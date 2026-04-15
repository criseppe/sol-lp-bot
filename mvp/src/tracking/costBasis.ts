/**
 * Cost Basis Tracking — weighted average SOL cost basis across ALL acquisition sources.
 *
 * Sources tracked:
 *   1. Explicit USDC→SOL swaps (pre-open, idle rebalance, SIR, any buy_sol)
 *   2. SOL returned from LP position closes (the SOL component of liquidity withdrawal)
 *   3. Any future SOL inflow points
 *
 * On sell/convert: basis is unchanged (FIFO/average), P&L is tracked elsewhere.
 * On buy/receive: weighted average is updated.
 *
 * State is persisted to bot_state DB row on every update.
 */

import type Database from 'better-sqlite3';

export interface CostBasisState {
  solCostBasis: number;       // weighted average acquisition price (USDC per SOL)
  solTotalAcquired: number;   // cumulative SOL acquired (all sources)
  solTotalCost: number;       // cumulative USDC cost (all sources)
  costBasisLastUpdated: number; // unix ms
}

/**
 * Read current cost basis state from DB.
 * Returns zeros if not yet initialised.
 */
export function readCostBasis(db: Database.Database): CostBasisState {
  const row = db.prepare(
    `SELECT sol_cost_basis, sol_total_acquired, sol_total_cost, cost_basis_last_updated
     FROM bot_state WHERE id = 1`,
  ).get() as {
    sol_cost_basis: number | null;
    sol_total_acquired: number | null;
    sol_total_cost: number | null;
    cost_basis_last_updated: number | null;
  } | undefined;

  return {
    solCostBasis: row?.sol_cost_basis ?? 0,
    solTotalAcquired: row?.sol_total_acquired ?? 0,
    solTotalCost: row?.sol_total_cost ?? 0,
    costBasisLastUpdated: row?.cost_basis_last_updated ?? 0,
  };
}

/**
 * Persist cost basis state back to the bot_state row.
 * Uses a partial UPDATE so we don't clobber unrelated fields.
 */
