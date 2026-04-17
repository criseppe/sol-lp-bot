const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true, fileMustExist: true });

function run(label, sql) {
  console.log('\n' + label);
  try {
    const rows = db.prepare(sql).all();
    if (rows.length === 0) { console.log('(no rows)'); return; }
    const cols = Object.keys(rows[0]);
    console.log(cols.join(' | '));
    console.log(cols.map(() => '---').join(' | '));
    for (const r of rows) {
      console.log(cols.map(c => r[c] === null ? '' : String(r[c])).join(' | '));
    }
  } catch (e) { console.log('ERR: ' + e.message); }
}

run('=== ALL EVENTS LAST 5H ===', `
SELECT datetime(timestamp/1000,'unixepoch') as time,
  event_type,
  ROUND(price,2) as price,
  ROUND(fee_usdc + fee_sol *
    (SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1),2) as fee_usd,
  ROUND(il_at_close,4) as il,
  SUBSTR(note,1,180) as note
FROM rebalance_events
WHERE timestamp > (strftime('%s','now') - 18000)*1000
ORDER BY timestamp`);

run('=== REGIME CHANGES LAST 5H ===', `
SELECT datetime(ts/1000,'unixepoch') as time,
  prev_regime, regime, confidence,
  ta_score_ranging, ta_score_bullish, ta_score_bearish, ta_score_extreme,
  ROUND(rsi,1) as rsi, ROUND(bb_width,2) as bb,
  ROUND(price,2) as price, ema_cross
FROM regime_snapshots
WHERE ts > (strftime('%s','now') - 18000)*1000
  AND regime_changed = 1
ORDER BY ts`);

run('=== POSITION HISTORY LAST 5H ===', `
WITH opens AS (
  SELECT timestamp as open_ts, price as open_price, note as open_note
  FROM rebalance_events
  WHERE event_type = 'POSITION_OPENED'
    AND timestamp > (strftime('%s','now') - 18000)*1000
),
closes AS (
  SELECT timestamp as close_ts, price as close_price,
    event_type as exit_type,
    ROUND(fee_usdc + fee_sol *
      (SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1),2) as fees,
    ROUND(il_at_close,4) as il,
    note as close_note
  FROM rebalance_events
  WHERE event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_ABOVE','OOR_BELOW','POSITION_CLOSED')
    AND timestamp > (strftime('%s','now') - 21600)*1000
)
SELECT
  datetime(o.open_ts/1000,'unixepoch') as opened,
  datetime(c.close_ts/1000,'unixepoch') as closed,
  ROUND((c.close_ts - o.open_ts)/60000.0,1) as dur_min,
  ROUND(o.open_price,2) as entry,
  ROUND(c.close_price,2) as exit_price,
  c.exit_type, c.fees, c.il,
  SUBSTR(c.close_note,1,180) as close_note
FROM opens o
JOIN closes c ON c.close_ts = (
  SELECT MIN(close_ts) FROM closes WHERE close_ts > o.open_ts
)
ORDER BY o.open_ts`);

run('=== SWAPS LAST 5H ===', `
SELECT datetime(timestamp/1000,'unixepoch') as time,
  direction,
  ROUND(sol_amount,4) as sol,
  ROUND(usdc_amount,2) as usdc,
  ROUND(price,2) as price,
  ROUND(cost_basis_before,2) as cb_before,
  ROUND(cost_basis_after,2) as cb_after,
  ROUND(cost_basis_after - cost_basis_before,4) as cb_delta,
  SUBSTR(reason,1,120) as reason
FROM swap_ledger
WHERE timestamp > (strftime('%s','now') - 18000)*1000
ORDER BY timestamp`);

run('=== FEES SUMMARY LAST 5H ===', `
SELECT
  COUNT(CASE WHEN fee_usdc>0 OR fee_sol>0 THEN 1 END) as fee_events,
  ROUND(SUM(fee_usdc + fee_sol *
    (SELECT price FROM regime_snapshots ORDER BY ts DESC LIMIT 1)),2) as total_fees,
  ROUND(SUM(il_at_close),4) as total_il,
  COUNT(CASE WHEN event_type='T1_DOWNSIDE' THEN 1 END) as downside_exits,
  COUNT(CASE WHEN event_type='T1_UPSIDE' THEN 1 END) as upside_exits,
  COUNT(CASE WHEN event_type='OOR_ABOVE' THEN 1 END) as oor_above,
  COUNT(CASE WHEN event_type='POSITION_OPENED' THEN 1 END) as opens
FROM rebalance_events
WHERE timestamp > (strftime('%s','now') - 18000)*1000`);

run('=== CURRENT STATE ===', `
SELECT state, regime,
  ROUND(sol_cost_basis,2) as basis,
  ROUND(usdc_reserve,2) as reserve,
  ROUND(usdc_reserve_floor,2) as floor,
  reserve_state,
  ROUND(cum_fees_sol,4) as cum_sol,
  ROUND(cum_fees_usdc,2) as cum_usdc,
  ROUND(realized_il,4) as realized_il,
  tx_count
FROM bot_state LIMIT 1`);

run('=== LATEST SNAPSHOT ===', `
SELECT ROUND(price,2) as price,
  ROUND(rsi,1) as rsi,
  ROUND(bb_width,2) as bb,
  ROUND(bb_position,3) as bb_pos,
  regime, confidence,
  ROUND(ema9,2) as ema9,
  ROUND(sma20,2) as sma20,
  ema_cross, vol_1h,
  datetime(ts/1000,'unixepoch') as updated
FROM regime_snapshots ORDER BY ts DESC LIMIT 1`);

db.close();
