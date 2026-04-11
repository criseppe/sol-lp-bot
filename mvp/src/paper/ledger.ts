import type {
  Regime, BotState, EventType, PaperPosition, PaperLedger,
  PoolState, CycleResult, RegimeParams, RebalanceEvent,
} from '../types.js';
import { REGIME_PARAMS, RISK, REENTRY } from '../constants.js';
import { detectRegime, getRegimeParams } from '../engine/regime.js';
import {
  calcRange, calcProximity, shouldFireDownside, shouldFireUpside,
  shouldReenterAfterUpside, isFlashCrash, getDownsideReentrySplit,
  getDeployAmount, isHarvestDue, calcHarvestFees, calcIL,
} from '../engine/rules.js';
import {
  insertPriceTick, getDailyCloses, insertRebalanceEvent, upsertDailyPnl,
} from '../db/sqlite.js';
import type { PriceTickRow } from '../db/sqlite.js';
import type Database from 'better-sqlite3';

export interface ComparisonSnapshot {
  timestamp: number;
  price: number;
  bot: {
    portfolioValue: number;
    netPnl: number;
    netPnlPct: number;
    netApr: number;
    cumFees: number;
    cumIL: number;
    rebalanceCount: number;
    regime: Regime;
  };
  naive: {
    portfolioValue: number;
    netPnl: number;
    netPnlPct: number;
    netApr: number;
    cumFees: number;
    cumIL: number;
    rebalanceCount: number;
  };
  advantage: number;
}

function createLedger(capitalUsdc: number): PaperLedger {
  return {
    solBalance: 0,
    usdcBalance: capitalUsdc,
    openPosition: null,
    cumFeesSol: 0,
    cumFeesUsdc: 0,
    cumIL: 0,
    cumGas: 0,
    rebalanceCount: 0,
    t1TriggerCount: 0,
    daysInRange: 0,
    totalCycles: 0,
    startTime: Date.now(),
    peakValue: capitalUsdc,
  };
}

export class PaperTradingEngine {
  private bot: PaperLedger;
  private naive: PaperLedger;
  private naivePosition: PaperPosition | null = null;
  private botState: BotState = 'IDLE';
  private currentRegime: Regime = 'RANGING';
  private pullbackWatchActive = false;
  private pullbackPeakPrice = 0;
  private pullbackWatchStart = 0;
  private lastHarvestTime: number;
  private lastRegimeCheck = 0;
  private flashCrashCooldownUntil = 0;
  private recentPrices: number[] = [];
  private rebalancesThisHour = 0;
  private rebalanceHourStart: number;
  private capitalUsdc: number;
  private regimeWindowDays: number;
  private trendThreshold: number;
  private priceToTick: (price: number) => number;

  constructor(
    capitalUsdc: number,
    priceToTick: (price: number) => number,
    regimeWindowDays = 7,
    trendThreshold = 0.35,
    restored?: { bot: PaperLedger; naive: PaperLedger; botState: BotState; regime: Regime; naivePosition?: PaperPosition | null },
  ) {
    this.capitalUsdc = capitalUsdc;
    this.priceToTick = priceToTick;
    this.regimeWindowDays = regimeWindowDays;
    this.trendThreshold = trendThreshold;

    if (restored) {
      this.bot = restored.bot;
      this.naive = restored.naive;
      this.botState = restored.botState;
      this.currentRegime = restored.regime;
      this.naivePosition = restored.naivePosition ?? null;
    } else {
      this.bot = createLedger(capitalUsdc);
      this.naive = createLedger(capitalUsdc);
    }

    const now = Date.now();
    this.lastHarvestTime = now;
    this.rebalanceHourStart = now;
  }

