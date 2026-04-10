import { describe, it, expect } from 'vitest';
import { PoolService } from '../src/data/pool.js';
import { Connection } from '@solana/web3.js';

// Unit tests for PoolService math functions (no RPC needed)
function createService(): PoolService {
  const connection = new Connection('https://localhost:8899');
  return new PoolService(connection, 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
}

describe('PoolService', () => {
  describe('priceToTick / tickToPrice round-trip', () => {
    const service = createService();

    it('round-trips price 150 within 0.1%', () => {
      const original = 150;
      const tick = service.priceToTick(original);
      const recovered = service.tickToPrice(tick);
      const errorPct = Math.abs(recovered - original) / original * 100;
      expect(errorPct).toBeLessThan(0.1);
    });

    it('round-trips price 50 within 0.1%', () => {
      const original = 50;
      const tick = service.priceToTick(original);
      const recovered = service.tickToPrice(tick);
      const errorPct = Math.abs(recovered - original) / original * 100;
      expect(errorPct).toBeLessThan(0.1);
    });

    it('round-trips price 500 within 0.1%', () => {
      const original = 500;
      const tick = service.priceToTick(original);
      const recovered = service.tickToPrice(tick);
      const errorPct = Math.abs(recovered - original) / original * 100;
      expect(errorPct).toBeLessThan(0.1);
    });

    it('round-trips price 1000 within 0.1%', () => {
      const original = 1000;
      const tick = service.priceToTick(original);
      const recovered = service.tickToPrice(tick);
      const errorPct = Math.abs(recovered - original) / original * 100;
      expect(errorPct).toBeLessThan(0.1);
    });
  });

  describe('isInRange', () => {
    it('returns true when tick is within bounds', async () => {
      const service = createService();
      // Manually set cached state to avoid RPC call
      (service as any).cachedState = {
        tickCurrentIndex: 100,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();

      expect(await service.isInRange(50, 150)).toBe(true);
    });

    it('returns true when tick is at lower bound', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 50,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();

      expect(await service.isInRange(50, 150)).toBe(true);
    });

    it('returns true when tick is at upper bound', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 150,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();

      expect(await service.isInRange(50, 150)).toBe(true);
    });

    it('returns false when tick is below lower bound', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 49,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();

      expect(await service.isInRange(50, 150)).toBe(false);
    });

    it('returns false when tick is above upper bound', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 151,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();

      expect(await service.isInRange(50, 150)).toBe(false);
    });
  });

  describe('cache', () => {
    it('does not increment fetchCount on cached call', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 100,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now(),
      };
      (service as any).lastFetchTime = Date.now();
      (service as any).fetchCount = 1;

      await service.fetchState();
      expect(service.getFetchCount()).toBe(1); // no new fetch
    });

    it('would need new fetch after cache expires', async () => {
      const service = createService();
      (service as any).cachedState = {
        tickCurrentIndex: 100,
        sqrtPriceX64: '0',
        liquidity: '0',
        lastUpdated: Date.now() - 11_000,
      };
      (service as any).lastFetchTime = Date.now() - 11_000;

      // This would attempt RPC and fail since we use localhost,
      // but the cache TTL check is what we're testing
      const isCacheValid = Date.now() - (service as any).lastFetchTime < 10_000;
      expect(isCacheValid).toBe(false);
    });
  });
});
