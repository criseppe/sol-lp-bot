import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, collectFeesQuote, NO_TOKEN_EXTENSION_CONTEXT } from '@orca-so/whirlpools-sdk';
import { loadWallet } from '../src/live/wallet.js';

async function main() {
  const conn = new Connection(process.env.RPC_URL!, { commitment: 'confirmed' });
  const wallet = loadWallet(process.env.WALLET_PRIVATE_KEY!);
  const ctx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  const positionMint = new PublicKey('CSMAs7M7f9FugERf6Sofxzvyq2WDoSopwEH57vudxpWQ');
  const [positionAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), positionMint.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM_ID,
  );

  const whirlpool = await client.getPool(process.env.WHIRLPOOL_ADDRESS!);
  const poolData = whirlpool.getData();
  const position = await client.getPosition(positionAddress);
  const posData = position.getData();
  const tickLower = position.getLowerTickData();
  const tickUpper = position.getUpperTickData();

  console.log('On-chain feeOwedA:', posData.feeOwedA.toString());
  console.log('On-chain feeOwedB:', posData.feeOwedB.toString());
  console.log('feeGrowthCheckpointA:', posData.feeGrowthCheckpointA.toString());
  console.log('feeGrowthCheckpointB:', posData.feeGrowthCheckpointB.toString());
  console.log('liquidity:', posData.liquidity.toString());

  // Try collectFeesQuote
  const quote = collectFeesQuote({
    whirlpool: poolData,
    position: posData,
    tickLower,
    tickUpper,
    tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
  });

  console.log('\ncollectFeesQuote:');
  console.log('feeOwedA:', quote.feeOwedA.toString(), '=', (Number(quote.feeOwedA.toString()) / 1e9).toFixed(9), 'SOL');
  console.log('feeOwedB:', quote.feeOwedB.toString(), '=', (Number(quote.feeOwedB.toString()) / 1e6).toFixed(6), 'USDC');
}

main();
