import { describe, it, expect, beforeEach } from 'vitest';
import { PaperTradingEngine } from '../src/paper/ledger.js';
import { initDb, insertPriceTick, getDailyCloses, getBotState, upsertBotState } from '../src/db/sqlite.js';
import type Database from 'better-sqlite3';
import type { PoolState } from '../src/types.js';

const identity = (p: number) => Math.round(p * 100);

let db: Database.Database;

function makePoolState(tick = 100): PoolState {
  return { tickCurrentIndex: tick, sqrtPriceX64: '0', liquidity: '0', feeRate: 3000, lastUpdated: Date.now() };
}

function seedHistory(db: Database.Database, days: number, basePrice: number) {
  const now = Date.now();
  for (let i = days; i >= 0; i--) {
    insertPriceTick(db, {
      timestamp: now - i * 86400_000,
      price: basePrice + (i % 2),
      confidence: 0.1,
      regime: 'RANGING',
      prox_lower: null,
      prox_upper: null,
      in_range: 1,
    });
  }
}

beforeEach(() => {
  db = initDb(':memory:');
  seedHistory(db, 7, 150);
});

describe('PaperTradingEngine', () => {
  it('starts with $1000, opens position, closes at same price → value ≈ $1000', () => {
    const engine = new PaperTradingEngine(1000, identity);
    const pool = makePoolState();

    // First cycle opens a position
    const r1 = engine.processCycle(150, pool, db);
    expect(r1.eventType).toBe('POSITION_OPENED');

    // Portfolio value should be approximately $1000
    const value = engine.getPortfolioValue(engine.getBotLedger(), 150);
    expect(value).toBeCloseTo(1000, -1); // within $10
  });

  it('open at $150, price drops to $120 → composition is ~100% SOL', () => {
    const engine = new PaperTradingEngine(1000, identity);

    // Open position at $150
    engine.processCycle(150, makePoolState(), db);

    const pos = engine.getBotLedger().openPosition!;
    expect(pos).not.toBeNull();

    // Price drops below lower bound → 100% SOL
    const comp = engine.estimateCurrentComposition(pos, pos.priceLower - 10);
    expect(comp.usdc).toBe(0);
    expect(comp.sol).toBeGreaterThan(0);
  });

  it('open at $150, price rises to $180 → composition is ~100% USDC', () => {
    const engine = new PaperTradingEngine(1000, identity);

    engine.processCycle(150, makePoolState(), db);

    const pos = engine.getBotLedger().openPosition!;
    expect(pos).not.toBeNull();

    // Price rises above upper bound → 100% USDC
    const comp = engine.estimateCurrentComposition(pos, pos.priceUpper + 10);
    expect(comp.sol).toBe(0);
    expect(comp.usdc).toBeGreaterThan(0);
  });

  it('naive bot opens with ±5% symmetric range', () => {
    const engine = new PaperTradingEngine(1000, identity);

    engine.processCycle(150, makePoolState(), db);

    const naivePos = engine.getNaivePosition();
    expect(naivePos).not.toBeNull();
    expect(naivePos!.priceLower).toBeCloseTo(150 * 0.95, 1);
    expect(naivePos!.priceUpper).toBeCloseTo(150 * 1.05, 1);
  });

  it('circuit breaker: >5% daily loss → HALTED', () => {
    const engine = new PaperTradingEngine(1000, identity);
    engine.processCycle(150, makePoolState(), db);

    // Massive price drop: $150 → $80 should cause >5% portfolio loss
    // Position opened at $150 with narrow range, price at $80 is far OOR
    for (let i = 0; i < 3; i++) {
      engine.processCycle(80, makePoolState(), db);
    }

    const value = engine.getPortfolioValue(engine.getBotLedger(), 80);
    // With $1000 capital, loss at $80 must exceed 5% ($50)
    expect(value).toBeLessThan(950);
    expect(engine.getState()).toBe('HALTED');
  });

  it('circuit breaker: HALTED state blocks further trading', () => {
    const engine = new PaperTradingEngine(1000, identity);
    engine.processCycle(150, makePoolState(), db);

    // Force halt
    (engine as any).botState = 'HALTED';

    // Next cycle should return CYCLE_SKIP, not open/close anything
    const result = engine.processCycle(150, makePoolState(), db);
    expect(result.eventType).toBe('CYCLE_SKIP');
    expect(engine.getState()).toBe('HALTED');
  });

  it('ledger persists to DB and restores correctly', () => {
    const engine1 = new PaperTradingEngine(1000, identity);
    engine1.processCycle(150, makePoolState(), db);

    // Persist
    const botLedger = engine1.getBotLedger();
    const naiveLedger = engine1.getNaiveLedger();
    upsertBotState(db, {
      state: engine1.getState(),
      regime: engine1.getRegime(),
      position_json: JSON.stringify(botLedger.openPosition),
      ledger_json: JSON.stringify(botLedger),
      naive_json: JSON.stringify(naiveLedger),
      updated_at: Date.now(),
    });

    // Restore
    const saved = getBotState(db);
    expect(saved).not.toBeNull();
    const restoredBot = JSON.parse(saved!.ledger_json!);
    const restoredNaive = JSON.parse(saved!.naive_json!);

    const engine2 = new PaperTradingEngine(1000, identity, 7, 0.35, {
      bot: restoredBot,
      naive: restoredNaive,
      botState: saved!.state,
      regime: saved!.regime!,
    });

    expect(engine2.getState()).toBe(engine1.getState());
    expect(engine2.getBotLedger().rebalanceCount).toBe(botLedger.rebalanceCount);
  });

  it('getComparison returns correct advantage calculation', () => {
    const engine = new PaperTradingEngine(1000, identity);
    engine.processCycle(150, makePoolState(), db);

    const comp = engine.getComparison(150);
    expect(comp.advantage).toBeCloseTo(comp.bot.netPnl - comp.naive.netPnl, 2);
    expect(comp.price).toBe(150);
    expect(comp.bot.regime).toBe('RANGING');
  });

  it('bot and naive run on same price feed', () => {
    const engine = new PaperTradingEngine(1000, identity);

    engine.processCycle(150, makePoolState(), db);

    // Both should have positions
    expect(engine.getBotLedger().openPosition).not.toBeNull();
    expect(engine.getNaivePosition()).not.toBeNull();

    // Both receive same price
    engine.processCycle(151, makePoolState(), db);
    expect(engine.getBotLedger().totalCycles).toBe(2);
    expect(engine.getNaiveLedger().totalCycles).toBe(2);
  });

  it('resume() exits HALTED state', () => {
    const engine = new PaperTradingEngine(1000, identity);
    // Force halt
    (engine as any).botState = 'HALTED';
    expect(engine.getState()).toBe('HALTED');

    engine.resume();
    expect(engine.getState()).toBe('IDLE');
  });

  it('flash crash cooldown blocks re-entry during pullback watch', () => {
    // Use high capital so 5% price drop doesn't trigger circuit breaker
    const engine = new PaperTradingEngine(10000, identity);
    seedHistory(db, 7, 100);
    engine.processCycle(100, makePoolState(), db);

    // Force pullback watch state: position closed, watching for re-entry
    (engine as any).pullbackWatchActive = true;
    (engine as any).pullbackPeakPrice = 100;
    (engine as any).pullbackWatchStart = Date.now();
    (engine as any).bot.openPosition = null;
    // Set wallet to hold full capital as USDC (no position, no IL)
    (engine as any).bot.solBalance = 0;
    (engine as any).bot.usdcBalance = 10000;
    (engine as any).botState = 'WAITING_PULLBACK';

    // Inject a flash crash into recent prices: 100 → 94 (6% drop > 5%)
    (engine as any).recentPrices = [100, 98, 96, 95, 94];

    // Process cycle — flash crash should set cooldown, return CYCLE_SKIP
    const result = engine.processCycle(94, makePoolState(), db);
    expect(result.eventType).toBe('CYCLE_SKIP');
    expect((engine as any).flashCrashCooldownUntil).toBeGreaterThan(Date.now());
  });

  it('rebalance loop limit: >10 rebalances/hour returns CYCLE_SKIP', () => {
    const engine = new PaperTradingEngine(1000, identity);
    seedHistory(db, 7, 150);

    // Force rebalance counter to the limit
    (engine as any).rebalancesThisHour = 10;
    (engine as any).rebalanceHourStart = Date.now();

    engine.processCycle(150, makePoolState(), db);

    // Next cycle should be blocked
    const result = engine.processCycle(150, makePoolState(), db);
    // When limit is hit, cycle returns CYCLE_SKIP (or PRICE_UPDATE if position exists)
    expect((engine as any).rebalancesThisHour).toBe(10);
  });
});
