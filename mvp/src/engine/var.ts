/**
 * VAR — Volatility-Adaptive Range
 * SIR — Smart Idle Rebalancing
 *
 * Replaces static regime-based params with continuous volatility-driven formulas.
 * Both features are behind feature flags (varEnabled / sirEnabled).
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface VarConfig {
  enabled: boolean;
  multiplier: number;        // k, default 3.0
  targetHours: number;       // default 2
  minWidth: number;          // 1.0%
  maxWidth: number;          // 6.0%
  adjustThreshold: number;   // 0.30 (30% deviation to trigger range change)
  minPositionAge: number;    // 15 min
  cooldownMinutes: number;   // 10
}

export interface SirConfig {
  enabled: boolean;
  cooldownMinutes: number;   // 5
  triggerThreshold: number;  // 0.08 (8% deviation)
  minSwapUsdc: number;       // 20
  trendMultiplier: number;   // 0.05
  maxSolPct: number;         // 0.75
  minSolPct: number;         // 0.15
}

export interface VarParams {
  targetWidth: number;
  proxThresholdLower: number;
  proxThresholdUpper: number;
  skewDown: number;
  skewUp: number;
  deployPct: number;
}

export interface SirResult {
  swap: boolean;
  direction: 'buy_sol' | 'sell_sol';
  amountUsdc: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ── VAR: Volatility-Adaptive Range ──────────────────────────────────────

/**
 * Calculate dynamic params from current volatility and trend.
 * @param vol1h  — 1-hour realised volatility (decimal, e.g. 0.003)
 * @param solDelta24h — SOL 24h price change in % (e.g. -4.0)
 */
export function calculateVarParams(vol1h: number, solDelta24h: number, config: VarConfig): VarParams {
  // Width: k * vol * sqrt(hours) * 100 → percentage
  const rawWidth = config.multiplier * vol1h * Math.sqrt(config.targetHours) * 100;
  const targetWidth = clamp(rawWidth, config.minWidth, config.maxWidth);

  // Thresholds: tighter range → wider thresholds (use almost all of it)
  const thresholdBase = 0.60 + ((config.maxWidth - targetWidth) / config.maxWidth) * 0.30;
  const proxThreshold = clamp(thresholdBase, 0.60, 0.92);

  // Skew: bearish → more range below, bullish → more range above
  // solDelta24h is percentage like -4.0 or +2.5
  const skewDown = clamp(0.50 - (solDelta24h / 100) * 2.5, 0.30, 0.60);
  const skewUp = 1 - skewDown;

  // Deploy: calmer market → deploy more
  const deployPct = clamp(0.95 - vol1h * 5, 0.25, 0.90);

  return {
    targetWidth,
    proxThresholdLower: proxThreshold,
    proxThresholdUpper: proxThreshold,
    skewDown,
    skewUp,
    deployPct,
  };
}

/**
 * Should we close+reopen with a new range width?
 * Returns true only when ALL conditions are met.
 */
export function shouldAdjustRange(
  currentWidth: number,
  targetWidth: number,
  proxToNearest: number,
  positionAgeMin: number,
  lastAdjustTime: number,
  now: number,
  config: VarConfig,
): boolean {
  // Width deviation must exceed threshold
  const widthDeviation = Math.abs(currentWidth - targetWidth) / currentWidth;
  if (widthDeviation < config.adjustThreshold) return false;

  // Price must be near center (low proximity to nearest bound)
  if (proxToNearest > 0.40) return false;

  // Position must be old enough
  if (positionAgeMin < config.minPositionAge) return false;

  // Cooldown since last adjustment
  if (now - lastAdjustTime < config.cooldownMinutes * 60_000) return false;

  return true;
}

// ── SIR: Smart Idle Rebalancing ─────────────────────────────────────────

/**
 * Calculate target SOL % for idle wallet.
 * Based on what the next position open would need + trend bias.
 * @param solDelta4h — SOL 4h price change in % (e.g. -2.0)
 */
export function calculateIdleTarget(
  _price: number,
  _width: number,
  _skewDown: number,
  solDelta4h: number,
  config: SirConfig,
): number {
  // Base: LP deposit ratio at range center is roughly 50/50
  const depositRatio = 0.50;

  // Trend bias: hold more of what's appreciating
  const trendBias = clamp((solDelta4h / 100) * config.trendMultiplier, -0.10, 0.10);

  return clamp(depositRatio + trendBias, config.minSolPct, config.maxSolPct);
}

/**
 * Should we rebalance idle wallet? Returns swap direction and amount.
 */
export function shouldRebalanceIdle(
  currentSolPct: number,
  targetSolPct: number,
  idleTotalUsdc: number,
  config: SirConfig,
): SirResult {
  const noSwap: SirResult = { swap: false, direction: 'buy_sol', amountUsdc: 0 };

  // Not enough idle capital to bother
  if (idleTotalUsdc < config.minSwapUsdc * 2) return noSwap;

  const deviation = currentSolPct - targetSolPct;

  // Deviation too small
  if (Math.abs(deviation) < config.triggerThreshold) return noSwap;

  // Calculate swap amount
  const amountUsdc = Math.abs(deviation) * idleTotalUsdc;

  // Swap too small
  if (amountUsdc < config.minSwapUsdc) return noSwap;

  return {
    swap: true,
    direction: deviation > 0 ? 'sell_sol' : 'buy_sol',
    amountUsdc,
  };
}
