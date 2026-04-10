# SOL/USDC LP Bot — MVP Specification
# Version 1.0 | April 2026
# Target: Claude Code — build this FIRST, before SPEC.md

> **PURPOSE**
> Validate core trading logic (7 rules + regime detector) against live Solana
> market data using paper money. No real capital. No infrastructure complexity.
> A single Node.js process that runs on your laptop.
>
> **RELATIONSHIP TO SPEC.md**
> MVP.md is Phase 0. Once graduation criteria are met, SPEC.md defines
> every subsequent upgrade. Do not implement anything from SPEC.md
> until MVP graduation criteria pass.
>
> **HOW TO USE**
> Work through sections in order. Each section has an acceptance checklist.
> Run `pnpm test` before moving to the next section.
> MVP is complete when all checklists pass and graduation criteria are met.

---

## 0. SETUP

### 0.1 Stack

```
Runtime:       Node.js 20 LTS
Language:      TypeScript (strict mode)
Package mgr:   pnpm
Solana SDK:    @solana/web3.js ^1.95
Orca SDK:      @orca-so/whirlpools-sdk ^0.13
Pyth SDK:      @pythnetwork/client ^2.21
Database:      SQLite via better-sqlite3 (no server, single file)
Web server:    express ^4 (dashboard only)
Testing:       vitest
Env vars:      dotenv
Logging:       console (structured JSON lines to stdout)
```

### 0.2 Folder Structure

```
/mvp
├── src/
│   ├── data/
│   │   ├── oracle.ts          # Pyth SOL/USD price feed
│   │   └── pool.ts            # Orca Whirlpool state reader
│   ├── engine/
│   │   ├── regime.ts          # Regime detector
│   │   └── rules.ts           # Rules 1-6 (Rule 7 excluded from MVP)
│   ├── paper/
│   │   └── ledger.ts          # Paper portfolio + naive benchmark
│   ├── db/
│   │   └── sqlite.ts          # Schema + all queries (no ORM)
│   ├── output/
│   │   ├── terminal.ts        # Formatted console output per cycle
│   │   └── dashboard.ts       # Express server + HTML dashboard
│   └── main.ts                # Entry point, wires everything
├── tests/
│   ├── regime.test.ts
│   ├── rules.test.ts
│   └── ledger.test.ts
├── .env
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

### 0.3 Environment Variables

```bash
# .env.example — copy to .env and fill in

# Solana RPC (use Helius free tier to start)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Pyth SOL/USD price feed account (mainnet)
PYTH_SOL_USD_FEED=H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG

# Orca SOL/USDC Whirlpool 0.05% (mainnet)
WHIRLPOOL_ADDRESS=HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ

# Paper trading capital (virtual USDC)
PAPER_CAPITAL_USDC=1000

# Decision loop interval (seconds)
DECISION_INTERVAL_SECONDS=30

# Regime detection window (days)
REGIME_WINDOW_DAYS=7

# Regime threshold (directional ratio)
TREND_THRESHOLD=0.35

# Dashboard port
DASHBOARD_PORT=3000

# SQLite file path
DB_PATH=./data/mvp.db

# Pyth validation
PYTH_MAX_CONFIDENCE_PCT=0.5
PYTH_MAX_STALENESS_SECONDS=60
```

### 0.4 Hardcoded Constants

```typescript
// src/constants.ts
// These never come from env vars

export const PROGRAM_IDS = {
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  PYTH_PROGRAM:   'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH',
} as const;

export const MINTS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

// Regime parameter map — all rule thresholds by regime
export const REGIME_PARAMS = {
  RANGING: {
    rangeWidthPct:        3,
    skewDown:             0.30,
    skewUp:               0.70,
    proxThresholdLower:   0.65,
    proxThresholdUpper:   0.88,
    deployPct:            1.00,
    solReentrySplit:      0.50,
    harvestIntervalDays:  7,
    harvestSolConvertPct: 0.00,
  },
  BULLISH_TREND: {
    rangeWidthPct:        6,
    skewDown:             0.20,
    skewUp:               0.80,
    proxThresholdLower:   0.70,
    proxThresholdUpper:   0.92,
    deployPct:            0.85,
    solReentrySplit:      0.50,
    harvestIntervalDays:  4,
    harvestSolConvertPct: 0.70,
  },
  BEARISH_TREND: {
    rangeWidthPct:        8,
    skewDown:             0.40,
    skewUp:               0.60,
    proxThresholdLower:   0.55,
    proxThresholdUpper:   0.82,
    deployPct:            0.50,
    solReentrySplit:      0.30,
    harvestIntervalDays:  2,
    harvestSolConvertPct: 1.00,
  },
  EXTREME: {
    rangeWidthPct:        10,
    skewDown:             0.50,
    skewUp:               0.50,
    proxThresholdLower:   0.50,
    proxThresholdUpper:   0.80,
    deployPct:            0.25,
    solReentrySplit:      0.20,
    harvestIntervalDays:  1,
    harvestSolConvertPct: 1.00,
  },
} as const;

// Circuit breaker thresholds
export const RISK = {
  DAILY_LOSS_LIMIT_PCT:      5,
  WEEKLY_DRAWDOWN_LIMIT_PCT: 15,
  MAX_IL_PCT:                8,
  REBALANCE_LOOP_LIMIT:      10,    // max rebalances per hour
  MIN_POSITION_SIZE_USDC:    100,
} as const;

// Rule 3 re-entry config
export const REENTRY = {
  PULLBACK_THRESHOLD_PCT:    2.5,
  TIMEOUT_HOURS:             8,
  FLASH_CRASH_PCT:           5,     // single candle drop
  FLASH_CRASH_WAIT_MINUTES:  15,
} as const;
```

### 0.5 Shared Types

```typescript
// src/types.ts

