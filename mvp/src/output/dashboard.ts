import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';
import crypto from 'crypto';
import type { BotState, RebalanceEvent } from '../types.js';
import { type DailyPnlRow, type LiveSnapshotRow, type DailySummaryRow, getLiveSnapshots, getLiveInRangePct, getDecisionLogs, getRegimeHistory, getRebalanceEvents as dbGetRebalanceEvents, exportAllData, getRule2PerfComparison, getRule2EventsCsv, getConfig, setConfigBatch, getDailySummaries, getAllDailySummaries, getRegimeSnapshots } from '../db/sqlite.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { REGIME_PARAMS } from '../constants.js';
import { runtime, exportConfig, applyConfigFromDb } from '../config.js';

const TZ = 'Europe/Berlin';


interface OnChainTx {
  signature: string;
  time: string;
  fee: number;
  feeSol: number;
  feeUsdc: number;
  computeUnits: number;
  status: string;
  slot: number;
}

async function fetchRecentTransactions(rpcUrl: string, walletAddress: string, limit = 10, solPrice = 82): Promise<OnChainTx[]> {
  try {
    const conn = new Connection(rpcUrl);
    const wallet = new PublicKey(walletAddress);
    const sigs = await conn.getSignaturesForAddress(wallet, { limit });
    const txs: OnChainTx[] = [];
    for (const sig of sigs) {
      const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      const fee = tx?.meta?.fee ?? 0;
      const feeSol = fee / 1e9;
      const cu = tx?.meta?.computeUnitsConsumed ?? 0;
      txs.push({
        signature: sig.signature,
        time: new Date((sig.blockTime ?? 0) * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ }),
        fee,
        feeSol,
        feeUsdc: feeSol * solPrice,
        computeUnits: cu,
        status: tx?.meta?.err ? 'FAILED' : 'OK',
        slot: sig.slot,
      });
    }
    return txs;
  } catch {
    return [];
  }
}

export interface PoolStats {
  tvlUsdc: number;
  price: number;
  feeRate: number;          // e.g. 3000 = 0.30%
  volume24h: number;
  volume7d: number;
  volume30d: number;
  fees24h: number;
  fees7d: number;
  fees30d: number;
  yield24h: number;         // yieldOverTvl 24h
  yield7d: number;
  yield30d: number;
  priceDelta24h: number;    // % change
  volumeDelta24h: number;   // % change
  tokenBalanceA: number;    // SOL in pool
  tokenBalanceB: number;    // USDC in pool
  tickSpacing: number;
  lastFetched: number;
}

export interface LiveData {
  walletAddress: string;
  solBalance: number;
  usdcBalance: number;
  totalValueUsdc: number;
  solPrice: number;
  positionMint: string | null;
  positionRange: { lower: number; upper: number } | null;
  positionLiquidity: string | null;
  feeOwedSol: string | null;
  feeOwedUsdc: string | null;
  positionSol: number;
  positionUsdc: number;
  positionValueUsdc: number;
  totalValueWithPosition: number;
  pendingFeesSol: number;
  pendingFeesUsdc: number;
  pendingFeesTotal: number;
  cumHarvestedFeesSol: number;
  cumHarvestedFeesUsdc: number;
  totalFeesUsdc: number;
  solCostBasis: number;
  solTracked: number;
  costBasisLastUpdated: number;
  entryPrice: number | null;
  entryTime: number | null;
  entrySol: number | null;
  entryUsdc: number | null;
  ilUsdc: number;
  realizedIlUsdc: number;
  gasSol: number;
  gasUsdc: number;
  txCount: number;
  estDailyFeesUsdc: number;
  estAprPct: number;
  actual24hFeesUsdc: number;
  actual24hAprPct: number;
  reserveCurrent: number;
  reserveFloor: number;
  reserveState: string;
  reserveLastUpdated: number;
  positionRegime: string | null;
  churnGuardActive: boolean;
  churnGuardReason: string | null;
  churnGuardExpiresMin: number | null;
  churnGuardLastExitPrice: number | null;
  churnGuardLastExitAgeMin: number | null;
  regime: string;
  botState: BotState;
  liveEvents: RebalanceEvent[];
  marketSignals?: {
    vol1h: number | null;
    vol4h: number | null;
    solDelta24h: number | null;
    solVolume24h: number | null;
    btcDelta24h: number | null;
    btcPrice: number | null;
    volumeRatio4h: number | null;
    fearGreedIndex: number | null;
    fearGreedLabel: string | null;
    lastUpdated: number;
    errors: string[];
  };
}

export interface DashboardServer {
  updateData(
    events: RebalanceEvent[],
    botState: BotState,
    dailyPnl?: DailyPnlRow[],
  ): void;
  updateLiveData(live: LiveData): void;
  onEmergencyStop(handler: () => Promise<void>): void;
  onPause(handler: () => void): void;
  onResume(handler: () => void): void;
  onHarvest(handler: () => Promise<{ feeSol: number; feeUsdc: number }>): void;
  onClosePosition(handler: () => Promise<void>): void;
  onToggleRule2(handler: (enabled: boolean) => void): void;
  onToggleAutoDeploy(handler: (enabled: boolean) => void): void;
  onAddLiquidity(handler: () => Promise<{ solDeposited: number; usdcDeposited: number; totalUsdc: number; liquidityAdded: string }>): void;
  onAddLiquidityPreview(handler: () => Promise<{ solAvailable: number; usdcAvailable: number; totalAvailableUsdc: number; estSolDeposit: number; estUsdcDeposit: number; estTotalUsdc: number; positionRange: string; needsSwap: string } | null>): void;
  getRule2Enabled(): boolean;
  setRule2Enabled(enabled: boolean): void;
  getAutoDeployEnabled(): boolean;
  setAutoDeployEnabled(enabled: boolean): void;
  getPoolStats(): PoolStats | null;
  setDb(db: any): void;
  stop(): void;
}

export function startDashboard(port: number): DashboardServer {
  const app = express();
  app.set('etag', false);
  let server: Server;

  // --- No-auth routes (before auth middleware) ---
  app.get('/intelligence', async (_req, res) => {
    const { renderIntelligenceHtml } = await import('./intelligence-page.js');
    res.type('html').send(renderIntelligenceHtml());
  });
  app.get('/api/intelligence', (req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    try {
      const from = parseInt(req.query?.from as string) || 0;
      const to = parseInt(req.query?.to as string) || Date.now();
      // Daily fees from daily_summary
      const dailyFees = dbRef.prepare("SELECT date, fees_earned_usdc as fees, total_usdc, regime, in_range_pct FROM daily_summary ORDER BY date ASC").all() as any[];
      // Positions from rebalance_events (open+close pairs)
      const events = dbRef.prepare("SELECT timestamp, event_type, price, fee_sol, fee_usdc, il_at_close, regime, sol_before, sol_after, usdc_before, usdc_after FROM rebalance_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC").all(from || 0, to) as any[];
      const positions: any[] = [];
      let lastOpen: any = null;
      for (const e of events) {
        if (e.event_type === 'POSITION_OPENED' || e.event_type === 'PULLBACK_REENTRY') {
          lastOpen = { entryTime: e.timestamp, entryPrice: e.price, regime: e.regime };
        } else if (['T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED'].includes(e.event_type) && lastOpen) {
          positions.push({
            entryTime: lastOpen.entryTime, exitTime: e.timestamp, entryPrice: lastOpen.entryPrice, exitPrice: e.price,
            durationMin: Math.round((e.timestamp - lastOpen.entryTime) / 60000),
            feesUsdc: (e.fee_sol || 0) * e.price + (e.fee_usdc || 0), feesSol: e.fee_sol || 0,
            exitReason: e.event_type, regime: lastOpen.regime, il: e.il_at_close || 0,
          });
          lastOpen = null;
        }
      }
      // Regime history from regime_snapshots (sampled)
      const regimeHistory = dbRef.prepare('SELECT ts, regime, price FROM regime_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts ASC').all(from || 0, to) as any[];
      // Gate fires from regime_snapshots
      const gateRaw = dbRef.prepare("SELECT date(ts/1000,'unixepoch') as date, reserve_gate, basis_gate, churn_guard FROM regime_snapshots WHERE ts >= ? AND ts <= ?").all(from || 0, to) as any[];
      const gateByDay: Record<string, any> = {};
      for (const g of gateRaw) {
        if (!gateByDay[g.date]) gateByDay[g.date] = { date: g.date, reserveBlock: 0, basisBlock: 0, churnBlock: 0, total: 0 };
        gateByDay[g.date].total++;
        if (g.reserve_gate === 'BLOCK') gateByDay[g.date].reserveBlock++;
        if (g.basis_gate === 'BLOCK') gateByDay[g.date].basisBlock++;
        if (g.churn_guard === 'BLOCK') gateByDay[g.date].churnBlock++;
      }
      // Price + cost basis history
      const priceHistory = dbRef.prepare('SELECT ts, price FROM regime_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts ASC').all(from || 0, to) as any[];
      const costBasis = (dbRef.prepare('SELECT sol_cost_basis FROM bot_state WHERE id=1').get() as any)?.sol_cost_basis || 0;
      // Gas from swap_ledger
      const gasRaw = dbRef.prepare("SELECT date(timestamp/1000,'unixepoch') as date, SUM(fee_lamports) as gas_lamports, COUNT(*) as swaps FROM swap_ledger WHERE timestamp >= ? AND timestamp <= ? GROUP BY date").all(from || 0, to) as any[];
      const gasMap: Record<string, number> = {};
      for (const g of gasRaw) { const price = priceHistory.length > 0 ? priceHistory[priceHistory.length-1].price : 84; gasMap[g.date] = (g.gas_lamports || 0) / 1e9 * price; }
      // Enrich daily fees with gas
      const dailyFeesEnriched = dailyFees.map((d: any) => ({ ...d, gas: gasMap[d.date] || 0, net: d.fees - (gasMap[d.date] || 0) }));
      // Summary — use daily_summary as authoritative fee source (same as arcade)
      const feesFromSummary = (dbRef.prepare('SELECT COALESCE(SUM(fees_earned_usdc), 0) as total FROM daily_summary').get() as any)?.total ?? 0;
      const latestPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : 84;
      const pendingFees = currentLive ? currentLive.pendingFeesTotal : 0;
      const totalFees = feesFromSummary + pendingFees;
      const totalGas = Object.values(gasMap).reduce((s: number, g: any) => s + g, 0);
      const avgDuration = positions.length > 0 ? Math.round(positions.reduce((s: number, p: any) => s + p.durationMin, 0) / positions.length) : 0;
      // SOL Conversion stats
      const scEnabled = runtime.solConversionEnabled;
      const scLastTs = (() => { try { return (dbRef.prepare('SELECT sol_conversion_last_ts FROM bot_state WHERE id = 1').get() as any)?.sol_conversion_last_ts ?? 0; } catch { return 0; } })();
      const scBasis = costBasis;
      const scThreshold = scBasis * runtime.solConversionBasisMultiplier;
      const scPrice = currentLive?.solPrice ?? 0;
      const scRegime = currentLive?.regime ?? 'RANGING';
      const regimeCooldowns: Record<string, number> = { RANGING: 3, BULLISH_TREND: 5, BEARISH_TREND: 10, EXTREME: 20 };
      const scCooldownMin = regimeCooldowns[scRegime] ?? 10;
      const scCooldownMs = scCooldownMin * (runtime.solConversionCooldownMin / 15) * 60_000;
      const scCooldownRemaining = Math.max(0, scCooldownMs - (Date.now() - scLastTs));
      const scRegimeAllows = scRegime === 'RANGING' || scRegime === 'BULLISH_TREND';
      // Check momentum override for BEARISH/EXTREME
      const scPrice30mRow = (() => { try { return dbRef.prepare('SELECT price FROM regime_snapshots WHERE ts <= ? ORDER BY ts DESC LIMIT 1').get(Date.now() - 30 * 60 * 1000) as {price: number} | undefined; } catch { return undefined; } })();
      const scPrice30mAgo = scPrice30mRow?.price ?? null;
      const scPriceChange30m = scPrice30mAgo ? (scPrice - scPrice30mAgo) / scPrice30mAgo : 0;
      const scMarginAboveBasis = scBasis > 0 ? (scPrice - scBasis) / scBasis : 0;
      const scMomentumOverride = (scRegime === 'BEARISH_TREND' || scRegime === 'EXTREME') && scPriceChange30m >= (runtime.solConvertMomentumThreshold ?? 0.02) && scMarginAboveBasis >= 0.005;
      const scBlocked = !scRegimeAllows && !scMomentumOverride;
      const scStatus = !scEnabled ? 'DISABLED' : (scRegimeAllows && scPrice < scThreshold) || scBlocked ? 'BLOCKED' : scCooldownRemaining > 0 ? 'COOLDOWN' : scMomentumOverride ? 'MOMENTUM' : 'FIRING';
      const walletSolVal = (currentLive?.solBalance ?? 0) * scPrice;
      const targetCycles: Record<string, number> = { RANGING: 6, BULLISH_TREND: 9, BEARISH_TREND: 18, EXTREME: 48 };
      const scDynCap = Math.min(Math.max(walletSolVal / (targetCycles[scRegime] ?? 18), 200), 5000);
      const scToday = (() => { try { return dbRef.prepare("SELECT COUNT(*) as c, COALESCE(SUM(sol_amount),0) as sol, COALESCE(SUM(usdc_amount),0) as usdc FROM swap_ledger WHERE direction='sell_sol' AND reason LIKE '%onvert%' AND timestamp > ?").get(Date.now() - 86400_000) as any; } catch { return { c: 0, sol: 0, usdc: 0 }; } })();
      const scWeek = (() => { try { return dbRef.prepare("SELECT COUNT(*) as c, COALESCE(SUM(sol_amount),0) as sol, COALESCE(SUM(usdc_amount),0) as usdc FROM swap_ledger WHERE direction='sell_sol' AND reason LIKE '%onvert%' AND timestamp > ?").get(Date.now() - 7 * 86400_000) as any; } catch { return { c: 0, sol: 0, usdc: 0 }; } })();
      const scLast = (() => { try { return dbRef.prepare("SELECT timestamp, sol_amount, usdc_amount, price, tx_signature FROM swap_ledger WHERE direction='sell_sol' AND reason LIKE '%onvert%' ORDER BY timestamp DESC LIMIT 1").get() as any; } catch { return null; } })();
      const scRecent = (() => { try { return dbRef.prepare("SELECT timestamp, sol_amount, usdc_amount, price, tx_signature FROM swap_ledger WHERE direction='sell_sol' AND reason LIKE '%onvert%' ORDER BY timestamp DESC LIMIT 10").all() as any[]; } catch { return []; } })();

      res.json({
        dailyFees: dailyFeesEnriched, positions, regimeHistory: regimeHistory.filter((_: any, i: number) => i % 5 === 0),
        priceHistory: priceHistory.filter((_: any, i: number) => i % 5 === 0).map((p: any) => ({ ...p, costBasis })),
        gateFires: Object.values(gateByDay),
        summary: { totalFees: Math.round(totalFees * 100) / 100, totalGas: Math.round(totalGas * 100) / 100, totalPositions: positions.length, avgDuration, avgApr7d: 0, avgApr30d: 0 },
        solConversion: {
          enabled: scEnabled, status: scStatus, lastConversionTs: scLastTs,
          cooldownRemainingMs: Math.round(scCooldownRemaining), cooldownTotalMin: scCooldownMin,
          threshold: parseFloat(scThreshold.toFixed(2)), priceAboveThreshold: scPrice >= scThreshold,
          dynamicCap: Math.round(scDynCap), idleSolValue: Math.round(walletSolVal),
          todayCount: scToday.c, todaySol: parseFloat((scToday.sol).toFixed(3)), todayUsdc: parseFloat((scToday.usdc).toFixed(2)),
          weekCount: scWeek.c, weekSol: parseFloat((scWeek.sol).toFixed(3)), weekUsdc: parseFloat((scWeek.usdc).toFixed(2)),
          last: scLast ? { ts: scLast.timestamp, sol: scLast.sol_amount, usdc: scLast.usdc_amount, price: scLast.price, tx: scLast.tx_signature } : null,
          recent: scRecent.map((r: any) => ({ ts: r.timestamp, sol: r.sol_amount, usdc: r.usdc_amount, price: r.price, tx: r.tx_signature })),
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Daily Fees Intelligence endpoint
  app.get('/api/daily-fees-intelligence', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    try {
      const now = Date.now();
      const todayStr = new Date(now).toLocaleDateString('en-CA', { timeZone: 'UTC' });
      const startOfTodayMs = new Date(todayStr + 'T00:00:00Z').getTime();
      const todayElapsedMs = now - startOfTodayMs;
      const hoursElapsed = todayElapsedMs / 3600000;
      const hoursRemaining = 24 - hoursElapsed;
      const price = currentLive?.solPrice ?? 0;

      // Today's closed-position fees from rebalance_events
      const todayRow = dbRef.prepare(`
        SELECT COALESCE(SUM(fee_usdc + fee_sol * ?), 0) as fees,
               COUNT(*) as positions
        FROM rebalance_events
        WHERE timestamp >= ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
      `).get(price, startOfTodayMs) as any;
      const feesToday = todayRow?.fees ?? 0;
      const positionsToday = todayRow?.positions ?? 0;

      // Pending fees from current open position
      const feesPending = currentLive?.pendingFeesTotal ?? 0;
      const feesTodayTotal = feesToday + feesPending;

      // Yesterday's full-day fees
      const yesterdayStart = startOfTodayMs - 86400000;
      const yesterdayRow = dbRef.prepare(`
        SELECT COALESCE(SUM(fee_usdc + fee_sol * ?), 0) as fees
        FROM rebalance_events
        WHERE timestamp >= ? AND timestamp < ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
      `).get(price, yesterdayStart, startOfTodayMs) as any;
      const feesYesterday = yesterdayRow?.fees ?? 0;

      // Yesterday fees at same elapsed time
      const yesterdaySameRow = dbRef.prepare(`
        SELECT COALESCE(SUM(fee_usdc + fee_sol * ?), 0) as fees
        FROM rebalance_events
        WHERE timestamp >= ? AND timestamp <= ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
      `).get(price, yesterdayStart, yesterdayStart + todayElapsedMs) as any;
      const feesYesterdaySameTime = yesterdaySameRow?.fees ?? 0;

      // 7-day average at same elapsed time
      let sum7d = 0;
      let days7dWithData = 0;
      for (let n = 1; n <= 7; n++) {
        const dayStartMs = startOfTodayMs - n * 86400000;
        const dayEndAtSameTime = dayStartMs + todayElapsedMs;
        const dayRow = dbRef.prepare(`
          SELECT COALESCE(SUM(fee_usdc + fee_sol * ?), 0) as fees,
                 COUNT(*) as cnt
          FROM rebalance_events
          WHERE timestamp >= ? AND timestamp <= ?
          AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
          AND (fee_usdc > 0 OR fee_sol > 0)
        `).get(price, dayStartMs, dayEndAtSameTime) as any;
        if ((dayRow?.cnt ?? 0) > 0) {
          sum7d += dayRow.fees;
          days7dWithData++;
        }
      }
      const fees7dAvgSameTime = days7dWithData > 0 ? sum7d / days7dWithData : 0;

      // Expected fees for full day (run rate projection)
      const currentRunRate = hoursElapsed > 0 ? feesTodayTotal / hoursElapsed : 0;
      const feesExpectedToday = hoursElapsed > 0 ? feesTodayTotal + (currentRunRate * hoursRemaining) : 0;
      const confidence = hoursElapsed < 2 ? 'LOW' : hoursElapsed <= 6 ? 'MEDIUM' : 'HIGH';

      // % comparisons
      const vsYesterdaySameTime = feesYesterdaySameTime > 0 ? ((feesTodayTotal - feesYesterdaySameTime) / feesYesterdaySameTime) * 100 : 0;
      const vs7dAvg = fees7dAvgSameTime > 0 ? ((feesTodayTotal - fees7dAvgSameTime) / fees7dAvgSameTime) * 100 : 0;

      // Avg fees per position
      const avgFeesPerPosition = positionsToday > 0 ? feesToday / positionsToday : 0;

      // Best position today
      const bestRow = dbRef.prepare(`
        SELECT MAX(fee_usdc + fee_sol * ?) as best
        FROM rebalance_events
        WHERE timestamp >= ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
      `).get(price, startOfTodayMs) as any;
      const bestPosition = bestRow?.best ?? 0;

      // Hourly breakdown for chart
      const hourlyRows = dbRef.prepare(`
        SELECT CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) as hour,
               SUM(fee_usdc + fee_sol * ?) as fees
        FROM rebalance_events
        WHERE timestamp >= ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
        GROUP BY hour
        ORDER BY hour
      `).all(price, startOfTodayMs) as any[];
      const hourlyToday: number[] = new Array(24).fill(0);
      for (const r of hourlyRows) { hourlyToday[r.hour] = r.fees; }

      // 7-day average hourly breakdown
      const hourly7dRows = dbRef.prepare(`
        SELECT CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) as hour,
               SUM(fee_usdc + fee_sol * ?) as fees
        FROM rebalance_events
        WHERE timestamp >= ? AND timestamp < ?
        AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED','FEE_HARVEST')
        AND (fee_usdc > 0 OR fee_sol > 0)
        GROUP BY hour
        ORDER BY hour
      `).all(price, startOfTodayMs - 7 * 86400000, startOfTodayMs) as any[];
      const hourly7dAvg: number[] = new Array(24).fill(0);
      const daysForAvg = Math.max(days7dWithData, 1);
      for (const r of hourly7dRows) { hourly7dAvg[r.hour] = r.fees / daysForAvg; }

      // Current hour (UTC)
      const currentHour = new Date(now).getUTCHours();

      res.json({
        feesToday,
        feesPending,
        feesTodayTotal,
        feesYesterday,
        feesYesterdaySameTime,
        fees7dAvgSameTime,
        feesExpectedToday,
        currentRunRate,
        hoursElapsed: parseFloat(hoursElapsed.toFixed(1)),
        hoursRemaining: parseFloat(hoursRemaining.toFixed(1)),
        confidence,
        vsYesterdaySameTime: parseFloat(vsYesterdaySameTime.toFixed(1)),
        vs7dAvg: parseFloat(vs7dAvg.toFixed(1)),
        positionsToday,
        avgFeesPerPosition: parseFloat(avgFeesPerPosition.toFixed(4)),
        bestPosition: parseFloat(bestPosition.toFixed(4)),
        hourlyToday,
        hourly7dAvg,
        currentHour,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/arcade', (_req, res) => {
    res.type('html').send(renderArcadeHtml());
  });
  app.get('/api/arcade-stats', (_req, res) => {
    if (!dbRef) { res.json({}); return; }
    try {
      const live = currentLive;
      const price = live?.solPrice ?? 0;
      const portfolioNow = live?.totalValueWithPosition ?? 0;
      const snap4h = dbRef.prepare('SELECT total_value FROM portfolio_snapshots WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(Date.now() - 4 * 3600_000) as { total_value: number } | undefined;
      const portfolio4hAgo = snap4h?.total_value ?? portfolioNow;
      const change = portfolioNow - portfolio4hAgo;
      const changePct = portfolio4hAgo > 0 ? (change / portfolio4hAgo) * 100 : 0;
      const feesAllRow = dbRef.prepare('SELECT COALESCE(SUM(fees_earned_usdc), 0) as total FROM daily_summary').get() as { total: number };
      const feesAllTime = feesAllRow?.total ?? 0;
      const positionActive = live?.botState === 'ACTIVE';
      const pendingFees = live ? live.pendingFeesTotal : 0;
      const fees4hClose = dbRef.prepare('SELECT COALESCE(SUM(fee_usdc),0) + COALESCE(SUM(fee_sol),0) * ? as total FROM rebalance_events WHERE timestamp > ? AND (fee_usdc > 0 OR fee_sol > 0)').get(price, Date.now() - 4 * 3600_000) as { total: number };
      const fees4h = (fees4hClose?.total ?? 0) + (positionActive ? pendingFees : 0);
      const feesPrev4hRow = dbRef.prepare('SELECT COALESCE(SUM(fee_usdc),0) + COALESCE(SUM(fee_sol),0) * ? as total FROM rebalance_events WHERE timestamp BETWEEN ? AND ? AND (fee_usdc > 0 OR fee_sol > 0)').get(price, Date.now() - 8 * 3600_000, Date.now() - 4 * 3600_000) as { total: number };
      const feesPrev4h = feesPrev4hRow?.total ?? 0;
      const feesVariance = feesPrev4h > 0 ? ((fees4h - feesPrev4h) / feesPrev4h) * 100 : null;
      const posCount = dbRef.prepare("SELECT COUNT(*) as c FROM rebalance_events WHERE event_type IN ('POSITION_OPENED','PULLBACK_REENTRY')").get() as { c: number };
      const uptimeDays = parseFloat(((Date.now() - startTime) / 86400_000).toFixed(1));
      const investorRows = dbRef.prepare(`
        SELECT name, SUM(amount_usdc) as total_invested, COUNT(*) as investments, MIN(invest_date) as first_investment
        FROM investors GROUP BY LOWER(name) ORDER BY total_invested DESC
      `).all() as { name: string; total_invested: number; investments: number; first_investment: string }[];
      const players = investorRows.map(r => ({
        name: r.name, totalInvested: r.total_invested,
        investments: r.investments, firstInvestment: r.first_investment,
      }));
      const totalInvested = players.reduce((s, p) => s + p.totalInvested, 0);
      res.json({
        portfolioNow, portfolio4hAgo, portfolioChange: change, portfolioChangePct: changePct,
        feesAllTime, fees4h, feesPrev4h, feesVariance,
        positionsAllTime: posCount?.c ?? 0,
        status: live?.botState === 'ACTIVE' ? 'ACTIVE' : 'IDLE',
        regime: live?.regime ?? 'RANGING',
        uptimeDays,
        lastUpdated: Date.now(),
        players,
        totalInvested,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // --- Basic auth middleware ---
  const dashUser = process.env.DASHBOARD_USER;
  const dashPass = process.env.DASHBOARD_PASS;

  if (dashUser && dashPass) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="SOL LP Bot Dashboard"');
        res.status(401).send('Authentication required');
        return;
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const userBuf = Buffer.from(user ?? '');
      const passBuf = Buffer.from(pass ?? '');
      const expectUser = Buffer.from(dashUser);
      const expectPass = Buffer.from(dashPass);
      const userMatch = userBuf.length === expectUser.length && crypto.timingSafeEqual(userBuf, expectUser);
      const passMatch = passBuf.length === expectPass.length && crypto.timingSafeEqual(passBuf, expectPass);
      if (!userMatch || !passMatch) {
        res.setHeader('WWW-Authenticate', 'Basic realm="SOL LP Bot Dashboard"');
        res.status(401).send('Invalid credentials');
        return;
      }
      next();
    });
    console.log(JSON.stringify({ level: 'info', msg: 'dashboard auth enabled', timestamp: Date.now() }));
  }

  // Prevent browser caching of HTML pages (ensures fresh content after deploys)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  let currentEvents: RebalanceEvent[] = [];
  let currentBotState: BotState = 'IDLE';
  let currentDailyPnl: DailyPnlRow[] = [];
  let currentLive: LiveData | null = null;
  let poolStats: PoolStats | null = null;
  let poolStatsFetchTime = 0;
  const POOL_STATS_TTL = 5 * 60_000; // refresh every 5 minutes
  const startTime = Date.now();

  async function fetchPoolStats(): Promise<void> {
    const now = Date.now();
    if (poolStats && now - poolStatsFetchTime < POOL_STATS_TTL) return;
    const whirlpoolAddr = process.env.WHIRLPOOL_ADDRESS;
    if (!whirlpoolAddr) return;
    try {
      const res = await fetch(`https://api.orca.so/v2/solana/pools/${whirlpoolAddr}`);
      if (!res.ok) return;
      const json = await res.json() as any;
      const d = json.data;
      if (!d) return;
      const s24 = d.stats?.['24h'] ?? {};
      const s7d = d.stats?.['7d'] ?? {};
      const s30d = d.stats?.['30d'] ?? {};
      poolStats = {
        tvlUsdc: parseFloat(d.tvlUsdc) || 0,
        price: parseFloat(d.price) || 0,
        feeRate: d.feeRate ?? 0,
        volume24h: parseFloat(s24.volume) || 0,
        volume7d: parseFloat(s7d.volume) || 0,
        volume30d: parseFloat(s30d.volume) || 0,
        fees24h: parseFloat(s24.fees) || 0,
        fees7d: parseFloat(s7d.fees) || 0,
        fees30d: parseFloat(s30d.fees) || 0,
        yield24h: parseFloat(s24.yieldOverTvl) || 0,
        yield7d: parseFloat(s7d.yieldOverTvl) || 0,
        yield30d: parseFloat(s30d.yieldOverTvl) || 0,
        priceDelta24h: parseFloat(s24.priceDelta) || 0,
        volumeDelta24h: parseFloat(s24.volumeDelta) || 0,
        tokenBalanceA: (parseFloat(d.tokenBalanceA) || 0) / 1e9,
        tokenBalanceB: (parseFloat(d.tokenBalanceB) || 0) / 1e6,
        tickSpacing: d.tickSpacing ?? 0,
        lastFetched: now,
      };
      poolStatsFetchTime = now;
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: 'pool stats fetch failed', error: String(err), timestamp: now }));
    }
  }

  app.get('/api/data', (_req, res) => {
    res.json({
      recentEvents: currentEvents.slice(0, 10),
      dailyPnl: currentDailyPnl,
      botState: currentBotState,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  app.get('/api/live', (_req, res) => {
    res.json(currentLive);
  });

  app.get('/api/market-signals', (_req, res) => {
    res.json(currentLive?.marketSignals ?? null);
  });

  // Data export and analysis endpoints
  let dbRef: ReturnType<typeof import('../db/sqlite.js')['initDb']> | null = null;

  app.get('/api/export', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(exportAllData(dbRef));
  });

  app.get('/api/decisions', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getDecisionLogs(dbRef, parseInt((_req.query as any).limit ?? '100')));
  });

  app.get('/api/snapshots', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    const hours = parseInt((_req.query as any).hours ?? '24');
    res.json(getLiveSnapshots(dbRef, hours));
  });

  // Hourly fees for a given date + events list
  // Hourly fees for a given date (all dates in CET)
  app.get('/api/hourly-fees', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    const date = (_req.query as any).date; // YYYY-MM-DD format
    if (!date) { res.status(400).json({ error: 'date param required (YYYY-MM-DD)' }); return; }

    // Get snapshots for this date and the previous day (for prevDayLastFees)
    // Fetch 2 days of data instead of entire table
    const dateMid = new Date(date + 'T12:00:00Z');
    const fetchFrom = dateMid.getTime() - 36 * 3600000; // 36h before noon = covers prev day
    const fetchTo = dateMid.getTime() + 36 * 3600000;   // 36h after noon = covers next day
    const allSnaps = dbRef.prepare('SELECT timestamp, price, pending_fees_sol, pending_fees_usdc, cum_fees_sol, cum_fees_usdc, in_range, position_mint FROM live_snapshots WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(fetchFrom, fetchTo) as any[];
    const daySnaps = allSnaps.filter((s: any) => new Date(s.timestamp).toLocaleDateString('en-CA', { timeZone: TZ }) === date);

    // Get daily summaries (needed for hourly fee scaling)
    const dailySummaries = dbRef.prepare('SELECT date, fees_earned_usdc FROM daily_summary ORDER BY date ASC').all() as any[];
    const dates = dailySummaries.map((r: any) => r.date);

    const hours: Record<number, { fees: number; inRange: number; total: number }> = {};
    for (let h = 0; h < 24; h++) hours[h] = { fees: 0, inRange: 0, total: 0 };

    // Track fee growth using total fees (cum + pending) but scale hourly proportionally
    // to match the authoritative daily_summary total. This avoids phantom spikes from
    // position close/reopen where the same fees get double-counted.
    // Step 1: compute raw hourly deltas
    const totalFn = (s: any) => {
      const pSol = (s.pending_fees_sol || 0);
      const pUsdc = (s.pending_fees_usdc || 0);
      const skip = pSol * s.price > 1000; // skip bogus pending values
      return (s.cum_fees_sol || 0) * s.price + (s.cum_fees_usdc || 0) + (skip ? 0 : pSol * s.price + pUsdc);
    };
    for (let i = 0; i < daySnaps.length; i++) {
      const s = daySnaps[i] as any;
      const d = new Date(s.timestamp);
      const hStr = d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });
      const h = parseInt(hStr) % 24;
      if (s.in_range) hours[h].inRange++;
      hours[h].total++;
      if (i > 0) {
        const prev = daySnaps[i - 1];
        const delta = totalFn(s) - totalFn(prev);
        if (delta > 0 && delta < 20) hours[h].fees += delta;
      }
    }
    // Step 2: scale hourly values proportionally to match daily_summary total
    const rawSum = Object.values(hours).reduce((s: number, h: any) => s + h.fees, 0);
    const summaryForScale = dailySummaries.find((r: any) => r.date === date);
    const authTotal = summaryForScale ? summaryForScale.fees_earned_usdc : rawSum;
    const scale = rawSum > 0 ? authTotal / rawSum : 1;
    if (Math.abs(scale - 1) > 0.05) { // only scale if >5% deviation
      for (let h = 0; h < 24; h++) hours[h].fees *= scale;
    }

    const hourlyData: Array<{ hour: number; fees: number; cumulative: number; inRangePct: number }> = [];
    let dayCum = 0;
    for (let h = 0; h < 24; h++) {
      const entry = hours[h];
      dayCum += entry.fees;
      const irPct = entry.total > 0 ? (entry.inRange / entry.total * 100) : 0;
      hourlyData.push({ hour: h, fees: entry.fees, cumulative: dayCum, inRangePct: irPct });
    }

    // Get events for this day
    const dayMid = new Date(date + 'T12:00:00Z');
    const dayBounds = allSnaps.filter((s: any) => new Date(s.timestamp).toLocaleDateString('en-CA', { timeZone: TZ }) === date);
    const dayStart = dayBounds.length > 0 ? dayBounds[0].timestamp - 60000 : dayMid.getTime() - 12 * 3600000;
    const dayEnd = dayBounds.length > 0 ? dayBounds[dayBounds.length - 1].timestamp + 60000 : dayMid.getTime() + 12 * 3600000;
    const events = dbRef.prepare(`SELECT timestamp, event_type, price, fee_sol, fee_usdc, il_at_close, note
      FROM rebalance_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC`).all(dayStart, dayEnd) as any[];

    const summaryRow = dailySummaries.find((r: any) => r.date === date);
    const dayTotal = summaryRow ? summaryRow.fees_earned_usdc : dayCum;

    res.json({ date, hourlyData, dayTotal, events, availableDates: dates });
  });

  app.get('/api/swap-ledger', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    try {
      const swaps = dbRef.prepare('SELECT * FROM swap_ledger ORDER BY timestamp DESC LIMIT 50').all() as any[];
      let totalPnl = 0, profitable = 0, unprofitable = 0, totalGas = 0, totalProtocolFee = 0, buys = 0, sells = 0;
      for (const s of swaps) {
        const gas = 0.00001 * s.price;
        const protocolFee = s.usdc_amount * 0.0006;
        totalGas += gas;
        totalProtocolFee += protocolFee;
        if (s.direction === 'buy_sol') buys++; else sells++;
        if (s.pnl_usdc != null) {
          totalPnl += s.pnl_usdc;
          if (s.pnl_usdc >= 0) profitable++; else unprofitable++;
        }
      }
      res.json({ swaps, summary: { totalPnl, swapCount: swaps.length, buys, sells, profitable, unprofitable, totalGas, totalProtocolFee } });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/regime-history', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getRegimeHistory(dbRef, 50));
  });

  app.get('/api/events', (_req, res) => {
    res.json(currentEvents.slice(0, 50));
  });

  app.get('/api/rule2-perf', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getRule2PerfComparison(dbRef));
  });

  app.get('/api/rule2-events.csv', (_req, res) => {
    if (!dbRef) { res.status(500).send('DB not available'); return; }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rebalance_events_rule2.csv"');
    res.send(getRule2EventsCsv(dbRef));
  });

  // Insights page
  app.get('/insights', async (_req, res) => {
    if (!dbRef) { res.type('html').send('<h1>DB not ready</h1>'); return; }
    const snapshots = getLiveSnapshots(dbRef, 24);
    const snapshots7d = getLiveSnapshots(dbRef, 168); // 7 days
    const inRangePct1h = getLiveInRangePct(dbRef, 1);
    const inRangePct24h = getLiveInRangePct(dbRef, 24);
    const inRangePctAll = getLiveInRangePct(dbRef, 9999);
    const allDecisions = getDecisionLogs(dbRef, 100);
    const regimeEvals = allDecisions.filter(d => d.decision === 'REGIME_EVAL' || d.decision === 'REGIME_CHANGE').slice(0, 10);
    const decisions = allDecisions.filter(d => d.decision !== 'REGIME_EVAL').slice(0, 10);
    const regimeHist = getRegimeHistory(dbRef, 20);
    const events = dbGetRebalanceEvents(dbRef, 100);
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const rpcUrl = process.env.RPC_URL ?? '';
    const walletAddr = currentLive?.walletAddress ?? '';
    const solPrice = currentLive?.solPrice ?? 82;
    const recentTxs = (rpcUrl && walletAddr) ? await fetchRecentTransactions(rpcUrl, walletAddr, 10, solPrice) : [];
    const dailySummaries = getAllDailySummaries(dbRef);
    res.type('html').send(renderInsightsHtml({ snapshots, snapshots7d, inRangePct1h, inRangePct24h, inRangePctAll, decisions, regimeEvals, regimeHist, events, recentTxs, uptime, dailySummaries }));
  });

  // Strategy page
  app.get('/strategy', (_req, res) => {
    res.type('html').send(renderStrategyHtml());
  });

  // Arcade page — moved before auth middleware (no-auth)

  // Investors page
  app.get('/investors', async (_req, res) => {
    const { renderInvestorsPageHtml } = await import('./investors-page.js');
    res.type('html').send(renderInvestorsPageHtml());
  });

  app.get('/api/investors', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    const investors = dbRef.prepare('SELECT * FROM investors ORDER BY invest_date ASC').all();
    const totalInvested = investors.reduce((s: number, i: any) => s + i.amount_usdc, 0);
    const latestSnap = dbRef.prepare('SELECT * FROM live_snapshots ORDER BY timestamp DESC LIMIT 1').get() as any;
    const totalPortfolio = latestSnap?.total_with_position ?? 0;
    const summaries = dbRef.prepare('SELECT * FROM daily_summary ORDER BY date DESC LIMIT 1').get() as any;
    const totalFees = summaries?.cum_fees_usdc ?? 0;
    res.json({ investors, totalInvested, totalPortfolio, totalFees });
  });

  app.post('/api/investors', express.json(), (req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    const { name, amount, date } = req.body;
    if (!name || !amount || !date) { res.status(400).json({ error: 'name, amount, date required' }); return; }
    dbRef.prepare('INSERT INTO investors (name, amount_usdc, invest_date, created_at) VALUES (?, ?, ?, ?)').run(name, parseFloat(amount), date, Date.now());
    res.json({ success: true });
  });

  app.delete('/api/investors/:id', (req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    dbRef.prepare('DELETE FROM investors WHERE id = ?').run(parseInt(req.params.id));
    res.json({ success: true });
  });

  // Analytics page
  app.get('/analytics', async (_req, res) => {
    const { renderAnalyticsPageHtml } = await import('./analytics-page.js');
    res.type('html').send(renderAnalyticsPageHtml());
  });

  // Analytics data API — returns all data needed for widgets
  app.get('/api/analytics-data', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    try {
      const days = parseInt((_req.query as any).days ?? '7');
      const since = Date.now() - days * 86400000;

      // Downsample to max 500 snapshots to keep response under 500KB for mobile
      const allSnaps = dbRef.prepare('SELECT timestamp, price, pending_fees_sol, pending_fees_usdc, cum_fees_sol, cum_fees_usdc, in_range, regime, position_value, sol_balance, usdc_balance, position_sol, position_usdc, total_with_position FROM live_snapshots WHERE timestamp > ? ORDER BY timestamp ASC').all(since) as any[];
      const step = Math.max(1, Math.floor(allSnaps.length / 500));
      const snaps = step === 1 ? allSnaps : allSnaps.filter((_: any, i: number) => i % step === 0 || i === allSnaps.length - 1);

      const events = dbRef.prepare('SELECT timestamp, event_type, price, fee_sol, fee_usdc, il_at_close, sol_before, usdc_before, sol_after, usdc_after, note, regime FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp ASC').all(since) as any[];

      const regimeHist = dbRef.prepare('SELECT timestamp, old_regime, new_regime, price FROM regime_history WHERE timestamp > ? ORDER BY timestamp ASC').all(since) as any[];

      const dailySummaries = dbRef.prepare('SELECT * FROM daily_summary ORDER BY date ASC').all() as any[];

      const state = dbRef.prepare('SELECT * FROM bot_state WHERE id=1').get() as any;

      res.json({ snaps, events, regimeHist, dailySummaries, state, days });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Projection page
  app.get('/projection', async (_req, res) => {
    const { renderProjectionPageHtml } = await import('./projection-page.js');
    res.type('html').send(renderProjectionPageHtml());
  });

  // Projection data API
  app.get('/api/projection-data', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    try {
      const snaps = dbRef.prepare('SELECT timestamp, price, pending_fees_sol, pending_fees_usdc, cum_fees_sol, cum_fees_usdc, in_range, regime, position_value, sol_balance, usdc_balance, position_sol, position_usdc, total_with_position FROM live_snapshots ORDER BY timestamp ASC').all() as any[];
      const events = dbRef.prepare('SELECT timestamp, event_type, price, fee_sol, fee_usdc, il_at_close, sol_before, usdc_before, sol_after, usdc_after, regime FROM rebalance_events ORDER BY timestamp ASC').all() as any[];
      const summaries = dbRef.prepare('SELECT * FROM daily_summary ORDER BY date ASC').all() as any[];
      const state = dbRef.prepare('SELECT * FROM bot_state WHERE id=1').get() as any;

      if (snaps.length < 10) { res.json({ error: 'Not enough data yet', snaps: snaps.length }); return; }

      // TZ already set by middleware from browser cookie
      const totalHours = (snaps[snaps.length-1].timestamp - snaps[0].timestamp) / 3600000;

      // Fee rate by regime
      const regimeFees: Record<string, { fees: number; hours: number; inRange: number; total: number }> = {};
      for (let i = 1; i < snaps.length; i++) {
        const prev = snaps[i-1], curr = snaps[i];
        const r = curr.regime || 'RANGING';
        if (!regimeFees[r]) regimeFees[r] = { fees: 0, hours: 0, inRange: 0, total: 0 };
        const elapsed = (curr.timestamp - prev.timestamp) / 3600000;
        const pPrev = (prev.pending_fees_sol||0)*prev.price + (prev.pending_fees_usdc||0);
        const pCurr = (curr.pending_fees_sol||0)*curr.price + (curr.pending_fees_usdc||0);
        const prevT = (prev.cum_fees_sol||0)*prev.price + (prev.cum_fees_usdc||0) + (pPrev > 1000 ? 0 : pPrev);
        const currT = (curr.cum_fees_sol||0)*curr.price + (curr.cum_fees_usdc||0) + (pCurr > 1000 ? 0 : pCurr);
        const delta = currT - prevT;
        if (delta > 0 && delta < 50) regimeFees[r].fees += delta;
        regimeFees[r].hours += elapsed;
        regimeFees[r].total++;
        if (curr.in_range) regimeFees[r].inRange++;
      }

      // Fee rate by day-of-week
      const dowFees: Record<string, { fees: number; hours: number }> = {};
      for (let i = 1; i < snaps.length; i++) {
        const curr = snaps[i], prev = snaps[i-1];
        const day = new Date(curr.timestamp).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
        if (!dowFees[day]) dowFees[day] = { fees: 0, hours: 0 };
        const elapsed = (curr.timestamp - prev.timestamp) / 3600000;
        const pPrev = (prev.pending_fees_sol||0)*prev.price + (prev.pending_fees_usdc||0);
        const pCurr = (curr.pending_fees_sol||0)*curr.price + (curr.pending_fees_usdc||0);
        const prevT = (prev.cum_fees_sol||0)*prev.price + (prev.cum_fees_usdc||0) + (pPrev > 1000 ? 0 : pPrev);
        const currT = (curr.cum_fees_sol||0)*curr.price + (curr.cum_fees_usdc||0) + (pCurr > 1000 ? 0 : pCurr);
        const delta = currT - prevT;
        if (delta > 0 && delta < 50) dowFees[day].fees += delta;
        dowFees[day].hours += elapsed;
      }

      // Positions
      const positions: any[] = [];
      let lastOpen: any = null;
      events.forEach((e: any) => {
        if (e.event_type === 'POSITION_OPENED') {
          const capB = (e.sol_before||0)*e.price + (e.usdc_before||0);
          const capA = (e.sol_after||0)*e.price + (e.usdc_after||0);
          lastOpen = { ts: e.timestamp, capital: Math.max(0, capB - capA) };
        } else if (['T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED'].includes(e.event_type) && lastOpen) {
          positions.push({
            duration: (e.timestamp - lastOpen.ts) / 60000,
            capital: lastOpen.capital,
            fees: (e.fee_sol||0)*e.price + (e.fee_usdc||0),
            il: e.il_at_close || 0,
          });
          lastOpen = null;
        }
      });

      // Costs
      const totalGasUsdc = (state.cum_gas_lamports||0) / 1e9 * snaps[snaps.length-1].price;
      const totalRebalances = positions.length;
      const costPerRebalance = totalRebalances > 0 ? totalGasUsdc / totalRebalances : 0.01;
      const rebalancesPerDay = totalHours > 0 ? totalRebalances / (totalHours / 24) : 10;
      const totalIL = positions.reduce((s: number, p: any) => s + Math.abs(p.il), 0);
      const ilPerRebalance = totalRebalances > 0 ? totalIL / totalRebalances : 0.01;
      const swapCount = events.filter((e: any) => (e.note||'').includes('SWAP')).length;

      // In-range
      const inRangePct = snaps.filter((s: any) => s.in_range).length / snaps.length * 100;

      // Regime distribution
      const regimeDist: Record<string, number> = {};
      Object.entries(regimeFees).forEach(([r, d]) => { regimeDist[r] = d.hours / totalHours; });

      // Current capital
      const latestSnap = snaps[snaps.length-1];
      const currentCapital = latestSnap.total_with_position || (latestSnap.sol_balance * latestSnap.price + latestSnap.usdc_balance);

      // Weekday vs weekend rate
      const weekdayDays = ['Mon','Tue','Wed','Thu','Fri'];
      const weekendDays = ['Sat','Sun'];
      let wdFees = 0, wdHours = 0, weFees = 0, weHours = 0;
      Object.entries(dowFees).forEach(([day, d]) => {
        if (weekdayDays.includes(day)) { wdFees += d.fees; wdHours += d.hours; }
        else { weFees += d.fees; weHours += d.hours; }
      });
      const weekdayRate = wdHours > 0 ? wdFees / wdHours : 0;
      const weekendRate = weHours > 0 ? weFees / weHours : 0;
      const blendedRate = totalHours > 0 ? (summaries.reduce((s: number, d: any) => s + (d.fees_earned_usdc || 0), 0)) / (totalHours / 24) / 24 : 1;

      // Daily summaries for trend
      const dailyFeesArr = summaries.map((s: any) => ({ date: s.date, fees: s.fees_earned_usdc || 0, total: s.total_usdc, regime: s.regime }));

      // SOL/USDC holdings and rolling averages
      const solHeld = latestSnap.sol_balance + (latestSnap.position_sol || 0);
      const usdcHeld = latestSnap.usdc_balance + (latestSnap.position_usdc || 0);
      const now = Date.now();
      const fees7d = summaries.filter((s: any) => new Date(s.date + 'T00:00:00').getTime() > now - 7 * 86400_000).reduce((a: number, s: any) => a + (s.fees_earned_usdc || 0), 0);
      const fees30d = summaries.filter((s: any) => new Date(s.date + 'T00:00:00').getTime() > now - 30 * 86400_000).reduce((a: number, s: any) => a + (s.fees_earned_usdc || 0), 0);
      const days7 = Math.min(7, summaries.filter((s: any) => new Date(s.date + 'T00:00:00').getTime() > now - 7 * 86400_000).length || 1);
      const days30 = Math.min(30, summaries.filter((s: any) => new Date(s.date + 'T00:00:00').getTime() > now - 30 * 86400_000).length || 1);

      res.json({
        totalHours,
        currentCapital: Math.round(currentCapital),
        currentPrice: latestSnap.price,
        solHeld: parseFloat(solHeld.toFixed(4)),
        usdcHeld: parseFloat(usdcHeld.toFixed(2)),
        avgDailyFees7d: parseFloat((fees7d / days7).toFixed(2)),
        avgDailyFees30d: parseFloat((fees30d / days30).toFixed(2)),
        inRangePct: Math.round(inRangePct * 10) / 10,
        regimeFeeRates: Object.fromEntries(Object.entries(regimeFees).map(([r, d]) => [r, { rate: d.hours > 0 ? d.fees / d.hours : 0, hours: d.hours, irPct: d.total > 0 ? d.inRange / d.total * 100 : 0 }])),
        regimeDistribution: regimeDist,
        weekdayRate,
        weekendRate,
        blendedRate,
        rebalancesPerDay: Math.round(rebalancesPerDay * 10) / 10,
        costPerRebalance: Math.round(costPerRebalance * 10000) / 10000,
        ilPerRebalance: Math.round(ilPerRebalance * 10000) / 10000,
        avgPositionDurationMin: positions.length > 0 ? Math.round(positions.reduce((s: number, p: any) => s + p.duration, 0) / positions.length) : 60,
        totalPositions: positions.length,
        totalGasUsdc: Math.round(totalGasUsdc * 10000) / 10000,
        swapCount,
        dailyFees: dailyFeesArr,
        dataStartDate: new Date(snaps[0].timestamp).toLocaleDateString('en-CA', { timeZone: TZ }),
        dataEndDate: new Date(snaps[snaps.length-1].timestamp).toLocaleDateString('en-CA', { timeZone: TZ }),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Analysis agent page + API
  app.get('/analysis', (_req, res) => {
    if (!dbRef) { res.type('html').send('<h1>DB not ready</h1>'); return; }
    const enabled = (() => { try { const r = dbRef.prepare("SELECT enabled FROM rule_toggles WHERE rule_name = 'analysisAgent'").get() as any; return r?.enabled === 1; } catch { return false; } })();
    const lastReport = (() => { try { const r = dbRef.prepare("SELECT value FROM config WHERE key = 'analysisLastReport'").get() as any; return r?.value ?? null; } catch { return null; } })();
    const lastRunTime = (() => { try { const r = dbRef.prepare("SELECT value FROM config WHERE key = 'analysisLastRunTime'").get() as any; return r?.value ? parseInt(r.value) : null; } catch { return null; } })();
    res.type('html').send(renderAnalysisHtml(enabled, lastReport, lastRunTime));
  });

  app.post('/api/analysis/toggle', (req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    const enabled = req.body?.enabled === true;
    dbRef.prepare("INSERT INTO rule_toggles (rule_name, enabled, updated_at) VALUES ('analysisAgent', ?, ?) ON CONFLICT(rule_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at")
      .run(enabled ? 1 : 0, Date.now());
    console.log(JSON.stringify({ level: 'info', msg: 'Analysis agent ' + (enabled ? 'ENABLED' : 'DISABLED'), timestamp: Date.now() }));
    res.json({ success: true, enabled });
  });

  let analysisRunning = false;
  app.post('/api/analysis/run', async (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not ready' }); return; }
    if (analysisRunning) { res.status(429).json({ error: 'Analysis already running' }); return; }
    analysisRunning = true;
    try {
      const { execSync } = await import('child_process');
      const output = execSync('node scripts/weekly-analysis.cjs --days=7', { cwd: process.cwd(), timeout: 30000 }).toString();
      dbRef.prepare("INSERT INTO config (key, value, updated_at) VALUES ('analysisLastReport', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(output, Date.now());
      dbRef.prepare("INSERT INTO config (key, value, updated_at) VALUES ('analysisLastRunTime', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(String(Date.now()), Date.now());
      res.json({ success: true, report: output });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally {
      analysisRunning = false;
    }
  });

  // Config page + API
  app.get('/config', (_req, res) => {
    res.type('html').send(renderConfigHtml());
  });

  app.get('/api/config', (_req, res) => {
    res.json(exportConfig());
  });

  app.use(express.json());
  app.post('/api/config', (req, res) => {
    try {
      const entries = req.body as Record<string, string>;
      if (!entries || typeof entries !== 'object') {
        res.status(400).json({ error: 'Expected JSON object of key-value pairs' });
        return;
      }
      if (!dbRef) { res.status(500).json({ error: 'DB not initialized' }); return; }
      // Whitelist: only accept keys that exist in the current exported config
      const validKeys = new Set(Object.keys(exportConfig()));
      const filtered: Record<string, string> = {};
      const rejected: string[] = [];
      for (const [k, v] of Object.entries(entries)) {
        if (validKeys.has(k)) { filtered[k] = v; } else { rejected.push(k); }
      }
      if (rejected.length > 0) {
        console.log(JSON.stringify({ level: 'warn', msg: `Config rejected unknown keys: ${rejected.join(', ')}`, timestamp: Date.now() }));
      }
      if (Object.keys(filtered).length === 0) {
        res.status(400).json({ error: 'No valid config keys provided', rejected });
        return;
      }
      setConfigBatch(dbRef, filtered);
      applyConfigFromDb(filtered);
      console.log(JSON.stringify({ level: 'info', msg: `Config updated: ${Object.keys(filtered).length} keys`, keys: Object.keys(filtered), timestamp: Date.now() }));
      res.json({ success: true, updated: Object.keys(filtered).length, rejected });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // CSV download: daily portfolio breakdown (all history)
  // CSV downloads from daily_summary table (all history, pre-computed)
  app.get('/api/daily-portfolio.csv', (_req, res) => {
    if (!dbRef) { res.status(500).send('DB not ready'); return; }
    const rows = getAllDailySummaries(dbRef);
    let csv = 'date,wallet_usdc,position_usdc,total_usdc,injected_usdc,portfolio_change,sol_price,regime\n';
    rows.forEach(r => { csv += `${r.date},${r.wallet_usdc.toFixed(2)},${r.position_usdc.toFixed(2)},${r.total_usdc.toFixed(2)},${r.injected_usdc.toFixed(2)},${r.portfolio_change.toFixed(2)},${r.sol_price.toFixed(2)},${r.regime ?? ''}\n`; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="daily-portfolio.csv"');
    res.send(csv);
  });

  app.get('/api/daily-fees.csv', (_req, res) => {
    if (!dbRef) { res.status(500).send('DB not ready'); return; }
    const rows = getAllDailySummaries(dbRef);
    let csv = 'date,fees_earned_usdc,cumulative_fees_usdc,sol_price\n';
    rows.forEach(r => { csv += `${r.date},${r.fees_earned_usdc.toFixed(6)},${r.cum_fees_usdc.toFixed(6)},${r.sol_price.toFixed(2)}\n`; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="daily-fees.csv"');
    res.send(csv);
  });

  // Simulation data download
  app.get('/api/simulation-data.json', async (_req, res) => {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const filePath = process.cwd() + '/data/simulation-data-compact.json';
      if (existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="simulation-data.json"');
        res.send(readFileSync(filePath, 'utf8'));
      } else {
        res.status(404).json({ error: 'Generate first: node scripts/generate-simulation-data.cjs' });
      }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Health check state
  interface HealthCheck {
    name: string;
    description: string;
    status: 'ok' | 'error' | 'checking';
    detail: string;
    lastChecked: number;
  }
  let healthChecks: HealthCheck[] = [];
  let healthCheckRunning = false;

  async function runHealthChecks(): Promise<HealthCheck[]> {
    if (healthCheckRunning) return healthChecks;
    healthCheckRunning = true;
    const checks: HealthCheck[] = [];
    const now = Date.now();
    const rpcUrl = process.env.RPC_URL ?? '';
    const walletAddr = currentLive?.walletAddress ?? '';

    // 1. Pyth Oracle (Hermes)
    try {
      const feedId = process.env.PYTH_SOL_USD_FEED ?? '';
      const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
      const json = await res.json() as any;
      const price = json.parsed?.[0]?.price;
      if (price) {
        const p = Number(price.price) * Math.pow(10, price.expo);
        checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'ok', detail: `$${p.toFixed(2)} | conf: ${(Number(price.conf) * Math.pow(10, price.expo)).toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'error', detail: 'No price data returned', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'error', detail: String(err), lastChecked: now }); }

    // 2. Solana RPC
    try {
      const conn2 = new Connection(rpcUrl);
      const slot = await conn2.getSlot();
      checks.push({ name: 'Solana RPC', description: 'Helius mainnet RPC', status: 'ok', detail: `Slot: ${slot}`, lastChecked: now });
    } catch (err) { checks.push({ name: 'Solana RPC', description: 'Helius mainnet RPC', status: 'error', detail: String(err), lastChecked: now }); }

    // 3. Wallet balance
    try {
      if (walletAddr) {
        const conn2 = new Connection(rpcUrl);
        const bal = await conn2.getBalance(new PublicKey(walletAddr));
        checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: bal > 10000000 ? 'ok' : 'error', detail: `${(bal / 1e9).toFixed(6)} SOL${bal <= 10000000 ? ' — LOW, need SOL for gas!' : ''}`, lastChecked: now });
      } else {
        checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: 'error', detail: 'No wallet address', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: 'error', detail: String(err), lastChecked: now }); }

    // 4. Orca Whirlpool
    try {
      const conn2 = new Connection(rpcUrl);
      const poolAddr = process.env.WHIRLPOOL_ADDRESS ?? '';
      const accInfo = await conn2.getAccountInfo(new PublicKey(poolAddr));
      checks.push({ name: 'Orca Whirlpool', description: 'SOL/USDC pool account', status: accInfo ? 'ok' : 'error', detail: accInfo ? `Data: ${accInfo.data.length} bytes` : 'Account not found', lastChecked: now });
    } catch (err) { checks.push({ name: 'Orca Whirlpool', description: 'SOL/USDC pool account', status: 'error', detail: String(err), lastChecked: now }); }

    // 5. Pool price
    try {
      if (currentLive?.solPrice) {
        checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'ok', detail: `$${currentLive.solPrice.toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'error', detail: 'No price from pool service', lastChecked: now });
      }
    } catch { checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 6. Position data
    try {
      if (currentLive?.positionMint) {
        checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'ok', detail: `Mint: ${currentLive.positionMint.slice(0, 12)}... | Liq: ${currentLive.positionLiquidity ?? '--'}`, lastChecked: now });
      } else {
        checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'ok', detail: 'No open position (normal if IDLE)', lastChecked: now });
      }
    } catch { checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 7. Pending fees (collectFeesQuote)
    try {
      if (currentLive?.positionMint) {
        const pf = currentLive.pendingFeesTotal;
        checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'ok', detail: `$${pf.toFixed(4)} (${currentLive.pendingFeesSol.toFixed(6)} SOL + ${currentLive.pendingFeesUsdc.toFixed(4)} USDC)`, lastChecked: now });
      } else {
        checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'ok', detail: 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 8. Gas tracking
    try {
      checks.push({ name: 'Gas Tracking', description: 'On-chain tx fee reading', status: (currentLive?.txCount ?? 0) > 0 ? 'ok' : 'ok', detail: `${currentLive?.gasSol?.toFixed(6) ?? '0'} SOL cumulative (${currentLive?.txCount ?? 0} txs)`, lastChecked: now });
    } catch { checks.push({ name: 'Gas Tracking', description: 'On-chain tx fee reading', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 9. Position composition
    try {
      if (currentLive?.positionMint && currentLive.positionValueUsdc > 0) {
        checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: 'ok', detail: `${currentLive.positionSol.toFixed(4)} SOL + ${currentLive.positionUsdc.toFixed(2)} USDC = $${currentLive.positionValueUsdc.toFixed(2)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: currentLive?.positionMint ? 'error' : 'ok', detail: currentLive?.positionMint ? 'Value is 0' : 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 10. SQLite DB
    try {
      if (dbRef) {
        const count = (dbRef.prepare('SELECT COUNT(*) as c FROM live_snapshots').get() as any).c;
        checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'ok', detail: `${count} snapshots recorded`, lastChecked: now });
      } else {
        checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'error', detail: 'DB not initialized', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'error', detail: String(err), lastChecked: now }); }

    // 11. Telegram
    try {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const tgChat = process.env.TELEGRAM_CHAT_ID;
      if (tgToken && tgChat) {
        const res = await fetch(`https://api.telegram.org/bot${tgToken}/getMe`);
        const json = await res.json() as any;
        checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: json.ok ? 'ok' : 'error', detail: json.ok ? `@${json.result.username}` : 'Bot unreachable', lastChecked: now });
      } else {
        checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: 'error', detail: 'Not configured', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: 'error', detail: String(err), lastChecked: now }); }

    // 12. IL calculation
    try {
      if (currentLive?.entryPrice && currentLive.positionMint) {
        checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'ok', detail: `Entry: $${currentLive.entryPrice.toFixed(2)} → Now: $${currentLive.solPrice.toFixed(2)} | IL: $${currentLive.ilUsdc.toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'ok', detail: 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 13-20. Orca Pool Stats API
    try {
      await fetchPoolStats();
      if (poolStats) {
        const ps = poolStats;
        const ok = 'ok' as const;
        checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: ok, detail: `Last fetched: ${new Date(ps.lastFetched).toLocaleTimeString('en-US', { hour12: false, timeZone: TZ })}`, lastChecked: now });
        checks.push({ name: 'Pool TVL', description: 'Total value locked in pool', status: ps.tvlUsdc > 0 ? ok : 'error', detail: `$${fmt(ps.tvlUsdc, 0)}`, lastChecked: now });
        checks.push({ name: 'Pool Volume (24h)', description: 'Trading volume last 24 hours', status: ok, detail: `$${fmt(ps.volume24h, 0)} | 7d: $${fmt(ps.volume7d, 0)} | 30d: $${fmt(ps.volume30d, 0)}`, lastChecked: now });
        checks.push({ name: 'Pool Fees (24h)', description: 'Fees generated last 24 hours', status: ok, detail: `$${fmt(ps.fees24h)} | 7d: $${fmt(ps.fees7d)} | 30d: $${fmt(ps.fees30d)}`, lastChecked: now });
        checks.push({ name: 'Pool APR', description: 'Annualized yield from fees', status: ok, detail: `24h: ${fmt(ps.yield24h * 365 * 100, 1)}% | 7d: ${fmt(ps.yield7d * (365/7) * 100, 1)}% | 30d: ${fmt(ps.yield30d * (365/30) * 100, 1)}%`, lastChecked: now });
        checks.push({ name: 'Pool Price', description: 'Orca pool SOL/USDC price', status: ps.price > 0 ? ok : 'error', detail: `$${fmt(ps.price)} | 24h change: ${ps.priceDelta24h >= 0 ? '+' : ''}${fmt(ps.priceDelta24h * 100, 2)}%`, lastChecked: now });
        checks.push({ name: 'Pool Balances', description: 'Token reserves in pool', status: ok, detail: `${fmt(ps.tokenBalanceA, 2)} SOL + ${fmt(ps.tokenBalanceB, 0)} USDC`, lastChecked: now });
        checks.push({ name: 'Pool Fee Rate', description: 'Swap fee tier', status: ok, detail: `${(ps.feeRate / 10000).toFixed(2)}% (${ps.feeRate / 100} bps) | tick spacing: ${ps.tickSpacing}`, lastChecked: now });
      } else {
        checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: 'error', detail: 'Failed to fetch pool stats', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: 'error', detail: String(err), lastChecked: now }); }

    healthChecks = checks;
    healthCheckRunning = false;
    return checks;
  }

  // Run health checks every 30 minutes
  setInterval(() => { runHealthChecks().catch((err) => { console.log(JSON.stringify({ level: 'error', msg: 'health check error', error: String(err), timestamp: Date.now() })); }); }, 30 * 60_000);

  // Status page
  app.get('/status', async (_req, res) => {
    const checks = await runHealthChecks();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    res.type('html').send(renderStatusHtml(checks, uptime));
  });

  app.get('/api/health', async (_req, res) => {
    const checks = await runHealthChecks();
    res.json(checks);
  });

  // Redirect root to live page
  app.get('/', (_req, res) => {
    res.redirect('/live');
  });

  // Live wallet page — reads events from DB for full history
  app.get('/live', async (_req, res) => {
    await fetchPoolStats();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const allEvents = dbRef ? dbGetRebalanceEvents(dbRef, 50) : currentEvents;
    res.type('html').send(renderLiveHtml(currentLive, allEvents, uptime, poolStats, rule2Enabled, autoDeployEnabled, solConversionEnabled));
  });

  // Bot control APIs
  let onEmergencyStop: (() => Promise<void>) | null = null;
  let onPause: (() => void) | null = null;
  let onResume: (() => void) | null = null;
  let isPaused = false;

  app.post('/api/emergency-stop', async (_req, res) => {
    if (onEmergencyStop) {
      try {
        await onEmergencyStop();
        res.json({ success: true, msg: 'Position closed and bot stopped.' });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No emergency stop handler registered.' });
    }
  });

  app.post('/api/pause', (_req, res) => {
    if (onPause) {
      onPause();
      isPaused = true;
      res.json({ success: true, msg: 'Bot paused. Position stays open on-chain.' });
    } else {
      res.status(400).json({ success: false, msg: 'No pause handler registered.' });
    }
  });

  app.post('/api/resume', (_req, res) => {
    if (onResume) {
      onResume();
      isPaused = false;
      res.json({ success: true, msg: 'Bot resumed.' });
    } else {
      res.status(400).json({ success: false, msg: 'No resume handler registered.' });
    }
  });

  let onClosePosition: (() => Promise<void>) | null = null;

  app.post('/api/close-position', async (_req, res) => {
    if (onClosePosition) {
      try {
        await onClosePosition();
        res.json({ success: true, msg: 'Position closed. Bot paused in IDLE state. Click Resume to restart.' });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No close-position handler registered.' });
    }
  });

  let onHarvest: (() => Promise<{ feeSol: number; feeUsdc: number }>) | null = null;

  app.post('/api/harvest', async (_req, res) => {
    if (onHarvest) {
      try {
        const fees = await onHarvest();
        res.json({ success: true, msg: `Harvested ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC` });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No harvest handler registered.' });
    }
  });

  // Rule 2 toggle
  let onToggleRule2: ((enabled: boolean) => void) | null = null;
  let rule2Enabled = true;

  app.post('/api/toggle-rule2', (req, res) => {
    rule2Enabled = !rule2Enabled;
    if (onToggleRule2) {
      onToggleRule2(rule2Enabled);
    }
    res.json({ success: true, rule2Enabled, msg: rule2Enabled ? 'Rule 2 (proximity exit) enabled.' : 'Rule 2 (proximity exit) disabled. Positions will only close when fully out of range.' });
  });

  app.get('/api/rule2-status', (_req, res) => {
    res.json({ rule2Enabled });
  });

  // Auto-deploy toggle
  let onToggleAutoDeploy: ((enabled: boolean) => void) | null = null;
  let autoDeployEnabled = true;

  app.post('/api/toggle-auto-deploy', (_req, res) => {
    autoDeployEnabled = !autoDeployEnabled;
    if (onToggleAutoDeploy) {
      onToggleAutoDeploy(autoDeployEnabled);
    }
    res.json({ success: true, autoDeployEnabled, msg: autoDeployEnabled ? 'Auto capital deployment enabled.' : 'Auto capital deployment disabled.' });
  });

  app.get('/api/auto-deploy-status', (_req, res) => {
    res.json({ autoDeployEnabled });
  });

  // SOL Conversion toggle
  let solConversionEnabled = runtime.solConversionEnabled;
  app.post('/api/toggle-sol-conversion', (_req, res) => {
    solConversionEnabled = !solConversionEnabled;
    if (dbRef) {
      try {
        dbRef.prepare('UPDATE bot_state SET sol_conversion_enabled = ? WHERE id = 1').run(solConversionEnabled ? 1 : 0);
        // Also write to config table for runtime reload
        dbRef.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('solConversionEnabled', ?, ?)").run(solConversionEnabled ? '1' : '0', Date.now());
      } catch {}
    }
    res.json({ success: true, solConversionEnabled, msg: solConversionEnabled ? 'SOL Conversion enabled.' : 'SOL Conversion disabled.' });
  });
  app.get('/api/sol-conversion-status', (_req, res) => {
    let lastTs = 0;
    if (dbRef) {
      try { const r = dbRef.prepare('SELECT sol_conversion_last_ts FROM bot_state WHERE id = 1').get() as any; lastTs = r?.sol_conversion_last_ts ?? 0; } catch {}
    }
    const cooldownMs = 15 * 60_000;
    const cooldownRemaining = lastTs > 0 ? Math.max(0, (cooldownMs - (Date.now() - lastTs)) / 60_000) : 0;
    const lastAgo = lastTs > 0 ? `${((Date.now() - lastTs) / 60_000).toFixed(0)}min ago` : 'never';
    res.json({ enabled: solConversionEnabled, lastConversionTs: lastTs, cooldownRemainingMin: Math.round(cooldownRemaining), lastConversionAgo: lastAgo });
  });

  // Regime snapshots API
  app.get('/api/regime-snapshots', (req, res) => {
    if (!dbRef) { res.json([]); return; }
    const limit = parseInt(req.query.limit as string) || 100;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const regime = req.query.regime as string | undefined;
    const changed = req.query.changed === '1';
    res.json(getRegimeSnapshots(dbRef, { limit, since, regime, changed }));
  });

  // Regime intelligence API
  app.get('/api/regime-intelligence', (_req, res) => {
    if (!dbRef) { res.json(null); return; }
    try {
      const snap = getRegimeSnapshots(dbRef, { limit: 1 })[0];
      if (!snap) { res.json(null); return; }
      const emaGapPct = snap.ema9 && snap.sma20 && snap.sma20 > 0 ? ((snap.ema9 - snap.sma20) / snap.sma20 * 100) : 0;
      const regimeParams = runtime.regimeParams[snap.regime as keyof typeof runtime.regimeParams];
      const deployPct = regimeParams?.deployPct ?? 1;
      const confMultiplier = snap.confidence === 'HIGH' ? 1.0 : snap.confidence === 'MEDIUM' ? 0.75 : 0.50;
      res.json({
        ...snap,
        emaGapPct: parseFloat(emaGapPct.toFixed(3)),
        deployPct: parseFloat((deployPct * 100).toFixed(0)),
        confidenceMultiplier: confMultiplier,
        effectiveDeployPct: parseFloat((deployPct * confMultiplier * 100).toFixed(0)),
      });
    } catch { res.json(null); }
  });

  // Price triggers API
  app.get('/api/price-triggers', (_req, res) => {
    const live = currentLive;
    if (!live || !dbRef) { res.json(null); return; }
    try {
      const price = live.solPrice;
      const regime = live.regime as keyof typeof runtime.regimeParams;
      const params = runtime.regimeParams[regime] ?? runtime.regimeParams['RANGING'];
      const pos = live.positionRange;
      const basis = live.solCostBasis || 0;
      const active = live.botState === 'ACTIVE' && pos;
      const lower = pos?.lower ?? 0;
      const upper = pos?.upper ?? 0;
      const range = upper - lower;
      const centre = (lower + upper) / 2;
      const hw = range / 2;
      const triggers: any[] = [];
      if (active && range > 0) {
        // Down/Up exit: rules.ts formula — proxToLower = (centre - price) / halfWidth
        triggers.push({ id: 'downExit', label: 'Down exit', triggerPrice: parseFloat((centre - params.proxThresholdLower * hw).toFixed(2)), direction: 'below', color: '#ef4444' });
        triggers.push({ id: 'upExit', label: 'Up exit', triggerPrice: parseFloat((centre + params.proxThresholdUpper * hw).toFixed(2)), direction: 'above', color: '#22c55e' });
        // Auto-deploy: executor.ts formula — proximityToLower = 1 - (price - lower) / range
        const adThreshold = params.proximityDeployThreshold ?? 0.40;
        const reserveFloorVal = live.reserveFloor ?? 0;
        const idleUsdcAboveFloor = Math.max(0, live.usdcBalance - reserveFloorVal);
        const adBlocked = idleUsdcAboveFloor < 100;
        triggers.push({ id: 'autoDeploy', label: 'Auto-deploy', triggerPrice: parseFloat((lower + (1 - adThreshold) * range).toFixed(2)), direction: 'above', color: adBlocked ? '#eab308' : '#58a6ff', idleUsdcAboveFloor: parseFloat(idleUsdcAboveFloor.toFixed(2)), autoDeployBlocked: adBlocked });
      }
      if (runtime.solConversionEnabled && basis > 0) {
        const scRegimeMult: Record<string, number | null> = { RANGING: 1.000, BULLISH_TREND: 1.010, BEARISH_TREND: 1.005, EXTREME: null };
        const scMult = scRegimeMult[regime] ?? null;
        if (scMult !== null) {
          const scEffective = scMult * runtime.solConversionBasisMultiplier;
          triggers.push({ id: 'solConvert', label: 'SOL convert', triggerPrice: parseFloat((basis * scEffective).toFixed(2)), direction: 'above', color: '#a855f7' });
        }
      }
      if (live.botState !== 'ACTIVE' && basis > 0) {
        triggers.push({ id: 'basisGate', label: 'Re-entry gate', triggerPrice: parseFloat((basis * (params.basisGateThreshold ?? 0.999)).toFixed(2)), direction: 'above', color: '#eab308' });
      }
      if (live.churnGuardActive && live.churnGuardLastExitPrice) {
        triggers.push({ id: 'churnGuard', label: 'ChurnGuard', triggerPrice: live.churnGuardLastExitPrice, direction: 'above', color: '#8b949e' });
      }
      // Pullback target — show when bot is waiting for pullback
      if (live.botState === 'WAITING_PULLBACK') {
        try {
          const pbState = dbRef.prepare('SELECT pullback_peak, pullback_start FROM bot_state WHERE id = 1').get() as any;
          if (pbState?.pullback_peak > 0) {
            const pullbackPct = runtime.pullbackThresholdPct / 100;
            const pullbackTarget = parseFloat((pbState.pullback_peak * (1 - pullbackPct)).toFixed(2));
            triggers.push({ id: 'pullback', label: 'Pullback target', triggerPrice: pullbackTarget, direction: 'below', color: '#f97316', note: `peak $${pbState.pullback_peak.toFixed(2)}` });
          }
        } catch {}
      }
      // Compute fill percentages and distances
      const currentProxToLower = hw > 0 ? Math.max(0, (centre - price) / hw) : 0;
      const currentProxToUpper = hw > 0 ? Math.max(0, (price - centre) / hw) : 0;
      for (const t of triggers) {
        t.distance = parseFloat((t.triggerPrice - price).toFixed(2));
        t.distanceAbs = Math.abs(t.distance);
        if (t.id === 'downExit') {
          // Fill = how close current proximity is to exit threshold (0%=safe, 100%=at exit)
          t.pctFilled = params.proxThresholdLower > 0 ? Math.min(100, Math.max(0, (currentProxToLower / params.proxThresholdLower) * 100)) : 0;
        } else if (t.id === 'upExit') {
          t.pctFilled = params.proxThresholdUpper > 0 ? Math.min(100, Math.max(0, (currentProxToUpper / params.proxThresholdUpper) * 100)) : 0;
        } else if (t.id === 'autoDeploy') {
          if (price >= t.triggerPrice) {
            t.pctFilled = 100;
            if (t.autoDeployBlocked) {
              t.note = 'BLOCKED';
              t.color = '#eab308';
              t.subNote = `$${t.idleUsdcAboveFloor.toFixed(0)} above floor`;
            } else {
              t.note = 'ACTIVE';
              t.color = '#22c55e';
              t.subNote = `deploying $${t.idleUsdcAboveFloor.toFixed(0)}`;
            }
          } else {
            const adRange = t.triggerPrice - lower;
            t.pctFilled = adRange > 0 ? Math.min(100, Math.max(0, ((price - lower) / adRange) * 100)) : 0;
          }
        } else if (t.id === 'pullback') {
          // Pullback: how far price has dropped from peak toward target (100% = at target)
          const peak = parseFloat(t.note?.replace('peak $', '') ?? '0') || price;
          const dropNeeded = peak - t.triggerPrice;
          const dropSoFar = peak - price;
          t.pctFilled = dropNeeded > 0 ? Math.min(100, Math.max(0, (dropSoFar / dropNeeded) * 100)) : 0;
        } else {
          // For basis gate, SOL convert, churnGuard — simple distance-based
          t.pctFilled = t.triggerPrice > lower ? Math.min(100, Math.max(0, ((price - lower) / (t.triggerPrice - lower)) * 100)) : 0;
        }
        t.pctFilled = parseFloat(t.pctFilled.toFixed(1));
      }
      const closest = triggers.length > 0 ? triggers.reduce((a, b) => a.distanceAbs < b.distanceAbs ? a : b) : null;
      res.json({ currentPrice: price, triggers, closestTrigger: closest ? { label: closest.label, price: closest.triggerPrice, distance: closest.distance } : null });
    } catch { res.json(null); }
  });

  // Add liquidity
  let onAddLiquidity: (() => Promise<{ solDeposited: number; usdcDeposited: number; totalUsdc: number; liquidityAdded: string }>) | null = null;
  let onAddLiquidityPreview: (() => Promise<{ solAvailable: number; usdcAvailable: number; totalAvailableUsdc: number; estSolDeposit: number; estUsdcDeposit: number; estTotalUsdc: number; positionRange: string; needsSwap: string } | null>) | null = null;

  app.get('/api/add-liquidity-preview', async (_req, res) => {
    if (!onAddLiquidityPreview) { res.status(400).json({ error: 'No handler registered' }); return; }
    try {
      const preview = await onAddLiquidityPreview();
      if (!preview) { res.json({ available: false, reason: 'No open position or insufficient wallet balance' }); return; }
      res.json({ available: true, ...preview });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/add-liquidity', async (_req, res) => {
    if (!onAddLiquidity) { res.status(400).json({ success: false, msg: 'No handler registered' }); return; }
    try {
      const result = await onAddLiquidity();
      res.json({ success: true, ...result, msg: `Added ${result.solDeposited.toFixed(4)} SOL + ${result.usdcDeposited.toFixed(2)} USDC ($${result.totalUsdc.toFixed(2)}) to position` });
    } catch (err) {
      res.status(500).json({ success: false, msg: String(err) });
    }
  });

  app.get('/api/bot-status', (_req, res) => {
    res.json({ paused: isPaused, botState: currentBotState });
  });

  server = app.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: `dashboard running on http://localhost:${port}`,
      timestamp: Date.now(),
    }));
  });

  return {
    updateData(events, botState, dailyPnl) {
      currentEvents = events;
      currentBotState = botState;
      if (dailyPnl) currentDailyPnl = dailyPnl;
    },
    updateLiveData(live) {
      currentLive = live;
    },
    onEmergencyStop(handler) {
      onEmergencyStop = handler;
    },
    onPause(handler) {
      onPause = handler;
    },
    onResume(handler) {
      onResume = handler;
    },
    onHarvest(handler) {
      onHarvest = handler;
    },
    onClosePosition(handler) {
      onClosePosition = handler;
    },
    onToggleRule2(handler) {
      onToggleRule2 = handler;
    },
    onToggleAutoDeploy(handler) {
      onToggleAutoDeploy = handler;
    },
    onAddLiquidity(handler) {
      onAddLiquidity = handler;
    },
    onAddLiquidityPreview(handler) {
      onAddLiquidityPreview = handler;
    },
    getRule2Enabled() {
      return rule2Enabled;
    },
    setRule2Enabled(enabled: boolean) {
      rule2Enabled = enabled;
    },
    getAutoDeployEnabled() {
      return autoDeployEnabled;
    },
    setAutoDeployEnabled(enabled: boolean) {
      autoDeployEnabled = enabled;
    },
    getPoolStats() {
      return poolStats;
    },
    setDb(d) {
      dbRef = d;
    },
    stop() {
      server.close();
    },
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number, d = 2): string {
  const parts = Math.abs(n).toFixed(d).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + parts.join('.');
}

// ── Shared styles ─────────────────────────────────────────────────────────

const SHARED_STYLES = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'SF Mono',Menlo,monospace;font-size:13px;padding:16px;-webkit-text-size-adjust:100%}
.banner{text-align:center;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px}
.banner h1{font-size:16px;color:#58a6ff}
.banner .mode{font-size:11px;text-transform:uppercase;letter-spacing:2px}
.nav{display:flex;gap:6px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:8px 14px;border:1px solid #30363d;border-radius:6px;font-size:12px;transition:all 0.2s;white-space:nowrap;text-align:center}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:13px;color:#8b949e;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d;gap:8px;flex-wrap:wrap}
.row .label{color:#8b949e;flex-shrink:0}
.row .value{font-weight:bold;text-align:right;word-break:break-word}
.green{color:#22c55e}.red{color:#ef4444}.amber{color:#eab308}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold}
.full{grid-column:1/-1}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d;white-space:nowrap}
td{padding:6px 4px;border-bottom:1px solid #21262d;vertical-align:top}
td:last-child{color:#8b949e;font-size:11px;line-height:1.4;max-width:500px}
.dots{display:flex;gap:8px;align-items:center}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.big-number{text-align:center;padding:12px 0}
.big-number .val{font-size:28px;font-weight:bold}
.big-number .sub{color:#8b949e;font-size:11px;margin-top:4px}
.range-bar{position:relative;height:24px;background:#21262d;border-radius:4px;margin:8px 0;overflow:hidden}
.range-fill{position:absolute;height:100%;background:#58a6ff20;border-left:2px solid #58a6ff;border-right:2px solid #58a6ff}
.range-cursor{position:absolute;top:0;width:3px;height:100%;background:#f0883e}
@media(max-width:700px){
  body{padding:8px;font-size:12px}
  .grid{grid-template-columns:1fr;gap:8px}
  .card{padding:10px}
  .card h2{font-size:11px;margin-bottom:8px}
  .banner{padding:8px}
  .banner h1{font-size:14px}
  .nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px}
  .nav a{padding:6px 3px;font-size:9px;text-align:center;min-width:0}
  .big-number .val{font-size:20px}
  .row{font-size:11px}
  .row .value{font-size:11px}
  table{font-size:10px}
  th,td{padding:4px 2px}
  td:last-child{max-width:150px}
  .range-bar{height:20px}
}
`;

const NAV_HTML = `
<div class="nav">
  <a href="/live" id="nav-live">Live Wallet</a>
  <a href="/insights" id="nav-insights">Insights</a>
  <a href="/strategy" id="nav-strategy">Strategy</a>
  <a href="/config" id="nav-config">Config</a>
  <a href="/status" id="nav-status">Status</a>
  <a href="/analytics" id="nav-analytics">Analytics</a>
  <a href="/investors" id="nav-investors">Investors</a>
  <a href="/projection" id="nav-projection">Projection</a>
  <a href="/analysis" id="nav-analysis">Agent</a>
  <a href="/intelligence" id="nav-intelligence">Intelligence</a>
  <a href="/arcade" id="nav-arcade">Arcade</a>
</div>`;

// ── Paper page ────────────────────────────────────────────────────────────

function renderPaperHtml(data: {
  comparison: any;
  recentEvents: RebalanceEvent[];
  dailyPnl: DailyPnlRow[];
  botState: BotState;
  uptime: number;
}): string {
  const c = data.comparison;
  const regimeColours: Record<string, string> = {
    RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7',
  };
  const stateColours: Record<string, string> = {
    IDLE: '#888', ACTIVE: '#22c55e', REBALANCING: '#eab308', HALTED: '#ef4444', WAITING_PULLBACK: '#f97316',
  };

  const price = c ? `$${fmt(c.price)}` : '--';
  const regime = c ? c.bot.regime : 'RANGING';
  const regimeCol = regimeColours[regime] || '#888';
  const stateCol = stateColours[data.botState] || '#888';

  const botVal = c ? `$${fmt(c.bot.portfolioValue)}` : '--';
  const naiveVal = c ? `$${fmt(c.naive.portfolioValue)}` : '--';
  const botPnl = c ? `${c.bot.netPnl >= 0 ? '+' : ''}$${fmt(c.bot.netPnl)}` : '--';
  const naivePnl = c ? `${c.naive.netPnl >= 0 ? '+' : ''}$${fmt(c.naive.netPnl)}` : '--';
  const botApr = c ? `${c.bot.netApr >= 0 ? '+' : ''}${fmt(c.bot.netApr, 1)}%` : '--';
  const naiveApr = c ? `${c.naive.netApr >= 0 ? '+' : ''}${fmt(c.naive.netApr, 1)}%` : '--';
  const botFees = c ? `+$${fmt(c.bot.cumFees)}` : '--';
  const naiveFees = c ? `+$${fmt(c.naive.cumFees)}` : '--';
  const botIL = c ? `$${fmt(c.bot.cumIL)}` : '--';
  const naiveIL = c ? `$${fmt(c.naive.cumIL)}` : '--';
  const advantage = c ? `${c.advantage >= 0 ? '+' : ''}$${fmt(c.advantage)}` : '--';
  const advCol = c && c.advantage >= 0 ? '#22c55e' : '#ef4444';

  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  const eventRows = data.recentEvents.map(e => {
    const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false, timeZone: TZ });
    return `<tr><td>${t}</td><td>${e.eventType}</td><td>$${fmt(e.price)}</td><td>${e.regime}</td><td>${e.note || ''}</td></tr>`;
  }).join('');

  const maxPnl = Math.max(1, ...data.dailyPnl.map(d => Math.abs(d.net_pnl ?? 0)));
  const pnlBars = data.dailyPnl.slice(-7).map(d => {
    const pnl = d.net_pnl ?? 0;
    const h = Math.max(2, Math.abs(pnl) / maxPnl * 80);
    const col = pnl >= 0 ? '#22c55e' : '#ef4444';
    const y = pnl >= 0 ? 90 - h : 90;
    return `<rect x="0" y="${y}" width="30" height="${h}" fill="${col}" rx="2"/><text x="15" y="108" text-anchor="middle" fill="#888" font-size="9">${d.date.slice(5)}</text>`;
  }).map((bar, i) => bar.replace(/x="0"/g, `x="${i * 40 + 5}"`)).join('');

  const dailyLoss = c ? ((1000 - c.bot.portfolioValue) / 1000 * 100) : 0;
  const cbDaily = dailyLoss > 5 ? '#ef4444' : dailyLoss > 3 ? '#eab308' : '#22c55e';
  const cbIL = c && Math.abs(c.bot.cumIL) > 80 ? '#ef4444' : '#22c55e';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>SOL/USDC LP Bot - Paper Simulation</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#f0883e">Paper Simulation</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | State: <span style="color:${stateCol}">${data.botState}</span></div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-paper').classList.add('active')</script>

<div class="grid">
  <div class="card">
    <h2>Market</h2>
    <div class="row"><span class="label">SOL Price</span><span class="value">${price}</span></div>
    <div class="row"><span class="label">Regime</span><span class="badge" style="background:${regimeCol}20;color:${regimeCol}">${regime}</span></div>
    <div class="row"><span class="label">Circuit Breakers</span><span class="dots"><span class="dot" style="background:${cbDaily}" title="Daily Loss"></span><span class="dot" style="background:${cbIL}" title="IL"></span></span></div>
  </div>

  <div class="card">
    <h2>Advantage</h2>
    <div class="big-number">
      <div class="val" style="color:${advCol}">${advantage}</div>
      <div class="sub">vs naive benchmark</div>
    </div>
  </div>

  <div class="card">
    <h2>Bot Strategy</h2>
    <div class="row"><span class="label">Portfolio</span><span class="value">${botVal}</span></div>
    <div class="row"><span class="label">Net P&L</span><span class="value ${c && c.bot.netPnl >= 0 ? 'green' : 'red'}">${botPnl}</span></div>
    <div class="row"><span class="label">Net APR</span><span class="value ${c && c.bot.netApr >= 0 ? 'green' : 'red'}">${botApr}</span></div>
    <div class="row"><span class="label">Fees</span><span class="value green">${botFees}</span></div>
    <div class="row"><span class="label">IL Cost</span><span class="value red">${botIL}</span></div>
    <div class="row"><span class="label">Rebalances</span><span class="value">${c ? c.bot.rebalanceCount : '--'}</span></div>
  </div>

  <div class="card">
    <h2>Naive Benchmark</h2>
    <div class="row"><span class="label">Portfolio</span><span class="value">${naiveVal}</span></div>
    <div class="row"><span class="label">Net P&L</span><span class="value ${c && c.naive.netPnl >= 0 ? 'green' : 'red'}">${naivePnl}</span></div>
    <div class="row"><span class="label">Net APR</span><span class="value ${c && c.naive.netApr >= 0 ? 'green' : 'red'}">${naiveApr}</span></div>
    <div class="row"><span class="label">Fees</span><span class="value green">${naiveFees}</span></div>
    <div class="row"><span class="label">IL Cost</span><span class="value red">${naiveIL}</span></div>
    <div class="row"><span class="label">Rebalances</span><span class="value">${c ? c.naive.rebalanceCount : '--'}</span></div>
  </div>

  <div class="card full">
    <h2>7-Day P&L</h2>
    <svg width="100%" height="120" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid meet">
      ${pnlBars || '<text x="150" y="60" text-anchor="middle" fill="#8b949e" font-size="12">No data yet</text>'}
    </svg>
  </div>

  <div class="card full">
    <h2>Recent Events</h2>
    <table>
      <thead><tr><th>Time</th><th>Event</th><th>Price</th><th>Regime</th><th>Description</th></tr></thead>
      <tbody>${eventRows || '<tr><td colspan="5" style="text-align:center;color:#8b949e">No events yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<script>window.__DATA__ = ${JSON.stringify(data)};</script>
</body>
</html>`;
}

// ── Live page ─────────────────────────────────────────────────────────────

function renderLiveHtml(live: LiveData | null, liveEvents: RebalanceEvent[], uptime: number, pool: PoolStats | null = null, rule2Enabled = true, autoDeployEnabled = true, solConversionEnabled = false): string {
  const regimeColours: Record<string, string> = {
    RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7',
  };
  const stateColours: Record<string, string> = {
    IDLE: '#888', ACTIVE: '#22c55e', REBALANCING: '#eab308', HALTED: '#ef4444', WAITING_PULLBACK: '#f97316',
  };

  const uptimeMin = Math.floor(uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  if (!live) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="10">
<title>SOL/USDC LP Bot - Live Wallet</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#ef4444">Live Wallet</div>
  <h1>SOL/USDC LP Bot</h1>
</div>
${NAV_HTML}
<script>document.getElementById('nav-live').classList.add('active')</script>
<div class="card" style="text-align:center;padding:40px">
  <h2>Not Available</h2>
  <p style="color:#8b949e;margin-top:12px">Bot is running in SHADOW mode. Set <code>BOT_MODE=LIVE</code> in .env to enable.</p>
</div>
${pool ? `<div class="card" style="margin-top:12px">
  <h2>SOL/USDC Pool <span style="font-size:10px;color:#8b949e;font-weight:normal;text-transform:none;letter-spacing:0">(Orca Whirlpool &middot; tick ${pool.tickSpacing} &middot; ${(pool.feeRate / 10000).toFixed(2)}% fee)</span></h2>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#58a6ff">$${fmt(pool.tvlUsdc, 0)}</div>
      <div style="font-size:10px;color:#8b949e">TVL</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#22c55e">$${fmt(pool.volume24h, 0)}</div>
      <div style="font-size:10px;color:#8b949e">Volume 24h</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#eab308">${fmt(pool.yield24h * 365 * 100, 1)}%</div>
      <div style="font-size:10px;color:#8b949e">APR (24h)</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d"></th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">24h</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">7d</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">30d</th>
    </tr></thead>
    <tbody>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Volume</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume24h, 0)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume7d, 0)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume30d, 0)}</td></tr>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Fees</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees24h)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees7d)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees30d)}</td></tr>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Yield / TVL</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield24h * 100, 4)}%</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield7d * 100, 4)}%</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield30d * 100, 3)}%</td></tr>
      <tr><td style="padding:6px 8px;color:#8b949e">APR</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield24h * 365 * 100, 1)}%</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield7d * (365/7) * 100, 1)}%</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield30d * (365/30) * 100, 1)}%</td></tr>
    </tbody>
  </table>
  <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#8b949e;flex-wrap:wrap">
    <span>Pool SOL: ${fmt(pool.tokenBalanceA, 2)}</span>
    <span>Pool USDC: ${fmt(pool.tokenBalanceB, 0)}</span>
    <span>Price 24h: <span style="color:${pool.priceDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.priceDelta24h >= 0 ? '+' : ''}${fmt(pool.priceDelta24h * 100, 2)}%</span></span>
    <span>Vol 24h: <span style="color:${pool.volumeDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.volumeDelta24h >= 0 ? '+' : ''}${fmt(pool.volumeDelta24h * 100, 1)}%</span> vs prior</span>
  </div>
</div>` : ''}
</body>
</html>`;
  }

  const regimeCol = regimeColours[live.regime] || '#888';
  const stateCol = stateColours[live.botState] || '#888';
  const totalValue = `$${fmt(live.totalValueUsdc)}`;
  const solValue = live.solBalance * live.solPrice;

  // Position range bar
  let rangeBarHtml = '<div style="color:#8b949e;text-align:center;padding:8px">No open position</div>';
  if (live.positionRange) {
    const r = live.positionRange;
    const rangeWidth = r.upper - r.lower;
    const centre = (r.lower + r.upper) / 2;
    const halfWidth = rangeWidth / 2;
    const cursorPos = Math.max(0, Math.min(100, ((live.solPrice - r.lower) / rangeWidth) * 100));
    const entryPos = live.entryPrice ? Math.max(0, Math.min(100, ((live.entryPrice - r.lower) / rangeWidth) * 100)) : null;

    // Proximity thresholds for current regime (use runtime config, not hardcoded constants)
    const regimeKey = live.regime ?? 'RANGING';
    const params = runtime.regimeParams[regimeKey] ?? runtime.regimeParams.RANGING;
    // Downside threshold: triggers when price drops to centre - threshold * halfWidth
    const downsidePrice = centre - params.proxThresholdLower * halfWidth;
    const downsidePos = Math.max(0, Math.min(100, ((downsidePrice - r.lower) / rangeWidth) * 100));
    // Upside threshold: triggers when price rises to centre + threshold * halfWidth
    const upsidePrice = centre + params.proxThresholdUpper * halfWidth;
    const upsidePos = Math.max(0, Math.min(100, ((upsidePrice - r.lower) / rangeWidth) * 100));
    // Current proximity values
    const proxToLower = Math.max(0, (centre - live.solPrice) / halfWidth);
    const proxToUpper = Math.max(0, (live.solPrice - centre) / halfWidth);
    const proxDownPct = Math.round(proxToLower * 100);
    const proxUpPct = Math.round(proxToUpper * 100);
    const downThreshPct = Math.round(params.proxThresholdLower * 100);
    const upThreshPct = Math.round(params.proxThresholdUpper * 100);

    rangeBarHtml = `
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#8b949e;margin-bottom:4px">
        <span>$${fmt(r.lower)}</span>
        <span style="color:#f0883e">$${fmt(live.solPrice)} (current)</span>
        <span>$${fmt(r.upper)}</span>
      </div>
      <div class="range-bar" style="height:32px">
        <div class="range-fill" style="left:0;width:100%"></div>
        <!-- Danger zones: beyond thresholds -->
        <div style="position:absolute;top:0;left:0;width:${downsidePos}%;height:100%;background:rgba(249,115,22,0.15);border-right:2px dashed #f97316" title="Downside exit at $${fmt(downsidePrice)} (${downThreshPct}%)"></div>
        <div style="position:absolute;top:0;right:0;width:${(100 - upsidePos).toFixed(1)}%;height:100%;background:rgba(88,166,255,0.15);border-left:2px dashed #58a6ff" title="Upside exit at $${fmt(upsidePrice)} (${upThreshPct}%)"></div>
        <!-- Threshold labels -->
        <div style="position:absolute;top:1px;left:${downsidePos}%;transform:translateX(-100%);font-size:9px;color:#f97316;padding:0 3px;white-space:nowrap">&#x25BC; ${downThreshPct}%</div>
        <div style="position:absolute;top:1px;left:${upsidePos}%;transform:translateX(0%);font-size:9px;color:#58a6ff;padding:0 3px;white-space:nowrap">${upThreshPct}% &#x25B2;</div>
        ${entryPos !== null ? `<div style="position:absolute;top:0;width:3px;height:100%;background:#a855f7;left:${entryPos}%" title="Entry: $${fmt(live.entryPrice!)}"></div>` : ''}
        <div class="range-cursor" style="left:${cursorPos}%"></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">
        <tbody>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Price</td>
            <td style="padding:6px 8px;color:#f0883e;font-weight:bold">$${fmt(live.solPrice)}</td>
            <td style="padding:6px 8px;color:#8b949e">Prox &#x25BC;</td>
            <td style="padding:6px 8px"><b style="color:${proxDownPct >= downThreshPct ? '#f97316' : '#c9d1d9'}">${proxDownPct}%</b><span style="color:#8b949e">/${downThreshPct}%</span></td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Entry</td>
            <td style="padding:6px 8px;color:#a855f7;font-weight:bold">${live.entryPrice ? `$${fmt(live.entryPrice)}` : '--'}</td>
            <td style="padding:6px 8px;color:#8b949e">Prox &#x25B2;</td>
            <td style="padding:6px 8px"><b style="color:${proxUpPct >= upThreshPct ? '#58a6ff' : '#c9d1d9'}">${proxUpPct}%</b><span style="color:#8b949e">/${upThreshPct}%</span></td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Range</td>
            <td style="padding:6px 8px;color:#8b949e">$${fmt(r.lower)}&#x2013;$${fmt(r.upper)}</td>
            <td style="padding:6px 8px;color:#8b949e">Now</td>
            <td style="padding:6px 8px;color:#f0883e">${fmt(live.positionSol, 4)} SOL + ${fmt(live.positionUsdc)} USDC</td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">R2 Exit</td>
            <td style="padding:6px 8px"><span style="color:#f97316">$${fmt(downsidePrice)}</span> <span style="color:#8b949e">/</span> <span style="color:#58a6ff">$${fmt(upsidePrice)}</span></td>
            <td style="padding:6px 8px;color:#8b949e">At entry</td>
            <td style="padding:6px 8px;color:#a855f7">${fmt(live.entrySol ?? 0, 4)} SOL + ${fmt(live.entryUsdc ?? 0)} USDC</td>
          </tr>
          ${live.entryTime ? (() => {
            const ageMs = Date.now() - live.entryTime;
            const ageMin = Math.floor(ageMs / 60_000);
            const ageH = Math.floor(ageMin / 60);
            const ageStr = ageH > 0 ? `${ageH}h ${ageMin % 60}m` : `${ageMin}m`;
            const inRange = live.solPrice >= r.lower && live.solPrice <= r.upper;
            const inRangeCol = inRange ? '#22c55e' : '#ef4444';
            return `<tr style="border-bottom:1px solid #21262d">
              <td style="padding:6px 8px;color:#8b949e">In Range</td>
              <td style="padding:6px 8px"><span style="color:${inRangeCol};font-weight:bold">${inRange ? 'YES' : 'NO'}</span></td>
              <td style="padding:6px 8px;color:#8b949e">Age</td>
              <td style="padding:6px 8px;color:#c9d1d9">${ageStr}</td>
            </tr>`;
          })() : ''}
        </tbody>
      </table>`;
  }

  // Events — each event is a full card with description
  const eventCards = liveEvents.map(e => {
    const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false, timeZone: TZ });
    const d = new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
    const typeColors: Record<string, string> = {
      POSITION_OPENED: '#22c55e', POSITION_CLOSED: '#ef4444',
      T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308',
      PULLBACK_REENTRY: '#22c55e', PULLBACK_TIMEOUT: '#a855f7',
      FEE_HARVEST: '#58a6ff', CIRCUIT_BREAKER: '#ef4444',
      REGIME_CHANGE: '#a855f7', LIQUIDITY_ADDED: '#22c55e',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="event-card">
      <div class="event-header">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span class="event-meta">${d} ${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div class="event-desc">${escHtml(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
      ${e.feeSol || e.feeUsdc ? `<div class="event-balances" style="color:#22c55e">Fees: ${fmt(e.feeSol, 6)} SOL + ${fmt(e.feeUsdc, 4)} USDC${e.ilAtClose ? ` | IL: $${fmt(e.ilAtClose, 4)}` : ''}</div>` : ''}
      ${e.solBefore || e.usdcBefore || e.solAfter || e.usdcAfter ? `<div class="event-balances">Before: ${fmt(e.solBefore, 4)} SOL / ${fmt(e.usdcBefore, 2)} USDC &rarr; After: ${fmt(e.solAfter, 4)} SOL / ${fmt(e.usdcAfter, 2)} USDC${!e.feeSol && !e.feeUsdc && e.ilAtClose ? ` | IL: $${fmt(e.ilAtClose, 4)}` : ''}</div>` : ''}
    </div>`;
  }).join('');

  // Solscan link
  const solscanUrl = `https://solscan.io/account/${live.walletAddress}`;
  const shortAddr = live.walletAddress.slice(0, 6) + '...' + live.walletAddress.slice(-4);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta id="auto-refresh" http-equiv="refresh" content="30">
<title>SOL/USDC LP Bot - Live Wallet</title>
<style>${SHARED_STYLES}
.wallet-addr{font-size:11px;color:#58a6ff;text-decoration:none}
.wallet-addr:hover{text-decoration:underline}
.event-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:8px}
.event-header{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.event-meta{font-size:11px;color:#8b949e}
.event-desc{font-size:12px;color:#c9d1d9;line-height:1.5;margin-bottom:4px}
.event-balances{font-size:11px;color:#8b949e;border-top:1px solid #21262d;padding-top:6px;margin-top:6px}
.ctrl-btn{border:none;padding:12px 24px;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;font-family:inherit;width:100%;transition:all 0.2s;-webkit-tap-highlight-color:transparent}
.ctrl-btn:disabled{background:#555!important;cursor:not-allowed;color:#888!important}
.ctrl-red{background:#dc2626;color:white}.ctrl-red:hover{background:#b91c1c}
.ctrl-amber{background:#d97706;color:white}.ctrl-amber:hover{background:#b45309}
.ctrl-green{background:#16a34a;color:white}.ctrl-green:hover{background:#15803d}
.ctrl-blue{background:#2563eb;color:white}.ctrl-blue:hover{background:#1d4ed8}
.stop-confirm{display:none;background:#1c1917;border:2px solid #dc2626;border-radius:8px;padding:16px;margin-top:12px;text-align:center}
.ctrl-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.fees-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.fees-cell{text-align:center;padding:12px 0}
.fees-cell:not(:last-child){border-right:1px solid #21262d}
.il-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.il-cell{text-align:center;padding:8px 0}
.wallet-split{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:12px;border-top:1px solid #21262d;padding-top:12px}
.wallet-half{text-align:center}
.wallet-half:first-child{border-right:1px solid #21262d}
@media(max-width:700px){
  .ctrl-grid{grid-template-columns:1fr 1fr;gap:8px}
  .ctrl-btn{padding:10px 8px;font-size:11px;min-height:44px}
  .fees-grid{grid-template-columns:1fr}
  .fees-cell{border-right:none!important;border-bottom:1px solid #21262d;padding:10px 0}
  .fees-cell:last-child{border-bottom:none}
  .il-grid{grid-template-columns:1fr}
  .il-cell{border-bottom:1px solid #21262d;padding:10px 0}
  .il-cell:last-child{border-bottom:none}
  .wallet-split{grid-template-columns:1fr}
  .wallet-half{padding:8px 0}
  .wallet-half:first-child{border-right:none;border-bottom:1px solid #21262d}
  .m-stack{grid-template-columns:1fr!important}
  .m-stack-3{grid-template-columns:1fr 1fr!important}
  .m-hide{display:none!important}
  .m-small{font-size:9px!important}
  .m-text-sm{font-size:10px!important}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#ef4444">Live Wallet &mdash; Real Money</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">
    Uptime: ${uptimeStr} | State: <span style="color:${stateCol}">${live.botState}</span> |
    <a href="${solscanUrl}" target="_blank" class="wallet-addr">${shortAddr}</a>
  </div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-live').classList.add('active')</script>

<div class="grid">
  <div class="card full">
    <h2>Total Portfolio Value</h2>
    <div class="big-number">
      <div class="val" style="color:#58a6ff">$${fmt(live.totalValueWithPosition)}</div>
      <div class="sub">Wallet + Liquidity Position</div>
    </div>
    <div class="wallet-split">
      <div class="wallet-half">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Wallet</div>
        <div style="font-size:16px;font-weight:bold">$${fmt(live.totalValueUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.solBalance, 4)} SOL + ${fmt(live.usdcBalance, 2)} USDC</div>
        ${(() => {
          const varEnabled = runtime.varEnabled;
          const sirEnabled = runtime.sirEnabled;
          // VAR deploy or static regime deploy
          const deployPct = varEnabled
            ? Math.max(0.25, Math.min(0.90, 0.95 - (live.marketSignals?.vol1h ?? 0.003) * 5))
            : (runtime.regimeParams[live.regime as keyof typeof runtime.regimeParams] ?? { deployPct: 1.0 }).deployPct;
          const targetIdlePct = (1 - Math.max(0.10, deployPct)) * 100;
          // Read target SOL % from runtime config (updated every 1 min from DB)
          const targetSolPct = Math.round(
            live.regime === 'EXTREME' ? runtime.idleTargetSolPctExtreme * 100 :
            live.regime === 'BEARISH_TREND' ? runtime.idleTargetSolPctBearish * 100 :
            live.regime === 'BULLISH_TREND' ? runtime.idleTargetSolPctBullish * 100 :
            runtime.idleTargetSolPctRanging * 100
          );
          const walletSolVal = live.solBalance * live.solPrice;
          const walletTotal = walletSolVal + live.usdcBalance;
          const walletSolPct = walletTotal > 0 ? (walletSolVal / walletTotal * 100) : 0;
          const walletUsdcPct = walletTotal > 0 ? (live.usdcBalance / walletTotal * 100) : 0;
          const walletPctOfTotal = live.totalValueWithPosition > 0 ? (walletTotal / live.totalValueWithPosition * 100) : 0;
          const solDeviation = Math.abs(walletSolPct - targetSolPct);
          const solDeviationCol = solDeviation > 15 ? '#ef4444' : solDeviation > 10 ? '#eab308' : '#22c55e';
          const idleDeviation = Math.abs(walletPctOfTotal - targetIdlePct);
          const idleCol = idleDeviation > 10 ? '#eab308' : '#22c55e';
          return `<div style="font-size:10px;margin-top:4px">
            <span style="color:${idleCol};font-weight:bold">${fmt(walletPctOfTotal, 0)}% of portfolio</span> <span style="color:#8b949e">· Target: ${fmt(targetIdlePct, 0)}% idle ${varEnabled ? '(VAR)' : '(' + live.regime + ')'}</span>
          </div>
          <div style="font-size:10px;margin-top:2px">
            <span style="color:#22c55e;font-weight:bold">${fmt(walletSolPct, 0)}% SOL</span> / <span style="color:#58a6ff;font-weight:bold">${fmt(walletUsdcPct, 0)}% USDC</span> <span style="color:${solDeviationCol}">· Target: ${targetSolPct}% SOL ${sirEnabled ? '(SIR)' : ''}</span>
          </div>`;
        })()}
      </div>
      <div class="wallet-half">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Liquidity Position</div>
        <div style="font-size:16px;font-weight:bold">${live.positionMint ? `$${fmt(live.positionValueUsdc)}` : '--'}</div>
        <div style="font-size:11px;color:#8b949e">${live.positionMint ? `${fmt(live.positionSol, 4)} SOL + ${fmt(live.positionUsdc, 2)} USDC` : 'No position open'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Market</h2>
    <div class="row"><span class="label">SOL Price</span><span class="value">$${fmt(live.solPrice)}</span></div>
    <div class="row"><span class="label">Regime</span><span class="badge" style="background:${regimeCol}20;color:${regimeCol}">${live.regime}</span></div>
    <div class="row"><span class="label">Bot State</span><span class="badge" style="background:${stateCol}20;color:${stateCol}">${live.botState}</span></div>
    <div class="row"><span class="label">Proximity Exit</span><span id="rule2-market-badge" class="badge" style="background:${rule2Enabled ? '#22c55e20' : '#f9731620'};color:${rule2Enabled ? '#22c55e' : '#f97316'}">${rule2Enabled ? 'ACTIVE' : 'BYPASSED'}</span></div>
    <div class="row"><span class="label">Auto Deploy</span><span id="autodeploy-market-badge" class="badge" style="background:${autoDeployEnabled ? '#22c55e20' : '#f9731620'};color:${autoDeployEnabled ? '#22c55e' : '#f97316'}">${autoDeployEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
  </div>

  <div class="card">
    <h2>Position Details</h2>
    <div class="row"><span class="label">Status</span><span class="value">${live.positionMint ? 'OPEN' : 'NONE'}</span></div>
    ${live.positionMint ? `
    <div class="row"><span class="label">SOL in Position</span><span class="value">${fmt(live.positionSol, 6)} <span style="color:#8b949e;font-weight:normal">($${fmt(live.positionSol * live.solPrice)})</span></span></div>
    <div class="row"><span class="label">USDC in Position</span><span class="value">${fmt(live.positionUsdc, 6)}</span></div>
    <div class="row"><span class="label">Position Value</span><span class="value" style="color:#58a6ff">$${fmt(live.positionValueUsdc)}</span></div>
    <div class="row"><span class="label">Entry Price</span><span class="value">$${fmt(live.entryPrice ?? 0)}</span></div>
    ${(() => {
      if (!live.positionRange) return '';
      const lo = live.positionRange.lower, hi = live.positionRange.upper;
      const w = hi - lo, c = (lo + hi) / 2, hw = w / 2;
      const rk = live.regime ?? 'RANGING';
      const rp = runtime.regimeParams[rk] ?? runtime.regimeParams.RANGING;
      const thL = rp.proxThresholdLower, thU = rp.proxThresholdUpper;
      const trigLo = c - thL * hw, trigHi = c + thU * hw;
      return `<div class="row"><span class="label">Range Width</span><span class="value">${fmt(w / c * 100, 2)}% ($${fmt(w)})</span></div>
      <div class="row"><span class="label">↓ Exit Trigger</span><span class="value" style="color:#ef4444">${Math.round(thL * 100)}% → $${fmt(trigLo)} <span style="font-size:10px;font-weight:normal;color:#8b949e">($${fmt(live.solPrice - trigLo, 2)} away)</span></span></div>
      <div class="row"><span class="label">↑ Exit Trigger</span><span class="value" style="color:#eab308">${Math.round(thU * 100)}% → $${fmt(trigHi)} <span style="font-size:10px;font-weight:normal;color:#8b949e">($${fmt(trigHi - live.solPrice, 2)} away)</span></span></div>`;
    })()}
    <div class="row"><span class="label">Fees Today</span><span class="value" style="color:#22c55e">$${fmt(live.actual24hFeesUsdc, 4)}</span></div>
    <div class="row"><span class="label">Today's APR</span><span class="value" style="color:#22c55e">${fmt(live.actual24hAprPct, 1)}%</span></div>
    <div class="row"><span class="label">Est. Max Yield 24h</span><span class="value" style="color:#8b949e">$${fmt(live.estDailyFeesUsdc, 4)} <span style="font-size:10px;font-weight:normal">(ceiling)</span></span></div>
    <div class="row"><span class="label">Est. Max APR</span><span class="value" style="color:#8b949e">${fmt(live.estAprPct, 1)}% <span style="font-size:10px;font-weight:normal">(ceiling)</span></span></div>
    ${(() => {
      const idleSol = Math.max(0, live.solBalance - runtime.solReserve);
      const idleUsdcRaw = Math.max(0, live.usdcBalance - runtime.usdcReserve);
      const idleUsdc = idleSol * live.solPrice + idleUsdcRaw;
      const idealPrice = live.positionRange ? Math.sqrt(live.positionRange.lower * live.positionRange.upper).toFixed(2) : '--';
      const deviation = live.positionRange ? Math.abs(live.solPrice / Math.sqrt(live.positionRange.lower * live.positionRange.upper) - 1) * 100 : 0;
      return `<div class="row"><span class="label">Idle Capital</span><span class="value" style="color:${idleUsdc > 10 ? '#eab308' : '#8b949e'}">$${fmt(idleUsdc)}</span></div>
    <div class="row"><span class="label">Ideal Deploy Price</span><span class="value">$${idealPrice} <span style="color:#8b949e;font-weight:normal">(${deviation.toFixed(1)}% off)</span></span></div>`;
    })()}
    ` : ''}
  </div>

  <div class="card full">
    <h2>Fees, IL &amp; PnL</h2>
    <div class="fees-grid">
      <div class="fees-cell">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Pending Fees</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.pendingFeesTotal)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.pendingFeesSol, 6)} SOL</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.pendingFeesUsdc, 4)} USDC</div>
        ${(() => {
          if (!live.entryTime || live.pendingFeesTotal <= 0) return '';
          const ageH = (Date.now() - live.entryTime) / 3_600_000;
          if (ageH < 0.05) return '<div style="font-size:12px;color:#8b949e;margin-top:4px">building...</div>';
          const fph = live.pendingFeesTotal / ageH;
          return '<div id="fee-rate-el" style="font-size:13px;font-weight:bold;margin-top:6px" data-rate="' + fph.toFixed(4) + '"><span style="color:#58a6ff">$' + fph.toFixed(2) + '/h</span> <span id="fee-trend"></span></div>' +
            '<script>(function(){var el=document.getElementById("fee-trend");var rate=parseFloat(document.getElementById("fee-rate-el").dataset.rate);var prev=parseFloat(localStorage.getItem("feeRate")||"0");if(prev>0&&rate>0){if(rate>prev*1.03){el.textContent="▲";el.style.color="#22c55e";}else if(rate<prev*0.97){el.textContent="▼";el.style.color="#ef4444";}else{el.textContent="▶";el.style.color="#8b949e";}}localStorage.setItem("feeRate",rate.toString());})()</script>';
        })()}
      </div>
      <div class="fees-cell">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Harvested Fees</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.cumHarvestedFeesSol * live.solPrice + live.cumHarvestedFeesUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.cumHarvestedFeesSol, 6)} SOL</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.cumHarvestedFeesUsdc, 4)} USDC</div>
      </div>
      <div class="fees-cell" style="border-right:none">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Total Fees Earned</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.totalFeesUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">Pending + Harvested</div>
      </div>
    </div>
    <div style="border-top:1px solid #21262d;margin-top:8px;padding-top:12px">
      <div class="il-grid">
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Potential IL (unrealized)</div>
          <div style="font-size:20px;font-weight:bold;color:${live.ilUsdc < 0 ? '#ef4444' : '#22c55e'}">${live.ilUsdc < 0 ? '-' : '+'}$${fmt(Math.abs(live.ilUsdc), 4)}</div>
          <div style="font-size:11px;color:#8b949e">${live.entryPrice ? `Entry $${fmt(live.entryPrice)} → $${fmt(live.solPrice)} (${((live.solPrice - live.entryPrice) / live.entryPrice * 100).toFixed(2)}%)` : '--'}</div>
        </div>
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Realized IL (from closes)</div>
          <div style="font-size:20px;font-weight:bold;color:${live.realizedIlUsdc < 0 ? '#ef4444' : '#22c55e'}">${live.realizedIlUsdc < 0 ? '-' : '+'}$${fmt(Math.abs(live.realizedIlUsdc), 4)}</div>
          <div style="font-size:11px;color:#8b949e">Cumulative from closed positions</div>
        </div>
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Gas Fees (on-chain)</div>
          <div style="font-size:20px;font-weight:bold;color:#ef4444">-$${fmt(live.gasUsdc, 4)}</div>
          <div style="font-size:11px;color:#8b949e">${fmt(live.gasSol, 6)} SOL (${live.txCount} txs)</div>
        </div>
      </div>
    </div>
    <div style="border-top:1px solid #21262d;margin-top:8px;padding-top:12px;text-align:center">
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Net PnL (Fees - IL - Gas)</div>
      ${(() => { const totalIl = live.ilUsdc + live.realizedIlUsdc; const net = live.totalFeesUsdc + totalIl - live.gasUsdc; return `<div style="font-size:24px;font-weight:bold;color:${net >= 0 ? '#22c55e' : '#ef4444'}">${net >= 0 ? '+' : '-'}$${fmt(Math.abs(net))}</div><div style="font-size:11px;color:#8b949e">${net >= 0 ? 'Profitable' : 'Underwater'} | Fees $${fmt(live.totalFeesUsdc)} - IL $${fmt(Math.abs(totalIl))} - Gas $${fmt(live.gasUsdc, 4)}</div>`; })()}
    </div>
  </div>

  <div class="card full">
    <h2>Position Range</h2>
    ${rangeBarHtml}
    ${live.positionMint ? `<div style="font-size:11px;color:#8b949e;margin-top:8px">Position: <a href="https://solscan.io/token/${live.positionMint}" target="_blank" class="wallet-addr">${live.positionMint.slice(0, 12)}...</a> | Liquidity: ${live.positionLiquidity || '--'}${live.positionRegime ? ` | Opened as <span style="color:${regimeColours[live.positionRegime] || '#888'};font-weight:bold">${live.positionRegime}</span>` : ''}</div>` : ''}
    ${live.churnGuardLastExitPrice != null ? (() => {
      const active = live.churnGuardActive;
      const color = active ? '#eab308' : '#22c55e';
      const label = active ? 'ACTIVE' : 'CLEAR';
      const detail = active && live.churnGuardReason ? ` — ${live.churnGuardReason}${live.churnGuardExpiresMin != null ? `, expires in ${Math.max(0, live.churnGuardExpiresMin).toFixed(0)}min` : ''}` : '';
      return `<div style="font-size:11px;margin-top:6px;padding:4px 8px;background:#0d1117;border:1px solid ${color};border-radius:4px"><span style="color:#8b949e">ChurnGuard: </span><span style="color:${color};font-weight:bold">${label}</span><span style="color:#8b949e">${detail}</span></div>`;
    })() : ''}
  </div>

  <div class="card full">
    <h2>Price Triggers</h2>
    <div id="price-triggers"><div style="color:#8b949e;font-size:11px">Loading...</div></div>
  </div>
  <script>
  (function(){
    function loadTriggers(){
      fetch('/api/price-triggers').then(function(r){return r.json()}).then(function(d){
        var c=document.getElementById('price-triggers');
        if(!c||!d||!d.triggers){if(c)c.innerHTML='<div style="color:#8b949e;font-size:11px">No data</div>';return;}
        var h='<div style="font-size:11px;color:#8b949e;margin-bottom:8px">Current price: <b style="color:#c9d1d9">$'+d.currentPrice.toFixed(2)+'</b></div>';
        d.triggers.forEach(function(t){
          var isBelow=t.direction==='below';
          var noteStr=t.note?(' <span style="padding:1px 5px;border-radius:3px;font-size:9px;font-weight:bold;background:'+t.color+'20;color:'+t.color+'">'+t.note+'</span>'):'';
          var distStr=t.note?'':' <span style="color:'+(isBelow?(t.distanceAbs<0.50?'#ef4444':t.distanceAbs<1.00?'#eab308':'#22c55e'):'#8b949e')+';font-size:10px">('+(t.distance>=0?'+$':'-$')+t.distanceAbs.toFixed(2)+')</span>';
          var arrow=isBelow?'▼':'▲';
          h+='<div style="margin-bottom:6px">';
          h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">';
          h+='<span style="font-size:11px;color:'+t.color+'">'+arrow+' '+t.label+noteStr+'</span>';
          h+='<span style="font-size:11px"><b style="color:#c9d1d9">$'+t.triggerPrice.toFixed(2)+'</b>'+distStr+'</span>';
          h+='</div>';
          h+='<div style="background:#21262d;height:8px;border-radius:4px;overflow:hidden">';
          h+='<div style="width:'+Math.min(100,t.pctFilled)+'%;height:100%;background:'+t.color+';border-radius:4px;transition:width 0.5s"></div>';
          h+='</div>';
          if(t.subNote){h+='<div style="font-size:9px;color:'+t.color+';text-align:right;margin-top:1px">'+t.subNote+'</div>';}
          h+='</div>';
        });
        if(d.closestTrigger){
          var ct=d.closestTrigger;
          var ctCol=ct.distance<0&&Math.abs(ct.distance)<0.50?'#ef4444':ct.distance<0&&Math.abs(ct.distance)<1.00?'#eab308':'#8b949e';
          h+='<div style="font-size:10px;color:'+ctCol+';margin-top:8px;text-align:center">Closest: <b>'+ct.label+'</b> at $'+ct.price.toFixed(2)+' ('+(ct.distance>=0?'+':'')+ct.distance.toFixed(2)+')</div>';
        }
        c.innerHTML=h;
      }).catch(function(){});
    }
    loadTriggers();setInterval(loadTriggers,30000);
  })();
  </script>

  <div class="card full">
    <h2>Regime Intelligence</h2>
    <div id="regime-intel"><div style="color:#8b949e;font-size:11px">Loading...</div></div>
  </div>
  <script>
  (function(){
    var RC={BULLISH_TREND:'#22c55e',BEARISH_TREND:'#ef4444',RANGING:'#4a9eff',EXTREME:'#a855f7'};
    var TZ='Europe/Berlin';
    function loadRI(){
      fetch('/api/regime-intelligence').then(function(r){return r.json()}).then(function(d){
        var c=document.getElementById('regime-intel');
        if(!c||!d||!d.regime){if(c)c.innerHTML='<div style="color:#8b949e;font-size:11px">No data yet</div>';return;}
        var col=RC[d.regime]||'#888';
        var confCol=d.confidence==='HIGH'?'#22c55e':d.confidence==='MEDIUM'?'#eab308':'#ef4444';
        // Header
        var h='<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:8px">';
        h+='<div><span class="badge" style="background:'+col+'20;color:'+col+'">'+d.regime+'</span>';
        h+=' <span style="color:'+confCol+';font-size:11px;font-weight:bold">'+d.confidence+'</span>';
        h+=' <span style="color:#8b949e;font-size:10px">Score: '+(d.ta_total_score||'?')+'/7</span></div>';
        h+='<span style="color:#8b949e;font-size:10px">'+(d.ta_data_age_min||0)+'min ago</span></div>';
        // TA Voting table
        var sigs=[
          {n:'EMA Cross',v:(d.ema_cross||'?')+' ('+(d.emaGapPct>0?'+':'')+d.emaGapPct.toFixed(1)+'%)',vote:d.ema_cross==='UP'?'BULLISH':d.ema_cross==='DOWN'?'BEARISH':'RANGING',pts:2},
          {n:'BB Width',v:(d.bb_width||0).toFixed(1)+'%',vote:d.bb_width>3?'EXTREME':d.bb_width<1.5?'RANGING':'RANGING',pts:2},
          {n:'RSI(14)',v:(d.rsi||0).toFixed(0),vote:d.rsi<30?'BEARISH':d.rsi>70?'BULLISH':'RANGING',pts:1},
          {n:'ATR(14)',v:'$'+(d.atr||0).toFixed(2),vote:d.atr>0.5?'trend':'normal',pts:1},
          {n:'BB Pos',v:(d.bb_position||0).toFixed(2),vote:'modifier',pts:d.bb_position<0.2?-1:d.bb_position>0.8?-1:0}
        ];
        var t='<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:11px">';
        t+='<thead><tr><th style="text-align:left;padding:3px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Signal</th>';
        t+='<th style="text-align:right;padding:3px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Value</th>';
        t+='<th style="text-align:left;padding:3px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Vote</th>';
        t+='<th class="m-hide" style="text-align:left;padding:3px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Pts</th></tr></thead><tbody>';
        sigs.forEach(function(s){
          var vc=RC[s.vote]||'#8b949e';
          var bar=s.pts>0?Array(s.pts+1).join('\\u2588'):s.pts<0?'\\u25BC':'\\u2013';
          t+='<tr style="border-bottom:1px solid #21262d"><td style="padding:3px 4px;color:#c9d1d9">'+s.n+'</td>';
          t+='<td style="padding:3px 4px;text-align:right;font-family:monospace;color:#c9d1d9">'+s.v+'</td>';
          t+='<td style="padding:3px 4px"><span style="padding:1px 6px;border-radius:3px;font-size:9px;background:'+vc+'20;color:'+vc+'">'+s.vote+'</span></td>';
          t+='<td class="m-hide" style="padding:3px 4px;color:'+vc+'">'+bar+'</td></tr>';
        });
        t+='</tbody></table></div>';
        // Score summary
        var sc='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin:8px 0;font-size:10px;text-align:center">';
        [{k:'B',v:d.ta_score_bullish,r:'BULLISH_TREND'},{k:'R',v:d.ta_score_ranging,r:'RANGING'},{k:'Be',v:d.ta_score_bearish,r:'BEARISH_TREND'},{k:'E',v:d.ta_score_extreme,r:'EXTREME'}].forEach(function(s){
          var isW=d.ta_winner===s.r;
          sc+='<div style="padding:4px;border:1px solid '+(isW?RC[s.r]||'#888':'#30363d')+';border-radius:4px;background:'+(isW?(RC[s.r]||'#888')+'15':'transparent')+'"><span style="color:#8b949e">'+s.k+':</span> <span style="color:#c9d1d9;font-weight:bold">'+(s.v!=null?s.v:'?')+'</span></div>';
        });
        sc+='</div>';
        // Market signals
        var mk='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin:6px 0;font-size:10px">';
        var v1h=d.vol_1h;var sol4=d.sol_change_4h;var fg=d.fear_greed;var btc=d.btc_change_4h;
        mk+='<div style="text-align:center;padding:3px;border:1px solid #21262d;border-radius:4px"><span style="color:#8b949e">Vol 1h</span><br><span style="color:'+(v1h>0.06?'#ef4444':v1h>0.04?'#eab308':'#22c55e')+'">'+(v1h!=null?(v1h*100).toFixed(1)+'%':'?')+'</span></div>';
        mk+='<div style="text-align:center;padding:3px;border:1px solid #21262d;border-radius:4px"><span style="color:#8b949e">SOL 24h</span><br><span style="color:'+(sol4<-4?'#ef4444':sol4>4?'#22c55e':'#c9d1d9')+'">'+(sol4!=null?(sol4>0?'+':'')+sol4.toFixed(1)+'%':'?')+'</span></div>';
        mk+='<div style="text-align:center;padding:3px;border:1px solid #21262d;border-radius:4px"><span style="color:#8b949e">F&G</span><br><span style="color:'+(fg<25?'#ef4444':fg>75?'#22c55e':'#c9d1d9')+'">'+(fg!=null?fg:'?')+'</span></div>';
        mk+='<div style="text-align:center;padding:3px;border:1px solid #21262d;border-radius:4px"><span style="color:#8b949e">BTC 24h</span><br><span style="color:'+(btc!=null&&Math.abs(btc)>3?'#eab308':'#c9d1d9')+'">'+(btc!=null?(btc>0?'+':'')+btc.toFixed(1)+'%':'?')+'</span></div>';
        mk+='</div>';
        // Veto + deploy
        var veto='<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;margin:6px 0;font-size:10px">';
        veto+='<span style="color:#8b949e">L1 Veto: <span style="color:'+(d.veto_fired?'#ef4444':'#22c55e')+';font-weight:bold">'+(d.veto_fired?'FIRED':'CLEAR')+'</span>'+(d.daily_regime?' (daily: '+d.daily_regime+')':'')+'</span>';
        veto+='<span style="color:#8b949e">Deploy: <span style="color:#c9d1d9;font-weight:bold">'+d.effectiveDeployPct+'%</span> ('+d.deployPct+'% x '+Math.round(d.confidenceMultiplier*100)+'%)</span>';
        veto+='</div>';
        // AI Summary
        var parts=[];
        if(d.ema_cross==='DOWN')parts.push('EMA9 is '+Math.abs(d.emaGapPct).toFixed(1)+'% below SMA20 confirming downward momentum');
        else if(d.ema_cross==='UP')parts.push('EMA9 is '+d.emaGapPct.toFixed(1)+'% above SMA20 confirming upward momentum');
        else parts.push('EMA9 and SMA20 are flat — no clear trend direction');
        var rsi=d.rsi||50;
        if(rsi<25)parts.push('RSI at '+rsi.toFixed(0)+' is deeply oversold — bounce likely');
        else if(rsi>75)parts.push('RSI at '+rsi.toFixed(0)+' is overbought — pullback likely');
        else if(rsi<40)parts.push('RSI at '+rsi.toFixed(0)+' shows bearish momentum');
        else if(rsi>60)parts.push('RSI at '+rsi.toFixed(0)+' shows bullish momentum');
        else parts.push('RSI at '+rsi.toFixed(0)+' is neutral');
        var bb=d.bb_width||2;
        if(bb>3)parts.push('BB width at '+bb.toFixed(1)+'% indicates high volatility');
        else if(bb<1.5)parts.push('BB width at '+bb.toFixed(1)+'% is squeezed — breakout imminent');
        else parts.push('BB width at '+bb.toFixed(1)+'% is normal');
        if(d.veto_fired)parts.push('L1 daily veto fired — confidence reduced');
        parts.push('Bot deploying at '+d.effectiveDeployPct+'% capacity');
        var summary='<div style="margin-top:8px;padding:8px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-size:11px;color:#8b949e;line-height:1.5">'+parts.join('. ')+'.</div>';
        c.innerHTML=h+t+sc+mk+veto+summary;
      }).catch(function(){});
    }
    loadRI();setInterval(loadRI,120000);
  })();
  </script>

  ${live.solCostBasis > 0 ? (() => {
    const basis = live.solCostBasis;
    const price = live.solPrice;
    const walletSol = live.solBalance;
    const trackedSol = live.solTracked ?? 0;
    const lpSol = live.entrySol ?? 0;
    const totalSolHeld = walletSol + lpSol;
    const lastUpdated = live.costBasisLastUpdated ?? 0;
    const unrealisedPnl = (price - basis) * totalSolHeld;
    const unrealisedPnlPct = basis > 0 ? ((price - basis) / basis) * 100 : 0;
    const pnlSign = unrealisedPnl >= 0 ? '+' : '';
    const pnlColor = unrealisedPnl >= 0 ? '#22c55e' : '#ef4444';
    const aboveBasis5Pct = price > basis * 1.05;
    const belowBasis = price < basis;
    const borderColor = belowBasis ? '#ef4444' : aboveBasis5Pct ? '#22c55e' : '#30363d';
    const lastUpdatedStr = lastUpdated > 0
      ? new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' })
      : '—';
    return `<div class="card full" style="border-color:${borderColor}">
      <h2>Cost Basis</h2>
      <div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px">
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Basis</span>
          <span style="color:#c9d1d9;font-weight:bold">$${fmt(basis)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Price</span>
          <span style="color:#c9d1d9;font-weight:bold">$${fmt(price)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Wallet SOL</span>
          <span style="color:#c9d1d9">${fmt(walletSol, 2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">LP SOL (est)</span>
          <span style="color:#c9d1d9">${fmt(lpSol, 2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Total SOL held</span>
          <span style="color:#c9d1d9;font-weight:bold">${fmt(totalSolHeld, 2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Tracked</span>
          <span style="color:#c9d1d9">${fmt(trackedSol, 2)} SOL</span>
        </div>
        ${totalSolHeld > 0 ? (() => {
          const trackingRatio = trackedSol / totalSolHeld;
          if (trackingRatio <= 1.05) return `<div style="font-size:10px;color:#22c55e;text-align:right">tracking accurate</div>`;
          if (trackingRatio <= 2.0) return `<div style="font-size:10px;color:#eab308;text-align:right">tracked ${fmt(trackedSol, 1)} vs held ${fmt(totalSolHeld, 1)} SOL</div>`;
          return `<div style="font-size:10px;color:#ef4444;text-align:right">tracking diverged — will reset on restart</div>`;
        })() : ''}
      </div>
      <div style="margin-top:8px;padding:8px;background:#0d1117;border:1px solid ${borderColor};border-radius:6px;text-align:center">
        <div style="font-size:10px;color:#8b949e;margin-bottom:2px">Unrealised P&amp;L</div>
        <div style="font-size:16px;font-weight:bold;color:${pnlColor}">${pnlSign}$${fmt(Math.abs(unrealisedPnl))} <span style="font-size:12px">(${pnlSign}${unrealisedPnlPct.toFixed(1)}%)</span></div>
      </div>
      ${belowBasis ? `<div style="color:#ef4444;font-size:11px;font-weight:bold;margin-top:6px;text-align:center">Price below basis — do not swap</div>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px">
        <span style="color:#8b949e">Updated</span>
        <span style="color:#8b949e">${lastUpdatedStr} CET</span>
      </div>
    </div>`;
  })() : ''}

  ${(() => {
    const resCurrent = live.reserveCurrent ?? 0;
    const resFloor = live.reserveFloor ?? 0;
    const resState = live.reserveState ?? 'EMPTY';
    const deficit = Math.max(0, resFloor - resCurrent);
    const refillPct = resFloor > 0 ? Math.min(100, (resCurrent / resFloor) * 100) : 0;
    const walletUsdc = live.usdcBalance ?? 0;
    const aboveFloor = walletUsdc - resFloor;
    const stateColor = resState === 'FULL' ? '#22c55e' : resState === 'REFILLING' ? '#eab308' : '#ef4444';
    const stateBg = resState === 'FULL' ? 'rgba(34,197,94,0.15)' : resState === 'REFILLING' ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)';
    const barColor = resState === 'FULL' ? '#22c55e' : resState === 'REFILLING' ? '#eab308' : '#ef4444';
    const borderColor = resState === 'FULL' ? '#22c55e' : resState === 'REFILLING' ? '#eab308' : '#ef4444';
    const aboveFloorColor = aboveFloor >= 0 ? '#22c55e' : '#ef4444';
    const aboveFloorSign = aboveFloor >= 0 ? '+' : '-';
    const aboveFloorLabel = aboveFloor >= 0 ? 'Above floor' : 'Below floor';
    const lastUpdatedStr = live.reserveLastUpdated > 0
      ? new Date(live.reserveLastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' })
      : '—';
    return `<div class="card full" style="border-color:${borderColor}">
      <h2>Reserve Monitor</h2>
      <div class="m-stack-3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 12px;font-size:12px;margin-bottom:8px">
        <div style="text-align:center">
          <div style="color:#8b949e;font-size:10px">Reserve</div>
          <div style="color:#c9d1d9;font-weight:bold">$${fmt(resCurrent)}</div>
        </div>
        <div style="text-align:center">
          <div style="color:#8b949e;font-size:10px">Floor</div>
          <div style="color:#c9d1d9;font-weight:bold">$${fmt(resFloor, 0)}</div>
        </div>
        <div style="text-align:center">
          <div style="color:#8b949e;font-size:10px">State</div>
          <div style="display:inline-block;padding:1px 8px;border-radius:4px;font-size:11px;font-weight:bold;color:${stateColor};background:${stateBg}">${resState}</div>
        </div>
      </div>
      <div style="background:#21262d;border-radius:4px;height:16px;overflow:hidden;position:relative;margin-bottom:4px">
        <div style="background:${barColor};height:100%;width:${refillPct.toFixed(1)}%;border-radius:4px;transition:width 0.3s"></div>
        <div style="position:absolute;top:0;left:0;right:0;text-align:center;font-size:10px;line-height:16px;color:#c9d1d9">$${fmt(resCurrent, 0)} of $${fmt(resFloor, 0)} (${refillPct.toFixed(1)}%)</div>
      </div>
      <div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px;margin-top:8px">
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">Wallet USDC</span>
          <span style="color:#c9d1d9">$${fmt(walletUsdc, 0)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8b949e">${aboveFloorLabel}</span>
          <span style="color:${aboveFloorColor};font-weight:bold">${aboveFloorSign}$${fmt(Math.abs(aboveFloor), 0)}</span>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px">
        <span style="color:#8b949e">Updated</span>
        <span style="color:#8b949e">${lastUpdatedStr} CET</span>
      </div>
    </div>`;
  })()}

  <div class="card full">
    <h2>Swap History</h2>
    <div id="live-swaps"><div style="color:#8b949e;font-size:11px">Loading...</div></div>
  </div>
  <script>
  (function(){
    var TZ='Europe/Berlin';
    function loadSwaps(){
    Promise.all([fetch('/api/swap-ledger').then(function(r){return r.json();}),fetch('/api/live').then(function(r){return r.json();}).catch(function(){return null;})]).then(function(results){
      var data=results[0];var live=results[1];
      var c=document.getElementById('live-swaps');
      if(!c||!data.swaps||data.swaps.length===0){if(c)c.innerHTML='<div style="color:#8b949e;font-size:11px">No swaps yet</div>';return;}
      var swaps=data.swaps.slice(0,50);
      var html='<div style="overflow-x:auto;max-height:500px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">';
      html+='<thead style="position:sticky;top:0;background:#161b22;z-index:1"><tr>';
      html+='<th style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Time</th>';
      html+='<th style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Dir</th>';
      html+='<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">SOL</th>';
      html+='<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">USDC</th>';
      html+='<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Price</th>';
      html+='<th class="m-hide" style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Basis</th>';
      html+='<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">P&L</th>';
      html+='<th class="m-hide" style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Reason</th>';
      html+='<th class="m-hide" style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">Src</th>';
      html+='<th class="m-hide" style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">TX</th>';
      html+='</tr></thead><tbody>';
      var totalPnl=0,totalSolBuy=0,totalSolSell=0,totalUsdcIn=0,totalUsdcOut=0;
      swaps.forEach(function(sw,i){
        var t=new Date(sw.timestamp).toLocaleString('en-GB',{timeZone:TZ,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
        var isBuy=sw.direction==='buy_sol';
        var isHarvest=(sw.reason||'').indexOf('Harvest')>=0;
        var reason=(sw.reason||'').slice(0,25);
        var pnl=sw.pnl_usdc||0;
        totalPnl+=pnl;
        if(isBuy){totalSolBuy+=sw.sol_amount;totalUsdcOut+=sw.usdc_amount;}else{totalSolSell+=sw.sol_amount;totalUsdcIn+=sw.usdc_amount;}
        var pnlCol=pnl>=0?'#22c55e':'#ef4444';
        var dirCol=isHarvest?'#58a6ff':(isBuy?'#22c55e':'#ef4444');
        var dirLabel=isHarvest?'HARVEST':(isBuy?'BUY':'SELL');
        var swPrice=sw.price||0;
        var bBefore=sw.cost_basis_before||0;
        var bAfter=sw.cost_basis_after||0;
        var basisStr=bAfter>0?'$'+bAfter.toFixed(2):'—';
        if(bBefore>0&&bAfter>0&&Math.abs(bAfter-bBefore)>0.005)basisStr='$'+bBefore.toFixed(2)+' → $'+bAfter.toFixed(2);
        var src=sw.source||'bot';
        var srcCol=src==='manual'?'#484f58':'#22c55e';
        var srcBg=src==='manual'?'#484f5820':'#22c55e15';
        var txStr=sw.tx_signature?'<a href="https://solscan.io/tx/'+sw.tx_signature+'" target="_blank" style="color:#58a6ff;text-decoration:none">'+sw.tx_signature.slice(0,8)+'</a>':(src==='bot'?'<span style="color:#eab308">no sig</span>':'<span style="color:#484f58">—</span>');
        var rowBg=i%2===0?'':'background:#0d1117;';
        html+='<tr style="border-bottom:1px solid #21262d;'+rowBg+'">';
        html+='<td style="padding:3px 4px;font-size:10px;color:#8b949e;white-space:nowrap">'+t+'</td>';
        html+='<td style="padding:3px 4px;font-size:10px;color:'+dirCol+';font-weight:bold">'+dirLabel+'</td>';
        html+='<td style="padding:3px 4px;text-align:right;font-family:monospace">'+sw.sol_amount.toFixed(3)+'</td>';
        html+='<td style="padding:3px 4px;text-align:right;font-family:monospace">$'+sw.usdc_amount.toFixed(2)+'</td>';
        html+='<td style="padding:3px 4px;text-align:right;font-family:monospace;color:#c9d1d9">'+(swPrice>0?'$'+swPrice.toFixed(2):'—')+'</td>';
        html+='<td class="m-hide" style="padding:3px 4px;text-align:right;font-family:monospace;color:#58a6ff;font-size:10px">'+basisStr+'</td>';
        html+='<td style="padding:3px 4px;text-align:right;color:'+pnlCol+';font-weight:bold">'+(pnl!==0?(pnl>0?'+':'')+pnl.toFixed(2):'—')+'</td>';
        html+='<td class="m-hide" style="padding:3px 4px;font-size:10px;color:#8b949e;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(sw.reason||'')+'">'+reason+'</td>';
        html+='<td class="m-hide" style="padding:3px 4px;font-size:10px"><span style="padding:1px 4px;border-radius:3px;background:'+srcBg+';color:'+srcCol+';font-size:9px">'+src+'</span></td>';
        html+='<td class="m-hide" style="padding:3px 4px;font-size:10px">'+txStr+'</td>';
        html+='</tr>';
      });
      html+='</tbody><tfoot><tr style="border-top:2px solid #30363d;font-weight:bold">';
      html+='<td style="padding:4px;color:#c9d1d9" colspan="2">Total ('+swaps.length+' swaps)</td>';
      html+='<td style="padding:4px;text-align:right;font-family:monospace;color:#c9d1d9">B:'+totalSolBuy.toFixed(1)+' S:'+totalSolSell.toFixed(1)+'</td>';
      html+='<td style="padding:4px;text-align:right;font-family:monospace;color:#c9d1d9">In:$'+totalUsdcIn.toFixed(0)+' Out:$'+totalUsdcOut.toFixed(0)+'</td>';
      html+='<td colspan="2"></td>';
      var netCol=totalPnl>=0?'#22c55e':'#ef4444';
      html+='<td style="padding:4px;text-align:right;font-size:14px;color:'+netCol+'">'+(totalPnl>=0?'+':'')+totalPnl.toFixed(2)+'</td>';
      html+='<td class="m-hide"></td><td class="m-hide"></td><td class="m-hide"></td><td class="m-hide"></td></tr></tfoot></table></div>';
      html+='<div style="font-size:10px;color:#484f58;margin-top:4px">Updated: '+new Date().toLocaleTimeString('en-US',{timeZone:TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' CET</div>';
      c.innerHTML=html;
    });
    }
    loadSwaps();
    setInterval(loadSwaps,30000);
  })();
  </script>

  ${pool ? `<div class="card full">
    <h2>SOL/USDC Pool <span style="font-size:10px;color:#8b949e;font-weight:normal;text-transform:none;letter-spacing:0">(Orca Whirlpool &middot; tick ${pool.tickSpacing} &middot; ${(pool.feeRate / 10000).toFixed(2)}% fee)</span></h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#58a6ff">$${fmt(pool.tvlUsdc, 0)}</div>
        <div style="font-size:10px;color:#8b949e">TVL</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#22c55e">$${fmt(pool.volume24h, 0)}</div>
        <div style="font-size:10px;color:#8b949e">Volume 24h</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#eab308">${fmt(pool.yield24h * 365 * 100, 1)}%</div>
        <div style="font-size:10px;color:#8b949e">APR (24h)</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d"></th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">24h</th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">7d</th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">30d</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Volume</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume24h, 0)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume7d, 0)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume30d, 0)}</td>
        </tr>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Fees</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees24h)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees7d)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees30d)}</td>
        </tr>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Yield / TVL</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield24h * 100, 4)}%</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield7d * 100, 4)}%</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield30d * 100, 3)}%</td>
        </tr>
        <tr>
          <td style="padding:6px 8px;color:#8b949e">APR</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield24h * 365 * 100, 1)}%</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield7d * (365/7) * 100, 1)}%</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield30d * (365/30) * 100, 1)}%</td>
        </tr>
      </tbody>
    </table>
    <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#8b949e;flex-wrap:wrap">
      <span>Pool SOL: ${fmt(pool.tokenBalanceA, 2)}</span>
      <span>Pool USDC: ${fmt(pool.tokenBalanceB, 0)}</span>
      <span>Price 24h: <span style="color:${pool.priceDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.priceDelta24h >= 0 ? '+' : ''}${fmt(pool.priceDelta24h * 100, 2)}%</span></span>
      <span>Vol 24h: <span style="color:${pool.volumeDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.volumeDelta24h >= 0 ? '+' : ''}${fmt(pool.volumeDelta24h * 100, 1)}%</span> vs prior</span>
    </div>
  </div>` : ''}

  <div class="card full">
    <h2>Bot Controls</h2>
    <div class="ctrl-grid">
      <div>
        <button id="harvest-btn" class="ctrl-btn ctrl-blue" onclick="showConfirmAction('Harvest fees?','Collect all pending fees from the position to your wallet.','harvestFees()')">
          Harvest Fees
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Collect pending fees from position to wallet.</div>
      </div>
      <div>
        <button id="pause-btn" class="ctrl-btn ctrl-amber" onclick="showConfirmAction('Pause bot?','Decision loop will stop. Position stays open and earns fees.','controlBot(\\'pause\\')')">
          Pause Bot
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Stops decision loop. Position stays open.</div>
      </div>
      <div>
        <button id="resume-btn" class="ctrl-btn ctrl-green" onclick="showConfirmAction('Resume bot?','Decision loop will restart. Bot will monitor and rebalance.','controlBot(\\'resume\\')')">
          Resume Bot
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Restarts decision loop and rebalancing.</div>
      </div>
      <div>
        <button id="close-pos-btn" class="ctrl-btn ctrl-amber" onclick="stopAutoRefresh();document.getElementById('close-pos-confirm').style.display='block'">
          Close Position
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Closes position, bot stays running in IDLE.</div>
      </div>
      <div>
        <button id="estop-btn" class="ctrl-btn ctrl-red" onclick="stopAutoRefresh();document.getElementById('stop-confirm').style.display='block'">
          Close &amp; Stop
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Closes position, withdraws all, shuts down.</div>
      </div>
      <div>
        <button id="rule2-btn" class="ctrl-btn ${rule2Enabled ? 'ctrl-amber' : 'ctrl-green'}" onclick="showConfirmAction('${rule2Enabled ? 'Disable' : 'Enable'} Rule 2?','${rule2Enabled ? 'Positions will only close on full OOR (no early proximity exit).' : 'Enable proximity-based early exit to reduce IL.'}','toggleRule2()')">
          ${rule2Enabled ? 'Disable' : 'Enable'} Rule 2
        </button>
        <div style="font-size:10px;margin-top:4px;text-align:center"><span id="rule2-status" style="color:${rule2Enabled ? '#22c55e' : '#f97316'};font-weight:600">${rule2Enabled ? 'ACTIVE' : 'BYPASSED'}</span> <span style="color:#8b949e">— Proximity early exit.</span></div>
      </div>
      <div>
        <button id="add-liq-btn" class="ctrl-btn ctrl-blue" onclick="previewAddLiquidity()" ${live?.positionMint ? '' : 'disabled'}>
          Add Liquidity
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">${live?.positionMint ? 'Add wallet balance to open position.' : 'No open position.'}</div>
      </div>
      <div>
        <button id="autodeploy-btn" class="ctrl-btn ${autoDeployEnabled ? 'ctrl-amber' : 'ctrl-green'}" onclick="showConfirmAction('${autoDeployEnabled ? 'Disable' : 'Enable'} Auto Deploy?','${autoDeployEnabled ? 'Idle wallet funds will NOT be deployed automatically.' : 'Idle funds will be deployed into the position up to the regime cap.'}','toggleAutoDeploy()')">
          ${autoDeployEnabled ? 'Disable' : 'Enable'} Auto Deploy
        </button>
        <div style="font-size:10px;margin-top:4px;text-align:center"><span id="autodeploy-status" style="color:${autoDeployEnabled ? '#22c55e' : '#f97316'};font-weight:600">${autoDeployEnabled ? 'ENABLED' : 'DISABLED'}</span> <span style="color:#8b949e">— Auto capital deployment.</span></div>
      </div>
      <div>
        <button id="solconv-btn" class="ctrl-btn ${solConversionEnabled ? 'ctrl-amber' : 'ctrl-green'}" onclick="showConfirmAction('${solConversionEnabled ? 'Disable' : 'Enable'} SOL Conversion?','${solConversionEnabled ? 'Bot will NOT convert SOL to USDC.' : 'Bot will convert small SOL amounts to USDC when profitable and USDC is needed for deploys.'}','toggleSolConversion()')">
          ${solConversionEnabled ? 'Disable' : 'Enable'} SOL Convert
        </button>
        <div style="font-size:10px;margin-top:4px;text-align:center"><span id="solconv-status" style="color:${solConversionEnabled ? '#22c55e' : '#f97316'};font-weight:600">${solConversionEnabled ? 'ENABLED' : 'DISABLED'}</span> <span style="color:#8b949e">— Profitable SOL→USDC.</span></div>
      </div>
    </div>
    <div id="ctrl-result" style="font-size:12px;text-align:center;min-height:20px"></div>
    <div class="stop-confirm" id="close-pos-confirm">
      <p style="color:#d97706;font-weight:bold;margin-bottom:8px">Close position?</p>
      <p style="color:#8b949e;font-size:12px;margin-bottom:12px">This will close your liquidity position on-chain. The bot stays running in IDLE. Click Resume to open a new position.</p>
      <button class="ctrl-btn ctrl-amber" id="confirm-close-pos-btn" onclick="executeClosePosition()">
        Yes, Close Position
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('close-pos-confirm').style.display='none'">
        Cancel
      </button>
      <div id="close-pos-result" style="margin-top:12px;font-size:12px"></div>
    </div>
    <div class="stop-confirm" id="stop-confirm">
      <p style="color:#ef4444;font-weight:bold;margin-bottom:8px">Are you sure?</p>
      <p style="color:#8b949e;font-size:12px;margin-bottom:12px">This will close your liquidity position on-chain and shut down the bot process.</p>
      <button class="ctrl-btn ctrl-red" id="confirm-stop-btn" onclick="executeStop()">
        Yes, Close &amp; Stop Now
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('stop-confirm').style.display='none'">
        Cancel
      </button>
      <div id="stop-result" style="margin-top:12px;font-size:12px"></div>
    </div>
    <div class="stop-confirm" id="add-liq-confirm" style="display:none">
      <p style="color:#58a6ff;font-weight:bold;margin-bottom:8px">Add Liquidity to Position</p>
      <div id="add-liq-preview" style="font-size:12px;color:#c9d1d9;margin-bottom:12px">Loading preview...</div>
      <button class="ctrl-btn ctrl-blue" id="confirm-add-liq-btn" onclick="executeAddLiquidity()">
        Yes, Add Liquidity
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('add-liq-confirm').style.display='none'">
        Cancel
      </button>
      <div id="add-liq-result" style="margin-top:12px;font-size:12px"></div>
    </div>
  </div>

  <div class="stop-confirm" id="generic-confirm" style="display:none">
    <p id="generic-confirm-title" style="color:#58a6ff;font-weight:bold;margin-bottom:8px"></p>
    <p id="generic-confirm-desc" style="color:#8b949e;font-size:12px;margin-bottom:12px"></p>
    <button class="ctrl-btn ctrl-blue" style="width:100%" id="generic-confirm-btn">Confirm</button>
    <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('generic-confirm').style.display='none'">Cancel</button>
  </div>

</div>

<script>
window.__LIVE_DATA__ = ${JSON.stringify(live)};

function showConfirmAction(title, desc, action) {
  var d = document.getElementById('generic-confirm');
  document.getElementById('generic-confirm-title').textContent = title;
  document.getElementById('generic-confirm-desc').textContent = desc;
  var btn = document.getElementById('generic-confirm-btn');
  btn.onclick = function() { d.style.display = 'none'; eval(action); };
  d.style.display = 'block';
}

function stopAutoRefresh() {
  var meta = document.getElementById('auto-refresh');
  if (meta) meta.remove();
}

function harvestFees() {
  stopAutoRefresh();
  var btn = document.getElementById('harvest-btn');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  btn.textContent = 'Harvesting...';
  result.innerHTML = '<span style="color:#eab308">Collecting fees from on-chain position...</span>';

  fetch('/api/harvest', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      btn.disabled = false;
      btn.textContent = 'Harvest Fees';
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Harvest Fees';
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
    });
}

function controlBot(action) {
  stopAutoRefresh();
  var result = document.getElementById('ctrl-result');
  var btn = document.getElementById(action === 'pause' ? 'pause-btn' : 'resume-btn');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">' + (action === 'pause' ? 'Pausing...' : 'Resuming...') + '</span>';

  fetch('/api/' + action, { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        if (action === 'pause') {
          document.getElementById('pause-btn').disabled = true;
          document.getElementById('resume-btn').disabled = false;
        } else {
          document.getElementById('pause-btn').disabled = false;
          document.getElementById('resume-btn').disabled = true;
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
        btn.disabled = false;
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function toggleRule2() {
  var btn = document.getElementById('rule2-btn');
  var status = document.getElementById('rule2-status');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">Toggling Rule 2...</span>';

  fetch('/api/toggle-rule2', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        var mBadge = document.getElementById('rule2-market-badge');
        if (data.rule2Enabled) {
          btn.textContent = 'Disable Rule 2';
          btn.className = 'ctrl-btn ctrl-amber';
          status.textContent = 'ACTIVE';
          status.style.color = '#22c55e';
          if (mBadge) { mBadge.textContent = 'ACTIVE'; mBadge.style.background = '#22c55e20'; mBadge.style.color = '#22c55e'; }
        } else {
          btn.textContent = 'Enable Rule 2';
          btn.className = 'ctrl-btn ctrl-green';
          status.textContent = 'BYPASSED';
          status.style.color = '#f97316';
          if (mBadge) { mBadge.textContent = 'BYPASSED'; mBadge.style.background = '#f9731620'; mBadge.style.color = '#f97316'; }
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
      btn.disabled = false;
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function toggleAutoDeploy() {
  var btn = document.getElementById('autodeploy-btn');
  var status = document.getElementById('autodeploy-status');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">Toggling Auto Deploy...</span>';

  fetch('/api/toggle-auto-deploy', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        var mBadge = document.getElementById('autodeploy-market-badge');
        if (data.autoDeployEnabled) {
          btn.textContent = 'Disable Auto Deploy';
          btn.className = 'ctrl-btn ctrl-amber';
          status.textContent = 'ENABLED';
          status.style.color = '#22c55e';
          if (mBadge) { mBadge.textContent = 'ENABLED'; mBadge.style.background = '#22c55e20'; mBadge.style.color = '#22c55e'; }
        } else {
          btn.textContent = 'Enable Auto Deploy';
          btn.className = 'ctrl-btn ctrl-green';
          status.textContent = 'DISABLED';
          status.style.color = '#f97316';
          if (mBadge) { mBadge.textContent = 'DISABLED'; mBadge.style.background = '#f9731620'; mBadge.style.color = '#f97316'; }
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
      btn.disabled = false;
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function toggleSolConversion() {
  var btn = document.getElementById('solconv-btn');
  var status = document.getElementById('solconv-status');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">Toggling SOL Conversion...</span>';

  fetch('/api/toggle-sol-conversion', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        if (data.solConversionEnabled) {
          btn.textContent = 'Disable SOL Convert';
          btn.className = 'ctrl-btn ctrl-amber';
          status.textContent = 'ENABLED';
          status.style.color = '#22c55e';
        } else {
          btn.textContent = 'Enable SOL Convert';
          btn.className = 'ctrl-btn ctrl-green';
          status.textContent = 'DISABLED';
          status.style.color = '#f97316';
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
      btn.disabled = false;
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function previewAddLiquidity() {
  stopAutoRefresh();
  var preview = document.getElementById('add-liq-preview');
  var confirmDiv = document.getElementById('add-liq-confirm');
  var resultDiv = document.getElementById('add-liq-result');
  resultDiv.innerHTML = '';
  preview.innerHTML = '<span style="color:#eab308">Loading preview...</span>';
  confirmDiv.style.display = 'block';

  fetch('/api/add-liquidity-preview')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.available) {
        preview.innerHTML = '<span style="color:#ef4444">' + (data.reason || 'Not available') + '</span>';
        document.getElementById('confirm-add-liq-btn').disabled = true;
        return;
      }
      document.getElementById('confirm-add-liq-btn').disabled = false;
      preview.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:8px">' +
        '<span style="color:#8b949e">Position Range</span><span>' + data.positionRange + '</span>' +
        '<span style="color:#8b949e">Available SOL</span><span>' + data.solAvailable.toFixed(4) + ' SOL</span>' +
        '<span style="color:#8b949e">Available USDC</span><span>$' + data.usdcAvailable.toFixed(2) + '</span>' +
        '<span style="color:#8b949e">Total Available</span><span style="color:#58a6ff;font-weight:bold">$' + data.totalAvailableUsdc.toFixed(2) + '</span>' +
        '</div>' +
        '<div style="border-top:1px solid #21262d;padding-top:8px;margin-top:4px">' +
        '<div style="color:#8b949e;margin-bottom:4px">Estimated deposit:</div>' +
        '<div style="font-weight:bold;color:#22c55e">' + data.estSolDeposit.toFixed(4) + ' SOL + $' + data.estUsdcDeposit.toFixed(2) + ' USDC = $' + data.estTotalUsdc.toFixed(2) + '</div>' +
        (data.needsSwap !== 'none' ? '<div style="color:#eab308;font-size:11px;margin-top:4px">Swap needed: ' + data.needsSwap + '</div>' : '') +
        '</div>';
    })
    .catch(function(err) {
      preview.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
    });
}

function executeAddLiquidity() {
  var btn = document.getElementById('confirm-add-liq-btn');
  var result = document.getElementById('add-liq-result');
  btn.disabled = true;
  btn.textContent = 'Adding liquidity...';
  result.innerHTML = '<span style="color:#eab308">Executing swap + deposit on Solana...</span>';

  fetch('/api/add-liquidity', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        setTimeout(function() { location.reload(); }, 3000);
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Yes, Add Liquidity';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Yes, Add Liquidity';
    });
}

function executeClosePosition() {
  var btn = document.getElementById('confirm-close-pos-btn');
  var result = document.getElementById('close-pos-result');
  btn.disabled = true;
  btn.textContent = 'Closing position...';
  result.innerHTML = '<span style="color:#eab308">Sending close transaction to Solana...</span>';

  fetch('/api/close-position', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">Error: ' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Retry Close Position';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Retry Close Position';
    });
}

function executeStop() {
  var btn = document.getElementById('confirm-stop-btn');
  var result = document.getElementById('stop-result');
  btn.disabled = true;
  btn.textContent = 'Closing position...';
  result.innerHTML = '<span style="color:#eab308">Sending close transaction to Solana...</span>';

  fetch('/api/emergency-stop', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">Position closed. Bot stopped.</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">Error: ' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Retry Close & Stop';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Retry Close & Stop';
    });
}
</script>
</body>
</html>`;
}

// ── Insights page ─────────────────────────────────────────────────────────

interface InsightsData {
  snapshots: Array<{ timestamp: number; price: number; total_value_usdc: number; pending_fees_sol: number; pending_fees_usdc: number; cum_fees_sol: number; cum_fees_usdc: number; il_usdc: number; in_range: number; regime: string; sol_balance: number; usdc_balance: number; position_mint: string | null; position_sol: number; position_usdc: number; position_value: number; total_with_position: number }>;
  snapshots7d: Array<{ timestamp: number; price: number; total_value_usdc: number; total_with_position: number; position_value: number; cum_fees_sol: number; cum_fees_usdc: number; pending_fees_sol: number; pending_fees_usdc: number; sol_balance: number; usdc_balance: number; position_sol: number; position_usdc: number }>;
  inRangePct1h: number;
  inRangePct24h: number;
  inRangePctAll: number;
  decisions: Array<{ timestamp: number; price: number; regime: string; bot_state: string; prox_lower: number | null; prox_upper: number | null; in_range: number | null; decision: string; reasoning: string; params_json: string | null }>;
  regimeEvals: Array<{ timestamp: number; price: number; regime: string; bot_state: string; decision: string; reasoning: string; params_json: string | null }>;
  regimeHist: Array<{ timestamp: number; old_regime: string; new_regime: string; price: number; dir_ratio: number | null; realised_vol: number | null; price_count: number | null }>;
  events: RebalanceEvent[];
  recentTxs: OnChainTx[];
  uptime: number;
  dailySummaries?: Array<{ date: string; wallet_usdc: number; position_usdc: number; total_usdc: number; injected_usdc: number; fees_earned_usdc: number; cum_fees_usdc: number; portfolio_change: number; sol_price: number; regime: string | null }>;
}

function buildDailyFeesChart(snapshots7d: Array<{ timestamp: number; price: number; cum_fees_sol: number; cum_fees_usdc: number; pending_fees_sol: number; pending_fees_usdc: number }>): string {
  const feeDailyMap = new Map<string, { totalFeesUsdc: number }>();
  snapshots7d.forEach(s => {
    const date = new Date(s.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
    const cumFeesUsdc = (s.cum_fees_sol ?? 0) * s.price + (s.cum_fees_usdc ?? 0);
    // Sanity check: pending fees > $1000 is overflow (u128 wrapping artifact), ignore
    const rawPending = (s.pending_fees_sol ?? 0) * s.price + (s.pending_fees_usdc ?? 0);
    const pendingFeesUsdc = rawPending > 1000 ? 0 : rawPending;
    feeDailyMap.set(date, { totalFeesUsdc: cumFeesUsdc + pendingFeesUsdc });
  });
  const feeDays = Array.from(feeDailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);

  if (feeDays.length < 1) return '<div class="card" style="margin-bottom:16px"><h2>Total Fees Earned Per Day</h2><div style="color:#8b949e;text-align:center;padding:20px">Collecting data...</div></div>';

  const dailyFees: Array<{ date: string; fees: number }> = [];
  // First day: show its cumulative total as earned that day
  dailyFees.push({ date: feeDays[0][0], fees: Math.max(0, feeDays[0][1].totalFeesUsdc) });
  // Subsequent days: delta from previous day
  for (let i = 1; i < feeDays.length; i++) {
    const delta = feeDays[i][1].totalFeesUsdc - feeDays[i - 1][1].totalFeesUsdc;
    dailyFees.push({ date: feeDays[i][0], fees: Math.max(0, delta) });
  }

  if (dailyFees.length === 0 || dailyFees.every(d => d.fees === 0)) return '<div class="card" style="margin-bottom:16px"><h2>Total Fees Earned Per Day</h2><div style="color:#8b949e;text-align:center;padding:20px">No fee data yet...</div></div>';

  const maxFee = Math.max(...dailyFees.map(d => d.fees), 0.01);
  const barW = Math.min(80, Math.floor(500 / dailyFees.length) - 8);
  const chartH = 80;
  const baseY = chartH + 25;
  const totalFees = dailyFees.reduce((s, d) => s + d.fees, 0);
  const avgFee = dailyFees.length > 0 ? totalFees / dailyFees.length : 0;
  const avgY = baseY - (avgFee / maxFee) * chartH * 0.85;

  const bars = dailyFees.map((d, i) => {
    const x = i * (barW + 8) + 50;
    const barH = Math.max(2, (d.fees / maxFee) * chartH * 0.85);
    const y = baseY - barH;
    const dayLabel = d.date.slice(5);
    const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });
    const feeLabel = d.fees < 0.01 ? d.fees.toFixed(4) : fmt(d.fees, 2);
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="#22c55e" rx="2"/>
      <text x="${x + barW / 2}" y="${Math.max(15, y - 4)}" text-anchor="middle" fill="#c9d1d9" font-size="9">$${feeLabel}</text>
      <text x="${x + barW / 2}" y="${baseY + 12}" text-anchor="middle" fill="#8b949e" font-size="9">${dayLabel}</text>
      <text x="${x + barW / 2}" y="${baseY + 22}" text-anchor="middle" fill="#8b949e" font-size="8">${dayName}</text>`;
  }).join('');

  return `<div class="card" style="margin-bottom:16px">
  <h2>Total Fees Earned Per Day <span style="color:#8b949e;font-size:12px;font-weight:normal">| Total: $${fmt(totalFees, 2)} | Avg: $${fmt(avgFee, 2)}/day</span></h2>
  <svg width="100%" height="135" viewBox="0 0 600 135" preserveAspectRatio="xMidYMid meet">
    <line x1="45" y1="25" x2="45" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    <line x1="45" y1="${baseY}" x2="590" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    <text x="5" y="30" fill="#8b949e" font-size="9">$${fmt(maxFee, 2)}</text>
    <text x="5" y="${baseY}" fill="#8b949e" font-size="9">$0</text>
    <line x1="45" y1="${avgY}" x2="590" y2="${avgY}" stroke="#eab308" stroke-width="1" stroke-dasharray="4,4"/>
    <text x="592" y="${avgY + 4}" fill="#eab308" font-size="8">avg</text>
    ${bars}
  </svg>
  <div style="overflow-x:auto;margin-top:8px">
  <table style="width:100%;border-collapse:collapse;font-size:11px">
    <tr style="border-bottom:1px solid #30363d">
      <th style="text-align:left;padding:6px 8px;color:#8b949e">Date</th>
      <th style="text-align:right;padding:6px 8px;color:#22c55e">Fees Earned</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e">Cumulative</th>
    </tr>
    ${(() => {
      let cum = 0;
      return dailyFees.map(d => {
        cum += d.fees;
        return `<tr style="border-bottom:1px solid #21262d">
          <td style="padding:5px 8px;color:#8b949e">${d.date}</td>
          <td style="padding:5px 8px;text-align:right;color:#22c55e;font-weight:bold">$${fmt(d.fees, 4)}</td>
          <td style="padding:5px 8px;text-align:right;color:#8b949e">$${fmt(cum, 4)}</td>
        </tr>`;
      }).join('');
    })()}
  </table>
  </div>
  <div style="margin-top:8px;text-align:right"><a href="/api/daily-fees.csv" style="color:#58a6ff;font-size:11px">Download full history (CSV)</a></div>
</div>`;
}

function renderInsightsHtml(data: InsightsData): string {
  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  const snaps = data.snapshots;
  // Detect capital injections: compare total tokens (wallet + position) between snapshots,
  // valued at the SAME price to eliminate price movement effects. Any increase in token
  // quantity = external deposit (swaps/rebalances just move tokens, don't create new ones).
  interface Injection { timestamp: number; amount: number; price: number }
  const detectedInjections: Injection[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    const p = curr.price; // value both at same price
    const prevValue = (prev.sol_balance + prev.position_sol) * p + prev.usdc_balance + prev.position_usdc;
    const currValue = (curr.sol_balance + curr.position_sol) * p + curr.usdc_balance + curr.position_usdc;
    const increase = currValue - prevValue;
    if (increase > 20) {
      detectedInjections.push({ timestamp: curr.timestamp, amount: increase, price: p });
    }
  }
  const totalInjected = detectedInjections.reduce((sum, inj) => sum + inj.amount, 0);

  // Build adjusted values: subtract cumulative injections AND SOL price impact
  // to show pure bot performance (fees - IL - gas only).
  // SOL impact = sum of (totalSolHoldings * priceChange) between consecutive snapshots.
  let cumInjected = 0;
  let cumSolImpact = 0;
  const injectionMap = new Map(detectedInjections.map(inj => [inj.timestamp, inj.amount]));
  const adjustedValues: number[] = [];
  const rawValues: number[] = [];
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const raw = s.total_with_position ?? s.total_value_usdc;
    rawValues.push(raw);
    if (injectionMap.has(s.timestamp)) cumInjected += injectionMap.get(s.timestamp)!;
    // SOL price impact: how much the portfolio changed purely due to SOL price movement
    if (i > 0) {
      const prev = snaps[i - 1];
      const totalSol = (prev.sol_balance ?? 0) + (prev.position_sol ?? 0);
      const priceDelta = s.price - prev.price;
      cumSolImpact += totalSol * priceDelta;
    }
    adjustedValues.push(raw - cumInjected - cumSolImpact);
  }

  let chartSvg = '<text x="200" y="40" text-anchor="middle" fill="#8b949e" font-size="12">Collecting data...</text>';
  if (snaps.length > 2) {
    // Use adjusted values (organic growth) for the chart line
    const values = adjustedValues;
    const allVals = [...rawValues, ...adjustedValues];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const range = maxV - minV || 1;
    const w = 580;
    const h = 80;

    // Organic growth line (adjusted)
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w + 10;
      const y = h - ((v - minV) / range) * (h - 10) + 5;
      return `${x},${y}`;
    }).join(' ');

    // Raw portfolio line (faded, includes injections)
    const rawPoints = rawValues.map((v, i) => {
      const x = (i / (rawValues.length - 1)) * w + 10;
      const y = h - ((v - minV) / range) * (h - 10) + 5;
      return `${x},${y}`;
    }).join(' ');

    const firstTime = new Date(snaps[0].timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: TZ });
    const lastTime = new Date(snaps[snaps.length - 1].timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: TZ });
    const lastVal = values[values.length - 1];
    const firstVal = values[0];
    const lastRaw = rawValues[rawValues.length - 1];
    const lineColor = lastVal >= firstVal ? '#22c55e' : '#ef4444';
    const changePct = firstVal > 0 ? ((lastVal - firstVal) / firstVal * 100) : 0;

    // Mark capital injections as vertical dashed lines
    const tMin = snaps[0].timestamp;
    const tMax = snaps[snaps.length - 1].timestamp;
    const tRange = tMax - tMin || 1;
    const injectionMarkers = detectedInjections
      .filter(inj => inj.timestamp >= tMin && inj.timestamp <= tMax)
      .map(inj => {
        const x = ((inj.timestamp - tMin) / tRange) * w + 10;
        return `<line x1="${x}" y1="5" x2="${x}" y2="${h}" stroke="#a855f7" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${x}" y="${h + 9}" text-anchor="middle" fill="#a855f7" font-size="8">+$${fmt(inj.amount, 0)}</text>`;
      }).join('');

    chartSvg = `
      ${totalInjected > 0 ? `<polyline points="${rawPoints}" fill="none" stroke="#8b949e" stroke-width="1" stroke-dasharray="2,2" opacity="0.4"/>` : ''}
      <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2"/>
      ${injectionMarkers}
      <text x="10" y="98" fill="#8b949e" font-size="9">${firstTime}</text>
      <text x="${w}" y="98" text-anchor="end" fill="#8b949e" font-size="9">${lastTime}</text>
      <text x="10" y="12" fill="#8b949e" font-size="9">$${fmt(maxV)}</text>
      <text x="10" y="${h}" fill="#8b949e" font-size="9">$${fmt(minV)}</text>
      <circle cx="${w + 10}" cy="${h - ((lastVal - minV) / range) * (h - 10) + 5}" r="3" fill="${lineColor}"/>
      <text x="${w - 80}" y="12" fill="${lineColor}" font-size="10" font-weight="bold">$${fmt(lastVal)} (${changePct >= 0 ? '+' : ''}${fmt(changePct, 1)}%)</text>
      ${totalInjected > 0 ? `<text x="${w}" y="12" text-anchor="end" fill="#8b949e" font-size="8">total: $${fmt(lastRaw)}</text>` : ''}`;
  }

  function gauge(pct: number, label: string): string {
    const col = pct > 80 ? '#22c55e' : pct > 50 ? '#eab308' : '#ef4444';
    return `<div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${col}">${fmt(pct, 1)}%</div>
      <div style="font-size:11px;color:#8b949e">${label}</div>
    </div>`;
  }

  const regimeCards = data.regimeHist.map(r => {
    const t = new Date(r.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
    const regimeColours: Record<string, string> = { RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7' };
    const oldCol = regimeColours[r.old_regime] || '#888';
    const newCol = regimeColours[r.new_regime] || '#888';
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="color:#8b949e;font-size:11px">${t}</span>
        <span class="badge" style="background:${oldCol}20;color:${oldCol}">${r.old_regime}</span>
        <span style="color:#8b949e">&rarr;</span>
        <span class="badge" style="background:${newCol}20;color:${newCol}">${r.new_regime}</span>
        <span style="color:#8b949e;font-size:11px">at $${fmt(r.price)}</span>
      </div>
      <div style="font-size:11px;color:#8b949e;margin-top:4px">
        dirRatio: ${r.dir_ratio?.toFixed(3) ?? '--'} | realisedVol: ${r.realised_vol?.toFixed(4) ?? '--'} | ${r.price_count ?? '--'} daily closes
      </div>
    </div>`;
  }).join('') || '<div style="color:#8b949e;text-align:center;padding:16px">No regime changes yet</div>';

  const decisionCards = data.decisions.map(d => {
    const t = new Date(d.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
    const decColours: Record<string, string> = {
      HOLD: '#8b949e', T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308', PULLBACK_REENTRY: '#22c55e',
      PULLBACK_TIMEOUT: '#a855f7', FEE_HARVEST: '#58a6ff', POSITION_OPENED: '#22c55e',
      LIQUIDITY_ADDED: '#22c55e', RULE2_ENABLED: '#22c55e', RULE2_DISABLED: '#f97316',
    };
    const col = decColours[d.decision] || '#8b949e';
    const proxStr = d.prox_lower !== null ? `prox: ${(d.prox_lower * 100).toFixed(0)}%down ${((d.prox_upper ?? 0) * 100).toFixed(0)}%up` : '';
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge" style="background:${col}20;color:${col}">${d.decision}</span>
        <span style="color:#8b949e;font-size:11px">${t} &middot; $${fmt(d.price)} &middot; ${d.regime}</span>
        ${proxStr ? `<span style="color:#8b949e;font-size:11px">${proxStr}</span>` : ''}
      </div>
      <div style="font-size:12px;color:#c9d1d9;margin-top:4px;line-height:1.4">${d.reasoning.replace(/\n/g, '<br/>')}</div>
    </div>`;
  }).join('') || '<div style="color:#8b949e;text-align:center;padding:16px">No decisions logged yet</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>SOL/USDC LP Bot - Insights</title>
<style>${SHARED_STYLES}
.section-title{font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d}
.gauge-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px}
@media(max-width:700px){
  .gauge-row{grid-template-columns:1fr;gap:8px}
  .section-title{font-size:13px;margin:16px 0 10px}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#a855f7">Insights &amp; Analytics</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | Snapshots: ${snaps.length} | CET</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-insights').classList.add('active')</script>

<div style="margin:8px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <button onclick="document.getElementById('insights-toggles').style.display=document.getElementById('insights-toggles').style.display==='none'?'flex':'none'" style="background:#21262d;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer">Toggle Cards</button>
  <div id="insights-toggles" style="display:none;flex-wrap:wrap;gap:6px">
  </div>
</div>
<script>
(function(){
  var sections = [
    {id:'sec-growth',name:'Portfolio Growth'},
    {id:'sec-daily7d',name:'Daily Fees'},
    {id:'sec-hourly',name:'Hourly Fees'},
    {id:'sec-positions',name:'Position History'},
    {id:'sec-signals',name:'Market Signals'},
    {id:'sec-inrange',name:'In-Range'},
    {id:'sec-regime',name:'Regime History'},
    {id:'sec-events',name:'Events & Injections'},
    {id:'sec-txs',name:'On-Chain TXs'},
    {id:'sec-swappnl',name:'Swap P&L'},
    {id:'sec-solprice',name:'SOL Daily Price'},
    {id:'sec-downloads',name:'Download Logs'}
  ];
  var stored = localStorage.getItem('insights-visible');
  var visible = stored ? JSON.parse(stored) : sections.map(function(s){return s.id;});
  var panel = document.getElementById('insights-toggles');
  sections.forEach(function(s){
    var checked = visible.includes(s.id) ? 'checked' : '';
    var lbl = document.createElement('label');
    lbl.style.cssText = 'font-size:10px;color:#8b949e;cursor:pointer;white-space:nowrap';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = visible.includes(s.id);
    cb.addEventListener('change', function(){ toggleInsight(s.id); });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + s.name));
    panel.appendChild(lbl);
  });
  window.toggleInsight = function(id){
    var el = document.getElementById(id);
    if(!el)return;
    var stored2 = localStorage.getItem('insights-visible');
    var vis = stored2 ? JSON.parse(stored2) : sections.map(function(s){return s.id;});
    if(vis.includes(id)){vis=vis.filter(function(v){return v!==id;});el.style.display='none';}
    else{vis.push(id);el.style.display='';}
    localStorage.setItem('insights-visible',JSON.stringify(vis));
  };
  sections.forEach(function(s){
    var el = document.getElementById(s.id);
    if(el && !visible.includes(s.id)) el.style.display='none';
  });
})();
</script>

<div id="sec-growth">
${(() => {
  // Group 7d snapshots by date, take last snapshot of each day
  const dailyMap = new Map<string, { total: number; wallet: number; position: number; solPrice: number; totalSol: number }>();
  data.snapshots7d.forEach(s => {
    const date = new Date(s.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
    const total = (s as any).total_with_position ?? s.total_value_usdc;
    const position = (s as any).position_value ?? 0;
    const totalSol = (s.sol_balance ?? 0) + (s.position_sol ?? 0);
    dailyMap.set(date, { total, wallet: s.total_value_usdc, position, solPrice: s.price, totalSol });
  });
  const days = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);

  // Detect capital injections from 7d snapshots: compare total portfolio value
  // between consecutive snapshots and flag increases beyond what price movement explains.
  const dailyInjections = new Map<string, number>();
  const allSnaps7d = data.snapshots7d;
  for (let i = 1; i < allSnaps7d.length; i++) {
    const prev = allSnaps7d[i - 1];
    const curr = allSnaps7d[i];
    const prevTotalSol = (prev.sol_balance ?? 0) + (prev.position_sol ?? 0);
    // Value previous tokens at current price (removes price movement effect)
    const prevTotalValue = prevTotalSol * curr.price + (prev.usdc_balance ?? 0) + (prev.position_usdc ?? 0);
    const currTotalValue = ((curr.sol_balance ?? 0) + (curr.position_sol ?? 0)) * curr.price + (curr.usdc_balance ?? 0) + (curr.position_usdc ?? 0);
    const unexplained = currTotalValue - prevTotalValue;
    if (unexplained > 20) {
      const date = new Date(curr.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
      dailyInjections.set(date, (dailyInjections.get(date) ?? 0) + unexplained);
    }
  }

  if (days.length === 0) return '<div class="card" style="margin-bottom:16px"><h2>Daily Portfolio Value (7 days)</h2><div style="color:#8b949e;text-align:center;padding:20px">Collecting data...</div></div>';

  // Also get cumulative fees per day for PnL line
  const feeDailyMap2 = new Map<string, number>();
  data.snapshots7d.forEach(s => {
    const date = new Date(s.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
    const cumFeesUsdc = (s.cum_fees_sol ?? 0) * s.price + (s.cum_fees_usdc ?? 0);
    const rawPending = (s.pending_fees_sol ?? 0) * s.price + (s.pending_fees_usdc ?? 0);
    const pendingFeesUsdc = rawPending > 1000 ? 0 : rawPending;
    feeDailyMap2.set(date, cumFeesUsdc + pendingFeesUsdc);
  });

  // Compute per-day SOL impact from snapshots: sum micro-impacts per snapshot pair
  // solImpact += currentSolHoldings * (price[i] - price[i-1])
  // This weights each price move by the actual SOL held at that moment.
  const dailySolImpact = new Map<string, number>();
  for (let i = 1; i < allSnaps7d.length; i++) {
    const prev = allSnaps7d[i - 1];
    const curr = allSnaps7d[i];
    const date = new Date(curr.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
    const prevDate = new Date(prev.timestamp).toLocaleDateString('en-CA', { timeZone: TZ });
    // Only count intra-day price moves (skip cross-day boundary)
    if (date !== prevDate) continue;
    const solHeld = (prev.sol_balance ?? 0) + (prev.position_sol ?? 0);
    const priceDelta = curr.price - prev.price;
    dailySolImpact.set(date, (dailySolImpact.get(date) ?? 0) + solHeld * priceDelta);
  }

  // Use daily_summary as source of truth for Change (consistent with live wallet page)
  // Falls back to snapshot-derived values if daily_summary not available
  const summaryMap = new Map<string, { total: number; change: number; injected: number; fees: number; solPrice: number }>();
  if (data.dailySummaries) {
    data.dailySummaries.forEach(s => {
      summaryMap.set(s.date, { total: s.total_usdc, change: s.portfolio_change, injected: s.injected_usdc, fees: s.fees_earned_usdc, solPrice: s.sol_price });
    });
  }

  const pnlPoints: Array<{ date: string; pnl: number; solImpact: number; organic: number }> = [];
  days.forEach(([date, val], i) => {
    const solImpact = dailySolImpact.get(date) ?? 0;
    const summary = summaryMap.get(date);

    if (summary) {
      // Use daily_summary: change = today - yesterday - injections (already computed in main.ts)
      pnlPoints.push({ date, pnl: summary.change, solImpact, organic: summary.fees });
    } else {
      // Fallback to snapshot-derived
      const injToday = dailyInjections.get(date) ?? 0;
      const todayFees = feeDailyMap2.get(date) ?? 0;
      const prevDayDate = i > 0 ? days[i - 1][0] : null;
      const prevDayFees = prevDayDate ? (feeDailyMap2.get(prevDayDate) ?? 0) : 0;
      const dailyFees = i === 0 ? todayFees : Math.max(0, todayFees - prevDayFees);
      const change = i === 0 ? 0 : val.total - days[i - 1][1].total - injToday;
      pnlPoints.push({ date, pnl: change, solImpact, organic: dailyFees });
    }
  });

  // Each bar = wallet + position + injections stacked
  const maxVal = Math.max(...days.map(([d, v]) => v.total + (dailyInjections.get(d) ?? 0)));
  const barW = Math.min(80, Math.floor(500 / days.length) - 8);
  const chartH = 100;
  const topPad = 20;
  const baseY = chartH + topPad;

  const bars = days.map(([date, val], i) => {
    const x = i * (barW + 8) + 50;
    const injected = dailyInjections.get(date) ?? 0;
    const dayTotal = val.total;
    const walletVal = val.wallet;
    const positionVal = val.position;

    const fullH = Math.max(4, (dayTotal / maxVal) * chartH * 0.85 + chartH * 0.15);
    const y = baseY - fullH;

    const injH = injected > 0 ? Math.max(3, (injected / dayTotal) * fullH) : 0;
    const posH = positionVal > 0 ? Math.max(3, (positionVal / dayTotal) * (fullH - injH)) : 0;
    const walH = fullH - posH - injH;

    const dayLabel = date.slice(5);
    const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });


    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${walH}" fill="#22c55e80" rx="2"/>
      <rect x="${x}" y="${y + walH}" width="${barW}" height="${posH}" fill="#58a6ff" rx="0"/>
      ${injH > 0 ? `<rect x="${x}" y="${y + walH + posH}" width="${barW}" height="${injH}" fill="#a855f7" rx="0"/>` : ''}
      <text x="${x + barW/2}" y="${Math.max(topPad + 2, y - 3)}" text-anchor="middle" fill="#c9d1d9" font-size="9">$${fmt(dayTotal, 0)}</text>
      <text x="${x + barW/2}" y="${baseY + 12}" text-anchor="middle" fill="#8b949e" font-size="9">${dayLabel}</text>
      <text x="${x + barW/2}" y="${baseY + 22}" text-anchor="middle" fill="#8b949e" font-size="8">${dayName}</text>`;
  }).join('');

  // PnL line overlay
  // Organic line (net of SOL price impact + injections) = true bot performance
  const orgVals = pnlPoints.map(p => p.organic);
  const pnlVals = pnlPoints.map(p => p.pnl);
  const allLineVals = [...orgVals, ...pnlVals];
  const pnlMin = Math.min(...allLineVals, 0);
  const pnlMax = Math.max(...allLineVals, 0);
  const pnlRange = pnlMax - pnlMin || 1;
  const lineY = (val: number) => baseY - ((val - pnlMin) / pnlRange) * chartH * 0.7 - chartH * 0.05;

  const organicLinePoints = pnlPoints.map((p, i) => {
    const x = i * (barW + 8) + 50 + barW / 2;
    return `${x},${lineY(p.organic)}`;
  }).join(' ');
  const pnlLinePoints = pnlPoints.map((p, i) => {
    const x = i * (barW + 8) + 50 + barW / 2;
    return `${x},${lineY(p.pnl)}`;
  }).join(' ');

  const lastOrganic = pnlPoints[pnlPoints.length - 1]?.organic ?? 0;
  const lastPnl = pnlPoints[pnlPoints.length - 1]?.pnl ?? 0;
  const organicColor = lastOrganic >= 0 ? '#22c55e' : '#ef4444';
  const pnlColor = lastPnl >= 0 ? '#8b949e' : '#8b949e';
  const lastX = (pnlPoints.length - 1) * (barW + 8) + 50 + barW / 2;
  const lastOrgY = lineY(lastOrganic);
  const lastPnlY = lineY(lastPnl);

  const hasInjections = dailyInjections.size > 0;
  return `<div class="card" style="margin-bottom:16px">
  <h2>Daily Portfolio Value (7 days)</h2>
  <div style="font-size:11px;color:#8b949e;margin-bottom:6px;display:flex;gap:16px;flex-wrap:wrap">
    <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e80;border-radius:2px;vertical-align:middle"></span> Wallet</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#58a6ff;border-radius:2px;vertical-align:middle"></span> Position</span>
    ${hasInjections ? '<span><span style="display:inline-block;width:10px;height:10px;background:#a855f7;border-radius:2px;vertical-align:middle"></span> Injections</span>' : ''}
    <span><span style="display:inline-block;width:16px;height:2px;background:${organicColor};vertical-align:middle"></span> Organic: <b style="color:${organicColor}">${lastOrganic >= 0 ? '+' : ''}$${fmt(lastOrganic, 2)}</b> <span style="color:#555">(fees - IL - gas)</span></span>
    <span><span style="display:inline-block;width:16px;height:2px;background:#8b949e;vertical-align:middle;opacity:0.4"></span> Raw: <span style="color:#8b949e">${lastPnl >= 0 ? '+' : ''}$${fmt(lastPnl, 2)}</span></span>
  </div>
  <svg width="100%" height="170" viewBox="0 0 600 170" preserveAspectRatio="xMidYMid meet">
    <line x1="45" y1="${topPad}" x2="45" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    <line x1="45" y1="${baseY}" x2="590" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    <text x="5" y="${topPad + 5}" fill="#8b949e" font-size="9">$${fmt(maxVal, 0)}</text>
    <text x="5" y="${baseY}" fill="#8b949e" font-size="9">$0</text>
    ${bars}
    <polyline points="${pnlLinePoints}" fill="none" stroke="#8b949e" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>
    <polyline points="${organicLinePoints}" fill="none" stroke="${organicColor}" stroke-width="2"/>
    <circle cx="${lastX}" cy="${lastOrgY}" r="3" fill="${organicColor}"/>
    <text x="${lastX + 6}" y="${lastOrgY + 4}" fill="${organicColor}" font-size="9" font-weight="bold">${lastOrganic >= 0 ? '+' : ''}$${fmt(lastOrganic, 2)}</text>
  </svg>
  <div style="overflow-x:auto;margin-top:8px">
  <table style="width:100%;border-collapse:collapse;font-size:11px">
    <tr style="border-bottom:1px solid #30363d">
      <th style="text-align:left;padding:6px 8px;color:#8b949e">Date</th>
      <th style="text-align:right;padding:6px 8px;color:#22c55e">Wallet</th>
      <th style="text-align:right;padding:6px 8px;color:#58a6ff">Position</th>
      <th style="text-align:right;padding:6px 8px;color:#a855f7">Injected</th>
      <th style="text-align:right;padding:6px 8px;color:#c9d1d9">Total</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e">SOL Price</th>
      <th style="text-align:right;padding:6px 8px;color:#f97316">SOL Impact</th>
      <th style="text-align:right;padding:6px 8px;color:#22c55e">Organic</th>
      <th style="text-align:right;padding:6px 8px;color:#eab308">Change</th>
    </tr>
    ${days.map(([date, val], i) => {
      const ds = data.dailySummaries?.find(s => s.date === date);
      const inj = ds?.injected_usdc ?? (dailyInjections.get(date) ?? 0);
      const walletVal = ds?.wallet_usdc ?? val.wallet;
      const posVal = ds?.position_usdc ?? val.position;
      const total = ds?.total_usdc ?? val.total;
      const solPrice = ds?.sol_price ?? val.solPrice;
      const p = pnlPoints[i];
      const pnl = p?.pnl ?? 0;
      const solImpact = p?.solImpact ?? 0;
      const organic = p?.organic ?? 0;
      const pnlCol = pnl >= 0 ? '#22c55e' : '#ef4444';
      const solCol = solImpact >= 0 ? '#22c55e' : '#ef4444';
      const orgCol = organic >= 0 ? '#22c55e' : '#ef4444';
      return `<tr style="border-bottom:1px solid #21262d">
        <td style="padding:5px 8px;color:#8b949e">${date}</td>
        <td style="padding:5px 8px;text-align:right;color:#22c55e">$${fmt(walletVal, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:#58a6ff">$${fmt(posVal, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:#a855f7">${inj > 0 ? '$' + fmt(inj, 2) : '-'}</td>
        <td style="padding:5px 8px;text-align:right;color:#c9d1d9;font-weight:bold">$${fmt(total, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:#8b949e">$${fmt(solPrice, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:${solCol}">${solImpact >= 0 ? '+' : ''}$${fmt(solImpact, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:${orgCol}">${organic >= 0 ? '+' : ''}$${fmt(organic, 2)}</td>
        <td style="padding:5px 8px;text-align:right;color:${pnlCol};font-weight:bold">${pnl >= 0 ? '+' : ''}$${fmt(pnl, 2)}</td>
      </tr>`;
    }).join('')}
  </table>
  </div>
  <div style="margin-top:8px;text-align:right"><a href="/api/daily-portfolio.csv" style="color:#58a6ff;font-size:11px">Download full history (CSV)</a></div>
</div>`;
})()}

</div>
<div id="sec-daily7d">${buildDailyFeesChart(data.snapshots7d)}</div>

<div id="sec-hourly"><div class="card" style="margin-bottom:16px">
  <h2>Hourly Fee Breakdown</h2>
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
    <label style="color:#8b949e;font-size:12px">Select day:</label>
    <select id="fee-day-select" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 10px;font-size:13px"></select>
    <span id="fee-day-total" style="color:#ffd700;font-size:13px;font-weight:bold"></span>
    <span id="fee-day-avg" style="color:#8b949e;font-size:11px"></span>
    <span style="color:#8b949e;font-size:10px;margin-left:auto">(CET)</span>
  </div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#8b949e">
    <span><span style="display:inline-block;width:10px;height:10px;background:#ffd700;border-radius:2px;vertical-align:middle"></span> &gt;$2/hr (high)</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:2px;vertical-align:middle"></span> $0.50-$2/hr</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#8b949e;border-radius:2px;vertical-align:middle"></span> &lt;$0.50/hr</span>
    <span>|</span>
    <span>In-Range %: <span style="color:#22c55e">&#9679;</span> &gt;90% <span style="color:#eab308">&#9679;</span> 50-90% <span style="color:#ef4444">&#9679;</span> &lt;50%</span>
  </div>
  <div id="fee-hourly-table" style="overflow-x:auto;-webkit-overflow-scrolling:touch">
    <div style="color:#8b949e;text-align:center;padding:16px">Loading...</div>
  </div>
  <div style="margin-top:12px">
    <div style="font-size:13px;color:#58a6ff;font-weight:bold;margin-bottom:8px;cursor:pointer" onclick="document.getElementById('fee-events-section').style.display=document.getElementById('fee-events-section').style.display==='none'?'block':'none'">
      ▶ Events for this day <span style="color:#8b949e;font-weight:normal;font-size:11px">(click to expand)</span>
    </div>
    <div id="fee-events-section" style="display:none">
      <div id="fee-events-table"></div>
    </div>
  </div>
</div>
<script>
(function() {
  var TZ = 'Europe/Berlin';
  var select = document.getElementById('fee-day-select');
  var tableDiv = document.getElementById('fee-hourly-table');
  var totalEl = document.getElementById('fee-day-total');
  var avgEl = document.getElementById('fee-day-avg');
  var eventsDiv = document.getElementById('fee-events-table');
  var today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  function fmt(n, d) { return Math.abs(n).toFixed(d || 2); }

  function loadDay(date) {
    tableDiv.innerHTML = '<div style="color:#8b949e;text-align:center;padding:16px">Loading...</div>';
    fetch('/api/hourly-fees?date=' + date).then(function(r) { return r.json(); }).then(function(d) {
      if (!d || !d.hourlyData) { tableDiv.innerHTML = '<div style="color:#8b949e">No data</div>'; return; }

      // Populate date selector if not done
      if (select.options.length === 0 && d.availableDates) {
        d.availableDates.reverse().forEach(function(dt) {
          var opt = document.createElement('option');
          opt.value = dt;
          opt.textContent = dt;
          if (dt === date) opt.selected = true;
          select.appendChild(opt);
        });
      }

      totalEl.textContent = 'Total: $' + fmt(d.dayTotal);
      var hoursWithData = d.hourlyData.filter(function(h) { return h.fees > 0; }).length;
      avgEl.textContent = hoursWithData > 0 ? '(avg $' + fmt(d.dayTotal / hoursWithData) + '/active hour)' : '';

      // Build table
      var maxFee = Math.max.apply(null, d.hourlyData.map(function(h) { return h.fees; }));
      var html = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
      html += '<thead><tr>';
      html += '<th style="text-align:left;padding:5px 4px;color:#8b949e;border-bottom:1px solid #30363d">Hour</th>';
      html += '<th style="text-align:right;padding:5px 4px;color:#8b949e;border-bottom:1px solid #30363d">Fees</th>';
      html += '<th style="text-align:right;padding:5px 4px;color:#8b949e;border-bottom:1px solid #30363d">Cumul</th>';
      html += '<th style="text-align:right;padding:5px 4px;color:#8b949e;border-bottom:1px solid #30363d">In-Range %</th>';
      html += '<th style="text-align:left;padding:5px 4px;color:#8b949e;border-bottom:1px solid #30363d;min-width:100px"></th>';
      html += '</tr></thead><tbody>';

      d.hourlyData.forEach(function(h) {
        var barW = maxFee > 0 ? Math.round(h.fees / maxFee * 100) : 0;
        var feeCol = h.fees > 2 ? '#ffd700' : h.fees > 0.5 ? '#22c55e' : h.fees > 0 ? '#8b949e' : '#333';
        var irCol = h.inRangePct > 90 ? '#22c55e' : h.inRangePct > 50 ? '#eab308' : h.inRangePct > 0 ? '#ef4444' : '#333';
        html += '<tr style="border-bottom:1px solid #21262d">';
        html += '<td style="padding:4px;font-family:monospace;white-space:nowrap">' + String(h.hour).padStart(2, '0') + ':00</td>';
        html += '<td style="padding:4px;text-align:right;color:' + feeCol + ';font-weight:bold">$' + fmt(h.fees, 4) + '</td>';
        html += '<td style="padding:4px;text-align:right;color:#8b949e">$' + fmt(h.cumulative) + '</td>';
        html += '<td style="padding:4px;text-align:right;color:' + irCol + '">' + (h.inRangePct > 0 ? fmt(h.inRangePct, 0) + '%' : '-') + '</td>';
        html += '<td style="padding:4px"><div style="height:10px;background:' + feeCol + ';width:' + barW + '%;border-radius:2px;min-width:' + (h.fees > 0 ? '2px' : '0') + '"></div></td>';
        html += '</tr>';
      });

      html += '</tbody></table>';
      tableDiv.innerHTML = html;

      // Build events table
      if (d.events && d.events.length > 0) {
        var eHtml = '<table style="width:100%;border-collapse:collapse;font-size:11px">';
        eHtml += '<thead><tr><th style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d">Time</th>';
        eHtml += '<th style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d">Event</th>';
        eHtml += '<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d">Price</th>';
        eHtml += '<th style="text-align:right;padding:4px;color:#8b949e;border-bottom:1px solid #30363d">Fees</th>';
        eHtml += '<th style="text-align:left;padding:4px;color:#8b949e;border-bottom:1px solid #30363d">Note</th></tr></thead><tbody>';
        var evtColors = { POSITION_OPENED: '#22c55e', POSITION_CLOSED: '#8b949e', T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
          OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308', FEE_HARVEST: '#ffd700', AUTO_DEPLOY: '#58a6ff',
          REGIME_CHANGE: '#a855f7', PULLBACK_REENTRY: '#22c55e', LIQUIDITY_ADDED: '#58a6ff', PRICE_UPDATE: '#8b949e' };
        d.events.forEach(function(e) {
          var t = new Date(e.timestamp).toLocaleTimeString('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
          var ec = evtColors[e.event_type] || '#8b949e';
          var feeTot = (e.fee_sol || 0) * e.price + (e.fee_usdc || 0);
          var noteShort = (e.note || '').split('\\n')[0].slice(0, 80);
          eHtml += '<tr style="border-bottom:1px solid #21262d">';
          eHtml += '<td style="padding:3px 4px;white-space:nowrap">' + t + '</td>';
          eHtml += '<td style="padding:3px 4px;color:' + ec + ';font-weight:bold;white-space:nowrap">' + e.event_type + '</td>';
          eHtml += '<td style="padding:3px 4px;text-align:right">$' + Number(e.price).toFixed(2) + '</td>';
          eHtml += '<td style="padding:3px 4px;text-align:right;color:#ffd700">' + (feeTot > 0 ? '$' + feeTot.toFixed(4) : '-') + '</td>';
          eHtml += '<td style="padding:3px 4px;color:#8b949e;font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + noteShort + '</td>';
          eHtml += '</tr>';
        });
        eHtml += '</tbody></table>';
        eventsDiv.innerHTML = eHtml;
      } else {
        eventsDiv.innerHTML = '<div style="color:#8b949e;font-size:11px">No events for this day</div>';
      }
    }).catch(function() { tableDiv.innerHTML = '<div style="color:#ef4444">Failed to load</div>'; });
  }

  select.addEventListener('change', function() { loadDay(this.value); });
  loadDay(today);

  // Auto-refresh at the top of every hour
  var now = new Date();
  var msToNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000;
  setTimeout(function() {
    loadDay(select.value);
    setInterval(function() { loadDay(select.value); }, 3600000);
  }, msToNextHour);
})();
</script>
</div>

<div id="sec-positions">
${(() => {
  // Build position history from rebalance events: pair opens with closes
  const closeTypes = new Set(['T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'POSITION_CLOSED']);
  const allEvents = data.events.slice().sort((a, b) => a.timestamp - b.timestamp);

  interface PositionRecord {
    openTime: number; closeTime: number; duration: number;
    entryPrice: number; closePrice: number;
    range: string; closeReason: string;
    feeSol: number; feeUsdc: number; feeTotalUsdc: number;
    il: number; regime: string;
    capitalInvested: number;
  }
  const positions: PositionRecord[] = [];
  let lastOpen: { timestamp: number; price: number; note: string; capitalInvested: number } | null = null;

  for (const e of allEvents) {
    if (e.eventType === 'POSITION_OPENED') {
      // Capital invested = wallet value before - wallet value after open
      const capBefore = (e.solBefore ?? 0) * e.price + (e.usdcBefore ?? 0);
      const capAfter = (e.solAfter ?? 0) * e.price + (e.usdcAfter ?? 0);
      lastOpen = { timestamp: e.timestamp, price: e.price, note: e.note, capitalInvested: Math.max(0, capBefore - capAfter) };
    } else if (closeTypes.has(e.eventType) && lastOpen) {
      const rangeMatch = (e.note || '').match(/Range was \$([\d.]+).*?\$([\d.]+)/);
      const range = rangeMatch ? `$${rangeMatch[1]}-$${rangeMatch[2]}` : '--';
      positions.push({
        openTime: lastOpen.timestamp,
        closeTime: e.timestamp,
        duration: e.timestamp - lastOpen.timestamp,
        entryPrice: lastOpen.price,
        closePrice: e.price,
        range,
        closeReason: e.eventType,
        feeSol: e.feeSol ?? 0,
        feeUsdc: e.feeUsdc ?? 0,
        feeTotalUsdc: (e.feeSol ?? 0) * e.price + (e.feeUsdc ?? 0),
        il: e.ilAtClose ?? 0,
        regime: e.regime,
        capitalInvested: lastOpen.capitalInvested,
      });
      lastOpen = null;
    }
  }

  const recent = positions.slice(-10).reverse();
  if (recent.length === 0) return '<div class="card" style="margin-bottom:16px"><h2>Position History</h2><div style="color:#8b949e;text-align:center;padding:20px">No closed positions yet</div></div>';

  const totalFees = recent.reduce((s, p) => s + p.feeTotalUsdc, 0);
  const totalIl = recent.reduce((s, p) => s + p.il, 0);
  const avgDuration = recent.reduce((s, p) => s + p.duration, 0) / recent.length;
  const avgDurMin = Math.floor(avgDuration / 60_000);
  const avgDurStr = avgDurMin >= 60 ? `${Math.floor(avgDurMin / 60)}h ${avgDurMin % 60}m` : `${avgDurMin}m`;

  const reasonColors: Record<string, string> = {
    T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
    OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308',
    POSITION_CLOSED: '#8b949e',
  };

  const totalCapital = recent.reduce((s, p) => s + p.capitalInvested, 0);
  const avgRoR = totalCapital > 0 ? ((totalFees + totalIl) / totalCapital * 100) : 0;

  const rows = recent.map(p => {
    const openT = new Date(p.openTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
    const durMin = Math.floor(p.duration / 60_000);
    const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`;
    const net = p.feeTotalUsdc + p.il;
    const netCol = net >= 0 ? '#22c55e' : '#ef4444';
    const reasonCol = reasonColors[p.closeReason] ?? '#8b949e';
    const ror = p.capitalInvested > 0 ? (net / p.capitalInvested * 100) : 0;
    const rorAnn = p.duration > 0 && p.capitalInvested > 0 ? (net / p.capitalInvested) * (365 * 24 * 3600_000 / p.duration) * 100 : 0;
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:4px 6px;color:#8b949e;font-size:10px;white-space:nowrap">${openT}</td>
      <td style="padding:4px 6px;text-align:right">${durStr}</td>
      <td style="padding:4px 6px;text-align:right;font-size:10px;color:#8b949e">${p.range}</td>
      <td style="padding:4px 6px;text-align:right;color:#58a6ff">$${fmt(p.capitalInvested, 0)}</td>
      <td style="padding:4px 6px;text-align:right;color:#22c55e">$${fmt(p.feeTotalUsdc, 4)}</td>
      <td style="padding:4px 6px;text-align:right;color:${p.il < 0 ? '#ef4444' : '#22c55e'}">${p.il < 0 ? '-' : '+'}$${fmt(Math.abs(p.il), 4)}</td>
      <td style="padding:4px 6px;text-align:right;color:${netCol};font-weight:bold">${net >= 0 ? '+' : '-'}$${fmt(Math.abs(net), 4)}</td>
      <td style="padding:4px 6px;text-align:right;color:${ror >= 0 ? '#22c55e' : '#ef4444'};font-size:10px">${ror >= 0 ? '+' : ''}${fmt(ror, 3)}%</td>
      <td style="padding:4px 6px"><span class="badge" style="background:${reasonCol}20;color:${reasonCol};font-size:9px">${p.closeReason.replace('_', ' ')}</span></td>
    </tr>`;
  }).join('');

  return `<div class="card" style="margin-bottom:16px">
  <h2>Position History <span style="color:#8b949e;font-size:12px;font-weight:normal">| ${recent.length} positions | Avg: ${avgDurStr} | Capital: $${fmt(totalCapital, 0)} | Fees: $${fmt(totalFees, 2)} | IL: $${fmt(Math.abs(totalIl), 2)} | Net: <span style="color:${totalFees + totalIl >= 0 ? '#22c55e' : '#ef4444'}">${totalFees + totalIl >= 0 ? '+' : '-'}$${fmt(Math.abs(totalFees + totalIl), 2)}</span> | RoR: <span style="color:${avgRoR >= 0 ? '#22c55e' : '#ef4444'}">${avgRoR >= 0 ? '+' : ''}${fmt(avgRoR, 3)}%</span></span></h2>
  <div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:11px">
    <tr style="border-bottom:1px solid #30363d">
      <th style="text-align:left;padding:4px 6px;color:#8b949e">Opened</th>
      <th style="text-align:right;padding:4px 6px;color:#8b949e">Duration</th>
      <th style="text-align:right;padding:4px 6px;color:#8b949e">Range</th>
      <th style="text-align:right;padding:4px 6px;color:#58a6ff">Capital</th>
      <th style="text-align:right;padding:4px 6px;color:#22c55e">Fees</th>
      <th style="text-align:right;padding:4px 6px;color:#ef4444">IL</th>
      <th style="text-align:right;padding:4px 6px;color:#eab308">Net</th>
      <th style="text-align:right;padding:4px 6px;color:#8b949e">RoR</th>
      <th style="text-align:left;padding:4px 6px;color:#8b949e">Exit</th>
    </tr>
    ${rows}
  </table>
  </div>
</div>`;
})()}

</div>
<div id="sec-signals"><div class="section-title">Market Signals (Enhanced Regime)</div>
<div class="card" style="margin-bottom:16px" id="market-signals-card">
  <div style="color:#8b949e;font-size:12px">Loading market signals...</div>
</div>
<script>
(function() {
  Promise.all([
    fetch('/api/market-signals').then(r => r.json()),
    fetch('/api/decisions?limit=20').then(r => r.json())
  ]).then(([s, decisions]) => {
    const card = document.getElementById('market-signals-card');
    if (!card) return;
    if (!s) { card.innerHTML = '<div style="color:#8b949e;font-size:12px">No market data available yet.</div>'; return; }
    const fmt = (v, d) => v != null ? Number(v).toFixed(d) : 'n/a';
    const pct = (v) => v != null ? (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%' : 'n/a';
    const col = (v) => v == null ? '#8b949e' : v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#c9d1d9';
    const volCol = (v, t) => v == null ? '#8b949e' : v > t ? '#ef4444' : v > t * 0.7 ? '#eab308' : '#22c55e';
    const fgCol = (v) => v == null ? '#8b949e' : v < 25 ? '#ef4444' : v < 40 ? '#eab308' : v > 75 ? '#22c55e' : v > 60 ? '#22c55e' : '#c9d1d9';
    const age = s.lastUpdated ? Math.floor((Date.now() - s.lastUpdated) / 60000) : '?';

    // Extract base regime data from last REGIME_EVAL decision
    var base = null;
    if (decisions && Array.isArray(decisions)) {
      var evalD = decisions.find(d => (d.decision === 'REGIME_EVAL' || d.decision === 'REGIME_CHANGE') && d.params_json);
      if (evalD && evalD.params_json) {
        try { base = JSON.parse(evalD.params_json); } catch(e) {}
      }
    }

    const regimeColors = { RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7' };
    const dirCol = base ? (base.dirRatio > 0.35 ? '#eab308' : '#22c55e') : '#8b949e';
    const dailyVolCol = base ? (base.realisedVol > 0.08 ? '#ef4444' : base.realisedVol > 0.05 ? '#eab308' : '#22c55e') : '#8b949e';
    const baseCol = base ? (regimeColors[base.baseRegime] || '#8b949e') : '#8b949e';
    const finalRegime = base ? (base.overrideReason ? 'OVERRIDDEN' : base.baseRegime) : null;

    card.innerHTML = \`
      <div style="font-size:11px;color:#58a6ff;font-weight:bold;margin-bottom:6px">Base Regime (Daily Closes)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;font-size:12px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #21262d">
        <div><span style="color:#8b949e">Base Regime</span><br><span style="font-size:16px;font-weight:bold;color:\${baseCol}">\${base ? base.baseRegime : 'n/a'}</span></div>
        <div><span style="color:#8b949e">Dir Ratio</span><br><span style="font-size:16px;font-weight:bold;color:\${dirCol}">\${base ? fmt(base.dirRatio, 4) : 'n/a'}</span><br><span style="font-size:9px;color:#555">\${base && base.dirRatio > 0.35 ? '> 0.35 → trending' : '< 0.35 → ranging'}</span></div>
        <div><span style="color:#8b949e">Daily Vol</span><br><span style="font-size:16px;font-weight:bold;color:\${dailyVolCol}">\${base ? fmt(base.realisedVol, 4) : 'n/a'}</span><br><span style="font-size:9px;color:#555">\${base && base.realisedVol > 0.08 ? '> 0.08 → EXTREME' : 'normal'}</span></div>
        <div><span style="color:#8b949e">Daily Closes</span><br><span style="font-size:16px;font-weight:bold;color:#c9d1d9">\${base ? base.priceCount : 'n/a'}</span><br><span style="font-size:9px;color:#555">over \${base ? base.trendThreshold : '?'} threshold</span></div>
      </div>
      <div style="font-size:11px;color:#58a6ff;font-weight:bold;margin-bottom:6px">Market Signals (Overrides)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;font-size:12px">
        <div><span style="color:#8b949e">Vol 1h</span><br><span style="font-size:16px;font-weight:bold;color:\${volCol(s.vol1h, 0.06)}">\${fmt(s.vol1h, 4)}</span><br><span style="font-size:9px;color:#555">\${s.vol1h > 0.06 ? '→ EXTREME' : 'calm'}</span></div>
        <div><span style="color:#8b949e">Vol 4h</span><br><span style="font-size:16px;font-weight:bold;color:\${volCol(s.vol4h, 0.05)}">\${fmt(s.vol4h, 4)}</span><br><span style="font-size:9px;color:#555">\${s.vol4h > 0.05 ? '→ EXTREME' : 'calm'}</span></div>
        <div><span style="color:#8b949e">SOL 24h</span><br><span style="font-size:16px;font-weight:bold;color:\${col(s.solDelta24h)}">\${pct(s.solDelta24h)}</span><br><span style="font-size:9px;color:#555">\${s.solDelta24h && Math.abs(s.solDelta24h) > 4 ? '→ trend override' : 'no override'}</span></div>
        <div><span style="color:#8b949e">BTC 24h</span><br><span style="font-size:16px;font-weight:bold;color:\${col(s.btcDelta24h)}">\${pct(s.btcDelta24h)}</span><br><span style="font-size:9px;color:#555">\${s.btcDelta24h && Math.abs(s.btcDelta24h) > 3 ? 'macro event' : 'no macro'}</span></div>
        <div><span style="color:#8b949e">Vol Ratio</span><br><span style="font-size:16px;font-weight:bold;color:\${s.volumeRatio4h > 3 ? '#ef4444' : s.volumeRatio4h > 2 ? '#eab308' : '#c9d1d9'}">\${s.volumeRatio4h != null ? fmt(s.volumeRatio4h, 1) + 'x' : 'n/a'}</span><br><span style="font-size:9px;color:#555">\${s.volumeRatio4h > 3 ? 'SPIKE' : s.volumeRatio4h > 2 ? 'elevated' : 'normal'}</span></div>
        <div><span style="color:#8b949e">SOL Vol 24h</span><br><span style="font-size:16px;font-weight:bold;color:#c9d1d9">\${s.solVolume24h != null ? '$' + (s.solVolume24h / 1e6).toFixed(0) + 'M' : 'n/a'}</span></div>
        <div><span style="color:#8b949e">Fear & Greed</span><br><span style="font-size:16px;font-weight:bold;color:\${fgCol(s.fearGreedIndex)}">\${s.fearGreedIndex != null ? s.fearGreedIndex + ' (' + (s.fearGreedLabel || '') + ')' : 'n/a'}</span></div>
        <div><span style="color:#8b949e">Confidence</span><br><span style="font-size:16px;font-weight:bold;color:\${base && base.confidence >= 3 ? '#22c55e' : base && base.confidence >= 2 ? '#eab308' : '#8b949e'}">\${base ? base.confidence + '/5' : 'n/a'}</span></div>
      </div>
      \${s.ta ? \`
      <div style="font-size:11px;color:#ffd700;font-weight:bold;margin-top:12px;margin-bottom:6px">Technical Analysis (30min candles)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;font-size:12px">
        <div><span style="color:#8b949e">RSI(14)</span><br><span style="font-size:16px;font-weight:bold;color:\${s.ta.rsi14 > 70 ? '#ef4444' : s.ta.rsi14 < 30 ? '#22c55e' : '#c9d1d9'}">\${s.ta.rsi14 != null ? fmt(s.ta.rsi14, 0) : 'n/a'}</span><br><span style="font-size:9px;color:#555">\${s.ta.rsi14 > 70 ? 'overbought' : s.ta.rsi14 < 30 ? 'oversold' : 'neutral'}</span></div>
        <div><span style="color:#8b949e">BB Width</span><br><span style="font-size:16px;font-weight:bold;color:\${s.ta.bbWidth > 3 ? '#ef4444' : s.ta.bbWidth < 1 ? '#22c55e' : '#c9d1d9'}">\${s.ta.bbWidth != null ? fmt(s.ta.bbWidth, 1) + '%' : 'n/a'}</span><br><span style="font-size:9px;color:#555">\${s.ta.bbWidth > 3 ? 'expansion' : s.ta.bbWidth < 1 ? 'squeeze' : 'normal'}</span></div>
        <div><span style="color:#8b949e">Trend</span><br><span style="font-size:16px;font-weight:bold;color:\${s.ta.trendDirection === 'UP' ? '#22c55e' : s.ta.trendDirection === 'DOWN' ? '#ef4444' : '#c9d1d9'}">\${s.ta.trendDirection || 'n/a'}</span><br><span style="font-size:9px;color:#555">EMA9 vs SMA20</span></div>
        <div><span style="color:#8b949e">ATR(14)</span><br><span style="font-size:16px;font-weight:bold;color:#c9d1d9">\${s.ta.atr14 != null ? '$' + fmt(s.ta.atr14, 2) : 'n/a'}</span><br><span style="font-size:9px;color:#555">avg range/candle</span></div>
        <div><span style="color:#8b949e">Support</span><br><span style="font-size:16px;font-weight:bold;color:#22c55e">\${s.ta.support != null ? '$' + fmt(s.ta.support, 2) : 'n/a'}</span></div>
        <div><span style="color:#8b949e">Resistance</span><br><span style="font-size:16px;font-weight:bold;color:#ef4444">\${s.ta.resistance != null ? '$' + fmt(s.ta.resistance, 2) : 'n/a'}</span></div>
        <div><span style="color:#8b949e">BB Position</span><br><span style="font-size:16px;font-weight:bold;color:\${s.ta.bbPosition > 0.8 ? '#ef4444' : s.ta.bbPosition < 0.2 ? '#22c55e' : '#c9d1d9'}">\${s.ta.bbPosition != null ? (s.ta.bbPosition * 100).toFixed(0) + '%' : 'n/a'}</span><br><span style="font-size:9px;color:#555">0=lower 100=upper</span></div>
        <div><span style="color:#8b949e">vs SMA20</span><br><span style="font-size:16px;font-weight:bold;color:\${col(s.ta.priceVsSma)}">\${s.ta.priceVsSma != null ? pct(s.ta.priceVsSma) : 'n/a'}</span><br><span style="font-size:9px;color:#555">mean reversion</span></div>
      </div>
      \` : ''}
      \${base && base.overrideReason ? '<div style="margin-top:8px;padding:6px 10px;background:#ef444415;border-left:3px solid #ef4444;border-radius:0 4px 4px 0;font-size:11px;color:#ef4444"><b>Override:</b> ' + base.overrideReason + '</div>' : ''}
      <div style="margin-top:8px;font-size:10px;color:#8b949e">Updated \${age}m ago\${s.errors && s.errors.length > 0 ? ' · Errors: ' + s.errors.join(', ') : ''}</div>
      <div id="mkt-commentary" style="margin-top:12px;padding:10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-size:12px;line-height:1.6;color:#c9d1d9"></div>
    \`;

    // Build commentary
    var c = document.getElementById('mkt-commentary');
    if (!c) return;
    var parts = [];

    // Volatility
    if (s.vol1h != null && s.vol4h != null) {
      if (s.vol1h > 0.06) parts.push('⚡ <b style="color:#ef4444">High short-term volatility</b> — 1h vol ' + fmt(s.vol1h, 4) + ' exceeds the 0.06 EXTREME threshold. Market is very active. Expect frequent position exits and rebalancing. Fee income should be high but IL risk is elevated.');
      else if (s.vol1h > 0.04) parts.push('🟡 <b style="color:#eab308">Elevated volatility</b> — 1h vol ' + fmt(s.vol1h, 4) + ' approaching the 0.06 threshold. Market is active but not extreme. Good fee conditions with moderate risk.');
      else if (s.vol4h > 0.03) parts.push('📊 <b>Moderate medium-term volatility</b> — 4h vol ' + fmt(s.vol4h, 4) + ' suggests sustained price movement over the past week. Positions may need wider ranges.');
      else parts.push('😴 <b style="color:#22c55e">Low volatility</b> — both 1h (' + fmt(s.vol1h, 4) + ') and 4h (' + fmt(s.vol4h, 4) + ') vol are calm. Market is quiet — fee income will be low but positions are stable. Good conditions for tight ranges.');
    }

    // SOL direction
    if (s.solDelta24h != null) {
      var solD = Number(s.solDelta24h);
      if (solD < -4) parts.push('📉 <b style="color:#ef4444">SOL in strong downtrend</b> (' + pct(solD) + ' in 24h). The bot should be in BEARISH regime with wider range and fast fee harvesting. Idle capital converting to USDC for protection.');
      else if (solD < -2) parts.push('📉 <b style="color:#eab308">SOL drifting lower</b> (' + pct(solD) + ' in 24h). Mild bearish pressure — current position may drift toward lower bound. Watch proximity.');
      else if (solD > 4) parts.push('📈 <b style="color:#22c55e">SOL in strong uptrend</b> (' + pct(solD) + ' in 24h). High trading volume generating fees. Position may need upward rebalancing.');
      else if (solD > 2) parts.push('📈 <b style="color:#22c55e">SOL pushing higher</b> (' + pct(solD) + ' in 24h). Moderate bullish momentum — good fee conditions with upward price pressure.');
      else parts.push('↔️ <b>SOL flat</b> (' + pct(solD) + ' in 24h). Ranging market — fee income depends on trading volume, not price direction.');
    }

    // BTC correlation
    if (s.btcDelta24h != null && s.solDelta24h != null) {
      var btcD = Number(s.btcDelta24h);
      var solD2 = Number(s.solDelta24h);
      if (Math.abs(btcD) > 3) {
        var same = (btcD > 0) === (solD2 > 0);
        if (same) parts.push('🔗 <b>BTC macro move confirmed</b> — BTC ' + pct(btcD) + ' in same direction as SOL. This is a crypto-wide move, not SOL-specific. Higher conviction in the current trend.');
        else parts.push('🔀 <b>SOL diverging from BTC</b> — BTC ' + pct(btcD) + ' but SOL going the other way. SOL-specific dynamics at play. Be cautious — divergences can reverse.');
      } else if (Math.abs(btcD) > 1) {
        parts.push('🪙 BTC ' + pct(btcD) + ' — moderate move, not a macro event (needs >±3% to trigger). SOL broadly following crypto market.');
      }
    }

    // Volume
    if (s.volumeRatio4h != null) {
      var vr = Number(s.volumeRatio4h);
      if (vr > 3) parts.push('🔊 <b style="color:#ef4444">Volume spike!</b> ' + fmt(vr, 1) + 'x above 7-day average. High trading activity = high fee potential. Volume spikes often accompany trending moves.');
      else if (vr > 2) parts.push('📊 <b style="color:#eab308">Elevated volume</b> — ' + fmt(vr, 1) + 'x above average. Above-normal trading activity supporting fee generation.');
      else if (vr < 0.5) parts.push('🔇 <b>Very low volume</b> — ' + fmt(vr, 1) + 'x (half of average). Fee income will be significantly reduced. Typical for weekends or low-interest periods.');
      else if (vr < 0.8) parts.push('📉 <b>Below-average volume</b> — ' + fmt(vr, 1) + 'x of 7-day average. Fee income lower than usual.');
      else parts.push('📊 Volume is near average (' + fmt(vr, 1) + 'x). Normal trading conditions.');
    }

    // Fear & Greed
    if (s.fearGreedIndex != null) {
      var fg = Number(s.fearGreedIndex);
      if (fg < 15) parts.push('😱 <b style="color:#ef4444">Extreme fear</b> (F&G ' + fg + '/100). Markets are panicking. Historical pattern: extreme fear often precedes bottoms, but can persist for days. Bot should be in defensive mode — USDC-heavy wallet, fast harvesting.');
      else if (fg < 25) parts.push('😨 <b style="color:#ef4444">Strong fear</b> (F&G ' + fg + '/100). Bearish sentiment dominates. Traders are selling. SOL likely under pressure. Defensive positioning is correct.');
      else if (fg < 40) parts.push('😟 <b style="color:#eab308">Fear</b> (F&G ' + fg + '/100). Cautious market. Not panic but not confident. Watch for sentiment shift.');
      else if (fg > 85) parts.push('🤑 <b style="color:#22c55e">Extreme greed</b> (F&G ' + fg + '/100). Euphoria in the market. Historically signals a top. Consider tightening stops.');
      else if (fg > 75) parts.push('😊 <b style="color:#22c55e">Strong greed</b> (F&G ' + fg + '/100). Bullish sentiment. Market is confident. Good for fee generation but watch for reversals.');
      else if (fg > 60) parts.push('🙂 <b>Moderate optimism</b> (F&G ' + fg + '/100). Healthy sentiment. Market is neither fearful nor euphoric.');
      else parts.push('😐 <b>Neutral sentiment</b> (F&G ' + fg + '/100). Market is balanced — no strong directional bias from sentiment.');
    }

    // Overall assessment
    var overall = '';
    var vol = s.vol1h != null ? Number(s.vol1h) : 0;
    var sol = s.solDelta24h != null ? Number(s.solDelta24h) : 0;
    var fg2 = s.fearGreedIndex != null ? Number(s.fearGreedIndex) : 50;
    var vr2 = s.volumeRatio4h != null ? Number(s.volumeRatio4h) : 1;

    if (vol > 0.06 && Math.abs(sol) > 4) overall = '🔴 <b style="color:#ef4444">DANGER</b> — High volatility + strong directional move. Maximum defensive positioning. Expect frequent rebalancing and IL.';
    else if (fg2 < 20 && sol < -2) overall = '🟠 <b style="color:#f97316">CAUTIOUS</b> — Fear + SOL dropping. Bearish regime is protecting capital. Harvest frequently, keep USDC-heavy.';
    else if (vol < 0.003 && vr2 < 0.7 && Math.abs(sol) < 1) overall = '💤 <b style="color:#8b949e">QUIET</b> — Very low volatility + low volume + flat price. Minimal fee income. Position is safe but not earning much. Wait for volume to return.';
    else if (vol < 0.005 && Math.abs(sol) < 2) overall = '🟢 <b style="color:#22c55e">STABLE</b> — Low vol, mild price movement. Good for steady fee accumulation. Position should stay in range.';
    else if (sol > 3 && vr2 > 1.5) overall = '🟢 <b style="color:#22c55e">BULLISH MOMENTUM</b> — SOL rising with above-average volume. Strong fee conditions. Watch for regime shift to BULLISH if it persists.';
    else overall = '🔵 <b style="color:#58a6ff">NORMAL</b> — Mixed signals, no extreme conditions. Bot is operating in standard mode.';

    c.innerHTML = '<div style="margin-bottom:10px;padding:8px;background:#161b2280;border-radius:4px;font-size:13px">' + overall + '</div>' + parts.map(function(p) { return '<div style="margin-bottom:6px">' + p + '</div>'; }).join('');
  }).catch(() => {});

  // No auto-refresh for insights page (server-rendered, would need full rebuild)
  // User can refresh manually. Telegram reports every 20min with live commentary.
})();
</script>

</div>
<div id="sec-inrange"><div class="section-title">In-Range Performance</div>
<div class="gauge-row">
  <div class="card">${gauge(data.inRangePct1h, 'Last 1 Hour')}</div>
  <div class="card">${gauge(data.inRangePct24h, 'Last 24 Hours')}</div>
  <div class="card">${gauge(data.inRangePctAll, 'All Time')}</div>
</div>

</div>
<div id="sec-regime"><div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Regime Changes</div>
<div class="card" style="margin-bottom:16px">
  ${regimeCards}
</div>

</div>
<div id="sec-events"><div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Event Log <span style="font-size:11px;color:#8b949e;font-weight:normal">(last 10 — <a href="/api/events" target="_blank" style="color:#58a6ff">download full log</a>)</span></div>
${data.events.slice(0, 10).length > 0 ? data.events.slice(0, 10).map(e => {
    const t = new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
    const typeColors: Record<string, string> = {
      POSITION_OPENED: '#22c55e', POSITION_CLOSED: '#ef4444',
      T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308',
      PULLBACK_REENTRY: '#22c55e', PULLBACK_TIMEOUT: '#a855f7',
      FEE_HARVEST: '#58a6ff', CIRCUIT_BREAKER: '#ef4444',
      REGIME_CHANGE: '#a855f7', LIQUIDITY_ADDED: '#22c55e',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span style="color:#8b949e;font-size:11px">${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div style="font-size:12px;color:#c9d1d9;line-height:1.5">${escHtml(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
      ${e.solBefore || e.usdcBefore || e.solAfter || e.usdcAfter ? `<div style="font-size:11px;color:#8b949e;border-top:1px solid #21262d;padding-top:6px;margin-top:6px">Before: ${fmt(e.solBefore, 4)} SOL / ${fmt(e.usdcBefore, 2)} USDC &rarr; After: ${fmt(e.solAfter, 4)} SOL / ${fmt(e.usdcAfter, 2)} USDC</div>` : ''}
    </div>`;
  }).join('') : '<div class="card" style="text-align:center;color:#8b949e;padding:20px">No events yet</div>'}

${(() => {
  // Detect capital injections from 7d snapshots
  const injections: Array<{ timestamp: number; amount: number; solDelta: number; usdcDelta: number; price: number }> = [];
  for (let i = 1; i < data.snapshots7d.length; i++) {
    const prev = data.snapshots7d[i - 1];
    const curr = data.snapshots7d[i];
    const p = curr.price;
    const prevVal = ((prev.sol_balance ?? 0) + (prev.position_sol ?? 0)) * p + (prev.usdc_balance ?? 0) + (prev.position_usdc ?? 0);
    const currVal = ((curr.sol_balance ?? 0) + (curr.position_sol ?? 0)) * p + (curr.usdc_balance ?? 0) + (curr.position_usdc ?? 0);
    const increase = currVal - prevVal;
    if (increase > 20) {
      const solDelta = ((curr.sol_balance ?? 0) + (curr.position_sol ?? 0)) - ((prev.sol_balance ?? 0) + (prev.position_sol ?? 0));
      const usdcDelta = ((curr.usdc_balance ?? 0) + (curr.position_usdc ?? 0)) - ((prev.usdc_balance ?? 0) + (prev.position_usdc ?? 0));
      injections.push({ timestamp: curr.timestamp, amount: increase, solDelta, usdcDelta, price: p });
    }
  }
  const totalInjected = injections.reduce((s, inj) => s + inj.amount, 0);

  if (injections.length === 0) return '';

  const rows = injections.map(inj => {
    const t = new Date(inj.timestamp).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const details: string[] = [];
    if (inj.solDelta > 0.01) details.push(`${fmt(inj.solDelta, 4)} SOL ($${fmt(inj.solDelta * inj.price)})`);
    if (inj.usdcDelta > 0.5) details.push(`$${fmt(inj.usdcDelta)} USDC`);
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:5px 6px;white-space:nowrap;font-size:11px;color:#8b949e">${t}</td>
      <td style="padding:5px 6px;text-align:right;color:#a855f7;font-weight:bold">$${fmt(inj.amount, 2)}</td>
      <td style="padding:5px 6px;font-size:11px;color:#8b949e">${details.join(' + ')}</td>
    </tr>`;
  }).join('');

  return `
<div style="font-size:14px;color:#a855f7;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Capital Injections</div>
<div class="card" style="margin-bottom:16px">
  <div style="display:flex;gap:16px;margin-bottom:10px;font-size:12px">
    <span><span style="color:#8b949e">Total injected:</span> <b style="color:#a855f7">$${fmt(totalInjected, 2)}</b></span>
    <span><span style="color:#8b949e">Transfers:</span> <b>${injections.length}</b></span>
  </div>
  <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:5px 6px;color:#8b949e;border-bottom:1px solid #30363d">Time</th>
      <th style="text-align:right;padding:5px 6px;color:#8b949e;border-bottom:1px solid #30363d">Amount</th>
      <th style="text-align:left;padding:5px 6px;color:#8b949e;border-bottom:1px solid #30363d">Details</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
})()}

</div>
<div id="sec-txs"><div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">On-Chain Transactions (last 10)</div>
<div class="card" style="margin-bottom:16px">
${data.recentTxs.length > 0 ? `
  ${(() => {
    const totalFee = data.recentTxs.reduce((s: number, tx: OnChainTx) => s + tx.fee, 0);
    const totalFeeSol = totalFee / 1e9;
    const totalFeeUsdc = data.recentTxs.reduce((s: number, tx: OnChainTx) => s + tx.feeUsdc, 0);
    const avgFee = totalFee / data.recentTxs.length;
    const okCount = data.recentTxs.filter((tx: OnChainTx) => tx.status === 'OK').length;
    return `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
      <div><span style="color:#8b949e">Total gas (${data.recentTxs.length} txs):</span> <b style="color:#ef4444">${totalFeeSol.toFixed(6)} SOL ($${totalFeeUsdc.toFixed(4)})</b></div>
      <div><span style="color:#8b949e">Avg/tx:</span> <b>${(avgFee / 1e9).toFixed(6)} SOL ($${(totalFeeUsdc / data.recentTxs.length).toFixed(4)})</b></div>
      <div><span style="color:#8b949e">Success:</span> <b style="color:${okCount === data.recentTxs.length ? '#22c55e' : '#eab308'}">${okCount}/${data.recentTxs.length}</b></div>
    </div>`;
  })()}
  <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Time</th>
        <th style="text-align:right;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Gas (SOL)</th>
        <th style="text-align:right;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Gas ($)</th>
        <th style="text-align:right;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">CU</th>
        <th style="text-align:center;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Status</th>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">TX</th>
      </tr>
    </thead>
    <tbody>
      ${data.recentTxs.map((tx: OnChainTx) => `
        <tr>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d;white-space:nowrap;font-size:11px">${tx.time}</td>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d;text-align:right;color:#ef4444;font-family:monospace;font-size:11px">${tx.feeSol.toFixed(6)}</td>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e;font-family:monospace;font-size:11px">$${tx.feeUsdc.toFixed(4)}</td>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e;font-size:10px">${tx.computeUnits > 0 ? (tx.computeUnits / 1000).toFixed(0) + 'K' : '-'}</td>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d;text-align:center"><span style="color:${tx.status === 'OK' ? '#22c55e' : '#ef4444'};font-size:11px">${tx.status}</span></td>
          <td style="padding:5px 4px;border-bottom:1px solid #21262d"><a href="https://solscan.io/tx/${tx.signature}" target="_blank" style="color:#58a6ff;text-decoration:none;font-family:monospace;font-size:10px">${tx.signature.slice(0, 12)}...</a></td>
        </tr>
      `).join('')}
    </tbody>
  </table></div>
  <div style="font-size:11px;color:#8b949e;margin-top:8px;text-align:right">
    <a href="https://solscan.io/account/Evga86Xco1D5XCeSF2T3Ff8DsJAhr2SoaVrPWALoLU6z" target="_blank" style="color:#58a6ff;text-decoration:none">View all on Solscan &rarr;</a>
  </div>
` : '<div style="color:#8b949e;text-align:center;padding:16px">No transactions found</div>'}
</div>

</div>
<div id="sec-swappnl"><div class="section-title">Swap P&amp;L Tracker</div>
<div class="card" style="margin-bottom:16px">
  <div id="swap-pnl-container"><div style="color:#8b949e;text-align:center;padding:20px">Loading swap data...</div></div>
</div>
<script>
(function() {
  var TZ = 'Europe/Berlin';
  function sfmt(n, d) { return n != null ? Number(n).toFixed(d != null ? d : 2) : '--'; }

  Promise.all([fetch('/api/swap-ledger').then(function(r) { return r.json(); }), fetch('/api/live').then(function(r) { return r.json(); }).catch(function() { return null; })]).then(function(results) {
    var data = results[0]; var live = results[1];
    var c = document.getElementById('swap-pnl-container');
    if (!c) return;
    if (!data.swaps || data.swaps.length === 0) {
      c.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px">No swaps recorded yet. Swaps will appear here when the bot rebalances.</div>';
      return;
    }
    var globalBasis = live && live.solCostBasis > 0 ? live.solCostBasis : 0;
    var walletSol = live && live.solBalance > 0 ? live.solBalance : 0;
    var solPrice = live && live.solPrice > 0 ? live.solPrice : 0;
    var unrealised = globalBasis > 0 && walletSol > 0 && solPrice > 0 ? (solPrice - globalBasis) * walletSol : null;
    var basisHeaderHtml = '';
    if (globalBasis > 0) {
      var unrStr = unrealised != null ? ((unrealised >= 0 ? '+' : '') + unrealised.toFixed(2)) : '—';
      var unrCol = unrealised != null ? (unrealised >= 0 ? '#22c55e' : '#ef4444') : '#8b949e';
      basisHeaderHtml = '<div style="font-size:11px;margin-bottom:10px;padding:7px 10px;background:#0d1117;border:1px solid #21262d;border-radius:6px">'
        + '<span style="color:#8b949e">Current SOL Avg Basis: </span><span style="color:#c9d1d9;font-weight:bold">$' + globalBasis.toFixed(2) + '</span>'
        + (walletSol > 0 ? ' <span style="color:#8b949e;margin-left:8px">| Wallet: </span><span style="color:#c9d1d9">' + walletSol.toFixed(1) + ' SOL</span>' : '')
        + (unrealised != null ? ' <span style="color:#8b949e;margin-left:8px">| Unrealised: </span><span style="color:' + unrCol + ';font-weight:bold">' + unrStr + '</span>' : '')
        + '</div>';
    }

    var s = data.summary;
    var pnlCount = s.profitable + s.unprofitable;
    var winRate = pnlCount > 0 ? (s.profitable / pnlCount * 100) : 0;
    var totalPnlCol = s.totalPnl >= 0 ? '#22c55e' : '#ef4444';
    var wrCol = winRate >= 50 ? '#22c55e' : '#ef4444';

    var html = basisHeaderHtml + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px;margin-bottom:14px">';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:' + totalPnlCol + '">' + (s.totalPnl >= 0 ? '+' : '') + '$' + sfmt(Math.abs(s.totalPnl), 2) + '</div><div style="font-size:9px;color:#8b949e">Sell P&amp;L</div></div>';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:#58a6ff">' + (s.buys || 0) + '</div><div style="font-size:9px;color:#8b949e">Buys</div></div>';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:#a855f7">' + (s.sells || 0) + '</div><div style="font-size:9px;color:#8b949e">Sells</div></div>';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:#22c55e">' + s.profitable + '</div><div style="font-size:9px;color:#8b949e">Profitable</div></div>';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:#ef4444">' + s.unprofitable + '</div><div style="font-size:9px;color:#8b949e">Unprofitable</div></div>';
    html += '<div style="text-align:center"><div style="font-size:16px;font-weight:bold;color:' + wrCol + '">' + sfmt(winRate, 0) + '%</div><div style="font-size:9px;color:#8b949e">Win Rate</div></div>';
    html += '</div>';

    // Store swaps + enrich with computed fields for sorting
    var swaps = data.swaps.map(function(sw) {
      var price = sw.price || 0;
      var gasEst = 10000 * price / 1e9;
      var protoFee = (sw.usdc_amount || 0) * 0.0006;
      var gross = sw.pnl_usdc != null ? sw.pnl_usdc : null;
      var net = gross != null ? gross - gasEst - protoFee : null;
      var reason = sw.reason || '';
      var source = 'unknown';
      if (reason.indexOf('SIR') >= 0) source = 'SIR';
      else if (reason.indexOf('Pre-open') >= 0) source = 'Pre-open';
      else if (reason.indexOf('Add liquidity') >= 0 || reason.indexOf('match position') >= 0) source = 'Auto-deploy';
      else if (reason.indexOf('Idle') >= 0 || reason.indexOf('idle') >= 0) source = 'Idle Rebal';
      else if (reason.indexOf('harvest') >= 0 || reason.indexOf('Harvest') >= 0) source = 'Harvest';
      return { ts: sw.timestamp, source: source, dir: sw.direction === 'buy_sol' ? 'BUY' : 'SELL', sol: sw.sol_amount, usdc: sw.usdc_amount, price: price, basis: sw.cost_basis_after || 0, gas: gasEst, fee: protoFee, gross: gross, net: net, cbBefore: sw.cost_basis_before, cbAfter: sw.cost_basis_after };
    });

    var sortCol = 'ts'; var sortAsc = false;
    function renderTable() {
      var sorted = swaps.slice().sort(function(a, b) {
        var va = a[sortCol], vb = b[sortCol];
        if (va == null && vb == null) return 0;
        if (va == null) return 1; if (vb == null) return -1;
        if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortAsc ? va - vb : vb - va;
      });
      var thStyle = 'padding:5px 4px;color:#58a6ff;border-bottom:1px solid #30363d;font-size:10px;cursor:pointer;user-select:none';
      var arrow = function(col) { return sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : ''; };
      var tbl = '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table id="swap-tbl" style="width:100%;border-collapse:collapse;font-size:11px">';
      tbl += '<thead><tr>';
      tbl += '<th style="text-align:left;' + thStyle + '" data-col="ts">Time' + arrow('ts') + '</th>';
      tbl += '<th style="text-align:left;' + thStyle + '" data-col="source">Source' + arrow('source') + '</th>';
      tbl += '<th style="text-align:left;' + thStyle + '" data-col="dir">Dir' + arrow('dir') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="sol">SOL' + arrow('sol') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="usdc">USDC' + arrow('usdc') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="price">Price' + arrow('price') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="basis">Avg Basis' + arrow('basis') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="gross">Gross' + arrow('gross') + '</th>';
      tbl += '<th style="text-align:right;' + thStyle + '" data-col="net">Net' + arrow('net') + '</th>';
      tbl += '</tr></thead><tbody>';
      var srcColors = {'SIR':'#a855f7','Pre-open':'#58a6ff','Auto-deploy':'#22c55e','Idle Rebal':'#eab308','Harvest':'#ffd700','unknown':'#8b949e'};
      sorted.forEach(function(r) {
        var t = new Date(r.ts).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        var dirCol = r.dir === 'BUY' ? '#22c55e' : '#ef4444';
        var grossCol = r.gross != null ? (r.gross >= 0 ? '#22c55e' : '#ef4444') : '#8b949e';
        var netCol = r.net != null ? (r.net >= 0 ? '#22c55e' : '#ef4444') : '#8b949e';
        tbl += '<tr style="border-bottom:1px solid #21262d">';
        tbl += '<td style="padding:4px;white-space:nowrap;font-size:10px;color:#8b949e">' + t + '</td>';
        tbl += '<td style="padding:4px;font-size:10px;font-weight:bold;color:' + (srcColors[r.source]||'#8b949e') + '">' + r.source + '</td>';
        tbl += '<td style="padding:4px;color:' + dirCol + ';font-weight:bold;font-size:10px">' + r.dir + '</td>';
        tbl += '<td style="padding:4px;text-align:right;font-family:monospace">' + sfmt(r.sol, 4) + '</td>';
        tbl += '<td style="padding:4px;text-align:right;font-family:monospace">$' + sfmt(r.usdc, 2) + '</td>';
        tbl += '<td style="padding:4px;text-align:right;font-family:monospace">$' + sfmt(r.price, 2) + '</td>';
        tbl += '<td style="padding:4px;text-align:right;font-family:monospace;color:#58a6ff">' + (r.basis > 0 ? '$' + sfmt(r.basis, 2) : '--') + '</td>';
        tbl += '<td style="padding:4px;text-align:right;color:' + grossCol + '">' + (r.gross != null ? (r.gross >= 0 ? '+' : '-') + '$' + sfmt(Math.abs(r.gross), 4) : '--') + '</td>';
        tbl += '<td style="padding:4px;text-align:right;color:' + netCol + ';font-weight:bold">' + (r.net != null ? (r.net >= 0 ? '+' : '-') + '$' + sfmt(Math.abs(r.net), 4) : '--') + '</td>';
        tbl += '</tr>';
      });
      tbl += '</tbody></table></div>';
      document.getElementById('swap-tbl-wrap').innerHTML = tbl;
      // Attach click handlers
      document.querySelectorAll('#swap-tbl th[data-col]').forEach(function(th) {
        th.addEventListener('click', function() {
          var col = th.getAttribute('data-col');
          if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = col === 'ts' ? false : true; }
          renderTable();
        });
      });
    }
    html += '<div id="swap-tbl-wrap"></div>';
    c.innerHTML = html;
    renderTable();
  }).catch(function(e) {
    var c = document.getElementById('swap-pnl-container');
    if (c) c.innerHTML = '<div style="color:#ef4444;text-align:center;padding:16px">Failed to load swap data</div>';
  });
})();
</script>

</div>
<div id="sec-solprice"><div class="section-title">SOL Daily Price</div>
<div class="card" style="margin-bottom:16px">
${(() => {
  const sums = data.dailySummaries;
  if (!sums || sums.length === 0) return '<div style="color:#8b949e;text-align:center;padding:16px">No daily data yet</div>';
  const sorted = [...sums].sort((a, b) => b.date.localeCompare(a.date));
  let html = '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += '<thead><tr>';
  html += '<th style="text-align:left;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:11px">Date</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:11px">Close Price</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:11px">Change</th>';
  html += '<th style="text-align:left;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d;font-size:11px">Regime</th>';
  html += '</tr></thead><tbody>';
  sorted.forEach((s, i) => {
    const prev = sorted[i + 1];
    const change = prev ? ((s.sol_price - prev.sol_price) / prev.sol_price * 100) : null;
    const chgCol = change === null ? '#8b949e' : change >= 0 ? '#22c55e' : '#ef4444';
    const chgStr = change === null ? '--' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    const regimeColours: Record<string, string> = { RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7' };
    const rCol = regimeColours[s.regime ?? ''] || '#8b949e';
    html += `<tr style="border-bottom:1px solid #21262d">`;
    html += `<td style="padding:5px 4px;color:#c9d1d9;white-space:nowrap">${s.date}</td>`;
    html += `<td style="padding:5px 4px;text-align:right;font-family:monospace;color:#c9d1d9">$${s.sol_price.toFixed(2)}</td>`;
    html += `<td style="padding:5px 4px;text-align:right;font-family:monospace;color:${chgCol}">${chgStr}</td>`;
    html += `<td style="padding:5px 4px"><span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${rCol}20;color:${rCol}">${s.regime ?? '--'}</span></td>`;
    html += `</tr>`;
  });
  html += '</tbody></table></div>';
  return html;
})()}
</div>

</div>
<div id="sec-downloads"><div class="card" style="margin-bottom:16px">
  <h2>Download Logs</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">Decision logs are recorded every 30 minutes (HOLD) and regime evaluations every 1 hour. Download for offline analysis.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <a href="/api/export" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Full JSON Export</a>
    <a href="/api/decisions?limit=500" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Decision Log (500)</a>
    <a href="/api/snapshots?hours=168" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Snapshots (7 days)</a>
    <a href="/api/regime-history" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Regime History</a>
    <a href="/api/rule2-perf" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Rule 2 Performance (JSON)</a>
    <a href="/api/rule2-events.csv" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Events CSV (with Rule 2 flag)</a>
  </div>
</div></div>

</body>
</html>`;
}

// ── Config page ──────────────────────────────────────────────────────────

function renderConfigHtml(): string {
  const c = runtime;
  const rp = c.regimeParams;
  const regimes = ['RANGING', 'BULLISH_TREND', 'BEARISH_TREND', 'EXTREME'] as const;
  const rpFields = [
    { key: 'rangeWidthPct', label: 'Range width %', desc: 'Width of LP position as % of price. Tighter = more fees but more OOR.', ex: '1.5→2%: range goes from ~$1.28 to ~$1.70 at $85 SOL.' },
    { key: 'skewDown', label: 'Skew down', desc: 'Fraction of range below current price (0-1). Higher = more downside room.', ex: '0.30→0.50: symmetric range. 0.30: 30% below, 70% above.' },
    { key: 'skewUp', label: 'Skew up', desc: 'Fraction of range above current price (0-1). Auto = 1 - skewDown.', ex: '0.70→0.50: symmetric. Should sum to 1.0 with skewDown.' },
    { key: 'proxThresholdLower', label: 'Downside exit %', desc: 'Rule 2 fires when proximity to lower bound reaches this (0-1).', ex: '0.65→0.50: exits earlier (halfway to bound). Less IL but more rebalances.' },
    { key: 'proxThresholdUpper', label: 'Upside exit %', desc: 'Rule 2 fires when proximity to upper bound reaches this (0-1).', ex: '0.88→0.95: holds almost to bound. More fees but risks full OOR.' },
    { key: 'deployPct', label: 'Deploy %', desc: 'Fraction of total capital deployed into position (0-1). Rest = reserve.', ex: '1.00→0.75: keeps 25% as reserve. Less fees but safer in volatility.' },
    { key: 'solReentrySplit', label: 'SOL re-entry split', desc: 'Target SOL fraction of wallet after downside exit (0-1).', ex: '0.50→0.30: hold 30% SOL / 70% USDC. Less SOL exposure on drops.' },
    { key: 'harvestIntervalDays', label: 'Harvest days', desc: 'Collect fees every N days. Lower = lock gains sooner.', ex: '7→3: harvest twice a week instead of once. More TXs but locks gains.' },
    { key: 'harvestSolConvertPct', label: 'SOL→USDC harvest %', desc: 'After harvest, convert this % of SOL fees to USDC (0-1).', ex: '0→0.50: convert half of harvested SOL to USDC. De-risks gains.' },
    { key: 'usdcDepositPct', label: 'USDC deposit %', desc: 'USDC portion of LP deposit as fraction of position size (0-1).', ex: '0.35→0.40: reserves more USDC for deposit. Affects reserve gate calculation.' },
    { key: 'deployRatioTolerance', label: 'Deploy ratio tolerance', desc: 'Max price deviation from midpoint for auto-deploy to fire (0-1).', ex: '0.020→0.050: deploys even near range edges. At 0.01: only near center.' },
    { key: 'basisGateThreshold', label: 'Basis gate threshold', desc: 'Price must be >= basis × threshold to open position. Lower = more permissive.', ex: '0.999 = 0.1% buffer. 0.995 = 0.5% buffer. 0.992 = 0.8% buffer.' },
    { key: 'proximityDeployThreshold', label: 'Prox deploy threshold', desc: 'Max proximity to lower bound before auto-deploy pauses (0-1).', ex: '0.40→0.55: deploys closer to edge. 0.40: pauses when 40% to lower bound.' },
    { key: 'reserveFloorPct', label: 'Reserve floor %', desc: 'Reserve floor as fraction of total portfolio. Higher = more USDC held back from deployment.', ex: '0.10 = 10% reserve. 0.18 = 18%. 0.20 = 20%. Higher in bearish regimes for safety.' },
  ];

  // Original defaults from constants (for "Default" column)
  const defaults = {
    RANGING: { ...REGIME_PARAMS.RANGING },
    BULLISH_TREND: { ...REGIME_PARAMS.BULLISH_TREND },
    BEARISH_TREND: { ...REGIME_PARAMS.BEARISH_TREND },
    EXTREME: { ...REGIME_PARAMS.EXTREME },
  } as Record<string, any>;

  function rpRow(field: typeof rpFields[0]): string {
    const safeDesc = field.desc.replace(/'/g, '&#39;');
    const safeEx = field.ex.replace(/'/g, '&#39;');
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#8b949e;font-size:11px;min-width:120px">${field.label}<span class="info-btn" onclick="showInfo('${field.label}','${safeDesc}','${safeEx}')">?</span></td>
      ${regimes.map(r => `<td style="padding:4px 6px;text-align:center"><span style="color:#30363d;font-size:10px">${defaults[r][field.key]}</span><br><input type="number" step="any" class="cfg-input" data-key="regime.${r}.${field.key}" value="${(rp[r] as any)[field.key]}" style="width:60px"></td>`).join('')}
    </tr>`;
  }

  function field(key: string, value: string | number, defaultVal: string | number, label: string, desc: string, ex: string, inputType = 'number'): string {
    const inputStyle = 'background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px;width:80px';
    const isToggle = inputType === 'toggle';
    const inputHtml = isToggle
      ? `<select class="cfg-input" data-key="${key}" style="${inputStyle};width:90px"><option value="null" ${value === 'null' ? 'selected' : ''}>OFF</option><option value="${typeof value === 'number' ? value : ''}" ${value !== 'null' && value !== '' ? 'selected' : ''}>ON</option></select>`
      : `<input type="${inputType}" step="any" class="cfg-input" data-key="${key}" value="${value}" style="${inputStyle}">`;
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:8px;color:#c9d1d9;font-size:12px">${label}</td>
      <td style="padding:8px;color:#30363d;font-size:11px">${defaultVal}</td>
      <td style="padding:8px">${inputHtml}</td>
      <td style="padding:8px;color:#8b949e;font-size:11px;max-width:220px">${desc}</td>
      <td style="padding:8px;color:#58a6ff;font-size:11px;max-width:220px">${ex}</td>
    </tr>`;
  }

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP Bot - Configuration</title>
<style>${SHARED_STYLES}
.cfg-section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.cfg-section h3{color:#58a6ff;font-size:14px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #21262d}
.cfg-input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px;max-width:100%}
.cfg-input:focus{border-color:#58a6ff;outline:none}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 8px;color:#8b949e;font-size:11px;border-bottom:1px solid #30363d}
.save-bar{position:sticky;bottom:0;background:#0d1117;border-top:2px solid #58a6ff;padding:12px 16px;display:flex;align-items:center;gap:12px;z-index:10}
.save-btn{background:#238636;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer}
.save-btn:hover{background:#2ea043}
@media(max-width:700px){
  .cfg-section{padding:10px;margin-bottom:10px}
  .cfg-section h3{font-size:12px;margin-bottom:8px}
  .cfg-section>table{display:block}
  .cfg-section>table>thead{display:none}
  .cfg-section>table>tbody{display:block}
  .cfg-section>table>tbody>tr{display:flex;flex-wrap:wrap;gap:4px;padding:8px 0;border-bottom:1px solid #21262d;align-items:center}
  .cfg-section>table>tbody>tr>td{display:block;padding:2px 4px !important;font-size:11px !important;border:none !important}
  .cfg-section>table>tbody>tr>td:first-child{width:100%;color:#c9d1d9 !important;font-weight:bold;font-size:12px !important}
  .cfg-section>table>tbody>tr>td:nth-child(2){display:none}
  .cfg-section>table>tbody>tr>td:nth-child(3){flex:0 0 auto}
  .cfg-section>table>tbody>tr>td:nth-child(4){flex:1;min-width:0}
  .cfg-section>table>tbody>tr>td:nth-child(5){display:none}
  .cfg-section div[style*="overflow-x"] table{display:table}
  .cfg-section div[style*="overflow-x"] thead{display:table-header-group}
  .cfg-section div[style*="overflow-x"] tbody{display:table-row-group}
  .cfg-section div[style*="overflow-x"] tr{display:table-row}
  .cfg-section div[style*="overflow-x"] td,.cfg-section div[style*="overflow-x"] th{display:table-cell}
  .cfg-input{font-size:14px !important;padding:6px 8px !important;min-height:36px}
  select.cfg-input{min-height:36px}
  .cfg-section div[style*="overflow-x"]{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .save-bar{padding:8px 12px}
  .save-btn{padding:10px 16px;font-size:13px;flex:1}
  #save-status{font-size:11px !important}
}
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
.modal-box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:450px;width:90%}
.modal-box h3{color:#f0883e;margin-bottom:12px}
.modal-box p{color:#c9d1d9;font-size:13px;line-height:1.6;margin-bottom:16px}
.modal-btns{display:flex;gap:12px;justify-content:flex-end}
.modal-btns button{padding:8px 20px;border-radius:6px;border:none;font-size:13px;cursor:pointer}
.btn-cancel{background:#21262d;color:#c9d1d9}
.btn-confirm{background:#da3633;color:#fff}
#save-status{font-size:13px}
.info-btn{display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;background:#21262d;color:#58a6ff;border-radius:50%;font-size:10px;cursor:pointer;border:1px solid #30363d;vertical-align:middle;margin-left:4px;-webkit-tap-highlight-color:transparent}
.info-popup{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:200;align-items:center;justify-content:center}
.info-popup.active{display:flex}
.info-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px 20px;max-width:360px;width:90%;margin:20px}
.info-card h4{color:#58a6ff;font-size:13px;margin:0 0 8px}
.info-card p{color:#c9d1d9;font-size:12px;line-height:1.6;margin:0 0 8px}
.info-card .ex{color:#8b949e;font-size:11px;line-height:1.5;padding:8px;background:#0d1117;border-radius:6px}
.info-card .close-btn{display:block;text-align:center;color:#8b949e;font-size:12px;margin-top:12px;cursor:pointer;padding:6px;background:#21262d;border-radius:6px}
</style></head><body>
<div class="banner">
  <div class="mode" style="color:#f0883e">Configuration</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">All changes take effect immediately. No restart required.</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-config').classList.add('active')</script>

<!-- SECTION 1: Decision Loop -->
<div class="cfg-section">
  <h3>1. Decision Loop</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('decisionIntervalSeconds', c.decisionIntervalSeconds, 60, 'Cycle interval (sec)', 'How often the bot reads price and makes decisions.', 'At 30s: faster OOR detection but 2x RPC calls. At 120s: saves RPC but slower reaction.')}
    ${field('regimeWindowDays', c.regimeWindowDays, 7, 'Regime window (days)', 'Days of daily closes for regime detection.', 'At 14 days: smoother regime, slower to react. At 3 days: reactive but may flap.')}
    ${field('trendThreshold', c.trendThreshold, 0.35, 'Trend threshold', 'dirRatio above this = trending. Higher = stays RANGING longer.', 'At 0.50: only strong trends flip regime. At 0.20: even mild trends trigger.')}
  </table>
</div>

<!-- SECTION 1b: Bot Timing & Control -->
<div class="cfg-section">
  <h3>1b. Bot Timing &amp; Control</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('regimeCheckIntervalMs', c.regimeCheckIntervalMs, 120000, 'Regime check interval (ms)', 'How often TA regime detection runs. 120000 = 2 min.', 'At 60000: checks every minute. At 300000: every 5 min. Lower = faster regime changes.')}
    ${field('autoDeployCheckIntervalSec', c.autoDeployCheckIntervalSec, 10, 'Auto-deploy interval (sec)', 'How often auto-deploy attempts to add idle capital.', 'At 10: checks every cycle. At 60: checks once per minute. At 300: every 5 min.')}
    ${field('solConversionCooldownMin', c.solConversionCooldownMin, 15, 'SOL conversion cooldown (min)', 'Minutes between automated SOL to USDC conversions.', 'At 15: converts at most once every 15 min. At 30: more conservative.')}
    ${field('solConversionBasisMultiplier', c.solConversionBasisMultiplier, 1.002, 'SOL conversion basis multiplier', 'Price must be > basis × this to convert. 1.002 = 0.2% above basis.', 'At 1.005: needs 0.5% margin. At 1.002: needs 0.2% margin. At 1.000: any price above basis.')}
    ${field('solConvertMomentumThreshold', c.solConvertMomentumThreshold, 0.02, 'Momentum threshold (30min %)', 'Min 30-min price rise to trigger SOL conversion in BEARISH/EXTREME. 0.02 = 2%.', 'At 0.01: 1% spike triggers. At 0.02: 2% spike. At 0.05: 5% spike needed. Only fires in BEARISH_TREND and EXTREME.')}
    ${field('solConvertMomentumCooldownMin', c.solConvertMomentumCooldownMin, 10, 'Momentum cooldown (min)', 'Cooldown for momentum-triggered conversions. Overrides regime cooldown when shorter.', 'At 5: aggressive, converts every 5 min during spikes. At 10: moderate. At 30: conservative.')}
    ${field('solConvertTargetDeployMinRanging', c.solConvertTargetDeployMinRanging, 15, 'Target deploy time RANGING (min)', 'Minutes to fully convert idle SOL in RANGING. Cap per conversion = cooldown/target × idle SOL value.', 'At 15: converts 20% per 3min cycle. At 30: converts 10% per cycle. Lower = faster deployment.')}
    ${field('solConvertTargetDeployMinBullish', c.solConvertTargetDeployMinBullish, 30, 'Target deploy time BULLISH (min)', 'Minutes to fully convert idle SOL in BULLISH_TREND.', 'At 30: converts 16.7% per 5min cycle. At 60: converts 8.3% per cycle.')}
    ${field('solConvertTargetDeployMinBearish', c.solConvertTargetDeployMinBearish, 90, 'Target deploy time BEARISH (min)', 'Minutes to fully convert idle SOL in BEARISH_TREND. Slower to limit sell pressure.', 'At 90: converts 11.1% per 10min cycle. At 180: converts 5.6% per cycle.')}
    ${field('solConvertTargetDeployMinExtreme', c.solConvertTargetDeployMinExtreme, 240, 'Target deploy time EXTREME (min)', 'Minutes to fully convert idle SOL in EXTREME. Very conservative.', 'At 240: converts 8.3% per 20min cycle. At 480: converts 4.2% per cycle.')}
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px">Regime change reopen<span class="info-btn" onclick="showInfo('Regime change reopen','When regime changes, close current position and reopen with new regime params.','Enabled: bot adapts range/skew to new regime immediately. Disabled: keeps current position until natural exit.')">?</span></td>
      <td style="color:#30363d">true</td>
      <td><select class="cfg-input" data-key="regimeChangeReopenEnabled" style="width:80px">
        <option value="true" ${c.regimeChangeReopenEnabled ? 'selected' : ''}>Enabled</option>
        <option value="false" ${!c.regimeChangeReopenEnabled ? 'selected' : ''}>Disabled</option>
      </select></td>
      <td style="color:#8b949e;font-size:11px">Close and reopen position when regime changes</td>
      <td style="color:#484f58;font-size:10px">Enabled: adapts immediately. Disabled: waits for natural exit.</td>
    </tr>
  </table>
</div>

<!-- SECTION 2: Position Rules -->
<div class="cfg-section">
  <h3>2. Position Rules</h3>
  <table style="margin-bottom:16px">
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:8px;color:#c9d1d9;font-size:12px">Range width override</td>
      <td style="padding:8px">
        <select id="rwo-toggle" class="cfg-input" style="width:60px" onchange="document.getElementById('rwo-val').style.display=this.value==='on'?'inline':'none'">
          <option value="off" ${c.rangeWidthOverride == null ? 'selected' : ''}>OFF</option>
          <option value="on" ${c.rangeWidthOverride != null ? 'selected' : ''}>ON</option>
        </select>
        <input type="number" step="any" id="rwo-val" class="cfg-input" data-key="rangeWidthOverride" value="${c.rangeWidthOverride ?? 1.5}" style="width:60px;margin-left:4px;${c.rangeWidthOverride == null ? 'display:none' : ''}">
      </td>
      <td style="padding:8px;color:#8b949e;font-size:11px">Force fixed range width regardless of regime. OFF = adaptive.</td>
      <td style="padding:8px;color:#58a6ff;font-size:11px">ON at 1.5%: always tight range. OFF: adapts 1.5-6% by regime.</td>
    </tr>
    ${field('positionMaxAgeHours', c.positionMaxAgeHours, 0, 'Max position age (h)', 'Rebalance after this many hours to reset IL baseline and collect fees. 0 = disabled.', 'At 24: daily rebalance. At 0: only rebalance on OOR/proximity exit.')}
  </table>
  <div style="color:#8b949e;font-size:11px;margin-bottom:8px">Per-regime parameters (hover <span style="color:#30363d">&#x2753;</span> for description + example):</div>
  <div style="overflow-x:auto">
  <table>
    <tr>
      <th></th>
      <th style="color:#4a9eff;text-align:center">Ranging</th>
      <th style="color:#22c55e;text-align:center">Bullish</th>
      <th style="color:#ef4444;text-align:center">Bearish</th>
      <th style="color:#a855f7;text-align:center">Extreme</th>
    </tr>
    ${rpFields.map(f => rpRow(f)).join('')}
  </table>
  </div>
</div>

<!-- SECTION 3: Capital & Reserves -->
<div class="cfg-section">
  <h3>3. Capital &amp; Reserves</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('maxLiveCapitalUsdc', c.maxLiveCapitalUsdc, 5000, 'Max live capital ($)', 'Safety cap. Bot refuses to start if wallet exceeds this.', 'At $10k: allows large wallet. At $500: stops on accidental deposits.')}
    ${field('solReserve', c.solReserve, 0.1, 'SOL reserve', 'Always kept for gas + rent. Never deposited.', 'At 0.2: more buffer for rapid rebalancing (~$17 idle).')}
    ${field('usdcReserve', c.usdcReserve, 1, 'USDC reserve ($)', 'Minimum USDC always in wallet.', 'At $5: more buffer. At $0: risk token account errors.')}
    ${field('minPositionSizeUsdc', c.minPositionSizeUsdc, 100, 'Min position size ($)', 'Won&#39;t open below this. Prevents dust positions.', 'At $500: only meaningful positions. At $50: allows small deploys.')}
  </table>
</div>

<!-- SECTION 4: Auto Deploy -->
<div class="cfg-section">
  <h3>4. Auto Deploy (Rule 7)</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('autoDeployCheckMinutes', c.autoDeployCheckMinutes, 5, 'Check frequency (min)', 'How often to check for idle funds. Each check = 2 RPC calls.', 'At 10 min: half RPC cost. At 1 min: very responsive but noisy.')}
    ${field('autoDeployCooldownMinutes', c.autoDeployCooldownMinutes, 30, 'Cooldown (min)', 'Minimum time between deployments.', 'At 15 min: faster cleanup of swap leftovers. At 60: less activity.')}
    ${field('minIdleUsdc', c.minIdleUsdc, 5, 'Min idle USDC ($)', 'Min idle USDC after reserve to trigger deploy.', 'At $20: ignores small amounts. At $1: deploys tiny leftovers.')}
    ${field('minIdleSol', c.minIdleSol, 0.05, 'Min idle SOL', 'Min idle SOL after reserve to trigger deploy.', 'At 0.5 SOL (~$42): only meaningful amounts. At 0.01: deploys dust.')}
    ${field('minDeployUsdc', c.minDeployUsdc, 10, 'Min deploy ($)', 'Min total deployable value to trigger.', 'At $50: only worthwhile deploys. At $5: deploys very small amounts.')}
    ${field('deployRatioTolerance', c.deployRatioTolerance, 0.02, 'Price ratio tolerance', 'Max deviation from geometric mean (0-1). Wider = more deploy opportunities.', 'At 0.05: deploys even near range edges. At 0.01: only near center.')}
  </table>
</div>

<!-- SECTION 4b: Swap Config -->
<div class="cfg-section">
  <h3>4b. Swap Routing</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('swapSlippageBps', c.swapSlippageBps, 15, 'Slippage (bps)', 'Swap slippage tolerance in basis points. 100 bps = 1%.', 'At 10: very tight, may fail in volatile markets. At 50: safer but more expensive.')}
    ${field('swapBufferPct', c.swapBufferPct, 3, 'Swap buffer (%)', 'Over-estimate swap amounts by this % to avoid coming up short.', 'At 1%: tighter, less over-swap. At 5%: more buffer, more leftover.')}
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#8b949e;font-size:11px;min-width:120px">Swap provider</td>
      <td style="padding:6px 8px;color:#30363d;font-size:11px">jupiter-fallback</td>
      <td style="padding:6px 8px">
        <select class="cfg-input" data-key="swapProvider" style="width:140px">
          <option value="jupiter-fallback" ${c.swapProvider === 'jupiter-fallback' ? 'selected' : ''}>Jupiter + Orca fallback</option>
          <option value="jupiter" ${c.swapProvider === 'jupiter' ? 'selected' : ''}>Jupiter only</option>
          <option value="orca" ${c.swapProvider === 'orca' ? 'selected' : ''}>Orca only (legacy)</option>
        </select>
      </td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">Routing strategy for token swaps.</td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">jupiter-fallback: best price via Jupiter, Orca if Jupiter is down.</td>
    </tr>
  </table>
</div>

<!-- SECTION 4c: Enhanced Regime Detection -->
<div class="cfg-section">
  <h3>4c. Enhanced Regime (Market Data)</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#8b949e;font-size:11px;min-width:120px">Enable enhanced regime</td>
      <td style="padding:6px 8px;color:#30363d;font-size:11px">true</td>
      <td style="padding:6px 8px">
        <select class="cfg-input" data-key="useEnhancedRegime" style="width:80px">
          <option value="true" ${c.useEnhancedRegime ? 'selected' : ''}>On</option>
          <option value="false" ${!c.useEnhancedRegime ? 'selected' : ''}>Off</option>
        </select>
      </td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">Use external market data (vol, BTC, F&G) to enhance regime detection. Off = daily closes only.</td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">Off: conservative, no API deps. On: smarter regime with market context.</td>
    </tr>
    ${field('vol1hExtremeThreshold', c.vol1hExtremeThreshold, 0.06, '1h vol → EXTREME', '1h log-return stddev above this triggers EXTREME override.', 'At 0.04: more sensitive. At 0.08: only fires on major moves.')}
    ${field('vol4hExtremeThreshold', c.vol4hExtremeThreshold, 0.05, '4h vol → EXTREME', '4h vol above this + volume spike → EXTREME override.', 'At 0.03: triggers more often. At 0.07: only extreme events.')}
    ${field('volumeSpikeMultiple', c.volumeSpikeMultiple, 3, 'Volume spike (x)', 'Current 4h volume / 7d avg above this = volume spike.', 'At 2: more sensitive. At 5: only massive volume events.')}
    ${field('trendDeltaThreshold', c.trendDeltaThreshold, 4, 'Trend delta (%)', 'SOL 24h change % above this + volume → trend override.', 'At 3: catches smaller moves. At 6: only strong trends.')}
    ${field('btcCorrelationThreshold', c.btcCorrelationThreshold, 3, 'BTC correlation (%)', 'BTC 24h move above this % = macro event (boosts confidence).', 'At 2: more events qualify. At 5: only BTC crashes/pumps.')}
    ${field('fearGreedExtremeLow', c.fearGreedExtremeLow, 25, 'F&G fear threshold', 'Fear & Greed below this = extreme fear, biases toward BEARISH.', 'At 20: only deep fear. At 30: catches more fear events.')}
    ${field('fearGreedExtremeHigh', c.fearGreedExtremeHigh, 75, 'F&G greed threshold', 'Fear & Greed above this = extreme greed, confirms BULLISH.', 'At 70: catches more greed. At 80: only euphoria.')}
  </table>
</div>

<!-- SECTION 5: Re-entry -->
<div class="cfg-section">
  <h3>5. Re-entry (Rule 3)</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('pullbackThresholdPct', c.pullbackThresholdPct, 2.5, 'Pullback threshold (%)', 'Price must drop this % from peak to re-enter.', 'At 5%: bigger pullback, better entry but longer wait. At 1%: quick re-entry.')}
    ${field('timeoutHours', c.timeoutHours, 4, 'Timeout (hours)', 'Re-enter after this long even without pullback.', 'At 8h: more patience. At 1h: re-enters quickly, prioritizes fee earning.')}
    ${field('flashCrashPct', c.flashCrashPct, 5, 'Flash crash threshold (%)', 'Drop this % in ~5 min = flash crash. Triggers cooldown.', 'At 10%: only extreme crashes trigger. At 3%: even moderate drops pause.')}
    ${field('flashCrashWaitMinutes', c.flashCrashWaitMinutes, 15, 'Flash crash cooldown (min)', 'Block re-entry for this long after crash. Also resets peak + timeout.', 'At 30 min: more settle time. At 5 min: minimal wait.')}
  </table>
</div>

<!-- SECTION 5b: Idle Wallet Rebalance -->
<div class="cfg-section">
  <h3>5b. Idle Wallet Rebalance (Rule 8)</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#8b949e;font-size:11px;min-width:120px">Enable idle rebalance</td>
      <td style="padding:6px 8px;color:#30363d;font-size:11px">true</td>
      <td style="padding:6px 8px">
        <select class="cfg-input" data-key="idleRebalanceEnabled" style="width:80px">
          <option value="true" ${c.idleRebalanceEnabled ? 'selected' : ''}>On</option>
          <option value="false" ${!c.idleRebalanceEnabled ? 'selected' : ''}>Off</option>
        </select>
      </td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">Maintain target SOL/USDC split in idle wallet per regime. Triggers once per regime change.</td>
      <td style="padding:6px 8px;color:#8b949e;font-size:11px">Off: idle capital stays as-is. On: rebalances on regime change.</td>
    </tr>
    ${field('idleRebalanceMinUsdc', c.idleRebalanceMinUsdc, 100, 'Min idle value ($)', 'Only trigger if total idle value exceeds this threshold.', 'At $50: triggers on smaller amounts. At $200: only large idle balances.')}
    ${field('idleRebalanceSolKeep', c.idleRebalanceSolKeep, 0.15, 'SOL to keep', 'Always keep this much SOL for gas regardless of target.', 'At 0.05: minimal gas reserve. At 0.5: more SOL kept back.')}
    ${field('idleRebalanceDeviationPct', c.idleRebalanceDeviationPct, 0.20, 'Deviation trigger', 'Only rebalance if wallet is more than this % off the regime target.', 'At 0.10: triggers more often. At 0.30: only large imbalances.')}
    ${field('idleTargetSolPctRanging', c.idleTargetSolPctRanging, 0.50, 'RANGING target SOL %', 'Target SOL share of idle wallet in RANGING. 0.50 = balanced.', 'At 0.40: slight USDC bias. At 0.60: slight SOL bias.')}
    ${field('idleTargetSolPctBullish', c.idleTargetSolPctBullish, 0.60, 'BULLISH target SOL %', 'Target SOL share in BULLISH. Higher = ride the upside.', 'At 0.50: balanced. At 0.70: strong SOL exposure.')}
    ${field('idleTargetSolPctBearish', c.idleTargetSolPctBearish, 0.35, 'BEARISH target SOL %', 'Target SOL share in BEARISH. Lower = more USDC protection.', 'At 0.20: aggressive protection. At 0.40: moderate.')}
    ${field('idleTargetSolPctExtreme', c.idleTargetSolPctExtreme, 0.15, 'EXTREME target SOL %', 'Target SOL share in EXTREME. Minimum SOL exposure.', 'At 0.10: almost all USDC. At 0.25: keep some SOL.')}
  </table>
</div>

<!-- SECTION 6: Circuit Breakers -->
<div class="cfg-section">
  <h3>6. Circuit Breakers</h3>
  <table>
    <tr><th>Parameter</th><th style="color:#30363d">Default</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('dailyLossLimitPct', c.dailyLossLimitPct, 5, 'Daily loss limit (%)', 'HALT if portfolio drops more than this in a day.', 'At 10%: more tolerance for volatile days. At 3%: very conservative.')}
    ${field('weeklyDrawdownLimitPct', c.weeklyDrawdownLimitPct, 15, 'Weekly drawdown (%)', 'HALT if portfolio drops this from weekly peak.', 'At 25%: allows larger drawdown. At 10%: halts early in downtrends.')}
    ${field('maxIlPct', c.maxIlPct, 8, 'Max IL (%)', 'Force rebalance if IL exceeds this on any position.', 'At 15%: allows more IL (wider ranges). At 5%: very tight IL control.')}
    ${field('rebalanceLoopLimit', c.rebalanceLoopLimit, 10, 'Rebalance limit (/hour)', 'Max close+reopen cycles per hour.', 'At 20: more activity in volatile markets. At 5: stricter limit.')}
  </table>
</div>

<!-- SAVE BAR -->
<div class="save-bar">
  <button class="save-btn" onclick="showConfirm()">Save Configuration</button>
  <span id="save-status"></span>
</div>

<!-- CONFIRMATION MODAL -->
<div class="modal-overlay" id="confirm-modal">
  <div class="modal-box">
    <h3>Confirm Configuration Change</h3>
    <p>These changes take effect <b>immediately</b> on the running bot. No restart required.<br><br>
    <span id="change-count"></span> parameter(s) will be updated.</p>
    <div id="change-list" style="max-height:200px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:8px;font-size:11px;color:#8b949e;margin-bottom:12px"></div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="hideConfirm()">Cancel</button>
      <button class="btn-confirm" onclick="doSave()">Apply Changes</button>
    </div>
  </div>
</div>

<!-- Info popup overlay -->
<div class="info-popup" id="info-popup" onclick="hideInfo()">
  <div class="info-card" onclick="event.stopPropagation()">
    <h4 id="info-title"></h4>
    <p id="info-desc"></p>
    <div class="ex" id="info-ex"></div>
    <div class="close-btn" onclick="hideInfo()">Close</div>
  </div>
</div>

<script>
function showInfo(title, desc, ex) {
  document.getElementById('info-title').textContent = title;
  document.getElementById('info-desc').textContent = desc;
  document.getElementById('info-ex').textContent = 'Example: ' + ex;
  document.getElementById('info-popup').classList.add('active');
}
function hideInfo() {
  document.getElementById('info-popup').classList.remove('active');
}

var originalValues = {};
document.querySelectorAll('.cfg-input').forEach(function(el) {
  originalValues[el.dataset.key || el.id] = el.value;
});

function getChanges() {
  var changes = {};
  document.querySelectorAll('.cfg-input').forEach(function(el) {
    var key = el.dataset.key;
    if (!key) return;
    var val = el.value;
    // Handle range width override toggle
    if (key === 'rangeWidthOverride') {
      var toggle = document.getElementById('rwo-toggle');
      if (toggle.value === 'off') val = 'null';
    }
    if (val !== originalValues[key]) {
      changes[key] = val;
    }
  });
  return changes;
}

function showConfirm() {
  var changes = getChanges();
  var keys = Object.keys(changes);
  if (keys.length === 0) {
    document.getElementById('save-status').textContent = 'No changes to save.';
    document.getElementById('save-status').style.color = '#8b949e';
    return;
  }
  document.getElementById('change-count').textContent = keys.length;
  var list = keys.map(function(k) {
    return '<div style="padding:2px 0"><span style="color:#58a6ff">' + k + '</span>: ' + (originalValues[k] || '(default)') + ' → <b style="color:#f0883e">' + changes[k] + '</b></div>';
  }).join('');
  document.getElementById('change-list').innerHTML = list;
  document.getElementById('confirm-modal').style.display = 'flex';
}

function hideConfirm() {
  document.getElementById('confirm-modal').style.display = 'none';
}

function doSave() {
  hideConfirm();
  var changes = getChanges();
  var status = document.getElementById('save-status');
  status.textContent = 'Saving...';
  status.style.color = '#f0883e';
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes)
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.success) {
      status.textContent = 'Saved ' + data.updated + ' parameter(s). Changes are live.';
      status.style.color = '#22c55e';
      // Update original values to reflect saved state
      Object.keys(changes).forEach(function(k) { originalValues[k] = changes[k]; });
    } else {
      status.textContent = 'Error: ' + (data.error || 'unknown');
      status.style.color = '#ef4444';
    }
  }).catch(function(err) {
    status.textContent = 'Error: ' + err;
    status.style.color = '#ef4444';
  });
}
</script>
</body></html>`;
}

// ── Strategy page ─────────────────────────────────────────────────────────

function renderStrategyHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP Bot - Strategy</title>
<style>${SHARED_STYLES}
.flow{display:flex;flex-direction:column;gap:2px;margin:12px 0}
.flow-step{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px}
.flow-step h3{font-size:13px;margin-bottom:6px}
.flow-arrow{text-align:center;color:#30363d;font-size:18px}
.param-grid{background:#30363d;border-radius:8px;overflow:hidden;margin:12px 0}
.param-grid-inner{display:grid;grid-template-columns:repeat(5,1fr);gap:1px}
.param-grid .cell{background:#161b22;padding:8px;font-size:11px;text-align:center}
.param-grid .header{background:#0d1117;color:#8b949e;font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.rule-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px}
.rule-card h3{color:#58a6ff;font-size:14px;margin-bottom:8px}
.rule-card .trigger{color:#f0883e;font-size:11px;font-style:italic;margin-top:8px;padding-top:8px;border-top:1px solid #21262d}
.rule-num{display:inline-block;background:#58a6ff20;color:#58a6ff;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:bold;margin-right:8px}
.logic-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:12px;font-family:monospace;color:#c9d1d9;margin:8px 0;line-height:1.6;white-space:pre-wrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
.example-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6}
.example-title{color:#58a6ff;font-weight:bold;margin-bottom:4px}
.example-text{color:#c9d1d9}
.example-note{color:#8b949e;margin-top:4px}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin:0 2px}
.tag-ranging{background:#4a9eff20;color:#4a9eff}
.tag-bull{background:#22c55e20;color:#22c55e}
.tag-bear{background:#ef444420;color:#ef4444}
.tag-extreme{background:#a855f720;color:#a855f7}
.section-title{font-size:14px;margin:24px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d}
@media(max-width:700px){
  .param-grid{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .param-grid-inner{grid-template-columns:repeat(5,minmax(70px,1fr));min-width:400px}
  .flow-step{padding:10px 12px}
  .flow-step h3{font-size:12px}
  .rule-card{padding:12px}
  .rule-card h3{font-size:13px}
  .logic-box{font-size:11px;padding:10px;overflow-x:auto}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#58a6ff">Strategy &amp; Rules</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Regime-adaptive concentrated liquidity on Orca Whirlpool</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-strategy').classList.add('active')</script>

<!-- ── OVERVIEW ──────────────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Overview</h2>
  <p style="color:#c9d1d9;font-size:13px;line-height:1.6">
    A <b>30-second decision loop</b> reads live SOL/USD prices, classifies the market into one of four regimes,
    and manages a concentrated liquidity position on the <b>Orca SOL/USDC Whirlpool</b>.
    Seven rules adapt range width, exit thresholds, capital sizing, fee harvesting and idle-fund deployment
    to current conditions. The goal: maximize fee yield while minimizing impermanent loss.
  </p>
</div>

<!-- ── DECISION FLOW ────────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Decision Flow</h2>
  <p style="font-size:11px;color:#8b949e;margin-bottom:8px">Every 30 seconds. Sub-checks run on their own cadence (noted below).</p>
  <div class="flow">
    <div class="flow-step"><h3>1. Fetch Price</h3><div style="font-size:12px;color:#8b949e">SOL/USD from Pyth Hermes. Reject if confidence &gt; 0.5% or stale &gt; 60s.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>2. Enhanced Regime Detection <span style="color:#8b949e;font-weight:normal;font-size:11px">(every 1h)</span></h3><div style="font-size:12px;color:#8b949e">Base regime from daily closes + market signal overrides (1h/4h vol, SOL/BTC 24h change, volume ratio, Fear &amp; Greed). Confidence score 0&#x2013;5. Also re-checked before every position reopen.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>3. Safety Checks</h3><div style="font-size:12px;color:#8b949e">Circuit breakers: daily loss &gt; 5%, IL &gt; 8%, rebalances &gt; 10/hr &#x2192; HALT.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>4. Position Decision</h3><div style="font-size:12px;color:#8b949e">No position &#x2192; open (Rules 1, 3&#x2013;5). In range &#x2192; monitor proximity (Rule 2). Out of range &#x2192; rebalance.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>5. Fee Harvest <span style="color:#8b949e;font-weight:normal;font-size:11px">(check every 1h)</span></h3><div style="font-size:12px;color:#8b949e">If harvest interval elapsed (Rule 6) &#x2192; collect accrued fees from position.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>6. Auto Deploy <span style="color:#8b949e;font-weight:normal;font-size:11px">(check every 5min)</span></h3><div style="font-size:12px;color:#8b949e">If idle wallet funds exist and position is in range (Rule 7) &#x2192; add liquidity.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>7. Record &amp; Report</h3><div style="font-size:12px;color:#8b949e">Log decision to DB (every 30min). Telegram report (every 1h). Dashboard snapshot.</div></div>
  </div>
</div>

<!-- ── REGIME DETECTION ─────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Regime Detection (Enhanced)</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:8px">Evaluated every 1 hour. Combines daily closing prices with real-time market signals for faster, more accurate classification.</p>

  <div style="font-size:12px;color:#58a6ff;font-weight:bold;margin:12px 0 6px">Step 1: Base Regime (Daily Closes)</div>
  <div class="logic-box"><b>dirRatio</b> = |net move| / total path
  1.0 = straight line (strong trend)
  0.0 = oscillating (ranging)

<b>realisedVol</b> = stddev of daily log returns
  Normal SOL: 3&#x2013;5%. Crisis: &gt; 8%

<b>Base classification:</b>
  realisedVol &gt; 0.08            &#x2192; <span class="tag tag-extreme">EXTREME</span>
  dirRatio &gt; 0.35 &amp; price up   &#x2192; <span class="tag tag-bull">BULLISH_TREND</span>
  dirRatio &gt; 0.35 &amp; price down &#x2192; <span class="tag tag-bear">BEARISH_TREND</span>
  otherwise                      &#x2192; <span class="tag tag-ranging">RANGING</span></div>

  <div style="font-size:12px;color:#58a6ff;font-weight:bold;margin:12px 0 6px">Step 2: Market Signal Overrides</div>
  <p style="font-size:12px;color:#8b949e;margin-bottom:8px">External data from CoinGecko (OHLC, BTC, SOL volume) and Fear &amp; Greed Index, polled every 15 min. Can override the base regime when signals are strong enough.</p>
  <div class="logic-box"><b>6 Market Signals:</b>

<b>vol1h</b>  = stddev of 30min log returns (24h of CoinGecko OHLC)
  Measures short-term intraday volatility.
  &gt; 0.06 &#x2192; <span class="tag tag-extreme">EXTREME</span> override (catches vol spikes before daily closes do)

<b>vol4h</b>  = stddev of 4h log returns (7d of CoinGecko OHLC)
  Measures medium-term volatility.
  &gt; 0.05 AND volume spike &gt; 3x &#x2192; <span class="tag tag-extreme">EXTREME</span> override

<b>SOL 24h change</b> = SOL price % change over 24 hours
  |change| &gt; 4% with volume &gt; 2x &#x2192; trend override:
    positive &#x2192; <span class="tag tag-bull">BULLISH_TREND</span>
    negative &#x2192; <span class="tag tag-bear">BEARISH_TREND</span>

<b>BTC 24h change</b> = BTC price % change (CoinGecko)
  |change| &gt; 3% in same direction as SOL = macro move
  Boosts confidence (confirms the regime, doesn't override)

<b>Volume ratio</b> = current SOL 24h vol / rolling 7-day avg
  Built from CoinGecko readings every 15 min.
  &gt; 3x = volume spike (confirms EXTREME or TREND)
  &gt; 2x = elevated (needed for trend override)

<b>Fear &amp; Greed</b> = crypto sentiment index (0&#x2013;100)
  &lt; 25 (Extreme Fear) + SOL down &gt; 2% &#x2192; <span class="tag tag-bear">BEARISH_TREND</span>
  &gt; 75 (Extreme Greed) &#x2192; confirms <span class="tag tag-bull">BULLISH_TREND</span>
  40&#x2013;60 (Neutral) &#x2192; confirms <span class="tag tag-ranging">RANGING</span></div>

  <div style="font-size:12px;color:#58a6ff;font-weight:bold;margin:12px 0 6px">Step 3: Confidence Score (0&#x2013;5)</div>
  <div class="logic-box">Each signal that agrees with the chosen regime adds +1:
  &#x2022; vol1h confirms volatility level           (+1)
  &#x2022; vol4h + volume spike confirms extreme      (+1)
  &#x2022; BTC correlated macro move                  (+1)
  &#x2022; Fear &amp; Greed matches sentiment             (+1)
  &#x2022; Volume level matches regime type            (+1)

<b>Higher confidence = more signals agree.</b>
Low confidence (1/5) means the regime is based mostly
on daily closes with little market confirmation.
High confidence (4-5/5) means multiple independent
signals all point to the same conclusion.</div>

  <div style="font-size:12px;color:#58a6ff;font-weight:bold;margin:12px 0 6px">Step 4: Override Priority</div>
  <div class="logic-box">1. EXTREME (highest priority):
   vol1h &gt; 0.06 alone is enough to override any base regime.
   vol4h &gt; 0.05 + volume spike also triggers EXTREME.

2. TREND:
   Only overrides RANGING (not EXTREME).
   Needs SOL |delta| &gt; 4% AND volume &gt; 2x.

3. Fear &amp; Greed:
   Only overrides RANGING to BEARISH (not other regimes).
   Needs F&amp;G &lt; 25 AND SOL down &gt; 2%.

4. If all APIs are down:
   Falls back to base regime from daily closes only.
   No degradation &#x2014; bot always has a valid regime.</div>

  <div class="example-box">
    <div class="example-title">Example: base = RANGING, but vol1h = 0.07</div>
    <div class="example-text">Daily closes are flat (dirRatio = 0.15) &#x2192; base = <span class="tag tag-ranging">RANGING</span></div>
    <div class="example-text">But 1h vol = 0.07 &gt; 0.06 threshold &#x2192; <b>OVERRIDE to <span class="tag tag-extreme">EXTREME</span></b></div>
    <div class="example-text">Result: wider range (6%), lower deploy (25%), faster harvest (1d)</div>
    <div class="example-note">Without enhanced detection, the bot would stay RANGING with a tight 1.5% range during high volatility &#x2014; high risk of repeated OOR exits.</div>
  </div>
  <div class="example-box">
    <div class="example-title">Example: SOL -5.2%, BTC -3.8%, F&amp;G = 18</div>
    <div class="example-text">Base = RANGING (only 3 daily closes, not enough for trend).</div>
    <div class="example-text">SOL delta -5.2% &gt; 4% threshold + volume 2.5x &#x2192; <b>OVERRIDE to <span class="tag tag-bear">BEARISH_TREND</span></b></div>
    <div class="example-text">BTC -3.8% same direction &#x2192; macro move confirmed (+1 confidence)</div>
    <div class="example-text">F&amp;G 18 = Extreme Fear &#x2192; confirms BEARISH (+1 confidence)</div>
    <div class="example-text">Confidence: 3/5. Result: 4% range, 50% deploy, faster harvest, 100% SOL&#x2192;USDC</div>
  </div>
  <div class="example-box">
    <div class="example-title">Example: all APIs down</div>
    <div class="example-text">CoinGecko 429, Fear &amp; Greed timeout &#x2192; all signals null.</div>
    <div class="example-text">Falls back to base regime from daily closes. Confidence: 0/5.</div>
    <div class="example-note">Bot continues operating normally &#x2014; just without market data enhancement.</div>
  </div>
</div>

<!-- ── PARAMETERS GRID ──────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Parameters by Regime</h2>
  <div class="param-grid">
  <div class="param-grid-inner">
    <div class="cell header">Parameter</div>
    <div class="cell header" style="color:#4a9eff">Ranging</div>
    <div class="cell header" style="color:#22c55e">Bullish</div>
    <div class="cell header" style="color:#ef4444">Bearish</div>
    <div class="cell header" style="color:#a855f7">Extreme</div>
    <div class="cell" style="text-align:left;color:#8b949e">Range Width (R1)</div><div class="cell" style="color:#4a9eff">1.5%</div><div class="cell" style="color:#22c55e">3%</div><div class="cell" style="color:#ef4444">2.5%</div><div class="cell" style="color:#a855f7">6%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Skew down/up (R1)</div><div class="cell">30/70</div><div class="cell">20/80</div><div class="cell">40/60</div><div class="cell">50/50</div>
    <div class="cell" style="text-align:left;color:#8b949e">Downside Exit (R2)</div><div class="cell">65%</div><div class="cell">70%</div><div class="cell">55%</div><div class="cell">50%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Upside Exit (R2)</div><div class="cell">88%</div><div class="cell">92%</div><div class="cell">82%</div><div class="cell">80%</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL Re-entry (R4)</div><div class="cell">50%</div><div class="cell">50%</div><div class="cell">30%</div><div class="cell">20%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Capital Deploy (R5)</div><div class="cell" style="color:#22c55e">100%</div><div class="cell">85%</div><div class="cell" style="color:#eab308">75%</div><div class="cell" style="color:#ef4444">25%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Harvest (R6)</div><div class="cell">7d</div><div class="cell">4d</div><div class="cell">2d</div><div class="cell">1d</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL&#x2192;USDC Harvest</div><div class="cell">0%</div><div class="cell">70%</div><div class="cell" style="color:#ef4444">100%</div><div class="cell" style="color:#ef4444">100%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Auto Deploy (R7)</div><div class="cell" style="color:#22c55e">Yes</div><div class="cell" style="color:#22c55e">Yes</div><div class="cell" style="color:#22c55e">Yes</div><div class="cell" style="color:#ef4444">Blocked</div>
  </div></div>
  <div style="font-size:11px;color:#8b949e;margin-top:4px">Pool fee tier: <b>0.04%</b> (Orca SOL/USDC, tick spacing 4). Fee density matters &#x2014; tighter range = more concentrated liquidity = more fees per dollar at 0.04%.</div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Regime Rationale</h2>
  <div style="font-size:12px;color:#c9d1d9;line-height:1.6">
    <div style="margin-bottom:12px;padding:10px;background:#4a9eff10;border-left:3px solid #4a9eff;border-radius:0 6px 6px 0">
      <b style="color:#4a9eff">RANGING</b> &#x2014; Maximize fee earnings<br>
      Tight 1.5% range concentrates all capital into a narrow band, maximizing fee capture per dollar on a 0.04% pool. 100% capital deployed. Harvest weekly (fees accumulate slowly at 0.04%). Keep harvested SOL (no conversion needed &#x2014; price is stable). Risk: frequent OOR exits if price drifts, but close+reopen is cheap on Solana.
    </div>
    <div style="margin-bottom:12px;padding:10px;background:#22c55e10;border-left:3px solid #22c55e;border-radius:0 6px 6px 0">
      <b style="color:#22c55e">BULLISH_TREND</b> &#x2014; Ride the trend, protect downside<br>
      Wider 3% range with upward skew (20% down / 80% up) gives room for price to rise. 85% deployed &#x2014; small reserve for gas. Harvest every 4 days, convert 70% of SOL fees to USDC to lock gains as price rises. Auto-deploy enabled: idle capital gets added as price moves up within range.
    </div>
    <div style="margin-bottom:12px;padding:10px;background:#ef444410;border-left:3px solid #ef4444;border-radius:0 6px 6px 0">
      <b style="color:#ef4444">BEARISH_TREND</b> &#x2014; Stay deployed, protect aggressively<br>
      Moderate 2.5% range &#x2014; wider than RANGING for safety but not so wide that fee density collapses. 75% capital deployed (25% reserve). The real protection: harvest every 2 days + convert 100% of SOL to USDC immediately. This locks gains before price drops further and reduces SOL exposure. Auto-deploy enabled &#x2014; idle capital should reach the 75% cap efficiently; the deploy cap itself limits exposure. Downward skew (40/60) gives more room below.
    </div>
    <div style="padding:10px;background:#a855f710;border-left:3px solid #a855f7;border-radius:0 6px 6px 0">
      <b style="color:#a855f7">EXTREME</b> &#x2014; Survival mode<br>
      Widest 6% range, symmetric (50/50). Only 25% capital deployed &#x2014; 75% parked as USDC. Harvest daily, convert everything to USDC. Auto-deploy blocked. This is for crisis events (crashes, liquidation cascades, >8% daily vol). Goal: stay alive, minimize losses, keep earning some fees with minimal exposure.
    </div>
  </div>
</div>

<!-- ── THE 7 RULES ──────────────────────────────────────────────────── -->

<div class="section-title" style="color:#58a6ff">The 7 Rules</div>

<div class="rule-card">
  <h3><span class="rule-num">1</span> Asymmetric Range</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Sets the price range for the position. Skewed by regime to give more room in the expected direction.</p>
  <div class="logic-box">lower = price &#xD7; (1 - rangeWidth &#xD7; skewDown)
upper = price &#xD7; (1 + rangeWidth &#xD7; skewUp)</div>
  <div class="example-box">
    <div class="example-title">SOL = $85, RANGING</div>
    <div class="example-text">lower = $85 &#xD7; (1 - 0.015 &#xD7; 0.30) = <b>$84.62</b></div>
    <div class="example-text">upper = $85 &#xD7; (1 + 0.015 &#xD7; 0.70) = <b>$85.89</b></div>
    <div class="example-note">Total range $1.27. Room below $0.38 (30%), room above $0.89 (70%). The 30/70 skew gives price more room to rise before going OOR.</div>
  </div>
  <div class="trigger">Runs: on every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">2</span> Proximity Monitor &amp; Early Exit</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Measures how close price is to range edges. Exits <b>before</b> going out of range to reduce IL. Can be toggled on/off from the dashboard.</p>
  <div class="logic-box">proxToLower = (centre - price) / halfWidth    0% = safe, 100% = edge
proxToUpper = (price - centre) / halfWidth

Downside: proxToLower &#x2265; threshold &#x2192; close + reopen at current price
Upside:   proxToUpper &#x2265; threshold &#x2192; close + enter pullback watch (Rule 3)</div>
  <div class="example-box">
    <div class="example-title">Downside exit in RANGING</div>
    <div class="example-text">Range $84.62&#x2013;$85.89, centre = $85.26, halfWidth = $0.64</div>
    <div class="example-text">Price drops to $84.84 &#x2192; proxToLower = ($85.26 - $84.84) / $0.64 = <b>66%</b></div>
    <div class="example-text">RANGING threshold = 65% &#x2192; 66% &#x2265; 65% &#x2192; <b style="color:#f97316">EXIT</b></div>
    <div class="example-note">Closes at 66% instead of waiting for 100% (full OOR). Avoids the worst IL in the last 35% of drift, then reopens centered at $84.84.</div>
  </div>
  <div class="trigger">Runs: every 30s cycle when position is in range. Disabled = only close on full OOR.</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">3</span> Pullback Re-entry</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After an upside exit or OOR above, waits for price to pull back before re-entering. Avoids opening at a local peak. Flash crash protection on both upside and downside.</p>
  <div class="logic-box">After upside exit, track peak price.

pullback &#x2265; 2.5% from peak   &#x2192; re-enter immediately
waited &#x2265; 4 hours            &#x2192; re-enter (timeout)

<b>Flash crash guard (upside + downside):</b>
Detection: max drawdown &#x2265; 5% within the last 10 price readings
(peak-to-trough, not just endpoint-to-endpoint).

During pullback watch:
  1. Block re-entry for 15 minutes
  2. Reset peak to current price (forget old peak)
  3. Reset 4h timeout from now (full new window)

During OOR below:
  1. Close position but do NOT reopen
  2. Enter cooldown (same 15 min)
  3. Bot goes IDLE until cooldown expires, then opens fresh

This prevents chasing a falling knife on both upside
pullbacks and downside free-falls.</div>
  <div class="example-box">
    <div class="example-title">Normal pullback re-entry</div>
    <div class="example-text">OOR above at $85.15. Peak tracks to $86.50, then drops to $84.34.</div>
    <div class="example-text">Pullback = ($86.50 - $84.34) / $86.50 = <b>2.5%</b> &#x2192; <b style="color:#22c55e">RE-ENTER</b></div>
    <div class="example-note">If no 2.5% pullback within 4 hours, re-enters anyway to avoid missing fees indefinitely.</div>
  </div>
  <div class="example-box">
    <div class="example-title">Flash crash during pullback watch</div>
    <div class="example-text">Peak is $86.50. At hour 3:50, SOL crashes from $85 to $80 in 5 min (6% drop).</div>
    <div class="example-text">Flash crash detected &#x2192; 15-min cooldown. Peak reset to $80. Timeout reset to now + 4h.</div>
    <div class="example-text">Hour 4:05: cooldown expires. Peak is $80. Timeout not until hour 7:50.</div>
    <div class="example-text">Bot watches from $80: needs 2.5% pullback to $78 or waits until 7:50.</div>
    <div class="example-note">Without this fix, the old 4h timeout would have already expired and the bot would jump in at $80 right after the 15-min pause &#x2014; right into a still-falling market.</div>
  </div>
  <div class="trigger">Runs: every 30s cycle while WAITING_PULLBACK</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">4</span> Re-entry SOL/USDC Split</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After a downside exit, determines the SOL/USDC wallet ratio before opening a new position. Less SOL in bearish markets to reduce exposure.</p>
  <div class="logic-box"><span class="tag tag-ranging">RANGING</span>  50% SOL / 50% USDC    <span class="tag tag-bull">BULLISH</span>  50 / 50
<span class="tag tag-bear">BEARISH</span> 30% SOL / 70% USDC    <span class="tag tag-extreme">EXTREME</span> 20 / 80</div>
  <div class="example-box">
    <div class="example-title">BEARISH re-entry with $46</div>
    <div class="example-text">OOR_BELOW triggered. Regime is BEARISH &#x2192; target 30/70 split.</div>
    <div class="example-text">$13.80 in SOL (0.162 SOL at $85) + $32.20 USDC.</div>
    <div class="example-note">Holding less SOL limits losses if price keeps falling. The actual deposit ratio is determined by concentrated liquidity math; this split targets the wallet balance before deposit.</div>
  </div>
  <div class="trigger">Runs: on position open after downside exit (OOR_BELOW, T1_DOWNSIDE)</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">5</span> Position Sizing</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Controls what % of capital goes into the position. More volatile = more reserve. Opens with the constraining token (no swap); Rule 7 auto-deploy tops up the rest.</p>
  <div class="logic-box"><b>Capital allocation:</b>
<span class="tag tag-ranging">RANGING</span>  100% deployed   <span class="tag tag-bull">BULLISH</span>  85% deployed
<span class="tag tag-bear">BEARISH</span>  50% deployed   <span class="tag tag-extreme">EXTREME</span> 25% deployed

<b>Position open process:</b>
1. Total value = SOL &#xD7; price + USDC
2. Deploy target = total &#xD7; regime deployPct
3. Quote with constraining token (SOL or USDC &#x2014; whichever limits)
4. Open position with available capital (NO pre-swap)
5. Reserve: 0.1 SOL (gas + rent) + $1 USDC always kept

<b>Why no swap on open?</b>
Swapping before position open is risky: if the swap succeeds
but the position TX fails (rent, slippage), the wallet is left
imbalanced with no position. Instead, the position opens with
partial capital, and Rule 7 (auto-deploy) adds the remaining
idle funds within 5 minutes &#x2014; including any needed swap.
The swap inside auto-deploy is safe because the position already
exists and is earning fees.</div>
  <div class="example-box">
    <div class="example-title">Open with partial capital, auto-deploy tops up</div>
    <div class="example-text">Wallet: 0.5 SOL ($42) + $3,000 USDC. Position needs SOL:USDC ratio ~1:36.</div>
    <div class="example-text">Constraining token is SOL &#x2192; deposits 0.4 SOL + ~$14 USDC = $48.</div>
    <div class="example-text">~$2,985 USDC sits idle. Rule 7 detects idle funds in 5 min.</div>
    <div class="example-text">Auto-deploy swaps ~$1,500 USDC &#x2192; SOL, deposits both &#x2192; full capital deployed.</div>
    <div class="example-note">Total time to full deployment: ~5 min. Missed fees on idle portion: ~$0.01. But no risk of failed-swap + no-position deadlock.</div>
  </div>
  <div class="trigger">Runs: on every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">6</span> Fee Harvest</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Collects accrued trading fees from the position. More frequent in volatile markets to lock gains before IL erases them. After collection, converts harvested SOL to USDC based on regime policy.</p>
  <div class="logic-box"><b>Harvest intervals:</b>
<span class="tag tag-ranging">RANGING</span>  every 7 days   (let fees accumulate)
<span class="tag tag-bull">BULLISH</span>  every 4 days
<span class="tag tag-bear">BEARISH</span>  every 2 days   (lock gains quickly)
<span class="tag tag-extreme">EXTREME</span> every 1 day    (harvest ASAP)

<b>Post-harvest SOL &#x2192; USDC conversion:</b>
<span class="tag tag-ranging">RANGING</span>  0% (keep SOL)   <span class="tag tag-bull">BULLISH</span>  70% converted
<span class="tag tag-bear">BEARISH</span> 100% converted   <span class="tag tag-extreme">EXTREME</span> 100% converted</div>
  <div class="example-box">
    <div class="example-title">BEARISH: harvest + full SOL conversion</div>
    <div class="example-text">Day 2: collectFees tx &#x2192; 0.001 SOL + 0.08 USDC to wallet.</div>
    <div class="example-text">BEARISH policy = 100% convert &#x2192; swap 0.001 SOL &#x2192; ~$0.08 USDC.</div>
    <div class="example-text">Result: all harvested value in USDC, protected from further SOL decline.</div>
    <div class="example-note">In RANGING, harvested SOL stays as SOL (0% conversion). In trending/volatile markets, converting to USDC locks gains and reduces exposure.</div>
  </div>
  <div class="trigger">Runs: checked every 1 hour against last harvest time. Minimum $0.50 pending fees required to justify gas cost. SOL conversion capped to preserve gas reserve.</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">7</span> Auto Capital Deployment</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Deploys idle wallet funds into an <b>existing in-range position</b>. Does not open new positions &#x2014; Rules 1&#x2013;5 handle that. Only runs after all exit rules have been evaluated and none triggered.</p>
  <div class="logic-box"><b>6 conditions must ALL pass:</b>
  1. Feature enabled          (dashboard toggle)
  2. Regime allows it         (blocked in EXTREME only)
  3. Idle funds &gt; threshold   (SOL &gt; 0.05 or USDC &gt; $5, after reserves)
  4. Cooldown elapsed         (configurable, default 5 min)
  5. Capital cap headroom     (position below regime deploy % cap)
  6. Price within range       (not too close to edges)

<b>Reserves:</b>  0.05 SOL (gas) + $1 USDC always kept
<b>Cooldown:</b>  1 hour between deployments</div>
  <div class="example-box">
    <div class="example-title">Auto deploy after manual wallet top-up</div>
    <div class="example-text">You send $150 USDC to the wallet. Position range $83.65&#x2013;$84.97, price $84.25.</div>
    <div class="example-text">$149 idle (after $1 reserve). Price within 2% of ideal $84.31. RANGING = 100% cap.</div>
    <div class="example-text">Bot swaps ~$75 USDC &#x2192; SOL to match ratio, deposits both &#x2192; $148 deployed.</div>
    <div class="example-text">Wallet after: 0.065 SOL + $1.00 USDC (reserves only).</div>
  </div>
  <div class="example-box">
    <div class="example-title">Skipped: price near range edge</div>
    <div class="example-text">Range $83.65&#x2013;$84.97. Ideal (geometric mean) = $84.31. Price = $83.72.</div>
    <div class="example-text">Deviation = |$83.72/$84.31 - 1| = 0.7%. Within 2% tolerance, but...</div>
    <div class="example-text">If price drops further to $83.50 &#x2192; deviation 1.0%. Still passes.</div>
    <div class="example-text">At $82.60 &#x2192; deviation 2.03% &#x2192; <b style="color:#f97316">SKIPPED</b>. Deposit ratio would be too SOL-heavy.</div>
    <div class="example-note">The 2% tolerance prevents deploying when the required token ratio is heavily skewed, which would waste swap fees.</div>
  </div>
  <div class="example-box">
    <div class="example-title">Bot is idle (no position) &#x2014; auto deploy does NOT run</div>
    <div class="example-text">After a Rule 2 exit or during pullback watch, no position exists.</div>
    <div class="example-text">Auto deploy requires an existing position. Rules 1&#x2013;5 handle opening.</div>
    <div class="example-note">Once a new position is opened, auto deploy activates on the next 5-minute check.</div>
  </div>
  <div class="trigger">Runs: checked every 5 minutes when position is in range</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">8</span> Idle Wallet Rebalance</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Maintains a target SOL/USDC split for idle wallet capital based on the current regime. Swaps in either direction to reach the target. Triggers once per regime change. Does not touch the position &#x2014; only the wallet balance.</p>
  <div class="logic-box"><b>Target idle SOL % by regime:</b>
<span class="tag tag-ranging">RANGING</span>  50% SOL (balanced &#x2014; ready for LP deposits)
<span class="tag tag-bull">BULLISH</span>  60% SOL (ride the upside)
<span class="tag tag-bear">BEARISH</span>  35% SOL (protect with USDC)
<span class="tag tag-extreme">EXTREME</span> 15% SOL (maximum USDC protection)

<b>Triggers when:</b>
  1. Regime changes (any direction)
  2. Total idle value &gt; $100
  3. Current SOL % deviates &gt; 20% from target
  4. Swap amount &gt; $5 (skip dust)

<b>Swaps both ways:</b>
  SOL-heavy in BEARISH &#x2192; sell SOL for USDC
  USDC-heavy in BULLISH &#x2192; buy SOL with USDC
  Already near target &#x2192; skip, no swap needed

<b>Safety:</b>
  &#x2022; Always keep 0.15 SOL for gas
  &#x2022; Only once per regime change (no repeated swaps)
  &#x2022; Resets when regime changes again</div>
  <div class="example-box">
    <div class="example-title">RANGING &#x2192; BEARISH: too much SOL</div>
    <div class="example-text">Wallet: 5.9 SOL ($486) + $5 USDC. SOL % = 99%. Target = 35%.</div>
    <div class="example-text">Deviation 64% &gt; 20% threshold. Need to sell SOL to reach 35%.</div>
    <div class="example-text">Target SOL value = $172. Current = $486. Sell ~$314 worth = 3.82 SOL.</div>
    <div class="example-text">Wallet after: ~2.08 SOL ($171) + $319 USDC. SOL &#x2248; 35%. &#x2713;</div>
  </div>
  <div class="example-box">
    <div class="example-title">BEARISH &#x2192; BULLISH: too much USDC</div>
    <div class="example-text">Wallet: 0.5 SOL ($41) + $350 USDC. SOL % = 10%. Target = 60%.</div>
    <div class="example-text">Deviation 50% &gt; 20% threshold. Need to buy SOL with USDC.</div>
    <div class="example-text">Target SOL value = $234. Current = $41. Buy ~$193 worth &#x2192; 2.35 SOL.</div>
    <div class="example-text">Wallet after: ~2.85 SOL ($234) + $157 USDC. SOL &#x2248; 60%. &#x2713;</div>
  </div>
  <div class="example-box">
    <div class="example-title">Already near target &#x2192; skip</div>
    <div class="example-text">Wallet: 2.0 SOL ($164) + $200 USDC. SOL % = 45%. Target (RANGING) = 50%.</div>
    <div class="example-text">Deviation 5% &lt; 20% threshold &#x2192; <b style="color:#22c55e">SKIP</b>. No swap needed.</div>
  </div>
  <div class="trigger">Runs: once per regime change, all regimes. Skips if wallet already near target.</div>
</div>

<!-- ── RULE EXECUTION ORDER ─────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Rule Execution Order</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:8px">Rules are evaluated in strict order each cycle. If any rule triggers an action, the cycle returns immediately &#x2014; later rules are skipped.</p>
  <div class="logic-box">1. No position?  &#x2192; Open (R1, R4, R5) or pullback watch (R3)    <b style="color:#f97316">return</b>
2. Out of range? &#x2192; Close + reopen (below) or pullback (above)  <b style="color:#f97316">return</b>
3. Rule 2 exit?  &#x2192; Proximity triggered &#x2192; close + act           <b style="color:#f97316">return</b>
4. Max age?      &#x2192; Rebalance if position too old (configurable)  <b style="color:#f97316">return</b>
5. Rule 6        &#x2192; Harvest if due (min $0.50 threshold)
6. Rule 7        &#x2192; Auto deploy if conditions met
7. Rule 8        &#x2192; Idle wallet rebalance (once per regime change)
8. Log HOLD      &#x2192; Record state to DB</div>
  <div style="font-size:11px;color:#8b949e;margin-top:4px">Exit rules (1-3) are evaluated first. If none trigger, maintenance rules (4-7) run. Idle rebalance (R8) runs last &#x2014; only after confirming the position is safe and stable.</div>
</div>

<!-- ── STATE MACHINE ───────────────────────────────────────────────── -->

<div class="section-title" style="color:#a855f7">Bot State Machine</div>
<div class="card" style="margin-bottom:16px">
  <p style="font-size:12px;color:#8b949e;margin-bottom:12px">The bot operates in 3 states. Each state determines which rules are evaluated and what actions are possible. State is persisted to DB — survives restarts.</p>
  <svg width="100%" height="280" viewBox="0 0 600 280" preserveAspectRatio="xMidYMid meet" style="margin-bottom:12px">
    <!-- State boxes -->
    <rect x="30" y="110" width="130" height="50" rx="10" fill="#21262d" stroke="#8b949e" stroke-width="2"/>
    <text x="95" y="140" text-anchor="middle" fill="#8b949e" font-size="14" font-weight="bold">IDLE</text>
    <rect x="235" y="20" width="130" height="50" rx="10" fill="#21262d" stroke="#22c55e" stroke-width="2"/>
    <text x="300" y="50" text-anchor="middle" fill="#22c55e" font-size="14" font-weight="bold">ACTIVE</text>
    <rect x="440" y="110" width="130" height="50" rx="10" fill="#21262d" stroke="#eab308" stroke-width="2"/>
    <text x="505" y="130" text-anchor="middle" fill="#eab308" font-size="13" font-weight="bold">WAITING</text>
    <text x="505" y="148" text-anchor="middle" fill="#eab308" font-size="13" font-weight="bold">PULLBACK</text>
    <!-- IDLE → ACTIVE -->
    <path d="M 130 110 Q 180 50 235 45" fill="none" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arrowG)"/>
    <text x="155" y="65" fill="#22c55e" font-size="9">Open position</text>
    <text x="155" y="75" fill="#22c55e" font-size="9">or Resume</text>
    <!-- ACTIVE → IDLE -->
    <path d="M 235 60 Q 180 100 160 110" fill="none" stroke="#8b949e" stroke-width="1.5" marker-end="url(#arrowW)"/>
    <text x="175" y="105" fill="#8b949e" font-size="9">Pause / Close</text>
    <!-- ACTIVE → WAITING_PULLBACK -->
    <path d="M 365 50 Q 420 70 450 110" fill="none" stroke="#eab308" stroke-width="1.5" marker-end="url(#arrowY)"/>
    <text x="395" y="65" fill="#eab308" font-size="9">Upside exit</text>
    <text x="395" y="75" fill="#eab308" font-size="9">OOR above</text>
    <!-- WAITING_PULLBACK → ACTIVE -->
    <path d="M 440 120 Q 390 60 365 40" fill="none" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arrowG)"/>
    <text x="410" y="38" fill="#22c55e" font-size="9">Pullback or</text>
    <text x="410" y="48" fill="#22c55e" font-size="9">Timeout</text>
    <!-- ACTIVE self-loop (close+reopen) -->
    <path d="M 300 20 C 330 -10 370 -10 350 20" fill="none" stroke="#58a6ff" stroke-width="1.5" marker-end="url(#arrowB)"/>
    <text x="340" y="5" fill="#58a6ff" font-size="9">OOR below / R2 down</text>
    <text x="340" y="-5" fill="#58a6ff" font-size="8">(close + reopen)</text>
    <!-- Flash crash loop -->
    <path d="M 570 135 C 590 160 590 180 570 155" fill="none" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3"/>
    <text x="545" y="180" fill="#ef4444" font-size="8">Flash crash</text>
    <text x="545" y="190" fill="#ef4444" font-size="8">cooldown</text>
    <!-- Arrow markers -->
    <defs>
      <marker id="arrowG" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#22c55e"/></marker>
      <marker id="arrowW" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#8b949e"/></marker>
      <marker id="arrowY" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#eab308"/></marker>
      <marker id="arrowB" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#58a6ff"/></marker>
    </defs>
    <!-- Descriptions below -->
    <rect x="20" y="200" width="170" height="70" rx="6" fill="#0d1117" stroke="#21262d"/>
    <text x="105" y="218" text-anchor="middle" fill="#8b949e" font-size="10" font-weight="bold">IDLE</text>
    <text x="30" y="232" fill="#8b949e" font-size="9">No active management.</text>
    <text x="30" y="244" fill="#8b949e" font-size="9">Position may exist (paused)</text>
    <text x="30" y="256" fill="#8b949e" font-size="9">or be closed (stopped).</text>
    <rect x="215" y="200" width="170" height="70" rx="6" fill="#0d1117" stroke="#21262d"/>
    <text x="300" y="218" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="bold">ACTIVE</text>
    <text x="225" y="232" fill="#8b949e" font-size="9">Full decision loop running.</text>
    <text x="225" y="244" fill="#8b949e" font-size="9">Monitors proximity, OOR,</text>
    <text x="225" y="256" fill="#8b949e" font-size="9">harvest, auto-deploy.</text>
    <rect x="410" y="200" width="170" height="70" rx="6" fill="#0d1117" stroke="#21262d"/>
    <text x="495" y="218" text-anchor="middle" fill="#eab308" font-size="10" font-weight="bold">WAITING PULLBACK</text>
    <text x="420" y="232" fill="#8b949e" font-size="9">Position closed. Watching</text>
    <text x="420" y="244" fill="#8b949e" font-size="9">for pullback or timeout</text>
    <text x="420" y="256" fill="#8b949e" font-size="9">before re-entering (R3).</text>
  </svg>
  <div style="font-size:12px;color:#c9d1d9;line-height:1.8">
    <div style="margin-bottom:8px"><b style="color:#8b949e">IDLE &#x2192; ACTIVE:</b> Bot opens a position (startup, resume from pause, or first run). Rules 1, 4, 5 calculate range and deploy capital.</div>
    <div style="margin-bottom:8px"><b style="color:#22c55e">ACTIVE &#x2192; ACTIVE (self-loop):</b> OOR below or Rule 2 downside exit. Bot closes position, re-checks regime (may update parameters), and reopens at current price. If flash crash detected during OOR below, enters cooldown instead of reopening (free-fall protection).</div>
    <div style="margin-bottom:8px"><b style="color:#eab308">ACTIVE &#x2192; WAITING_PULLBACK:</b> Rule 2 upside exit or OOR above. Price rose past the range. Bot closes position and waits for a pullback before re-entering (Rule 3). Avoids buying at a local top.</div>
    <div style="margin-bottom:8px"><b style="color:#22c55e">WAITING_PULLBACK &#x2192; ACTIVE:</b> Either price pulls back enough (configurable %, default 1%) or timeout expires (configurable, default 15 min). Bot opens new position. If flash crash detected during wait, cooldown enforced (configurable, default 15 min) and peak/timeout reset.</div>
    <div style="margin-bottom:8px"><b style="color:#a855f7">TX Backoff:</b> If position open/close fails repeatedly (RPC errors), the bot backs off exponentially: 60s &#x2192; 120s &#x2192; 240s &#x2192; 300s cap. Resets on first successful TX.</div>
    <div style="margin-bottom:8px"><b style="color:#8b949e">ACTIVE &#x2192; IDLE:</b> User pauses bot or closes position from dashboard. Position may stay open (paused) or be closed (manual close).</div>
    <div><b style="color:#ef4444">Emergency Stop:</b> From any state &#x2192; IDLE. Closes position if open, saves state, exits process.</div>
  </div>
  <div style="margin-top:12px;padding:10px;background:#0d1117;border-radius:6px;font-size:11px;color:#8b949e;line-height:1.6">
    <b style="color:#a855f7">Crash recovery:</b> All state (including pullback watch status, peak price, and timeout start) is persisted to DB every cycle and on shutdown. On restart, the bot resumes in the correct state &#x2014; if it was waiting for a pullback, it continues waiting rather than opening a new position immediately.
  </div>
</div>

<!-- ── CIRCUIT BREAKERS ─────────────────────────────────────────────── -->

<div class="section-title" style="color:#ef4444">Circuit Breakers</div>
<div class="card" style="margin-bottom:16px">
  <div class="logic-box"><b>Daily Loss</b>        portfolio drops &gt; 5%         &#x2192; HALT
<b>Weekly Drawdown</b>   drops &gt; 15% from peak      &#x2192; HALT
<b>Max IL</b>            impermanent loss &gt; 8%       &#x2192; force rebalance
<b>Rebalance Limit</b>  &gt; 10 per hour               &#x2192; pause
<b>Min Position</b>     &lt; $100 USDC                  &#x2192; skip open
<b>Flash Crash</b>      &gt; 5% single drop             &#x2192; wait 15 min</div>
</div>

<!-- ── CONCENTRATED LIQUIDITY PRIMER ────────────────────────────────── -->

<div class="section-title" style="color:#58a6ff">How Concentrated Liquidity Works</div>
<div class="card" style="margin-bottom:16px">
  <p style="font-size:12px;color:#c9d1d9;line-height:1.6;margin-bottom:8px">
    Unlike traditional AMMs (liquidity from $0 to &#x221E;), concentrated liquidity focuses capital in a <b>specific price range</b>.
    Higher fee yield per $, but the range must be actively managed.
  </p>
  <div class="logic-box">At lower bound  &#x2192; 100% SOL,  0% USDC  (bought the dip)
At centre       &#x2192; ~50% SOL, ~50% USDC
At upper bound  &#x2192;  0% SOL, 100% USDC  (sold the top)

This is why deposit ratio isn't 50/50 and why Rule 5 swaps to match.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
    <div style="background:#0d1117;border-radius:6px;padding:10px;font-size:11px">
      <div style="color:#22c55e;font-weight:bold;margin-bottom:4px">Advantages</div>
      <div style="color:#c9d1d9;line-height:1.5">Higher fee yield per $. Capital efficient. Earn on every swap through your range.</div>
    </div>
    <div style="background:#0d1117;border-radius:6px;padding:10px;font-size:11px">
      <div style="color:#ef4444;font-weight:bold;margin-bottom:4px">Risks</div>
      <div style="color:#c9d1d9;line-height:1.5">Impermanent loss on price moves. Out of range = zero fees. Narrower range = more fees but more IL.</div>
    </div>
  </div>
</div>

</body>
</html>`;
}

// ── Status page ───────────────────────────────────────────────────────────

function renderStatusHtml(checks: Array<{ name: string; description: string; status: string; detail: string; lastChecked: number }>, uptime: number): string {
  const uptimeMin = Math.floor(uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
  const okCount = checks.filter(c => c.status === 'ok').length;
  const errorCount = checks.filter(c => c.status === 'error').length;
  const allOk = errorCount === 0;

  const rows = checks.map(c => {
    const dot = c.status === 'ok' ? '#22c55e' : '#ef4444';
    return `<div style="display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid #21262d">
      <div style="min-width:12px;padding-top:3px;flex-shrink:0"><div class="dot" style="background:${dot}"></div></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-weight:bold;font-size:13px;color:#c9d1d9">${c.name}</div>
          <div style="font-size:10px;color:#8b949e">${new Date(c.lastChecked).toLocaleTimeString('en-US', { hour12: false, timeZone: TZ })}</div>
        </div>
        <div style="font-size:11px;color:#8b949e;margin-top:2px">${c.description}</div>
        <div style="font-size:12px;color:${c.status === 'ok' ? '#c9d1d9' : '#ef4444'};margin-top:4px;font-family:monospace;word-break:break-word">${c.detail}</div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>SOL/USDC LP Bot - Status</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:${allOk ? '#22c55e' : '#ef4444'}">${allOk ? 'All Systems Operational' : errorCount + ' Issue(s) Detected'}</div>
  <h1>Live Data Status</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | ${okCount}/${checks.length} checks passing | Auto-refreshes every 30 min</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-status').classList.add('active')</script>

<div class="card" style="margin-bottom:16px">
  <div style="display:flex;gap:16px;justify-content:center;padding:8px 0">
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:#22c55e">${okCount}</div>
      <div style="font-size:11px;color:#8b949e">Passing</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${errorCount > 0 ? '#ef4444' : '#8b949e'}">${errorCount}</div>
      <div style="font-size:11px;color:#8b949e">Failing</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:#8b949e">${checks.length}</div>
      <div style="font-size:11px;color:#8b949e">Total</div>
    </div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Data Sources &amp; Services</h2>
  ${rows}
</div>

<div style="text-align:center;margin-top:16px">
  <a href="/api/health" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:12px">View as JSON</a>
</div>

</body>
</html>`;
}

// ── ARCADE PAGE ──────────────────────────────────────────────────────────

function renderArcadeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MISSION STATUS</title>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1a1a0a;--orange:#ff6600;--yellow:#ffcc00;--green:#00cc44;--red:#cc0000;--khaki:#8b8b4b;--white:#fff;--pink:#ff00ff}
body{background:var(--bg);color:var(--white);font-family:'Press Start 2P',monospace;font-size:10px;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow-x:hidden;text-transform:uppercase}
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,0.15) 0px,rgba(0,0,0,0.15) 2px,transparent 2px,transparent 4px);pointer-events:none;z-index:9999}
#loading{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9998}
#loading .lt{color:var(--yellow);font-size:16px;animation:blink 1s step-end infinite}
#loading .lbar{width:280px;height:14px;background:#222;border:1px solid var(--khaki);margin:16px 0;border-radius:2px;overflow:hidden;position:relative}
#loading .lbar::after{content:'';position:absolute;top:0;left:-40%;width:40%;height:100%;background:var(--orange);animation:loadSlide 1.2s ease-in-out infinite}
#loading .lsub{color:var(--khaki);font-size:8px;animation:blink 2s step-end infinite}
#main{width:min(95vw,860px);border:3px dashed var(--khaki);padding:28px;position:relative;background:rgba(0,0,0,0.3);display:none}
#main::before,#main::after{content:'';position:absolute;width:12px;height:12px;border-color:var(--khaki);border-style:solid}
#main::before{top:-1px;left:-1px;border-width:3px 0 0 3px}
#main::after{top:-1px;right:-1px;border-width:3px 3px 0 0}
.corners::before,.corners::after{content:'';position:absolute;width:12px;height:12px;border-color:var(--khaki);border-style:solid}
.corners::before{bottom:-1px;left:-1px;border-width:0 0 3px 3px}
.corners::after{bottom:-1px;right:-1px;border-width:0 3px 3px 0}
.title{color:var(--yellow);font-size:14px;margin-bottom:4px}
.sub{display:flex;justify-content:space-between;color:var(--khaki);font-size:8px;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #333}
.port{text-align:center;margin:20px 0}
.port .label{color:var(--yellow);font-size:11px;margin-bottom:8px;letter-spacing:2px}
.port .val{color:var(--orange);font-size:52px;line-height:1;text-shadow:0 0 20px rgba(255,102,0,0.3)}
.port .chg{margin-top:8px;font-size:16px}
.chg.pos{color:var(--green);text-shadow:0 0 8px rgba(0,204,68,0.3);animation:glowG 2s ease-in-out infinite}
.chg.neg{color:var(--red);text-shadow:0 0 8px rgba(204,0,0,0.3);animation:glowR 2s ease-in-out infinite}
.intel{color:var(--yellow);font-size:10px;margin:20px 0 10px;letter-spacing:2px}
.fees{display:flex;gap:16px;margin-bottom:16px}
.fees .stat{flex:1;text-align:center;padding:10px 6px;border:1px dashed #444}
.fees .stat .lbl{color:var(--khaki);font-size:8px;margin-bottom:6px}
.fees .stat .v{font-size:22px}
.fees .stat .var{font-size:8px;margin-top:4px}
.players-label{color:var(--yellow);font-size:10px;margin:20px 0 10px;letter-spacing:2px}
.player-row{display:flex;align-items:center;gap:8px;height:28px;font-size:9px}
.player-rank{width:32px;text-align:right;font-size:9px;flex-shrink:0}
.player-name{width:100px;color:var(--white);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.player-pts{width:70px;color:var(--yellow);text-align:right;flex-shrink:0}
.player-bar-wrap{flex:1;height:8px;background:#1a1a1a;border-radius:4px;overflow:hidden;min-width:40px}
.player-bar-fill{height:100%;border-radius:4px;transition:width 1.5s cubic-bezier(0.22,1,0.36,1)}
.players-total{text-align:center;color:var(--khaki);font-size:8px;margin-top:10px;letter-spacing:1px}
.regime{margin:16px 0;font-size:14px}
.meta{margin-top:16px;padding-top:8px;border-top:1px solid #333;font-size:9px;color:#666}
.meta .row{display:flex;justify-content:space-between;margin-bottom:4px}
.coin-wrap{text-align:center;margin-top:10px}
.coin{color:var(--pink);font-size:12px;animation:blink 0.8s step-end infinite}
.extreme{animation:borderFlash 0.5s step-end infinite}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes loadSlide{0%{left:-40%}100%{left:100%}}
@keyframes glowG{0%,100%{text-shadow:0 0 8px rgba(0,204,68,0.2)}50%{text-shadow:0 0 14px rgba(0,204,68,0.5)}}
@keyframes glowR{0%,100%{text-shadow:0 0 8px rgba(204,0,0,0.2)}50%{text-shadow:0 0 14px rgba(204,0,0,0.5)}}
@keyframes borderFlash{0%,49%{border-color:var(--khaki)}50%,100%{border-color:#ff0000}}
@media(max-width:600px){
  #main{margin:8px;padding:14px;border-width:2px}
  .title{font-size:9px}
  .sub{font-size:7px}
  .port .label{font-size:8px}
  .port .val{font-size:30px}
  .port .chg{font-size:10px}
  .intel{font-size:8px}
  .fees{flex-direction:column;gap:8px}
  .fees .stat .lbl{font-size:7px}
  .fees .stat .v{font-size:15px}
  .fees .stat .var{font-size:7px}
  .regime{font-size:10px}
  .player-row{font-size:8px;height:24px}
  .player-rank{width:24px;font-size:8px}
  .player-name{width:80px;font-size:8px}
  .player-pts{width:60px;font-size:8px}
  .player-bar-wrap{display:none}
  .players-label{font-size:8px}
  .players-total{font-size:7px}
  .meta{font-size:8px}
  .coin{font-size:9px}
  #loading .lt{font-size:12px}
  #loading .lbar{width:200px}
  #loading .lsub{font-size:7px}
}
</style></head><body>
<div id="loading">
  <div class="lt">LOADING...</div>
  <div class="lbar"></div>
  <div class="lsub" id="load-msg">ESTABLISHING CONNECTION...</div>
</div>
<div id="main" class="corners">
  <span class="title">&#9733; MISSION STATUS</span>
  <div class="sub"><span>CLASSIFIED</span><span>SOL/USDC LP</span></div>
  <div class="port">
    <div class="label">PORTFOLIO VALUE</div>
    <div class="val" id="portfolio"></div>
    <div class="chg" id="change"></div>
  </div>
  <div class="intel">&#9472; INTEL REPORT &#9472;</div>
  <div class="fees">
    <div class="stat"><div class="lbl">FEES ALL TIME</div><div class="v" style="color:var(--orange)" id="fees"></div></div>
    <div class="stat"><div class="lbl">FEES LAST 4H</div><div class="v" style="color:var(--green)" id="fees4h"></div><div class="var" id="feesVar"></div></div>
  </div>
  <div class="players-label">&#9472; PLAYERS &#9472;</div>
  <div id="players"></div>
  <div class="players-total" id="players-total"></div>
  <div class="regime" id="regime"></div>
  <div class="meta">
    <div class="row"><span id="lastUp"></span><span>NEXT IN: <span id="cd">--:--</span></span></div>
    <div class="row"><span id="lastKnown"></span><span></span></div>
  </div>
  <div class="coin-wrap"><span class="coin">[INSERT COIN]</span></div>
</div>
<script>
var REFRESH=4*3600*1000,lastFetch=0,refreshTimer=null;
var RE={RANGING:'\\u{1F634} RANGING',BULLISH_TREND:'\\u{1F680} BULLISH',BEARISH_TREND:'\\u{1F43B} BEARISH',EXTREME:'\\u{1F4A5} EXTREME'};

function setLoadMsg(m){document.getElementById('load-msg').textContent=m;}

function isValid(d){
  return d&&typeof d.portfolioNow==='number'&&d.portfolioNow>100
    &&typeof d.feesAllTime==='number'&&d.regime&&d.regime.length>0;
}

function countUp(el,target,pre,suf,dec,dur){
  pre=pre||'';suf=suf||'';dec=dec||0;dur=dur||1500;
  var st=null;
  function step(ts){if(!st)st=ts;var p=Math.min((ts-st)/dur,1);p=1-Math.pow(1-p,3);
    el.textContent=pre+(dec>0?(target*p).toFixed(dec):Math.round(target*p).toLocaleString())+suf;
    if(p<1)requestAnimationFrame(step);}
  requestAnimationFrame(step);
}

function renderData(d){
  countUp(document.getElementById('portfolio'),d.portfolioNow,'$','',2);
  countUp(document.getElementById('fees'),d.feesAllTime,'$','',2);
  countUp(document.getElementById('fees4h'),d.fees4h,'$','',2);
  var fv=document.getElementById('feesVar');
  if(d.feesVariance!=null){
    fv.textContent='vs prev 4h: '+(d.feesVariance>=0?'+':'')+d.feesVariance.toFixed(1)+'%';
    fv.style.color=d.feesVariance>=0?'#00cc44':'#cc0000';
  }else{fv.textContent='vs prev 4h: NEW';fv.style.color='#8b8b4b';}
  function fmtScore(n){return Math.round(n).toLocaleString();}
  var colors=['#ffcc00','#ffffff','#cd7f32'];
  var pc=document.getElementById('players');pc.innerHTML='';
  if(d.players&&d.players.length){
    var hdr=document.createElement('div');hdr.className='player-row';
    hdr.innerHTML='<span class="player-rank" style="color:#8b8b4b">RANK</span><span class="player-name" style="color:#8b8b4b">NAME</span><span class="player-pts" style="color:#8b8b4b">SCORE</span><span class="player-bar-wrap"></span>';
    pc.appendChild(hdr);
    var maxP=d.players[0].totalInvested;
    d.players.forEach(function(p,i){
      var rc=i<3?colors[i]:'#444';
      var pct=maxP>0?((p.totalInvested/maxP)*100).toFixed(1):'0';
      var row=document.createElement('div');row.className='player-row';
      row.innerHTML='<span class="player-rank" style="color:'+rc+'">'+(i===0?'👑 ':'')+'#'+(i+1)+'</span>'
        +'<span class="player-name">'+p.name.toUpperCase()+'</span>'
        +'<span class="player-pts">'+fmtScore(p.totalInvested)+'</span>'
        +'<span class="player-bar-wrap"><span class="player-bar-fill" style="width:'+pct+'%;background:'+rc+'"></span></span>';
      pc.appendChild(row);
    });
    document.getElementById('players-total').textContent='TOTAL SCORE: '+d.totalInvested.toLocaleString()+' PTS';
  }
  var ch=d.portfolioChange,cp=d.portfolioChangePct;
  var ce=document.getElementById('change');
  ce.className='chg '+(ch>=0?'pos':'neg');
  ce.textContent=(ch>=0?'+':'')+ch.toFixed(2)+' ('+(cp>=0?'+':'')+cp.toFixed(1)+'%) '+(ch>=0?'\\u25B2':'\\u25BC');
  document.getElementById('regime').textContent='REGIME: '+(RE[d.regime]||d.regime);
  var m=document.getElementById('main');
  if(d.regime==='EXTREME')m.classList.add('extreme');else m.classList.remove('extreme');
  if(d.status==='IDLE')document.getElementById('lastKnown').textContent='LAST KNOWN';
  else document.getElementById('lastKnown').textContent='';
  var t=new Date(d.lastUpdated);
  document.getElementById('lastUp').textContent='LAST: '+t.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Berlin'})+' CET';
}

function loadData(){
  var ctrl=new AbortController();
  var to=setTimeout(function(){ctrl.abort();},4000);
  fetch('/api/arcade-stats',{signal:ctrl.signal}).then(function(r){
    clearTimeout(to);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();
  }).then(function(d){
    if(!isValid(d)){setLoadMsg('BOT INITIALISING...');setTimeout(loadData,5000);return;}
    renderData(d);
    document.getElementById('loading').style.display='none';
    document.getElementById('main').style.display='block';
    lastFetch=Date.now();
    if(!refreshTimer)refreshTimer=setInterval(loadData,REFRESH);
  }).catch(function(e){
    clearTimeout(to);
    setLoadMsg(e&&e.name==='AbortError'?'CONNECTION TIMEOUT...':'RECONNECTING...');
    setTimeout(loadData,5000);
  });
}

function countdown(){
  if(!lastFetch){document.getElementById('cd').textContent='--:--';return;}
  var rem=Math.max(0,REFRESH-(Date.now()-lastFetch));
  var m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
  document.getElementById('cd').textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
}

loadData();
setInterval(countdown,1000);
</script></body></html>`;
}

// ── ANALYSIS AGENT PAGE ─────────────────────────────────────────────────

function renderAnalysisHtml(enabled: boolean, lastReport: string | null, lastRunTime: number | null): string {
  // TZ set by middleware from browser cookie
  const lastRunStr = lastRunTime ? new Date(lastRunTime).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : 'Never';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP Bot - Analysis Agent</title>
<style>${SHARED_STYLES}
.agent-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.agent-card h2{color:#a855f7;font-size:16px;margin-bottom:8px}
.agent-card h3{color:#58a6ff;font-size:13px;margin:12px 0 6px}
.toggle-row{display:flex;align-items:center;gap:12px;margin:12px 0}
.toggle-btn{padding:10px 24px;border:none;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;transition:all 0.2s}
.toggle-on{background:#238636;color:#fff}
.toggle-off{background:#da3633;color:#fff}
.run-btn{background:#58a6ff;color:#000;padding:10px 24px;border:none;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer}
.run-btn:disabled{opacity:0.5;cursor:not-allowed}
.report-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:16px;font-family:'SF Mono',Menlo,monospace;font-size:11px;line-height:1.6;color:#c9d1d9;white-space:pre-wrap;overflow-x:auto;max-height:600px;overflow-y:auto;-webkit-overflow-scrolling:touch}
.how-it-works{font-size:12px;color:#8b949e;line-height:1.6}
.how-it-works li{margin-bottom:6px}
.status-badge{display:inline-block;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:bold}
.badge-on{background:#23863620;color:#238636;border:1px solid #238636}
.badge-off{background:#da363320;color:#da3633;border:1px solid #da3633}
#run-status{font-size:12px;margin-top:8px}
@media(max-width:700px){
  .agent-card{padding:12px}
  .agent-card h2{font-size:14px}
  .report-box{font-size:10px;padding:10px;max-height:400px}
  .toggle-btn,.run-btn{padding:10px 16px;font-size:13px}
}
</style></head><body>
<div class="banner">
  <div class="mode" style="color:#a855f7">Analysis Agent</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Execution pattern analysis & optimization suggestions</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-analysis').classList.add('active')</script>

<div class="agent-card">
  <h2>🔬 Analysis Agent</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:12px">
    Reads execution data from the last 7 days and produces optimization suggestions.
    <b>Read-only</b> — never modifies bot state, config, or positions. Only observes and recommends.
  </p>

  <div class="toggle-row">
    <span style="color:#8b949e;font-size:12px">Weekly Auto-Report:</span>
    <span class="status-badge ${enabled ? 'badge-on' : 'badge-off'}" id="status-badge">${enabled ? 'ENABLED' : 'DISABLED'}</span>
    <button class="toggle-btn ${enabled ? 'toggle-off' : 'toggle-on'}" id="toggle-btn" onclick="toggleAgent()">${enabled ? 'Disable' : 'Enable'}</button>
  </div>
  <div style="font-size:11px;color:#8b949e">When enabled, runs automatically every Sunday midnight (Berlin) and sends report via Telegram.</div>

  <div style="margin-top:16px">
    <button class="run-btn" id="run-btn" onclick="runNow()">▶ Run Analysis Now</button>
    <div style="font-size:11px;color:#8b949e;margin-top:4px">Last run: ${lastRunStr}</div>
    <div id="run-status"></div>
  </div>
</div>

<div class="agent-card">
  <h3>📋 How It Works</h3>
  <ul class="how-it-works">
    <li><b>Position Duration:</b> Tracks how long positions stay open. If most die in &lt;1 hour, the range may be too tight or proximity thresholds too aggressive.</li>
    <li><b>Fee Rate by Regime:</b> Compares $/hr earned in RANGING vs BEARISH vs BULLISH. Identifies which regime generates the most value.</li>
    <li><b>Peak Fee Hours:</b> Analyzes fee income by hour of day (Berlin time). Finds the best and worst hours for fee generation — useful for timing manual operations.</li>
    <li><b>Weekday vs Weekend:</b> Compares fee rates. Weekend volume is typically 40-60% of weekday on Solana DEXes.</li>
    <li><b>Exit Efficiency:</b> Detects "unnecessary" T1 exits where price bounced back within 30 minutes. These burn gas without preventing real IL.</li>
    <li><b>Gas Efficiency:</b> Measures the fee-to-gas ratio. Higher is better. Below 10x means rebalancing costs are eating into profits.</li>
    <li><b>Suggestions:</b> Based on all the above, produces specific parameter change recommendations with estimated impact.</li>
  </ul>
</div>

<div class="agent-card">
  <h3>📊 Latest Report</h3>
  <div class="report-box" id="report-box">${lastReport ? lastReport.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'No report yet. Click "Run Analysis Now" to generate one.'}</div>
</div>

<script>
function toggleAgent() {
  var btn = document.getElementById('toggle-btn');
  var badge = document.getElementById('status-badge');
  var isOn = badge.classList.contains('badge-on');
  var newState = !isOn;
  btn.disabled = true;
  fetch('/api/analysis/toggle', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled: newState})
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.success) {
      badge.textContent = newState ? 'ENABLED' : 'DISABLED';
      badge.className = 'status-badge ' + (newState ? 'badge-on' : 'badge-off');
      btn.textContent = newState ? 'Disable' : 'Enable';
      btn.className = 'toggle-btn ' + (newState ? 'toggle-off' : 'toggle-on');
    }
    btn.disabled = false;
  }).catch(function() { btn.disabled = false; });
}

function runNow() {
  var btn = document.getElementById('run-btn');
  var status = document.getElementById('run-status');
  var box = document.getElementById('report-box');
  btn.disabled = true;
  status.textContent = 'Running analysis...';
  status.style.color = '#eab308';
  fetch('/api/analysis/run', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.success) {
        box.textContent = d.report;
        status.textContent = 'Report generated at ' + new Date().toLocaleTimeString();
        status.style.color = '#22c55e';
      } else {
        status.textContent = 'Error: ' + (d.error || 'unknown');
        status.style.color = '#ef4444';
      }
      btn.disabled = false;
    }).catch(function(err) {
      status.textContent = 'Error: ' + err;
      status.style.color = '#ef4444';
      btn.disabled = false;
    });
}
</script>
</body></html>`;
}
