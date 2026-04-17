const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });

console.log("=== bot_state columns ===");
const cols = db.prepare("PRAGMA table_info(bot_state)").all();
console.log(cols.map(c => c.name).join(", "));

console.log("\n=== CURRENT WALLET STATE ===");
const bs = db.prepare("SELECT * FROM bot_state LIMIT 1").get();
if (bs) {
  for (const [k, v] of Object.entries(bs)) {
    if (v != null && v !== '' && k !== 'live_position_data' && k !== 'active_position') {
      console.log(`${k}: ${typeof v === 'number' ? Number(v).toFixed(4) : v}`);
    }
  }
}
db.close();