export type Regime = 'RANGING' | 'BULLISH_TREND' | 'BEARISH_TREND' | 'EXTREME';

export type BotState =
  | 'IDLE'
  | 'ACTIVE'
  | 'REBALANCING'
  | 'HALTED'
  | 'WAITING_PULLBACK';

export type EventType =
  | 'STARTUP'
  | 'PRICE_UPDATE'
  | 'REGIME_CHANGE'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'T1_DOWNSIDE'
  | 'T1_UPSIDE'
  | 'OOR_BELOW'
  | 'OOR_ABOVE'
  | 'PULLBACK_REENTRY'
  | 'PULLBACK_TIMEOUT'
  | 'FEE_HARVEST'
  | 'CIRCUIT_BREAKER'
  | 'CYCLE_SKIP';

export interface PythPrice {
  price: number;
  confidence: number;
  publishTime: number;
  valid: boolean;
}

export interface PoolState {
  tickCurrentIndex: number;
  sqrtPriceX64: string;
  liquidity: string;
  lastUpdated: number;
}

export interface RegimeParams {
  rangeWidthPct: number;
  skewDown: number;
  skewUp: number;
  proxThresholdLower: number;
  proxThresholdUpper: number;
  deployPct: number;
  solReentrySplit: number;
  harvestIntervalDays: number;
  harvestSolConvertPct: number;
}

export interface RangeBounds {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
}

export interface ProximityState {
  proxToLower: number;      // 0.0 (at centre) → 1.0 (at lower edge)
  proxToUpper: number;      // 0.0 (at centre) → 1.0 (at upper edge)
  inRange: boolean;
  centre: number;
}

export interface PaperPosition {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  entryPrice: number;
  solAmount: number;
  usdcAmount: number;
  entryTime: number;
  regime: Regime;
}

export interface PaperLedger {
  solBalance: number;
  usdcBalance: number;
  openPosition: PaperPosition | null;
  cumFeesSol: number;
  cumFeesUsdc: number;
  cumIL: number;
  cumGas: number;           // always near 0 on Solana, tracked for completeness
  rebalanceCount: number;
  t1TriggerCount: number;
  daysInRange: number;
  totalCycles: number;
  startTime: number;
  peakValue: number;
}

export interface CycleResult {
  timestamp: number;
  price: number;
  regime: Regime;
  botState: BotState;
  proxToLower: number;
  proxToUpper: number;
  inRange: boolean;
  eventType: EventType;
  eventNote: string;
  portfolioValue: number;
  cumFees: number;
  cumIL: number;
  netPnl: number;
  netApr: number;
}

export interface RebalanceEvent {
  timestamp: number;
  eventType: EventType;
  price: number;
  regime: Regime;
  note: string;
  solBefore: number;
  usdcBefore: number;
  solAfter: number;
  usdcAfter: number;
  feeSol: number;
  feeUsdc: number;
  ilAtClose: number;
}
```

### 0.6 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

### 0.7 package.json scripts

```json
{
  "scripts": {
    "dev":   "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "test":  "vitest run",
    "test:watch": "vitest"
  }
}
```

**Acceptance — Section 0:**
- [ ] `pnpm install` completes with no errors
- [ ] `.env` created from `.env.example` with real Helius key
- [ ] `src/constants.ts` and `src/types.ts` created, no TypeScript errors
- [ ] `pnpm dev` starts without crashing (main.ts can be empty stub)

---

## 1. DATA LAYER

### MVP-DATA-001: Pyth Oracle

**File:** `src/data/oracle.ts`

```typescript
// OracleService class
//
// Constructor: takes RPC WebSocket URL + Pyth feed address from env
//
// start(): void
//   - Opens accountSubscribe WebSocket to PYTH_SOL_USD_FEED
//   - On each update: deserialises using @pythnetwork/client parsePriceData()
//   - Validates:
//       price.aggregate.status === PriceStatus.Trading
//       (price.aggregate.confidence / price.aggregate.price) * 100
//         <= PYTH_MAX_CONFIDENCE_PCT
//       (Date.now()/1000 - price.aggregate.publishSlot) within staleness window
//   - Stores last valid PythPrice in memory
//   - Stores last update timestamp
//   - On invalid price: increments badPriceCount, logs warning
//
// getPrice(): PythPrice | null
//   - Returns last valid price if within PYTH_MAX_STALENESS_SECONDS
//   - Returns null if stale or never received
//
// stop(): void
//   - Closes WebSocket subscription cleanly
```

**Acceptance:**
- [ ] `getPrice()` returns a number within 2 seconds of start
- [ ] Price is within reasonable range ($50–$5000 for SOL)
- [ ] Simulated high-confidence input (0.3%) → accepted
- [ ] Simulated low-confidence input (0.8%) → rejected, null returned
- [ ] `stop()` closes connection without hanging

**Constraints:**
- Do NOT fall back to HTTP polling if WebSocket fails
- Do NOT use price if `status !== Trading`
- Log every rejection with reason

---

### MVP-DATA-002: Whirlpool Pool State Reader

**File:** `src/data/pool.ts`

```typescript
// PoolService class
//
// Constructor: takes Connection + whirlpool address from env
//
// fetchState(): Promise<PoolState>
//   - Fetches whirlpool account data using Orca SDK WhirlpoolContext
//   - Returns current tickCurrentIndex, sqrtPriceX64, liquidity
//   - Caches result for 10 seconds (avoid hammering RPC)
//
// getCurrentPrice(): number
//   - Converts sqrtPriceX64 to human-readable SOL/USDC price
//   - Uses Orca SDK: PriceMath.sqrtPriceX64ToPrice(sqrtPrice, 9, 6)
//   - (SOL decimals=9, USDC decimals=6)
//
// isInRange(tickLower: number, tickUpper: number): boolean
//   - Returns tickLower <= tickCurrentIndex <= tickUpper
//
// priceToTick(price: number): number
//   - Converts price to nearest valid tick index
//   - Uses Orca SDK: PriceMath.priceToInitializableTickIndex()
//   - Tick spacing for 0.05% pool = 1
//
// tickToPrice(tick: number): number
//   - Converts tick index to price
//   - Uses Orca SDK: PriceMath.tickIndexToPrice()
```

**Acceptance:**
- [ ] `getCurrentPrice()` returns a price within ±2% of Pyth price
- [ ] `isInRange()` returns correct boolean for known tick bounds
- [ ] `priceToTick()` round-trips: tickToPrice(priceToTick(p)) ≈ p (within 0.1%)
- [ ] Cache works: second call within 10s does not make new RPC request

**Constraints:**
- Use Orca SDK math functions only; do NOT implement tick math manually
- Log RPC errors but do NOT throw; return cached state if available

---

**Acceptance — Section 1:**
- [ ] Both services instantiate and return data without errors
- [ ] `node -e "require('./dist/data/oracle').test()"` prints a valid SOL price
- [ ] Unit tests for all validation branches pass

---

## 2. DATABASE LAYER

### MVP-DB-001: SQLite Schema and Queries

**File:** `src/db/sqlite.ts`

```typescript
// Uses better-sqlite3 (synchronous — simpler than async for single process)
// DB file path from DB_PATH env var (default: ./data/mvp.db)
// Created automatically on first run with mkdirSync

