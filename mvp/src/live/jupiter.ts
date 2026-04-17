/**
 * Jupiter V6 API client for token swaps.
 * Uses the Jupiter aggregator for best-price routing across all Solana DEXes.
 */

import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { JUPITER } from '../constants.js';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string }; percent: number }>;
  // Full response passed to swap endpoint
  raw: any;
}

export interface JupiterSwapResult {
  inputAmount: number;   // human-readable (SOL or USDC)
  outputAmount: number;  // human-readable
  inputDecimals: number;
  outputDecimals: number;
  priceImpactPct: number;
  route: string;         // human-readable route summary
  txSignature: string;
  feeLamports: number;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JUPITER.TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get a swap quote from Jupiter V6.
 */
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps: number,
): Promise<JupiterQuote | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: 'false',
  });
  const url = `${JUPITER.QUOTE_API}?${params}`;

  for (let attempt = 0; attempt <= JUPITER.MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < JUPITER.MAX_RETRIES) {
          console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote ${res.status}, retrying in ${JUPITER.RETRY_DELAY_MS}ms`, timestamp: Date.now() }));
          await new Promise(r => setTimeout(r, JUPITER.RETRY_DELAY_MS));
          continue;
        }
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote failed: HTTP ${res.status}`, timestamp: Date.now() }));
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote error: ${res.status} ${body.slice(0, 200)}`, timestamp: Date.now() }));
        return null;
      }
      const data = await res.json();
      const routeSummary = (data.routePlan ?? [])
        .map((r: any) => `${r.swapInfo?.label ?? '?'}(${r.percent}%)`)
        .join(' → ');
      return {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        priceImpactPct: data.priceImpactPct ?? '0',
        routePlan: data.routePlan ?? [],
        raw: data,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote timeout (${JUPITER.TIMEOUT_MS}ms)`, timestamp: Date.now() }));
      } else if (attempt < JUPITER.MAX_RETRIES) {
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote error: ${String(err).slice(0, 100)}, retrying...`, timestamp: Date.now() }));
        await new Promise(r => setTimeout(r, JUPITER.RETRY_DELAY_MS));
        continue;
      } else {
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter quote failed: ${String(err).slice(0, 100)}`, timestamp: Date.now() }));
      }
      return null;
    }
  }
  return null;
}

/**
 * Build, sign, send, and confirm a Jupiter swap transaction.
 */
export async function executeJupiterSwap(
  connection: Connection,
  payer: Keypair,
  quote: JupiterQuote,
  inputDecimals: number,
  outputDecimals: number,
): Promise<JupiterSwapResult | null> {
  // 1. Get serialized transaction from Jupiter
  let swapTxBase64: string;
  try {
    const res = await fetchWithTimeout(JUPITER.SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: payer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(JSON.stringify({ level: 'warn', msg: `Jupiter swap API error: ${res.status} ${body.slice(0, 200)}`, timestamp: Date.now() }));
      return null;
    }
    const data = await res.json();
    swapTxBase64 = data.swapTransaction;
    if (!swapTxBase64) {
      console.log(JSON.stringify({ level: 'warn', msg: 'Jupiter swap API returned no transaction', timestamp: Date.now() }));
      return null;
    }
  } catch (err: any) {
    console.log(JSON.stringify({ level: 'warn', msg: `Jupiter swap TX build failed: ${String(err).slice(0, 100)}`, timestamp: Date.now() }));
    return null;
  }

  // 2. Deserialize, sign, send
  try {
    const txBuf = Buffer.from(swapTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([payer]);

    const sig = await connection.sendTransaction(tx, {
      maxRetries: 2,
      skipPreflight: false,
    });

    console.log(JSON.stringify({ level: 'info', msg: `Jupiter swap sent: ${sig.slice(0, 16)}...`, timestamp: Date.now() }));

    // 3. Confirm. If confirmTransaction throws (RPC timeout), DON'T return null yet —
    // the tx may have already landed on-chain. Falling back to Orca here would execute
    // a duplicate swap. Poll signature status before declaring failure.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    let confirmed = false;
    try {
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      confirmed = true;
    } catch (confirmErr) {
      // Poll getSignatureStatus for up to ~30s before deciding Jupiter truly failed.
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
          const val = st?.value;
          if (val && (val.confirmationStatus === 'confirmed' || val.confirmationStatus === 'finalized') && !val.err) {
            confirmed = true;
            break;
          }
          if (val?.err) {
            console.log(JSON.stringify({ level: 'warn', msg: `Jupiter tx ${sig.slice(0, 16)} on-chain error: ${JSON.stringify(val.err).slice(0, 120)}`, timestamp: Date.now() }));
            return null;
          }
        } catch { /* keep polling */ }
      }
      if (!confirmed) {
        console.log(JSON.stringify({ level: 'warn', msg: `Jupiter confirm timed out for ${sig.slice(0, 16)} — treating as landed to avoid duplicate fallback swap. ${String(confirmErr).slice(0, 80)}`, timestamp: Date.now() }));
        confirmed = true; // assume landed — safer than a duplicate Orca swap
      }
    }

    // 4. Get fee from transaction meta
    let feeLamports = 10000; // conservative fallback
    try {
      await new Promise(r => setTimeout(r, 1500));
      const txData = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (txData?.meta?.fee) feeLamports = txData.meta.fee;
    } catch { /* use fallback */ }

    const routeSummary = (quote.routePlan ?? [])
      .map((r: any) => `${r.swapInfo?.label ?? '?'}(${r.percent}%)`)
      .join(' → ');

    return {
      inputAmount: Number(quote.inAmount) / (10 ** inputDecimals),
      outputAmount: Number(quote.outAmount) / (10 ** outputDecimals),
      inputDecimals,
      outputDecimals,
      priceImpactPct: parseFloat(quote.priceImpactPct) || 0,
      route: routeSummary || 'direct',
      txSignature: sig,
      feeLamports,
    };
  } catch (err: any) {
    console.log(JSON.stringify({ level: 'warn', msg: `Jupiter swap TX failed: ${String(err).slice(0, 150)}`, timestamp: Date.now() }));
    return null;
  }
}
