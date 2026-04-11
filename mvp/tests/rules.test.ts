import { describe, it, expect } from 'vitest';
import {
  calcRange, calcProximity, shouldFireDownside, shouldFireUpside,
  shouldReenterAfterUpside, isFlashCrash, getDownsideReentrySplit,
  getDeployAmount, isHarvestDue, calcHarvestFees, calcIL,
} from '../src/engine/rules.js';
import { REGIME_PARAMS } from '../src/constants.js';
import type { PaperPosition } from '../src/types.js';

const identity = (p: number) => Math.round(p * 100); // mock priceToTick

describe('Rule 1: calcRange', () => {
  it('SOL=$150, RANGING → lower=$149.33, upper=$151.58', () => {
    const params = REGIME_PARAMS.RANGING;
    // lower = 150 * (1 - 0.015 * 0.30) = 150 * 0.9955 = 149.325
    // upper = 150 * (1 + 0.015 * 0.70) = 150 * 1.0105 = 151.575
    const range = calcRange(150, params, identity);
    expect(range.priceLower).toBeCloseTo(149.325, 1);
    expect(range.priceUpper).toBeCloseTo(151.575, 1);
  });

  it('SOL=$150, BEARISH → lower=$147.60, upper=$153.60', () => {
    const params = REGIME_PARAMS.BEARISH_TREND;
    // lower = 150 * (1 - 0.04 * 0.40) = 150 * 0.984 = 147.60
    // upper = 150 * (1 + 0.04 * 0.60) = 150 * 1.024 = 153.60
    const range = calcRange(150, params, identity);
    expect(range.priceLower).toBeCloseTo(147.60, 2);
    expect(range.priceUpper).toBeCloseTo(153.60, 2);
  });
});

function makePosition(priceLower: number, priceUpper: number): PaperPosition {
  return {
    tickLower: 0, tickUpper: 0,
    priceLower, priceUpper,
    entryPrice: (priceLower + priceUpper) / 2,
    solAmount: 1, usdcAmount: 150,
    entryTime: Date.now(), regime: 'RANGING',
  };
}

describe('Rule 2: calcProximity', () => {
  it('price at centre → both proximities = 0', () => {
    const pos = makePosition(140, 160);
    const prox = calcProximity(150, pos); // centre = 150
    expect(prox.proxToLower).toBeCloseTo(0);
    expect(prox.proxToUpper).toBeCloseTo(0);
    expect(prox.inRange).toBe(true);
  });

  it('price at lower tick → proxToLower ≈ 1.0', () => {
    const pos = makePosition(140, 160);
    const prox = calcProximity(140, pos);
    expect(prox.proxToLower).toBeCloseTo(1.0);
    expect(prox.inRange).toBe(true);
  });

  it('price at upper tick → proxToUpper ≈ 1.0', () => {
    const pos = makePosition(140, 160);
    const prox = calcProximity(160, pos);
    expect(prox.proxToUpper).toBeCloseTo(1.0);
  });

  it('proxToLower=0.67 with threshold=0.65 → shouldFireDownside=true', () => {
    const pos = makePosition(140, 160);
    // centre=150, halfWidth=10, need proxToLower=0.67
    // (150 - price)/10 = 0.67 → price = 143.3
    const prox = calcProximity(143.3, pos);
    expect(prox.proxToLower).toBeCloseTo(0.67, 1);
    expect(shouldFireDownside(prox, 0.65, 0, 0)).toBe(true);
  });

  it('shouldFireUpside when proxToUpper exceeds threshold', () => {
    const pos = makePosition(140, 160);
    const prox = calcProximity(159, pos); // proxToUpper = 0.9
    expect(shouldFireUpside(prox, 0.88)).toBe(true);
  });
});

