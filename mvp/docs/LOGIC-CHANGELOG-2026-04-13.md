# Logic Changelog — April 13, 2026

## Summary
One-day intensive session: overnight experiment + all-day active monitoring.
Results: $84+ fees today (vs $30 yesterday), net profit $130+.

## Changes Made

### 1. Config Hot-Reload (Bug Fix)
- **Before:** Config loaded only at startup. DB changes required restart.
- **After:** Config reloads from DB every 5 minutes in decision loop.
- **File:** `src/main.ts` (line ~360)
- **Impact:** Proximity threshold changes now take effect within 5 min.

### 2. BEARISH Proximity Thresholds
- **Before:** proxThresholdLower=0.60, proxThresholdUpper=0.80
- **After:** proxThresholdLower=0.85, proxThresholdUpper=0.85 (symmetric)
- **Rationale:** Wider thresholds reduce unnecessary exits. Validated overnight — survived 80% bounce.

### 3. Range Width Tightening
- **Before:** 2.5% (BEARISH), 2.5% (RANGING)
- **After:** 1.5% (all regimes)
- **Rationale:** Tighter range = more fee concentration. At vol=0.003, 1.5% captures oscillations.
- **Data:** 2.5%=$1.55/h, 2.0%=$2.36/h, 1.5%=$1.61-10/h depending on price action.

### 4. VAR Engine (Volatility-Adaptive Range)
- **Before:** Static regime-to-params mapping (RANGING/BULLISH/BEARISH/EXTREME)
- **After:** Dynamic params from volatility formula: width = k * vol1h * sqrt(hours)
- **File:** `src/engine/var.ts` (new), `src/main.ts` integration
- **Config:** varEnabled=true, varMultiplier=3.0, varTargetHours=2
- **Status:** Active. Overrides regime params when enabled.

### 5. SIR Engine (Smart Idle Rebalancing)
- **Before:** Idle rebalance only on regime change or position reopen
- **After:** Continuous price-driven rebalancing with deposit-ratio target (~50%)
- **File:** `src/engine/var.ts` (SIR section), `src/main.ts` integration
- **Config:** sirEnabled=false (disabled due to swap losses)
- **Status:** DISABLED. Needs P&L-aware rules before re-enabling.
- **Problem:** -$3.40 loss over 11 swaps from over-trading.

### 6. Idle Rebalance Periodic Re-check
- **Before:** Only triggered on regime change or position reopen (idleRebalancePending)
- **After:** Also triggers every 30 min regardless (catches post-auto-deploy drift)
- **File:** `src/main.ts` (idle rebalance section)
- **Impact:** Fixes wallet ratio drifting to 90%+ SOL after auto-deploy rounds.

### 7. P&L-Aware Swap Guards
- **Before:** All swaps executed blindly regardless of cost basis
- **After:** Swaps check cost basis before executing:
  - SOL sells blocked if price < cost basis (unless deviation >25%)
  - SOL buys blocked if price > cost basis (unless deviation >25%)
- **Files:** `src/main.ts` (idle rebalance), `src/live/executor.ts` (auto-deploy)
- **Impact:** Prevents loss-making ratio matching swaps.

### 8. Swap P&L Tracker
- **Before:** No tracking of swap profitability
- **After:** `swap_ledger` table records every swap with cost basis + P&L
- **Files:** `src/db/sqlite.ts`, `src/engine/var.ts` (calculateSwapPnl), `src/main.ts`
- **UI:** Swap P&L Tracker card on insights page with source column.

### 9. Fee/Hour Display
- **Before:** No fee rate shown on live wallet
- **After:** $/h with trend arrow (up/down/flat) on pending fees section
- **File:** `src/output/dashboard.ts`

### 10. Position Details Enhancement
- **Before:** Basic position info
- **After:** Shows range width, lower exit trigger price, upper exit trigger price with distance
- **File:** `src/output/dashboard.ts`

### 11. Dynamic Target Display
- **Before:** Static "Target: 35% SOL" based on regime
- **After:** Shows "(SIR)" or "(VAR)" labels, dynamic values when features enabled
- **File:** `src/output/dashboard.ts`

### 12. Fee Calculation Consistency Fix
- **Before:** Different fee calculation methods across pages (snapshot deltas vs daily_summary)
- **After:** All pages use daily_summary.fees_earned_usdc as source of truth
- **File:** `src/output/dashboard.ts`

### 13. Capital Cap Increase
- **Before:** maxLiveCapitalUsdc = $7,000
- **After:** maxLiveCapitalUsdc = $10,000
- **Reason:** User added $1,166 new capital

### 14. All Swaps Tracked in Ledger
- **Before:** Only SIR swaps tracked
- **After:** onSwap callback fires for ALL swaps (pre-open, auto-deploy, idle rebalance, SIR, harvest)
- **File:** `src/live/executor.ts` (doSwap fires onSwap), `src/main.ts` (onSwap handler)

## Current Configuration (as of 20:00 UTC April 13)
- VAR: ENABLED (dynamic width/thresholds/deploy)
- SIR: DISABLED (needs P&L-aware rules)
- P&L guard: ENABLED (all swaps)
- Idle rebalance: ENABLED with 30-min periodic re-check
- Range width: 1.5% (all regimes, VAR may override)
- Thresholds: 85%/85% (BEARISH), 85%/85% (RANGING), VAR may override
- Deploy: 85-90% (VAR adjusts based on vol)
- Capital cap: $10,000

## Known Issues
- **SIR disabled:** Over-traded idle wallet, -$3.40 loss over 11 swaps. Needs P&L-aware rules (check cost basis before swap, min profit threshold) before re-enabling.
- **Pre-open swap oversizing:** When opening after downside exit with 100% SOL, pre-open swap can sell more SOL than needed. Needs better target calculation accounting for position deposit requirements.
- **Tick array errors:** Orca SDK tick array errors (0x1781/0x1782) on close/open TXs during RPC congestion. Handled by exponential backoff but can delay position operations.
- **Swap ledger historical gap:** Swaps before the ledger was added (early April 12) are not tracked. P&L totals are partial.

## Key Metrics
- Yesterday fees: $29.92
- Today fees: $84+ (and counting)
- Net profit (all-time): $130+
- Total swaps tracked: 20+
- Swap P&L: -$15.83 (mostly from pre-P&L-guard auto-deploy swaps)
