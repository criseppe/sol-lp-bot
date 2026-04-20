/**
 * onchainBasis.ts — Standalone on-chain cost basis observer.
 *
 * Read-only: never writes to bot_state or swap_ledger; never participates in
 * the bot's cycle. Owns its own DB tables (swap_ledger_onchain, onchain_basis_meta)
 * and mirrors the chain via Helius RPC on manual sync only.
 */

import express, { Router } from 'express';
import type { Connection } from '@solana/web3.js';
import type Database from 'better-sqlite3';
import { fetchOnChainSwaps, type OnChainSwap, type FetchProgress } from '../data/heliusSwaps.js';
import { computeBasis } from '../engine/costBasis.js';

export interface OnchainBasisRouterOpts {
  connection: Connection;
  walletAddress: string;
  db: Database.Database;
  minBlockTime?: number;
}

interface SyncState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  sigsFetched: number;
  txsProcessed: number;
  swapsFound: number;
  newSwaps: number;
}

interface OnchainSwapRow {
  id: number;
  signature: string;
  block_time: number;
  slot: number;
  direction: 'BUY_SOL' | 'SELL_SOL';
  sol_delta: number;
  usdc_delta: number;
  implied_price: number;
  gas_fee_sol: number;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swap_ledger_onchain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      block_time INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('BUY_SOL','SELL_SOL')),
      sol_delta REAL NOT NULL,
      usdc_delta REAL NOT NULL,
      implied_price REAL NOT NULL,
      gas_fee_sol REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'helius',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_swap_ledger_onchain_slot ON swap_ledger_onchain (slot DESC);
    CREATE INDEX IF NOT EXISTS idx_swap_ledger_onchain_block_time ON swap_ledger_onchain (block_time DESC);

    CREATE TABLE IF NOT EXISTS onchain_basis_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function rowToSwap(r: OnchainSwapRow): OnChainSwap {
  return {
    signature: r.signature,
    blockTime: r.block_time,
    slot: r.slot,
    direction: r.direction,
    solDelta: r.sol_delta,
    usdcDelta: r.usdc_delta,
    impliedPrice: r.implied_price,
    gasFee: r.gas_fee_sol,
  };
}

