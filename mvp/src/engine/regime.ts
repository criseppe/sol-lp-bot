import type { Regime, RegimeParams } from '../types.js';
import { REGIME_PARAMS } from '../constants.js';
import type { TechnicalAnalysis, MarketSignals } from '../data/market.js';

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

  // Step 1b: Refine base EXTREME using vol4h (42 data points) instead of daily close vol (2-3 points)
  // vol4h is statistically more robust — use it to correct false EXTREME or detect missed EXTREME
  if (vol4h != null) {
    if (base.regime === 'EXTREME' && vol4h < config.vol4hExtremeThreshold * 0.8) {
      // Base said EXTREME from sparse daily data, but 4h vol disagrees — downgrade to trend or ranging
      const prices_up = base.priceCount >= 2 && base.dirRatio > trendThreshold;
      regime = prices_up ? (solDelta24h != null && solDelta24h > 0 ? 'BULLISH_TREND' : 'BEARISH_TREND') : 'RANGING';
      overrideReason = `Base EXTREME downgraded to ${regime}: vol4h ${vol4h.toFixed(4)} < ${(config.vol4hExtremeThreshold * 0.8).toFixed(4)} — daily close vol was misleading with only ${base.priceCount} data points`;
    } else if (base.regime !== 'EXTREME' && vol4h > config.vol4hExtremeThreshold) {
      // 4h vol says EXTREME but base missed it (sparse daily data)
      regime = 'EXTREME';
      overrideReason = `vol4h ${vol4h.toFixed(4)} > ${config.vol4hExtremeThreshold} threshold (base missed with ${base.priceCount} daily closes)`;
      confidence++;
    }
  }

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

  // Step 8: Technical Analysis — RSI, trend, Bollinger confirm/override regime
  const ta = marketSignals.ta;
  if (ta) {
    // RSI overbought + price at resistance → likely reversal, don't stay BULLISH
    if (ta.rsi14 != null && ta.rsi14 > 75 && regime === 'BULLISH_TREND') {
      // Don't override to BEARISH yet, but reduce confidence (momentum fading)
      confidence = Math.max(0, confidence - 1);
      if (!overrideReason) overrideReason = `TA: RSI ${ta.rsi14.toFixed(0)} overbought — bullish momentum may be fading`;
    }

    // RSI oversold + price at support → likely bounce, don't stay BEARISH
    if (ta.rsi14 != null && ta.rsi14 < 25 && regime === 'BEARISH_TREND') {
      confidence = Math.max(0, confidence - 1);
      if (!overrideReason) overrideReason = `TA: RSI ${ta.rsi14.toFixed(0)} oversold — bearish momentum may be exhausting`;
    }

    // EMA/SMA trend confirms direction
    if (ta.trendDirection === 'UP' && (regime === 'BULLISH_TREND' || regime === 'RANGING')) confidence++;
    if (ta.trendDirection === 'DOWN' && (regime === 'BEARISH_TREND' || regime === 'RANGING')) confidence++;

    // Bollinger expansion → volatility increasing, may need wider regime
    if (ta.bbWidth != null && ta.bbWidth > 3.0 && regime === 'RANGING') {
      // Wide Bollinger in RANGING = trending, upgrade
      if (ta.trendDirection === 'UP') {
        regime = 'BULLISH_TREND';
        overrideReason = `TA: Bollinger expanding (${ta.bbWidth.toFixed(1)}%) + EMA>SMA → BULLISH`;
      } else if (ta.trendDirection === 'DOWN') {
        regime = 'BEARISH_TREND';
        overrideReason = `TA: Bollinger expanding (${ta.bbWidth.toFixed(1)}%) + EMA<SMA → BEARISH`;
      }
    }

    // Bollinger squeeze + RANGING → high confidence ranging (consolidation)
    if (ta.bbWidth != null && ta.bbWidth < 1.0 && regime === 'RANGING') {
      confidence++;
    }
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

// ── TA-First Regime Detection ─────────────────────────────────────────────

export interface TaRegimeResult {
  regime: Regime;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  deployMultiplier: number;
  candidateRegime: Regime;
  newCandidateCount: number;
  log: string;
  votes: Record<string, number>;
  vetoFired: boolean;
}

/**
 * detectRegimeTA — primary regime signal using TA indicators.
 * Replaces detectRegimeEnhanced() as the primary signal when TA data is available.
 * dailyRegime (from detectRegime) is used only as a veto — not as a voter.
 */
export function detectRegimeTA(
  ta: TechnicalAnalysis | null,
  marketSignals: MarketSignals | null,
  dailyRegime: Regime | null,
  previousCandidate: Regime | null,
  candidateCount: number,
): TaRegimeResult {
  // ── Tallies ────────────────────────────────────────────────────────────
  const votes: Record<string, number> = { BULLISH_TREND: 0, BEARISH_TREND: 0, RANGING: 0, EXTREME: 0 };

  const voteLog: string[] = [];

  if (ta) {
    // EMA9 vs SMA20 trend (2 points)
    if (ta.trendDirection === 'UP') {
      votes['BULLISH_TREND'] += 2;
      voteLog.push('trend=UP→B+2');
    } else if (ta.trendDirection === 'DOWN') {
      votes['BEARISH_TREND'] += 2;
      voteLog.push('trend=DOWN→Be+2');
    } else if (ta.trendDirection === 'FLAT') {
      votes['RANGING'] += 2;
      voteLog.push('trend=FLAT→R+2');
    }

    // BB Width (2 points)
    if (ta.bbWidth != null) {
      if (ta.bbWidth < 1.5) {
        votes['RANGING'] += 2;
        voteLog.push(`bbW=${ta.bbWidth.toFixed(1)}<1.5→R+2`);
      } else if (ta.bbWidth <= 3.0) {
        // 1pt to trend direction, 1pt to RANGING
        if (ta.trendDirection === 'UP') {
          votes['BULLISH_TREND'] += 1;
          voteLog.push(`bbW=${ta.bbWidth.toFixed(1)}→B+1`);
        } else if (ta.trendDirection === 'DOWN') {
          votes['BEARISH_TREND'] += 1;
          voteLog.push(`bbW=${ta.bbWidth.toFixed(1)}→Be+1`);
        } else {
          votes['RANGING'] += 1;
          voteLog.push(`bbW=${ta.bbWidth.toFixed(1)}→R+1`);
        }
        votes['RANGING'] += 1;
        voteLog.push('bbW_mid→R+1');
      } else {
        // bbWidth > 3.0
        votes['EXTREME'] += 2;
        voteLog.push(`bbW=${ta.bbWidth.toFixed(1)}>3→E+2`);
      }
    }

    // RSI (1 point) — 2-point dead zone at boundaries to reduce flipping
    if (ta.rsi14 != null) {
      if (ta.rsi14 >= 62 && ta.rsi14 <= 75) {
        votes['BULLISH_TREND'] += 1;
        voteLog.push(`rsi=${ta.rsi14.toFixed(0)}→B+1`);
      } else if (ta.rsi14 >= 25 && ta.rsi14 <= 38) {
        votes['BEARISH_TREND'] += 1;
        voteLog.push(`rsi=${ta.rsi14.toFixed(0)}→Be+1`);
      } else if (ta.rsi14 > 38 && ta.rsi14 < 62) {
        votes['RANGING'] += 1;
        voteLog.push(`rsi=${ta.rsi14.toFixed(0)}→R+1`);
      } else {
        // rsi14 > 75 or < 25
        votes['EXTREME'] += 1;
        voteLog.push(`rsi=${ta.rsi14.toFixed(0)}→E+1`);
      }
    }

    // ATR (1 point)
    if (ta.atr14 != null) {
      if (ta.atr14 > 0.60) {
        votes['EXTREME'] += 1;
        voteLog.push(`atr=$${ta.atr14.toFixed(2)}>0.60→E+1`);
      } else if (ta.atr14 >= 0.30) {
        // 1pt to current trend direction
        if (ta.trendDirection === 'UP') {
          votes['BULLISH_TREND'] += 1;
          voteLog.push(`atr=$${ta.atr14.toFixed(2)}→B+1`);
        } else if (ta.trendDirection === 'DOWN') {
          votes['BEARISH_TREND'] += 1;
          voteLog.push(`atr=$${ta.atr14.toFixed(2)}→Be+1`);
        } else {
          votes['RANGING'] += 1;
          voteLog.push(`atr=$${ta.atr14.toFixed(2)}→R+1`);
        }
      } else {
        votes['RANGING'] += 1;
        voteLog.push(`atr=$${ta.atr14.toFixed(2)}<0.30→R+1`);
      }
    }
  } else {
    // No TA: default baseline so downstream logic can still run
    votes['RANGING'] += 1;
    voteLog.push('noTA→R+1');
  }

  // ── Market Signal Overrides ───────────────────────────────────────────
  let marketOverride: Regime | null = null;
  const mktLog: string[] = [];

  if (marketSignals) {
    const { vol1h, solDelta24h, volumeRatio4h, fearGreedIndex } = marketSignals;

    if (vol1h != null && vol1h > 0.06) {
      marketOverride = 'EXTREME';
      mktLog.push(`vol1h=${vol1h.toFixed(4)}>0.06→EXTREME`);
    }

    if (solDelta24h != null && volumeRatio4h != null && volumeRatio4h > 2) {
      if (solDelta24h > 4) {
        // Confirm BULLISH or override RANGING
        if (marketOverride == null) {
          votes['BULLISH_TREND'] += 2;
          mktLog.push(`sol+${solDelta24h.toFixed(1)}%+vol${volumeRatio4h.toFixed(1)}x→B+2`);
        }
      } else if (solDelta24h < -4) {
        // Confirm BEARISH or override RANGING
        if (marketOverride == null) {
          votes['BEARISH_TREND'] += 2;
          mktLog.push(`sol${solDelta24h.toFixed(1)}%+vol${volumeRatio4h.toFixed(1)}x→Be+2`);
        }
      }
    }

    if (fearGreedIndex != null) {
      if (fearGreedIndex < 15) {
        votes['BEARISH_TREND'] += 1;
        mktLog.push(`F&G=${fearGreedIndex}<15→Be+1`);
      } else if (fearGreedIndex > 75) {
        votes['BULLISH_TREND'] += 1;
        mktLog.push(`F&G=${fearGreedIndex}>75→B+1`);
      }
    }
  }

  // ── BB Position Reduction (apply BEFORE tie-break) ────────────────────
  let bbPosReduction = 0;
  let bbPosNote = '';
  if (ta?.bbPosition != null && (ta.bbPosition > 0.85 || ta.bbPosition < 0.15)) {
    bbPosReduction = 1;
    bbPosNote = ` bbPos=${ta.bbPosition.toFixed(2)} extreme→score-1`;
  }

  // ── Determine Winner from adjusted votes ─────────────────────────────
  const bullPts = Math.max(0, votes['BULLISH_TREND'] - bbPosReduction);
  const bearPts = Math.max(0, votes['BEARISH_TREND'] - bbPosReduction);
  const rangPts = votes['RANGING']; // RANGING not reduced by BB position
  const extrPts = Math.max(0, votes['EXTREME'] - bbPosReduction);

  let winner: Regime = 'RANGING';
  let winScore = rangPts;
  if (bullPts > winScore) { winner = 'BULLISH_TREND'; winScore = bullPts; }
  if (bearPts > winScore) { winner = 'BEARISH_TREND'; winScore = bearPts; }
  if (extrPts > winScore) { winner = 'EXTREME'; winScore = extrPts; }

  const voteSummary = `B:${votes['BULLISH_TREND']} R:${votes['RANGING']} Be:${votes['BEARISH_TREND']} E:${votes['EXTREME']}`;
  const adjustedScore = winScore;

  // ── Apply market override (EXTREME) ──────────────────────────────────
  let candidate: Regime = winner;
  if (marketOverride != null) {
    candidate = marketOverride;
  }

  // ── Layer 1 Veto (daily regime) ───────────────────────────────────────
  let vetoLog = 'none';
  if (dailyRegime != null && candidate !== 'EXTREME') {
    if (dailyRegime === 'BEARISH_TREND' && candidate === 'BULLISH_TREND') {
      candidate = 'RANGING';
      vetoLog = `daily=${dailyRegime} vetoes BULLISH→RANGING`;
    } else if (dailyRegime === 'BULLISH_TREND' && candidate === 'BEARISH_TREND') {
      candidate = 'RANGING';
      vetoLog = `daily=${dailyRegime} vetoes BEARISH→RANGING`;
    } else {
      vetoLog = `daily=${dailyRegime}, no conflict`;
    }
  } else if (dailyRegime != null && candidate === 'EXTREME') {
    vetoLog = `daily=${dailyRegime}, EXTREME never vetoed`;
  } else {
    vetoLog = 'no daily regime';
  }

  // ── Hysteresis ────────────────────────────────────────────────────────
  let newCandidateCount: number;
  let committedRegime: Regime;
  let hysteresisLog: string;

  // EXTREME fires immediately; high-conviction (≥6/7, no veto) also fires immediately
  const vetoFiredForHysteresis = vetoLog.includes('vetoes');
  if (candidate === 'EXTREME') {
    newCandidateCount = 1;
    committedRegime = 'EXTREME';
    hysteresisLog = 'EXTREME fires immediately → COMMITTED';
  } else if (adjustedScore >= 6 && !vetoFiredForHysteresis) {
    newCandidateCount = 1;
    committedRegime = candidate;
    hysteresisLog = `IMMEDIATE (score ${adjustedScore}/7) → COMMITTED`;
  } else if (candidate === previousCandidate) {
    newCandidateCount = Math.min(candidateCount + 1, 99);
    if (newCandidateCount >= 3) {
      committedRegime = candidate;
      hysteresisLog = `cycle ${newCandidateCount}/3 → COMMITTED`;
    } else {
      committedRegime = previousCandidate ?? candidate;
      hysteresisLog = `cycle ${newCandidateCount}/3 → pending`;
    }
  } else {
    newCandidateCount = 1;
    committedRegime = previousCandidate ?? candidate; // keep old until confirmed
    hysteresisLog = `new candidate (cycle 1/3) → pending`;
  }

  // ── Confidence & Deploy Multiplier ────────────────────────────────────
  const vetoFired = vetoLog.includes('vetoes');
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  let deployMultiplier: number;
  if (vetoFired) {
    // L1 and TA disagree — inherently ambiguous, reduce deploy
    confidence = 'LOW';
    deployMultiplier = 0.50;
  } else if (adjustedScore >= 4) {
    confidence = 'HIGH';
    deployMultiplier = 1.0;
  } else if (adjustedScore >= 2) {
    confidence = 'MEDIUM';
    deployMultiplier = 0.75;
  } else {
    confidence = 'LOW';
    deployMultiplier = 0.50;
  }

  // ── Build log string ──────────────────────────────────────────────────
  const maxPossibleScore = 7; // 2+2+1+1+1 max votes
  const deployPct = Math.round(deployMultiplier * 100);
  const log = [
    `[Regime] TA votes: ${voteSummary}${voteLog.length ? ` (${voteLog.join(' ')})` : ''}`,
    mktLog.length ? `mkt: ${mktLog.join(' ')}` : null,
    bbPosNote ? bbPosNote.trim() : null,
    `→ ${candidate}`,
    `| L1 veto: ${vetoLog}`,
    `| Hysteresis: ${hysteresisLog}`,
    `| Committed: ${committedRegime}`,
    `| Confidence: ${confidence}${vetoFired ? ' (veto override)' : ` (score ${adjustedScore}/${maxPossibleScore})`}`,
    `| Deploy: ${deployPct}%`,
  ].filter(Boolean).join(' ');

  return {
    regime: committedRegime,
    confidence,
    score: adjustedScore,
    deployMultiplier,
    candidateRegime: candidate,
    newCandidateCount,
    log,
    votes,
    vetoFired,
  };
}
