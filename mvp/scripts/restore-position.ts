import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { initDb, upsertBotState } from '../src/db/sqlite.js';

const mint = new PublicKey('AC4cLB9m28j9Fh3qv1GfAJhBe6MJ6tugm8VTGhNi2hUp');
const [positionAddress] = PublicKey.findProgramAddressSync(
  [Buffer.from('position'), mint.toBuffer()],
  ORCA_WHIRLPOOL_PROGRAM_ID
);
console.log('Position address:', positionAddress.toBase58());

const db = initDb(process.env.DB_PATH!);
upsertBotState(db, {
  state: 'ACTIVE',
  regime: 'RANGING',
  position_json: JSON.stringify({
    positionMint: 'AC4cLB9m28j9Fh3qv1GfAJhBe6MJ6tugm8VTGhNi2hUp',
    positionAddress: positionAddress.toBase58(),
    priceLower: 84.76,
    priceUpper: 86.04,
    entryPrice: 85.15,
    entryTime: Date.now(),
    regime: 'RANGING',
  }),
  ledger_json: '{}',
  naive_json: '{}',
  updated_at: Date.now(),
  cum_fees_sol: 0,
  cum_fees_usdc: 0,
  realized_il: 0,
  tx_count: 0,
  cum_gas_lamports: 0,
});
console.log('Done!');
