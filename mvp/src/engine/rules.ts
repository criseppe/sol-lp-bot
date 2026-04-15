import type { Regime, RegimeParams, PaperPosition, ProximityState, RangeBounds } from '../types.js';
import { REGIME_PARAMS, REENTRY } from '../constants.js';
import { runtime } from '../config.js';

export interface ReentryDecision {
  should: boolean;
  reason: 'PULLBACK' | 'TIMEOUT' | 'WAITING';
}

export interface DeployAmount {
  deployUsdc: number;
  reserveUsdc: number;
}

export interface HarvestEstimate {
  solFees: number;
  usdcFees: number;
  totalUsdcValue: number;
}

// MVP estimated constants for fee harvest
const EST_POOL_DAILY_VOLUME = 500_000_000;
const EST_POOL_TVL = 250_000_000;

// ─── RULE 1: Asymmetric Range Calculator ──────────────────────────────────

export function calcRange(
  currentPrice: number,
  params: RegimeParams,
  priceToTick: (price: number) => number,
  priceToTickLower?: (price: number) => number,
  priceToTickUpper?: (price: number) => number,
): RangeBounds {
  const lower = currentPrice * (1 - (params.rangeWidthPct / 100) * params.skewDown);
  const upper = currentPrice * (1 + (params.rangeWidthPct / 100) * params.skewUp);
  return {
    tickLower: (priceToTickLower ?? priceToTick)(lower),
    tickUpper: (priceToTickUpper ?? priceToTick)(upper),
    priceLower: lower,
    priceUpper: upper,
  };
}

// ─── RULE 2: Proximity Calculator ────────────────────────────────────────

export function calcProximity(currentPrice: number, position: PaperPosition): ProximityState {
  const centre = (position.priceLower + position.priceUpper) / 2;
  const halfWidth = (position.priceUpper - position.priceLower) / 2;
  if (halfWidth <= 0) {
    return { proxToLower: 0, proxToUpper: 0, inRange: false, centre };
  }
  const proxToLower = Math.max(0, (centre - currentPrice) / halfWidth);
  const proxToUpper = Math.max(0, (currentPrice - centre) / halfWidth);
  const inRange = currentPrice >= position.priceLower && currentPrice <= position.priceUpper;
  return { proxToLower, proxToUpper, inRange, centre };
}

export function shouldFireDownside(
  prox: ProximityState,
  threshold: number,
  _dailyILRate?: number,
  _gasCost?: number,
): boolean {
  return prox.proxToLower >= threshold;
}

export function shouldFireUpside(prox: ProximityState, threshold: number): boolean {
  return prox.proxToUpper >= threshold;
}

// ─── RULE 3: Re-entry Timing ──────────────────────────────────────────────

export function shouldReenterAfterUpside(
  currentPrice: number,
  peakPrice: number,
  watchStartTime: number,
  now: number,
): ReentryDecision {
  if (peakPrice <= 0) return { should: true, reason: 'TIMEOUT' };
  const pullbackPct = ((peakPrice - currentPrice) / peakPrice) * 100;
  const hoursWaiting = (now - watchStartTime) / 3600000;
  if (pullbackPct >= runtime.pullbackThresholdPct) {
    return { should: true, reason: 'PULLBACK' };
  }
  if (hoursWaiting >= runtime.timeoutHours) {
    return { should: true, reason: 'TIMEOUT' };
  }
  return { should: false, reason: 'WAITING' };
}

/**
 * Detect flash crash using max drawdown within the price window,
 * not just endpoint-to-endpoint. A 5% drop followed by 3% recovery
 * still registers as a 5% crash (peak-to-trough), not a 2% drop.
 */
export function isFlashCrash(prices: number[]): boolean {
  if (prices.length < 2) return false;
  let peak = prices[0];
  let maxDrawdownPct = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    if (peak > 0) {
      const drawdown = ((peak - p) / peak) * 100;
      if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    }
  }
  return maxDrawdownPct >= runtime.flashCrashPct;
}

