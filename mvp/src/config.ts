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
  autoDeployCooldownMinutes: 30,
  minIdleUsdc: 5,
  minIdleSol: 0.05,
  minDeployUsdc: 10,
  deployRatioTolerance: 0.02,

  // Re-entry (Rule 3)
  pullbackThresholdPct: REENTRY.PULLBACK_THRESHOLD_PCT as number,
  timeoutHours: REENTRY.TIMEOUT_HOURS as number,
  flashCrashPct: REENTRY.FLASH_CRASH_PCT as number,
  flashCrashWaitMinutes: REENTRY.FLASH_CRASH_WAIT_MINUTES as number,

  // Circuit Breakers
  dailyLossLimitPct: RISK.DAILY_LOSS_LIMIT_PCT as number,
  weeklyDrawdownLimitPct: RISK.WEEKLY_DRAWDOWN_LIMIT_PCT as number,
  maxIlPct: RISK.MAX_IL_PCT as number,
  rebalanceLoopLimit: RISK.REBALANCE_LOOP_LIMIT as number,

  // Swap config
  swapSlippageBps: 6,                                                     // 0.06%
  swapBufferPct: 3,                                                       // 3% over-request
  swapProvider: 'jupiter-fallback' as 'jupiter' | 'orca' | 'jupiter-fallback',

  // Position max age (hours) — rebalance to reset IL baseline. 0 = disabled.
  positionMaxAgeHours: 0,

  // Idle wallet rebalance — maintain target SOL/USDC split per regime
  idleRebalanceEnabled: true,
  idleRebalanceMinUsdc: 100,                 // min idle value to trigger ($)
  idleRebalanceSolKeep: 0.15,                // always keep this much SOL for gas
  idleRebalanceDeviationPct: 0.15,           // only rebalance if >15% off target
  // Target idle SOL % per regime (rest is USDC)
  idleTargetSolPctRanging: 0.50,             // 50% SOL — balanced for deposits
  idleTargetSolPctBullish: 0.60,             // 60% SOL — ride the upside
  idleTargetSolPctBearish: 0.35,             // 35% SOL — protect from downside
  idleTargetSolPctExtreme: 0.15,             // 15% SOL — survival mode

  // Range width override (null = use regime default)
  rangeWidthOverride: null as number | null,

  // Enhanced regime detection (market data signals)
  useEnhancedRegime: true,
  vol1hExtremeThreshold: 0.06,
  vol4hExtremeThreshold: 0.05,
  volumeSpikeMultiple: 3,
  trendDeltaThreshold: 4,
  btcCorrelationThreshold: 3,
  fearGreedExtremeLow: 25,
  fearGreedExtremeHigh: 75,

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
  'deployPct', 'solReentrySplit', 'harvestIntervalDays', 'harvestSolConvertPct',
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
  const v11 = nv('autoDeployCooldownMinutes', 1, 1440); if (v11 != null) runtime.autoDeployCooldownMinutes = v11;
  const v12 = nv('minIdleUsdc', 0.1, 10000); if (v12 != null) runtime.minIdleUsdc = v12;
  const v13 = nv('minIdleSol', 0.001, 100); if (v13 != null) runtime.minIdleSol = v13;
  const v14 = nv('minDeployUsdc', 1, 10000); if (v14 != null) runtime.minDeployUsdc = v14;
  const v15 = nv('deployRatioTolerance', 0.001, 0.5); if (v15 != null) runtime.deployRatioTolerance = v15;

  // Re-entry
  const v16 = nv('pullbackThresholdPct', 0.1, 20); if (v16 != null) runtime.pullbackThresholdPct = v16;
  const v17 = nv('timeoutHours', 0.05, 48); if (v17 != null) runtime.timeoutHours = v17;
  const v18 = nv('flashCrashPct', 1, 30); if (v18 != null) runtime.flashCrashPct = v18;
  const v19 = nv('flashCrashWaitMinutes', 1, 120); if (v19 != null) runtime.flashCrashWaitMinutes = v19;

  // Circuit breakers
  const v20 = nv('dailyLossLimitPct', 1, 50); if (v20 != null) runtime.dailyLossLimitPct = v20;
  const v21 = nv('weeklyDrawdownLimitPct', 1, 80); if (v21 != null) runtime.weeklyDrawdownLimitPct = v21;
  const v22 = nv('maxIlPct', 1, 50); if (v22 != null) runtime.maxIlPct = v22;
  const v23 = nv('rebalanceLoopLimit', 1, 100); if (v23 != null) runtime.rebalanceLoopLimit = v23;

  // Swap config
  const vSlip = nv('swapSlippageBps', 10, 500); if (vSlip != null) runtime.swapSlippageBps = vSlip;
  const vBuf = nv('swapBufferPct', 0, 10); if (vBuf != null) runtime.swapBufferPct = vBuf;
  const vProv = g('swapProvider'); if (vProv === 'jupiter' || vProv === 'orca' || vProv === 'jupiter-fallback') runtime.swapProvider = vProv;

  // Position max age
  const vMaxAge = nv('positionMaxAgeHours', 0, 168); if (vMaxAge != null) runtime.positionMaxAgeHours = vMaxAge;

  // Idle wallet rebalance
  const vIREnabled = g('idleRebalanceEnabled'); if (vIREnabled === 'true' || vIREnabled === 'false') runtime.idleRebalanceEnabled = vIREnabled === 'true';
  const vIRMin = nv('idleRebalanceMinUsdc', 10, 10000); if (vIRMin != null) runtime.idleRebalanceMinUsdc = vIRMin;
  const vIRKeep = nv('idleRebalanceSolKeep', 0.01, 5); if (vIRKeep != null) runtime.idleRebalanceSolKeep = vIRKeep;
  const vIRDev = nv('idleRebalanceDeviationPct', 0.05, 0.5); if (vIRDev != null) runtime.idleRebalanceDeviationPct = vIRDev;
  const vIRRanging = nv('idleTargetSolPctRanging', 0, 1); if (vIRRanging != null) runtime.idleTargetSolPctRanging = vIRRanging;
  const vIRBull = nv('idleTargetSolPctBullish', 0, 1); if (vIRBull != null) runtime.idleTargetSolPctBullish = vIRBull;
  const vIRBear = nv('idleTargetSolPctBearish', 0, 1); if (vIRBear != null) runtime.idleTargetSolPctBearish = vIRBear;
  const vIRExtreme = nv('idleTargetSolPctExtreme', 0, 1); if (vIRExtreme != null) runtime.idleTargetSolPctExtreme = vIRExtreme;

  // Enhanced regime
  const vUseEnh = g('useEnhancedRegime'); if (vUseEnh === 'true' || vUseEnh === 'false') runtime.useEnhancedRegime = vUseEnh === 'true';
  const vV1h = nv('vol1hExtremeThreshold', 0.01, 0.5); if (vV1h != null) runtime.vol1hExtremeThreshold = vV1h;
  const vV4h = nv('vol4hExtremeThreshold', 0.01, 0.5); if (vV4h != null) runtime.vol4hExtremeThreshold = vV4h;
  const vVSpike = nv('volumeSpikeMultiple', 1, 20); if (vVSpike != null) runtime.volumeSpikeMultiple = vVSpike;
  const vTrDelta = nv('trendDeltaThreshold', 1, 20); if (vTrDelta != null) runtime.trendDeltaThreshold = vTrDelta;
  const vBtcCorr = nv('btcCorrelationThreshold', 1, 20); if (vBtcCorr != null) runtime.btcCorrelationThreshold = vBtcCorr;
  const vFGLow = nv('fearGreedExtremeLow', 0, 50); if (vFGLow != null) runtime.fearGreedExtremeLow = vFGLow;
  const vFGHigh = nv('fearGreedExtremeHigh', 50, 100); if (vFGHigh != null) runtime.fearGreedExtremeHigh = vFGHigh;

  const rwo = g('rangeWidthOverride');
  if (rwo != null) runtime.rangeWidthOverride = rwo === 'null' || rwo === '' ? null : parseFloat(rwo);

  // Regime params (with bounds)
  const rpBounds: Record<string, [number, number]> = {
    rangeWidthPct: [0.1, 20], skewDown: [0, 1], skewUp: [0, 1],
    proxThresholdLower: [0.1, 1], proxThresholdUpper: [0.1, 1],
    deployPct: [0.01, 1], solReentrySplit: [0, 1],
    harvestIntervalDays: [0.1, 30], harvestSolConvertPct: [0, 1],
  };
  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      const key = `regime.${regime}.${field}`;
      const bounds = rpBounds[field] ?? [0, 1000];
      const val = nv(key, bounds[0], bounds[1]);
      if (val != null) (runtime.regimeParams[regime] as any)[field] = val;
    }
  }
}

