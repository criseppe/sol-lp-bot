import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? '/home/botuser/sol-lp-bot/mvp/data/mvp.db';
const db = new Database(DB_PATH);

// 14 missing pre-close harvest events extracted from PM2 logs
// These were collected on-chain but never written to rebalance_events
const harvests = [
  { ts: '2026-04-15T05:34:19.098Z', feeSol: 0.161674, feeUsdc: 12.6474, price: 83.17 },
  { ts: '2026-04-15T14:18:25.594Z', feeSol: 0.097974, feeUsdc: 10.1713, price: 84.09 },
  { ts: '2026-04-15T17:08:06.488Z', feeSol: 0.131871, feeUsdc: 15.0854, price: 84.95 },
  { ts: '2026-04-15T17:23:06.277Z', feeSol: 0.013760, feeUsdc:  0.2203, price: 84.56 },
  { ts: '2026-04-15T20:19:03.983Z', feeSol: 0.130135, feeUsdc: 10.3344, price: 84.76 },
  { ts: '2026-04-15T22:10:05.148Z', feeSol: 0.035776, feeUsdc:  6.8154, price: 85.37 },
  { ts: '2026-04-15T22:19:41.189Z', feeSol: 0.006678, feeUsdc:  0.0002, price: 85.03 },
  { ts: '2026-04-16T00:27:05.291Z', feeSol: 0.132939, feeUsdc:  9.0264, price: 84.57 },
  { ts: '2026-04-16T02:41:05.110Z', feeSol: 0.095127, feeUsdc: 10.3122, price: 85.49 },
  { ts: '2026-04-16T04:50:06.049Z', feeSol: 0.077674, feeUsdc:  6.0727, price: 85.09 },
  { ts: '2026-04-16T05:10:04.931Z', feeSol: 0.015732, feeUsdc:  1.2587, price: 85.09 },
  { ts: '2026-04-16T10:13:35.953Z', feeSol: 0.140305, feeUsdc: 11.5292, price: 84.97 },
  { ts: '2026-04-16T10:17:36.695Z', feeSol: 0.009999, feeUsdc:  0.2925, price: 84.85 },
  { ts: '2026-04-16T10:20:37.880Z', feeSol: 0.005934, feeUsdc:  0.2283, price: 84.74 },
];

const insert = db.prepare(`
  INSERT INTO rebalance_events
  (timestamp, event_type, price, regime, note,
   sol_before, usdc_before, sol_after, usdc_after,
   fee_sol, fee_usdc, il_at_close, rule2_active)
  VALUES (?, 'FEE_HARVEST', ?, 'BACKFILL', ?,
          0, 0, 0, 0,
          ?, ?, 0, 1)
`);

const checkExists = db.prepare(`
  SELECT COUNT(*) as c FROM rebalance_events
  WHERE timestamp = ? AND event_type = 'FEE_HARVEST'
`);

let inserted = 0;
let skipped = 0;
let total = 0;

const txn = db.transaction(() => {
  for (const h of harvests) {
    const ts = new Date(h.ts).getTime();
    const usdValue = h.feeUsdc + h.feeSol * h.price;
    const note = `Backfilled from PM2 logs — pre-close harvest not recorded in DB. ${h.feeSol.toFixed(6)} SOL + ${h.feeUsdc.toFixed(4)} USDC ($${usdValue.toFixed(2)})`;

    const existing = checkExists.get(ts) as { c: number };
    if (existing.c > 0) {
      console.log(`SKIP (exists): ${h.ts} — $${usdValue.toFixed(2)}`);
      skipped++;
      continue;
    }

    insert.run(ts, h.price, note, h.feeSol, h.feeUsdc);
    inserted++;
    total += usdValue;
    console.log(`INSERT: ${h.ts} — ${h.feeSol.toFixed(6)} SOL + $${h.feeUsdc.toFixed(4)} = $${usdValue.toFixed(2)}`);
  }
});

txn();

console.log('');
console.log(`Done: ${inserted} inserted, ${skipped} skipped, $${total.toFixed(2)} total value`);

// Verify
const backfillCheck = db.prepare(`
  SELECT COUNT(*) as count,
         ROUND(SUM(fee_usdc + fee_sol * 85.40), 2) as total_usd
  FROM rebalance_events
  WHERE note LIKE '%Backfill%'
`).get() as any;
console.log(`Backfill rows in DB: ${backfillCheck.count}, value at $85.40: $${backfillCheck.total_usd}`);

const allFeesCheck = db.prepare(`
  SELECT COUNT(*) as count,
         ROUND(SUM(fee_usdc + fee_sol * 85.40), 2) as total_usd
  FROM rebalance_events
  WHERE fee_usdc > 0 OR fee_sol > 0
`).get() as any;
console.log(`All fee rows in DB: ${allFeesCheck.count}, value at $85.40: $${allFeesCheck.total_usd}`);

db.close();
