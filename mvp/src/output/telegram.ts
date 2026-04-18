import type Database from 'better-sqlite3';
import { getBotState } from '../db/sqlite.js';
import { getReserveState } from '../reserve/reserveManager.js';
import { readCostBasis } from '../tracking/costBasis.js';
import { getRegimeParams } from '../engine/regime.js';
import type { LiveData } from './dashboard.js';
import type { MarketSignals } from '../data/market.js';
import { runtime } from '../config.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  intervalMs: number;
}

export function startTelegramReporter(
  config: TelegramConfig,
  db: Database.Database,
  getLiveData: () => LiveData | null,
  getMarketSignals: () => MarketSignals | null,
): { stop: () => void; sendNow: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout>;

  const send = async () => {
    try {
      const text = buildReport(db, getLiveData, getMarketSignals);
      await sendTelegram(config.botToken, config.chatId, text);
      console.log(JSON.stringify({ level: 'info', msg: 'telegram report sent', timestamp: Date.now() }));
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'telegram report failed', error: String(err), timestamp: Date.now() }));
    }
  };

  const scheduleNext = (delayMs: number) => {
    timer = setTimeout(() => {
      send().finally(() => scheduleNext(config.intervalMs));
    }, delayMs);
  };

  // First report after 2 min
  scheduleNext(2 * 60_000);
  console.log(JSON.stringify({ level: 'info', msg: `telegram reporter started, every ${config.intervalMs / 60_000}min`, timestamp: Date.now() }));

  return { stop: () => clearTimeout(timer), sendNow: send };
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'), disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

// ── Telegram Alerts ──
// Rate-limited, event-driven alerts (separate from periodic reports)

const alertLastSent: Record<string, number> = {};
let solConvertFiredAfterRestart = false;

function rateLimited(key: string, cooldownMs: number): boolean {
  const last = alertLastSent[key] ?? 0;
  if (Date.now() - last < cooldownMs) return true;
  alertLastSent[key] = Date.now();
  return false;
}

/** Send a one-off alert (not a periodic report). Requires TG env vars. */
export async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await sendTelegram(token, chatId, text);
    console.log(JSON.stringify({ level: 'info', msg: 'telegram alert sent', alertPreview: text.slice(0, 80), timestamp: Date.now() }));
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'telegram alert failed', error: String(err), timestamp: Date.now() }));
  }
}

/** Alert 1: Pre-open SOL buy blocked by floor check. Max once per 10 min. */
export function alertFloorCheckBlocked(p: {
  usdcRemaining: number; floor: number; regime: string; price: number;
}): void {
  if (rateLimited('floor_blocked', 10 * 60_000)) return;
  const text = [
    `🚫 Pre-open SOL buy blocked`,
    `Floor check failed: $${p.usdcRemaining.toFixed(0)} USDC remaining < floor $${p.floor.toFixed(0)}`,
    `Regime: ${p.regime} | Price: $${p.price.toFixed(2)}`,
    `Action needed: Check wallet USDC vs reserve floor`,
    ``,
    `⏰ ${formatTimeCET()}`,
    `No action taken — monitoring only`,
  ].join('\n');
  sendTelegramAlert(text);
}

/** Alert 2: Shadow sell opportunity detected (profitable sell NOT executed). Max once per 15 min. */
export function alertShadowSell(p: {
  solAmount: number; usdcValue: number; price: number;
  marginPct: number; basis: number; regime: string;
}): void {
  if (rateLimited('shadow_sell', 15 * 60_000)) return;
  const text = [
    `👁 Shadow: Pre-open sell opportunity detected`,
    `Would sell: ${p.solAmount.toFixed(4)} SOL → $${p.usdcValue.toFixed(0)} USDC @ $${p.price.toFixed(2)}`,
    `Margin: +${p.marginPct.toFixed(1)}% above basis $${p.basis.toFixed(2)}`,
    `Regime: ${p.regime} | This is DATA only, no action taken`,
    `Review at: gcamlp.duckdns.org/intelligence`,
    ``,
    `⏰ ${formatTimeCET()}`,
    `No action taken — monitoring only`,
  ].join('\n');
  sendTelegramAlert(text);
}

