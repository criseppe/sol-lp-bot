/**
 * Bot Intelligence — unified execution analytics page
 * 13 original widgets + 8 from analytics = 21 widgets in 5 sections
 */

export function renderIntelligenceHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Intelligence — Execution Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;padding:12px}
.nav{display:flex;gap:5px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:7px 10px;border:1px solid #30363d;border-radius:6px;font-size:11px;text-align:center}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.hdr{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.hdr h1{font-size:18px;color:#58a6ff}
.hdr .sub{color:#8b949e;font-size:11px}
.df{display:flex;gap:4px;flex-wrap:wrap}
.df button{padding:5px 10px;font-size:10px;border:1px solid #30363d;background:transparent;color:#8b949e;border-radius:4px;cursor:pointer;font-family:inherit}
.df button.on{border-color:#58a6ff;color:#58a6ff;background:#58a6ff15}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.w{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;min-height:200px}
.w.full{grid-column:1/-1}
.w h3{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.w canvas{width:100%!important;max-height:260px}
.w table{width:100%;border-collapse:collapse;font-size:11px}
.w th{text-align:left;color:#8b949e;padding:4px 6px;border-bottom:1px solid #30363d;cursor:pointer;font-size:10px;user-select:none}
.w th:hover{color:#58a6ff}
.w td{padding:4px 6px;border-bottom:1px solid #21262d}
.w .empty{text-align:center;color:#484f58;padding:40px 0;font-size:11px}
.w .loading{text-align:center;color:#8b949e;padding:40px 0}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:bold}
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:16px}
.sum .s{text-align:center;padding:8px;background:#0d1117;border-radius:6px;border:1px solid #21262d}
.sum .s .v{font-size:18px;font-weight:bold;margin-bottom:2px}
.sum .s .l{font-size:9px;color:#8b949e}
.pag{display:flex;gap:4px;justify-content:center;margin-top:8px}
.pag button{padding:3px 8px;font-size:10px;border:1px solid #30363d;background:transparent;color:#8b949e;border-radius:3px;cursor:pointer}
.pag button.on{border-color:#58a6ff;color:#58a6ff}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.fees-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.fees-card{padding:8px;border:1px solid #21262d;border-radius:6px;text-align:center;background:#0d1117}
.fees-card-val{font-size:18px;font-weight:bold;font-family:monospace}
.fees-card-sub{font-size:9px;color:#8b949e;margin-top:1px}
.fees-card-label{font-size:9px;color:#484f58;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px}
.fees-compare{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11px;padding:8px 0;border-top:1px solid #21262d;border-bottom:1px solid #21262d}
.fees-bottom{display:flex;gap:16px;justify-content:center;font-size:11px;color:#8b949e;padding:10px 0 0}
.section-hdr{display:flex;align-items:center;gap:8px;padding:10px 0 6px;cursor:pointer;user-select:none;grid-column:1/-1}
.section-hdr h2{font-size:13px;color:#58a6ff;text-transform:uppercase;letter-spacing:1.5px;font-weight:600}
.section-hdr .arrow{color:#484f58;font-size:14px;transition:transform 0.2s}
.section-hdr .line{flex:1;height:1px;background:#21262d}
.section-content{display:contents}
.section-content.collapsed .w{display:none}
@media(max-width:700px){
  body{padding:8px}
  .grid{grid-template-columns:1fr}
  .w canvas{max-height:200px}
  .nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  .nav a{padding:6px 3px;font-size:9px}
  .hdr h1{font-size:15px}
  .sum{grid-template-columns:1fr 1fr}
  .sum .s .v{font-size:15px}
  .w th,.w td{padding:3px 4px;font-size:10px}
  .m-hide{display:none!important}
  .fees-cards{grid-template-columns:1fr 1fr}
  .fees-card-val{font-size:15px}
  .fees-compare{grid-template-columns:1fr 1fr}
  #hpCards,#ilCards{grid-template-columns:1fr 1fr!important}
  #cHourlyFees{max-height:200px!important}
  #cHourlyVol{max-height:120px!important}
  .fees-bottom{flex-wrap:wrap;gap:8px;font-size:10px}
  #cFees{max-height:200px!important}
  .section-hdr h2{font-size:11px}
}
</style></head><body>
<div class="nav">
  <a href="/live">Live Wallet</a><a href="/insights">Insights</a><a href="/strategy">Strategy</a>
  <a href="/config">Config</a>
  <a href="/projection">Projection</a><a href="/intelligence" class="active">Intelligence</a><a href="/arcade">Arcade</a>
</div>

<div class="hdr">
  <div><h1>Bot Intelligence</h1><div class="sub">execution analytics · updated live</div></div>
  <div class="df" id="df">
    <button onclick="setRange(7)" id="df7">7D</button>
    <button onclick="setRange(30)" class="on" id="df30">30D</button>
    <button onclick="setRange(0)" id="dfAll">ALL</button>
  </div>
</div>

<div class="sum" id="summary"></div>
<div class="grid" id="widgets"></div>

<script>
var DATA=null,CHS={},rangeDays=30,FEES_DATA=null,ANALYTICS=null;

function setRange(d){rangeDays=d;document.querySelectorAll('#df button').forEach(function(b){b.classList.remove('on')});
  if(d===7)document.getElementById('df7').classList.add('on');
  else if(d===30)document.getElementById('df30').classList.add('on');
  else document.getElementById('dfAll').classList.add('on');
  load();}

function fmt(n,d){return n!=null?Number(n).toFixed(d!=null?d:2):'—';}
var RC={RANGING:'#4a9eff',BULLISH_TREND:'#22c55e',BEARISH_TREND:'#ef4444',EXTREME:'#a855f7'};

function toggleSection(id){
  var content=document.getElementById('sec-'+id);
  var arrow=document.getElementById('arrow-'+id);
  if(!content)return;
  content.classList.toggle('collapsed');
  arrow.textContent=content.classList.contains('collapsed')?'\\u25B6':'\\u25BC';
  try{localStorage.setItem('intel-sec-'+id,content.classList.contains('collapsed')?'0':'1');}catch{}
}
function isSectionOpen(id){
  try{var v=localStorage.getItem('intel-sec-'+id);return v!=='0';}catch{return true;}
}

async function load(){
  try{
    var url='/api/intelligence';
    if(rangeDays>0){var from=Date.now()-rangeDays*86400000;url+='?from='+from+'&to='+Date.now();}
    var r=await fetch(url);DATA=await r.json();
    if(DATA.error){document.getElementById('widgets').innerHTML='<div class="w full"><div class="empty">'+DATA.error+'</div></div>';return;}
    render();
  }catch(e){document.getElementById('widgets').innerHTML='<div class="w full"><div class="empty">Failed: '+e+'</div></div>';}
}

async function loadAnalyticsData(){
  try{
    var days=rangeDays>0?rangeDays:90;
    var r=await fetch('/api/analytics-data?days='+days);
    if(r.ok){ANALYTICS=await r.json();renderAnalyticsWidgets();}
  }catch(e){console.warn('analytics data load failed',e);}
}

function sectionHeader(id,title){
  var open=isSectionOpen(id);
  return '<div class="section-hdr" onclick="toggleSection(\\''+id+'\\')"><span class="arrow" id="arrow-'+id+'">'+(open?'\\u25BC':'\\u25B6')+'</span><h2>'+title+'</h2><span class="line"></span></div>';
}

function render(){
  Object.values(CHS).forEach(function(c){try{c.destroy();}catch{}});CHS={};
  var S=DATA.summary;
  // Summary cards
  var sh='';
  sh+='<div class="s"><div class="v" style="color:#22c55e">$'+fmt(S.totalFees,0)+'</div><div class="l">Fees Collected</div></div>';
  sh+='<div class="s"><div class="v" style="color:#ef4444">$'+fmt(S.totalGas,2)+'</div><div class="l">Total Gas</div></div>';
  sh+='<div class="s"><div class="v" style="color:#ffd700">$'+fmt(S.totalFees-S.totalGas,0)+'</div><div class="l">Net Income</div></div>';
  sh+='<div class="s"><div class="v" style="color:#58a6ff">'+S.totalPositions+'</div><div class="l">Positions</div></div>';
  sh+='<div class="s"><div class="v" style="color:#c9d1d9">'+S.avgDuration+'m</div><div class="l">Avg Duration</div></div>';
  document.getElementById('summary').innerHTML=sh;

  var h='';

  // ── SECTION 1: DAILY PERFORMANCE ──
  h+=sectionHeader('perf','Daily Performance');
  var perfOpen=isSectionOpen('perf');
  h+='<div class="section-content'+(perfOpen?'':' collapsed')+'" id="sec-perf">';
  // W0: Daily Fees Intelligence
  h+=renderFeesIntelligence();
  // W1: Fee Income
  h+='<div class="w"><h3>Fee Income</h3><canvas id="c1"></canvas></div>';
  // Portfolio Growth (from analytics)
  h+='<div class="w full"><h3>Portfolio Growth (7D)</h3><canvas id="cPortGrowth"></canvas><div class="tbl-wrap" id="wPortGrowthTbl"></div></div>';
  // Hourly Performance
  h+='<div class="w full" id="wHourlyPerf">';
  h+='<h3>Hourly Performance</h3>';
  h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap">';
  h+='<button id="hpPrev" onclick="hpNav(-1)" style="background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer">\\u25C0</button>';
  h+='<select id="hpDate" onchange="hpLoad(this.value)" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 10px;font-size:12px;flex:1;max-width:180px"></select>';
  h+='<button id="hpNext" onclick="hpNav(1)" style="background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer">\\u25B6</button>';
  h+='</div>';
  h+='<canvas id="cHourlyFees" style="width:100%;max-height:280px"></canvas>';
  h+='<canvas id="cHourlyVol" style="width:100%;max-height:160px;margin-top:8px"></canvas>';
  h+='<div id="hpCards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px"></div>';
  h+='</div>';
  h+='</div>';

  // ── SECTION 2: POSITION ANALYTICS ──
  h+=sectionHeader('pos','Position Analytics');
  var posOpen=isSectionOpen('pos');
  h+='<div class="section-content'+(posOpen?'':' collapsed')+'" id="sec-pos">';
  // W2: Position P&L Table
  h+='<div class="w full"><h3>Position P&L</h3><div class="tbl-wrap" id="w2"></div></div>';
  // W6: Position Duration
  h+='<div class="w"><h3>Position Duration Distribution</h3><canvas id="c6"></canvas></div>';
  // Fee vs Duration (from analytics)
  h+='<div class="w"><h3>Fee vs Duration</h3><canvas id="cFeeVsDur"></canvas></div>';
  // W5: Exit Reason Breakdown
  h+='<div class="w"><h3>Exit Reason Breakdown</h3><canvas id="c5"></canvas></div>';
  // W11: Churn Rate
  h+='<div class="w"><h3>Churn Rate (Positions/Day)</h3><canvas id="c11"></canvas></div>';
  // In-Range Rate (from analytics)
  h+='<div class="w"><h3>In-Range Rate</h3><canvas id="cInRange"></canvas></div>';
  h+='</div>';

  // ── SECTION 3: COST & RISK ──
  h+=sectionHeader('cost','Cost & Risk');
  var costOpen=isSectionOpen('cost');
  h+='<div class="section-content'+(costOpen?'':' collapsed')+'" id="sec-cost">';
  // W4: Fee vs Gas
  h+='<div class="w"><h3>Fee vs Gas (Daily)</h3><canvas id="c4"></canvas></div>';
  // IL Tracker (full)
  h+='<div class="w full" id="wILTracker"><h3>Impermanent Loss <span style="font-size:9px;color:#484f58;font-weight:normal;text-transform:none;letter-spacing:0">realized IL at position close</span></h3>';
  h+='<div id="ilCards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px"></div>';
  h+='<canvas id="cILTracker" style="width:100%;max-height:260px"></canvas>';
  h+='<div id="ilRatio" style="text-align:center;padding:8px 0;font-size:12px"></div>';
  h+='<div class="tbl-wrap" id="ilRegimeTable"></div>';
  h+='</div>';
  // W10: Cost Basis vs Price
  h+='<div class="w full"><h3>Cost Basis vs SOL Price</h3><canvas id="c10"></canvas></div>';
  // W12: Gate Fire Rate
  h+='<div class="w"><h3>Gate Block Rate</h3><canvas id="c12"></canvas></div>';
  h+='</div>';

  // ── SECTION 4: REGIME & MARKET ──
  h+=sectionHeader('regime','Regime & Market');
  var regimeOpen=isSectionOpen('regime');
  h+='<div class="section-content'+(regimeOpen?'':' collapsed')+'" id="sec-regime">';
  // W7: Performance by Regime
  h+='<div class="w"><h3>Performance by Regime</h3><canvas id="c7"></canvas></div>';
  // W8: Regime Timeline
  h+='<div class="w full"><h3>Regime Timeline</h3><canvas id="c8"></canvas></div>';
  // SOL Price vs Fees (from analytics)
  h+='<div class="w"><h3>SOL Price vs Fee Rate</h3><canvas id="cPriceVsFees"></canvas></div>';
  // Volume & Volatility (from analytics)
  h+='<div class="w"><h3>Volume & Volatility</h3><canvas id="cVolHistory"></canvas></div>';
  // Weekday vs Weekend (from analytics)
  h+='<div class="w"><h3>Weekday vs Weekend</h3><canvas id="cFeesWeekday"></canvas></div>';
  h+='</div>';

  // ── SECTION 5: CAPITAL ──
  h+=sectionHeader('capital','Capital');
  var capitalOpen=isSectionOpen('capital');
  h+='<div class="section-content'+(capitalOpen?'':' collapsed')+'" id="sec-capital">';
  // Capital Allocation (from analytics)
  h+='<div class="w full"><h3>Capital Allocation</h3><canvas id="cCapitalAlloc"></canvas></div>';

  // W13: SOL Conversion Monitor
  var sc=DATA.solConversion;
  if(sc){
    var stCol=sc.status==='FIRING'?'#22c55e':sc.status==='COOLDOWN'?'#eab308':sc.status==='BLOCKED'?'#ef4444':'#484f58';
    var scH='<div class="w full"><h3>SOL Conversion Monitor <span class="badge" style="background:'+stCol+'20;color:'+stCol+';margin-left:8px">'+sc.status+'</span></h3>';
    scH+='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;font-size:11px">';
    var cdText=sc.cooldownRemainingMs>0?Math.floor(sc.cooldownRemainingMs/60000)+':'+String(Math.floor((sc.cooldownRemainingMs%60000)/1000)).padStart(2,'0'):'Ready';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Next fire</span><br><span id="sc-cd" style="color:'+(sc.cooldownRemainingMs>0?'#eab308':'#22c55e')+';font-weight:bold;font-size:14px">'+cdText+'</span></div>';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Cooldown</span><br><span style="color:#c9d1d9;font-weight:bold">'+sc.cooldownTotalMin+'min <span style="color:#8b949e;font-size:10px">('+DATA.regimeHistory?.[0]?.regime?.replace('_TREND','') || 'RANGING'+')</span></span></div>';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Threshold</span><br><span style="color:#c9d1d9;font-weight:bold">$'+sc.threshold.toFixed(2)+'</span> <span style="color:'+(sc.priceAboveThreshold?'#22c55e':'#ef4444')+';font-size:10px">'+(sc.priceAboveThreshold?'\\u2713':'\\u2717')+'</span></div>';
    scH+='</div>';
    scH+='<div style="font-size:10px;color:#8b949e;margin-bottom:10px">Cap: $'+sc.dynamicCap+' · Idle SOL: $'+sc.idleSolValue+'</div>';
    scH+='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">';
    scH+='<div class="s"><div class="v" style="color:#a855f7;font-size:16px">'+sc.todayCount+'</div><div class="l">Today</div></div>';
    scH+='<div class="s"><div class="v" style="color:#c9d1d9;font-size:16px">'+sc.todaySol.toFixed(1)+' SOL</div><div class="l">Converted</div></div>';
    scH+='<div class="s"><div class="v" style="color:#22c55e;font-size:16px">$'+sc.todayUsdc.toFixed(0)+'</div><div class="l">Received</div></div>';
    scH+='</div>';
    if(sc.weekCount>0){
      var avgP=sc.weekSol>0?(sc.weekUsdc/sc.weekSol):0;
      scH+='<div style="font-size:10px;color:#8b949e;margin-bottom:10px">Week: '+sc.weekCount+' conversions · '+sc.weekSol.toFixed(1)+' SOL → $'+sc.weekUsdc.toFixed(0)+' USDC · avg $'+avgP.toFixed(2)+'/SOL</div>';
    }
    if(sc.last){
      var ago=Math.round((Date.now()-sc.last.ts)/60000);
      var agoStr=ago<60?ago+'min ago':(ago/60).toFixed(1)+'h ago';
      var txLink=sc.last.tx?'<a href="https://solscan.io/tx/'+sc.last.tx+'" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:10px">'+sc.last.tx.slice(0,8)+'</a>':'';
      scH+='<div style="font-size:11px;color:#c9d1d9;margin-bottom:8px">Last: <b>'+agoStr+'</b> — '+sc.last.sol.toFixed(3)+' SOL → $'+sc.last.usdc.toFixed(2)+' @ $'+sc.last.price.toFixed(2)+' '+txLink+'</div>';
    }
    if(sc.recent&&sc.recent.length>0){
      scH+='<div class="tbl-wrap"><table><thead><tr><th>Time</th><th style="text-align:right">SOL</th><th style="text-align:right">USDC</th><th style="text-align:right">Price</th><th class="m-hide">TX</th></tr></thead><tbody>';
      sc.recent.forEach(function(r){
        var t=new Date(r.ts).toLocaleTimeString('en-US',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hour12:false});
        var tx=r.tx?'<a href="https://solscan.io/tx/'+r.tx+'" target="_blank" style="color:#58a6ff;text-decoration:none">'+r.tx.slice(0,8)+'</a>':'—';
        scH+='<tr><td>'+t+'</td><td style="text-align:right;font-family:monospace">'+r.sol.toFixed(3)+'</td><td style="text-align:right;font-family:monospace">$'+r.usdc.toFixed(2)+'</td><td style="text-align:right;font-family:monospace">$'+r.price.toFixed(2)+'</td><td class="m-hide">'+tx+'</td></tr>';
      });
      scH+='</tbody></table></div>';
    }
    scH+='</div>';
    h+=scH;
  }
  h+='</div>'; // end capital section

  document.getElementById('widgets').innerHTML=h;

  var df=DATA.dailyFees||[];
  var pos=DATA.positions||[];
  var rh=DATA.regimeHistory||[];
  var ph=DATA.priceHistory||[];
  var gf=DATA.gateFires||[];

  // W1: Fee Income bar chart
  if(df.length>0){
    var labels=df.map(function(d){return d.date.slice(5);});
    var cumFees=[];var cum=0;df.forEach(function(d){cum+=d.fees;cumFees.push(cum);});
    CHS.c1=new Chart(document.getElementById('c1'),{type:'bar',data:{labels:labels,datasets:[
      {label:'Daily Fees',data:df.map(function(d){return d.fees;}),backgroundColor:'#22c55e80',yAxisID:'y'},
      {label:'Cumulative',data:cumFees,type:'line',borderColor:'#eab308',backgroundColor:'transparent',tension:0.3,pointRadius:1,yAxisID:'y1'}
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{
      y:{ticks:{callback:function(v){return '$'+v;},color:'#8b949e'},grid:{color:'#21262d'}},
      y1:{position:'right',ticks:{callback:function(v){return '$'+v;},color:'#eab308'},grid:{display:false}},
      x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}
    }}});
  }

  // W2: Position table
  if(pos.length>0){
    var tb='<table><thead><tr><th>Date</th><th class="m-hide">Entry</th><th class="m-hide">Exit</th><th>Duration</th><th>Fees</th><th>Exit</th></tr></thead><tbody>';
    pos.slice().reverse().slice(0,30).forEach(function(p){
      var d=new Date(p.exitTime).toLocaleDateString('en-GB',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit'});
      var fCol=p.feesUsdc>0?'#22c55e':'#8b949e';
      var exitBadge=RC[p.regime]||'#8b949e';
      tb+='<tr><td>'+d+'</td><td class="m-hide" style="font-family:monospace">$'+fmt(p.entryPrice)+'</td><td class="m-hide" style="font-family:monospace">$'+fmt(p.exitPrice)+'</td>';
      tb+='<td>'+p.durationMin+'m</td><td style="color:'+fCol+'">$'+fmt(p.feesUsdc)+'</td>';
      tb+='<td><span class="badge" style="background:'+exitBadge+'20;color:'+exitBadge+'">'+p.exitReason.replace('T1_','').slice(0,8)+'</span></td></tr>';
    });
    tb+='</tbody></table>';
    document.getElementById('w2').innerHTML=tb;
  }else{document.getElementById('w2').innerHTML='<div class="empty">No positions yet</div>';}

  // W4: Fee vs Gas
  if(df.length>0){
    CHS.c4=new Chart(document.getElementById('c4'),{type:'bar',data:{labels:df.map(function(d){return d.date.slice(5);}),datasets:[
      {label:'Fees',data:df.map(function(d){return d.fees;}),backgroundColor:'#22c55e80'},
      {label:'Gas',data:df.map(function(d){return d.gas;}),backgroundColor:'#ef444480'},
      {label:'Net',data:df.map(function(d){return d.net;}),type:'line',borderColor:'#eab308',backgroundColor:'transparent',tension:0.3,pointRadius:1}
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{stacked:false,ticks:{callback:function(v){return '$'+v;},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}}}});
  }

  // W5: Exit Reason donut
  if(pos.length>0){
    var reasons={};pos.forEach(function(p){var r=p.exitReason.replace('T1_','');reasons[r]=(reasons[r]||0)+1;});
    var rKeys=Object.keys(reasons);var rVals=rKeys.map(function(k){return reasons[k];});
    var rCols=rKeys.map(function(k){return k==='DOWNSIDE'?'#ef4444':k==='UPSIDE'?'#22c55e':k==='OOR_BELOW'?'#f97316':k==='OOR_ABOVE'?'#eab308':'#8b949e';});
    CHS.c5=new Chart(document.getElementById('c5'),{type:'doughnut',data:{labels:rKeys,datasets:[{data:rVals,backgroundColor:rCols}]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}}}});
  }

  // W6: Duration histogram
  if(pos.length>0){
    var buckets=[{l:'0-5m',min:0,max:5},{l:'5-15m',min:5,max:15},{l:'15-30m',min:15,max:30},{l:'30-60m',min:30,max:60},{l:'1-4h',min:60,max:240},{l:'4h+',min:240,max:99999}];
    var bCounts=buckets.map(function(b){return pos.filter(function(p){return p.durationMin>=b.min&&p.durationMin<b.max;}).length;});
    var bCols=['#ef4444','#f97316','#eab308','#22c55e','#22c55e','#58a6ff'];
    CHS.c6=new Chart(document.getElementById('c6'),{type:'bar',data:{labels:buckets.map(function(b){return b.l;}),datasets:[{label:'Positions',data:bCounts,backgroundColor:bCols}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e'},grid:{display:false}}}}});
  }

  // W7: Performance by regime
  if(pos.length>0){
    var regimes={};pos.forEach(function(p){var r=p.regime||'RANGING';if(!regimes[r])regimes[r]={fees:0,count:0,dur:0};regimes[r].fees+=p.feesUsdc;regimes[r].count++;regimes[r].dur+=p.durationMin;});
    var rk=Object.keys(regimes);
    CHS.c7=new Chart(document.getElementById('c7'),{type:'bar',data:{labels:rk.map(function(r){return r.replace('_TREND','');}),datasets:[
      {label:'Avg Fees/Pos',data:rk.map(function(r){return regimes[r].count>0?(regimes[r].fees/regimes[r].count):0;}),backgroundColor:rk.map(function(r){return (RC[r]||'#888')+'80';})},
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return '$'+v.toFixed(2);},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e'},grid:{display:false}}}}});
  }

  // W8: Regime timeline
  if(rh.length>1){
    var segments=[];var prev=rh[0];
    for(var i=1;i<rh.length;i++){if(rh[i].regime!==prev.regime||i===rh.length-1){segments.push({regime:prev.regime,from:prev.ts,to:rh[i].ts});prev=rh[i];}}
    var tLabels=rh.filter(function(_,i){return i%Math.max(1,Math.floor(rh.length/20))===0;}).map(function(r){return new Date(r.ts).toLocaleTimeString('en-US',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hour12:false});});
    var tPrices=rh.filter(function(_,i){return i%Math.max(1,Math.floor(rh.length/20))===0;}).map(function(r){return r.price;});
    CHS.c8=new Chart(document.getElementById('c8'),{type:'line',data:{labels:tLabels,datasets:[
      {label:'SOL Price',data:tPrices,borderColor:'#c9d1d9',backgroundColor:'transparent',tension:0.3,pointRadius:1,borderWidth:1.5}
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return '$'+v;},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e',maxRotation:0,maxTicksLimit:10},grid:{display:false}}}}});
  }

  // W10: Cost Basis vs Price
  if(ph.length>1){
    var pLabels=ph.map(function(p){return new Date(p.ts).toLocaleTimeString('en-US',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hour12:false});});
    CHS.c10=new Chart(document.getElementById('c10'),{type:'line',data:{labels:pLabels,datasets:[
      {label:'SOL Price',data:ph.map(function(p){return p.price;}),borderColor:'#c9d1d9',backgroundColor:'transparent',tension:0.3,pointRadius:0,borderWidth:1.5},
      {label:'Cost Basis',data:ph.map(function(p){return p.costBasis;}),borderColor:'#eab308',borderDash:[5,3],backgroundColor:'transparent',tension:0,pointRadius:0,borderWidth:1.5}
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return '$'+v;},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e',maxRotation:0,maxTicksLimit:10},grid:{display:false}}}}});
  }

  // W11: Churn rate
  if(pos.length>0){
    var churnByDay={};pos.forEach(function(p){var d=new Date(p.exitTime).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});churnByDay[d]=(churnByDay[d]||0)+1;});
    var cDays=Object.keys(churnByDay).sort();var cVals=cDays.map(function(d){return churnByDay[d];});
    var cCols=cVals.map(function(v){return v<=3?'#22c55e80':v<=6?'#eab30880':'#ef444480';});
    CHS.c11=new Chart(document.getElementById('c11'),{type:'bar',data:{labels:cDays.map(function(d){return d.slice(5);}),datasets:[{label:'Positions/Day',data:cVals,backgroundColor:cCols}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}}}});
  }

  // W12: Gate block rate
  if(gf.length>0){
    CHS.c12=new Chart(document.getElementById('c12'),{type:'bar',data:{labels:gf.map(function(g){return g.date.slice(5);}),datasets:[
      {label:'ReserveGate',data:gf.map(function(g){return g.reserveBlock;}),backgroundColor:'#ef444480'},
      {label:'BasisGate',data:gf.map(function(g){return g.basisBlock;}),backgroundColor:'#eab30880'},
      {label:'ChurnGuard',data:gf.map(function(g){return g.churnBlock;}),backgroundColor:'#a855f780'}
    ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{stacked:true,ticks:{color:'#8b949e'},grid:{color:'#21262d'}},x:{stacked:true,ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}}}});
  }

  // Hourly fees chart for Daily Fees Intelligence
  renderFeesChart();

  // Render analytics widgets if data already loaded
  if(ANALYTICS) renderAnalyticsWidgets();

  // Render IL tracker from intelligence data
  renderILTracker();
}

function renderILTracker(){
  if(!DATA||!DATA.ilTracker)return;
  var il=DATA.ilTracker;
  var byDay=il.byDay||[];
  var byRegime=il.byRegime||[];
  var allTime=il.allTime||{totalIl:0,totalFees:0,positions:0};

  // Metric cards: today, 7d, 30d, all-time
  var cardsEl=document.getElementById('ilCards');
  if(cardsEl){
    var today=new Date().toLocaleDateString('en-CA',{timeZone:'UTC'});
    var todayRow=byDay.find(function(d){return d.date===today;});
    var now=Date.now();
    var il7d=byDay.filter(function(d){return new Date(d.date+'T00:00:00Z').getTime()>now-7*86400000;}).reduce(function(s,d){return s+d.il;},0);
    var il30d=byDay.filter(function(d){return new Date(d.date+'T00:00:00Z').getTime()>now-30*86400000;}).reduce(function(s,d){return s+d.il;},0);
    var ilCol=function(v){return v>=0?'#22c55e':'#ef4444';};
    var ilFmt=function(v){return (v>=0?'+':'')+('$'+Math.abs(v).toFixed(2));};
    var cs='';
    cs+='<div class="s"><div class="v" style="color:'+ilCol(todayRow?.il||0)+';font-size:14px">'+ilFmt(todayRow?.il||0)+'</div><div class="l">Today</div></div>';
    cs+='<div class="s"><div class="v" style="color:'+ilCol(il7d)+';font-size:14px">'+ilFmt(il7d)+'</div><div class="l">7 Days</div></div>';
    cs+='<div class="s"><div class="v" style="color:'+ilCol(il30d)+';font-size:14px">'+ilFmt(il30d)+'</div><div class="l">30 Days</div></div>';
    cs+='<div class="s"><div class="v" style="color:'+ilCol(allTime.totalIl)+';font-size:14px">'+ilFmt(allTime.totalIl)+'</div><div class="l">All Time</div></div>';
    cardsEl.innerHTML=cs;
  }

  // Dual bar chart: fees (green up) + IL (red down) + net line
  var chartEl=document.getElementById('cILTracker');
  if(chartEl&&byDay.length>0){
    if(CHS.cILTracker)try{CHS.cILTracker.destroy();}catch{}
    var last14=byDay.slice(-14);
    var labels=last14.map(function(d){return d.date.slice(5);});
    var fees=last14.map(function(d){return d.fees;});
    var ilVals=last14.map(function(d){return d.il;});
    var net=last14.map(function(d){return d.fees+d.il;});
    CHS.cILTracker=new Chart(chartEl,{type:'bar',data:{labels:labels,datasets:[
      {label:'Fees',data:fees,backgroundColor:'#22c55e80'},
      {label:'IL',data:ilVals,backgroundColor:'#ef444480'},
      {label:'Net P&L',data:net,type:'line',borderColor:'#eab308',backgroundColor:'transparent',tension:0.3,pointRadius:2,borderWidth:2}
    ]},options:{interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{ticks:{callback:function(v){return '$'+Number(v).toFixed(2);},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}}}});
  }

  // Ratio badge
  var ratioEl=document.getElementById('ilRatio');
  if(ratioEl&&allTime.totalIl!==0){
    var absIl=Math.abs(allTime.totalIl);
    var ratio=absIl>0?allTime.totalFees/absIl:999;
    var rCol=ratio>=2?'#22c55e':ratio>=1?'#eab308':'#ef4444';
    var rText=ratio>=1?'Fees '+ratio.toFixed(1)+'x IL — net positive':'IL exceeds fees';
    ratioEl.innerHTML='<span class="badge" style="background:'+rCol+'20;color:'+rCol+';padding:4px 12px;font-size:12px">'+rText+'</span> <span style="color:#8b949e;font-size:11px;margin-left:8px">Fees $'+fmt(allTime.totalFees)+' vs IL $'+fmt(absIl)+'</span>';
  }

  // IL by regime table
  var tblEl=document.getElementById('ilRegimeTable');
  if(tblEl&&byRegime.length>0){
    var RC2={RANGING:'#4a9eff',BULLISH_TREND:'#22c55e',BEARISH_TREND:'#ef4444',EXTREME:'#a855f7'};
    var t='<table style="margin-top:8px"><thead><tr><th>Regime</th><th style="text-align:right">Positions</th><th style="text-align:right">Avg IL</th><th style="text-align:right">Avg Fees</th><th style="text-align:right">Net/Pos</th><th style="text-align:right">Total IL</th><th style="text-align:right">Total Fees</th></tr></thead><tbody>';
    byRegime.forEach(function(r){
      var netPer=r.avgFees+r.avgIl;
      var netCol=netPer>=0?'#22c55e':'#ef4444';
      t+='<tr><td style="color:'+(RC2[r.regime]||'#8b949e')+'">'+r.regime.replace('_TREND','')+'</td>';
      t+='<td style="text-align:right">'+r.positions+'</td>';
      t+='<td style="text-align:right;color:#ef4444">$'+fmt(Math.abs(r.avgIl),4)+'</td>';
      t+='<td style="text-align:right;color:#22c55e">$'+fmt(r.avgFees)+'</td>';
      t+='<td style="text-align:right;color:'+netCol+'">'+(netPer>=0?'+':'-')+'$'+fmt(Math.abs(netPer))+'</td>';
      t+='<td style="text-align:right;color:#ef4444">$'+fmt(Math.abs(r.totalIl))+'</td>';
      t+='<td style="text-align:right;color:#22c55e">$'+fmt(r.totalFees)+'</td>';
      t+='</tr>';
    });
    t+='</tbody></table>';
    tblEl.innerHTML=t;
  }
}

// ── ANALYTICS WIDGET RENDERERS (from analytics-page data) ──

function totalFeesCalc(s){
  var p=(s.pending_fees_sol||0)*s.price+(s.pending_fees_usdc||0);
  return (s.cum_fees_sol||0)*s.price+(s.cum_fees_usdc||0)+(p>1000?0:p);
}

function buildHourlyFees(snaps){
  var map={};
  for(var i=1;i<snaps.length;i++){
    var d=new Date(snaps[i].timestamp);
    var key=d.toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'})+'T'+String(d.getUTCHours()).padStart(2,'0');
    var delta=totalFeesCalc(snaps[i])-totalFeesCalc(snaps[i-1]);
    if(delta>0&&delta<100){
      if(!map[key])map[key]={fees:0,inRange:0,total:0,price:snaps[i].price,regime:snaps[i].regime};
      map[key].fees+=delta;
      if(snaps[i].in_range)map[key].inRange++;
      map[key].total++;
    }
  }
  return Object.entries(map).map(function(e){return{hour:e[0],fees:e[1].fees,irPct:e[1].total>0?e[1].inRange/e[1].total*100:0,price:e[1].price,regime:e[1].regime};}).sort(function(a,b){return a.hour.localeCompare(b.hour);});
}

function buildPositions(events){
  var positions=[],lastOpen=null;
  events.forEach(function(e){
    if(e.event_type==='POSITION_OPENED'){
      var capB=(e.sol_before||0)*e.price+(e.usdc_before||0);
      var capA=(e.sol_after||0)*e.price+(e.usdc_after||0);
      lastOpen={ts:e.timestamp,price:e.price,capital:Math.max(0,capB-capA),regime:e.regime};
    }else if(['T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_CLOSED'].includes(e.event_type)&&lastOpen){
      var fees=(e.fee_sol||0)*e.price+(e.fee_usdc||0);
      positions.push({openTime:lastOpen.ts,closeTime:e.timestamp,duration:(e.timestamp-lastOpen.ts)/60000,
        openPrice:lastOpen.price,closePrice:e.price,capital:lastOpen.capital,
        fees:fees,il:e.il_at_close||0,net:fees+(e.il_at_close||0),reason:e.event_type,regime:lastOpen.regime});
      lastOpen=null;
    }
  });
  return positions;
}

function renderAnalyticsWidgets(){
  if(!ANALYTICS)return;
  var snaps=ANALYTICS.snaps||[];
  var events=ANALYTICS.events||[];
  if(snaps.length<2)return;
  var positions=buildPositions(events);
  var hourlyFees=buildHourlyFees(snaps);
  var summaries=ANALYTICS.dailySummaries||[];

  // 1. Portfolio Growth (stacked bar: wallet+position per day, organic P&L line)
  try{
    var elPG=document.getElementById('cPortGrowth');
    var elPGTbl=document.getElementById('wPortGrowthTbl');
    if(elPG&&summaries.length>0){
      if(CHS.cPortGrowth)try{CHS.cPortGrowth.destroy();}catch{}
      var pgDays=summaries.slice(-7);
      var pgLabels=pgDays.map(function(s){return s.date.slice(5);});
      var pgWallet=pgDays.map(function(s){return s.wallet_usdc||0;});
      var pgPosition=pgDays.map(function(s){return s.position_usdc||0;});
      var pgInjected=pgDays.map(function(s){return s.injected_usdc||0;});
      var pgFees=pgDays.map(function(s){return s.fees_earned_usdc||0;});
      var pgChange=pgDays.map(function(s){return s.portfolio_change||0;});
      var pgTotal=pgDays.map(function(s){return s.total_usdc||0;});
      // Organic line = cumulative fees over the 7 days
      var pgOrganic=[];var pgOrgCum=0;pgFees.forEach(function(f){pgOrgCum+=f;pgOrganic.push(pgOrgCum);});
      CHS.cPortGrowth=new Chart(elPG,{type:'bar',data:{labels:pgLabels,datasets:[
        {label:'Wallet',data:pgWallet,backgroundColor:'#22c55e80',stack:'portfolio'},
        {label:'Position',data:pgPosition,backgroundColor:'#58a6ff80',stack:'portfolio'},
        {label:'Injected',data:pgInjected,backgroundColor:'#a855f780',stack:'portfolio'},
        {label:'Organic P&L',data:pgOrganic,type:'line',borderColor:'#22c55e',backgroundColor:'transparent',tension:0.3,pointRadius:3,borderWidth:2,yAxisID:'y1'}
      ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{
        y:{stacked:true,ticks:{callback:function(v){return '$'+v;},color:'#8b949e'},grid:{color:'#21262d'}},
        y1:{position:'right',ticks:{callback:function(v){return '$'+Number(v).toFixed(2);},color:'#22c55e'},grid:{display:false}},
        x:{stacked:true,ticks:{color:'#8b949e'},grid:{display:false}}
      }}});
      // Table below chart
      if(elPGTbl){
        var tbl='<table style="margin-top:10px"><thead><tr><th>Date</th><th style="text-align:right">Wallet</th><th style="text-align:right">Position</th><th style="text-align:right">Injected</th><th style="text-align:right">Total</th><th style="text-align:right">Fees</th><th style="text-align:right">Change</th></tr></thead><tbody>';
        pgDays.slice().reverse().forEach(function(s){
          var chgCol=(s.portfolio_change||0)>=0?'#22c55e':'#ef4444';
          var chgSign=(s.portfolio_change||0)>=0?'+':'';
          tbl+='<tr><td>'+s.date+'</td><td style="text-align:right;color:#22c55e">$'+fmt(s.wallet_usdc||0,0)+'</td><td style="text-align:right;color:#58a6ff">$'+fmt(s.position_usdc||0,0)+'</td><td style="text-align:right;color:'+(s.injected_usdc>0?'#a855f7':'#484f58')+'">'+(s.injected_usdc>0?'$'+fmt(s.injected_usdc,0):'—')+'</td><td style="text-align:right;font-weight:bold">$'+fmt(s.total_usdc||0,0)+'</td><td style="text-align:right;color:#ffd700">$'+fmt(s.fees_earned_usdc||0)+'</td><td style="text-align:right;color:'+chgCol+'">'+chgSign+'$'+fmt(Math.abs(s.portfolio_change||0))+'</td></tr>';
        });
        tbl+='</tbody></table>';
        elPGTbl.innerHTML=tbl;
      }
    }
  }catch(e){console.warn('portfolio-growth error',e);}

  // 2. In-Range Rate
  try{
    var el2=document.getElementById('cInRange');
    if(el2&&snaps.length>10){
      if(CHS.cInRange)try{CHS.cInRange.destroy();}catch{}
      var step=Math.max(1,Math.floor(snaps.length/100));
      var irLabels=[],irData=[];
      for(var i=0;i<snaps.length;i+=step){
        var windowSize=Math.min(60,snaps.length-i);
        var ir=0;for(var j=i;j<i+windowSize&&j<snaps.length;j++)if(snaps[j].in_range)ir++;
        irLabels.push('');irData.push(ir/windowSize*100);
      }
      CHS.cInRange=new Chart(el2,{type:'line',data:{labels:irLabels,datasets:[{label:'In-Range %',data:irData,borderColor:'#22c55e',backgroundColor:'#22c55e20',fill:true,pointRadius:0,tension:0.3}]},options:{plugins:{legend:{display:false}},scales:{y:{min:0,max:100,ticks:{callback:function(v){return v+'%';},color:'#8b949e'},grid:{color:'#21262d'}},x:{display:false}}}});
    }
  }catch(e){console.warn('in-range error',e);}

  // 3. IL Tracker — uses DATA.ilTracker from /api/intelligence
  // (rendered separately below after main render, since it uses DATA not ANALYTICS)

  // 4. Fee vs Duration scatter
  try{
    var el4=document.getElementById('cFeeVsDur');
    if(el4&&positions.length>0){
      if(CHS.cFeeVsDur)try{CHS.cFeeVsDur.destroy();}catch{}
      var scatterData=positions.map(function(p){return{x:p.duration,y:p.fees};});
      CHS.cFeeVsDur=new Chart(el4,{type:'scatter',data:{datasets:[{label:'Fee vs Duration',data:scatterData,backgroundColor:'#ffd70080',pointRadius:4}]},options:{plugins:{legend:{display:false}},scales:{x:{title:{display:true,text:'Duration (min)',color:'#8b949e'},grid:{color:'#21262d'},ticks:{color:'#8b949e'}},y:{title:{display:true,text:'Fees ($)',color:'#8b949e'},ticks:{callback:function(v){return '$'+v.toFixed(2);},color:'#8b949e'},grid:{color:'#21262d'}}}}});
    }
  }catch(e){console.warn('fee-vs-duration error',e);}

  // 5. SOL Price vs Fees
  try{
    var el5=document.getElementById('cPriceVsFees');
    if(el5&&hourlyFees.length>0){
      if(CHS.cPriceVsFees)try{CHS.cPriceVsFees.destroy();}catch{}
      var pvLabels=hourlyFees.map(function(h){return h.hour.slice(-5);});
      var pvPrices=hourlyFees.map(function(h){return h.price;});
      var pvFees=hourlyFees.map(function(h){return h.fees;});
      CHS.cPriceVsFees=new Chart(el5,{type:'line',data:{labels:pvLabels,datasets:[{label:'SOL Price',data:pvPrices,borderColor:'#58a6ff',pointRadius:0,yAxisID:'y',tension:0.3},{label:'Fees ($)',data:pvFees,borderColor:'#ffd700',pointRadius:0,yAxisID:'y1',tension:0.3}]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{position:'left',ticks:{callback:function(v){return '$'+v.toFixed(0);},color:'#8b949e'},grid:{color:'#21262d'}},y1:{position:'right',ticks:{callback:function(v){return '$'+v.toFixed(2);},color:'#8b949e'},grid:{display:false}},x:{display:false}}}});
    }
  }catch(e){console.warn('price-vs-fees error',e);}

  // 6. Capital Allocation
  try{
    var el6=document.getElementById('cCapitalAlloc');
    if(el6&&snaps.length>2){
      if(CHS.cCapitalAlloc)try{CHS.cCapitalAlloc.destroy();}catch{}
      var caStep=Math.max(1,Math.floor(snaps.length/100));
      var caLabels=[],wSol=[],wUsdc=[],pSol=[],pUsdc=[];
      for(var ci=0;ci<snaps.length;ci+=caStep){
        var s=snaps[ci];caLabels.push('');
        wSol.push((s.sol_balance||0)*s.price);wUsdc.push(s.usdc_balance||0);
        pSol.push((s.position_sol||0)*s.price);pUsdc.push(s.position_usdc||0);
      }
      CHS.cCapitalAlloc=new Chart(el6,{type:'line',data:{labels:caLabels,datasets:[
        {label:'Wallet SOL',data:wSol,backgroundColor:'#22c55e40',borderColor:'#22c55e',fill:true,pointRadius:0,tension:0.3},
        {label:'Wallet USDC',data:wUsdc,backgroundColor:'#58a6ff40',borderColor:'#58a6ff',fill:true,pointRadius:0,tension:0.3},
        {label:'Position SOL',data:pSol,backgroundColor:'#eab30840',borderColor:'#eab308',fill:true,pointRadius:0,tension:0.3},
        {label:'Position USDC',data:pUsdc,backgroundColor:'#a855f740',borderColor:'#a855f7',fill:true,pointRadius:0,tension:0.3},
      ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{y:{stacked:true,ticks:{callback:function(v){return '$'+v.toFixed(0);},color:'#8b949e'},grid:{color:'#21262d'}},x:{display:false}}}});
    }
  }catch(e){console.warn('capital-alloc error',e);}

  // 7. Weekday vs Weekend
  try{
    var el7=document.getElementById('cFeesWeekday');
    if(el7&&snaps.length>10){
      if(CHS.cFeesWeekday)try{CHS.cFeesWeekday.destroy();}catch{}
      var wd={fees:0,hours:0},we={fees:0,hours:0};
      for(var wi=1;wi<snaps.length;wi++){
        var day=new Date(snaps[wi].timestamp).toLocaleDateString('en-US',{timeZone:'Europe/Berlin',weekday:'short'});
        var isWe=day==='Sat'||day==='Sun';var b=isWe?we:wd;
        var delta=totalFeesCalc(snaps[wi])-totalFeesCalc(snaps[wi-1]);
        var elapsed=(snaps[wi].timestamp-snaps[wi-1].timestamp)/3600000;
        if(delta>0&&delta<100)b.fees+=delta;b.hours+=elapsed;
      }
      var wdRate=wd.hours>0?wd.fees/wd.hours*24:0;var weRate=we.hours>0?we.fees/we.hours*24:0;
      CHS.cFeesWeekday=new Chart(el7,{type:'bar',data:{labels:['Weekday','Weekend'],datasets:[{label:'$/day',data:[wdRate,weRate],backgroundColor:['#58a6ff','#a855f7']}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return '$'+v.toFixed(0);},color:'#8b949e'},grid:{color:'#21262d'}},x:{ticks:{color:'#8b949e'},grid:{display:false}}}}});
    }
  }catch(e){console.warn('fees-weekday error',e);}

  // 8. Volume & Volatility (SOL price history)
  try{
    var el8=document.getElementById('cVolHistory');
    if(el8&&snaps.length>10){
      if(CHS.cVolHistory)try{CHS.cVolHistory.destroy();}catch{}
      var vStep=Math.max(1,Math.floor(snaps.length/100));
      var vLabels=[],vPrices=[];
      for(var vi=0;vi<snaps.length;vi+=vStep){vLabels.push('');vPrices.push(snaps[vi].price);}
      CHS.cVolHistory=new Chart(el8,{type:'line',data:{labels:vLabels,datasets:[{label:'SOL Price',data:vPrices,borderColor:'#58a6ff',pointRadius:0,tension:0.3,fill:false}]},options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:function(v){return '$'+v.toFixed(0);},color:'#8b949e'},grid:{color:'#21262d'}},x:{display:false}}}});
    }
  }catch(e){console.warn('vol-history error',e);}
}

function renderFeesIntelligence(){
  if(!FEES_DATA)return '<div class="w full" id="fees-widget"><div class="loading">Loading daily fees…</div></div>';
  var d=FEES_DATA;
  var todayCol=d.feesTodayTotal>d.fees7dAvgSameTime?'#22c55e':d.feesTodayTotal<d.fees7dAvgSameTime*0.80?'#ef4444':'#c9d1d9';
  var progressPct=d.feesExpectedToday>0?Math.min(100,d.feesTodayTotal/d.feesExpectedToday*100):0;
  var onTrack=d.fees7dAvgSameTime>0&&d.feesTodayTotal>=d.fees7dAvgSameTime*0.90;
  var barCol=onTrack?'#22c55e':'#eab308';
  var vsYCol=d.vsYesterdaySameTime>=0?'#22c55e':'#ef4444';
  var vs7Col=d.vs7dAvg>=0?'#22c55e':'#ef4444';
  var vsYSign=d.vsYesterdaySameTime>=0?'+':'';
  var vs7Sign=d.vs7dAvg>=0?'+':'';
  var confCol=d.confidence==='HIGH'?'#22c55e':d.confidence==='MEDIUM'?'#eab308':'#ef4444';

  var s='<div class="w full" id="fees-widget">';
  s+='<h3>Daily Fees Intelligence <span style="font-size:9px;color:#484f58;font-weight:normal;text-transform:none;letter-spacing:0">Updated every 5 min · Day resets at 00:00 UTC</span></h3>';
  s+='<div class="fees-cards">';
  s+='<div class="fees-card" style="border-color:'+todayCol+'30"><div class="fees-card-val" style="color:'+todayCol+'">$'+fmt(d.feesTodayTotal)+'</div><div class="fees-card-sub">'+fmt(d.feesPending,3)+' pending (separate)</div><div class="fees-card-label">Collected today</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.feesYesterday)+'</div><div class="fees-card-sub">full day</div><div class="fees-card-label">Yesterday</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.fees7dAvgSameTime)+'</div><div class="fees-card-sub">at '+d.hoursElapsed+'h elapsed</div><div class="fees-card-label">7D avg (same time)</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.feesExpectedToday)+'</div><div class="fees-card-sub" style="color:'+confCol+'">'+d.confidence+' confidence</div><div class="fees-card-label">Expected today</div></div>';
  s+='</div>';
  s+='<div style="margin:10px 0">';
  s+='<div style="display:flex;justify-content:space-between;font-size:10px;color:#8b949e;margin-bottom:3px"><span>Today: $'+fmt(d.feesTodayTotal)+' of expected $'+fmt(d.feesExpectedToday)+'</span><span>'+fmt(progressPct,0)+'%</span></div>';
  s+='<div style="background:#21262d;border-radius:4px;height:8px;overflow:hidden"><div style="width:'+progressPct+'%;height:100%;background:'+barCol+';border-radius:4px;transition:width 0.5s"></div></div>';
  s+='</div>';
  s+='<div class="fees-compare">';
  s+='<div><span style="color:#8b949e">vs Yesterday (same time):</span> <span style="color:'+vsYCol+';font-weight:bold">'+vsYSign+fmt(d.vsYesterdaySameTime,1)+'%</span></div>';
  s+='<div><span style="color:#8b949e">vs 7D average:</span> <span style="color:'+vs7Col+';font-weight:bold">'+vs7Sign+fmt(d.vs7dAvg,1)+'%</span></div>';
  s+='<div><span style="color:#8b949e">Run rate:</span> <span style="color:#c9d1d9;font-weight:bold">$'+fmt(d.currentRunRate)+'/hr</span> <span style="color:#484f58">('+d.hoursElapsed+'h)</span></div>';
  s+='<div><span style="color:#8b949e">Pending fees:</span> <span style="color:#eab308;font-weight:bold">$'+fmt(d.feesPending)+'</span></div>';
  s+='</div>';
  s+='<div style="margin-top:12px"><canvas id="cFees" style="width:100%;max-height:220px"></canvas></div>';
  s+='<div class="fees-bottom">';
  s+='<span>Positions today: <b>'+d.positionsToday+'</b></span>';
  s+='<span>Avg per position: <b>$'+fmt(d.avgFeesPerPosition)+'</b></span>';
  s+='<span>Best position: <b>$'+fmt(d.bestPosition)+'</b></span>';
  s+='</div>';
  s+='</div>';
  return s;
}

function renderFeesChart(){
  if(!FEES_DATA)return;
  var el=document.getElementById('cFees');if(!el)return;
  var d=FEES_DATA;
  var labels=[];for(var i=0;i<24;i++)labels.push(String(i).padStart(2,'0'));
  var todayBg=d.hourlyToday.map(function(_,i){return i===d.currentHour?'#58a6ff':'#22c55e80';});
  CHS.cFees=new Chart(el,{type:'bar',data:{labels:labels,datasets:[
    {label:'Today',data:d.hourlyToday,backgroundColor:todayBg,order:2},
    {label:'7D Avg',data:d.hourly7dAvg,type:'line',borderColor:'#eab308',borderDash:[5,3],backgroundColor:'transparent',tension:0.3,pointRadius:0,borderWidth:1.5,order:1}
  ]},options:{plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{
    y:{ticks:{callback:function(v){return '$'+Number(v).toFixed(2);},color:'#8b949e'},grid:{color:'#21262d'}},
    x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}
  }}});
}

async function loadFeesData(){
  try{
    var r=await fetch('/api/daily-fees-intelligence');
    if(r.ok){
      FEES_DATA=await r.json();
      var w=document.getElementById('fees-widget');
      if(w){
        var parent=w.parentNode;
        var tmp=document.createElement('div');
        tmp.innerHTML=renderFeesIntelligence();
        var newW=tmp.firstChild;
        parent.replaceChild(newW,w);
        if(CHS.cFees){try{CHS.cFees.destroy();}catch{}}
        renderFeesChart();
      }
    }
  }catch(e){console.warn('fees intelligence load failed',e);}
}

// ── HOURLY PERFORMANCE WIDGET ──
var HP_DATA=null,HP_DATES=[];
async function hpLoad(date){
  try{
    var r=await fetch('/api/hourly-performance?date='+date);
    if(!r.ok)return;
    HP_DATA=await r.json();
    // Populate date selector on first load
    var sel=document.getElementById('hpDate');
    if(sel&&HP_DATA.availableDates&&sel.options.length===0){
      HP_DATES=HP_DATA.availableDates;
      HP_DATES.slice().reverse().forEach(function(d){
        var opt=document.createElement('option');
        opt.value=d;opt.textContent=d;
        if(d===date)opt.selected=true;
        sel.appendChild(opt);
      });
    }else if(sel){sel.value=date;}
    // Update nav buttons
    var idx=HP_DATES.indexOf(date);
    var prevBtn=document.getElementById('hpPrev');
    var nextBtn=document.getElementById('hpNext');
    if(prevBtn)prevBtn.disabled=idx<=0;
    if(nextBtn)nextBtn.disabled=idx>=HP_DATES.length-1;
    hpRender();
  }catch(e){console.warn('hourly-performance load failed',e);}
}
function hpNav(dir){
  var sel=document.getElementById('hpDate');
  if(!sel)return;
  var idx=HP_DATES.indexOf(sel.value);
  var next=idx+dir;
  if(next>=0&&next<HP_DATES.length){hpLoad(HP_DATES[next]);}
}
function hpRender(){
  if(!HP_DATA||!HP_DATA.hours)return;
  var hrs=HP_DATA.hours;
  var labels=hrs.map(function(h){return h.hour;});
  var fees=hrs.map(function(h){return h.fees;});
  var uptime=hrs.map(function(h){return h.activePct;});
  var priceRange=hrs.map(function(h){return h.priceRange;});
  var bbWidth=hrs.map(function(h){return h.bbWidth;});

  // Fees + uptime chart
  if(CHS.cHourlyFees)try{CHS.cHourlyFees.destroy();}catch{}
  var el1=document.getElementById('cHourlyFees');
  if(el1){
    var feeCols=fees.map(function(v){return v>2?'#2ea043cc':v>0.5?'#2ea04399':'#2ea04340';});
    CHS.cHourlyFees=new Chart(el1,{type:'bar',data:{labels:labels,datasets:[
      {label:'Fees ($)',data:fees,backgroundColor:feeCols,yAxisID:'y',order:2},
      {label:'Active %',data:uptime,type:'line',borderColor:'#58a6ff',backgroundColor:'transparent',tension:0.3,pointRadius:2,borderWidth:2,yAxisID:'y1',order:1}
    ]},options:{interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}},tooltip:{callbacks:{label:function(ctx){
      var h=hrs[ctx.dataIndex];
      if(ctx.datasetIndex===0)return 'Fees: $'+fmt(h.fees,4)+' ('+h.events+' events)';
      return 'Active: '+fmt(h.activePct,1)+'%';
    },afterBody:function(items){
      var h=hrs[items[0].dataIndex];
      var lines=[];
      if(h.high>0)lines.push('Price: $'+fmt(h.low)+' – $'+fmt(h.high)+' (range $'+fmt(h.priceRange,4)+')');
      if(h.bbWidth>0)lines.push('BB Width: '+fmt(h.bbWidth,2)+'%');
      return lines;
    }}}},scales:{
      y:{ticks:{callback:function(v){return '$'+Number(v).toFixed(2);},color:'#8b949e'},grid:{color:'#21262d'},title:{display:true,text:'Fees',color:'#484f58',font:{size:10}}},
      y1:{position:'right',min:0,max:100,ticks:{callback:function(v){return v+'%';},color:'#58a6ff'},grid:{display:false},title:{display:true,text:'Active %',color:'#484f58',font:{size:10}}},
      x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}
    }}});
  }

  // Volatility chart
  if(CHS.cHourlyVol)try{CHS.cHourlyVol.destroy();}catch{}
  var el2=document.getElementById('cHourlyVol');
  if(el2){
    CHS.cHourlyVol=new Chart(el2,{type:'line',data:{labels:labels,datasets:[
      {label:'Price Range ($)',data:priceRange,borderColor:'#f97316',backgroundColor:'#f9731620',fill:true,tension:0.3,pointRadius:2,borderWidth:1.5,yAxisID:'y'},
      {label:'BB Width (%)',data:bbWidth,borderColor:'#a855f7',backgroundColor:'transparent',tension:0.3,pointRadius:2,borderWidth:1.5,yAxisID:'y1'}
    ]},options:{interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#8b949e',font:{size:10}}}},scales:{
      y:{ticks:{callback:function(v){return '$'+Number(v).toFixed(2);},color:'#f97316'},grid:{color:'#21262d'},title:{display:true,text:'Price Range',color:'#484f58',font:{size:10}}},
      y1:{position:'right',ticks:{callback:function(v){return Number(v).toFixed(1)+'%';},color:'#a855f7'},grid:{display:false},title:{display:true,text:'BB Width',color:'#484f58',font:{size:10}}},
      x:{ticks:{color:'#8b949e',maxRotation:0},grid:{display:false}}
    }}});
  }

  // Summary cards
  var cardsEl=document.getElementById('hpCards');
  if(cardsEl){
    var bestHr=hrs.reduce(function(a,b){return b.fees>a.fees?b:a;},hrs[0]);
    var activeHrs=hrs.filter(function(h){return h.activePct!=null;});
    var avgActive=activeHrs.length>0?activeHrs.reduce(function(s,h){return s+h.activePct;},0)/activeHrs.length:0;
    var peakVol=hrs.reduce(function(a,b){return b.priceRange>a.priceRange?b:a;},hrs[0]);
    var totalFees=hrs.reduce(function(s,h){return s+h.fees;},0);
    var cs='';
    cs+='<div class="s"><div class="v" style="color:#ffd700;font-size:14px">'+bestHr.hour+':00</div><div class="l">Best hour ($'+fmt(bestHr.fees)+')</div></div>';
    cs+='<div class="s"><div class="v" style="color:#58a6ff;font-size:14px">'+fmt(avgActive,0)+'%</div><div class="l">Avg active</div></div>';
    cs+='<div class="s"><div class="v" style="color:#f97316;font-size:14px">'+peakVol.hour+':00</div><div class="l">Peak vol ($'+fmt(peakVol.priceRange,4)+')</div></div>';
    cs+='<div class="s"><div class="v" style="color:#22c55e;font-size:14px">$'+fmt(totalFees)+'</div><div class="l">Total fees</div></div>';
    cardsEl.innerHTML=cs;
  }
}

load();
loadFeesData();
loadAnalyticsData();
var hpToday=new Date().toLocaleDateString('en-CA',{timeZone:'UTC'});
hpLoad(hpToday);
setInterval(function(){hpLoad(document.getElementById('hpDate')?.value||hpToday);},300000);
setInterval(loadFeesData,300000);
setInterval(loadAnalyticsData,300000);
var scCdStart=0,scCdTotal=0;
function updateScCd(){var el=document.getElementById('sc-cd');if(!el)return;var rem=Math.max(0,scCdTotal-(Date.now()-scCdStart));if(rem<=0){el.textContent='Ready';el.style.color='#22c55e';}else{var m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);el.textContent=m+':'+String(s).padStart(2,'0');}}
setInterval(updateScCd,1000);
var _origRender=render;render=function(){_origRender();if(DATA&&DATA.solConversion){scCdStart=Date.now();scCdTotal=DATA.solConversion.cooldownRemainingMs||0;}};
</script>
</body></html>`;
}
