import type { Regime, RegimeParams, PaperPosition, ProximityState, RangeBounds } from '../types.js';
import { REGIME_PARAMS, REENTRY } from '../constants.js';

// No imports from data/ or db/ — all functions are pure

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
  dailyILRate: number,
  gasCost: number,
): boolean {
  const projectedIL = Math.abs(dailyILRate) * 4;
  return prox.proxToLower >= threshold || projectedIL > gasCost;
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
  if (pullbackPct >= REENTRY.PULLBACK_THRESHOLD_PCT) {
    return { should: true, reason: 'PULLBACK' };
  }
  if (hoursWaiting >= REENTRY.TIMEOUT_HOURS) {
    return { should: true, reason: 'TIMEOUT' };
  }
  return { should: false, reason: 'WAITING' };
}

export function isFlashCrash(prices: number[]): boolean {
  if (prices.length < 2) return false;
  if (prices[0] <= 0) return false;
  const drop = ((prices[0] - prices[prices.length - 1]) / prices[0]) * 100;
  return drop >= REENTRY.FLASH_CRASH_PCT;
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
  feeRate = 3000,
): HarvestEstimate {
  const feePct = feeRate / 1_000_000; // e.g. 3000 → 0.003 (0.30%)
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
}): AutoDeployCheck {
  const {
    currentPrice, priceLower, priceUpper,
    walletSol, walletUsdc, positionValueUsdc,
    regime, params, lastDeployTime, now, enabled,
    minIdleUsdc, minIdleSol, minDeployUsdc, deployRatioTolerance,
  } = opts;

  const solReserve = 0.05;
  const usdcReserve = 1;
  const idleSol = Math.max(0, walletSol - solReserve);
  const idleUsdcRaw = Math.max(0, walletUsdc - usdcReserve);
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

  // BR-3: Never deploy in BEARISH_TREND or EXTREME
  if (regime === 'BEARISH_TREND' || regime === 'EXTREME') {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_REGIME: ${regime} blocks additional deployment`, ...base };
  }

  // BR-1: Check meaningful idle funds
  if (idleSol < minIdleSol && idleUsdcRaw < minIdleUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_LOW_IDLE: SOL=${idleSol.toFixed(4)} < ${minIdleSol}, USDC=${idleUsdcRaw.toFixed(2)} < ${minIdleUsdc}`, ...base };
  }

  // BR-6: Cooldown — max one per hour
  const hoursSinceLast = (now - lastDeployTime) / 3600_000;
  if (hoursSinceLast < 1) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_COOLDOWN: ${(60 - hoursSinceLast * 60).toFixed(0)}min remaining`, ...base };
  }

  // BR-3: Check regime capital cap
  if (headroom < minDeployUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_CAP: position $${positionValueUsdc.toFixed(2)} already at ${(params.deployPct * 100).toFixed(0)}% cap ($${maxDeployUsdc.toFixed(2)}), headroom $${headroom.toFixed(2)} < min $${minDeployUsdc}`, ...base };
  }

  // BR-4: Minimum deploy size
  if (deployableUsdc < minDeployUsdc) {
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_DUST: deployable $${deployableUsdc.toFixed(2)} < min $${minDeployUsdc}`, ...base };
  }

  // BR-2: Price must be near geometric mean (optimal capital split)
  const priceRatio = currentPrice / idealPrice;
  const deviation = Math.abs(priceRatio - 1);
  if (deviation > deployRatioTolerance) {
    const dir = currentPrice > idealPrice ? 'above' : 'below';
    return { shouldDeploy: false, reason: `DEPLOY_SKIPPED_RATIO: price $${currentPrice.toFixed(2)} is ${(deviation * 100).toFixed(1)}% ${dir} ideal $${idealPrice.toFixed(2)} (tolerance: ${(deployRatioTolerance * 100).toFixed(1)}%)`, ...base };
  }

  return {
    shouldDeploy: true,
    reason: `AUTO_DEPLOY: idle $${deployableUsdc.toFixed(2)}, price $${currentPrice.toFixed(2)} within ${(deployRatioTolerance * 100).toFixed(1)}% of ideal $${idealPrice.toFixed(2)}, regime ${regime} cap ${(params.deployPct * 100).toFixed(0)}%`,
    ...base,
  };
}

// ── IL Calculator ─────────────────────────────────────────────────────────

export function calcIL(
  entryPrice: number,
  currentPrice: number,
  initialSol: number,
  initialUsdc: number,
): number {
  const k = initialSol * initialUsdc;
  const lpValue = 2 * Math.sqrt(k * currentPrice);
  const holdValue = initialSol * currentPrice + initialUsdc;
  return lpValue - holdValue; // negative = loss vs hold
}