/**
 * Export current runtime config as flat key-value for API/DB.
 */
export function exportConfig(): Record<string, string> {
  const out: Record<string, string> = {};

  out['decisionIntervalSeconds'] = String(runtime.decisionIntervalSeconds);
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
  out['pullbackThresholdPct'] = String(runtime.pullbackThresholdPct);
  out['timeoutHours'] = String(runtime.timeoutHours);
  out['flashCrashPct'] = String(runtime.flashCrashPct);
  out['flashCrashWaitMinutes'] = String(runtime.flashCrashWaitMinutes);
  out['dailyLossLimitPct'] = String(runtime.dailyLossLimitPct);
  out['weeklyDrawdownLimitPct'] = String(runtime.weeklyDrawdownLimitPct);
  out['maxIlPct'] = String(runtime.maxIlPct);
  out['rebalanceLoopLimit'] = String(runtime.rebalanceLoopLimit);
  out['swapSlippageBps'] = String(runtime.swapSlippageBps);
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
  out['rangeWidthOverride'] = runtime.rangeWidthOverride != null ? String(runtime.rangeWidthOverride) : 'null';
  out['useEnhancedRegime'] = String(runtime.useEnhancedRegime);
  out['vol1hExtremeThreshold'] = String(runtime.vol1hExtremeThreshold);
  out['vol4hExtremeThreshold'] = String(runtime.vol4hExtremeThreshold);
  out['volumeSpikeMultiple'] = String(runtime.volumeSpikeMultiple);
  out['trendDeltaThreshold'] = String(runtime.trendDeltaThreshold);
  out['btcCorrelationThreshold'] = String(runtime.btcCorrelationThreshold);
  out['fearGreedExtremeLow'] = String(runtime.fearGreedExtremeLow);
  out['fearGreedExtremeHigh'] = String(runtime.fearGreedExtremeHigh);

  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      out[`regime.${regime}.${field}`] = String((runtime.regimeParams[regime] as any)[field]);
    }
  }

  return out;
}
