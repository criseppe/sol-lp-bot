# SOL/USDC LP Bot — Complete Logic Reference

**Version:** Day 5 (April 16 2026) — Commit `9a970c1`
**Sources:** `src/constants.ts`, `src/config.ts`, `src/engine/regime.ts`, `src/engine/rules.ts`, `src/reserve/reserveManager.ts`, `src/live/executor.ts`, `src/main.ts`, live DB config table.

---

## 1. OVERVIEW

An Orca Whirlpool concentrated-LP bot that keeps one SOL/USDC position open on the 0.04% pool, harvesting fees while avoiding impermanent-loss blowups.

**Capital flow:**
1. Wallet holds SOL + USDC. `maxLiveCapitalUsdc = $20,000` (DB) caps how much the bot may manage.
2. Each cycle the bot computes a regime, chooses a range, and keeps the position inside that range.
3. LP fees accrue on-chain. They are harvested on a regime-dependent cadence and split between a USDC reserve floor and compounded deposits.
4. Idle wallet capital above the reserve floor is auto-deployed into the current position (Rule 7) or idle-rebalanced to a regime-specific SOL/USDC split.

**Core loop (`runLiveCycle`, `src/main.ts:1309`):**
- Default cadence: **60 s** (`decisionIntervalSeconds`, tightens to 30 s when regime = EXTREME).
- Regime re-evaluated every **120 s** (`regimeCheckIntervalMs`).
- Each cycle: regime detect → gates (Reserve/Basis/Churn) → position open/close/hold → auto-deploy → SOL-convert → idle rebalance → SIR (if enabled) → persist state.

---

## 2. REGIME DETECTION

Detection runs in two layers. When technical-analysis data is available (normal path), **TA-first** (`detectRegimeTA`) is primary and the daily-closes regime acts only as a veto. When TA is unavailable, `detectRegimeEnhanced` is used as a fallback.

### 2.1 Base Regime — Daily Closes (`detectRegime`, `src/engine/regime.ts:44`)

Inputs: array of daily closing prices (at least 3, else defaults to RANGING).

```
netMove   = |prices[last] − prices[0]|
totalPath = Σ |prices[i] − prices[i-1]|
dirRatio  = netMove / totalPath

logReturns = log(prices[i] / prices[i-1])
realisedVol = stdDev(logReturns)
```

Classification:
| Condition | Regime |
|---|---|
| `!isFinite(vol)` or `vol > 0.08` | EXTREME |
| `dirRatio > trendThreshold` (0.35) and last > first | BULLISH_TREND |
| `dirRatio > trendThreshold` (0.35) and last < first | BEARISH_TREND |
| otherwise | RANGING |

**Cold-start backfill** (`src/main.ts:202–220`): on boot, if DB has fewer than 3 daily closes, the bot fetches 8 days of SOL 1D OHLCV from Birdeye's public API and persists them. If the call fails, the bot defaults to RANGING and warns.

### 2.2 TA-First Regime (`detectRegimeTA`, `src/engine/regime.ts:293`)

A weighted vote across TA indicators. Max score 7 (voting structure: 2+2+1+1 + market bonus).

**TA voters (from `TechnicalAnalysis` signals):**

| Signal | Condition | Points | Regime |
|---|---|---|---|
| EMA9 vs SMA20 trend | `trendDirection = 'UP'` (EMA9 > SMA20 × 1.001) | +2 | BULLISH_TREND |
|  | `trendDirection = 'DOWN'` (EMA9 < SMA20 × 0.999) | +2 | BEARISH_TREND |
|  | `trendDirection = 'FLAT'` | +2 | RANGING |
| BB Width | `bbWidth < 1.5%` | +2 | RANGING |
|  | `1.5% ≤ bbWidth ≤ 3.0%` | +1 trend, +1 RANGING | trend+RANGING |
|  | `bbWidth > 3.0%` | +2 | EXTREME |
| RSI-14 | `62 ≤ rsi ≤ 75` | +1 | BULLISH_TREND |
|  | `25 ≤ rsi ≤ 38` | +1 | BEARISH_TREND |
|  | `38 < rsi < 62` (neutral zone) | +1 | RANGING |
|  | `rsi > 75` or `rsi < 25` | +1 | EXTREME |
| ATR-14 | `atr > $0.60` | +1 | EXTREME |
|  | `$0.30 ≤ atr ≤ $0.60` | +1 | current trend |
|  | `atr < $0.30` | +1 | RANGING |

**Market-signal overrides / boosts** (`src/engine/regime.ts:394–427`):
- `vol1h > 0.06` → hard override to EXTREME.
- `|solDelta24h| > 4%` + `volumeRatio4h > 2x` → +2 BULLISH or BEARISH.
- Fear & Greed `< 15` → +1 BEARISH; `> 75` → +1 BULLISH.

