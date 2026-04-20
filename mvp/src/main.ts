import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { OracleService } from './data/oracle.js';
import { PoolService } from './data/pool.js';
import { initDb, getBotState, upsertBotState, getRebalanceEvents, getHistoryDayCount, backfillPriceHistory, getDailyPnl, upsertDailyPnl, insertPriceTick, insertRebalanceEvent, getDailyCloses, insertLiveSnapshot, getLiveSnapshots, getLiveInRangePct, insertDecisionLog, getDecisionLogs, insertRegimeChange, getRegimeHistory, exportAllData, getRuleEnabled, setRuleEnabled, insertRegimeSnapshot, pruneOldData } from './db/sqlite.js';
import { startDashboard } from './output/dashboard.js';
import { LiveExecutor, type LivePosition } from './live/executor.js';
import { startTelegramReporter, alertIdleRebalance, alertSolConvert, alertStrategicRebalance } from './output/telegram.js';
import type { LiveData } from './output/dashboard.js';
import { loadWallet, getWalletBalances, validateWalletForLive } from './live/wallet.js';
import { detectRegime, detectRegimeWithMetrics, detectRegimeEnhanced, detectRegimeTA, getRegimeParams } from './engine/regime.js';
import { MarketDataService } from './data/market.js';
import { calcRange, calcProximity, shouldFireDownside, shouldFireUpside, isFlashCrash, getDownsideReentrySplit, isHarvestDue, checkAutoDeploy } from './engine/rules.js';
import { MINTS, REGIME_TRANSITION_RULES } from './constants.js';
import type { BotState, Regime, EventType } from './types.js';
import { runtime, applyConfigFromDb } from './config.js';
import { getConfig, setConfig, upsertDailySummary, getDailySummaries, getAllDailySummaries, getFeesCollected } from './db/sqlite.js';
import { calculateVarParams, shouldAdjustRange, calculateIdleTarget, shouldRebalanceIdle, calculateSwapPnl } from './engine/var.js';
import type { VarConfig, SirConfig } from './engine/var.js';
import { insertSwapLedger, backfillSwapLedgerCostBasis } from './db/sqlite.js';
import { bootstrapCostBasis, updateCostBasis, readCostBasis, recalculateFromCurrentHoldings, reduceCostBasisHoldings } from './tracking/costBasis.js';
import { getReserveState, updateReserve, computeFloor, routeHarvest, checkDeployGate, checkReserveFloor } from './reserve/reserveManager.js';
import { checkDefensiveTriggers, checkDefensiveExit, updateEntryPriceLow, makeInitialState, type DefensiveState } from './engine/defensive.js';
import * as regimeRefresh from './engine/regimeRefresh.js';
import * as dynamicScaling from './engine/dynamicScaling.js';

// ── Process-level safety nets ─────────────────────────────────────────────
// Prevent stray promise rejections or exceptions (e.g. Solana web3.js retry
// layers, fire-and-forget RPC calls) from crashing the bot process.
process.on('unhandledRejection', (reason: unknown) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: '[Process] Unhandled promise rejection',
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 3).join(' | ') : undefined,
    timestamp: Date.now(),
  }));
  // do NOT exit — log and continue
});

process.on('uncaughtException', (err: Error) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: '[Process] Uncaught exception',
    error: err.message,
    stack: err.stack?.split('\n').slice(0, 3).join(' | '),
    timestamp: Date.now(),
  }));
  // do NOT exit — log and continue
});

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
runtime.maxLiveCapitalUsdc = parseFloat(process.env.MAX_LIVE_CAPITAL_USDC ?? '25000');
runtime.rangeWidthOverride = process.env.RANGE_WIDTH_OVERRIDE ? parseFloat(process.env.RANGE_WIDTH_OVERRIDE) : null;
runtime.minIdleUsdc = parseFloat(process.env.MIN_IDLE_USDC ?? '5');
runtime.minIdleSol = parseFloat(process.env.MIN_IDLE_SOL ?? '0.05');
runtime.minDeployUsdcFloor = parseFloat(process.env.MIN_DEPLOY_USDC ?? '50');
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
// Phase 19: pause state carried from wallet validation. If paused at startup,
// main cycle should emit a heartbeat and skip operations until recovered.
let startupPaused = false;
let startupPauseReason: string = '';
let lastUpsideExitPrice = 0;
let lastUpsideExitTs = 0;
// Regime-Change Refresh (RCR) in-memory state (restored from DB below)
let rcrMarkedForSwitch: boolean = (savedState?.marked_for_switch ?? 0) === 1;
let rcrMarkTimestamp: number | null = savedState?.mark_timestamp ?? null;
let rcrMarkTargetRegime: Regime | null = (savedState?.mark_target_regime ?? null) as Regime | null;
let rcrEntryRegime: Regime | null = (savedState?.entry_regime ?? null) as Regime | null;
let rcrLastSwitchTs: number | null = savedState?.last_switch_timestamp ?? null;
let liveLastHarvestTime = savedState?.last_harvest_time || Date.now(); // default to now, not epoch 0
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
let lastRegimeChangeTs = 0;
let reopenPendingTs: number | null = null;
let reopenPendingRegime: string | null = null;
let reopenPendingUrgency: string | null = null;
let reopenPendingOldRegime: string | null = null;
let lastPositionCloseTs = 0;
let lastBbWidth: number | null = null;
let lastRsi: number | null = null;
let lastHoldLogTime = 0;
let currentLiveData: LiveData | null = null;
let lastPendingFeesCheck = 0;
let cachedPendingFeesSol = 0;
let cachedPendingFeesUsdc = 0;
let cachedPendingFeesTotal = 0;
let liveLastAutoDeployTime = 0;
let liveLastAutoDeployCheck = 0;
let autoDeployNullCount = 0; // consecutive cycles increaseLiquidity returned null — used to throttle log level
let liveLastHarvestCheck = 0;
let autoDeployEnabled = true; // will be loaded from DB
let liveFlashCrashCooldownUntil = parseInt(getConfig(db)['flashCrashCooldownUntil'] ?? '0'); // persisted across restarts
let liveRecentPrices: number[] = []; // last ~10 prices for flash crash detection
let consecutiveTxFailures = 0; // exponential backoff on repeated TX failures
let txBackoffUntil = 0; // timestamp: skip position operations until this time
let lastIdleRebalanceRegime: string | null = null; // track which regime last triggered idle rebalance
let lastIdleRebalanceTime = 0; // timestamp of last idle rebalance (30-min cooldown)
let lastVarAdjustTime = 0; // timestamp of last VAR range adjustment
let lastSirSwapTime = 0; // timestamp of last SIR idle swap
// Weighted average SOL cost basis — backed by DB, updated at every acquisition event.
// Read from DB on startup; bootstraps from history if DB columns are empty.
let costBasisState = bootstrapCostBasis(db);
// USDC reserve — seeded and logged during main() startup after wallet balances are available.
// Kept as module-level var so harvest routing can read it without extra DB reads.
let liveReserveUsdc = 0;
backfillSwapLedgerCostBasis(db); // backfill cost_basis_after for historical swap_ledger rows
pruneOldData(db); // startup cleanup: live_snapshots 7d, decision_log 7d, portfolio_snapshots 30d
let sirCostBasis = costBasisState.solCostBasis; // kept in sync for legacy references
let idleRebalancePending = false; // set true after position reopen to trigger check

// Strategic SOL Rebalance — unstick from SOL-heavy idle
let strategicIdleStartTs = 0;           // when this idle period began (0 = not idle yet)
let lastStrategicRebalanceTs = 0;       // cooldown tracker
let strategicRebalanceFailures = 0;     // consecutive tx failure count
let strategicRebalanceBackoffUntil = 0; // backoff window after 3 consecutive failures

// Progressive basis decay — gradually loosen sell threshold when stuck below basis
let belowBasisStartTs = 0;
let lastDecayLogTs = 0;
let smartSellPending = false; // DISABLED — any SOL sell loses money in downtrends
let taRegimeCandidate: Regime | null = null;   // TA-first regime hysteresis candidate
let taRegimeCandidateCount = 0;                // consecutive cycles candidate has held
let taDeployMultiplier = 1.0;                  // latest deploy multiplier from TA confidence
let smartSellEntryPrice = 0; // price at position open (cost basis reference)
let smartSellStartTime = 0; // when the smart sell was triggered
let positionChangedThisCycle = false; // guards manual swap detection against LP deposit/withdrawal interference

// Cycle-scoped accumulators for bot-initiated swaps. Reconciler subtracts bot
// activity from observed wallet delta so user swaps that coincide with bot
// swaps are still detected (was: 30s time-based guard that wrongly suppressed
// detection when bot swapped in the same cycle as a user's external swap).
let botSolDeltaThisCycle = 0;
let botUsdcDeltaThisCycle = 0;
// Cycle-scoped regime snapshot tracking (module-level so runLiveCycle can write, setInterval can read)
let cycleGateReserve = 'NA';
let cycleGateBasis = 'NA';
let cycleGateChurn = 'NA';
let cycleTaResult: { confidence: string; vetoFired: boolean; votes: Record<string, number>; candidateRegime: string; score: number } | null = null;
let cycleDailyRegime: string | null = null;
let cyclePrevRegime = 'RANGING';

let solConversionLastTs =(() => { try { const r = db.prepare('SELECT sol_conversion_last_ts FROM bot_state WHERE id = 1').get() as any; return r?.sol_conversion_last_ts ?? 0; } catch { return 0; } })();

// ── 4. START DATA SERVICES ────────────────────────────────────────────────

const oracle = new OracleService(PYTH_SOL_USD_FEED, runtime.pythMaxConfidencePct, runtime.pythMaxStalenessSec);
const marketData = new MarketDataService();
const dashboard = startDashboard(DASHBOARD_PORT);
dashboard.setDb(db);

// Load Rule 2 toggle state from DB
let rule2Enabled = getRuleEnabled(db, 'rule2');
dashboard.setRule2Enabled(rule2Enabled);

// Load auto-deploy toggle state from DB
autoDeployEnabled = getRuleEnabled(db, 'autoDeploy');
dashboard.setAutoDeployEnabled(autoDeployEnabled);

// Restore upside exit state from DB
if (savedState?.last_upside_exit_ts) {
  lastUpsideExitPrice = savedState.last_upside_exit_price ?? 0;
  lastUpsideExitTs = savedState.last_upside_exit_ts ?? 0;
  console.log(JSON.stringify({ level: 'info', msg: `Upside exit state restored: price=$${lastUpsideExitPrice.toFixed(2)}, at ${new Date(lastUpsideExitTs).toISOString()}`, timestamp: Date.now() }));
}

// Log restored RCR state (so a restart while marked is visible)
if (rcrMarkedForSwitch || rcrEntryRegime) {
  console.log(JSON.stringify({
    level: 'info',
    msg: `[RCR] State restored: marked=${rcrMarkedForSwitch}, entry_regime=${rcrEntryRegime}, target=${rcrMarkTargetRegime}, mark_ts=${rcrMarkTimestamp ? new Date(rcrMarkTimestamp).toISOString() : 'null'}, last_switch_ts=${rcrLastSwitchTs ? new Date(rcrLastSwitchTs).toISOString() : 'null'}`,
    timestamp: Date.now(),
  }));
}

// Pre-populate price history for flash crash detection
try {
  const recentSnaps = db.prepare(`SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 10`).all() as { price: number }[];
  liveRecentPrices = recentSnaps.map(r => r.price).reverse();
  console.log(JSON.stringify({ level: 'info', msg: `[Startup] Pre-populated ${liveRecentPrices.length} prices for flash crash detection`, timestamp: Date.now() }));
} catch (e) {
  console.log(JSON.stringify({ level: 'warn', msg: `[Startup] Flash-crash prepopulate failed: ${String(e)}`, timestamp: Date.now() }));
}

// ── Defensive Downtrend Mode state (Phase C core) ────────────────────────
// Restored from DB so a restart while active does not silently resume
// normal operation. Default state = inactive.
let defensiveState: DefensiveState = (() => {
  const s = makeInitialState();
  if (!savedState) return s;
  if (savedState.defensive_active === 1 && savedState.defensive_entered_at) {
    s.active = true;
    s.enteredAt = savedState.defensive_entered_at ?? null;
    s.enteredPrice = savedState.defensive_entered_price ?? null;
    s.enteredTrigger = savedState.defensive_entered_trigger ?? null;
    s.entryPriceLow = savedState.defensive_entry_price_low ?? null;
    s.cooldownUntil = savedState.defensive_cooldown_until ?? null;
    console.log(JSON.stringify({ level: 'info', msg: `[DEFENSIVE] State restored from DB: trigger=${s.enteredTrigger}, enteredAt=${s.enteredAt ? new Date(s.enteredAt).toISOString() : 'null'}, priceLow=${s.entryPriceLow ?? 'null'}`, timestamp: Date.now() }));
  } else if (savedState.defensive_cooldown_until) {
    s.cooldownUntil = savedState.defensive_cooldown_until;
  }
  return s;
})();

function defensiveFields() {
  return {
    defensive_active: defensiveState.active ? 1 : 0,
    defensive_entered_at: defensiveState.enteredAt,
    defensive_entered_price: defensiveState.enteredPrice,
    defensive_entered_trigger: defensiveState.enteredTrigger,
    defensive_entry_price_low: defensiveState.entryPriceLow,
    defensive_cooldown_until: defensiveState.cooldownUntil,
  };
}

// Targeted write of defensive_* columns only. Runs at ENTER, EXIT, and when
// entryPriceLow moves. Avoids needing to thread defensiveFields() through
// every existing upsertBotState call.
function persistDefensiveState(): void {
  try {
    db.prepare(`UPDATE bot_state SET defensive_active=?, defensive_entered_at=?, defensive_entered_price=?, defensive_entered_trigger=?, defensive_entry_price_low=?, defensive_cooldown_until=? WHERE id=1`).run(
      defensiveState.active ? 1 : 0,
      defensiveState.enteredAt,
      defensiveState.enteredPrice,
      defensiveState.enteredTrigger,
      defensiveState.entryPriceLow,
      defensiveState.cooldownUntil,
    );
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', msg: `[DEFENSIVE] persist failed: ${String(e)}`, timestamp: Date.now() }));
  }
}

// Query regime_snapshots for historical price closest to targetTs (±window ms).
// Returns null if no snapshot found within window.
function queryPriceAt(targetTs: number, windowMs = 300_000): number | null {
  try {
    const row = db.prepare(
      `SELECT price FROM regime_snapshots WHERE ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) ASC LIMIT 1`,
    ).get(targetTs - windowMs, targetTs + windowMs, targetTs) as { price: number } | undefined;
    return row?.price ?? null;
  } catch {
    return null;
  }
}

// Helper: upside exit fields for every state save
function upsideExitFields() {
  return { last_upside_exit_price: lastUpsideExitPrice, last_upside_exit_ts: lastUpsideExitTs, last_harvest_time: liveLastHarvestTime };
}

// Helper: Regime-Change Refresh fields for every state save
function rcrFields() {
  return {
    marked_for_switch: rcrMarkedForSwitch ? 1 : 0,
    mark_timestamp: rcrMarkTimestamp,
    mark_target_regime: rcrMarkTargetRegime,
    entry_regime: rcrEntryRegime,
    last_switch_timestamp: rcrLastSwitchTs,
  };
}

// Targeted write of RCR columns only. Avoids threading rcrFields() through
// every existing upsertBotState call.
function persistRcrState(): void {
  try {
    db.prepare(`UPDATE bot_state SET marked_for_switch=?, mark_timestamp=?, mark_target_regime=?, entry_regime=?, last_switch_timestamp=? WHERE id=1`).run(
      rcrMarkedForSwitch ? 1 : 0,
      rcrMarkTimestamp,
      rcrMarkTargetRegime,
      rcrEntryRegime,
      rcrLastSwitchTs,
    );
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', msg: `[RCR] persist failed: ${String(e)}`, timestamp: Date.now() }));
  }
}

// Helper: cost basis fields for every state save (prevents INSERT OR REPLACE from zeroing them)
function costBasisFields() {
  return {
    sol_cost_basis: costBasisState.solCostBasis,
    sol_total_acquired: costBasisState.solTotalAcquired,
    sol_total_cost: costBasisState.solTotalCost,
    cost_basis_last_updated: costBasisState.costBasisLastUpdated,
  };
}

// Helper: reconcile reserve after a position open based on actual wallet USDC
async function reconcileReserveAfterOpen(label: string): Promise<void> {
  const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const usdcAfterOpen = balances.usdc;
  const state = getReserveState(db);
  const floor = state.floor;
  if (usdcAfterOpen >= floor) {
    updateReserve(db, floor);
    console.log(JSON.stringify({ level: 'info', msg: `[Reserve][${label}] Post-open: wallet USDC $${usdcAfterOpen.toFixed(2)} >= floor $${floor.toFixed(2)}. Reserve set to floor $${floor.toFixed(2)}`, timestamp: Date.now() }));
  } else {
    updateReserve(db, Math.max(0, usdcAfterOpen));
    console.log(JSON.stringify({ level: 'warn', msg: `[Reserve][${label}] Post-open: wallet USDC $${usdcAfterOpen.toFixed(2)} below floor $${floor.toFixed(2)}. Reserve set to $${Math.max(0, usdcAfterOpen).toFixed(2)}`, timestamp: Date.now() }));
  }
}

// ── Progressive basis decay ───────────────────────────────────────────────
// When price stays below basis for > progressiveBasisDecayStartHours, gradually
// loosen the effective threshold on a progressiveBasisDecayIntervalMinutes cadence
// so SolConvert / idle-rebalance SOL-sell can eventually fire at a small loss.
// Bounded by progressiveBasisDecayMinThreshold (default 95%). Disabled by default.
function calculateEffectiveBasisThreshold(basis: number, currentPrice: number, now: number, regime?: Regime): number {
  const defaultMultiplier = 0.995;
  const defaultThreshold = basis * defaultMultiplier;

  if (!runtime.progressiveBasisDecayEnabled) return defaultThreshold;

  if (currentPrice >= basis) { belowBasisStartTs = 0; return defaultThreshold; }

  if (belowBasisStartTs === 0) { belowBasisStartTs = now; return defaultThreshold; }

  // Per-regime decay params (fall back to globals when regime not provided)
  const rp = regime ? runtime.regimeParams[regime] : null;
  const startHours   = rp?.progressiveBasisDecayStartHours    ?? runtime.progressiveBasisDecayStartHours;
  const perInterval  = rp?.progressiveBasisDecayPerInterval   ?? runtime.progressiveBasisDecayPerInterval;
  const minThreshold = rp?.progressiveBasisDecayMinThreshold  ?? runtime.progressiveBasisDecayMinThreshold;

  const hoursBelowBasis = (now - belowBasisStartTs) / 3600_000;
  if (hoursBelowBasis < startHours) return defaultThreshold;

  const hoursDecaying = hoursBelowBasis - startHours;
  const intervalsElapsed = Math.floor((hoursDecaying * 60) / runtime.progressiveBasisDecayIntervalMinutes);
  const decayAmount = intervalsElapsed * perInterval;
  const effectiveMultiplier = Math.max(minThreshold, defaultMultiplier - decayAmount);
  const threshold = basis * effectiveMultiplier;

  const logIntervalMs = 15 * 60_000;
  if (now - lastDecayLogTs > logIntervalMs) {
    lastDecayLogTs = now;
    console.log(JSON.stringify({
      level: 'info',
      msg: `[ProgressiveDecay] SolConvert threshold loosened. hrsBelowBasis: ${hoursBelowBasis.toFixed(2)}, intervalsElapsed: ${intervalsElapsed}, effectiveMultiplier: ${effectiveMultiplier.toFixed(4)}, threshold: $${threshold.toFixed(2)}, lossTolerance: ${((1 - effectiveMultiplier) * 100).toFixed(2)}%`,
      timestamp: now,
    }));
  }

  return threshold;
}

// Pure (no side-effects, no logging) accessor for dashboard visibility.
// Must match the math in calculateEffectiveBasisThreshold above.
function getProgressiveDecayState(basis: number, currentPrice: number, now: number, regime?: Regime) {
  if (!runtime.progressiveBasisDecayEnabled) return null;
  if (basis <= 0) return null;
  const defaultMultiplier = 0.995;
  if (currentPrice >= basis || belowBasisStartTs === 0) {
    return { active: false, hrsBelowBasis: 0, effectiveMultiplier: defaultMultiplier, effectiveThresholdUsd: basis * defaultMultiplier, lossTolerancePct: (1 - defaultMultiplier) * 100 };
  }
  const rp = regime ? runtime.regimeParams[regime] : null;
  const startHours   = rp?.progressiveBasisDecayStartHours    ?? runtime.progressiveBasisDecayStartHours;
  const perInterval  = rp?.progressiveBasisDecayPerInterval   ?? runtime.progressiveBasisDecayPerInterval;
  const minThreshold = rp?.progressiveBasisDecayMinThreshold  ?? runtime.progressiveBasisDecayMinThreshold;
  const hrsBelowBasis = (now - belowBasisStartTs) / 3600_000;
  const hoursDecaying = Math.max(0, hrsBelowBasis - startHours);
  const intervalsElapsed = Math.floor((hoursDecaying * 60) / runtime.progressiveBasisDecayIntervalMinutes);
  const decayAmount = intervalsElapsed * perInterval;
  const effectiveMultiplier = Math.max(minThreshold, defaultMultiplier - decayAmount);
  return {
    active: hrsBelowBasis >= startHours,
    hrsBelowBasis,
    effectiveMultiplier,
    effectiveThresholdUsd: basis * effectiveMultiplier,
    lossTolerancePct: (1 - effectiveMultiplier) * 100,
  };
}

// Wrapper to auto-tag rebalance events with rule2 state and position ID
function insertRebalanceEventWithRule2(db_: typeof db, event: Parameters<typeof insertRebalanceEvent>[1], overridePositionId?: string) {
  const posId = overridePositionId ?? liveExecutor?.getCurrentPosition()?.positionMint?.toBase58() ?? null;
  insertRebalanceEvent(db_, { ...event, rule2Active: rule2Enabled ? 1 : 0, positionId: posId ?? undefined });
}