export function createOnchainBasisRouter(opts: OnchainBasisRouterOpts): Router {
  const { connection, walletAddress, db } = opts;
  const minBlockTime = opts.minBlockTime ?? Math.floor(Date.now() / 1000) - 20 * 86400;

  ensureSchema(db);

  const syncState: SyncState = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null,
    sigsFetched: 0,
    txsProcessed: 0,
    swapsFound: 0,
    newSwaps: 0,
  };

  const router: Router = express.Router();

  router.get('/onchain-basis', (_req, res) => {
    res.type('html').send(renderHtml());
  });

  router.get('/api/onchain-basis/status', (_req, res) => {
    try {
      const rows = db.prepare(
        `SELECT signature, block_time, slot, direction, sol_delta, usdc_delta, implied_price, gas_fee_sol
         FROM swap_ledger_onchain ORDER BY slot ASC`,
      ).all() as OnchainSwapRow[];
      const swaps = rows.map(rowToSwap);
      const { state, totalRealisedPnl, totalGasCostSol } = computeBasis(swaps);

      // On-chain basis here = simple average USDC cost across BUY_SOL swaps,
      // independent of any sells. Reason: weighted-with-sells drifts to the
      // most recent buy whenever holdings go to zero (see computeBasis in
      // engine/costBasis.ts); users asked for the simpler "how much have we
      // paid per SOL on average across every acquisition" number.
      const onchainBasisBuyAvg = state.totalSolBought > 0
        ? state.totalUsdcBuys / state.totalSolBought
        : 0;

      let dbBasis: number | null = null;
      try {
        const row = db.prepare(`SELECT sol_cost_basis FROM bot_state WHERE id = 1`).get() as
          | { sol_cost_basis: number | null }
          | undefined;
        dbBasis = row?.sol_cost_basis ?? null;
      } catch {
        dbBasis = null;
      }

      let dbSwapCount: number | null = null;
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM swap_ledger`).get() as { c: number } | undefined;
        dbSwapCount = row?.c ?? 0;
      } catch {
        dbSwapCount = null;
      }

      const onchainSwapCount = swaps.length;
      const divergencePct = onchainBasisBuyAvg > 0 && dbBasis != null && dbBasis > 0
        ? ((onchainBasisBuyAvg - dbBasis) / onchainBasisBuyAvg) * 100
        : null;
      const gapPct = dbSwapCount != null && dbSwapCount > 0
        ? ((onchainSwapCount - dbSwapCount) / dbSwapCount) * 100
        : null;

      let lastSyncAt: number | null = null;
      try {
        const row = db.prepare(`SELECT value FROM onchain_basis_meta WHERE key = 'last_sync_at'`).get() as
          | { value: string }
          | undefined;
        if (row?.value) lastSyncAt = parseInt(row.value, 10) || null;
      } catch {
        lastSyncAt = null;
      }

      res.json({
        onchainBasis: onchainBasisBuyAvg,
        dbBasis,
        divergencePct,
        onchainSwapCount,
        dbSwapCount,
        gapPct,
        lastSyncAt,
        totalRealisedPnl,
        totalGasCostSol,
        totalSolBought: state.totalSolBought,
        totalSolSold: state.totalSolSold,
        totalUsdcBuys: state.totalUsdcBuys,
        totalUsdcSells: state.totalUsdcSells,
        syncState,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/onchain-basis/swaps', (req, res) => {
    try {
      const limitRaw = parseInt(String(req.query.limit ?? '100'), 10);
      const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
      const order = String(req.query.order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
      const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

      const totalRow = db.prepare(`SELECT COUNT(*) as c FROM swap_ledger_onchain`).get() as { c: number };
      const total = totalRow?.c ?? 0;

      const chronoRows = db.prepare(
        `SELECT signature, block_time, slot, direction, sol_delta, usdc_delta, implied_price, gas_fee_sol
         FROM swap_ledger_onchain ORDER BY slot ASC`,
      ).all() as OnchainSwapRow[];
      // Running simple buy-only average per-row, matching the headline metric
      // (totalUsdcBuys / totalSolBought up to each swap). Sells do not change it.
      const basisBySlot = new Map<number, number>();
      let runUsdc = 0, runSol = 0, runBasis = 0;
      for (const r of chronoRows) {
        if (r.direction === 'BUY_SOL') {
          runUsdc += Math.abs(r.usdc_delta);
          runSol += Math.abs(r.sol_delta);
          runBasis = runSol > 0 ? runUsdc / runSol : 0;
        }
        basisBySlot.set(r.slot, runBasis);
      }

      const pageRows = db.prepare(
        `SELECT id, signature, block_time, slot, direction, sol_delta, usdc_delta, implied_price, gas_fee_sol
         FROM swap_ledger_onchain ORDER BY slot ${order} LIMIT ? OFFSET ?`,
      ).all(limit, offset) as (OnchainSwapRow & { id: number })[];

      const out = pageRows.map((r) => ({
        id: r.id,
        signature: r.signature,
        blockTime: r.block_time,
        slot: r.slot,
        direction: r.direction,
        solDelta: r.sol_delta,
        usdcDelta: r.usdc_delta,
        impliedPrice: r.implied_price,
        gasFee: r.gas_fee_sol,
        basisAfter: basisBySlot.get(r.slot) ?? 0,
      }));

      res.json({ total, limit, offset, order: order.toLowerCase(), swaps: out });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/onchain-basis/sync', (_req, res) => {
    if (syncState.status === 'running') {
      res.json({ ok: false, reason: 'already running' });
      return;
    }
    syncState.status = 'running';
    syncState.startedAt = Date.now();
    syncState.finishedAt = null;
    syncState.error = null;
    syncState.sigsFetched = 0;
    syncState.txsProcessed = 0;
    syncState.swapsFound = 0;
    syncState.newSwaps = 0;
    res.json({ ok: true, message: 'Sync started' });

    void (async () => {
      try {
        const swaps = await fetchOnChainSwaps(connection, walletAddress, {
          limit: 1000,
          minBlockTime,
          onProgress: (p: FetchProgress) => {
            syncState.sigsFetched = p.sigsFetched;
            syncState.txsProcessed = p.txsProcessed;
            syncState.swapsFound = p.swapsFound;
          },
        });

        const insert = db.prepare(
          `INSERT OR IGNORE INTO swap_ledger_onchain
             (signature, block_time, slot, direction, sol_delta, usdc_delta, implied_price, gas_fee_sol, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'helius')`,
        );
        const upsertMeta = db.prepare(
          `INSERT INTO onchain_basis_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        );

        let newCount = 0;
        const tx = db.transaction((list: OnChainSwap[]) => {
          for (const s of list) {
            const info = insert.run(
              s.signature, s.blockTime, s.slot, s.direction,
              s.solDelta, s.usdcDelta, s.impliedPrice, s.gasFee,
            );
            if (info.changes > 0) newCount += 1;
          }
          upsertMeta.run('last_sync_at', String(Math.floor(Date.now() / 1000)));
        });
        tx(swaps);

        syncState.newSwaps = newCount;
        syncState.status = 'done';
        syncState.finishedAt = Date.now();
      } catch (err) {
        syncState.status = 'error';
        syncState.error = err instanceof Error ? err.message : String(err);
        syncState.finishedAt = Date.now();
      }
    })();
  });

  return router;
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>On-Chain Cost Basis — sol-lp-bot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #08090d;
  --card: #0f1118;
  --border: #1e2535;
  --accent: #f5a623;
  --buy: #18e87a;
  --sell: #ff4567;
  --link: #4e9eff;
  --muted: #55637a;
  --text: #d6dce8;
  --text-dim: #8b94a8;
  --warn: #f5a623;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: 'DM Sans', system-ui, sans-serif; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
