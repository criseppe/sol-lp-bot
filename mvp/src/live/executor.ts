import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath, PoolUtil, increaseLiquidityQuoteByInputToken,
  decreaseLiquidityQuoteByLiquidity, collectFeesQuote,
  NO_TOKEN_EXTENSION_CONTEXT, IGNORE_CACHE,
  type Whirlpool, type Position,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import BN from 'bn.js';
import DecimalImport from 'decimal.js';
const Decimal = DecimalImport as unknown as typeof DecimalImport.default;
import { MINTS } from '../constants.js';
import type { RangeBounds, Regime } from '../types.js';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const SLIPPAGE = Percentage.fromFraction(2, 100); // 2% slippage

export interface LivePosition {
  positionMint: PublicKey;
  positionAddress: PublicKey;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  entryPrice: number;
  entryTime: number;
  regime: Regime;
}

export interface SwapEvent {
  timestamp: number;
  fromToken: string;
  toToken: string;
  fromAmount: number;
  toAmount: number;
  reason: string;
}

export class LiveExecutor {
  private connection: Connection;
  private wallet: Wallet;
  private ctx: WhirlpoolContext;
  private client: ReturnType<typeof buildWhirlpoolClient>;
  private whirlpoolAddress: PublicKey;
  private currentPosition: LivePosition | null = null;
  public onSwap: ((event: SwapEvent) => void) | null = null;
  public cumGasLamports = 0;
  public txCount = 0;

  getGasStats(solPrice: number): { gasSol: number; gasUsdc: number; txCount: number } {
    const gasSol = this.cumGasLamports / 1_000_000_000;
    return { gasSol, gasUsdc: gasSol * solPrice, txCount: this.txCount };
  }

  private async execTx(txBuilder: { buildAndExecute: () => Promise<string> }): Promise<string> {
    const sig = await txBuilder.buildAndExecute();
    this.txCount++;
    try {
      await new Promise(r => setTimeout(r, 1500));
      const txData = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (txData?.meta?.fee) {
        this.cumGasLamports += txData.meta.fee;
        console.log(JSON.stringify({ level: 'info', msg: `tx fee: ${txData.meta.fee} lamports (${(txData.meta.fee/1e9).toFixed(6)} SOL)`, sig: sig.slice(0,12), cumGas: this.cumGasLamports, timestamp: Date.now() }));
      }
    } catch {
      this.cumGasLamports += 5000;
    }
    return sig;
  }

  constructor(connection: Connection, wallet: Wallet, whirlpoolAddress: string) {
    this.connection = connection;
    this.wallet = wallet;
    this.whirlpoolAddress = new PublicKey(whirlpoolAddress);
    this.ctx = WhirlpoolContext.from(connection, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
    this.client = buildWhirlpoolClient(this.ctx);
  }

  async openPosition(
    range: RangeBounds,
    currentPrice: number,
    regime: Regime,
    usdcToDeposit: number,
  ): Promise<LivePosition> {
    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);

    // Initialize tick arrays if needed
    const initTx = await whirlpool.initTickArrayForTicks([range.tickLower, range.tickUpper]);
    if (initTx) {
      console.log(JSON.stringify({ level: 'info', msg: 'initializing tick arrays', timestamp: Date.now() }));
      await this.execTx(initTx);
    }

    // Get actual balances
    let solBal = await this.getSolBalance();
    let usdcBal = await this.getUsdcBalance();
    const solReserve = 0.05;
    const usdcReserve = 1;

    const usdcMint = new PublicKey(MINTS.USDC);
    const solMint = new PublicKey(MINTS.SOL);

    // First, try a USDC quote to see the ideal SOL/USDC ratio
    let solAvailable = Math.max(0, solBal - solReserve);
    let usdcAvailable = Math.max(0, usdcBal - usdcReserve);

    console.log(JSON.stringify({
      level: 'info',
      msg: `Wallet: ${solBal.toFixed(4)} SOL (${solAvailable.toFixed(4)} avail), ${usdcBal.toFixed(2)} USDC (${usdcAvailable.toFixed(2)} avail). Deploy target: $${usdcToDeposit.toFixed(2)}`,
      timestamp: Date.now(),
    }));

    // Determine the ideal ratio by quoting with 1 SOL to find SOL:USDC ratio
    const ratioQuote = increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(1),
      range.tickLower, range.tickUpper, SLIPPAGE, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    );
    const usdcPer1Sol = Number(ratioQuote.tokenEstB.toString()) / 1e6;
    // ratio: for every 1 SOL deposited, need usdcPer1Sol USDC
    // Total value per unit: 1 SOL * price + usdcPer1Sol USDC
    const valuePerSolUnit = currentPrice + usdcPer1Sol;

