import { describe, it, expect, beforeEach } from 'vitest';
import { OracleService } from '../src/data/oracle.js';

function createService(maxConfidencePct = 0.5, maxStalenessSec = 60): OracleService {
  return new OracleService(
    '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    maxConfidencePct,
    maxStalenessSec,
  );
}

function simulatePriceUpdate(
  service: OracleService,
  price: number,
  confidence: number,
  publishTime?: number,
): void {
  // Hermes feed format: raw integers with exponent
  const expo = -8;
  const rawPrice = Math.round(price / Math.pow(10, expo));
  const rawConf = Math.round(confidence / Math.pow(10, expo));
  const feed = {
    id: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    price: {
      price: rawPrice.toString(),
      expo,
      conf: rawConf.toString(),
      publish_time: publishTime ?? Math.floor(Date.now() / 1000),
    },
  };
  service.handlePriceUpdate(feed);
}

describe('OracleService', () => {
  let service: OracleService;

  beforeEach(() => {
    service = createService();
  });

  it('accepts price with confidence within threshold (0.3%)', () => {
    const price = 150;
    const confidence = price * 0.003; // 0.3%
    simulatePriceUpdate(service, price, confidence);

    const result = service.getPrice();
    expect(result).not.toBeNull();
    expect(result!.price).toBeCloseTo(150, 0);
    expect(result!.valid).toBe(true);
  });

  it('rejects price with confidence exceeding threshold (0.8%)', () => {
    const price = 150;
    const confidence = price * 0.008; // 0.8%
    simulatePriceUpdate(service, price, confidence);

    const result = service.getPrice();
    expect(result).toBeNull();
    expect(service.getBadPriceCount()).toBe(1);
  });

  it('rejects stale price', () => {
    const staleTime = Math.floor(Date.now() / 1000) - 120; // 2 min ago
    simulatePriceUpdate(service, 150, 0.1, staleTime);

    expect(service.getPrice()).toBeNull();
    expect(service.getBadPriceCount()).toBe(1);
  });

  it('returns null when no price has been received', () => {
    expect(service.getPrice()).toBeNull();
  });

  it('returns null when price becomes stale after being valid', () => {
    simulatePriceUpdate(service, 150, 0.1);
    // Manually set lastUpdateTime to make price appear stale
    (service as any).lastUpdateTime = Date.now() - 61_000;

    expect(service.getPrice()).toBeNull();
  });

  it('price is within reasonable SOL range ($50-$5000)', () => {
    simulatePriceUpdate(service, 150, 0.1);
    const result = service.getPrice();
    expect(result).not.toBeNull();
    expect(result!.price).toBeGreaterThanOrEqual(50);
    expect(result!.price).toBeLessThanOrEqual(5000);
  });

  it('accepts confidence at exactly threshold boundary', () => {
    const price = 100;
    const confidence = price * 0.005; // exactly 0.5%
    simulatePriceUpdate(service, price, confidence);

    const result = service.getPrice();
    expect(result).not.toBeNull();
  });

  it('increments badPriceCount for each rejection', () => {
    simulatePriceUpdate(service, 150, 150); // 100% confidence - rejected
    const staleTime = Math.floor(Date.now() / 1000) - 120;
    simulatePriceUpdate(service, 150, 0.1, staleTime); // stale
    simulatePriceUpdate(service, 150, 5); // high confidence

    expect(service.getBadPriceCount()).toBe(3);
  });

  it('updates price when a valid update follows a rejection', () => {
    simulatePriceUpdate(service, 150, 150); // rejected
    expect(service.getPrice()).toBeNull();

    simulatePriceUpdate(service, 160, 0.1); // accepted
    const result = service.getPrice();
    expect(result).not.toBeNull();
    expect(result!.price).toBeCloseTo(160, 0);
  });

  it('stop() completes without error', () => {
    expect(() => service.stop()).not.toThrow();
  });
});
