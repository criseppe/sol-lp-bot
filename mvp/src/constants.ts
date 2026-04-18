// Hardcoded constants — these never come from env vars

export const PROGRAM_IDS = {
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  PYTH_PROGRAM:   'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH',
} as const;

export const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

// Regime parameter map — all rule thresholds by regime
export const REGIME_PARAMS = {
  RANGING: {
    rangeWidthPct:        1.5,
    skewDown:             0.30,
    skewUp:               0.70,
    proxThresholdLower:   0.72,
    proxThresholdUpper:   0.88,
    deployPct:            1.00,
    solReentrySplit:      0.50,
    harvestIntervalDays:  7,
    harvestSolConvertPct: 0.50,
    usdcDepositPct:       0.35,
    deployRatioTolerance: 0.020,
    basisGateThreshold:   0.995,
    proximityDeployThreshold: 0.40,
    reserveFloorPct: 0.10,
  },
  BULLISH_TREND: {
    rangeWidthPct:        3,
    skewDown:             0.25,
    skewUp:               0.75,
    proxThresholdLower:   0.80,
    proxThresholdUpper:   0.92,
    deployPct:            0.85,
    solReentrySplit:      0.50,
    harvestIntervalDays:  4,
    harvestSolConvertPct: 0.70,
    usdcDepositPct:       0.30,
    deployRatioTolerance: 0.035,
    basisGateThreshold:   0.995,
    proximityDeployThreshold: 0.55,
    reserveFloorPct: 0.12,
  },
  BEARISH_TREND: {
    rangeWidthPct:        2,
    skewDown:             0.45,
    skewUp:               0.55,
    proxThresholdLower:   0.55,
    proxThresholdUpper:   0.82,
    deployPct:            0.75,
    solReentrySplit:      0.30,
    harvestIntervalDays:  2,
    harvestSolConvertPct: 1.00,
    usdcDepositPct:       0.40,
    deployRatioTolerance: 0.030,
    basisGateThreshold:   0.992,
    proximityDeployThreshold: 0.55,
    reserveFloorPct: 0.18,
  },
  EXTREME: {
    rangeWidthPct:        5,
    skewDown:             0.50,
    skewUp:               0.50,
    proxThresholdLower:   0.50,
    proxThresholdUpper:   0.80,
    deployPct:            0.25,
    solReentrySplit:      0.20,
    harvestIntervalDays:  1,
    harvestSolConvertPct: 1.00,
    usdcDepositPct:       0.50,
    deployRatioTolerance: 0.050,
    basisGateThreshold:   0.995,
    proximityDeployThreshold: 0.40,
    reserveFloorPct: 0.20,
  },
} as const;

// Regime transition rules for smart reopen logic
export interface RegimeTransitionRule {
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  stableMinutes: number;
  widthThreshold: number;
}

export const REGIME_TRANSITION_RULES: Record<string, RegimeTransitionRule> = {
  'RANGING→BULLISH_TREND':        { urgency: 'LOW',      stableMinutes: 30, widthThreshold: 1.4 },
  'RANGING→BEARISH_TREND':        { urgency: 'HIGH',     stableMinutes: 10, widthThreshold: 1.2 },
  'RANGING→EXTREME':              { urgency: 'CRITICAL', stableMinutes: 5,  widthThreshold: 1.0 },
  'BULLISH_TREND→RANGING':        { urgency: 'MEDIUM',   stableMinutes: 20, widthThreshold: 1.3 },
  'BULLISH_TREND→BEARISH_TREND':  { urgency: 'CRITICAL', stableMinutes: 5,  widthThreshold: 1.0 },
  'BULLISH_TREND→EXTREME':        { urgency: 'CRITICAL', stableMinutes: 5,  widthThreshold: 1.0 },
  'BEARISH_TREND→RANGING':        { urgency: 'LOW',      stableMinutes: 30, widthThreshold: 1.4 },
  'BEARISH_TREND→BULLISH_TREND':  { urgency: 'HIGH',     stableMinutes: 10, widthThreshold: 1.2 },
  'BEARISH_TREND→EXTREME':        { urgency: 'CRITICAL', stableMinutes: 5,  widthThreshold: 1.0 },
  'EXTREME→RANGING':              { urgency: 'HIGH',     stableMinutes: 10, widthThreshold: 1.2 },
  'EXTREME→BULLISH_TREND':        { urgency: 'HIGH',     stableMinutes: 10, widthThreshold: 1.2 },
  'EXTREME→BEARISH_TREND':        { urgency: 'CRITICAL', stableMinutes: 5,  widthThreshold: 1.0 },
};

// Jupiter aggregator
export const JUPITER = {
  QUOTE_API:      'https://api.jup.ag/swap/v1/quote',
  SWAP_API:       'https://api.jup.ag/swap/v1/swap',
  TIMEOUT_MS:     10_000,
  RETRY_DELAY_MS: 2_000,
  MAX_RETRIES:    1,
} as const;

// Circuit breaker thresholds
export const RISK = {
  DAILY_LOSS_LIMIT_PCT:      5,
  WEEKLY_DRAWDOWN_LIMIT_PCT: 15,
  MAX_IL_PCT:                8,
  REBALANCE_LOOP_LIMIT:      10,    // max rebalances per hour
  MIN_POSITION_SIZE_USDC:    100,
} as const;

// Rule 3 re-entry config
export const REENTRY = {
  PULLBACK_THRESHOLD_PCT:    2.5,
  TIMEOUT_HOURS:             4,      // 4 hours before timeout re-entry
  FLASH_CRASH_PCT:           5,     // single candle drop
  FLASH_CRASH_WAIT_MINUTES:  15,
} as const;