// ── Strategic SOL Rebalance ──────────────────────────────────────────────
// When bot is stuck idle (no position, SOL-heavy, price below basis),
// automatically sell a small slice of SOL → USDC to unstick deployment.
// Unlike SolConvert (which requires profit margin), this accepts a small
// realized loss to escape the idle trap; the alternative is indefinite
// idle opportunity cost.
async function checkStrategicRebalance(price: number, currentPos: any): Promise<boolean> {
  if (!runtime.strategicRebalanceEnabled) return false;
  if (currentPos) { strategicIdleStartTs = 0; return false; }

  const now = Date.now();
  if (now < strategicRebalanceBackoffUntil) return false;

  if (strategicIdleStartTs === 0) { strategicIdleStartTs = now; return false; }

  const cooldownMs = runtime.strategicRebalanceCooldownHours * 3600_000;
  if (now - lastStrategicRebalanceTs < cooldownMs) return false;

  const idleMs = runtime.strategicRebalanceIdleMinutes * 60_000;
  if (now - strategicIdleStartTs < idleMs) return false;

  if (!liveExecutor) return false;
  const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const basis = readCostBasis(db).solCostBasis;
  if (basis <= 0) return false;

  const basisFloor = basis * runtime.strategicRebalanceBasisMultiplier;
  if (price >= basisFloor) return false; // SolConvert would fire instead

  const portfolio = balances.sol * price + balances.usdc;
  // Phase 19: dynamic thresholds snapshot for this check
  const dyn = dynamicScaling.getCurrentDyn();
  const minPortfolioGate = dyn.strategicRebalanceMinPortfolioUsdc ?? runtime.strategicRebalanceMinPortfolioUsdcFloor;
  if (portfolio < minPortfolioGate) return false;
  const solShare = (balances.sol * price) / portfolio;
  if (solShare < runtime.strategicRebalanceMinSolSharePct) return false;
  const reserveFloor = getReserveState(db).floor;
  const availableAboveFloor = Math.max(0, balances.usdc - reserveFloor);
  if (availableAboveFloor >= dyn.minDeployUsdc) return false; // enough USDC to deploy normally

  const targetUsdc = portfolio * (1 - runtime.strategicRebalanceTargetSolSharePct);
  const usdcGap = targetUsdc - balances.usdc;
  if (usdcGap < runtime.strategicRebalanceMinUsdcGain) return false;

  // Ensure swap produces enough USDC to actually clear reserveFloor + minDeployUsdc.
  // Without this floor, the max-portfolio-pct cap can bind and leave USDC still below deploy threshold.
  const usdcNeeded = reserveFloor + dyn.minDeployUsdc - balances.usdc;
  const requiredUsdc = Math.max(usdcGap, usdcNeeded * 1.05); // 5% buffer over strict need

  const solNeeded = (requiredUsdc / price) * 1.01;                                       // +1% slippage buffer
  const solMaxPct = (portfolio * runtime.strategicRebalanceMaxPortfolioPct) / price;      // cap by max portfolio %
  const solMaxAvailable = Math.max(0, balances.sol - dyn.solReserveSol);                  // never drop below SOL reserve

  const solToSell = Math.min(solNeeded, solMaxPct, solMaxAvailable);

  if (solToSell <= 0 || solToSell * price < runtime.strategicRebalanceMinUsdcGain) return false;

  // Warn if maxPortfolioPct cap binds below what we need to actually deploy next cycle
  const projectedUsdc = balances.usdc + (solToSell * price);
  const projectedAvailable = projectedUsdc - reserveFloor;
  if (projectedAvailable < dyn.minDeployUsdc) {
    console.log(JSON.stringify({ level: 'warn', msg: `[StrategicRebalance] Warning: maxPortfolioPct cap binds, projected USDC $${projectedAvailable.toFixed(2)} insufficient for minDeployUsdc $${dyn.minDeployUsdc.toFixed(2)}. Consider raising strategicRebalanceMaxPortfolioPct.`, timestamp: now }));
  }

  const reason = `Strategic rebalance: unstick SOL-heavy idle (share ${(solShare * 100).toFixed(0)}%, price $${price.toFixed(2)} < basis×${runtime.strategicRebalanceBasisMultiplier.toFixed(3)} $${basisFloor.toFixed(2)}, idle ${((now - strategicIdleStartTs) / 60000).toFixed(0)}min)`;
  console.log(JSON.stringify({ level: 'info', msg: `[StrategicRebalance] Triggering: sell ${solToSell.toFixed(3)} SOL → ~$${(solToSell * price).toFixed(0)} USDC. ${reason}`, timestamp: now }));

  try {
    const swapResult = await liveExecutor.doSwapPublic(MINTS.SOL, MINTS.USDC, Math.floor(solToSell * 1e9), reason);
    if (!swapResult) {
      strategicRebalanceFailures++;
      if (strategicRebalanceFailures >= 3) {
        strategicRebalanceBackoffUntil = now + 30 * 60_000;
        strategicRebalanceFailures = 0;
        console.log(JSON.stringify({ level: 'warn', msg: '[StrategicRebalance] 3 consecutive swap failures — 30min backoff', timestamp: Date.now() }));
      }
      return false;
    }
    strategicRebalanceFailures = 0;

    // onSwap callback handles cost basis, swap_ledger, and lastBotSwapTime automatically.
    // We emit a STRATEGIC_REBALANCE-typed rebalance_event for timeline clarity.
    const balancesAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
    const usdcReceived = Math.max(0, balancesAfter.usdc - balances.usdc);
    const effectivePrice = usdcReceived > 0 ? usdcReceived / solToSell : price;
    const pnl = (effectivePrice - basis) * solToSell;

    insertRebalanceEventWithRule2(db, {
      timestamp: now, eventType: 'STRATEGIC_REBALANCE', price, regime: liveRegime,
      note: `${reason} → received $${usdcReceived.toFixed(2)} @ $${effectivePrice.toFixed(2)} (P&L $${pnl.toFixed(2)})`,
      solBefore: balances.sol, usdcBefore: balances.usdc,
      solAfter: balancesAfter.sol, usdcAfter: balancesAfter.usdc,
      feeSol: 0, feeUsdc: 0, ilAtClose: 0,
    });

    lastStrategicRebalanceTs = now;
    strategicIdleStartTs = 0;
    console.log(JSON.stringify({ level: 'info', msg: `[StrategicRebalance] Done: sold ${solToSell.toFixed(3)} SOL → $${usdcReceived.toFixed(2)} @ $${effectivePrice.toFixed(2)} (basis $${basis.toFixed(2)}, P&L $${pnl.toFixed(2)}). Deploy next cycle.`, timestamp: Date.now() }));

    try { alertStrategicRebalance({ solSold: solToSell, usdcReceived, pnl, price, basis }); } catch {}
    return true;
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: `[StrategicRebalance] Swap error: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }));
    strategicRebalanceFailures++;
    return false;
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  await oracle.start();
  await marketData.start();
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

    const walletCheck = validateWalletForLive(balances.sol, balances.usdc, runtime.maxLiveCapitalUsdc, solPrice, runtime.pauseThresholdUsdc);
    if (walletCheck.paused) {
      startupPaused = true;
      startupPauseReason = walletCheck.pauseReason ?? 'unknown';
      console.log(JSON.stringify({ level: 'warn', msg: `[Startup] Bot paused at startup: ${startupPauseReason}. Will retry each cycle.`, timestamp: Date.now() }));
    }
    liveExecutor = new LiveExecutor(conn, wallet, WHIRLPOOL_ADDRESS);

    // Restore gas stats from DB (persisted on every state save and shutdown)
    liveExecutor.cumGasLamports = (savedState as any)?.cum_gas_lamports ?? 0;
    liveExecutor.txCount = (savedState as any)?.tx_count ?? 0;
    console.log(JSON.stringify({ level: 'info', msg: `gas from DB: ${liveExecutor.cumGasLamports} lamports (${(liveExecutor.cumGasLamports/1e9).toFixed(6)} SOL), ${liveExecutor.txCount} txs`, timestamp: Date.now() }));

    // ── Startup cost basis reconciliation ────────────────────────────────────
    // Compare tracked SOL against actual wallet balance. Large discrepancy means
    // we missed a SOL inflow (external deposit, airdrop, etc.) — warn but do NOT auto-correct.
    {
      const trackedSol = costBasisState.solTotalAcquired;
      const walletSol = balances.sol;
      if (trackedSol > 0 && walletSol > trackedSol * 1.05) {
        const untracked = walletSol - trackedSol;
        console.log(JSON.stringify({
          level: 'warn',
          msg: `COST_BASIS reconciliation WARNING: wallet has ${walletSol.toFixed(4)} SOL but only ${trackedSol.toFixed(4)} SOL tracked (${untracked.toFixed(4)} SOL unaccounted). Cost basis may be understated. Review external deposits.`,
          walletSol, trackedSol, untracked, timestamp: Date.now(),
        }));
      } else if (trackedSol > 0) {
        console.log(JSON.stringify({
          level: 'info',
          msg: `COST_BASIS reconciliation OK: wallet ${walletSol.toFixed(4)} SOL, tracked ${trackedSol.toFixed(4)} SOL, basis $${costBasisState.solCostBasis.toFixed(2)}`,
          timestamp: Date.now(),
        }));
      }
    }

    // ── Reserve initialisation ────────────────────────────────────────────────
    {
      const reserveSnap = getReserveState(db);
      if (!reserveSnap.floor || reserveSnap.floor === 0) {
        // First ever run — use wallet-only value as temporary floor
        // Will be corrected by in-cycle seed (Location 2) on first cycle
        const floor = computeFloor(balances.totalUsdc, (runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).reserveFloorPct);
        if (reserveSnap.current === 0) {
          const seed = Math.min(balances.usdc, floor);
          updateReserve(db, seed, floor);
          liveReserveUsdc = seed;
          console.log(JSON.stringify({ level: 'info', msg: `[Reserve] First run — seeded reserve: $${seed.toFixed(2)}, temporary floor: $${floor.toFixed(2)} (will correct to full portfolio on first cycle)`, timestamp: Date.now() }));
        } else {
          updateReserve(db, reserveSnap.current, floor);
          liveReserveUsdc = reserveSnap.current;
          console.log(JSON.stringify({ level: 'info', msg: `[Reserve] Startup: no floor found — temporary floor $${floor.toFixed(2)} (will correct to full portfolio on first cycle)`, timestamp: Date.now() }));
        }
      } else {
        // Valid floor exists — preserve it, never overwrite on restart
        updateReserve(db, reserveSnap.current); // no floor param → keeps existing floor
        liveReserveUsdc = reserveSnap.current;
        console.log(JSON.stringify({ level: 'info', msg: `[Reserve] Startup: preserving existing floor $${reserveSnap.floor.toFixed(2)}, reserve $${reserveSnap.current.toFixed(2)}, state ${reserveSnap.state}`, timestamp: Date.now() }));
      }
    }

    // Reserve floor callback — executor reads this to protect USDC reserve
    liveExecutor.getReserveFloor = () => getReserveState(db).floor;
    // Use max of current-regime and position-regime thresholds so auto-deploy
    // uses the stricter gate when regime changes mid-position, preventing
    // deploys at the wrong proximity.
    liveExecutor.getProximityDeployThreshold = () => {
      const currentThreshold = (runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).proximityDeployThreshold ?? 0.40;
      const posRegime = liveExecutor?.getCurrentPosition()?.regime;
      const posThreshold = posRegime
        ? ((runtime.regimeParams[posRegime] ?? getRegimeParams(posRegime as Regime)).proximityDeployThreshold ?? 0.40)
        : 0;
      return Math.max(currentThreshold, posThreshold);
    };
    liveExecutor.getCurrentRegime = () => liveRegime;
    liveExecutor.getCostBasis = () => costBasisState?.solCostBasis ?? 0;

    // P&L guard for auto-deploy ratio matching swaps.
    // Allow SOL sells when price is at or above the decay-aware effective
    // threshold (basis × 0.995 by default; lower when progressive decay is
    // active and price has been below basis past the grace period). This
    // aligns the guard with the idle-rebalance path's decay behavior.
    liveExecutor.shouldAllowSwap = (direction, _amount, price) => {
      if (direction === 'sell_sol') {
        const basis = sirCostBasis || 0;
        if (basis > 0) {
          const effectiveThreshold = calculateEffectiveBasisThreshold(basis, price, Date.now(), liveRegime);
          if (price < effectiveThreshold) {
            const decayActive = effectiveThreshold < basis * 0.995 - 1e-9;
            console.log(JSON.stringify({ level: 'info', msg: `P&L guard: BLOCKED sell SOL at $${price.toFixed(4)} (below effective threshold $${effectiveThreshold.toFixed(4)}, basis $${basis.toFixed(4)}${decayActive ? ', decay active' : ''})`, timestamp: Date.now() }));
            return false;
          }
        }
      }
      return true; // buys always allowed
    };

    // Log swaps as events
    liveExecutor.onSwap = (event) => {
      lastBotSwapTime = Date.now(); // mark bot swap to avoid false manual detection
      // Track bot-swap impact for reconciler delta accounting
      const isSolOut = event.fromToken === 'SOL';
      if (isSolOut) {
        botSolDeltaThisCycle -= event.fromAmount;
        botUsdcDeltaThisCycle += event.toAmount;
      } else {
        botSolDeltaThisCycle += event.toAmount;
        botUsdcDeltaThisCycle -= event.fromAmount;
      }
      const swapPrice = currentLiveData?.solPrice || oracle.getPrice()?.price || 0;
      insertRebalanceEventWithRule2(db, {
        timestamp: event.timestamp, eventType: 'PRICE_UPDATE', price: swapPrice, regime: liveRegime,
        note: `SWAP: ${event.reason}`,
        solBefore: 0, usdcBefore: event.fromAmount, solAfter: event.toAmount, usdcAfter: 0,
        feeSol: 0, feeUsdc: 0, ilAtClose: 0,
      });
      insertDecisionLog(db, {
        timestamp: event.timestamp, price: swapPrice, regime: liveRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'SWAP', reasoning: event.reason, params_json: null,
      });
      // Track ALL swaps in swap_ledger for P&L analysis
      const isSolSell = event.fromToken === 'SOL';
      const solAmt = isSolSell ? event.fromAmount : event.toAmount;
      const usdcAmt = isSolSell ? event.toAmount : event.fromAmount;
      const direction = isSolSell ? 'sell_sol' : 'buy_sol';
      const idleSolHolding = 0; // approximate — exact value would need balance check
      const basisBefore = sirCostBasis || swapPrice;
      const pnlCalc = calculateSwapPnl(direction as any, solAmt, swapPrice, basisBefore, idleSolHolding);
      // COST_BASIS: tracked — update DB-persisted cost basis on every USDC→SOL buy swap.
      // Atomic: cost-basis write + swap_ledger insert must commit together to prevent drift.
      db.transaction(() => {
        if (direction === 'buy_sol') {
          costBasisState = updateCostBasis(db, solAmt, swapPrice, `swap onSwap (${event.reason.slice(0, 60)})`);
          sirCostBasis = costBasisState.solCostBasis;
        } else {
          // Harvest fee-SOL sells: fee SOL was never added to sol_total_acquired,
          // so reducing the tracked pool would shrink totals below real capital acquisitions.
          const isHarvestSell = /harvest/i.test(event.reason);
          if (isHarvestSell) {
            console.log(JSON.stringify({ level: 'info', msg: `[CostBasis] Harvest sell — skipping reduce (${solAmt.toFixed(4)} SOL fee-income, not capital)`, timestamp: Date.now() }));
            costBasisState = readCostBasis(db);
            sirCostBasis = costBasisState.solCostBasis;
          } else {
            reduceCostBasisHoldings(db, solAmt, `swap sell (${event.reason.slice(0, 40)})`);
            costBasisState = readCostBasis(db);
            sirCostBasis = costBasisState.solCostBasis;
          }
        }
        insertSwapLedger(db, {
          timestamp: event.timestamp, direction, sol_amount: solAmt, usdc_amount: usdcAmt,
          price: swapPrice, reason: event.reason, pnl_usdc: pnlCalc.pnlUsdc,
          cost_basis_before: basisBefore, cost_basis_after: sirCostBasis,
          tx_signature: event.txSignature, fee_lamports: event.feeLamports, price_impact_pct: event.priceImpactPct,
        });
      })();
    };

    // Restore live position from DB if exists
    if (savedState?.position_json && savedState.position_json !== 'null' && savedState.position_json !== null) {
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
          // Backfill entry_regime if never set (first bot run after RCR deploy).
          // Current regime is the best available proxy for an already-open position.
          if (!rcrEntryRegime) {
            rcrEntryRegime = liveRegime;
            persistRcrState();
            console.log(JSON.stringify({ level: 'info', msg: `[RCR] entry_regime backfilled from restored position: ${rcrEntryRegime}`, timestamp: Date.now() }));
          }
          console.log(JSON.stringify({ level: 'info', msg: 'live position restored', positionMint: pos.positionMint, timestamp: Date.now() }));
          // Restore last regime change time so stability gate works after restart
          try {
            const lastChange = db.prepare('SELECT ts FROM regime_snapshots WHERE regime_changed = 1 ORDER BY ts DESC LIMIT 1').get() as { ts: number } | undefined;
            if (lastChange) lastRegimeChangeTs = lastChange.ts;
          } catch { /* ignore if column missing */ }
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
              console.log(JSON.stringify({ level: 'error', msg: `failed to close orphan ${mint.toBase58().slice(0, 12)}...`, error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: Date.now() }));
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

    // Cost basis: reset lifetime totals to current actual holdings if wildly off (>2x)
    {
      const pos = liveExecutor?.getCurrentPosition();
      const lpSol = pos ? pos.entrySol : 0;
      const totalSolHeld = balances.sol + lpSol;
      recalculateFromCurrentHoldings(db, totalSolHeld);
      costBasisState = readCostBasis(db);
      sirCostBasis = costBasisState.solCostBasis;

      // Recalculate reserve floor if portfolio has grown/shrunk significantly
      const totalPortfolio = balances.sol * (balances.solPrice ?? 84) + balances.usdc + (pos ? pos.entrySol * (balances.solPrice ?? 84) + (pos.entryUsdc ?? 0) : 0);
      checkReserveFloor(db, totalPortfolio, (runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).reserveFloorPct);
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
  let pendingDashboardAction: (() => Promise<any>) | null = null;
  let prevBalSol = 0;
  let prevBalUsdc = 0;
  let lastBotSwapTime = 0; // track when bot does a swap to avoid false manual detections
  let lastPruneTime = Date.now();

  let lastConfigReload = Date.now();

  const decisionLoop = setInterval(async () => {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      // Reset cycle-scoped snapshot tracking
      cycleGateReserve = 'NA'; cycleGateBasis = 'NA'; cycleGateChurn = 'NA';
      cyclePrevRegime = liveRegime;
      positionChangedThisCycle = false;
      botSolDeltaThisCycle = 0;
      botUsdcDeltaThisCycle = 0;

      // Reload config from DB every 5 minutes (picks up threshold changes without restart)
      const now0 = Date.now();
      if (now0 - lastConfigReload > 60_000) { // reload config every 1 min (was 5 min)
        applyConfigFromDb(getConfig(db));
        lastConfigReload = now0;
      }

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

          // Actual fees today from daily_summary (consistent with insights/analytics)
          let actual24hFeesUsdc = 0;
          let actual24hAprPct = 0;
          try {
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
            const todaySummary = getDailySummaries(db, 1);
            if (todaySummary.length > 0 && todaySummary[0].date === today) {
              actual24hFeesUsdc = todaySummary[0].fees_earned_usdc;
            }
            actual24hAprPct = positionValueUsdc > 0 ? (actual24hFeesUsdc * 365 / positionValueUsdc) * 100 : 0;
          } catch (e) { console.log(JSON.stringify({ level: 'error', msg: `[FinancialOp] daily_fee_calc: ${String(e)}`, timestamp: Date.now() })); }

          // CL-accurate IL (matches executor.closePosition formula at src/live/executor.ts:567-580).
          // IL = lpValue - hodlValue, both legs priced at pool sqrtPrice for source-consistency.
          // Using Pyth for hodl vs pool for lp creates a ~1-2 bp oracle-mix bias that can flip
          // sign at small deltas. closePosition uses pool for both — mirror that here.
          let ilUsdc = 0;
          if (livePos && livePos.entrySol != null && livePos.entryUsdc != null && posComp && positionValueUsdc > 0) {
            const hodlValue = livePos.entrySol * posComp.poolPrice + livePos.entryUsdc;
            if (hodlValue > 0) {
              ilUsdc = positionValueUsdc - hodlValue;
            }
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
            solCostBasis: costBasisState.solCostBasis || 0,
            solTracked: costBasisState.solTotalAcquired || 0,
            costBasisLastUpdated: costBasisState.costBasisLastUpdated || 0,
            entryPrice: livePos?.entryPrice ?? null,
            entryTime: livePos?.entryTime ?? null,
            entrySol: livePos?.entrySol ?? positionSol,
            entryUsdc: livePos?.entryUsdc ?? positionUsdc,
            ilUsdc,
            realizedIlUsdc: liveRealizedIl,
            ...(() => { const g = liveExecutor!.getGasStats(price.price); return { gasSol: g.gasSol, gasUsdc: g.gasUsdc, txCount: g.txCount }; })(),
            estDailyFeesUsdc,
            estAprPct,
            actual24hFeesUsdc,
            actual24hAprPct,
            positionRegime: livePos?.regime ?? null,
            ...(() => { const rs = getReserveState(db); return { reserveCurrent: rs.current, reserveFloor: rs.floor, reserveState: rs.state }; })(),
            reserveLastUpdated: Date.now(),
            ...(() => {
              const lastExit = db.prepare("SELECT timestamp, price FROM decision_log WHERE decision IN ('T1_DOWNSIDE','OOR_BELOW') ORDER BY rowid DESC LIMIT 1").get() as { timestamp: number; price: number } | undefined;
              // Downside churn guard
              let active = false, reason: string | null = null, expiresMin: number | null = null;
              let exitPrice: number | null = null, exitAgeMin: number | null = null;
              if (lastExit) {
                const ageMin = (Date.now() - lastExit.timestamp) / 60000;
                const belowExit = price.price < lastExit.price;
                const cooldownBlock = ageMin < 15 && belowExit;
                const priceBlock = belowExit && ageMin < 20;
                active = cooldownBlock || priceBlock;
                reason = cooldownBlock ? `price $${price.price.toFixed(2)} below exit $${lastExit.price.toFixed(2)}, cooldown ${(15 - ageMin).toFixed(0)}min` : priceBlock ? `price $${price.price.toFixed(2)} below exit $${lastExit.price.toFixed(2)}` : null;
                expiresMin = cooldownBlock ? 15 - ageMin : priceBlock ? 20 - ageMin : null;
                exitPrice = lastExit.price;
                exitAgeMin = ageMin;
              }
              // Upside churn guard
              if (!active && lastUpsideExitTs > 0) {
                const upsideAgeMin = (Date.now() - lastUpsideExitTs) / 60000;
                const upsideCooldown = runtime.upsideChurnCooldownMin ?? 5;
                if (upsideAgeMin < upsideCooldown) {
                  active = true;
                  reason = `upside cooldown: ${upsideAgeMin.toFixed(1)}min < ${upsideCooldown}min (exit $${lastUpsideExitPrice.toFixed(2)})`;
                  expiresMin = upsideCooldown - upsideAgeMin;
                  exitPrice = lastUpsideExitPrice;
                  exitAgeMin = upsideAgeMin;
                }
              }
              return { churnGuardActive: active, churnGuardReason: reason, churnGuardExpiresMin: expiresMin, churnGuardLastExitPrice: exitPrice, churnGuardLastExitAgeMin: exitAgeMin };
            })(),
            regime: liveRegime,
            botState: liveBotState,
            liveEvents: [],
            marketSignals: marketData.getSignals() ?? undefined,
            progressiveDecay: getProgressiveDecayState(costBasisState.solCostBasis || 0, price.price, Date.now(), liveRegime),
            strategicRebalance: runtime.strategicRebalanceEnabled ? (() => {
              const total = balances.sol * price.price + balances.usdc;
              const solSharePct = total > 0 ? (balances.sol * price.price) / total * 100 : 0;
              const idleSeconds = strategicIdleStartTs > 0 ? Math.floor((Date.now() - strategicIdleStartTs) / 1000) : 0;
              const cooldownRemainingSec = lastStrategicRebalanceTs > 0
                ? Math.max(0, Math.floor((lastStrategicRebalanceTs + runtime.strategicRebalanceCooldownHours * 3600_000 - Date.now()) / 1000))
                : 0;
              return {
                enabled: true,
                idleSeconds,
                triggerSeconds: runtime.strategicRebalanceIdleMinutes * 60,
                solSharePct,
                solShareThresholdPct: runtime.strategicRebalanceMinSolSharePct * 100,
                cooldownRemainingSec,
                lastFiredTs: lastStrategicRebalanceTs,
              };
            })() : null,
          };
          currentLiveData = liveDataUpdate;
          dashboard.updateLiveData(liveDataUpdate);

          // Record live snapshot for historical tracking
          const isInRange = posData && price.price >= posData.priceLower && price.price <= posData.priceUpper;
          // Detect manual swaps: wallet balance changed but bot didn't swap
          // Skip if position opened/closed this cycle — balance diff includes LP deposit/withdrawal
          if (positionChangedThisCycle) {
            // Update previous balances without recording a swap
          } else if (prevBalSol > 0) {
            // Subtract bot-initiated swap impact from observed wallet delta.
            // Remainder is user-attributable (external Jupiter swap, etc.).
            // Replaces older 30s lastBotSwapTime guard which wrongly suppressed
            // detection when bot swapped in the same cycle as a user swap.
            const totalSolDiff = balances.sol - prevBalSol;
            const totalUsdcDiff = balances.usdc - prevBalUsdc;
            const solDiff = totalSolDiff - botSolDeltaThisCycle;
            const usdcDiff = totalUsdcDiff - botUsdcDeltaThisCycle;
            // Phase 19: dynamic manual-swap detection thresholds (scale with capital)
            const manualSolThresh = dynamicScaling.getCurrentDyn().manualSwapDetectionMinSol ?? runtime.manualSwapDetectionMinSolFloor;
            const manualUsdcThresh = dynamicScaling.getCurrentDyn().manualSwapDetectionMinUsdc ?? runtime.manualSwapDetectionMinUsdcFloor;
            // Manual SOL→USDC sell: SOL dropped, USDC increased (not from position close)
            if (solDiff < -manualSolThresh && usdcDiff > manualUsdcThresh && liveBotState === 'ACTIVE') {
              const solSold = Math.abs(solDiff);
              const usdcReceived = usdcDiff;
              const effectivePrice = usdcReceived / solSold;
              const pnl = (effectivePrice - sirCostBasis) * solSold;
              console.log(JSON.stringify({ level: 'info', msg: `Manual swap detected: sold ${solSold.toFixed(2)} SOL → $${usdcReceived.toFixed(0)} USDC @ $${effectivePrice.toFixed(2)} (basis $${sirCostBasis.toFixed(2)}, P&L $${pnl.toFixed(2)})`, timestamp: Date.now() }));
              try {
                // Atomic: ledger + cost-basis writes together so a crash can't orphan one.
                db.transaction(() => {
                  insertSwapLedger(db, {
                    timestamp: Date.now(), direction: 'sell_sol', sol_amount: solSold, usdc_amount: usdcReceived,
                    price: effectivePrice, reason: 'Manual swap from phone (SOL→USDC)', pnl_usdc: pnl,
                    cost_basis_before: sirCostBasis, cost_basis_after: sirCostBasis, source: 'manual',
                  });
                  reduceCostBasisHoldings(db, solSold, 'manual_sell');
                  costBasisState = readCostBasis(db);
                  sirCostBasis = costBasisState.solCostBasis;
                })();
              } catch (e) { console.log(JSON.stringify({ level: 'error', msg: `[FinancialOp] manual_sell_detect: ${String(e)}`, timestamp: Date.now() })); }
            }
            // Manual USDC→SOL buy: USDC dropped, SOL increased
            if (usdcDiff < -manualUsdcThresh && solDiff > manualSolThresh && liveBotState === 'ACTIVE') {
              const solBought = solDiff;
              const usdcSpent = Math.abs(usdcDiff);
              const effectivePrice = usdcSpent / solBought;
              console.log(JSON.stringify({ level: 'info', msg: `Manual swap detected: bought ${solBought.toFixed(2)} SOL with $${usdcSpent.toFixed(0)} USDC @ $${effectivePrice.toFixed(2)}`, timestamp: Date.now() }));
              try {
                let result: typeof costBasisState;
                // Atomic: ledger + cost-basis writes together.
                db.transaction(() => {
                  insertSwapLedger(db, {
                    timestamp: Date.now(), direction: 'buy_sol', sol_amount: solBought, usdc_amount: usdcSpent,
                    price: effectivePrice, reason: 'Manual swap from phone (USDC→SOL)', pnl_usdc: 0,
                    cost_basis_before: sirCostBasis, cost_basis_after: sirCostBasis, source: 'manual',
                  });
                  // Update cost basis (module-level state + sirCostBasis so next upsertBotState doesn't stomp DB)
                  result = updateCostBasis(db, solBought, effectivePrice, 'manual_buy');
                  costBasisState = result;
                  sirCostBasis = result.solCostBasis;
                })();
                console.log(JSON.stringify({ level: 'info', msg: `[CostBasis] Manual buy detected — costBasisState refreshed (basis $${result!.solCostBasis.toFixed(2)})`, timestamp: Date.now() }));
              } catch (e) { console.log(JSON.stringify({ level: 'error', msg: `[FinancialOp] manual_buy_detect: ${String(e)}`, timestamp: Date.now() })); }
            }
          }
          prevBalSol = balances.sol;
          prevBalUsdc = balances.usdc;

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

          // ── Reserve seed check (every cycle, with full portfolio data) ──
          {
            const reserveState = getReserveState(db);
            if (reserveState.current === 0 && reserveState.floor === 0) {
              const floor = computeFloor(totalWithPosition);
              const seed = Math.min(balances.usdc, floor);
              if (seed > 0) {
                updateReserve(db, seed, floor);
                liveReserveUsdc = seed;
                console.log(JSON.stringify({ level: 'info', msg: `[Reserve] Seeded in cycle: reserve=$${seed.toFixed(2)}, floor=$${floor.toFixed(2)}, portfolio=$${totalWithPosition.toFixed(0)}`, timestamp: Date.now() }));
              }
            }
          }
        } catch (e) { console.log(JSON.stringify({ level: 'error', msg: `[FinancialOp] live_data_update: ${String(e)}`, timestamp: Date.now() })); }
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
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
      });

      checkAndWriteDailyPnl(price.price);

      // ── Regime snapshot ────────────────────────────────────────────────
      {
        const pos = liveExecutor!.getCurrentPosition();
        const posAgeMin = pos ? (Date.now() - pos.entryTime) / 60_000 : null;
        let proxLower: number | null = null;
        let proxUpper: number | null = null;
        if (pos) {
          const halfWidth = (pos.priceUpper - pos.priceLower) / 2;
          if (halfWidth > 0) {
            const centre = (pos.priceLower + pos.priceUpper) / 2;
            proxLower = Math.max(0, (centre - price.price) / halfWidth);
            proxUpper = Math.max(0, (price.price - centre) / halfWidth);
          }
        }
        const mkt = marketData.getSignals();
        const ta = mkt?.ta ?? null;
        const effectiveDeployPct = ((runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).deployPct) * (taDeployMultiplier ?? 1.0);
        const ctr = cycleTaResult as { confidence: string; vetoFired: boolean; votes: Record<string, number>; candidateRegime: string; score: number } | null;
        insertRegimeSnapshot(db, {
          ts: Date.now(),
          regime: liveRegime,
          prev_regime: cyclePrevRegime,
          regime_changed: liveRegime !== cyclePrevRegime ? 1 : 0,
          confidence: ctr?.confidence ?? 'LOW',
          deploy_pct: effectiveDeployPct,
          veto_fired: ctr?.vetoFired ? 1 : 0,
          ta_score_bullish: ctr?.votes?.['BULLISH_TREND'] ?? null,
          ta_score_ranging: ctr?.votes?.['RANGING'] ?? null,
          ta_score_bearish: ctr?.votes?.['BEARISH_TREND'] ?? null,
          ta_score_extreme: ctr?.votes?.['EXTREME'] ?? null,
          ta_winner: ctr?.candidateRegime ?? null,
          ta_total_score: ctr?.score ?? null,
          ema9: ta?.ema9 ?? null,
          sma20: ta?.sma20 ?? null,
          ema_cross: ta?.trendDirection ?? null,
          rsi: ta?.rsi14 ?? null,
          bb_width: ta?.bbWidth ?? null,
          bb_position: ta?.bbPosition ?? null,
          atr: ta?.atr14 ?? null,
          vol_1h: mkt?.vol1h ?? null,
          sol_change_4h: mkt?.solDelta24h ?? null,
          fear_greed: mkt?.fearGreedIndex ?? null,
          btc_change_4h: mkt?.btcDelta24h ?? null,
          price: price.price,
          position_state: pos ? 'ACTIVE' : 'IDLE',
          position_age_min: posAgeMin,
          proximity_lower: proxLower,
          proximity_upper: proxUpper,
          reserve_gate: cycleGateReserve,
          basis_gate: cycleGateBasis,
          churn_guard: cycleGateChurn,
          daily_regime: cycleDailyRegime,
          ta_data_age_min: Math.round((Date.now() - liveLastRegimeCheck) / 60000),
        });
        if (ta?.bbWidth != null) lastBbWidth = ta.bbWidth;
        if (ta?.rsi14 != null) lastRsi = ta.rsi14;
      }

      // Prune old price ticks once per day
      const now2 = Date.now();
      if (now2 - lastPruneTime > 86400_000) {
        lastPruneTime = now2;
        const { pruneOldPriceTicks } = await import('./db/sqlite.js');
        pruneOldPriceTicks(db, 30);
        pruneOldData(db);
        if (currentLiveData?.totalValueWithPosition) checkReserveFloor(db, currentLiveData.totalValueWithPosition, (runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).reserveFloorPct);
        console.log(JSON.stringify({ level: 'info', msg: 'daily prune + reserve floor check', timestamp: now2 }));
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'cycle error', error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: Date.now() }));
    } finally {
      cycleRunning = false;
      if (pendingDashboardAction) {
        const action = pendingDashboardAction;
        pendingDashboardAction = null;
        console.log(JSON.stringify({ level: 'info', msg: '[Dashboard] Executing queued dashboard action', timestamp: Date.now() }));
        try { await action(); } catch (e) { console.log(JSON.stringify({ level: 'error', msg: `[Dashboard] Queued action failed: ${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() })); }
      }
    }
  }, runtime.decisionIntervalSeconds * 1000);

  // Dashboard control handlers
  let botPaused = false;

  {
    const executor = liveExecutor!;
    const liveWallet = (executor as any).wallet;

    dashboard.onPause(() => {
      if (cycleRunning) console.log(JSON.stringify({ level: 'info', msg: '[Dashboard] Pause during cycle — flag will apply next cycle', timestamp: Date.now() }));
      botPaused = true;
      liveBotState = 'IDLE';
      console.log(JSON.stringify({ level: 'info', msg: 'Bot PAUSED from dashboard. Position stays open.', timestamp: Date.now() }));
      insertDecisionLog(db, { timestamp: Date.now(), price: 0, regime: liveRegime, bot_state: 'IDLE',
        prox_lower: null, prox_upper: null, in_range: null,
        decision: 'PAUSED', reasoning: 'Bot paused manually from dashboard. Decision loop halted. Position remains open on-chain and continues earning fees.',
        params_json: null });
    });

    dashboard.onResume(() => {
      if (cycleRunning) console.log(JSON.stringify({ level: 'info', msg: '[Dashboard] Resume during cycle — flag will apply next cycle', timestamp: Date.now() }));
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
      if (cycleRunning) {
        console.log(JSON.stringify({ level: 'warn', msg: '[Dashboard] Add liquidity requested during active cycle — queuing', timestamp: Date.now() }));
        return new Promise<any>((resolve, reject) => { pendingDashboardAction = async () => { try { resolve(await dashboardAddLiquidity()); } catch (e) { reject(e); } }; });
      }
      return dashboardAddLiquidity();
    });

    async function dashboardAddLiquidity() {
      const currentPrice = currentLiveData?.solPrice ?? 0;
      const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
      const balances = await getWalletBalances(conn, (executor as any).wallet.publicKey);
      const posComp = await executor.getPositionComposition();
      const posValue = posComp?.totalUsdc ?? 0;
      const totalValue = balances.sol * currentPrice + balances.usdc + posValue;
      const maxDeploy = totalValue * params.deployPct;
      const headroom = Math.max(0, maxDeploy - posValue);
      console.log(JSON.stringify({ level: 'info', msg: `ADD LIQUIDITY triggered from dashboard. Headroom: $${headroom.toFixed(2)} (cap ${(params.deployPct*100).toFixed(0)}%)`, timestamp: Date.now() }));
      const result = await executor.increaseLiquidity(currentPrice, headroom > 10 ? headroom : undefined);
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
    }

    dashboard.onHarvest(async () => {
      if (cycleRunning) {
        console.log(JSON.stringify({ level: 'warn', msg: '[Dashboard] Harvest requested during active cycle — queuing', timestamp: Date.now() }));
        return new Promise<{ feeSol: number; feeUsdc: number }>((resolve, reject) => { pendingDashboardAction = async () => { try { resolve(await dashboardHarvest()); } catch (e) { reject(e); } }; });
      }
      return dashboardHarvest();
    });

    async function dashboardHarvest(): Promise<{ feeSol: number; feeUsdc: number }> {
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
    }

    dashboard.onClosePosition(async () => {
      if (cycleRunning) {
        console.log(JSON.stringify({ level: 'warn', msg: '[Dashboard] Close requested during active cycle — queuing for after cycle', timestamp: Date.now() }));
        return new Promise<void>((resolve, reject) => { pendingDashboardAction = async () => { try { await dashboardClosePosition(); resolve(); } catch (e) { reject(e); } }; });
      }
      return dashboardClosePosition();
    });

    async function dashboardClosePosition() {
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
        position_json: null, updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
      });

      console.log(JSON.stringify({ level: 'info', msg: 'Position closed. Bot paused in IDLE.', timestamp: Date.now() }));
    }

    dashboard.onEmergencyStop(async () => {
      console.log(JSON.stringify({ level: 'warn', msg: 'EMERGENCY STOP triggered from dashboard', timestamp: Date.now() }));
      clearInterval(decisionLoop);
      oracle.stop();
      marketData.stop();

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
        position_json: null, updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl, tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
      });

      console.log(JSON.stringify({ level: 'info', msg: 'Emergency stop complete. Exiting in 3s...', timestamp: Date.now() }));
      setTimeout(() => process.exit(0), 3000);
    });
  }

  // Telegram reporter
  let reporter: { stop: () => void } | null = null;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  const reportIntervalMin = parseInt(process.env.REPORT_INTERVAL_MINUTES ?? '20');
  if (tgToken && tgChatId) {
    reporter = startTelegramReporter(
      { botToken: tgToken, chatId: tgChatId, intervalMs: reportIntervalMin * 60_000 },
      db,
      () => currentLiveData,
      () => marketData.getSignals(),
    );
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'telegram reporter disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)', timestamp: Date.now() }));
  }

  // Analysis agent — weekly auto-run (Sunday midnight Berlin, if enabled)
  let lastAnalysisCheck = 0;
  setInterval(async () => {
    const now = Date.now();
    if (now - lastAnalysisCheck < 3600_000) return; // check once per hour
    lastAnalysisCheck = now;
    try {
      const enabled = getRuleEnabled(db, 'analysisAgent');
      if (!enabled) return;
      const d = new Date(now);
      const berlinHour = parseInt(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }));
      const berlinDay = d.toLocaleDateString('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
      if (berlinDay === 'Sun' && berlinHour === 0) {
        // Check if already ran today
        const { getConfig: gc } = await import('./db/sqlite.js');
        const cfg = gc(db);
        const lastRun = parseInt(cfg['analysisLastRunTime'] ?? '0');
        if (now - lastRun < 86400_000) return; // already ran within 24h
        console.log(JSON.stringify({ level: 'info', msg: 'Analysis agent: running weekly report', timestamp: now }));
        const { execSync } = await import('child_process');
        const output = execSync('node scripts/weekly-analysis.cjs --days=7 --telegram', { cwd: process.cwd(), timeout: 60000 }).toString();
        const { setConfig: sc } = await import('./db/sqlite.js');
        sc(db, 'analysisLastReport', output);
        sc(db, 'analysisLastRunTime', String(now));
        console.log(JSON.stringify({ level: 'info', msg: 'Analysis agent: report complete + sent to Telegram', timestamp: now }));
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'Analysis agent failed', error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: now }));
    }
  }, 60_000);

  // Portfolio snapshot — every 4 hours for arcade page
  let lastPortfolioSnap = 0;
  setInterval(() => {
    const now = Date.now();
    if (now - lastPortfolioSnap < 4 * 3600_000) return;
    lastPortfolioSnap = now;
    const total = currentLiveData?.totalValueWithPosition ?? 0;
    if (total > 0) {
      try { db.prepare('INSERT INTO portfolio_snapshots (ts, total_value) VALUES (?, ?)').run(now, total); } catch (e) { console.log(JSON.stringify({ level: 'warn', msg: `portfolio_snapshot insert: ${String(e)}`, timestamp: Date.now() })); }
    }
  }, 60_000);
  // Seed first snapshot on startup
  {
    const total = currentLiveData?.totalValueWithPosition ?? 0;
    if (total > 0) {
      try { db.prepare('INSERT INTO portfolio_snapshots (ts, total_value) VALUES (?, ?)').run(Date.now(), total); } catch (e) { console.log(JSON.stringify({ level: 'warn', msg: `portfolio_snapshot seed: ${String(e)}`, timestamp: Date.now() })); }
    }
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...', timestamp: Date.now() }));
    clearInterval(decisionLoop);
    oracle.stop();
    marketData.stop();
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
      tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
    });

    console.log(JSON.stringify({ level: 'info', msg: 'State saved. Bye.', timestamp: Date.now() }));
    process.exit(0);
  });
}

