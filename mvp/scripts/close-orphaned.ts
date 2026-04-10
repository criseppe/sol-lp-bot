import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { loadWallet } from '../src/live/wallet.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!, { commitment: 'confirmed' });
  const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
  console.log('Wallet:', wallet.publicKey.toBase58());

  const ctx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  // The position mint from earlier logs
  const positionMint = new PublicKey('5d6QD1tHa37FpPBGTyo4wXudgfYpipn8aEnX9Eyaq2eN');
  const [positionAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), positionMint.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM_ID,
  );

  console.log('Position address:', positionAddress.toBase58());

  try {
    const position = await client.getPosition(positionAddress);
    const data = position.getData();
    console.log('Liquidity:', data.liquidity.toString());
    console.log('Fee owed A (SOL):', data.feeOwedA.toString());
    console.log('Fee owed B (USDC):', data.feeOwedB.toString());

    const whirlpool = await client.getPool(process.env.WHIRLPOOL_ADDRESS!);
    console.log('Closing position...');

    const txBuilders = await whirlpool.closePosition(
      positionAddress,
      Percentage.fromFraction(1, 100),
      wallet.publicKey,
      wallet.publicKey,
      wallet.publicKey,
    );

    for (const tx of txBuilders) {
      const sig = await tx.buildAndExecute();
      console.log('TX sent');
    }

    console.log('Position closed successfully!');
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
