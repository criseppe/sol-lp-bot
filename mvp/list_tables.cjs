const Database = require('better-sqlite3');
const db = new Database('/home/botuser/sol-lp-bot/mvp/data/mvp.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("TABLES:", tables.map(t => t.name).join(", "));
db.close();
