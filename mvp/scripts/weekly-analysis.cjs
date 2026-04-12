/**
 * Weekly Execution Analysis Agent
 * Reads bot data from the last 7 days and produces optimization suggestions.
 * Run: node scripts/weekly-analysis.cjs [--telegram] [--days=7]
 *
 * Purely read-only — does NOT modify bot state, config, or positions.
 */

const Database = require('better-sqlite3');
require('dotenv/config');

const db = new Database('./data/mvp.db');
const args = process.argv.slice(2);
const sendTelegram = args.includes('--telegram');
const daysArg = args.find(a => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1]) : 7;
const now = Date.now();
const since = now - days * 86400000;
const TZ = 'Europe/Berlin';

function fmt(n, d = 2) { return n.toFixed(d); }

// ── 1. Position Duration Analysis ──

const events = db.prepare(`
  SELECT timestamp, event_type, price, fee_sol, fee_usdc, il_at_close, note
  FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp ASC
`).all(since);

const openEvents = events.filter(e => e.event_type === 'POSITION_OPENED');
const closeEvents = events.filter(e => ['T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'POSITION_CLOSED'].includes(e.event_type));

const positions = [];
let lastOpen = null;
for (const e of events) {
  if (e.event_type === 'POSITION_OPENED') {
    lastOpen = { timestamp: e.timestamp, price: e.price };
  } else if (['T1_DOWNSIDE', 'T1_UPSIDE', 'OOR_BELOW', 'OOR_ABOVE', 'POSITION_CLOSED'].includes(e.event_type) && lastOpen) {
    positions.push({
      duration: (e.timestamp - lastOpen.timestamp) / 3600000,
      closeReason: e.event_type,
      openPrice: lastOpen.price,
      closePrice: e.price,
      feeSol: e.fee_sol || 0,
      feeUsdc: e.fee_usdc || 0,
      il: e.il_at_close || 0,
    });
    lastOpen = null;
  }
}

// ── 2. Fee Rate by Hour of Day ──

const snapshots = db.prepare(`
  SELECT timestamp, price, pending_fees_sol, pending_fees_usdc, cum_fees_sol, cum_fees_usdc, in_range, regime, position_value
  FROM live_snapshots WHERE timestamp > ? ORDER BY timestamp ASC
`).all(since);

const hourlyFees = {};
for (let h = 0; h < 24; h++) hourlyFees[h] = { totalFees: 0, count: 0, inRangeCount: 0 };

for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1];
  const curr = snapshots[i];
  const h = new Date(curr.timestamp).getUTCHours(); // Use UTC, consistent across systems
  const prevTotal = (prev.cum_fees_sol * prev.price + prev.cum_fees_usdc) + (prev.pending_fees_sol * prev.price + prev.pending_fees_usdc);
  const currTotal = (curr.cum_fees_sol * curr.price + curr.cum_fees_usdc) + (curr.pending_fees_sol * curr.price + curr.pending_fees_usdc);
  const feeDelta = currTotal - prevTotal;
  if (feeDelta > 0 && feeDelta < 100) { // sanity: skip harvest resets
    hourlyFees[h].totalFees += feeDelta;
    hourlyFees[h].count++;
  }
  if (curr.in_range) hourlyFees[h].inRangeCount++;
}

// ── 3. Fee Rate by Regime ──

const regimeFees = {};
for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1];
  const curr = snapshots[i];
  const regime = curr.regime || 'UNKNOWN';
  if (!regimeFees[regime]) regimeFees[regime] = { totalFees: 0, hours: 0, inRange: 0, total: 0 };
  const elapsed = (curr.timestamp - prev.timestamp) / 3600000;
  const prevTotal = (prev.cum_fees_sol * prev.price + prev.cum_fees_usdc) + (prev.pending_fees_sol * prev.price + prev.pending_fees_usdc);
  const currTotal = (curr.cum_fees_sol * curr.price + curr.cum_fees_usdc) + (curr.pending_fees_sol * curr.price + curr.pending_fees_usdc);
  const feeDelta = currTotal - prevTotal;
  if (feeDelta > 0 && feeDelta < 100) regimeFees[regime].totalFees += feeDelta;
  regimeFees[regime].hours += elapsed;
  regimeFees[regime].total++;
  if (curr.in_range) regimeFees[regime].inRange++;
}

// ── 4. Unnecessary Exits (closed, price came back within 10min) ──

let unnecessaryExits = 0;
let unnecessaryGas = 0;
for (let i = 0; i < positions.length; i++) {
  const pos = positions[i];
  if (pos.closeReason === 'T1_DOWNSIDE' || pos.closeReason === 'T1_UPSIDE') {
    // Check if next position opened at similar price (price bounced back)
    if (i + 1 < positions.length) {
      const next = positions[i + 1];
      const priceDiff = Math.abs(next.openPrice - pos.closePrice) / pos.closePrice * 100;
      if (priceDiff < 0.3 && pos.duration < 0.5) {
        unnecessaryExits++;
        unnecessaryGas += 0.84; // est. gas+swap cost per close+reopen
      }
    }
  }
}

