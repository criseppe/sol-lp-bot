const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });

const since = Date.now() - 4 * 3600 * 1000;
const lastPrice = db.prepare("SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1").get()?.price || 0;
const r2 = n => (n == null ? '' : Number(n).toFixed(2));
const r4 = n => (n == null ? '' : Number(n).toFixed(4));
const r6 = n => (n == null ? '' : Number(n).toFixed(6));
const tfmt = ms => new Date(ms).toISOString().replace('T',' ').slice(0,19);

function section(name) { console.log('\n=== ' + name + ' ==='); }
function run(title, sql, params=[]) {
  section(title);
  try {
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) { console.log('(none)'); return []; }
    rows.forEach(r => console.log(JSON.stringify(r)));
    return rows;
  } catch (e) { console.log('ERR:', e.message); return []; }
}

console.log(`# Status report - last 4h | now=${new Date().toISOString()} | ref_price=${r2(lastPrice)}`);

// 1. Rebalance events
section('ALL REBALANCE EVENTS LAST 4H');
try {
  const ev = db.prepare(`
    SELECT timestamp, event_type, price, fee_usdc, fee_sol, il_at_close, note
    FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp`).all(since);
  if (!ev.length) console.log('(none)');
  for (const r of ev) {
    const feeUsd = ((r.fee_usdc||0) + (r.fee_sol||0) * lastPrice);
    console.log(`${tfmt(r.timestamp)} | ${r.event_type} | price=${r2(r.price)} | fee_usdc=${r4(r.fee_usdc)} | fee_sol=${r6(r.fee_sol)} | fee_usd=${r4(feeUsd)} | il=${r6(r.il_at_close)} | ${r.note||''}`);
  }
} catch(e){console.log(e.message);}

// 2. All swaps
section('ALL SWAPS LAST 4H');
try {
  const sw = db.prepare(`
    SELECT timestamp, direction, sol_amount, usdc_amount, price,
           cost_basis_before, cost_basis_after, swap_hash, reason
    FROM swap_ledger WHERE timestamp > ? ORDER BY timestamp`).all(since);
  if (!sw.length) console.log('(none)');
  for (const r of sw) {
    const delta = (r.cost_basis_after||0) - (r.cost_basis_before||0);
    console.log(`${tfmt(r.timestamp)} | ${r.direction} | sol=${r6(r.sol_amount)} | usdc=${r4(r.usdc_amount)} | px=${r4(r.price)} | cb_b=${r4(r.cost_basis_before)} | cb_a=${r4(r.cost_basis_after)} | d=${r6(delta)} | hash=${r.swap_hash||''} | ${r.reason||''}`);
  }
} catch(e){console.log(e.message);}

// 3. Duplicate check
section('DUPLICATE CHECK');
try {
  const tot = db.prepare(`
    SELECT COUNT(*) as total_swaps,
      SUM(CASE WHEN swap_hash LIKE 'tx:%' THEN 1 ELSE 0 END) as with_sig,
      SUM(CASE WHEN swap_hash IS NULL OR swap_hash NOT LIKE 'tx:%' THEN 1 ELSE 0 END) as without_sig
    FROM swap_ledger WHERE timestamp > ?`).get(since);
  console.log(JSON.stringify(tot));
  const dupes = db.prepare(`
    SELECT swap_hash, COUNT(*) as dupes, direction,
      ROUND(sol_amount,4) as sol, reason
    FROM swap_ledger
    WHERE timestamp > ? AND swap_hash IS NOT NULL
    GROUP BY swap_hash HAVING COUNT(*) > 1`).all(since);
  if (!dupes.length) console.log('no duplicates');
  dupes.forEach(r => console.log(JSON.stringify(r)));
} catch(e){console.log(e.message);}

