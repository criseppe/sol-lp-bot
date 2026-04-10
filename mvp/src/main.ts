import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { OracleService } from './data/oracle.js';
import { PoolService } from './data/pool.js';
import { PaperTradingEngine } from './paper/ledger.js';
import { initDb, getBotState, upsertBotState, getRebalanceEvents, getHistoryDayCount, backfillPriceHistory, getDailyPnl, upsertDailyPnl, insertPriceTick, insertRebalanceEvent, getDailyCloses, insertLiveSnapshot, getLiveSnapshots, getLiveInRangePct, insertDecisionLog, getDecisionLogs, insertRegimeChange, getRegimeHistory, exportAllData } from './db/sqlite.js';
import { printCycle, printEvent } from './output/terminal.js';
import { startDashboard } from './output/dashboard.js';
import { LiveExecutor, type LivePosition } from './live/executor.js';
import { startTelegramReporter } from './output/telegram.js';
import type { LiveData } from './output/dashboard.js';
import { loadWallet, getWalletBalances, validateWalletForLive } from './live/wallet.js';
import { detectRegime, detectRegimeWithMetrics, getRegimeParams } from './engine/regime.js';
import { calcRange, calcProximity, shouldFireDownside, shouldFireUpside, shouldReenterAfterUpside, getDownsideReentrySplit, isHarvestDue } from './engine/rules.js';
import { REENTRY, RISK } from './constants.js';
import type { BotState, Regime, EventType } from './types.js';

// ── 1. VALIDATE ENV VARS ─────────────────────────────────────────────────

const BOT_MODE = (process.env.BOT_MODE ?? 'SHADOW').toUpperCase();
const IS_LIVE = BOT_MODE === 'LIVE';

const REQUIRED_VARS = ['RPC_URL', 'PYTH_SOL_USD_FEED', 'WHIRLPOOL_ADDRESS', 'PAPER_CAPITAL_USDC', 'DB_PATH'];
if (IS_LIVE) REQUIRED_VARS.push('WALLET_PRIVATE_KEY');

for (const key of REQUIRED_VARS) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const RPC_URL = process.env.RPC_URL!;
const PYTH_SOL_USD_FEED = process.env.PYTH_SOL_USD_FEED!;
const WHIRLPOOL_ADDRESS = process.env.WHIRLPOOL_ADDRESS!;
const PAPER_CAPITAL_USDC = parseFloat(process.env.PAPER_CAPITAL_USDC!);
const DB_PATH = process.env.DB_PATH!;
const DECISION_INTERVAL_SECONDS = parseInt(process.env.DECISION_INTERVAL_SECONDS ?? '30');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '3000');
const REGIME_WINDOW_DAYS = parseInt(process.env.REGIME_WINDOW_DAYS ?? '7');
const TREND_THRESHOLD = parseFloat(process.env.TREND_THRESHOLD ?? '0.35');
const PYTH_MAX_CONFIDENCE_PCT = parseFloat(process.env.PYTH_MAX_CONFIDENCE_PCT ?? '0.5');
const PYTH_MAX_STALENESS_SECONDS = parseInt(process.env.PYTH_MAX_STALENESS_SECONDS ?? '60');
const MAX_LIVE_CAPITAL_USDC = parseFloat(process.env.MAX_LIVE_CAPITAL_USDC ?? '150');
const RANGE_WIDTH_OVERRIDE = process.env.RANGE_WIDTH_OVERRIDE ? parseFloat(process.env.RANGE_WIDTH_OVERRIDE) : null;

// ── 2. INIT DATABASE ──────────────────────────────────────────────────────

const db = initDb(DB_PATH);

// ── 3. SETUP ──────────────────────────────────────────────────────────────

const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const pool = new PoolService(conn, WHIRLPOOL_ADDRESS);

// Paper engine always runs (for comparison)
let engine: PaperTradingEngine;
const savedState = getBotState(db);

if (savedState && savedState.ledger_json) {
  try {
    const botLedger = JSON.parse(savedState.ledger_json);
    const naiveLedger = savedState.naive_json ? JSON.parse(savedState.naive_json) : undefined;
    engine = new PaperTradingEngine(
      PAPER_CAPITAL_USDC,
      (p: number) => pool.priceToTick(p),
      REGIME_WINDOW_DAYS,
      TREND_THRESHOLD,
      {
        bot: botLedger,
        naive: naiveLedger ?? botLedger,
        botState: savedState.state as BotState,
        regime: (savedState.regime ?? 'RANGING') as Regime,
      },
    );
    console.log(JSON.stringify({ level: 'info', msg: 'paper state restored from DB', timestamp: Date.now() }));
  } catch {
    engine = new PaperTradingEngine(PAPER_CAPITAL_USDC, (p: number) => pool.priceToTick(p), REGIME_WINDOW_DAYS, TREND_THRESHOLD);
  }
} else {
  engine = new PaperTradingEngine(PAPER_CAPITAL_USDC, (p: number) => pool.priceToTick(p), REGIME_WINDOW_DAYS, TREND_THRESHOLD);
}