**BB-position penalty** (`regime.ts:430–435`): if `bbPosition > 0.85` or `< 0.15`, subtract 1 from all non-RANGING winners before tie-break.

**Daily-regime veto (Layer 1, `regime.ts:458–474`):**
- If daily = BEARISH and TA candidate = BULLISH → force RANGING.
- If daily = BULLISH and TA candidate = BEARISH → force RANGING.
- EXTREME is never vetoed.

**Hysteresis (`regime.ts:476–504`):**
- EXTREME commits immediately (1 cycle).
- Score ≥ 6 without veto commits immediately.
- Same candidate for 3 consecutive cycles commits; otherwise the previous regime is held.

**Confidence & deploy multiplier (`regime.ts:506–523`):**
| Situation | Confidence | `deployMultiplier` |
|---|---|---|
| Veto fired | LOW | 0.50 |
| adjustedScore ≥ 4 | HIGH | 1.00 |
| adjustedScore ≥ 2 | MEDIUM | 0.75 |
| adjustedScore < 2 | LOW | 0.50 |

The multiplier scales `params.deployPct` downstream — a LOW-confidence RANGING regime deploys only 50% of the regime's nominal deploy cap.

### 2.3 Regime Parameters

Defaults live in `REGIME_PARAMS` (`src/constants.ts:14–79`). DB overrides are applied via `applyConfigFromDb` (`src/config.ts:156`). Active values as of 2026-04-16:

| Parameter | RANGING | BULLISH_TREND | BEARISH_TREND | EXTREME |
|---|---|---|---|---|
| `rangeWidthPct` | **2.0** (DB) | **3.5** (DB) | **2.5** (DB) | 5.0 |
| `skewDown` | 0.30 | 0.25 | 0.45 | 0.50 |
| `skewUp` | 0.70 | 0.75 | 0.55 | 0.50 |
| `proxThresholdLower` | 0.65 | 0.72 | 0.55 | 0.50 |
| `proxThresholdUpper` | 0.88 | 0.92 | 0.82 | 0.80 |
| `deployPct` | 1.00 | 0.85 | 0.75 | 0.25 |
| `solReentrySplit` | 0.50 | 0.50 | 0.30 | 0.20 |
| `harvestIntervalDays` | 7 | 4 | 2 | 1 |
| `harvestSolConvertPct` | 0.50 | 0.70 | 1.00 | 1.00 |
| `usdcDepositPct` | 0.35 | 0.30 | 0.40 | 0.50 |
| `deployRatioTolerance` | 0.020 | 0.035 | 0.030 | 0.050 |
| `basisGateThreshold` | 0.995 | 0.995 | 0.992 | 0.995 |
| `proximityDeployThreshold` | 0.40 | 0.55 | 0.55 | 0.40 |
| `reserveFloorPct` | 0.10 | 0.12 | 0.18 | 0.20 |

Idle-rebalance SOL targets (not in `REGIME_PARAMS` — config.ts):
| Regime | `idleTargetSolPct` |
|---|---|
| RANGING | 0.50 |
| BULLISH_TREND | 0.55 |
| BEARISH_TREND | 0.35 |
| EXTREME | 0.25 |

---

## 3. POSITION LIFECYCLE

### 3.1 State Machine

States (`BotState` in `src/types.ts`): `IDLE`, `ACTIVE`, `HALTED`.

```
           open gates pass
IDLE ───────────────────────▶ ACTIVE
  ▲                              │
  │   close (any exit type)      │
  └──────────────────────────────┘
```

> Day 5 change: `WAITING_PULLBACK` has been removed. After T1_UPSIDE or OOR_ABOVE the bot goes straight to IDLE and relies on the **upside churn cooldown** (5 min) plus a **post-upside centre offset** on re-entry. See §3.2 Gate 3b and §3.3.

### 3.2 Position Open — Gate Sequence

All four gates must pass. Used at `main.ts:1636–1687` (fresh open) and `main.ts:2560–2603` (close-and-reopen). Regime reopen (§6) skips the ChurnGuards but still runs Reserve + Basis.

**Gate 1: ReserveGate** (`reserveManager.ts:148`)
```
usdcNeeded = totalPortfolio × deployPct × taDeployMultiplier × usdcDepositPct
             (e.g. $20,000 × 1.00 × 1.00 × 0.35 = $7,000 in RANGING)
```
- state = EMPTY → **block** (needs manual seed).
- state = REFILLING → **allow** iff `walletTotalUsdc ≥ usdcNeeded` and `reserve > 0`.
- state = FULL → **allow**.

**Gate 2: BasisGate** (`main.ts:1650–1659`)
```
threshold = solCostBasis × basisGateThreshold
block if price < threshold
```
Example (RANGING, basis $84.70, threshold 0.995): blocks opens when price < $84.28.

