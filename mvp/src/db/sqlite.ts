import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Regime, BotState, RebalanceEvent } from '../types.js';

// Row types
export interface PriceTickRow {
  timestamp: number;
  price: number;
  confidence: number;
  regime: Regime;
  prox_lower: number | null;
  prox_upper: number | null;
  in_range: number;
  source?: string;
}

export interface BotStateRow {
  state: BotState;
  regime: Regime | null;
  position_json: string | null;
  ledger_json?: string | null;
  naive_json?: string | null;
  updated_at: number;
  cum_fees_sol?: number;
  cum_fees_usdc?: number;
  realized_il?: number;
  tx_count?: number;
  cum_gas_lamports?: number;
  pullback_active?: number;  // DEPRECATED — kept for DB compat
  pullback_peak?: number;    // DEPRECATED
  pullback_start?: number;   // DEPRECATED
  last_upside_exit_price?: number;
  last_upside_exit_ts?: number;
  last_harvest_time?: number;
  // Cost basis tracking
  sol_cost_basis?: number;
  sol_total_acquired?: number;
  sol_total_cost?: number;
  cost_basis_last_updated?: number;
  // USDC reserve
  usdc_reserve?: number;
  usdc_reserve_floor?: number;
  reserve_state?: 'FULL' | 'REFILLING' | 'EMPTY';
  reserve_last_updated?: number;
}

