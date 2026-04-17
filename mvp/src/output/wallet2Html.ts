// wallet2Html.ts — New dashboard design (v2)
// Static mockup for design validation. Live data wiring next.

export function renderWallet2Html(
  live: any,
  uptime: number,
  _allEvents: any[]
): string {
  const price = live?.solPrice?.toFixed(2) ?? '87.48'
  const regime = live?.regime ?? 'EXTREME'
  const state = live?.state ?? 'ACTIVE'
  const portfolioTotal = live?.totalValueUsdc?.toFixed(2) ?? '17,109.42'
  const walletValue = ((live?.walletSol ?? 95.69) * (live?.solPrice ?? 87.48) + (live?.walletUsdc ?? 3320.50)).toFixed(2)
  const positionValue = live?.positionValueUsdc?.toFixed(2) ?? '2,657.97'
  const walletSol = live?.walletSol?.toFixed(4) ?? '95.6922'
  const walletUsdc = live?.walletUsdc?.toFixed(2) ?? '3,320.50'
  const pendingFees = live?.pendingFeesTotal?.toFixed(2) ?? '0.86'
  const harvFeesSol = live?.cumFeesSol?.toFixed(6) ?? '3.142468'
  const harvFeesUsdc = live?.cumFeesUsdc?.toFixed(4) ?? '276.4736'
  const harvFeesTotal = ((live?.cumFeesSol ?? 3.142468) * (live?.solPrice ?? 87.48) + (live?.cumFeesUsdc ?? 276.47)).toFixed(2)
  const netPnl = live?.netPnl?.toFixed(2) ?? '544.92'
  const realizedIl = live?.realizedIl?.toFixed(4) ?? '-4.2937'
  const gasUsdc = live?.gasUsdc?.toFixed(4) ?? '-2.2515'
  const basis = live?.costBasis?.toFixed(2) ?? '87.57'
  const reserve = live?.usdcReserve?.toFixed(2) ?? '3,082.79'
  const reserveFloor = live?.usdcReserveFloor?.toFixed(2) ?? '3,082.79'
  const reserveAbove = ((live?.walletUsdc ?? 3320.50) - (live?.usdcReserveFloor ?? 3082.79)).toFixed(0)
  const posOpen = live?.positionOpen ?? true
  const entryPrice = live?.entryPrice?.toFixed(2) ?? '87.66'
  const priceLower = live?.priceLower?.toFixed(2) ?? '86.65'
  const priceUpper = live?.priceUpper?.toFixed(2) ?? '88.90'
  const exitDown = live?.exitDown?.toFixed(2) ?? '87.16'
  const exitUp = live?.exitUp?.toFixed(2) ?? '88.69'
  const rangeWidth = live?.rangeWidthPct?.toFixed(2) ?? '2.56'
  const feesToday = live?.feesToday?.toFixed(4) ?? '16.8944'
  const aprToday = live?.aprToday?.toFixed(1) ?? '113.7'
  const idleCapital = live?.idleCapital?.toFixed(2) ?? '11,695.41'
  const confidence = live?.confidence ?? 'MEDIUM'
  const rsi = live?.rsi?.toFixed(0) ?? '18'
  const bbWidth = live?.bbWidth?.toFixed(1) ?? '3.2'
  const regimeColor = regime === 'EXTREME' ? '#ff6b35'
    : regime === 'BEARISH_TREND' ? '#f04060'
    : regime === 'BULLISH_TREND' ? '#22d47a'
    : '#38bdf8'
  const regimeBg = regime === 'EXTREME' ? '#3d1a08'
    : regime === 'BEARISH_TREND' ? '#4d1020'
    : regime === 'BULLISH_TREND' ? '#16532e'
    : '#0c2d40'
  const pricePct = posOpen ? Math.min(100, Math.max(0,
    ((parseFloat(price) - parseFloat(priceLower)) /
     (parseFloat(priceUpper) - parseFloat(priceLower))) * 100
  )).toFixed(1) : '50'
  const priceAboveBasis = parseFloat(price) >= parseFloat(basis)
  const deployedPct = posOpen
    ? ((parseFloat(positionValue) / parseFloat(portfolioTotal.replace(',',''))) * 100).toFixed(0)
    : '0'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP — Live Wallet v2</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#090c10;--surface:#0e1318;--surface2:#131920;--border:#1e2830;--border2:#273040;--text:#e2e8f0;--muted:#64748b;--muted2:#4a5568;--green:#22d47a;--green-dim:#16532e;--red:#f04060;--red-dim:#4d1020;--amber:#f5a623;--amber-dim:#4a2e06;--blue:#38bdf8;--blue-dim:#0c2d40;--purple:#a78bfa;--purple-dim:#2d1f52;--extreme:#ff6b35;--extreme-dim:#3d1a08;--mono:'IBM Plex Mono',monospace;--sans:'Syne',sans-serif;--r:10px;--r-sm:6px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;line-height:1.5;min-height:100vh;-webkit-font-smoothing:antialiased}
.nav{position:sticky;top:0;z-index:100;background:rgba(9,12,16,0.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:52px}
.nav-brand{font-family:var(--sans);font-weight:800;font-size:15px;letter-spacing:-0.02em;color:var(--text);display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.6;transform:scale(0.85)}}
.nav-regime{font-size:10px;font-weight:600;letter-spacing:0.08em;padding:3px 8px;border-radius:4px;border:1px solid}
.nav-uptime{font-size:11px;color:var(--muted)}
.tabs{display:flex;gap:2px;padding:10px 16px 0;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--border);background:var(--bg)}
.tabs::-webkit-scrollbar{display:none}
.tab{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:0.05em;color:var(--muted);padding:6px 14px 8px;border-radius:6px 6px 0 0;white-space:nowrap;cursor:pointer;border:1px solid transparent;border-bottom:none;position:relative;bottom:-1px;text-decoration:none;display:block}
.tab.active{color:var(--text);background:var(--surface);border-color:var(--border);border-bottom-color:var(--surface)}
.tab:hover:not(.active){color:var(--text)}
.page{padding:16px;max-width:480px;margin:0 auto}
.hero{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px;margin-bottom:12px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:radial-gradient(circle,rgba(34,212,122,0.06) 0%,transparent 70%);pointer-events:none}
.hero-label{font-size:10px;font-weight:600;letter-spacing:0.12em;color:var(--muted);margin-bottom:6px;text-transform:uppercase}
.hero-value{font-family:var(--sans);font-size:36px;font-weight:800;letter-spacing:-0.03em;line-height:1;margin-bottom:16px}
.alloc-bar{height:6px;border-radius:3px;background:var(--border2);overflow:hidden;margin-bottom:10px}
.alloc-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--green) 0%,#16a34a 100%)}
.hero-split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hs-label{font-size:10px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.06em}
.hs-value{font-size:15px;font-weight:500}
.hs-sub{font-size:10px;color:var(--muted);margin-top:1px}
.status-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.status-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px;text-align:center}
.sc-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px}
.sc-value{font-size:12px;font-weight:600}
.section{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin-bottom:12px;overflow:hidden}
.sh{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}
.st{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted)}
.badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px}
.bg{background:var(--green-dim);color:var(--green)}
.br{background:var(--red-dim);color:var(--red)}
.ba{background:var(--amber-dim);color:var(--amber)}
.bb{background:var(--blue-dim);color:var(--blue)}
.be{background:var(--extreme-dim);color:var(--extreme);border:1px solid rgba(255,107,53,0.3)}
.sb{padding:14px 16px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:5px 0}
.kv+.kv{border-top:1px solid rgba(30,40,48,0.5)}
.kk{color:var(--muted);font-size:11px}
.kv-v{font-size:12px;font-weight:500;text-align:right}
.green{color:var(--green)}.red{color:var(--red)}.amber{color:var(--amber)}.blue{color:var(--blue)}.muted{color:var(--muted)}.extreme-c{color:var(--extreme)}
.range-visual{padding:16px;background:var(--surface2);border-radius:var(--r-sm);margin:14px 0}
.range-labels{display:flex;justify-content:space-between;margin-bottom:8px;font-size:10px;color:var(--muted)}
.range-track{height:28px;background:var(--border);border-radius:6px;position:relative;margin-bottom:8px}
.range-fill{position:absolute;top:0;bottom:0;left:0;right:0;background:linear-gradient(90deg,rgba(240,64,96,0.15) 0%,rgba(34,212,122,0.12) 40%,rgba(34,212,122,0.12) 70%,rgba(240,64,96,0.15) 100%);border-radius:6px}
.range-price-line{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--amber);border-radius:2px;box-shadow:0 0 8px var(--amber)}
.range-price-label{position:absolute;top:-22px;transform:translateX(-50%);font-size:10px;font-weight:600;color:var(--amber);white-space:nowrap;background:var(--surface);padding:1px 5px;border-radius:3px;border:1px solid var(--amber-dim)}
.range-exit-down{position:absolute;top:0;bottom:0;left:0;width:18%;background:rgba(240,64,96,0.18);border-radius:6px 0 0 6px;border-right:1.5px dashed rgba(240,64,96,0.4)}
.range-exit-up{position:absolute;top:0;bottom:0;right:0;width:15%;background:rgba(34,212,122,0.12);border-radius:0 6px 6px 0;border-left:1.5px dashed rgba(34,212,122,0.35)}
.range-trigger-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--muted)}
.fee-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.fee-card{background:var(--surface2);border-radius:var(--r-sm);padding:12px;border:1px solid var(--border)}
.fc-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px}
.fc-value{font-family:var(--sans);font-size:20px;font-weight:700;letter-spacing:-0.02em;line-height:1;margin-bottom:2px}
.fc-sub{font-size:10px;color:var(--muted)}
.pnl-banner{background:linear-gradient(135deg,rgba(34,212,122,0.08) 0%,rgba(34,212,122,0.04) 100%);border:1px solid rgba(34,212,122,0.2);border-radius:var(--r-sm);padding:14px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.pnl-value{font-family:var(--sans);font-size:28px;font-weight:800;letter-spacing:-0.03em;color:var(--green);line-height:1}
.pnl-break{font-size:10px;color:var(--muted);margin-top:2px}
.pnl-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em}
.signal-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.signal-row{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border)}
.sn{font-size:11px;color:var(--muted);min-width:80px}
.sv{font-size:11px;font-weight:500;flex:1;text-align:center}
.vote{font-size:9px;font-weight:700;letter-spacing:0.06em;padding:2px 7px;border-radius:3px;min-width:64px;text-align:center}
.v-bear{background:var(--red-dim);color:var(--red)}
.v-ext{background:var(--extreme-dim);color:var(--extreme)}
.v-norm{background:var(--border);color:var(--muted)}
.v-mod{background:var(--border);color:var(--blue)}
.vote-bars{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px}
.vb-label{font-size:9px;color:var(--muted);text-align:center;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em}
.vb-track{height:32px;background:var(--border);border-radius:4px;overflow:hidden;position:relative}
.vb-fill{position:absolute;bottom:0;left:0;right:0;border-radius:4px}
.vb-count{text-align:center;font-size:12px;font-weight:700;margin-top:3px}
.f-bull{background:var(--green)}.f-range{background:var(--blue)}.f-bear{background:var(--red)}.f-ext{background:var(--extreme)}
.basis-compare{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.bc-item{background:var(--surface2);border-radius:var(--r-sm);padding:12px;border:1px solid var(--border);text-align:center}
.bc-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px}
.bc-value{font-family:var(--sans);font-size:22px;font-weight:800;letter-spacing:-0.02em}
.basis-warn{background:rgba(245,166,35,0.06);border:1px solid rgba(245,166,35,0.2);border-radius:var(--r-sm);padding:10px 12px;font-size:11px;color:var(--amber);display:flex;align-items:center;gap:8px;margin-bottom:12px}
.res-bar-track{height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin:10px 0 6px}
.res-bar-fill{height:100%;background:linear-gradient(90deg,var(--green) 0%,#16a34a 100%);border-radius:4px}
.res-meta{display:flex;justify-content:space-between;font-size:10px;color:var(--muted)}
.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:14px 16px;border-top:1px solid var(--border)}
.action-btn{padding:10px 14px;border-radius:var(--r-sm);font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:0.04em;cursor:pointer;border:1px solid;text-align:center}
.btn-h{background:var(--green-dim);color:var(--green);border-color:rgba(34,212,122,0.25)}
.btn-c{background:var(--red-dim);color:var(--red);border-color:rgba(240,64,96,0.25)}
.btn-p{background:var(--amber-dim);color:var(--amber);border-color:rgba(245,166,35,0.25)}
.btn-l{background:var(--purple-dim);color:#a78bfa;border-color:rgba(167,139,250,0.25)}
.alert-strip{background:var(--extreme-dim);border:1px solid rgba(255,107,53,0.3);border-radius:var(--r-sm);padding:10px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px}
.alert-text{font-size:11px;color:rgba(255,180,140,0.9);line-height:1.5}
.trigger-list{display:flex;flex-direction:column;gap:8px}
.trigger-item{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border)}
.ti-arrow{font-size:14px;width:16px;flex-shrink:0}
.ti-label{font-size:11px;color:var(--muted);flex:1}
.ti-price{font-size:13px;font-weight:600}
.ti-dist{font-size:10px;color:var(--muted)}
.divider{height:1px;background:var(--border);margin:12px 0}
.note{display:inline-block;background:rgba(99,110,123,0.15);border:1px solid var(--border2);border-radius:3px;padding:1px 6px;font-size:9px;color:var(--muted);margin-left:4px}
.swap-list{display:flex;flex-direction:column}
.swap-item{display:grid;grid-template-columns:44px 52px 1fr 52px 36px;align-items:center;padding:8px 0;font-size:11px;gap:4px}
.swap-item+.swap-item{border-top:1px solid var(--border)}
.swap-time{color:var(--muted);font-size:10px}
.swap-dir{font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;text-align:center;letter-spacing:0.04em}
.d-buy{background:var(--blue-dim);color:var(--blue)}
.d-sell{background:var(--red-dim);color:var(--red)}
.d-harv{background:var(--green-dim);color:var(--green)}
.swap-price{color:var(--muted);text-align:right;font-size:10px}
.swap-pnl{text-align:right;font-weight:600;font-size:10px}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-brand"><div class="dot"></div>SOL/USDC LP</div>
  <div style="display:flex;align-items:center;gap:12px">
    <span class="nav-regime" style="background:${regimeBg};color:${regimeColor};border-color:${regimeColor}">${regime.replace('_TREND','')}</span>
    <span class="nav-uptime">${uptime}m</span>
  </div>
</nav>
<div class="tabs">
  <a href="/live" class="tab">Wallet</a>
  <a href="/wallet2" class="tab active">Wallet v2</a>
  <a href="/intelligence" class="tab">Intelligence</a>
  <a href="/insights" class="tab">Insights</a>
  <a href="/strategy" class="tab">Strategy</a>
  <a href="/config" class="tab">Config</a>
  <a href="/projection" class="tab">Projection</a>
</div>
<div class="page">

${regime === 'EXTREME' ? `
<div class="alert-strip">
  <div style="font-size:14px;flex-shrink:0;margin-top:1px">⚠</div>
  <div class="alert-text"><strong style="color:var(--extreme)">EXTREME regime</strong> — BB width ${bbWidth}%, RSI ${rsi}. Deploy capped at 25%. Capital held in reserve.</div>
</div>` : ''}

<div class="hero">
  <div class="hero-label">Total Portfolio</div>
  <div class="hero-value" style="color:var(--text)">$<span style="color:var(--green)">${portfolioTotal}</span></div>
  <div class="alloc-bar"><div class="alloc-fill" style="width:${deployedPct}%"></div></div>
  <div class="hero-split">
    <div>
      <div class="hs-label">In Position</div>
      <div class="hs-value green">$${positionValue}</div>
      <div class="hs-sub">${deployedPct}% deployed</div>
    </div>
    <div>
      <div class="hs-label">Wallet Idle</div>
      <div class="hs-value amber">$${walletValue}</div>
      <div class="hs-sub">${walletSol} SOL + $${walletUsdc} USDC</div>
    </div>
  </div>
</div>

<div class="status-row">
  <div class="status-card"><div class="sc-label">Bot</div><div class="sc-value green">${state}</div></div>
  <div class="status-card"><div class="sc-label">Prox Exit</div><div class="sc-value green">ACTIVE</div></div>
  <div class="status-card"><div class="sc-label">Deploy</div><div class="sc-value blue">ON</div></div>
</div>

<div class="section">
  <div class="sh"><div class="st">Position</div><div class="badge ${posOpen ? 'bg' : 'br'}">${posOpen ? 'OPEN' : 'CLOSED'}</div></div>
  <div class="sb">
    <div class="range-visual">
      <div class="range-labels"><span class="red">$${priceLower} ↓</span><span style="color:var(--muted)">centre $${((parseFloat(priceLower)+parseFloat(priceUpper))/2).toFixed(2)}</span><span class="green">$${priceUpper} ↑</span></div>
      <div class="range-track">
        <div class="range-fill"></div>
        <div class="range-exit-down"></div>
        <div class="range-exit-up"></div>
        <div class="range-price-label" style="left:${pricePct}%">$${price}</div>
        <div class="range-price-line" style="left:${pricePct}%"></div>
      </div>
      <div class="range-trigger-labels"><span class="red">↓ Exit $${exitDown}</span><span class="green">↑ Exit $${exitUp}</span></div>
    </div>
    <div class="kv"><span class="kk">Entry</span><span class="kv-v">$${entryPrice}</span></div>
    <div class="kv"><span class="kk">Range Width</span><span class="kv-v">${rangeWidth}%</span></div>
    <div class="kv"><span class="kk">Opened as</span><span class="kv-v" style="color:${regimeColor}">${regime}</span></div>
    <div class="kv"><span class="kk">In Range</span><span class="kv-v green">YES</span></div>
    <div class="divider"></div>
    <div class="trigger-list">
      <div class="trigger-item"><div class="ti-arrow red">↓</div><div class="ti-label">Down exit</div><div><div class="ti-price red">$${exitDown}</div></div></div>
      <div class="trigger-item"><div class="ti-arrow green">↑</div><div class="ti-label">Up exit</div><div><div class="ti-price green">$${exitUp}</div></div></div>
      <div class="trigger-item"><div class="ti-arrow blue">⊕</div><div class="ti-label">Auto-deploy <span class="note">ACTIVE</span></div><div><div class="ti-price blue">$${price}</div></div></div>
      <div class="trigger-item"><div class="ti-arrow" style="color:var(--purple)">⇄</div><div class="ti-label">SOL convert</div><div><div class="ti-price" style="color:var(--purple)">+$0.33 away</div></div></div>
    </div>
  </div>
  <div class="action-grid">
    <div class="action-btn btn-h">Harvest Fees</div>
    <div class="action-btn btn-c">Close Position</div>
    <div class="action-btn btn-p">Pause Bot</div>
    <div class="action-btn btn-l">Add Liquidity</div>
  </div>
</div>

<div class="section">
  <div class="sh"><div class="st">Fees & P&L</div><div class="badge bg">+$${netPnl} net</div></div>
  <div class="sb">
    <div class="pnl-banner">
      <div>
        <div class="pnl-label">Net P&L All Time</div>
        <div class="pnl-value">+$${netPnl}</div>
        <div class="pnl-break">$${harvFeesTotal} fees − $${Math.abs(parseFloat(realizedIl)).toFixed(2)} IL − $${Math.abs(parseFloat(gasUsdc)).toFixed(2)} gas</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px">PROFITABLE</div>
        <div style="font-size:24px;font-family:var(--sans);font-weight:800;color:var(--green)">99%</div>
        <div style="font-size:9px;color:var(--muted)">fee coverage</div>
      </div>
    </div>
    <div class="fee-grid">
      <div class="fee-card"><div class="fc-label">Pending</div><div class="fc-value green">$${pendingFees}</div><div class="fc-sub">in position now</div></div>
      <div class="fee-card"><div class="fc-label">Harvested</div><div class="fc-value green">$${harvFeesTotal}</div><div class="fc-sub">${harvFeesSol} SOL + $${harvFeesUsdc} USDC</div></div>
      <div class="fee-card"><div class="fc-label">Realized IL</div><div class="fc-value red">−$${Math.abs(parseFloat(realizedIl)).toFixed(2)}</div><div class="fc-sub">from closed positions</div></div>
      <div class="fee-card"><div class="fc-label">Gas</div><div class="fc-value red">−$${Math.abs(parseFloat(gasUsdc)).toFixed(2)}</div><div class="fc-sub">on-chain fees</div></div>
    </div>
    <div class="kv"><span class="kk">Fees Today</span><span class="kv-v green">$${feesToday}</span></div>
    <div class="kv"><span class="kk">Today's APR</span><span class="kv-v amber">${aprToday}%</span></div>
    <div class="kv"><span class="kk">Idle Capital</span><span class="kv-v amber">$${idleCapital}</span></div>
  </div>
</div>

<div class="section">
  <div class="sh"><div class="st">Regime Intelligence</div><div class="badge be">${regime.replace('_TREND','')} · ${confidence}</div></div>
  <div class="sb">
    <div class="vote-bars">
      <div><div class="vb-label">Bull</div><div class="vb-track"><div class="vb-fill f-bull" style="height:0%"></div></div><div class="vb-count muted">0</div></div>
      <div><div class="vb-label">Range</div><div class="vb-track"><div class="vb-fill f-range" style="height:14%"></div></div><div class="vb-count blue">1</div></div>
      <div><div class="vb-label">Bear</div><div class="vb-track"><div class="vb-fill f-bear" style="height:29%"></div></div><div class="vb-count red">2</div></div>
      <div><div class="vb-label">Ext</div><div class="vb-track"><div class="vb-fill f-ext" style="height:43%"></div></div><div class="vb-count extreme-c">3</div></div>
    </div>
    <div class="signal-grid">
      <div class="signal-row"><span class="sn">EMA Cross</span><span class="sv muted">DOWN −0.7%</span><span class="vote v-bear">BEARISH</span></div>
      <div class="signal-row"><span class="sn">BB Width</span><span class="sv extreme-c">${bbWidth}%</span><span class="vote v-ext">EXTREME</span></div>
      <div class="signal-row"><span class="sn">RSI(14)</span><span class="sv red">${rsi}</span><span class="vote v-bear">BEARISH</span></div>
      <div class="signal-row"><span class="sn">ATR(14)</span><span class="sv muted">$0.28</span><span class="vote v-norm">normal</span></div>
      <div class="signal-row"><span class="sn">BB Position</span><span class="sv muted">0.27</span><span class="vote v-mod">modifier</span></div>
    </div>
    <div class="divider"></div>
    <div class="kv"><span class="kk">Confidence</span><span class="kv-v amber">${confidence}</span></div>
    <div class="kv"><span class="kk">L1 Veto</span><span class="kv-v green">CLEAR</span></div>
  </div>
</div>

<div class="section">
  <div class="sh"><div class="st">Cost Basis</div><div class="badge ${priceAboveBasis ? 'bg' : 'br'}">${priceAboveBasis ? 'ABOVE BASIS' : 'BELOW BASIS'}</div></div>
  <div class="sb">
    <div class="basis-compare">
      <div class="bc-item"><div class="bc-label">Basis</div><div class="bc-value amber">$${basis}</div></div>
      <div class="bc-item"><div class="bc-label">Price</div><div class="bc-value ${priceAboveBasis ? 'green' : 'red'}">$${price}</div></div>
    </div>
    ${!priceAboveBasis ? `<div class="basis-warn">⚠ Price $${(parseFloat(basis)-parseFloat(price)).toFixed(2)} below basis. SolConvert gated.</div>` : ''}
    <div class="kv"><span class="kk">Wallet SOL</span><span class="kv-v">${walletSol}</span></div>
    <div class="kv"><span class="kk">Total Held</span><span class="kv-v">${(parseFloat(walletSol)+33.13).toFixed(2)} SOL</span></div>
  </div>
</div>

<div class="section">
  <div class="sh"><div class="st">Reserve Monitor</div><div class="badge bg">FULL</div></div>
  <div class="sb">
    <div class="kv"><span class="kk">Reserve</span><span class="kv-v green">$${reserve}</span></div>
    <div class="kv"><span class="kk">Floor</span><span class="kv-v muted">$${reserveFloor}</span></div>
    <div class="res-bar-track"><div class="res-bar-fill" style="width:100%"></div></div>
    <div class="res-meta"><span class="green">100% funded</span><span>FULL</span></div>
    <div class="kv" style="margin-top:8px"><span class="kk">Above floor</span><span class="kv-v green">+$${reserveAbove}</span></div>
  </div>
</div>

<div style="height:24px"></div>
</div>
</body>
</html>`
}
