import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, PriceMath, TickArrayUtil, TickUtil, IGNORE_CACHE } from '@orca-so/whirlpools-sdk';
import { Wallet } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

async function main() {
  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!)));
  const ctx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);
  const poolPk = new PublicKey(process.env.WHIRLPOOL_ADDRESS!);

  const whirlpool = await client.getPool(poolPk, IGNORE_CACHE);
  const poolData = whirlpool.getData();
  const price = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();
  const tickSpacing = poolData.tickSpacing;

  // Find position
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });
  let posMint: PublicKey | null = null;
  for (const { account } of tokenAccounts.value) {
    const info = account.data.parsed.info;
    if (info.tokenAmount.uiAmount === 1 && info.tokenAmount.decimals === 0) {
      const mint = new PublicKey(info.mint);
      const [posAddr] = PublicKey.findProgramAddressSync([Buffer.from('position'), mint.toBuffer()], ORCA_WHIRLPOOL_PROGRAM_ID);
      const accInfo = await conn.getAccountInfo(posAddr);
      if (accInfo && accInfo.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) { posMint = mint; break; }
    }
  }
  if (!posMint) { console.log('No position'); return; }

  const [posAddr] = PublicKey.findProgramAddressSync([Buffer.from('position'), posMint.toBuffer()], ORCA_WHIRLPOOL_PROGRAM_ID);
  const position = await client.getPosition(posAddr, IGNORE_CACHE);
  const posData = position.getData();

  console.log('Price:', price, 'Tick:', poolData.tickCurrentIndex, 'TickSpacing:', tickSpacing);
  console.log('Position:', posData.tickLowerIndex, '-', posData.tickUpperIndex);

  // Fetch tick arrays directly
  const fetcher = client.getFetcher();
  const tickArrayLowerPDAs = TickArrayUtil.getTickArrayPDAs(posData.tickLowerIndex, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, poolPk);
  const tickArrayUpperPDAs = TickArrayUtil.getTickArrayPDAs(posData.tickUpperIndex, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, poolPk);

  const tickArrayLower = await fetcher.getTickArray(tickArrayLowerPDAs[0].publicKey, IGNORE_CACHE);
  const tickArrayUpper = await fetcher.getTickArray(tickArrayUpperPDAs[0].publicKey, IGNORE_CACHE);

  if (!tickArrayLower || !tickArrayUpper) { console.log('Could not fetch tick arrays'); return; }

  const lowerTick = TickArrayUtil.getTickFromArray(tickArrayLower, posData.tickLowerIndex, tickSpacing);
  const upperTick = TickArrayUtil.getTickFromArray(tickArrayUpper, posData.tickUpperIndex, tickSpacing);

  console.log('\n--- From position.getLowerTickData() (SDK) ---');
  const posLower = position.getLowerTickData();
  const posUpper = position.getUpperTickData();
  console.log('Lower fgOutsideA:', posLower.feeGrowthOutsideA.toString());
  console.log('Upper fgOutsideA:', posUpper.feeGrowthOutsideA.toString());

  console.log('\n--- From direct TickArray fetch ---');
  console.log('Lower fgOutsideA:', lowerTick.feeGrowthOutsideA.toString());
  console.log('Upper fgOutsideA:', upperTick.feeGrowthOutsideA.toString());

  console.log('\n--- Same data?', posLower.feeGrowthOutsideA.toString() === lowerTick.feeGrowthOutsideA.toString());

  // Compute with direct tick data
  const U128 = (1n << 128n);
  const wrap = (v: bigint) => ((v % U128) + U128) % U128;
  const Q64 = 1n << 64n;

  const currentTick = poolData.tickCurrentIndex;
  const liquidity = BigInt(posData.liquidity.toString());
  const fgGA = BigInt(poolData.feeGrowthGlobalA.toString());
  const fgGB = BigInt(poolData.feeGrowthGlobalB.toString());
  const loA = BigInt(lowerTick.feeGrowthOutsideA.toString());
  const loB = BigInt(lowerTick.feeGrowthOutsideB.toString());
  const upA = BigInt(upperTick.feeGrowthOutsideA.toString());
  const upB = BigInt(upperTick.feeGrowthOutsideB.toString());

  console.log('\nfgGlobalA:', fgGA.toString());
  console.log('loA:', loA.toString());
  console.log('upA:', upA.toString());

  const belowA = currentTick >= posData.tickLowerIndex ? loA : wrap(fgGA - loA);
  const belowB = currentTick >= posData.tickLowerIndex ? loB : wrap(fgGB - loB);
  const aboveA = currentTick < posData.tickUpperIndex ? upA : wrap(fgGA - upA);
  const aboveB = currentTick < posData.tickUpperIndex ? upB : wrap(fgGB - upB);

  console.log('belowA:', belowA.toString());
  console.log('aboveA:', aboveA.toString());
  console.log('sum:', (belowA + aboveA).toString());

  const insideA = wrap(fgGA - belowA - aboveA);
  const insideB = wrap(fgGB - belowB - aboveB);
  const ckA = BigInt(posData.feeGrowthCheckpointA.toString());
  const ckB = BigInt(posData.feeGrowthCheckpointB.toString());

  console.log('\ninsideA:', insideA.toString());
  console.log('ckA:', ckA.toString());
  const diffA = wrap(insideA - ckA);
  const diffB = wrap(insideB - ckB);
  console.log('diffA:', diffA.toString());

  const feeA = diffA * liquidity / Q64;
  const feeB = diffB * liquidity / Q64;
  console.log('\nfeeA lamports:', feeA.toString());
  console.log('feeB micro-USDC:', feeB.toString());
  console.log('feeA SOL:', Number(feeA) / 1e9);
  console.log('feeB USDC:', Number(feeB) / 1e6);
  console.log('Total USD:', Number(feeA) / 1e9 * price + Number(feeB) / 1e6);

  // Sanity: what does Orca show? Check the position value
  console.log('\n--- Position info ---');
  console.log('feeOwedA:', posData.feeOwedA.toString(), '= SOL:', Number(posData.feeOwedA.toString()) / 1e9);
  console.log('feeOwedB:', posData.feeOwedB.toString(), '= USDC:', Number(posData.feeOwedB.toString()) / 1e6);
}

main().catch(console.error);