export interface DailyPnlRow {
  date: string;
  opening_value: number | null;
  closing_value: number | null;
  fees_sol: number;
  fees_usdc: number;
  il_cost: number;
  net_pnl: number | null;
  net_pnl_pct: number | null;
  rebalances: number;
  in_range_pct: number | null;
  regime: string | null;
}

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS price_ticks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL,
      price       REAL NOT NULL,
      confidence  REAL NOT NULL,
      regime      TEXT NOT NULL,
      prox_lower  REAL,
      prox_upper  REAL,
      in_range    INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'live'
    );

    CREATE TABLE IF NOT EXISTS rebalance_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      price       REAL NOT NULL,
      regime      TEXT NOT NULL,
      note        TEXT,
      sol_before  REAL,
      usdc_before REAL,
      sol_after   REAL,
      usdc_after  REAL,
      fee_sol     REAL DEFAULT 0,
      fee_usdc    REAL DEFAULT 0,
      il_at_close REAL DEFAULT 0,
      rule2_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_pnl (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT UNIQUE NOT NULL,
      opening_value REAL,
      closing_value REAL,
      fees_sol      REAL DEFAULT 0,
      fees_usdc     REAL DEFAULT 0,
      il_cost       REAL DEFAULT 0,
      net_pnl       REAL,
      net_pnl_pct   REAL,
      rebalances    INTEGER DEFAULT 0,
      in_range_pct  REAL,
      regime        TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_summary (
      date            TEXT PRIMARY KEY,
      wallet_usdc     REAL NOT NULL,
      position_usdc   REAL NOT NULL,
      total_usdc      REAL NOT NULL,
      injected_usdc   REAL DEFAULT 0,
      fees_earned_usdc REAL DEFAULT 0,
      cum_fees_usdc   REAL DEFAULT 0,
      portfolio_change REAL DEFAULT 0,
      sol_price       REAL NOT NULL,
      regime          TEXT,
      in_range_pct    REAL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_state (
      id             INTEGER PRIMARY KEY DEFAULT 1,
      state          TEXT NOT NULL DEFAULT 'IDLE',
      regime         TEXT,
      position_json  TEXT,
      ledger_json    TEXT,
      naive_json     TEXT,
      updated_at     INTEGER NOT NULL,
      cum_fees_sol   REAL DEFAULT 0,
      cum_fees_usdc  REAL DEFAULT 0,
      realized_il    REAL DEFAULT 0,
      tx_count       INTEGER DEFAULT 0,
      cum_gas_lamports INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS live_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      price           REAL NOT NULL,
      sol_balance     REAL NOT NULL,
      usdc_balance    REAL NOT NULL,
      total_value_usdc REAL NOT NULL,
      pending_fees_sol REAL DEFAULT 0,
      pending_fees_usdc REAL DEFAULT 0,
      cum_fees_sol    REAL DEFAULT 0,
      cum_fees_usdc   REAL DEFAULT 0,
      il_usdc         REAL DEFAULT 0,
      in_range        INTEGER DEFAULT 0,
      regime          TEXT,
      position_mint   TEXT,
      position_sol    REAL DEFAULT 0,
      position_usdc   REAL DEFAULT 0,
      position_value  REAL DEFAULT 0,
      total_with_position REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS decision_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      price           REAL NOT NULL,
      regime          TEXT NOT NULL,
      bot_state       TEXT NOT NULL,
      prox_lower      REAL,
      prox_upper      REAL,
      in_range        INTEGER,
      decision        TEXT NOT NULL,
      reasoning       TEXT NOT NULL,
      params_json     TEXT
    );

    CREATE TABLE IF NOT EXISTS regime_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      old_regime      TEXT NOT NULL,
      new_regime      TEXT NOT NULL,
      price           REAL NOT NULL,
      dir_ratio       REAL,
      realised_vol    REAL,
      price_count     INTEGER
    );

    CREATE TABLE IF NOT EXISTS rule_toggles (
      rule_name       TEXT PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 1,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS investors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      invest_date TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);

  // swap_ledger table (added 2026-04-13; use CREATE IF NOT EXISTS so fresh DBs get it too)
  db.exec(`
    CREATE TABLE IF NOT EXISTS swap_ledger (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp         INTEGER NOT NULL,
      direction         TEXT NOT NULL,
      sol_amount        REAL NOT NULL,
      usdc_amount       REAL NOT NULL,
      price             REAL NOT NULL,
      reason            TEXT,
      pnl_usdc          REAL,
      cost_basis_before REAL DEFAULT 0,
      cost_basis_after  REAL DEFAULT 0
    );
  `);
  // Migration helper: suppress "duplicate column" errors, log anything else
  const migrate = (sql: string) => {
    try { db.exec(sql); } catch (e: any) {
      if (!e?.message?.includes('duplicate column') && !e?.message?.includes('already exists')) {
        console.log(JSON.stringify({ level: 'warn', msg: `[Migration] ${e?.message ?? 'unknown error'}`, timestamp: Date.now() }));
      }
    }
  };

  // Migration: add swap metadata columns to swap_ledger
  migrate(`ALTER TABLE swap_ledger ADD COLUMN tx_signature TEXT DEFAULT NULL`);
  migrate(`ALTER TABLE swap_ledger ADD COLUMN fee_lamports INTEGER DEFAULT NULL`);
  migrate(`ALTER TABLE swap_ledger ADD COLUMN price_impact_pct REAL DEFAULT NULL`);
  migrate(`ALTER TABLE swap_ledger ADD COLUMN source TEXT DEFAULT 'bot'`);
  migrate(`ALTER TABLE swap_ledger ADD COLUMN swap_hash TEXT DEFAULT NULL`);
  // Partial unique index on swap_hash: rejects duplicate swaps (e.g. Jupiter+Orca
  // double-execution when confirmation timed out). NULL values are allowed for
  // legacy rows that pre-date the hash.
  migrate(`CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_ledger_hash ON swap_ledger(swap_hash) WHERE swap_hash IS NOT NULL`);
  // Backfill: tag manual swaps detected via balance diff
  try {
    db.exec(`UPDATE swap_ledger SET source = 'manual' WHERE (reason LIKE '%Manual swap%' OR reason LIKE '%manual%' OR reason LIKE '%balance diff%') AND (source IS NULL OR source = 'bot')`);
    db.exec(`UPDATE swap_ledger SET source = 'bot' WHERE source IS NULL OR source = ''`);
  } catch (e: any) {
    console.log(JSON.stringify({ level: 'warn', msg: `[Migration] backfill swap source: ${e?.message ?? 'unknown'}`, timestamp: Date.now() }));
  }

  // Migration: add pullback state columns to bot_state (DEPRECATED — kept for compat)
  migrate(`ALTER TABLE bot_state ADD COLUMN pullback_active INTEGER DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN pullback_peak REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN pullback_start INTEGER DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN last_harvest_time INTEGER DEFAULT 0`);

  // Migration: add upside exit tracking columns to bot_state
  migrate(`ALTER TABLE bot_state ADD COLUMN last_upside_exit_price REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN last_upside_exit_ts INTEGER DEFAULT 0`);

  // Migration: add rule2_active column to existing rebalance_events tables
  migrate(`ALTER TABLE rebalance_events ADD COLUMN rule2_active INTEGER DEFAULT 1`);

  // Migration: add position_id column for per-position P&L tracking
  migrate(`ALTER TABLE rebalance_events ADD COLUMN position_id TEXT`);

  // Migration: add cost basis tracking columns to bot_state
  migrate(`ALTER TABLE bot_state ADD COLUMN sol_cost_basis REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN sol_total_acquired REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN sol_total_cost REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN cost_basis_last_updated INTEGER DEFAULT 0`);

  // Migration: add USDC reserve columns to bot_state
  migrate(`ALTER TABLE bot_state ADD COLUMN usdc_reserve REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN usdc_reserve_floor REAL DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN reserve_state TEXT DEFAULT 'EMPTY'`);
  migrate(`ALTER TABLE bot_state ADD COLUMN reserve_last_updated INTEGER DEFAULT 0`);

  // Migration: SOL conversion tracking
  migrate(`ALTER TABLE bot_state ADD COLUMN sol_conversion_enabled INTEGER DEFAULT 0`);
  migrate(`ALTER TABLE bot_state ADD COLUMN sol_conversion_last_ts INTEGER DEFAULT 0`);

  // Portfolio snapshots — 4-hourly value tracking for arcade page
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    total_value REAL NOT NULL
  )`);

  // Regime snapshots — per-cycle data capture for post-hoc analysis
  db.exec(`CREATE TABLE IF NOT EXISTS regime_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    regime TEXT NOT NULL,
    prev_regime TEXT,
    regime_changed INTEGER DEFAULT 0,
    confidence TEXT NOT NULL,
    deploy_pct REAL,
    veto_fired INTEGER DEFAULT 0,
    ta_score_bullish INTEGER,
    ta_score_ranging INTEGER,
    ta_score_bearish INTEGER,
    ta_score_extreme INTEGER,
    ta_winner TEXT,
    ta_total_score INTEGER,
    ema9 REAL, sma20 REAL, ema_cross TEXT,
    rsi REAL, bb_width REAL, bb_position REAL, atr REAL,
    vol_1h REAL, sol_change_4h REAL, fear_greed INTEGER, btc_change_4h REAL,
    price REAL NOT NULL,
    position_state TEXT,
    position_age_min REAL,
    proximity_lower REAL, proximity_upper REAL,
    reserve_gate TEXT, basis_gate TEXT, churn_guard TEXT,
    daily_regime TEXT,
    ta_data_age_min INTEGER DEFAULT 0
  )`);
  migrate(`ALTER TABLE regime_snapshots ADD COLUMN ta_data_age_min INTEGER DEFAULT 0`);

  // Indexes for query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_regime_snapshots_ts ON regime_snapshots(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_log_ts ON decision_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_rebalance_events_ts ON rebalance_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_live_snapshots_ts ON live_snapshots(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_price_ticks_ts ON price_ticks(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_swap_ledger_ts ON swap_ledger(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts ON portfolio_snapshots(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_regime_history_ts ON regime_history(timestamp DESC);
  `);

  return db;
}