// initDb(dbPath: string): Database
//   Creates tables if not exist, returns db handle

// SCHEMA:

/*
CREATE TABLE IF NOT EXISTS price_ticks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  price       REAL NOT NULL,
  confidence  REAL NOT NULL,
  regime      TEXT NOT NULL,
  prox_lower  REAL,
  prox_upper  REAL,
  in_range    INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'live'   -- 'live' | 'backfill'
);

CREATE TABLE IF NOT EXISTS rebalance_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  price       REAL NOT NULL,
  regime      TEXT NOT NULL,
  note        TEXT,
  sol_before  REAL,
  usdc_before REAL,
  sol_after   REAL,
  usdc_after  REAL,
  fee_sol     REAL DEFAULT 0,
  fee_usdc    REAL DEFAULT 0,
  il_at_close REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT UNIQUE NOT NULL,
  opening_value REAL,
  closing_value REAL,
  fees_sol      REAL DEFAULT 0,
  fees_usdc     REAL DEFAULT 0,
  il_cost       REAL DEFAULT 0,
  net_pnl       REAL,
  net_pnl_pct   REAL,
  rebalances    INTEGER DEFAULT 0,
  in_range_pct  REAL,
  regime        TEXT
);

CREATE TABLE IF NOT EXISTS bot_state (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'IDLE',
  regime         TEXT,
  position_json  TEXT,    -- JSON blob of PaperPosition | null
  ledger_json    TEXT,    -- JSON blob of PaperLedger
  naive_json     TEXT,    -- JSON blob of naive PaperLedger
  updated_at     INTEGER NOT NULL
);
*/

