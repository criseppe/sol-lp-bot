import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!, { commitment: 'confirmed' });
  const wallet = new PublicKey('Evga86Xco1D5XCeSF2T3Ff8DsJAhr2SoaVrPWALoLU6z');

  // Get all transaction signatures for this wallet
  const sigs = await conn.getSignaturesForAddress(wallet, { limit: 50 });
  console.log(`Found ${sigs.length} transactions\n`);

  let totalGasLamports = 0;
  let txCount = 0;

  for (const sig of sigs) {
    const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;

    txCount++;
    const fee = tx.meta.fee;
    totalGasLamports += fee;

    const time = new Date((sig.blockTime ?? 0) * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const status = tx.meta.err ? 'FAILED' : 'OK';
    console.log(`${time} | ${fee.toString().padStart(7)} lamports (${(fee/1e9).toFixed(6)} SOL) | ${status} | ${sig.signature.slice(0, 20)}...`);
  }

  console.log(`\n--- TOTALS ---`);
  console.log(`Transactions: ${txCount}`);
  console.log(`Total gas: ${totalGasLamports} lamports = ${(totalGasLamports / 1e9).toFixed(6)} SOL`);
  console.log(`Total gas ($): $${(totalGasLamports / 1e9 * 85).toFixed(4)} (at ~$85/SOL)`);
}

main();