export function insertPriceTick(db: Database.Database, tick: PriceTickRow): void {
  const stmt = db.prepare(`
    INSERT INTO price_ticks (timestamp, price, confidence, regime, prox_lower, prox_upper, in_range, source)
    VALUES (@timestamp, @price, @confidence, @regime, @prox_lower, @prox_upper, @in_range, @source)
  `);
  stmt.run({ ...tick, source: tick.source ?? 'live' });
}

export function getDailyCloses(db: Database.Database, days: number): number[] {
  const stmt = db.prepare(`
    SELECT price FROM price_ticks
    WHERE timestamp >= (strftime('%s','now') - ? * 86400) * 1000
    GROUP BY date(datetime(timestamp/1000,'unixepoch'))
    HAVING timestamp = MAX(timestamp)
    ORDER BY date(datetime(timestamp/1000,'unixepoch')) ASC
  `);
  const rows = stmt.all(days) as Array<{ price: number }>;
  return rows.map(r => r.price);
}

export function backfillPriceHistory(db: Database.Database, closes: Array<{ timestamp: number; price: number }>): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO price_ticks (timestamp, price, confidence, regime, in_range, source)
    VALUES (@timestamp, @price, 0, 'RANGING', 0, 'backfill')
  `);
  const insertMany = db.transaction((items: Array<{ timestamp: number; price: number }>) => {
    for (const item of items) {
      stmt.run(item);
    }
  });
  insertMany(closes);
}

export function getHistoryDayCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT date(datetime(timestamp/1000,'unixepoch'))) as count
    FROM price_ticks
  `).get() as { count: number };
  return row.count;
}

export function insertRebalanceEvent(db: Database.Database, event: RebalanceEvent & { rule2Active?: number; positionId?: string }): void {
  const stmt = db.prepare(`
    INSERT INTO rebalance_events (timestamp, event_type, price, regime, note, sol_before, usdc_before, sol_after, usdc_after, fee_sol, fee_usdc, il_at_close, rule2_active, position_id)
    VALUES (@timestamp, @eventType, @price, @regime, @note, @solBefore, @usdcBefore, @solAfter, @usdcAfter, @feeSol, @feeUsdc, @ilAtClose, @rule2Active, @positionId)
  `);
  stmt.run({ ...event, rule2Active: event.rule2Active ?? 1, positionId: event.positionId ?? null });
}