describe('Rule 3: Re-entry Timing', () => {
  it('peak=$155, current=$151.125 (2.5% pullback) → should=true, PULLBACK', () => {
    const now = Date.now();
    const result = shouldReenterAfterUpside(151.125, 155, now - 1000, now);
    expect(result.should).toBe(true);
    expect(result.reason).toBe('PULLBACK');
  });

  it('8.1h elapsed, no pullback → should=true, TIMEOUT', () => {
    const now = Date.now();
    const watchStart = now - 8.1 * 3600_000;
    const result = shouldReenterAfterUpside(155, 155, watchStart, now); // no pullback
    expect(result.should).toBe(true);
    expect(result.reason).toBe('TIMEOUT');
  });

  it('still waiting: small pullback, short time', () => {
    const now = Date.now();
    const result = shouldReenterAfterUpside(154, 155, now - 1000, now); // 0.6% pullback
    expect(result.should).toBe(false);
    expect(result.reason).toBe('WAITING');
  });

  it('2% drop → isFlashCrash=false', () => {
    const prices = [100, 99, 98]; // 2% drop
    expect(isFlashCrash(prices)).toBe(false);
  });

  it('6% drop → isFlashCrash=true', () => {
    const prices = [100, 97, 94]; // 6% drop
    expect(isFlashCrash(prices)).toBe(true);
  });

  it('fewer than 2 prices → false', () => {
    expect(isFlashCrash([100])).toBe(false);
    expect(isFlashCrash([])).toBe(false);
  });
});

describe('Rule 4: Re-entry Split', () => {
  it('RANGING → 0.50', () => {
    expect(getDownsideReentrySplit('RANGING')).toBe(0.50);
  });

  it('BEARISH → 0.30', () => {
    expect(getDownsideReentrySplit('BEARISH_TREND')).toBe(0.30);
  });

  it('EXTREME → 0.20', () => {
    expect(getDownsideReentrySplit('EXTREME')).toBe(0.20);
  });
});

describe('Rule 5: Position Sizing', () => {
  it('$1000 capital, BEARISH (deployPct=0.50) → deploy=$500, reserve=$500', () => {
    const params = REGIME_PARAMS.BEARISH_TREND;
    const result = getDeployAmount(1000, params);
    expect(result.deployUsdc).toBe(500);
    expect(result.reserveUsdc).toBe(500);
  });

  it('$1000 capital, RANGING (deployPct=1.00) → deploy=$1000, reserve=$0', () => {
    const params = REGIME_PARAMS.RANGING;
    const result = getDeployAmount(1000, params);
    expect(result.deployUsdc).toBe(1000);
    expect(result.reserveUsdc).toBe(0);
  });
});

describe('Rule 6: Fee Harvest', () => {
  it('last harvest 3 days ago, RANGING (interval=7) → false', () => {
    const now = Date.now();
    const lastHarvest = now - 3 * 86400_000;
    expect(isHarvestDue(lastHarvest, REGIME_PARAMS.RANGING, now)).toBe(false);
  });

  it('last harvest 8 days ago, RANGING → true', () => {
    const now = Date.now();
    const lastHarvest = now - 8 * 86400_000;
    expect(isHarvestDue(lastHarvest, REGIME_PARAMS.RANGING, now)).toBe(true);
  });

  it('calcHarvestFees returns positive values', () => {
    const pos = makePosition(140, 160);
    const result = calcHarvestFees(pos, 150, 7);
    expect(result.totalUsdcValue).toBeGreaterThan(0);
    expect(result.solFees).toBeCloseTo(result.usdcFees);
  });
});

describe('IL Calculator', () => {
  it('entry=$150, current=$120 → negative value', () => {
    const il = calcIL(150, 120, 1, 150);
    expect(il).toBeLessThan(0);
  });

  it('entry=$150, current=$150 → 0', () => {
    const il = calcIL(150, 150, 1, 150);
    expect(il).toBeCloseTo(0, 5);
  });

  it('entry=$150, current=$200 → negative value', () => {
    const il = calcIL(150, 200, 1, 150);
    expect(il).toBeLessThan(0);
  });
});