    // Calculate ideal split of total available capital
    const totalAvailableUsdc = solAvailable * currentPrice + usdcAvailable;
    const idealSolUnits = totalAvailableUsdc / valuePerSolUnit;
    const idealSol = idealSolUnits; // how much SOL we'd need if deploying everything
    const idealUsdc = idealSol * usdcPer1Sol;

    console.log(JSON.stringify({
      level: 'info',
      msg: `Ratio: 1 SOL needs ${usdcPer1Sol.toFixed(2)} USDC. Ideal split: ${idealSol.toFixed(4)} SOL + ${idealUsdc.toFixed(2)} USDC. Have: ${solAvailable.toFixed(4)} SOL + ${usdcAvailable.toFixed(2)} USDC`,
      timestamp: Date.now(),
    }));

    // Check if we need to swap to reach the ideal ratio
    const solDeficit = idealSol - solAvailable;
    const usdcDeficit = idealUsdc - usdcAvailable;

    if (solDeficit > 0.01) {
      // Need more SOL — swap USDC → SOL
      const usdcToSwap = Math.min(solDeficit * currentPrice * 1.03, usdcAvailable - 2); // keep $2 buffer
      if (usdcToSwap > 1) {
        console.log(JSON.stringify({
          level: 'info',
          msg: `Pre-deposit swap: need ${solDeficit.toFixed(4)} more SOL. Swapping ~$${usdcToSwap.toFixed(2)} USDC → SOL`,
          timestamp: Date.now(),
        }));
        try {
          const { swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
          const swapQuote = await swapQuoteByInputToken(
            whirlpool, usdcMint, new BN(Math.floor(usdcToSwap * 1e6)),
            SLIPPAGE, ORCA_WHIRLPOOL_PROGRAM_ID, this.client.getFetcher(),
          );
          const solBeforeSwap = solBal;
          const usdcBeforeSwap = usdcBal;
          const swapTx = await whirlpool.swap(swapQuote);
          await this.execTx(swapTx);
          await new Promise(r => setTimeout(r, 2000));
          solBal = await this.getSolBalance();
          usdcBal = await this.getUsdcBalance();
          solAvailable = Math.max(0, solBal - solReserve);
          usdcAvailable = Math.max(0, usdcBal - usdcReserve);
          const solReceived = solBal - solBeforeSwap;
          const usdcSpent = usdcBeforeSwap - usdcBal;
          console.log(JSON.stringify({ level: 'info', msg: `Swap done: ${usdcSpent.toFixed(2)} USDC → ${solReceived.toFixed(4)} SOL. Now: ${solBal.toFixed(4)} SOL, ${usdcBal.toFixed(2)} USDC`, timestamp: Date.now() }));
          if (this.onSwap) this.onSwap({ timestamp: Date.now(), fromToken: 'USDC', toToken: 'SOL', fromAmount: usdcSpent, toAmount: solReceived, reason: `Pre-deposit: wallet had ${solBeforeSwap.toFixed(4)} SOL, needed ~${idealSol.toFixed(4)}. Swapped ${usdcSpent.toFixed(2)} USDC → ${solReceived.toFixed(4)} SOL.` });
        } catch (err) {
          console.log(JSON.stringify({ level: 'warn', msg: `Swap failed: ${String(err)}`, timestamp: Date.now() }));
        }
      }
    } else if (usdcDeficit > 1) {
      // Need more USDC — swap SOL → USDC
      const solToSwap = Math.min(usdcDeficit / currentPrice * 1.03, solAvailable - 0.02);
      if (solToSwap > 0.005) {
        console.log(JSON.stringify({
          level: 'info',
          msg: `Pre-deposit swap: need ${usdcDeficit.toFixed(2)} more USDC. Swapping ~${solToSwap.toFixed(4)} SOL → USDC`,
          timestamp: Date.now(),
        }));
        try {
          const { swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
          const swapQuote = await swapQuoteByInputToken(
            whirlpool, solMint, new BN(Math.floor(solToSwap * 1e9)),
            SLIPPAGE, ORCA_WHIRLPOOL_PROGRAM_ID, this.client.getFetcher(),
          );
          const solBeforeSwap = solBal;
          const usdcBeforeSwap = usdcBal;
          const swapTx = await whirlpool.swap(swapQuote);
          await this.execTx(swapTx);
          await new Promise(r => setTimeout(r, 2000));
          solBal = await this.getSolBalance();
          usdcBal = await this.getUsdcBalance();
          solAvailable = Math.max(0, solBal - solReserve);
          usdcAvailable = Math.max(0, usdcBal - usdcReserve);
          const usdcReceived = usdcBal - usdcBeforeSwap;
          const solSpent = solBeforeSwap - solBal;
          console.log(JSON.stringify({ level: 'info', msg: `Swap done: ${solSpent.toFixed(4)} SOL → ${usdcReceived.toFixed(2)} USDC. Now: ${solBal.toFixed(4)} SOL, ${usdcBal.toFixed(2)} USDC`, timestamp: Date.now() }));
          if (this.onSwap) this.onSwap({ timestamp: Date.now(), fromToken: 'SOL', toToken: 'USDC', fromAmount: solSpent, toAmount: usdcReceived, reason: `Pre-deposit: wallet had ${usdcBeforeSwap.toFixed(2)} USDC, needed ~${idealUsdc.toFixed(2)}. Swapped ${solSpent.toFixed(4)} SOL → ${usdcReceived.toFixed(2)} USDC.` });
        } catch (err) {
          console.log(JSON.stringify({ level: 'warn', msg: `Swap failed: ${String(err)}`, timestamp: Date.now() }));
        }
      }
    }

    // Refresh pool data after potential swap
    await whirlpool.refreshData();

    // Quote with updated balances — try SOL first (usually the limiting token)
    let quote = solAvailable > 0.01 ? increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(solAvailable),
      range.tickLower, range.tickUpper, SLIPPAGE, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    ) : null;
    let quotedBy = 'SOL';

    if (quote) {
      const usdcNeeded = Number(quote.tokenEstB.toString()) / 1e6;
      if (usdcNeeded > usdcAvailable) {
        // Try USDC quote instead
        quote = increaseLiquidityQuoteByInputToken(
          usdcMint, new Decimal(usdcAvailable),
          range.tickLower, range.tickUpper, SLIPPAGE, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        );
        quotedBy = 'USDC';
        const solNeeded = Number(quote.tokenEstA.toString()) / 1e9;
        if (solNeeded > solAvailable) quote = null;
      }
    }

    if (!quote || quote.liquidityAmount.isZero()) {
      console.log(JSON.stringify({
        level: 'warn',
        msg: `Cannot open position: SOL=${solAvailable.toFixed(4)}, USDC=${usdcAvailable.toFixed(2)}. No valid quote.`,
        timestamp: Date.now(),
      }));
      return null as unknown as LivePosition;
    }

    const estSol = Number(quote.tokenEstA.toString()) / 1e9;
    const estUsdc = Number(quote.tokenEstB.toString()) / 1e6;
    console.log(JSON.stringify({
      level: 'info',
      msg: `Quoted by ${quotedBy}: depositing ${estSol.toFixed(4)} SOL ($${(estSol*currentPrice).toFixed(2)}) + ${estUsdc.toFixed(2)} USDC = $${(estSol*currentPrice+estUsdc).toFixed(2)} total`,
      timestamp: Date.now(),
    }));

    console.log(JSON.stringify({
      level: 'info',
      msg: 'opening position',
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      priceLower: range.priceLower.toFixed(4),
      priceUpper: range.priceUpper.toFixed(4),
      estSOL: (Number(quote.tokenEstA.toString()) / 1e9).toFixed(6),
      estUSDC: (Number(quote.tokenEstB.toString()) / 1e6).toFixed(6),
      liquidity: quote.liquidityAmount.toString(),
      timestamp: Date.now(),
    }));

    const { positionMint, tx } = await whirlpool.openPosition(
      range.tickLower,
      range.tickUpper,
      quote,
    );

    await this.execTx(tx);

    // Derive position address
    const [positionAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), positionMint.toBuffer()],
      ORCA_WHIRLPOOL_PROGRAM_ID,
    );

    this.currentPosition = {
      positionMint,
      positionAddress,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      priceLower: range.priceLower,
      priceUpper: range.priceUpper,
      entryPrice: currentPrice,
      entryTime: Date.now(),
      regime,
    };

    console.log(JSON.stringify({
      level: 'info',
      msg: 'position opened',
      positionMint: positionMint.toBase58(),
      timestamp: Date.now(),
    }));

    return this.currentPosition;
  }

  async closePosition(): Promise<{
    solReceived: number; usdcReceived: number;
    feeSolCollected: number; feeUsdcCollected: number; feeTotalUsdc: number;
    ilAtClose: number;
    entryPrice: number; closePrice: number;
    positionMint: string; priceLower: number; priceUpper: number;
  }> {
    if (!this.currentPosition) {
      throw new Error('No open position to close');
    }

    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
    const poolData = whirlpool.getData();
    const currentPrice = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();

    // 1. Capture pending fees before close
    const pendingFees = await this.getPendingFees();
    const feeSolCollected = pendingFees?.feeSolDecimal ?? 0;
    const feeUsdcCollected = pendingFees?.feeUsdcDecimal ?? 0;
    const feeTotalUsdc = pendingFees?.feeTotalUsdc ?? 0;

    // 2. Compute IL before close
    let ilAtClose = 0;
    const entryPrice = this.currentPosition.entryPrice;
    if (entryPrice && entryPrice !== currentPrice) {
      const posComp = await this.getPositionComposition();
      const posValue = posComp?.totalUsdc ?? 0;
      const priceRatio = currentPrice / entryPrice;
      const ilPct = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
      ilAtClose = ilPct * posValue;
    }

    // 3. Capture position info before it's cleared
    const posInfo = {
      positionMint: this.currentPosition.positionMint.toBase58(),
      priceLower: this.currentPosition.priceLower,
      priceUpper: this.currentPosition.priceUpper,
    };

    // 4. Close on-chain
    const solBefore = await this.getSolBalance();
    const usdcBefore = await this.getUsdcBalance();

    const txBuilders = await whirlpool.closePosition(
      this.currentPosition.positionAddress,
      SLIPPAGE,
      this.wallet.publicKey,
      this.wallet.publicKey,
      this.wallet.publicKey,
    );

    for (const txBuilder of txBuilders) {
      await this.execTx(txBuilder);
    }

    const solAfter = await this.getSolBalance();
    const usdcAfter = await this.getUsdcBalance();

    console.log(JSON.stringify({
      level: 'info',
      msg: 'position closed',
      positionMint: posInfo.positionMint,
      solReceived: (solAfter - solBefore).toFixed(6),
      usdcReceived: (usdcAfter - usdcBefore).toFixed(6),
      feeSol: feeSolCollected.toFixed(6),
      feeUsdc: feeUsdcCollected.toFixed(6),
      il: ilAtClose.toFixed(4),
      timestamp: Date.now(),
    }));

    this.currentPosition = null;
    return {
      solReceived: solAfter - solBefore,
      usdcReceived: usdcAfter - usdcBefore,
      feeSolCollected, feeUsdcCollected, feeTotalUsdc,
      ilAtClose,
      entryPrice, closePrice: currentPrice,
      ...posInfo,
    };
  }

  async collectFees(): Promise<{ feeSol: number; feeUsdc: number }> {
    if (!this.currentPosition) return { feeSol: 0, feeUsdc: 0 };

    const solBefore = await this.getSolBalance();
    const usdcBefore = await this.getUsdcBalance();

    const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
    const tx = await position.collectFees();
    await this.execTx(tx);

    const solAfter = await this.getSolBalance();
    const usdcAfter = await this.getUsdcBalance();

    // Use collectFeesQuote to know expected fees (balance diff is skewed by gas)
    const result = {
      feeSol: Math.max(0, solAfter - solBefore),
      feeUsdc: Math.max(0, usdcAfter - usdcBefore),
    };

    console.log(JSON.stringify({
      level: 'info',
      msg: 'fees collected',
      feeSol: result.feeSol.toFixed(6),
      feeUsdc: result.feeUsdc.toFixed(6),
      timestamp: Date.now(),
    }));

    return result;
  }

  async getPositionData(): Promise<{ liquidity: string; feeOwedA: string; feeOwedB: string } | null> {
    if (!this.currentPosition) return null;
    try {
      const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
      const data = position.getData();
      return {
        liquidity: data.liquidity.toString(),
        feeOwedA: data.feeOwedA.toString(),
        feeOwedB: data.feeOwedB.toString(),
      };
    } catch {
      return null;
    }
  }

  async getPositionComposition(): Promise<{ sol: number; usdc: number; totalUsdc: number } | null> {
    if (!this.currentPosition) return null;
    try {
      const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
      const poolData = whirlpool.getData();
      const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
      const posData = position.getData();

      if (posData.liquidity.isZero()) return { sol: 0, usdc: 0, totalUsdc: 0 };

      const currentSqrtPrice = poolData.sqrtPrice;
      const lowerSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(this.currentPosition.tickLower);
      const upperSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(this.currentPosition.tickUpper);

      const amounts = PoolUtil.getTokenAmountsFromLiquidity(
        posData.liquidity,
        currentSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        false,
      );

      const sol = Number(amounts.tokenA.toString()) / 1e9;
      const usdc = Number(amounts.tokenB.toString()) / 1e6;
      const solPrice = PriceMath.sqrtPriceX64ToPrice(currentSqrtPrice, 9, 6).toNumber();
      return { sol, usdc, totalUsdc: sol * solPrice + usdc };
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'getPositionComposition failed', error: String(err), timestamp: Date.now() }));
      return null;
    }
  }

  async getPendingFees(): Promise<{ feeSolDecimal: number; feeUsdcDecimal: number; feeTotalUsdc: number } | null> {
    if (!this.currentPosition) return null;
    try {
      const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
      const poolData = whirlpool.getData();
      const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
      const posData = position.getData();
      const tickLower = position.getLowerTickData();
      const tickUpper = position.getUpperTickData();

      // Use collectFeesQuote to compute real pending fees from fee growth data
      // This calculates off-chain without needing an updateFeesAndRewards tx
      const quote = collectFeesQuote({
        whirlpool: poolData,
        position: posData,
        tickLower,
        tickUpper,
        tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
      });

      const feeSol = Number(quote.feeOwedA.toString()) / 1e9;
      const feeUsdc = Number(quote.feeOwedB.toString()) / 1e6;
      const solPrice = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();

      return {
        feeSolDecimal: feeSol,
        feeUsdcDecimal: feeUsdc,
        feeTotalUsdc: feeSol * solPrice + feeUsdc,
      };
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'getPendingFees failed', error: String(err), timestamp: Date.now() }));
      return null;
    }
  }

  async getEstimatedYield24h(): Promise<{ dailyFeesUsdc: number; aprPct: number } | null> {
    if (!this.currentPosition) return null;
    try {
      const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
      const poolData = whirlpool.getData();
      const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
      const posData = position.getData();

      if (posData.liquidity.isZero()) return { dailyFeesUsdc: 0, aprPct: 0 };

      // Check if position is in range (earning fees)
      const inRange = poolData.tickCurrentIndex >= this.currentPosition.tickLower &&
                      poolData.tickCurrentIndex <= this.currentPosition.tickUpper;
      if (!inRange) return { dailyFeesUsdc: 0, aprPct: 0 };

      // Fee rate: poolData.feeRate is in hundredths of a basis point
      // e.g. 500 = 0.05% = 5 bps
      const feeRatePct = poolData.feeRate / 1_000_000;

      // Position's share of pool liquidity at current tick
      // Pool liquidity = active liquidity at current tick
      const poolLiquidity = poolData.liquidity;
      const posLiquidity = posData.liquidity;
      const liquidityShare = poolLiquidity.isZero() ? 0 : posLiquidity.toNumber() / poolLiquidity.toNumber();

      // Estimate daily volume from the pool
      // We use a conservative estimate based on typical SOL/USDC pool volume
      // The Orca SOL/USDC whirlpool typically does $50M-500M/day
      // For a more accurate estimate, we'd need historical volume data
      const estDailyVolume = 100_000_000; // $100M conservative estimate

      const dailyFeesUsdc = liquidityShare * estDailyVolume * feeRatePct;

      // Get position value for APR calc
      const comp = await this.getPositionComposition();
      const posValue = comp?.totalUsdc ?? 0;
      const aprPct = posValue > 0 ? (dailyFeesUsdc * 365 / posValue) * 100 : 0;

      return { dailyFeesUsdc, aprPct };
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'getEstimatedYield24h failed', error: String(err), timestamp: Date.now() }));
      return null;
    }
  }

  getCurrentPosition(): LivePosition | null {
    return this.currentPosition;
  }

  setCurrentPosition(pos: LivePosition | null): void {
    this.currentPosition = pos;
  }

  private async getSolBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey);
    return lamports / 1_000_000_000;
  }

  private async getUsdcBalance(): Promise<number> {
    try {
      const usdcMint = new PublicKey(MINTS.USDC);
      const ata = await getAssociatedTokenAddress(usdcMint, this.wallet.publicKey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 1_000_000;
    } catch {
      return 0;
    }
  }
}
