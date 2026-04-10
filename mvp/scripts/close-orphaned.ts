import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { loadWallet } from '../src/live/wallet.js';
import { MINTS } from '../src/constants.js';

const SLIPPAGE = Percentage.fromFraction(2, 100);

async function getSolBalance(conn: Connection, pubkey: PublicKey): Promise<number> {
  return (await conn.getBalance(pubkey)) / 1e9;
}

async function getUsdcBalance(conn: Connection, pubkey: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(MINTS.USDC), pubkey);
    const account = await getAccount(conn, ata);
    return Number(account.amount) / 1e6;
  } catch { return 0; }
}

async function findOrphanedPositions(conn: Connection, owner: PublicKey): Promise<PublicKey[]> {
  // Find all token accounts with amount=1 (NFTs) that are Whirlpool position mints
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  const candidates: PublicKey[] = [];
  for (const { account } of tokenAccounts.value) {
    const info = account.data.parsed.info;
    const mint = info.mint as string;
    const amount = info.tokenAmount.uiAmount as number;
    // Position NFTs have amount=1 and decimals=0
    if (amount === 1 && info.tokenAmount.decimals === 0 && mint !== MINTS.SOL && mint !== MINTS.USDC) {
      // Check if this is actually a Whirlpool position by deriving the PDA
      const mintPk = new PublicKey(mint);
      const [posAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('position'), mintPk.toBuffer()],
        ORCA_WHIRLPOOL_PROGRAM_ID,
      );
      // Verify the position account exists on-chain
      const accInfo = await conn.getAccountInfo(posAddress);
      if (accInfo && accInfo.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) {
        candidates.push(mintPk);
      }
    }
  }
  return candidates;
}

async function main() {
  const conn = new Connection(process.env.RPC_URL!, { commitment: 'confirmed' });
  const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
  console.log('Wallet:', wallet.publicKey.toBase58());

  const solBefore = await getSolBalance(conn, wallet.publicKey);
  const usdcBefore = await getUsdcBalance(conn, wallet.publicKey);
  console.log(`Balances before: ${solBefore.toFixed(6)} SOL + ${usdcBefore.toFixed(2)} USDC ($${(solBefore * 85 + usdcBefore).toFixed(2)} est)`);

  // Auto-detect orphaned positions
  console.log('\nScanning for orphaned Whirlpool positions...');
  const orphans = await findOrphanedPositions(conn, wallet.publicKey);

  if (orphans.length === 0) {
    console.log('No orphaned positions found. Wallet is clean.');
    return;
  }

  console.log(`Found ${orphans.length} orphaned position(s):\n`);

  const ctx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);
  const whirlpool = await client.getPool(process.env.WHIRLPOOL_ADDRESS!);
  const poolData = whirlpool.getData();
  const currentPrice = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();
  console.log(`Current SOL price: $${currentPrice.toFixed(2)}\n`);

  for (const mint of orphans) {
    const [posAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), mint.toBuffer()],
      ORCA_WHIRLPOOL_PROGRAM_ID,
    );

    console.log(`--- Position: ${mint.toBase58()} ---`);
    console.log(`  PDA: ${posAddress.toBase58()}`);

    try {
      const position = await client.getPosition(posAddress);
      const data = position.getData();
      const priceLower = PriceMath.tickIndexToPrice(data.tickLowerIndex, 9, 6).toNumber();
      const priceUpper = PriceMath.tickIndexToPrice(data.tickUpperIndex, 9, 6).toNumber();
      const inRange = poolData.tickCurrentIndex >= data.tickLowerIndex && poolData.tickCurrentIndex <= data.tickUpperIndex;

      console.log(`  Liquidity: ${data.liquidity.toString()}`);
      console.log(`  Range: $${priceLower.toFixed(2)} — $${priceUpper.toFixed(2)}`);
      console.log(`  In range: ${inRange ? 'YES' : 'NO'}`);
      console.log(`  Fee owed A (SOL): ${data.feeOwedA.toString()}`);
      console.log(`  Fee owed B (USDC): ${data.feeOwedB.toString()}`);

      console.log('  Closing position...');
      const txBuilders = await whirlpool.closePosition(
        posAddress,
        SLIPPAGE,
        wallet.publicKey,
        wallet.publicKey,
        wallet.publicKey,
      );

      for (let i = 0; i < txBuilders.length; i++) {
        const sig = await txBuilders[i].buildAndExecute();
        console.log(`  TX ${i + 1}/${txBuilders.length} sent: ${sig.slice(0, 20)}...`);
        // Wait for confirmation
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log('  Position closed successfully!\n');
    } catch (err) {
      console.error(`  Error closing position: ${err}\n`);
    }
  }

  // Final balances
  await new Promise(r => setTimeout(r, 3000));
  const solAfter = await getSolBalance(conn, wallet.publicKey);
  const usdcAfter = await getUsdcBalance(conn, wallet.publicKey);
  console.log('=== RESULT ===');
  console.log(`Before: ${solBefore.toFixed(6)} SOL + ${usdcBefore.toFixed(2)} USDC`);
  console.log(`After:  ${solAfter.toFixed(6)} SOL + ${usdcAfter.toFixed(2)} USDC`);
  console.log(`Recovered: ${(solAfter - solBefore).toFixed(6)} SOL + ${(usdcAfter - usdcBefore).toFixed(2)} USDC`);
  const estRecovered = (solAfter - solBefore) * currentPrice + (usdcAfter - usdcBefore);
  console.log(`Estimated value recovered: $${estRecovered.toFixed(2)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