// ── 5. Gas Efficiency ──

const harvests = events.filter(e => e.event_type === 'FEE_HARVEST');
const totalHarvestedUsdc = harvests.reduce((s, e) => s + (e.fee_sol || 0) * e.price + (e.fee_usdc || 0), 0);
const state = db.prepare('SELECT cum_gas_lamports, tx_count FROM bot_state WHERE id=1').get();
const totalGasUsdc = (state.cum_gas_lamports / 1e9) * (snapshots.length > 0 ? snapshots[snapshots.length - 1].price : 82);

// ── 6. Volume Pattern (weekend vs weekday) ──

const dayOfWeekFees = { weekday: { fees: 0, hours: 0 }, weekend: { fees: 0, hours: 0 } };
for (let i = 1; i < snapshots.length; i++) {
  const curr = snapshots[i];
  const prev = snapshots[i - 1];
  const day = new Date(curr.timestamp).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  const isWeekend = day === 'Sat' || day === 'Sun';
  const bucket = isWeekend ? dayOfWeekFees.weekend : dayOfWeekFees.weekday;
  const elapsed = (curr.timestamp - prev.timestamp) / 3600000;
  const prevTotal = (prev.cum_fees_sol * prev.price + prev.cum_fees_usdc) + (prev.pending_fees_sol * prev.price + prev.pending_fees_usdc);
  const currTotal = (curr.cum_fees_sol * curr.price + curr.cum_fees_usdc) + (curr.pending_fees_sol * curr.price + curr.pending_fees_usdc);
  const feeDelta = currTotal - prevTotal;
  if (feeDelta > 0 && feeDelta < 100) bucket.fees += feeDelta;
  bucket.hours += elapsed;
}

// ── 7. Proximity Threshold Analysis ──

const decisions = db.prepare(`
  SELECT timestamp, price, prox_lower, prox_upper, decision, reasoning, params_json
  FROM decision_log WHERE timestamp > ? AND decision IN ('T1_DOWNSIDE', 'T1_UPSIDE', 'HOLD')
  ORDER BY timestamp ASC
`).all(since);

const t1Exits = decisions.filter(d => d.decision === 'T1_DOWNSIDE' || d.decision === 'T1_UPSIDE');
const avgProxAtExit = t1Exits.length > 0
  ? t1Exits.reduce((s, d) => s + Math.max(d.prox_lower || 0, d.prox_upper || 0), 0) / t1Exits.length
  : 0;

// ── BUILD REPORT ──

const lines = [];
lines.push('📊 WEEKLY EXECUTION ANALYSIS');
lines.push('Period: ' + days + ' days ending ' + new Date().toLocaleDateString('en-CA', { timeZone: TZ }));
lines.push('Data: ' + snapshots.length + ' snapshots, ' + positions.length + ' positions, ' + events.length + ' events');
lines.push('');

// Position Duration
lines.push('⏱️ POSITION DURATION');
if (positions.length > 0) {
  const durations = positions.map(p => p.duration).sort((a, b) => a - b);
  lines.push('  Avg: ' + fmt(durations.reduce((s, v) => s + v, 0) / durations.length, 1) + 'h | Med: ' + fmt(durations[Math.floor(durations.length / 2)], 1) + 'h');
  lines.push('  Range: ' + fmt(durations[0], 1) + 'h — ' + fmt(durations[durations.length - 1], 1) + 'h');
  const under1h = durations.filter(d => d < 1).length;
  lines.push('  <1h: ' + under1h + '/' + positions.length + ' (' + fmt(under1h / positions.length * 100, 0) + '%)');

  // Close reasons
  const reasons = {};
  positions.forEach(p => { reasons[p.closeReason] = (reasons[p.closeReason] || 0) + 1; });
  lines.push('  Exits: ' + Object.entries(reasons).map(([k, v]) => k + '=' + v).join(', '));
} else {
  lines.push('  No completed positions in period');
}
lines.push('');

// Fee Rate by Regime
lines.push('💰 FEE RATE BY REGIME');
Object.entries(regimeFees).forEach(([regime, data]) => {
  const rate = data.hours > 0 ? data.totalFees / data.hours : 0;
  const ir = data.total > 0 ? (data.inRange / data.total * 100) : 0;
  lines.push('  ' + regime + ': $' + fmt(rate) + '/hr ($' + fmt(rate * 24) + '/day) | IR: ' + fmt(ir, 0) + '% | ' + fmt(data.hours, 1) + 'h');
});
lines.push('');

// Fee Rate by Hour
lines.push('🕐 PEAK FEE HOURS (Berlin)');
const hourlyRates = Object.entries(hourlyFees)
  .map(([h, d]) => ({ hour: parseInt(h), rate: d.count > 0 ? d.totalFees / d.count * 60 : 0, count: d.count }))
  .filter(h => h.count > 5)
  .sort((a, b) => b.rate - a.rate);