export function getRebalanceEvents(db: Database.Database, limit: number): RebalanceEvent[] {
  const rows = db.prepare(`
    SELECT timestamp, event_type, price, regime, note, sol_before, usdc_before, sol_after, usdc_after, fee_sol, fee_usdc, il_at_close, position_id
    FROM rebalance_events
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{
    timestamp: number; event_type: string; price: number; regime: string; note: string;
    sol_before: number; usdc_before: number; sol_after: number; usdc_after: number;
    fee_sol: number; fee_usdc: number; il_at_close: number; position_id: string | null;
  }>;
  return rows.map(r => ({
    timestamp: r.timestamp,
    eventType: r.event_type as RebalanceEvent['eventType'],
    price: r.price,
    regime: r.regime as RebalanceEvent['regime'],
    note: r.note,
    solBefore: r.sol_before,
    usdcBefore: r.usdc_before,
    solAfter: r.sol_after,
    usdcAfter: r.usdc_after,
    feeSol: r.fee_sol,
    feeUsdc: r.fee_usdc,
    ilAtClose: r.il_at_close,
    positionId: r.position_id,
  }));
}

export function upsertBotState(db: Database.Database, state: BotStateRow): void {
  // Log any basis mutation coming through upsertBotState so silent stomps become visible.
  // Catches cases where caller's in-memory cost basis is stale (see BUG-1 class bugs).
  try {
    const prior = db.prepare('SELECT sol_cost_basis FROM bot_state WHERE id = 1').get() as { sol_cost_basis: number } | undefined;
    const newBasis = state.sol_cost_basis;
    if (prior && newBasis != null && prior.sol_cost_basis > 0 && Math.abs(newBasis - prior.sol_cost_basis) > 0.01) {
      console.log(JSON.stringify({
        level: 'info',
        msg: '[CostBasis] upsertBotState mutation',
        from: prior.sol_cost_basis,
        to: newBasis,
        delta: newBasis - prior.sol_cost_basis,
        timestamp: Date.now(),
      }));
    }
  } catch { /* non-fatal diagnostic */ }

  db.prepare(`
    INSERT OR REPLACE INTO bot_state (id, state, regime, position_json, ledger_json, naive_json, updated_at, cum_fees_sol, cum_fees_usdc, realized_il, tx_count, cum_gas_lamports, pullback_active, pullback_peak, pullback_start, last_harvest_time, sol_cost_basis, sol_total_acquired, sol_total_cost, cost_basis_last_updated, usdc_reserve, usdc_reserve_floor, reserve_state, reserve_last_updated, last_upside_exit_price, last_upside_exit_ts)
    VALUES (1, @state, @regime, @position_json, @ledger_json, @naive_json, @updated_at, @cum_fees_sol, @cum_fees_usdc, @realized_il, @tx_count, @cum_gas_lamports, @pullback_active, @pullback_peak, @pullback_start, @last_harvest_time, @sol_cost_basis, @sol_total_acquired, @sol_total_cost, @cost_basis_last_updated, @usdc_reserve, @usdc_reserve_floor, @reserve_state, @reserve_last_updated, @last_upside_exit_price, @last_upside_exit_ts)
  `).run({
    ...state,
    ledger_json: state.ledger_json ?? null,
    naive_json: state.naive_json ?? null,
    cum_fees_sol: state.cum_fees_sol ?? 0,
    cum_fees_usdc: state.cum_fees_usdc ?? 0,
    realized_il: state.realized_il ?? 0,
    tx_count: state.tx_count ?? 0,
    cum_gas_lamports: state.cum_gas_lamports ?? 0,
    pullback_active: state.pullback_active ?? 0,
    pullback_peak: state.pullback_peak ?? 0,
    pullback_start: state.pullback_start ?? 0,
    last_harvest_time: state.last_harvest_time ?? 0,
    last_upside_exit_price: state.last_upside_exit_price ?? 0,
    last_upside_exit_ts: state.last_upside_exit_ts ?? 0,
    sol_cost_basis: state.sol_cost_basis ?? 0,
    sol_total_acquired: state.sol_total_acquired ?? 0,
    sol_total_cost: state.sol_total_cost ?? 0,
    cost_basis_last_updated: state.cost_basis_last_updated ?? 0,
    usdc_reserve: state.usdc_reserve ?? (getBotState(db)?.usdc_reserve ?? 0),
    usdc_reserve_floor: state.usdc_reserve_floor ?? (getBotState(db)?.usdc_reserve_floor ?? 0),
    reserve_state: state.reserve_state ?? (getBotState(db)?.reserve_state ?? 'EMPTY'),
    reserve_last_updated: state.reserve_last_updated ?? (getBotState(db)?.reserve_last_updated ?? 0),
  });
}

export function getBotState(db: Database.Database): BotStateRow | null {
  const row = db.prepare(`SELECT state, regime, position_json, ledger_json, naive_json, updated_at, cum_fees_sol, cum_fees_usdc, realized_il, tx_count, cum_gas_lamports, pullback_active, pullback_peak, pullback_start, last_harvest_time, sol_cost_basis, sol_total_acquired, sol_total_cost, cost_basis_last_updated, usdc_reserve, usdc_reserve_floor, reserve_state, reserve_last_updated, last_upside_exit_price, last_upside_exit_ts FROM bot_state WHERE id = 1`).get() as BotStateRow | undefined;
  return row ?? null;
}

export function upsertDailyPnl(db: Database.Database, pnl: DailyPnlRow): void {
  db.prepare(`
    INSERT INTO daily_pnl (date, opening_value, closing_value, fees_sol, fees_usdc, il_cost, net_pnl, net_pnl_pct, rebalances, in_range_pct, regime)
    VALUES (@date, @opening_value, @closing_value, @fees_sol, @fees_usdc, @il_cost, @net_pnl, @net_pnl_pct, @rebalances, @in_range_pct, @regime)
    ON CONFLICT(date) DO UPDATE SET
      opening_value = @opening_value,
      closing_value = @closing_value,
      fees_sol = @fees_sol,
      fees_usdc = @fees_usdc,
      il_cost = @il_cost,
      net_pnl = @net_pnl,
      net_pnl_pct = @net_pnl_pct,
      rebalances = @rebalances,
      in_range_pct = @in_range_pct,
      regime = @regime
  `).run(pnl);
}

export function getDailyPnl(db: Database.Database, days: number): DailyPnlRow[] {
  return db.prepare(`
    SELECT * FROM daily_pnl
    WHERE date >= date('now', '-' || ? || ' days')
    ORDER BY date ASC
  `).all(days) as DailyPnlRow[];
}

// ── Fee query helpers ─────────────────────────────────────────────────────
// Single source of truth: rebalance_events (actual fees collected at close/harvest).
// SOL fees valued at event-time price (stored in `price` column).

export function getFeesCollected(db: Database.Database, opts: {
  fromTs?: number;
  toTs?: number;
  currentPrice?: number; // if provided, values SOL at this price instead of event price
} = {}): number {
  const useCurrentPrice = opts.currentPrice != null;
  let sql = `
    SELECT COALESCE(SUM(
      fee_usdc + fee_sol * ${useCurrentPrice ? '?' : 'COALESCE(price, 0)'}
    ), 0) as total
    FROM rebalance_events
    WHERE (fee_usdc > 0 OR fee_sol > 0)
  `;
  const params: any[] = useCurrentPrice ? [opts.currentPrice] : [];

  if (opts.fromTs != null) {
    sql += ` AND timestamp >= ?`;
    params.push(opts.fromTs);
  }
  if (opts.toTs != null) {
    sql += ` AND timestamp <= ?`;
    params.push(opts.toTs);
  }

  const row = db.prepare(sql).get(...params) as { total: number };
  return row?.total ?? 0;
}

export function getFeesCollectedByDay(db: Database.Database, days: number = 30, currentPrice?: number): { date: string; fees: number; events: number }[] {
  const useCurrentPrice = currentPrice != null;
  return db.prepare(`
    SELECT
      DATE(timestamp / 1000, 'unixepoch') as date,
      ROUND(SUM(fee_usdc + fee_sol * ${useCurrentPrice ? '?' : 'COALESCE(price, 0)'}), 4) as fees,
      COUNT(*) as events
    FROM rebalance_events
    WHERE (fee_usdc > 0 OR fee_sol > 0)
    AND timestamp >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(...(useCurrentPrice ? [currentPrice, Date.now() - days * 86400_000] : [Date.now() - days * 86400_000])) as { date: string; fees: number; events: number }[];
}

export function pruneOldPriceTicks(db: Database.Database, keepDays: number): void {
  db.prepare(`
    DELETE FROM price_ticks
    WHERE source != 'backfill'
    AND timestamp < (strftime('%s','now') - ? * 86400) * 1000
  `).run(keepDays);
}

export function pruneOldData(db: Database.Database): void {
  const now = Date.now();
  const day7 = now - 7 * 24 * 3600_000;
  const day30 = now - 30 * 24 * 3600_000;
  const tables: Array<{ table: string; col: string; cutoff: number }> = [
    { table: 'live_snapshots', col: 'timestamp', cutoff: day7 },
    { table: 'decision_log', col: 'timestamp', cutoff: day7 },
    { table: 'portfolio_snapshots', col: 'ts', cutoff: day30 },
  ];
  for (const { table, col, cutoff } of tables) {
    try {
      const result = db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
      if ((result as any).changes > 0) {
        console.log(JSON.stringify({ level: 'info', msg: `[DBPrune] ${table}: deleted ${(result as any).changes} old rows`, timestamp: now }));
      }
    } catch (e) {
      console.log(JSON.stringify({ level: 'warn', msg: `[DBPrune] ${table} pruning failed: ${String(e)}`, timestamp: now }));
    }
  }
}

// ── Live snapshots ────────────────────────────────────────────────────────

export interface LiveSnapshotRow {
  timestamp: number;
  price: number;
  sol_balance: number;
  usdc_balance: number;
  total_value_usdc: number;
  pending_fees_sol: number;
  pending_fees_usdc: number;
  cum_fees_sol: number;
  cum_fees_usdc: number;
  il_usdc: number;
  in_range: number;
  regime: string;
  position_mint: string | null;
  position_sol: number;
  position_usdc: number;
  position_value: number;
  total_with_position: number;
}

export function insertLiveSnapshot(db: Database.Database, snap: LiveSnapshotRow): void {
  db.prepare(`
    INSERT INTO live_snapshots (timestamp, price, sol_balance, usdc_balance, total_value_usdc,
      pending_fees_sol, pending_fees_usdc, cum_fees_sol, cum_fees_usdc, il_usdc,
      in_range, regime, position_mint, position_sol, position_usdc, position_value, total_with_position)
    VALUES (@timestamp, @price, @sol_balance, @usdc_balance, @total_value_usdc,
      @pending_fees_sol, @pending_fees_usdc, @cum_fees_sol, @cum_fees_usdc, @il_usdc,
      @in_range, @regime, @position_mint, @position_sol, @position_usdc, @position_value, @total_with_position)
  `).run(snap);
}

export function getLiveSnapshots(db: Database.Database, hours: number): LiveSnapshotRow[] {
  return db.prepare(`
    SELECT * FROM live_snapshots
    WHERE timestamp >= ? ORDER BY timestamp ASC
  `).all(Date.now() - hours * 3600_000) as LiveSnapshotRow[];
}

export function getLiveInRangePct(db: Database.Database, hours: number): number {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN in_range = 1 THEN 1 ELSE 0 END) as in_range_count
    FROM live_snapshots WHERE timestamp >= ?
  `).get(Date.now() - hours * 3600_000) as { total: number; in_range_count: number };
  return row.total > 0 ? (row.in_range_count / row.total) * 100 : 0;
}

// ── Decision log ──────────────────────────────────────────────────────────

export interface DecisionLogRow {
  timestamp: number;
  price: number;
  regime: string;
  bot_state: string;
  prox_lower: number | null;
  prox_upper: number | null;
  in_range: number | null;
  decision: string;
  reasoning: string;
  params_json: string | null;
}

export function insertDecisionLog(db: Database.Database, log: DecisionLogRow): void {
  db.prepare(`
    INSERT INTO decision_log (timestamp, price, regime, bot_state, prox_lower, prox_upper,
      in_range, decision, reasoning, params_json)
    VALUES (@timestamp, @price, @regime, @bot_state, @prox_lower, @prox_upper,
      @in_range, @decision, @reasoning, @params_json)
  `).run(log);
}

export function getDecisionLogs(db: Database.Database, limit: number): DecisionLogRow[] {
  return db.prepare(`
    SELECT * FROM decision_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as DecisionLogRow[];
}

