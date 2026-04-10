import type Database from 'better-sqlite3';
import { getLiveSnapshots, getLiveInRangePct, getDecisionLogs, getRegimeHistory, getRebalanceEvents } from '../db/sqlite.js';
import type { LiveData } from './dashboard.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  intervalMs: number;
}

export function startTelegramReporter(
  config: TelegramConfig,
  db: Database.Database,
  getLiveData: () => LiveData | null,
): { stop: () => void; sendNow: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout>;

  const send = async () => {
    try {
      const text = buildReport(db, getLiveData);
      await sendTelegram(config.botToken, config.chatId, text);
      console.log(JSON.stringify({ level: 'info', msg: 'telegram report sent', timestamp: Date.now() }));
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'telegram report failed', error: String(err), timestamp: Date.now() }));
    }
  };

  const scheduleNext = (delayMs: number) => {
    timer = setTimeout(async () => {
      await send();
      scheduleNext(config.intervalMs);
    }, delayMs);
  };

  // First report after 3 min
  scheduleNext(3 * 60_000);
  console.log(JSON.stringify({ level: 'info', msg: `telegram reporter started, every ${config.intervalMs / 60_000}min`, timestamp: Date.now() }));

  return { stop: () => clearTimeout(timer), sendNow: send };
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

function fmt(n: number, d = 2): string {
  return Math.abs(n).toFixed(d);
}

function sign(n: number): string {
  return n >= 0 ? '+' : '-';
}

