import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadWallet, getWalletBalances } from '../src/live/wallet.js';
import { LiveExecutor } from '../src/live/executor.js';
import { initDb, insertRebalanceEvent, insertDecisionLog, getBotState } from '../src/db/sqlite.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!, { commitment: 'confirmed' });
  const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
  const db = initDb(process.env.DB_PATH!);

  const savedState = getBotState(db);
  if (!savedState?.position_json || savedState.position_json === 'null') {
    console.log('No position found in DB.');
    process.exit(1);
  }

  const pos = JSON.parse(savedState.position_json);
  if (!pos?.positionMint) {
    console.log('No position mint in saved state.');
    process.exit(1);
  }

  console.log(`Closing position ${pos.positionMint.slice(0, 12)}...`);

  // Use the executor so fees+IL are captured
  const executor = new LiveExecutor(conn, wallet, process.env.WHIRLPOOL_ADDRESS!);
  executor.setCurrentPosition({
    ...pos,
    positionMint: new PublicKey(pos.positionMint),
    positionAddress: new PublicKey(pos.positionAddress),
  });

  const balBefore = await getWalletBalances(conn, wallet.publicKey);
  const result = await executor.closePosition();
  const balAfter = await getWalletBalances(conn, wallet.publicKey);

  console.log(`Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)})`);
  console.log(`IL at close: $${result.ilAtClose.toFixed(4)}`);
  console.log(`Wallet: ${balAfter.sol.toFixed(6)} SOL + ${balAfter.usdc.toFixed(6)} USDC`);

  insertRebalanceEvent(db, {
    timestamp: Date.now(), eventType: 'POSITION_CLOSED', price: result.closePrice, regime: savedState.regime ?? 'RANGING',
    note: `WHY: Manual close via script. Range was $${result.priceLower.toFixed(2)}-$${result.priceUpper.toFixed(2)}, entry at $${result.entryPrice.toFixed(2)}.\nEXECUTED: Fees collected: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC ($${result.feeTotalUsdc.toFixed(4)}). Received ${result.solReceived.toFixed(4)} SOL + ${result.usdcReceived.toFixed(2)} USDC. IL: $${result.ilAtClose.toFixed(4)}. Wallet: ${balAfter.sol.toFixed(4)} SOL + ${balAfter.usdc.toFixed(2)} USDC.`,
    solBefore: balBefore.sol, usdcBefore: balBefore.usdc,
    solAfter: balAfter.sol, usdcAfter: balAfter.usdc,
    feeSol: result.feeSolCollected, feeUsdc: result.feeUsdcCollected, ilAtClose: result.ilAtClose,
  });
  insertDecisionLog(db, {
    timestamp: Date.now(), price: result.closePrice, regime: savedState.regime ?? 'RANGING', bot_state: 'IDLE',
    prox_lower: null, prox_upper: null, in_range: null,
    decision: 'MANUAL_CLOSE', reasoning: `Manual close via script. Fees: ${result.feeSolCollected.toFixed(6)} SOL + ${result.feeUsdcCollected.toFixed(4)} USDC. IL: $${result.ilAtClose.toFixed(4)}.`,
    params_json: null,
  });

  // Update cumulative fees in DB
  const cumFeesSol = (savedState.cum_fees_sol ?? 0) + result.feeSolCollected;
  const cumFeesUsdc = (savedState.cum_fees_usdc ?? 0) + result.feeUsdcCollected;
  const realizedIl = (savedState.realized_il ?? 0) + result.ilAtClose;
  db.prepare("UPDATE bot_state SET position_json = 'null', state = 'IDLE', cum_fees_sol = ?, cum_fees_usdc = ?, realized_il = ? WHERE id = 1").run(cumFeesSol, cumFeesUsdc, realizedIl);

  console.log('Logged and DB state cleared.');
}

main();
