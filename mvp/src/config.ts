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

  // Range width override (null = use regime default)
  rangeWidthOverride: null as number | null,

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

  if (n('decisionIntervalSeconds') != null) runtime.decisionIntervalSeconds = n('decisionIntervalSeconds')!;
  if (n('regimeWindowDays') != null) runtime.regimeWindowDays = n('regimeWindowDays')!;
  if (n('trendThreshold') != null) runtime.trendThreshold = n('trendThreshold')!;
  if (n('maxLiveCapitalUsdc') != null) runtime.maxLiveCapitalUsdc = n('maxLiveCapitalUsdc')!;
  if (n('solReserve') != null) runtime.solReserve = n('solReserve')!;
  if (n('usdcReserve') != null) runtime.usdcReserve = n('usdcReserve')!;
  if (n('minPositionSizeUsdc') != null) runtime.minPositionSizeUsdc = n('minPositionSizeUsdc')!;
  if (n('autoDeployCheckMinutes') != null) runtime.autoDeployCheckMinutes = n('autoDeployCheckMinutes')!;
  if (n('autoDeployCooldownMinutes') != null) runtime.autoDeployCooldownMinutes = n('autoDeployCooldownMinutes')!;
  if (n('minIdleUsdc') != null) runtime.minIdleUsdc = n('minIdleUsdc')!;
  if (n('minIdleSol') != null) runtime.minIdleSol = n('minIdleSol')!;
  if (n('minDeployUsdc') != null) runtime.minDeployUsdc = n('minDeployUsdc')!;
  if (n('deployRatioTolerance') != null) runtime.deployRatioTolerance = n('deployRatioTolerance')!;
  if (n('pullbackThresholdPct') != null) runtime.pullbackThresholdPct = n('pullbackThresholdPct')!;
  if (n('timeoutHours') != null) runtime.timeoutHours = n('timeoutHours')!;
  if (n('flashCrashPct') != null) runtime.flashCrashPct = n('flashCrashPct')!;
  if (n('flashCrashWaitMinutes') != null) runtime.flashCrashWaitMinutes = n('flashCrashWaitMinutes')!;
  if (n('dailyLossLimitPct') != null) runtime.dailyLossLimitPct = n('dailyLossLimitPct')!;
  if (n('weeklyDrawdownLimitPct') != null) runtime.weeklyDrawdownLimitPct = n('weeklyDrawdownLimitPct')!;
  if (n('maxIlPct') != null) runtime.maxIlPct = n('maxIlPct')!;
  if (n('rebalanceLoopLimit') != null) runtime.rebalanceLoopLimit = n('rebalanceLoopLimit')!;

  const rwo = g('rangeWidthOverride');
  if (rwo != null) runtime.rangeWidthOverride = rwo === 'null' || rwo === '' ? null : parseFloat(rwo);

  // Regime params
  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      const key = `regime.${regime}.${field}`;
      const val = n(key);
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
  out['rangeWidthOverride'] = runtime.rangeWidthOverride != null ? String(runtime.rangeWidthOverride) : 'null';

  for (const regime of REGIME_KEYS) {
    for (const field of REGIME_PARAM_FIELDS) {
      out[`regime.${regime}.${field}`] = String((runtime.regimeParams[regime] as any)[field]);
    }
  }

  return out;
}