// ── REGIME REOPEN LOGIC ──────────────────────────────────────────────────

function shouldReopenForRegime(params: {
  positionOpenRegime: string;
  currentRegime: string;
  regimeStableMs: number;
  proxToLower: number;
  pendingFeesUsd: number;
  currentRangeWidthPct: number;
  currentPrice: number;
  confidence: string;
}): { shouldReopen: boolean; reason: string; urgency?: string; harvestFirst?: boolean } {
  const { positionOpenRegime, currentRegime } = params;

  if (currentRegime === positionOpenRegime) {
    return { shouldReopen: false, reason: 'same regime' };
  }
  if (!runtime.regimeReopenEnabled) {
    return { shouldReopen: false, reason: 'reopen disabled' };
  }

  const key = `${positionOpenRegime}→${currentRegime}`;
  const rule = REGIME_TRANSITION_RULES[key];
  if (!rule) {
    return { shouldReopen: false, reason: `no rule for ${key}` };
  }

  // Confidence gate
  const confOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const minConf = confOrder[runtime.regimeReopenMinConfidence as keyof typeof confOrder] ?? 1;
  const curConf = confOrder[params.confidence as keyof typeof confOrder] ?? 0;
  if (curConf < minConf && rule.urgency !== 'CRITICAL') {
    return { shouldReopen: false, reason: `confidence ${params.confidence} < required ${runtime.regimeReopenMinConfidence}, urgency ${rule.urgency}` };
  }

  // Stability gate
  const stableMinutes = params.regimeStableMs / 60000;
  if (stableMinutes < rule.stableMinutes) {
    return { shouldReopen: false, reason: `regime stable ${stableMinutes.toFixed(1)}min < required ${rule.stableMinutes}min` };
  }

  // Width threshold gate
  const targetParams = runtime.regimeParams[currentRegime] ?? getRegimeParams(currentRegime as Regime);
  const targetWidth = targetParams.rangeWidthPct;
  const currentWidthPct = params.currentRangeWidthPct;
  const widthRatio = targetWidth > 0 ? currentWidthPct / targetWidth : 1;

  const isTooWide = widthRatio >= rule.widthThreshold;
  const isTooNarrow = rule.widthThreshold > 0 ? widthRatio <= (1 / rule.widthThreshold) : false;
  const skewMismatch = true; // always true since regimes differ in shouldReopenForRegime

  const widthGatePasses = isTooWide || isTooNarrow || skewMismatch;

  if (!widthGatePasses && rule.urgency !== 'CRITICAL') {
    return { shouldReopen: false, reason: `width ratio ${widthRatio.toFixed(2)} within acceptable range` };
  }

  // Proximity gate — bypassed for CRITICAL and HIGH urgency (urgency overrides timing)
  if (rule.urgency !== 'CRITICAL' && rule.urgency !== 'HIGH') {
    if (params.proxToLower > runtime.regimeReopenMaxProximity) {
      return { shouldReopen: false, reason: `proxToLower ${params.proxToLower.toFixed(2)} > max ${runtime.regimeReopenMaxProximity}` };
    }
    if (params.proxToLower < runtime.regimeReopenMinProximity) {
      return { shouldReopen: false, reason: `proxToLower ${params.proxToLower.toFixed(2)} < min ${runtime.regimeReopenMinProximity}` };
    }
  }

  // Pending fees gate
  const harvestFirst = params.pendingFeesUsd > runtime.regimeReopenMaxPendingFees;
  if (harvestFirst && rule.urgency === 'LOW') {
    return { shouldReopen: false, reason: `pending fees $${params.pendingFeesUsd.toFixed(2)} > max, LOW urgency` };
  }

  return {
    shouldReopen: true,
    urgency: rule.urgency,
    harvestFirst,
    reason: `${key} | urgency=${rule.urgency} | stable=${stableMinutes.toFixed(1)}min | width=${widthRatio.toFixed(2)}x | prox=${params.proxToLower.toFixed(2)}`,
  };
}

