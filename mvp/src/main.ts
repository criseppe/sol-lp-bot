import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { OracleService } from './data/oracle.js';
import { PoolService } from './data/pool.js';
import { initDb, getBotState, upsertBotState, getRebalanceEvents, getHistoryDayCount, backfillPriceHistory, getDailyPnl, upsertDailyPnl, insertPriceTick, insertRebalanceEvent, getDailyCloses, insertLiveSnapshot, getLiveSnapshots, getLiveInRangePct, insertDecisionLog, getDecisionLogs, insertRegimeChange, getRegimeHistory, exportAllData, getRuleEnabled, setRuleEnabled } from './db/sqlite.js';
import { startDashboard } from './output/dashboard.js';
import { LiveExecutor, type LivePosition } from './live/executor.js';
import { startTelegramReporter } from './output/telegram.js';
import type { LiveData } from './output/dashboard.js';
import { loadWallet, getWalletBalances, validateWalletForLive } from './live/wallet.js';
import { detectRegime, detectRegimeWithMetrics, getRegimeParams } from './engine/regime.js';
import { calcRange, calcProximity, shouldFireDownside, shouldFireUpside, shouldReenterAfterUpside, isFlashCrash, getDownsideReentrySplit, isHarvestDue, checkAutoDeploy } from './engine/rules.js';
import { REENTRY, RISK, MINTS } from './constants.js';
import type { BotState, Regime, EventType } from './types.js';
import { runtime, applyConfigFromDb } from './config.js';
import { getConfig, upsertDailySummary, getDailySummaries, getAllDailySummaries } from './db/sqlite.js';

// ── 1. VALIDATE ENV VARS ─────────────────────────────────────────────────

const REQUIRED_VARS = ['RPC_URL', 'PYTH_SOL_USD_FEED', 'WHIRLPOOL_ADDRESS', 'DB_PATH', 'WALLET_PRIVATE_KEY'];

for (const key of REQUIRED_VARS) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const RPC_URL = process.env.RPC_URL!;
const PYTH_SOL_USD_FEED = process.env.PYTH_SOL_USD_FEED!;
const WHIRLPOOL_ADDRESS = process.env.WHIRLPOOL_ADDRESS!;
const DB_PATH = process.env.DB_PATH!;
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '3000');

// Initialize runtime config from env vars (DB overrides applied after DB init)
runtime.decisionIntervalSeconds = parseInt(process.env.DECISION_INTERVAL_SECONDS ?? '60');
runtime.regimeWindowDays = parseInt(process.env.REGIME_WINDOW_DAYS ?? '7');
runtime.trendThreshold = parseFloat(process.env.TREND_THRESHOLD ?? '0.35');
runtime.pythMaxConfidencePct = parseFloat(process.env.PYTH_MAX_CONFIDENCE_PCT ?? '0.5');
runtime.pythMaxStalenessSec = parseInt(process.env.PYTH_MAX_STALENESS_SECONDS ?? '60');
runtime.maxLiveCapitalUsdc = parseFloat(process.env.MAX_LIVE_CAPITAL_USDC ?? '150');
runtime.rangeWidthOverride = process.env.RANGE_WIDTH_OVERRIDE ? parseFloat(process.env.RANGE_WIDTH_OVERRIDE) : null;
runtime.minIdleUsdc = parseFloat(process.env.MIN_IDLE_USDC ?? '5');
runtime.minIdleSol = parseFloat(process.env.MIN_IDLE_SOL ?? '0.05');
runtime.minDeployUsdc = parseFloat(process.env.MIN_DEPLOY_USDC ?? '10');
runtime.deployRatioTolerance = parseFloat(process.env.DEPLOY_RATIO_TOLERANCE ?? '0.02');

// ── 2. INIT DATABASE ──────────────────────────────────────────────────────

const db = initDb(DB_PATH);

// Apply config overrides from DB (takes precedence over env vars)
applyConfigFromDb(getConfig(db));

// ── 3. SETUP ──────────────────────────────────────────────────────────────

const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const pool = new PoolService(conn, WHIRLPOOL_ADDRESS);

const savedState = getBotState(db);

let liveExecutor: LiveExecutor | null = null;
let liveRegime: Regime = 'RANGING';
let liveBotState: BotState = 'IDLE';
let livePullbackActive = false;
let livePullbackPeak = 0;
let livePullbackStart = 0;
let liveLastHarvestTime = Date.now();
let liveLastRegimeCheck = 0;
let liveLastRegimeEvalLog = 0;
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
let lastPendingFeesCheck = 0;
let cachedPendingFeesSol = 0;
let cachedPendingFeesUsdc = 0;
let cachedPendingFeesTotal = 0;
let liveLastAutoDeployTime = 0;
let liveLastAutoDeployCheck = 0;
let liveLastHarvestCheck = 0;
let autoDeployEnabled = true; // will be loaded from DB
let liveFlashCrashCooldownUntil = 0; // timestamp: block re-entry until this time
let liveRecentPrices: number[] = []; // last ~10 prices for flash crash detection

// ── 4. START DATA SERVICES ────────────────────────────────────────────────

const oracle = new OracleService(PYTH_SOL_USD_FEED, runtime.pythMaxConfidencePct, runtime.pythMaxStalenessSec);
const dashboard = startDashboard(DASHBOARD_PORT);
dashboard.setDb(db);

// Load Rule 2 toggle state from DB
let rule2Enabled = getRuleEnabled(db, 'rule2');
dashboard.setRule2Enabled(rule2Enabled);

// Load auto-deploy toggle state from DB
autoDeployEnabled = getRuleEnabled(db, 'autoDeploy');
dashboard.setAutoDeployEnabled(autoDeployEnabled);

