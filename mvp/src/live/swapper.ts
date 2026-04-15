/**
 * Swap abstraction layer — tries Jupiter first, falls back to Orca.
 * Configured via runtime.swapProvider: 'jupiter' | 'orca' | 'jupiter-fallback'.
 */

import { Connection, type Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ORCA_WHIRLPOOL_PROGRAM_ID, type Whirlpool } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { getJupiterQuote, executeJupiterSwap } from './jupiter.js';
import { runtime } from '../config.js';
import { MINTS } from '../constants.js';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amountRaw: number;       // smallest units (lamports or micro-USDC)
  slippageBps: number;
  reason: string;
}

export interface SwapResult {
  inputAmount: number;     // human-readable
  outputAmount: number;    // human-readable
  provider: 'jupiter' | 'orca';
  priceImpactPct?: number;
  route?: string;
  feeLamports: number;
  txSignature?: string;
}

interface OrcaContext {
  whirlpool: Whirlpool;
  fetcher: any;
  execTx: (txBuilder: { buildAndExecute: () => Promise<string> }) => Promise<string>;
}

function getDecimals(mint: string): number {
  if (mint === MINTS.SOL) return SOL_DECIMALS;
  if (mint === MINTS.USDC) return USDC_DECIMALS;
  return 9; // default
}

async function swapViaJupiter(
  connection: Connection,
  payer: Keypair,
  params: SwapParams,
): Promise<SwapResult | null> {
  const quote = await getJupiterQuote(
    params.inputMint, params.outputMint, params.amountRaw, params.slippageBps,
  );
  if (!quote) return null;

  const inputDec = getDecimals(params.inputMint);
  const outputDec = getDecimals(params.outputMint);
  const result = await executeJupiterSwap(connection, payer, quote, inputDec, outputDec);
  if (!result) return null;

  console.log(JSON.stringify({
    level: 'info',
    msg: `Jupiter swap: ${result.inputAmount.toFixed(6)} ${params.inputMint === MINTS.SOL ? 'SOL' : 'USDC'} → ${result.outputAmount.toFixed(6)} ${params.outputMint === MINTS.SOL ? 'SOL' : 'USDC'} | route: ${result.route} | impact: ${result.priceImpactPct.toFixed(4)}% | reason: ${params.reason}`,
    timestamp: Date.now(),
  }));

  return {
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    provider: 'jupiter',
    priceImpactPct: result.priceImpactPct,
    route: result.route,
    feeLamports: result.feeLamports,
    txSignature: result.txSignature,
  };
}

async function swapViaOrca(
  params: SwapParams,
  orca: OrcaContext,
): Promise<SwapResult | null> {
  try {
    const { swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
    const slippage = Percentage.fromFraction(params.slippageBps, 10000);
    const inputMint = new PublicKey(params.inputMint);
    const swapQuote = await swapQuoteByInputToken(
      orca.whirlpool, inputMint, new BN(params.amountRaw),
      slippage, ORCA_WHIRLPOOL_PROGRAM_ID, orca.fetcher,
    );
    const swapTx = await orca.whirlpool.swap(swapQuote);
    await orca.execTx(swapTx);

    const inputDec = getDecimals(params.inputMint);
    const outputDec = getDecimals(params.outputMint);
    const inAmt = Number(swapQuote.estimatedAmountIn.toString()) / (10 ** inputDec);
    const outAmt = Number(swapQuote.estimatedAmountOut.toString()) / (10 ** outputDec);

    console.log(JSON.stringify({
      level: 'info',
      msg: `Orca swap: ${inAmt.toFixed(6)} ${params.inputMint === MINTS.SOL ? 'SOL' : 'USDC'} → ${outAmt.toFixed(6)} ${params.outputMint === MINTS.SOL ? 'SOL' : 'USDC'} | reason: ${params.reason}`,
      timestamp: Date.now(),
    }));

    return {
      inputAmount: inAmt,
      outputAmount: outAmt,
      provider: 'orca',
      feeLamports: 0, // tracked by execTx
    };
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: `Orca swap failed: ${String(err).slice(0, 150)}`, timestamp: Date.now() }));
    return null;
  }
}

/**
 * Execute a swap using the configured provider strategy.
 */
export async function executeSwap(
  connection: Connection,
  payer: Keypair,
  params: SwapParams,
  orca: OrcaContext,
): Promise<SwapResult | null> {
  const provider = runtime.swapProvider;

  if (provider === 'orca') {
    return swapViaOrca(params, orca);
  }

  if (provider === 'jupiter') {
    return swapViaJupiter(connection, payer, params);
  }

  // jupiter-fallback: try Jupiter first, fall back to Orca
  const jupResult = await swapViaJupiter(connection, payer, params);
  if (jupResult) return jupResult;

  console.log(JSON.stringify({ level: 'warn', msg: 'Jupiter swap failed, falling back to Orca', timestamp: Date.now() }));
  return swapViaOrca(params, orca);
}
