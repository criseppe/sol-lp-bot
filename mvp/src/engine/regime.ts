import type { Regime, RegimeParams } from '../types.js';
import { REGIME_PARAMS } from '../constants.js';

export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map(v => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Detect market regime from daily closing prices.
 *
 * INPUT CONTRACT:
 * prices must be DAILY closing prices, one per calendar day, oldest first.
 * Always sourced from getDailyCloses(db, REGIME_WINDOW_DAYS).
 * NEVER pass raw 30-second price_ticks.
 */
export interface RegimeResult {
  regime: Regime;
  dirRatio: number;
  realisedVol: number;
  priceCount: number;
}

export function detectRegimeWithMetrics(prices: number[], trendThreshold = 0.35): RegimeResult {
  const regime = detectRegime(prices, trendThreshold);
  if (prices.length < 3) return { regime, dirRatio: 0, realisedVol: 0, priceCount: prices.length };

  const last = prices.length - 1;
  const netMove = Math.abs(prices[last] - prices[0]);
  let totalPath = 0;
  for (let i = 1; i <= last; i++) totalPath += Math.abs(prices[i] - prices[i - 1]);
  const dirRatio = totalPath === 0 ? 0 : netMove / totalPath;
  const logReturns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const realisedVol = stdDev(logReturns);
  return { regime, dirRatio, realisedVol, priceCount: prices.length };
}

export function detectRegime(prices: number[], trendThreshold = 0.35): Regime {
  if (prices.length < 3) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'insufficient data for regime detection, defaulting to RANGING',
      priceCount: prices.length,
      timestamp: Date.now(),
    }));
    return 'RANGING';
  }

  const last = prices.length - 1;
  const netMove = Math.abs(prices[last] - prices[0]);
  let totalPath = 0;
  for (let i = 1; i <= last; i++) {
    totalPath += Math.abs(prices[i] - prices[i - 1]);
  }
  const dirRatio = totalPath === 0 ? 0 : netMove / totalPath;

  const logReturns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const realisedVol = stdDev(logReturns);

  if (realisedVol > 0.08) return 'EXTREME';
  if (dirRatio > trendThreshold) {
    return prices[last] > prices[0] ? 'BULLISH_TREND' : 'BEARISH_TREND';
  }
  return 'RANGING';
}

export function getRegimeParams(regime: Regime): RegimeParams {
  return REGIME_PARAMS[regime];
}
