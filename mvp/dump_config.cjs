const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });
const rows = db.prepare("SELECT key, value FROM config ORDER BY key").all();
for (const r of rows) console.log(`${r.key} = ${r.value}`);
db.close();
