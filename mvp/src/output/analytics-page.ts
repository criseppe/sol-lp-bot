/**
 * Analytics page — 20 widget dashboard with Chart.js
 * Widgets can be toggled on/off, state persisted in localStorage
 */

const SHARED_NAV = `<div class="nav">
  <a href="/live">Live Wallet</a><a href="/insights">Insights</a><a href="/strategy">Strategy</a>
  <a href="/config">Config</a><a href="/status">Status</a><a href="/analytics" class="active">Analytics</a>
  <a href="/analysis">Agent</a><a href="/arcade">Arcade</a>
</div>`;

export function renderAnalyticsPageHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOL/USDC LP Bot — Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;padding:12px;-webkit-text-size-adjust:100%}
.nav{display:flex;gap:5px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:7px 10px;border:1px solid #30363d;border-radius:6px;font-size:11px;text-align:center}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.header{text-align:center;margin-bottom:16px}
.header h1{font-size:18px;color:#58a6ff;margin-bottom:4px}
.header .sub{color:#8b949e;font-size:11px}
.controls{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;justify-content:center}
.controls select,.controls button{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;-webkit-appearance:none}
.controls button:hover{border-color:#58a6ff}
.toggle-panel{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:16px;display:none}
.toggle-panel.show{display:block}
.toggle-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.toggle-item{display:flex;align-items:center;gap:8px;font-size:12px;color:#8b949e;padding:4px 0}
.toggle-item input{accent-color:#58a6ff;width:18px;height:18px}
.toggle-item label{cursor:pointer}
.widget-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,450px),1fr));gap:12px}
.widget{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;position:relative;overflow:hidden}
.widget h3{font-size:13px;color:#58a6ff;margin-bottom:8px;padding-right:50px}
.widget .desc{font-size:10px;color:#8b949e;margin-bottom:10px}
.widget canvas{width:100%!important;max-height:220px}
.widget table{width:100%;border-collapse:collapse;font-size:11px}
.widget th{text-align:left;color:#8b949e;padding:4px 6px;border-bottom:1px solid #30363d;font-size:10px}
.widget td{padding:4px 6px;border-bottom:1px solid #21262d}
.widget .export-btn{position:absolute;top:10px;right:10px;background:#21262d;color:#8b949e;border:none;padding:4px 10px;border-radius:4px;font-size:10px;cursor:pointer;z-index:1}
.widget div[style*="overflow-x"]{-webkit-overflow-scrolling:touch}
@media(max-width:700px){
  body{padding:8px}
  .nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  .nav a{padding:7px 3px;font-size:9px}
  .header h1{font-size:16px}
  .controls{gap:6px}
  .controls select,.controls button{padding:10px 12px;font-size:14px;flex:1;min-height:40px}
  .toggle-grid{grid-template-columns:1fr 1fr}
  .toggle-item{font-size:13px;padding:6px 0}
  .toggle-item input{width:20px;height:20px}
  .widget-grid{gap:8px}
  .widget{padding:10px}
  .widget h3{font-size:12px;margin-bottom:6px}
  .widget canvas{max-height:180px}
  .widget table{font-size:10px}
  .widget th,.widget td{padding:3px 4px}
  .widget .export-btn{padding:6px 10px;font-size:11px}
  .widget .metric .val{font-size:20px}
}
.widget .export-btn:hover{color:#58a6ff}
.widget .metric{text-align:center;padding:8px}
.widget .metric .val{font-size:24px;font-weight:bold}
.widget .metric .lbl{font-size:10px;color:#8b949e}
.loading{text-align:center;padding:40px;color:#8b949e}
</style></head><body>

${SHARED_NAV}

<div class="header">
  <h1>Analytics Dashboard</h1>
  <div class="sub">20 widgets — toggle, export, auto-refresh every 5 min</div>
</div>

<div class="controls">
  <select id="days-select">
    <option value="1">Last 24h</option>
    <option value="2">Last 2 days</option>
    <option value="7" selected>Last 7 days</option>
    <option value="14">Last 14 days</option>
    <option value="30">Last 30 days</option>
  </select>
  <button onclick="togglePanel()">Toggle Widgets</button>
  <button onclick="loadAll()">Refresh</button>

</div>

<div class="toggle-panel" id="toggle-panel">
  <div style="font-size:12px;color:#58a6ff;margin-bottom:8px;font-weight:bold">Show/Hide Widgets</div>
  <div class="toggle-grid" id="toggle-grid"></div>
</div>

<div class="widget-grid" id="widget-grid">
  <div class="loading">Loading analytics...</div>
</div>

<script>
const TZ='Europe/Berlin';
const fmt=(n,d)=>n!=null?Number(n).toFixed(d??2):'n/a';
const COLORS={green:'#22c55e',red:'#ef4444',blue:'#58a6ff',amber:'#eab308',purple:'#a855f7',gray:'#8b949e',gold:'#ffd700',cyan:'#0ff'};
const REGIME_COLORS={RANGING:'#4a9eff',BULLISH_TREND:'#22c55e',BEARISH_TREND:'#ef4444',EXTREME:'#a855f7'};

// Widget definitions
const WIDGETS = [
  {id:'fees-today',cat:'Fees',name:'Fees Per Hour (Today)',type:'chart'},
  {id:'fees-daily',cat:'Fees',name:'Fees Per Day',type:'chart'},
  {id:'fee-heatmap',cat:'Fees',name:'Fee Rate Heatmap',type:'table'},
  {id:'cum-fees',cat:'Fees',name:'Cumulative Fees',type:'chart'},
  {id:'fees-regime',cat:'Fees',name:'Fee Rate by Regime',type:'chart'},
  {id:'fees-weekday',cat:'Fees',name:'Weekday vs Weekend',type:'chart'},
  {id:'pos-duration',cat:'Position',name:'Position Duration',type:'chart'},
  {id:'pos-table',cat:'Position',name:'Position P&L Table',type:'table'},
  {id:'exit-reasons',cat:'Position',name:'Exit Reason Breakdown',type:'chart'},
  {id:'fee-vs-duration',cat:'Position',name:'Fee vs Duration',type:'chart'},
  {id:'gas-trend',cat:'Cost',name:'Gas Cost Trend',type:'chart'},
  {id:'swap-costs',cat:'Cost',name:'Swap Cost Breakdown',type:'chart'},
  {id:'il-tracker',cat:'Cost',name:'IL Tracker',type:'chart'},
  {id:'in-range',cat:'Cost',name:'In-Range Rate',type:'chart'},
  {id:'price-vs-fees',cat:'Market',name:'SOL Price vs Fees',type:'chart'},
  {id:'regime-timeline',cat:'Market',name:'Regime Timeline',type:'table'},
  {id:'vol-history',cat:'Market',name:'Volume & Volatility',type:'chart'},
  {id:'portfolio-value',cat:'Portfolio',name:'Portfolio Value',type:'table'},
  {id:'capital-alloc',cat:'Portfolio',name:'Capital Allocation',type:'chart'},
  {id:'daily-waterfall',cat:'Portfolio',name:'Daily P&L Breakdown',type:'table'},
];

let DATA = null;
let charts = {};

function getVisible() {
  try { return JSON.parse(localStorage.getItem('analytics-visible') || 'null'); } catch { return null; }
}
function setVisible(v) { localStorage.setItem('analytics-visible', JSON.stringify(v)); }

function togglePanel() {
  document.getElementById('toggle-panel').classList.toggle('show');
}

function buildToggles() {
  var visible = getVisible() || WIDGETS.map(w => w.id);
  var grid = document.getElementById('toggle-grid');
  grid.innerHTML = WIDGETS.map(w => {
    var checked = visible.includes(w.id) ? 'checked' : '';
    return '<div class="toggle-item"><input type="checkbox" id="chk-'+w.id+'" '+checked+' onchange="onToggle()"><label for="chk-'+w.id+'">'+w.cat+': '+w.name+'</label></div>';
  }).join('');
}

function onToggle() {
  var visible = WIDGETS.filter(w => document.getElementById('chk-'+w.id)?.checked).map(w => w.id);
  setVisible(visible);
  renderWidgets();
}

function renderWidgets() {
  var visible = getVisible() || WIDGETS.map(w => w.id);
  var grid = document.getElementById('widget-grid');
  grid.innerHTML = WIDGETS.filter(w => visible.includes(w.id)).map(w =>
    '<div class="widget" id="w-'+w.id+'"><h3>'+w.name+'</h3><div class="desc">Loading...</div></div>'
  ).join('');
  if (DATA) populateAll();
}

async function loadAll() {
  var days = document.getElementById('days-select').value;
  try {
    var res = await fetch('/api/analytics-data?days='+days, {credentials:'same-origin'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
    renderWidgets();
  } catch(e) {
    document.getElementById('widget-grid').innerHTML = '<div class="loading" style="color:#ef4444">Failed to load: '+e+'</div>';
  }
}

function populateAll() {
  if (!DATA) return;
  Object.values(charts).forEach(c => { try{c.destroy();}catch{} });
  charts = {};

  var snaps = DATA.snaps || [];
  var events = DATA.events || [];
  if (snaps.length < 2) return;

  // Precompute common data
  var positions = buildPositions(events);
  var hourlyFees = buildHourlyFees(snaps);
  var dailyFees = buildDailyFees(snaps);

  var fns = [
    function() { populateFeesToday(); },
    function() { populateFeesDaily(DATA.dailySummaries || []); },
    function() { populateFeeHeatmap(hourlyFees); },
    function() { populateCumFees(DATA.dailySummaries || []); },
    function() { populateFeesRegime(snaps); },
    function() { populateFeesWeekday(snaps); },
    function() { populatePosDuration(positions); },
    function() { populatePosTable(positions); },
    function() { populateExitReasons(positions); },
    function() { populateFeeVsDuration(positions); },
    function() { populateGasTrend(snaps); },
    function() { populateSwapCosts(events); },
    function() { populateILTracker(positions); },
    function() { populateInRange(snaps); },
    function() { populatePriceVsFees(hourlyFees); },
    function() { populateRegimeTimeline(DATA.regimeHist || [], snaps); },
    function() { populateVolHistory(snaps); },
    function() { populatePortfolioValue(snaps, DATA.dailySummaries || []); },
    function() { populateCapitalAlloc(snaps); },
    function() { populateDailyWaterfall(DATA.dailySummaries || []); },
  ];
  fns.forEach(function(fn) { try { fn(); } catch(e) { console.error('Widget error:', e); } });
}

// ── DATA BUILDERS ──

function buildPositions(events) {
  var positions = [], lastOpen = null;
  events.forEach(function(e) {
    if (e.event_type === 'POSITION_OPENED') {
      var capB = (e.sol_before||0)*e.price + (e.usdc_before||0);
      var capA = (e.sol_after||0)*e.price + (e.usdc_after||0);
      lastOpen = {ts:e.timestamp, price:e.price, capital:Math.max(0,capB-capA), regime:e.regime};
    } else if (['T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED'].includes(e.event_type) && lastOpen) {
      var fees = (e.fee_sol||0)*e.price + (e.fee_usdc||0);
      positions.push({openTime:lastOpen.ts, closeTime:e.timestamp, duration:(e.timestamp-lastOpen.ts)/60000,
        openPrice:lastOpen.price, closePrice:e.price, capital:lastOpen.capital,
        fees:fees, il:e.il_at_close||0, net:fees+(e.il_at_close||0), reason:e.event_type, regime:lastOpen.regime});
      lastOpen = null;
    }
  });
  return positions;
}

function totalFees(s) {
  var p = (s.pending_fees_sol||0)*s.price + (s.pending_fees_usdc||0);
  return (s.cum_fees_sol||0)*s.price + (s.cum_fees_usdc||0) + (p > 1000 ? 0 : p);
}

function buildHourlyFees(snaps) {
  var map = {};
  for (var i=1;i<snaps.length;i++) {
    var d = new Date(snaps[i].timestamp);
    var key = d.toLocaleDateString('en-CA',{timeZone:TZ}) + 'T' + String(d.getUTCHours()).padStart(2,'0');
    var delta = totalFees(snaps[i]) - totalFees(snaps[i-1]);
    if (delta > 0 && delta < 100) {
      if (!map[key]) map[key] = {fees:0,inRange:0,total:0,price:snaps[i].price,regime:snaps[i].regime};
      map[key].fees += delta;
      if (snaps[i].in_range) map[key].inRange++;
      map[key].total++;
    }
  }
  return Object.entries(map).map(function(e){return{hour:e[0],fees:e[1].fees,irPct:e[1].total>0?e[1].inRange/e[1].total*100:0,price:e[1].price,regime:e[1].regime};}).sort(function(a,b){return a.hour.localeCompare(b.hour);});
}

function buildDailyFees(snaps) {
  var map = {};
  for (var i=1;i<snaps.length;i++) {
    var date = new Date(snaps[i].timestamp).toLocaleDateString('en-CA',{timeZone:TZ});
    var delta = totalFees(snaps[i]) - totalFees(snaps[i-1]);
    if (delta > 0 && delta < 100) {
      map[date] = (map[date]||0) + delta;
    }
  }
  return Object.entries(map).sort(function(a,b){return a[0].localeCompare(b[0]);});
}

// ── CHART HELPER ──
function makeChart(id, cfg) {
  var el = document.getElementById('w-'+id);
  if (!el) return;
  el.innerHTML = '<h3>'+WIDGETS.find(function(w){return w.id===id;})?.name+'</h3>' +
    '<button class="export-btn" onclick="exportWidget(\\''+id+'\\')">Export</button>' +
    '<canvas id="c-'+id+'"></canvas>';
  var ctx = document.getElementById('c-'+id+'');
  if (!ctx) return;
  charts[id] = new Chart(ctx, cfg);
}

function makeTable(id, html) {
  var el = document.getElementById('w-'+id);
  if (!el) return;
  el.innerHTML = '<h3>'+WIDGETS.find(function(w){return w.id===id;})?.name+'</h3>' +
    '<button class="export-btn" onclick="exportWidget(\\''+id+'\\')">Export</button>' + html;
}

function exportWidget(id) {
  var el = document.getElementById('w-'+id);
  if (!el) return;
  var canvas = el.querySelector('canvas');
  if (canvas) {
    var a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = id + '.png';
    a.click();
  } else {
    var table = el.querySelector('table');
    if (table) {
      var csv = Array.from(table.rows).map(function(r){return Array.from(r.cells).map(function(c){return c.textContent;}).join(',');}).join('\\n');
      var blob = new Blob([csv], {type:'text/csv'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = id + '.csv';
      a.click();
    }
  }
}

// ── WIDGET RENDERERS ──

function populateFeesToday() {
  var el = document.getElementById('w-fees-today');
  if (!el) return;
  var today = new Date().toLocaleDateString('en-CA',{timeZone:TZ});
  el.innerHTML = '<h3>Fees Per Hour</h3>' +
    '<button class="export-btn" onclick="exportWidget(\\'fees-today\\')">Export</button>' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">' +
      '<select id="fees-today-date" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;-webkit-appearance:none"></select>' +
      '<span id="fees-today-total" style="font-size:14px;font-weight:bold;color:#ffd700"></span>' +
    '</div>' +
    '<div style="display:flex;gap:12px;margin-bottom:6px;font-size:11px;color:#8b949e;flex-wrap:wrap">' +
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#ffd700;margin-right:4px"></span>&gt; $2</span>' +
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#22c55e;margin-right:4px"></span>$0.50 – $2</span>' +
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#8b949e80;margin-right:4px"></span>&lt; $0.50</span>' +
    '</div>' +
    '<canvas id="c-fees-today"></canvas>';
  loadFeesTodayData(today, true);
}

async function loadFeesTodayData(date, initSelect) {
  try {
    var res = await fetch('/api/hourly-fees?date=' + date);
    var d = await res.json();
    if (d.error) { document.getElementById('fees-today-total').textContent = 'No data'; return; }

    // Populate date selector on first load
    if (initSelect) {
      var select = document.getElementById('fees-today-date');
      if (select && d.availableDates && d.availableDates.length > 0) {
        var dates = d.availableDates.slice().reverse();
        // Ensure today is included even if not in daily_summary yet
        if (dates.indexOf(date) === -1) dates.unshift(date);
        select.innerHTML = dates.map(function(dt) {
          return '<option value="' + dt + '"' + (dt === date ? ' selected' : '') + '>' + dt + '</option>';
        }).join('');
        select.onchange = function() { loadFeesTodayData(select.value, false); };
      }
    }

    // Update total — use dayTotal from daily_summary (authoritative)
    var totalEl = document.getElementById('fees-today-total');
    if (totalEl) totalEl.textContent = 'Total: $' + (d.dayTotal || 0).toFixed(2);

    // Draw chart
    var hd = d.hourlyData || [];
    var labels = hd.map(function(h) { return String(h.hour).padStart(2,'0') + ':00'; });
    // Scale hourly data proportionally if sum != dayTotal (snapshot deltas can diverge from daily_summary)
    var rawSum = hd.reduce(function(s,h){return s+h.fees;},0);
    var scale = (d.dayTotal && rawSum > 0 && Math.abs(rawSum - d.dayTotal) > 1) ? d.dayTotal / rawSum : 1;
    var data = hd.map(function(h) { return h.fees * scale; });
    if (charts['fees-today']) { try { charts['fees-today'].destroy(); } catch(e) {} }
    var ctx = document.getElementById('c-fees-today');
    if (!ctx) return;
    charts['fees-today'] = new Chart(ctx, {
      type:'bar',
      data:{labels:labels,datasets:[{label:'Fees ($)',data:data,backgroundColor:data.map(function(v){return v>2?COLORS.gold:v>0.5?COLORS.green:COLORS.gray+'80';})}]},
      options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(2);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}
    });
    // Legend
    var legendEl = document.getElementById('fees-today-legend');
    if (!legendEl) {
      var lg = document.createElement('div');
      lg.id = 'fees-today-legend';
      lg.style.cssText = 'font-size:10px;color:#8b949e;margin-top:6px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap';
      lg.innerHTML = '<span><span style="display:inline-block;width:10px;height:10px;background:'+COLORS.gold+';border-radius:2px;margin-right:3px"></span>High (>$2/h)</span>' +
        '<span><span style="display:inline-block;width:10px;height:10px;background:'+COLORS.green+';border-radius:2px;margin-right:3px"></span>Normal (>$0.50/h)</span>' +
        '<span><span style="display:inline-block;width:10px;height:10px;background:'+COLORS.gray+'80;border-radius:2px;margin-right:3px"></span>Low (<$0.50/h)</span>';
      ctx.parentElement.appendChild(lg);
    }
  } catch(e) {
    var totalEl = document.getElementById('fees-today-total');
    if (totalEl) totalEl.textContent = 'Error loading data';
  }
}

function populateFeesDaily(summaries) {
  if (!summaries || summaries.length === 0) { makeTable('fees-daily','<div style="color:#8b949e;padding:12px">No daily data yet</div>'); return; }
  var labels = summaries.map(function(s){return s.date.slice(5);});
  var data = summaries.map(function(s){return s.fees_earned_usdc || 0;});
  var avg = data.reduce(function(s,v){return s+v;},0)/data.length;
  makeChart('fees-daily',{type:'bar',data:{labels:labels,datasets:[{label:'Daily Fees ($)',data:data,backgroundColor:COLORS.green+'80'},{label:'Average',data:data.map(function(){return avg;}),type:'line',borderColor:COLORS.amber,borderDash:[4,4],pointRadius:0}]},options:{plugins:{legend:{labels:{color:COLORS.gray,font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populateFeeHeatmap(hf) {
  var grid = {};
  hf.forEach(function(h){var day=h.hour.slice(0,10);var hr=parseInt(h.hour.slice(-2));if(!grid[day])grid[day]={};grid[day][hr]=h.fees;});
  var days = Object.keys(grid).sort();
  var html = '<div style="overflow-x:auto"><table><tr><th></th>';
  for(var h=0;h<24;h++) html += '<th style="text-align:center;font-size:9px;padding:2px">'+String(h).padStart(2,'0')+'</th>';
  html += '</tr>';
  days.forEach(function(d){
    html += '<tr><td style="font-size:10px;white-space:nowrap;padding:2px 4px">'+d.slice(5)+'</td>';
    for(var h=0;h<24;h++){
      var v=grid[d]?.[h]||0;
      var bg=v>2?'rgba(255,215,0,0.6)':v>0.5?'rgba(34,197,94,0.4)':v>0.1?'rgba(34,197,94,0.15)':'transparent';
      html += '<td style="text-align:center;background:'+bg+';font-size:9px;padding:2px;min-width:24px" title="'+d+' '+h+':00: $'+v.toFixed(4)+'">'+( v>0.01?v.toFixed(1):'')+'</td>';
    }
    html += '</tr>';
  });
  html += '</table></div>';
  html += '<div style="font-size:10px;color:#8b949e;margin-top:6px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">';
  html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgba(255,215,0,0.6);border-radius:2px;margin-right:3px"></span>High (>$2)</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,0.4);border-radius:2px;margin-right:3px"></span>Medium ($0.50-$2)</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,0.15);border-radius:2px;margin-right:3px"></span>Low ($0.10-$0.50)</span>';
  html += '<span><span style="display:inline-block;width:10px;height:10px;background:#161b22;border:1px solid #30363d;border-radius:2px;margin-right:3px"></span>None</span>';
  html += '</div>';
  makeTable('fee-heatmap',html);
}

function populateCumFees(summaries) {
  if (!summaries || summaries.length === 0) { makeTable('cum-fees','<div style="color:#8b949e;padding:12px">No data</div>'); return; }
  var labels = summaries.map(function(s){return s.date.slice(5);});
  var data = summaries.map(function(s){return s.cum_fees_usdc || 0;});
  makeChart('cum-fees',{type:'line',data:{labels:labels,datasets:[{label:'Cumulative Fees ($)',data:data,borderColor:COLORS.gold,backgroundColor:COLORS.gold+'20',fill:true,pointRadius:0,tension:0.3}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populateFeesRegime(snaps) {
  var regimes = {};
  for(var i=1;i<snaps.length;i++){var r=snaps[i].regime||'UNKNOWN';var d=totalFees(snaps[i])-totalFees(snaps[i-1]);var elapsed=(snaps[i].timestamp-snaps[i-1].timestamp)/3600000;if(d>0&&d<100){if(!regimes[r])regimes[r]={fees:0,hours:0};regimes[r].fees+=d;regimes[r].hours+=elapsed;}}
  var labels=Object.keys(regimes);var data=labels.map(function(r){return regimes[r].hours>0?regimes[r].fees/regimes[r].hours:0;});
  makeChart('fees-regime',{type:'bar',data:{labels:labels,datasets:[{label:'$/hour',data:data,backgroundColor:labels.map(function(l){return REGIME_COLORS[l]||COLORS.gray;})}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(2);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populateFeesWeekday(snaps) {
  var wd={fees:0,hours:0},we={fees:0,hours:0};
  for(var i=1;i<snaps.length;i++){var day=new Date(snaps[i].timestamp).toLocaleDateString('en-US',{timeZone:TZ,weekday:'short'});var isWe=day==='Sat'||day==='Sun';var b=isWe?we:wd;var d=totalFees(snaps[i])-totalFees(snaps[i-1]);var el=(snaps[i].timestamp-snaps[i-1].timestamp)/3600000;if(d>0&&d<100)b.fees+=d;b.hours+=el;}
  var wdRate=wd.hours>0?wd.fees/wd.hours*24:0;var weRate=we.hours>0?we.fees/we.hours*24:0;
  makeChart('fees-weekday',{type:'bar',data:{labels:['Weekday','Weekend'],datasets:[{label:'$/day',data:[wdRate,weRate],backgroundColor:[COLORS.blue,COLORS.purple]}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populatePosDuration(pos) {
  var buckets={'<10m':0,'10-30m':0,'30-60m':0,'1-4h':0,'4h+':0};
  pos.forEach(function(p){if(p.duration<10)buckets['<10m']++;else if(p.duration<30)buckets['10-30m']++;else if(p.duration<60)buckets['30-60m']++;else if(p.duration<240)buckets['1-4h']++;else buckets['4h+']++;});
  makeChart('pos-duration',{type:'bar',data:{labels:Object.keys(buckets),datasets:[{label:'Count',data:Object.values(buckets),backgroundColor:COLORS.blue+'80'}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{stepSize:1},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populatePosTable(pos) {
  if(pos.length===0){makeTable('pos-table','<div style="color:#8b949e;padding:12px">No positions</div>');return;}
  var html='<div style="overflow-x:auto;max-height:300px;overflow-y:auto"><table><tr><th>Opened</th><th>Dur</th><th style="text-align:right">Capital</th><th style="text-align:right">Fees</th><th style="text-align:right">IL</th><th style="text-align:right">Net</th><th>Exit</th></tr>';
  pos.slice(-15).reverse().forEach(function(p){
    var t=new Date(p.openTime).toLocaleString('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    var dur=p.duration>=60?fmt(p.duration/60,1)+'h':fmt(p.duration,0)+'m';
    var nc=p.net>=0?COLORS.green:COLORS.red;
    html+='<tr><td style="white-space:nowrap;font-size:10px">'+t+'</td><td>'+dur+'</td><td style="text-align:right;color:'+COLORS.blue+'">$'+fmt(p.capital,0)+'</td><td style="text-align:right;color:'+COLORS.gold+'">$'+fmt(p.fees,4)+'</td><td style="text-align:right;color:'+COLORS.red+'">$'+fmt(p.il,4)+'</td><td style="text-align:right;color:'+nc+';font-weight:bold">$'+fmt(p.net,4)+'</td><td style="font-size:9px;color:'+(REGIME_COLORS[p.regime]||COLORS.gray)+'">'+p.reason.replace('_',' ')+'</td></tr>';
  });
  html+='</table></div>';
  makeTable('pos-table',html);
}

function populateExitReasons(pos) {
  var counts={};pos.forEach(function(p){counts[p.reason]=(counts[p.reason]||0)+1;});
  var labels=Object.keys(counts);var data=Object.values(counts);
  var colors=[COLORS.amber,COLORS.gold,COLORS.red,COLORS.green,COLORS.gray,COLORS.purple];
  makeChart('exit-reasons',{type:'doughnut',data:{labels:labels.map(function(l){return l.replace('_',' ');}),datasets:[{data:data,backgroundColor:colors.slice(0,labels.length)}]},options:{plugins:{legend:{position:'right',labels:{color:COLORS.gray,font:{size:10}}}}}});
}

function populateFeeVsDuration(pos) {
  var data=pos.map(function(p){return{x:p.duration,y:p.fees};});
  makeChart('fee-vs-duration',{type:'scatter',data:{datasets:[{label:'Fee vs Duration',data:data,backgroundColor:COLORS.gold+'80',pointRadius:4}]},options:{plugins:{legend:{display:false}},scales:{x:{title:{display:true,text:'Duration (min)',color:COLORS.gray},grid:{color:'#21262d'}},y:{title:{display:true,text:'Fees ($)',color:COLORS.gray},ticks:{callback:function(v){return'$'+v.toFixed(2);}},grid:{color:'#21262d'}}}}});
}

function populateGasTrend(snaps) {
  if(!DATA.state)return;
  makeTable('gas-trend','<div class="metric"><div class="val" style="color:'+COLORS.red+'">$'+fmt(DATA.state.cum_gas_lamports/1e9*snaps[snaps.length-1].price,4)+'</div><div class="lbl">Total Gas ('+DATA.state.tx_count+' txs)</div></div><div class="metric"><div class="val" style="color:'+COLORS.gray+'">$'+fmt(DATA.state.cum_gas_lamports/1e9/Math.max(1,DATA.state.tx_count)*snaps[snaps.length-1].price,6)+'</div><div class="lbl">Avg per TX</div></div>');
}

function populateSwapCosts(events) {
  var swapCount=events.filter(function(e){return(e.note||'').includes('SWAP')||(e.note||'').includes('swap');}).length;
  var price=DATA.snaps[DATA.snaps.length-1]?.price||82;
  var gasEst=swapCount*(DATA.state?.cum_gas_lamports||0)/Math.max(1,DATA.state?.tx_count||1)/1e9*price;
  var poolFeeEst=swapCount*50*0.0004; // rough estimate
  makeChart('swap-costs',{type:'doughnut',data:{labels:['Gas ($'+fmt(gasEst,4)+')','Pool Fee (~$'+fmt(poolFeeEst,2)+')','Slippage (~$'+fmt(gasEst*2,2)+')'],datasets:[{data:[gasEst,poolFeeEst,gasEst*2],backgroundColor:[COLORS.red,COLORS.amber,COLORS.purple]}]},options:{plugins:{legend:{position:'right',labels:{color:COLORS.gray,font:{size:10}}}}}});
}

function populateILTracker(pos) {
  if(pos.length===0)return;
  var labels=pos.map(function(p,i){return'#'+(i+1);});
  var data=pos.map(function(p){return p.il;});
  var cum=[];var s=0;data.forEach(function(d){s+=d;cum.push(s);});
  makeChart('il-tracker',{type:'bar',data:{labels:labels,datasets:[{label:'IL per position',data:data,backgroundColor:COLORS.red+'60'},{label:'Cumulative IL',data:cum,type:'line',borderColor:COLORS.red,pointRadius:2,tension:0.3}]},options:{plugins:{legend:{labels:{color:COLORS.gray,font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(3);}},grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
}

function populateInRange(snaps) {
  var step=Math.max(1,Math.floor(snaps.length/100));
  var labels=[],data=[];
  for(var i=0;i<snaps.length;i+=step){
    var windowSize=Math.min(60,snaps.length-i);
    var ir=0;for(var j=i;j<i+windowSize&&j<snaps.length;j++)if(snaps[j].in_range)ir++;
    labels.push('');data.push(ir/windowSize*100);
  }
  makeChart('in-range',{type:'line',data:{labels:labels,datasets:[{label:'In-Range %',data:data,borderColor:COLORS.green,backgroundColor:COLORS.green+'20',fill:true,pointRadius:0,tension:0.3}]},options:{plugins:{legend:{display:false}},scales:{y:{min:0,max:100,ticks:{callback:function(v){return v+'%';}},grid:{color:'#21262d'}},x:{display:false}}}});
}

function populatePriceVsFees(hf) {
  var labels=hf.map(function(h){return h.hour.slice(-5);});
  var prices=hf.map(function(h){return h.price;});
  var fees=hf.map(function(h){return h.fees;});
  makeChart('price-vs-fees',{type:'line',data:{labels:labels,datasets:[{label:'SOL Price',data:prices,borderColor:COLORS.blue,pointRadius:0,yAxisID:'y',tension:0.3},{label:'Fees ($)',data:fees,borderColor:COLORS.gold,pointRadius:0,yAxisID:'y1',tension:0.3}]},options:{plugins:{legend:{labels:{color:COLORS.gray,font:{size:10}}}},scales:{y:{position:'left',ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},y1:{position:'right',ticks:{callback:function(v){return'$'+v.toFixed(2);}},grid:{display:false}},x:{display:false}}}});
}

function populateRegimeTimeline(hist, snaps) {
  if(snaps.length===0){makeTable('regime-timeline','<div style="color:#8b949e;padding:12px">No data</div>');return;}
  var html='<div style="overflow-x:auto"><table><tr><th>Time</th><th>From</th><th>To</th><th>Price</th></tr>';
  if(hist.length===0) html+='<tr><td colspan="4" style="color:#8b949e">No regime changes in period. Current: '+(snaps[snaps.length-1].regime||'UNKNOWN')+'</td></tr>';
  hist.forEach(function(r){
    var t=new Date(r.timestamp).toLocaleString('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    html+='<tr><td>'+t+'</td><td style="color:'+(REGIME_COLORS[r.old_regime]||COLORS.gray)+'">'+r.old_regime+'</td><td style="color:'+(REGIME_COLORS[r.new_regime]||COLORS.gray)+';font-weight:bold">'+r.new_regime+'</td><td>$'+fmt(r.price)+'</td></tr>';
  });
  html+='</table></div>';
  // Add current regime bar
  var curRegime = snaps[snaps.length-1].regime || 'UNKNOWN';
  html += '<div style="margin-top:8px;padding:6px 10px;background:'+(REGIME_COLORS[curRegime]||COLORS.gray)+'15;border-left:3px solid '+(REGIME_COLORS[curRegime]||COLORS.gray)+';border-radius:0 4px 4px 0;font-size:11px">Current: <b style="color:'+(REGIME_COLORS[curRegime]||COLORS.gray)+'">'+curRegime+'</b></div>';
  makeTable('regime-timeline',html);
}

function populateVolHistory(snaps) {
  var step=Math.max(1,Math.floor(snaps.length/100));
  var labels=[],prices=[];
  for(var i=0;i<snaps.length;i+=step){labels.push('');prices.push(snaps[i].price);}
  makeChart('vol-history',{type:'line',data:{labels:labels,datasets:[{label:'SOL Price',data:prices,borderColor:COLORS.blue,pointRadius:0,tension:0.3,fill:false}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},x:{display:false}}}});
}

function populatePortfolioValue(snaps, dailySummaries) {
  // Build daily lookup from dailySummaries
  var dailyMap = {};
  (dailySummaries || []).forEach(function(s) { dailyMap[s.date] = s; });

  // Get last snapshot per day (end-of-day values)
  var eodSnaps = {};
  snaps.forEach(function(s) {
    var d = new Date(s.timestamp).toLocaleDateString('en-CA', {timeZone: TZ});
    eodSnaps[d] = s; // overwrites, so last snapshot of the day wins
  });

  var days = Object.keys(eodSnaps).sort();
  if (days.length === 0) { makeTable('portfolio-value','<div style="color:#8b949e;padding:12px">No data yet</div>'); return; }

  // Build rows
  var rows = [];
  days.forEach(function(d, i) {
    var s = eodSnaps[d];
    var ds = dailyMap[d];
    var totalSol = (s.sol_balance || 0) + (s.position_sol || 0);
    var solPrice = s.price || 0;
    var portfolio = (s.total_with_position || s.total_value_usdc || 0);
    var solImpact = totalSol * solPrice;
    var newCapital = ds ? (ds.injected_usdc || 0) : 0;
    var prevRow = i > 0 ? rows[i - 1] : null;
    var change = prevRow ? portfolio - prevRow.portfolio : 0;
    var solImpactChange = prevRow ? solImpact - prevRow.solImpact : 0;
    rows.push({ date: d, portfolio: portfolio, totalSol: totalSol, solPrice: solPrice, solImpact: solImpact, newCapital: newCapital, change: change, solImpactChange: solImpactChange });
  });

  var f = function(v, d) { return v != null ? Number(v).toFixed(d != null ? d : 2) : '--'; };
  var colFn = function(v) { return v >= 0 ? COLORS.green : COLORS.red; };
  var signFn = function(v, d) { return (v >= 0 ? '+' : '-') + '$' + f(Math.abs(v), d != null ? d : 2); };

  var html = '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:11px">';
  html += '<thead><tr>';
  html += '<th style="text-align:left;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">Date</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">Portfolio</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">SOL Impact</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">New Capital</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">Change</th>';
  html += '<th style="text-align:right;padding:6px 4px;color:#8b949e;border-bottom:1px solid #30363d">SOL Chg</th>';
  html += '</tr></thead><tbody>';

  rows.slice().reverse().forEach(function(r, idx) {
    var isFirst = idx === rows.length - 1;
    html += '<tr style="border-bottom:1px solid #21262d">';
    html += '<td style="padding:5px 4px;color:#c9d1d9;white-space:nowrap">' + r.date + '</td>';
    html += '<td style="padding:5px 4px;text-align:right;font-family:monospace;color:#c9d1d9">$' + f(r.portfolio, 0) + '</td>';
    html += '<td style="padding:5px 4px;text-align:right;font-family:monospace;color:#58a6ff" title="' + f(r.totalSol, 2) + ' SOL × $' + f(r.solPrice, 2) + '">$' + f(r.solImpact, 0) + ' <span style="color:#8b949e;font-size:9px">(' + f(r.totalSol, 1) + ' SOL)</span></td>';
    html += '<td style="padding:5px 4px;text-align:right;font-family:monospace;color:' + (r.newCapital > 0 ? COLORS.purple : '#8b949e') + '">' + (r.newCapital > 0 ? '$' + f(r.newCapital, 0) : '–') + '</td>';
    html += '<td style="padding:5px 4px;text-align:right;font-family:monospace;color:' + (isFirst ? '#8b949e' : colFn(r.change)) + '">' + (isFirst ? '–' : signFn(r.change, 0)) + '</td>';
    html += '<td style="padding:5px 4px;text-align:right;font-family:monospace;color:' + (isFirst ? '#8b949e' : colFn(r.solImpactChange)) + '">' + (isFirst ? '–' : signFn(r.solImpactChange, 0)) + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  makeTable('portfolio-value', html);
}

function populateCapitalAlloc(snaps) {
  var step=Math.max(1,Math.floor(snaps.length/100));
  var labels=[],wSol=[],wUsdc=[],pSol=[],pUsdc=[];
  for(var i=0;i<snaps.length;i+=step){
    var s=snaps[i];labels.push('');
    wSol.push((s.sol_balance||0)*s.price);wUsdc.push(s.usdc_balance||0);
    pSol.push((s.position_sol||0)*s.price);pUsdc.push(s.position_usdc||0);
  }
  makeChart('capital-alloc',{type:'line',data:{labels:labels,datasets:[
    {label:'Wallet SOL',data:wSol,backgroundColor:'#22c55e40',borderColor:COLORS.green,fill:true,pointRadius:0,tension:0.3},
    {label:'Wallet USDC',data:wUsdc,backgroundColor:'#58a6ff40',borderColor:COLORS.blue,fill:true,pointRadius:0,tension:0.3},
    {label:'Position SOL',data:pSol,backgroundColor:'#eab30840',borderColor:COLORS.amber,fill:true,pointRadius:0,tension:0.3},
    {label:'Position USDC',data:pUsdc,backgroundColor:'#a855f740',borderColor:COLORS.purple,fill:true,pointRadius:0,tension:0.3},
  ]},options:{plugins:{legend:{labels:{color:COLORS.gray,font:{size:10}}}},scales:{y:{stacked:true,ticks:{callback:function(v){return'$'+v.toFixed(0);}},grid:{color:'#21262d'}},x:{display:false}}}});
}

function populateDailyWaterfall(summaries) {
  if(summaries.length===0){makeTable('daily-waterfall','<div style="color:#8b949e;padding:12px">No data</div>');return;}
  var html='<div style="overflow-x:auto"><table><tr><th>Date</th><th style="text-align:right">Total</th><th style="text-align:right">Change</th><th style="text-align:right">Fees</th><th style="text-align:right">Injected</th><th>Regime</th></tr>';
  summaries.forEach(function(s){
    var chgCol=s.portfolio_change>=0?COLORS.green:COLORS.red;
    html+='<tr><td>'+s.date+'</td><td style="text-align:right;font-weight:bold">$'+fmt(s.total_usdc,0)+'</td><td style="text-align:right;color:'+chgCol+'">'+(s.portfolio_change>=0?'+':'')+fmt(s.portfolio_change)+'</td><td style="text-align:right;color:'+COLORS.gold+'">$'+fmt(s.fees_earned_usdc)+'</td><td style="text-align:right;color:'+(s.injected_usdc>0?COLORS.purple:COLORS.gray)+'">'+(s.injected_usdc>0?'$'+fmt(s.injected_usdc):'-')+'</td><td style="color:'+(REGIME_COLORS[s.regime]||COLORS.gray)+'">'+(s.regime||'-')+'</td></tr>';
  });
  html+='</table></div>';
  makeTable('daily-waterfall',html);
}

// ── INIT ──
buildToggles();
renderWidgets();
loadAll();
document.getElementById('days-select').addEventListener('change', loadAll);
setInterval(loadAll, 300000); // refresh every 5 min
</script>
</body></html>`;
}