/** Alert 3: Idle rebalance executed. Always fires (rare event). */
export function alertIdleRebalance(p: {
  direction: string; inputAmount: number; outputAmount: number;
  inputToken: string; outputToken: string;
  newSolPct: number; newUsdcPct: number;
  targetSolPct: number; regime: string; price: number;
}): void {
  // No rate limit — rare event, always fire
  const text = [
    `⚖️ Idle rebalance executed`,
    `Direction: ${p.direction}`,
    `Swapped: ${p.inputAmount.toFixed(4)} ${p.inputToken} → ${p.outputAmount.toFixed(4)} ${p.outputToken}`,
    `New wallet ratio: ${(p.newSolPct * 100).toFixed(0)}% SOL / ${(p.newUsdcPct * 100).toFixed(0)}% USDC`,
    `Target was: ${(p.targetSolPct * 100).toFixed(0)}% SOL (${p.regime})`,
    `Regime: ${p.regime} | Price: $${p.price.toFixed(2)}`,
    ``,
    `⏰ ${formatTimeCET()}`,
    `No action taken — monitoring only`,
  ].join('\n');
  sendTelegramAlert(text);
}

/** Alert 4: SolConvert fired. First conversion after restart only. */
export function alertSolConvert(p: {
  regime: string; targetSolPct: number;
  solConverted: number; usdcReceived: number; price: number;
  dynamicCap: number;
}): void {
  if (solConvertFiredAfterRestart) return;
  solConvertFiredAfterRestart = true;
  const text = [
    `💱 SolConvert fired`,
    `Regime: ${p.regime} | Target SOL%: ${(p.targetSolPct * 100).toFixed(0)}%`,
    `Converted: ${p.solConverted.toFixed(3)} SOL → $${p.usdcReceived.toFixed(2)} USDC @ $${p.price.toFixed(2)}`,
    `Dynamic cap: $${p.dynamicCap.toFixed(0)}`,
    ``,
    `⏰ ${formatTimeCET()}`,
    `No action taken — monitoring only`,
  ].join('\n');
  sendTelegramAlert(text);
}

/** Alert 5: Strategic rebalance fired — bot unstuck from SOL-heavy idle. */
export function alertStrategicRebalance(p: {
  solSold: number; usdcReceived: number; pnl: number; price: number; basis: number;
}): void {
  const text = [
    `🔧 Strategic rebalance: unstuck bot`,
    `Sold ${p.solSold.toFixed(2)} SOL → $${p.usdcReceived.toFixed(0)} USDC`,
    `Price $${p.price.toFixed(2)} | Basis $${p.basis.toFixed(2)} | P&L $${p.pnl.toFixed(2)}`,
    `Deploy on next cycle.`,
    ``,
    `⏰ ${formatTimeCET()}`,
  ].join('\n');
  sendTelegramAlert(text);
}

function fmt(n: number, d = 2): string { return n.toFixed(d); }

