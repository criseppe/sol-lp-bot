import { Connection, PublicKey } from '@solana/web3.js';
import { PriceMath, buildWhirlpoolClient, WhirlpoolContext, buildDefaultAccountFetcher, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { Wallet } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import DecimalImport from 'decimal.js';
const Decimal = DecimalImport as unknown as typeof DecimalImport.default;
import type { PoolState } from '../types.js';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const CACHE_TTL_MS = 10_000;

export class PoolService {
  private connection: Connection;
  private whirlpoolAddress: PublicKey;
  private tickSpacing: number = 1;
  private cachedState: PoolState | null = null;
  private lastFetchTime = 0;
  private fetchCount = 0;

  constructor(connection: Connection, whirlpoolAddress: string) {
    this.connection = connection;
    this.whirlpoolAddress = new PublicKey(whirlpoolAddress);
  }

  async fetchState(): Promise<PoolState> {
    const now = Date.now();
    if (this.cachedState && now - this.lastFetchTime < CACHE_TTL_MS) {
      return this.cachedState;
    }

    try {
      const dummyWallet = new Wallet(Keypair.generate());
      const fetcher = buildDefaultAccountFetcher(this.connection);
      const ctx = WhirlpoolContext.from(
        this.connection,
        dummyWallet,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        fetcher,
      );
      const client = buildWhirlpoolClient(ctx);
      const whirlpool = await client.getPool(this.whirlpoolAddress);
      const data = whirlpool.getData();

      this.tickSpacing = data.tickSpacing;
      this.cachedState = {
        tickCurrentIndex: data.tickCurrentIndex,
        sqrtPriceX64: data.sqrtPrice.toString(),
        liquidity: data.liquidity.toString(),
        feeRate: data.feeRate ?? 0,
        lastUpdated: now,
      };
      this.lastFetchTime = now;
      this.fetchCount++;

      return this.cachedState;
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'pool fetch error',
        error: String(err),
        timestamp: Date.now(),
      }));
      if (this.cachedState) {
        // Update lastFetchTime on error to prevent rapid retry loops
        this.lastFetchTime = now;
        return this.cachedState;
      }
      throw err;
    }
  }

  async getCurrentPrice(): Promise<number> {
    const state = await this.fetchState();
    const BN = (await import('bn.js')).default;
    const sqrtPrice = new BN(state.sqrtPriceX64);
    const price = PriceMath.sqrtPriceX64ToPrice(sqrtPrice, SOL_DECIMALS, USDC_DECIMALS);
    return price.toNumber();
  }

  async isInRange(tickLower: number, tickUpper: number): Promise<boolean> {
    const state = await this.fetchState();
    return state.tickCurrentIndex >= tickLower && state.tickCurrentIndex <= tickUpper;
  }

  priceToTick(price: number): number {
    return PriceMath.priceToInitializableTickIndex(
      new Decimal(price),
      SOL_DECIMALS,
      USDC_DECIMALS,
      this.tickSpacing,
    );
  }

  /** Round tick DOWN so the price is at or below the target — use for lower bounds */
  priceToTickLower(price: number): number {
    const tick = this.priceToTick(price);
    const tickPrice = PriceMath.tickIndexToPrice(tick, SOL_DECIMALS, USDC_DECIMALS).toNumber();
    // If rounding pushed the price above target, step down one tick spacing
    return tickPrice > price ? tick - this.tickSpacing : tick;
  }

  /** Round tick UP so the price is at or above the target — use for upper bounds */
  priceToTickUpper(price: number): number {
    const tick = this.priceToTick(price);
    const tickPrice = PriceMath.tickIndexToPrice(tick, SOL_DECIMALS, USDC_DECIMALS).toNumber();
    // If rounding pushed the price below target, step up one tick spacing
    return tickPrice < price ? tick + this.tickSpacing : tick;
  }

  getTickSpacing(): number {
    return this.tickSpacing;
  }

  tickToPrice(tick: number): number {
    return PriceMath.tickIndexToPrice(tick, SOL_DECIMALS, USDC_DECIMALS).toNumber();
  }

  getFetchCount(): number {
    return this.fetchCount;
  }
}