// ── Regime history ────────────────────────────────────────────────────────

export interface RegimeHistoryRow {
  timestamp: number;
  old_regime: string;
  new_regime: string;
  price: number;
  dir_ratio: number | null;
  realised_vol: number | null;
  price_count: number | null;
}

export function insertRegimeChange(db: Database.Database, row: RegimeHistoryRow): void {
  db.prepare(`
    INSERT INTO regime_history (timestamp, old_regime, new_regime, price, dir_ratio, realised_vol, price_count)
    VALUES (@timestamp, @old_regime, @new_regime, @price, @dir_ratio, @realised_vol, @price_count)
  `).run(row);
}

export function getRegimeHistory(db: Database.Database, limit: number): RegimeHistoryRow[] {
  return db.prepare(`
    SELECT * FROM regime_history ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as RegimeHistoryRow[];
}

// ── Rule 2 performance comparison ────────────────────────────────────────

export interface Rule2PerfRow {
  rule2_active: number;
  event_count: number;
  total_fee_sol: number;
  total_fee_usdc: number;
  total_il: number;
  avg_fee_sol: number;
  avg_fee_usdc: number;
  avg_il: number;
  first_event: number;
  last_event: number;
}

export function getRule2PerfComparison(db: Database.Database): Rule2PerfRow[] {
  return db.prepare(`
    SELECT
      rule2_active,
      COUNT(*) as event_count,
      COALESCE(SUM(fee_sol), 0) as total_fee_sol,
      COALESCE(SUM(fee_usdc), 0) as total_fee_usdc,
      COALESCE(SUM(il_at_close), 0) as total_il,
      COALESCE(AVG(fee_sol), 0) as avg_fee_sol,
      COALESCE(AVG(fee_usdc), 0) as avg_fee_usdc,
      COALESCE(AVG(il_at_close), 0) as avg_il,
      MIN(timestamp) as first_event,
      MAX(timestamp) as last_event
    FROM rebalance_events
    WHERE event_type IN ('T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'POSITION_CLOSED')
    GROUP BY rule2_active
  `).all() as Rule2PerfRow[];
}

export function getRule2EventsCsv(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT timestamp, event_type, price, regime, fee_sol, fee_usdc, il_at_close, rule2_active,
           sol_before, usdc_before, sol_after, usdc_after, note
    FROM rebalance_events
    ORDER BY timestamp ASC
  `).all() as Array<any>;
  const header = 'timestamp,datetime,event_type,price,regime,fee_sol,fee_usdc,il_at_close,rule2_active,sol_before,usdc_before,sol_after,usdc_after,note';
  const lines = rows.map(r => {
    const dt = new Date(r.timestamp).toISOString();
    const note = (r.note ?? '').replace(/,/g, ';').replace(/\n/g, ' ');
    return `${r.timestamp},${dt},${r.event_type},${r.price},${r.regime},${r.fee_sol},${r.fee_usdc},${r.il_at_close},${r.rule2_active},${r.sol_before},${r.usdc_before},${r.sol_after},${r.usdc_after},"${note}"`;
  });
  return [header, ...lines].join('\n');
}

// ── Rule toggles ─────────────────────────────────────────────────────────

export function getRuleEnabled(db: Database.Database, ruleName: string): boolean {
  const row = db.prepare(`SELECT enabled FROM rule_toggles WHERE rule_name = ?`).get(ruleName) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true; // default enabled if no row
}

export function setRuleEnabled(db: Database.Database, ruleName: string, enabled: boolean): void {
  db.prepare(`
    INSERT INTO rule_toggles (rule_name, enabled, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(rule_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(ruleName, enabled ? 1 : 0, Date.now());
}

// ── Export helpers ─────────────────────────────────────────────────────────

export function exportAllData(db: Database.Database): {
  price_ticks: unknown[];
  rebalance_events: unknown[];
  live_snapshots: unknown[];
  decision_log: unknown[];
  regime_history: unknown[];
  daily_pnl: unknown[];
} {
  return {
    price_ticks: db.prepare('SELECT * FROM price_ticks ORDER BY timestamp ASC').all(),
    rebalance_events: db.prepare('SELECT * FROM rebalance_events ORDER BY timestamp ASC').all(),
    live_snapshots: db.prepare('SELECT * FROM live_snapshots ORDER BY timestamp ASC').all(),
    decision_log: db.prepare('SELECT * FROM decision_log ORDER BY timestamp ASC').all(),
    regime_history: db.prepare('SELECT * FROM regime_history ORDER BY timestamp ASC').all(),
    daily_pnl: db.prepare('SELECT * FROM daily_pnl ORDER BY date ASC').all(),
  };
}

// ── Daily summary ────────────────────────────────────────────────────────

export interface DailySummaryRow {
  date: string;
  wallet_usdc: number;
  position_usdc: number;
  total_usdc: number;
  injected_usdc: number;
  fees_earned_usdc: number;
  cum_fees_usdc: number;
  portfolio_change: number;
  sol_price: number;
  regime: string | null;
  in_range_pct: number | null;
}

export function upsertDailySummary(db: Database.Database, row: DailySummaryRow): void {
  db.prepare(`
    INSERT INTO daily_summary (date, wallet_usdc, position_usdc, total_usdc, injected_usdc, fees_earned_usdc, cum_fees_usdc, portfolio_change, sol_price, regime, in_range_pct, updated_at)
    VALUES (@date, @wallet_usdc, @position_usdc, @total_usdc, @injected_usdc, @fees_earned_usdc, @cum_fees_usdc, @portfolio_change, @sol_price, @regime, @in_range_pct, @updated_at)
    ON CONFLICT(date) DO UPDATE SET
      wallet_usdc = excluded.wallet_usdc, position_usdc = excluded.position_usdc, total_usdc = excluded.total_usdc,
      injected_usdc = excluded.injected_usdc, fees_earned_usdc = excluded.fees_earned_usdc, cum_fees_usdc = excluded.cum_fees_usdc,
      portfolio_change = excluded.portfolio_change, sol_price = excluded.sol_price, regime = excluded.regime,
      in_range_pct = excluded.in_range_pct, updated_at = excluded.updated_at
  `).run({ ...row, updated_at: Date.now() });
}

export function getDailySummaries(db: Database.Database, limit: number): DailySummaryRow[] {
  return db.prepare('SELECT * FROM daily_summary ORDER BY date DESC LIMIT ?').all(limit) as DailySummaryRow[];
}

export function getAllDailySummaries(db: Database.Database): DailySummaryRow[] {
  return db.prepare('SELECT * FROM daily_summary ORDER BY date ASC').all() as DailySummaryRow[];
}

// ── Config key-value store ───────────────────────────────────────────────

export function getConfig(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM config').all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

export function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, Date.now());
}

// ── Swap Ledger (cost basis tracking) ────────────────────────────────────

export function insertSwapLedger(db: Database.Database, entry: {
  timestamp: number; direction: string; sol_amount: number; usdc_amount: number;
  price: number; reason: string; pnl_usdc: number | null;
  cost_basis_before: number; cost_basis_after: number;
  tx_signature?: string | null; fee_lamports?: number | null; price_impact_pct?: number | null;
  source?: string;
}): void {
  // Dedup key: tx_signature if present (unique per on-chain tx). Otherwise a content
  // hash of direction + sol_amount + 10s time bucket so a double-insert from retry logic
  // is rejected by the partial unique index.
  const swapHash = entry.tx_signature
    ? `tx:${entry.tx_signature}`
    : `${entry.direction}|${entry.sol_amount.toFixed(6)}|${Math.floor(entry.timestamp / 10000)}`;
  const info = db.prepare(`INSERT OR IGNORE INTO swap_ledger (timestamp, direction, sol_amount, usdc_amount, price, reason, pnl_usdc, cost_basis_before, cost_basis_after, tx_signature, fee_lamports, price_impact_pct, source, swap_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.timestamp, entry.direction, entry.sol_amount, entry.usdc_amount,
    entry.price, entry.reason, entry.pnl_usdc, entry.cost_basis_before, entry.cost_basis_after,
    entry.tx_signature ?? null, entry.fee_lamports ?? null, entry.price_impact_pct ?? null,
    entry.source ?? 'bot', swapHash,
  );
  if (info.changes === 0) {
    console.log(JSON.stringify({ level: 'warn', msg: `[swap_ledger] duplicate rejected: hash=${swapHash.slice(0, 40)} direction=${entry.direction} sol=${entry.sol_amount.toFixed(4)} reason=${entry.reason.slice(0, 60)}`, timestamp: Date.now() }));
  }
}

export function getSwapLedger(db: Database.Database, limit = 50): any[] {
  return db.prepare('SELECT * FROM swap_ledger ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getSwapPnlSummary(db: Database.Database): { totalPnl: number; swapCount: number; profitable: number; unprofitable: number } {
  const rows = db.prepare("SELECT pnl_usdc FROM swap_ledger WHERE direction = 'sell_sol' AND pnl_usdc IS NOT NULL").all() as any[];
  let totalPnl = 0, profitable = 0, unprofitable = 0;
  for (const r of rows) {
    totalPnl += r.pnl_usdc;
    if (r.pnl_usdc >= 0) profitable++; else unprofitable++;
  }
  return { totalPnl, swapCount: rows.length, profitable, unprofitable };
}

export function setConfigBatch(db: Database.Database, entries: Record<string, string>): void {
  const stmt = db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      stmt.run(key, value, now);
    }
  });
  tx();
}

