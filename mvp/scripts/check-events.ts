import 'dotenv/config';
import { initDb, getRebalanceEvents, getDecisionLogs } from '../src/db/sqlite.js';

const db = initDb(process.env.DB_PATH!);

console.log('=== Last 15 Rebalance Events ===');
const events = getRebalanceEvents(db, 15);
events.forEach(e => {
  const t = new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${t}  ${e.eventType.padEnd(20)}  $${e.price.toFixed(2)}  ${(e.note ?? '').slice(0, 150)}`);
});

console.log('\n=== Last 15 Decision Logs ===');
const decisions = getDecisionLogs(db, 15);
decisions.forEach(d => {
  const t = new Date(d.timestamp).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${t}  ${d.decision.padEnd(20)}  $${d.price.toFixed(2)}  ${d.reasoning.slice(0, 150)}`);
});
