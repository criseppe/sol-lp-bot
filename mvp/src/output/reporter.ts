import nodemailer from 'nodemailer';
import type Database from 'better-sqlite3';
import { getLiveSnapshots, getLiveInRangePct, getDecisionLogs, getRegimeHistory, getRebalanceEvents } from '../db/sqlite.js';
import type { LiveData } from './dashboard.js';

export interface ReporterConfig {
  smtpUser: string;
  smtpPass: string;
  recipientEmail: string;
  intervalMs: number;
}

export function startReporter(
  config: ReporterConfig,
  db: Database.Database,
  getLiveData: () => LiveData | null,
): { stop: () => void } {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  // Send first report after 5 minutes, then every interval
  let timer: ReturnType<typeof setTimeout>;
  const scheduleNext = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        await generateAndSend(transporter, config, db, getLiveData);
      } catch (err) {
        console.log(JSON.stringify({ level: 'error', msg: 'report email failed', error: String(err), timestamp: Date.now() }));
      }
      scheduleNext(config.intervalMs);
    }, delayMs);
  };

  // First report after 5 min to collect some data
  scheduleNext(5 * 60_000);
  console.log(JSON.stringify({ level: 'info', msg: `reporter started, emails every ${config.intervalMs / 60_000}min to ${config.recipientEmail}`, timestamp: Date.now() }));

  return {
    stop() {
      clearTimeout(timer);
    },
  };
}