// Exported query functions (all synchronous):
// insertPriceTick(db, tick: PriceTickRow): void
//
// getDailyCloses(db, days: number): number[]
//   Returns one price per calendar day (last recorded price of each day).
//   Oldest first. This is the ONLY function that feeds the regime detector.
//   NEVER pass raw tick data to detectRegime() — always use this function.
//
//   SQL:
//   SELECT price FROM price_ticks
//   WHERE timestamp >= (strftime('%s','now') - days * 86400) * 1000
//   GROUP BY date(datetime(timestamp/1000,'unixepoch'))
//   HAVING timestamp = MAX(timestamp)
//   ORDER BY date(datetime(timestamp/1000,'unixepoch')) ASC
//
// backfillPriceHistory(db, closes: Array<{timestamp:number, price:number}>): void
//   Bulk-inserts historical daily closes with source='backfill'.
//   Called once on cold start if DB has fewer than 3 days of history.
//   Uses INSERT OR IGNORE to avoid duplicating existing rows.
//
// getHistoryDayCount(db): number
//   Returns count of distinct calendar days in price_ticks.
//   Used by cold start check: if count < 3 → trigger backfill.
//
// insertRebalanceEvent(db, event: RebalanceEvent): void
// getRebalanceEvents(db, limit: number): RebalanceEvent[]
// upsertBotState(db, state: BotStateRow): void
// getBotState(db): BotStateRow | null
// upsertDailyPnl(db, pnl: DailyPnlRow): void
// getDailyPnl(db, days: number): DailyPnlRow[]
// pruneOldPriceTicks(db, keepDays: number): void   -- call daily, skips source='backfill' rows older than keepDays
```

**Acceptance:**
- [ ] `initDb()` creates all tables on fresh file
- [ ] `insertPriceTick()` stores a row with source='live' by default
- [ ] `getDailyCloses(db, 7)` returns exactly one price per calendar day (last of day), oldest first
- [ ] `getDailyCloses()` returns correct prices when mix of 'live' and 'backfill' rows exist
- [ ] `backfillPriceHistory()` inserts rows with source='backfill'; duplicate timestamps ignored
- [ ] `getHistoryDayCount()` returns correct distinct day count
- [ ] `upsertBotState()` is idempotent (second call updates, not inserts)
- [ ] `pruneOldPriceTicks()` deletes rows older than keepDays
- [ ] Unit tests for each query function using in-memory SQLite (`:memory:`)

**Constraints:**
- Use synchronous better-sqlite3 API throughout; do NOT use async SQLite
- bot_state table always has exactly ONE row (id=1); use INSERT OR REPLACE
- getDailyCloses() must use GROUP BY date + HAVING MAX(timestamp) — do NOT use LIMIT or ORDER BY alone
- NEVER call detectRegime() with raw tick data; always call getDailyCloses() first

---

## 3. ENGINE

### MVP-ENGINE-001: Regime Detector

**File:** `src/engine/regime.ts`

```typescript
// detectRegime(prices: number[]): Regime
//
//   INPUT CONTRACT — critical:
//   prices must be DAILY closing prices, one per calendar day, oldest first.
//   Always sourced from getDailyCloses(db, REGIME_WINDOW_DAYS).
//   NEVER pass raw 30-second price_ticks — dirRatio is meaningless on tick data.
//
//   Requires at least 3 prices; returns 'RANGING' if insufficient data.
//
//   Algorithm:
//     last          = prices.length - 1
//     netMove       = |prices[last] - prices[0]|
//     totalPath     = sum(|prices[i] - prices[i-1]|) for i in 1..last
//     dirRatio      = totalPath === 0 ? 0 : netMove / totalPath
//                     // 1.0 = straight-line trend, 0.0 = pure oscillation
//
//     logReturns    = prices.slice(1).map((p, i) => Math.log(p / prices[i]))
//     realisedVol   = stdDev(logReturns)
//                     // daily std dev of log returns
//                     // > 0.08 ≈ 8% daily vol = crisis / extreme regime
//
//     if realisedVol > 0.08:          return 'EXTREME'
//     if dirRatio > TREND_THRESHOLD:
//       if prices[last] > prices[0]:  return 'BULLISH_TREND'
//       else:                         return 'BEARISH_TREND'
//     return 'RANGING'
//
//   Threshold rationale:
//     TREND_THRESHOLD = 0.35 (env var, default 0.35)
//       Below 0.35 → oscillating market. Above 0.35 → meaningful directional
//       progress. Calibrated against real SOL price history.
//     realisedVol 0.08 → ~150% annualised vol. Normal SOL daily vol is 3-5%.
//       Above 0.08 signals crash or blow-off top → EXTREME params apply.
//
// getRegimeParams(regime: Regime): RegimeParams
//   → looks up REGIME_PARAMS constant, returns full parameter set
//
// stdDev(values: number[]): number
//   → population standard deviation (not sample); exported for testing
```

**Acceptance:**
- [ ] 14 prices trending up, dirRatio=0.90 → BULLISH_TREND
- [ ] 14 prices trending down, dirRatio=0.90 → BEARISH_TREND
- [ ] 14 prices oscillating, dirRatio=0.05 → RANGING
- [ ] realisedVol=0.09 (any direction) → EXTREME regardless of dirRatio
- [ ] Less than 3 prices → RANGING (safe default, logged as warning)
- [ ] `stdDev([2,4,4,4,5,5,7,9])` ≈ 2.0 (known test vector)
- [ ] Unit test confirms getDailyCloses output (not raw ticks) is passed in

---

### MVP-ENGINE-002: Rules 1–6

**File:** `src/engine/rules.ts`

Each rule is a pure function. No side effects. All testable in isolation.

```typescript
// ─── RULE 1: Asymmetric Range Calculator ──────────────────────────────────
// calcRange(currentPrice: number, params: RegimeParams, pool: PoolService): RangeBounds
//   lower = currentPrice * (1 - (params.rangeWidthPct/100) * params.skewDown)
//   upper = currentPrice * (1 + (params.rangeWidthPct/100) * params.skewUp)
//   tickLower = pool.priceToTick(lower)
//   tickUpper = pool.priceToTick(upper)
//   return { tickLower, tickUpper, priceLower: lower, priceUpper: upper }

// ─── RULE 2: Proximity Calculator ────────────────────────────────────────
// calcProximity(currentPrice: number, position: PaperPosition): ProximityState
//   centre     = (position.priceLower + position.priceUpper) / 2
//   halfWidth  = (position.priceUpper - position.priceLower) / 2
//   proxLower  = Math.max(0, (centre - currentPrice) / halfWidth)
//   proxUpper  = Math.max(0, (currentPrice - centre) / halfWidth)
//   inRange    = currentPrice >= position.priceLower &&
//                currentPrice <= position.priceUpper
//   return { proxToLower: proxLower, proxToUpper: proxUpper, inRange, centre }

// shouldFireDownside(prox: ProximityState, threshold: number,
//                    dailyILRate: number, gasCost: number): boolean
//   projectedIL = Math.abs(dailyILRate) * 4
//   return prox.proxToLower >= threshold || projectedIL > gasCost

// shouldFireUpside(prox: ProximityState, threshold: number): boolean
//   return prox.proxToUpper >= threshold

// ─── RULE 3: Re-entry Timing ──────────────────────────────────────────────
// shouldReenterAfterUpside(currentPrice: number, peakPrice: number,
//                           watchStartTime: number): ReentryDecision
//   pullbackPct = (peakPrice - currentPrice) / peakPrice * 100
//   hoursWaiting = (Date.now() - watchStartTime) / 3600000
//   if pullbackPct >= REENTRY.PULLBACK_THRESHOLD_PCT:
//     return { should: true, reason: 'PULLBACK' }
//   if hoursWaiting >= REENTRY.TIMEOUT_HOURS:
//     return { should: true, reason: 'TIMEOUT' }
//   return { should: false, reason: 'WAITING' }

// isFlashCrash(prices: number[]): boolean
//   // prices = last 60 one-minute closes (or available)
//   if prices.length < 2: return false
//   drop = (prices[0] - prices[prices.length-1]) / prices[0] * 100
//   return drop >= REENTRY.FLASH_CRASH_PCT

