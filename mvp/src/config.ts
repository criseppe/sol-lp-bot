/**
 * Runtime configuration — loaded from env, overridden by DB config table.
 * All values are mutable at runtime via the /config dashboard page.
 */

import { REGIME_PARAMS, RISK, REENTRY } from './constants.js';
import type { RegimeParams } from './types.js';

// ── Current runtime config (mutable) ─────────────────────────────────────

export const runtime = {
  // Decision loop
  decisionIntervalSeconds: 60,
  regimeCheckIntervalMs: 180_000, // 3 minutes between regime checks
  regimeWindowDays: 7,
  trendThreshold: 0.35,

  // Oracle
  pythMaxConfidencePct: 0.5,
  pythMaxStalenessSec: 60,

  // Capital & Reserves
  maxLiveCapitalUsdc: 5000,
  solReserve: 0.1,
  usdcReserve: 1,
  minPositionSizeUsdc: RISK.MIN_POSITION_SIZE_USDC as number,

  // Auto Deploy
  autoDeployCheckMinutes: 5,
  autoDeployCheckIntervalSec: 10, // seconds between auto-deploy attempts (within main cycle)
  autoDeployCooldownMinutes: 30,
  minIdleUsdc: 5,
  minIdleSol: 0.05,
  minDeployUsdc: 10,
  deployRatioTolerance: 0.02,

  // Re-entry (Rule 3) — DEPRECATED pullback fields kept for compat
  pullbackThresholdPct: REENTRY.PULLBACK_THRESHOLD_PCT as number,
  timeoutHours: REENTRY.TIMEOUT_HOURS as number,
  flashCrashPct: REENTRY.FLASH_CRASH_PCT as number,
  flashCrashWaitMinutes: REENTRY.FLASH_CRASH_WAIT_MINUTES as number,

  // Post-upside re-entry
  upsideChurnCooldownMin: 5,
  postUpsideOffsetRanging:  -0.005,
  postUpsideOffsetBullish:   0.000,
  postUpsideOffsetBearish:  -0.010,
  postUpsideOffsetExtreme:  -0.005,
  postUpsideFloorMultiplier: 0.5,  // pre-open SOL buy: relax USDC reserve floor to this fraction when post-upside (0.5 = 50%)
  postUpsideMaxBuyAboveBasis: 0.02, // skip post-upside pre-open SOL buy when currentPrice > basis × (1 + this) — avoids ratcheting cost basis
  preOpenMaxBuyAboveBasis: 0.005,  // strict cap on ALL pre-open SOL buys: skip when currentPrice > basis × (1 + this) (0.5% default)
  t1DownsideMinAgeMin: 30,         // minimum position age (min) before Rule 2 T1_DOWNSIDE may fire (not applied in BEARISH/EXTREME)
  t1DownsideAgeGuardEnabled: true, // master on/off for T1_DOWNSIDE age guard
  t1DownsideEmergencyOffset: 0.10, // bypass age guard when proxToLower >= proxThresholdLower + this offset

  // Circuit Breakers
  dailyLossLimitPct: RISK.DAILY_LOSS_LIMIT_PCT as number,
  weeklyDrawdownLimitPct: RISK.WEEKLY_DRAWDOWN_LIMIT_PCT as number,
  maxIlPct: RISK.MAX_IL_PCT as number,
  rebalanceLoopLimit: RISK.REBALANCE_LOOP_LIMIT as number,

  // Swap config
  swapSlippageBps: 30,                                                    // 0.3% Jupiter trade slippage
  liquiditySlippageBps: 100,                                              // 1.0% Orca LP slippage (open/close/increase/decrease)
  swapBufferPct: 3,                                                       // 3% over-request
  swapProvider: 'jupiter-fallback' as 'jupiter' | 'orca' | 'jupiter-fallback',

  // Priority fee for Orca on-chain TXs (close/open/increaseLiquidity/collectFees/Orca-swap-fallback).
  // Jupiter swaps already use prioritizationFeeLamports='auto' and don't use this.
  priorityFeeLamports: 0,        // 0 = disabled (no ComputeBudget instructions added).
  computeBudgetLimit: 0,         // 0 = no explicit CU cap (only used when priorityFeeLamports > 0).
  skipPreflight: false,          // bypass RPC simulation — validators decide. Use when Helius sim spuriously rejects.

  // Position max age (hours) — rebalance to reset IL baseline. 0 = disabled.
  positionMaxAgeHours: 0,

  // Idle wallet rebalance — maintain target SOL/USDC split per regime
  idleRebalanceEnabled: true,
  idleRebalanceMinUsdc: 100,                 // min idle value to trigger ($)
  idleRebalanceSolKeep: 0.15,                // always keep this much SOL for gas
  idleRebalanceDeviationPct: 0.15,           // only rebalance if >15% off target
  // Target idle SOL % per regime (rest is USDC)
  idleTargetSolPctRanging: 0.50,             // 50% SOL — balanced for deposits
  idleTargetSolPctBullish: 0.55,             // 55% SOL — slight upside bias
  idleTargetSolPctBearish: 0.35,             // 35% SOL — protect from downside
  idleTargetSolPctExtreme: 0.25,             // 25% SOL — keep some exposure
  idleRebalanceMaxUsdc: 2000,                // max USDC per idle rebalance cycle
  idleRebalanceSpreadCycles: 3,              // spread large rebalance over N cycles

  // Range width override (null = use regime default)
  rangeWidthOverride: null as number | null,

  // Regime-change reopen (smart transition rules)
  regimeReopenEnabled: true,
  regimeReopenMaxProximity: 0.75,
  regimeReopenMinProximity: 0.25,
  regimeReopenMaxPendingFees: 10.0,
  regimeReopenMinConfidence: 'MEDIUM' as string,
  regimeReopenMaxPriceVelocity: 0.30,
  regimeReopenMaxBbWidth: 2.5,
  regimeReopenMaxWaitCritical: 15,
  regimeReopenMaxWaitHigh: 45,
  regimeReopenMaxWaitMedium: 120,
  regimeMinScoreMargin: 2, // min (top−runner-up) TA score gap to commit a new regime candidate
  // Legacy toggle (mapped to regimeReopenEnabled)
  regimeChangeReopenEnabled: true,

  // VAR — Volatility-Adaptive Range
  varEnabled: false,
  varMultiplier: 3.0,
  varTargetHours: 2,
  varMinWidth: 1.0,
  varMaxWidth: 6.0,
  varAdjustThreshold: 0.30,
  varMinAge: 15,
  varCooldown: 10,

  // SIR — Smart Idle Rebalancing
  sirEnabled: false,
  sirCooldownMinutes: 5,
  sirTriggerThreshold: 0.08,
  sirMinSwapUsdc: 20,
  sirTrendMultiplier: 0.05,
  sirMaxSolPct: 0.75,
  sirMinSolPct: 0.15,

  // SOL Conversion — sell SOL to USDC when profitable and USDC needed for deploys
  solConversionEnabled: true,
  solConversionCooldownMin: 15,
  solConversionBasisMultiplier: 1.000, // global scaling on regime thresholds (RANGING=1.000, BULLISH=1.010, BEARISH=1.005, EXTREME=disabled). 1.0=defaults, 1.01=1% stricter
  solConvertMomentumThreshold: 0.02, // 30-min price change required to trigger momentum override in BEARISH/EXTREME
  solConvertMomentumCooldownMin: 10, // cooldown minutes for momentum-triggered conversions
  solConvertTargetDeployMinRanging: 15, // minutes to fully convert idle SOL in RANGING
  solConvertTargetDeployMinBullish: 30, // minutes to fully convert idle SOL in BULLISH
  solConvertTargetDeployMinBearish: 90, // minutes to fully convert idle SOL in BEARISH
  solConvertTargetDeployMinExtreme: 240, // minutes to fully convert idle SOL in EXTREME
  solConvertMinSolPct: 0.20, // SOL-heavy gate: only fire SolConvert if walletSolValue > this fraction of wallet total

  // Pre-open SOL→USDC sell (conditional). Fires only when wallet is SOL-heavy at open
  // AND price is at or above basis (no loss realization). Contradicts the prior
  // "never sell SOL pre-open" rule; gated strictly by basis margin to avoid the
  // historical loss pattern.
  preOpenSolSellEnabled: true,
  preOpenSolSellMaxPct: 0.10,            // max fraction of wallet SOL value per fire
  preOpenSolSellMinUsd: 500,             // min excess-SOL USD value before firing
  preOpenSolSellCooldownMs: 180_000,     // 3 min cooldown

  // SolConvert per-fire size cap (fraction of wallet SOL value). Previously hardcoded
  // at 0.05 in main.ts; now configurable for DB tuning.
  solConvertMaxFromSolPct: 0.05,

  // Enhanced regime detection (market data signals)
  useEnhancedRegime: true,
  vol1hExtremeThreshold: 0.06,
  vol4hExtremeThreshold: 0.05,
  volumeSpikeMultiple: 3,
  trendDeltaThreshold: 4,
  btcCorrelationThreshold: 3,
  fearGreedExtremeLow: 25,
  fearGreedExtremeHigh: 75,

  // EXTREME regime TA thresholds (reduce false positives)
  extremeBbWidthThreshold: 3.5,
  extremeRsiLow: 22,
  extremeRsiHigh: 78,
  extremeAtrThreshold: 0.60,

  // Master switch for all dynamic param adjustments (TA deploy multiplier,
  // post-upside centre offsets, RSI-weak centre offsets, post-upside deploy
  // boost). When false, runs with pure static regime params only.
  dynamicAdjustmentsEnabled: false,

  // Progressive basis decay — gradually loosen SolConvert threshold
  // when price stays below basis for extended periods.
  progressiveBasisDecayEnabled: false,
  progressiveBasisDecayStartHours: 0.5,
  progressiveBasisDecayPerInterval: 0.001,
  progressiveBasisDecayIntervalMinutes: 15,
  progressiveBasisDecayMinThreshold: 0.950,

  // Strategic SOL Rebalance — unstick bot when idle + SOL-heavy + below basis
  strategicRebalanceEnabled: true,
  strategicRebalanceIdleMinutes: 30,
  strategicRebalanceBasisMultiplier: 0.995,
  strategicRebalanceMinSolSharePct: 0.80,
  strategicRebalanceMaxPortfolioPct: 0.15,
  strategicRebalanceCooldownHours: 2,
  strategicRebalanceTargetSolSharePct: 0.70,
  strategicRebalanceMinUsdcGain: 500,

  // Regime params (mutable copies)
  regimeParams: {
    RANGING: { ...REGIME_PARAMS.RANGING },
    BULLISH_TREND: { ...REGIME_PARAMS.BULLISH_TREND },
    BEARISH_TREND: { ...REGIME_PARAMS.BEARISH_TREND },
    EXTREME: { ...REGIME_PARAMS.EXTREME },
  } as Record<string, RegimeParams>,
};