**Gate 3: Downside ChurnGuard** (`main.ts:1660–1674`)
Reads most recent `T1_DOWNSIDE`/`OOR_BELOW` row from `decision_log`.
```
exitAgeMin = (now - lastExit.timestamp) / 60_000
block if exitAgeMin < 15 AND price < lastExit.price   (15-min cooldown after downside)
block if price < lastExit.price AND exitAgeMin < 20   (secondary guard up to 20 min)
```

**Gate 3b: Upside ChurnGuard** (`main.ts:1675–1684`, Day 5)
```
minsSinceUpside = (now - lastUpsideExitTs) / 60_000
block if minsSinceUpside < upsideChurnCooldownMin (default 5)
```
Uses in-memory `lastUpsideExitTs` (persisted to `bot_state`).

**Passing example (RANGING, price $84.50):**
- Wallet: 7 SOL + $14,000 USDC → `totalPortfolio = $14,591.50`. Deploy target $14,591.50 → `usdcNeeded = $5,107`. Reserve FULL, floor $1,459. Wallet USDC $14,000 ≫ usdcNeeded → **Reserve PASS**.
- Basis $84.70 × 0.995 = $84.27; price $84.50 ≥ threshold → **Basis PASS**.
- No exit in last 20 min → **Downside churn PASS**.
- No upside exit in last 5 min → **Upside churn PASS**.

**Blocked example:** price $83.90, last upside exit 3 min ago at $85.70 → Upside churn blocks for 2 more minutes.

### 3.3 Range Calculation (`calcRange`, `src/engine/rules.ts:27`)

```
lower = centrePrice × (1 − (rangeWidthPct / 100) × skewDown)
upper = centrePrice × (1 + (rangeWidthPct / 100) × skewUp)
```
Ticks rounded via `priceToTickLower` / `priceToTickUpper`.

Examples at price $85.00 (using **active DB widths**):

| Regime | Width | SkewDown/Up | Lower | Upper |
|---|---|---|---|---|
| RANGING | 2.0% | 0.30 / 0.70 | 84.49 | 86.19 |
| BULLISH_TREND | 3.5% | 0.25 / 0.75 | 84.26 | 87.23 |
| BEARISH_TREND | 2.5% | 0.45 / 0.55 | 84.04 | 86.17 |
| EXTREME | 5.0% | 0.50 / 0.50 | 82.88 | 87.13 |

**Post-upside centre offset** (Day 5, `main.ts:2326–2344`):
If `minsSinceUpside < 30`, `centrePrice` shifts by:

| Regime | Offset (from `postUpsideOffset*`) |
|---|---|
| RANGING | −0.5% |
| BULLISH_TREND | 0.0% |
| BEARISH_TREND | −1.0% |
| EXTREME | −0.5% |

Example: RANGING upside exit at $85.70, re-entry 4 min later at $85.70. Centre = $85.70 × (1 − 0.005) = $85.27 → range $84.75 – $86.47 (shifted downward vs. a non-offset range of $85.19 – $86.90).

### 3.4 Pre-Open Swap (`executor.ts:219–296`)

Runs inside `openPosition` before the LP deposit.

1. Simulate the LP ratio at the chosen tick range (USDC per 1 SOL).
2. Compute `idealSol` and `idealUsdc` for the full `deployTarget`.
3. Compute deficits: `solDeficit = idealSol − solAvailable`, `usdcDeficit = idealUsdc − usdcAvailable`.

**Rules:**
- **Never sell SOL in pre-open.** SOL-heavy wallets deposit SOL-constrained; the excess SOL stays idle. A `shadow_sell` alert fires if the wallet would be profitable to sell (monitoring only).
- **USDC-heavy → partial buy** (Day 5 safety):
  ```
  fullSwapUsdc         = solDeficit × price × 0.95
  effectiveFloor       = reserveFloor × floorMultiplier   // 1.0 normally, 0.5 post-upside
  usdcAvailableForSwap = max(0, walletUsdc − idealUsdc − effectiveFloor)
  hardCap              = max(0, usdcAvailable − 2)
  usdcToSwap           = min(fullSwapUsdc, usdcAvailableForSwap, hardCap)
  ```
  If `usdcToSwap < $50`, the swap is skipped and the bot deposits with the current ratio (a `floor_check_blocked` alert fires).
- Triggered only when `solDeficit > 0.5`, `solDeficit × price > $50`, and deviation from ideal > 20%.