function isGoodReopenMoment(params: {
  proxToLower: number;
  bbWidth: number;
  pendingFeesUsd: number;
  minutesSinceLastClose: number;
  priceVelocity5min: number;
  urgency: string;
  minutesWaiting: number;
}): { good: boolean; reason: string } {
  const maxWait: Record<string, number> = {
    CRITICAL: runtime.regimeReopenMaxWaitCritical ?? 15,
    HIGH: runtime.regimeReopenMaxWaitHigh ?? 45,
    MEDIUM: runtime.regimeReopenMaxWaitMedium ?? 120,
    LOW: 0,
  };

  const wait = maxWait[params.urgency] ?? 60;
  if (wait > 0 && params.minutesWaiting >= wait) {
    return { good: true, reason: `max wait ${wait}min reached — forcing reopen` };
  }

  if (params.urgency === 'LOW') {
    return { good: false, reason: 'LOW urgency — waiting for natural exit' };
  }

  // Proximity gate — bypassed for CRITICAL and HIGH urgency (urgency overrides timing)
  if (params.urgency !== 'CRITICAL' && params.urgency !== 'HIGH') {
    if (params.proxToLower > 0.68) {
      return { good: false, reason: `near lower exit (prox ${(params.proxToLower * 100).toFixed(0)}%) — let natural exit happen` };
    }
    if (params.proxToLower < 0.32) {
      return { good: false, reason: `near upper exit (prox ${(params.proxToLower * 100).toFixed(0)}%) — let natural exit happen` };
    }
  }

  const maxVelocity = runtime.regimeReopenMaxPriceVelocity ?? 0.30;
  if (params.priceVelocity5min > maxVelocity) {
    return { good: false, reason: `price moving fast ($${params.priceVelocity5min.toFixed(2)}/5min > $${maxVelocity.toFixed(2)})` };
  }

  const maxBb = runtime.regimeReopenMaxBbWidth ?? 2.5;
  if (params.bbWidth > maxBb) {
    return { good: false, reason: `high volatility BB ${params.bbWidth.toFixed(1)}% > ${maxBb}%` };
  }

  if (params.pendingFeesUsd > 8) {
    return { good: false, reason: `pending fees $${params.pendingFeesUsd.toFixed(2)} > $8 — harvest first` };
  }

  if (params.minutesSinceLastClose < 5) {
    return { good: false, reason: `too soon after last close (${params.minutesSinceLastClose.toFixed(1)}min)` };
  }

  const nearMid = params.proxToLower >= 0.40 && params.proxToLower <= 0.60;
  return {
    good: true,
    reason: nearMid ? 'price near midpoint — optimal re-entry' : 'conditions acceptable for reopen',
  };
}

// ── LIVE CYCLE ────────────────────────────────────────────────────────────