// ── Config key mapping ───────────────────────────────────────────────────

const REGIME_KEYS = ['RANGING', 'BULLISH_TREND', 'BEARISH_TREND', 'EXTREME'] as const;
const REGIME_PARAM_FIELDS: (keyof RegimeParams)[] = [
  'rangeWidthPct', 'skewDown', 'skewUp', 'proxThresholdLower', 'proxThresholdUpper',
  'deployPct', 'solReentrySplit', 'harvestIntervalDays', 'harvestSolConvertPct', 'usdcDepositPct', 'deployRatioTolerance', 'basisGateThreshold', 'proximityDeployThreshold', 'reserveFloorPct',
  'solConvertBasisMultiplier',
  'progressiveBasisDecayStartHours', 'progressiveBasisDecayPerInterval', 'progressiveBasisDecayMinThreshold',
];

/**
 * Load config from DB entries into runtime object.
 * DB values override env/constant defaults.
 */
export function applyConfigFromDb(dbConfig: Record<string, string>): void {
  const g = (key: string) => dbConfig[key];
  const n = (key: string) => { const v = g(key); return v != null ? parseFloat(v) : undefined; };
  // Validated number: only apply if within bounds
  const nv = (key: string, min: number, max: number) => {
    const v = n(key);
    if (v == null) return undefined;
    if (!isFinite(v) || v < min || v > max) {
      console.log(JSON.stringify({ level: 'warn', msg: `Config rejected: ${key}=${v} outside [${min}, ${max}]`, timestamp: Date.now() }));
      return undefined;
    }
    return v;
  };

  // Decision loop
  const v1 = nv('decisionIntervalSeconds', 10, 600); if (v1 != null) runtime.decisionIntervalSeconds = v1;
  const rcMs = nv('regimeCheckIntervalMs', 30000, 3600000); if (rcMs != null) runtime.regimeCheckIntervalMs = rcMs;
  const v2 = nv('regimeWindowDays', 1, 30); if (v2 != null) runtime.regimeWindowDays = v2;
  const v3 = nv('trendThreshold', 0.05, 0.95); if (v3 != null) runtime.trendThreshold = v3;
  const v4 = nv('pythMaxConfidencePct', 0.1, 5); if (v4 != null) runtime.pythMaxConfidencePct = v4;
  const v5 = nv('pythMaxStalenessSec', 10, 300); if (v5 != null) runtime.pythMaxStalenessSec = v5;

  // Capital & reserves
  const v6 = nv('maxLiveCapitalUsdc', 10, 1000000); if (v6 != null) runtime.maxLiveCapitalUsdc = v6;
  const v7 = nv('solReserve', 0.01, 10); if (v7 != null) runtime.solReserve = v7;
  const v8 = nv('usdcReserve', 0, 100); if (v8 != null) runtime.usdcReserve = v8;
  const v9 = nv('minPositionSizeUsdc', 1, 10000); if (v9 != null) runtime.minPositionSizeUsdc = v9;

  // Auto deploy
  const v10 = nv('autoDeployCheckMinutes', 1, 60); if (v10 != null) runtime.autoDeployCheckMinutes = v10;
  const adSec = nv('autoDeployCheckIntervalSec', 5, 300); if (adSec != null) runtime.autoDeployCheckIntervalSec = adSec;
  const v11 = nv('autoDeployCooldownMinutes', 0, 1440); if (v11 != null) runtime.autoDeployCooldownMinutes = v11;
  const v12 = nv('minIdleUsdc', 0.1, 10000); if (v12 != null) runtime.minIdleUsdc = v12;
  const v13 = nv('minIdleSol', 0.001, 100); if (v13 != null) runtime.minIdleSol = v13;
  const v14 = nv('minDeployUsdc', 1, 10000); if (v14 != null) runtime.minDeployUsdc = v14;
  const v15 = nv('deployRatioTolerance', 0.001, 0.5); if (v15 != null) runtime.deployRatioTolerance = v15;

  // SOL conversion
  const scEnabled = g('solConversionEnabled'); if (scEnabled != null) runtime.solConversionEnabled = scEnabled === 'true' || scEnabled === '1';
  const scCooldown = nv('solConversionCooldownMin', 1, 120); if (scCooldown != null) runtime.solConversionCooldownMin = scCooldown;
  const scBasis = nv('solConversionBasisMultiplier', 1.000, 1.050); if (scBasis != null) runtime.solConversionBasisMultiplier = scBasis;
  const scMomThresh = nv('solConvertMomentumThreshold', 0.005, 0.10); if (scMomThresh != null) runtime.solConvertMomentumThreshold = scMomThresh;
  const scMomCool = nv('solConvertMomentumCooldownMin', 1, 120); if (scMomCool != null) runtime.solConvertMomentumCooldownMin = scMomCool;
  const scTdR = nv('solConvertTargetDeployMinRanging', 5, 60); if (scTdR != null) runtime.solConvertTargetDeployMinRanging = scTdR;
  const scTdB = nv('solConvertTargetDeployMinBullish', 10, 120); if (scTdB != null) runtime.solConvertTargetDeployMinBullish = scTdB;
  const scTdBe = nv('solConvertTargetDeployMinBearish', 30, 240); if (scTdBe != null) runtime.solConvertTargetDeployMinBearish = scTdBe;
  const scTdE = nv('solConvertTargetDeployMinExtreme', 60, 480); if (scTdE != null) runtime.solConvertTargetDeployMinExtreme = scTdE;
  const scMinSol = nv('solConvertMinSolPct', 0, 1); if (scMinSol != null) runtime.solConvertMinSolPct = scMinSol;

  // Pre-open SOL sell
  const vPOSSEn = g('preOpenSolSellEnabled'); if (vPOSSEn === 'true' || vPOSSEn === 'false') runtime.preOpenSolSellEnabled = vPOSSEn === 'true';
  const vPOSSMax = nv('preOpenSolSellMaxPct', 0, 0.5); if (vPOSSMax != null) runtime.preOpenSolSellMaxPct = vPOSSMax;
  const vPOSSMin = nv('preOpenSolSellMinUsd', 0, 10000); if (vPOSSMin != null) runtime.preOpenSolSellMinUsd = vPOSSMin;
  const vPOSSCool = nv('preOpenSolSellCooldownMs', 60_000, 3_600_000); if (vPOSSCool != null) runtime.preOpenSolSellCooldownMs = vPOSSCool;
  const vSCMaxFrom = nv('solConvertMaxFromSolPct', 0, 1); if (vSCMaxFrom != null) runtime.solConvertMaxFromSolPct = vSCMaxFrom;

  // Re-entry
  const v16 = nv('pullbackThresholdPct', 0.1, 20); if (v16 != null) runtime.pullbackThresholdPct = v16;
  const v17 = nv('timeoutHours', 0.05, 48); if (v17 != null) runtime.timeoutHours = v17;
  const v18 = nv('flashCrashPct', 1, 30); if (v18 != null) runtime.flashCrashPct = v18;
  const v19 = nv('flashCrashWaitMinutes', 1, 120); if (v19 != null) runtime.flashCrashWaitMinutes = v19;

  // Post-upside re-entry
  const vUCC = nv('upsideChurnCooldownMin', 0, 60); if (vUCC != null) runtime.upsideChurnCooldownMin = vUCC;
  const vPOR = nv('postUpsideOffsetRanging', -0.05, 0.05); if (vPOR != null) runtime.postUpsideOffsetRanging = vPOR;
  const vPOB = nv('postUpsideOffsetBullish', -0.05, 0.05); if (vPOB != null) runtime.postUpsideOffsetBullish = vPOB;
  const vPOBe = nv('postUpsideOffsetBearish', -0.05, 0.05); if (vPOBe != null) runtime.postUpsideOffsetBearish = vPOBe;
  const vPOE = nv('postUpsideOffsetExtreme', -0.05, 0.05); if (vPOE != null) runtime.postUpsideOffsetExtreme = vPOE;
  const vPUFM = nv('postUpsideFloorMultiplier', 0, 1); if (vPUFM != null) runtime.postUpsideFloorMultiplier = vPUFM;
  const vPUMBAB = nv('postUpsideMaxBuyAboveBasis', 0, 0.10); if (vPUMBAB != null) runtime.postUpsideMaxBuyAboveBasis = vPUMBAB;
  const vPreMBAB = nv('preOpenMaxBuyAboveBasis', 0, 0.10); if (vPreMBAB != null) runtime.preOpenMaxBuyAboveBasis = vPreMBAB;
  const vT1DMA = nv('t1DownsideMinAgeMin', 0, 240); if (vT1DMA != null) runtime.t1DownsideMinAgeMin = vT1DMA;
  // Absent DB key → reset to default (true) so removing the key actually re-enables the guard.
  // Accepts 'true'/'false' strings (written by config UI) and numeric '1'/'0'.
  { const vs = g('t1DownsideAgeGuardEnabled');
    runtime.t1DownsideAgeGuardEnabled = (vs === 'true' || vs === '1') ? true
      : (vs === 'false' || vs === '0') ? false
      : true; }
  const vT1DEO = nv('t1DownsideEmergencyOffset', 0, 0.5); if (vT1DEO != null) runtime.t1DownsideEmergencyOffset = vT1DEO;

  // Circuit breakers
  const v20 = nv('dailyLossLimitPct', 1, 50); if (v20 != null) runtime.dailyLossLimitPct = v20;
  const v21 = nv('weeklyDrawdownLimitPct', 1, 80); if (v21 != null) runtime.weeklyDrawdownLimitPct = v21;
  const v22 = nv('maxIlPct', 1, 50); if (v22 != null) runtime.maxIlPct = v22;
  const v23 = nv('rebalanceLoopLimit', 1, 100); if (v23 != null) runtime.rebalanceLoopLimit = v23;

  // Swap config
  const vSlip = nv('swapSlippageBps', 1, 500); if (vSlip != null) runtime.swapSlippageBps = vSlip;
  const vLiqSlip = nv('liquiditySlippageBps', 1, 1000); if (vLiqSlip != null) runtime.liquiditySlippageBps = vLiqSlip;
  const vBuf = nv('swapBufferPct', 0, 10); if (vBuf != null) runtime.swapBufferPct = vBuf;
  const vProv = g('swapProvider'); if (vProv === 'jupiter' || vProv === 'orca' || vProv === 'jupiter-fallback') runtime.swapProvider = vProv;
  const vPrio = nv('priorityFeeLamports', 0, 10_000_000); if (vPrio != null) runtime.priorityFeeLamports = vPrio;
  const vCul = nv('computeBudgetLimit', 0, 1_400_000); if (vCul != null) runtime.computeBudgetLimit = vCul;
  const vSkip = g('skipPreflight'); if (vSkip === 'true' || vSkip === 'false') runtime.skipPreflight = vSkip === 'true';

  // Position max age
  const vMaxAge = nv('positionMaxAgeHours', 0, 168); if (vMaxAge != null) runtime.positionMaxAgeHours = vMaxAge;

  // Idle wallet rebalance
  const vIREnabled = g('idleRebalanceEnabled'); if (vIREnabled === 'true' || vIREnabled === 'false') runtime.idleRebalanceEnabled = vIREnabled === 'true';
  const vRCR = g('regimeChangeReopenEnabled'); if (vRCR === 'true' || vRCR === 'false') { runtime.regimeChangeReopenEnabled = vRCR === 'true'; runtime.regimeReopenEnabled = vRCR === 'true'; }
  const vRRE = g('regimeReopenEnabled'); if (vRRE === 'true' || vRRE === 'false') { runtime.regimeReopenEnabled = vRRE === 'true'; runtime.regimeChangeReopenEnabled = vRRE === 'true'; }
  const vRRMaxP = nv('regimeReopenMaxProximity', 0.3, 1.0); if (vRRMaxP != null) runtime.regimeReopenMaxProximity = vRRMaxP;
  const vRRMinP = nv('regimeReopenMinProximity', 0.0, 0.5); if (vRRMinP != null) runtime.regimeReopenMinProximity = vRRMinP;
  const vRRMaxF = nv('regimeReopenMaxPendingFees', 0, 100); if (vRRMaxF != null) runtime.regimeReopenMaxPendingFees = vRRMaxF;
  const vRRConf = g('regimeReopenMinConfidence'); if (vRRConf === 'LOW' || vRRConf === 'MEDIUM' || vRRConf === 'HIGH') runtime.regimeReopenMinConfidence = vRRConf;
  const vRRVel = nv('regimeReopenMaxPriceVelocity', 0.05, 5); if (vRRVel != null) runtime.regimeReopenMaxPriceVelocity = vRRVel;
  const vRRBb = nv('regimeReopenMaxBbWidth', 0.5, 10); if (vRRBb != null) runtime.regimeReopenMaxBbWidth = vRRBb;
  const vRRWC = nv('regimeReopenMaxWaitCritical', 1, 60); if (vRRWC != null) runtime.regimeReopenMaxWaitCritical = vRRWC;
  const vRRWH = nv('regimeReopenMaxWaitHigh', 5, 180); if (vRRWH != null) runtime.regimeReopenMaxWaitHigh = vRRWH;
  const vRRWM = nv('regimeReopenMaxWaitMedium', 10, 360); if (vRRWM != null) runtime.regimeReopenMaxWaitMedium = vRRWM;
  const vRMin = nv('regimeMinScoreMargin', 0, 7); if (vRMin != null) runtime.regimeMinScoreMargin = vRMin;
  const vIRMin = nv('idleRebalanceMinUsdc', 10, 10000); if (vIRMin != null) runtime.idleRebalanceMinUsdc = vIRMin;
  const vIRKeep = nv('idleRebalanceSolKeep', 0.01, 5); if (vIRKeep != null) runtime.idleRebalanceSolKeep = vIRKeep;
  const vIRDev = nv('idleRebalanceDeviationPct', 0.05, 0.5); if (vIRDev != null) runtime.idleRebalanceDeviationPct = vIRDev;
  const vIRRanging = nv('idleTargetSolPctRanging', 0, 1); if (vIRRanging != null) runtime.idleTargetSolPctRanging = vIRRanging;
  const vIRBull = nv('idleTargetSolPctBullish', 0, 1); if (vIRBull != null) runtime.idleTargetSolPctBullish = vIRBull;
  const vIRBear = nv('idleTargetSolPctBearish', 0, 1); if (vIRBear != null) runtime.idleTargetSolPctBearish = vIRBear;
  const vIRExtreme = nv('idleTargetSolPctExtreme', 0, 1); if (vIRExtreme != null) runtime.idleTargetSolPctExtreme = vIRExtreme;
  const vIRMax = nv('idleRebalanceMaxUsdc', 50, 50000); if (vIRMax != null) runtime.idleRebalanceMaxUsdc = vIRMax;
  const vIRSpread = nv('idleRebalanceSpreadCycles', 1, 10); if (vIRSpread != null) runtime.idleRebalanceSpreadCycles = vIRSpread;

  // Enhanced regime
  const vUseEnh = g('useEnhancedRegime'); if (vUseEnh === 'true' || vUseEnh === 'false') runtime.useEnhancedRegime = vUseEnh === 'true';
  const vV1h = nv('vol1hExtremeThreshold', 0.01, 0.5); if (vV1h != null) runtime.vol1hExtremeThreshold = vV1h;
  const vV4h = nv('vol4hExtremeThreshold', 0.01, 0.5); if (vV4h != null) runtime.vol4hExtremeThreshold = vV4h;
  const vVSpike = nv('volumeSpikeMultiple', 1, 20); if (vVSpike != null) runtime.volumeSpikeMultiple = vVSpike;
  const vTrDelta = nv('trendDeltaThreshold', 1, 20); if (vTrDelta != null) runtime.trendDeltaThreshold = vTrDelta;
  const vBtcCorr = nv('btcCorrelationThreshold', 1, 20); if (vBtcCorr != null) runtime.btcCorrelationThreshold = vBtcCorr;
  const vFGLow = nv('fearGreedExtremeLow', 0, 50); if (vFGLow != null) runtime.fearGreedExtremeLow = vFGLow;
  const vFGHigh = nv('fearGreedExtremeHigh', 50, 100); if (vFGHigh != null) runtime.fearGreedExtremeHigh = vFGHigh;

  // EXTREME regime TA thresholds
  const vEbbW = nv('extremeBbWidthThreshold', 1.5, 10); if (vEbbW != null) runtime.extremeBbWidthThreshold = vEbbW;
  const vErsiL = nv('extremeRsiLow', 5, 40); if (vErsiL != null) runtime.extremeRsiLow = vErsiL;
  const vErsiH = nv('extremeRsiHigh', 60, 95); if (vErsiH != null) runtime.extremeRsiHigh = vErsiH;
  const vEatr = nv('extremeAtrThreshold', 0.10, 5); if (vEatr != null) runtime.extremeAtrThreshold = vEatr;

  // VAR config
  const vVarEn = g('varEnabled'); if (vVarEn === 'true' || vVarEn === 'false') runtime.varEnabled = vVarEn === 'true';
  const vVarMult = nv('varMultiplier', 1, 10); if (vVarMult != null) runtime.varMultiplier = vVarMult;
  const vVarHours = nv('varTargetHours', 0.5, 24); if (vVarHours != null) runtime.varTargetHours = vVarHours;
  const vVarMinW = nv('varMinWidth', 0.5, 5); if (vVarMinW != null) runtime.varMinWidth = vVarMinW;
  const vVarMaxW = nv('varMaxWidth', 2, 20); if (vVarMaxW != null) runtime.varMaxWidth = vVarMaxW;
  const vVarAdj = nv('varAdjustThreshold', 0.1, 0.8); if (vVarAdj != null) runtime.varAdjustThreshold = vVarAdj;
  const vVarAge = nv('varMinAge', 1, 60); if (vVarAge != null) runtime.varMinAge = vVarAge;
  const vVarCool = nv('varCooldown', 1, 60); if (vVarCool != null) runtime.varCooldown = vVarCool;

  // SIR config
  const vSirEn = g('sirEnabled'); if (vSirEn === 'true' || vSirEn === 'false') runtime.sirEnabled = vSirEn === 'true';
  const vSirCool = nv('sirCooldownMinutes', 1, 60); if (vSirCool != null) runtime.sirCooldownMinutes = vSirCool;
  const vSirTrig = nv('sirTriggerThreshold', 0.02, 0.5); if (vSirTrig != null) runtime.sirTriggerThreshold = vSirTrig;
  const vSirMin = nv('sirMinSwapUsdc', 5, 500); if (vSirMin != null) runtime.sirMinSwapUsdc = vSirMin;
  const vSirTrend = nv('sirTrendMultiplier', 0.01, 0.2); if (vSirTrend != null) runtime.sirTrendMultiplier = vSirTrend;
  const vSirMaxSol = nv('sirMaxSolPct', 0.5, 1); if (vSirMaxSol != null) runtime.sirMaxSolPct = vSirMaxSol;
  const vSirMinSol = nv('sirMinSolPct', 0, 0.5); if (vSirMinSol != null) runtime.sirMinSolPct = vSirMinSol;

  const rwo = g('rangeWidthOverride');
  if (rwo != null) runtime.rangeWidthOverride = rwo === 'null' || rwo === '' ? null : parseFloat(rwo);

  // Regime params (with bounds)
  const rpBounds: Record<string, [number, number]> = {
    rangeWidthPct: [0.1, 20], skewDown: [0, 1], skewUp: [0, 1],
    proxThresholdLower: [0.1, 1], proxThresholdUpper: [0.1, 1],
    deployPct: [0.01, 1], solReentrySplit: [0, 1],
    harvestIntervalDays: [0.1, 30], harvestSolConvertPct: [0, 1],
    solConvertBasisMultiplier: [0.95, 1.10],
    progressiveBasisDecayStartHours: [0, 24],
    progressiveBasisDecayPerInterval: [0, 0.01],
    progressiveBasisDecayMinThreshold: [0.5, 1.0],
  };
  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      const key = `regime.${regime}.${field}`;
      const bounds = rpBounds[field] ?? [0, 1000];
      const val = nv(key, bounds[0], bounds[1]);
      if (val != null) (runtime.regimeParams[regime] as any)[field] = val;
    }
  }

  // Master switch for dynamic adjustments.
  // Absent DB key → reset to default (false) so removing the key actually disables.
  // Accepts 'true'/'false' strings (written by config UI) and numeric '1'/'0'.
  { const vs = g('dynamicAdjustmentsEnabled');
    runtime.dynamicAdjustmentsEnabled = (vs === 'true' || vs === '1') ? true
      : (vs === 'false' || vs === '0') ? false
      : false; }

  // Progressive basis decay
  { const v = n('progressiveBasisDecayEnabled'); if (v != null) runtime.progressiveBasisDecayEnabled = v !== 0; }
  const pbdS = nv('progressiveBasisDecayStartHours', 0.0, 48);         if (pbdS != null) runtime.progressiveBasisDecayStartHours = pbdS;
  const pbdP = nv('progressiveBasisDecayPerInterval', 0.0001, 0.01);   if (pbdP != null) runtime.progressiveBasisDecayPerInterval = pbdP;
  const pbdI = nv('progressiveBasisDecayIntervalMinutes', 1, 60);      if (pbdI != null) runtime.progressiveBasisDecayIntervalMinutes = pbdI;
  const pbdM = nv('progressiveBasisDecayMinThreshold', 0.80, 0.99);    if (pbdM != null) runtime.progressiveBasisDecayMinThreshold = pbdM;

  // Strategic SOL Rebalance
  { const v = n('strategicRebalanceEnabled'); if (v != null) runtime.strategicRebalanceEnabled = v !== 0; }
  const srIdle = nv('strategicRebalanceIdleMinutes', 5, 1440);        if (srIdle != null) runtime.strategicRebalanceIdleMinutes = srIdle;
  const srMult = nv('strategicRebalanceBasisMultiplier', 0.90, 1.00);  if (srMult != null) runtime.strategicRebalanceBasisMultiplier = srMult;
  const srMin  = nv('strategicRebalanceMinSolSharePct', 0.50, 1.00);   if (srMin  != null) runtime.strategicRebalanceMinSolSharePct = srMin;
  const srMax  = nv('strategicRebalanceMaxPortfolioPct', 0.01, 0.50);  if (srMax  != null) runtime.strategicRebalanceMaxPortfolioPct = srMax;
  const srCd   = nv('strategicRebalanceCooldownHours', 0.5, 24);       if (srCd   != null) runtime.strategicRebalanceCooldownHours = srCd;
  const srTgt  = nv('strategicRebalanceTargetSolSharePct', 0.30, 0.95); if (srTgt  != null) runtime.strategicRebalanceTargetSolSharePct = srTgt;
  const srMU   = nv('strategicRebalanceMinUsdcGain', 50, 10000);       if (srMU   != null) runtime.strategicRebalanceMinUsdcGain = srMU;
}