// ─── RULE 4: Re-entry Split ───────────────────────────────────────────────
// getDownsideReentrySplit(regime: Regime): number   // SOL fraction
//   RANGING:       0.50
//   BULLISH_TREND: 0.50
//   BEARISH_TREND: 0.30
//   EXTREME:       0.20

// ─── RULE 5: Position Sizing ─────────────────────────────────────────────
// getDeployAmount(totalCapital: number, params: RegimeParams): DeployAmount
//   return {
//     deployUsdc: totalCapital * params.deployPct,
//     reserveUsdc: totalCapital * (1 - params.deployPct)
//   }

// ─── RULE 6: Fee Harvest ─────────────────────────────────────────────────
// isHarvestDue(lastHarvestTime: number, params: RegimeParams): boolean
//   daysSinceHarvest = (Date.now() - lastHarvestTime) / 86400000
//   return daysSinceHarvest >= params.harvestIntervalDays

// calcHarvestFees(position: PaperPosition, poolDailyVolume: number,
//                 poolTvl: number, daysHeld: number): HarvestEstimate
//   // Estimates accrued fees (paper mode — no real on-chain read)
//   feeTier          = 0.0005  // 0.05%
//   positionShare    = (position.solAmount * currentPrice + position.usdcAmount) / poolTvl
//   dailyFees        = positionShare * poolDailyVolume * feeTier
//   totalFees        = dailyFees * daysHeld
//   solFees          = totalFees * 0.5   // approximate split
//   usdcFees         = totalFees * 0.5
//   return { solFees, usdcFees, totalUsdcValue: totalFees }
//
// NOTE: MVP uses estimated pool volume of $500M/day and pool TVL of $250M
// These are constants in the file, easy to update from real data later

// ─── IL Calculator (used by paper ledger) ─────────────────────────────────
// calcIL(entryPrice: number, currentPrice: number,
//         initialSol: number, initialUsdc: number): number
//   // Returns IL as negative USD value
//   k          = initialSol * initialUsdc
//   lpValue    = 2 * Math.sqrt(k * currentPrice)
//   holdValue  = initialSol * currentPrice + initialUsdc
//   return lpValue - holdValue   // negative = loss vs hold

export interface ReentryDecision {
  should: boolean;
  reason: 'PULLBACK' | 'TIMEOUT' | 'WAITING';
}

export interface DeployAmount {
  deployUsdc: number;
  reserveUsdc: number;
}

export interface HarvestEstimate {
  solFees: number;
  usdcFees: number;
  totalUsdcValue: number;
}
```

**Acceptance:**
- [ ] Rule 1: SOL=$150, RANGING → lower=$147.75, upper=$155.25
- [ ] Rule 1: SOL=$150, BEARISH → lower=$145.50, upper=$154.20
- [ ] Rule 2: price at centre → both proximities = 0
- [ ] Rule 2: price at lower tick → proxToLower ≈ 1.0
- [ ] Rule 2: proxToLower=0.67 with threshold=0.65 → shouldFireDownside=true
- [ ] Rule 3: peak=$155, current=$151.13 (2.5% pullback) → should=true, PULLBACK
- [ ] Rule 3: 8.1h elapsed, no pullback → should=true, TIMEOUT
- [ ] Rule 3: 2% drop in prices array → isFlashCrash=false (< 5% threshold)
- [ ] Rule 3: 6% drop → isFlashCrash=true
- [ ] Rule 4: BEARISH → 0.30 (not 0.50)
- [ ] Rule 5: $1000 capital, BEARISH (deployPct=0.50) → deploy=$500, reserve=$500
- [ ] Rule 6: last harvest 3 days ago, RANGING (interval=7) → isHarvestDue=false
- [ ] Rule 6: last harvest 8 days ago, RANGING → isHarvestDue=true
- [ ] IL: entry=$150, current=$120 → negative value (loss vs hold)
- [ ] IL: entry=$150, current=$150 → 0 (no price change = no IL)
- [ ] All functions are pure (no side effects, same input = same output)

**Constraints:**
- Do NOT import anything from data/ or db/ in rules.ts
- All functions must be pure — no I/O, no state, no Date.now() calls
  (pass timestamps as parameters for testability)

---

## 4. PAPER LEDGER

### MVP-PAPER-001: Paper Trading Engine

**File:** `src/paper/ledger.ts`

```typescript
// PaperTradingEngine class
// Manages TWO parallel ledgers:
//   this.bot   — uses all 7 rules with regime-aware parameters
//   this.naive — symmetric ±5% range, reactive only, always 50/50, no rules
//
// Both ledgers start with PAPER_CAPITAL_USDC from env vars.
// Both receive the same price on every cycle.

class PaperTradingEngine {
  // ── State ──────────────────────────────────────────────────────────────
  private bot: PaperLedger;
  private naive: PaperLedger;
  private botState: BotState;
  private currentRegime: Regime;
  private pullbackWatchActive: boolean;
  private pullbackPeakPrice: number;
  private pullbackWatchStart: number;
  private lastHarvestTime: number;
  private lastRegimeCheck: number;
  private flashCrashCooldownUntil: number;
  private rebalancesThisHour: number;
  private rebalanceHourStart: number;

  // ── Main entry point — called every cycle ──────────────────────────────
  processCycle(price: number, poolState: PoolState, db: Database): CycleResult
  //
  // 1. Update regime if due (REGIME_WINDOW_DAYS of prices from DB)
  // 2. Run bot decision logic (steps below)
  // 3. Run naive decision logic (simple OOR check only)
  // 4. Calculate portfolio values for both
  // 5. Persist cycle to DB
  // 6. Return CycleResult

