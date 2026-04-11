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

  // Migration: add rule2_active column to existing rebalance_events tables
  try {
    db.exec(`ALTER TABLE rebalance_events ADD COLUMN rule2_active INTEGER DEFAULT 1`);
  } catch (_) { /* column already exists */ }

  // Migration: add position_id column for per-position P&L tracking
  try {
    db.exec(`ALTER TABLE rebalance_events ADD COLUMN position_id TEXT`);
  } catch (_) { /* column already exists */ }

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
  db.prepare(`
    INSERT OR REPLACE INTO bot_state (id, state, regime, position_json, ledger_json, naive_json, updated_at, cum_fees_sol, cum_fees_usdc, realized_il, tx_count, cum_gas_lamports)
    VALUES (1, @state, @regime, @position_json, @ledger_json, @naive_json, @updated_at, @cum_fees_sol, @cum_fees_usdc, @realized_il, @tx_count, @cum_gas_lamports)
  `).run({ ...state, ledger_json: state.ledger_json ?? null, naive_json: state.naive_json ?? null, cum_fees_sol: state.cum_fees_sol ?? 0, cum_fees_usdc: state.cum_fees_usdc ?? 0, realized_il: state.realized_il ?? 0, tx_count: state.tx_count ?? 0, cum_gas_lamports: state.cum_gas_lamports ?? 0 });
}

export function getBotState(db: Database.Database): BotStateRow | null {
  const row = db.prepare(`SELECT state, regime, position_json, ledger_json, naive_json, updated_at, cum_fees_sol, cum_fees_usdc, realized_il, tx_count, cum_gas_lamports FROM bot_state WHERE id = 1`).get() as BotStateRow | undefined;
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

export function pruneOldPriceTicks(db: Database.Database, keepDays: number): void {
  db.prepare(`
    DELETE FROM price_ticks
    WHERE source != 'backfill'
    AND timestamp < (strftime('%s','now') - ? * 86400) * 1000
  `).run(keepDays);
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
