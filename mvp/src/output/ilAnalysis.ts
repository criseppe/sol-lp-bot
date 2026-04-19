/**
 * IL Analysis page — comprehensive IL in context.
 *
 * Data source: rebalance_events (il_at_close, fee_usdc from closes and
 * FEE_HARVEST events) + bot_state.cum_gas_lamports.
 *
 * Phase 1 scope: sections 1-8 of design. Section 2 is a placeholder for
 * future AI commentary; sections 9-10 (patterns, AI recommendations) are
 * deferred to Phase 2.
 */

import type Database from 'better-sqlite3';
import { SHARED_STYLES, NAV_HTML } from './dashboard.js';

const CLOSE_EVENT_TYPES = ['T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'POSITION_CLOSED'] as const;
const CLOSE_SQL_LIST = CLOSE_EVENT_TYPES.map(t => `'${t}'`).join(',');

export interface IlAnalysisHero {
  netVsHodl: number;
  totalFees: number;
  totalIl: number;
  totalGas: number;
  ratio: number;
  healthStatus: 'healthy' | 'marginal' | 'losing';
}

export interface IlTimeWindow {
  period: string;
  fees: number;
  il: number;
  net: number;
  ratio: number;
  color: 'green' | 'yellow' | 'red';
}

export interface IlCumulativePoint { date: string; fees: number; il: number; net: number }

export interface IlRegimeRow {
  regime: string;
  positions: number;
  avgIl: number;
  avgFees: number;
  totalIl: number;
  totalFees: number;
  net: number;
  ratio: number;
}

export interface IlDistributionBucket {
  bucket: string;
  count: number;
  percentage: number;
}

export interface IlPositionRow {
  time: string;
  regime: string;
  eventType: string;
  ageMin: number | null;
  il: number;
  fees: number;
  net: number;
  priceChangePct: number | null;
  openPrice: number | null;
  closePrice: number;
}

export interface IlAnalysisData {
  hero: IlAnalysisHero;
  timeWindows: IlTimeWindow[];
  ratioHealth: { current30d: number; status: string; interpretation: string };
  cumulativeChart: IlCumulativePoint[];
  regimeBreakdown: IlRegimeRow[];
  ilDistribution: IlDistributionBucket[];
  positions: IlPositionRow[];
  lastUpdated: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function startOfUtcDayMs(d = new Date()): number {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  return utc;
}

function feeSumWhere(db: Database.Database, solPrice: number, whereTs: string, params: unknown[]): number {
  // USD-equivalent of both fee halves (matches Intelligence page convention).
  // Historical fee_sol is re-valued at current SOL price.
  const r = db.prepare(`SELECT COALESCE(SUM(fee_usdc + fee_sol * ?),0) as s FROM rebalance_events WHERE (fee_usdc > 0 OR fee_sol > 0) AND ${whereTs}`).get(solPrice, ...params as []) as { s: number };
  return r.s ?? 0;
}

function ilSumWhere(db: Database.Database, whereTs: string, params: unknown[]): number {
  const r = db.prepare(`SELECT COALESCE(SUM(il_at_close),0) as s FROM rebalance_events WHERE event_type IN (${CLOSE_SQL_LIST}) AND il_at_close IS NOT NULL AND ${whereTs}`).get(...params as []) as { s: number };
  return r.s ?? 0;
}

function healthColor(ratio: number): 'green' | 'yellow' | 'red' {
  if (!isFinite(ratio) || ratio >= 1.5) return 'green';
  if (ratio >= 1.0) return 'yellow';
  return 'red';
}

// ── Data layer ───────────────────────────────────────────────────────────

export function computeIlAnalysisData(db: Database.Database): IlAnalysisData {
  const now = Date.now();
  const todayStart = startOfUtcDayMs();
  const yesterdayStart = todayStart - 86_400_000;
  const sevenDayStart = now - 7 * 86_400_000;
  const thirtyDayStart = now - 30 * 86_400_000;

  // Current SOL price for USD-equivalent conversion of fee_sol across all
  // fee queries in this function. Historical fee_sol is valued at the
  // latest price (same convention as the Intelligence page).
  const solPrice = getCurrentSolPrice(db);

  // Hero — all time
  const totalFees = feeSumWhere(db, solPrice, 'timestamp > 0', []);
  const totalIl = ilSumWhere(db, 'timestamp > 0', []); // negative
  const absIl = Math.abs(totalIl);
  const gasRow = db.prepare('SELECT COALESCE(cum_gas_lamports, 0) as g FROM bot_state WHERE id = 1').get() as { g: number } | undefined;
  const totalGas = (gasRow?.g ?? 0) * 1e-9 * solPrice;
  const netVsHodl = totalFees + totalIl - totalGas; // il is negative already
  const ratio = absIl > 0 ? totalFees / absIl : Infinity;
  const healthStatus: 'healthy' | 'marginal' | 'losing' =
    ratio >= 1.5 ? 'healthy' : ratio >= 1.0 ? 'marginal' : 'losing';

  // Time windows
  const mkWindow = (period: string, startTs: number, endTs: number | null): IlTimeWindow => {
    const where = endTs != null ? 'timestamp >= ? AND timestamp < ?' : 'timestamp >= ?';
    const params = endTs != null ? [startTs, endTs] : [startTs];
    const fees = feeSumWhere(db, solPrice, where, params);
    const il = ilSumWhere(db, where, params);
    const absIl2 = Math.abs(il);
    const r = absIl2 > 0 ? fees / absIl2 : (fees > 0 ? Infinity : 0);
    return { period, fees, il, net: fees + il, ratio: r, color: healthColor(r) };
  };
  const timeWindows: IlTimeWindow[] = [
    mkWindow('Today (UTC)', todayStart, null),
    mkWindow('Yesterday', yesterdayStart, todayStart),
    mkWindow('Last 7 days', sevenDayStart, null),
    mkWindow('Last 30 days', thirtyDayStart, null),
    mkWindow('All time', 0, null),
  ];

  // Ratio health (30d)
  const win30 = timeWindows[3];
  let status: string;
  let interpretation: string;
  if (!isFinite(win30.ratio)) { status = 'no IL'; interpretation = 'No realized IL in the 30-day window.'; }
  else if (win30.ratio >= 2.0) { status = 'strong'; interpretation = 'Fees are covering IL by more than 2x.'; }
  else if (win30.ratio >= 1.5) { status = 'healthy'; interpretation = 'Fees comfortably cover IL with room to spare.'; }
  else if (win30.ratio >= 1.0) { status = 'marginal'; interpretation = 'Fees just cover IL. Small regime shift could tip negative.'; }
  else if (win30.ratio >= 0.5) { status = 'losing'; interpretation = 'Fees cover less than half of IL. Strategy is bleeding.'; }
  else { status = 'bleeding'; interpretation = 'IL far exceeds fees. Review range widths and Rule 2 thresholds.'; }

  // Cumulative chart — 30 daily buckets
  const dailyRows = db.prepare(`
    SELECT date(timestamp/1000,'unixepoch') as d,
           COALESCE(SUM(fee_usdc + fee_sol * ?),0) as fees,
           COALESCE(SUM(CASE WHEN event_type IN (${CLOSE_SQL_LIST}) THEN il_at_close ELSE 0 END),0) as il
    FROM rebalance_events
    WHERE timestamp >= ?
    GROUP BY d ORDER BY d ASC
  `).all(solPrice, thirtyDayStart) as Array<{ d: string; fees: number; il: number }>;
  const cumulativeChart: IlCumulativePoint[] = [];
  let cf = 0, ci = 0;
  for (const r of dailyRows) {
    cf += r.fees; ci += r.il;
    cumulativeChart.push({ date: r.d, fees: round2(cf), il: round2(ci), net: round2(cf + ci) });
  }

  // Regime breakdown
  const regimeRows = db.prepare(`
    SELECT regime,
           COUNT(*) as n,
           COALESCE(AVG(il_at_close),0) as avg_il,
           COALESCE(SUM(il_at_close),0) as total_il,
           COALESCE((SELECT SUM(fee_usdc + fee_sol * ?) FROM rebalance_events f WHERE f.regime = rebalance_events.regime AND (f.fee_usdc > 0 OR f.fee_sol > 0)),0) as total_fees
    FROM rebalance_events
    WHERE event_type IN (${CLOSE_SQL_LIST}) AND il_at_close IS NOT NULL
    GROUP BY regime ORDER BY total_il ASC
  `).all(solPrice) as Array<{ regime: string | null; n: number; avg_il: number; total_il: number; total_fees: number }>;
  const regimeBreakdown: IlRegimeRow[] = regimeRows.map(r => {
    const absIl3 = Math.abs(r.total_il ?? 0);
    return {
      regime: r.regime ?? 'UNKNOWN',
      positions: r.n,
      avgIl: round2(r.avg_il),
      avgFees: r.n > 0 ? round2(r.total_fees / r.n) : 0,
      totalIl: round2(r.total_il),
      totalFees: round2(r.total_fees),
      net: round2((r.total_fees ?? 0) + (r.total_il ?? 0)),
      ratio: absIl3 > 0 ? round2(r.total_fees / absIl3) : Infinity,
    };
  });

  // IL distribution
  const bucketDefs: Array<[string, (il: number) => boolean]> = [
    ['<= -$50',      il => il <= -50],
    ['-$50 to -$40', il => il > -50 && il <= -40],
    ['-$40 to -$30', il => il > -40 && il <= -30],
    ['-$30 to -$20', il => il > -30 && il <= -20],
    ['-$20 to -$10', il => il > -20 && il <= -10],
    ['-$10 to -$5',  il => il > -10 && il <= -5],
    ['-$5 to -$1',   il => il > -5 && il <= -1],
    ['-$1 to $0',    il => il > -1 && il <= 0],
    ['$0 to $5',     il => il > 0 && il <= 5],
    ['> $5',         il => il > 5],
  ];
  const allIl = db.prepare(`SELECT il_at_close as il FROM rebalance_events WHERE event_type IN (${CLOSE_SQL_LIST}) AND il_at_close IS NOT NULL`).all() as Array<{ il: number }>;
  const total = allIl.length;
  const ilDistribution: IlDistributionBucket[] = bucketDefs.map(([label, pred]) => {
    const count = allIl.filter(x => pred(x.il)).length;
    return { bucket: label, count, percentage: total > 0 ? round1(count / total * 100) : 0 };
  });

  // Per-position table (latest 50 closes with matched open)
  const closes = db.prepare(`
    SELECT timestamp as c_ts, event_type, regime, price as c_price, il_at_close as il, fee_usdc as fee, position_id
    FROM rebalance_events
    WHERE event_type IN (${CLOSE_SQL_LIST}) AND il_at_close IS NOT NULL
    ORDER BY timestamp DESC LIMIT 50
  `).all() as Array<{ c_ts: number; event_type: string; regime: string | null; c_price: number; il: number; fee: number; position_id: string | null }>;
  const openerStmt = db.prepare(`SELECT timestamp, price FROM rebalance_events WHERE position_id = ? AND event_type = 'POSITION_OPENED' ORDER BY timestamp ASC LIMIT 1`);
  const positions: IlPositionRow[] = closes.map(c => {
    const op = c.position_id ? openerStmt.get(c.position_id) as { timestamp: number; price: number } | undefined : undefined;
    const ageMin = op ? round1((c.c_ts - op.timestamp) / 60_000) : null;
    const priceChangePct = op && op.price > 0 ? round2((c.c_price - op.price) / op.price * 100) : null;
    return {
      time: new Date(c.c_ts).toISOString().replace('T', ' ').slice(0, 19),
      regime: c.regime ?? 'UNKNOWN',
      eventType: c.event_type,
      ageMin,
      il: round2(c.il),
      fees: round2(c.fee ?? 0),
      net: round2((c.fee ?? 0) + c.il),
      priceChangePct,
      openPrice: op ? round2(op.price) : null,
      closePrice: round2(c.c_price),
    };
  });

  return {
    hero: {
      netVsHodl: round2(netVsHodl),
      totalFees: round2(totalFees),
      totalIl: round2(totalIl),
      totalGas: round2(totalGas),
      ratio: isFinite(ratio) ? round2(ratio) : 0,
      healthStatus,
    },
    timeWindows: timeWindows.map(w => ({ ...w, fees: round2(w.fees), il: round2(w.il), net: round2(w.net), ratio: isFinite(w.ratio) ? round2(w.ratio) : 0 })),
    ratioHealth: { current30d: isFinite(win30.ratio) ? round2(win30.ratio) : 0, status, interpretation },
    cumulativeChart,
    regimeBreakdown,
    ilDistribution,
    positions,
    lastUpdated: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  };
}

function getCurrentSolPrice(db: Database.Database): number {
  const r = db.prepare(`SELECT price FROM live_snapshots ORDER BY timestamp DESC LIMIT 1`).get() as { price: number } | undefined;
  return r?.price ?? 0;
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round1(n: number): number { return Math.round((n + Number.EPSILON) * 10) / 10; }

// ── Rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function colorClass(color: 'green' | 'yellow' | 'red'): string {
  return color === 'green' ? 'green' : color === 'yellow' ? 'amber' : 'red';
}

function heroColor(h: IlAnalysisHero): string {
  if (h.healthStatus === 'healthy') return '#22c55e';
  if (h.healthStatus === 'marginal') return '#eab308';
  return '#ef4444';
}

function fmt(n: number | null, d = 2): string {
  if (n == null) return '—';
  return Number(n).toFixed(d);
}

function fmtSigned(n: number, d = 2): string {
  const s = Number(n).toFixed(d);
  return n > 0 ? `+${s}` : s;
}

function renderCumulativeSvg(points: IlCumulativePoint[]): string {
  if (points.length === 0) {
    return '<div style="color:#8b949e;text-align:center;padding:40px 0;font-size:12px">No data in the last 30 days.</div>';
  }
  const W = 720, H = 220, PAD_L = 48, PAD_R = 12, PAD_T = 12, PAD_B = 32;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const all = points.flatMap(p => [p.fees, p.il, p.net]);
  const minV = Math.min(0, ...all);
  const maxV = Math.max(0, ...all);
  const range = maxV - minV || 1;

  const xAt = (i: number) => PAD_L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * plotW);
  const yAt = (v: number) => PAD_T + plotH - ((v - minV) / range) * plotH;

  const mkPath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const fp = mkPath(points.map(p => p.fees));
  const ip = mkPath(points.map(p => p.il));
  const np = mkPath(points.map(p => p.net));

  const yZero = yAt(0);
  const yTicks = 5;
  const ticks: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = minV + (range * i) / yTicks;
    const y = yAt(v);
    ticks.push(`<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="#21262d" stroke-width="1"/>`);
    ticks.push(`<text x="${PAD_L - 6}" y="${(y + 3).toFixed(1)}" fill="#8b949e" font-size="9" text-anchor="end">$${v.toFixed(0)}</text>`);
  }

  const xLabels: string[] = [];
  const stepX = Math.max(1, Math.floor(points.length / 6));
  for (let i = 0; i < points.length; i += stepX) {
    const xa = xAt(i);
    xLabels.push(`<text x="${xa.toFixed(1)}" y="${(H - PAD_B + 14).toFixed(1)}" fill="#8b949e" font-size="9" text-anchor="middle">${esc(points[i].date.slice(5))}</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" xmlns="http://www.w3.org/2000/svg">
    ${ticks.join('')}
    <line x1="${PAD_L}" y1="${yZero.toFixed(1)}" x2="${W - PAD_R}" y2="${yZero.toFixed(1)}" stroke="#484f58" stroke-width="1" stroke-dasharray="3,3"/>
    <path d="${ip}" stroke="#ef4444" fill="none" stroke-width="1.6"/>
    <path d="${fp}" stroke="#22c55e" fill="none" stroke-width="1.6"/>
    <path d="${np}" stroke="#eab308" fill="none" stroke-width="2"/>
    ${xLabels.join('')}
    <g font-size="10" fill="#c9d1d9">
      <circle cx="${W - PAD_R - 100}" cy="${PAD_T + 4}" r="4" fill="#22c55e"/><text x="${W - PAD_R - 92}" y="${PAD_T + 7}">Fees</text>
      <circle cx="${W - PAD_R - 60}" cy="${PAD_T + 4}" r="4" fill="#ef4444"/><text x="${W - PAD_R - 52}" y="${PAD_T + 7}">IL</text>
      <circle cx="${W - PAD_R - 28}" cy="${PAD_T + 4}" r="4" fill="#eab308"/><text x="${W - PAD_R - 20}" y="${PAD_T + 7}">Net</text>
    </g>
  </svg>`;
}

function renderHistogram(buckets: IlDistributionBucket[]): string {
  const maxPct = buckets.reduce((m, b) => Math.max(m, b.percentage), 0) || 1;
  return buckets.map(b => {
    const w = (b.percentage / maxPct) * 100;
    const color = b.bucket.startsWith('<') || b.bucket.startsWith('-') ? '#ef4444' : '#22c55e';
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;padding:3px 0">
      <div style="width:110px;color:#8b949e;white-space:nowrap">${esc(b.bucket)}</div>
      <div style="flex:1;background:#21262d;border-radius:3px;height:14px;overflow:hidden"><div style="width:${w.toFixed(1)}%;height:100%;background:${color}"></div></div>
      <div style="width:70px;text-align:right;color:#c9d1d9">${b.count} <span style="color:#8b949e">(${b.percentage}%)</span></div>
    </div>`;
  }).join('');
}

function renderRatioBar(ratio: number): string {
  // Scale: 0 → 3.0, markers at 1.0 and 1.5
  const max = 3.0;
  const clamped = Math.min(Math.max(ratio, 0), max);
  const pct = (clamped / max) * 100;
  return `<div style="margin:10px 0">
    <div style="display:flex;height:22px;background:#21262d;border-radius:4px;overflow:hidden;position:relative">
      <div style="width:33.3%;background:#ef444430"></div>
      <div style="width:16.7%;background:#eab30830"></div>
      <div style="width:50%;background:#22c55e30"></div>
      <div style="position:absolute;top:-2px;bottom:-2px;left:${pct.toFixed(1)}%;width:3px;background:#58a6ff;transform:translateX(-1.5px)"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#8b949e;margin-top:3px">
      <span>0</span><span>1.0 (break-even)</span><span>1.5 (healthy)</span><span>3.0+</span>
    </div>
    <div style="margin-top:6px;font-size:12px"><b style="color:#58a6ff">${ratio.toFixed(2)}</b> — ${esc(status30dLabel(ratio))}</div>
  </div>`;
}

function status30dLabel(r: number): string {
  if (!isFinite(r) || r <= 0) return 'no data';
  if (r >= 2.0) return 'strong';
  if (r >= 1.5) return 'healthy';
  if (r >= 1.0) return 'marginal';
  if (r >= 0.5) return 'losing';
  return 'bleeding';
}

export function renderIlAnalysisHtml(data: IlAnalysisData): string {
  const h = data.hero;
  const heroColSub = h.ratio > 0 ? `fees $${h.totalFees.toFixed(2)} / IL $${Math.abs(h.totalIl).toFixed(2)} = ${h.ratio.toFixed(2)}x` : 'no realized IL yet';
  const heroCol = heroColor(h);

  const tw = data.timeWindows.map(w => {
    const col = colorClass(w.color);
    return `<tr>
      <td style="color:#c9d1d9">${esc(w.period)}</td>
      <td class="green">$${w.fees.toFixed(2)}</td>
      <td class="red">$${w.il.toFixed(2)}</td>
      <td class="${w.net >= 0 ? 'green' : 'red'}">$${fmtSigned(w.net)}</td>
      <td class="${col}">${isFinite(w.ratio) && w.ratio > 0 ? w.ratio.toFixed(2) + 'x' : '—'}</td>
    </tr>`;
  }).join('');

  const rb = data.regimeBreakdown.map(r => {
    const col = colorClass(healthColor(r.ratio));
    return `<tr>
      <td><span style="padding:1px 6px;border-radius:3px;font-size:10px;background:${regimeBadgeBg(r.regime)}20;color:${regimeBadgeBg(r.regime)}">${esc(r.regime)}</span></td>
      <td>${r.positions}</td>
      <td class="red">$${r.avgIl.toFixed(2)}</td>
      <td class="green">$${r.avgFees.toFixed(2)}</td>
      <td class="red">$${r.totalIl.toFixed(2)}</td>
      <td class="green">$${r.totalFees.toFixed(2)}</td>
      <td class="${r.net >= 0 ? 'green' : 'red'}">$${fmtSigned(r.net)}</td>
      <td class="${col}">${isFinite(r.ratio) && r.ratio > 0 ? r.ratio.toFixed(2) + 'x' : '—'}</td>
    </tr>`;
  }).join('');

  const posRows = data.positions.map(p => {
    const evtCol = p.eventType === 'T1_UPSIDE' ? '#22c55e' : p.eventType === 'T1_DOWNSIDE' ? '#ef4444' : '#eab308';
    const pc = p.priceChangePct;
    return `<tr>
      <td style="font-family:monospace;font-size:10px">${esc(p.time)}</td>
      <td><span style="padding:1px 6px;border-radius:3px;font-size:10px;background:${evtCol}20;color:${evtCol}">${esc(p.eventType)}</span></td>
      <td style="font-size:10px">${esc(p.regime)}</td>
      <td>${p.ageMin != null ? p.ageMin.toFixed(0) + 'm' : '—'}</td>
      <td>$${fmt(p.openPrice)}</td>
      <td>$${p.closePrice.toFixed(2)}</td>
      <td class="${pc != null && pc < 0 ? 'red' : 'green'}">${pc != null ? (pc >= 0 ? '+' : '') + pc.toFixed(2) + '%' : '—'}</td>
      <td class="red">$${p.il.toFixed(2)}</td>
      <td class="green">$${p.fees.toFixed(2)}</td>
      <td class="${p.net >= 0 ? 'green' : 'red'}">$${fmtSigned(p.net)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>IL Analysis — SOL/USDC LP Bot</title>
<style>${SHARED_STYLES}
.hero{text-align:center;padding:24px 12px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px}
.hero .big{font-size:42px;font-weight:bold;margin-bottom:6px}
.hero .subline{color:#8b949e;font-size:12px;margin-bottom:4px}
.hero .meta{display:flex;justify-content:center;gap:14px;flex-wrap:wrap;font-size:11px;color:#8b949e;margin-top:8px}
.hero .meta span b{color:#c9d1d9}
.placeholder{background:#0d1117;border:1px dashed #30363d;border-radius:6px;padding:10px;text-align:center;color:#8b949e;font-size:11px;font-style:italic}
@media(max-width:700px){.hero .big{font-size:28px}.hero{padding:16px 8px}}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#ef4444">IL Analysis &mdash; Fees vs. Impermanent Loss</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">IL is opportunity cost vs. HODL &mdash; this page puts it in context with fees and time.</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-il-analysis').classList.add('active')</script>

<!-- SECTION 1: Hero -->
<div class="hero">
  <div class="big" style="color:${heroCol}">${h.netVsHodl >= 0 ? '+' : ''}$${h.netVsHodl.toFixed(2)}</div>
  <div class="subline">Net vs HODL &mdash; all time</div>
  <div class="subline" style="color:${heroCol};text-transform:uppercase;letter-spacing:1px;font-size:10px;margin-top:8px">${h.healthStatus}</div>
  <div class="meta">
    <span>Fees: <b class="green">$${h.totalFees.toFixed(2)}</b></span>
    <span>IL: <b class="red">$${h.totalIl.toFixed(2)}</b></span>
    <span>Gas: <b>$${h.totalGas.toFixed(2)}</b></span>
    <span>Ratio: <b>${h.ratio > 0 ? h.ratio.toFixed(2) + 'x' : '—'}</b></span>
  </div>
  <div style="font-size:10px;color:#8b949e;margin-top:10px;font-style:italic">
    Fees are <b>realized-to-wallet only</b> (book-closed events in rebalance_events).
    Pending unharvested fees appear on the Live Wallet page.
    fee_sol valued at latest SOL price, matching Intelligence-page convention.
  </div>
</div>

<!-- SECTION 2: AI commentary placeholder -->
<div class="card full" style="margin-bottom:12px">
  <h2>Commentary</h2>
  <div class="placeholder">AI commentary &amp; pattern detection coming in Phase 2.<br>For now, see the regime breakdown and distribution below.</div>
</div>

<!-- SECTION 3: Time windows + Section 4: Ratio health -->
<div class="grid">
  <div class="card">
    <h2>Time Windows</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Period</th><th>Fees</th><th>IL</th><th>Net</th><th>Ratio</th></tr></thead>
        <tbody>${tw}</tbody>
      </table>
    </div>
    <div style="color:#8b949e;font-size:10px;margin-top:6px">Ratio color: green ≥1.5x · yellow ≥1.0x · red &lt;1.0x</div>
  </div>
  <div class="card">
    <h2>Ratio Health (30d)</h2>
    ${renderRatioBar(data.ratioHealth.current30d)}
    <div style="font-size:11px;color:#8b949e;margin-top:8px">${esc(data.ratioHealth.interpretation)}</div>
  </div>
</div>

<!-- SECTION 5: Cumulative chart -->
<div class="card full" style="margin-top:12px">
  <h2>Cumulative Fees / IL / Net (last 30 days)</h2>
  ${renderCumulativeSvg(data.cumulativeChart)}
</div>

<!-- SECTION 6: Regime breakdown + SECTION 7: Distribution -->
<div class="grid" style="margin-top:12px">
  <div class="card">
    <h2>By Regime (all time closes)</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Regime</th><th>N</th><th>Avg IL</th><th>Avg Fee</th><th>Total IL</th><th>Total Fee</th><th>Net</th><th>Ratio</th></tr></thead>
        <tbody>${rb || '<tr><td colspan="8" style="color:#8b949e;text-align:center">No closes yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>IL Distribution (all closes)</h2>
    ${renderHistogram(data.ilDistribution)}
  </div>
</div>

<!-- SECTION 8: Per-position table -->
<div class="card full" style="margin-top:12px">
  <h2>Latest Closes (up to 50)</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Time (UTC)</th><th>Event</th><th>Regime</th><th>Age</th><th>Open $</th><th>Close $</th><th>Δ%</th><th>IL</th><th>Fees</th><th>Net</th></tr></thead>
      <tbody>${posRows || '<tr><td colspan="10" style="color:#8b949e;text-align:center">No close events.</td></tr>'}</tbody>
    </table>
  </div>
</div>

<div style="text-align:center;color:#8b949e;font-size:10px;margin-top:16px;padding-bottom:16px">
  Last updated ${esc(data.lastUpdated)} &middot; auto-refresh every 60s
</div>
</body></html>`;
}

function regimeBadgeBg(regime: string): string {
  switch (regime) {
    case 'RANGING': return '#4a9eff';
    case 'BULLISH_TREND': return '#22c55e';
    case 'BEARISH_TREND': return '#ef4444';
    case 'EXTREME': return '#a855f7';
    default: return '#8b949e';
  }
}