// Live executor (only if LIVE mode)
let liveExecutor: LiveExecutor | null = null;
let liveRegime: Regime = 'RANGING';
let liveBotState: BotState = 'IDLE';
let livePullbackActive = false;
let livePullbackPeak = 0;
let livePullbackStart = 0;
let liveLastHarvestTime = Date.now();
let liveLastRegimeCheck = 0;
let liveRebalancesThisHour = 0;
let liveRebalanceHourStart = Date.now();
let liveCumFeesSol = savedState?.cum_fees_sol ?? 0;
let liveCumFeesUsdc = savedState?.cum_fees_usdc ?? 0;
let liveRealizedIl = savedState?.realized_il ?? 0;
if (liveCumFeesSol || liveCumFeesUsdc || liveRealizedIl) {
  console.log(JSON.stringify({ level: 'info', msg: `restored from DB: cumFees=${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(4)} USDC, realizedIL=$${liveRealizedIl.toFixed(6)}`, timestamp: Date.now() }));
}
let lastHoldLogTime = 0;
let currentLiveData: LiveData | null = null;

// ── 4. START DATA SERVICES ────────────────────────────────────────────────

const oracle = new OracleService(PYTH_SOL_USD_FEED, PYTH_MAX_CONFIDENCE_PCT, PYTH_MAX_STALENESS_SECONDS);
const dashboard = startDashboard(DASHBOARD_PORT);
dashboard.setDb(db);

// ── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  await oracle.start();
  await pool.fetchState();

  // Cold start backfill
  const dayCount = getHistoryDayCount(db);
  if (dayCount < 3) {
    console.log(JSON.stringify({ level: 'info', msg: `Insufficient price history (${dayCount} days). Attempting backfill...`, timestamp: Date.now() }));
    try {
      const timeFrom = Math.floor(Date.now() / 1000 - 8 * 86400);
      const timeTo = Math.floor(Date.now() / 1000);
      const url = `https://public-api.birdeye.so/defi/ohlcv?address=So11111111111111111111111111111111111111112&type=1D&time_from=${timeFrom}&time_to=${timeTo}`;
      const response = await fetch(url);
      const json = await response.json() as { data?: { items?: Array<{ c: number; unixTime: number }> } };
      if (json.data?.items) {
        const closes = json.data.items.map((c: { c: number; unixTime: number }) => ({ timestamp: c.unixTime * 1000, price: c.c }));
        backfillPriceHistory(db, closes);
        console.log(JSON.stringify({ level: 'info', msg: `Backfilled ${closes.length} days`, timestamp: Date.now() }));
      }
    } catch {
      console.log(JSON.stringify({ level: 'warn', msg: 'Backfill failed — defaulting to RANGING', timestamp: Date.now() }));
    }
  }

  // Live mode setup
  if (IS_LIVE) {
    const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
    const balances = await getWalletBalances(conn, wallet.publicKey);
    const solPrice = (await pool.getCurrentPrice());
    balances.solPrice = solPrice;
    balances.totalUsdc = balances.sol * solPrice + balances.usdc;

    console.log(JSON.stringify({
      level: 'info',
      msg: 'LIVE MODE wallet loaded',
      address: wallet.publicKey.toBase58(),
      sol: balances.sol.toFixed(6),
      usdc: balances.usdc.toFixed(6),
      totalUsdc: balances.totalUsdc.toFixed(2),
      timestamp: Date.now(),
    }));

    validateWalletForLive(balances.sol, balances.usdc, MAX_LIVE_CAPITAL_USDC);
    liveExecutor = new LiveExecutor(conn, wallet, WHIRLPOOL_ADDRESS);

    // Read actual gas from blockchain on startup (always accurate)
    try {
      const sigs = await conn.getSignaturesForAddress(wallet.publicKey, { limit: 100 });
      let totalGas = 0;
      for (const sig of sigs) {
        const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (tx?.meta?.fee) totalGas += tx.meta.fee;
      }
      liveExecutor.cumGasLamports = totalGas;
      liveExecutor.txCount = sigs.length;
      console.log(JSON.stringify({ level: 'info', msg: `gas from chain: ${totalGas} lamports (${(totalGas/1e9).toFixed(6)} SOL), ${sigs.length} txs`, timestamp: Date.now() }));
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `gas read failed, using DB: ${String(err)}`, timestamp: Date.now() }));
      liveExecutor.cumGasLamports = (savedState as any)?.cum_gas_lamports ?? 0;
      liveExecutor.txCount = (savedState as any)?.tx_count ?? 0;
    }

    // Log swaps as events
    liveExecutor.onSwap = (event) => {
      insertRebalanceEvent(db, {
        timestamp: event.timestamp, eventType: 'PRICE_UPDATE', price: currentLiveData?.solPrice ?? 0, regime: liveRegime,
        note: `SWAP: ${event.reason}`,
        solBefore: 0, usdcBefore: event.fromAmount, solAfter: event.toAmount, usdcAfter: 0,
        feeSol: 0, feeUsdc: 0, ilAtClose: 0,
      });
      insertDecisionLog(db, {
        timestamp: event.timestamp, price: 0, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'SWAP', reasoning: event.reason, params_json: null,
      });
    };

    // Restore live position from DB if exists
    if (savedState?.position_json && savedState.position_json !== 'null') {
      try {
        const pos = JSON.parse(savedState.position_json);
        if (pos?.positionMint) {
          const { PublicKey } = await import('@solana/web3.js');
          liveExecutor.setCurrentPosition({
            ...pos,
            positionMint: new PublicKey(pos.positionMint),
            positionAddress: new PublicKey(pos.positionAddress),
          });
          liveBotState = 'ACTIVE';
          liveRegime = (savedState.regime ?? 'RANGING') as Regime;
          console.log(JSON.stringify({ level: 'info', msg: 'live position restored', positionMint: pos.positionMint, timestamp: Date.now() }));
          insertDecisionLog(db, { timestamp: Date.now(), price: pos.entryPrice ?? 0, regime: liveRegime, bot_state: 'ACTIVE',
            prox_lower: null, prox_upper: null, in_range: null,
            decision: 'RESTORED', reasoning: `Position restored from DB after restart. Mint: ${pos.positionMint}. Range: $${pos.priceLower?.toFixed(2) ?? '?'}-$${pos.priceUpper?.toFixed(2) ?? '?'}. Entry price: $${pos.entryPrice?.toFixed(2) ?? '?'}. Regime: ${liveRegime}.`,
            params_json: null });
        }
      } catch {
        console.log(JSON.stringify({ level: 'warn', msg: 'could not restore live position', timestamp: Date.now() }));
      }
    }
  }

  // Wait for first price
  let firstPrice = oracle.getPrice();
  let waited = 0;
  while (!firstPrice && waited < 30_000) {
    await new Promise(r => setTimeout(r, 2000));
    waited += 2000;
    firstPrice = oracle.getPrice();
  }
  if (!firstPrice) {
    console.error('No valid price within 30s. Exiting.');
    oracle.stop();
    dashboard.stop();
    process.exit(1);
  }

  console.log(JSON.stringify({ level: 'info', msg: `First price: $${firstPrice.price.toFixed(2)}`, timestamp: Date.now() }));

  // Banner
  const modeStr = IS_LIVE ? 'LIVE MODE ⚡ REAL MONEY' : 'SHADOW MODE';
  console.log(`
+-------------------------------------------+
|  SOL/USDC LP Bot MVP  ·  ${modeStr.padEnd(16)}|
|  Capital: $${PAPER_CAPITAL_USDC.toLocaleString('en-US')} USDC  ·  Pool: SOL/USDC  |
|  Dashboard: http://localhost:${DASHBOARD_PORT}          |
|  DB: ${DB_PATH.padEnd(36)}|
|  Press Ctrl+C to stop gracefully          |
+-------------------------------------------+
`);

  // ── DECISION LOOP ─────────────────────────────────────────────────────

  let lastEventType = '';

  const decisionLoop = setInterval(async () => {
    try {
      const price = oracle.getPrice();
      if (!price) return;

      const poolState = await pool.fetchState();

      if (IS_LIVE && liveExecutor) {
        // Live mode: only run live engine (skip if paused)
        if (!botPaused) await runLiveCycle(price.price);

        // Store price tick for regime detection
        insertPriceTick(db, {
          timestamp: Date.now(), price: price.price, confidence: price.confidence,
          regime: liveRegime, prox_lower: null, prox_upper: null, in_range: 0,
        });

        // Print live status to terminal
        const livePos = liveExecutor.getCurrentPosition();
        const stateStr = `[${liveBotState}] SOL=$${price.price.toFixed(2)} regime=${liveRegime}`;
        const posStr = livePos ? `pos: $${livePos.priceLower.toFixed(2)}-$${livePos.priceUpper.toFixed(2)}` : 'no position';
        console.log(JSON.stringify({ level: 'info', msg: `LIVE cycle: ${stateStr} ${posStr}`, timestamp: Date.now() }));
      } else {
        // Shadow mode: run paper engine
        const result = engine.processCycle(price.price, poolState, db);
        const comparison = engine.getComparison(price.price);

        printCycle(result, comparison);

        if (result.eventType !== 'PRICE_UPDATE' && result.eventType !== 'CYCLE_SKIP' && result.eventType !== lastEventType) {
          const events = getRebalanceEvents(db, 1);
          if (events.length > 0) printEvent(events[0]);
        }
        lastEventType = result.eventType;
      }

      const comparison = engine.getComparison(price.price);
      dashboard.updateData(comparison, getRebalanceEvents(db, 50), IS_LIVE ? liveBotState : engine.getState(), getDailyPnl(db, 7));

      // Update live dashboard data
      if (IS_LIVE && liveExecutor) {
        try {
          const wallet = (liveExecutor as any).wallet;
          const balances = await getWalletBalances(conn, wallet.publicKey);
          const livePos = liveExecutor.getCurrentPosition();
          const posData = await liveExecutor.getPositionData();
          const posComp = await liveExecutor.getPositionComposition();

          // Convert raw fee amounts to decimals (SOL=9 decimals, USDC=6 decimals)
          const feesSolDecimal = posData?.feeOwedA ? Number(posData.feeOwedA) / 1e9 : 0;
          const feesUsdcDecimal = posData?.feeOwedB ? Number(posData.feeOwedB) / 1e6 : 0;
          const feesTotalUsdc = feesSolDecimal * price.price + feesUsdcDecimal;

          // Position composition
          const positionSol = posComp?.sol ?? 0;
          const positionUsdc = posComp?.usdc ?? 0;
          const positionValueUsdc = posComp?.totalUsdc ?? 0;
          const walletValueUsdc = balances.sol * price.price + balances.usdc;
          const totalWithPosition = walletValueUsdc + positionValueUsdc;

          // Calculate IL
          let ilUsdc = 0;
          if (livePos && livePos.entryPrice && livePos.entryPrice !== price.price) {
            const priceRatio = price.price / livePos.entryPrice;
            const ilPct = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
            ilUsdc = ilPct * totalWithPosition;
          }

          // Real pending fees from on-chain data
          const pendingFees = await liveExecutor.getPendingFees();
          const pendingFeesSol = pendingFees?.feeSolDecimal ?? 0;
          const pendingFeesUsdc = pendingFees?.feeUsdcDecimal ?? 0;
          const pendingFeesTotal = pendingFees?.feeTotalUsdc ?? 0;
          const totalFeesUsdc = pendingFeesTotal + liveCumFeesSol * price.price + liveCumFeesUsdc;

          const liveDataUpdate: LiveData = {
            walletAddress: wallet.publicKey.toBase58(),
            solBalance: balances.sol,
            usdcBalance: balances.usdc,
            totalValueUsdc: walletValueUsdc,
            solPrice: price.price,
            positionMint: livePos?.positionMint.toBase58() ?? null,
            positionRange: posData ? { lower: posData.priceLower, upper: posData.priceUpper } : null,
            positionLiquidity: posData?.liquidity ?? null,
            feeOwedSol: posData?.feeOwedA ?? null,
            feeOwedUsdc: posData?.feeOwedB ?? null,
            positionSol,
            positionUsdc,
            positionValueUsdc,
            totalValueWithPosition: totalWithPosition,
            pendingFeesSol,
            pendingFeesUsdc,
            pendingFeesTotal,
            cumHarvestedFeesSol: liveCumFeesSol,
            cumHarvestedFeesUsdc: liveCumFeesUsdc,
            totalFeesUsdc,
            entryPrice: livePos?.entryPrice ?? null,
            entrySol: positionSol,
            entryUsdc: positionUsdc,
            ilUsdc,
            realizedIlUsdc: liveRealizedIl,
            ...(() => { const g = liveExecutor!.getGasStats(price.price); return { gasSol: g.gasSol, gasUsdc: g.gasUsdc, txCount: g.txCount }; })(),
            regime: liveRegime,
            botState: liveBotState,
            liveEvents: [],
          };
          currentLiveData = liveDataUpdate;
          dashboard.updateLiveData(liveDataUpdate);

          // Record live snapshot for historical tracking
          const isInRange = posData && price.price >= posData.priceLower && price.price <= posData.priceUpper;
          insertLiveSnapshot(db, {
            timestamp: Date.now(),
            price: price.price,
            sol_balance: balances.sol,
            usdc_balance: balances.usdc,
            total_value_usdc: walletValueUsdc,
            pending_fees_sol: feesSolDecimal,
            pending_fees_usdc: feesUsdcDecimal,
            cum_fees_sol: liveCumFeesSol,
            cum_fees_usdc: liveCumFeesUsdc,
            il_usdc: ilUsdc,
            in_range: isInRange ? 1 : 0,
            regime: liveRegime,
            position_mint: livePos?.positionMint.toBase58() ?? null,
            position_sol: positionSol,
            position_usdc: positionUsdc,
            position_value: positionValueUsdc,
            total_with_position: totalWithPosition,
          });
        } catch {}
      }

      // Persist state
      const livePos = liveExecutor?.getCurrentPosition();
      upsertBotState(db, {
        state: IS_LIVE ? liveBotState : engine.getState(),
        regime: IS_LIVE ? liveRegime : engine.getRegime(),
        position_json: IS_LIVE && livePos
          ? JSON.stringify({ ...livePos, positionMint: livePos.positionMint.toBase58(), positionAddress: livePos.positionAddress.toBase58() })
          : JSON.stringify(engine.getBotLedger().openPosition),
        ledger_json: JSON.stringify(engine.getBotLedger()),
        naive_json: JSON.stringify(engine.getNaiveLedger()),
        updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
      });

      checkAndWriteDailyPnl(comparison);
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'cycle error', error: String(err), timestamp: Date.now() }));
    }
  }, DECISION_INTERVAL_SECONDS * 1000);

  // Dashboard control handlers
  let botPaused = false;

  if (IS_LIVE && liveExecutor) {
    const executor = liveExecutor;
    const liveWallet = (executor as any).wallet;

    dashboard.onPause(() => {
      botPaused = true;
      liveBotState = 'IDLE';
      console.log(JSON.stringify({ level: 'info', msg: 'Bot PAUSED from dashboard. Position stays open.', timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price: 0, regime: liveRegime, bot_state: 'IDLE',
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'PAUSED', reasoning: 'Bot paused manually from dashboard. Decision loop halted. Position remains open on-chain and continues earning fees.',
        params_json: null });
    });

    dashboard.onResume(() => {
      botPaused = false;
      liveBotState = 'ACTIVE';
      console.log(JSON.stringify({ level: 'info', msg: 'Bot RESUMED from dashboard.', timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price: 0, regime: liveRegime, bot_state: 'ACTIVE',
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'RESUMED', reasoning: 'Bot resumed manually from dashboard. Decision loop restarted. Bot will monitor position and rebalance as needed.',
        params_json: null });
    });

    dashboard.onHarvest(async () => {
      const currentPrice = currentLiveData?.solPrice ?? 0;
      console.log(JSON.stringify({ level: 'info', msg: 'Manual fee harvest from dashboard', timestamp: Date.now() }));
      const fees = await executor.collectFees();
      liveCumFeesSol += fees.feeSol;
      liveCumFeesUsdc += fees.feeUsdc;
      const feeTotalUsdc = fees.feeSol * currentPrice + fees.feeUsdc;
      insertRebalanceEvent(db, {
        timestamp: Date.now(), eventType: 'FEE_HARVEST', price: currentPrice, regime: liveRegime,
        note: `Manual harvest from dashboard. Collected ${fees.feeSol.toFixed(6)} SOL ($${(fees.feeSol * currentPrice).toFixed(4)}) + ${fees.feeUsdc.toFixed(6)} USDC = $${feeTotalUsdc.toFixed(4)} total. Cumulative: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.`,
        solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
        feeSol: fees.feeSol, feeUsdc: fees.feeUsdc, ilAtClose: 0,
      });
      return fees;
    });

    dashboard.onEmergencyStop(async () => {
      console.log(JSON.stringify({ level: 'warn', msg: 'EMERGENCY STOP triggered from dashboard', timestamp: Date.now() }));
      clearInterval(decisionLoop);
      oracle.stop();

      if (executor.getCurrentPosition()) {
        const balBefore = await getWalletBalances(conn, liveWallet.publicKey);
        console.log(JSON.stringify({ level: 'info', msg: 'Closing live position...', timestamp: Date.now() }));
        const result = await executor.closePosition();
        const balAfter = await getWalletBalances(conn, liveWallet.publicKey);

        liveCumFeesSol += result.feeSolCollected;
        liveCumFeesUsdc += result.feeUsdcCollected;
        liveRealizedIl += result.ilAtClose;

        insertRebalanceEvent(db, {
          timestamp: Date.now(), eventType: 'POSITION_CLOSED', price: result.closePrice, regime: liveRegime,
          note: `WHY: Emergency stop triggered from dashboard. Range was $${result.priceLower.toFixed(2)}-$${result.priceUpper.toFixed(2)}, entry at $${result.entryPrice.toFixed(2)}.\nEXECUTED: Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)}). Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC.`,
          solBefore: balBefore.sol, usdcBefore: balBefore.usdc,
          solAfter: balAfter.sol, usdcAfter: balAfter.usdc,
          feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
        });
        insertDecisionLog(db, { timestamp: Date.now(), price: result.closePrice, regime: liveRegime, bot_state: 'IDLE',
          prox_lower: null, prox_upper: null, in_range: null,
          decision: 'EMERGENCY_STOP', reasoning: `Emergency stop from dashboard. Fees: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC.`,
          params_json: null });
        console.log(JSON.stringify({ level: 'info', msg: 'Live position closed.', timestamp: Date.now() }));
      }

      liveBotState = 'IDLE';
      upsertBotState(db, {
        state: 'IDLE', regime: liveRegime,
        position_json: 'null', ledger_json: JSON.stringify(engine.getBotLedger()),
        naive_json: JSON.stringify(engine.getNaiveLedger()), updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
      });

      console.log(JSON.stringify({ level: 'info', msg: 'Emergency stop complete. Exiting in 3s...', timestamp: Date.now() }));
      setTimeout(() => process.exit(0), 3000);
    });
  }

  // Telegram reporter
  let reporter: { stop: () => void } | null = null;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  const reportIntervalMin = parseInt(process.env.REPORT_INTERVAL_MINUTES ?? '60');
  if (tgToken && tgChatId) {
    reporter = startTelegramReporter(
      { botToken: tgToken, chatId: tgChatId, intervalMs: reportIntervalMin * 60_000 },
      db,
      () => currentLiveData,
    );
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'telegram reporter disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)', timestamp: Date.now() }));
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...', timestamp: Date.now() }));
    clearInterval(decisionLoop);
    oracle.stop();
    reporter?.stop();
    dashboard.stop();

    const livePos = liveExecutor?.getCurrentPosition();
    upsertBotState(db, {
      state: IS_LIVE ? liveBotState : engine.getState(),
      regime: IS_LIVE ? liveRegime : engine.getRegime(),
      position_json: IS_LIVE && livePos
        ? JSON.stringify({ ...livePos, positionMint: livePos.positionMint.toBase58(), positionAddress: livePos.positionAddress.toBase58() })
        : JSON.stringify(engine.getBotLedger().openPosition),
      ledger_json: JSON.stringify(engine.getBotLedger()),
      naive_json: JSON.stringify(engine.getNaiveLedger()),
      updated_at: Date.now(),
      cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
    });

    console.log(JSON.stringify({ level: 'info', msg: 'State saved. Bye.', timestamp: Date.now() }));
    process.exit(0);
  });
}