async function generateAndSend(
  transporter: nodemailer.Transporter,
  config: ReporterConfig,
  db: Database.Database,
  getLiveData: () => LiveData | null,
): Promise<void> {
  const now = Date.now();
  const live = getLiveData();
  const snapshots1h = getLiveSnapshots(db, 1);
  const snapshots24h = getLiveSnapshots(db, 24);
  const inRange1h = getLiveInRangePct(db, 1);
  const inRange24h = getLiveInRangePct(db, 24);
  const inRangeAll = getLiveInRangePct(db, 9999);
  const decisions = getDecisionLogs(db, 50);
  const regimeHist = getRegimeHistory(db, 10);
  const events = getRebalanceEvents(db, 20);

  // Compute metrics
  const actionDecisions = decisions.filter(d => d.decision !== 'HOLD');
  const holdDecisions = decisions.filter(d => d.decision === 'HOLD');
  const lastHourActions = actionDecisions.filter(d => d.timestamp > now - 3600_000);

  // Value change over last hour
  let valueChange1h = 0;
  let valueChangePct1h = 0;
  if (snapshots1h.length >= 2) {
    const first = snapshots1h[0].total_value_usdc;
    const last = snapshots1h[snapshots1h.length - 1].total_value_usdc;
    valueChange1h = last - first;
    valueChangePct1h = first > 0 ? (valueChange1h / first) * 100 : 0;
  }

  // Value change over 24h
  let valueChange24h = 0;
  let valueChangePct24h = 0;
  if (snapshots24h.length >= 2) {
    const first = snapshots24h[0].total_value_usdc;
    const last = snapshots24h[snapshots24h.length - 1].total_value_usdc;
    valueChange24h = last - first;
    valueChangePct24h = first > 0 ? (valueChange24h / first) * 100 : 0;
  }

  // Detect issues
  const issues: string[] = [];
  if (live && live.botState === 'HALTED') issues.push('BOT IS HALTED — circuit breaker triggered. Manual intervention may be needed.');
  if (inRange1h < 30) issues.push(`Low in-range rate last hour: ${inRange1h.toFixed(1)}%. Price may be drifting out of position bounds.`);
  if (live && !live.positionMint) issues.push('No open position. Bot may be waiting for pullback re-entry or encountered an error opening.');
  if (lastHourActions.length > 5) issues.push(`High activity: ${lastHourActions.length} actions in the last hour. May indicate volatile conditions or too-tight range.`);
  if (live && live.ilUsdc < -5) issues.push(`Significant IL: $${Math.abs(live.ilUsdc).toFixed(2)}. Price has moved considerably from entry.`);

  const latestSnap = snapshots1h.length > 0 ? snapshots1h[snapshots1h.length - 1] : null;

  // Build email
  const subject = `LP Bot Report — ${live?.botState ?? 'UNKNOWN'} | $${live?.totalValueUsdc.toFixed(2) ?? '--'} | ${issues.length > 0 ? issues.length + ' issue(s)' : 'All clear'}`;

  const fmt = (n: number, d = 2) => Math.abs(n).toFixed(d);
  const sign = (n: number) => n >= 0 ? '+' : '-';

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; background: #0d1117; color: #c9d1d9; padding: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #21262d; }
  .label { color: #8b949e; }
  .value { font-weight: bold; }
  .green { color: #22c55e; } .red { color: #ef4444; } .amber { color: #eab308; } .blue { color: #58a6ff; }
  .issue { background: #1c1917; border-left: 3px solid #ef4444; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; }
  .suggestion { background: #0c1f0c; border-left: 3px solid #22c55e; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; }
  .event { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #8b949e; padding: 4px; font-size: 11px; border-bottom: 1px solid #30363d; }
  td { padding: 4px; font-size: 12px; border-bottom: 1px solid #21262d; }
</style></head>
<body>
<div style="text-align:center;margin-bottom:20px">
  <div style="color:#58a6ff;font-size:16px;font-weight:bold">SOL/USDC LP Bot — Hourly Report</div>
  <div style="color:#8b949e;font-size:11px">${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</div>
</div>

${issues.length > 0 ? `
<div class="card">
  <h2 style="color:#ef4444">Issues Detected (${issues.length})</h2>
  ${issues.map(i => `<div class="issue">${i}</div>`).join('')}
</div>
` : `
<div class="card">
  <h2 style="color:#22c55e">Status: All Clear</h2>
  <div style="color:#8b949e">No issues detected this period.</div>
</div>
`}

<div class="card">
  <h2>Portfolio Overview</h2>
  <div class="row"><span class="label">Total Value</span><span class="value blue">$${live ? fmt(live.totalValueUsdc) : '--'}</span></div>
  <div class="row"><span class="label">SOL Balance</span><span class="value">${live ? fmt(live.solBalance, 6) : '--'} SOL ($${live ? fmt(live.solBalance * live.solPrice) : '--'})</span></div>
  <div class="row"><span class="label">USDC Balance</span><span class="value">${live ? fmt(live.usdcBalance, 6) : '--'}</span></div>
  <div class="row"><span class="label">SOL Price</span><span class="value">$${live ? fmt(live.solPrice) : '--'}</span></div>
  <div class="row"><span class="label">1h Change</span><span class="value ${valueChange1h >= 0 ? 'green' : 'red'}">${sign(valueChange1h)}$${fmt(Math.abs(valueChange1h))} (${sign(valueChangePct1h)}${fmt(Math.abs(valueChangePct1h), 1)}%)</span></div>
  <div class="row"><span class="label">24h Change</span><span class="value ${valueChange24h >= 0 ? 'green' : 'red'}">${sign(valueChange24h)}$${fmt(Math.abs(valueChange24h))} (${sign(valueChangePct24h)}${fmt(Math.abs(valueChangePct24h), 1)}%)</span></div>
</div>

<div class="card">
  <h2>Position & Fees</h2>
  <div class="row"><span class="label">Position</span><span class="value">${live?.positionMint ? 'OPEN' : 'NONE'}</span></div>
  ${live?.positionRange ? `<div class="row"><span class="label">Range</span><span class="value">$${fmt(live.positionRange.lower)} — $${fmt(live.positionRange.upper)}</span></div>` : ''}
  ${live?.entryPrice ? `<div class="row"><span class="label">Entry Price</span><span class="value">$${fmt(live.entryPrice)}</span></div>` : ''}
  <div class="row"><span class="label">Pending Fees</span><span class="value green">${live ? `${fmt(live.pendingFeesSol, 6)} SOL + ${fmt(live.pendingFeesUsdc, 6)} USDC ($${fmt(live.totalFeesUsdc)})` : '--'}</span></div>
  <div class="row"><span class="label">Impermanent Loss</span><span class="value ${live && live.ilUsdc < 0 ? 'red' : 'green'}">${live ? `${sign(live.ilUsdc)}$${fmt(Math.abs(live.ilUsdc))}` : '--'}</span></div>
  <div class="row"><span class="label">Net (Fees - IL)</span><span class="value ${live && (live.totalFeesUsdc + live.ilUsdc) >= 0 ? 'green' : 'red'}">${live ? `${sign(live.totalFeesUsdc + live.ilUsdc)}$${fmt(Math.abs(live.totalFeesUsdc + live.ilUsdc))}` : '--'}</span></div>
</div>

<div class="card">
  <h2>In-Range Performance</h2>
  <table>
    <tr><th>Period</th><th>In-Range %</th><th>Assessment</th></tr>
    <tr><td>Last 1h</td><td class="${inRange1h > 80 ? 'green' : inRange1h > 50 ? 'amber' : 'red'}">${fmt(inRange1h, 1)}%</td><td>${inRange1h > 80 ? 'Excellent' : inRange1h > 50 ? 'Acceptable' : 'Poor — consider widening range'}</td></tr>
    <tr><td>Last 24h</td><td class="${inRange24h > 80 ? 'green' : inRange24h > 50 ? 'amber' : 'red'}">${fmt(inRange24h, 1)}%</td><td>${inRange24h > 80 ? 'Excellent' : inRange24h > 50 ? 'Acceptable' : 'Poor — review range parameters'}</td></tr>
    <tr><td>All Time</td><td class="${inRangeAll > 80 ? 'green' : inRangeAll > 50 ? 'amber' : 'red'}">${fmt(inRangeAll, 1)}%</td><td>${inRangeAll > 80 ? 'Excellent' : inRangeAll > 50 ? 'Acceptable' : 'Needs attention'}</td></tr>
  </table>
</div>

<div class="card">
  <h2>Regime & Market</h2>
  <div class="row"><span class="label">Current Regime</span><span class="value">${live?.regime ?? '--'}</span></div>
  <div class="row"><span class="label">Bot State</span><span class="value">${live?.botState ?? '--'}</span></div>
  ${regimeHist.length > 0 ? `
  <div style="margin-top:8px;font-size:12px;color:#8b949e">Recent regime changes:</div>
  ${regimeHist.slice(0, 5).map(r => {
    const t = new Date(r.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #21262d">${t}: ${r.old_regime} → ${r.new_regime} (dirRatio=${r.dir_ratio?.toFixed(3)}, vol=${r.realised_vol?.toFixed(4)})</div>`;
  }).join('')}` : '<div style="color:#8b949e;font-size:11px;margin-top:8px">No regime changes recorded yet.</div>'}
</div>

<div class="card">
  <h2>Actions Taken (Last Hour: ${lastHourActions.length})</h2>
  ${lastHourActions.length > 0 ? lastHourActions.map(d => {
    const t = new Date(d.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `<div class="event"><strong>${d.decision}</strong> at ${t} ($${fmt(d.price)}) — ${d.reasoning}</div>`;
  }).join('') : '<div style="color:#8b949e">No actions taken in the last hour. Bot is holding position.</div>'}
</div>

<div class="card">
  <h2>Recent Decision Reasoning (Last 10)</h2>
  ${decisions.slice(0, 10).map(d => {
    const t = new Date(d.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const col = d.decision === 'HOLD' ? '#8b949e' : '#58a6ff';
    return `<div class="event"><span style="color:${col};font-weight:bold">${d.decision}</span> <span style="color:#8b949e">${t} · $${fmt(d.price)}</span><br/><span style="color:#c9d1d9">${d.reasoning}</span></div>`;
  }).join('') || '<div style="color:#8b949e">No decisions logged yet.</div>'}
</div>

${generateSuggestions(live, inRange1h, inRange24h, lastHourActions.length, issues, regimeHist)}

<div style="text-align:center;color:#8b949e;font-size:10px;margin-top:20px;padding-top:12px;border-top:1px solid #21262d">
  SOL/USDC LP Bot MVP · Dashboard: http://localhost:3000/live · Insights: http://localhost:3000/insights
</div>
</body>
</html>`;

  await transporter.sendMail({
    from: config.smtpUser,
    to: config.recipientEmail,
    subject,
    html,
  });

  console.log(JSON.stringify({ level: 'info', msg: 'report email sent', to: config.recipientEmail, issues: issues.length, timestamp: Date.now() }));
}

function generateSuggestions(
  live: LiveData | null,
  inRange1h: number,
  inRange24h: number,
  actionsLastHour: number,
  issues: string[],
  regimeHist: Array<{ old_regime: string; new_regime: string }>,
): string {
  const suggestions: string[] = [];

  if (inRange24h < 50) {
    suggestions.push('In-range rate is below 50% over 24h. Consider increasing <code>rangeWidthPct</code> for the current regime to capture more price movement.');
  }
  if (inRange24h > 95 && actionsLastHour === 0) {
    suggestions.push('Position is very stable (>95% in-range). You could tighten the range to earn more fees per unit of liquidity, at the cost of more frequent rebalances.');
  }
  if (actionsLastHour > 5) {
    suggestions.push('Too many rebalances. This burns gas and causes IL. Consider increasing proximity thresholds (<code>proxThresholdLower</code>, <code>proxThresholdUpper</code>) to reduce trigger sensitivity.');
  }
  if (live && live.ilUsdc < -3 && live.totalFeesUsdc < Math.abs(live.ilUsdc)) {
    suggestions.push('IL exceeds earned fees. The position is currently unprofitable vs holding. This is normal in trending markets — the regime detector should adjust parameters if the trend persists.');
  }
  if (live && live.botState === 'HALTED') {
    suggestions.push('Bot is halted. Review the circuit breaker that triggered (daily loss or IL limit). If market conditions have stabilized, restart the bot or call <code>resume()</code>.');
  }
  if (regimeHist.length > 3) {
    const recent = regimeHist.slice(0, 4);
    const regimes = new Set(recent.map(r => r.new_regime));
    if (regimes.size >= 3) {
      suggestions.push('Regime is oscillating frequently. Consider increasing <code>TREND_THRESHOLD</code> to require stronger directional signals before switching from RANGING.');
    }
  }
  if (live && !live.positionMint) {
    suggestions.push('No open position. If the bot is in pullback watch, it will re-enter automatically. If this persists, check logs for errors in position opening.');
  }
  if (suggestions.length === 0) {
    suggestions.push('No specific optimizations suggested at this time. Continue monitoring and let the bot accumulate more data for meaningful analysis.');
  }

  return `
<div class="card">
  <h2>Suggestions</h2>
  ${suggestions.map(s => `<div class="suggestion">${s}</div>`).join('')}
</div>`;
}