async function runLiveCycle(price: number): Promise<void> {
  if (!liveExecutor) return;
  const now = Date.now();

  if (liveBotState === 'HALTED') return;

  // Track recent prices for flash crash detection (keep last 10)
  liveRecentPrices.push(price);
  if (liveRecentPrices.length > 10) liveRecentPrices.shift();

  // ── Phase 19: dynamic scaling — compute operating state & params ────────
  // Uses the latest liveData snapshot (refreshed each cycle by the dashboard
  // block). On the very first cycle (before any snapshot), falls through to
  // the module-level floor defaults and continues normally.
  const walletEquityNow = currentLiveData?.totalValueWithPosition;
  if (walletEquityNow != null && walletEquityNow > 0) {
    const opState = dynamicScaling.computeOperatingState(
      walletEquityNow,
      runtime.maxLiveCapitalUsdc,
      runtime.pauseThresholdUsdc,
    );
    const dynNew = dynamicScaling.computeDynamicParams(
      opState,
      price,
      {
        // Phase 19A
        minDeployUsdcFloor: runtime.minDeployUsdcFloor,
        solReserveFloor: runtime.solReserveFloor,
        idleRebalanceMinUsdcFloor: runtime.idleRebalanceMinUsdcFloor,
        usdcReserveFloor: runtime.usdcReserveFloor,
        // Phase 19B
        strategicRebalanceMinPortfolioUsdcFloor: runtime.strategicRebalanceMinPortfolioUsdcFloor,
        solConvertMinAmountUsdcFloor: runtime.solConvertMinAmountUsdcFloor,
        manualSwapDetectionMinSolFloor: runtime.manualSwapDetectionMinSolFloor,
        manualSwapDetectionMinUsdcFloor: runtime.manualSwapDetectionMinUsdcFloor,
        idleRebalanceMinImbalanceUsdcFloor: runtime.idleRebalanceMinImbalanceUsdcFloor,
        deployMinThresholdUsdcFloor: runtime.deployMinThresholdUsdcFloor,
      },
      runtime.dynamicScalingEnabled,
    );
    dynamicScaling.setCurrent(opState, dynNew);
    if (opState.paused) {
      console.log(JSON.stringify({
        level: 'warn',
        msg: `[Bot] Paused — ${opState.pauseReason}. Wallet $${walletEquityNow.toFixed(2)} < pauseThreshold $${runtime.pauseThresholdUsdc}. Skipping cycle operations.`,
        timestamp: now,
      }));
      return;
    }
  }

  // ── Defensive Downtrend Mode (Phase C core) ─────────────────────────────
  // When enabled: detect sustained drawdown and stop LP operations.
  // Gating (AUTO_DEPLOY / open / idle-rebal buy) is applied at each site.
  // When disabled: triggers return null, state never flips active.
  if (runtime.defensiveDowntrendEnabled || defensiveState.active) {
    try {
      // Always update entry price low while active (tracks recovery baseline)
      if (defensiveState.active) {
        const updated = updateEntryPriceLow(defensiveState, price);
        if (updated !== defensiveState) {
          defensiveState = updated;
          persistDefensiveState();
        }
      }

      // Exit path: already active → check if we should leave
      if (defensiveState.active) {
        const exit = checkDefensiveExit(defensiveState, price, lastRsi, now);
        if (exit.shouldExit) {
          const durationMin = defensiveState.enteredAt ? (now - defensiveState.enteredAt) / 60_000 : 0;
          console.log(JSON.stringify({ level: 'info', msg: `[DEFENSIVE] EXIT: reason=${exit.reason}, duration=${durationMin.toFixed(1)}min, enteredPrice=$${(defensiveState.enteredPrice ?? 0).toFixed(2)}, priceLow=$${(defensiveState.entryPriceLow ?? 0).toFixed(2)}, currentPrice=$${price.toFixed(2)}`, timestamp: now }));
          const cooldownUntil = now + runtime.defensiveDowntrendCooldownMinutes * 60_000;
          const preExit = defensiveState;
          defensiveState = { active: false, enteredAt: null, enteredPrice: null, enteredTrigger: null, entryPriceLow: null, cooldownUntil };
          persistDefensiveState();
          // Clear the manual force-exit flag after honoring it (one-shot)
          if (exit.reason === 'manual_force_exit') runtime.defensiveDowntrendForceExit = false;
          insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
            prox_lower: null, prox_upper: null, in_range: null,
            decision: 'DEFENSIVE_EXIT', reasoning: `Defensive mode exit: ${exit.reason}. Cooldown ${runtime.defensiveDowntrendCooldownMinutes}min.`,
            params_json: JSON.stringify({ durationMin, enteredPrice: preExit.enteredPrice, priceLow: preExit.entryPriceLow, currentPrice: price, exitReason: exit.reason }) });
        }
      } else if (runtime.defensiveDowntrendEnabled) {
        // Entry path: feature enabled, not active → check triggers
        const cooldownActive = defensiveState.cooldownUntil != null && now < defensiveState.cooldownUntil;
        const price1hAgo = queryPriceAt(now - 3_600_000);
        const price4hAgo = queryPriceAt(now - 14_400_000);
        const price24hAgo = queryPriceAt(now - 86_400_000);
        const price7dAgo = queryPriceAt(now - 604_800_000);
        const trig = checkDefensiveTriggers(price, price1hAgo, price4hAgo, price24hAgo, price7dAgo, lastRsi, now);

        // Emergency re-entry: allow re-enter during cooldown if trigger is this many × stricter.
        // Implementation: during cooldown, multiply configured thresholds by the emergency multiplier
        // by temporarily checking a stricter drop (price fell faster than normal threshold × multiplier).
        let allowEntry = !cooldownActive && trig.trigger != null;
        if (!allowEntry && cooldownActive && trig.trigger != null) {
          const mult = runtime.defensiveDowntrendEmergencyReentryMultiplier;
          // Derive a stricter drop check: compare realized drop to threshold × multiplier.
          // Only the most severe trigger types need re-checking.
          const drops: Array<[number | null, number]> = [
            [price1hAgo, runtime.defensiveDowntrend1hDropPct * mult],
            [price4hAgo, runtime.defensiveDowntrend4hDropPct * mult],
            [price24hAgo, runtime.defensiveDowntrend24hDropPct * mult],
            [price7dAgo, runtime.defensiveDowntrend7dDropPct * mult],
          ];
          for (const [pAgo, thresh] of drops) {
            if (pAgo != null && pAgo > 0 && (pAgo - price) / pAgo >= thresh) { allowEntry = true; break; }
          }
        }

        if (allowEntry) {
          defensiveState = { active: true, enteredAt: now, enteredPrice: price, enteredTrigger: trig.trigger, entryPriceLow: price, cooldownUntil: defensiveState.cooldownUntil };
          persistDefensiveState();
          console.log(JSON.stringify({ level: 'info', msg: `[DEFENSIVE] ENTER: trigger=${trig.trigger}, price=$${price.toFixed(2)}, rsi=${lastRsi?.toFixed(1) ?? 'null'}${cooldownActive ? ' [emergency-reentry]' : ''}`, timestamp: now }));
          insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
            prox_lower: null, prox_upper: null, in_range: null,
            decision: 'DEFENSIVE_ENTER', reasoning: `Defensive downtrend mode entered: ${trig.trigger}. Price=$${price.toFixed(2)}, RSI=${lastRsi?.toFixed(1) ?? 'null'}. Blocks AUTO_DEPLOY / openPosition / idle-rebal buys until exit.`,
            params_json: JSON.stringify({ trigger: trig.trigger, price1hAgo, price4hAgo, price24hAgo, price7dAgo, rsi: lastRsi, emergencyReentry: cooldownActive }) });
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `[DEFENSIVE] check failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: now }));
    }
  }

  // Regime update (every 1 hour)
  if (now - liveLastRegimeCheck > runtime.regimeCheckIntervalMs) {
    const closes = getDailyCloses(db, runtime.regimeWindowDays);
    const MIN_CLOSES_FOR_REGIME_CHANGE = 5;

    // ── TA-first regime detection (primary path) ──────────────────────────
    const mktSignals = marketData.getSignals();
    const ta = mktSignals?.ta ?? null;

    let newRegime: Regime;
    let reasoningText: string;
    let paramsJson: Record<string, unknown>;
    let deployMultiplier = 1.0; // may be reduced by TA confidence

    if (ta != null) {
      // Primary path: TA-first detection
      // Get daily regime as veto-only input
      const dailyRegime = closes.length >= 3 ? detectRegime(closes, runtime.trendThreshold) : null;
      const taResult = detectRegimeTA(ta, mktSignals, dailyRegime, taRegimeCandidate, taRegimeCandidateCount, price);
      cycleTaResult = taResult;
      cycleDailyRegime = dailyRegime ?? null;

      // Update hysteresis state
      taRegimeCandidate = taResult.candidateRegime;
      taRegimeCandidateCount = taResult.newCandidateCount;
      deployMultiplier = taResult.deployMultiplier;
      // Master switch: force 1.0 when dynamic adjustments disabled so downstream
      // position-size sites (auto-deploy, rebalance, SolConvert cap) are static.
      taDeployMultiplier = runtime.dynamicAdjustmentsEnabled ? taResult.deployMultiplier : 1.0;

      newRegime = taResult.regime;
      reasoningText = taResult.log;
      paramsJson = {
        method: 'TA-first',
        score: taResult.score,
        confidence: taResult.confidence,
        deployMultiplier: taResult.deployMultiplier,
        candidateRegime: taResult.candidateRegime,
        candidateCount: taResult.newCandidateCount,
        dailyRegime,
        ta: { rsi14: ta.rsi14, bbWidth: ta.bbWidth, bbPosition: ta.bbPosition, trendDirection: ta.trendDirection, atr14: ta.atr14 },
        vol1h: mktSignals?.vol1h ?? null,
        solDelta24h: mktSignals?.solDelta24h ?? null,
        volumeRatio4h: mktSignals?.volumeRatio4h ?? null,
        fearGreedIndex: mktSignals?.fearGreedIndex ?? null,
      };
    } else {
      // Fallback: use existing detectRegimeEnhanced when TA not yet available
      const mktSignalsFallback = runtime.useEnhancedRegime ? mktSignals : null;
      const enhancedResult = detectRegimeEnhanced(closes, runtime.trendThreshold, mktSignalsFallback, {
        vol1hExtremeThreshold: runtime.vol1hExtremeThreshold,
        vol4hExtremeThreshold: runtime.vol4hExtremeThreshold,
        volumeSpikeMultiple: runtime.volumeSpikeMultiple,
        trendDeltaThreshold: runtime.trendDeltaThreshold,
        btcCorrelationThreshold: runtime.btcCorrelationThreshold,
        fearGreedExtremeLow: runtime.fearGreedExtremeLow,
        fearGreedExtremeHigh: runtime.fearGreedExtremeHigh,
      });

      const priceDir = closes.length >= 2 ? (closes[closes.length - 1] > closes[0] ? 'UP' : 'DOWN') : 'N/A';
      const volStatus = enhancedResult.realisedVol > 0.08 ? 'ABOVE 0.08 threshold → EXTREME' : `${enhancedResult.realisedVol.toFixed(4)} (below 0.08 threshold)`;
      const dirStatus = enhancedResult.dirRatio > runtime.trendThreshold ? `ABOVE ${runtime.trendThreshold} threshold → trending` : `${enhancedResult.dirRatio.toFixed(3)} (below ${runtime.trendThreshold} threshold → ranging)`;
      const sig = enhancedResult.signals;
      const mktParts: string[] = [];
      if (sig.vol1h != null) mktParts.push(`vol1h=${sig.vol1h.toFixed(4)}`);
      if (sig.vol4h != null) mktParts.push(`vol4h=${sig.vol4h.toFixed(4)}`);
      if (sig.solDelta24h != null) mktParts.push(`SOL24h=${sig.solDelta24h > 0 ? '+' : ''}${sig.solDelta24h.toFixed(1)}%`);
      if (sig.btcDelta24h != null) mktParts.push(`BTC24h=${sig.btcDelta24h > 0 ? '+' : ''}${sig.btcDelta24h.toFixed(1)}%`);
      if (sig.volumeRatio4h != null) mktParts.push(`volRatio=${sig.volumeRatio4h.toFixed(1)}x`);
      if (sig.fearGreedIndex != null) mktParts.push(`F&G=${sig.fearGreedIndex}`);
      const mktSummary = mktParts.length > 0 ? ` Market signals: ${mktParts.join(', ')}.` : ' No market data available.';
      const overrideNote = enhancedResult.overrideReason ? ` OVERRIDE: ${enhancedResult.overrideReason} (base was ${enhancedResult.baseRegime}).` : '';

      newRegime = enhancedResult.regime;
      reasoningText = `[Regime] Fallback (no TA): ${enhancedResult.priceCount} daily closes. ` +
        `realisedVol=${volStatus}. dirRatio=${dirStatus}. Price direction: ${priceDir}. ` +
        `${closes.length >= 2 ? `Price range: $${Math.min(...closes).toFixed(2)}-$${Math.max(...closes).toFixed(2)}.` : 'Insufficient data.'}` +
        mktSummary + overrideNote + ` Confidence: ${enhancedResult.confidence}/5.` +
        ` Result: ${newRegime}.`;
      paramsJson = {
        method: 'enhanced-fallback',
        dirRatio: enhancedResult.dirRatio, realisedVol: enhancedResult.realisedVol, priceCount: enhancedResult.priceCount,
        trendThreshold: runtime.trendThreshold, baseRegime: enhancedResult.baseRegime,
        overrideReason: enhancedResult.overrideReason, confidence: enhancedResult.confidence,
        ...enhancedResult.signals,
      };
    }

    // Determine if regime has changed (hysteresis in TA path already prevents premature change)
    const marketConfirmed = mktSignals != null;
    const changed = newRegime !== liveRegime && (ta != null || closes.length >= MIN_CLOSES_FOR_REGIME_CHANGE || marketConfirmed);

    // Log regime changes immediately; unchanged evals only every 1 hour
    if (changed || now - liveLastRegimeEvalLog >= 3_600_000) {
      liveLastRegimeEvalLog = now;
      insertDecisionLog(db, { timestamp: now, price, regime: newRegime, bot_state: liveBotState,
        prox_lower: null, prox_upper: null, in_range: null,
        decision: changed ? 'REGIME_CHANGE' : 'REGIME_EVAL',
        reasoning: reasoningText + (changed ? ` (CHANGED from ${liveRegime})` : ' (no change)') +
          (deployMultiplier < 1.0 ? ` Deploy multiplier: ${Math.round(deployMultiplier * 100)}%.` : ''),
        params_json: JSON.stringify(paramsJson) });
    }

    if (changed) {
      const oldRegime = liveRegime;
      liveRegime = newRegime;
      console.log(JSON.stringify({ level: 'info', msg: 'LIVE regime change', from: oldRegime, to: newRegime, method: ta != null ? 'TA-first' : 'enhanced-fallback', deployMultiplier, timestamp: now }));

      // Regime-Change Refresh: mark/unmark/update when regime flips mid-position
      const rcrPos = liveExecutor?.getCurrentPosition() ?? null;
      const rcrAction = regimeRefresh.checkRegimeChange({
        newRegime,
        prevRegime: oldRegime,
        entryRegime: rcrEntryRegime,
        markedForSwitch: rcrMarkedForSwitch,
        markTarget: rcrMarkTargetRegime,
        hasOpenPosition: !!rcrPos,
        enabled: runtime.regimeChangeRefreshEnabled,
      });
      if (rcrAction) {
        if (rcrAction.action === 'MARK') {
          rcrMarkedForSwitch = true;
          rcrMarkTimestamp = now;
          rcrMarkTargetRegime = rcrAction.to;
        } else if (rcrAction.action === 'UPDATE_TARGET') {
          rcrMarkTargetRegime = rcrAction.to;
        } else {
          // UNMARK
          rcrMarkedForSwitch = false;
          rcrMarkTimestamp = null;
          rcrMarkTargetRegime = null;
        }
        persistRcrState();
        regimeRefresh.logMarkEvent(db, { action: rcrAction, entryRegime: rcrEntryRegime, price });
        console.log(JSON.stringify({
          level: 'info',
          msg: `[RCR] ${rcrAction.action}: entry=${rcrEntryRegime} newRegime=${newRegime} target=${rcrMarkTargetRegime} marked=${rcrMarkedForSwitch}`,
          timestamp: now,
        }));
      }
      // Update reserve floor for new regime
      const newFloorPct = (runtime.regimeParams[newRegime] ?? getRegimeParams(newRegime)).reserveFloorPct ?? 0.20;
      if (currentLiveData?.totalValueWithPosition) {
        checkReserveFloor(db, currentLiveData.totalValueWithPosition, newFloorPct);
      }
      const dailyMetrics = closes.length >= 3 ? detectRegimeWithMetrics(closes, runtime.trendThreshold) : null;
      insertRegimeChange(db, {
        timestamp: now, old_regime: oldRegime, new_regime: newRegime, price,
        dir_ratio: dailyMetrics?.dirRatio ?? 0, realised_vol: dailyMetrics?.realisedVol ?? 0, price_count: dailyMetrics?.priceCount ?? 0,
      });
      insertRebalanceEventWithRule2(db, {
        timestamp: now, eventType: 'REGIME_CHANGE', price, regime: newRegime,
        note: reasoningText + `\nEXECUTED: Regime changed from ${oldRegime} to ${newRegime}. All rule parameters updated.` +
          (deployMultiplier < 1.0 ? ` Deploy multiplier: ${Math.round(deployMultiplier * 100)}%.` : ''),
        solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0, feeSol: 0, feeUsdc: 0, ilAtClose: 0,
      });

      // Record regime change timestamp — per-cycle reopen check uses this for stability gate
      lastRegimeChangeTs = now;
    }
    liveLastRegimeCheck = now;
  }

  // Rebalance rate limit
  if (now - liveRebalanceHourStart > 3600_000) {
    liveRebalancesThisHour = 0;
    liveRebalanceHourStart = now;
  }
  if (liveRebalancesThisHour >= runtime.rebalanceLoopLimit) return;

  let params = { ...(runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)) };
  const currentPos = liveExecutor.getCurrentPosition();

  // ── VAR override: dynamic params from volatility ──
  // VAR can suggest a width but the regime config width acts as a ceiling.
  // User sets regime width to control max concentration; VAR only widens up to that.
  if (runtime.varEnabled) {
    const mktSig = marketData.getSignals();
    if (mktSig?.vol1h != null) {
      const regimeWidth = params.rangeWidthPct; // user-configured width for this regime
      const varConfig: VarConfig = {
        enabled: true, multiplier: runtime.varMultiplier, targetHours: runtime.varTargetHours,
        minWidth: runtime.varMinWidth, maxWidth: Math.max(regimeWidth, runtime.varMaxWidth),
        adjustThreshold: runtime.varAdjustThreshold, minPositionAge: runtime.varMinAge,
        cooldownMinutes: runtime.varCooldown,
      };
      const varP = calculateVarParams(mktSig.vol1h, mktSig.solDelta24h ?? 0, varConfig);
      // Regime width = user's desired width. VAR does NOT override width.
      // Width is set by the user via config. VAR only influences thresholds.
      params.rangeWidthPct = regimeWidth;
      // Clamp downside threshold: never exceed regime config (65%) to prevent SOL-heavy exits
      const regimeThreshLower = (runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime)).proxThresholdLower;
      params.proxThresholdLower = Math.min(varP.proxThresholdLower, regimeThreshLower);
      params.proxThresholdUpper = varP.proxThresholdUpper;
      params.deployPct = varP.deployPct;

      // ── Technical Analysis adjustments ──
      const ta = mktSig.ta;
      if (ta) {
        // Widen range near support/resistance (breakout likely)
        if (ta.resistance && ta.support) {
          const distToResist = ta.resistance > 0 ? Math.abs(price - ta.resistance) / price : 1;
          const distToSupport = ta.support > 0 ? Math.abs(price - ta.support) / price : 1;
          if (distToResist < 0.003 || distToSupport < 0.003) {
            // Price within 0.3% of S/R — widen range for safety
            params.rangeWidthPct = Math.max(params.rangeWidthPct, regimeWidth * 1.5);
            console.log(JSON.stringify({ level: 'info', msg: `TA: near S/R level (S=$${ta.support.toFixed(2)} R=$${ta.resistance.toFixed(2)}), widening to ${params.rangeWidthPct.toFixed(2)}%`, timestamp: now }));
          }
        }

        // Bollinger squeeze → tighten range (low vol, concentrate for fees)
        if (ta.bbWidth != null && ta.bbWidth < 0.8) {
          params.rangeWidthPct = Math.max(regimeWidth * 0.8, params.rangeWidthPct * 0.9);
          console.log(JSON.stringify({ level: 'info', msg: `TA: Bollinger squeeze (width ${ta.bbWidth.toFixed(1)}%), tightening range`, timestamp: now }));
        }

        // RSI extreme → adjust skew
        if (ta.rsi14 != null) {
          if (ta.rsi14 > 70) {
            // Overbought — give more upside room (price likely to stay high or pull back)
            params.skewUp = Math.min(0.70, params.skewUp + 0.10);
            params.skewDown = 1 - params.skewUp;
          } else if (ta.rsi14 < 30) {
            // Oversold — give more downside room
            params.skewDown = Math.min(0.70, params.skewDown + 0.10);
            params.skewUp = 1 - params.skewDown;
          }
        }
      }

      // VAR range adjustment DISABLED — width is user-controlled via config.
      // VAR only influences thresholds and skew, not width.
      // Positions are not closed/reopened for width changes.
    }
  }

  // Apply TA confidence deploy multiplier (reduces deployPct when TA signal is weak)
  if (runtime.dynamicAdjustmentsEnabled && taDeployMultiplier < 1.0) {
    params.deployPct *= taDeployMultiplier;
  }

  // Force reopen: check for DB flag (set via manual intervention instead of clearing position_json)
  const forceReopenFlag = getConfig(db)['forceReopen'] === 'true';
  if (forceReopenFlag && currentPos) {
    console.log(JSON.stringify({ level: 'info', msg: 'Force reopen requested via DB flag. Closing current position...', timestamp: now }));
    setConfig(db, 'forceReopen', 'false');
    try {
      await liveClosePosition(price, 'POSITION_CLOSED', 'Force reopen requested via config flag.');
    } catch (e) {
      console.log(JSON.stringify({ level: 'error', msg: 'Force reopen close failed', error: String(e), timestamp: now }));
    }
    return; // next cycle will open fresh
  }

  // Clear stale reopen if regime reverted to position regime
  if (reopenPendingTs && currentPos && currentPos.regime === liveRegime) {
    console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] Cleared — regime reverted to position regime (${currentPos.regime})`, timestamp: now }));
    reopenPendingTs = null;
    reopenPendingRegime = null;
    reopenPendingUrgency = null;
    reopenPendingOldRegime = null;
  }

  // ── Per-cycle: detect regime mismatch and evaluate reopen ──
  if (currentPos && liveExecutor && currentPos.regime !== liveRegime && !reopenPendingTs) {
    const regimeStableMs = lastRegimeChangeTs > 0 ? now - lastRegimeChangeTs : 99 * 60_000;
    const mismatchProx = calcProximity(price, currentPos as any);
    const mismatchWidthPct = currentPos.priceUpper > 0 && currentPos.priceLower > 0
      ? ((currentPos.priceUpper - currentPos.priceLower) / ((currentPos.priceUpper + currentPos.priceLower) / 2)) * 100
      : 2.0;
    const confLevel = (taDeployMultiplier ?? 1.0) >= 1.0 ? 'HIGH' : (taDeployMultiplier ?? 1.0) >= 0.75 ? 'MEDIUM' : 'LOW';

    const reopenCheck = shouldReopenForRegime({
      positionOpenRegime: currentPos.regime,
      currentRegime: liveRegime,
      regimeStableMs,
      proxToLower: mismatchProx.proxToLower,
      pendingFeesUsd: cachedPendingFeesTotal,
      currentRangeWidthPct: mismatchWidthPct,
      currentPrice: price,
      confidence: confLevel,
    });

    if (reopenCheck.shouldReopen) {
      reopenPendingTs = now;
      reopenPendingRegime = liveRegime;
      reopenPendingUrgency = reopenCheck.urgency ?? 'MEDIUM';
      reopenPendingOldRegime = currentPos.regime;
      console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] Mismatch: ${currentPos.regime} → ${liveRegime} — ${reopenCheck.reason}`, timestamp: now }));
    } else {
      // Log once per 10 minutes to avoid spam
      if (now % 600_000 < 60_000) {
        console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] Mismatch ${currentPos.regime}→${liveRegime} — no reopen: ${reopenCheck.reason}`, timestamp: now }));
      }
    }
  }

  // ── Per-cycle regime reopen timing check ──
  if (reopenPendingTs && currentPos && liveExecutor) {
    const minutesWaiting = (now - reopenPendingTs) / 60000;
    const minutesSinceLastClose = lastPositionCloseTs > 0 ? (now - lastPositionCloseTs) / 60000 : 999;
    const priceVelocity5min = liveRecentPrices.length >= 2
      ? Math.abs(liveRecentPrices[liveRecentPrices.length - 1] - liveRecentPrices[0])
      : 0;
    const prox = calcProximity(price, currentPos as any);

    const timingCheck = isGoodReopenMoment({
      proxToLower: prox.proxToLower,
      bbWidth: lastBbWidth ?? 1.5,
      pendingFeesUsd: cachedPendingFeesTotal,
      minutesSinceLastClose,
      priceVelocity5min,
      urgency: reopenPendingUrgency ?? 'MEDIUM',
      minutesWaiting,
    });

    console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] Timing: ${timingCheck.reason} (waiting ${minutesWaiting.toFixed(1)}min, ${reopenPendingOldRegime} → ${reopenPendingRegime})`, timestamp: now }));

    if (timingCheck.good) {
      console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] EXECUTING: ${reopenPendingOldRegime} → ${reopenPendingRegime} (${reopenPendingUrgency}, waited ${minutesWaiting.toFixed(1)}min)`, timestamp: now }));
      const targetRegime = reopenPendingRegime!;
      const urgency = reopenPendingUrgency!;
      const fromRegime = reopenPendingOldRegime!;
      reopenPendingTs = null;
      reopenPendingRegime = null;
      reopenPendingUrgency = null;
      reopenPendingOldRegime = null;
      try {
        const closed = await liveClosePosition(price, 'POSITION_CLOSED', `Regime reopen (${urgency}): ${fromRegime} → ${targetRegime}`);
        if (!closed) {
          console.log(JSON.stringify({ level: 'warn', msg: '[RegimeReopen] Close failed — position unchanged', timestamp: now }));
          return;
        }
        // Gates: Reserve + Basis + Upside ChurnGuard (downside ChurnGuard skipped for regime reopen)
        const regimeParamsRR = runtime.regimeParams[targetRegime] ?? getRegimeParams(targetRegime as Regime);
        const balancesRR = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
        const positionSizeRR = (balancesRR.sol * price + balancesRR.usdc) * regimeParamsRR.deployPct * (taDeployMultiplier ?? 1.0);
        const usdcNeededRR = positionSizeRR * (regimeParamsRR.usdcDepositPct ?? 0.35);
        const gateRR = checkDeployGate(db, usdcNeededRR, balancesRR.usdc, balancesRR.sol * price + balancesRR.usdc);
        if (!gateRR.allowed) {
          console.log(JSON.stringify({ level: 'warn', msg: `[ReserveGate] Deploy blocked: ${gateRR.reason}`, timestamp: Date.now() }));
          return;
        }
        // BasisGate skipped on LP open — no realized loss when pairing capital.
        // Sell-at-loss protection remains in SolConvert and idle-rebalance SOL-sell paths.
        console.log(JSON.stringify({ level: 'info', msg: '[BasisGate] Skipping for LP open — deploying existing capital, no realized loss', timestamp: Date.now() }));
        // Keep upside ChurnGuard even for regime reopen — prevents opening near upper
        // bound right after an upside exit, which would immediately trigger T1_UPSIDE
        // and waste the reopen. Re-arm the pending timestamp so the check retries next cycle.
        const upsideChurnMinsRR = runtime.upsideChurnCooldownMin ?? 5;
        if (lastUpsideExitTs > 0) {
          const minsSinceUpsideRR = (Date.now() - lastUpsideExitTs) / 60000;
          if (minsSinceUpsideRR < upsideChurnMinsRR) {
            console.log(JSON.stringify({ level: 'warn', msg: `[RegimeReopen] Upside cooldown active — ${minsSinceUpsideRR.toFixed(1)}min < ${upsideChurnMinsRR}min since upside exit at $${lastUpsideExitPrice.toFixed(2)}. Retrying next cycle.`, timestamp: Date.now() }));
            reopenPendingTs = Date.now();
            reopenPendingRegime = targetRegime;
            reopenPendingUrgency = urgency;
            reopenPendingOldRegime = fromRegime;
            return;
          }
        }
        console.log(JSON.stringify({ level: 'info', msg: `[RegimeReopen] Gates passed. Opening with ${targetRegime} params (width=${regimeParamsRR.rangeWidthPct}%)`, timestamp: Date.now() }));
        await liveOpenPosition(price, 'POSITION_OPENED', `Re-opening after regime change: ${fromRegime} → ${targetRegime} (${urgency}, waited ${minutesWaiting.toFixed(0)}min). Width=${regimeParamsRR.rangeWidthPct}%.`);
        await reconcileReserveAfterOpen('RR');
      } catch (e) {
        console.log(JSON.stringify({ level: 'error', msg: '[RegimeReopen] failed', error: String(e), timestamp: now }));
      }
      return;
    }
  }

  // No position → open one
  if (!currentPos) {
    // Strategic SOL Rebalance: if idle + SOL-heavy + below basis, unstick by
    // selling a small SOL slice. Accepts small realized loss to escape idle trap.
    if (await checkStrategicRebalance(price, currentPos)) return;

    // Gate 1: ReserveGate
    const regimeParamsID = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
    const balancesID = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
    const positionSizeID = (balancesID.sol * price + balancesID.usdc) * regimeParamsID.deployPct * (taDeployMultiplier ?? 1.0);
    const usdcNeededID = positionSizeID * (regimeParamsID.usdcDepositPct ?? 0.35);
    const gateID = checkDeployGate(db, usdcNeededID, balancesID.usdc, balancesID.sol * price + balancesID.usdc);
    if (!gateID.allowed) {
      cycleGateReserve = 'BLOCK';
      console.log(JSON.stringify({ level: 'warn', msg: `[ReserveGate] Deploy blocked: ${gateID.reason}. Shortfall: $${gateID.shortfall.toFixed(2)}`, timestamp: Date.now() }));
      return;
    }
    cycleGateReserve = 'PASS';
    console.log(JSON.stringify({ level: 'info', msg: `[ReserveGate] Passed: ${gateID.reason}`, timestamp: Date.now() }));
    // Gate 2: BasisGate — skipped on LP open (no realized loss).
    // Sell-at-loss protection remains in SolConvert and idle-rebalance SOL-sell paths.
    cycleGateBasis = 'SKIP';
    console.log(JSON.stringify({ level: 'info', msg: '[BasisGate] Skipping for LP open — deploying existing capital, no realized loss', timestamp: Date.now() }));
    // Gate 3: ChurnGuard
    const lastExitID = db.prepare("SELECT timestamp, decision, price FROM decision_log WHERE decision IN ('T1_DOWNSIDE','OOR_BELOW') ORDER BY rowid DESC LIMIT 1").get() as any;
    if (lastExitID) {
      const exitAgeMinID = (Date.now() - lastExitID.timestamp) / 60000;
      if (exitAgeMinID < 15 && price < lastExitID.price) {
        cycleGateChurn = 'BLOCK';
        console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Blocked: downside exit ${exitAgeMinID.toFixed(1)}min ago, price $${price.toFixed(2)} still below exit $${lastExitID.price.toFixed(2)}. Cooldown: ${(15 - exitAgeMinID).toFixed(1)}min remaining`, timestamp: Date.now() }));
        return;
      }
      if (price < lastExitID.price && exitAgeMinID < 20) {
        cycleGateChurn = 'BLOCK';
        console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Deploy blocked: price $${price.toFixed(2)} below previous exit $${lastExitID.price.toFixed(2)}. Waiting for recovery (expires in ${(20 - exitAgeMinID).toFixed(0)}min).`, timestamp: Date.now() }));
        return;
      }
    }
    // Gate 3b: Upside ChurnGuard
    const upsideChurnMinsID = runtime.upsideChurnCooldownMin ?? 5;
    if (lastUpsideExitTs > 0) {
      const minsSinceUpsideID = (Date.now() - lastUpsideExitTs) / 60000;
      if (minsSinceUpsideID < upsideChurnMinsID) {
        cycleGateChurn = 'BLOCK';
        console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Upside cooldown: ${minsSinceUpsideID.toFixed(1)}min < ${upsideChurnMinsID}min since last upside exit at $${lastUpsideExitPrice.toFixed(2)}`, timestamp: Date.now() }));
        return;
      }
    }
    cycleGateChurn = 'PASS';
    console.log(JSON.stringify({ level: 'info', msg: '[ChurnGuard] Passed', timestamp: Date.now() }));
    await liveOpenPosition(price, 'POSITION_OPENED', `No open position detected. Bot is idle. Opening new position.`);
    await reconcileReserveAfterOpen('ID');
    idleRebalancePending = true;
    return;
  }

  // Regime-Change Refresh: if marked, check whether price is back near entry
  // (switch eligible). Runs before T1/OOR checks so a friendly drift-back can
  // trigger a zero-IL switch instead of waiting for a normal exit.
  if (rcrMarkedForSwitch && runtime.regimeChangeRefreshEnabled) {
    const trig = regimeRefresh.checkSwitchTrigger({
      markedForSwitch: rcrMarkedForSwitch,
      entryPrice: currentPos.entryPrice,
      currentPrice: price,
      now,
      lastSwitchTs: rcrLastSwitchTs,
      config: regimeRefresh.getRefreshConfig(),
    });
    if (trig.ready) {
      const markedAt = rcrMarkTimestamp;
      const entryRegimeAtSwitch = rcrEntryRegime;
      const targetRegime = rcrMarkTargetRegime;
      console.log(JSON.stringify({
        level: 'info',
        msg: `[RCR] Switch eligible (${trig.reason}). entry=${entryRegimeAtSwitch} → target=${targetRegime}. Executing close+reopen at $${price.toFixed(2)} (entry $${currentPos.entryPrice.toFixed(2)}).`,
        timestamp: now,
      }));
      rcrLastSwitchTs = now;
      rcrMarkedForSwitch = false;
      rcrMarkTimestamp = null;
      rcrMarkTargetRegime = null;
      persistRcrState();
      regimeRefresh.logExecutedEvent(db, {
        entryRegime: entryRegimeAtSwitch,
        targetRegime,
        entryPrice: currentPos.entryPrice,
        switchPrice: price,
        markedAt,
        currentRegime: liveRegime,
      });
      await liveCloseAndReopen(price, 'POSITION_CLOSED',
        `Regime-Change Refresh: ${entryRegimeAtSwitch} → ${targetRegime}. Price within ${(runtime.regimeRefreshTolerance * 100).toFixed(2)}% of entry $${currentPos.entryPrice.toFixed(2)} (current $${price.toFixed(2)}).`);
      return;
    }
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
        const posAgeMin = currentPos.entryTime > 0 ? (now - currentPos.entryTime) / 60000 : Infinity;
        const ageGuardEnabled = runtime.t1DownsideAgeGuardEnabled ?? true;
        const minAgeMin = runtime.t1DownsideMinAgeMin ?? 30;
        const isFastExitRegime = liveRegime === 'BEARISH_TREND' || liveRegime === 'EXTREME';
        // Emergency proximity override: bypass age guard when price is dangerously
        // close to the lower bound regardless of position age or regime gate.
        const emergencyOffset = runtime.t1DownsideEmergencyOffset ?? 0.10;
        const emergencyThreshold = Math.min(1.0, params.proxThresholdLower + emergencyOffset);
        const isEmergency = prox.proxToLower >= emergencyThreshold;
        // Three bypass paths: master switch off, fast-exit regime, or emergency proximity.
        const bypassAgeGuard = !ageGuardEnabled || isFastExitRegime || isEmergency;
        if (posAgeMin < minAgeMin && !bypassAgeGuard) {
          console.log(JSON.stringify({ level: 'info', msg: `[Rule2] T1_DOWNSIDE suppressed — age ${posAgeMin.toFixed(1)}min < ${minAgeMin}min minimum (regime ${liveRegime}). proxToLower=${proxPct}% (emergency at ${(emergencyThreshold*100).toFixed(0)}%).`, timestamp: now }));
        } else {
          if (isEmergency && posAgeMin < minAgeMin) {
            console.log(JSON.stringify({ level: 'warn', msg: `[Rule2] T1_DOWNSIDE EMERGENCY EXIT — age ${posAgeMin.toFixed(1)}min < ${minAgeMin}min but proxToLower=${proxPct}% >= ${(emergencyThreshold*100).toFixed(0)}% emergency threshold.`, timestamp: now }));
          }
          const reason = `Rule 2 early downside exit: proxToLower=${proxPct}% >= threshold ${(params.proxThresholdLower*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} drifting toward lower bound $${currentPos.priceLower.toFixed(2)}. Closing to avoid full OOR impermanent loss.`;
          await liveCloseAndReopen(price, 'T1_DOWNSIDE', reason);
          return;
        }
      }
      if (shouldFireUpside(prox, params.proxThresholdUpper)) {
        const proxPct = (prox.proxToUpper * 100).toFixed(0);
        const reason = `Rule 2 early upside exit: proxToUpper=${proxPct}% >= threshold ${(params.proxThresholdUpper*100).toFixed(0)}% (${liveRegime} regime). Price $${price.toFixed(2)} nearing upper bound $${currentPos.priceUpper.toFixed(2)}. Closing → IDLE (immediate re-entry with centre offset after ${runtime.upsideChurnCooldownMin ?? 5}min cooldown).`;
        await liveClosePosition(price, 'T1_UPSIDE', reason);
        lastUpsideExitPrice = price;
        lastUpsideExitTs = now;
        liveBotState = 'IDLE';
        console.log(JSON.stringify({ level: 'info', msg: `[T1_UPSIDE] Closed at $${price.toFixed(2)} → IDLE (immediate)`, timestamp: now }));
        // Save immediately
        upsertBotState(db, { state: liveBotState, regime: liveRegime, position_json: null, updated_at: Date.now(),
          cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
          tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields() });
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
      const reason = `Out of range below: price $${price.toFixed(2)} < lower bound $${currentPos.priceLower.toFixed(2)}. Position is now 100% SOL (all USDC converted). Earning zero fees.`;
      // Flash crash check: if price is in free-fall, close but don't reopen — enter cooldown
      if (isFlashCrash(liveRecentPrices)) {
        await liveClosePosition(price, 'OOR_BELOW', reason + ' Flash crash detected — closing without reopen, entering cooldown.');
        liveFlashCrashCooldownUntil = now + runtime.flashCrashWaitMinutes * 60_000;
        setConfig(db, 'flashCrashCooldownUntil', String(liveFlashCrashCooldownUntil));
        liveBotState = 'IDLE';
        console.log(JSON.stringify({ level: 'warn', msg: `OOR_BELOW + flash crash: closed position, cooldown ${runtime.flashCrashWaitMinutes}min`, timestamp: now }));
        insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
          prox_lower: null, prox_upper: null, in_range: 0,
          decision: 'FLASH_CRASH_COOLDOWN', reasoning: `OOR below with flash crash (>=${runtime.flashCrashPct}% drop in recent candles). Closed position but NOT reopening — waiting ${runtime.flashCrashWaitMinutes}min for stabilization.`,
          params_json: null });
        return;
      }
      await liveCloseAndReopen(price, 'OOR_BELOW', reason + ' Closing and reopening at current price.');
      return;
    }
    if (price > currentPos.priceUpper) {
      const reason = `Out of range above: price $${price.toFixed(2)} > upper bound $${currentPos.priceUpper.toFixed(2)}. Position is now 100% USDC (all SOL sold). Earning zero fees. Closing → IDLE (immediate re-entry with centre offset after ${runtime.upsideChurnCooldownMin ?? 5}min cooldown).`;
      await liveClosePosition(price, 'OOR_ABOVE', reason);
      lastUpsideExitPrice = price;
      lastUpsideExitTs = now;
      liveBotState = 'IDLE';
      console.log(JSON.stringify({ level: 'info', msg: `[OOR_ABOVE] Closed at $${price.toFixed(2)} → IDLE (immediate)`, timestamp: now }));
      // Save immediately
      upsertBotState(db, { state: liveBotState, regime: liveRegime, position_json: null, updated_at: Date.now(),
        cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
        tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields() });
      return;
    }
  }

  // Position max age check — rebalance to reset IL baseline
  if (runtime.positionMaxAgeHours > 0 && currentPos.entryTime > 0) {
    const ageHours = (now - currentPos.entryTime) / 3_600_000;
    if (ageHours >= runtime.positionMaxAgeHours) {
      const reason = `Position age ${ageHours.toFixed(1)}h >= max ${runtime.positionMaxAgeHours}h. Rebalancing to reset IL baseline and collect accumulated fees.`;
      console.log(JSON.stringify({ level: 'info', msg: `Position max age reached: ${ageHours.toFixed(1)}h`, timestamp: now }));
      await liveCloseAndReopen(price, 'POSITION_CLOSED', reason);
      return;
    }
  }

  // Fee harvest (check every 1 hour)
  if (now - liveLastHarvestCheck >= 3_600_000) {
    liveLastHarvestCheck = now;
    if (isHarvestDue(liveLastHarvestTime, params, now)) {
      try {
        // Check if pending fees are worth the gas cost (~$0.10) before harvesting
        const pendingCheck = await liveExecutor.getPendingFees();
        const pendingTotal = pendingCheck?.feeTotalUsdc ?? 0;
        if (pendingTotal < 2.00) {
          // Not enough fees to justify gas — skip this harvest, check again next hour
          console.log(JSON.stringify({ level: 'info', msg: `Harvest skipped: pending fees $${pendingTotal.toFixed(4)} < $2.00 minimum`, timestamp: now }));
          // Don't update liveLastHarvestTime — will re-check next hour
          // NOTE: do NOT return here — auto-deploy and idle rebalance still need to run
        } else {
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

        // ── Reserve routing ────────────────────────────────────────────────
        // Route the USDC portion of harvested fees to the reserve or to compounding.
        const harvestUsdcAmount = fees.feeUsdc;
        if (harvestUsdcAmount > 0) {
          const reserveSnap = getReserveState(db);
          const split = routeHarvest(db, harvestUsdcAmount);
          const newReserve = reserveSnap.current + split.toReserve;
          updateReserve(db, newReserve);
          liveReserveUsdc = newReserve;
          const snapAfterHarvest = getReserveState(db);
          console.log(JSON.stringify({
            level: 'info',
            msg: `[Reserve] Harvest routed: $${split.toReserve.toFixed(4)} to reserve, $${split.toCompound.toFixed(4)} to compound. Reserve: $${snapAfterHarvest.current.toFixed(2)} / floor $${snapAfterHarvest.floor.toFixed(2)} (state: ${snapAfterHarvest.state})`,
            timestamp: now,
          }));
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
        } // end else (fees >= $0.50)
      } catch (err) {
        console.log(JSON.stringify({ level: 'error', msg: 'fee harvest failed', error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: now }));
      }
    }
  }

  // Auto capital deployment — check every 5 minutes for idle wallet funds to deploy
  if (prox.inRange && now - liveLastAutoDeployCheck >= runtime.autoDeployCheckIntervalSec * 1_000 && !defensiveState.active) {
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
        minDeployUsdc: dynamicScaling.getCurrentDyn().minDeployUsdc,
        deployRatioTolerance: params.deployRatioTolerance ?? runtime.deployRatioTolerance,
        reserveFloor: getReserveState(db).floor,
      });

      if (deployCheck.shouldDeploy) {
        console.log(JSON.stringify({ level: 'info', msg: `AUTO_DEPLOY: deploying $${deployCheck.deployableUsdc.toFixed(2)} idle capital`, timestamp: now }));
        const result = await liveExecutor.increaseLiquidity(price, deployCheck.deployableUsdc);
        if (!result) {
          autoDeployNullCount++;
          // First miss + every 10th: surface as warn. In between: info. Beyond 10 in a row, suppress.
          if (autoDeployNullCount === 1) {
            console.log(JSON.stringify({ level: 'info', msg: 'AUTO_DEPLOY: increaseLiquidity returned null, skipping', timestamp: now }));
          } else if (autoDeployNullCount === 10) {
            console.log(JSON.stringify({ level: 'warn', msg: `AUTO_DEPLOY: increaseLiquidity has returned null for ${autoDeployNullCount} consecutive cycles — investigate (further logs suppressed)`, timestamp: now }));
          } else if (autoDeployNullCount < 10) {
            console.log(JSON.stringify({ level: 'info', msg: `AUTO_DEPLOY: increaseLiquidity returned null (${autoDeployNullCount}/10), skipping`, timestamp: now }));
          }
          // > 10: silent until the streak breaks (counter reset on success below)
        } else {
        autoDeployNullCount = 0;
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

        // Persist updated entrySol/entryUsdc immediately (don't wait for next cycle)
        const updatedPos = liveExecutor!.getCurrentPosition();
        if (updatedPos) {
          upsertBotState(db, {
            state: liveBotState, regime: liveRegime,
            position_json: JSON.stringify({ ...updatedPos, positionMint: updatedPos.positionMint.toBase58(), positionAddress: updatedPos.positionAddress.toBase58() }),
            updated_at: Date.now(),
            cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
            tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
          });
        }
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
      console.log(JSON.stringify({ level: 'error', msg: 'auto-deploy check failed', error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: now }));
    }
  }

  // ── SOL Conversion: sell small SOL amounts when profitable and USDC needed for deploys ──
  if (currentPos && liveBotState === 'ACTIVE') {
    try {
      const basis = costBasisState.solCostBasis;

      // Step 1: Get price 30 minutes ago for momentum calculation
      const price30mRow = db.prepare(`
        SELECT price FROM regime_snapshots
        WHERE ts <= ?
        ORDER BY ts DESC LIMIT 1
      `).get(now - 30 * 60 * 1000) as {price: number} | undefined;
      const price30mAgo = price30mRow?.price ?? null;

      // Step 2: Calculate momentum and margin above basis
      const marginAboveBasis = basis > 0
        ? (price - basis) / basis
        : 0;
      const priceChange30m = price30mAgo
        ? (price - price30mAgo) / price30mAgo
        : 0;

      // Step 3: Momentum multiplier tiers (scales conversion cap)
      const getMomentumMultiplier = (margin: number): number => {
        if (margin >= 0.030) return 1.00;
        if (margin >= 0.020) return 0.75;
        if (margin >= 0.010) return 0.50;
        if (margin >= 0.005) return 0.25;
        return 0;
      };
      const momentumMult = getMomentumMultiplier(marginAboveBasis);
      const MOMENTUM_THRESHOLD = runtime.solConvertMomentumThreshold ?? 0.02;
      const momentumOverride =
        (liveRegime === 'BEARISH_TREND' || liveRegime === 'EXTREME') &&
        priceChange30m >= MOMENTUM_THRESHOLD &&
        momentumMult > 0;

      // Dynamic cooldown per regime, scaled by global multiplier
      const regimeCooldownMin: Record<string, number> = { RANGING: 3, BULLISH_TREND: 5, BEARISH_TREND: 10, EXTREME: 20 };
      const baseCooldown = regimeCooldownMin[liveRegime] ?? 10;
      const regimeCooldownMs = baseCooldown * (runtime.solConversionCooldownMin / 15) * 60_000; // solConversionCooldownMin acts as multiplier (15 = 1x)
      // Step 6: Momentum cooldown — shorter cooldown when momentum is strong
      const momentumCooldownMs = (runtime.solConvertMomentumCooldownMin ?? 10) * 60 * 1000;
      const effectiveCooldownMs = momentumOverride ? Math.min(regimeCooldownMs, momentumCooldownMs) : regimeCooldownMs;
      const timeSinceLast = now - solConversionLastTs;

      // Per-regime basis multiplier — now configurable via regime.<regime>.solConvertBasisMultiplier.
      // EXTREME historically had null (disabled); preserved by treating exact 0 as "disabled" sentinel.
      const regimeParams0 = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
      const regimeMultRaw = (regimeParams0 as any).solConvertBasisMultiplier;
      const regimeMult: number | null = (regimeMultRaw == null || regimeMultRaw === 0) ? null : regimeMultRaw;
      const effectiveMult = regimeMult != null ? regimeMult * runtime.solConversionBasisMultiplier : null;
      // Progressive basis decay state — used both as threshold source and as regime-gate bypass.
      const decayState = getProgressiveDecayState(basis, price, now, liveRegime);
      const decayActive = decayState?.active === true;
      // Progressive basis decay: when enabled, loosen threshold below per-regime default
      // after extended idle below basis. When decay is active, always use the decayed
      // threshold — including in EXTREME (where the per-regime mult is null) — so the
      // decay-bypass path never fires without a price check.
      const basisThresholdActive = decayActive
        ? calculateEffectiveBasisThreshold(basis, price, now, liveRegime)
        : (effectiveMult !== null
            ? (runtime.progressiveBasisDecayEnabled
                ? calculateEffectiveBasisThreshold(basis, price, now, liveRegime)
                : basis * effectiveMult)
            : null);

      // Step 4: Regime gate — RANGING/BULLISH allowed; BEARISH/EXTREME allowed only via
      // momentum override OR active progressive decay (past grace period).
      const regimeAllows = liveRegime === 'RANGING' || liveRegime === 'BULLISH_TREND';
      const decayBypass = !regimeAllows && !momentumOverride && decayActive;

      if (!runtime.solConversionEnabled) {
        // silent skip — don't log every cycle
      } else if (!regimeAllows && !momentumOverride && !decayActive) {
        console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: regime ${liveRegime} blocked, no momentum override, no decay bypass (30m change: ${(priceChange30m * 100).toFixed(2)}%, margin: ${(marginAboveBasis * 100).toFixed(2)}%, hrsBelowBasis: ${(decayState?.hrsBelowBasis ?? 0).toFixed(2)}, need: >${(MOMENTUM_THRESHOLD * 100).toFixed(0)}% momentum + >0.5% margin OR decay past ${runtime.progressiveBasisDecayStartHours}h grace)`, timestamp: now }));
      } else if (basisThresholdActive !== null && price < basisThresholdActive) {
        const decayTag = runtime.progressiveBasisDecayEnabled ? ' [progressive-decay]' : '';
        const bypassTag = decayBypass ? ` [decay-bypass ${(decayState?.hrsBelowBasis ?? 0).toFixed(1)}h below basis]` : '';
        console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: price $${price.toFixed(2)} below threshold $${basisThresholdActive.toFixed(2)} (basis $${basis.toFixed(2)} × ${(basisThresholdActive / basis).toFixed(4)})${decayTag}${bypassTag}`, timestamp: now }));
      } else if (timeSinceLast < effectiveCooldownMs) {
        const effectiveCooldownMin = effectiveCooldownMs / 60_000;
        console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: cooldown active (${((effectiveCooldownMs - timeSinceLast) / 60_000).toFixed(1)}min remaining, ${effectiveCooldownMin.toFixed(0)}min effective${momentumOverride ? ' [momentum]' : ''} for ${liveRegime})`, timestamp: now }));
      } else {
        if (momentumOverride) {
          console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Momentum override active in ${liveRegime}: +${(priceChange30m * 100).toFixed(2)}% in 30min, margin +${(marginAboveBasis * 100).toFixed(2)}% above basis, cap multiplier ${(momentumMult * 100).toFixed(0)}%`, timestamp: now }));
        }

        const scBalances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
        const walletSolValue = scBalances.sol * price;
        const totalPortfolio = walletSolValue + scBalances.usdc;
        const reserveFloor = getReserveState(db).floor;
        const deployableUsdc = Math.max(0, scBalances.usdc - reserveFloor);
        const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
        const positionSize = totalPortfolio * params.deployPct * (taDeployMultiplier ?? 1.0);
        const targetUsdcForDeploy = positionSize * (params.usdcDepositPct ?? 0.35);

        const minSolPct = runtime.solConvertMinSolPct ?? 0.20;
        if (walletSolValue <= totalPortfolio * minSolPct) {
          console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: SOL not heavy (${(walletSolValue / totalPortfolio * 100).toFixed(0)}% of portfolio, need >${(minSolPct * 100).toFixed(0)}%)`, timestamp: now }));
        } else if (deployableUsdc >= targetUsdcForDeploy) {
          console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: USDC sufficient ($${deployableUsdc.toFixed(0)} deployable >= $${targetUsdcForDeploy.toFixed(0)} target)`, timestamp: now }));
        } else {
          const needed = targetUsdcForDeploy - deployableUsdc;
          const maxFromSol = walletSolValue * (runtime.solConvertMaxFromSolPct ?? 0.05);
          // Dynamic cap: spread conversion over target deployment time per regime
          const targetDeployMin: number = ({
            RANGING: runtime.solConvertTargetDeployMinRanging ?? 15,
            BULLISH_TREND: runtime.solConvertTargetDeployMinBullish ?? 30,
            BEARISH_TREND: runtime.solConvertTargetDeployMinBearish ?? 90,
            EXTREME: runtime.solConvertTargetDeployMinExtreme ?? 240,
          } as Record<string, number>)[liveRegime] ?? 90;
          const scRegimeCooldown: number = ({ RANGING: 3, BULLISH_TREND: 5, BEARISH_TREND: 10, EXTREME: 20 } as Record<string, number>)[liveRegime] ?? 10;
          const dynamicCapPct = scRegimeCooldown / targetDeployMin;
          const dynamicCap = Math.min(Math.max(walletSolValue * dynamicCapPct, 200), walletSolValue * 0.50);
          console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Dynamic cap: $${dynamicCap.toFixed(2)} (${(dynamicCapPct * 100).toFixed(1)}% of idle SOL $${walletSolValue.toFixed(0)}, target: ${targetDeployMin}min, cooldown: ${scRegimeCooldown}min)`, timestamp: now }));

          // Apply momentum-scaled cap for momentum override path
          let effectiveCap = dynamicCap;
          if (momentumOverride && !regimeAllows) {
            effectiveCap = dynamicCap * momentumMult;
            console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Momentum cap: $${effectiveCap.toFixed(2)} (${(momentumMult * 100).toFixed(0)}% × $${dynamicCap.toFixed(2)} base)`, timestamp: now }));
          }

          // Minimum conversion floor: the walletSolValue * 0.50 ceiling in dynamicCap can
          // clamp cap below the $50 convertUsdc floor when idle SOL is low, blocking SolConvert
          // entirely. Enforce a 0.5-SOL floor, but never exceed available idle SOL value.
          const minCapUsdc = Math.min(0.5 * price, walletSolValue);
          if (effectiveCap < minCapUsdc) {
            console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Cap raised from $${effectiveCap.toFixed(2)} to min $${minCapUsdc.toFixed(2)} (0.5 SOL floor, idle $${walletSolValue.toFixed(0)})`, timestamp: now }));
            effectiveCap = minCapUsdc;
          }

          const convertUsdc = Math.min(needed, maxFromSol, effectiveCap);
          const convertSol = convertUsdc / price;

          // Phase 19: dynamic SolConvert minimum (floor-clamped percent of operating capital)
          const solConvertMin = dynamicScaling.getCurrentDyn().solConvertMinAmountUsdc ?? runtime.solConvertMinAmountUsdcFloor;
          if (convertUsdc < solConvertMin) {
            console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: amount too small ($${convertUsdc.toFixed(2)} < $${solConvertMin.toFixed(2)} min)`, timestamp: now }));
          } else {
            const sellAllowed = !liveExecutor!.shouldAllowSwap || liveExecutor!.shouldAllowSwap('sell_sol', convertSol, price);
            if (!sellAllowed) {
              console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Skipped: shouldAllowSwap blocked (price $${price.toFixed(2)} vs basis $${basis.toFixed(2)})`, timestamp: now }));
            } else {
              // Step 7: Tag swap reason based on path
              const swapReason = momentumOverride && !regimeAllows
                ? `SOL→USDC momentum override (+${(priceChange30m * 100).toFixed(1)}% in 30min)`
                : `SolConvert: ${convertSol.toFixed(3)} SOL → USDC (margin ${((price / basis - 1) * 100).toFixed(1)}% above basis)`;
              console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Converting ${convertSol.toFixed(3)} SOL → $${convertUsdc.toFixed(2)} USDC. Price: $${price.toFixed(2)}, basis: $${basis.toFixed(2)}, margin: ${((price / basis - 1) * 100).toFixed(2)}%, cap: $${effectiveCap.toFixed(0)} (${(dynamicCapPct * 100).toFixed(1)}% of $${walletSolValue.toFixed(0)}, target ${targetDeployMin}min), cooldown: ${(effectiveCooldownMs / 60_000).toFixed(0)}min${momentumOverride ? ' [momentum]' : ''}`, timestamp: now }));
              const swapResult = await liveExecutor!.doSwapPublic(MINTS.SOL, MINTS.USDC, Math.floor(convertSol * 1e9), swapReason);
              if (swapResult) {
                // NOTE: cost-basis reduction is handled by onSwap callback (main.ts:607).
                // Do NOT call reduceCostBasisHoldings here — would double-reduce.
                costBasisState = readCostBasis(db);
                sirCostBasis = costBasisState.solCostBasis;
                solConversionLastTs = now;
                try { db.prepare('UPDATE bot_state SET sol_conversion_last_ts = ? WHERE id = 1').run(now); } catch (e) { console.log(JSON.stringify({ level: 'warn', msg: `sol_conversion_ts update: ${String(e)}`, timestamp: Date.now() })); }
                console.log(JSON.stringify({ level: 'info', msg: `[SolConvert] Converted ${convertSol.toFixed(3)} SOL → $${convertUsdc.toFixed(2)} USDC. Price: $${price.toFixed(2)}, basis: $${basis.toFixed(2)}, margin: ${((price / basis - 1) * 100).toFixed(2)}%, cooldown: ${(effectiveCooldownMs / 60_000).toFixed(0)}min${momentumOverride ? ' [momentum]' : ''}`, timestamp: now }));
                const scTargetSolPct = ({
                  'RANGING': runtime.idleTargetSolPctRanging,
                  'BULLISH_TREND': runtime.idleTargetSolPctBullish,
                  'BEARISH_TREND': runtime.idleTargetSolPctBearish,
                  'EXTREME': runtime.idleTargetSolPctExtreme,
                } as Record<string, number>)[liveRegime] ?? 0.50;
                alertSolConvert({ regime: liveRegime, targetSolPct: scTargetSolPct, solConverted: convertSol, usdcReceived: convertUsdc, price, dynamicCap: effectiveCap });
              } else {
                console.log(JSON.stringify({ level: 'warn', msg: '[SolConvert] Swap failed — skipping cycle', timestamp: now }));
              }
            }
          }
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: '[SolConvert] check failed', error: err instanceof Error ? err.message : String(err), timestamp: now }));
    }
  }

  // Rule 8: Idle wallet rebalance — maintain target SOL/USDC split per regime
  // Triggers on: regime change OR after position reopen OR periodic re-check every 30 min
  // The periodic re-check catches drift from auto-deploy consuming SOL disproportionately
  // ── Smart sell: sell SOL when price reaches upper half of range for better P&L ──
  if (smartSellPending && currentPos) {
    const mid = (currentPos.priceLower + currentPos.priceUpper) / 2;
    const smartSellMaxWait = 30 * 60_000; // 30 min max wait, then fall through to normal rebalance
    const waitExpired = now - smartSellStartTime > smartSellMaxWait;
    const priceAboveMid = price > mid;
    const priceNearTop = price > mid + (currentPos.priceUpper - mid) * 0.5; // upper 25% of range

    if (priceAboveMid || waitExpired) {
      try {
        const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
        const idleSol = Math.max(0, balances.sol - runtime.idleRebalanceSolKeep);
        const idleUsdc = Math.max(0, balances.usdc - dynamicScaling.getCurrentDyn().usdcReserveUsdc);
        const idleTotal = idleSol * price + idleUsdc;
        const targetSolPct = ({
          'RANGING': runtime.idleTargetSolPctRanging,
          'BULLISH_TREND': runtime.idleTargetSolPctBullish,
          'BEARISH_TREND': runtime.idleTargetSolPctBearish,
          'EXTREME': runtime.idleTargetSolPctExtreme,
        } as Record<string, number>)[liveRegime] ?? 0.50;
        const currentSolPct = idleTotal > 0 ? (idleSol * price) / idleTotal : 0;

        if (currentSolPct > targetSolPct + 0.10 && idleSol > 0.01 && idleTotal > 50) {
          const targetSolUsdc = idleTotal * targetSolPct;
          const diffUsdc = idleSol * price - targetSolUsdc;
          const solToSwap = Math.min(diffUsdc / price, idleSol);

          if (solToSwap > 0.01) {
            const pnlPerSol = price - smartSellEntryPrice;
            const reason = waitExpired
              ? `Smart sell (timeout): SOL→USDC after ${((now - smartSellStartTime) / 60000).toFixed(0)}min wait. Price $${price.toFixed(2)}${priceNearTop ? ' (near top ✅)' : ''} vs entry $${smartSellEntryPrice.toFixed(2)}`
              : `Smart sell: SOL→USDC at $${price.toFixed(2)} (above mid $${mid.toFixed(2)}${priceNearTop ? ', near top ✅' : ''}). Entry $${smartSellEntryPrice.toFixed(2)}, est P&L ${pnlPerSol >= 0 ? '+' : ''}$${(pnlPerSol * solToSwap).toFixed(2)}`;

            console.log(JSON.stringify({ level: 'info', msg: reason, solToSwap: solToSwap.toFixed(4), timestamp: now }));
            const swapResult = await liveExecutor.doSwapPublic(
              MINTS.SOL, MINTS.USDC, Math.floor(solToSwap * 1e9), reason,
            );
            if (swapResult) {
              smartSellPending = false;
              lastIdleRebalanceTime = now;
              lastIdleRebalanceRegime = liveRegime;
              idleRebalancePending = false;
              const balAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
              insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
                prox_lower: null, prox_upper: null, in_range: null,
                decision: 'IDLE_REBALANCE', reasoning: `${reason}. Swapped ${swapResult.inputAmount.toFixed(4)} SOL → ${swapResult.outputAmount.toFixed(2)} USDC via ${swapResult.provider}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC.`,
                params_json: JSON.stringify({ smartSell: true, entryPrice: smartSellEntryPrice, sellPrice: price, pnlPerSol }) });
            }
          } else {
            smartSellPending = false; // nothing to sell
          }
        } else {
          smartSellPending = false; // wallet already balanced
        }
      } catch (err) {
        console.log(JSON.stringify({ level: 'error', msg: 'smart sell failed', error: err instanceof Error ? err.message : String(err), timestamp: now }));
        if (waitExpired) smartSellPending = false; // give up after timeout + error
      }
    } else {
      // Still waiting for price to reach upper half — log occasionally
      if (now % 300000 < 120000) { // log every ~5 min
        console.log(JSON.stringify({ level: 'info', msg: `Smart sell waiting: price $${price.toFixed(2)} < mid $${mid.toFixed(2)}. Waited ${((now - smartSellStartTime) / 60000).toFixed(0)}min. Will sell when price above mid or after 30min.`, timestamp: now }));
      }
    }
  }

  const idleRebalanceCooldownMs = 30 * 60_000;
  const periodicRecheck = now - lastIdleRebalanceTime >= idleRebalanceCooldownMs;
  const idleRebalanceDue = lastIdleRebalanceRegime !== liveRegime || (idleRebalancePending && periodicRecheck) || periodicRecheck;
  // Skip idle rebalance if smart sell is pending
  if (runtime.idleRebalanceEnabled && idleRebalanceDue && !smartSellPending) {
    try {
      const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
      const idleSol = Math.max(0, balances.sol - runtime.idleRebalanceSolKeep);
      const idleUsdc = Math.max(0, balances.usdc - dynamicScaling.getCurrentDyn().usdcReserveUsdc);
      const idleTotal = idleSol * price + idleUsdc;

      if (idleTotal >= dynamicScaling.getCurrentDyn().idleRebalanceMinUsdc) {
        // Get target SOL % for current regime
        const targetSolPct =
          liveRegime === 'EXTREME' ? runtime.idleTargetSolPctExtreme :
          liveRegime === 'BEARISH_TREND' ? runtime.idleTargetSolPctBearish :
          liveRegime === 'BULLISH_TREND' ? runtime.idleTargetSolPctBullish :
          runtime.idleTargetSolPctRanging;

        const currentSolPct = idleTotal > 0 ? (idleSol * price) / idleTotal : 0;
        const deviation = currentSolPct - targetSolPct;

        // Only swap if wallet is significantly off-target
        if (Math.abs(deviation) > runtime.idleRebalanceDeviationPct) {
          const targetSolUsdc = idleTotal * targetSolPct;
          const currentSolUsdc = idleSol * price;
          const diffUsdc = Math.abs(currentSolUsdc - targetSolUsdc);

          let swapResult = null;
          let swapDirection = '';

          if (deviation > 0) {
            // Smart rebalance: sell only when price is near or above cost basis (capped per cycle)
            const basis = sirCostBasis || price;
            const lossPerSol = Math.max(0, basis - price);
            const sellCapUsdc = Math.min(
              Math.max(diffUsdc / runtime.idleRebalanceSpreadCycles, 100),
              runtime.idleRebalanceMaxUsdc,
            );
            const idealSolToSwap = Math.min(diffUsdc / price, idleSol, sellCapUsdc / price);

            const idleSellThreshold = runtime.progressiveBasisDecayEnabled
              ? calculateEffectiveBasisThreshold(basis, price, now, liveRegime)
              : basis;
            if (price < idleSellThreshold) {
              // P&L guard: BLOCKED — price below (possibly decayed) basis threshold
              const decayTag = runtime.progressiveBasisDecayEnabled ? ' [progressive-decay]' : '';
              console.log(JSON.stringify({ level: 'info', msg: `Idle rebalance: SOL sell BLOCKED — price $${price.toFixed(2)} below threshold $${idleSellThreshold.toFixed(2)} (basis $${basis.toFixed(2)}).${decayTag} Waiting.`, timestamp: now }));
              lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
            } else {
              // Price >= threshold — sell capped amount (profitable or within loss tolerance)
              if (idealSolToSwap >= 0.1) {
                swapDirection = `SOL→USDC (${(currentSolPct * 100).toFixed(0)}% → ${(targetSolPct * 100).toFixed(0)}%)`;
                console.log(JSON.stringify({ level: 'info', msg: `Idle rebalance: selling ${idealSolToSwap.toFixed(2)} SOL (cap $${sellCapUsdc.toFixed(0)}, gap $${diffUsdc.toFixed(0)}) — price $${price.toFixed(2)} >= basis $${basis.toFixed(2)} (profitable).`, timestamp: now }));
                swapResult = await liveExecutor.doSwapPublic(
                  MINTS.SOL, MINTS.USDC, Math.floor(idealSolToSwap * 1e9),
                  `Idle rebalance (${liveRegime}): ${swapDirection} — above basis`,
                );
              } else {
                lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
              }
            }
          } else {
            // Too much USDC → swap USDC to SOL (capped per cycle)
            const idleRebalanceCap = Math.min(
              Math.max(diffUsdc / runtime.idleRebalanceSpreadCycles, 100),
              runtime.idleRebalanceMaxUsdc,
            );
            const usdcToSwap = Math.min(diffUsdc, idleUsdc, idleRebalanceCap);
            // Phase 19: dynamic imbalance threshold (scales with capital)
            const idleImbalanceMin = dynamicScaling.getCurrentDyn().idleRebalanceMinImbalanceUsdc ?? runtime.idleRebalanceMinImbalanceUsdcFloor;
            if (usdcToSwap > 1 && diffUsdc > idleImbalanceMin) {
              // Defensive Downtrend Mode (Phase C) blocks USDC→SOL buys.
              if (defensiveState.active) {
                console.log(JSON.stringify({ level: 'info', msg: `[DEFENSIVE] BLOCK: idle-rebal USDC→SOL blocked (trigger=${defensiveState.enteredTrigger}, deviation=${(Math.abs(deviation) * 100).toFixed(0)}%)`, timestamp: now }));
                lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
              } else {
              // P&L awareness: only buy SOL when price is at or near basis (≤ basis × 1.01).
              // Never buy significantly above basis — even large deviations — because it
              // inflates cost basis and makes future BasisGate blocks more likely.
              const basis = sirCostBasis || price;
              const basisCap = basis * 1.01;
              const buyingCheap = price <= basisCap;
              if (!buyingCheap) {
                console.log(JSON.stringify({ level: 'info', msg: `Idle rebalance SKIPPED: buying SOL at $${price.toFixed(2)} > basis cap $${basisCap.toFixed(2)} (basis $${basis.toFixed(2)} × 1.01). Deviation ${(Math.abs(deviation) * 100).toFixed(0)}%. Waiting for dip — basis protection.`, timestamp: now }));
              } else {
                swapDirection = `USDC→SOL (${(currentSolPct * 100).toFixed(0)}% SOL → target ${(targetSolPct * 100).toFixed(0)}%)`;
                console.log(JSON.stringify({ level: 'info', msg: `Idle rebalance: ${swapDirection}, swapping $${usdcToSwap.toFixed(2)} USDC (cap $${idleRebalanceCap.toFixed(0)}, gap $${diffUsdc.toFixed(0)}) ✅ buying at/near basis (price $${price.toFixed(2)} ≤ $${basisCap.toFixed(2)})`, timestamp: now }));
                swapResult = await liveExecutor.doSwapPublic(
                  MINTS.USDC, MINTS.SOL, Math.floor(usdcToSwap * 1e6),
                  `Idle wallet rebalance (${liveRegime}): ${swapDirection}`,
                );
              }
              } // end else (defensive not active)
            }
          }

          if (swapResult) {
            lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
            await new Promise(r => setTimeout(r, 4000));
            const balAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
            const newSolPct = (Math.max(0, balAfter.sol - runtime.idleRebalanceSolKeep) * price) / idleTotal;
            insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
              prox_lower: null, prox_upper: null, in_range: null,
              decision: 'IDLE_REBALANCE', reasoning: `Idle wallet rebalance (${liveRegime}): ${swapDirection}. Swapped ${swapResult.inputAmount.toFixed(4)} ${deviation > 0 ? 'SOL' : 'USDC'} → ${swapResult.outputAmount.toFixed(4)} ${deviation > 0 ? 'USDC' : 'SOL'} via ${swapResult.provider}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC (SOL ${(newSolPct * 100).toFixed(0)}%, target ${(targetSolPct * 100).toFixed(0)}%).`,
              params_json: JSON.stringify({ targetSolPct, currentSolPct: currentSolPct, deviation, provider: swapResult.provider }) });
            insertRebalanceEventWithRule2(db, {
              timestamp: now, eventType: 'PRICE_UPDATE', price, regime: liveRegime,
              note: `IDLE REBALANCE (${liveRegime}): ${swapDirection}. ${swapResult.inputAmount.toFixed(4)} ${deviation > 0 ? 'SOL' : 'USDC'} → ${swapResult.outputAmount.toFixed(4)} ${deviation > 0 ? 'USDC' : 'SOL'} via ${swapResult.provider}.`,
              solBefore: balances.sol, usdcBefore: balances.usdc,
              solAfter: balAfter.sol, usdcAfter: balAfter.usdc,
              feeSol: 0, feeUsdc: 0, ilAtClose: 0,
            });
            const newUsdcPct = 1 - newSolPct;
            alertIdleRebalance({
              direction: swapDirection, inputAmount: swapResult.inputAmount, outputAmount: swapResult.outputAmount,
              inputToken: deviation > 0 ? 'SOL' : 'USDC', outputToken: deviation > 0 ? 'USDC' : 'SOL',
              newSolPct, newUsdcPct, targetSolPct, regime: liveRegime, price,
            });
          } else if (swapDirection) {
            // Mark as done to prevent retrying every 60s during persistent API outage
            lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
            console.log(JSON.stringify({ level: 'warn', msg: 'Idle rebalance swap failed — will retry on next regime change', timestamp: now }));
          } else {
            // Deviation exists but swap amount too small — mark as done
            lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
          }
        } else {
          // Wallet already near target — mark as done for this regime
          lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
          console.log(JSON.stringify({ level: 'info', msg: `Idle wallet already near target: SOL ${(currentSolPct * 100).toFixed(0)}% vs target ${(targetSolPct * 100).toFixed(0)}% (deviation ${(Math.abs(deviation) * 100).toFixed(0)}% < ${(runtime.idleRebalanceDeviationPct * 100).toFixed(0)}% threshold)`, timestamp: now }));
        }
      } else {
        // Not enough idle capital to bother — mark as done
        lastIdleRebalanceRegime = liveRegime; lastIdleRebalanceTime = now; idleRebalancePending = false;
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'idle rebalance failed', error: err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err)), timestamp: now }));
    }
  }

  // ── SIR: Smart Idle Rebalancing (price-driven) ──
  if (runtime.sirEnabled && now - lastSirSwapTime >= runtime.sirCooldownMinutes * 60_000) {
    try {
      const mktSig = marketData.getSignals();
      const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
      const idleSol = Math.max(0, balances.sol - runtime.idleRebalanceSolKeep);
      const idleTotal = idleSol * price + balances.usdc;
      const currentSolPct = idleTotal > 0 ? (idleSol * price) / idleTotal : 0;

      const sirConfig: SirConfig = {
        enabled: true, cooldownMinutes: runtime.sirCooldownMinutes,
        triggerThreshold: runtime.sirTriggerThreshold, minSwapUsdc: runtime.sirMinSwapUsdc,
        trendMultiplier: runtime.sirTrendMultiplier, maxSolPct: runtime.sirMaxSolPct,
        minSolPct: runtime.sirMinSolPct,
      };
      const sirTarget = calculateIdleTarget(price, params.rangeWidthPct, params.skewDown, mktSig?.solDelta24h ?? 0, sirConfig);
      const sirResult = shouldRebalanceIdle(currentSolPct, sirTarget, idleTotal, sirConfig);

      if (sirResult.swap) {
        console.log(JSON.stringify({ level: 'info', msg: `SIR rebalance: ${sirResult.direction} $${sirResult.amountUsdc.toFixed(0)} (SOL ${(currentSolPct * 100).toFixed(0)}% → target ${(sirTarget * 100).toFixed(0)}%)`, timestamp: now }));
        const solAmount = sirResult.direction === 'sell_sol' ? sirResult.amountUsdc / price : sirResult.amountUsdc / price;
        const idleSolHolding = Math.max(0, balances.sol - runtime.idleRebalanceSolKeep);
        const basisBefore = sirCostBasis || price; // default to current price if no prior basis
        const pnlCalc = calculateSwapPnl(sirResult.direction, solAmount, price, basisBefore, idleSolHolding);

        if (sirResult.direction === 'sell_sol') {
          await liveExecutor.doSwapPublic(MINTS.SOL, MINTS.USDC, Math.floor(solAmount * 1e9), `SIR: sell SOL to target ${(sirTarget * 100).toFixed(0)}%`);
        } else {
          await liveExecutor.doSwapPublic(MINTS.USDC, MINTS.SOL, Math.floor(sirResult.amountUsdc * 1e6), `SIR: buy SOL to target ${(sirTarget * 100).toFixed(0)}%`);
        }
        // COST_BASIS: tracked — SIR USDC→SOL buy updates weighted average cost basis
        // Atomic: cost-basis update (buy path) + ledger insert must commit together.
        db.transaction(() => {
          if (sirResult.direction === 'buy_sol') {
            costBasisState = updateCostBasis(db, solAmount, price, `SIR buy SOL to target ${(sirTarget * 100).toFixed(0)}%`);
            sirCostBasis = costBasisState.solCostBasis;
          } else {
            sirCostBasis = pnlCalc.newBasis;
          }
          // Track in swap ledger
          insertSwapLedger(db, {
            timestamp: now, direction: sirResult.direction, sol_amount: solAmount,
            usdc_amount: sirResult.amountUsdc, price, reason: `SIR: ${sirResult.direction} to target ${(sirTarget * 100).toFixed(0)}%`,
            pnl_usdc: pnlCalc.pnlUsdc, cost_basis_before: basisBefore, cost_basis_after: sirCostBasis,
          });
        })();
        lastSirSwapTime = now;
        if (pnlCalc.pnlUsdc != null) {
          console.log(JSON.stringify({ level: 'info', msg: `SIR swap P&L: ${pnlCalc.pnlUsdc >= 0 ? '+' : ''}$${pnlCalc.pnlUsdc.toFixed(2)} (sold at $${price.toFixed(2)}, basis $${basisBefore.toFixed(2)})`, timestamp: now }));
        }
        insertDecisionLog(db, { timestamp: now, price, regime: liveRegime, bot_state: liveBotState,
          prox_lower: null, prox_upper: null, in_range: null,
          decision: 'SIR_REBALANCE', reasoning: `SIR idle rebalance: ${sirResult.direction} $${sirResult.amountUsdc.toFixed(2)}. SOL ${(currentSolPct * 100).toFixed(0)}% → target ${(sirTarget * 100).toFixed(0)}%. Trend bias: SOL 4h ${mktSig?.solDelta24h ?? 0}%.`,
          params_json: JSON.stringify({ currentSolPct, sirTarget, amountUsdc: sirResult.amountUsdc, direction: sirResult.direction }) });
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'SIR rebalance failed', error: err instanceof Error ? err.message : String(err), timestamp: now }));
    }
  }

  liveBotState = 'ACTIVE';
}

async function liveOpenPosition(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  if (defensiveState.active) {
    console.log(JSON.stringify({ level: 'info', msg: `[DEFENSIVE] BLOCK: openPosition blocked (trigger=${defensiveState.enteredTrigger}, eventType=${eventType})`, timestamp: Date.now() }));
    return;
  }
  if (!liveExecutor) return;
  // Exponential backoff on repeated TX failures
  if (Date.now() < txBackoffUntil) {
    console.log(JSON.stringify({ level: 'info', msg: `TX backoff: skipping open, ${((txBackoffUntil - Date.now()) / 1000).toFixed(0)}s remaining (${consecutiveTxFailures} consecutive failures)`, timestamp: Date.now() }));
    return;
  }
  const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);

  // Post-upside centre offset: shift range centre down after recent upside exit
  let centrePrice = price;
  let postUpsideNote = '';
  const minsSinceUpside = lastUpsideExitTs > 0 ? (Date.now() - lastUpsideExitTs) / 60000 : 999;
  const isPostUpside = minsSinceUpside < 30 && lastUpsideExitPrice > 0;
  if (runtime.dynamicAdjustmentsEnabled && isPostUpside) {
    const postUpsideOffsets: Record<string, number> = {
      'RANGING':       runtime.postUpsideOffsetRanging  ?? -0.005,
      'BULLISH_TREND': runtime.postUpsideOffsetBullish  ??  0.000,
      'BEARISH_TREND': runtime.postUpsideOffsetBearish  ?? -0.010,
      'EXTREME':       runtime.postUpsideOffsetExtreme  ?? -0.005,
    };
    const offset = postUpsideOffsets[liveRegime] ?? -0.005;
    if (offset !== 0) {
      centrePrice = price * (1 + offset);
      postUpsideNote = ` [PostUpside] Centre offset ${(offset * 100).toFixed(1)}%: $${price.toFixed(2)} → $${centrePrice.toFixed(2)} (upside exit ${minsSinceUpside.toFixed(1)}min ago @ $${lastUpsideExitPrice.toFixed(2)}).`;
      console.log(JSON.stringify({ level: 'info', msg: `[PostUpside] Centre offset ${(offset * 100).toFixed(1)}%: $${price.toFixed(2)} → $${centrePrice.toFixed(2)} (last upside exit ${minsSinceUpside.toFixed(1)}min ago @ $${lastUpsideExitPrice.toFixed(2)})`, timestamp: Date.now() }));
    }
  }

  // Defensive centre offset in BULLISH when RSI is oversold — prevents opening
  // a range centred too high when the market is actually weak.
  if (runtime.dynamicAdjustmentsEnabled && liveRegime === 'BULLISH_TREND' && lastRsi != null && lastRsi < 45) {
    const rsiOffset = -0.003; // -0.3%
    const before = centrePrice;
    centrePrice = centrePrice * (1 + rsiOffset);
    console.log(JSON.stringify({ level: 'info', msg: `[OpenPosition] BULLISH RSI-weak offset ${(rsiOffset * 100).toFixed(1)}%: centre $${before.toFixed(2)} → $${centrePrice.toFixed(2)} (rsi=${lastRsi.toFixed(1)})`, timestamp: Date.now() }));
  }

  // Post-upside: override deployPct to 100% for max USDC-constrained deployment,
  // but ONLY in RANGING/BULLISH. BEARISH/EXTREME keep regime default to preserve reserves.
  const postUpsideDeployBoost = runtime.dynamicAdjustmentsEnabled && isPostUpside && liveRegime !== 'BEARISH_TREND' && liveRegime !== 'EXTREME';
  const effectiveDeployPct = postUpsideDeployBoost ? 1.0 : params.deployPct;
  if (postUpsideDeployBoost && params.deployPct < 1.0) {
    console.log(JSON.stringify({ level: 'info', msg: `[PostUpside] deployPct ${(params.deployPct * 100).toFixed(0)}% → 100% (RANGING/BULLISH only)`, timestamp: Date.now() }));
  } else if (isPostUpside && !postUpsideDeployBoost) {
    console.log(JSON.stringify({ level: 'info', msg: `[PostUpside] deployPct kept at regime default ${(params.deployPct * 100).toFixed(0)}% — BEARISH/EXTREME`, timestamp: Date.now() }));
  }

  const range = calcRange(centrePrice, params, (p) => pool.priceToTick(p), (p) => pool.priceToTickLower(p), (p) => pool.priceToTickUpper(p));

  const balances = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const totalWalletUsdc = balances.sol * price + balances.usdc;
  // Phase 19: dynamic reserves
  const dynAtOpen = dynamicScaling.getCurrentDyn();
  const reserveUsdc = dynAtOpen.solReserveSol * price + dynAtOpen.usdcReserveUsdc;
  const deployUsdc = Math.min(totalWalletUsdc * effectiveDeployPct, totalWalletUsdc - reserveUsdc);
  // Phase 19: dynamic minimum deploy threshold (scales with capital)
  const deployMinThresh = dynAtOpen.deployMinThresholdUsdc ?? runtime.deployMinThresholdUsdcFloor;
  if (deployUsdc < deployMinThresh) {
    console.log(JSON.stringify({ level: 'warn', msg: `insufficient funds to open position: deployUsdc $${deployUsdc.toFixed(2)} < min $${deployMinThresh.toFixed(2)}`, sol: balances.sol, usdc: balances.usdc, timestamp: Date.now() }));
    return;
  }

  // Build reasoning
  const why = triggerReason ?? `No open position detected.`;
  const logic = `${why}${postUpsideNote} Regime: ${liveRegime} → rangeWidth=${params.rangeWidthPct}%, skew=${(params.skewDown*100).toFixed(0)}% down/${(params.skewUp*100).toFixed(0)}% up, deploy=${(effectiveDeployPct*100).toFixed(0)}% of capital. Range calculated: $${range.priceLower.toFixed(2)}-$${range.priceUpper.toFixed(2)} around ${centrePrice !== price ? 'offset centre' : 'current'} price $${centrePrice.toFixed(2)}.`;

  try {
    liveExecutor.isPostUpsideOpen = isPostUpside;
    const pos = await liveExecutor.openPosition(range, price, liveRegime, deployUsdc);
    liveExecutor.isPostUpsideOpen = false;
    if (!pos) return;
    consecutiveTxFailures = 0; // reset backoff on success
    txBackoffUntil = 0;
    liveRebalancesThisHour++;
    dailyRebalanceCount++;
    liveBotState = 'ACTIVE';
    positionChangedThisCycle = true;  // guard reconciler from attributing LP deposit to manual swap

    // Regime-Change Refresh: fresh position — reset mark state, record entry regime
    rcrEntryRegime = liveRegime;
    rcrMarkedForSwitch = false;
    rcrMarkTimestamp = null;
    rcrMarkTargetRegime = null;
    persistRcrState();

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

    // Smart sell DISABLED — selling SOL always loses money in downtrends.
    // The 65% downside exit threshold prevents SOL-heavy wallets at the root.
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    consecutiveTxFailures++;
    const backoffSec = Math.min(300, 60 * Math.pow(2, consecutiveTxFailures - 1)); // 60s, 120s, 240s, 300s cap
    txBackoffUntil = Date.now() + backoffSec * 1000;
    console.log(JSON.stringify({ level: 'error', msg: 'LIVE open position failed', error: errMsg, failures: consecutiveTxFailures, backoffSec, timestamp: Date.now() }));
  }
}

async function liveClosePosition(price: number, eventType: EventType, triggerReason?: string): Promise<boolean> {
  if (!liveExecutor) return false;
  // Regime-Change Refresh: if a close fires while marked (for any non-RCR reason,
  // since RCR clears the mark before calling close), log SUPPRESSED and clear state.
  if (rcrMarkedForSwitch) {
    const prevTarget = rcrMarkTargetRegime;
    regimeRefresh.logSuppressedEvent(db, {
      reason: `normal close: ${eventType}`,
      regime: liveRegime,
      entryRegime: rcrEntryRegime,
      markTarget: prevTarget,
      price,
    });
    rcrMarkedForSwitch = false;
    rcrMarkTimestamp = null;
    rcrMarkTargetRegime = null;
    persistRcrState();
    console.log(JSON.stringify({
      level: 'info',
      msg: `[RCR] Mark suppressed by normal close: eventType=${eventType}, target was ${prevTarget}`,
      timestamp: Date.now(),
    }));
  }
  try {
    // Pre-close harvest: collect fees before closing to ensure they route through reserve
    try {
      const pendingFees = await liveExecutor.getPendingFees();
      const pendingFeesUsdc = pendingFees ? pendingFees.feeTotalUsdc : 0;
      if (pendingFeesUsdc >= 1.00) {
        console.log(JSON.stringify({ level: 'info', msg: `[PreCloseHarvest] Collecting $${pendingFeesUsdc.toFixed(2)} pending fees before close`, timestamp: Date.now() }));
        const fees = await liveExecutor.collectFees();
        if (fees && (fees.feeSol > 0.001 || fees.feeUsdc > 0.01)) {
          liveCumFeesSol += fees.feeSol;
          liveCumFeesUsdc += fees.feeUsdc;
          liveLastHarvestTime = Date.now();
          // Record pre-close harvest in rebalance_events so getFeesCollected() sees it
          insertRebalanceEventWithRule2(db, {
            timestamp: Date.now(), eventType: 'FEE_HARVEST', price, regime: liveRegime,
            note: `Pre-close harvest: ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(4)} USDC ($${pendingFeesUsdc.toFixed(2)}). Cumulative: ${liveCumFeesSol.toFixed(6)} SOL + ${liveCumFeesUsdc.toFixed(6)} USDC.`,
            solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
            feeSol: fees.feeSol, feeUsdc: fees.feeUsdc, ilAtClose: 0,
          });
          // Convert SOL fee income to USDC per regime policy.
          // NOTE: This converts LP fee income (zero cost basis).
          // shouldAllowSwap is intentionally NOT called here —
          // fee SOL sells are always profitable regardless of price vs basis.
          const params = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
          if (params.harvestSolConvertPct > 0 && fees.feeSol > 0.0001) {
            if (price < 50) {
              console.log(JSON.stringify({ level: 'warn', msg: `[PreCloseHarvest] Price $${price.toFixed(2)} below $50 sanity check — skipping SOL conversion`, timestamp: Date.now() }));
            } else {
              await liveExecutor.convertHarvestedSol(fees.feeSol, params.harvestSolConvertPct);
            }
          }
          // Route USDC to reserve
          if (fees.feeUsdc > 0) {
            const reserveSnap = getReserveState(db);
            const split = routeHarvest(db, fees.feeUsdc);
            const newReserve = reserveSnap.current + split.toReserve;
            updateReserve(db, newReserve);
            console.log(JSON.stringify({ level: 'info', msg: `[Reserve] Pre-close harvest routed: $${split.toReserve.toFixed(4)} to reserve, $${split.toCompound.toFixed(4)} to compound`, timestamp: Date.now() }));
          }
          console.log(JSON.stringify({ level: 'info', msg: `[PreCloseHarvest] Collected ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(4)} USDC ($${pendingFeesUsdc.toFixed(2)})`, timestamp: Date.now() }));
        } else {
          console.log(JSON.stringify({ level: 'info', msg: `[PreCloseHarvest] Fees too small to harvest ($${pendingFeesUsdc.toFixed(2)}) — skipping conversion`, timestamp: Date.now() }));
        }
      } else {
        console.log(JSON.stringify({ level: 'info', msg: `[PreCloseHarvest] Skipped — pending fees $${pendingFeesUsdc.toFixed(2)} below $1.00 threshold`, timestamp: Date.now() }));
      }
    } catch (e) {
      // CRITICAL: harvest failure must never block the close
      console.log(JSON.stringify({ level: 'warn', msg: `[PreCloseHarvest] Failed — proceeding with close anyway. Error: ${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() }));
    }

    // Capture position ID before close (closePosition clears it)
    const closingPositionId = liveExecutor.getCurrentPosition()?.positionMint?.toBase58() ?? undefined;
    const balancesBefore = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
    const result = await liveExecutor.closePosition();

    positionChangedThisCycle = true;
    lastPositionCloseTs = Date.now();
    // Clear pending reopen on close — fresh start
    reopenPendingTs = null;
    reopenPendingRegime = null;
    reopenPendingUrgency = null;
    reopenPendingOldRegime = null;
    // IMMEDIATELY clear position in DB after successful on-chain close
    // This prevents ghost positions if any subsequent logging/state update fails
    upsertBotState(db, {
      state: 'IDLE', regime: liveRegime, position_json: null,
      updated_at: Date.now(),
      cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
      tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0,
      ...upsideExitFields(), ...costBasisFields(),
    });

    const balancesAfter = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);

    // Track fees and IL from the enriched close result
    consecutiveTxFailures = 0; // reset backoff on success
    txBackoffUntil = 0;
    liveCumFeesSol += result.feeSolCollected;
    liveCumFeesUsdc += result.feeUsdcCollected;
    liveRealizedIl += result.ilAtClose;
    liveRebalancesThisHour++;
    dailyRebalanceCount++;

    // COST_BASIS: SOL returned from LP close was ALREADY tracked when it entered the LP
    // (via pre-open USDC→SOL buy and add-liquidity ratio swaps). Re-adding here would
    // double-count. Fees are tracked separately (liveCumFeesSol / cum_fees_sol).
    const solReturnedFromClose = balancesAfter.sol - balancesBefore.sol;
    costBasisState = readCostBasis(db);
    sirCostBasis = costBasisState.solCostBasis;
    console.log(JSON.stringify({
      level: 'info',
      msg: `[CostBasis] LP close — no basis update (returned ${solReturnedFromClose.toFixed(4)} SOL was already tracked)`,
      timestamp: Date.now(),
    }));

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
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    consecutiveTxFailures++;
    const backoffSec = Math.min(300, 60 * Math.pow(2, consecutiveTxFailures - 1));
    txBackoffUntil = Date.now() + backoffSec * 1000;
    console.log(JSON.stringify({ level: 'error', msg: 'LIVE close position failed', error: errMsg, failures: consecutiveTxFailures, backoffSec, timestamp: Date.now() }));
    return false;
  }
}