// 4. Regime timeline
section('REGIME TIMELINE LAST 4H (changes + latest)');
try {
  const rs = db.prepare(`
    SELECT ts, regime, prev_regime, confidence, rsi, bb_width, price,
           ta_score_ranging, ta_score_bullish, ta_score_bearish, regime_changed
    FROM regime_snapshots
    WHERE ts > ? AND (regime_changed = 1 OR ts = (SELECT MAX(ts) FROM regime_snapshots))
    ORDER BY ts`).all(since);
  if (!rs.length) console.log('(none)');
  rs.forEach(r => {
    console.log(`${tfmt(r.ts)} | ${r.prev_regime}->${r.regime} | conf=${r.confidence} | rsi=${r2(r.rsi)} | bb=${r2(r.bb_width)} | px=${r2(r.price)} | ta(rng/bull/bear)=${r.ta_score_ranging}/${r.ta_score_bullish}/${r.ta_score_bearish} | chg=${r.regime_changed}`);
  });
} catch(e){console.log(e.message);}

// 5. Position history (open->close pairs)
section('POSITION HISTORY LAST 4H');
try {
  const opens = db.prepare(`
    SELECT timestamp as open_ts, price as open_price, note as open_note
    FROM rebalance_events WHERE event_type='POSITION_OPENED' AND timestamp > ?
    ORDER BY timestamp`).all(since);
  const closes = db.prepare(`
    SELECT timestamp as close_ts, price as close_price, event_type as exit_type,
           fee_usdc, fee_sol, il_at_close as il, note as close_note
    FROM rebalance_events
    WHERE event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_ABOVE','OOR_BELOW','POSITION_CLOSED')
    AND timestamp > ? ORDER BY timestamp`).all(since - 3600*1000);
  if (!opens.length) console.log('(no opens in 4h)');
  for (const o of opens) {
    const c = closes.find(c => c.close_ts > o.open_ts);
    const feeUsd = c ? (c.fee_usdc||0) + (c.fee_sol||0) * lastPrice : null;
    if (c) {
      const dur = ((c.close_ts - o.open_ts)/60000).toFixed(1);
      console.log(`OPEN ${tfmt(o.open_ts)} px=${r2(o.open_price)} | CLOSE ${tfmt(c.close_ts)} px=${r2(c.close_price)} | dur=${dur}m | ${c.exit_type} | fees=$${r2(feeUsd)} | il=${r4(c.il)} | open_note="${o.open_note||''}" | close_note="${c.close_note||''}"`);
    } else {
      console.log(`OPEN ${tfmt(o.open_ts)} px=${r2(o.open_price)} | STILL OPEN | open_note="${o.open_note||''}"`);
    }
  }
} catch(e){console.log(e.message);}

// 6. Basis drift
section('BASIS DRIFT FULL HISTORY LAST 4H');
try {
  const sw = db.prepare(`
    SELECT timestamp, direction, sol_amount, price,
           cost_basis_before, cost_basis_after, reason
    FROM swap_ledger WHERE timestamp > ? ORDER BY timestamp`).all(since);
  if (!sw.length) console.log('(none)');
  let totalDelta = 0;
  sw.forEach(r => {
    const d = (r.cost_basis_after||0) - (r.cost_basis_before||0);
    totalDelta += d;
    console.log(`${tfmt(r.timestamp)} | ${r.direction} | sol=${r4(r.sol_amount)} | px=${r2(r.price)} | cb_b=${r4(r.cost_basis_before)} | cb_a=${r4(r.cost_basis_after)} | d=${r4(d)} | ${r.reason||''}`);
  });
  console.log(`TOTAL BASIS DELTA: ${r4(totalDelta)}`);
} catch(e){console.log(e.message);}

// 7. SolConvert
section('SOLCONVERT ACTIVITY');
try {
  const sw = db.prepare(`
    SELECT timestamp, direction, sol_amount, usdc_amount, price, cost_basis_before, reason
    FROM swap_ledger
    WHERE timestamp > ? AND (reason LIKE '%onvert%' OR reason LIKE '%SolConvert%')
    ORDER BY timestamp`).all(since);
  if (!sw.length) console.log('(none)');
  sw.forEach(r => console.log(`${tfmt(r.timestamp)} | ${r.direction} | sol=${r4(r.sol_amount)} | usdc=${r2(r.usdc_amount)} | px=${r2(r.price)} | basis=${r2(r.cost_basis_before)} | ${r.reason||''}`));
} catch(e){console.log(e.message);}