**Post-upside example** (Day 5 scenario): wallet 7 SOL + $16,344 USDC, price $85.70, regime RANGING, `reserveFloor = $2,000`. `floorMultiplier = 0.5` → `effectiveFloor = $1,000`. `idealSol ≈ 9.5 SOL`, `idealUsdc ≈ $5,300`. `solDeficit ≈ 2.5 SOL × $85.70 = $214`. `usdcAvailableForSwap = $16,344 − $5,300 − $1,000 = $10,044`. `fullSwapUsdc = $214 × 0.95 ≈ $203` → full buy of ≈ 2.37 SOL, resulting wallet ≈ 9.37 SOL + $16,141 USDC (floor preserved at $1,000).

### 3.5 Position Close (`liveClosePosition`, `main.ts:2420`)

Trigger types (`EventType`):
- `T1_DOWNSIDE` — `proxToLower ≥ proxThresholdLower`.
- `T1_UPSIDE` — `proxToUpper ≥ proxThresholdUpper`.
- `OOR_BELOW` — price exits below lower tick.
- `OOR_ABOVE` — price exits above upper tick.
- `POSITION_CLOSED` — manual close, regime-reopen, or force-reopen flag.
- `MAX_AGE` — `positionMaxAgeHours` reached (currently `0` = disabled).

**Pre-close harvest** (Day 5, `main.ts:2423–2471`): if `pendingFees ≥ $0.50`, collect fees first, route USDC via `routeHarvest`, convert SOL fee income per regime policy (never blocked by `shouldAllowSwap` — LP fee SOL has zero cost basis).

**Close sequence:**
1. Pre-close harvest (above).
2. `closePosition()` — withdraw liquidity, burn position NFT, receive SOL + USDC.
3. Clear `position_json` in DB **immediately** so a crashed subsequent step can't leave a ghost row.
4. Update `costBasis` with the returning SOL as a new acquisition at current price.
5. Record `rebalance_events` and `decision_log` rows with fee + IL detail.

---

## 4. EXIT RULES IN DETAIL

### 4.1 T1_DOWNSIDE (`calcProximity`, `shouldFireDownside`)

```
centre     = (priceLower + priceUpper) / 2
halfWidth  = (priceUpper − priceLower) / 2
proxToLower = max(0, (centre − price) / halfWidth)
fire if proxToLower ≥ proxThresholdLower
```

**Example (RANGING, range $84.00 – $85.70):** centre $84.85, halfWidth $0.85. At price $84.28, `proxToLower = 0.67` > threshold 0.65 → fires. Exit price ≈ $84.25 (65% = $84.30).

### 4.2 T1_UPSIDE (`shouldFireUpside`)

```
proxToUpper = max(0, (price − centre) / halfWidth)
fire if proxToUpper ≥ proxThresholdUpper
```

| Regime | Upper threshold | Trigger price (range $84.00 – $85.70, centre $84.85) |
|---|---|---|
| RANGING | 0.88 | $85.60 |
| BULLISH_TREND | 0.92 | $85.63 |
| BEARISH_TREND | 0.82 | $85.55 |
| EXTREME | 0.80 | $85.53 |

### 4.3 OOR_ABOVE / OOR_BELOW (`main.ts:1734–1766`)

Fires when price leaves the tick range entirely. OOR_BELOW with a flash crash (`isFlashCrash`, ≥ 5% peak-to-trough over last 10 cycles) triggers a **FLASH_CRASH_COOLDOWN** for `flashCrashWaitMinutes` (15 min) — close without reopen.

### 4.4 Post-Exit Behaviour (Day 5)

**After T1_UPSIDE or OOR_ABOVE** (`main.ts:1710–1765`):
- Transition straight to `IDLE` (no `WAITING_PULLBACK`).
- Persist `lastUpsideExitPrice`, `lastUpsideExitTs`.
- Upside ChurnGuard blocks re-open for `upsideChurnCooldownMin = 5` minutes.
- Next open applies:
  - Post-upside centre offset (§3.3).
  - `deployPct` overridden to **100%** (`main.ts:2347–2350`) so the bot can re-deploy USDC received from the close even if the regime cap would be 85%/75%.
  - Pre-open partial SOL buy with relaxed floor (`effectiveFloor = reserveFloor × 0.5`).

**After T1_DOWNSIDE or OOR_BELOW** (`liveCloseAndReopen`, `main.ts:2537+`):
- Same close routine, then gates run again.
- Downside ChurnGuard 15–20 min cooldown blocks reopen while price remains below the exit price.
- Normal re-entry at current price with full gate checks.

---

## 5. AUTO-DEPLOY (Rule 7, `checkAutoDeploy`, `rules.ts:167`)

Runs every `autoDeployCheckIntervalSec = 10 s` when a position is active and in range.

