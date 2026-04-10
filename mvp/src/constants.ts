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
    proxThresholdLower:   0.65,
    proxThresholdUpper:   0.88,
    deployPct:            1.00,
    solReentrySplit:      0.50,
    harvestIntervalDays:  7,
    harvestSolConvertPct: 0.00,
  },
  BULLISH_TREND: {
    rangeWidthPct:        3,
    skewDown:             0.20,
    skewUp:               0.80,
    proxThresholdLower:   0.70,
    proxThresholdUpper:   0.92,
    deployPct:            0.85,
    solReentrySplit:      0.50,
    harvestIntervalDays:  4,
    harvestSolConvertPct: 0.70,
  },
  BEARISH_TREND: {
    rangeWidthPct:        4,
    skewDown:             0.40,
    skewUp:               0.60,
    proxThresholdLower:   0.55,
    proxThresholdUpper:   0.82,
    deployPct:            0.50,
    solReentrySplit:      0.30,
    harvestIntervalDays:  2,
    harvestSolConvertPct: 1.00,
  },
  EXTREME: {
    rangeWidthPct:        6,
    skewDown:             0.50,
    skewUp:               0.50,
    proxThresholdLower:   0.50,
    proxThresholdUpper:   0.80,
    deployPct:            0.25,
    solReentrySplit:      0.20,
    harvestIntervalDays:  1,
    harvestSolConvertPct: 1.00,
  },
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
  TIMEOUT_HOURS:             0.083,  // ~5 minutes (for testing)
  FLASH_CRASH_PCT:           5,     // single candle drop
  FLASH_CRASH_WAIT_MINUTES:  15,
} as const;