// Wrapper to auto-tag rebalance events with rule2 state and position ID
function insertRebalanceEventWithRule2(db_: typeof db, event: Parameters<typeof insertRebalanceEvent>[1], overridePositionId?: string) {
  const posId = overridePositionId ?? liveExecutor?.getCurrentPosition()?.positionMint?.toBase58() ?? null;
  insertRebalanceEvent(db_, { ...event, rule2Active: rule2Enabled ? 1 : 0, positionId: posId ?? undefined });
}

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
  {
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

    validateWalletForLive(balances.sol, balances.usdc, runtime.maxLiveCapitalUsdc, solPrice);
    liveExecutor = new LiveExecutor(conn, wallet, WHIRLPOOL_ADDRESS);

    // Restore gas stats from DB (persisted on every state save and shutdown)
    liveExecutor.cumGasLamports = (savedState as any)?.cum_gas_lamports ?? 0;
    liveExecutor.txCount = (savedState as any)?.tx_count ?? 0;
    console.log(JSON.stringify({ level: 'info', msg: `gas from DB: ${liveExecutor.cumGasLamports} lamports (${(liveExecutor.cumGasLamports/1e9).toFixed(6)} SOL), ${liveExecutor.txCount} txs`, timestamp: Date.now() }));

    // Log swaps as events
    liveExecutor.onSwap = (event) => {
      insertRebalanceEventWithRule2(db, {
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

    // Orphaned position recovery: if DB says no position, scan on-chain for any open positions
    if (!liveExecutor.getCurrentPosition()) {
      try {
        console.log(JSON.stringify({ level: 'info', msg: 'scanning for orphaned on-chain positions...', timestamp: Date.now() }));
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        });

        const orphanMints: PublicKey[] = [];
        for (const { account } of tokenAccounts.value) {
          const info = account.data.parsed.info;
          const mint = info.mint as string;
          const amount = info.tokenAmount.uiAmount as number;
          if (amount === 1 && info.tokenAmount.decimals === 0 && mint !== MINTS.SOL && mint !== MINTS.USDC) {
            const mintPk = new PublicKey(mint);
            const [posAddr] = PublicKey.findProgramAddressSync(
              [Buffer.from('position'), mintPk.toBuffer()],
              ORCA_WHIRLPOOL_PROGRAM_ID,
            );
            const accInfo = await conn.getAccountInfo(posAddr);
            if (accInfo && accInfo.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) {
              orphanMints.push(mintPk);
            }
          }
        }

        if (orphanMints.length > 0) {
          console.log(JSON.stringify({ level: 'warn', msg: `found ${orphanMints.length} orphaned position(s), recovering...`, mints: orphanMints.map(m => m.toBase58()), timestamp: Date.now() }));
          const { buildWhirlpoolClient: bwc, PriceMath: PM } = await import('@orca-so/whirlpools-sdk');
          const { Percentage: Pct } = await import('@orca-so/common-sdk');
          const recoveryCtx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
          const recoveryClient = bwc(recoveryCtx);
          const whirlpool = await recoveryClient.getPool(new PublicKey(WHIRLPOOL_ADDRESS));
          const poolData = whirlpool.getData();
          const price = PM.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();
          const slippage = Pct.fromFraction(2, 100);

          const solBefore = await conn.getBalance(wallet.publicKey) / 1e9;
          const usdcAtaBefore = await (async () => { try { const { getAssociatedTokenAddress: gata, getAccount: ga } = await import('@solana/spl-token'); const ata = await gata(new PublicKey(MINTS.USDC), wallet.publicKey); return Number((await ga(conn, ata)).amount) / 1e6; } catch { return 0; } })();

          for (const mint of orphanMints) {
            const [posAddr] = PublicKey.findProgramAddressSync(
              [Buffer.from('position'), mint.toBuffer()],
              ORCA_WHIRLPOOL_PROGRAM_ID,
            );
            try {
              const position = await recoveryClient.getPosition(posAddr);
              const posData = position.getData();
              const priceLower = PM.tickIndexToPrice(posData.tickLowerIndex, 9, 6).toNumber();
              const priceUpper = PM.tickIndexToPrice(posData.tickUpperIndex, 9, 6).toNumber();
              console.log(JSON.stringify({ level: 'info', msg: `closing orphan: ${mint.toBase58().slice(0, 12)}... range $${priceLower.toFixed(2)}-$${priceUpper.toFixed(2)}, liq=${posData.liquidity.toString()}`, timestamp: Date.now() }));

              const txBuilders = await whirlpool.closePosition(posAddr, slippage, wallet.publicKey, wallet.publicKey, wallet.publicKey);
              for (const txb of txBuilders) {
                const sig = await txb.buildAndExecute();
                liveExecutor.txCount++;
                console.log(JSON.stringify({ level: 'info', msg: `orphan close tx: ${sig.slice(0, 20)}...`, timestamp: Date.now() }));
                await new Promise(r => setTimeout(r, 2000));
              }

              console.log(JSON.stringify({ level: 'info', msg: `orphan ${mint.toBase58().slice(0, 12)}... closed successfully`, timestamp: Date.now() }));
            } catch (err) {
              console.log(JSON.stringify({ level: 'error', msg: `failed to close orphan ${mint.toBase58().slice(0, 12)}...`, error: String(err), timestamp: Date.now() }));
            }
          }

          // Log recovery
          await new Promise(r => setTimeout(r, 2000));
          const solAfter = await conn.getBalance(wallet.publicKey) / 1e9;
          const usdcAtaAfter = await (async () => { try { const { getAssociatedTokenAddress: gata, getAccount: ga } = await import('@solana/spl-token'); const ata = await gata(new PublicKey(MINTS.USDC), wallet.publicKey); return Number((await ga(conn, ata)).amount) / 1e6; } catch { return 0; } })();
          const recoveredUsdc = (solAfter - solBefore) * price + (usdcAtaAfter - usdcAtaBefore);
          console.log(JSON.stringify({ level: 'info', msg: `orphan recovery complete: recovered ${(solAfter - solBefore).toFixed(4)} SOL + ${(usdcAtaAfter - usdcAtaBefore).toFixed(2)} USDC (~$${recoveredUsdc.toFixed(2)})`, timestamp: Date.now() }));

          insertRebalanceEventWithRule2(db, {
            timestamp: Date.now(), eventType: 'POSITION_CLOSED', price, regime: liveRegime,
            note: `ORPHAN RECOVERY: Found ${orphanMints.length} position(s) not tracked by DB. Closed and recovered ~$${recoveredUsdc.toFixed(2)} to wallet.`,
            solBefore: solBefore, usdcBefore: usdcAtaBefore, solAfter, usdcAfter: usdcAtaAfter,
            feeSol: 0, feeUsdc: 0, ilAtClose: 0,
          });
          insertDecisionLog(db, {
            timestamp: Date.now(), price, regime: liveRegime, bot_state: 'IDLE',
            prox_lower: null, prox_upper: null, in_range: null,
            decision: 'ORPHAN_RECOVERY', reasoning: `Detected ${orphanMints.length} on-chain position(s) not in DB. Closed all and recovered ~$${recoveredUsdc.toFixed(2)}. Mints: ${orphanMints.map(m => m.toBase58().slice(0, 12)).join(', ')}`,
            params_json: null,
          });
        } else {
          console.log(JSON.stringify({ level: 'info', msg: 'no orphaned positions found', timestamp: Date.now() }));
        }
      } catch (err) {
        console.log(JSON.stringify({ level: 'warn', msg: `orphan scan failed (non-fatal): ${String(err)}`, timestamp: Date.now() }));
      }
    }
  }

  if (!liveExecutor) {
    console.error('LiveExecutor not initialized. Check WALLET_PRIVATE_KEY.');
    process.exit(1);
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
  console.log(`
+-------------------------------------------+
|  SOL/USDC LP Bot MVP  ·  LIVE MODE ⚡ REAL MONEY|
|  Capital: $${runtime.maxLiveCapitalUsdc.toLocaleString('en-US')} USDC  ·  Pool: SOL/USDC  |
|  Dashboard: http://localhost:${DASHBOARD_PORT}          |
|  DB: ${DB_PATH.padEnd(36)}|
|  Press Ctrl+C to stop gracefully          |
+-------------------------------------------+
`);

  // ── DECISION LOOP ─────────────────────────────────────────────────────

  let cycleRunning = false;
  let lastPruneTime = Date.now();

  const decisionLoop = setInterval(async () => {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      const price = oracle.getPrice();
      if (!price) return;

      await pool.fetchState();

      if (!botPaused) await runLiveCycle(price.price);

      // Store price tick for regime detection
      insertPriceTick(db, {
        timestamp: Date.now(), price: price.price, confidence: price.confidence,
        regime: liveRegime, prox_lower: null, prox_upper: null, in_range: 0,
      });

      // Print live status to terminal
      const livePos = liveExecutor!.getCurrentPosition();
      const stateStr = `[${liveBotState}] SOL=$${price.price.toFixed(2)} regime=${liveRegime}`;
      const posStr = livePos ? `pos: $${livePos.priceLower.toFixed(2)}-$${livePos.priceUpper.toFixed(2)}` : 'no position';
      console.log(JSON.stringify({ level: 'info', msg: `LIVE cycle: ${stateStr} ${posStr}`, timestamp: Date.now() }));

      dashboard.updateData(getRebalanceEvents(db, 50), liveBotState, getDailyPnl(db, 7));

      // Update live dashboard data
      {
        const exec = liveExecutor!;
        try {
          const wallet = (exec as any).wallet;
          const balances = await getWalletBalances(conn, wallet.publicKey);
          const livePos = exec.getCurrentPosition();
          const posData = await exec.getPositionData();
          const posComp = await exec.getPositionComposition();

          // Real pending fees from on-chain fee growth data (every 2 min, expensive: 4 RPC calls)
          const nowMs = Date.now();
          if (nowMs - lastPendingFeesCheck >= 120_000) {
            lastPendingFeesCheck = nowMs;
            const freshFees = await exec.getPendingFees();
            if (freshFees) {
              cachedPendingFeesSol = freshFees.feeSolDecimal;
              cachedPendingFeesUsdc = freshFees.feeUsdcDecimal;
              cachedPendingFeesTotal = freshFees.feeTotalUsdc;
            }
          }
          const pendingFeesSol = cachedPendingFeesSol;
          const pendingFeesUsdc = cachedPendingFeesUsdc;
          const pendingFeesTotal = cachedPendingFeesTotal;
          const totalFeesUsdc = pendingFeesTotal + liveCumFeesSol * price.price + liveCumFeesUsdc;

          // Position composition
          const positionSol = posComp?.sol ?? 0;
          const positionUsdc = posComp?.usdc ?? 0;
          const positionValueUsdc = posComp?.totalUsdc ?? 0;
          const walletValueUsdc = balances.sol * price.price + balances.usdc;
          const totalWithPosition = walletValueUsdc + positionValueUsdc;

          // Estimated 24h yield from on-chain liquidity share + Orca API volume
          const poolStatsData = dashboard.getPoolStats();
          const yieldEst = await exec.getEstimatedYield24h(poolStatsData?.volume24h);
          const estDailyFeesUsdc = yieldEst?.dailyFeesUsdc ?? 0;
          const estAprPct = yieldEst?.aprPct ?? 0;

          // Calculate IL
          let ilUsdc = 0;
          if (livePos && livePos.entryPrice && livePos.entryPrice !== price.price) {
            const priceRatio = price.price / livePos.entryPrice;
            const ilPct = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
            ilUsdc = ilPct * totalWithPosition;
          }

          const liveDataUpdate: LiveData = {
            walletAddress: wallet.publicKey.toBase58(),
            solBalance: balances.sol,
            usdcBalance: balances.usdc,
            totalValueUsdc: walletValueUsdc,
            solPrice: price.price,
            positionMint: livePos?.positionMint.toBase58() ?? null,
            positionRange: posData ? { lower: posData.priceLower, upper: posData.priceUpper } : null,
            positionLiquidity: posData?.liquidity ?? null,
            feeOwedSol: pendingFeesSol > 0 ? pendingFeesSol.toString() : null,
            feeOwedUsdc: pendingFeesUsdc > 0 ? pendingFeesUsdc.toString() : null,
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
            entrySol: livePos?.entrySol ?? positionSol,
            entryUsdc: livePos?.entryUsdc ?? positionUsdc,
            ilUsdc,
            realizedIlUsdc: liveRealizedIl,
            ...(() => { const g = liveExecutor!.getGasStats(price.price); return { gasSol: g.gasSol, gasUsdc: g.gasUsdc, txCount: g.txCount }; })(),
            estDailyFeesUsdc,
            estAprPct,
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
            pending_fees_sol: pendingFeesSol,
            pending_fees_usdc: pendingFeesUsdc,
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
      const livePos2 = liveExecutor?.getCurrentPosition();
      upsertBotState(db, {
        state: liveBotState,
        regime: liveRegime,
        position_json: livePos2
          ? JSON.stringify({ ...livePos2, positionMint: livePos2.positionMint.toBase58(), positionAddress: livePos2.positionAddress.toBase58() })
          : 'null',
        updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
      });

      checkAndWriteDailyPnl(price.price);

      // Prune old price ticks once per day
      const now2 = Date.now();
      if (now2 - lastPruneTime > 86400_000) {
        lastPruneTime = now2;
        const { pruneOldPriceTicks } = await import('./db/sqlite.js');
        pruneOldPriceTicks(db, 30);
        console.log(JSON.stringify({ level: 'info', msg: 'pruned price ticks older than 30 days', timestamp: now2 }));
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'cycle error', error: String(err), timestamp: Date.now() }));
    } finally {
      cycleRunning = false;
    }
  }, runtime.decisionIntervalSeconds * 1000);

  // Dashboard control handlers
  let botPaused = false;

  {
    const executor = liveExecutor!;
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

    dashboard.onToggleRule2((enabled) => {
      rule2Enabled = enabled;
      setRuleEnabled(db, 'rule2', enabled);
      const action = enabled ? 'ENABLED' : 'DISABLED';
      console.log(JSON.stringify({ level: 'info', msg: `Rule 2 (proximity exit) ${action} from dashboard`, timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price: 0, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: `RULE2_${action}`, reasoning: `Rule 2 (proximity early exit) ${action.toLowerCase()} from dashboard. ${enabled ? 'Positions will now exit early based on proximity thresholds.' : 'Positions will only close when fully out of range (OOR).'}`,
        params_json: null });
    });

    dashboard.onToggleAutoDeploy((enabled) => {
      autoDeployEnabled = enabled;
      setRuleEnabled(db, 'autoDeploy', enabled);
      const action = enabled ? 'ENABLED' : 'DISABLED';
      console.log(JSON.stringify({ level: 'info', msg: `Auto Capital Deploy ${action} from dashboard`, timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price: 0, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: `AUTODEPLOY_${action}`, reasoning: `Auto capital deployment ${action.toLowerCase()} from dashboard. ${enabled ? 'Idle wallet funds will be automatically deployed into the position when conditions are met.' : 'Auto deployment disabled. Use manual Add Liquidity to deploy capital.'}`,
        params_json: null });
      // Trigger immediate check when enabled (skip the 5-min wait)
      if (enabled) liveLastAutoDeployCheck = 0;
    });

    dashboard.onAddLiquidityPreview(async () => {
      const currentPrice = currentLiveData?.solPrice ?? 0;
      return executor.getAddLiquidityPreview(currentPrice);
    });

    dashboard.onAddLiquidity(async () => {
      const currentPrice = currentLiveData?.solPrice ?? 0;
      console.log(JSON.stringify({ level: 'info', msg: 'ADD LIQUIDITY triggered from dashboard', timestamp: Date.now() }));
      const result = await executor.increaseLiquidity(currentPrice);
      if (!result) throw new Error('No valid liquidity quote — insufficient funds or position out of range');
      insertRebalanceEventWithRule2(db, {
        timestamp: Date.now(), eventType: 'LIQUIDITY_ADDED', price: currentPrice, regime: liveRegime,
        note: `Manual add liquidity from dashboard. Deposited ${result.solDeposited.toFixed(6)} SOL + ${result.usdcDeposited.toFixed(2)} USDC = $${result.totalUsdc.toFixed(2)}. Liquidity added: ${result.liquidityAdded}.`,
        solBefore: 0, usdcBefore: 0, solAfter: result.solDeposited, usdcAfter: result.usdcDeposited,
        feeSol: 0, feeUsdc: 0, ilAtClose: 0,
      });
      insertDecisionLog(db, { timestamp: Date.now(), price: currentPrice, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'LIQUIDITY_ADDED', reasoning: `Added liquidity to existing position from dashboard. Deposited ${result.solDeposited.toFixed(4)} SOL + ${result.usdcDeposited.toFixed(2)} USDC ($${result.totalUsdc.toFixed(2)}). Position range unchanged.`,
        params_json: null });
      return result;
    });

    dashboard.onHarvest(async () => {
      const currentPrice = currentLiveData?.solPrice ?? 0;
      console.log(JSON.stringify({ level: 'info', msg: 'Manual fee harvest from dashboard', timestamp: Date.now() }));
      const fees = await executor.collectFees();
      liveCumFeesSol += fees.feeSol;
      liveCumFeesUsdc += fees.feeUsdc;
      const feeTotalUsdc = fees.feeSol * currentPrice + fees.feeUsdc;
      insertRebalanceEventWithRule2(db, {
        timestamp: Date.now(), eventType: 'FEE_HARVEST', price: currentPrice, regime: liveRegime,
        note: `Manual harvest from dashboard. Collected ${fees.feeSol.toFixed(6)} SOL ($${(fees.feeSol * currentPrice).toFixed(4)}) + ${fees.feeUsdc.toFixed(6)} USDC = $${feeTotalUsdc.toFixed(4)} total. Cumulative: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.`,
        solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
        feeSol: fees.feeSol, feeUsdc: fees.feeUsdc, ilAtClose: 0,
      });
      return fees;
    });

    dashboard.onClosePosition(async () => {
      console.log(JSON.stringify({ level: 'warn', msg: 'CLOSE POSITION triggered from dashboard', timestamp: Date.now() }));

      if (!executor.getCurrentPosition()) {
        throw new Error('No position open to close.');
      }

      const currentPrice = currentLiveData?.solPrice ?? 0;
      const closingPosId = executor.getCurrentPosition()?.positionMint?.toBase58() ?? undefined;
      const balBefore = await getWalletBalances(conn, liveWallet.publicKey);
      console.log(JSON.stringify({ level: 'info', msg: 'Closing live position (keep bot running)...', timestamp: Date.now() }));
      const result = await executor.closePosition();
      const balAfter = await getWalletBalances(conn, liveWallet.publicKey);

      liveCumFeesSol += result.feeSolCollected;
      liveCumFeesUsdc += result.feeUsdcCollected;
      liveRealizedIl += result.ilAtClose;

      insertRebalanceEventWithRule2(db, {
        timestamp: Date.now(), eventType: 'POSITION_CLOSED', price: result.closePrice, regime: liveRegime,
        note: `WHY: Close Position triggered from dashboard. Range was $${result.priceLower.toFixed(2)}-$${result.priceUpper.toFixed(2)}, entry at $${result.entryPrice.toFixed(2)}.\nEXECUTED: Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)}). Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC.`,
        solBefore: balBefore.sol, usdcBefore: balBefore.usdc,
        solAfter: balAfter.sol, usdcAfter: balAfter.usdc,
        feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
      }, closingPosId);
      insertDecisionLog(db, { timestamp: Date.now(), price: result.closePrice, regime: liveRegime, bot_state: 'IDLE',
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'CLOSE_POSITION', reasoning: `Position closed from dashboard. Bot paused in IDLE. Fees: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Click Resume to restart.`,
        params_json: null });

      botPaused = true;
      liveBotState = 'IDLE';
      upsertBotState(db, {
        state: 'IDLE', regime: liveRegime,
        position_json: 'null', updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
      });

      console.log(JSON.stringify({ level: 'info', msg: 'Position closed. Bot paused in IDLE.', timestamp: Date.now() }));
    });

    dashboard.onEmergencyStop(async () => {
      console.log(JSON.stringify({ level: 'warn', msg: 'EMERGENCY STOP triggered from dashboard', timestamp: Date.now() }));
      clearInterval(decisionLoop);
      oracle.stop();

      if (executor.getCurrentPosition()) {
        const emergencyPosId = executor.getCurrentPosition()?.positionMint?.toBase58() ?? undefined;
        const balBefore = await getWalletBalances(conn, liveWallet.publicKey);
        console.log(JSON.stringify({ level: 'info', msg: 'Closing live position...', timestamp: Date.now() }));
        const result = await executor.closePosition();
        const balAfter = await getWalletBalances(conn, liveWallet.publicKey);

        liveCumFeesSol += result.feeSolCollected;
        liveCumFeesUsdc += result.feeUsdcCollected;
        liveRealizedIl += result.ilAtClose;

        insertRebalanceEventWithRule2(db, {
          timestamp: Date.now(), eventType: 'POSITION_CLOSED', price: result.closePrice, regime: liveRegime,
          note: `WHY: Emergency stop triggered from dashboard. Range was $${result.priceLower.toFixed(2)}-$${result.priceUpper.toFixed(2)}, entry at $${result.entryPrice.toFixed(2)}.\nEXECUTED: Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)}). Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC.`,
          solBefore: balBefore.sol, usdcBefore: balBefore.usdc,
          solAfter: balAfter.sol, usdcAfter: balAfter.usdc,
          feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
        }, emergencyPosId);
        insertDecisionLog(db, { timestamp: Date.now(), price: result.closePrice, regime: liveRegime, bot_state: 'IDLE',
          prox_lower: null, prox_upper: null, in_range: null,
          decision: 'EMERGENCY_STOP', reasoning: `Emergency stop from dashboard. Fees: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC.`,
          params_json: null });
        console.log(JSON.stringify({ level: 'info', msg: 'Live position closed.', timestamp: Date.now() }));
      }

      liveBotState = 'IDLE';
      upsertBotState(db, {
        state: 'IDLE', regime: liveRegime,
        position_json: 'null', updated_at: Date.now(),
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
      state: liveBotState,
      regime: liveRegime,
      position_json: livePos
        ? JSON.stringify({ ...livePos, positionMint: livePos.positionMint.toBase58(), positionAddress: livePos.positionAddress.toBase58() })
        : 'null',
      updated_at: Date.now(),
      cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
      tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
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

  // Track recent prices for flash crash detection (keep last 10)
  liveRecentPrices.push(price);
  if (liveRecentPrices.length > 10) liveRecentPrices.shift();

  // Regime update (every 1 hour)
  if (now - liveLastRegimeCheck > 3_600_000) {
    const closes = getDailyCloses(db, runtime.regimeWindowDays);
    const MIN_CLOSES_FOR_REGIME_CHANGE = 5;
    const result = closes.length >= 3
      ? detectRegimeWithMetrics(closes, runtime.trendThreshold)
      : { regime: 'RANGING' as const, dirRatio: 0, realisedVol: 0, priceCount: closes.length };

    // Determine thresholds for reasoning
    const volStatus = result.realisedVol > 0.08 ? 'ABOVE 0.08 threshold → EXTREME' : `${result.realisedVol.toFixed(4)} (below 0.08 threshold)`;
    const dirStatus = result.dirRatio > runtime.trendThreshold ? `ABOVE ${runtime.trendThreshold} threshold → trending` : `${result.dirRatio.toFixed(3)} (below ${runtime.trendThreshold} threshold → ranging)`;
    const priceDir = closes.length >= 2 ? (closes[closes.length - 1] > closes[0] ? 'UP' : 'DOWN') : 'N/A';
    // Suppress regime changes on thin data to prevent flapping
    const changed = result.regime !== liveRegime && closes.length >= MIN_CLOSES_FOR_REGIME_CHANGE;

    // Log regime changes immediately; unchanged evals only every 1 hour
    if (changed || now - liveLastRegimeEvalLog >= 3_600_000) {
      liveLastRegimeEvalLog = now;
      insertDecisionLog(db, { timestamp: now, price, regime: result.regime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: changed ? 'REGIME_CHANGE' : 'REGIME_EVAL',
        reasoning: `Regime evaluation: ${result.priceCount} daily closes analyzed over ${runtime.regimeWindowDays} days. ` +
          `realisedVol=${volStatus}. dirRatio=${dirStatus}. Price direction: ${priceDir}. ` +
          `${closes.length >= 2 ? `Price range: $${Math.min(...closes).toFixed(2)}-$${Math.max(...closes).toFixed(2)}.` : 'Insufficient data.'} ` +
          `Result: ${result.regime}${changed ? ` (CHANGED from ${liveRegime})` : ' (no change)'}.`,
        params_json: JSON.stringify({ dirRatio: result.dirRatio, realisedVol: result.realisedVol, priceCount: result.priceCount, trendThreshold: runtime.trendThreshold }) });
    }

    if (changed) {
      const oldRegime = liveRegime;
      liveRegime = result.regime;
      console.log(JSON.stringify({ level: 'info', msg: 'LIVE regime change', from: oldRegime, to: result.regime, dirRatio: result.dirRatio.toFixed(3), vol: result.realisedVol.toFixed(4), timestamp: now }));
      insertRegimeChange(db, {
        timestamp: now, old_regime: oldRegime, new_regime: result.regime, price,
        dir_ratio: result.dirRatio, realised_vol: result.realisedVol, price_count: result.priceCount,
      });
      insertRebalanceEventWithRule2(db, {
        timestamp: now, eventType: 'REGIME_CHANGE', price, regime: result.regime,
        note: `WHY: dirRatio=${result.dirRatio.toFixed(3)} (threshold ${runtime.trendThreshold}), realisedVol=${result.realisedVol.toFixed(4)} (threshold 0.08), ${result.priceCount} daily closes, price direction: ${priceDir}.\nEXECUTED: Regime changed from ${oldRegime} to ${result.regime}. All rule parameters updated.`,
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
  if (liveRebalancesThisHour >= runtime.rebalanceLoopLimit) return;

  const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
  const currentPos = liveExecutor.getCurrentPosition();

  // No position → open one
  if (!currentPos) {
    if (livePullbackActive) {
      // Flash crash detection: if price dropped >= 5% in recent candles, enforce cooldown
      if (now < liveFlashCrashCooldownUntil) {
        return; // still in flash crash cooldown, skip re-entry
      }
      if (isFlashCrash(liveRecentPrices)) {
        liveFlashCrashCooldownUntil = now + runtime.flashCrashWaitMinutes * 60_000;
        const oldPeak = livePullbackPeak;
        livePullbackPeak = price;   // Reset peak to crash level
        livePullbackStart = now;    // Reset 4h timeout from now
        console.log(JSON.stringify({ level: 'warn', msg: `Flash crash detected (>=${runtime.flashCrashPct}% drop). Peak reset $${oldPeak.toFixed(2)} → $${price.toFixed(2)}. Timeout reset. Waiting ${runtime.flashCrashWaitMinutes}min.`, timestamp: now }));
        insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
          prox_lower: null, prox_upper: null, in_range: null,
          decision: 'FLASH_CRASH_COOLDOWN', reasoning: `Flash crash detected: price dropped >=${runtime.flashCrashPct}% in recent candles. Peak reset from $${oldPeak.toFixed(2)} to $${price.toFixed(2)}. 4h timeout reset. Blocking re-entry for ${runtime.flashCrashWaitMinutes} minutes to avoid catching a falling knife.`,
          params_json: null });
        return;
      }

      const decision = shouldReenterAfterUpside(price, livePullbackPeak, livePullbackStart, now);
      if (decision.should) {
        livePullbackActive = false;
        liveFlashCrashCooldownUntil = 0;
        const waitH = ((now - livePullbackStart) / 3600_000).toFixed(1);
        const pullPct = ((livePullbackPeak - price) / livePullbackPeak * 100).toFixed(1);
        const reason = decision.reason === 'PULLBACK'
          ? `Rule 3 pullback re-entry: price pulled back ${pullPct}% from peak $${livePullbackPeak.toFixed(2)} (threshold: ${runtime.pullbackThresholdPct}%). Waited ${waitH}h.`
          : `Rule 3 timeout re-entry: waited ${waitH}h without sufficient pullback (${pullPct}% vs ${runtime.pullbackThresholdPct}% threshold).`;
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
    if (rule2Enabled) {
      if (shouldFireDownside(prox, params.proxThresholdLower, 0, 0)) {
        const proxPct = (prox.proxToLower * 100).toFixed(0);
        const reason = `Rule 2 early downside exit: proxToLower=${proxPct}% >= threshold ${(params.proxThresholdLower*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} drifting toward lower bound $${currentPos.priceLower.toFixed(2)}. Closing to avoid full OOR impermanent loss.`;
        await liveCloseAndReopen(price, 'T1_DOWNSIDE', reason);
        return;
      }
      if (shouldFireUpside(prox, params.proxThresholdUpper)) {
        const proxPct = (prox.proxToUpper * 100).toFixed(0);
        const timeoutStr = runtime.timeoutHours >= 1 ? `${runtime.timeoutHours}h` : `${Math.round(runtime.timeoutHours * 60)}min`;
        const reason = `Rule 2 early upside exit: proxToUpper=${proxPct}% >= threshold ${(params.proxThresholdUpper*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} nearing upper bound $${currentPos.priceUpper.toFixed(2)}. Closing and entering Rule 3 pullback watch — will wait for ${runtime.pullbackThresholdPct}% pullback or ${timeoutStr} timeout.`;
        await liveClosePosition(price, 'T1_UPSIDE', reason);
        livePullbackActive = true;
        livePullbackPeak = price;
        livePullbackStart = now;
        liveBotState = 'WAITING_PULLBACK';
        return;
      }
    }
    // Log HOLD decision every 30 minutes
    if (now - lastHoldLogTime >= 1_800_000) {
      lastHoldLogTime = now;
      const rule2Note = rule2Enabled ? '' : ' [Rule 2 BYPASSED — proximity exit disabled, will only close on full OOR]';
      insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
        prox_lower: prox.proxToLower, prox_upper: prox.proxToUpper, in_range: 1,
        decision: 'HOLD', reasoning: `Position in range. Price $${price.toFixed(2)} within $${currentPos.priceLower.toFixed(2)}-$${currentPos.priceUpper.toFixed(2)}. proxDown=${(prox.proxToLower*100).toFixed(0)}% (need ${(params.proxThresholdLower*100).toFixed(0)}% to trigger downside exit), proxUp=${(prox.proxToUpper*100).toFixed(0)}% (need ${(params.proxThresholdUpper*100).toFixed(0)}% to trigger upside exit). Regime: ${liveRegime}. Holding — position is earning fees.${rule2Note}`,
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

  // Fee harvest (check every 1 hour)
  if (now - liveLastHarvestCheck >= 3_600_000) {
    liveLastHarvestCheck = now;
    if (isHarvestDue(liveLastHarvestTime, params, now)) {
      try {
        const daysSinceHarvest = ((now - liveLastHarvestTime) / 86400_000).toFixed(1);
        const fees = await liveExecutor.collectFees();
        liveCumFeesSol += fees.feeSol;
        liveCumFeesUsdc += fees.feeUsdc;
        liveLastHarvestTime = now;

        // Convert harvested SOL to USDC based on regime's harvestSolConvertPct
        let convertNote = '';
        if (params.harvestSolConvertPct > 0 && fees.feeSol > 0.0001) {
          const conversion = await liveExecutor.convertHarvestedSol(fees.feeSol, params.harvestSolConvertPct);
          if (conversion) {
            convertNote = ` Converted ${conversion.solSwapped.toFixed(6)} SOL → ${conversion.usdcReceived.toFixed(2)} USDC (${(params.harvestSolConvertPct * 100).toFixed(0)}% regime policy).`;
          }
        }

        insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
          prox_lower: null, prox_upper: null, in_range: null,
          decision: 'FEE_HARVEST', reasoning: `Harvest due: ${daysSinceHarvest} days since last. Collected ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC. Cumulative: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.${convertNote}`,
          params_json: null });
        insertRebalanceEventWithRule2(db, {
          timestamp: now, eventType: 'FEE_HARVEST', price, regime: liveRegime,
          note: `Collected fees: ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC. Cumulative total: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.${convertNote}`,
          solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
          feeSol: fees.feeSol, feeUsdc: fees.feeUsdc, ilAtClose: 0,
        });
      } catch (err) {
        console.log(JSON.stringify({ level: 'error', msg: 'fee harvest failed', error: String(err), timestamp: now }));
      }
    }
  }

  // Auto capital deployment — check every 5 minutes for idle wallet funds to deploy
  if (prox.inRange && now - liveLastAutoDeployCheck >= runtime.autoDeployCheckMinutes * 60_000) {
    liveLastAutoDeployCheck = now;
    try {
      const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
      const posComp = await liveExecutor.getPositionComposition();
      const posValue = posComp?.totalUsdc ?? 0;

      const deployCheck = checkAutoDeploy({
        currentPrice: price,
        priceLower: currentPos.priceLower,
        priceUpper: currentPos.priceUpper,
        walletSol: balances.sol,
        walletUsdc: balances.usdc,
        positionValueUsdc: posValue,
        regime: liveRegime,
        params,
        lastDeployTime: liveLastAutoDeployTime,
        now,
        enabled: autoDeployEnabled,
        minIdleUsdc: runtime.minIdleUsdc,
        minIdleSol: runtime.minIdleSol,
        minDeployUsdc: runtime.minDeployUsdc,
        deployRatioTolerance: runtime.deployRatioTolerance,
      });

      if (deployCheck.shouldDeploy) {
        console.log(JSON.stringify({ level: 'info', msg: `AUTO_DEPLOY: deploying $${deployCheck.deployableUsdc.toFixed(2)} idle capital`, timestamp: now }));
        const result = await liveExecutor.increaseLiquidity(price, deployCheck.deployableUsdc);
        if (!result) {
          console.log(JSON.stringify({ level: 'warn', msg: 'AUTO_DEPLOY: increaseLiquidity returned null, skipping', timestamp: now }));
        } else {
        liveLastAutoDeployTime = now;

        insertRebalanceEventWithRule2(db, {
          timestamp: now, eventType: 'AUTO_DEPLOY', price, regime: liveRegime,
          note: `WHY: ${deployCheck.reason}\nEXECUTED: Auto-deployed ${result.solDeposited.toFixed(6)} SOL + ${result.usdcDeposited.toFixed(2)} USDC = $${result.totalUsdc.toFixed(2)}. Liquidity added: ${result.liquidityAdded}. Ideal price: $${deployCheck.idealPrice.toFixed(2)}, cap: ${(deployCheck.currentDeployPct * 100).toFixed(0)}%.`,
          solBefore: balances.sol, usdcBefore: balances.usdc,
          solAfter: balances.sol - result.solDeposited, usdcAfter: balances.usdc - result.usdcDeposited,
          feeSol: 0, feeUsdc: 0, ilAtClose: 0,
        });
        insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
          prox_lower: prox.proxToLower, prox_upper: prox.proxToUpper, in_range: 1,
          decision: 'AUTO_DEPLOY', reasoning: `${deployCheck.reason}\nDeposited ${result.solDeposited.toFixed(4)} SOL + ${result.usdcDeposited.toFixed(2)} USDC ($${result.totalUsdc.toFixed(2)}). Position range: $${currentPos.priceLower.toFixed(2)}-$${currentPos.priceUpper.toFixed(2)}.`,
          params_json: JSON.stringify({ idleUsdc: deployCheck.idleUsdc, idealPrice: deployCheck.idealPrice, deployPct: deployCheck.currentDeployPct, deployableUsdc: deployCheck.deployableUsdc }) });
        }
      } else {
        // Log skip reason periodically (every 30 min, same cadence as HOLD log)
        if (now - lastHoldLogTime >= 1_800_000 && deployCheck.reason !== 'DEPLOY_SKIPPED_DISABLED') {
          insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
            prox_lower: prox.proxToLower, prox_upper: prox.proxToUpper, in_range: 1,
            decision: 'DEPLOY_SKIP', reasoning: deployCheck.reason,
            params_json: JSON.stringify({ idleUsdc: deployCheck.idleUsdc, idealPrice: deployCheck.idealPrice, deployPct: deployCheck.currentDeployPct, deployableUsdc: deployCheck.deployableUsdc }) });
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'auto-deploy check failed', error: String(err), timestamp: now }));
    }
  }

  liveBotState = 'ACTIVE';
}

async function liveOpenPosition(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  if (!liveExecutor) return;
  const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
  const effectiveParams = runtime.rangeWidthOverride !== null
    ? { ...params, rangeWidthPct: runtime.rangeWidthOverride }
    : params;
  const range = calcRange(price, effectiveParams, (p) => pool.priceToTick(p), (p) => pool.priceToTickLower(p), (p) => pool.priceToTickUpper(p));

  const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const totalWalletUsdc = balances.sol * price + balances.usdc;
  const reserveUsdc = 0.1 * price + 1; // SOL reserve (in USDC) + USDC reserve
  const deployUsdc = Math.min(totalWalletUsdc * effectiveParams.deployPct, totalWalletUsdc - reserveUsdc);
  if (deployUsdc < 5) {
    console.log(JSON.stringify({ level: 'warn', msg: 'insufficient funds to open position', sol: balances.sol, usdc: balances.usdc, timestamp: Date.now() }));
    return;
  }

  // Build reasoning
  const why = triggerReason ?? `No open position detected.`;
  const widthNote = runtime.rangeWidthOverride !== null ? ` (override: ${runtime.rangeWidthOverride}%, regime default: ${params.rangeWidthPct}%)` : `%`;
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

    // Auto-enable auto-deploy if position opened with less than 50% of target
    if (!autoDeployEnabled && depositedTotal < deployUsdc * 0.5) {
      autoDeployEnabled = true;
      setRuleEnabled(db, 'autoDeploy', true);
      dashboard.setAutoDeployEnabled(true);
      console.log(JSON.stringify({ level: 'info', msg: `Auto-deploy auto-enabled: deployed $${depositedTotal.toFixed(2)} of $${deployUsdc.toFixed(2)} target (${(depositedTotal / deployUsdc * 100).toFixed(0)}%). Idle capital will be deployed within ${runtime.autoDeployCheckMinutes} min.`, timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'AUTODEPLOY_ENABLED', reasoning: `Auto-deploy auto-enabled after partial position open. Deployed $${depositedTotal.toFixed(2)} of $${deployUsdc.toFixed(2)} target (${(depositedTotal / deployUsdc * 100).toFixed(0)}%). Remaining idle capital will be deployed via Rule 7.`,
        params_json: null });
    }

    insertRebalanceEventWithRule2(db, {
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
    // Capture position ID before close (closePosition clears it)
    const closingPositionId = liveExecutor.getCurrentPosition()?.positionMint?.toBase58() ?? undefined;
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

    insertRebalanceEventWithRule2(db, {
      timestamp: Date.now(), eventType, price, regime: liveRegime,
      note: `WHY: ${why}${posInfo}\nEXECUTED: ${execution}`,
      solBefore: balancesBefore.sol, usdcBefore: balancesBefore.usdc,
      solAfter: balancesAfter.sol, usdcAfter: balancesAfter.usdc,
      feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
    }, closingPositionId);
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
let dailySummaryInitialValue = 0;
let dailySummaryCumInjected = 0;

function checkAndWriteDailyPnl(currentPrice: number) {
  const today = new Date().toISOString().slice(0, 10);
  const totalValue = currentLiveData?.totalValueWithPosition ?? 0;
  const walletValue = currentLiveData?.totalValueUsdc ?? 0;
  const positionValue = currentLiveData?.positionValueUsdc ?? 0;
  const cumFeesUsdc = liveCumFeesSol * currentPrice + liveCumFeesUsdc;
  const rawPending = (currentLiveData?.pendingFeesSol ?? 0) * currentPrice + (currentLiveData?.pendingFeesUsdc ?? 0);
  const pendingFeesUsdc = rawPending > 1000 ? 0 : rawPending;
  const totalFeesUsdc = cumFeesUsdc + pendingFeesUsdc;

  // New day: write daily_pnl and reset daily tracking
  if (today !== lastPnlDate) {
    // Detect injection: if total jumped significantly from yesterday's close
    if (lastPnlDate && dailySummaryInitialValue > 0) {
      const jump = totalValue - dailySummaryInitialValue;
      if (jump > Math.max(5, dailySummaryInitialValue * 0.05)) {
        dailySummaryCumInjected += jump;
      }
    }
    dailySummaryInitialValue = totalValue;
    lastPnlDate = today;

    upsertDailyPnl(db, {
      date: today,
      opening_value: totalValue,
      closing_value: totalValue,
      fees_sol: liveCumFeesSol, fees_usdc: liveCumFeesUsdc,
      il_cost: liveRealizedIl,
      net_pnl: totalFeesUsdc + liveRealizedIl, net_pnl_pct: totalValue > 0 ? ((totalFeesUsdc + liveRealizedIl) / totalValue) * 100 : 0,
      rebalances: 0,
      in_range_pct: null, regime: liveRegime,
    });
  }

  // Get yesterday's cumulative fees for daily delta
  const prevSummaries = getDailySummaries(db, 2);
  const yesterday = prevSummaries.find(s => s.date !== today);
  const prevCumFees = yesterday?.cum_fees_usdc ?? 0;
  const dailyFeesEarned = Math.max(0, totalFeesUsdc - prevCumFees);
  const portfolioChange = totalValue - dailySummaryInitialValue;

  // Upsert today's summary (updates every cycle with latest values)
  upsertDailySummary(db, {
    date: today,
    wallet_usdc: walletValue,
    position_usdc: positionValue,
    total_usdc: totalValue,
    injected_usdc: 0, // intra-day injections tracked separately
    fees_earned_usdc: dailyFeesEarned,
    cum_fees_usdc: totalFeesUsdc,
    portfolio_change: portfolioChange,
    sol_price: currentPrice,
    regime: liveRegime,
    in_range_pct: null,
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