```
solReserve    = runtime.solReserve (0.10)           // SOL kept for gas
idleSol       = max(0, walletSol − solReserve)
idleUsdcRaw   = max(0, walletUsdc − reserveFloor)
idleUsdc      = idleSol × price + idleUsdcRaw       // USDC-denominated idle total

totalValue    = idleUsdc + positionValueUsdc
maxDeployUsdc = totalValue × deployPct
headroom      = maxDeployUsdc − positionValueUsdc
deployableUsdc = min(idleUsdc, max(0, headroom))
```

**Blocking conditions:**
1. `enabled = false` → DEPLOY_SKIPPED_DISABLED.
2. `regime = EXTREME` → DEPLOY_SKIPPED_REGIME.
3. `idleSol < 0.25 AND idleUsdcRaw < $25` → DEPLOY_SKIPPED_LOW_IDLE.
4. `minSinceLast < autoDeployCooldownMinutes` (DB: 0) → DEPLOY_SKIPPED_COOLDOWN.
5. `headroom < minDeployUsdc` ($100 DB) → DEPLOY_SKIPPED_CAP.
6. `deployableUsdc < minDeployUsdc` → DEPLOY_SKIPPED_DUST.
7. Price out of range → DEPLOY_SKIPPED_OOR.
8. Within `deployRatioTolerance` of the edge → DEPLOY_SKIPPED_RATIO.

Additionally, inside `LiveExecutor.increaseLiquidity` (`executor.ts:829–852`):
- `idleUsdc < $100` → skip.
- `proximityToLower > params.proximityDeployThreshold` → skip (e.g. > 40% in RANGING).
- `proximityToUpper > 0.85` → skip.

**Example (RANGING, range $84.00 – $85.70, position $12,000, wallet 0.5 SOL + $1,500):** centre $84.85; at price $84.30, proxToLower = (84.85 − 84.30) / 0.85 = 0.65 which **exceeds** the 0.40 deploy threshold → skipped "too close to lower". At price $84.85 proxToLower = 0 → deploys.

---

## 6. REGIME-CHANGE REOPEN (Day 5)

Triggered when the current position's recorded regime differs from `liveRegime` (`main.ts:1539`).

### 6.1 Transition Rules (`REGIME_TRANSITION_RULES`, `constants.ts:88–101`)

| From → To | Urgency | stableMinutes | widthThreshold |
|---|---|---|---|
| RANGING → BULLISH_TREND | LOW | 30 | 1.4 |
| RANGING → BEARISH_TREND | HIGH | 10 | 1.2 |
| RANGING → EXTREME | CRITICAL | 5 | 1.0 |
| BULLISH_TREND → RANGING | MEDIUM | 20 | 1.3 |
| BULLISH_TREND → BEARISH_TREND | CRITICAL | 5 | 1.0 |
| BULLISH_TREND → EXTREME | CRITICAL | 5 | 1.0 |
| BEARISH_TREND → RANGING | LOW | 30 | 1.4 |
| BEARISH_TREND → BULLISH_TREND | HIGH | 10 | 1.2 |
| BEARISH_TREND → EXTREME | CRITICAL | 5 | 1.0 |
| EXTREME → RANGING | HIGH | 10 | 1.2 |
| EXTREME → BULLISH_TREND | MEDIUM | 20 | 1.3 |
| EXTREME → BEARISH_TREND | MEDIUM | 20 | 1.3 |

### 6.2 `shouldReopenForRegime` (main.ts:1181) — 5 gates

1. **Same-regime gate:** bail if `currentRegime == positionOpenRegime`.
2. **Feature flag:** bail if `regimeReopenEnabled = false`.
3. **Rule lookup:** bail if no rule for `from→to`.
4. **Confidence gate:** unless urgency = CRITICAL, bail if `currentConfidence < regimeReopenMinConfidence` (default MEDIUM).
5. **Stability gate:** bail if `regimeStableMinutes < rule.stableMinutes`.
6. **Width-ratio gate:** `widthRatio = currentRangeWidthPct / targetRegimeWidth`. Unless urgency = CRITICAL, bail if `widthRatio < rule.widthThreshold`.
7. **Proximity gate:** bail if `proxToLower > regimeReopenMaxProximity` (0.75) or `< regimeReopenMinProximity` (0.25).
8. **Pending-fees gate:** if `pendingFeesUsd > regimeReopenMaxPendingFees` ($10) and urgency = LOW, bail with "harvest first".

### 6.3 `isGoodReopenMoment` (main.ts:1250) — 7 timing conditions

Max wait by urgency: CRITICAL 15 min, HIGH 45 min, MEDIUM 120 min, LOW 0 (LOW waits for a natural exit indefinitely).