// ─── RULE 4: Re-entry Split ───────────────────────────────────────────────

export function getDownsideReentrySplit(regime: Regime): number {
  return REGIME_PARAMS[regime].solReentrySplit;
}

// ─── RULE 5: Position Sizing ─────────────────────────────────────────────

export function getDeployAmount(totalCapital: number, params: RegimeParams): DeployAmount {
  return {
    deployUsdc: totalCapital * params.deployPct,
    reserveUsdc: totalCapital * (1 - params.deployPct),
  };
}

// ─── RULE 6: Fee Harvest ─────────────────────────────────────────────────

export function isHarvestDue(lastHarvestTime: number, params: RegimeParams, now: number): boolean {
  const daysSinceHarvest = (now - lastHarvestTime) / 86400000;
  return daysSinceHarvest >= params.harvestIntervalDays;
}

export function calcHarvestFees(
  position: PaperPosition,
  currentPrice: number,
  daysHeld: number,
  poolDailyVolume = EST_POOL_DAILY_VOLUME,
  poolTvl = EST_POOL_TVL,
  feeRate = 400,
): HarvestEstimate {
  const feePct = feeRate / 1_000_000; // e.g. 400 → 0.0004 (0.04%)
  const positionValue = position.solAmount * currentPrice + position.usdcAmount;
  if (poolTvl <= 0) return { solFees: 0, usdcFees: 0, totalUsdcValue: 0 };
  const positionShare = positionValue / poolTvl;
  const dailyFees = positionShare * poolDailyVolume * feePct;
  const totalFees = dailyFees * daysHeld;
  const solFees = totalFees * 0.5;
  const usdcFees = totalFees * 0.5;
  return { solFees, usdcFees, totalUsdcValue: totalFees };
}

// ─── RULE 7: Auto Capital Deployment ────────────────────────────────────────

export interface AutoDeployCheck {
  shouldDeploy: boolean;
  reason: string;
  idleUsdc: number;
  idealPrice: number;
  currentDeployPct: number;
  maxDeployUsdc: number;
  deployableUsdc: number;
}

/**
 * Check if idle wallet capital should be auto-deployed into an existing position.
 * Returns a decision with reasoning for logging.
 */