function formatTimeCET(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function buildReport(
  db: Database.Database,
  getLiveData: () => LiveData | null,
  _getMarketSignals: () => MarketSignals | null,
): string {
  const live = getLiveData();
  if (!live) return `🔴 sol-lp-bot — no data\n${formatTimeCET()}`;

  const price = live.solPrice;
  const regime = live.regime ?? 'RANGING';
  const positionActive = !!live.positionMint;

  // Portfolio
  const walletValue = live.totalValueUsdc;
  const lpValue = live.positionValueUsdc;
  const totalPortfolio = live.totalValueWithPosition;
  const walletPct = totalPortfolio > 0 ? (walletValue / totalPortfolio * 100).toFixed(0) : '0';
  const lpPct = totalPortfolio > 0 ? (lpValue / totalPortfolio * 100).toFixed(0) : '0';

  // Reserve
  const rs = getReserveState(db);

  // Cost basis & P&L
  const cb = readCostBasis(db);
  const totalSolHeld = live.solBalance + (live.entrySol ?? 0);
  const pnl = cb.solCostBasis > 0 ? (price - cb.solCostBasis) * totalSolHeld : 0;
  const aboveBasis = price >= cb.solCostBasis;

  // Regime params for gates
  const params = runtime.regimeParams[regime as keyof typeof runtime.regimeParams] ?? getRegimeParams(regime as any);
  const basisThreshold = params.basisGateThreshold ?? 0.999;
  const basisThresholdPrice = cb.solCostBasis * basisThreshold;

  // Gate status
  const reserveGatePassing = rs.state === 'FULL' || (rs.current > 0 && totalPortfolio >= 0);
  const basisGatePassing = cb.solCostBasis <= 0 || price >= basisThresholdPrice;

  // ChurnGuard
  let churnGuardClear = true;
  try {
    const lastExit = db.prepare("SELECT timestamp, price FROM decision_log WHERE decision IN ('T1_DOWNSIDE','OOR_BELOW') ORDER BY rowid DESC LIMIT 1").get() as { timestamp: number; price: number } | undefined;
    if (lastExit) {
      const ageMin = (Date.now() - lastExit.timestamp) / 60000;
      if ((ageMin < 15 || ageMin < 20) && price < lastExit.price) churnGuardClear = false;
    }
  } catch {}

  // Position proximity
  let proxLine = '';
  if (positionActive && live.positionRange) {
    const lower = live.positionRange.lower;
    const upper = live.positionRange.upper;
    const range = upper - lower;
    if (range > 0) {
      const proxLower = 1 - (price - lower) / range;
      const warning = proxLower > 0.60 ? ' — approaching exit' : '';
      proxLine = `\n📍 Proximity lower: ${(proxLower * 100).toFixed(1)}%${warning}`;
    }
  }

  // Fees
  const totalIL = live.ilUsdc + live.realizedIlUsdc;
  const netFees = live.totalFeesUsdc + totalIL - live.gasUsdc;

  const basisWarning = !aboveBasis && cb.solCostBasis > 0 ? '\n⚠️ Price below basis — do not swap' : '';

  const rangeLower = live.positionRange?.lower?.toFixed(2) ?? '?';
  const rangeUpper = live.positionRange?.upper?.toFixed(2) ?? '?';

  return [
    `🤖 sol-lp-bot status`,
    `⏰ ${formatTimeCET()}`,
    ``,
    `📊 Position: ${positionActive ? `ACTIVE $${rangeLower}-$${rangeUpper}` : 'IDLE'}`,
    `💰 Price: $${price.toFixed(2)}`,
    `📈 Regime: ${regime}`,
    ``,
    `💵 Portfolio: $${totalPortfolio.toFixed(0)}`,
    `   Wallet: $${walletValue.toFixed(0)} (${walletPct}%)`,
    `   LP: $${lpValue.toFixed(0)} (${lpPct}%)`,
    ``,
    `🏦 Reserve: $${rs.current.toFixed(0)} / $${rs.floor.toFixed(0)} (${rs.state})`,
    `📐 Basis: $${cb.solCostBasis.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    ``,
    `💸 Fees (MtM): $${live.totalFeesUsdc.toFixed(2)} | Pending: $${live.pendingFeesTotal.toFixed(2)} | Net: ${netFees >= 0 ? '+' : ''}$${netFees.toFixed(2)}`,
    ``,
    `🚦 Gates:`,
    `   Reserve: ${reserveGatePassing ? 'PASS' : 'BLOCK'}`,
    `   Basis: ${basisGatePassing ? 'PASS' : 'BLOCK'} (threshold $${basisThresholdPrice.toFixed(2)})`,
    `   ChurnGuard: ${churnGuardClear ? 'CLEAR' : 'ACTIVE'}`,
    `${proxLine}${basisWarning}`,
  ].filter(l => l !== undefined).join('\n').trim();
}
