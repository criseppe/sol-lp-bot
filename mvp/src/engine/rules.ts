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
): RangeBounds {
  const lower = currentPrice * (1 - (params.rangeWidthPct / 100) * params.skewDown);
  const upper = currentPrice * (1 + (params.rangeWidthPct / 100) * params.skewUp);
  return {
    tickLower: priceToTick(lower),
    tickUpper: priceToTick(upper),
    priceLower: lower,
    priceUpper: upper,
  };
}

// ─── RULE 2: Proximity Calculator ────────────────────────────────────────

export function calcProximity(currentPrice: number, position: PaperPosition): ProximityState {
  const centre = (position.priceLower + position.priceUpper) / 2;
  const halfWidth = (position.priceUpper - position.priceLower) / 2;
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
): HarvestEstimate {
  const feeTier = 0.0005;
  const positionValue = position.solAmount * currentPrice + position.usdcAmount;
  const positionShare = positionValue / poolTvl;
  const dailyFees = positionShare * poolDailyVolume * feeTier;
  const totalFees = dailyFees * daysHeld;
  const solFees = totalFees * 0.5;
  const usdcFees = totalFees * 0.5;
  return { solFees, usdcFees, totalUsdcValue: totalFees };
}

// ─── IL Calculator ─────────────────────────────────────────────────────────

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