  processCycle(price: number, poolState: PoolState, db: Database.Database): CycleResult {
    try {
      this.bot.totalCycles++;
      this.naive.totalCycles++;

      // Update regime if due (every 60s)
      const now = Date.now();
      if (now - this.lastRegimeCheck > 60_000) {
        const closes = getDailyCloses(db, this.regimeWindowDays);
        if (closes.length >= 3) {
          const newRegime = detectRegime(closes, this.trendThreshold);
          if (newRegime !== this.currentRegime) {
            console.log(JSON.stringify({
              level: 'info', msg: 'regime change',
              from: this.currentRegime, to: newRegime, timestamp: now,
            }));
            this.currentRegime = newRegime;
          }
        }
        this.lastRegimeCheck = now;
      }

      // Run bot logic
      const eventType = this.runBotCycle(price, db, poolState.feeRate);

      // Run naive logic
      this.runNaiveCycle(price);

      // Calculate proximity for logging
      let proxToLower = 0;
      let proxToUpper = 0;
      let inRange = false;
      if (this.bot.openPosition) {
        const prox = calcProximity(price, this.bot.openPosition);
        proxToLower = prox.proxToLower;
        proxToUpper = prox.proxToUpper;
        inRange = prox.inRange;
        if (inRange) this.bot.daysInRange += (parseInt(process.env.DECISION_INTERVAL_SECONDS ?? '30') / 86400);
      }

      // Store price tick
      const tick: PriceTickRow = {
        timestamp: now,
        price,
        confidence: 0,
        regime: this.currentRegime,
        prox_lower: proxToLower,
        prox_upper: proxToUpper,
        in_range: inRange ? 1 : 0,
      };
      insertPriceTick(db, tick);

      // Portfolio values
      const botValue = this.getPortfolioValue(this.bot, price);
      const naiveValue = this.getPortfolioValue(this.naive, price);

      // Track peak
      if (botValue > this.bot.peakValue) this.bot.peakValue = botValue;

      const initialCapital = this.capitalUsdc;
      const botPnl = botValue - initialCapital;
      const elapsed = (now - this.bot.startTime) / 86400_000;
      const botApr = elapsed > 0 ? (botPnl / initialCapital) * (365 / elapsed) * 100 : 0;

      return {
        timestamp: now,
        price,
        regime: this.currentRegime,
        botState: this.botState,
        proxToLower,
        proxToUpper,
        inRange,
        eventType,
        eventNote: '',
        portfolioValue: botValue,
        cumFees: this.bot.cumFeesSol * price + this.bot.cumFeesUsdc,
        cumIL: this.bot.cumIL,
        netPnl: botPnl,
        netApr: botApr,
      };
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error', msg: 'processCycle error', error: String(err), timestamp: Date.now(),
      }));
      return {
        timestamp: Date.now(), price, regime: this.currentRegime,
        botState: this.botState, proxToLower: 0, proxToUpper: 0,
        inRange: false, eventType: 'CYCLE_SKIP', eventNote: String(err),
        portfolioValue: this.getPortfolioValue(this.bot, price),
        cumFees: 0, cumIL: 0, netPnl: 0, netApr: 0,
      };
    }
  }

  private runBotCycle(price: number, db: Database.Database, feeRate = 3000): EventType {
    const now = Date.now();

    // Track recent prices for flash crash detection
    this.recentPrices.push(price);
    if (this.recentPrices.length > 10) this.recentPrices.shift();

    // Step 1: If HALTED, return early
    if (this.botState === 'HALTED') return 'CYCLE_SKIP';

    // Step 2: Circuit breakers
    const botValue = this.getPortfolioValue(this.bot, price);
    const dailyLossPct = ((this.capitalUsdc - botValue) / this.capitalUsdc) * 100;
    if (dailyLossPct > RISK.DAILY_LOSS_LIMIT_PCT) {
      this.botState = 'HALTED';
      console.log(JSON.stringify({
        level: 'warn', msg: 'circuit breaker: daily loss limit',
        lossPct: dailyLossPct.toFixed(2), timestamp: now,
      }));
      return 'CIRCUIT_BREAKER';
    }

    // Rebalance loop limit
    if (now - this.rebalanceHourStart > 3600_000) {
      this.rebalancesThisHour = 0;
      this.rebalanceHourStart = now;
    }
    if (this.rebalancesThisHour >= RISK.REBALANCE_LOOP_LIMIT) {
      return 'CYCLE_SKIP';
    }

    // Flash crash cooldown
    if (now < this.flashCrashCooldownUntil) {
      return 'CYCLE_SKIP';
    }

    const params = getRegimeParams(this.currentRegime);

    // Step 3: No open position → open one
    if (!this.bot.openPosition) {
      if (this.pullbackWatchActive) {
        // Flash crash detection during pullback watch
        if (isFlashCrash(this.recentPrices)) {
          this.flashCrashCooldownUntil = now + REENTRY.FLASH_CRASH_WAIT_MINUTES * 60_000;
          this.pullbackPeakPrice = price;   // Reset peak to crash level
          this.pullbackWatchStart = now;    // Reset 4h timeout from now
          return 'CYCLE_SKIP';
        }
        // Step 6: Pullback watch
        const decision = shouldReenterAfterUpside(
          price, this.pullbackPeakPrice, this.pullbackWatchStart, now,
        );
        if (decision.should) {
          this.pullbackWatchActive = false;
          const split = getDownsideReentrySplit(this.currentRegime);
          const waitHours = ((now - this.pullbackWatchStart) / 3600_000).toFixed(1);
          const pullbackPct = ((this.pullbackPeakPrice - price) / this.pullbackPeakPrice * 100).toFixed(1);
          const note = decision.reason === 'PULLBACK'
            ? `Rule 3 pullback re-entry: price pulled back ${pullbackPct}% from peak $${this.pullbackPeakPrice.toFixed(2)} to $${price.toFixed(2)} (threshold: ${REENTRY.PULLBACK_THRESHOLD_PCT}%). Waited ${waitHours}h. Re-opening position.`
            : `Rule 3 timeout re-entry: waited ${waitHours}h without sufficient pullback (max was ${pullbackPct}% vs ${REENTRY.PULLBACK_THRESHOLD_PCT}% threshold). Re-opening position at current price $${price.toFixed(2)}.`;
          this.openPosition(price, this.currentRegime, split, db, note);
          return decision.reason === 'PULLBACK' ? 'PULLBACK_REENTRY' : 'PULLBACK_TIMEOUT';
        }
        // Track peak during watch
        if (price > this.pullbackPeakPrice) this.pullbackPeakPrice = price;
        return 'PRICE_UPDATE';
      }

      this.openPosition(price, this.currentRegime, 0.5, db,
        `Initial position opened at $${price.toFixed(2)} using ${this.currentRegime} regime params. Range width: ${params.rangeWidthPct}%, skew: ${(params.skewDown*100).toFixed(0)}% down / ${(params.skewUp*100).toFixed(0)}% up. Deploying ${(params.deployPct*100).toFixed(0)}% of capital with 50/50 SOL/USDC split.`);
      return 'POSITION_OPENED';
    }

    // Step 4: Proximity check (in range)
    const prox = calcProximity(price, this.bot.openPosition);
    if (prox.inRange) {
      // Check downside
      if (shouldFireDownside(prox, params.proxThresholdLower, 0, 0)) {
        this.bot.t1TriggerCount++;
        const proxPct = (prox.proxToLower * 100).toFixed(0);
        const threshPct = (params.proxThresholdLower * 100).toFixed(0);
        this.closePosition(price, 'T1_DOWNSIDE', db,
          `Rule 2 early downside exit: price $${price.toFixed(2)} drifting toward lower bound. Proximity to lower edge: ${proxPct}% (threshold: ${threshPct}%). Closed position to avoid full out-of-range IL.`);
        const split = getDownsideReentrySplit(this.currentRegime);
        this.openPosition(price, this.currentRegime, split, db,
          `Re-entered after downside exit with ${(split*100).toFixed(0)}% SOL / ${((1-split)*100).toFixed(0)}% USDC split (Rule 4, ${this.currentRegime} regime).`);
        return 'T1_DOWNSIDE';
      }
      // Check upside
      if (shouldFireUpside(prox, params.proxThresholdUpper)) {
        this.bot.t1TriggerCount++;
        const proxPct = (prox.proxToUpper * 100).toFixed(0);
        const threshPct = (params.proxThresholdUpper * 100).toFixed(0);
        this.closePosition(price, 'T1_UPSIDE', db,
          `Rule 2 early upside exit: price $${price.toFixed(2)} nearing upper bound. Proximity to upper edge: ${proxPct}% (threshold: ${threshPct}%). Closed position, entering pullback watch mode (Rule 3).`);
        // Start pullback watch
        this.pullbackWatchActive = true;
        this.pullbackPeakPrice = price;
        this.pullbackWatchStart = now;
        this.botState = 'WAITING_PULLBACK';
        return 'T1_UPSIDE';
      }
    } else {
      // Step 5: Out of range
      if (price < this.bot.openPosition.priceLower) {
        this.closePosition(price, 'OOR_BELOW', db,
          `Price $${price.toFixed(2)} dropped below range lower bound $${this.bot.openPosition.priceLower.toFixed(2)}. Position is 100% SOL. Closed and re-entering at new price level.`);
        const split = getDownsideReentrySplit(this.currentRegime);
        this.openPosition(price, this.currentRegime, split, db,
          `Re-entered after downside OOR with ${(split*100).toFixed(0)}% SOL / ${((1-split)*100).toFixed(0)}% USDC split (Rule 4, ${this.currentRegime} regime).`);
        return 'OOR_BELOW';
      }
      if (price > this.bot.openPosition.priceUpper) {
        this.closePosition(price, 'OOR_ABOVE', db,
          `Price $${price.toFixed(2)} rose above range upper bound $${this.bot.openPosition.priceUpper.toFixed(2)}. Position is 100% USDC. Closed position, entering pullback watch (Rule 3) — waiting for ${REENTRY.PULLBACK_THRESHOLD_PCT}% pullback or ${REENTRY.TIMEOUT_HOURS}h timeout before re-entry.`);
        this.pullbackWatchActive = true;
        this.pullbackPeakPrice = price;
        this.pullbackWatchStart = now;
        this.botState = 'WAITING_PULLBACK';
        return 'OOR_ABOVE';
      }
    }

    // Step 7: Fee harvest
    if (this.bot.openPosition && isHarvestDue(this.lastHarvestTime, params, now)) {
      const daysHeld = (now - this.bot.openPosition.entryTime) / 86400_000;
      const harvest = calcHarvestFees(this.bot.openPosition, price, daysHeld, undefined, undefined, feeRate);
      this.bot.cumFeesSol += harvest.solFees / price; // convert to SOL
      this.bot.cumFeesUsdc += harvest.usdcFees;
      this.lastHarvestTime = now;
      return 'FEE_HARVEST';
    }

    this.botState = 'ACTIVE';
    return 'PRICE_UPDATE';
  }

  private openPosition(price: number, regime: Regime, solSplit: number, db: Database.Database, note?: string): void {
    const params = getRegimeParams(regime);
    const range = calcRange(price, params, this.priceToTick);
    const deploy = getDeployAmount(
      this.bot.solBalance * price + this.bot.usdcBalance,
      params,
    );

    if (deploy.deployUsdc < RISK.MIN_POSITION_SIZE_USDC) {
      return; // too small
    }

    const solAmount = (deploy.deployUsdc * solSplit) / price;
    const usdcAmount = deploy.deployUsdc * (1 - solSplit);

    const position: PaperPosition = {
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      priceLower: range.priceLower,
      priceUpper: range.priceUpper,
      entryPrice: price,
      solAmount,
      usdcAmount,
      entryTime: Date.now(),
      regime,
    };

    const previousSolBalance = this.bot.solBalance;
    this.bot.solBalance = 0;
    this.bot.usdcBalance = previousSolBalance * price + this.bot.usdcBalance - deploy.deployUsdc;
    this.bot.openPosition = position;
    this.bot.rebalanceCount++;
    this.rebalancesThisHour++;
    this.botState = 'ACTIVE';

    insertRebalanceEvent(db, {
      timestamp: Date.now(),
      eventType: 'POSITION_OPENED',
      price,
      regime,
      note: note ?? `Opened position: range $${range.priceLower.toFixed(2)}-$${range.priceUpper.toFixed(2)}, deployed $${deploy.deployUsdc.toFixed(2)} (${(solSplit*100).toFixed(0)}% SOL / ${((1-solSplit)*100).toFixed(0)}% USDC).`,
      solBefore: 0,
      usdcBefore: deploy.deployUsdc + (this.bot.usdcBalance),
      solAfter: solAmount,
      usdcAfter: usdcAmount,
      feeSol: 0,
      feeUsdc: 0,
      ilAtClose: 0,
    });
  }

  private closePosition(price: number, reason: EventType, db: Database.Database, note?: string): void {
    const pos = this.bot.openPosition;
    if (!pos) return;

    const comp = this.estimateCurrentComposition(pos, price);
    const il = calcIL(pos.entryPrice, price, pos.solAmount, pos.usdcAmount);
    this.bot.cumIL += il;

    const solBefore = pos.solAmount;
    const usdcBefore = pos.usdcAmount;

    // Credit back to balances
    this.bot.solBalance += comp.sol;
    this.bot.usdcBalance += comp.usdc;
    this.bot.openPosition = null;

    insertRebalanceEvent(db, {
      timestamp: Date.now(),
      eventType: reason,
      price,
      regime: this.currentRegime,
      note: note ? `${note} IL: $${il.toFixed(2)}` : `Closed position. IL: $${il.toFixed(2)}`,
      solBefore,
      usdcBefore,
      solAfter: comp.sol,
      usdcAfter: comp.usdc,
      feeSol: 0,
      feeUsdc: 0,
      ilAtClose: il,
    });
  }

  estimateCurrentComposition(
    position: PaperPosition,
    currentPrice: number,
  ): { sol: number; usdc: number } {
    const totalValue = position.solAmount * currentPrice + position.usdcAmount;
    if (currentPrice <= 0) {
      return { sol: position.solAmount, usdc: position.usdcAmount };
    }
    if (currentPrice <= position.priceLower) {
      return { sol: totalValue / currentPrice, usdc: 0 };
    }
    if (currentPrice >= position.priceUpper) {
      return { sol: 0, usdc: totalValue };
    }
    const rangeWidth = position.priceUpper - position.priceLower;
    if (rangeWidth <= 0) {
      return { sol: position.solAmount, usdc: position.usdcAmount };
    }
    const ratio = (currentPrice - position.priceLower) / rangeWidth;
    return {
      usdc: totalValue * ratio,
      sol: (totalValue * (1 - ratio)) / currentPrice,
    };
  }

  private runNaiveCycle(price: number): void {
    if (!this.naivePosition) {
      // Open with ±5% symmetric, 50/50 split
      const totalValue = this.naive.solBalance * price + this.naive.usdcBalance;
      if (totalValue < RISK.MIN_POSITION_SIZE_USDC) return;

      const lower = price * 0.95;
      const upper = price * 1.05;
      const solAmount = (totalValue * 0.5) / price;
      const usdcAmount = totalValue * 0.5;

      this.naivePosition = {
        tickLower: this.priceToTick(lower),
        tickUpper: this.priceToTick(upper),
        priceLower: lower,
        priceUpper: upper,
        entryPrice: price,
        solAmount,
        usdcAmount,
        entryTime: Date.now(),
        regime: 'RANGING',
      };
      this.naive.solBalance = 0;
      this.naive.usdcBalance = 0;
      this.naive.openPosition = this.naivePosition;
      this.naive.rebalanceCount++;
      return;
    }

    // OOR check
    if (price < this.naivePosition.priceLower || price > this.naivePosition.priceUpper) {
      // Close
      const comp = this.estimateCurrentComposition(this.naivePosition, price);
      const il = calcIL(this.naivePosition.entryPrice, price, this.naivePosition.solAmount, this.naivePosition.usdcAmount);
      this.naive.cumIL += il;
      this.naive.solBalance += comp.sol;
      this.naive.usdcBalance += comp.usdc;
      this.naivePosition = null;
      this.naive.openPosition = null;

      // Reopen
      const totalValue = this.naive.solBalance * price + this.naive.usdcBalance;
      const lower = price * 0.95;
      const upper = price * 1.05;
      const solAmount = (totalValue * 0.5) / price;
      const usdcAmount = totalValue * 0.5;

      this.naivePosition = {
        tickLower: this.priceToTick(lower),
        tickUpper: this.priceToTick(upper),
        priceLower: lower,
        priceUpper: upper,
        entryPrice: price,
        solAmount,
        usdcAmount,
        entryTime: Date.now(),
        regime: 'RANGING',
      };
      this.naive.solBalance = 0;
      this.naive.usdcBalance = 0;
      this.naive.openPosition = this.naivePosition;
      this.naive.rebalanceCount++;
    }

    // Estimate naive fees (simple)
    if (this.naivePosition) {
      const inRange = price >= this.naivePosition.priceLower && price <= this.naivePosition.priceUpper;
      if (inRange) {
        this.naive.daysInRange += (parseInt(process.env.DECISION_INTERVAL_SECONDS ?? '30') / 86400);
      }
    }
  }

  getPortfolioValue(ledger: PaperLedger, currentPrice: number): number {
    let value = ledger.solBalance * currentPrice + ledger.usdcBalance;
    if (ledger.openPosition) {
      const comp = this.estimateCurrentComposition(ledger.openPosition, currentPrice);
      value += comp.sol * currentPrice + comp.usdc;
    }
    value += ledger.cumFeesSol * currentPrice + ledger.cumFeesUsdc;
    return value;
  }

  getComparison(currentPrice: number): ComparisonSnapshot {
    const now = Date.now();
    const botValue = this.getPortfolioValue(this.bot, currentPrice);
    const naiveValue = this.getPortfolioValue(this.naive, currentPrice);
    const initial = this.capitalUsdc;
    const elapsed = (now - this.bot.startTime) / 86400_000;

    const botPnl = botValue - initial;
    const naivePnl = naiveValue - initial;
    const botApr = elapsed > 0 ? (botPnl / initial) * (365 / elapsed) * 100 : 0;
    const naiveApr = elapsed > 0 ? (naivePnl / initial) * (365 / elapsed) * 100 : 0;

    return {
      timestamp: now,
      price: currentPrice,
      bot: {
        portfolioValue: botValue,
        netPnl: botPnl,
        netPnlPct: (botPnl / initial) * 100,
        netApr: botApr,
        cumFees: this.bot.cumFeesSol * currentPrice + this.bot.cumFeesUsdc,
        cumIL: this.bot.cumIL,
        rebalanceCount: this.bot.rebalanceCount,
        regime: this.currentRegime,
      },
      naive: {
        portfolioValue: naiveValue,
        netPnl: naivePnl,
        netPnlPct: (naivePnl / initial) * 100,
        netApr: naiveApr,
        cumFees: this.naive.cumFeesSol * currentPrice + this.naive.cumFeesUsdc,
        cumIL: this.naive.cumIL,
        rebalanceCount: this.naive.rebalanceCount,
      },
      advantage: botPnl - naivePnl,
    };
  }

  getBotLedger(): PaperLedger {
    return this.bot;
  }

  getNaiveLedger(): PaperLedger {
    return this.naive;
  }

  getNaivePosition(): PaperPosition | null {
    return this.naivePosition;
  }

  getState(): BotState {
    return this.botState;
  }

  getRegime(): Regime {
    return this.currentRegime;
  }

  resume(): void {
    if (this.botState === 'HALTED') {
      this.botState = 'IDLE';
      console.log(JSON.stringify({
        level: 'info', msg: 'bot resumed from HALTED', timestamp: Date.now(),
      }));
    }
  }
}
