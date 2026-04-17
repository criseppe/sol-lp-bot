const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });

const cutoff = Date.now() - 10 * 3600 * 1000;
const latestPriceRow = db.prepare('SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1').get();
const latestPrice = latestPriceRow ? latestPriceRow.price : 0;

const pad = (v, w) => String(v == null ? '' : v).padEnd(w);
const toUtc = (ms) => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '';

console.log('=== ALL EVENTS LAST 10H ===');
const events = db.prepare(`
  SELECT timestamp, event_type, price, fee_usdc, fee_sol, il_at_close, note, regime,
         sol_before, usdc_before, sol_after, usdc_after
  FROM rebalance_events
  WHERE timestamp > ?
  ORDER BY timestamp
`).all(cutoff);
if (events.length === 0) console.log('(no events)');
for (const e of events) {
  const feeUsd = (e.fee_usdc || 0) + (e.fee_sol || 0) * latestPrice;
  console.log(
    `${toUtc(e.timestamp)}  ${pad(e.event_type, 20)} price=${(e.price||0).toFixed(2)}  ` +
    `regime=${pad(e.regime||'-', 10)} fee_usd=${feeUsd.toFixed(2)}  ` +
    `il=${e.il_at_close == null ? '-' : Number(e.il_at_close).toFixed(4)}  ` +
    `note=${e.note || ''}`
  );
}

console.log('\n=== REGIME TIMELINE LAST 10H (changes + latest) ===');
const maxTs = db.prepare('SELECT MAX(ts) as m FROM regime_snapshots').get().m;
const regimes = db.prepare(`
  SELECT ts, prev_regime, regime, confidence,
         ta_score_ranging, ta_score_bullish, ta_score_bearish, ta_score_extreme,
         rsi, bb_width, price, regime_changed
  FROM regime_snapshots
  WHERE ts > ? AND (regime_changed = 1 OR ts = ?)
  ORDER BY ts
`).all(cutoff, maxTs);
if (regimes.length === 0) console.log('(no regime snapshots in window)');
for (const r of regimes) {
  console.log(
    `${toUtc(r.ts)}  ${pad(r.prev_regime || '-', 10)} -> ${pad(r.regime, 10)}  ` +
    `conf=${r.confidence ?? '-'}  ` +
    `TA R/B/Br/X=${r.ta_score_ranging}/${r.ta_score_bullish}/${r.ta_score_bearish}/${r.ta_score_extreme}  ` +
    `rsi=${(r.rsi||0).toFixed(1)}  bb=${(r.bb_width||0).toFixed(2)}  price=${(r.price||0).toFixed(2)}  ` +
    `changed=${r.regime_changed}`
  );
}

console.log('\n=== CURRENT STATE ===');
const state = db.prepare('SELECT * FROM bot_state LIMIT 1').get();
if (state) {
  let pos = null;
  try { pos = state.position_json ? JSON.parse(state.position_json) : null; } catch(_) {}
  console.log(`state=${state.state}  regime=${state.regime}  updated=${toUtc(state.updated_at)}`);
  console.log(`sol_cost_basis=${(state.sol_cost_basis||0).toFixed(2)}  ` +
              `sol_acquired=${(state.sol_total_acquired||0).toFixed(4)}  ` +
              `sol_total_cost=${(state.sol_total_cost||0).toFixed(2)}`);
  console.log(`usdc_reserve=${(state.usdc_reserve||0).toFixed(2)}  ` +
              `floor=${(state.usdc_reserve_floor||0).toFixed(2)}  reserve_state=${state.reserve_state || '-'}`);
  console.log(`cum_fees_sol=${(state.cum_fees_sol||0).toFixed(4)}  ` +
              `cum_fees_usdc=${(state.cum_fees_usdc||0).toFixed(2)}  ` +
              `realized_il=${(state.realized_il||0).toFixed(4)}  tx_count=${state.tx_count}  ` +
              `cum_gas_lamports=${state.cum_gas_lamports||0}`);
  console.log(`last_upside_exit_price=${state.last_upside_exit_price ?? '-'}  ` +
              `last_upside_exit_ts=${toUtc(state.last_upside_exit_ts)}`);
  if (pos) {
    console.log(`position.range=[${pos.lowerPrice ?? pos.range_lower ?? '?'}, ${pos.upperPrice ?? pos.range_upper ?? '?'}]  ` +
                `opened=${toUtc(pos.openedAt || pos.opened_at)}  ` +
                `width_pct=${pos.widthPct ?? pos.width_pct ?? '-'}  ` +
                `sol_in=${pos.solAmount ?? pos.sol ?? '-'}  usdc_in=${pos.usdcAmount ?? pos.usdc ?? '-'}`);
  }
}

