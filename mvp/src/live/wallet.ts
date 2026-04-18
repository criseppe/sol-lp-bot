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

export function validateWalletForLive(sol: number, usdc: number, maxCapitalUsdc: number, solPrice = 150): void {
  const estimatedTotal = sol * solPrice + usdc;
  if (estimatedTotal > maxCapitalUsdc) {
    throw new Error(
      `Wallet balance (~$${estimatedTotal.toFixed(0)}) exceeds safety cap ($${maxCapitalUsdc}). ` +
      `Reduce balance or increase MAX_LIVE_CAPITAL_USDC.`,
    );
  }
  if (sol < 0.01) {
    throw new Error('Insufficient SOL for transaction fees (need at least 0.01 SOL).');
  }
}