  // ── Bot decision logic (called by processCycle) ────────────────────────
  private runBotCycle(price: number, poolState: PoolState): EventType
  //
  // Step 1: Safety — if HALTED return early
  // Step 2: Circuit breakers (check RISK constants)
  //   → if daily loss > RISK.DAILY_LOSS_LIMIT_PCT → HALT, return CIRCUIT_BREAKER
  //   → if IL > RISK.MAX_IL_PCT → force rebalance
  //   → if rebalancesThisHour > RISK.REBALANCE_LOOP_LIMIT → pause 30 min
  // Step 3: If no open position → open one (Rules 1 + 5)
  // Step 4: Rule 2 proximity check (if position open and in range)
  //   → check downside proximity → early downside exit if threshold met
  //   → check upside proximity → early upside exit if threshold met
  // Step 5: Out-of-range check
  //   → OOR below → downside rebalance (Rules 3 + 4)
  //   → OOR above → start pullback watch (Rule 3)
  // Step 6: Pullback watch update (Rule 3)
  //   → check if pullback threshold met or timeout → re-enter
  // Step 7: Fee harvest check (Rule 6)
  //   → if harvest due → estimate and credit fees to ledger
  // Return: EventType describing what happened this cycle

  // ── Position operations ────────────────────────────────────────────────
  private openPosition(price: number, regime: Regime,
                        solSplit: number): void
  //   - Calculates range (Rule 1)
  //   - Calculates deploy amount (Rule 5)
  //   - Splits deployUsdc into SOL + USDC (solSplit fraction → SOL)
  //   - Creates PaperPosition
  //   - Updates bot.solBalance and bot.usdcBalance
  //   - Increments rebalanceCount
  //   - Logs to DB as POSITION_OPENED event

  private closePosition(price: number, reason: EventType): void
  //   - Calculates current SOL+USDC composition at current price
  //     using Uniswap V3 formula: amounts from liquidity + tick bounds
  //   - Calculates IL: calcIL(entryPrice, price, initSol, initUsdc)
  //   - Credits SOL+USDC back to ledger balances
  //   - Records IL in bot.cumIL
  //   - Logs to DB as rebalance event with ilAtClose

  private estimateCurrentComposition(position: PaperPosition,
                                       currentPrice: number): {sol: number, usdc: number}
  //   // Simplified: linear interpolation within range
  //   // When price = priceLower: 100% SOL, 0% USDC
  //   // When price = priceUpper: 0% SOL, 100% USDC
  //   // When price = centre: 50% SOL, 50% USDC
  //   // This is an approximation (good enough for paper trading validation)
  //   if currentPrice <= position.priceLower:
  //     return { sol: totalValue/currentPrice, usdc: 0 }
  //   if currentPrice >= position.priceUpper:
  //     return { sol: 0, usdc: totalValue }
  //   ratio = (currentPrice - position.priceLower) /
  //           (position.priceUpper - position.priceLower)
  //   usdcFraction = ratio
  //   totalValue = position.solAmount * currentPrice + position.usdcAmount
  //   return {
  //     usdc: totalValue * usdcFraction,
  //     sol:  totalValue * (1 - usdcFraction) / currentPrice
  //   }

  // ── Naive bot (runs in parallel, same price) ───────────────────────────
  private runNaiveCycle(price: number): void
  //   Simple logic only:
  //   - If no position: open with ±5% symmetric range, 50/50 split
  //   - If price < naivePosition.priceLower OR > naivePosition.priceUpper:
  //       close and reopen at current price, 50/50 always
  //   - No proximity triggers, no regime awareness, no rules

  // ── Portfolio value calculator ─────────────────────────────────────────
  getPortfolioValue(ledger: PaperLedger, currentPrice: number): number
  //   if no open position: return solBalance * currentPrice + usdcBalance
  //   else: return estimateCurrentComposition value + reserve
  //         + cumFeesSol * currentPrice + cumFeesUsdc

  getComparison(currentPrice: number): ComparisonSnapshot
  getBotLedger(): PaperLedger
  getNaiveLedger(): PaperLedger
  getState(): BotState
  resume(): void    // exit HALTED state (manual call)
}

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
  advantage: number;    // bot.netPnl - naive.netPnl in USDC
}
```

**Acceptance:**
- [ ] Start with $1000, open position, close at same price → value ≈ $1000 (minus gas rounding)
- [ ] Open at $150, price moves to $120 → composition is ~100% SOL
- [ ] Open at $150, price moves to $180 → composition is ~100% USDC
- [ ] Naive bot opens with ±5% symmetric range (confirmed in test)
- [ ] Circuit breaker: simulate 6% daily loss → state transitions to HALTED
- [ ] Ledger persists to DB and restores correctly on re-instantiation
- [ ] `getComparison()` returns correct advantage calculation
- [ ] Both bot and naive run on same price feed (same cycle)

**Constraints:**
- Do NOT use exact Uniswap V3 math for paper trading — linear approximation is fine
- Do NOT throw exceptions in processCycle; catch all errors and log them
- Keep bot and naive completely separate (no shared state)

---

## 5. OUTPUT

### MVP-OUTPUT-001: Terminal Formatter

**File:** `src/output/terminal.ts`

```typescript
// printCycle(result: CycleResult, comparison: ComparisonSnapshot): void
//
// Clears the last N lines and reprints a formatted summary.
// Uses ANSI colour codes directly (no chalk dependency).
//
// Output format (printed every cycle):
//
// ┌─────────────────────────────────────────────────────────────┐
// │  SOL/USDC LP Bot  ·  SHADOW MODE  ·  [timestamp]           │
// ├─────────────────────────────────────────────────────────────┤
// │  SOL Price:  $148.24          Regime:  RANGING              │
// │  In Range:   YES              Prox ↓:  34%   ↑:  18%       │
// │  Range:      $144.28 ──●──── $152.66                        │
// ├────────────────────────┬────────────────────────────────────┤
// │  BOT STRATEGY          │  NAIVE BENCHMARK                   │
// │  Portfolio:  $1,042.10 │  Portfolio:  $1,018.40             │
// │  Net P&L:    +$42.10   │  Net P&L:    +$18.40               │
// │  Net APR:    +54.2%    │  Net APR:    +23.6%                │
// │  Fees:       +$68.30   │  Fees:       +$31.20               │
// │  IL cost:    -$26.20   │  IL cost:    -$12.80               │
// │  Rebalances: 7         │  Rebalances: 12                    │
// ├────────────────────────┴────────────────────────────────────┤
// │  Advantage:  +$23.70  (+30.6% better than naive)           │
// │  Last event: T1_DOWNSIDE at $146.80  (2h ago)               │
// └─────────────────────────────────────────────────────────────┘
//
// Colours:
//   Regime: RANGING=blue, BULLISH=green, BEARISH=red, EXTREME=magenta
//   P&L positive=green, negative=red
//   Proximity bar: green < 50%, amber 50-75%, red > 75%
//   In Range: green YES, red NO

