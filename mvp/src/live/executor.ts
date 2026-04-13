import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
  PriceMath, PoolUtil, increaseLiquidityQuoteByInputToken,
  decreaseLiquidityQuoteByLiquidity, collectFeesQuote,
  TickArrayUtil, NO_TOKEN_EXTENSION_CONTEXT, IGNORE_CACHE,
  type Whirlpool, type Position,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import DecimalImport from 'decimal.js';
const Decimal = DecimalImport as unknown as typeof DecimalImport.default;
import { MINTS } from '../constants.js';
import type { RangeBounds, Regime } from '../types.js';
import { executeSwap, type SwapResult } from './swapper.js';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
function getSlippage(): Percentage { return Percentage.fromFraction(runtime.swapSlippageBps, 10000); }
function getSwapBuffer(): number { return 1 + runtime.swapBufferPct / 100; }

// Dynamic reserves — read from runtime config (updated via /config page)
import { runtime } from '../config.js';
function getSolReserve(): number { return runtime.solReserve; }
function getUsdcReserve(): number { return runtime.usdcReserve; }

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
  entrySol: number;
  entryUsdc: number;
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
  public shouldAllowSwap: ((direction: 'sell_sol' | 'buy_sol', amount: number, price: number) => boolean) | null = null;
  public cumGasLamports = 0;
  public txCount = 0;

  getGasStats(solPrice: number): { gasSol: number; gasUsdc: number; txCount: number } {
    const gasSol = this.cumGasLamports / 1_000_000_000;
    return { gasSol, gasUsdc: gasSol * solPrice, txCount: this.txCount };
  }

  private async execTx(txBuilder: { buildAndExecute: () => Promise<string> }): Promise<string> {
    let sig: string;
    try {
      sig = await txBuilder.buildAndExecute();
    } catch (err: any) {
      const msg = String(err);
      // Retry once on transient errors (blockhash expired, timeout, 429)
      if (msg.includes('Blockhash not found') || msg.includes('timeout') || msg.includes('429')) {
        console.log(JSON.stringify({ level: 'warn', msg: `TX failed (${msg.slice(0, 80)}), retrying in 3s...`, timestamp: Date.now() }));
        await new Promise(r => setTimeout(r, 3000));
        sig = await txBuilder.buildAndExecute();
      } else {
        throw err;
      }
    }
    this.txCount++;
    // Try to get actual fee with confirmation, retry once after delay
    let feeRecorded = false;
    for (let attempt = 0; attempt < 2 && !feeRecorded; attempt++) {
      try {
        if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
        else await new Promise(r => setTimeout(r, 3000));
        const txData = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (txData?.meta?.fee) {
          this.cumGasLamports += txData.meta.fee;
          console.log(JSON.stringify({ level: 'info', msg: `tx fee: ${txData.meta.fee} lamports (${(txData.meta.fee/1e9).toFixed(6)} SOL)`, sig: sig.slice(0,12), cumGas: this.cumGasLamports, timestamp: Date.now() }));
          feeRecorded = true;
        }
      } catch { /* retry */ }
    }
    if (!feeRecorded) {
      this.cumGasLamports += 10000; // conservative estimate if both attempts fail
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

  /**
   * Execute a swap via Jupiter (with Orca fallback).
   * Updates cumGasLamports/txCount for Jupiter swaps.
   */
  private async doSwap(inputMint: string, outputMint: string, amountRaw: number, reason: string): Promise<SwapResult | null> {
    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
    const result = await executeSwap(
      this.connection,
      this.wallet.payer,
      { inputMint, outputMint, amountRaw, slippageBps: runtime.swapSlippageBps, reason },
      { whirlpool, fetcher: this.client.getFetcher(), execTx: (tx) => this.execTx(tx) },
    );
    // Track gas for Jupiter swaps (Orca gas is tracked via execTx already)
    if (result && result.provider === 'jupiter') {
      this.cumGasLamports += result.feeLamports;
      this.txCount++;
    }
    // Fire swap event callback for tracking (swap ledger, cost basis, etc.)
    if (result && this.onSwap) {
      try {
        this.onSwap({
          timestamp: Date.now(),
          fromToken: inputMint === MINTS.SOL ? 'SOL' : 'USDC',
          toToken: outputMint === MINTS.SOL ? 'SOL' : 'USDC',
          fromAmount: inputMint === MINTS.SOL ? amountRaw / 1e9 : amountRaw / 1e6,
          toAmount: result.outputAmount,
          reason,
        });
      } catch {}
    }
    return result;
  }

  /**
   * Public swap method for external callers (idle wallet rebalance, etc.).
   */
  async doSwapPublic(inputMint: string, outputMint: string, amountRaw: number, reason: string): Promise<SwapResult | null> {
    return this.doSwap(inputMint, outputMint, amountRaw, reason);
  }

  async openPosition(
    range: RangeBounds,
    currentPrice: number,
    regime: Regime,
    usdcToDeposit: number,
  ): Promise<LivePosition | null> {
    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);

    // Initialize tick arrays if needed — retry once if it fails (429 can cause false negatives)
    const poolData = whirlpool.getData();
    const tickSpacing = poolData.tickSpacing;
    try {
      const initTx = await whirlpool.initTickArrayForTicks([range.tickLower, range.tickUpper]);
      if (initTx) {
        console.log(JSON.stringify({ level: 'info', msg: 'initializing tick arrays', timestamp: Date.now() }));
        await this.execTx(initTx);
        await new Promise(r => setTimeout(r, 5000)); // 5s wait for RPC to see the init
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `Tick array init failed (may already exist): ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }));
    }

    // Validate tick arrays exist before opening — avoids 0x1781 simulation failures
    try {
      const fetcher = this.client.getFetcher();
      const lowerPDAs = TickArrayUtil.getTickArrayPDAs(range.tickLower, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false);
      const upperPDAs = TickArrayUtil.getTickArrayPDAs(range.tickUpper, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false);
      const lowerArr = await fetcher.getTickArray(lowerPDAs[0].publicKey, IGNORE_CACHE);
      const upperArr = await fetcher.getTickArray(upperPDAs[0].publicKey, IGNORE_CACHE);
      if (!lowerArr || !upperArr) {
        console.log(JSON.stringify({ level: 'warn', msg: `Tick arrays not found after init. Lower: ${!!lowerArr}, Upper: ${!!upperArr}. Waiting 5s and retrying...`, timestamp: Date.now() }));
        await new Promise(r => setTimeout(r, 5000));
        // Re-init if still missing
        const retryInit = await whirlpool.initTickArrayForTicks([range.tickLower, range.tickUpper]);
        if (retryInit) {
          await this.execTx(retryInit);
          await new Promise(r => setTimeout(r, 5000));
        }
      } else {
        console.log(JSON.stringify({ level: 'info', msg: 'Tick arrays validated ✅', timestamp: Date.now() }));
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `Tick array validation failed: ${err instanceof Error ? err.message : String(err)}. Proceeding anyway.`, timestamp: Date.now() }));
    }

    const usdcMint = new PublicKey(MINTS.USDC);
    const solMint = new PublicKey(MINTS.SOL);

    // Get balances and compute ideal ratio for the range
    let solBal = await this.getSolBalance();
    let usdcBal = await this.getUsdcBalance();
    let solAvailable = Math.max(0, solBal - getSolReserve());
    let usdcAvailable = Math.max(0, usdcBal - getUsdcReserve());

    // Pre-open swap: if wallet is heavily imbalanced (one side < $5), swap to match
    // the ideal ratio for the LP range. This prevents "no valid quote" after downside exits.
    // Cap the swap to the deploy target so we don't swap more than needed.
    const ratioQuote = increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(1), range.tickLower, range.tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    );
    const usdcPer1Sol = Number(ratioQuote.tokenEstB.toString()) / 1e6;
    const swapTargetUsdc = usdcToDeposit > 0 ? Math.min(solAvailable * currentPrice + usdcAvailable, usdcToDeposit) : (solAvailable * currentPrice + usdcAvailable);
    const idealSol = swapTargetUsdc / (currentPrice + usdcPer1Sol);
    const idealUsdc = idealSol * usdcPer1Sol;

    // Pre-open swap: if wallet ratio is significantly off from the ideal LP deposit ratio, swap to match.
    // Old logic only swapped when one side < $5 — now swaps whenever deviation > 30%.
    const solValueUsdc = solAvailable * currentPrice;
    const totalAvail = solValueUsdc + usdcAvailable;
    const currentSolRatio = totalAvail > 0 ? solValueUsdc / totalAvail : 0.5;
    const idealSolRatio = totalAvail > 0 ? (idealSol * currentPrice) / totalAvail : 0.5;
    const ratioDeviation = Math.abs(currentSolRatio - idealSolRatio);

    if (ratioDeviation > 0.30 && totalAvail > 50) {
      if (currentSolRatio > idealSolRatio && solAvailable > 0.1) {
        // Too much SOL — swap to USDC
        const solToSwap = Math.min((idealUsdc - usdcAvailable) / currentPrice * getSwapBuffer(), solAvailable - 0.05);
        if (solToSwap > 0.01) {
          console.log(JSON.stringify({ level: 'info', msg: `Pre-open swap: ${solToSwap.toFixed(4)} SOL -> USDC (ratio ${(currentSolRatio*100).toFixed(0)}% SOL vs ideal ${(idealSolRatio*100).toFixed(0)}%)`, timestamp: Date.now() }));
          await this.doSwap(MINTS.SOL, MINTS.USDC, Math.floor(solToSwap * 1e9), `Pre-open: SOL -> USDC to match LP deposit ratio`);
          await new Promise(r => setTimeout(r, 4000));
          solBal = await this.getSolBalance();
          usdcBal = await this.getUsdcBalance();
          solAvailable = Math.max(0, solBal - getSolReserve());
          usdcAvailable = Math.max(0, usdcBal - getUsdcReserve());
        }
      } else if (currentSolRatio < idealSolRatio && usdcAvailable > 10) {
        // Too much USDC — swap to SOL
        const usdcToSwap = Math.min((idealSol - solAvailable) * currentPrice * getSwapBuffer(), usdcAvailable - 2);
        if (usdcToSwap > 1) {
          console.log(JSON.stringify({ level: 'info', msg: `Pre-open swap: ${usdcToSwap.toFixed(2)} USDC -> SOL (ratio ${(currentSolRatio*100).toFixed(0)}% SOL vs ideal ${(idealSolRatio*100).toFixed(0)}%)`, timestamp: Date.now() }));
          await this.doSwap(MINTS.USDC, MINTS.SOL, Math.floor(usdcToSwap * 1e6), `Pre-open: USDC -> SOL to match LP deposit ratio`);
          await new Promise(r => setTimeout(r, 4000));
          solBal = await this.getSolBalance();
          usdcBal = await this.getUsdcBalance();
          solAvailable = Math.max(0, solBal - getSolReserve());
          usdcAvailable = Math.max(0, usdcBal - getUsdcReserve());
        }
      }
    }

    // Cap available capital at usdcToDeposit (regime deploy cap)
    // Without this, the executor ignores the deploy % and deposits everything available.
    const availableValueUsdc = solAvailable * currentPrice + usdcAvailable;
    if (usdcToDeposit > 0 && availableValueUsdc > usdcToDeposit) {
      const capRatio = usdcToDeposit / availableValueUsdc;
      solAvailable = solAvailable * capRatio;
      usdcAvailable = usdcAvailable * capRatio;
      console.log(JSON.stringify({
        level: 'info',
        msg: `Deploy cap applied: available $${availableValueUsdc.toFixed(2)} capped to $${usdcToDeposit.toFixed(2)} (${(capRatio * 100).toFixed(0)}%). SOL: ${solAvailable.toFixed(4)}, USDC: ${usdcAvailable.toFixed(2)}.`,
        timestamp: Date.now(),
      }));
    }

    console.log(JSON.stringify({
      level: 'info',
      msg: `Open position: wallet ${solBal.toFixed(4)} SOL (${solAvailable.toFixed(4)} avail), ${usdcBal.toFixed(2)} USDC (${usdcAvailable.toFixed(2)} avail). Deploy target: $${usdcToDeposit.toFixed(2)}.`,
      timestamp: Date.now(),
    }));

    // Quote with the constraining token — deposit what we can
    // Auto-deploy (Rule 7) will add remaining idle funds within minutes.
    // Reserve 0.02 SOL extra for position account rent + TX fees
    const solForQuote = Math.max(0, solAvailable - 0.02);
    let quote = solForQuote > 0.01 ? increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(solForQuote),
      range.tickLower, range.tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    ) : null;
    let quotedBy = 'SOL';

    if (quote) {
      const usdcNeeded = Number(quote.tokenEstB.toString()) / 1e6;
      if (usdcNeeded > usdcAvailable) {
        // SOL quote needs more USDC than available — try USDC quote instead
        quote = usdcAvailable > 0.5 ? increaseLiquidityQuoteByInputToken(
          usdcMint, new Decimal(usdcAvailable),
          range.tickLower, range.tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        ) : null;
        quotedBy = 'USDC';
        if (quote) {
          const solNeeded = Number(quote.tokenEstA.toString()) / 1e9;
          if (solNeeded > solAvailable) quote = null;
        }
      }
    } else if (usdcAvailable > 0.5) {
      // No SOL available — try USDC-only quote
      quote = increaseLiquidityQuoteByInputToken(
        usdcMint, new Decimal(usdcAvailable),
        range.tickLower, range.tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
      );
      quotedBy = 'USDC';
      if (quote) {
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
      return null;
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
      priceLower: PriceMath.tickIndexToPrice(range.tickLower, SOL_DECIMALS, USDC_DECIMALS).toNumber(),
      priceUpper: PriceMath.tickIndexToPrice(range.tickUpper, SOL_DECIMALS, USDC_DECIMALS).toNumber(),
      entryPrice: currentPrice,
      entryTime: Date.now(),
      regime,
      entrySol: estSol,
      entryUsdc: estUsdc,
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
      getSlippage(),
      this.wallet.publicKey,
      this.wallet.publicKey,
      this.wallet.publicKey,
    );

    for (const txBuilder of txBuilders) {
      await this.execTx(txBuilder);
    }

    // Only clear position state AFTER all TXs succeeded
    this.currentPosition = null;

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

    // Get expected fees via quote BEFORE collecting (balance delta is skewed by gas)
    const pendingFees = await this.getPendingFees();
    const expectedSol = pendingFees?.feeSolDecimal ?? 0;
    const expectedUsdc = pendingFees?.feeUsdcDecimal ?? 0;

    const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
    const tx = await position.collectFees();
    await this.execTx(tx);

    const result = {
      feeSol: expectedSol,
      feeUsdc: expectedUsdc,
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

  /**
   * Convert a percentage of harvested SOL fees to USDC.
   * Called after collectFees() based on regime's harvestSolConvertPct.
   */
  async convertHarvestedSol(solAmount: number, convertPct: number): Promise<{ solSwapped: number; usdcReceived: number } | null> {
    if (convertPct <= 0 || solAmount <= 0.0001) return null;

    const solToSwap = solAmount * convertPct;
    if (solToSwap < 0.0005) return null; // dust threshold

    // Ensure wallet retains enough SOL for gas after conversion
    const solBal = await this.getSolBalance();
    const minSolForGas = getSolReserve() + 0.01; // reserve + gas buffer
    if (solBal - solToSwap < minSolForGas) {
      const maxSwap = Math.max(0, solBal - minSolForGas);
      if (maxSwap < 0.0005) {
        console.log(JSON.stringify({ level: 'info', msg: `Harvest SOL conversion skipped: wallet ${solBal.toFixed(4)} SOL, need ${minSolForGas.toFixed(4)} for gas+reserve`, timestamp: Date.now() }));
        return null;
      }
      console.log(JSON.stringify({ level: 'info', msg: `Harvest SOL conversion capped: ${solToSwap.toFixed(4)} → ${maxSwap.toFixed(4)} SOL (keeping ${minSolForGas.toFixed(4)} for gas)`, timestamp: Date.now() }));
      // Fall through with reduced amount — solToSwap is let-reassigned below
    }

    try {
      const actualSwap = Math.min(solToSwap, Math.max(0, solBal - minSolForGas));
      const solBefore = await this.getSolBalance();
      const usdcBefore = await this.getUsdcBalance();
      const swapResult = await this.doSwap(
        MINTS.SOL, MINTS.USDC, Math.floor(actualSwap * 1e9),
        `Harvest SOL→USDC conversion: ${actualSwap.toFixed(6)} SOL (${(convertPct * 100).toFixed(0)}% of ${solAmount.toFixed(6)} harvested, capped by gas reserve).`,
      );
      if (!swapResult) {
        console.log(JSON.stringify({ level: 'warn', msg: 'Harvest SOL conversion: swap failed (all providers)', timestamp: Date.now() }));
        return null;
      }
      await new Promise(r => setTimeout(r, 4000));
      const solAfter = await this.getSolBalance();
      const usdcAfter = await this.getUsdcBalance();
      const solSwapped = solBefore - solAfter;
      const usdcReceived = usdcAfter - usdcBefore;
      console.log(JSON.stringify({ level: 'info', msg: `Harvest SOL conversion (${swapResult.provider}): ${solSwapped.toFixed(6)} SOL → ${usdcReceived.toFixed(2)} USDC (${(convertPct * 100).toFixed(0)}% of harvested)`, timestamp: Date.now() }));
      if (this.onSwap) this.onSwap({ timestamp: Date.now(), fromToken: 'SOL', toToken: 'USDC', fromAmount: solSwapped, toAmount: usdcReceived, reason: `Harvest SOL→USDC conversion (${swapResult.provider}): ${(convertPct * 100).toFixed(0)}% of ${solAmount.toFixed(6)} SOL harvested fees.` });
      return { solSwapped, usdcReceived };
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `Harvest SOL conversion failed: ${String(err)}`, timestamp: Date.now() }));
      return null;
    }
  }

  async getPositionData(): Promise<{ liquidity: string; feeOwedA: string; feeOwedB: string; tickLower: number; tickUpper: number; priceLower: number; priceUpper: number } | null> {
    if (!this.currentPosition) return null;
    try {
      const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
      const data = position.getData();
      return {
        liquidity: data.liquidity.toString(),
        feeOwedA: data.feeOwedA.toString(),
        feeOwedB: data.feeOwedB.toString(),
        tickLower: data.tickLowerIndex,
        tickUpper: data.tickUpperIndex,
        priceLower: PriceMath.tickIndexToPrice(data.tickLowerIndex, SOL_DECIMALS, USDC_DECIMALS).toNumber(),
        priceUpper: PriceMath.tickIndexToPrice(data.tickUpperIndex, SOL_DECIMALS, USDC_DECIMALS).toNumber(),
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
      const solPrice = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6).toNumber();
      const tickSpacing = poolData.tickSpacing;

      // Fetch tick data directly from TickArrays (not from position cache which can be stale)
      const fetcher = this.client.getFetcher();
      const tickArrayLowerPDAs = TickArrayUtil.getTickArrayPDAs(
        posData.tickLowerIndex, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false,
      );
      const tickArrayUpperPDAs = TickArrayUtil.getTickArrayPDAs(
        posData.tickUpperIndex, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false,
      );
      const tickArrayLower = await fetcher.getTickArray(tickArrayLowerPDAs[0].publicKey, IGNORE_CACHE);
      const tickArrayUpper = await fetcher.getTickArray(tickArrayUpperPDAs[0].publicKey, IGNORE_CACHE);
      if (!tickArrayLower || !tickArrayUpper) return null;

      const lowerTick = TickArrayUtil.getTickFromArray(tickArrayLower, posData.tickLowerIndex, tickSpacing);
      const upperTick = TickArrayUtil.getTickFromArray(tickArrayUpper, posData.tickUpperIndex, tickSpacing);

      // u128 wrapping fee growth arithmetic (matches Solana on-chain program)
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

      const belowA = currentTick >= posData.tickLowerIndex ? loA : wrap(fgGA - loA);
      const belowB = currentTick >= posData.tickLowerIndex ? loB : wrap(fgGB - loB);
      const aboveA = currentTick < posData.tickUpperIndex ? upA : wrap(fgGA - upA);
      const aboveB = currentTick < posData.tickUpperIndex ? upB : wrap(fgGB - upB);

      const insideA = wrap(fgGA - belowA - aboveA);
      const insideB = wrap(fgGB - belowB - aboveB);
      const ckA = BigInt(posData.feeGrowthCheckpointA.toString());
      const ckB = BigInt(posData.feeGrowthCheckpointB.toString());

      const feeA = wrap(insideA - ckA) * liquidity / Q64 + BigInt(posData.feeOwedA.toString());
      const feeB = wrap(insideB - ckB) * liquidity / Q64 + BigInt(posData.feeOwedB.toString());

      const feeSol = Number(feeA) / 1e9;
      const feeUsdc = Number(feeB) / 1e6;
      const feeTotalUsdc = feeSol * solPrice + feeUsdc;

      // Sanity check: if computed fees exceed position value, the fee growth
      // math overflowed — fall back to stored feeOwed (updated after harvests)
      const posComp = await this.getPositionComposition();
      const posValue = posComp?.totalUsdc ?? 0;
      if (posValue > 0 && feeTotalUsdc > posValue) {
        const fallbackSol = Number(posData.feeOwedA.toString()) / 1e9;
        const fallbackUsdc = Number(posData.feeOwedB.toString()) / 1e6;
        return {
          feeSolDecimal: fallbackSol,
          feeUsdcDecimal: fallbackUsdc,
          feeTotalUsdc: fallbackSol * solPrice + fallbackUsdc,
        };
      }

      return { feeSolDecimal: feeSol, feeUsdcDecimal: feeUsdc, feeTotalUsdc };
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'getPendingFees failed', error: String(err), timestamp: Date.now() }));
      return null;
    }
  }

  async getEstimatedYield24h(dailyVolume?: number): Promise<{ dailyFeesUsdc: number; aprPct: number } | null> {
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

      // Fee rate from on-chain data (e.g. 3000 = 0.30%)
      const feeRatePct = poolData.feeRate / 1_000_000;

      // Position's share of pool liquidity at current tick
      const poolLiquidity = poolData.liquidity;
      const posLiquidity = posData.liquidity;
      const liquidityShare = poolLiquidity.isZero() ? 0 : posLiquidity.toNumber() / poolLiquidity.toNumber();

      // Use real daily volume from Orca API if available, fallback to estimate
      const estDailyVolume = dailyVolume ?? 100_000_000;

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

  async getAddLiquidityPreview(currentPrice: number): Promise<{
    solAvailable: number; usdcAvailable: number; totalAvailableUsdc: number;
    estSolDeposit: number; estUsdcDeposit: number; estTotalUsdc: number;
    positionRange: string; needsSwap: string;
  } | null> {
    if (!this.currentPosition) return null;
    const solBal = await this.getSolBalance();
    const usdcBal = await this.getUsdcBalance();
    const solReserve = getSolReserve();
    const usdcReserve = getUsdcReserve();
    const solAvailable = Math.max(0, solBal - solReserve);
    const usdcAvailable = Math.max(0, usdcBal - usdcReserve);
    if (solAvailable < 0.001 && usdcAvailable < 0.5) return null;

    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
    const solMint = new PublicKey(MINTS.SOL);
    const { tickLower, tickUpper } = this.currentPosition;

    const ratioQuote = increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(1), tickLower, tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    );
    const usdcPer1Sol = Number(ratioQuote.tokenEstB.toString()) / 1e6;
    const valuePerSolUnit = currentPrice + usdcPer1Sol;
    const totalAvailableUsdc = solAvailable * currentPrice + usdcAvailable;
    const idealSol = totalAvailableUsdc / valuePerSolUnit;
    const idealUsdc = idealSol * usdcPer1Sol;

    const solDeficit = idealSol - solAvailable;
    const usdcDeficit = idealUsdc - usdcAvailable;
    let needsSwap = 'none';
    if (solDeficit > 0.01) needsSwap = `~$${(solDeficit * currentPrice).toFixed(2)} USDC -> SOL`;
    else if (usdcDeficit > 1) needsSwap = `~${(usdcDeficit / currentPrice).toFixed(4)} SOL -> USDC`;

    return {
      solAvailable, usdcAvailable, totalAvailableUsdc,
      estSolDeposit: idealSol, estUsdcDeposit: idealUsdc,
      estTotalUsdc: idealSol * currentPrice + idealUsdc,
      positionRange: `$${this.currentPosition.priceLower.toFixed(2)}-$${this.currentPosition.priceUpper.toFixed(2)}`,
      needsSwap,
    };
  }

  async increaseLiquidity(currentPrice: number, maxDeployUsdc?: number): Promise<{
    solDeposited: number; usdcDeposited: number; totalUsdc: number; liquidityAdded: string;
  } | null> {
    if (!this.currentPosition) return null;

    const whirlpool = await this.client.getPool(this.whirlpoolAddress, IGNORE_CACHE);
    const solMint = new PublicKey(MINTS.SOL);
    const usdcMint = new PublicKey(MINTS.USDC);
    const solReserve = getSolReserve();
    const usdcReserve = getUsdcReserve();
    const { tickLower, tickUpper } = this.currentPosition;

    let solBal = await this.getSolBalance();
    let usdcBal = await this.getUsdcBalance();
    let solAvailable = Math.max(0, solBal - solReserve);
    let usdcAvailable = Math.max(0, usdcBal - usdcReserve);

    console.log(JSON.stringify({ level: 'info', msg: `Add liquidity: wallet ${solBal.toFixed(4)} SOL (${solAvailable.toFixed(4)} avail), ${usdcBal.toFixed(2)} USDC (${usdcAvailable.toFixed(2)} avail)${maxDeployUsdc ? `, cap: $${maxDeployUsdc.toFixed(2)}` : ''}`, timestamp: Date.now() }));

    // Calculate ideal ratio (same logic as openPosition), capped at maxDeployUsdc if provided
    const ratioQuote = increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(1), tickLower, tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    );
    const usdcPer1Sol = Number(ratioQuote.tokenEstB.toString()) / 1e6;
    const valuePerSolUnit = currentPrice + usdcPer1Sol;
    const totalAvailableUsdc = solAvailable * currentPrice + usdcAvailable;
    const deployTargetUsdc = maxDeployUsdc != null ? Math.min(totalAvailableUsdc, maxDeployUsdc) : totalAvailableUsdc;
    const idealSol = deployTargetUsdc / valuePerSolUnit;
    const idealUsdc = idealSol * usdcPer1Sol;

    const solDeficit = idealSol - solAvailable;
    const usdcDeficit = idealUsdc - usdcAvailable;

    // Swap to match ideal ratio (with P&L awareness)
    if (solDeficit > 0.01) {
      const usdcToSwap = Math.min(solDeficit * currentPrice * getSwapBuffer(), usdcAvailable - 2);
      const buyAllowed = !this.shouldAllowSwap || this.shouldAllowSwap('buy_sol', solDeficit, currentPrice);
      if (usdcToSwap > 1 && !buyAllowed) {
        console.log(JSON.stringify({ level: 'info', msg: `Add liquidity: SKIPPED USDC→SOL swap ($${usdcToSwap.toFixed(0)}) — P&L guard blocked (buying above basis). Deploying with available ratio.`, timestamp: Date.now() }));
      }
      if (usdcToSwap > 1 && buyAllowed) {
        console.log(JSON.stringify({ level: 'info', msg: `Add liquidity swap: ${usdcToSwap.toFixed(2)} USDC -> SOL`, timestamp: Date.now() }));
        const solBeforeSwap = solBal;
        const usdcBeforeSwap = usdcBal;
        await this.doSwap(MINTS.USDC, MINTS.SOL, Math.floor(usdcToSwap * 1e6), `Add liquidity: USDC -> SOL to match position ratio`);
        await new Promise(r => setTimeout(r, 4000));
        solBal = await this.getSolBalance();
        usdcBal = await this.getUsdcBalance();
        solAvailable = Math.max(0, solBal - solReserve);
        usdcAvailable = Math.max(0, usdcBal - usdcReserve);
        const solReceived = solBal - solBeforeSwap;
        const usdcSpent = usdcBeforeSwap - usdcBal;
        if (this.onSwap) this.onSwap({ timestamp: Date.now(), fromToken: 'USDC', toToken: 'SOL', fromAmount: usdcSpent, toAmount: solReceived, reason: `Add liquidity: swapped ${usdcSpent.toFixed(2)} USDC -> ${solReceived.toFixed(4)} SOL to match position ratio` });
      }
    } else if (usdcDeficit > 1) {
      const solToSwap = Math.min(usdcDeficit / currentPrice * getSwapBuffer(), solAvailable - 0.02);
      const sellAllowed = !this.shouldAllowSwap || this.shouldAllowSwap('sell_sol', solToSwap, currentPrice);
      if (solToSwap > 0.005 && !sellAllowed) {
        console.log(JSON.stringify({ level: 'info', msg: `Add liquidity: SKIPPED SOL→USDC swap (${solToSwap.toFixed(2)} SOL) — P&L guard blocked (selling below basis). Deploying with available ratio.`, timestamp: Date.now() }));
      }
      if (solToSwap > 0.005 && sellAllowed) {
        console.log(JSON.stringify({ level: 'info', msg: `Add liquidity swap: ${solToSwap.toFixed(4)} SOL -> USDC`, timestamp: Date.now() }));
        const solBeforeSwap = solBal;
        const usdcBeforeSwap = usdcBal;
        await this.doSwap(MINTS.SOL, MINTS.USDC, Math.floor(solToSwap * 1e9), `Add liquidity: SOL -> USDC to match position ratio`);
        await new Promise(r => setTimeout(r, 4000));
        solBal = await this.getSolBalance();
        usdcBal = await this.getUsdcBalance();
        solAvailable = Math.max(0, solBal - solReserve);
        usdcAvailable = Math.max(0, usdcBal - usdcReserve);
        const usdcReceived = usdcBal - usdcBeforeSwap;
        const solSpent = solBeforeSwap - solBal;
        if (this.onSwap) this.onSwap({ timestamp: Date.now(), fromToken: 'SOL', toToken: 'USDC', fromAmount: solSpent, toAmount: usdcReceived, reason: `Add liquidity: swapped ${solSpent.toFixed(4)} SOL -> ${usdcReceived.toFixed(2)} USDC to match position ratio` });
      }
    }

    // Refresh pool data after swap
    await whirlpool.refreshData();

    // Cap available capital at maxDeployUsdc (same fix as openPosition)
    if (maxDeployUsdc != null) {
      const availValue = solAvailable * currentPrice + usdcAvailable;
      if (availValue > maxDeployUsdc) {
        const capRatio = maxDeployUsdc / availValue;
        solAvailable = solAvailable * capRatio;
        usdcAvailable = usdcAvailable * capRatio;
        console.log(JSON.stringify({ level: 'info', msg: `Add liquidity deploy cap: available $${availValue.toFixed(2)} capped to $${maxDeployUsdc.toFixed(2)} (${(capRatio * 100).toFixed(0)}%)`, timestamp: Date.now() }));
      }
    }

    // Quote with capped balances
    let quote = solAvailable > 0.01 ? increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(solAvailable), tickLower, tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    ) : null;

    if (quote) {
      const usdcNeeded = Number(quote.tokenEstB.toString()) / 1e6;
      if (usdcNeeded > usdcAvailable) {
        quote = usdcAvailable > 0.5 ? increaseLiquidityQuoteByInputToken(
          usdcMint, new Decimal(usdcAvailable), tickLower, tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        ) : null;
        if (quote) {
          const solNeeded = Number(quote.tokenEstA.toString()) / 1e9;
          if (solNeeded > solAvailable) quote = null;
        }
      }
    } else if (usdcAvailable > 0.5) {
      quote = increaseLiquidityQuoteByInputToken(
        usdcMint, new Decimal(usdcAvailable), tickLower, tickUpper, getSlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
      );
      if (quote) {
        const solNeeded = Number(quote.tokenEstA.toString()) / 1e9;
        if (solNeeded > solAvailable) quote = null;
      }
    }

    if (!quote || quote.liquidityAmount.isZero()) {
      console.log(JSON.stringify({ level: 'warn', msg: `Cannot add liquidity: SOL=${solAvailable.toFixed(4)}, USDC=${usdcAvailable.toFixed(2)}. No valid quote.`, timestamp: Date.now() }));
      return null;
    }

    const estSol = Number(quote.tokenEstA.toString()) / 1e9;
    const estUsdc = Number(quote.tokenEstB.toString()) / 1e6;
    console.log(JSON.stringify({ level: 'info', msg: `Add liquidity quote: ${estSol.toFixed(4)} SOL + ${estUsdc.toFixed(2)} USDC = $${(estSol * currentPrice + estUsdc).toFixed(2)}`, timestamp: Date.now() }));

    // Increase liquidity on existing position
    const position = await this.client.getPosition(this.currentPosition.positionAddress, IGNORE_CACHE);
    const tx = await position.increaseLiquidity(quote);
    await this.execTx(tx);

    const liquidityAdded = quote.liquidityAmount.toString();

    // Update entry composition to include the added liquidity
    this.currentPosition.entrySol += estSol;
    this.currentPosition.entryUsdc += estUsdc;

    console.log(JSON.stringify({
      level: 'info', msg: 'liquidity added to position',
      positionMint: this.currentPosition.positionMint.toBase58(),
      solDeposited: estSol.toFixed(6), usdcDeposited: estUsdc.toFixed(6),
      liquidityAdded, timestamp: Date.now(),
    }));

    return { solDeposited: estSol, usdcDeposited: estUsdc, totalUsdc: estSol * currentPrice + estUsdc, liquidityAdded };
  }

  getCurrentPosition(): LivePosition | null {
    return this.currentPosition;
  }

  setCurrentPosition(pos: LivePosition | null): void {
    if (pos) {
      // Preserve entrySol/entryUsdc — only default if truly missing
      if (pos.entrySol == null || pos.entrySol === undefined) pos.entrySol = 0;
      if (pos.entryUsdc == null || pos.entryUsdc === undefined) pos.entryUsdc = 0;
      // Always derive prices from ticks to match on-chain reality
      pos.priceLower = PriceMath.tickIndexToPrice(pos.tickLower, SOL_DECIMALS, USDC_DECIMALS).toNumber();
      pos.priceUpper = PriceMath.tickIndexToPrice(pos.tickUpper, SOL_DECIMALS, USDC_DECIMALS).toNumber();
    }
    this.currentPosition = pos;
  }

  private async getSolBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
    return lamports / 1_000_000_000;
  }

  private async getUsdcBalance(): Promise<number> {
    try {
      const usdcMint = new PublicKey(MINTS.USDC);
      const ata = await getAssociatedTokenAddress(usdcMint, this.wallet.publicKey);
      const account = await getAccount(this.connection, ata, 'confirmed');
      return Number(account.amount) / 1_000_000;
    } catch {
      return 0;
    }
  }
}
