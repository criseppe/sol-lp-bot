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
import { alertFloorCheckBlocked, alertShadowSell } from '../output/telegram.js';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
// Orca LP slippage (open/close/increaseLiquidity/decreaseLiquidity quotes). Jupiter swaps use
// runtime.swapSlippageBps directly (as bps integer) in the executeSwap path (line 162).
function getLiquiditySlippage(): Percentage { return Percentage.fromFraction(runtime.liquiditySlippageBps ?? 100, 10000); }
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
  txSignature?: string;
  feeLamports?: number;
  priceImpactPct?: number;
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
  public getReserveFloor: (() => number) | null = null;
  public getProximityDeployThreshold: (() => number) | null = null;
  public getCurrentRegime: (() => string) | null = null;
  public getCostBasis: (() => number) | null = null;
  public isPostUpsideOpen = false;
  public cumGasLamports = 0;
  public txCount = 0;

  getGasStats(solPrice: number): { gasSol: number; gasUsdc: number; txCount: number } {
    const gasSol = this.cumGasLamports / 1_000_000_000;
    return { gasSol, gasUsdc: gasSol * solPrice, txCount: this.txCount };
  }

  private buildExecOptions(): { computeBudgetOption: { type: 'none' } | { type: 'fixed'; priorityFeeLamports: number; computeBudgetLimit?: number } } {
    const priorityFeeLamports = runtime.priorityFeeLamports ?? 0;
    const computeBudgetLimit = runtime.computeBudgetLimit ?? 0;
    if (priorityFeeLamports > 0) {
      return computeBudgetLimit > 0
        ? { computeBudgetOption: { type: 'fixed', priorityFeeLamports, computeBudgetLimit } }
        : { computeBudgetOption: { type: 'fixed', priorityFeeLamports } };
    }
    return { computeBudgetOption: { type: 'none' } };
  }

  private buildSendOptions(): { skipPreflight: boolean; maxRetries: number; preflightCommitment: 'confirmed' } {
    return { skipPreflight: runtime.skipPreflight ?? false, maxRetries: 3, preflightCommitment: 'confirmed' };
  }

  private async execTx(txBuilder: { buildAndExecute: (options?: any, sendOptions?: any) => Promise<string> }): Promise<string> {
    const isTransientExpiry = (msg: string): boolean =>
      msg.includes('Blockhash not found') ||
      msg.includes('timeout') ||
      msg.includes('429') ||
      msg.includes('block height exceeded') ||
      msg.includes('TransactionExpiredBlockheight') ||
      msg.includes('BlockheightBasedTxnExpired') ||
      msg.includes('Transaction was not confirmed');

    let sig!: string;
    try {
      sig = await txBuilder.buildAndExecute(this.buildExecOptions(), this.buildSendOptions());
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Retry up to 2x on transient errors. Orca TransactionBuilder.buildAndExecute()
      // fetches a fresh blockhash each call, so retry = fresh blockhash window.
      if (isTransientExpiry(msg)) {
        let lastErr = err;
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          console.log(JSON.stringify({ level: 'warn', msg: `TX failed (${msg.slice(0, 100)}), retry ${attempt}/2 in 3s (fresh blockhash)...`, timestamp: Date.now() }));
          await new Promise(r => setTimeout(r, 3000));
          try {
            sig = await txBuilder.buildAndExecute(this.buildExecOptions(), this.buildSendOptions());
            ok = true;
          } catch (retryErr: any) {
            lastErr = retryErr;
            const retryMsg = String(retryErr?.message ?? retryErr);
            if (!isTransientExpiry(retryMsg)) throw retryErr;
          }
        }
        if (!ok) throw lastErr;
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
          txSignature: result.txSignature,
          feeLamports: result.feeLamports,
          priceImpactPct: result.priceImpactPct,
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
      const currentTick = poolData.tickCurrentIndex;
      // Check all 3 tick arrays: lower bound, upper bound, AND current tick
      const ticksToCheck = [range.tickLower, range.tickUpper, currentTick];
      const allPDAs = ticksToCheck.map(t => TickArrayUtil.getTickArrayPDAs(t, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false));
      const allArrays = await Promise.all(allPDAs.map(p => fetcher.getTickArray(p[0].publicKey, IGNORE_CACHE)));
      const missing = allArrays.map((a, i) => !a ? ticksToCheck[i] : null).filter(Boolean);
      if (missing.length > 0) {
        console.log(JSON.stringify({ level: 'warn', msg: `Tick arrays missing for ticks: [${missing.join(',')}]. Initializing + waiting 5s...`, timestamp: Date.now() }));
        // Init all 3 ticks (lower, upper, current)
        const retryInit = await whirlpool.initTickArrayForTicks(ticksToCheck);
        if (retryInit) {
          try { await this.execTx(retryInit); } catch {}
          await new Promise(r => setTimeout(r, 5000));
        }
      } else {
        console.log(JSON.stringify({ level: 'info', msg: 'Tick arrays validated ✅ (lower + upper + current)', timestamp: Date.now() }));
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

    // Pre-open swap: find the ideal SOL/USDC ratio for the LP deposit using the FULL
    // capital to deploy, then swap only the difference between current wallet and ideal.
    // Key insight: simulate with a reference amount to get the ratio, then scale to full capital.
    {
      // Get the LP deposit ratio: how much USDC per 1 SOL at this tick range
      const ratioQuote = increaseLiquidityQuoteByInputToken(
        solMint, new Decimal(1), range.tickLower, range.tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
      );
      const usdcPer1Sol = Number(ratioQuote.tokenEstB.toString()) / 1e6;

      // Calculate ideal amounts for the full capital we want to deploy
      const totalVal = solAvailable * currentPrice + usdcAvailable;
      const deployTarget = usdcToDeposit > 0 ? Math.min(totalVal, usdcToDeposit) : totalVal;

      // idealSol * currentPrice + idealSol * usdcPer1Sol = deployTarget
      const idealSol = deployTarget / (currentPrice + usdcPer1Sol);
      const idealUsdc = idealSol * usdcPer1Sol;

      const solDeficit = idealSol - solAvailable; // positive = need more SOL
      const usdcDeficit = idealUsdc - usdcAvailable; // positive = need more USDC

      console.log(JSON.stringify({
        level: 'info',
        msg: `Pre-open calc: wallet ${solAvailable.toFixed(4)} SOL ($${(solAvailable*currentPrice).toFixed(0)}) + $${usdcAvailable.toFixed(0)} USDC. Ideal for $${deployTarget.toFixed(0)} deposit: ${idealSol.toFixed(4)} SOL + $${idealUsdc.toFixed(0)} USDC. Deficit: ${solDeficit.toFixed(4)} SOL / $${usdcDeficit.toFixed(0)} USDC`,
        timestamp: Date.now(),
      }));

      // RULE: NEVER sell SOL in pre-open swap. Selling SOL after position close is the #1
      // source of losses (-$20+ per day). The LP quote handles excess SOL by depositing
      // with SOL as the constraining token. Remaining SOL stays idle — no round-trips.
      // Only buy SOL if wallet is heavily USDC and needs SOL for a balanced deposit.
      const deviationPct = deployTarget > 0 ? Math.abs(solDeficit * currentPrice) / deployTarget : 0;

      if (solDeficit > 0.5 && solDeficit * currentPrice > 50 && deviationPct > 0.20) {
        // Post-upside basis-cap guard: skip the pre-open SOL buy when price is too far above
        // weighted-avg cost basis. Buying large SOL deltas at a premium ratchets basis up,
        // which then causes BasisGate to block subsequent re-opens on minor pullbacks.
        // Position opens SOL-constrained instead; auto-deploy + idle rebalance fill it gradually.
        const basisForCap = this.getCostBasis ? this.getCostBasis() : 0;
        const maxBuyAboveBasis = runtime.postUpsideMaxBuyAboveBasis ?? 0.02;
        const strictMaxBuyAboveBasis = runtime.preOpenMaxBuyAboveBasis ?? 0.005;
        const strictBasisCap = basisForCap * (1 + strictMaxBuyAboveBasis);
        const postUpsideCap = basisForCap * (1 + maxBuyAboveBasis);
        // Strict cap: applies to ALL opens (not just post-upside). Prevents basis ratchet on high-price reopens.
        if (basisForCap > 0 && currentPrice > strictBasisCap) {
          console.log(JSON.stringify({ level: 'info', msg: `[PreOpen] SOL buy blocked — price $${currentPrice.toFixed(2)} > strict basis cap $${strictBasisCap.toFixed(2)} (basis $${basisForCap.toFixed(2)} + ${(strictMaxBuyAboveBasis * 100).toFixed(1)}%). Opening SOL-constrained to protect cost basis.`, timestamp: Date.now() }));
          // Fall through to deposit with available SOL/USDC — do NOT enter the buy/skip-by-floor branch.
        } else if (this.isPostUpsideOpen && basisForCap > 0 && currentPrice > postUpsideCap) {
          console.log(JSON.stringify({ level: 'info', msg: `[PreOpen] Post-upside SOL buy skipped — price $${currentPrice.toFixed(2)} > basis cap $${postUpsideCap.toFixed(2)} (basis $${basisForCap.toFixed(2)} × ${(1 + maxBuyAboveBasis).toFixed(3)}). Opening SOL-constrained to protect cost basis.`, timestamp: Date.now() }));
          // Fall through to deposit with available SOL/USDC — do NOT enter the buy/skip-by-floor branch.
        } else {
        // Need more SOL — buy with USDC. Partial-buy: swap as much as the floor allows
        // instead of all-or-nothing. Post-upside relaxes floor (default 50%) for fuller deployment.
        const reserveFloorBuy = this.getReserveFloor ? this.getReserveFloor() : 0;
        const floorMultiplier = this.isPostUpsideOpen ? runtime.postUpsideFloorMultiplier : 1.0;
        const effectiveFloor = reserveFloorBuy * floorMultiplier;
        const fullSwapUsdc = solDeficit * currentPrice * 0.95;
        const usdcAvailableForSwap = Math.max(0, usdcBal - idealUsdc - effectiveFloor);
        const hardCap = Math.max(0, usdcAvailable - 2);
        const usdcToSwap = Math.min(fullSwapUsdc, usdcAvailableForSwap, hardCap);

        if (usdcToSwap < 50) {
          console.log(JSON.stringify({ level: 'warn', msg: `[PreOpen] Insufficient USDC above floor for SOL buy: wallet $${usdcBal.toFixed(0)} − idealUsdc $${idealUsdc.toFixed(0)} − floor $${effectiveFloor.toFixed(0)} = $${usdcAvailableForSwap.toFixed(0)} (need ≥$50). Depositing with available ratio instead.`, timestamp: Date.now() }));
          alertFloorCheckBlocked({ usdcRemaining: usdcAvailableForSwap, floor: effectiveFloor, regime: this.getCurrentRegime?.() ?? 'UNKNOWN', price: currentPrice });
        } else {
          const solToBuy = usdcToSwap / currentPrice;
          const isPartial = usdcToSwap < fullSwapUsdc - 0.01;
          const usdcAfterBuy = usdcBal - usdcToSwap - idealUsdc;
          const floorLabel = this.isPostUpsideOpen ? `relaxed floor $${effectiveFloor.toFixed(0)}` : `floor $${reserveFloorBuy.toFixed(0)}`;
          const modeLabel = this.isPostUpsideOpen ? ' (post-upside relaxed floor)' : '';
          console.log(JSON.stringify({ level: 'info', msg: `[PreOpen] SOL buy: ${isPartial ? 'PARTIAL' : 'FULL'} — ${solToBuy.toFixed(3)} SOL ($${usdcToSwap.toFixed(2)})${modeLabel}. Ideal deficit: ${solDeficit.toFixed(2)} SOL ($${fullSwapUsdc.toFixed(0)}). USDC after: $${usdcAfterBuy.toFixed(0)} (${floorLabel}).`, timestamp: Date.now() }));
          await this.doSwap(MINTS.USDC, MINTS.SOL, Math.floor(usdcToSwap * 1e6), `Pre-open: ${isPartial ? 'partial' : 'full'} USDC -> SOL (${solToBuy.toFixed(2)} SOL of ${solDeficit.toFixed(2)} needed)`);
          await new Promise(r => setTimeout(r, 4000));
          solBal = await this.getSolBalance();
          usdcBal = await this.getUsdcBalance();
          solAvailable = Math.max(0, solBal - getSolReserve());
          usdcAvailable = Math.max(0, usdcBal - getUsdcReserve());
        }
        } // end else (basis cap not exceeded)
      } else if (solDeficit < 0) {
        // SOL-heavy wallet — never sell SOL. Deposit SOL-constrained, respect reserve floor.
        const reserveFloor = this.getReserveFloor ? this.getReserveFloor() : 0;
        const availableUsdc = Math.max(0, usdcAvailable - reserveFloor);
        console.log(JSON.stringify({ level: 'info', msg: `[PreOpen] SOL-heavy wallet — depositing SOL-constrained. Wallet USDC: $${usdcAvailable.toFixed(2)}, Reserve floor: $${reserveFloor.toFixed(2)}, Available for deposit: $${availableUsdc.toFixed(2)}`, timestamp: Date.now() }));
        // Shadow sell alert: would selling excess SOL be profitable?
        const excessSol = Math.abs(solDeficit);
        const basis = this.getCostBasis?.() ?? 0;
        if (basis > 0 && currentPrice > basis) {
          const marginPct = ((currentPrice / basis) - 1) * 100;
          alertShadowSell({ solAmount: excessSol, usdcValue: excessSol * currentPrice, price: currentPrice, marginPct, basis, regime: this.getCurrentRegime?.() ?? 'UNKNOWN' });
        }
        usdcAvailable = availableUsdc;
      } else {
        console.log(JSON.stringify({ level: 'info', msg: `Pre-open: no swap needed (deviation ${(deviationPct*100).toFixed(0)}%)`, timestamp: Date.now() }));
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
    // Reserve SOL for position account rent + TX fees (0.02 rent + 0.03 gas buffer)
    const solForQuote = Math.max(0, solAvailable - 0.05);
    let quote = solForQuote > 0.01 ? increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(solForQuote),
      range.tickLower, range.tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    ) : null;
    let quotedBy = 'SOL';

    if (quote) {
      const usdcNeeded = Number(quote.tokenEstB.toString()) / 1e6;
      if (usdcNeeded > usdcAvailable) {
        // SOL quote needs more USDC than available — try USDC quote instead
        quote = usdcAvailable > 0.5 ? increaseLiquidityQuoteByInputToken(
          usdcMint, new Decimal(usdcAvailable),
          range.tickLower, range.tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
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
        range.tickLower, range.tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
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

    // 2. Compute IL as (LP value at close) − (HODL counterfactual value at close).
    // HODL uses cumulative deposited SOL+USDC across initial open and any
    // increaseLiquidity additions (entrySol/entryUsdc are accumulated in
    // openPosition and increaseLiquidity). Replaces the V2 full-range formula
    // which severely underestimates IL for concentrated-liquidity positions.
    const entryPrice = this.currentPosition.entryPrice;
    let ilAtClose = 0;
    {
      const posComp = await this.getPositionComposition();
      const lpValue = posComp?.totalUsdc ?? 0;
      const hodlValue = this.currentPosition.entrySol * currentPrice + this.currentPosition.entryUsdc;
      if (hodlValue > 0) {
        ilAtClose = lpValue - hodlValue;
      }
    }

    // 3. Capture position info before it's cleared
    const posInfo = {
      positionMint: this.currentPosition.positionMint.toBase58(),
      priceLower: this.currentPosition.priceLower,
      priceUpper: this.currentPosition.priceUpper,
    };

    // 4. Validate tick arrays before close (same 0x1781/0x1782 issue as open)
    try {
      const tickSpacing = poolData.tickSpacing;
      const currentTick = poolData.tickCurrentIndex;
      const ticksToCheck = [this.currentPosition.tickLower, this.currentPosition.tickUpper, currentTick];
      const initTx = await whirlpool.initTickArrayForTicks(ticksToCheck);
      if (initTx) {
        console.log(JSON.stringify({ level: 'info', msg: 'Close: initializing tick arrays', timestamp: Date.now() }));
        try { await this.execTx(initTx); } catch {}
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch {}

    // 5. Close on-chain
    const solBefore = await this.getSolBalance();
    const usdcBefore = await this.getUsdcBalance();

    const txBuilders = await whirlpool.closePosition(
      this.currentPosition.positionAddress,
      getLiquiditySlippage(),
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
   * NOTE: This converts LP fee income (zero cost basis).
   * shouldAllowSwap is intentionally NOT called here —
   * fee SOL sells are always profitable regardless of price vs basis.
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
      // onSwap already fired by doSwap (executor.ts:139) — no second call here, prevents duplicate swap_ledger row + double basis update.
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
      solMint, new Decimal(1), tickLower, tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
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

    // Validate tick arrays exist before add-liquidity — avoids 0x1781 simulation failures
    try {
      const poolData = whirlpool.getData();
      const tickSpacing = poolData.tickSpacing;
      const fetcher = this.client.getFetcher();
      const currentTick = poolData.tickCurrentIndex;
      const ticksToCheck = [tickLower, tickUpper, currentTick];
      const allPDAs = ticksToCheck.map(t => TickArrayUtil.getTickArrayPDAs(t, tickSpacing, 1, ORCA_WHIRLPOOL_PROGRAM_ID, this.whirlpoolAddress, false));
      const allArrays = await Promise.all(allPDAs.map(p => fetcher.getTickArray(p[0].publicKey, IGNORE_CACHE)));
      const missing = allArrays.map((a, i) => !a ? ticksToCheck[i] : null).filter(Boolean);
      if (missing.length > 0) {
        console.log(JSON.stringify({ level: 'warn', msg: `[AutoDeploy] Tick arrays missing for ticks: [${missing.join(',')}]. Initializing + waiting 5s...`, timestamp: Date.now() }));
        const retryInit = await whirlpool.initTickArrayForTicks(ticksToCheck);
        if (retryInit) {
          try { await this.execTx(retryInit); } catch {}
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: `[AutoDeploy] Tick array validation failed: ${err instanceof Error ? err.message : String(err)}. Proceeding anyway.`, timestamp: Date.now() }));
    }

    let solBal = await this.getSolBalance();
    let usdcBal = await this.getUsdcBalance();
    let solAvailable = Math.max(0, solBal - solReserve);
    let usdcAvailable = Math.max(0, usdcBal - usdcReserve);

    // Reserve-aware idle capital check — match rules.ts formula: idle = SOL value + USDC above floor.
    // Why: rules.ts greenlights deploy based on total idle (SOL+USDC); executor must use the same
    // measure or dashboard "idle capital" disagrees with what auto-deploy actually evaluates.
    const reserveFloor = this.getReserveFloor ? this.getReserveFloor() : 0;
    const idleUsdcRaw = Math.max(0, usdcBal - reserveFloor);
    const idleUsdc = solAvailable * currentPrice + idleUsdcRaw;
    if (idleUsdc < 100) {
      console.log(JSON.stringify({ level: 'info', msg: `[AutoDeploy] Skipped — insufficient idle capital. Wallet USDC: $${usdcBal.toFixed(2)}, Floor: $${reserveFloor.toFixed(2)}, USDC above floor: $${idleUsdcRaw.toFixed(2)}, SOL value: $${(solAvailable * currentPrice).toFixed(2)}, Total idle: $${idleUsdc.toFixed(2)}`, timestamp: Date.now() }));
      return null;
    }
    // Cap usdcAvailable at USDC-only above floor (SOL portion is handled via solAvailable separately)
    usdcAvailable = Math.min(usdcAvailable, idleUsdcRaw);

    // Proximity guard — don't deploy capital near range edges (about to exit).
    // Formula B (centre-relative): proxB = max(0, (centre - price) / halfWidth).
    // = 0 when price >= centre (upper half of range is fine to deploy)
    // = 1 at lower bound (exit-trigger territory)
    // Threshold comes from regime params (proximityDeployThreshold) and is set below
    // each regime's exit trigger (proxThresholdLower) so deploy stops before exit fires.
    const { priceLower, priceUpper } = this.currentPosition;
    const positionRange = priceUpper - priceLower;
    if (positionRange > 0) {
      const centre = (priceLower + priceUpper) / 2;
      const halfWidth = positionRange / 2;
      const proxB = Math.max(0, (centre - currentPrice) / halfWidth);
      const proxThreshold = this.getProximityDeployThreshold ? this.getProximityDeployThreshold() : 0.55;
      if (proxB > proxThreshold) {
        console.log(JSON.stringify({ level: 'info', msg: `[AutoDeploy] Skipped — too close to lower boundary. Proximity: ${(proxB * 100).toFixed(1)}% (threshold ${(proxThreshold * 100).toFixed(0)}%). Price $${currentPrice.toFixed(2)}, lower $${priceLower.toFixed(2)}`, timestamp: Date.now() }));
        return null;
      }
      const proximityToUpper = (currentPrice - priceLower) / positionRange;
      if (proximityToUpper > 0.85) {
        console.log(JSON.stringify({ level: 'info', msg: `[AutoDeploy] Skipped — too close to upper boundary. Proximity: ${(proximityToUpper * 100).toFixed(1)}% (threshold 85%). Price $${currentPrice.toFixed(2)}, upper $${priceUpper.toFixed(2)}`, timestamp: Date.now() }));
        return null;
      }
    }

    console.log(JSON.stringify({ level: 'info', msg: `Add liquidity: wallet ${solBal.toFixed(4)} SOL (${solAvailable.toFixed(4)} avail), ${usdcBal.toFixed(2)} USDC ($${idleUsdcRaw.toFixed(2)} above floor), total idle $${idleUsdc.toFixed(2)}${maxDeployUsdc ? `, cap: $${maxDeployUsdc.toFixed(2)}` : ''}`, timestamp: Date.now() }));

    // Calculate ideal ratio (same logic as openPosition), capped at maxDeployUsdc if provided
    const ratioQuote = increaseLiquidityQuoteByInputToken(
      solMint, new Decimal(1), tickLower, tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
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
        // onSwap already fired by doSwap (executor.ts:139) — no second call here, prevents duplicate swap_ledger row + double basis update.
      }
    } else if (usdcDeficit > 1) {
      // SOL-heavy — never sell SOL in auto-deploy. Deposit SOL-constrained.
      console.log(JSON.stringify({ level: 'info', msg: `[AutoDeploy] SOL-heavy — depositing SOL-constrained (need $${usdcDeficit.toFixed(2)} more USDC, not selling SOL).`, timestamp: Date.now() }));
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
      solMint, new Decimal(solAvailable), tickLower, tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
    ) : null;

    if (quote) {
      const usdcNeeded = Number(quote.tokenEstB.toString()) / 1e6;
      if (usdcNeeded > usdcAvailable) {
        quote = usdcAvailable > 0.5 ? increaseLiquidityQuoteByInputToken(
          usdcMint, new Decimal(usdcAvailable), tickLower, tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        ) : null;
        if (quote) {
          const solNeeded = Number(quote.tokenEstA.toString()) / 1e9;
          if (solNeeded > solAvailable) quote = null;
        }
      }
    } else if (usdcAvailable > 0.5) {
      quote = increaseLiquidityQuoteByInputToken(
        usdcMint, new Decimal(usdcAvailable), tickLower, tickUpper, getLiquiditySlippage(), whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
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
