import { describe, it, expect } from 'vitest';
import {
  calcRange, calcProximity, shouldFireDownside, shouldFireUpside,
  shouldReenterAfterUpside, isFlashCrash, getDownsideReentrySplit,
  getDeployAmount, isHarvestDue, calcHarvestFees, calcIL, checkAutoDeploy,
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

  it('SOL=$150, BEARISH → lower=$148.50, upper=$152.25', () => {
    const params = REGIME_PARAMS.BEARISH_TREND;
    // lower = 150 * (1 - 0.025 * 0.40) = 150 * 0.99 = 148.50
    // upper = 150 * (1 + 0.025 * 0.60) = 150 * 1.015 = 152.25
    const range = calcRange(150, params, identity);
    expect(range.priceLower).toBeCloseTo(148.50, 2);
    expect(range.priceUpper).toBeCloseTo(152.25, 2);
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

  it('shouldFireDownside: does not fire when below proximity threshold', () => {
    const pos = makePosition(140, 160);
    // proxToLower = 0.3 (well below 0.65 threshold)
    const prox = calcProximity(147, pos);
    expect(prox.proxToLower).toBeCloseTo(0.3, 1);
    // Proximity alone won't trigger — IL params are ignored (proximity-only logic)
    expect(shouldFireDownside(prox, 0.65)).toBe(false);
    expect(shouldFireDownside(prox, 0.65, -5, 0.001)).toBe(false);
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
  it('$1000 capital, BEARISH (deployPct=0.75) → deploy=$750, reserve=$250', () => {
    const params = REGIME_PARAMS.BEARISH_TREND;
    const result = getDeployAmount(1000, params);
    expect(result.deployUsdc).toBe(750);
    expect(result.reserveUsdc).toBe(250);
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

// ─── Rule 7: checkAutoDeploy ─────────────────────────────────────────────

describe('Rule 7: checkAutoDeploy', () => {
  const baseOpts = {
    currentPrice: 84.25,
    priceLower: 83.65,
    priceUpper: 84.97,
    walletSol: 0.5,
    walletUsdc: 50,
    positionValueUsdc: 40,
    regime: 'RANGING' as const,
    params: REGIME_PARAMS.RANGING,
    lastDeployTime: 0,
    now: Date.now(),
    enabled: true,
    minIdleUsdc: 5,
    minIdleSol: 0.05,
    minDeployUsdc: 10,
    deployRatioTolerance: 0.02,
    reserveFloor: 0,
  };

  it('deploys when all conditions pass', () => {
    const result = checkAutoDeploy(baseOpts);
    expect(result.shouldDeploy).toBe(true);
    expect(result.reason).toContain('AUTO_DEPLOY');
    expect(result.deployableUsdc).toBeGreaterThan(10);
  });

  it('skips when disabled', () => {
    const result = checkAutoDeploy({ ...baseOpts, enabled: false });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toBe('DEPLOY_SKIPPED_DISABLED');
  });

  it('allows in BEARISH_TREND regime (deploy cap limits exposure)', () => {
    const result = checkAutoDeploy({ ...baseOpts, regime: 'BEARISH_TREND', params: REGIME_PARAMS.BEARISH_TREND });
    // BEARISH allows auto-deploy — the deployPct cap (75%) limits exposure
    expect(result.shouldDeploy).toBe(true);
  });

  it('blocks in EXTREME regime', () => {
    const result = checkAutoDeploy({ ...baseOpts, regime: 'EXTREME', params: REGIME_PARAMS.EXTREME });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_REGIME');
  });

  it('allows in BULLISH_TREND regime', () => {
    const result = checkAutoDeploy({ ...baseOpts, regime: 'BULLISH_TREND', params: REGIME_PARAMS.BULLISH_TREND });
    expect(result.shouldDeploy).toBe(true);
  });

  it('skips when idle funds below threshold', () => {
    const result = checkAutoDeploy({ ...baseOpts, walletSol: 0.05, walletUsdc: 1 });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_LOW_IDLE');
  });

  it('deploys when only SOL idle exceeds threshold', () => {
    const result = checkAutoDeploy({ ...baseOpts, walletSol: 0.5, walletUsdc: 1 });
    expect(result.shouldDeploy).toBe(true);
  });

  it('deploys when only USDC idle exceeds threshold', () => {
    const result = checkAutoDeploy({ ...baseOpts, walletSol: 0.05, walletUsdc: 50 });
    expect(result.shouldDeploy).toBe(true);
  });

  it('enforces 1-hour cooldown', () => {
    const result = checkAutoDeploy({ ...baseOpts, lastDeployTime: Date.now() - 30 * 60_000 }); // 30 min ago
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_COOLDOWN');
  });

  it('allows after cooldown expires', () => {
    const result = checkAutoDeploy({ ...baseOpts, lastDeployTime: Date.now() - 61 * 60_000 }); // 61 min ago
    expect(result.shouldDeploy).toBe(true);
  });

  it('skips when position at regime cap (BULLISH 85%)', () => {
    // BULLISH = 85% deploy. walletSol=0.5 ($42 idle), walletUsdc=10 ($9 idle) → idleUsdc ~$51.
    // Position=$200. Total = 51 + 200 = 251. Max = 251 * 0.85 = 213.35. Headroom = 213.35 - 200 = 13.35.
    // But deployableUsdc = min(51, 13.35) = 13.35 > 10, so NOT this check.
    // Use position=$500 → max = 551*0.85 = 468.35, headroom = 468.35-500 = -31.65 < 10
    const result = checkAutoDeploy({ ...baseOpts, positionValueUsdc: 500, walletSol: 0.5, walletUsdc: 10,
      regime: 'BULLISH_TREND', params: REGIME_PARAMS.BULLISH_TREND });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_CAP');
  });

  it('skips when deployable below minimum', () => {
    const result = checkAutoDeploy({ ...baseOpts, walletSol: 0.06, walletUsdc: 5 });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED');
  });

  it('skips when price out of range', () => {
    // Price $82.00 is below range $83.65-$84.97 → DEPLOY_SKIPPED_OOR
    const result = checkAutoDeploy({ ...baseOpts, currentPrice: 82.0 });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_OOR');
  });

  it('skips when price near edge of range', () => {
    // Price $84.96 is within 0.01 of upper bound $84.97 → deviation ~0.99 > (1-0.02)=0.98
    const result = checkAutoDeploy({ ...baseOpts, currentPrice: 84.96 });
    expect(result.shouldDeploy).toBe(false);
    expect(result.reason).toContain('DEPLOY_SKIPPED_RATIO');
  });

  it('deploys when price within range center', () => {
    // Price at 84.25 is near center of $83.65-$84.97
    const result = checkAutoDeploy({ ...baseOpts, currentPrice: 84.25 });
    expect(result.shouldDeploy).toBe(true);
  });
});

// ─── isFlashCrash: boundary & edge cases ─────────────────────────────────

describe('isFlashCrash boundary', () => {
  it('exactly 5% drop triggers', () => {
    // 100 → 95 = exactly 5%
    expect(isFlashCrash([100, 95])).toBe(true);
  });

  it('4.9% drop does not trigger', () => {
    expect(isFlashCrash([100, 95.1])).toBe(false);
  });

  it('large drop (10%) triggers', () => {
    expect(isFlashCrash([100, 90])).toBe(true);
  });

  it('price going up does not trigger', () => {
    expect(isFlashCrash([100, 110])).toBe(false);
  });

  it('multiple prices: uses first and last', () => {
    // 100 → 98 → 96 → 94: drop = (100-94)/100 = 6%
    expect(isFlashCrash([100, 98, 96, 94])).toBe(true);
  });

  it('handles zero first price', () => {
    expect(isFlashCrash([0, 50])).toBe(false);
  });

  it('handles negative first price', () => {
    expect(isFlashCrash([-10, 50])).toBe(false);
  });
});

// ─── calcHarvestFees: edge cases ─────────────────────────────────────────

describe('calcHarvestFees edge cases', () => {
  const pos = makePosition(140, 160);

  it('daysHeld = 0 → zero fees', () => {
    const result = calcHarvestFees(pos, 150, 0);
    expect(result.totalUsdcValue).toBe(0);
  });

  it('poolTvl = 0 → zero fees (no division by zero)', () => {
    const result = calcHarvestFees(pos, 150, 7, 500_000_000, 0);
    expect(result.totalUsdcValue).toBe(0);
  });

  it('higher volume → proportionally higher fees', () => {
    const low = calcHarvestFees(pos, 150, 7, 100_000_000, 250_000_000);
    const high = calcHarvestFees(pos, 150, 7, 500_000_000, 250_000_000);
    expect(high.totalUsdcValue).toBeCloseTo(low.totalUsdcValue * 5, 5);
  });

  it('fees scale with daysHeld', () => {
    const d1 = calcHarvestFees(pos, 150, 1);
    const d7 = calcHarvestFees(pos, 150, 7);
    expect(d7.totalUsdcValue).toBeCloseTo(d1.totalUsdcValue * 7, 5);
  });

  it('sol and usdc fees are equal (50/50 split)', () => {
    const result = calcHarvestFees(pos, 150, 7);
    expect(result.solFees).toBeCloseTo(result.usdcFees, 10);
  });
});

// ─── isHarvestDue: edge cases ────────────────────────────────────────────

describe('isHarvestDue', () => {
  it('returns true when interval elapsed', () => {
    const now = Date.now();
    expect(isHarvestDue(now - 8 * 86400_000, REGIME_PARAMS.RANGING, now)).toBe(true); // 8 days > 7
  });

  it('returns false when interval not elapsed', () => {
    const now = Date.now();
    expect(isHarvestDue(now - 3 * 86400_000, REGIME_PARAMS.RANGING, now)).toBe(false); // 3 days < 7
  });

  it('returns true at exactly the boundary', () => {
    const now = Date.now();
    expect(isHarvestDue(now - 7 * 86400_000, REGIME_PARAMS.RANGING, now)).toBe(true); // exactly 7 days
  });
});
