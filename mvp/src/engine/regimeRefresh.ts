// Regime-Change Refresh (RCR)
//
// When regime changes while a position is open, mark the position for a switch.
// When price drifts back within a small tolerance of entry, close the current
// position and reopen using the latest regime's parameters. Goal: zero-IL
// regime adaptation, gated on price cooperation.
//
// Normal close rules (T1/OOR/etc.) always win — if one fires while marked,
// the mark is cleared and the close proceeds as usual.

import type Database from 'better-sqlite3';
import type { Regime } from '../types.js';
import { insertRebalanceEvent } from '../db/sqlite.js';
import { runtime } from '../config.js';

export type MarkAction =
  | { action: 'MARK'; from: null; to: Regime }
  | { action: 'UPDATE_TARGET'; from: Regime; to: Regime }
  | { action: 'UNMARK'; from: Regime; to: null };

export interface RefreshConfig {
  enabled: boolean;
  tolerancePct: number;          // fraction of entry price (0.001 = 0.1%)
  minSwitchIntervalSec: number;  // churn protection between consecutive switches
}

export function getRefreshConfig(): RefreshConfig {
  return {
    enabled: runtime.regimeChangeRefreshEnabled,
    tolerancePct: runtime.regimeRefreshTolerance,
    minSwitchIntervalSec: runtime.regimeRefreshMinSwitchIntervalSec,
  };
}

// Decide mark action for a regime transition while a position is active.
// Returns null when no mark-state change is needed.
export function checkRegimeChange(args: {
  newRegime: Regime;
  prevRegime: Regime | null;
  entryRegime: Regime | null;
  markedForSwitch: boolean;
  markTarget: Regime | null;
  hasOpenPosition: boolean;
  enabled: boolean;
}): MarkAction | null {
  if (!args.enabled) return null;
  if (!args.hasOpenPosition) return null;
  if (!args.entryRegime) return null;
  if (args.newRegime === args.prevRegime) return null;

  if (args.markedForSwitch) {
    if (args.newRegime === args.entryRegime) {
      const prior = (args.markTarget ?? args.prevRegime) as Regime;
      return { action: 'UNMARK', from: prior, to: null };
    }
    if (args.newRegime !== args.markTarget) {
      return { action: 'UPDATE_TARGET', from: (args.markTarget ?? args.prevRegime) as Regime, to: args.newRegime };
    }
    return null;
  }

  if (args.newRegime !== args.entryRegime) {
    return { action: 'MARK', from: null, to: args.newRegime };
  }
  return null;
}

// Check whether a marked position is ready to switch at the current price.
export function checkSwitchTrigger(args: {
  markedForSwitch: boolean;
  entryPrice: number | null;
  currentPrice: number;
  now: number;
  lastSwitchTs: number | null;
  config: RefreshConfig;
}): { ready: boolean; reason: string; distancePct: number } {
  const entryPrice = args.entryPrice ?? 0;
  const distancePct = entryPrice > 0 ? Math.abs(args.currentPrice - entryPrice) / entryPrice : Infinity;
  if (!args.config.enabled) return { ready: false, reason: 'disabled', distancePct };
  if (!args.markedForSwitch) return { ready: false, reason: 'not-marked', distancePct };
  if (entryPrice <= 0) return { ready: false, reason: 'no-entry-price', distancePct };
  if (args.lastSwitchTs && args.lastSwitchTs > 0) {
    const elapsedSec = (args.now - args.lastSwitchTs) / 1000;
    if (elapsedSec < args.config.minSwitchIntervalSec) {
      const remain = args.config.minSwitchIntervalSec - elapsedSec;
      return { ready: false, reason: `churn-cooldown(${remain.toFixed(0)}s)`, distancePct };
    }
  }
  if (distancePct > args.config.tolerancePct) {
    return { ready: false, reason: `distance-${(distancePct * 100).toFixed(3)}%`, distancePct };
  }
  return { ready: true, reason: `within-${(distancePct * 100).toFixed(3)}%`, distancePct };
}

export function mapActionToEventType(action: MarkAction): 'REGIME_SWITCH_MARKED' | 'REGIME_SWITCH_UNMARKED' {
  return action.action === 'UNMARK' ? 'REGIME_SWITCH_UNMARKED' : 'REGIME_SWITCH_MARKED';
}

export function logMarkEvent(db: Database.Database, args: {
  action: MarkAction;
  entryRegime: Regime | null;
  price: number;
}): void {
  const type = mapActionToEventType(args.action);
  const tolPctStr = (runtime.regimeRefreshTolerance * 100).toFixed(2);
  let note: string;
  let regimeField: Regime;
  if (args.action.action === 'MARK') {
    note = `Regime changed while position active: ${args.entryRegime} → ${args.action.to}. Marked for switch — will close+reopen when price returns within ${tolPctStr}% of entry.`;
    regimeField = args.action.to;
  } else if (args.action.action === 'UPDATE_TARGET') {
    note = `Switch target updated: ${args.action.from} → ${args.action.to}. Entry regime: ${args.entryRegime}.`;
    regimeField = args.action.to;
  } else {
    note = `Regime returned to entry (${args.entryRegime}). Pending switch cleared (target was ${args.action.from}).`;
    regimeField = (args.entryRegime ?? args.action.from) as Regime;
  }
  insertRebalanceEvent(db, {
    timestamp: Date.now(),
    eventType: type,
    price: args.price,
    regime: regimeField,
    note,
    solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
    feeSol: 0, feeUsdc: 0, ilAtClose: 0,
  });
}

export function logExecutedEvent(db: Database.Database, args: {
  entryRegime: Regime | null;
  targetRegime: Regime | null;
  entryPrice: number;
  switchPrice: number;
  markedAt: number | null;
  currentRegime: Regime;
}): void {
  const waitMin = args.markedAt ? ((Date.now() - args.markedAt) / 60000).toFixed(1) : 'n/a';
  const distPct = args.entryPrice > 0 ? (Math.abs(args.switchPrice - args.entryPrice) / args.entryPrice * 100).toFixed(3) : 'n/a';
  insertRebalanceEvent(db, {
    timestamp: Date.now(),
    eventType: 'REGIME_SWITCH_EXECUTED',
    price: args.switchPrice,
    regime: args.currentRegime,
    note: `Regime switch executed: ${args.entryRegime} → ${args.targetRegime}. Entry $${args.entryPrice.toFixed(2)}, switch $${args.switchPrice.toFixed(2)} (${distPct}% from entry). Waited ${waitMin}min since mark.`,
    solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
    feeSol: 0, feeUsdc: 0, ilAtClose: 0,
  });
}

export function logSuppressedEvent(db: Database.Database, args: {
  reason: string;
  regime: Regime;
  entryRegime: Regime | null;
  markTarget: Regime | null;
  price: number;
}): void {
  insertRebalanceEvent(db, {
    timestamp: Date.now(),
    eventType: 'REGIME_SWITCH_SUPPRESSED',
    price: args.price,
    regime: args.regime,
    note: `Pending regime switch cancelled — ${args.reason}. Entry regime: ${args.entryRegime}. Target was: ${args.markTarget ?? 'n/a'}.`,
    solBefore: 0, usdcBefore: 0, solAfter: 0, usdcAfter: 0,
    feeSol: 0, feeUsdc: 0, ilAtClose: 0,
  });
}