async function liveCloseAndReopen(price: number, eventType: EventType, triggerReason?: string): Promise<void> {
  const closed = await liveClosePosition(price, eventType, triggerReason);
  if (!closed) {
    console.log(JSON.stringify({ level: 'warn', msg: 'closeAndReopen: close failed, aborting reopen — position still open', timestamp: Date.now() }));
    return;
  }
  await new Promise(r => setTimeout(r, 2000));

  // Re-check regime before reopening — conditions may have changed during the close.
  // Reset hysteresis after close/reopen: prevents immediate re-commit from triggering
  // another regime reopen (churn cascade). Pass null/0 so the fresh call starts clean,
  // and do NOT write candidate state back — let next main cycle pick it up fresh.
  taRegimeCandidate = null;
  taRegimeCandidateCount = 0;
  const freshMkt = marketData.getSignals();
  const freshTa = freshMkt?.ta ?? null;
  const freshCloses = getDailyCloses(db, runtime.regimeWindowDays);
  const freshDailyRegime = freshCloses.length >= 3 ? detectRegime(freshCloses, runtime.trendThreshold) : null;
  const freshTaResult = freshTa
    ? detectRegimeTA(freshTa, freshMkt, freshDailyRegime, null, 0, price)
    : null;
  const freshRegimeValue: Regime = freshTaResult?.regime ?? liveRegime;
  if (freshTaResult) {
    // Deploy multiplier is safe to carry forward (reflects current score, not hysteresis).
    // Master switch: force 1.0 when dynamic adjustments disabled.
    taDeployMultiplier = runtime.dynamicAdjustmentsEnabled ? freshTaResult.deployMultiplier : 1.0;
  }
  console.log(JSON.stringify({
    level: 'info',
    msg: `[CloseAndReopen] Regime re-check: ${liveRegime} → ${freshRegimeValue} (TA winner: ${freshTaResult?.candidateRegime ?? 'n/a'}, confidence: ${freshTaResult?.confidence ?? 'n/a'}, veto_fired: ${freshTaResult?.vetoFired ?? false})`,
    detail: freshTaResult?.log ?? 'TA unavailable, keeping current regime',
    timestamp: Date.now(),
  }));
  if (freshRegimeValue !== liveRegime) {
    const oldRegime = liveRegime;
    liveRegime = freshRegimeValue;
    const dailyMetricsCR = freshCloses.length >= 3 ? detectRegimeWithMetrics(freshCloses, runtime.trendThreshold) : null;
    insertRegimeChange(db, {
      timestamp: Date.now(), old_regime: oldRegime, new_regime: freshRegimeValue, price,
      dir_ratio: dailyMetricsCR?.dirRatio ?? 0,
      realised_vol: dailyMetricsCR?.realisedVol ?? 0,
      price_count: dailyMetricsCR?.priceCount ?? 0,
    });
    liveLastRegimeCheck = Date.now(); // reset timer since we just checked
  }

  // Gate 1: ReserveGate
  const regimeParamsCR = runtime.regimeParams[liveRegime] ?? getRegimeParams(liveRegime);
  const balancesCR = await getWalletBalances(conn, (liveExecutor as any).wallet.publicKey);
  const positionSizeCR = (balancesCR.sol * price + balancesCR.usdc) * regimeParamsCR.deployPct * (taDeployMultiplier ?? 1.0);
  const usdcNeededCR = positionSizeCR * (regimeParamsCR.usdcDepositPct ?? 0.35);
  const gateCR = checkDeployGate(db, usdcNeededCR, balancesCR.usdc, balancesCR.sol * price + balancesCR.usdc);
  if (!gateCR.allowed) {
    console.log(JSON.stringify({ level: 'warn', msg: `[ReserveGate] Deploy blocked: ${gateCR.reason}. Shortfall: $${gateCR.shortfall.toFixed(2)}`, timestamp: Date.now() }));
    return;
  }
  console.log(JSON.stringify({ level: 'info', msg: `[ReserveGate] Passed: ${gateCR.reason}`, timestamp: Date.now() }));
  // Gate 2: BasisGate — skipped on LP open (no realized loss).
  // Sell-at-loss protection remains in SolConvert and idle-rebalance SOL-sell paths.
  console.log(JSON.stringify({ level: 'info', msg: '[BasisGate] Skipping for LP open — deploying existing capital, no realized loss', timestamp: Date.now() }));
  // Gate 3: ChurnGuard
  const lastExitCR = db.prepare("SELECT timestamp, decision, price FROM decision_log WHERE decision IN ('T1_DOWNSIDE','OOR_BELOW') ORDER BY rowid DESC LIMIT 1").get() as any;
  if (lastExitCR) {
    const exitAgeMinCR = (Date.now() - lastExitCR.timestamp) / 60000;
    if (exitAgeMinCR < 15 && price < lastExitCR.price) {
      console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Blocked: downside exit ${exitAgeMinCR.toFixed(1)}min ago, price $${price.toFixed(2)} still below exit $${lastExitCR.price.toFixed(2)}. Cooldown: ${(15 - exitAgeMinCR).toFixed(1)}min remaining`, timestamp: Date.now() }));
      return;
    }
    if (price < lastExitCR.price && exitAgeMinCR < 20) {
      console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Deploy blocked: price $${price.toFixed(2)} below previous exit $${lastExitCR.price.toFixed(2)}. Waiting for recovery (expires in ${(20 - exitAgeMinCR).toFixed(0)}min).`, timestamp: Date.now() }));
      return;
    }
  }
  // Gate 3b: Upside ChurnGuard
  const upsideChurnMinsCR = runtime.upsideChurnCooldownMin ?? 5;
  if (lastUpsideExitTs > 0) {
    const minsSinceUpsideCR = (Date.now() - lastUpsideExitTs) / 60000;
    if (minsSinceUpsideCR < upsideChurnMinsCR) {
      console.log(JSON.stringify({ level: 'warn', msg: `[ChurnGuard] Upside cooldown: ${minsSinceUpsideCR.toFixed(1)}min < ${upsideChurnMinsCR}min since last upside exit at $${lastUpsideExitPrice.toFixed(2)}`, timestamp: Date.now() }));
      return;
    }
  }
  console.log(JSON.stringify({ level: 'info', msg: '[ChurnGuard] Passed', timestamp: Date.now() }));
  await liveOpenPosition(price, 'POSITION_OPENED', `Re-opening after ${eventType}. Previous position closed due to: ${triggerReason ?? eventType}.`);
  await reconcileReserveAfterOpen('CR');
  idleRebalancePending = true; // trigger idle rebalance check on next cycle (with cooldown)

  // Save position to DB immediately — prevents orphan recovery from killing
  // a legitimate position if bot crashes before the next cycle save
  const newPos = liveExecutor?.getCurrentPosition();
  if (newPos) {
    upsertBotState(db, {
      state: liveBotState, regime: liveRegime,
      position_json: JSON.stringify({ ...newPos, positionMint: newPos.positionMint.toBase58(), positionAddress: newPos.positionAddress.toBase58() }),
      updated_at: Date.now(),
      cum_fees_sol: liveCumFeesSol, cum_fees_usdc: liveCumFeesUsdc, realized_il: liveRealizedIl,
      tx_count: liveExecutor?.txCount ?? 0, cum_gas_lamports: liveExecutor?.cumGasLamports ?? 0, ...upsideExitFields(), ...costBasisFields(),
    });
  }

  // Clear any pending regime reopen — position is now fresh
  reopenPendingTs = null;
  reopenPendingRegime = null;
  reopenPendingUrgency = null;
  reopenPendingOldRegime = null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────