1. **Max-wait override:** `minutesWaiting ≥ wait` → force reopen.
2. **LOW urgency:** always wait for natural exit.
3. **Near exit:** `proxToLower > 0.68` or `< 0.32` → wait (let the natural exit fire).
4. **Price velocity:** `priceVelocity5min > regimeReopenMaxPriceVelocity` ($0.30) → wait.
5. **High vol:** `bbWidth > regimeReopenMaxBbWidth` (2.5%) → wait.
6. **Pending fees:** `pendingFeesUsd > $8` → wait (harvest first).
7. **Minimum gap since last close:** `minutesSinceLastClose < 5` → wait.

If none triggers, sweet spot is `proxToLower ∈ [0.40, 0.60]` → "optimal re-entry", otherwise "conditions acceptable".

### 6.4 Examples

- **BULLISH_TREND → RANGING** with current width 1.56% and target 2.0% (DB): `widthRatio = 0.78 < 1.3` → **no reopen** (width close enough, keep the position).
- **BULLISH_TREND → BEARISH_TREND:** CRITICAL urgency bypasses confidence + width gates. After 5 min stability and any acceptable timing window → reopen.
- **RANGING → EXTREME:** CRITICAL, reopens as soon as basic gates pass; EXTREME commits immediately in hysteresis.

---

## 7. SOL CONVERSION (`main.ts:1916–2057`)

Sells a small slice of idle SOL to USDC to refill deposit capital when the wallet is SOL-heavy. Enabled in DB (`solConversionEnabled = 1`).

### 7.1 Trigger gate chain

1. `solConversionEnabled` must be true.
2. **Regime gate:** RANGING / BULLISH always allowed. BEARISH / EXTREME only via momentum override.
3. **Basis gate:** for RANGING / BULLISH, require `price ≥ basis × regimeMult × globalMult` (see below).
4. **Cooldown gate:** dynamic by regime.
5. **SOL-heavy check:** wallet SOL value must be `> 20%` of total.
6. **USDC-deficit check:** `deployableUsdc < targetUsdcForDeploy`.
7. **Amount floor:** must be ≥ $50 USDC equivalent.
8. **shouldAllowSwap P&L guard:** blocks SOL sells if `price < basis`.

### 7.2 Basis multiplier (`main.ts:1961`)

```
regimeBasisMult = { RANGING: 1.000, BULLISH_TREND: 1.010, BEARISH_TREND: 1.005, EXTREME: null }
effectiveMult   = regimeBasisMult[regime] × solConversionBasisMultiplier   (global default 1.000)
```
RANGING sells at or above basis; BULLISH requires +1% above basis; BEARISH momentum override requires +0.5%; EXTREME never sells via this path.

### 7.3 Cooldown & dynamic cap

| Regime | Base cooldown | targetDeployMin | dynamicCap % of idle SOL |
|---|---|---|---|
| RANGING | 3 min | 15 | 20% |
| BULLISH_TREND | 5 min | 30 | 16.7% |
| BEARISH_TREND | 10 min | 90 | 11.1% |
| EXTREME | 20 min | 240 | 8.3% |

```
dynamicCapPct = cooldownMin / targetDeployMin
dynamicCap    = clamp(walletSolValue × dynamicCapPct, $200, walletSolValue × 0.50)
convertUsdc   = min(usdcNeeded, walletSolValue × 0.05, effectiveCap)
```

### 7.4 Momentum override (BEARISH / EXTREME)

- `priceChange30m ≥ solConvertMomentumThreshold` (0.02 = 2%) required.
- `marginAboveBasis` must be ≥ 0.5% for a non-zero tier:
  - ≥ 3% → 1.00x cap, ≥ 2% → 0.75x, ≥ 1% → 0.50x, ≥ 0.5% → 0.25x, else 0.
- Effective cooldown falls back to `min(regimeCooldown, solConvertMomentumCooldownMin)` (default 10 min).

### 7.5 `idleTargetSolPct` lookup (used for post-convert alert wording)

RANGING 0.50, BULLISH 0.55, BEARISH 0.35, EXTREME 0.25.

---

## 8. IDLE REBALANCE (`main.ts:2128–2253`)

Maintains a target SOL/USDC split on the idle wallet, independent of SOL Conversion.

**Schedule:** runs on regime change, after a position reopen (`idleRebalancePending = true`), and as a periodic re-check every **30 min** (`idleRebalanceCooldownMs`). Skipped while a smart-sell is pending or `idleRebalanceEnabled = false`.

**Inputs:**
```
idleSol   = max(0, walletSol − idleRebalanceSolKeep)     // 0.15
idleUsdc  = max(0, walletUsdc − usdcReserve)              // 5 (DB)
idleTotal = idleSol × price + idleUsdc
```

**Per-regime targets** (Day 5 fix):
| Regime | Target SOL % |
|---|---|
| RANGING | 50% |
| BULLISH_TREND | 55% |
| BEARISH_TREND | 35% |
| EXTREME | 25% |