// ── LIVE CYCLE ────────────────────────────────────────────────────────────

async function runLiveCycle(price: number): Promise<void> {
  if (!liveExecutor) return;
  const now = Date.now();

  if (liveBotState === 'HALTED') return;

  // Regime update (every 60s)
  if (now - liveLastRegimeCheck > 60_000) {
    const closes = getDailyCloses(db, REGIME_WINDOW_DAYS);
    const result = closes.length >= 3
      ? detectRegimeWithMetrics(closes, TREND_THRESHOLD)
      : { regime: 'RANGING' as const, dirRatio: 0, realisedVol: 0, priceCount: closes.length };

    // Determine thresholds for reasoning
    const volStatus = result.realisedVol > 0.08 ? 'ABOVE 0.08 threshold → EXTREME' : `${result.realisedVol.toFixed(4)} (below 0.08 threshold)`;
    const dirStatus = result.dirRatio > TREND_THRESHOLD ? `ABOVE ${TREND_THRESHOLD} threshold → trending` : `${result.dirRatio.toFixed(3)} (below ${TREND_THRESHOLD} threshold → ranging)`;
    const priceDir = closes.length >= 2 ? (closes[closes.length - 1] > closes[0] ? 'UP' : 'DOWN') : 'N/A';
    const changed = result.regime !== liveRegime;

    // Log every evaluation
    insertDecisionLog(db, { timestamp: now, price, regime: result.regime, bot_state: liveBotState,
      prox_lower: null, prox_upper: null, in_range: null,
      decision: changed ? 'REGIME_CHANGE' : 'REGIME_EVAL',
      reasoning: `Regime evaluation: ${result.priceCount} daily closes analyzed over ${REGIME_WINDOW_DAYS} days. ` +
        `realisedVol=${volStatus}. dirRatio=${dirStatus}. Price direction: ${priceDir}. ` +
        `${closes.length >= 2 ? `Price range: $${Math.min(...closes).toFixed(2)}-$${Math.max(...closes).toFixed(2)}.` : 'Insufficient data.'} ` +
        `Result: ${result.regime}${changed ? ` (CHANGED from ${liveRegime})` : ' (no change)'}.`,
      params_json: JSON.stringify({ dirRatio: result.dirRatio, realisedVol: result.realisedVol, priceCount: result.priceCount, trendThreshold: TREND_THRESHOLD }) });

    if (changed) {
      const oldRegime = liveRegime;
      liveRegime = result.regime;
      console.log(JSON.stringify({ level: 'info', msg: 'LIVE regime change', from: oldRegime, to: result.regime, dirRatio: result.dirRatio.toFixed(3), vol: result.realisedVol.toFixed(4), timestamp: now }));
      insertRegimeChange(db, {
        timestamp: now, old_regime: oldRegime, new_regime: result.regime, price,
        dir_ratio: result.dirRatio, realised_vol: result.realisedVol, price_count: result.priceCount,
      });
      insertRebalanceEvent(db, {
        timestamp: now, eventType: 'REGIME_CHANGE', price, regime: result.regime,
        note: `WHY: dirRatio=${result.dirRatio.toFixed(3)} (threshold ${TREND_THRESHOLD}), realisedVol=${result.realisedVol.toFixed(4)} (threshold 0.08), ${result.priceCount} daily closes, price direction: ${priceDir}.\nEXECUTED: Regime changed from ${oldRegime} to ${result.regime}. All rule parameters updated.`,
        solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0, feeSol: 0, feeUsdc: 0, ilAtClose: 0,
      });
    }
    liveLastRegimeCheck = now;
  }

  // Rebalance rate limit
  if (now - liveRebalanceHourStart > 3600_000) {
    liveRebalancesThisHour = 0;
    liveRebalanceHourStart = now;
  }
  if (liveRebalancesThisHour >= RISK.REBALANCE_LOOP_LIMIT) return;

  const params = getRegimeParams(liveRegime);
  const currentPos = liveExecutor.getCurrentPosition();

  // No position → open one
  if (!currentPos) {
    if (livePullbackActive) {
      const decision = shouldReenterAfterUpside(price, livePullbackPeak, livePullbackStart, now);
      if (decision.should) {
        livePullbackActive = false;
        const waitH = ((now - livePullbackStart) / 3600_000).toFixed(1);
        const pullPct = ((livePullbackPeak - price) / livePullbackPeak * 100).toFixed(1);
        const reason = decision.reason === 'PULLBACK'
          ? `Rule 3 pullback re-entry: price pulled back ${pullPct}% from peak $${livePullbackPeak.toFixed(2)} (threshold: ${REENTRY.PULLBACK_THRESHOLD_PCT}%). Waited ${waitH}h.`
          : `Rule 3 timeout re-entry: waited ${waitH}h without sufficient pullback (${pullPct}% vs ${REENTRY.PULLBACK_THRESHOLD_PCT}% threshold).`;
        await liveOpenPosition(price, 'PULLBACK_REENTRY', reason);
      } else {
        if (price > livePullbackPeak) livePullbackPeak = price;
      }
      return;
    }
    await liveOpenPosition(price, 'POSITION_OPENED', `No open position detected. Bot is idle. Opening new position.`);
    return;
  }

  // Proximity check
  const prox = calcProximity(price, {
    ...currentPos,
    solAmount: 0, usdcAmount: 0,
    entryPrice: currentPos.entryPrice,
    entryTime: currentPos.entryTime,
    regime: currentPos.regime,
  });

  if (prox.inRange) {
    if (shouldFireDownside(prox, params.proxThresholdLower, 0, 0)) {
      const proxPct = (prox.proxToLower * 100).toFixed(0);
      const reason = `Rule 2 early downside exit: proxToLower=${proxPct}% >= threshold ${(params.proxThresholdLower*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} drifting toward lower bound $${currentPos.priceLower.toFixed(2)}. Closing to avoid full OOR impermanent loss.`;
      await liveCloseAndReopen(price, 'T1_DOWNSIDE', reason);
      return;
    }
    if (shouldFireUpside(prox, params.proxThresholdUpper)) {
      const proxPct = (prox.proxToUpper * 100).toFixed(0);
      const timeoutStr = REENTRY.TIMEOUT_HOURS >= 1 ? `${REENTRY.TIMEOUT_HOURS}h` : `${Math.round(REENTRY.TIMEOUT_HOURS * 60)}min`;
      const reason = `Rule 2 early upside exit: proxToUpper=${proxPct}% >= threshold ${(params.proxThresholdUpper*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} nearing upper bound $${currentPos.priceUpper.toFixed(2)}. Closing and entering Rule 3 pullback watch — will wait for ${REENTRY.PULLBACK_THRESHOLD_PCT}% pullback or ${timeoutStr} timeout.`;
      await liveClosePosition(price, 'T1_UPSIDE', reason);
      livePullbackActive = true;
      livePullbackPeak = price;
      livePullbackStart = now;
      liveBotState = 'WAITING_PULLBACK';
      return;
    }
    // Log HOLD decision every 5 minutes
    if (now - lastHoldLogTime >= 300_000) {
      lastHoldLogTime = now;
      insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
        prox_lower: prox.proxToLower, prox_upper: prox.proxToUpper, in_range: 1,
        decision: 'HOLD', reasoning: `Position in range. Price $${price.toFixed(2)} within $${currentPos.priceLower.toFixed(2)}-$${currentPos.priceUpper.toFixed(2)}. proxDown=${(prox.proxToLower*100).toFixed(0)}% (need ${(params.proxThresholdLower*100).toFixed(0)}% to trigger downside exit), proxUp=${(prox.proxToUpper*100).toFixed(0)}% (need ${(params.proxThresholdUpper*100).toFixed(0)}% to trigger upside exit). Regime: ${liveRegime}. Holding — position is earning fees.`,
        params_json: null });
    }
  } else {
    if (price < currentPos.priceLower) {
      const reason = `Out of range below: price $${price.toFixed(2)} < lower bound $${currentPos.priceLower.toFixed(2)}. Position is now 100% SOL (all USDC converted). Earning zero fees. Must close and reopen at current price to resume fee earning.`;
      await liveCloseAndReopen(price, 'OOR_BELOW', reason);
      return;
    }
    if (price > currentPos.priceUpper) {
      const reason = `Out of range above: price $${price.toFixed(2)} > upper bound $${currentPos.priceUpper.toFixed(2)}. Position is now 100% USDC (all SOL sold). Earning zero fees. Closing and entering Rule 3 pullback watch — waiting for price to pull back before re-entering.`;
      await liveClosePosition(price, 'OOR_ABOVE', reason);
      livePullbackActive = true;
      livePullbackPeak = price;
      livePullbackStart = now;
      liveBotState = 'WAITING_PULLBACK';
      return;
    }
  }

  // Fee harvest
  if (isHarvestDue(liveLastHarvestTime, params, now)) {
    try {
      const fees = await liveExecutor.collectFees();
      liveCumFeesSol += fees.feeSol;
      liveCumFeesUsdc += fees.feeUsdc;
      liveLastHarvestTime = now;
      insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'FEE_HARVEST', reasoning: `Harvest due: ${((now - liveLastHarvestTime)/86400_000).toFixed(1)} days since last. Collected ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC. Cumulative: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.`,
        params_json: null });
      insertRebalanceEvent(db, {
        timestamp: now, eventType: 'FEE_HARVEST', price, regime: liveRegime,
        note: `Collected fees: ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC. Cumulative total: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.`,
        solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
        feeSol: fees.feeSol, feeUsdc: fees.feeUsdc, ilAtClose: 0,
      });
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'fee harvest failed', error: String(err), timestamp: now }));
    }
  }

  liveBotState = 'ACTIVE';
}