// printEvent(event: RebalanceEvent): void
//   Prints a single line when a significant event occurs:
//   [HH:MM:SS] ⚡ T1_DOWNSIDE  $148.20  prox=68%  → rebalanced [RANGING]
```

**Acceptance:**
- [ ] Output renders without ANSI escape artefacts in standard terminal
- [ ] Numbers formatted with commas and 2 decimal places
- [ ] Regime badge uses correct colour per regime
- [ ] Advantage row shows correct calculation

---

### MVP-OUTPUT-002: Simple Dashboard

**File:** `src/output/dashboard.ts`

```typescript
// startDashboard(port: number): DashboardServer
//
// Express server with two routes:
//
// GET /
//   Serves a single self-contained HTML page (no external dependencies).
//   Page auto-refreshes every 30 seconds via <meta http-equiv="refresh">.
//   Data is embedded as JSON in the HTML at render time (server-side).
//   NO WebSocket in MVP. NO auth. NO framework. Just HTML + inline CSS + inline JS.
//
// GET /api/data
//   Returns JSON: { comparison, recentEvents, dailyPnl, botState, uptime }
//   Dashboard JS fetches this on load.
//
// GET /api/events
//   Returns last 50 rebalance events as JSON array.
//
// The HTML dashboard shows:
//   - Mode banner (SHADOW MODE — Paper Trading)
//   - Current price + regime badge
//   - Bot vs Naive comparison table
//   - Position range visual (simple CSS bar)
//   - Last 10 events table
//   - 7-day P&L chart (simple SVG bar chart, inline)
//   - Circuit breaker status (green/amber/red dots)
//
// DashboardServer exposes:
//   updateData(comparison: ComparisonSnapshot,
//              events: RebalanceEvent[],
//              botState: BotState): void
//   stop(): void
```

**Dashboard HTML requirements:**
- Single file, all CSS inline in `<style>`, no external stylesheets
- No JavaScript frameworks (vanilla JS only)
- Auto-refreshes every 30 seconds (`<meta http-equiv="refresh" content="30">`)
- Works on mobile (responsive grid)
- Dark theme matching the terminal aesthetic
- Accessible on `http://localhost:3000` by default

**Acceptance:**
- [ ] `http://localhost:3000` loads without errors in Chrome/Firefox/Safari
- [ ] Data updates within 35 seconds of a new cycle
- [ ] Works with JavaScript disabled (data visible in HTML source)
- [ ] No external network requests from the page

---

## 6. MAIN ENTRY POINT

### MVP-MAIN-001: Wiring Everything Together

**File:** `src/main.ts`

