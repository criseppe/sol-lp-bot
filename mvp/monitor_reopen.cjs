const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });
const since = Math.floor(Date.now() / 1000 - 600) * 1000;
const rows = db.prepare(`SELECT timestamp, event_type, price, note FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp`).all(since);
for (const r of rows) {
  const t = new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${t} | ${r.event_type} | price=${(r.price||0).toFixed(2)} | ${(r.note||'').slice(0,200)}`);
}
if (!rows.length) console.log("(no events in last 10min)");
db.close();
