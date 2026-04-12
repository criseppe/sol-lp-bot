import { describe, it, expect } from 'vitest';
import { detectRegime, stdDev, getRegimeParams } from '../src/engine/regime.js';

describe('stdDev', () => {
  it('returns ≈2.0 for known test vector [2,4,4,4,5,5,7,9]', () => {
    const result = stdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBeCloseTo(2.0, 1);
  });

  it('returns 0 for empty array', () => {
    expect(stdDev([])).toBe(0);
  });

  it('returns 0 for constant values', () => {
    expect(stdDev([5, 5, 5, 5])).toBe(0);
  });
});

describe('detectRegime', () => {
  it('returns BULLISH_TREND for 14 prices trending up (dirRatio=0.90)', () => {
    // Straight line up: 100 to 113, step=1 → dirRatio = 13/13 = 1.0
    const prices = Array.from({ length: 14 }, (_, i) => 100 + i);
    expect(detectRegime(prices)).toBe('BULLISH_TREND');
  });

  it('returns BEARISH_TREND for 14 prices trending down (dirRatio=0.90)', () => {
    // Straight line down: 113 to 100
    const prices = Array.from({ length: 14 }, (_, i) => 113 - i);
    expect(detectRegime(prices)).toBe('BEARISH_TREND');
  });

  it('returns RANGING for 14 oscillating prices (dirRatio≈0.05)', () => {
    // Oscillating: 100, 105, 100, 105, ... → net move ≈ 0, total path large
    const prices = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? 100 : 105));
    const regime = detectRegime(prices);
    expect(regime).toBe('RANGING');
  });

  it('returns EXTREME when realisedVol > 0.08', () => {
    // Create prices with massive daily swings
    // log return of 0.10 each day = 10% daily moves
    const prices = [100];
    for (let i = 1; i < 14; i++) {
      // Alternate between +12% and -12% to get high vol but low dirRatio
      prices.push(prices[i - 1] * (i % 2 === 0 ? 1.12 : 0.88));
    }
    expect(detectRegime(prices)).toBe('EXTREME');
  });

  it('returns RANGING for fewer than 3 prices', () => {
    expect(detectRegime([100])).toBe('RANGING');
    expect(detectRegime([100, 110])).toBe('RANGING');
    expect(detectRegime([])).toBe('RANGING');
  });
});

describe('getRegimeParams', () => {
  it('returns correct params for each regime', () => {
    expect(getRegimeParams('RANGING').rangeWidthPct).toBe(1.5);
    expect(getRegimeParams('BULLISH_TREND').rangeWidthPct).toBe(3);
    expect(getRegimeParams('BEARISH_TREND').rangeWidthPct).toBe(2.5);
    expect(getRegimeParams('EXTREME').rangeWidthPct).toBe(6);
  });
});