function buildReport(db: Database.Database, getLiveData: () => LiveData | null): string {
  const now = Date.now();
  const live = getLiveData();
  const snapshots1h = getLiveSnapshots(db, 1);
  const inRange1h = getLiveInRangePct(db, 1);
  const inRange24h = getLiveInRangePct(db, 24);
  const inRangeAll = getLiveInRangePct(db, 9999);
  const decisions = getDecisionLogs(db, 20);
  const regimeHist = getRegimeHistory(db, 5);
  const recentEvents = getRebalanceEvents(db, 10);

  const lastHourEvents = recentEvents.filter(e => e.timestamp > now - 3600_000);
  // Count only real rebalances (not regime evals, restores, price updates)
  const realRebalances = lastHourEvents.filter(e => ['POSITION_OPENED', 'T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'PULLBACK_REENTRY', 'PULLBACK_TIMEOUT'].includes(e.eventType));

  let valueChange1h = 0;
  if (snapshots1h.length >= 2) {
    const first = (snapshots1h[0] as any).total_with_position ?? snapshots1h[0].total_value_usdc;
    const last = (snapshots1h[snapshots1h.length - 1] as any).total_with_position ?? snapshots1h[snapshots1h.length - 1].total_value_usdc;
    valueChange1h = last - first;
  }

  // Issues
  const issues: string[] = [];
  if (live?.botState === 'HALTED') issues.push('🔴 BOT HALTED — circuit breaker triggered');
  if (inRange1h < 30) issues.push(`🟡 Low in-range: ${fmt(inRange1h, 0)}% (1h)`);
  if (live && !live.positionMint) issues.push('🟡 No open position');
  if (realRebalances.length > 5) issues.push(`🟡 High activity: ${realRebalances.length} rebalances/hour`);
  if (live && live.ilUsdc < -5) issues.push(`🔴 IL: -$${fmt(Math.abs(live.ilUsdc))}`);

  const lines: string[] = [];

  // Header
  lines.push(`<b>🤖 SOL/USDC LP Bot Report</b>`);
  lines.push(`${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`);
  lines.push('');

  // Issues
  if (issues.length > 0) {
    lines.push(`<b>⚠️ Issues (${issues.length})</b>`);
    issues.forEach(i => lines.push(i));
    lines.push('');
  } else {
    lines.push('✅ <b>All clear</b> — no issues');
    lines.push('');
  }

  // Portfolio
  lines.push('<b>💰 Portfolio</b>');
  if (live) {
    lines.push(`Total: <b>$${fmt(live.totalValueWithPosition)}</b>`);
    lines.push(`Wallet: ${fmt(live.solBalance, 4)} SOL + ${fmt(live.usdcBalance, 2)} USDC ($${fmt(live.totalValueUsdc)})`);
    if (live.positionMint) {
      lines.push(`Position: ${fmt(live.positionSol, 4)} SOL + ${fmt(live.positionUsdc, 2)} USDC ($${fmt(live.positionValueUsdc)})`);
    }
    lines.push(`SOL Price: $${fmt(live.solPrice)}`);
    lines.push(`1h change: ${sign(valueChange1h)}$${fmt(Math.abs(valueChange1h))}`);
  } else {
    lines.push('No live data yet');
  }
  lines.push('');

  // Position
  lines.push('<b>📊 Position</b>');
  if (live?.positionRange) {
    lines.push(`Range: $${fmt(live.positionRange.lower)} — $${fmt(live.positionRange.upper)}`);
    lines.push(`Entry: $${fmt(live.entryPrice ?? 0)} → Now: $${fmt(live.solPrice)}`);
    const pctChange = live.entryPrice ? ((live.solPrice - live.entryPrice) / live.entryPrice * 100) : 0;
    lines.push(`Price change: ${sign(pctChange)}${fmt(Math.abs(pctChange), 2)}%`);
    lines.push(`Pending fees: $${fmt(live.pendingFeesTotal)} (${fmt(live.pendingFeesSol, 6)} SOL + ${fmt(live.pendingFeesUsdc, 4)} USDC)`);
    lines.push(`Harvested fees: $${fmt(live.cumHarvestedFeesSol * live.solPrice + live.cumHarvestedFeesUsdc)}`);
    lines.push(`Total fees: $${fmt(live.totalFeesUsdc)}`);
    lines.push(`IL: ${sign(live.ilUsdc)}$${fmt(Math.abs(live.ilUsdc))}`);
    lines.push(`Gas: -$${fmt(live.gasUsdc, 4)} (${fmt(live.gasSol, 6)} SOL, ${live.txCount} txs)`);
    const totalIl = live.ilUsdc + live.realizedIlUsdc;
    const net = live.totalFeesUsdc + totalIl - live.gasUsdc;
    lines.push(`Net PnL: ${sign(net)}$${fmt(Math.abs(net))} ${net >= 0 ? '✅' : '❌'} (fees - IL - gas)`);
  } else {
    lines.push('No open position');
  }
  lines.push('');

  // In-range
  lines.push('<b>📏 In-Range</b>');
  const emojiRange = (pct: number) => pct > 80 ? '🟢' : pct > 50 ? '🟡' : '🔴';
  lines.push(`1h: ${emojiRange(inRange1h)} ${fmt(inRange1h, 0)}% | 24h: ${emojiRange(inRange24h)} ${fmt(inRange24h, 0)}% | All: ${emojiRange(inRangeAll)} ${fmt(inRangeAll, 0)}%`);
  lines.push('');

  // Regime
  lines.push(`<b>🌊 Regime:</b> ${live?.regime ?? '--'} | State: ${live?.botState ?? '--'}`);
  if (regimeHist.length > 0) {
    const latest = regimeHist[0];
    const t = new Date(latest.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    lines.push(`Last change: ${latest.old_regime} → ${latest.new_regime} at ${t}`);
  }
  lines.push('');

  // Events (last hour) — includes rebalances, swaps, regime changes
  lines.push(`<b>📋 Events (last hour: ${lastHourEvents.length})</b>`);
  if (lastHourEvents.length > 0) {
    lastHourEvents.slice(0, 8).forEach(e => {
      const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      lines.push(`${t} <b>${e.eventType}</b> $${fmt(e.price)}`);
      if (e.note) lines.push(`  └ ${e.note.slice(0, 150)}`);
    });
  } else {
    lines.push('No events — holding position');
  }
  // Regime changes
  if (regimeHist.length > 0) {
    const recentRegimeChanges = regimeHist.filter(r => r.timestamp > now - 3600_000);
    if (recentRegimeChanges.length > 0) {
      lines.push('');
      lines.push('<b>🔄 Regime Changes</b>');
      recentRegimeChanges.forEach(r => {
        const t = new Date(r.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        lines.push(`${t} ${r.old_regime} → <b>${r.new_regime}</b> at $${fmt(r.price)}`);
        lines.push(`  └ dirRatio=${r.dir_ratio?.toFixed(3)}, vol=${r.realised_vol?.toFixed(4)}, ${r.price_count} closes`);
      });
    }
  }
  lines.push('');

  // Suggestions
  lines.push('<b>💡 Suggestions</b>');
  if (inRange24h < 50) {
    lines.push('• Consider widening range (increase rangeWidthPct)');
  }
  if (realRebalances.length > 5) {
    lines.push('• Too many rebalances — increase proximity thresholds');
  }
  if (live && live.ilUsdc < -3) {
    lines.push('• Significant IL detected — price has moved from entry');
  }
  if (live?.botState === 'HALTED') {
    lines.push('• Bot halted — check dashboard and consider resuming');
  }
  if (!issues.length && realRebalances.length <= 5 && inRange24h >= 50) {
    lines.push('• No changes needed — continue monitoring');
  }

  return lines.join('\n');
}