async function liveOpenPosition(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  if (!liveExecutor) return;
  const params = getRegimeParams(liveRegime);
  const effectiveParams = RANGE_WIDTH_OVERRIDE !== null
    ? { ...params, rangeWidthPct: RANGE_WIDTH_OVERRIDE }
    : params;
  const range = calcRange(price, effectiveParams, (p) => pool.priceToTick(p), (p) => pool.priceToTickLower(p), (p) => pool.priceToTickUpper(p));

  const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const totalWalletUsdc = balances.sol * price + balances.usdc;
  const deployTarget = totalWalletUsdc * effectiveParams.deployPct;
  // The executor will quote by USDC first, then re-quote by SOL if SOL-limited
  // Pass the USDC portion of what we want to deploy (executor handles the SOL side)
  const deployUsdc = Math.min(deployTarget, balances.usdc - 1);
  if (deployUsdc < 5 && balances.sol * price < 5) {
    console.log(JSON.stringify({ level: 'warn', msg: 'insufficient funds to open position', sol: balances.sol, usdc: balances.usdc, timestamp: Date.now() }));
    return;
  }

  // Build reasoning
  const why = triggerReason ?? `No open position detected.`;
  const widthNote = RANGE_WIDTH_OVERRIDE !== null ? ` (override: ${RANGE_WIDTH_OVERRIDE}%, regime default: ${params.rangeWidthPct}%)` : `%`;
  const logic = `${why} Regime: ${liveRegime} → rangeWidth=${effectiveParams.rangeWidthPct}${widthNote}, skew=${(effectiveParams.skewDown*100).toFixed(0)}% down/${(effectiveParams.skewUp*100).toFixed(0)}% up, deploy=${(effectiveParams.deployPct*100).toFixed(0)}% of capital. Range calculated: $${range.priceLower.toFixed(2)}-$${range.priceUpper.toFixed(2)} around current price $${price.toFixed(2)}.`;

  try {
    const pos = await liveExecutor.openPosition(range, price, liveRegime, deployUsdc);
    if (!pos) return;
    liveRebalancesThisHour++;
    liveBotState = 'ACTIVE';

    const comp = await liveExecutor.getPositionComposition();
    const depositedSol = comp?.sol ?? 0;
    const depositedUsdc = comp?.usdc ?? 0;
    const depositedTotal = comp?.totalUsdc ?? 0;
    const balancesAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);

    const execution = `Deposited ${depositedSol.toFixed(4)} SOL ($${(depositedSol * price).toFixed(2)}) + ${depositedUsdc.toFixed(2)} USDC = $${depositedTotal.toFixed(2)} total. Wallet after: ${balancesAfter.sol.toFixed(4)} SOL + ${balancesAfter.usdc.toFixed(2)} USDC. Mint: ${pos.positionMint.toBase58().slice(0, 12)}...`;

    insertRebalanceEvent(db, {
      timestamp: Date.now(), eventType, price, regime: liveRegime,
      note: `WHY: ${logic}\nEXECUTED: ${execution}`,
      solBefore: balances.sol, usdcBefore: balances.usdc,
      solAfter: balancesAfter.sol, usdcAfter: balancesAfter.usdc, feeSol: 0, feeUsdc: 0, ilAtClose: 0,
    });
    insertDecisionLog(db, { timestamp: Date.now(), price, regime: liveRegime, bot_state: liveBotState,
      prox_lower: null, prox_upper: null, in_range: null,
      decision: eventType, reasoning: `${logic}\n${execution}`,
      params_json: JSON.stringify(params) });
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'LIVE open position failed', error: String(err), timestamp: Date.now() }));
  }
}