// 8. Idle/rebalance
section('IDLE REBALANCE ACTIVITY');
try {
  const sw = db.prepare(`
    SELECT timestamp, direction, sol_amount, usdc_amount, price, cost_basis_before, cost_basis_after, reason
    FROM swap_ledger
    WHERE timestamp > ? AND (reason LIKE '%idle%' OR reason LIKE '%Idle%' OR reason LIKE '%rebalance%')
    ORDER BY timestamp`).all(since);
  if (!sw.length) console.log('(none)');
  sw.forEach(r => console.log(`${tfmt(r.timestamp)} | ${r.direction} | sol=${r4(r.sol_amount)} | usdc=${r2(r.usdc_amount)} | px=${r2(r.price)} | cb_b=${r2(r.cost_basis_before)} | cb_a=${r2(r.cost_basis_after)} | ${r.reason||''}`));
} catch(e){console.log(e.message);}

// 9. Summary
section('FEES AND IL SUMMARY');
try {
  const row = db.prepare(`
    SELECT
      COUNT(CASE WHEN fee_usdc > 0 OR fee_sol > 0 THEN 1 END) as fee_events,
      SUM(fee_usdc) as sum_fee_usdc,
      SUM(fee_sol) as sum_fee_sol,
      SUM(il_at_close) as total_il,
      COUNT(CASE WHEN event_type='T1_DOWNSIDE' THEN 1 END) as downside_exits,
      COUNT(CASE WHEN event_type='T1_UPSIDE' THEN 1 END) as upside_exits,
      COUNT(CASE WHEN event_type='OOR_ABOVE' THEN 1 END) as oor_above,
      COUNT(CASE WHEN event_type='OOR_BELOW' THEN 1 END) as oor_below,
      COUNT(CASE WHEN event_type='POSITION_OPENED' THEN 1 END) as opens,
      COUNT(CASE WHEN event_type='POSITION_CLOSED' THEN 1 END) as closes
    FROM rebalance_events WHERE timestamp > ?`).get(since);
  const totFees = (row.sum_fee_usdc||0) + (row.sum_fee_sol||0) * lastPrice;
  const netPnl = totFees + (row.total_il || 0);
  console.log(`fee_events=${row.fee_events} | sum_fee_usdc=${r4(row.sum_fee_usdc)} | sum_fee_sol=${r6(row.sum_fee_sol)} | total_fees_usd=${r2(totFees)} | total_il=${r4(row.total_il)} | net_pnl_usd=${r2(netPnl)}`);
  console.log(`opens=${row.opens} | closes=${row.closes} | T1_DOWN=${row.downside_exits} | T1_UP=${row.upside_exits} | OOR_ABOVE=${row.oor_above} | OOR_BELOW=${row.oor_below}`);
} catch(e){console.log(e.message);}

// 10. Current state
section('CURRENT BOT STATE');
try {
  const bs = db.prepare(`SELECT * FROM bot_state LIMIT 1`).get();
  if (bs) {
    console.log(`state=${bs.state} | regime=${bs.regime} | conf=${bs.confidence} | basis=${r2(bs.sol_cost_basis)} | reserve=${r2(bs.usdc_reserve)} | floor=${r2(bs.usdc_reserve_floor)} | reserve_state=${bs.reserve_state} | cum_sol=${r4(bs.cum_fees_sol)} | cum_usdc=${r2(bs.cum_fees_usdc)} | realized_il=${r4(bs.realized_il)} | tx=${bs.tx_count} | last_upside_px=${bs.last_upside_exit_price} | last_upside=${bs.last_upside_exit_ts ? tfmt(bs.last_upside_exit_ts) : 'null'}`);
  }
  const snap = db.prepare(`SELECT * FROM regime_snapshots ORDER BY ts DESC LIMIT 1`).get();
  if (snap) {
    console.log(`px=${r2(snap.price)} | rsi=${r2(snap.rsi)} | bb=${r2(snap.bb_width)} | bb_pos=${r4(snap.bb_position)} | regime=${snap.regime} | conf=${snap.confidence} | ema9=${r2(snap.ema9)} | sma20=${r2(snap.sma20)} | ema_cross=${snap.ema_cross} | updated=${tfmt(snap.ts)}`);
  }
} catch(e){console.log(e.message);}

db.close();