function writeCostBasis(db: Database.Database, state: CostBasisState): void {
  db.prepare(
    `UPDATE bot_state
     SET sol_cost_basis = ?, sol_total_acquired = ?, sol_total_cost = ?, cost_basis_last_updated = ?
     WHERE id = 1`,
  ).run(state.solCostBasis, state.solTotalAcquired, state.solTotalCost, state.costBasisLastUpdated);

  // If the row doesn't exist yet (first run before first upsertBotState), insert it
  const changed = (db.prepare('SELECT changes() as c').get() as { c: number }).c;
  if (changed === 0) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_state (id, state, updated_at, sol_cost_basis, sol_total_acquired, sol_total_cost, cost_basis_last_updated)
       VALUES (1, 'IDLE', ?, ?, ?, ?, ?)`,
    ).run(Date.now(), state.solCostBasis, state.solTotalAcquired, state.solTotalCost, state.costBasisLastUpdated);
  }
}

/**
 * Record a new SOL acquisition and update the weighted average cost basis.
 *
 * @param db                   SQLite database instance
 * @param newSolAmount         SOL received (positive number)
 * @param acquisitionPriceUsdc USDC price per SOL at time of acquisition
 * @param source               Human-readable label for logging (e.g. "LP close", "USDC→SOL swap")
 * @returns Updated cost basis state
 */
export function updateCostBasis(
  db: Database.Database,
  newSolAmount: number,
  acquisitionPriceUsdc: number,
  source: string,
): CostBasisState {
  if (newSolAmount <= 0 || acquisitionPriceUsdc <= 0) {
    // Nothing to record; just return current state
    return readCostBasis(db);
  }

  const current = readCostBasis(db);

  const newTotalAcquired = current.solTotalAcquired + newSolAmount;
  const newTotalCost = current.solTotalCost + newSolAmount * acquisitionPriceUsdc;
  const newBasis = newTotalAcquired > 0 ? newTotalCost / newTotalAcquired : acquisitionPriceUsdc;

  const updated: CostBasisState = {
    solCostBasis: newBasis,
    solTotalAcquired: newTotalAcquired,
    solTotalCost: newTotalCost,
    costBasisLastUpdated: Date.now(),
  };

  writeCostBasis(db, updated);

  console.log(JSON.stringify({
    level: 'info',
    msg: `COST_BASIS: updated via ${source}: +${newSolAmount.toFixed(4)} SOL @ $${acquisitionPriceUsdc.toFixed(2)} → new basis $${newBasis.toFixed(2)} (total ${newTotalAcquired.toFixed(4)} SOL, cost $${newTotalCost.toFixed(2)})`,
    timestamp: Date.now(),
  }));

  return updated;
}

/**
 * Reduce tracked SOL holdings after a sell event.
 * Decreases sol_total_acquired and sol_total_cost proportionally
 * so that sol_cost_basis remains unchanged.
 */
export function reduceCostBasisHoldings(
  db: Database.Database,
  solSoldAmount: number,
  label: string,
): void {
  const state = readCostBasis(db);
  if (!state.solCostBasis || state.solTotalAcquired <= 0) return;

  const newTotalAcquired = Math.max(0, state.solTotalAcquired - solSoldAmount);
  const reductionRatio = state.solTotalAcquired > 0 ? newTotalAcquired / state.solTotalAcquired : 0;
  const newTotalCost = state.solTotalCost * reductionRatio;

  db.prepare(
    `UPDATE bot_state SET sol_total_acquired = ?, sol_total_cost = ?, cost_basis_last_updated = ? WHERE id = 1`,
  ).run(newTotalAcquired, newTotalCost, Date.now());

  console.log(JSON.stringify({
    level: 'info',
    msg: `[CostBasis] Holdings reduced [${label}]: sold ${solSoldAmount.toFixed(3)} SOL. Tracked: ${state.solTotalAcquired.toFixed(3)} → ${newTotalAcquired.toFixed(3)} SOL. Basis unchanged: $${state.solCostBasis.toFixed(2)}`,
    timestamp: Date.now(),
  }));
}

/**
 * Reset cost basis totals to reflect current actual SOL holdings.
 * Keeps the existing weighted average basis (which is mathematically correct),
 * but resets sol_total_acquired and sol_total_cost to match real holdings.
 * This prevents lifetime-cumulative totals from growing unboundedly.
 *
 * Only triggers if sol_total_acquired > currentSolHeld * 2 (significantly off).
 */
export function recalculateFromCurrentHoldings(
  db: Database.Database,
  currentSolBalance: number,
): void {
  const existing = readCostBasis(db);
  if (!existing.solCostBasis || existing.solCostBasis <= 0) return;
  if (existing.solTotalAcquired <= currentSolBalance * 2) return; // not wildly off

  const newTotalAcquired = currentSolBalance;
  const newTotalCost = currentSolBalance * existing.solCostBasis;

  db.prepare(
    `UPDATE bot_state SET sol_total_acquired = ?, sol_total_cost = ?, cost_basis_last_updated = ? WHERE id = 1`,
  ).run(newTotalAcquired, newTotalCost, Date.now());

  console.log(JSON.stringify({
    level: 'info',
    msg: `[CostBasis] Reset to current holdings: ${currentSolBalance.toFixed(3)} SOL at basis $${existing.solCostBasis.toFixed(2)}. total_cost reset to $${newTotalCost.toFixed(2)} (was ${existing.solTotalAcquired.toFixed(1)} SOL / $${existing.solTotalCost.toFixed(0)})`,
    timestamp: Date.now(),
  }));
}

/**
 * Bootstrap cost basis from historical data on startup.
 * Reads swap_ledger (buy_sol) and rebalance_events (LP close SOL returns).
 * Writes the computed state to DB so it persists.
 * Skips if DB already has a non-zero cost_basis_last_updated (already initialised).
 * Set FORCE_RECALC = true and restart to rebuild cost basis from swap_ledger history.
 */
export function bootstrapCostBasis(db: Database.Database): CostBasisState {
  const FORCE_RECALC = false; // set to true and restart to rebuild from history
  const existing = readCostBasis(db);

  // If we've already persisted data, trust it over a cold recalc
  if (existing.costBasisLastUpdated > 0 && existing.solTotalAcquired > 0 && !FORCE_RECALC) {
    console.log(JSON.stringify({
      level: 'info',
      msg: `COST_BASIS: restored from DB — basis $${existing.solCostBasis.toFixed(2)}, tracked ${existing.solTotalAcquired.toFixed(4)} SOL`,
      timestamp: Date.now(),
    }));
    return existing;
  }

  // Cold start: reconstruct from historical tables
  let totalSol = 0;
  let totalCost = 0;

  try {
    // 1. swap_ledger: every USDC→SOL buy
    const buys = db.prepare(
      `SELECT sol_amount, price FROM swap_ledger WHERE direction = 'buy_sol' AND price > 0`,
    ).all() as Array<{ sol_amount: number; price: number }>;
    for (const b of buys) {
      totalSol += b.sol_amount;
      totalCost += b.sol_amount * b.price;
    }

    // 2. rebalance_events: SOL returned when LP position closes (sol_after > sol_before)
    const closes = db.prepare(
      `SELECT sol_after, sol_before, price FROM rebalance_events
       WHERE event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_ABOVE','OOR_BELOW','POSITION_CLOSED')
         AND sol_after > sol_before AND price > 0`,
    ).all() as Array<{ sol_after: number; sol_before: number; price: number }>;
    for (const c of closes) {
      const sol = c.sol_after - c.sol_before;
      totalSol += sol;
      totalCost += sol * c.price;
    }
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: `COST_BASIS: bootstrap query failed: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: Date.now(),
    }));
  }

  const basis = totalSol > 0 ? totalCost / totalSol : 0;

  const state: CostBasisState = {
    solCostBasis: basis,
    solTotalAcquired: totalSol,
    solTotalCost: totalCost,
    costBasisLastUpdated: totalSol > 0 ? Date.now() : 0,
  };

  if (totalSol > 0) {
    writeCostBasis(db, state);
    console.log(JSON.stringify({
      level: 'info',
      msg: `COST_BASIS: bootstrapped from history — basis $${basis.toFixed(2)}, ${totalSol.toFixed(4)} SOL across ${0} swaps+closes`,
      timestamp: Date.now(),
    }));
  } else {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'COST_BASIS: no historical data found, will start tracking from first acquisition',
      timestamp: Date.now(),
    }));
  }

  return state;
}
