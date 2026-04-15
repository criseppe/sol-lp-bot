/**
 * Bot Intelligence — execution analytics page with 12 interactive widgets
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
  .fees-bottom{flex-wrap:wrap;gap:8px;font-size:10px}
  #cFees{max-height:200px!important}
}
</style></head><body>
<div class="nav">
  <a href="/live">Live Wallet</a><a href="/insights">Insights</a><a href="/strategy">Strategy</a>
  <a href="/config">Config</a><a href="/analytics">Analytics</a>
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
var DATA=null,CHS={},rangeDays=30,FEES_DATA=null;

function setRange(d){rangeDays=d;document.querySelectorAll('#df button').forEach(function(b){b.classList.remove('on')});
  if(d===7)document.getElementById('df7').classList.add('on');
  else if(d===30)document.getElementById('df30').classList.add('on');
  else document.getElementById('dfAll').classList.add('on');
  load();}

function fmt(n,d){return n!=null?Number(n).toFixed(d!=null?d:2):'—';}
var RC={RANGING:'#4a9eff',BULLISH_TREND:'#22c55e',BEARISH_TREND:'#ef4444',EXTREME:'#a855f7'};

async function load(){
  try{
    var url='/api/intelligence';
    if(rangeDays>0){var from=Date.now()-rangeDays*86400000;url+='?from='+from+'&to='+Date.now();}
    var r=await fetch(url);DATA=await r.json();
    if(DATA.error){document.getElementById('widgets').innerHTML='<div class="w full"><div class="empty">'+DATA.error+'</div></div>';return;}
    render();
  }catch(e){document.getElementById('widgets').innerHTML='<div class="w full"><div class="empty">Failed: '+e+'</div></div>';}
}

function render(){
  Object.values(CHS).forEach(function(c){try{c.destroy();}catch{}});CHS={};
  var S=DATA.summary;
  // Summary cards
  var sh='';
  sh+='<div class="s"><div class="v" style="color:#22c55e">$'+fmt(S.totalFees,0)+'</div><div class="l">Total Fees (incl. pending)</div></div>';
  sh+='<div class="s"><div class="v" style="color:#ef4444">$'+fmt(S.totalGas,2)+'</div><div class="l">Total Gas</div></div>';
  sh+='<div class="s"><div class="v" style="color:#ffd700">$'+fmt(S.totalFees-S.totalGas,0)+'</div><div class="l">Net Income</div></div>';
  sh+='<div class="s"><div class="v" style="color:#58a6ff">'+S.totalPositions+'</div><div class="l">Positions</div></div>';
  sh+='<div class="s"><div class="v" style="color:#c9d1d9">'+S.avgDuration+'m</div><div class="l">Avg Duration</div></div>';
  document.getElementById('summary').innerHTML=sh;

  var h='';
  // W0: Daily Fees Intelligence
  h+=renderFeesIntelligence();
  // W1: Fee Income
  h+='<div class="w"><h3>Fee Income</h3><canvas id="c1"></canvas></div>';
  // W2: Position P&L Table
  h+='<div class="w full"><h3>Position P&L</h3><div class="tbl-wrap" id="w2"></div></div>';
  // W3: APR Trend (placeholder — needs multi-day data)
  // W4: Fee vs Gas
  h+='<div class="w"><h3>Fee vs Gas (Daily)</h3><canvas id="c4"></canvas></div>';
  // W5: Exit Reason Breakdown
  h+='<div class="w"><h3>Exit Reason Breakdown</h3><canvas id="c5"></canvas></div>';
  // W6: Position Duration
  h+='<div class="w"><h3>Position Duration Distribution</h3><canvas id="c6"></canvas></div>';
  // W7: Performance by Regime
  h+='<div class="w"><h3>Performance by Regime</h3><canvas id="c7"></canvas></div>';
  // W8: Regime Timeline
  h+='<div class="w full"><h3>Regime Timeline</h3><canvas id="c8"></canvas></div>';
  // W10: Cost Basis vs Price
  h+='<div class="w full"><h3>Cost Basis vs SOL Price</h3><canvas id="c10"></canvas></div>';
  // W11: Churn Rate
  h+='<div class="w"><h3>Churn Rate (Positions/Day)</h3><canvas id="c11"></canvas></div>';
  // W12: Gate Fire Rate
  h+='<div class="w"><h3>Gate Block Rate</h3><canvas id="c12"></canvas></div>';

  // W13: SOL Conversion Monitor
  var sc=DATA.solConversion;
  if(sc){
    var stCol=sc.status==='FIRING'?'#22c55e':sc.status==='COOLDOWN'?'#eab308':sc.status==='BLOCKED'?'#ef4444':'#484f58';
    var scH='<div class="w full"><h3>SOL Conversion Monitor <span class="badge" style="background:'+stCol+'20;color:'+stCol+';margin-left:8px">'+sc.status+'</span></h3>';
    // Status row
    scH+='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;font-size:11px">';
    var cdText=sc.cooldownRemainingMs>0?Math.floor(sc.cooldownRemainingMs/60000)+':'+String(Math.floor((sc.cooldownRemainingMs%60000)/1000)).padStart(2,'0'):'Ready';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Next fire</span><br><span id="sc-cd" style="color:'+(sc.cooldownRemainingMs>0?'#eab308':'#22c55e')+';font-weight:bold;font-size:14px">'+cdText+'</span></div>';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Cooldown</span><br><span style="color:#c9d1d9;font-weight:bold">'+sc.cooldownTotalMin+'min <span style="color:#8b949e;font-size:10px">('+DATA.regimeHistory?.[0]?.regime?.replace('_TREND','') || 'RANGING'+')</span></span></div>';
    scH+='<div style="padding:6px;border:1px solid #21262d;border-radius:4px;text-align:center"><span style="color:#8b949e">Threshold</span><br><span style="color:#c9d1d9;font-weight:bold">$'+sc.threshold.toFixed(2)+'</span> <span style="color:'+(sc.priceAboveThreshold?'#22c55e':'#ef4444')+';font-size:10px">'+(sc.priceAboveThreshold?'\\u2713':'\\u2717')+'</span></div>';
    scH+='</div>';
    // Conditions
    scH+='<div style="font-size:10px;color:#8b949e;margin-bottom:10px">Cap: $'+sc.dynamicCap+' · Idle SOL: $'+sc.idleSolValue+'</div>';
    // Today
    scH+='<div class="m-stack" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">';
    scH+='<div class="s"><div class="v" style="color:#a855f7;font-size:16px">'+sc.todayCount+'</div><div class="l">Today</div></div>';
    scH+='<div class="s"><div class="v" style="color:#c9d1d9;font-size:16px">'+sc.todaySol.toFixed(1)+' SOL</div><div class="l">Converted</div></div>';
    scH+='<div class="s"><div class="v" style="color:#22c55e;font-size:16px">$'+sc.todayUsdc.toFixed(0)+'</div><div class="l">Received</div></div>';
    scH+='</div>';
    // Week summary
    if(sc.weekCount>0){
      var avgP=sc.weekSol>0?(sc.weekUsdc/sc.weekSol):0;
      scH+='<div style="font-size:10px;color:#8b949e;margin-bottom:10px">Week: '+sc.weekCount+' conversions · '+sc.weekSol.toFixed(1)+' SOL → $'+sc.weekUsdc.toFixed(0)+' USDC · avg $'+avgP.toFixed(2)+'/SOL</div>';
    }
    // Last conversion
    if(sc.last){
      var ago=Math.round((Date.now()-sc.last.ts)/60000);
      var agoStr=ago<60?ago+'min ago':(ago/60).toFixed(1)+'h ago';
      var txLink=sc.last.tx?'<a href="https://solscan.io/tx/'+sc.last.tx+'" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:10px">'+sc.last.tx.slice(0,8)+'</a>':'';
      scH+='<div style="font-size:11px;color:#c9d1d9;margin-bottom:8px">Last: <b>'+agoStr+'</b> — '+sc.last.sol.toFixed(3)+' SOL → $'+sc.last.usdc.toFixed(2)+' @ $'+sc.last.price.toFixed(2)+' '+txLink+'</div>';
    }
    // Recent table
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

  // Header metrics - 4 cards
  s+='<div class="fees-cards">';
  s+='<div class="fees-card" style="border-color:'+todayCol+'30"><div class="fees-card-val" style="color:'+todayCol+'">$'+fmt(d.feesTodayTotal)+'</div><div class="fees-card-sub">'+fmt(d.feesPending,3)+' pending</div><div class="fees-card-label">Today so far</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.feesYesterday)+'</div><div class="fees-card-sub">full day</div><div class="fees-card-label">Yesterday</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.fees7dAvgSameTime)+'</div><div class="fees-card-sub">at '+d.hoursElapsed+'h elapsed</div><div class="fees-card-label">7D avg (same time)</div></div>';
  s+='<div class="fees-card"><div class="fees-card-val">$'+fmt(d.feesExpectedToday)+'</div><div class="fees-card-sub" style="color:'+confCol+'">'+d.confidence+' confidence</div><div class="fees-card-label">Expected today</div></div>';
  s+='</div>';

  // Progress bar
  s+='<div style="margin:10px 0">';
  s+='<div style="display:flex;justify-content:space-between;font-size:10px;color:#8b949e;margin-bottom:3px"><span>Today: $'+fmt(d.feesTodayTotal)+' of expected $'+fmt(d.feesExpectedToday)+'</span><span>'+fmt(progressPct,0)+'%</span></div>';
  s+='<div style="background:#21262d;border-radius:4px;height:8px;overflow:hidden"><div style="width:'+progressPct+'%;height:100%;background:'+barCol+';border-radius:4px;transition:width 0.5s"></div></div>';
  s+='</div>';

  // Comparison row
  s+='<div class="fees-compare">';
  s+='<div><span style="color:#8b949e">vs Yesterday (same time):</span> <span style="color:'+vsYCol+';font-weight:bold">'+vsYSign+fmt(d.vsYesterdaySameTime,1)+'%</span></div>';
  s+='<div><span style="color:#8b949e">vs 7D average:</span> <span style="color:'+vs7Col+';font-weight:bold">'+vs7Sign+fmt(d.vs7dAvg,1)+'%</span></div>';
  s+='<div><span style="color:#8b949e">Run rate:</span> <span style="color:#c9d1d9;font-weight:bold">$'+fmt(d.currentRunRate)+'/hr</span> <span style="color:#484f58">('+d.hoursElapsed+'h)</span></div>';
  s+='<div><span style="color:#8b949e">Pending fees:</span> <span style="color:#eab308;font-weight:bold">$'+fmt(d.feesPending)+'</span></div>';
  s+='</div>';

  // Hourly chart
  s+='<div style="margin-top:12px"><canvas id="cFees" style="width:100%;max-height:220px"></canvas></div>';

  // Bottom row
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

load();
loadFeesData();
setInterval(loadFeesData,300000); // refresh every 5 min
var scCdStart=0,scCdTotal=0;
function updateScCd(){var el=document.getElementById('sc-cd');if(!el)return;var rem=Math.max(0,scCdTotal-(Date.now()-scCdStart));if(rem<=0){el.textContent='Ready';el.style.color='#22c55e';}else{var m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);el.textContent=m+':'+String(s).padStart(2,'0');}}
setInterval(updateScCd,1000);
var _origRender=render;render=function(){_origRender();if(DATA&&DATA.solConversion){scCdStart=Date.now();scCdTotal=DATA.solConversion.cooldownRemainingMs||0;}};
</script>
</body></html>`;
}