**Fire condition:** `|deviation| > idleRebalanceDeviationPct` (0.15).

**Cap formula (per cycle):**
```
gapUsdc = |currentSolUsdc − targetSolUsdc|
cap     = clamp(gapUsdc / idleRebalanceSpreadCycles, $100, idleRebalanceMaxUsdc)
                                                    ($100, $2,000)
```

**SOL-heavy (sell SOL path):** blocked if `price < basis` (P&L guard). If allowed, sell cap is `min(gap/3, $100, $2,000)`. Minimum trade 0.1 SOL.

**USDC-heavy (buy SOL path):** prefers buying below basis ("buying the dip"). Buys above basis only if `|deviation| > 25%`; otherwise logs `SKIPPED: above basis, waiting for dip`.

---

## 9. FEE COLLECTION

### 9.1 Sources
- **Pending fees** — uncollected on-chain, polled every 2 min (`cachedPendingFees*`).
- **Harvested fees** — `rebalance_events` rows where `eventType = 'FEE_HARVEST'` (the single source of truth for Fee Income charts, commit `e7f5e6a`).
- **Pre-close harvest** (Day 5) — a `FEE_HARVEST` row is inserted immediately before every close when pending fees ≥ $0.50, ensuring they show up in the harvested total.

### 9.2 Formula

```
fee_total_usdc = fee_usdc + fee_sol × currentPrice
```
Totals are computed in USD MtM using the latest price.

### 9.3 `harvestSolConvertPct` per regime (used inside `convertHarvestedSol`)

| Regime | % of harvested SOL converted to USDC |
|---|---|
| RANGING | 50% |
| BULLISH_TREND | 70% |
| BEARISH_TREND | 100% |
| EXTREME | 100% |

The SOL converted from harvested fees is **never** gated by `shouldAllowSwap` — LP fee SOL has a zero cost basis (`main.ts:2441–2444`).

### 9.4 Harvest schedule (`isHarvestDue`)
Triggered when `daysSinceHarvest ≥ harvestIntervalDays` **AND** pending fees ≥ $0.50 (otherwise skipped to save gas, re-checked hourly).

### 9.5 Historical gap

A $208 gap between on-chain vs tracked harvested fees remains from Apr 12-14 (pre-fix). New `FEE_HARVEST` rows (including the pre-close ones) shrink it over time.

---

## 10. RESERVE SYSTEM (`src/reserve/reserveManager.ts`)

### 10.1 States

| State | Rule |
|---|---|
| **EMPTY** | `current ≤ 0`. Deploys blocked. |
| **REFILLING** | `0 < current < floor`. Deploys allowed iff wallet covers deposit and reserve > 0. Harvests route 100% → reserve (capped at deficit). |
| **FULL** | `current ≥ floor`. Deploys always allowed. Harvests split 50/50 between reserve top-up (capped at deficit) and compounding. |

### 10.2 Floor per regime (`reserveFloorPct`)

| Regime | `reserveFloorPct` | Floor at $20,000 portfolio |
|---|---|---|
| RANGING | 0.10 | $2,000 |
| BULLISH_TREND | 0.12 | $2,400 |
| BEARISH_TREND | 0.18 | $3,600 |
| EXTREME | 0.20 | $4,000 |

On regime change, `checkReserveFloor` recalculates the floor and only commits when drift > 20% (`reserveManager.ts:179`).

### 10.3 Refill

Every successful harvest flows through `routeHarvest(db, feeUsdc)`. REFILLING / EMPTY routes 100% of harvest to reserve up to the deficit. FULL splits 50/50. Post-open and pre-close both invoke `reconcileReserveAfterOpen` to set reserve to `max(0, walletUsdc)` clamped at `floor`.

---

## 11. COST BASIS TRACKING (`src/tracking/costBasis.ts`)

Weighted-average `solCostBasis` persisted on `bot_state` (`sol_cost_basis`, `sol_total_acquired`, `sol_total_cost`).

**Updated by:**
- `updateCostBasis` on every **SOL acquisition**: position close (returns SOL), USDC→SOL idle-rebalance, pre-open USDC→SOL buy, `onSwap` buy event, SIR buy.
- `reduceCostBasisHoldings` on every **SOL sell**: SolConvert, idle-rebalance SOL sell, SIR sell. This reduces `solTotalAcquired` and `solTotalCost` proportionally but leaves the weighted-average price unchanged.

**Basis can drift up** whenever a buy happens at a higher price than the current basis. Example: basis $84.70, idle-rebalance buys 85.9 SOL at $85.20:
```
totalCost    = 84.70 × existingSol + 85.20 × 85.9
totalAcquired = existingSol + 85.9
newBasis      = totalCost / totalAcquired  ≈ $84.95 (if existingSol ≈ 85)
```