/**
 * Export current runtime config as flat key-value for API/DB.
 */
export function exportConfig(): Record<string, string> {
  const out: Record<string, string> = {};

  out['decisionIntervalSeconds'] = String(runtime.decisionIntervalSeconds);
  out['regimeCheckIntervalMs'] = String(runtime.regimeCheckIntervalMs);
  out['autoDeployCheckIntervalSec'] = String(runtime.autoDeployCheckIntervalSec);
  out['regimeChangeReopenEnabled'] = String(runtime.regimeChangeReopenEnabled);
  out['regimeReopenEnabled'] = String(runtime.regimeReopenEnabled);
  out['regimeReopenMaxProximity'] = String(runtime.regimeReopenMaxProximity);
  out['regimeReopenMinProximity'] = String(runtime.regimeReopenMinProximity);
  out['regimeReopenMaxPendingFees'] = String(runtime.regimeReopenMaxPendingFees);
  out['regimeReopenMinConfidence'] = runtime.regimeReopenMinConfidence;
  out['regimeReopenMaxPriceVelocity'] = String(runtime.regimeReopenMaxPriceVelocity);
  out['regimeReopenMaxBbWidth'] = String(runtime.regimeReopenMaxBbWidth);
  out['regimeMinScoreMargin'] = String(runtime.regimeMinScoreMargin);
  out['regimeReopenMaxWaitCritical'] = String(runtime.regimeReopenMaxWaitCritical);
  out['regimeReopenMaxWaitHigh'] = String(runtime.regimeReopenMaxWaitHigh);
  out['regimeReopenMaxWaitMedium'] = String(runtime.regimeReopenMaxWaitMedium);
  out['regimeWindowDays'] = String(runtime.regimeWindowDays);
  out['trendThreshold'] = String(runtime.trendThreshold);
  out['pythMaxConfidencePct'] = String(runtime.pythMaxConfidencePct);
  out['pythMaxStalenessSec'] = String(runtime.pythMaxStalenessSec);
  out['maxLiveCapitalUsdc'] = String(runtime.maxLiveCapitalUsdc);
  out['solReserve'] = String(runtime.solReserve);
  out['usdcReserve'] = String(runtime.usdcReserve);
  out['minPositionSizeUsdc'] = String(runtime.minPositionSizeUsdc);
  out['autoDeployCheckMinutes'] = String(runtime.autoDeployCheckMinutes);
  out['autoDeployCooldownMinutes'] = String(runtime.autoDeployCooldownMinutes);
  out['minIdleUsdc'] = String(runtime.minIdleUsdc);
  out['minIdleSol'] = String(runtime.minIdleSol);
  out['minDeployUsdc'] = String(runtime.minDeployUsdc);
  out['deployRatioTolerance'] = String(runtime.deployRatioTolerance);
  out['solConversionEnabled'] = runtime.solConversionEnabled ? '1' : '0';
  out['solConversionCooldownMin'] = String(runtime.solConversionCooldownMin);
  out['solConversionBasisMultiplier'] = String(runtime.solConversionBasisMultiplier);
  out['solConvertMomentumThreshold'] = String(runtime.solConvertMomentumThreshold);
  out['solConvertMomentumCooldownMin'] = String(runtime.solConvertMomentumCooldownMin);
  out['solConvertTargetDeployMinRanging'] = String(runtime.solConvertTargetDeployMinRanging);
  out['solConvertTargetDeployMinBullish'] = String(runtime.solConvertTargetDeployMinBullish);
  out['solConvertTargetDeployMinBearish'] = String(runtime.solConvertTargetDeployMinBearish);
  out['solConvertTargetDeployMinExtreme'] = String(runtime.solConvertTargetDeployMinExtreme);
  out['preOpenSolSellEnabled'] = runtime.preOpenSolSellEnabled ? '1' : '0';
  out['preOpenSolSellMaxPct'] = String(runtime.preOpenSolSellMaxPct);
  out['preOpenSolSellMinUsd'] = String(runtime.preOpenSolSellMinUsd);
  out['preOpenSolSellCooldownMs'] = String(runtime.preOpenSolSellCooldownMs);
  out['solConvertMaxFromSolPct'] = String(runtime.solConvertMaxFromSolPct);
  out['pullbackThresholdPct'] = String(runtime.pullbackThresholdPct);
  out['timeoutHours'] = String(runtime.timeoutHours);
  out['flashCrashPct'] = String(runtime.flashCrashPct);
  out['flashCrashWaitMinutes'] = String(runtime.flashCrashWaitMinutes);
  out['upsideChurnCooldownMin'] = String(runtime.upsideChurnCooldownMin);
  out['postUpsideOffsetRanging'] = String(runtime.postUpsideOffsetRanging);
  out['postUpsideOffsetBullish'] = String(runtime.postUpsideOffsetBullish);
  out['postUpsideOffsetBearish'] = String(runtime.postUpsideOffsetBearish);
  out['postUpsideOffsetExtreme'] = String(runtime.postUpsideOffsetExtreme);
  out['postUpsideFloorMultiplier'] = String(runtime.postUpsideFloorMultiplier);
  out['postUpsideMaxBuyAboveBasis'] = String(runtime.postUpsideMaxBuyAboveBasis);
  out['preOpenMaxBuyAboveBasis'] = String(runtime.preOpenMaxBuyAboveBasis);
  out['t1DownsideMinAgeMin'] = String(runtime.t1DownsideMinAgeMin);
  out['dailyLossLimitPct'] = String(runtime.dailyLossLimitPct);
  out['weeklyDrawdownLimitPct'] = String(runtime.weeklyDrawdownLimitPct);
  out['maxIlPct'] = String(runtime.maxIlPct);
  out['rebalanceLoopLimit'] = String(runtime.rebalanceLoopLimit);
  out['swapSlippageBps'] = String(runtime.swapSlippageBps);
  out['liquiditySlippageBps'] = String(runtime.liquiditySlippageBps);
  out['swapBufferPct'] = String(runtime.swapBufferPct);
  out['swapProvider'] = runtime.swapProvider;
  out['positionMaxAgeHours'] = String(runtime.positionMaxAgeHours);
  out['idleRebalanceEnabled'] = String(runtime.idleRebalanceEnabled);
  out['idleRebalanceMinUsdc'] = String(runtime.idleRebalanceMinUsdc);
  out['idleRebalanceSolKeep'] = String(runtime.idleRebalanceSolKeep);
  out['idleRebalanceDeviationPct'] = String(runtime.idleRebalanceDeviationPct);
  out['idleTargetSolPctRanging'] = String(runtime.idleTargetSolPctRanging);
  out['idleTargetSolPctBullish'] = String(runtime.idleTargetSolPctBullish);
  out['idleTargetSolPctBearish'] = String(runtime.idleTargetSolPctBearish);
  out['idleTargetSolPctExtreme'] = String(runtime.idleTargetSolPctExtreme);
  out['idleRebalanceMaxUsdc'] = String(runtime.idleRebalanceMaxUsdc);
  out['idleRebalanceSpreadCycles'] = String(runtime.idleRebalanceSpreadCycles);
  out['rangeWidthOverride'] = runtime.rangeWidthOverride != null ? String(runtime.rangeWidthOverride) : 'null';
  out['varEnabled'] = String(runtime.varEnabled);
  out['varMultiplier'] = String(runtime.varMultiplier);
  out['varTargetHours'] = String(runtime.varTargetHours);
  out['varMinWidth'] = String(runtime.varMinWidth);
  out['varMaxWidth'] = String(runtime.varMaxWidth);
  out['varAdjustThreshold'] = String(runtime.varAdjustThreshold);
  out['varMinAge'] = String(runtime.varMinAge);
  out['varCooldown'] = String(runtime.varCooldown);
  out['sirEnabled'] = String(runtime.sirEnabled);
  out['sirCooldownMinutes'] = String(runtime.sirCooldownMinutes);
  out['sirTriggerThreshold'] = String(runtime.sirTriggerThreshold);
  out['sirMinSwapUsdc'] = String(runtime.sirMinSwapUsdc);
  out['sirTrendMultiplier'] = String(runtime.sirTrendMultiplier);
  out['sirMaxSolPct'] = String(runtime.sirMaxSolPct);
  out['sirMinSolPct'] = String(runtime.sirMinSolPct);
  out['useEnhancedRegime'] = String(runtime.useEnhancedRegime);
  out['vol1hExtremeThreshold'] = String(runtime.vol1hExtremeThreshold);
  out['vol4hExtremeThreshold'] = String(runtime.vol4hExtremeThreshold);
  out['volumeSpikeMultiple'] = String(runtime.volumeSpikeMultiple);
  out['trendDeltaThreshold'] = String(runtime.trendDeltaThreshold);
  out['btcCorrelationThreshold'] = String(runtime.btcCorrelationThreshold);
  out['fearGreedExtremeLow'] = String(runtime.fearGreedExtremeLow);
  out['fearGreedExtremeHigh'] = String(runtime.fearGreedExtremeHigh);
  out['extremeBbWidthThreshold'] = String(runtime.extremeBbWidthThreshold);
  out['extremeRsiLow'] = String(runtime.extremeRsiLow);
  out['extremeRsiHigh'] = String(runtime.extremeRsiHigh);
  out['extremeAtrThreshold'] = String(runtime.extremeAtrThreshold);

  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      out[`regime.${regime}.${field}`] = String((runtime.regimeParams[regime] as any)[field]);
    }
  }

  return out;
}
