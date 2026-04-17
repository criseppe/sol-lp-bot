const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true, fileMustExist: true });

function run(label, sql) {
  console.log('\n' + label);
  try {
    const rows = db.prepare(sql).all();
    if (rows.length === 0) { console.log('(no rows)'); return; }
    const cols = Object.keys(rows[0]);
    console.log(cols.join(' | '));
    console.log(cols.map(c => '---').join(' | '));
    for (const r of rows) {
      console.log(cols.map(c => r[c] === null ? '' : String(r[c])).join(' | '));
    }
  } catch (e) { console.log('ERR: ' + e.message); }
}

console.log('=== regime_history COLUMNS ===');
console.log(db.prepare("PRAGMA table_info(regime_history)").all().map(c => c.name).join(', '));

run('=== REGIME CHANGES LAST 5H (regime_snapshots.regime_changed=1) ===', `
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
    AND timestamp > (strftime('%s','now') - 21600)*1000
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
  SUBSTR(c.close_note, 1, 200) as close_note
FROM opens o
JOIN closes c ON c.close_ts = (
  SELECT MIN(close_ts) FROM closes WHERE close_ts > o.open_ts
)
ORDER BY o.open_ts`);

run('=== CURRENT STATE (clean) ===', `
SELECT state, regime,
  ROUND(sol_cost_basis,2) as basis,
  ROUND(usdc_reserve,2) as reserve,
  ROUND(usdc_reserve_floor,2) as floor,
  reserve_state,
  ROUND(cum_fees_sol,4) as cum_sol,
  ROUND(cum_fees_usdc,2) as cum_usdc,
  ROUND(realized_il,4) as realized_il,
  tx_count,
  sol_conversion_enabled,
  ROUND(last_upside_exit_price,2) as last_upside_exit,
  datetime(updated_at/1000,'unixepoch') as updated
FROM bot_state LIMIT 1`);

db.close();