console.log('\n=== LATEST SNAPSHOT ===');
const snap = db.prepare('SELECT * FROM regime_snapshots ORDER BY ts DESC LIMIT 1').get();
if (snap) {
  console.log(`time=${toUtc(snap.ts)}  price=${(snap.price||0).toFixed(2)}  rsi=${(snap.rsi||0).toFixed(1)}  ` +
              `bb=${(snap.bb_width||0).toFixed(2)}  bb_pos=${(snap.bb_position||0).toFixed(3)}  atr=${(snap.atr||0).toFixed(4)}`);
  console.log(`regime=${snap.regime}  confidence=${snap.confidence ?? '-'}  ` +
              `TA R/B/Br/X=${snap.ta_score_ranging}/${snap.ta_score_bullish}/${snap.ta_score_bearish}/${snap.ta_score_extreme}  ` +
              `winner=${snap.ta_winner}  total=${snap.ta_total_score}`);
  console.log(`ema9=${(snap.ema9||0).toFixed(2)}  sma20=${(snap.sma20||0).toFixed(2)}  ema_cross=${snap.ema_cross}  ` +
              `vol_1h=${snap.vol_1h}  sol_change_4h=${snap.sol_change_4h}  btc_change_4h=${snap.btc_change_4h}  ` +
              `f&g=${snap.fear_greed}`);
  console.log(`position_state=${snap.position_state}  age_min=${snap.position_age_min}  ` +
              `proximity L/U=${snap.proximity_lower}/${snap.proximity_upper}  ` +
              `reserve_gate=${snap.reserve_gate}  basis_gate=${snap.basis_gate}  churn_guard=${snap.churn_guard}`);
}

console.log('\n=== EVENT COUNTS LAST 10H ===');
const counts = db.prepare(`
  SELECT event_type, COUNT(*) as c
  FROM rebalance_events
  WHERE timestamp > ?
  GROUP BY event_type
  ORDER BY c DESC
`).all(cutoff);
for (const c of counts) console.log(`${pad(c.event_type, 20)} ${c.c}`);

console.log('\n=== REGIME CHANGE COUNTS LAST 10H ===');
const rc = db.prepare(`
  SELECT regime, COUNT(*) as c
  FROM regime_snapshots
  WHERE ts > ? AND regime_changed = 1
  GROUP BY regime
  ORDER BY c DESC
`).all(cutoff);
if (rc.length === 0) console.log('(no regime changes)');
for (const c of rc) console.log(`${pad(c.regime, 20)} ${c.c}`);

console.log('\n=== FEE + IL TOTALS LAST 10H ===');
const totals = db.prepare(`
  SELECT SUM(fee_sol) as fs, SUM(fee_usdc) as fu, SUM(il_at_close) as il, COUNT(*) as n
  FROM rebalance_events WHERE timestamp > ?
`).get(cutoff);
const totFeeUsd = (totals.fu || 0) + (totals.fs || 0) * latestPrice;
console.log(`events=${totals.n}  fee_sol=${(totals.fs||0).toFixed(4)}  fee_usdc=${(totals.fu||0).toFixed(2)}  ` +
            `total_fee_usd=${totFeeUsd.toFixed(2)}  sum_il_at_close=${(totals.il||0).toFixed(4)}`);

console.log('\n=== SWAP LEDGER LAST 10H ===');
try {
  const swaps = db.prepare(`
    SELECT * FROM swap_ledger WHERE ts > ? ORDER BY ts
  `).all(cutoff);
  if (swaps.length === 0) console.log('(no swaps)');
  for (const s of swaps) {
    const keys = Object.keys(s).slice(0, 12);
    console.log(keys.map(k => `${k}=${s[k]}`).join('  '));
  }
} catch (e) { console.log('(swap_ledger query failed: ' + e.message + ')'); }

console.log('\n=== DECISION LOG LAST 10 ===');
try {
  const decisions = db.prepare(`
    SELECT * FROM decision_log WHERE ts > ? ORDER BY ts DESC LIMIT 10
  `).all(cutoff);
  if (decisions.length === 0) console.log('(no decisions in window)');
  for (const d of decisions) {
    const time = d.ts ? toUtc(d.ts) : '-';
    console.log(`${time}  ${JSON.stringify(d).slice(0, 280)}`);
  }
} catch (e) { console.log('(decision_log query failed: ' + e.message + ')'); }

db.close();
