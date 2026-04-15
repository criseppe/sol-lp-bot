# SOL/USDC LP Bot — Codebase Reference

> **Last updated:** 2026-04-13  
> **Status:** Live on production. Running on Orca Whirlpool SOL/USDC pool.  
> **Capital:** Up to $10,000 USDC (configurable via `maxLiveCapitalUsdc`).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Map](#2-file-map)
3. [Data Flow](#3-data-flow)
4. [Decision Loop (main.ts)](#4-decision-loop-maints)
5. [Executor (live/executor.ts)](#5-executor-liveexecutorts)
6. [Config System](#6-config-system)
7. [Database Schema](#7-database-schema)
8. [Dashboard (output/dashboard.ts)](#8-dashboard-outputdashboardts)
9. [Market Data & TA (data/market.ts)](#9-market-data--ta-datamarketts)
10. [Regime Detection (engine/regime.ts)](#10-regime-detection-engineregimets)
11. [Cost Basis Tracking (tracking/costBasis.ts)](#11-cost-basis-tracking-trackingcostbasisstts)
12. [Swap System](#12-swap-system)
13. [Known Issues](#13-known-issues)
14. [Config Reference](#14-config-reference)
15. [Key Learnings](#15-key-learnings)

---

## 1. Architecture Overview

The bot is a Node.js/TypeScript process that manages a concentrated liquidity position on Orca Whirlpool (SOL/USDC, 0.04% fee tier). It runs a decision loop every 60 seconds (configurable), observing price from Pyth Network, computing regime from daily closes, and executing position open/close/harvest operations on-chain.

```
┌─────────────────────────────────────────────────────────────┐
│                         main.ts                             │
│                    (Decision Loop)                          │
│                                                             │
│  OracleService  →  PythPrice (every 2s)                     │
│  MarketData     →  CoinGecko OHLC + F&G (every 15min)       │
│  PoolService    →  Orca pool state (each cycle)             │
│                                                             │
│  detectRegimeEnhanced()  →  Regime (RANGING/BULLISH/        │
│                              BEARISH/EXTREME)               │
│  calcRange()             →  TickLower/TickUpper             │
│  calcProximity()         →  proxToLower/proxToUpper         │
│  checkAutoDeploy()       →  auto deploy idle capital        │
│                                                             │
│  LiveExecutor.openPosition()    → Orca open TX              │
│  LiveExecutor.closePosition()   → Orca close TX             │
│  LiveExecutor.collectFees()     → Orca harvest TX           │
│  LiveExecutor.increaseLiquidity()→ Orca add liquidity TX    │
│  executeSwap() via Jupiter/Orca → token swap TXs            │
│                                                             │
│  SQLite DB         →  state, history, config                │
│  Dashboard (Express)→  HTTP :3000                           │
│  Telegram reporter →  periodic alerts                       │
└─────────────────────────────────────────────────────────────┘
```

**State machine:**

```
IDLE → ACTIVE (open position)
ACTIVE → IDLE (close position)
ACTIVE → WAITING_PULLBACK (upside exit or OOR_ABOVE)
WAITING_PULLBACK → ACTIVE (pullback detected or timeout)
HALTED (circuit breaker; manual intervention required)
```

**Modes:** The bot only runs in **LIVE** mode (real wallet, real transactions). Paper trading mode was removed; `src/paper/ledger.ts` is kept for historical reference but unused in the main loop.

---

## 2. File Map

### Core Entry Point

| File | Purpose |
|------|---------|
| `src/main.ts` | Main entry point. Initialises all services, runs the decision loop, defines `runLiveCycle()`, `liveOpenPosition()`, `liveClosePosition()`, `liveCloseAndReopen()`. ~1750 lines. |

### Types & Constants

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/types.ts` | All shared TypeScript types | `Regime`, `BotState`, `EventType`, `PythPrice`, `PoolState`, `RegimeParams`, `RangeBounds`, `ProximityState`, `PaperPosition`, `CycleResult`, `RebalanceEvent` |
| `src/constants.ts` | Hardcoded constants (never from env) | `PROGRAM_IDS`, `MINTS`, `REGIME_PARAMS`, `JUPITER`, `RISK`, `REENTRY` |

### Configuration

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/config.ts` | Runtime config object, DB loader | `runtime` (mutable object), `applyConfigFromDb()`, `exportConfig()` |

### Data Services

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/data/oracle.ts` | Pyth price feed (Hermes polling every 2s) | `OracleService` class: `start()`, `getPrice()`, `stop()` |
| `src/data/market.ts` | CoinGecko + Fear&Greed (15min poll) | `MarketDataService` class: `start()`, `getSignals()`, `stop()`. `MarketSignals`, `TechnicalAnalysis`, `OHLCV` interfaces |
| `src/data/pool.ts` | Orca Whirlpool pool state | `PoolService` class: `fetchState()`, `getCurrentPrice()`, `priceToTick()`, `priceToTickLower()`, `priceToTickUpper()` |

### Decision Engine

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/engine/regime.ts` | Regime detection (daily closes + market signals) | `detectRegime()`, `detectRegimeWithMetrics()`, `detectRegimeEnhanced()`, `getRegimeParams()`, `stdDev()` |
| `src/engine/rules.ts` | Trading rules (range, proximity, re-entry, auto-deploy, IL) | `calcRange()`, `calcProximity()`, `shouldFireDownside()`, `shouldFireUpside()`, `shouldReenterAfterUpside()`, `isFlashCrash()`, `isHarvestDue()`, `checkAutoDeploy()`, `calcIL()` |
| `src/engine/var.ts` | VAR (Volatility-Adaptive Range) + SIR (Smart Idle Rebalancing) | `calculateVarParams()`, `shouldAdjustRange()`, `calculateIdleTarget()`, `shouldRebalanceIdle()`, `calculateSwapPnl()` |

### Live Execution

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/live/executor.ts` | Position lifecycle manager (open/close/harvest/add liquidity, fee math) | `LiveExecutor` class, `LivePosition` interface, `SwapEvent` interface |
| `src/live/swapper.ts` | Swap router: Jupiter-first with Orca fallback | `executeSwap()`, `SwapParams`, `SwapResult` |
| `src/live/jupiter.ts` | Jupiter V6 aggregator client | `getJupiterQuote()`, `executeJupiterSwap()` |
| `src/live/wallet.ts` | Wallet loading & balance fetching | `loadWallet()`, `getWalletBalances()`, `validateWalletForLive()` |

### Database

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/db/sqlite.ts` | All DB operations (SQLite via better-sqlite3) | `initDb()`, `insertPriceTick()`, `getDailyCloses()`, `insertRebalanceEvent()`, `getRebalanceEvents()`, `upsertBotState()`, `getBotState()`, `insertDecisionLog()`, `getDecisionLogs()`, `insertSwapLedger()`, `getConfig()`, `setConfig()`, `upsertDailySummary()`, and many more |

### Output & Reporting

| File | Purpose |
|------|---------|
| `src/output/dashboard.ts` | Express HTTP server (port 3000). Main dashboard, all API endpoints, pool stats fetcher. ~2000+ lines |
| `src/output/analytics-page.ts` | Analytics page HTML renderer |
| `src/output/investors-page.ts` | Investors page HTML renderer |
| `src/output/projection-page.ts` | Projection/forecast page HTML renderer |
| `src/output/reporter.ts` | Telegram report builder (formats message) |
| `src/output/telegram.ts` | Telegram bot reporter (polls on interval) |
| `src/output/terminal.ts` | Terminal display helpers (unused in live loop) |

### Tracking

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/tracking/costBasis.ts` | Weighted-average SOL cost basis tracking | `bootstrapCostBasis()`, `updateCostBasis()`, `readCostBasis()`, `CostBasisState` |

### Legacy (Not Used in Live Loop)

| File | Purpose |
|------|---------|
| `src/paper/ledger.ts` | Paper trading ledger (unused in production) |
| `src/utils.ts` | Misc utilities |

### Scripts

| File | Purpose |
|------|---------|
| `scripts/close-and-restart.ts` | Manual close + restart helper |
| `scripts/close-orphaned.ts` | Close orphaned on-chain positions |
| `scripts/restore-position.ts` | Manually restore position state in DB |
| `scripts/check-fees.ts` | Debug pending fees |
| `scripts/test-live.ts` | Connectivity/integration test |
| `scripts/read-gas.ts` | Read gas from recent transactions |

---

## 3. Data Flow

```
Pyth Hermes (https://hermes.pyth.network)
  └─ OracleService.fetchLatest() every 2s
       └─ validates staleness, confidence, sign
       └─ stores lastPrice: PythPrice

CoinGecko / alternative.me
  └─ MarketDataService.refresh() every 15min
       └─ fetchCoinGeckoOHLC(1)  → 30min candles → vol1h, TA
       └─ fetchCoinGeckoOHLC(7)  → 4h candles → vol4h
       └─ fetchSolMarketData()   → solDelta24h, volume24h
       └─ fetchBtcPrice()        → btcDelta24h
       └─ fetchVolumeRatio7d()   → volumeRatio4h
       └─ fetchFearGreed()       → fearGreedIndex
       └─ stores signals: MarketSignals

Decision Loop (every 60s via setInterval)
  ├─ reload config from DB (every 60s)
  ├─ price = oracle.getPrice()
  ├─ pool.fetchState()           → cached 10s
  ├─ runLiveCycle(price)
  │    ├─ regime update (hourly)
  │    │    └─ detectRegimeEnhanced(dailyCloses, mktSignals)
  │    │         → Regime + override reason + confidence
  │    ├─ apply VAR params (if varEnabled)
  │    │    └─ calculateVarParams(vol1h, solDelta24h)
  │    ├─ check forceReopen flag
  │    ├─ if no position → liveOpenPosition()
  │    ├─ if position exists:
  │    │    ├─ calcProximity() → proxToLower, proxToUpper
  │    │    ├─ Rule 2: shouldFireDownside/Upside → close/reopen
  │    │    ├─ if OOR_BELOW → closeAndReopen
  │    │    ├─ if OOR_ABOVE → close + enter pullback watch
  │    │    ├─ positionMaxAge check → closeAndReopen
  │    │    ├─ isHarvestDue → collectFees → convertHarvestedSol
  │    │    └─ checkAutoDeploy → increaseLiquidity (Rule 7)
  │    └─ idleRebalance (Rule 8)
  ├─ insertPriceTick()
  ├─ update dashboard data
  ├─ insertLiveSnapshot()
  └─ upsertBotState() (persist state)

LiveExecutor
  └─ openPosition()
       ├─ pool.getPool(IGNORE_CACHE) → fresh on-chain data
       ├─ initTickArrayForTicks → on-chain TX (if needed)
       ├─ pre-open swap (USDC→SOL if heavily imbalanced)
       ├─ increaseLiquidityQuoteByInputToken (SOL-constrained)
       ├─ whirlpool.openPosition → on-chain TX
       └─ stores currentPosition: LivePosition

  └─ closePosition()
       ├─ getPendingFees() → fee growth math
       ├─ getPositionComposition() → IL calc
       ├─ whirlpool.closePosition → on-chain TX(s)
       └─ clears currentPosition

  └─ collectFees()
       ├─ getPendingFees() → expected amounts
       └─ position.collectFees() → on-chain TX

  └─ doSwap(inputMint, outputMint, amountRaw, reason)
       └─ executeSwap() → Jupiter or Orca
       └─ fires onSwap callback → swap_ledger + cost basis

Dashboard (Express :3000)
  └─ GET / → main dashboard HTML (live)
  └─ GET /insights → insights page
  └─ GET /analytics → analytics page
  └─ GET /config → config editor
  └─ GET /strategy → strategy doc
  └─ GET /investors → investors page
  └─ GET /projection → projection page
  └─ GET /api/live → LiveData JSON
  └─ GET /api/analytics-data → snapshots, events, regime
  └─ POST /api/config → save config to DB
  └─ POST /api/control → pause/resume/harvest/close/emergency-stop
```

---

## 4. Decision Loop (main.ts)

The main loop runs every `runtime.decisionIntervalSeconds` seconds (default: 60s). When EXTREME regime is active, the loop effectively runs faster because the config can set a lower interval.

### Startup Sequence (lines 1–430)

1. Validate required env vars (`RPC_URL`, `PYTH_SOL_USD_FEED`, `WHIRLPOOL_ADDRESS`, `DB_PATH`, `WALLET_PRIVATE_KEY`)
2. Initialize DB (`initDb(DB_PATH)`)
3. Apply DB config overrides (`applyConfigFromDb(getConfig(db))`)
4. Create Solana `Connection` (commitment: `confirmed`)
5. Load wallet, check balances, validate against capital cap
6. Start `OracleService` (Hermes polling every 2s)
7. Start `MarketDataService` (CoinGecko polling every 15min)
8. Fetch initial pool state
9. Cold-start price history backfill (from BirdEye API) if <3 days in DB
10. Restore `LiveExecutor` gas stats from DB
11. Restore cost basis state (`bootstrapCostBasis()`)
12. Set up `onSwap` callback (swap ledger + cost basis updates)
13. Restore live position from DB (JSON in `bot_state.position_json`)
14. Scan for orphaned on-chain positions (closes them if found)
15. Wait for first valid Pyth price (timeout: 30s)
16. Start dashboard, Telegram reporter, weekly analysis agent timer

### `runLiveCycle(price)` — Called Every Cycle (line 878)

```
1. If HALTED → return immediately

2. Track recent prices array (last 10) for flash crash detection

3. Regime update (throttled to hourly):
   a. getDailyCloses(db, regimeWindowDays)
   b. detectRegimeEnhanced(closes, trendThreshold, mktSignals, enhancedConfig)
   c. Suppress change if <5 daily closes AND no market override AND no market confirmation
   d. Log REGIME_CHANGE or REGIME_EVAL to decision_log
   e. If changed: update liveRegime, insert regime_history, insert rebalance_events

4. Rebalance rate limit: liveRebalancesThisHour >= rebalanceLoopLimit → return

5. Build effective params from regime:
   - Start with runtime.regimeParams[liveRegime]
   - If varEnabled: overlay VAR thresholds + skew (NOT width — width is user-controlled)
   - If near S/R levels (TA): widen range 1.5x
   - If Bollinger squeeze (bbWidth < 0.8%): tighten range 10%
   - If RSI overbought (>70): skew more upside
   - If RSI oversold (<30): skew more downside

6. Check forceReopen DB flag → close current position if set

7. If no position:
   a. If livePullbackActive:
      - Check flash crash cooldown
      - isFlashCrash(recentPrices) → extend cooldown, reset peak
      - shouldReenterAfterUpside() → open if pullback% >= threshold OR timeout
      - Else: update peak price
   b. Else: liveOpenPosition(price, 'POSITION_OPENED')

8. If position exists:
   a. calcProximity() → prox object
   b. If in range AND rule2Enabled:
      - shouldFireDownside(prox, proxThresholdLower) → liveCloseAndReopen (T1_DOWNSIDE)
      - shouldFireUpside(prox, proxThresholdUpper) → liveClosePosition + enter pullback (T1_UPSIDE)
   c. Log HOLD every 30min
   d. If price < priceLower:
      - isFlashCrash → close without reopen, enter cooldown
      - Else → liveCloseAndReopen (OOR_BELOW)
   e. If price > priceUpper:
      - liveClosePosition + enter pullback (OOR_ABOVE)
   f. positionMaxAgeHours check → liveCloseAndReopen

9. Fee harvest (hourly check):
   - isHarvestDue → getPendingFees → if total ≥ $0.50: collectFees
   - convertHarvestedSol(fees, harvestSolConvertPct)

10. Auto-deploy (Rule 7, every autoDeployCheckMinutes if in-range):
    - getWalletBalances + getPositionComposition
    - checkAutoDeploy() → if shouldDeploy: increaseLiquidity(deployableUsdc)
    - Log AUTO_DEPLOY or DEPLOY_SKIP to decision_log

11. Idle wallet rebalance (Rule 8, every 30min or on regime change):
    - Smart sell DISABLED (if block at line 1401)
    - Compute idleSol, idleUsdc, idleTotal
    - Get targetSolPct for current regime
    - If abs(deviation) > idleRebalanceDeviationPct:
      - SOL→USDC: skip if price < cost basis (smart rebalance DISABLED — always skipped)
      - USDC→SOL: skip if price > cost basis AND deviation < 25%
    - doSwapPublic if threshold met

12. SIR (if sirEnabled — currently DISABLED):
    - calculateIdleTarget(price, width, skewDown, solDelta24h)
    - shouldRebalanceIdle → doSwapPublic
```

### `liveOpenPosition()` (line 1553)

1. Check TX backoff (exponential, up to 5min)
2. `calcRange(price, effectiveParams, priceToTick…)` → range bounds
3. Compute `deployUsdc` = `totalWalletUsdc * deployPct - reserves`
4. `liveExecutor.openPosition(range, price, regime, deployUsdc)`
5. Auto-enable auto-deploy if partial deposit (<50% of target)
6. Log to rebalance_events + decision_log
7. Smart sell activation code is `if (false)` — permanently disabled

### `liveClosePosition()` (line 1640)

1. Pre-close harvest: if pending fees > 0.001 SOL or 0.1 USDC → collectFees + convertHarvestedSol (100%)
2. Capture position ID before close
3. `liveExecutor.closePosition()`
4. **Immediately write IDLE state to DB** (crash-safe: prevents ghost positions)
5. Track SOL returned from close → `updateCostBasis()`
6. Accumulate cumFeesSol/cumFeesUsdc/realizedIL
7. Log to rebalance_events + decision_log

### `liveCloseAndReopen()` (line 1724)

1. `liveClosePosition()` → if fails, abort (do NOT reopen)
2. 2s delay
3. Re-check regime (may have changed during close)
4. `liveOpenPosition()` with reason referencing the original trigger

---

## 5. Executor (live/executor.ts)

`LiveExecutor` is the single class that owns the on-chain position state and all transaction execution.

### State

- `currentPosition: LivePosition | null` — in-memory position state (also persisted to DB)
- `onSwap: ((event: SwapEvent) => void) | null` — callback fired on every swap (set in main.ts)
- `shouldAllowSwap` — P&L guard callback (currently always returns `true` for auto-deploy)
- `cumGasLamports: number` — cumulative gas paid, persisted to DB
- `txCount: number` — total transaction count, persisted to DB

### `openPosition(range, currentPrice, regime, usdcToDeposit)` (line 152)

Key logic:

1. **Tick array init:** `initTickArrayForTicks([lower, upper])` → on-chain TX if arrays missing
2. **Tick array validation:** Check all 3 arrays (lower, upper, current tick) exist before open
3. **Pre-open swap:** Compute ideal SOL/USDC ratio for LP deposit. If wallet is USDC-heavy (solDeficit > 0.5 SOL AND > $50 AND deviation >20%), buy SOL with USDC. **NEVER sell SOL.**
4. **Deploy cap:** Cap available amounts at `usdcToDeposit / availableValue` ratio
5. **Liquidity quote:** `increaseLiquidityQuoteByInputToken` with SOL as input; fallback to USDC if SOL quote needs more USDC than available
6. **openPosition TX:** `whirlpool.openPosition(tickLower, tickUpper, quote)`
7. Stores full `LivePosition` including `entrySol`, `entryUsdc`, `entryPrice`, `entryTime`

### `closePosition()` (line 386)

1. Fetch `getPendingFees()` for attribution
2. Compute IL at close (`ilAtClose = ilPct * posValue`)
3. Validate + init tick arrays before close (same 0x1781 prevention)
4. `whirlpool.closePosition()` — may produce multiple TX builders
5. Execute each TX, clear `currentPosition` **only after all TXs succeed**

### `collectFees()` (line 482)

1. `getPendingFees()` → expected amounts (uses fee growth math, not balance delta)
2. `position.collectFees()` → on-chain TX
3. Returns expected amounts (not balance delta, which is skewed by gas)

### `convertHarvestedSol(solAmount, convertPct)` (line 514)

1. Check wallet SOL balance — keep `getSolReserve() + 0.01` minimum
2. Cap swap amount to available SOL above minimum
3. `doSwap(SOL → USDC, actualSwap * 1e9, reason)`
4. Fires `onSwap` callback

### `getPendingFees()` (line 610)

Uses **fee growth math** (u128 wrapping arithmetic matching on-chain program):
- Fetches tick arrays fresh (`IGNORE_CACHE`)
- Computes `feeGrowthInside` from global + outside accumulator values
- `feeOwed = (insideFeeGrowth - checkpoint) * liquidity / Q64 + feeOwedStored`
- Sanity check: if computed total > position value, falls back to stored `feeOwed` (handles overflow edge cases)

### `increaseLiquidity(currentPrice, maxDeployUsdc?)` (line 769)

Used for auto-deploy (Rule 7) and manual "Add Liquidity" from dashboard. Same pre-open swap logic as `openPosition`. Calls `position.increaseLiquidity(quote)`.

### `getEstimatedYield24h(dailyVolume?)` (line 687)

Estimates daily fees from liquidity share:
- `dailyFeesUsdc = liquidityShare * dailyVolume * feeRatePct`
- Uses Orca API 24h volume if available, else `$100M` fallback

### `execTx()` (line 68)

Private helper used for all Orca TXs:
- Retries once on blockhash/timeout/429 errors (3s delay)
- After success: fetches TX meta to get actual fee; falls back to 10000 lamports if fetch fails
- Increments `txCount` and `cumGasLamports`

---

## 6. Config System

### Loading Priority

```
hardcoded defaults (constants.ts)
  ↓ overridden by
env vars (parsed in main.ts lines 42-53)
  ↓ overridden by
DB config table (applyConfigFromDb called at startup + every 60s)
```

### `runtime` Object (`src/config.ts`)

The single mutable config object imported throughout the codebase. All fields are read by name. DB values validated against bounds before applying (rejected with warn log if out of range).

### Config Reload

`applyConfigFromDb(getConfig(db))` is called every **60 seconds** in the decision loop (line ~440). Previously 5 minutes, changed 2026-04-13.

### Regime Param Overrides

Each regime has 9 configurable params, stored in DB with keys like `regime.RANGING.rangeWidthPct`. These override `REGIME_PARAMS` in `constants.ts`.

### DB Config Keys

All values stored as strings in the `config` table. Key `flashCrashCooldownUntil` persists the flash crash end timestamp across restarts.

### Dashboard `/config` Page

Allows editing any config value via the web UI. Calls `POST /api/config` → `setConfigBatch(db, entries)`. Change takes effect on the next 60s config reload cycle.

---

## 7. Database Schema

Database: SQLite at path from `DB_PATH` env var. WAL mode, 5s busy timeout.

### `price_ticks`

Stores every price reading from the decision loop.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `timestamp` | INTEGER | Unix ms |
| `price` | REAL | SOL/USDC price |
| `confidence` | REAL | Pyth confidence |
| `regime` | TEXT | Regime at time |
| `prox_lower` | REAL | Nullable (not always computed) |
| `prox_upper` | REAL | Nullable |
| `in_range` | INTEGER | 0/1 |
| `source` | TEXT | 'live' or 'backfill' |

Pruned to 30 days (excluding backfill rows) once per day. Used by `getDailyCloses()` for regime detection.

### `rebalance_events`

Every significant decision event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `timestamp` | INTEGER | Unix ms |
| `event_type` | TEXT | See `EventType` enum |
| `price` | REAL | SOL price at event |
| `regime` | TEXT | Active regime |
| `note` | TEXT | Human-readable WHY + EXECUTED description |
| `sol_before/after` | REAL | Wallet SOL |
| `usdc_before/after` | REAL | Wallet USDC |
| `fee_sol/fee_usdc` | REAL | Fees collected (0 for non-harvest) |
| `il_at_close` | REAL | IL in USDC (0 for non-close) |
| `rule2_active` | INTEGER | Was Rule 2 enabled? (0/1) |
| `position_id` | TEXT | Position mint for per-position P&L |

EventTypes: `STARTUP`, `PRICE_UPDATE`, `REGIME_CHANGE`, `POSITION_OPENED`, `POSITION_CLOSED`, `T1_DOWNSIDE`, `T1_UPSIDE`, `OOR_BELOW`, `OOR_ABOVE`, `PULLBACK_REENTRY`, `PULLBACK_TIMEOUT`, `FEE_HARVEST`, `CIRCUIT_BREAKER`, `CYCLE_SKIP`, `LIQUIDITY_ADDED`, `AUTO_DEPLOY`

### `bot_state`

Single row (id=1) holding all persistent runtime state.

| Column | Type | Notes |
|--------|------|-------|
| `state` | TEXT | `BotState` enum |
| `regime` | TEXT | Current regime |
| `position_json` | TEXT | JSON of `LivePosition` or `'null'` |
| `cum_fees_sol/usdc` | REAL | Cumulative harvested fees |
| `realized_il` | REAL | Sum of IL from all closes |
| `tx_count` | INTEGER | Total transaction count |
| `cum_gas_lamports` | INTEGER | Total gas paid in lamports |
| `pullback_active` | INTEGER | 0/1 — restores WAITING_PULLBACK state |
| `pullback_peak` | REAL | Peak price when pullback started |
| `pullback_start` | INTEGER | Unix ms when pullback started |
| `last_harvest_time` | INTEGER | Unix ms of last fee harvest |
| `sol_cost_basis` | REAL | Weighted average SOL acquisition price |
| `sol_total_acquired` | REAL | Cumulative SOL acquired (all sources) |
| `sol_total_cost` | REAL | Cumulative USDC cost |
| `cost_basis_last_updated` | INTEGER | Unix ms |

### `daily_pnl`

One row per calendar day. Not the primary source for the dashboard (use `daily_summary`).

| Column | Type | Notes |
|--------|------|-------|
| `date` | TEXT | YYYY-MM-DD |
| `opening_value/closing_value` | REAL | Portfolio value at day open/close |
| `fees_sol/usdc` | REAL | Daily fees |
| `il_cost` | REAL | Daily IL |
| `net_pnl/net_pnl_pct` | REAL | Net P&L |
| `rebalances` | INTEGER | Rebalance count |
| `in_range_pct` | REAL | % of ticks in range |
| `regime` | TEXT | Dominant regime |

### `daily_summary`

**Primary authoritative fee source** for analytics/insights pages.

| Column | Type | Notes |
|--------|------|-------|
| `date` | TEXT PK | YYYY-MM-DD |
| `wallet_usdc` | REAL | Wallet value (SOL×price + USDC) |
| `position_usdc` | REAL | Position value |
| `total_usdc` | REAL | Total portfolio |
| `injected_usdc` | REAL | External deposits |
| `fees_earned_usdc` | REAL | Fees collected today |
| `cum_fees_usdc` | REAL | Cumulative fees |
| `portfolio_change` | REAL | Daily change |
| `sol_price` | REAL | End-of-day SOL price |
| `regime` | TEXT | Regime |
| `in_range_pct` | REAL | % of ticks in range |
| `updated_at` | INTEGER | Unix ms |

### `live_snapshots`

Inserted every cycle for portfolio tracking.

| Column | Type | Notes |
|--------|------|-------|
| `timestamp` | INTEGER | Unix ms |
| `price` | REAL | SOL price |
| `sol_balance/usdc_balance` | REAL | Wallet balances |
| `total_value_usdc` | REAL | Wallet total (without position) |
| `pending_fees_sol/usdc` | REAL | Uncollected fees |
| `cum_fees_sol/usdc` | REAL | All-time collected |
| `il_usdc` | REAL | Current unrealized IL |
| `in_range` | INTEGER | 0/1 |
| `regime` | TEXT | |
| `position_mint` | TEXT | Position NFT mint |
| `position_sol/usdc` | REAL | Composition |
| `position_value/total_with_position` | REAL | |

### `decision_log`

Every decision logged with reasoning.

| Column | Type | Notes |
|--------|------|-------|
| `timestamp` | INTEGER | Unix ms |
| `price` | REAL | |
| `regime` | TEXT | |
| `bot_state` | TEXT | |
| `prox_lower/upper` | REAL | Nullable |
| `in_range` | INTEGER | Nullable |
| `decision` | TEXT | e.g. `HOLD`, `REGIME_CHANGE`, `AUTO_DEPLOY`, `IDLE_REBALANCE` |
| `reasoning` | TEXT | Full human-readable explanation |
| `params_json` | TEXT | JSON of relevant params |

### `regime_history`

Every regime transition.

| Column | Type | Notes |
|--------|------|-------|
| `timestamp` | INTEGER | |
| `old_regime/new_regime` | TEXT | |
| `price` | REAL | |
| `dir_ratio/realised_vol` | REAL | Detection metrics |
| `price_count` | INTEGER | Daily closes used |

### `rule_toggles`

Feature flag store.

| Column | Type | Notes |
|--------|------|-------|
| `rule_name` | TEXT PK | e.g. `rule2`, `autoDeploy`, `analysisAgent` |
| `enabled` | INTEGER | 0/1 |
| `updated_at` | INTEGER | |

### `config`

Key-value config store. Overrides env/hardcoded defaults.

| Column | Type |
|--------|------|
| `key` | TEXT PK |
| `value` | TEXT |
| `updated_at` | INTEGER |

### `swap_ledger`

Every swap executed by the bot (added 2026-04-13).

| Column | Type | Notes |
|--------|------|-------|
| `timestamp` | INTEGER | |
| `direction` | TEXT | `buy_sol` or `sell_sol` |
| `sol_amount/usdc_amount` | REAL | |
| `price` | REAL | SOL price at swap |
| `reason` | TEXT | Why the swap was executed |
| `pnl_usdc` | REAL | P&L for sell swaps (null for buys) |
| `cost_basis_before/after` | REAL | Weighted-average basis |

### `investors`

Manual investor tracking.

| Column | Type |
|--------|------|
| `name` | TEXT |
| `amount_usdc` | REAL |
| `invest_date` | TEXT |

---

## 8. Dashboard (output/dashboard.ts)

Express server on `DASHBOARD_PORT` (default: 3000). Optional basic auth via `DASHBOARD_USER`/`DASHBOARD_PASS` env vars. All pages are mobile-responsive.

### Pages

| Route | Description |
|-------|-------------|
| `GET /` | Main live dashboard. Shows wallet balances, position details, pending/cumulative fees, IL, gas, regime, bot state, market signals, recent events, daily P&L chart. Controls: Pause/Resume, Harvest, Close Position, Add Liquidity, Emergency Stop, Rule 2 toggle, Auto-Deploy toggle. |
| `GET /insights` | Deep analytics. In-range %, decision log, regime history, recent transactions, fee timeline by day, daily summary table. |
| `GET /analytics` | Interactive charts: portfolio value, fees, regime changes, position composition, drawdown. Loads from `/api/analytics-data`. |
| `GET /config` | Config editor. All runtime.* fields editable with bounds validation. Regime params per-regime. Saves to DB. |
| `GET /strategy` | Strategy documentation page. |
| `GET /arcade` | Fun/experimental page. |
| `GET /investors` | Investor tracking. Shows NAV, share price, per-investor holdings. |
| `GET /projection` | Fee projection/forecast. |

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/data` | Recent events, daily P&L, bot state, uptime |
| `GET /api/live` | Full `LiveData` object (all live stats) |
| `GET /api/market-signals` | Current `MarketSignals` |
| `GET /api/analytics-data?days=N` | Snapshots, events, regime history, daily summaries (downsampled to 500 points) |
| `GET /api/decisions?limit=N` | Decision log entries |
| `GET /api/snapshots?hours=N` | Live snapshots |
| `GET /api/hourly-fees?date=YYYY-MM-DD` | Hourly fee breakdown + events for a day (scaled to match daily_summary total) |
| `GET /api/swap-ledger` | Last 50 swaps with P&L summary |
| `GET /api/regime-history` | Last 50 regime transitions |
| `GET /api/events` | Last 50 rebalance events |
| `GET /api/rule2-perf` | Rule 2 on/off performance comparison |
| `GET /api/rule2-events.csv` | CSV export of all events |
| `GET /api/export` | Full DB dump (all tables) |
| `GET /api/investors` | Investor list + total portfolio |
| `POST /api/investors` | Add investor |
| `DELETE /api/investors/:id` | Remove investor |
| `POST /api/config` | Save config to DB (batch) |
| `POST /api/control` | Actions: `pause`, `resume`, `harvest`, `close`, `emergency_stop`, `toggle_rule2`, `toggle_autodeploy`, `add_liquidity`, `add_liquidity_preview` |

### Pool Stats Fetch

Every 5 minutes, fetches `https://api.orca.so/v2/solana/pools/{WHIRLPOOL_ADDRESS}` for TVL, volume, fees, yield data. Used for `estDailyFeesUsdc` display and auto-deploy `increaseLiquidity` logic.

---

## 9. Market Data & TA (data/market.ts)

`MarketDataService` polls every 15 minutes. Falls back gracefully; individual failures only add to `errors[]`.

### Data Sources

| Source | Data | Endpoint |
|--------|------|---------|
| CoinGecko OHLC (1d) | 30min SOL candles (48 points) | `/coins/solana/ohlc?vs_currency=usd&days=1` |
| CoinGecko OHLC (7d) | 4h SOL candles (42 points) | `/coins/solana/ohlc?vs_currency=usd&days=7` |
| CoinGecko simple/price | SOL 24h delta + volume | `/simple/price?ids=solana...` |
| CoinGecko market_chart | 7d volume history for ratio | `/coins/solana/market_chart?vs_currency=usd&days=7` |
| CoinGecko simple/price | BTC 24h delta + price | `/simple/price?ids=bitcoin...` |
| alternative.me | Fear & Greed Index | `https://api.alternative.me/fng/` |

### Computed Signals

- `vol1h` — stddev of log returns from 30min closes (last ~24h)
- `vol4h` — stddev of log returns from 4h closes (last 7d)
- `solDelta24h` — (lastClose - firstClose) / firstClose × 100
- `volumeRatio4h` — latest 24h volume / 7d average volume
- `fearGreedIndex` — 0–100 (Extreme Fear / Fear / Neutral / Greed / Extreme Greed)

### Technical Analysis (from 30min candles)

Computed by `calcTA(candles: OHLCV[])`:

| Indicator | Formula | Signal |
|-----------|---------|--------|
| `rsi14` | Standard RSI(14) | >75 = overbought, <25 = oversold |
| `sma20` | Simple MA(20) periods (30min → 10h lookback) | Trend reference |
| `ema9` | Exponential MA(9) | Short-term trend |
| `trendDirection` | EMA9 vs SMA20: >0.1% = UP, <-0.1% = DOWN, else FLAT | Trend |
| `bbWidth` | (upper-lower)/middle × 100 | <1% = squeeze, >3% = expansion |
| `bbPosition` | (price-lower)/(upper-lower), clamped 0–1 | 0=at lower BB, 1=at upper BB |
| `atr14` | Avg True Range over 14 periods | Price volatility in $ |
| `support` | Min(low) of last 12 candles | Recent support |
| `resistance` | Max(high) of last 12 candles | Recent resistance |
| `priceVsSma` | (price-SMA20)/SMA20 × 100 | Mean reversion signal |

---

## 10. Regime Detection (engine/regime.ts)

### Base Regime from Daily Closes

`detectRegime(prices[], trendThreshold)` — uses **daily closing prices** only, oldest first, from `getDailyCloses(db, regimeWindowDays)`.

Logic:
1. `dirRatio = netMove / totalPath` (linearity of price path)
2. `realisedVol = stdDev(logReturns)` of daily closes
3. If `realisedVol > 0.08` → `EXTREME`
4. If `dirRatio > trendThreshold (0.35)`:
   - lastClose > firstClose → `BULLISH_TREND`
   - else → `BEARISH_TREND`
5. Else → `RANGING`
6. Default to `RANGING` if fewer than 3 prices

### Enhanced Regime Detection

`detectRegimeEnhanced(prices, trendThreshold, marketSignals, config)` — overlays market signals on top of base regime.

Override cascade (each can change regime):

| Step | Condition | Effect |
|------|-----------|--------|
| 1b | Base=EXTREME but vol4h < 80% of threshold | Downgrade to trend or RANGING |
| 1b | Base≠EXTREME but vol4h > threshold | Upgrade to EXTREME |
| 2 | vol1h > vol1hExtremeThreshold (0.06) | Force EXTREME |
| 3 | vol4h > threshold AND volumeRatio4h > spike multiple | Force EXTREME |
| 4 | abs(solDelta24h) > trendDeltaThreshold AND volume confirms | Force BULLISH/BEARISH |
| 5 | BTC move > btcCorrelationThreshold, same direction as SOL | confidence++ |
| 6 | fearGreedIndex < 25 + SOL dropping | Override RANGING→BEARISH |
| 6 | fearGreedIndex > 75, regime=BULLISH | confidence++ |
| 7 | Low volume + RANGING | confidence++ |
| 8 | RSI >75 + BULLISH | confidence-- (momentum fading) |
| 8 | Bollinger expansion + trend | Override RANGING→trend |
| 8 | Bollinger squeeze + RANGING | confidence++ |

**Suppression rule (main.ts line 928):** Regime change is suppressed if:
- Fewer than 5 daily closes AND
- No override reason AND
- No market signal confirmation

### Regime Params (constants.ts defaults)

| Param | RANGING | BULLISH | BEARISH | EXTREME |
|-------|---------|---------|---------|---------|
| `rangeWidthPct` | 1.5% | 3% | 2.5% | 6% |
| `skewDown` | 0.30 | 0.20 | 0.40 | 0.50 |
| `skewUp` | 0.70 | 0.80 | 0.60 | 0.50 |
| `proxThresholdLower` | 0.65 | 0.70 | 0.55 | 0.50 |
| `proxThresholdUpper` | 0.88 | 0.92 | 0.82 | 0.80 |
| `deployPct` | 1.00 | 0.85 | 0.75 | 0.25 |
| `solReentrySplit` | 0.50 | 0.50 | 0.30 | 0.20 |
| `harvestIntervalDays` | 7 | 4 | 2 | 1 |
| `harvestSolConvertPct` | 0.00 | 0.70 | 1.00 | 1.00 |

Note: These are hardcoded defaults. All are overridable via DB config keys like `regime.RANGING.rangeWidthPct`.

---

## 11. Cost Basis Tracking (tracking/costBasis.ts)

Tracks a **weighted-average SOL acquisition price** across all sources.

### Sources Tracked

1. USDC→SOL swaps (any reason: pre-open, idle rebalance, SIR, auto-deploy)
2. SOL returned from LP position closes (sol_after > sol_before in rebalance_events)

### State Storage

Stored in `bot_state` row: `sol_cost_basis`, `sol_total_acquired`, `sol_total_cost`, `cost_basis_last_updated`.

Also written via partial `UPDATE` (not INSERT OR REPLACE) to avoid clobbering unrelated fields.

### `bootstrapCostBasis(db)` — Startup

- If DB has non-zero `cost_basis_last_updated`: trust DB, return
- Else cold-start: query `swap_ledger` (buy_sol) + `rebalance_events` (LP closes with sol_after > sol_before) to reconstruct history
- Writes computed state to DB

### `updateCostBasis(db, newSolAmount, acquisitionPriceUsdc, source)` — On Acquisition

```
newTotalAcquired = current.solTotalAcquired + newSolAmount
newTotalCost = current.solTotalCost + newSolAmount * acquisitionPriceUsdc
newBasis = newTotalCost / newTotalAcquired
```

Called from:
- `main.ts onSwap callback` (buy_sol swaps)
- `liveClosePosition()` (SOL returned from LP close)
- `main.ts SIR rebalance` (buy_sol direction)

### Usage in Idle Rebalance

- SOL sell skipped if `price < cost basis` (prevents realized losses)
- SOL buy skipped if `price > cost basis AND deviation < 25%` (prevents buying tops)
- Exception: deviation > 25% always executes regardless of cost basis

---

## 12. Swap System

All swaps flow through `executeSwap()` in `swapper.ts`, called via `executor.doSwap()`.

### Swap Provider Strategy (`runtime.swapProvider`)

| Mode | Behavior |
|------|---------|
| `jupiter` | Jupiter V6 only |
| `orca` | Orca Whirlpool direct swap only |
| `jupiter-fallback` (default) | Try Jupiter; if fails, try Orca |

### Jupiter Integration (`live/jupiter.ts`)

- Quote: `GET https://api.jup.ag/swap/v1/quote`
- Swap: `POST https://api.jup.ag/swap/v1/swap`
- Timeout: 10s, 1 retry on 429/5xx
- TX: `wrapAndUnwrapSol: true`, `dynamicComputeUnitLimit: true`, `prioritizationFeeLamports: auto`
- Slippage: `runtime.swapSlippageBps` (default: 6 bps = 0.06%)

### Swap Functions and Their Status

| Function | File | Status | Trigger |
|----------|------|--------|---------|
| Pre-open swap (USDC→SOL) | `executor.ts:openPosition()` | **ACTIVE** (only buys SOL, never sells) | On position open when wallet is USDC-heavy |
| Auto-deploy swap | `executor.ts:increaseLiquidity()` | **ACTIVE** | Rule 7: idle capital deployment; `shouldAllowSwap` always returns `true` |
| Harvest SOL conversion | `executor.ts:convertHarvestedSol()` | **ACTIVE** | After fee harvest, converts % of SOL fees per regime's `harvestSolConvertPct` |
| Idle rebalance SOL sell | `main.ts:runLiveCycle()` | **EFFECTIVELY DISABLED** | Smart rebalance has `if (true)` skip for SOL sells (line 1401) |
| Idle rebalance USDC buy | `main.ts:runLiveCycle()` | **ACTIVE** (with cost basis guard) | Idle wallet USDC→SOL when deviation > 15% and price ≤ basis or deviation > 25% |
| SIR rebalance | `main.ts:runLiveCycle()` | **DISABLED** (`sirEnabled=false`) | Would swap based on 4h SOL delta; disabled after -$3.40 loss |
| Smart sell | `main.ts:liveOpenPosition()` | **DISABLED** (`if (false)`) | Would sell excess SOL after position open at mid-range price |
| Manual harvest SOL convert | `dashboard.ts onHarvest` | **ACTIVE** | Dashboard Harvest button |
| Manual add liquidity | `dashboard.ts onAddLiquidity` | **ACTIVE** | Dashboard Add Liquidity button |

### P&L Guards

- **Auto-deploy:** `shouldAllowSwap` always returns `true` — LP ratio swaps are necessary for deposit, not speculative
- **Idle rebalance SOL sell:** Always skipped (`if (true)` block at line 1401)
- **Idle rebalance USDC buy:** Only when `price <= basis` OR `deviation > 25%`

### Swap Ledger (`swap_ledger`)

Every swap via `onSwap` callback records: direction, amounts, price, reason, P&L (sell only), cost_basis before/after. Used in insights page "Swap P&L Tracker" card.

---

## 13. Known Issues

### Active Bugs

1. **Smart rebalance always skipped** (`main.ts` line 1401): `if (true)` permanently blocks SOL→USDC idle rebalance sells. Only USDC→SOL buys happen. Wallet can drift SOL-heavy over time. Workaround: manual harvest + "never sell SOL" principle.

2. **Tick array errors (0x1781/0x1782)**: Orca SDK fails when tick arrays aren't initialized. Handled by `initTickArrayForTicks` pre-call + validation step, but during RPC congestion the init TX can fail silently. Mitigation: exponential TX backoff (60s/120s/240s/300s).

3. **Swap ledger historical gap**: Swaps before 2026-04-12 not tracked. P&L totals are partial. `backfillSwapLedgerCostBasis()` reconstructs cost_basis values for existing rows but cannot add missing swap records.

4. **Cost basis reconciliation**: External SOL deposits not automatically tracked. Warning logged on startup if wallet > tracked × 1.05. Manual correction needed.

### Disabled Features

- **SIR (Smart Idle Rebalancing)**: `sirEnabled=false` after -$3.40 loss from 11 swaps. Over-traded idle wallet. Needs P&L-aware minimum profit threshold before re-enabling.

- **Smart sell**: `if (false)` in `liveOpenPosition()`. Would sell excess SOL above mid-range after position open. Disabled because selling SOL in downtrends consistently loses money.

- **VAR range adjustments**: VAR engine is active but does NOT close/reopen positions to change width. Width is user-controlled via config. VAR only influences proximity thresholds and skew.

### Technical Debt

- Paper trading mode (`src/paper/ledger.ts`) completely unused but not deleted
- `getDeployAmount()` in `rules.ts` is unused — deploy logic is inline in `main.ts`
- Pool stats TVL used for yield estimate fallback; Orca API URL is hardcoded to `api.orca.so/v2`
- `src/output/terminal.ts` unused in live loop
- `getHarvestFees()` / `EST_POOL_DAILY_VOLUME` constants in `rules.ts` are placeholder estimates (paper mode legacy), not used in live mode
- Dashboard HTML is rendered inline (multi-thousand-line template literals in dashboard.ts)

---

## 14. Config Reference

All values in `runtime` object, overridable via DB config table.

### Decision Loop

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `decisionIntervalSeconds` | 60 | 10–600 | Loop interval in seconds |
| `regimeWindowDays` | 7 | 1–30 | Days of daily closes for regime detection |
| `trendThreshold` | 0.35 | 0.05–0.95 | dirRatio threshold for trend vs ranging |
| `pythMaxConfidencePct` | 0.5 | 0.1–5 | Max Pyth confidence band (%) before rejecting price |
| `pythMaxStalenessSec` | 60 | 10–300 | Max age of Pyth price before rejecting |

### Capital & Reserves

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `maxLiveCapitalUsdc` | 5000 | 10–1M | Safety cap: rejects wallet if total value exceeds this |
| `solReserve` | 0.1 | 0.01–10 | Min SOL kept for gas (not deployed) |
| `usdcReserve` | 1 | 0–100 | Min USDC reserve |
| `minPositionSizeUsdc` | 100 | 1–10000 | Minimum position size |

### Auto Deploy (Rule 7)

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `autoDeployCheckMinutes` | 5 | 1–60 | How often to check idle capital |
| `autoDeployCooldownMinutes` | 30 | 1–1440 | Min time between auto-deploys |
| `minIdleUsdc` | 5 | 0.1–10000 | Min idle USDC to trigger |
| `minIdleSol` | 0.05 | 0.001–100 | Min idle SOL to trigger |
| `minDeployUsdc` | 10 | 1–10000 | Min deploy amount |
| `deployRatioTolerance` | 0.02 | 0.001–0.5 | Max price deviation from range midpoint |

### Re-entry (Rule 3)

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `pullbackThresholdPct` | 2.5 | 0.1–20 | % pullback from peak to re-enter |
| `timeoutHours` | 4 | 0.05–48 | Hours to wait before forced re-entry |
| `flashCrashPct` | 5 | 1–30 | Peak-to-trough % drop = flash crash |
| `flashCrashWaitMinutes` | 15 | 1–120 | Cooldown after flash crash before re-entry |

### Circuit Breakers

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `dailyLossLimitPct` | 5 | 1–50 | Max daily loss % before HALTED |
| `weeklyDrawdownLimitPct` | 15 | 1–80 | Max weekly drawdown % |
| `maxIlPct` | 8 | 1–50 | Max IL % before HALTED |
| `rebalanceLoopLimit` | 10 | 1–100 | Max rebalances per hour |

### Swap Config

| Key | Default | Bounds | Description |
|-----|---------|--------|-------------|
| `swapSlippageBps` | 6 | 10–500 | Slippage tolerance in basis points |
| `swapBufferPct` | 3 | 0–10 | Over-request % buffer on swap amounts |
| `swapProvider` | `jupiter-fallback` | enum | `jupiter` / `orca` / `jupiter-fallback` |

### Position Lifecycle

| Key | Default | Description |
|-----|---------|-------------|
| `positionMaxAgeHours` | 0 | Rebalance when position older than this (0 = disabled) |
| `rangeWidthOverride` | null | Override regime width; null = use regime default |

### Idle Wallet Rebalance (Rule 8)

| Key | Default | Description |
|-----|---------|-------------|
| `idleRebalanceEnabled` | true | Master switch |
| `idleRebalanceMinUsdc` | 100 | Min idle value ($) to trigger |
| `idleRebalanceSolKeep` | 0.15 | Always keep this much SOL for gas |
| `idleRebalanceDeviationPct` | 0.15 | Trigger only if >15% off target |
| `idleTargetSolPctRanging` | 0.50 | 50% SOL target when RANGING |
| `idleTargetSolPctBullish` | 0.60 | 60% SOL target when BULLISH |
| `idleTargetSolPctBearish` | 0.35 | 35% SOL target when BEARISH |
| `idleTargetSolPctExtreme` | 0.15 | 15% SOL target when EXTREME |

### VAR (Volatility-Adaptive Range)

| Key | Default | Description |
|-----|---------|-------------|
| `varEnabled` | false | Master switch |
| `varMultiplier` | 3.0 | `k` in `width = k * vol1h * sqrt(hours)` |
| `varTargetHours` | 2 | Target hold duration in hours |
| `varMinWidth` | 1.0 | Minimum range width % |
| `varMaxWidth` | 6.0 | Maximum range width % |
| `varAdjustThreshold` | 0.30 | Width deviation % to trigger change |
| `varMinAge` | 15 | Min position age (min) before adjusting |
| `varCooldown` | 10 | Min minutes between adjustments |

Note: VAR does NOT close/reopen positions to change width. Width is user-controlled; VAR only adjusts proximity thresholds and skew.

### SIR (Smart Idle Rebalancing)

| Key | Default | Description |
|-----|---------|-------------|
| `sirEnabled` | false | Master switch (currently DISABLED) |
| `sirCooldownMinutes` | 5 | |
| `sirTriggerThreshold` | 0.08 | Deviation % to trigger |
| `sirMinSwapUsdc` | 20 | Min swap size |
| `sirTrendMultiplier` | 0.05 | Trend bias weight |
| `sirMaxSolPct` | 0.75 | Max SOL % allowed |
| `sirMinSolPct` | 0.15 | Min SOL % allowed |

### Enhanced Regime Detection

| Key | Default | Description |
|-----|---------|-------------|
| `useEnhancedRegime` | true | Use market signals for regime override |
| `vol1hExtremeThreshold` | 0.06 | 1h vol above this → EXTREME |
| `vol4hExtremeThreshold` | 0.05 | 4h vol above this (+ volume spike) → EXTREME |
| `volumeSpikeMultiple` | 3 | Volume ratio above this = spike |
| `trendDeltaThreshold` | 4 | SOL 24h delta % above this → trend |
| `btcCorrelationThreshold` | 3 | BTC 24h delta % threshold for correlation |
| `fearGreedExtremeLow` | 25 | F&G below this = extreme fear |
| `fearGreedExtremeHigh` | 75 | F&G above this = extreme greed |

### Regime Params (per regime, 9 params each)

Keys in format `regime.{REGIME}.{PARAM}` where REGIME ∈ {RANGING, BULLISH_TREND, BEARISH_TREND, EXTREME} and PARAM ∈ {rangeWidthPct, skewDown, skewUp, proxThresholdLower, proxThresholdUpper, deployPct, solReentrySplit, harvestIntervalDays, harvestSolConvertPct}.

---

## 15. Key Learnings

### Never Sell SOL (Most Important)

Selling SOL in downtrends is the single largest source of losses. When price falls below the LP range, the position is already 100% SOL. Selling that SOL to rebalance the idle wallet locks in losses. The bot now has multiple hard guards:

- Pre-open swap: only buys SOL (USDC→SOL), never sells SOL
- Idle rebalance SOL sell: permanently disabled (`if (true)` skip)
- Smart sell: permanently disabled (`if (false)`)
- SIR disabled after -$3.40 loss from over-trading

**Rule:** Hold SOL. Wait for recovery. Deploy into position when price stabilizes.

### Swap Costs Are Significant

Each swap costs ~$0.10–0.30 in slippage + gas. On a $300 position, this is 0.03–0.1% per swap. At 1-2 swaps per rebalance, a position that rebalances 10× costs more in swap losses than it earns in fees.

Key metrics from production:
- Protocol fee (0.06% slippage): significant on large swaps
- Gas: ~$0.001 per TX (negligible)
- Over-trading cost: SIR had -$3.40 over 11 swaps (about -$0.31/swap net loss)

**Rule:** Never swap unless strictly necessary. The LP deposit swap on reopen is unavoidable; idle rebalance swaps are optional and often costly.

### Position Churn Is the Enemy

Each close+reopen costs:
1. Orca position close: 2–3 TXs
2. Orca position open: 2–3 TXs
3. Pre-open swap (if needed): 1 TX
4. Total slippage: 0.06% of capital per swap direction

At $500 capital, a close+reopen costs ~$1.50 in slippage + $0.01 gas = ~$1.51. You need to earn that back before the next rebalance.

**Rule:** Don't rebalance until clearly needed. The 65%/88% proximity thresholds balance IL protection against churn cost.

### Skew Is Critical

Asymmetric range with more upside room (e.g., 30% down / 70% up in RANGING) means:
- Less IL exposure on upside moves (price rising = good for SOL holders)
- More IL exposure on downside moves (price falling = fee income compensates)
- Higher probability of staying in range during bull markets

**Rule:** Skew ranges with more room in the direction of regime momentum.

### Tight Ranges Earn More When In Range

A 1.5% range earns ~3-5× more fees per dollar deployed than a 3% range at the same liquidity depth. The tradeoff is more frequent out-of-range events.

From production (2026-04-13): 1.5% range earned $84+ fees in one day vs $30 the previous day with wider ranges.

**Rule:** Use the tightest range consistent with staying in range >80% of the time for the current regime's volatility. The VAR formula `width = 3.0 × vol1h × sqrt(2h) × 100` gives a data-driven target.

### Daily Close Regime vs Intraday Signals

The base regime uses 7 daily closing prices. With only 2-3 closes, the regime can flip spuriously. The enhanced detection fixes this by using 4h/1h volatility from CoinGecko (42+ data points) to either confirm or override the sparse daily signal.

**Rule:** Trust `vol4h` more than `realisedVol` from daily closes when data is sparse.

### Cost Basis Matters for Swap Decisions

Selling SOL below cost basis always realizes a loss. The cost basis tracking system (weighted average) provides the reference price for every idle rebalance decision. If the current price is significantly below basis, selling SOL destroys value even if it "rebalances" the portfolio ratio.

**Rule:** Track SOL cost basis. Only sell when price ≥ basis (or when deviation is so extreme you must sell regardless).

### Auto-Deploy Is Safe; SIR Is Not

Auto-deploy (adding liquidity to existing position) is safe because:
1. The SOL being swapped is going INTO the LP, not being sold for USDC
2. The LP earns fees that amortize swap costs within hours
3. The swap is LP-ratio-matching, not speculative

SIR (idle rebalancing between market cycles) is unsafe because:
1. It sells/buys SOL based on short-term price trends
2. Each swap has unavoidable slippage + gas costs
3. Over-trading amplifies losses in volatile markets

**Rule:** Deploy idle capital INTO the LP aggressively. Don't trade idle SOL for USDC speculatively.

---

*Reference generated 2026-04-13 from live source code. For latest values, always query DB config: `SELECT key, value FROM config ORDER BY key;`*
