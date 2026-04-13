const Database = require('better-sqlite3');
const db = new Database('./data/mvp.db');
require('dotenv/config');

const now = Date.now();
const state = db.prepare('SELECT * FROM bot_state WHERE id=1').get();
const snap = db.prepare('SELECT * FROM live_snapshots ORDER BY timestamp DESC LIMIT 1').get();
const prevSnap = db.prepare('SELECT * FROM live_snapshots WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(now - 600000);
const inRange1h = (() => { const r = db.prepare('SELECT COUNT(*) as t, SUM(CASE WHEN in_range=1 THEN 1 ELSE 0 END) as ir FROM live_snapshots WHERE timestamp > ?').get(now - 3600000); return r.t > 0 ? (r.ir/r.t*100) : 0; })();
const inRange24h = (() => { const r = db.prepare('SELECT COUNT(*) as t, SUM(CASE WHEN in_range=1 THEN 1 ELSE 0 END) as ir FROM live_snapshots WHERE timestamp > ?').get(now - 86400000); return r.t > 0 ? (r.ir/r.t*100) : 0; })();
const events = db.prepare('SELECT * FROM rebalance_events WHERE timestamp > ? ORDER BY timestamp DESC').all(now - 3600000);
const lastRegimeEval = db.prepare("SELECT params_json FROM decision_log WHERE decision IN ('REGIME_EVAL','REGIME_CHANGE') AND params_json IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get();

let pos = null;
try { if (state.position_json && state.position_json !== 'null') pos = JSON.parse(state.position_json); } catch {}

const fmt = (n,d=2) => n.toFixed(d);
const sgn = (n) => n >= 0 ? '+' : '';
const lines = [];

const icon = !snap ? '🔴' : state.state === 'HALTED' ? '🔴' : !pos ? '🟡' : '🟢';
lines.push(icon + ' <b>LP Bot</b> | ' + state.state + ' | ' + state.regime);
lines.push('');

if (snap) {
  const chg = prevSnap ? (snap.total_with_position - prevSnap.total_with_position) : 0;
  lines.push('<b>SOL</b> $' + fmt(snap.price) + ' (' + sgn(chg) + '$' + fmt(Math.abs(chg)) + ' 10m)');
  lines.push('<b>Total</b> $' + fmt(snap.total_with_position) + ' | Pos $' + fmt(snap.position_value) + ' | Wallet $' + fmt(snap.total_value_usdc));
  lines.push('');
}

if (pos && snap) {
  const lower = pos.priceLower, upper = pos.priceUpper;
  const centre = (lower+upper)/2, hw = (upper-lower)/2;
  const pd = hw>0?Math.max(0,(centre-snap.price)/hw):0;
  const pu = hw>0?Math.max(0,(snap.price-centre)/hw):0;
  lines.push('<b>Range</b> $' + fmt(lower) + '-$' + fmt(upper) + ' (' + fmt((upper-lower)/centre*100,1) + '%)');
  lines.push('<b>Prox</b> ↓' + fmt(pd*100,0) + '% ↑' + fmt(pu*100,0) + '% | Dist ↓$' + fmt(snap.price-lower) + ' ↑$' + fmt(upper-snap.price));
  if (pos.entryPrice) {
    const age = pos.entryTime ? ((now-pos.entryTime)/3600000) : 0;
    lines.push('<b>Entry</b> $' + fmt(pos.entryPrice) + ' (' + sgn(snap.price-pos.entryPrice) + fmt(Math.abs((snap.price-pos.entryPrice)/pos.entryPrice*100),1) + '%) | Age ' + fmt(age,1) + 'h');
  }
  if (pd > 0.5 || pu > 0.5) {
    const dir = pd > pu ? 'LOWER' : 'UPPER';
    lines.push('⚠️ <b>Drifting toward ' + dir + ' bound (' + fmt(Math.max(pd,pu)*100,0) + '%)</b>');
  }
  lines.push('');
  lines.push('<b>In-range</b> 1h: ' + fmt(inRange1h,0) + '% | 24h: ' + fmt(inRange24h,0) + '%');
  lines.push('');
}

// Fees
const pendTotal = snap ? (snap.pending_fees_sol*snap.price + snap.pending_fees_usdc) : 0;
const harvTotal = snap ? (state.cum_fees_sol*snap.price + state.cum_fees_usdc) : 0;
const totalFees = pendTotal + harvTotal;
const totalIL = (snap?.il_usdc||0) + state.realized_il;
const gasSol = state.cum_gas_lamports/1e9;
const gasUsdc = snap ? gasSol*snap.price : 0;
const net = totalFees + totalIL - gasUsdc;
lines.push('<b>Fees</b> pend $' + fmt(pendTotal) + ' | harv $' + fmt(harvTotal) + ' | total $' + fmt(totalFees));
lines.push('<b>IL</b> $' + fmt(totalIL) + ' | <b>Gas</b> $' + fmt(gasUsdc) + ' (' + state.tx_count + ' txs)');
lines.push('<b>Net</b> ' + sgn(net) + '$' + fmt(Math.abs(net)) + (net>=0?' ✅':' ❌'));
lines.push('');

// Market signals
if (lastRegimeEval?.params_json) {
  try {
    const p = JSON.parse(lastRegimeEval.params_json);
    lines.push('<b>📡 Market Signals</b>');
    if (p.vol1h != null) {
      const st = p.vol1h > 0.06 ? '🔴 HIGH' : p.vol1h > 0.04 ? '🟡' : '🟢 calm';
      lines.push('Vol 1h: ' + p.vol1h.toFixed(4) + ' ' + st + ' (EXTREME if &gt;0.06)');
    }
    if (p.vol4h != null) {
      const st = p.vol4h > 0.05 ? '🔴 HIGH' : p.vol4h > 0.035 ? '🟡' : '🟢 calm';
      lines.push('Vol 4h: ' + p.vol4h.toFixed(4) + ' ' + st + ' (EXTREME if &gt;0.05+spike)');
    }
    if (p.solDelta24h != null) {
      const st = Math.abs(p.solDelta24h) > 4 ? '🔴 strong move' : '🟢 mild';
      lines.push('SOL 24h: ' + sgn(p.solDelta24h) + p.solDelta24h.toFixed(1) + '% ' + st + ' (trend if &gt;±4%)');
    }
    if (p.btcDelta24h != null) {
      const macro = Math.abs(p.btcDelta24h) > 3 ? '⚡ macro event' : '';
      lines.push('BTC 24h: ' + sgn(p.btcDelta24h) + p.btcDelta24h.toFixed(1) + '% ' + macro + ' (macro if &gt;±3%)');
    }
    if (p.volumeRatio4h != null) {
      const st = p.volumeRatio4h > 3 ? '🔴 SPIKE' : p.volumeRatio4h > 2 ? '🟡 elevated' : '🟢 normal';
      lines.push('Vol ratio: ' + p.volumeRatio4h.toFixed(1) + 'x ' + st + ' (spike if &gt;3x)');
    } else {
      lines.push('Vol ratio: building... (needs ~1h of data)');
    }
    if (p.fearGreedIndex != null) {
      const emoji = p.fearGreedIndex < 25 ? '😨' : p.fearGreedIndex < 40 ? '😟' : p.fearGreedIndex > 75 ? '🤑' : p.fearGreedIndex > 60 ? '😊' : '😐';
      lines.push('F&amp;G: ' + p.fearGreedIndex + '/100 ' + emoji);
    }
    lines.push('');

    // Summary
    const sp = [];
    if (p.vol1h != null && p.vol4h != null) {
      if (p.vol1h > 0.06 || p.vol4h > 0.05) sp.push('High volatility — EXTREME conditions');
      else if (p.vol1h > 0.04 || p.vol4h > 0.035) sp.push('Volatility rising — watch closely');
      else sp.push('Low volatility — market quiet');
    }
    if (p.solDelta24h != null) {
      if (p.solDelta24h < -4) sp.push('SOL in strong downtrend');
      else if (p.solDelta24h < -2) sp.push('SOL drifting down');
      else if (p.solDelta24h > 4) sp.push('SOL in strong uptrend');
      else if (p.solDelta24h > 2) sp.push('SOL pushing up');
      else sp.push('SOL flat');
    }
    if (p.btcDelta24h != null && p.solDelta24h != null && Math.abs(p.btcDelta24h) > 3) {
      const same = (p.btcDelta24h > 0) === (p.solDelta24h > 0);
      sp.push(same ? 'correlated with BTC macro move' : 'diverging from BTC');
    }
    if (p.fearGreedIndex != null && p.fearGreedIndex < 25) sp.push('extreme fear in market');
    if (p.fearGreedIndex != null && p.fearGreedIndex > 75) sp.push('extreme greed in market');
    if (p.volumeRatio4h != null && p.volumeRatio4h > 3) sp.push('volume spike detected');
    if (sp.length > 0) lines.push('💬 ' + sp.join(', ') + '.');
    lines.push('');
  } catch {}
}

lines.push('<b>Regime</b> ' + state.regime);
const lastChange = db.prepare('SELECT * FROM regime_history ORDER BY timestamp DESC LIMIT 1').get();
if (lastChange) {
  const ago = ((now - lastChange.timestamp) / 3600000);
  lines.push('Last change: ' + lastChange.old_regime + ' → ' + lastChange.new_regime + ' (' + fmt(ago,1) + 'h ago)');
}
lines.push('');

const real = events.filter(e => ['POSITION_OPENED','POSITION_CLOSED','T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','FEE_HARVEST','AUTO_DEPLOY','LIQUIDITY_ADDED'].includes(e.event_type));
if (real.length > 0) {
  lines.push('<b>Events</b> (' + real.length + ' last hour)');
  real.slice(0,5).forEach(e => {
    const t = new Date(e.timestamp).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'});
    lines.push(t + ' <b>' + e.event_type + '</b> $' + fmt(e.price));
  });
} else {
  lines.push('No events last hour — holding');
}

const text = lines.join('\n');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) { console.log('Missing TELEGRAM env vars'); process.exit(1); }

fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true}),
}).then(r => r.json()).then(j => {
  if (j.ok) console.log('SENT OK');
  else console.log('FAILED:', JSON.stringify(j));
  db.close();
}).catch(e => { console.log('ERROR:', e); db.close(); });
