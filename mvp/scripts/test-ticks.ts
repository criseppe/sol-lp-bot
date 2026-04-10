import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { PoolService } from '../src/data/pool.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!);
  const pool = new PoolService(conn, process.env.WHIRLPOOL_ADDRESS!);
  await pool.fetchState();

  console.log('Tick spacing:', pool.getTickSpacing());

  const price = await pool.getCurrentPrice();
  console.log('Current price:', price.toFixed(4));

  const tick = pool.priceToTick(price);
  console.log('Price to tick:', tick);
  console.log('Tick divisible by spacing:', tick % pool.getTickSpacing() === 0);

  const lower = price * 0.97;
  const upper = price * 1.03;
  const tickLower = pool.priceToTick(lower);
  const tickUpper = pool.priceToTick(upper);
  console.log(`Range $${lower.toFixed(2)}-$${upper.toFixed(2)} → ticks ${tickLower} to ${tickUpper}`);
  console.log('Lower divisible:', tickLower % pool.getTickSpacing() === 0);
  console.log('Upper divisible:', tickUpper % pool.getTickSpacing() === 0);
}

main();
