import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { PoolService } from '../src/data/pool.js';
import { OracleService } from '../src/data/oracle.js';

async function main() {
  const rpcUrl = process.env.RPC_URL!;

  // Test Pool Service
  console.log('--- Pool Service ---');
  const conn = new Connection(rpcUrl);
  const pool = new PoolService(conn, process.env.WHIRLPOOL_ADDRESS!);
  const poolPrice = await pool.getCurrentPrice();
  console.log('Pool price:', poolPrice.toFixed(4));

  // Test Oracle Service (Hermes)
  console.log('\n--- Oracle Service (Hermes) ---');
  const oracle = new OracleService(
    process.env.PYTH_SOL_USD_FEED!,
    parseFloat(process.env.PYTH_MAX_CONFIDENCE_PCT!),
    parseInt(process.env.PYTH_MAX_STALENESS_SECONDS!),
  );
  await oracle.start();

  const p = oracle.getPrice();
  if (p) {
    console.log('Oracle price:', p.price.toFixed(4));
    console.log('Oracle confidence:', p.confidence.toFixed(6));
    const diffPct = Math.abs(poolPrice - p.price) / p.price * 100;
    console.log('Pool vs Oracle diff:', diffPct.toFixed(3) + '%');
    console.log('Within 2%:', diffPct < 2);
    console.log('In range $50-$5000:', p.price >= 50 && p.price <= 5000);
  } else {
    console.log('ERROR: No oracle price');
  }

  // Test cache
  console.log('\n--- Cache Test ---');
  const fetchesBefore = pool.getFetchCount();
  await pool.fetchState();
  console.log('Second fetch used cache:', pool.getFetchCount() === fetchesBefore);

  oracle.stop();
}

main();
