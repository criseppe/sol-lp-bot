import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { MINTS } from '../constants.js';
import bs58 from 'bs58';

export function loadWallet(privateKeyBase58: string): Wallet {
  // NOTE: do NOT zero the decoded buffer — @solana/web3.js Keypair.fromSecretKey stores the
  // SAME Uint8Array reference internally. Zeroing it corrupts the Keypair's signing key and
  // every sign() call produces an invalid ed25519 signature (Solana rejects with
  // "Transaction did not pass signature verification"). Previous L5 "zero key buffer after
  // keypair creation" attempt caused this exact failure (commit 6bda86f, 2026-04-18).
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return new Wallet(keypair);
}

export async function getWalletBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<{ sol: number; usdc: number; totalUsdc: number; solPrice: number }> {
  const usdcMint = new PublicKey(MINTS.USDC);
  const ata = await getAssociatedTokenAddress(usdcMint, owner);

  // Fetch SOL and USDC balances in parallel
  const [lamports, usdc] = await Promise.all([
    connection.getBalance(owner),
    getAccount(connection, ata)
      .then(account => Number(account.amount) / 1_000_000)
      .catch(() => 0), // ATA doesn't exist = 0 USDC
  ]);

  return { sol: lamports / LAMPORTS_PER_SOL, usdc, totalUsdc: 0, solPrice: 0 };
}

export interface WalletValidationResult {
  ok: boolean;
  paused: boolean;
  pauseReason?: string;
  overCap: boolean;
  walletEquityUsd: number;
}

export function validateWalletForLive(
  sol: number,
  usdc: number,
  maxCapitalUsdc: number,
  solPrice = 150,
  pauseThresholdUsdc = 100,
): WalletValidationResult {
  const estimatedTotal = sol * solPrice + usdc;

  // Hard refusal: insufficient SOL for fees. Without this the bot can't even
  // sign transactions, so pause is meaningless — abort.
  if (sol < 0.01) {
    throw new Error('Insufficient SOL for transaction fees (need at least 0.01 SOL).');
  }

  // Phase 19: over-cap is no longer fatal. The bot operates with
  // min(walletEquity, maxCap); excess sits in the wallet untouched.
  const overCap = estimatedTotal > maxCapitalUsdc;
  if (overCap) {
    console.log(JSON.stringify({
      level: 'info',
      msg: `[Wallet] Balance ~$${estimatedTotal.toFixed(0)} exceeds cap $${maxCapitalUsdc}. Operating on $${maxCapitalUsdc}; excess $${(estimatedTotal - maxCapitalUsdc).toFixed(0)} held idle.`,
      timestamp: Date.now(),
    }));
  }

  // Phase 19: below pauseThreshold, bot pauses gracefully (no ops) rather
  // than crashing or operating at unsafe dust amounts.
  if (estimatedTotal < pauseThresholdUsdc) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: `[Wallet] Balance ~$${estimatedTotal.toFixed(2)} below pause threshold $${pauseThresholdUsdc}. Bot will pause (no operations) until funded.`,
      timestamp: Date.now(),
    }));
    return {
      ok: true,
      paused: true,
      pauseReason: 'wallet_below_pause_threshold',
      overCap,
      walletEquityUsd: estimatedTotal,
    };
  }

  return { ok: true, paused: false, overCap, walletEquityUsd: estimatedTotal };
}
