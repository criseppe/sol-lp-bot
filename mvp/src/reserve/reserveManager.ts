/**
 * USDC Reserve Manager
 *
 * Maintains a floor reserve of USDC so the bot always has capital available
 * for rebalancing swaps, gas, and emergency operations.
 *
 * Reserve floor = RESERVE_FLOOR_PCT * total portfolio value (USDC-denominated).
 *
 * States:
 *   EMPTY      — reserve is at 0 or far below floor; all harvests go to reserve
 *   REFILLING  — reserve exists but is below floor; all harvests go to reserve
 *   FULL       — reserve >= floor; harvests split 50/50 between reserve top-up and compounding
 */

import type Database from 'better-sqlite3';

// ── Constants ─────────────────────────────────────────────────────────────

const RESERVE_FLOOR_PCT = 0.20; // 20% of total portfolio value

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReserveSnapshot {
  floor: number;
  current: number;
  deficit: number;
  state: 'FULL' | 'REFILLING' | 'EMPTY';
  isDeployable: boolean; // true only if current >= floor
}

export interface HarvestSplit {
  toReserve: number;
  toCompound: number;
}

export interface DeployGate {
  allowed: boolean;
  reason: string;
  shortfall: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compute the USDC floor for the given total portfolio value.
 */
export function computeFloor(totalPortfolioUsdc: number, floorPct?: number): number {
  return totalPortfolioUsdc * (floorPct ?? RESERVE_FLOOR_PCT);
}

/**
 * Read the current reserve snapshot from the DB.
 * Returns a safe default if the row is absent.
 */
export function getReserveState(db: Database.Database): ReserveSnapshot {
  const row = db.prepare(
    `SELECT usdc_reserve, usdc_reserve_floor, reserve_state FROM bot_state WHERE id = 1`,
  ).get() as {
    usdc_reserve: number | null;
    usdc_reserve_floor: number | null;
    reserve_state: string | null;
  } | undefined;

  const current = row?.usdc_reserve ?? 0;
  const floor = row?.usdc_reserve_floor ?? 0;
  const rawState = row?.reserve_state ?? 'EMPTY';

  const state: 'FULL' | 'REFILLING' | 'EMPTY' =
    rawState === 'FULL' || rawState === 'REFILLING' || rawState === 'EMPTY'
      ? (rawState as 'FULL' | 'REFILLING' | 'EMPTY')
      : 'EMPTY';

  const deficit = Math.max(0, floor - current);
  const isDeployable = current >= floor;

  return { floor, current, deficit, state, isDeployable };
}

/**
 * Persist the new reserve amount and derive the new state.
 * Also updates usdc_reserve_floor if a non-zero floor is passed (optional).
 */
export function updateReserve(db: Database.Database, newAmount: number, newFloor?: number): void {
  const existing = getReserveState(db);
  const floor = newFloor !== undefined ? newFloor : existing.floor;

  let newState: 'FULL' | 'REFILLING' | 'EMPTY';
  if (newAmount <= 0) {
    newState = 'EMPTY';
  } else if (newAmount >= floor) {
    newState = 'FULL';
  } else {
    newState = 'REFILLING';
  }

  const updated = db.prepare(
    `UPDATE bot_state
     SET usdc_reserve = ?, usdc_reserve_floor = ?, reserve_state = ?, reserve_last_updated = ?
     WHERE id = 1`,
  ).run(newAmount, floor, newState, Date.now());

  // If row doesn't exist yet, insert a minimal row
  if ((updated as { changes: number }).changes === 0) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_state (id, state, updated_at, usdc_reserve, usdc_reserve_floor, reserve_state, reserve_last_updated)
       VALUES (1, 'IDLE', ?, ?, ?, ?, ?)`,
    ).run(Date.now(), newAmount, floor, newState, Date.now());
  }
}

/**
 * Determine how to split a harvested USDC amount between the reserve and compounding.
 *
 * Rules:
 *   EMPTY / REFILLING  → 100% to reserve (up to the deficit)
 *   FULL               → 50% to reserve top-up (up to deficit), 50% to compound
 *
 * Does NOT write to DB — caller must call updateReserve with the new balance.
 */
export function routeHarvest(db: Database.Database, harvestAmountUsdc: number): HarvestSplit {
  if (harvestAmountUsdc <= 0) return { toReserve: 0, toCompound: 0 };

  const { state, deficit } = getReserveState(db);

  if (state === 'EMPTY' || state === 'REFILLING') {
    // All harvest goes to reserve, but never more than the deficit
    const toReserve = Math.min(harvestAmountUsdc, deficit);
    const toCompound = harvestAmountUsdc - toReserve;
    return { toReserve, toCompound };
  }

  // FULL: split 50/50, reserve side capped at deficit (which may be 0 when exactly full)
  const halfAmount = harvestAmountUsdc * 0.5;
  const toReserve = Math.min(halfAmount, deficit);
  const toCompound = harvestAmountUsdc - toReserve;
  return { toReserve, toCompound };
}

/**
 * Check whether a deployment of usdcNeededForDeposit is allowed given the
 * current reserve level.
 *
 * Block 2 rules:
 *   EMPTY    → always blocked
 *   REFILLING → allowed if wallet covers deposit AND reserve > 0 (deadlock prevention)
 *   FULL     → always allowed
 */
export function checkDeployGate(db: Database.Database, usdcNeededForDeposit: number, walletUsdcBalance: number, walletTotalUsdc?: number): {
  allowed: boolean; reason: string; shortfall: number;
} {
  const state = getReserveState(db);

  if (state.state === 'EMPTY') {
    return { allowed: false, reason: `Reserve EMPTY — seed required`, shortfall: usdcNeededForDeposit };
  }

  if (state.state === 'REFILLING') {
    // Allow deploy if wallet total value (SOL+USDC) covers deposit AND reserve > 0
    // Reserve floor is a target to rebuild toward, not a hard block
    // Deadlock prevention: bot must be able to earn fees to refill reserve
    // Pre-open swap handles SOL/USDC rebalancing for the deposit
    const totalValue = walletTotalUsdc ?? walletUsdcBalance;
    if (totalValue >= usdcNeededForDeposit && state.current > 0) {
      return { allowed: true, reason: `REFILLING — wallet $${totalValue.toFixed(2)} covers deposit $${usdcNeededForDeposit.toFixed(2)}. Reserve rebuilding: $${state.current.toFixed(2)} / $${state.floor.toFixed(2)}`, shortfall: 0 };
    }
    if (state.current === 0) {
      return { allowed: false, reason: `Reserve EMPTY within REFILLING state — manual top-up required`, shortfall: usdcNeededForDeposit };
    }
    return { allowed: false, reason: `Wallet value $${totalValue.toFixed(2)} insufficient for deposit $${usdcNeededForDeposit.toFixed(2)}`, shortfall: usdcNeededForDeposit - totalValue };
  }

  return { allowed: true, reason: `Reserve FULL — $${state.current.toFixed(2)} / floor $${state.floor.toFixed(2)}`, shortfall: 0 };
}

/**
 * Recalculate reserve floor when portfolio value drifts >20% from expected.
 * Only adjusts floor — does not change current reserve amount.
 */
export function checkReserveFloor(db: Database.Database, totalPortfolioUsdc: number, floorPct?: number): void {
  const state = getReserveState(db);
  if (state.floor === 0 || totalPortfolioUsdc <= 0) return;

  const expectedFloor = totalPortfolioUsdc * (floorPct ?? RESERVE_FLOOR_PCT);
  const floorDrift = (expectedFloor - state.floor) / state.floor;

  if (Math.abs(floorDrift) > 0.20) {
    const newFloor = Math.round(expectedFloor * 100) / 100;
    db.prepare('UPDATE bot_state SET usdc_reserve_floor = ? WHERE id = 1').run(newFloor);
    // Force state recalculation with new floor
    const currentReserve = getReserveState(db).current;
    updateReserve(db, currentReserve, newFloor);
    const newState = getReserveState(db);
    console.log(JSON.stringify({
      level: 'info',
      msg: `[Reserve] Floor recalculated: $${state.floor.toFixed(2)} → $${newFloor.toFixed(2)} (portfolio $${totalPortfolioUsdc.toFixed(0)}, drift ${(floorDrift * 100).toFixed(0)}%). State: ${newState.state}`,
      timestamp: Date.now(),
    }));
  }
}