// ── Swap Ledger cost_basis_after backfill ─────────────────────────────────

/**
 * Backfills `cost_basis_after` (and `cost_basis_before`) in swap_ledger for any
 * rows where the field is 0 or NULL. Computes a running weighted-average across
 * all SOL acquisition events (swap buys + LP closes) ordered chronologically.
 *
 * Only runs when there are entries needing backfill, so it is safe to call on
 * every startup.
 */
export function backfillSwapLedgerCostBasis(db: Database.Database): void {
  // Quick check: are there any rows that need backfill?
  const needsBackfill = db.prepare(
    `SELECT COUNT(*) as cnt FROM swap_ledger WHERE cost_basis_after IS NULL OR cost_basis_after = 0`,
  ).get() as { cnt: number };
  if (needsBackfill.cnt === 0) return;

  // 1. All swap_ledger rows, oldest first
  const swaps = db.prepare(
    `SELECT id, timestamp, direction, sol_amount, price FROM swap_ledger ORDER BY timestamp ASC`,
  ).all() as Array<{ id: number; timestamp: number; direction: string; sol_amount: number; price: number }>;

  // 2. LP closes where SOL returned (sol_after > sol_before), oldest first
  const lpCloseTypes = `('T1_DOWNSIDE','T1_UPSIDE','OOR_ABOVE','OOR_BELOW','POSITION_CLOSED')`;
  const closes = db.prepare(
    `SELECT timestamp, sol_after, sol_before, price FROM rebalance_events
     WHERE event_type IN ${lpCloseTypes}
       AND sol_after > sol_before AND price > 0
     ORDER BY timestamp ASC`,
  ).all() as Array<{ timestamp: number; sol_after: number; sol_before: number; price: number }>;

  // 3. Merge into chronological stream of acquisition events
  interface AcqEvent { timestamp: number; sol: number; price: number; swapId?: number; direction?: string }
  const acqEvents: AcqEvent[] = [];

  for (const s of swaps) {
    // buy_sol = USDC→SOL acquisition; sell_sol does not change cost basis
    if (s.direction === 'buy_sol' && s.sol_amount > 0 && s.price > 0) {
      acqEvents.push({ timestamp: s.timestamp, sol: s.sol_amount, price: s.price, swapId: s.id, direction: s.direction });
    }
    // Still include sell_sol as a "marker" so we can capture the basis snapshot at that point
    if (s.direction === 'sell_sol') {
      acqEvents.push({ timestamp: s.timestamp, sol: 0, price: s.price, swapId: s.id, direction: s.direction });
    }
  }

  for (const c of closes) {
    const sol = c.sol_after - c.sol_before;
    acqEvents.push({ timestamp: c.timestamp, sol, price: c.price });
  }

  // Sort by timestamp; swap entries already appear in order relative to close events
  acqEvents.sort((a, b) => a.timestamp - b.timestamp);

  // 4. Walk through computing running weighted average
  let totalSol = 0;
  let totalCost = 0;
  let runningBasis = 0;

  // Build a map: swapId → { basisBefore, basisAfter }
  const basisMap = new Map<number, { before: number; after: number }>();

  // Pre-populate with existing basis_before values so we don't overwrite
  // entries that were already correctly populated at insertion time.
  for (const s of swaps) {
    basisMap.set(s.id, { before: 0, after: 0 });
  }

  for (const ev of acqEvents) {
    const basisBefore = runningBasis;

    if (ev.sol > 0) {
      totalSol += ev.sol;
      totalCost += ev.sol * ev.price;
      runningBasis = totalSol > 0 ? totalCost / totalSol : ev.price;
    }

    // Attach basis snapshot to the corresponding swap row
    if (ev.swapId !== undefined) {
      basisMap.set(ev.swapId, { before: basisBefore, after: runningBasis });
    }
  }

  // 5. Write back only the rows that currently have cost_basis_after = 0 or NULL
  const updateStmt = db.prepare(
    `UPDATE swap_ledger SET cost_basis_before = ?, cost_basis_after = ? WHERE id = ? AND (cost_basis_after IS NULL OR cost_basis_after = 0)`,
  );
  const updateTx = db.transaction(() => {
    for (const [id, vals] of basisMap.entries()) {
      if (vals.after > 0) {
        updateStmt.run(vals.before, vals.after, id);
      }
    }
  });
  updateTx();

  console.log(JSON.stringify({
    level: 'info',
    msg: `COST_BASIS_BACKFILL: backfilled ${needsBackfill.cnt} swap_ledger rows`,
    timestamp: Date.now(),
  }));
}

