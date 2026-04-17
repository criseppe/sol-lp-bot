const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });

const since = Date.now() - 3600000;
const lastPrice = db.prepare("SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1").get()?.price || 0;

console.log("=== POSITIONS LAST 60MIN ===");
try {
  const positions = db.prepare(`
    SELECT timestamp, event_type, price, fee_usdc, fee_sol, il_at_close, note
    FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp
  `).all(since);
  for (const r of positions) {
    const feesUsd = ((r.fee_usdc || 0) + (r.fee_sol || 0) * lastPrice).toFixed(2);
    const t = new Date(r.timestamp).toISOString().replace('T',' ').slice(0,19);
    console.log(`${t} | ${r.event_type} | price=${(r.price||0).toFixed(2)} | fees=$${feesUsd} | il=${(r.il_at_close||0).toFixed(4)} | ${r.note||''}`);
  }
  if (!positions.length) console.log("(none)");
} catch(e) { console.log("rebalance_events error:", e.message); }

console.log("\n=== SWAPS LAST 60MIN ===");
try {
  const swaps = db.prepare(`
    SELECT timestamp, direction, sol_amount, usdc_amount, price, reason
    FROM swap_ledger WHERE timestamp > ? ORDER BY timestamp
  `).all(since);
  for (const r of swaps) {
    const t = new Date(r.timestamp).toISOString().replace('T',' ').slice(0,19);
    console.log(`${t} | ${r.direction} | sol=${(r.sol_amount||0).toFixed(4)} | usdc=${(r.usdc_amount||0).toFixed(2)} | price=${(r.price||0).toFixed(2)} | ${r.reason||''}`);
  }
  if (!swaps.length) console.log("(none)");
} catch(e) { console.log("swap_ledger error:", e.message); }

console.log("\n=== REGIME CHANGES LAST 60MIN ===");
try {
  const regChanges = db.prepare(`
    SELECT ts, prev_regime, regime, confidence, rsi, bb_width, price
    FROM regime_snapshots WHERE ts > ? AND regime_changed = 1 ORDER BY ts
  `).all(since);
  for (const r of regChanges) {
    const t = new Date(r.ts).toISOString().replace('T',' ').slice(0,19);
    console.log(`${t} | ${r.prev_regime} -> ${r.regime} | conf=${r.confidence} | rsi=${(r.rsi||0).toFixed(1)} | bb=${(r.bb_width||0).toFixed(2)} | price=${(r.price||0).toFixed(2)}`);
  }
  if (!regChanges.length) console.log("(none)");
} catch(e) { console.log("regime_snapshots error:", e.message); }

console.log("\n=== CURRENT STATE ===");
try {
  const bs = db.prepare(`SELECT state, regime, confidence, sol_cost_basis, usdc_reserve, reserve_state, cum_fees_sol, cum_fees_usdc FROM bot_state LIMIT 1`).get();
  if (bs) {
    console.log(`state=${bs.state} | regime=${bs.regime} | conf=${bs.confidence} | basis=${(bs.sol_cost_basis||0).toFixed(2)} | reserve=${(bs.usdc_reserve||0).toFixed(2)} | reserve_state=${bs.reserve_state} | cum_sol=${(bs.cum_fees_sol||0).toFixed(4)} | cum_usdc=${(bs.cum_fees_usdc||0).toFixed(2)}`);
  } else {
    console.log("(no bot_state row)");
  }
} catch(e) { console.log("bot_state error:", e.message); }

try {
  const snap = db.prepare(`SELECT price, rsi, bb_width, regime, confidence, ts FROM regime_snapshots ORDER BY ts DESC LIMIT 1`).get();
  if (snap) {
    const t = new Date(snap.ts).toISOString().replace('T',' ').slice(0,19);
    console.log(`price=${(snap.price||0).toFixed(2)} | rsi=${(snap.rsi||0).toFixed(1)} | bb=${(snap.bb_width||0).toFixed(2)} | regime=${snap.regime} | conf=${snap.confidence} | t=${t}`);
  }
} catch(e) { console.log("snapshot error:", e.message); }
db.close();