let lastPnlDate = '';
let dailySummaryCumInjected = 0;
let dailyRebalanceCount = 0;
// Track previous wallet balances to detect incoming transfers (injections)
let prevWalletSol = -1;
let prevWalletUsdc = -1;
let prevPositionSol = -1;
let prevPositionUsdc = -1;

function checkAndWriteDailyPnl(currentPrice: number) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const totalValue = currentLiveData?.totalValueWithPosition ?? 0;
  const walletValue = currentLiveData?.totalValueUsdc ?? 0;
  const positionValue = currentLiveData?.positionValueUsdc ?? 0;
  const solBal = currentLiveData?.solBalance ?? 0;
  const usdcBal = currentLiveData?.usdcBalance ?? 0;
  const posSol = currentLiveData?.positionSol ?? 0;
  const posUsdc = currentLiveData?.positionUsdc ?? 0;
  const cumFeesUsdc = liveCumFeesSol * currentPrice + liveCumFeesUsdc;
  const rawPending = (currentLiveData?.pendingFeesSol ?? 0) * currentPrice + (currentLiveData?.pendingFeesUsdc ?? 0);
  const pendingFeesUsdc = rawPending > 1000 ? 0 : rawPending;
  const totalFeesUsdc = cumFeesUsdc + pendingFeesUsdc;

  // Detect injections: compare total tokens (wallet + position) valued at same price.
  // Any increase in token quantity = external deposit (swaps just move tokens around).
  if (prevWalletSol >= 0) {
    const p = currentPrice;
    const prevTotalValue = (prevWalletSol + prevPositionSol) * p + prevWalletUsdc + prevPositionUsdc;
    const currTotalValue = (solBal + posSol) * p + usdcBal + posUsdc;
    const unexplained = currTotalValue - prevTotalValue;
    if (unexplained > 20) {
      dailySummaryCumInjected += unexplained;
      console.log(JSON.stringify({ level: 'info', msg: `Capital injection detected: $${unexplained.toFixed(2)} new capital`, timestamp: Date.now() }));
    }
  }
  prevWalletSol = solBal;
  prevWalletUsdc = usdcBal;
  prevPositionSol = posSol;
  prevPositionUsdc = posUsdc;

  // New day: reset daily tracking
  if (today !== lastPnlDate) {
    // On restart mid-day, restore today's cumulative injections from DB
    const existingSummary = getDailySummaries(db, 1);
    if (existingSummary.length > 0 && existingSummary[0].date === today) {
      dailySummaryCumInjected = existingSummary[0].injected_usdc;
    } else {
      dailySummaryCumInjected = 0;
    }
    dailyRebalanceCount = 0;
    lastPnlDate = today;

    upsertDailyPnl(db, {
      date: today,
      opening_value: totalValue,
      closing_value: totalValue,
      fees_sol: liveCumFeesSol, fees_usdc: liveCumFeesUsdc,
      il_cost: liveRealizedIl,
      net_pnl: totalFeesUsdc + liveRealizedIl, net_pnl_pct: totalValue > 0 ? ((totalFeesUsdc + liveRealizedIl) / totalValue) * 100 : 0,
      rebalances: dailyRebalanceCount,
      in_range_pct: null, regime: liveRegime,
    });
  }

  // Fee sources — single source of truth: rebalance_events (actual fees collected).
  // bot_state.cum_fees_sol/usdc is mark-to-market for portfolio valuation only.
  // daily_summary.fees_earned_usdc = getFeesCollected() for that day (no pending).

  // Portfolio change = today's value vs yesterday's close, net of injections
  const allSummaries = getDailySummaries(db, 2);
  const yesterday = allSummaries.find(s => s.date !== today);
  const yesterdayClose = yesterday?.total_usdc ?? totalValue;
  // Daily fees: actual fees collected today from closes/harvests (no pending)
  // SOL valued at current price for consistency across all pages
  const startOfTodayMs = new Date(today + 'T00:00:00Z').getTime();
  const dailyFeesEarned = getFeesCollected(db, { fromTs: startOfTodayMs, currentPrice: currentPrice });
  const portfolioChange = totalValue - yesterdayClose - dailySummaryCumInjected;

  // Upsert today's summary (updates every cycle with latest values)
  upsertDailySummary(db, {
    date: today,
    wallet_usdc: walletValue,
    position_usdc: positionValue,
    total_usdc: totalValue,
    injected_usdc: dailySummaryCumInjected,
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
