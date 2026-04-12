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
  const logReturns = prices.slice(1).map((p, i) => {
    if (prices[i] <= 0) return 0;
    return Math.log(p / prices[i]);
  });
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

  const logReturns = prices.slice(1).map((p, i) => {
    if (prices[i] <= 0) return 0;
    return Math.log(p / prices[i]);
  });
  const realisedVol = stdDev(logReturns);

  if (!isFinite(realisedVol) || realisedVol > 0.08) return 'EXTREME';
  if (dirRatio > trendThreshold) {
    return prices[last] > prices[0] ? 'BULLISH_TREND' : 'BEARISH_TREND';
  }
  return 'RANGING';
}

export function getRegimeParams(regime: Regime): RegimeParams {
  return REGIME_PARAMS[regime];
}

// ── Enhanced Regime Detection (market data signals) ─────────────────────

import type { MarketSignals } from '../data/market.js';

export interface EnhancedRegimeResult extends RegimeResult {
  baseRegime: Regime;           // regime from daily closes alone
  overrideReason: string | null; // why it was overridden (null = no override)
  confidence: number;            // 0-5, how many signals agree
  signals: {
    vol1h: number | null;
    vol4h: number | null;
    solDelta24h: number | null;
    btcDelta24h: number | null;
    volumeRatio4h: number | null;
    fearGreedIndex: number | null;
  };
}

export interface EnhancedRegimeConfig {
  vol1hExtremeThreshold: number;   // 1h vol above this → EXTREME (default 0.06)
  vol4hExtremeThreshold: number;   // 4h vol above this + volume spike → EXTREME (default 0.05)
  volumeSpikeMultiple: number;     // volume ratio above this = spike (default 3)
  trendDeltaThreshold: number;     // |SOL delta| above this % + volume spike → trend (default 4)
  btcCorrelationThreshold: number; // |BTC delta| above this % = macro move (default 3)
  fearGreedExtremeLow: number;     // F&G below this = extreme fear (default 25)
  fearGreedExtremeHigh: number;    // F&G above this = extreme greed (default 75)
}

export const DEFAULT_ENHANCED_CONFIG: EnhancedRegimeConfig = {
  vol1hExtremeThreshold: 0.06,
  vol4hExtremeThreshold: 0.05,
  volumeSpikeMultiple: 3,
  trendDeltaThreshold: 4,
  btcCorrelationThreshold: 3,
  fearGreedExtremeLow: 25,
  fearGreedExtremeHigh: 75,
};

export function detectRegimeEnhanced(
  prices: number[],
  trendThreshold: number,
  marketSignals: MarketSignals | null,
  config: EnhancedRegimeConfig = DEFAULT_ENHANCED_CONFIG,
): EnhancedRegimeResult {
  // Step 1: base regime from daily closes (existing logic)
  const base = detectRegimeWithMetrics(prices, trendThreshold);

  // If no market signals available, return base with no override
  if (!marketSignals) {
    return {
      ...base,
      baseRegime: base.regime,
      overrideReason: null,
      confidence: 0,
      signals: { vol1h: null, vol4h: null, solDelta24h: null, btcDelta24h: null, volumeRatio4h: null, fearGreedIndex: null },
    };
  }

  const { vol1h, vol4h, solDelta24h, btcDelta24h, volumeRatio4h, fearGreedIndex } = marketSignals;
  let regime = base.regime;
  let overrideReason: string | null = null;
  let confidence = 0;

  // Step 2: EXTREME override — short-term vol spike
  if (vol1h != null && vol1h > config.vol1hExtremeThreshold) {
    if (regime !== 'EXTREME') {
      overrideReason = `1h vol ${vol1h.toFixed(4)} > ${config.vol1hExtremeThreshold} threshold`;
      regime = 'EXTREME';
    }
    confidence++;
  }

  // Step 3: EXTREME override — medium-term vol + volume spike
  if (vol4h != null && vol4h > config.vol4hExtremeThreshold && volumeRatio4h != null && volumeRatio4h > config.volumeSpikeMultiple) {
    if (regime !== 'EXTREME') {
      overrideReason = `4h vol ${vol4h.toFixed(4)} > ${config.vol4hExtremeThreshold} AND volume spike ${volumeRatio4h.toFixed(1)}x > ${config.volumeSpikeMultiple}x`;
      regime = 'EXTREME';
    }
    confidence++;
  }

  // Step 4: TREND override — large SOL move + volume confirms
  if (solDelta24h != null && volumeRatio4h != null && volumeRatio4h > 2 && regime === 'RANGING') {
    if (solDelta24h > config.trendDeltaThreshold) {
      overrideReason = `SOL +${solDelta24h.toFixed(1)}% with ${volumeRatio4h.toFixed(1)}x volume → BULLISH`;
      regime = 'BULLISH_TREND';
    } else if (solDelta24h < -config.trendDeltaThreshold) {
      overrideReason = `SOL ${solDelta24h.toFixed(1)}% with ${volumeRatio4h.toFixed(1)}x volume → BEARISH`;
      regime = 'BEARISH_TREND';
    }
  }

  // Step 5: BTC correlation check — macro move amplifies confidence
  if (btcDelta24h != null && solDelta24h != null) {
    const btcAbs = Math.abs(btcDelta24h);
    if (btcAbs > config.btcCorrelationThreshold) {
      const sameDirection = (btcDelta24h > 0 && solDelta24h > 0) || (btcDelta24h < 0 && solDelta24h < 0);
      if (sameDirection) {
        confidence++; // correlated macro move confirms the regime
      }
    }
  }

  // Step 6: Fear & Greed as tiebreaker / confidence boost
  if (fearGreedIndex != null) {
    if (fearGreedIndex < config.fearGreedExtremeLow) {
      // Extreme fear — confirms BEARISH/EXTREME
      if (regime === 'BEARISH_TREND' || regime === 'EXTREME') confidence++;
      // Override RANGING to BEARISH if fear is extreme and SOL is dropping
      if (regime === 'RANGING' && solDelta24h != null && solDelta24h < -2) {
        overrideReason = `F&G extreme fear (${fearGreedIndex}) + SOL ${solDelta24h.toFixed(1)}% → BEARISH`;
        regime = 'BEARISH_TREND';
      }
    } else if (fearGreedIndex > config.fearGreedExtremeHigh) {
      // Extreme greed — confirms BULLISH
      if (regime === 'BULLISH_TREND') confidence++;
    }
    // Neutral zone adds confidence to RANGING
    if (fearGreedIndex >= 40 && fearGreedIndex <= 60 && regime === 'RANGING') confidence++;
  }

  // Step 7: Volume confirms current regime
  if (volumeRatio4h != null) {
    if (volumeRatio4h < 1.5 && regime === 'RANGING') confidence++;
    if (volumeRatio4h > 2 && (regime === 'BULLISH_TREND' || regime === 'BEARISH_TREND' || regime === 'EXTREME')) confidence++;
  }

  // Cap confidence at 5
  confidence = Math.min(confidence, 5);

  return {
    regime,
    dirRatio: base.dirRatio,
    realisedVol: base.realisedVol,
    priceCount: base.priceCount,
    baseRegime: base.regime,
    overrideReason,
    confidence,
    signals: { vol1h, vol4h, solDelta24h, btcDelta24h, volumeRatio4h, fearGreedIndex },
  };
}
