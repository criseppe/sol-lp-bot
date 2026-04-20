/**
 * USDC Reserve Manager — DEPRECATED: reserve concept removed in Phase 20.
 *
 * All functions kept as no-op stubs for backwards-compat with existing
 * callers. They always return "FULL / allowed / compound-all" so that
 * consumers transparently operate on idle wallet capital.
 *
 * To fully remove: migrate callers to use idle capital directly, then
 * delete this module and the usdc_reserve / usdc_reserve_floor /
 * reserve_state columns from bot_state.
 */

import type Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReserveSnapshot {
  floor: number;
  current: number;
  deficit: number;
  state: 'FULL' | 'REFILLING' | 'EMPTY';
  isDeployable: boolean;
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

/** DEPRECATED: always returns 0 — reserve concept removed. */
export function computeFloor(_totalPortfolioUsdc: number, _floorPct?: number): number {
  return 0;
}

/**
 * Read the "reserve" snapshot. Always reports state=FULL, floor=0, and a
 * non-blocking posture so legacy callers never gate deploys.
 * Still reads usdc_reserve from DB for informational display.
 */
export function getReserveState(db: Database.Database): ReserveSnapshot {
  const row = db.prepare(
    `SELECT usdc_reserve FROM bot_state WHERE id = 1`,
  ).get() as { usdc_reserve: number | null } | undefined;

  const current = row?.usdc_reserve ?? 0;
  return { floor: 0, current, deficit: 0, state: 'FULL', isDeployable: true };
}

/**
 * DEPRECATED: no-op write. Preserves the informational usdc_reserve value
 * and always forces floor=0, state=FULL.
 */
export function updateReserve(db: Database.Database, newAmount: number, _newFloor?: number): void {
  const updated = db.prepare(
    `UPDATE bot_state
     SET usdc_reserve = ?, usdc_reserve_floor = 0, reserve_state = 'FULL', reserve_last_updated = ?
     WHERE id = 1`,
  ).run(newAmount, Date.now());

  if ((updated as { changes: number }).changes === 0) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_state (id, state, updated_at, usdc_reserve, usdc_reserve_floor, reserve_state, reserve_last_updated)
       VALUES (1, 'IDLE', ?, ?, 0, 'FULL', ?)`,
    ).run(Date.now(), newAmount, Date.now());
  }
}

/** DEPRECATED: always routes 100% to compound. */
export function routeHarvest(_db: Database.Database, harvestAmountUsdc: number): HarvestSplit {
  if (harvestAmountUsdc <= 0) return { toReserve: 0, toCompound: 0 };
  return { toReserve: 0, toCompound: harvestAmountUsdc };
}

/** DEPRECATED: always allows. */
export function checkDeployGate(
  _db: Database.Database,
  _usdcNeededForDeposit: number,
  _walletUsdcBalance: number,
  _walletTotalUsdc?: number,
): { allowed: boolean; reason: string; shortfall: number } {
  return { allowed: true, reason: 'Reserve concept removed (Phase 20)', shortfall: 0 };
}

/** DEPRECATED: no-op. */
export function checkReserveFloor(_db: Database.Database, _totalPortfolioUsdc: number, _floorPct?: number): void {
  // no-op
}