// ── Regime Snapshots ─────────────────────────────────────────────────────

export interface RegimeSnapshotRow {
  ts: number;
  regime: string;
  prev_regime: string | null;
  regime_changed: number;
  confidence: string;
  deploy_pct: number | null;
  veto_fired: number;
  ta_score_bullish: number | null;
  ta_score_ranging: number | null;
  ta_score_bearish: number | null;
  ta_score_extreme: number | null;
  ta_winner: string | null;
  ta_total_score: number | null;
  ema9: number | null;
  sma20: number | null;
  ema_cross: string | null;
  rsi: number | null;
  bb_width: number | null;
  bb_position: number | null;
  atr: number | null;
  vol_1h: number | null;
  sol_change_4h: number | null;
  fear_greed: number | null;
  btc_change_4h: number | null;
  price: number;
  position_state: string | null;
  position_age_min: number | null;
  proximity_lower: number | null;
  proximity_upper: number | null;
  reserve_gate: string | null;
  basis_gate: string | null;
  churn_guard: string | null;
  daily_regime: string | null;
  ta_data_age_min: number;
}

export function insertRegimeSnapshot(db: Database.Database, snap: RegimeSnapshotRow): void {
  try {
    db.prepare(`INSERT INTO regime_snapshots (
      ts, regime, prev_regime, regime_changed, confidence, deploy_pct, veto_fired,
      ta_score_bullish, ta_score_ranging, ta_score_bearish, ta_score_extreme, ta_winner, ta_total_score,
      ema9, sma20, ema_cross, rsi, bb_width, bb_position, atr,
      vol_1h, sol_change_4h, fear_greed, btc_change_4h,
      price, position_state, position_age_min, proximity_lower, proximity_upper,
      reserve_gate, basis_gate, churn_guard, daily_regime, ta_data_age_min
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      snap.ts, snap.regime, snap.prev_regime, snap.regime_changed, snap.confidence, snap.deploy_pct, snap.veto_fired,
      snap.ta_score_bullish, snap.ta_score_ranging, snap.ta_score_bearish, snap.ta_score_extreme, snap.ta_winner, snap.ta_total_score,
      snap.ema9, snap.sma20, snap.ema_cross, snap.rsi, snap.bb_width, snap.bb_position, snap.atr,
      snap.vol_1h, snap.sol_change_4h, snap.fear_greed, snap.btc_change_4h,
      snap.price, snap.position_state, snap.position_age_min, snap.proximity_lower, snap.proximity_upper,
      snap.reserve_gate, snap.basis_gate, snap.churn_guard, snap.daily_regime, snap.ta_data_age_min,
    );
    // Auto-cleanup: keep 30 days
    db.prepare(`DELETE FROM regime_snapshots WHERE ts < ?`).run(Date.now() - 30 * 24 * 3600 * 1000);
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: `regime_snapshot insert failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }));
  }
}

export function getRegimeSnapshots(db: Database.Database, opts: { limit?: number; since?: number; regime?: string; changed?: boolean }): RegimeSnapshotRow[] {
  let sql = 'SELECT * FROM regime_snapshots WHERE 1=1';
  const params: any[] = [];
  if (opts.since) { sql += ' AND ts >= ?'; params.push(opts.since); }
  if (opts.regime) { sql += ' AND regime = ?'; params.push(opts.regime); }
  if (opts.changed) { sql += ' AND regime_changed = 1'; }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(opts.limit ?? 100);
  return db.prepare(sql).all(...params) as RegimeSnapshotRow[];
}
