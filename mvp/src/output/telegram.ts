import type Database from 'better-sqlite3';
import { getLiveSnapshots, getLiveInRangePct, getRebalanceEvents, getRegimeHistory, getBotState } from '../db/sqlite.js';
import type { LiveData } from './dashboard.js';
import type { MarketSignals } from '../data/market.js';

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
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

function fmt(n: number, d = 2): string { return n.toFixed(d); }
function sign(n: number): string { return n >= 0 ? '+' : ''; }

function buildReport(
  db: Database.Database,
  getLiveData: () => LiveData | null,
  getMarketSignals: () => MarketSignals | null,
): string {
  const now = Date.now();
  const live = getLiveData();
  const mkt = getMarketSignals();
  const state = getBotState(db);
  const snapshots1h = getLiveSnapshots(db, 1);
  const inRange1h = getLiveInRangePct(db, 1);
  const inRange24h = getLiveInRangePct(db, 24);
  const regimeHist = getRegimeHistory(db, 5);
  const events = getRebalanceEvents(db, 20);
  const lastHourEvents = events.filter(e => e.timestamp > now - 3_600_000);

  // Value change 10min
  let change10m = 0;
  if (snapshots1h.length >= 2) {
    const recent = snapshots1h[snapshots1h.length - 1];
    const tenMinAgo = snapshots1h.find((_, i) => i >= snapshots1h.length - 11);
    if (tenMinAgo) change10m = (recent.total_with_position ?? recent.total_value_usdc) - (tenMinAgo.total_with_position ?? tenMinAgo.total_value_usdc);
  }

  const lines: string[] = [];

  // ── Header ──
  const alertIcon = !live ? '🔴' : live.botState === 'HALTED' ? '🔴' : !live.positionMint ? '🟡' : '🟢';
  lines.push(`${alertIcon} <b>LP Bot</b> | ${live?.botState ?? 'UNKNOWN'} | ${live?.regime ?? '--'}`);
  lines.push('');

  // ── Alerts ──
  const alerts: string[] = [];
  if (live?.botState === 'HALTED') alerts.push('BOT HALTED — circuit breaker');
  if (live && !live.positionMint) alerts.push('No open position');
  if (inRange1h < 30) alerts.push(`Low in-range: ${fmt(inRange1h, 0)}%`);
  if (live && live.ilUsdc < -5) alerts.push(`IL: -$${fmt(Math.abs(live.ilUsdc))}`);

  if (alerts.length > 0) {
    alerts.forEach(a => lines.push(`⚠️ ${a}`));
    lines.push('');
  }

  // ── Price & Portfolio ──
  if (live) {
    lines.push(`<b>SOL</b> $${fmt(live.solPrice)} (${sign(change10m)}$${fmt(Math.abs(change10m))} 10m)`);
    lines.push(`<b>Total</b> $${fmt(live.totalValueWithPosition)} | Pos $${fmt(live.positionValueUsdc)} | Wallet $${fmt(live.totalValueUsdc)}`);
    lines.push('');
  }

  // ── Position ──
  if (live?.positionRange) {
    const lower = live.positionRange.lower;
    const upper = live.positionRange.upper;
    const centre = (lower + upper) / 2;
    const hw = (upper - lower) / 2;
    const proxDown = hw > 0 ? Math.max(0, (centre - live.solPrice) / hw) : 0;
    const proxUp = hw > 0 ? Math.max(0, (live.solPrice - centre) / hw) : 0;
    const distDown = ((live.solPrice - lower) / live.solPrice * 100);
    const distUp = ((upper - live.solPrice) / live.solPrice * 100);
    const age = live.entryTime ? ((now - live.entryTime) / 3_600_000) : 0;

    lines.push(`<b>Range</b> $${fmt(lower)}-$${fmt(upper)} (${fmt((upper - lower) / centre * 100, 1)}%)`);
    lines.push(`<b>Prox</b> ↓${fmt(proxDown * 100, 0)}% ↑${fmt(proxUp * 100, 0)}% | Dist ↓$${fmt(live.solPrice - lower)} ↑$${fmt(upper - live.solPrice)}`);
    if (live.entryPrice) {
      lines.push(`<b>Entry</b> $${fmt(live.entryPrice)} (${sign(live.solPrice - live.entryPrice)}${fmt(Math.abs((live.solPrice - live.entryPrice) / live.entryPrice * 100), 1)}%) | Age ${fmt(age, 1)}h`);
    }

    // Proximity warning
    if (proxDown > 0.5 || proxUp > 0.5) {
      const dir = proxDown > proxUp ? 'LOWER' : 'UPPER';
      const pct = Math.max(proxDown, proxUp) * 100;
      lines.push(`⚠️ <b>Drifting toward ${dir} bound (${fmt(pct, 0)}%)</b>`);
    }
    lines.push('');

    // In-range
    lines.push(`<b>In-range</b> 1h: ${fmt(inRange1h, 0)}% | 24h: ${fmt(inRange24h, 0)}%`);
    lines.push('');
  } else {
    lines.push('No position open');
    if (state?.pullback_active) {
      const waitH = state.pullback_start ? ((now - state.pullback_start) / 3_600_000) : 0;
      lines.push(`Pullback watch: peak $${fmt(state.pullback_peak ?? 0)}, waiting ${fmt(waitH, 1)}h`);
    }
    lines.push('');
  }

  // ── Fees & PnL ──
  if (live) {
    const pendingTotal = live.pendingFeesTotal;
    const harvestedTotal = live.totalFeesUsdc - pendingTotal;
    const totalIL = live.ilUsdc + live.realizedIlUsdc;
    const net = live.totalFeesUsdc + totalIL - live.gasUsdc;

    lines.push(`<b>Fees</b> pending $${fmt(pendingTotal)} | harvested $${fmt(harvestedTotal)} | total $${fmt(live.totalFeesUsdc)}`);
    lines.push(`<b>IL</b> $${fmt(totalIL)} | <b>Gas</b> $${fmt(live.gasUsdc)} (${live.txCount} txs)`);
    lines.push(`<b>Net</b> ${sign(net)}$${fmt(Math.abs(net))} ${net >= 0 ? '✅' : '❌'}`);
    lines.push('');
  }

  // ── Market Signals ──
  if (mkt) {
    lines.push('<b>📡 Market Signals</b>');
    if (mkt.vol1h != null) {
      const status = mkt.vol1h > 0.06 ? '🔴 HIGH' : mkt.vol1h > 0.04 ? '🟡' : '🟢 calm';
      lines.push(`Vol 1h: ${fmt(mkt.vol1h, 4)} ${status} (EXTREME if &gt;0.06)`);
    }
    if (mkt.vol4h != null) {
      const status = mkt.vol4h > 0.05 ? '🔴 HIGH' : mkt.vol4h > 0.035 ? '🟡' : '🟢 calm';
      lines.push(`Vol 4h: ${fmt(mkt.vol4h, 4)} ${status} (EXTREME if &gt;0.05+spike)`);
    }
    if (mkt.solDelta24h != null) {
      const status = Math.abs(mkt.solDelta24h) > 4 ? '🔴 strong move' : '🟢 mild';
      lines.push(`SOL 24h: ${sign(mkt.solDelta24h)}${fmt(mkt.solDelta24h, 1)}% ${status} (trend if &gt;±4%)`);
    }
    if (mkt.btcDelta24h != null) {
      const macro = Math.abs(mkt.btcDelta24h) > 3 ? '⚡ macro event' : '';
      lines.push(`BTC 24h: ${sign(mkt.btcDelta24h)}${fmt(mkt.btcDelta24h, 1)}% ${macro} (macro if &gt;±3%)`);
    }
    if (mkt.volumeRatio4h != null) {
      const status = mkt.volumeRatio4h > 3 ? '🔴 SPIKE' : mkt.volumeRatio4h > 2 ? '🟡 elevated' : '🟢 normal';
      lines.push(`Vol ratio: ${fmt(mkt.volumeRatio4h, 1)}x ${status} (spike if &gt;3x)`);
    } else {
      lines.push('Vol ratio: building... (needs ~1h of data)');
    }
    if (mkt.fearGreedIndex != null) {
      const emoji = mkt.fearGreedIndex < 25 ? '😨' : mkt.fearGreedIndex < 40 ? '😟' : mkt.fearGreedIndex > 75 ? '🤑' : mkt.fearGreedIndex > 60 ? '😊' : '😐';
      lines.push(`F&amp;G: ${mkt.fearGreedIndex}/100 ${emoji} ${mkt.fearGreedLabel ?? ''}`);
    }
    if (mkt.errors.length > 0) {
      lines.push(`<i>API errors: ${mkt.errors.join(', ').slice(0, 100)}</i>`);
    }
    lines.push('');
  }

  // ── Regime ──
  lines.push(`<b>Regime</b> ${live?.regime ?? '--'}`);
  if (regimeHist.length > 0) {
    const last = regimeHist[0];
    const ago = ((now - last.timestamp) / 3_600_000);
    lines.push(`Last change: ${last.old_regime} → ${last.new_regime} (${fmt(ago, 1)}h ago)`);
  }
  lines.push('');

  // ── Summary ──
  if (mkt && live) {
    const summaryParts: string[] = [];

    // Volatility assessment
    if (mkt.vol1h != null && mkt.vol4h != null) {
      if (mkt.vol1h > 0.06 || mkt.vol4h > 0.05) summaryParts.push('High volatility — EXTREME conditions');
      else if (mkt.vol1h > 0.04 || mkt.vol4h > 0.035) summaryParts.push('Volatility rising — watch closely');
      else summaryParts.push('Low volatility — market quiet');
    }

    // SOL direction
    if (mkt.solDelta24h != null) {
      if (mkt.solDelta24h < -4) summaryParts.push('SOL in strong downtrend');
      else if (mkt.solDelta24h < -2) summaryParts.push('SOL drifting down');
      else if (mkt.solDelta24h > 4) summaryParts.push('SOL in strong uptrend');
      else if (mkt.solDelta24h > 2) summaryParts.push('SOL pushing up');
      else summaryParts.push('SOL flat');
    }

    // BTC correlation
    if (mkt.btcDelta24h != null && mkt.solDelta24h != null && Math.abs(mkt.btcDelta24h) > 3) {
      const same = (mkt.btcDelta24h > 0) === (mkt.solDelta24h > 0);
      summaryParts.push(same ? 'correlated with BTC macro move' : 'diverging from BTC');
    }

    // Sentiment
    if (mkt.fearGreedIndex != null) {
      if (mkt.fearGreedIndex < 25) summaryParts.push('extreme fear in market');
      else if (mkt.fearGreedIndex > 75) summaryParts.push('extreme greed in market');
    }

    // Volume
    if (mkt.volumeRatio4h != null && mkt.volumeRatio4h > 3) {
      summaryParts.push('volume spike detected');
    }

    if (summaryParts.length > 0) {
      lines.push(`💬 ${summaryParts.join(', ')}.`);
      lines.push('');
    }
  }

  // ── Activity ──
  const realActions = lastHourEvents.filter(e =>
    ['POSITION_OPENED', 'POSITION_CLOSED', 'T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'PULLBACK_REENTRY', 'PULLBACK_TIMEOUT', 'FEE_HARVEST', 'AUTO_DEPLOY', 'LIQUIDITY_ADDED'].includes(e.eventType)
  );
  if (realActions.length > 0) {
    lines.push(`<b>Events</b> (${realActions.length} last hour)`);
    realActions.slice(0, 5).forEach(e => {
      const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const note = e.note ? e.note.split('\n')[0].slice(0, 80) : '';
      lines.push(`${t} <b>${e.eventType}</b> $${fmt(e.price)} ${note}`);
    });
  } else {
    lines.push('No events last hour — holding');
  }

  return lines.join('\n');
}