.mono, .num { font-family: 'JetBrains Mono', monospace; }
.container { max-width: 1400px; margin: 0 auto; padding: 20px 24px 80px; }
.header {
  display: flex; align-items: center; gap: 20px;
  padding: 18px 0 22px; border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.header .back { color: var(--muted); font-size: 13px; }
.header .title {
  font-family: 'JetBrains Mono', monospace; color: var(--accent);
  font-size: 20px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
}
.header .subtitle { color: var(--muted); font-size: 12px; }
.header .right { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.last-sync { color: var(--text-dim); font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.progress { width: 180px; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; display: none; }
.progress.visible { display: block; }
.progress > div { height: 100%; background: var(--accent); width: 0%; transition: width 0.4s ease; }
.status-msg { color: var(--text-dim); font-size: 12px; font-family: 'JetBrains Mono', monospace; min-width: 140px; }
.sync-btn {
  background: var(--accent); color: #0b0c12; border: none; padding: 8px 14px;
  border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase; font-size: 12px; cursor: pointer;
}
.sync-btn:hover { filter: brightness(1.1); }
.sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }

h2.section {
  font-family: 'JetBrains Mono', monospace; font-size: 12px;
  color: var(--text-dim); letter-spacing: 0.12em; text-transform: uppercase;
  margin: 28px 0 12px; font-weight: 500;
}

.grid { display: grid; gap: 12px; }
.grid-6 { grid-template-columns: repeat(6, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 1100px) { .grid-6 { grid-template-columns: repeat(3, 1fr); } .grid-4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .grid-6, .grid-4 { grid-template-columns: repeat(2, 1fr); } }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-top: 2px solid var(--border); border-radius: 6px;
  padding: 14px 14px 16px; position: relative; min-height: 86px;
}
.card.accent-amber { border-top-color: var(--accent); }
.card.accent-blue { border-top-color: var(--link); }
.card.accent-green { border-top-color: var(--buy); }
.card.accent-red { border-top-color: var(--sell); }
.card.accent-warn { border-top-color: var(--warn); }
.card .label {
  font-family: 'JetBrains Mono', monospace; font-size: 10px;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em;
  margin-bottom: 8px;
}
.card .value {
  font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 700;
  color: var(--text);
}
.card .value.amber { color: var(--accent); }
.card .value.blue { color: var(--link); }
.card .value.green { color: var(--buy); }
.card .value.red { color: var(--sell); }
.card .value.warn { color: var(--warn); }
.card .sub { font-family: 'JetBrains Mono', monospace; color: var(--muted); font-size: 11px; margin-top: 4px; }

.skeleton {
  background: linear-gradient(90deg, var(--card) 0%, #182030 50%, var(--card) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite linear;
  border-radius: 3px; height: 22px; margin-top: 2px;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.tablewrap { background: var(--card); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.tablewrap .topbar {
  display: flex; align-items: center; gap: 12px; padding: 10px 14px;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.tablewrap .topbar .info { color: var(--text-dim); font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.tablewrap .topbar .controls { margin-left: auto; display: flex; align-items: center; gap: 8px; }
select, .pg-btn {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  padding: 6px 10px; border-radius: 4px; font-family: 'JetBrains Mono', monospace;
  font-size: 12px; cursor: pointer;
}
.pg-btn:disabled { opacity: 0.4; cursor: not-allowed; }

table { width: 100%; border-collapse: collapse; }
th, td {
  padding: 9px 12px; text-align: left; font-size: 12px;
  border-bottom: 1px solid var(--border);
  font-family: 'JetBrains Mono', monospace;
}
th {
  color: var(--text-dim); font-weight: 500; text-transform: uppercase;
  letter-spacing: 0.08em; font-size: 10px; background: #0a0c12;
}
tr:hover td { background: #12151e; }
td.num { text-align: right; }
.dir-badge {
  display: inline-block; padding: 2px 8px; border-radius: 3px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
}
.dir-badge.buy { background: rgba(24,232,122,0.15); color: var(--buy); }
.dir-badge.sell { background: rgba(255,69,103,0.15); color: var(--sell); }
.pos { color: var(--buy); }
.neg { color: var(--sell); }
.amber { color: var(--accent); }
.empty { padding: 40px; text-align: center; color: var(--muted); }

.statusbar {
  position: fixed; left: 0; right: 0; bottom: 0;
  background: #0a0c12; border-top: 1px solid var(--border);
  padding: 8px 24px; display: flex; align-items: center; gap: 12px;
  font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-dim);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--buy); }
.dot.running { background: var(--accent); animation: pulse 1s infinite; }
.dot.error { background: var(--sell); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.statusbar .spacer { flex: 1; }
.statusbar .brand { color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <a class="back" href="/">&larr; Dashboard</a>
    <div>
      <div class="title">On-Chain Cost Basis</div>
      <div class="subtitle">Standalone &middot; disconnected from bot process</div>
    </div>
    <div class="right">
      <span class="last-sync" id="lastSync">last sync: —</span>
      <div class="progress" id="progress"><div></div></div>
      <span class="status-msg" id="statusMsg">idle</span>
      <button class="sync-btn" id="syncBtn" onclick="startSync()">&#x27F3; Sync from Chain</button>
    </div>
  </div>

  <h2 class="section">Basis Comparison</h2>
  <div class="grid grid-6" id="basisCards">
    <div class="card accent-amber"><div class="label">Avg Buy Price</div><div class="value amber"><div class="skeleton"></div></div></div>
    <div class="card accent-blue"><div class="label">Bot DB Basis</div><div class="value blue"><div class="skeleton"></div></div></div>
    <div class="card accent-warn"><div class="label">Divergence</div><div class="value warn"><div class="skeleton"></div></div></div>
    <div class="card accent-green"><div class="label">On-Chain Swaps</div><div class="value green"><div class="skeleton"></div></div></div>
    <div class="card accent-blue"><div class="label">DB Swaps</div><div class="value blue"><div class="skeleton"></div></div></div>
    <div class="card accent-warn"><div class="label">Coverage Gap</div><div class="value warn"><div class="skeleton"></div></div></div>
  </div>

  <h2 class="section">Swap Performance</h2>
  <div class="grid grid-4" id="perfCards">
    <div class="card accent-green"><div class="label">Realised PnL</div><div class="value green"><div class="skeleton"></div></div></div>
    <div class="card"><div class="label">Total Gas Cost</div><div class="value"><div class="skeleton"></div></div></div>
    <div class="card accent-green"><div class="label">Total SOL Bought</div><div class="value green"><div class="skeleton"></div></div></div>
    <div class="card accent-red"><div class="label">Total SOL Sold</div><div class="value red"><div class="skeleton"></div></div></div>
  </div>

  <h2 class="section">All On-Chain Swaps <span style="color:var(--muted);margin-left:8px" id="rowCountLabel">—</span></h2>
  <div class="tablewrap">
    <div class="topbar">
      <span class="info" id="tableInfo">—</span>
      <div class="controls">
        <label style="color:var(--text-dim);font-size:11px;font-family:'JetBrains Mono',monospace">Order</label>
        <select id="orderSelect" onchange="onOrderChange()">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
        <button class="pg-btn" id="prevBtn" onclick="prevPage()">&larr; Prev</button>
        <button class="pg-btn" id="nextBtn" onclick="nextPage()">Next &rarr;</button>
      </div>
    </div>
    <div id="tableBody">
      <div class="empty">Loading swaps…</div>
    </div>
  </div>
</div>

<div class="statusbar">
  <div class="dot" id="sbDot"></div>
  <span id="sbText">idle</span>
  <span style="color:var(--muted)" id="sbDetail"></span>
  <div class="spacer"></div>
  <span class="brand">sol-lp-bot &middot; on-chain basis &middot; standalone</span>
</div>

<script>
const PAGE_SIZE = 100;
let currentPage = 0;
let currentOrder = 'desc';
let lastTotal = 0;
let syncPollTimer = null;
let statusIntervalTimer = null;

function fmt2(n) { if (n == null || !isFinite(n)) return '—'; return Number(n).toFixed(2); }
function fmt4(n) { if (n == null || !isFinite(n)) return '—'; return Number(n).toFixed(4); }
function fmtUSD(n) { if (n == null || !isFinite(n)) return '—'; const s = Math.abs(n).toFixed(2); return (n < 0 ? '-$' : '$') + s; }
function fmtSOL(n) { if (n == null || !isFinite(n)) return '—'; return Number(n).toFixed(4) + ' SOL'; }
function fmtPct(n) { if (n == null || !isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }
function fmtInt(n) { if (n == null) return '—'; return Number(n).toLocaleString(); }
function fmtRelTime(sec) {
  if (!sec) return '—';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function fmtTime(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toISOString().replace('T', ' ').replace(/\\.\\d+Z$/, 'Z');
}
function truncSig(s) { if (!s || s.length < 16) return s || ''; return s.slice(0, 8) + '…' + s.slice(-6); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderBasisCards(d) {
  const cards = document.getElementById('basisCards');
  const divClass = d.divergencePct == null ? 'warn' : (Math.abs(d.divergencePct) < 1 ? 'green' : 'warn');
  const gapClass = d.gapPct == null ? 'warn' : (Math.abs(d.gapPct) < 5 ? 'warn' : 'red');
  const gapLabel = d.gapPct == null ? '' : (d.gapPct > 0 ? 'on-chain has MORE' : 'on-chain has LESS');
  cards.innerHTML = \`
    <div class="card accent-amber"><div class="label">Avg Buy Price</div><div class="value amber">$\${fmt4(d.onchainBasis)}<div class="sub">total USDC / total SOL across all buys</div></div></div>
    <div class="card accent-blue"><div class="label">Bot DB Basis</div><div class="value blue">\${d.dbBasis == null ? '—' : '$' + fmt4(d.dbBasis)}</div></div>
    <div class="card accent-\${divClass}"><div class="label">Divergence</div><div class="value \${divClass}">\${fmtPct(d.divergencePct)}</div></div>
    <div class="card accent-green"><div class="label">On-Chain Swaps</div><div class="value green">\${fmtInt(d.onchainSwapCount)}</div></div>
    <div class="card accent-blue"><div class="label">DB Swaps</div><div class="value blue">\${d.dbSwapCount == null ? '—' : fmtInt(d.dbSwapCount)}</div></div>
    <div class="card accent-\${gapClass}"><div class="label">Coverage Gap</div><div class="value \${gapClass}">\${fmtPct(d.gapPct)}<div class="sub">\${gapLabel}</div></div></div>
  \`;
}

function renderPerfCards(d) {
  const cards = document.getElementById('perfCards');
  const pnlClass = (d.totalRealisedPnl ?? 0) >= 0 ? 'green' : 'red';
  const usdcSpent = d.totalUsdcBuys ?? 0;
  const usdcRecv = d.totalUsdcSells ?? 0;
  cards.innerHTML = \`
    <div class="card accent-\${pnlClass}"><div class="label">Realised PnL</div><div class="value \${pnlClass}">\${fmtUSD(d.totalRealisedPnl)}</div></div>
    <div class="card"><div class="label">Total Gas Cost</div><div class="value">\${fmtSOL(d.totalGasCostSol)}</div></div>
    <div class="card accent-green"><div class="label">Total SOL Bought</div><div class="value green">\${fmtSOL(d.totalSolBought)}<div class="sub">spent \${fmtUSD(usdcSpent)}</div></div></div>
    <div class="card accent-red"><div class="label">Total SOL Sold</div><div class="value red">\${fmtSOL(d.totalSolSold)}<div class="sub">received \${fmtUSD(usdcRecv)}</div></div></div>
  \`;
}

function renderStatusBar(d) {
  const dot = document.getElementById('sbDot');
  const text = document.getElementById('sbText');
  const detail = document.getElementById('sbDetail');
  const ss = d.syncState || { status: 'idle' };
  dot.className = 'dot' + (ss.status === 'running' ? ' running' : ss.status === 'error' ? ' error' : '');
  if (ss.status === 'running') {
    text.textContent = 'syncing…';
    detail.textContent = \`\${fmtInt(ss.sigsFetched)} sigs · \${fmtInt(ss.txsProcessed)} txs · \${fmtInt(ss.swapsFound)} swaps found\`;
  } else if (ss.status === 'error') {
    text.textContent = 'error';
    detail.textContent = ss.error || '';
  } else if (ss.status === 'done') {
    text.textContent = 'sync complete';
    detail.textContent = \`+\${fmtInt(ss.newSwaps)} new swaps\`;
  } else {
    text.textContent = 'idle';
    detail.textContent = '';
  }
  document.getElementById('statusMsg').textContent = text.textContent;
  document.getElementById('lastSync').textContent = 'last sync: ' + fmtRelTime(d.lastSyncAt);
  const prog = document.getElementById('progress');
  if (ss.status === 'running') {
    prog.classList.add('visible');
    const pct = Math.min(90, (ss.txsProcessed / Math.max(ss.sigsFetched, 1)) * 100);
    prog.firstElementChild.style.width = pct + '%';
  } else if (ss.status === 'done') {
    prog.firstElementChild.style.width = '100%';
    setTimeout(() => { prog.classList.remove('visible'); prog.firstElementChild.style.width = '0%'; }, 1500);
  } else if (ss.status === 'error') {
    prog.classList.remove('visible');
    prog.firstElementChild.style.width = '0%';
  }
}

async function fetchStatus() {
  try {
    const r = await fetch('/api/onchain-basis/status', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    renderBasisCards(d);
    renderPerfCards(d);
    renderStatusBar(d);
    return d;
  } catch (e) {
    console.error('fetchStatus', e);
  }
}

function renderTable(resp) {
  const rows = resp.swaps || [];
  const total = resp.total || 0;
  lastTotal = total;
  const body = document.getElementById('tableBody');
  document.getElementById('rowCountLabel').textContent = \`(\${fmtInt(total)})\`;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  document.getElementById('tableInfo').textContent = \`\${fmtInt(total)} swaps · page \${currentPage + 1} of \${pages}\`;
  document.getElementById('prevBtn').disabled = currentPage <= 0;
  document.getElementById('nextBtn').disabled = (currentPage + 1) >= pages;

  if (rows.length === 0) {
    body.innerHTML = '<div class="empty">No swaps yet. Click &ldquo;Sync from Chain&rdquo; to pull your on-chain history from Helius.</div>';
    return;
  }
  let html = '<table><thead><tr><th>#</th><th>Time (UTC)</th><th>Direction</th><th class="num">SOL &Delta;</th><th class="num">USDC &Delta;</th><th class="num">Implied Price</th><th class="num">Avg Buy Price</th><th class="num">Gas (SOL)</th><th>Signature</th></tr></thead><tbody>';
  rows.forEach((s, i) => {
    const idx = currentOrder === 'desc' ? (currentPage * PAGE_SIZE + i + 1) : (currentPage * PAGE_SIZE + i + 1);
    const dirClass = s.direction === 'BUY_SOL' ? 'buy' : 'sell';
    const dirLabel = s.direction === 'BUY_SOL' ? 'BUY' : 'SELL';
    const solClass = s.solDelta >= 0 ? 'pos' : 'neg';
    const usdcClass = s.usdcDelta >= 0 ? 'pos' : 'neg';
    const solSign = s.solDelta >= 0 ? '+' : '';
    const usdcSign = s.usdcDelta >= 0 ? '+' : '';
    html += \`<tr>
      <td>\${idx}</td>
      <td>\${fmtTime(s.blockTime)}</td>
      <td><span class="dir-badge \${dirClass}">\${dirLabel}</span></td>
      <td class="num \${solClass}">\${solSign}\${fmt4(s.solDelta)}</td>
      <td class="num \${usdcClass}">\${usdcSign}\${fmt2(s.usdcDelta)}</td>
      <td class="num">$\${fmt4(s.impliedPrice)}</td>
      <td class="num amber">$\${fmt4(s.basisAfter)}<div style="color:var(--muted);font-size:10px;font-weight:normal">running avg</div></td>
      <td class="num">\${fmt4(s.gasFee)}</td>
      <td><a href="https://solscan.io/tx/\${esc(s.signature)}" target="_blank" rel="noopener">\${truncSig(s.signature)}</a></td>
    </tr>\`;
  });
  html += '</tbody></table>';
  body.innerHTML = html;
}

async function loadSwaps() {
  try {
    const offset = currentPage * PAGE_SIZE;
    const url = \`/api/onchain-basis/swaps?limit=\${PAGE_SIZE}&offset=\${offset}&order=\${currentOrder}\`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return;
    const resp = await r.json();
    renderTable(resp);
  } catch (e) {
    console.error('loadSwaps', e);
  }
}

function onOrderChange() {
  currentOrder = document.getElementById('orderSelect').value;
  currentPage = 0;
  loadSwaps();
}
function prevPage() { if (currentPage > 0) { currentPage -= 1; loadSwaps(); } }
function nextPage() {
  const pages = Math.max(1, Math.ceil(lastTotal / PAGE_SIZE));
  if (currentPage + 1 < pages) { currentPage += 1; loadSwaps(); }
}

async function startSync() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/onchain-basis/sync', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('statusMsg').textContent = 'already running';
    }
  } catch (e) {
    console.error('startSync', e);
  }
  if (syncPollTimer) clearInterval(syncPollTimer);
  syncPollTimer = setInterval(async () => {
    const d = await fetchStatus();
    if (!d) return;
    const st = d.syncState?.status;
    if (st === 'done' || st === 'error') {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
      btn.disabled = false;
      await loadSwaps();
    }
  }, 1500);
}

(async function init() {
  await fetchStatus();
  await loadSwaps();
  statusIntervalTimer = setInterval(fetchStatus, 30000);
})();
</script>
</body>
</html>`;
}
