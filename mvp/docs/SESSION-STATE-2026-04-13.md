# Session State — April 13, 2026 (20:00 UTC)

Use this file to restore context if the session is lost. Share it with the new Claude session.

## Current Bot State
- **Position**: $82.79-$83.65 (1.0% width — tightest ever, evening calm experiment)
- **Price**: ~$83.30 | SOL +1.2% 24h | BTC +1.6% | F&G 12
- **Portfolio**: ~$7,510 ($6,713 position + $798 idle)
- **Today's fees**: $84.24 (vs $29.92 yesterday — 2.8x!)
- **Net profit (all-time)**: $130.29
- **Regime**: BEARISH_TREND | Vol1h: 0.0037 (calm)

## Active Features
- **VAR**: ENABLED — dynamic width/thresholds/deploy from volatility
- **SIR**: DISABLED — needs P&L-aware rules (lost $3.40 on 11 swaps from over-trading)
- **P&L guard**: ENABLED on ALL swaps (idle rebalance + auto-deploy ratio matching)
- **Idle rebalance**: 30-min periodic re-check (fixes post-auto-deploy drift)
- **Swap ledger**: tracking all swaps with cost basis + P&L
- **Config hot-reload**: every 5 min from DB

## Key Config (DB overrides)
```
regime.BEARISH_TREND.rangeWidthPct = 1.0
regime.RANGING.rangeWidthPct = 1.0
regime.BEARISH_TREND.proxThresholdLower = 0.85
regime.BEARISH_TREND.proxThresholdUpper = 0.85
regime.RANGING.proxThresholdLower = 0.85
regime.RANGING.proxThresholdUpper = 0.85
maxLiveCapitalUsdc = 10000
varEnabled = true
sirEnabled = false
swapSlippageBps = 6
```

## Architecture (key files)
- `src/engine/var.ts` — VAR + SIR engine (NEW today)
- `src/main.ts` — decision loop, VAR override, P&L guards, SIR integration, idle rebalance
- `src/live/executor.ts` — position management, P&L-aware shouldAllowSwap callback
- `src/config.ts` — runtime config with 15 new VAR/SIR keys
- `src/db/sqlite.ts` — swap_ledger table, getSwapPnlSummary
- `src/output/dashboard.ts` — live wallet page (fee/h, position details, dynamic targets)
- `src/output/analytics-page.ts` — fees per hour with day selector
- `docs/LOGIC-CHANGELOG-2026-04-13.md` — full changelog of all 14 changes today

## Monitoring Approach
- **2-min cycles** with enhanced pattern tracking
- Track: price trend (last 5 cycles), vol1h change, volume ratio, SOL/BTC divergence
- Track: fee/h rate, position age, pending fees
- Decision framework: price trend + vol + fee rate + prox trajectory
- Act preemptively at 60% prox (not wait for 80%+)
- Tighten range in calm, widen in vol spikes
- P&L guard prevents loss-making swaps

## Known Issues
1. **SIR disabled** — over-traded, needs profit-only sell rule + higher cooldown
2. **Pre-open swap oversizing** — converts too much when wallet is imbalanced
3. **Tick array errors (0x1781)** — transient RPC issue, resolves on retry/restart
4. **Pullback wait on dashboard close** — requires stop→clear DB→start workaround
5. **Auto-deploy drains SOL disproportionately** — periodic rebalance fixes but adds swaps
6. **Swap P&L: -$15.83 total** — mostly from pre-P&L-guard auto-deploy ratio swaps

## What Was Built Today
1. Config hot-reload (5-min periodic)
2. VAR engine (src/engine/var.ts) — dynamic width/thresholds/skew/deploy from vol
3. SIR engine (in var.ts) — continuous idle rebalancing (disabled)
4. Swap cost basis tracking (swap_ledger table + calculateSwapPnl)
5. P&L-aware swap guards (idle rebalance + auto-deploy)
6. Idle rebalance 30-min periodic re-check
7. Fee/h display with trend arrow on live wallet
8. Position details: width + exit trigger prices
9. Swap P&L Tracker on insights page with Source column
10. Dynamic target display (SIR/VAR labels)
11. Fee calculation consistency fix (daily_summary as source of truth)
12. Analytics: fees per hour day selector + legend
13. Capital cap raised to $10,000
14. All swaps tracked via onSwap callback

## User Preferences (from memory)
- Mobile-first design (accesses from phone)
- Always check DB config, not code defaults
- Safe deploys: branch, tag, rollback
- No SIR until P&L-aware rules added
- Track swap P&L as decision factor
- Use vol + volume data for dynamic decisions
- Reduce unnecessary swaps — every swap costs slippage
- Tighten range in calm, widen in volatile
- Consider fee/h and position age in decisions

## Overnight Plan
- Keep 1.0% width while calm (widen if vol spikes)
- VAR active, SIR disabled
- P&L guards active
- 2-min monitoring with pattern tracking
- Pre-emptive recenter if prox >60% with momentum
- Tomorrow: build P&L-aware SIR v2, discuss VAR v2 with trend detection