async function liveClosePosition(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  if (!liveExecutor) return;
  try {
    const balancesBefore = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
    const result = await liveExecutor.closePosition();
    const balancesAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);

    // Track fees and IL from the enriched close result
    liveCumFeesSol += result.feeSolCollected;
    liveCumFeesUsdc += result.feeUsdcCollected;
    liveRealizedIl += result.ilAtClose;
    liveRebalancesThisHour++;

    const why = triggerReason ?? `Position closed (${eventType}).`;
    const posInfo = ` Range was $${result.priceLower.toFixed(2)}-$${result.priceUpper.toFixed(2)}, entry at $${result.entryPrice.toFixed(2)}, close at $${result.closePrice.toFixed(2)}.`;
    const feeStr = `Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)}). `;
    const execution = `${feeStr}Received ${result.solReceived.toFixed(4)} SOL ($${(result.solReceived * price).toFixed(2)}) + ${result.usdcReceived.toFixed(2)} USDC. Realized IL: $${result.ilAtClose.toFixed(4)}. Wallet: ${balancesAfter.sol.toFixed(4)} SOL + ${balancesAfter.usdc.toFixed(2)} USDC = $${(balancesAfter.sol * price + balancesAfter.usdc).toFixed(2)} total.`;

    insertRebalanceEvent(db, {
      timestamp: Date.now(), eventType, price, regime: liveRegime,
      note: `WHY: ${why}${posInfo}\nEXECUTED: ${execution}`,
      solBefore: balancesBefore.sol, usdcBefore: balancesBefore.usdc,
      solAfter: balancesAfter.sol, usdcAfter: balancesAfter.usdc,
      feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
    });
    insertDecisionLog(db, { timestamp: Date.now(), price, regime: liveRegime, bot_state: liveBotState,
      prox_lower: null, prox_upper: null, in_range: null,
      decision: eventType, reasoning: `${why}${posInfo}\n${execution}`,
      params_json: null });
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'LIVE close position failed', error: String(err), timestamp: Date.now() }));
  }
}

async function liveCloseAndReopen(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  await liveClosePosition(price, eventType, triggerReason);
  await new Promise(r => setTimeout(r, 2000));
  await liveOpenPosition(price, 'POSITION_OPENED', `Re-opening after ${eventType}. Previous position closed due to: ${triggerReason ?? eventType}.`);
}

// ── HELPERS ───────────────────────────────────────────────────────────────

let lastPnlDate = '';
function checkAndWriteDailyPnl(comparison: ReturnType<typeof engine.getComparison>) {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastPnlDate) return;
  lastPnlDate = today;
  upsertDailyPnl(db, {
    date: today,
    opening_value: comparison.bot.portfolioValue,
    closing_value: comparison.bot.portfolioValue,
    fees_sol: 0, fees_usdc: comparison.bot.cumFees,
    il_cost: comparison.bot.cumIL,
    net_pnl: comparison.bot.netPnl, net_pnl_pct: comparison.bot.netPnlPct,
    rebalances: comparison.bot.rebalanceCount,
    in_range_pct: null, regime: comparison.bot.regime,
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