```typescript
// Startup sequence:
//
// 1. VALIDATE ENV VARS
//    Check all required vars present. Print clear error and exit if missing.
//    Required: RPC_URL, RPC_WS_URL, PYTH_SOL_USD_FEED, WHIRLPOOL_ADDRESS,
//              PAPER_CAPITAL_USDC, DB_PATH
//
// 2. INIT DATABASE
//    db = initDb(process.env.DB_PATH)
//    mkdirSync(dirname(DB_PATH), { recursive: true })
//
// 3. RESTORE STATE
//    savedState = db.getBotState()
//    if savedState exists: restore PaperTradingEngine from savedState.ledger_json
//    else: start fresh with PAPER_CAPITAL_USDC
//
// 4. START DATA SERVICES
//    oracle = new OracleService(RPC_WS_URL, PYTH_SOL_USD_FEED)
//    pool   = new PoolService(new Connection(RPC_URL), WHIRLPOOL_ADDRESS)
//    oracle.start()
//    await pool.fetchState()    // initial fetch
//
// 5. START DASHBOARD
//    dashboard = startDashboard(DASHBOARD_PORT)
//
// 5b. COLD START BACKFILL
//    dayCount = db.getHistoryDayCount()
//    if dayCount < 3:
//      Log: "Insufficient price history (N days). Backfilling from Birdeye..."
//      Try:
//        response = await fetch(
//          'https://public-api.birdeye.so/defi/ohlcv' +
//          '?address=So11111111111111111111111111111111111111112' +
//          '&type=1D' +
//          '&time_from=' + Math.floor(Date.now()/1000 - 8*86400) +
//          '&time_to='   + Math.floor(Date.now()/1000)
//        )
//        candles = response.json().data.items   // [{o,h,l,c,v,unixTime}]
//        closes  = candles.map(c => ({ timestamp: c.unixTime * 1000, price: c.c }))
//        db.backfillPriceHistory(closes)
//        Log: "Backfilled N days of SOL price history"
//      Catch:
//        Log: "Birdeye backfill failed — regime will default to RANGING until
//              3+ days of live data accumulates. This is safe."
//        // Do NOT exit. Bot starts with RANGING params as safe default.
//
// 6. WAIT FOR FIRST VALID PRICE
//    poll oracle.getPrice() every 2s until non-null (max 30s, then exit with error)
//    Log: "First price received: $X.XX — starting decision loop"
//
// 7. PRINT STARTUP BANNER
//    ┌─────────────────────────────────────────┐
//    │  SOL/USDC LP Bot MVP  ·  SHADOW MODE    │
//    │  Capital: $1,000 USDC  ·  Pool: SOL/USDC│
//    │  Dashboard: http://localhost:3000        │
//    │  DB: ./data/mvp.db                       │
//    │  Press Ctrl+C to stop gracefully         │
//    └─────────────────────────────────────────┘
//
// 8. DECISION LOOP
//    setInterval(async () => {
//      try {
//        price = oracle.getPrice()
//        if (!price) { log('CYCLE_SKIP: oracle stale'); return }
//
//        poolState = await pool.fetchState()
//        result = engine.processCycle(price.price, poolState, db)
//        comparison = engine.getComparison(price.price)
//
//        terminal.printCycle(result, comparison)
//        dashboard.updateData(comparison, db.getRebalanceEvents(50), engine.getState())
//
//        // Persist state every cycle
//        db.upsertBotState({
//          id: 1,
//          state: engine.getState(),
//          regime: result.regime,
//          position_json: JSON.stringify(engine.getBotLedger().openPosition),
//          ledger_json: JSON.stringify(engine.getBotLedger()),
//          naive_json: JSON.stringify(engine.getNaiveLedger()),
//          updated_at: Date.now(),
//        })
//
//        // Daily P&L snapshot at midnight
//        checkAndWriteDailyPnl(db, comparison)
//
//      } catch (err) {
//        console.error('[CYCLE ERROR]', err)
//        // Never crash the loop on a single error
//      }
//    }, DECISION_INTERVAL_SECONDS * 1000)
//
// 9. GRACEFUL SHUTDOWN
//    process.on('SIGINT', () => {
//      log('Shutting down gracefully...')
//      clearInterval(decisionLoop)
//      oracle.stop()
//      dashboard.stop()
//      db.upsertBotState({ ...finalState })
//      log('State saved. Bye.')
//      process.exit(0)
//    })
```

**Acceptance:**
- [ ] Missing env var → clear error message with variable name, process exits with code 1
- [ ] `pnpm dev` starts, prints banner, begins printing cycles within 60 seconds
- [ ] `Ctrl+C` stops cleanly (no hanging processes, state saved)
- [ ] Crash on single cycle → loop continues on next cycle (error logged, not thrown)
- [ ] Restart after crash → restores ledger state from SQLite
- [ ] After 5 minutes running: price ticks visible in SQLite DB

---

## 7. README

### MVP-README-001: Getting Started

**File:** `README.md` — must contain:

```markdown
## Prerequisites
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Helius free API key (https://helius.dev)

## Setup (5 minutes)
1. `pnpm install`
2. `cp .env.example .env`
3. Fill in your Helius RPC URL in `.env`
4. `pnpm dev`

## What you'll see
- Terminal: live cycle output every 30 seconds
- Dashboard: http://localhost:3000

## Bot modes
BOT_MODE is always SHADOW in MVP (paper trading only).
No real money is ever spent or moved.

## Data
SQLite database at DB_PATH (default: ./data/mvp.db).
View with any SQLite browser or: `sqlite3 ./data/mvp.db`

## Stopping
Ctrl+C — state is saved automatically.
Restart with `pnpm dev` — state is restored.
```

---

## 8. GRADUATION CRITERIA

**The MVP is complete and ready for SPEC.md Phase 1 when ALL of the following are true:**

```
[ ] Bot has run continuously for 72+ hours without crashing
[ ] At least 14 days of price_ticks data in the SQLite DB
[ ] All 6 rules have triggered at least once
    (visible in rebalance_events table by event_type)
[ ] Net APR is positive (bot.netPnlPct > 0 annualised)
[ ] Bot strategy outperforms naive benchmark
    (comparison.advantage > 0)
[ ] Regime has changed at least once during the run
    (at least 2 distinct values in regime column of price_ticks)
[ ] Dashboard loads and shows correct data
[ ] `pnpm test` passes with 0 failures
[ ] No TypeScript errors (`tsc --noEmit` exits 0)
```

**Once graduated:**
- Archive the MVP state: `sqlite3 ./data/mvp.db .dump > mvp_archive.sql`
- Note which rule parameters worked best (from daily_pnl data)
- Note which regime classification felt accurate vs actual market
- Carry these observations into SPEC.md parameter tuning

---

## APPENDIX — WHAT NOT TO BUILD IN MVP

```
✗ Docker / docker-compose      → not needed yet
✗ PostgreSQL                   → SQLite is sufficient
✗ JWT authentication           → no auth in MVP
✗ Cloudflare Tunnel            → localhost only
✗ Email alerts                 → console output is enough
✗ WebSocket server             → HTTP polling dashboard is fine
✗ Rule 7 (Drift hedge)         → skip entirely in MVP
✗ LiveExecutor                 → paper only
✗ RPC failover (3 nodes)       → single Helius endpoint
✗ State recovery on crash      → simple restart acceptable
✗ Multi-environment config     → always SHADOW mode
✗ Ledger hardware wallet       → no real signing needed
✗ Rate limiting                → not needed solo
✗ Playwright e2e tests         → unit tests only
✗ pnpm monorepo workspaces     → single flat package
✗ Redis                        → not needed
✗ Next.js dashboard            → plain HTML served by Express
```