**Startup reconciliation** (`main.ts:248–267`): on boot, if `walletSol > trackedSol × 1.05` a warning logs but the bot does **not** auto-correct.

---

## 12. CALCULATED FIELDS REFERENCE

| Field | Formula | Source | Notes |
|---|---|---|---|
| `proximityToLower` | `max(0, (centre − price) / halfWidth)` | `rules.ts:46` | 0–1; ≥ `proxThresholdLower` fires T1_DOWNSIDE |
| `proximityToUpper` | `max(0, (price − centre) / halfWidth)` | `rules.ts:46` | ≥ `proxThresholdUpper` fires T1_UPSIDE |
| `deployRatioTolerance` | per-regime (see §2.3) | `constants.ts` | Edge margin for auto-deploy |
| `rangeWidth` | `(upper − lower) / ((upper + lower) / 2) × 100` | `main.ts:1543` | Width as % — used in `widthRatio` |
| `centrePrice` | `price × (1 + offset)` if post-upside, else `price` | `main.ts:2340` | Offsets per regime (§3.3) |
| `positionAge` | `now − currentPos.entryTime` | ms | Used by MAX_AGE (disabled) and VAR gating |
| `feeRate` ($/hr) | `totalFeesMtM / hoursHeld` | dashboard aggregate | By regime on dashboard |
| `netPnL` | `fees − realizedIL − gasCost − swapCost` | dashboard | USD-denominated |
| `realizedIL` | Σ `ilAtClose` from every close | `liveRealizedIl` | IL formula `2√r/(1+r) − 1` × holdValue |
| `pendingFees` | `feeSolDecimal × price + feeUsdcDecimal` | executor polled 2 min | Uncollected on-chain |
| `harvestedFees` | `Σ rebalance_events.fee_* WHERE eventType='FEE_HARVEST'` | DB | Single source of truth |
| `totalFeesMtM` | `harvestedFees + pendingFees` | composite | Used in dashboard displays |
| `costBasis` | `solTotalCost / solTotalAcquired` | `bot_state.sol_cost_basis` | Weighted average |
| `portfolioValue` | `wallet.sol × price + wallet.usdc + positionValueUsdc` | per cycle | `totalValueWithPosition` |
| `reserveFloor` | `totalPortfolio × reserveFloorPct` | `reserveManager.computeFloor` | Regime-dependent |
| `idleCapital` | `max(0, walletSol − solReserve) × price + max(0, walletUsdc − reserveFloor)` | `rules.ts:194` | Deployable above floors |
| `solConvertThreshold` | `basis × regimeBasisMult × globalMult` | `main.ts:1961` | Min acceptable sell price |
| `regimeStableMinutes` | `(now − lastRegimeChangeTs) / 60_000` | `main.ts:1540` | Input to reopen stability gate |
| `widthRatio` | `currentRangeWidthPct / targetRegimeWidth` | `main.ts:1223` | Reopen width gate |
| `usdcAvailableForSwap` | `max(0, usdcBal − idealUsdc − effectiveFloor)` | `executor.ts:259` | Pre-open partial-buy budget |
| `effectiveFloor` | `reserveFloor × (postUpside ? postUpsideFloorMultiplier : 1)` | `executor.ts:257` | Relaxed floor during post-upside |
| `priceVelocity5min` | `|prices[last] − prices[0]|` over ~10 ticks | `main.ts:1576` | Reopen timing gate |

---

## 13. KNOWN ISSUES & MONITORING

1. **0x1781 tick-array init errors** — intermittent on busy pools. `openPosition` now validates all 3 tick arrays (lower, upper, current) and retries with a 5 s wait (`executor.ts:186–208`). Positions still occasionally fail; exponential TX backoff (60s / 120s / 240s / 300s) skips opens during a streak.
2. **Regime flip-flop edge case** — `detectRegimeTA` hysteresis holds the previous regime while a new candidate is forming. During a close/reopen cycle that lasts longer than the regime detection interval, a transient candidate can briefly commit. Mitigation: score ≥ 6 committing immediately is correctly gated by `!vetoFiredForHysteresis`.
3. **$208 historical harvested-fee gap** — arose from harvests that failed to write `FEE_HARVEST` rows before the Apr 12-14 fixes. Shrinking as new rows (including the Day 5 pre-close harvests) accumulate.
4. **Jupiter 0x1771 slippage errors** — handled by `jupiter-fallback` provider setting (`swapProvider`), which retries via Orca when Jupiter returns a slippage error.
5. **varEnabled = false** (DB) — VAR skew/threshold adjustments stay disabled until validated under live conditions. The knobs (`varMultiplier`, `varTargetHours`, etc.) are live-editable but inert.

---

*End of document.*