export function checkAutoDeploy(opts: {
  currentPrice: number;
  priceLower: number;
  priceUpper: number;
  walletSol: number;
  walletUsdc: number;
  positionValueUsdc: number;
  regime: Regime;
  params: RegimeParams;
  lastDeployTime: number;
  now: number;
  enabled: boolean;
  minIdleUsdc: number;
  minIdleSol: number;
  minDeployUsdc: number;
  deployRatioTolerance: number;
  reserveFloor: number;
}): AutoDeployCheck {
  const {
    currentPrice, priceLower, priceUpper,
    walletSol, walletUsdc, positionValueUsdc,
    regime, params, lastDeployTime, now, enabled,
    minIdleUsdc, minIdleSol, minDeployUsdc, deployRatioTolerance,
    reserveFloor,
  } = opts;

  const solReserve = runtime.solReserve;
  const idleSol = Math.max(0, walletSol - solReserve);
  const idleUsdcRaw = Math.max(0, walletUsdc - reserveFloor);
  const idleUsdc = idleSol * currentPrice + idleUsdcRaw;
  const idealPrice = Math.sqrt(priceLower * priceUpper);
  const totalValueUsdc = idleUsdc + positionValueUsdc;
  const maxDeployUsdc = totalValueUsdc * params.deployPct;
  const headroom = maxDeployUsdc - positionValueUsdc;
  const deployableUsdc = Math.min(idleUsdc, Math.max(0, headroom));

  const base = { idleUsdc, idealPrice, currentDeployPct: params.deployPct, maxDeployUsdc, deployableUsdc };

  if (!enabled) {
    return { shouldDeploy: false, reason: 'DEPLOY_SKIPPED_DISABLED', ...base };
  }

  // BR-3: Block auto-deploy in EXTREME only (survival mode, 25% cap is deliberate)
  // BEARISH is allowed — deploy cap (75%) limits exposure, protection comes from fast harvest + SOL→USDC
  if (regime === 'EXTREME') {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_REGIME: ${regime} blocks additional deployment`, ...base };
  }

  // BR-1: Check meaningful idle funds
  if (idleSol < minIdleSol && idleUsdcRaw < minIdleUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_LOW_IDLE: SOL=${idleSol.toFixed(4)} < ${minIdleSol}, USDC=${idleUsdcRaw.toFixed(2)} < ${minIdleUsdc}`, ...base };
  }

  // BR-6: Cooldown
  const cooldownMin = runtime.autoDeployCooldownMinutes;
  const minSinceLast = (now - lastDeployTime) / 60_000;
  if (minSinceLast < cooldownMin) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_COOLDOWN: ${(cooldownMin - minSinceLast).toFixed(0)}min remaining`, ...base };
  }

  // BR-3: Check regime capital cap
  if (headroom < minDeployUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_CAP: position $${positionValueUsdc.toFixed(2)} already at ${(params.deployPct * 100).toFixed(0)}% cap ($${maxDeployUsdc.toFixed(2)}), headroom $${headroom.toFixed(2)} < min $${minDeployUsdc}`, ...base };
  }

  // BR-4: Minimum deploy size
  if (deployableUsdc < minDeployUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_DUST: deployable $${deployableUsdc.toFixed(2)} < min $${minDeployUsdc}`, ...base };
  }

  // BR-2: Price must be within the position range (can deposit both tokens)
  // Use range midpoint as reference instead of geometric mean — works correctly for skewed ranges
  const rangeMid = (priceLower + priceUpper) / 2;
  const halfRange = (priceUpper - priceLower) / 2;
  const deviation = halfRange > 0 ? Math.abs(currentPrice - rangeMid) / halfRange : 1;
  if (deviation > 1) {
    const dir = currentPrice > rangeMid ? 'above' : 'below';
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_OOR: price $${currentPrice.toFixed(2)} is out of range $${priceLower.toFixed(2)}-$${priceUpper.toFixed(2)}`, ...base };
  }
  // Additionally check price is not too close to edges (need reasonable token split for deposit)
  if (deviation > (1 - deployRatioTolerance)) {
    const dir = currentPrice > rangeMid ? 'near upper' : 'near lower';
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_RATIO: price $${currentPrice.toFixed(2)} is ${dir} edge of range (${(deviation * 100).toFixed(0)}% from center, need <${((1 - deployRatioTolerance) * 100).toFixed(0)}%)`, ...base };
  }

  return {
    shouldDeploy: true,
    reason: `AUTO_DEPLOY: idle $${deployableUsdc.toFixed(2)}, price $${currentPrice.toFixed(2)} within ${(deployRatioTolerance * 100).toFixed(1)}% of ideal $${idealPrice.toFixed(2)}, regime ${regime} cap ${(params.deployPct * 100).toFixed(0)}%`,
    ...base,
  };
}

// ── IL Calculator ─────────────────────────────────────────────────────────

/**
 * Calculate impermanent loss for a concentrated liquidity position.
 * Uses the concentrated LP IL formula: IL% = 2*sqrt(r)/(1+r) - 1
 * where r = currentPrice / entryPrice.
 * Returns USD value of IL (negative = loss vs holding).
 */
export function calcIL(
  entryPrice: number,
  currentPrice: number,
  initialSol: number,
  initialUsdc: number,
): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const holdValue = initialSol * currentPrice + initialUsdc;
  if (holdValue <= 0) return 0;
  const r = currentPrice / entryPrice;
  const ilPct = 2 * Math.sqrt(r) / (1 + r) - 1; // always <= 0
  return ilPct * holdValue; // negative = loss vs hold
}
