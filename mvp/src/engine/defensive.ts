/**
 * Defensive Downtrend Mode (Phase C core)
 *
 * Master switch: runtime.defensiveDowntrendEnabled (default false).
 * Trigger detection + exit detection only — integration (gating,
 * persistence, logging) lives in main.ts.
 *
 * Historical price lookups are computed in main.ts from regime_snapshots
 * and passed in as scalars so this module stays pure and testable.
 */

import { runtime } from '../config.js';

export interface DefensiveState {
  active: boolean;
  enteredAt: number | null;
  enteredPrice: number | null;
  enteredTrigger: string | null;
  entryPriceLow: number | null;
  cooldownUntil: number | null;
}

export function makeInitialState(): DefensiveState {
  return { active: false, enteredAt: null, enteredPrice: null, enteredTrigger: null, entryPriceLow: null, cooldownUntil: null };
}

export function checkDefensiveTriggers(
  currentPrice: number,
  price1hAgo: number | null,
  price4hAgo: number | null,
  price24hAgo: number | null,
  price7dAgo: number | null,
  rsi: number | null,
  _now: number,
): { trigger: string | null } {
  if (!runtime.defensiveDowntrendEnabled) return { trigger: null };

  if (price1hAgo != null && price1hAgo > 0) {
    const drop1h = (price1hAgo - currentPrice) / price1hAgo;
    if (drop1h >= runtime.defensiveDowntrend1hDropPct) {
      return { trigger: `1h_drop_${(drop1h * 100).toFixed(1)}%` };
    }
  }

  if (price4hAgo != null && price4hAgo > 0) {
    const drop4h = (price4hAgo - currentPrice) / price4hAgo;
    if (drop4h >= runtime.defensiveDowntrend4hDropPct) {
      return { trigger: `4h_drop_${(drop4h * 100).toFixed(1)}%` };
    }
  }

  if (price24hAgo != null && price24hAgo > 0) {
    const drop24h = (price24hAgo - currentPrice) / price24hAgo;
    if (drop24h >= runtime.defensiveDowntrend24hDropPct) {
      return { trigger: `24h_drop_${(drop24h * 100).toFixed(1)}%` };
    }
  }

  if (price7dAgo != null && price7dAgo > 0) {
    const drop7d = (price7dAgo - currentPrice) / price7dAgo;
    if (drop7d >= runtime.defensiveDowntrend7dDropPct) {
      return { trigger: `7d_drop_${(drop7d * 100).toFixed(1)}%` };
    }
  }

  if (runtime.defensiveDowntrendUseRsi && rsi != null) {
    if (rsi <= runtime.defensiveDowntrendRsiThreshold) {
      return { trigger: `rsi_oversold_${rsi.toFixed(1)}` };
    }
  }

  return { trigger: null };
}

export function checkDefensiveExit(
  state: DefensiveState,
  currentPrice: number,
  rsi: number | null,
  now: number,
): { shouldExit: boolean; reason: string | null } {
  if (!state.active || state.enteredAt == null) return { shouldExit: false, reason: null };

  if (runtime.defensiveDowntrendForceExit) {
    return { shouldExit: true, reason: 'manual_force_exit' };
  }

  const minHoldMs = runtime.defensiveDowntrendMinHoldMinutes * 60_000;
  if (now - state.enteredAt < minHoldMs) {
    return { shouldExit: false, reason: null };
  }

  const hoursInMode = (now - state.enteredAt) / 3_600_000;
  if (hoursInMode >= runtime.defensiveDowntrendMaxHoldHours) {
    return { shouldExit: true, reason: `max_hold_${hoursInMode.toFixed(1)}h` };
  }

  if (state.entryPriceLow != null && state.entryPriceLow > 0) {
    const recoveryPct = (currentPrice - state.entryPriceLow) / state.entryPriceLow;
    if (recoveryPct >= runtime.defensiveDowntrendExitRecoveryPct) {
      return { shouldExit: true, reason: `recovery_${(recoveryPct * 100).toFixed(1)}%` };
    }
  }

  if (rsi != null && rsi >= runtime.defensiveDowntrendExitRsiThreshold) {
    return { shouldExit: true, reason: `rsi_recovery_${rsi.toFixed(1)}` };
  }

  return { shouldExit: false, reason: null };
}

export function updateEntryPriceLow(state: DefensiveState, currentPrice: number): DefensiveState {
  if (!state.active) return state;
  const next = state.entryPriceLow == null ? currentPrice : Math.min(state.entryPriceLow, currentPrice);
  if (next === state.entryPriceLow) return state;
  return { ...state, entryPriceLow: next };
}