if (hourlyRates.length >= 3) {
  const top3 = hourlyRates.slice(0, 3);
  const bot3 = hourlyRates.slice(-3).reverse();
  lines.push('  Best:  ' + top3.map(h => h.hour + ':00=$' + fmt(h.rate) + '/hr').join(', '));
  lines.push('  Worst: ' + bot3.map(h => h.hour + ':00=$' + fmt(h.rate) + '/hr').join(', '));
} else {
  lines.push('  Not enough hourly data yet');
}
lines.push('');

// Weekend vs Weekday
lines.push('📅 WEEKDAY vs WEEKEND');
const wdRate = dayOfWeekFees.weekday.hours > 0 ? dayOfWeekFees.weekday.fees / dayOfWeekFees.weekday.hours : 0;
const weRate = dayOfWeekFees.weekend.hours > 0 ? dayOfWeekFees.weekend.fees / dayOfWeekFees.weekend.hours : 0;
lines.push('  Weekday: $' + fmt(wdRate) + '/hr ($' + fmt(wdRate * 24) + '/day)');
lines.push('  Weekend: $' + fmt(weRate) + '/hr ($' + fmt(weRate * 24) + '/day)');
if (wdRate > 0 && weRate > 0) lines.push('  Weekend is ' + fmt(weRate / wdRate * 100, 0) + '% of weekday');
lines.push('');

// Unnecessary Exits
lines.push('🔄 EXIT EFFICIENCY');
lines.push('  Total T1 exits: ' + t1Exits.length);
lines.push('  Unnecessary (price bounced <0.3% within 30min): ' + unnecessaryExits);
if (unnecessaryExits > 0) lines.push('  Est. wasted gas: $' + fmt(unnecessaryGas));
if (avgProxAtExit > 0) lines.push('  Avg proximity at exit: ' + fmt(avgProxAtExit * 100, 0) + '%');
lines.push('');

// Gas Efficiency
lines.push('⛽ GAS EFFICIENCY');
lines.push('  Total gas: $' + fmt(totalGasUsdc) + ' (' + state.tx_count + ' txs)');
lines.push('  Total harvested fees: $' + fmt(totalHarvestedUsdc));
lines.push('  Fee/gas ratio: ' + (totalGasUsdc > 0 ? fmt(totalHarvestedUsdc / totalGasUsdc, 1) + 'x' : 'n/a'));
lines.push('');

// ── SUGGESTIONS ──

lines.push('💡 SUGGESTIONS');
const suggestions = [];

// Proximity threshold suggestion
if (unnecessaryExits >= 2 && t1Exits.length >= 4) {
  const pct = fmt(unnecessaryExits / t1Exits.length * 100, 0);
  suggestions.push('Raise proxThresholdLower by 5%: ' + pct + '% of T1 exits were unnecessary (price bounced back). Est. saving: $' + fmt(unnecessaryGas) + '/week in gas.');
}

// Position duration suggestion
if (positions.length >= 5) {
  const under1h = positions.filter(p => p.duration < 1).length;
  if (under1h / positions.length > 0.5) {
    suggestions.push('Most positions die in <1h (' + under1h + '/' + positions.length + '). Consider widening range by 0.5% or raising proximity thresholds to reduce churn.');
  }
}

// Weekend suggestion
if (weRate > 0 && wdRate > 0 && weRate / wdRate < 0.5) {
  suggestions.push('Weekend fee rate is <50% of weekday. Consider wider range on weekends to reduce exits on low-volume days.');
}

// Harvest efficiency
if (harvests.length > 0 && totalHarvestedUsdc / harvests.length < 1) {
  suggestions.push('Average harvest collects <$1 in fees. Consider increasing harvest interval or raising the min $0.50 threshold to save gas.');
}

// Gas efficiency
if (totalGasUsdc > 0 && totalHarvestedUsdc / totalGasUsdc < 10) {
  suggestions.push('Fee/gas ratio is low (' + fmt(totalHarvestedUsdc / totalGasUsdc, 1) + 'x). Each $1 of gas only earns $' + fmt(totalHarvestedUsdc / totalGasUsdc, 1) + ' in fees. Reducing rebalance frequency would improve this.');
}

if (suggestions.length === 0) {
  suggestions.push('No specific optimizations suggested. Continue collecting data for more accurate analysis.');
}

suggestions.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + s));

const report = lines.join('\n');
console.log(report);

// Send via Telegram if requested
if (sendTelegram) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: report, disable_web_page_preview: true }),
    }).then(r => r.json()).then(j => {
      console.log(j.ok ? '\nSent to Telegram' : '\nTelegram failed: ' + JSON.stringify(j));
      db.close();
    });
  } else {
    console.log('\nTelegram not configured');
    db.close();
  }
} else {
  db.close();
}
