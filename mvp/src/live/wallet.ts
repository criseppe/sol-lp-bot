import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { MINTS } from '../constants.js';
import bs58 from 'bs58';

export function loadWallet(privateKeyBase58: string): Wallet {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return new Wallet(keypair);
}

export async function getWalletBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<{ sol: number; usdc: number; totalUsdc: number; solPrice: number }> {
  // SOL balance
  const lamports = await connection.getBalance(owner);
  const sol = lamports / LAMPORTS_PER_SOL;

  // USDC balance
  let usdc = 0;
  try {
    const usdcMint = new PublicKey(MINTS.USDC);
    const ata = await getAssociatedTokenAddress(usdcMint, owner);
    const account = await getAccount(connection, ata);
    usdc = Number(account.amount) / 1_000_000; // USDC has 6 decimals
  } catch {
    // ATA doesn't exist = 0 USDC
  }

  return { sol, usdc, totalUsdc: 0, solPrice: 0 }; // totalUsdc filled by caller
}

export function validateWalletForLive(sol: number, usdc: number, maxCapitalUsdc: number): void {
  const estimatedTotal = sol * 150 + usdc; // rough estimate
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
