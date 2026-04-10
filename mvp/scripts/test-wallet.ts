import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { loadWallet, getWalletBalances } from '../src/live/wallet.js';
import { PoolService } from '../src/data/pool.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!);
  const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
  console.log('Wallet address:', wallet.publicKey.toBase58());

  const balances = await getWalletBalances(conn, wallet.publicKey);
  const pool = new PoolService(conn, process.env.WHIRLPOOL_ADDRESS!);
  const solPrice = await pool.getCurrentPrice();

  console.log('SOL balance:', balances.sol.toFixed(6));
  console.log('USDC balance:', balances.usdc.toFixed(6));
  console.log('SOL price:', solPrice.toFixed(2));
  console.log('Total value: $' + (balances.sol * solPrice + balances.usdc).toFixed(2));
}

main();
