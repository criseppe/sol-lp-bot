/**
 * P&L Projection Page — 12-month forward model from real execution data
 */

export function renderProjectionPageHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOL/USDC LP Bot — 12-Month Projection</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;padding:12px;-webkit-text-size-adjust:100%}
.nav{display:flex;gap:5px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:7px 10px;border:1px solid #30363d;border-radius:6px;font-size:11px;text-align:center}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.header{text-align:center;margin-bottom:16px}
.header h1{font-size:18px;color:#ffd700;margin-bottom:4px}
.header .sub{color:#8b949e;font-size:11px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;text-align:center}
.card .val{font-size:22px;font-weight:bold;margin-bottom:4px}
.card .lbl{font-size:10px;color:#8b949e}
.section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.section h2{font-size:14px;color:#58a6ff;margin-bottom:12px}
.section canvas{width:100%!important;max-height:280px}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;color:#8b949e;padding:5px 6px;border-bottom:1px solid #30363d;font-size:10px}
td{padding:5px 6px;border-bottom:1px solid #21262d}
.sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-bottom:16px}
.slider-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px}
.slider-card label{font-size:11px;color:#8b949e;display:block;margin-bottom:4px}
.slider-card input[type=range]{width:100%;accent-color:#58a6ff}
.slider-card .val{font-size:13px;color:#c9d1d9;font-weight:bold;text-align:right}
.assumptions{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:11px;color:#8b949e;line-height:1.6}
.assumptions b{color:#c9d1d9}
.loading{text-align:center;padding:40px;color:#8b949e}
@media(max-width:700px){
  body{padding:8px}
  .nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  .nav a{padding:7px 3px;font-size:9px}
  .cards{grid-template-columns:1fr 1fr}
  .card .val{font-size:18px}
  .sliders{grid-template-columns:1fr}
  .section{padding:12px}
  .section canvas{max-height:220px}
  table{font-size:10px}
  th,td{padding:3px 4px}
}
</style></head><body>

<div class="nav">
  <a href="/live">Live Wallet</a><a href="/insights">Insights</a><a href="/strategy">Strategy</a>
  <a href="/config">Config</a><a href="/status">Status</a><a href="/analytics">Analytics</a>
  <a href="/projection" class="active">Projection</a><a href="/analysis">Agent</a><a href="/arcade">Arcade</a>
</div>

<div class="header">
  <h1>12-Month P&L Projection</h1>
  <div class="sub">Based on real execution data · Updates daily</div>
</div>

<div id="content"><div class="loading">Loading projection model...</div></div>

<script>
const TZ='Europe/Berlin';
const fmt=(n,d)=>n!=null?Number(n).toFixed(d??2):'n/a';
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SEASONAL=[1.1,1.0,0.9,1.2,0.8,0.7,0.7,0.8,1.0,1.1,1.3,1.2];

let DATA=null;
let charts={};
let volMultiplier=1.0;
let capitalOverride=0;
let solPriceChangePct=0;

async function load() {
  try {
    const res = await fetch('/api/projection-data');
    DATA = await res.json();
    if (DATA.error) { document.getElementById('content').innerHTML='<div class="loading" style="color:#eab308">'+DATA.error+'</div>'; return; }
    capitalOverride = DATA.currentCapital;
    render();
  } catch(e) {
    document.getElementById('content').innerHTML='<div class="loading" style="color:#ef4444">Failed: '+e+'</div>';
  }
}

function render() {
  if (!DATA) return;
  Object.values(charts).forEach(c => { try{c.destroy();}catch{} });
  charts={};

  const capital = capitalOverride || DATA.currentCapital;
  const wdRate = DATA.weekdayRate * volMultiplier;
  const weRate = DATA.weekendRate * volMultiplier;
  const blended = DATA.blendedRate * volMultiplier;
  const costPerDay = DATA.rebalancesPerDay * (DATA.costPerRebalance + DATA.ilPerRebalance);
  const startMonth = new Date().getMonth();
  var solPrice = DATA.currentPrice || 84;
  var solHeld = DATA.solHeld || 0;
  var usdcHeld = DATA.usdcHeld || 0;

  // Build 3 scenarios (fees + SOL price impact)
  function buildScenario(label, feeMultiplier) {
    let cumFees = 0;
    const months = [];
    for (let i = 0; i < 12; i++) {
      const mIdx = (startMonth + i) % 12;
      const seasonal = SEASONAL[mIdx];
      const wdHours = 30 * (5/7) * 24;
      const weHours = 30 * (2/7) * 24;
      const fees = (wdHours * wdRate * feeMultiplier + weHours * weRate * feeMultiplier) * seasonal * (DATA.inRangePct / 100);
      const costs = costPerDay * 30;
      const netFees = fees - costs;
      cumFees += netFees;
      const solPriceM = solPrice * (1 + solPriceChangePct / 100 * (i + 1) / 12);
      const solPnl = solHeld * (solPriceM - solPrice);
      const portfolio = solHeld * solPriceM + usdcHeld + cumFees;
      months.push({ month: MONTHS[mIdx], fees: Math.round(fees), costs: Math.round(costs), netFees: Math.round(netFees), cumFees: Math.round(cumFees), solPrice: Math.round(solPriceM * 100) / 100, solPnl: Math.round(solPnl), portfolio: Math.round(portfolio) });
    }
    const totalFees12m = cumFees;
    const solPnl12m = solHeld * (solPrice * (1 + solPriceChangePct / 100) - solPrice);
    const annualReturn = totalFees12m + solPnl12m;
    const apr = capital > 0 ? (totalFees12m / capital * 100) : 0;
    const monthlyAvg = totalFees12m / 12;
    const breakEvenDays = monthlyAvg > 0 ? Math.round(capital / (monthlyAvg / 30)) : 999;
    const breakEvenDropPct = solHeld * solPrice > 0 ? (totalFees12m / (solHeld * solPrice)) * 100 : 100;
    const breakEvenPrice = solPrice * (1 - breakEvenDropPct / 100);
    return { label, months, annualReturn: Math.round(annualReturn), feeReturn: Math.round(totalFees12m), solPnl: Math.round(solPnl12m), apr: Math.round(apr * 10) / 10, monthlyAvg: Math.round(monthlyAvg), breakEvenDays, breakEvenPrice: Math.round(breakEvenPrice * 100) / 100, breakEvenDropPct: Math.round(breakEvenDropPct * 10) / 10 };
  }

  const conservative = buildScenario('Conservative', 0.6);
  const base = buildScenario('Base Case', 1.0);
  const optimistic = buildScenario('Optimistic', 1.8);

  // Render
  var html = '';

  // Summary cards
  var beCol = solPrice > base.breakEvenPrice ? '#22c55e' : '#ef4444';
  html += '<div class="cards">';
  html += '<div class="card"><div class="val" style="color:#ffd700">$'+fmt(base.feeReturn,0)+'</div><div class="lbl">Fee Income (12m)</div></div>';
  html += '<div class="card"><div class="val" style="color:'+(base.solPnl>=0?'#22c55e':'#ef4444')+'">$'+fmt(base.solPnl,0)+'</div><div class="lbl">SOL P&L (12m)</div></div>';
  html += '<div class="card"><div class="val" style="color:#22c55e">'+base.apr+'%</div><div class="lbl">Fee APR</div></div>';
  html += '<div class="card"><div class="val" style="color:'+beCol+'">'+(solHeld>0&&!isNaN(base.breakEvenPrice)?'$'+fmt(base.breakEvenPrice):'N/A')+'</div><div class="lbl">Break-Even SOL Price</div></div>';
  html += '<div class="card"><div class="val" style="color:#58a6ff">$'+(DATA.avgDailyFees7d||0).toFixed(2)+'</div><div class="lbl">Avg Daily Fees (7d)</div></div>';
  html += '<div class="card"><div class="val" style="color:#8b949e">$'+(DATA.avgDailyFees30d||0).toFixed(2)+'</div><div class="lbl">Avg Daily Fees (30d)</div></div>';
  html += '<div class="card"><div class="val" style="color:#8b949e">$'+fmt(capital,0)+'</div><div class="lbl">Capital</div></div>';
  html += '<div class="card"><div class="val" style="color:#8b949e">'+fmt(DATA.totalHours,0)+'h</div><div class="lbl">Data Window</div></div>';
  html += '</div>';
  html += solHeld > 0 && !isNaN(base.breakEvenPrice) ? '<div style="text-align:center;font-size:11px;color:#8b949e;margin-bottom:12px">SOL can drop to <b style="color:'+beCol+'">$'+fmt(base.breakEvenPrice)+'</b> (-'+base.breakEvenDropPct+'%) before 12m fees are wiped out</div>' : '';

  // SOL price scenario + sensitivity sliders
  var solEnd = solPrice * (1 + solPriceChangePct/100);

  html += '<div class="sliders">';
  html += '<div class="slider-card"><label>SOL Price Scenario (12m)</label>';
  html += '<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">';
  [{l:'Bear -30%',v:-30},{l:'Flat 0%',v:0},{l:'Bull +50%',v:50}].forEach(function(s){
    var active=solPriceChangePct===s.v;
    html+='<button onclick="solPriceChangePct='+s.v+';render()" style="padding:4px 8px;font-size:10px;border:1px solid '+(active?'#58a6ff':'#30363d')+';background:'+(active?'#58a6ff20':'transparent')+';color:'+(active?'#58a6ff':'#8b949e')+';border-radius:4px;cursor:pointer;font-family:inherit">'+s.l+'</button>';
  });
  html += '<button onclick="document.getElementById(\\'sol-slider\\').style.display=\\'block\\'" style="padding:4px 8px;font-size:10px;border:1px solid #30363d;background:transparent;color:#8b949e;border-radius:4px;cursor:pointer;font-family:inherit">Custom</button>';
  html += '</div>';
  html += '<div id="sol-slider" style="display:'+([-30,0,50].indexOf(solPriceChangePct)>=0?'none':'block')+'"><input type="range" min="-80" max="300" step="5" value="'+solPriceChangePct+'" oninput="solPriceChangePct=parseInt(this.value);render()"></div>';
  html += '<div class="val">Current: $'+fmt(solPrice)+' → Year end: $'+fmt(solEnd)+' ('+(solPriceChangePct>=0?'+':'')+solPriceChangePct+'%)</div></div>';
  html += '<div class="slider-card"><label>Volume Multiplier</label><input type="range" min="0.2" max="3" step="0.1" value="'+volMultiplier+'" oninput="volMultiplier=parseFloat(this.value);document.getElementById(\\'vol-val\\').textContent=this.value+\\'x\\';render()"><div class="val" id="vol-val">'+volMultiplier+'x</div></div>';
  html += '<div class="slider-card"><label>Capital ($)</label><input type="range" min="1000" max="20000" step="500" value="'+capital+'" oninput="capitalOverride=parseInt(this.value);document.getElementById(\\'cap-val\\').textContent=\\'$\\'+this.value;render()"><div class="val" id="cap-val">$'+capital+'</div></div>';
  html += '</div>';

  // Chart
  html += '<div class="section"><h2>Cumulative Return — 12 Months</h2><canvas id="proj-chart"></canvas></div>';

  // Monthly table
  html += '<div class="section"><h2>Monthly Breakdown</h2>';
  html += '<div style="overflow-x:auto"><table>';
  html += '<tr><th>Month</th><th style="text-align:right">SOL Price</th><th style="text-align:right">Fees</th><th style="text-align:right">SOL P&L</th><th style="text-align:right;color:#58a6ff">Portfolio</th><th style="text-align:right">Return</th></tr>';
  for (let i = 0; i < 12; i++) {
    const b = base.months[i];
    const ret = capital > 0 ? ((b.portfolio - capital) / capital * 100) : 0;
    const retCol = ret >= 0 ? '#22c55e' : '#ef4444';
    html += '<tr>';
    html += '<td style="font-weight:bold">'+b.month+'</td>';
    html += '<td style="text-align:right;font-family:monospace">$'+fmt(b.solPrice)+'</td>';
    html += '<td style="text-align:right;color:#22c55e">$'+b.cumFees+'</td>';
    html += '<td style="text-align:right;color:'+(b.solPnl>=0?'#22c55e':'#ef4444')+'">$'+b.solPnl+'</td>';
    html += '<td style="text-align:right;color:#58a6ff;font-weight:bold">$'+b.portfolio.toLocaleString()+'</td>';
    html += '<td style="text-align:right;color:'+retCol+'">'+(ret>=0?'+':'')+ret.toFixed(1)+'%</td>';
    html += '</tr>';
  }
  html += '</table></div>';

  // Scenario summary
  html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">';
  [conservative, base, optimistic].forEach(function(s) {
    var col = s === conservative ? '#8b949e' : s === base ? '#58a6ff' : '#ffd700';
    html += '<div style="text-align:center;padding:8px;background:#0d1117;border-radius:6px;border:1px solid '+col+'30">';
    html += '<div style="font-size:10px;color:'+col+';font-weight:bold;margin-bottom:4px">'+s.label+'</div>';
    html += '<div style="font-size:16px;font-weight:bold;color:'+col+'">$'+s.feeReturn+' <span style="font-size:11px;color:'+(s.solPnl>=0?'#22c55e':'#ef4444')+'">'+(s.solPnl>=0?'+':'')+s.solPnl+' SOL</span></div>';
    html += '<div style="font-size:10px;color:#8b949e">'+s.apr+'% fee APR · $'+s.monthlyAvg+'/mo · BE: $'+s.breakEvenPrice+'</div>';
    html += '</div>';
  });
  html += '</div></div>';

  // Assumptions
  html += '<div class="section"><h2>Model Assumptions (from real data)</h2><div class="assumptions">';
  html += '<b>Fee Rates:</b> Weekday $'+fmt(DATA.weekdayRate,4)+'/hr · Weekend $'+fmt(DATA.weekendRate,4)+'/hr · Blended $'+fmt(DATA.blendedRate,4)+'/hr<br>';
  html += '<b>In-Range:</b> '+DATA.inRangePct+'% of time position is earning fees<br>';
  html += '<b>Rebalances:</b> '+DATA.rebalancesPerDay+'/day · Cost: $'+fmt(DATA.costPerRebalance,4)+' gas + $'+fmt(DATA.ilPerRebalance,4)+' IL per rebalance<br>';
  html += '<b>Positions:</b> '+DATA.totalPositions+' total · Avg duration: '+DATA.avgPositionDurationMin+' min<br>';

  html += '<b>Regime Distribution:</b> ';
  Object.entries(DATA.regimeDistribution).forEach(function(e) {
    html += e[0]+' '+(e[1]*100).toFixed(0)+'% · ';
  });
  html += '<br>';

  html += '<b>Regime Fee Rates:</b> ';
  Object.entries(DATA.regimeFeeRates).forEach(function(e) {
    html += e[0]+' $'+fmt(e[1].rate,2)+'/hr · ';
  });
  html += '<br>';

  html += '<b>Seasonality:</b> Q4 highest (Nov +30%, Dec +20%), Q2-Q3 lowest (Jun-Jul -30%)<br>';
  html += '<b>Data Window:</b> '+DATA.dataStartDate+' to '+DATA.dataEndDate+' ('+fmt(DATA.totalHours,0)+' hours)<br>';
  html += '<b>Scenarios:</b> Conservative (60% of observed rate) · Base (100%) · Optimistic (180%)<br>';
  html += '<b>Costs:</b> Total gas: $'+fmt(DATA.totalGasUsdc,4)+' across '+DATA.swapCount+' swaps. Negligible on Solana.<br>';
  html += '<b>Caveats:</b> Past performance does not guarantee future results. Projections become more accurate as data accumulates. IL during crashes can wipe weeks of fees.';
  html += '</div></div>';

  // Daily fees trend
  if (DATA.dailyFees && DATA.dailyFees.length > 0) {
    html += '<div class="section"><h2>Daily Fee Trend (actual data)</h2><canvas id="daily-chart"></canvas></div>';
  }

  document.getElementById('content').innerHTML = html;

  // Render charts
  var labels = base.months.map(function(m){return m.month;});
  charts.proj = new Chart(document.getElementById('proj-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'Optimistic', data: optimistic.months.map(function(m){return m.portfolio;}), borderColor: '#ffd700', backgroundColor: '#ffd70020', fill: false, tension: 0.3, pointRadius: 3, borderDash: [5,3] },
        { label: 'Base Case', data: base.months.map(function(m){return m.portfolio;}), borderColor: '#58a6ff', backgroundColor: '#58a6ff20', fill: true, tension: 0.3, pointRadius: 3 },
        { label: 'Conservative', data: conservative.months.map(function(m){return m.portfolio;}), borderColor: '#8b949e', backgroundColor: '#8b949e20', fill: false, tension: 0.3, pointRadius: 3, borderDash: [5,3] },
        { label: 'SOL P&L', data: base.months.map(function(m){return m.solPnl;}), borderColor: '#a855f7', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, borderDash: [3,3], borderWidth: 1.5 },
        { label: 'Fees Only', data: base.months.map(function(m){return m.cumFees;}), borderColor: '#22c55e', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, borderDash: [2,2], borderWidth: 1.5 },
      ]
    },
    options: {
      plugins: { legend: { labels: { color: '#8b949e', font: { size: 11 } } } },
      scales: {
        y: { ticks: { callback: function(v){return '$'+v.toLocaleString();}, color: '#8b949e' }, grid: { color: '#21262d' } },
        x: { ticks: { color: '#8b949e' }, grid: { display: false } }
      }
    }
  });

  // Daily trend chart
  if (DATA.dailyFees && DATA.dailyFees.length > 0) {
    var dLabels = DATA.dailyFees.map(function(d){return d.date.slice(5);});
    var dData = DATA.dailyFees.map(function(d){return d.fees;});
    charts.daily = new Chart(document.getElementById('daily-chart'), {
      type: 'bar',
      data: { labels: dLabels, datasets: [{ label: 'Daily Fees ($)', data: dData, backgroundColor: '#22c55e80' }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { callback: function(v){return '$'+v;}, color: '#8b949e' }, grid: { color: '#21262d' } },
          x: { ticks: { color: '#8b949e' }, grid: { display: false } }
        }
      }
    });
  }
}

load();
</script>
</body></html>`;
}
