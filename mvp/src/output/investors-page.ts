/**
 * Investors page — track investors, shares, and returns
 */

export function renderInvestorsPageHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOL/USDC LP Bot — Investors</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;padding:12px;-webkit-text-size-adjust:100%}
.nav{display:flex;gap:5px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:7px 10px;border:1px solid #30363d;border-radius:6px;font-size:11px;text-align:center}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.header{text-align:center;margin-bottom:16px}
.header h1{font-size:18px;color:#a855f7;margin-bottom:4px}
.header .sub{color:#8b949e;font-size:11px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;text-align:center}
.card .val{font-size:20px;font-weight:bold;margin-bottom:4px}
.card .lbl{font-size:10px;color:#8b949e}
.section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.section h2{font-size:14px;color:#58a6ff;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#8b949e;padding:6px 8px;border-bottom:1px solid #30363d;font-size:11px}
td{padding:6px 8px;border-bottom:1px solid #21262d}
.add-form{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:16px}
.add-form label{font-size:11px;color:#8b949e;display:block;margin-bottom:2px}
.add-form input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:8px 10px;font-size:13px;min-height:38px}
.add-form button{background:#238636;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;min-height:38px}
.add-form button:hover{background:#2ea043}
.del-btn{background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:2px 6px}
.del-btn:hover{background:#ef444420;border-radius:4px}
#status{font-size:12px;margin-top:8px;min-height:20px}
.loading{text-align:center;padding:30px;color:#8b949e}
@media(max-width:700px){
  body{padding:8px}
  .nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  .nav a{padding:7px 3px;font-size:9px}
  .cards{grid-template-columns:1fr 1fr}
  .card .val{font-size:16px}
  .add-form{flex-direction:column}
  .add-form input,.add-form button{width:100%}
  table{font-size:11px}
  th,td{padding:4px 6px}
}
</style></head><body>

<div class="nav">
  <a href="/live">Live Wallet</a><a href="/insights">Insights</a><a href="/strategy">Strategy</a>
  <a href="/config">Config</a><a href="/status">Status</a><a href="/investors" class="active">Investors</a>
  <a href="/analytics">Analytics</a><a href="/projection">Projection</a><a href="/analysis">Agent</a><a href="/arcade">Arcade</a>
</div>

<div class="header">
  <h1>Investor Tracker</h1>
  <div class="sub">Track investors, shares, and returns · Auto-updates with portfolio value</div>
</div>

<div class="cards" id="summary-cards"><div class="loading">Loading...</div></div>

<div class="section">
  <h2>Add Investor</h2>
  <div class="add-form">
    <div><label>Name</label><input type="text" id="inv-name" placeholder="Investor name"></div>
    <div><label>Amount ($)</label><input type="number" id="inv-amount" step="0.01" placeholder="1000"></div>
    <div><label>Date</label><input type="date" id="inv-date"></div>
    <button onclick="addInvestor()">Add Investor</button>
  </div>
  <div id="status"></div>
</div>

<div class="section">
  <h2>Investors</h2>
  <div id="investors-table"><div class="loading">Loading...</div></div>
</div>

<script>
var fmt = function(n, d) { return n != null ? Number(n).toFixed(d || 2) : '0.00'; };

// Default date to today
document.getElementById('inv-date').value = new Date().toLocaleDateString('en-CA');

function addInvestor() {
  var name = document.getElementById('inv-name').value.trim();
  var amount = document.getElementById('inv-amount').value;
  var date = document.getElementById('inv-date').value;
  var status = document.getElementById('status');
  if (!name || !amount || !date) { status.textContent = 'Fill all fields'; status.style.color = '#ef4444'; return; }
  status.textContent = 'Adding...'; status.style.color = '#eab308';
  fetch('/api/investors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, amount: amount, date: date })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.success) {
      status.textContent = 'Added!'; status.style.color = '#22c55e';
      document.getElementById('inv-name').value = '';
      document.getElementById('inv-amount').value = '';
      loadData();
    } else {
      status.textContent = 'Error: ' + (d.error || 'unknown'); status.style.color = '#ef4444';
    }
  }).catch(function(e) { status.textContent = 'Error: ' + e; status.style.color = '#ef4444'; });
}

function deleteInvestor(id, name) {
  if (!confirm('Remove investor ' + name + '?')) return;
  fetch('/api/investors/' + id, { method: 'DELETE' }).then(function() { loadData(); });
}

function loadData() {
  fetch('/api/investors').then(function(r) { return r.json(); }).then(function(data) {
    var investors = data.investors || [];
    var totalInvested = data.totalInvested || 0;
    var totalPortfolio = data.totalPortfolio || 0;
    var totalFees = data.totalFees || 0;

    // Summary cards
    var cardsHtml = '';
    cardsHtml += '<div class="card"><div class="val" style="color:#a855f7">' + investors.length + '</div><div class="lbl">Investors</div></div>';
    cardsHtml += '<div class="card"><div class="val" style="color:#58a6ff">$' + fmt(totalInvested, 0) + '</div><div class="lbl">Total Invested</div></div>';
    cardsHtml += '<div class="card"><div class="val" style="color:#22c55e">$' + fmt(totalPortfolio, 0) + '</div><div class="lbl">Portfolio Value</div></div>';
    cardsHtml += '<div class="card"><div class="val" style="color:#ffd700">$' + fmt(totalFees, 2) + '</div><div class="lbl">Total Fees Earned</div></div>';
    var totalReturn = totalPortfolio - totalInvested;
    var trCol = totalReturn >= 0 ? '#22c55e' : '#ef4444';
    cardsHtml += '<div class="card"><div class="val" style="color:' + trCol + '">' + (totalReturn >= 0 ? '+' : '-') + '$' + fmt(Math.abs(totalReturn), 2) + '</div><div class="lbl">Total Return</div></div>';
    document.getElementById('summary-cards').innerHTML = cardsHtml;

    // Table
    if (investors.length === 0) {
      document.getElementById('investors-table').innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px">No investors yet. Add one above.</div>';
      return;
    }

    var html = '<div style="overflow-x:auto"><table>';
    html += '<tr><th>Name</th><th style="text-align:right">Invested</th><th style="text-align:center">Date</th><th style="text-align:right">Share</th><th style="text-align:right">Capital Avail.</th><th style="text-align:right">Return</th><th style="text-align:right">Return %</th><th></th></tr>';

    var totalCapAvail = 0;
    investors.forEach(function(inv) {
      var share = totalInvested > 0 ? (inv.amount_usdc / totalInvested) : 0;
      var returnUsdc = totalFees * share;
      var returnPct = inv.amount_usdc > 0 ? (returnUsdc / inv.amount_usdc * 100) : 0;
      var capAvail = (share * totalPortfolio) - inv.amount_usdc;
      totalCapAvail += capAvail;
      var shareCol = share > 0.5 ? '#a855f7' : '#c9d1d9';
      var capCol = capAvail >= 0 ? '#22c55e' : '#ef4444';

      html += '<tr>';
      html += '<td style="font-weight:bold">' + inv.name + '</td>';
      html += '<td style="text-align:right;color:#58a6ff">$' + fmt(inv.amount_usdc, 2) + '</td>';
      html += '<td style="text-align:center;color:#8b949e">' + inv.invest_date + '</td>';
      html += '<td style="text-align:right;color:' + shareCol + ';font-weight:bold">' + fmt(share * 100, 1) + '%</td>';
      html += '<td style="text-align:right;color:' + capCol + ';font-weight:bold">' + (capAvail >= 0 ? '+' : '-') + '$' + fmt(Math.abs(capAvail), 2) + '</td>';
      html += '<td style="text-align:right;color:#ffd700;font-weight:bold">$' + fmt(returnUsdc, 2) + '</td>';
      html += '<td style="text-align:right;color:#22c55e">' + fmt(returnPct, 2) + '%</td>';
      html += '<td><button class="del-btn" onclick="deleteInvestor(' + inv.id + ',\\'' + inv.name.replace(/'/g, "\\\\'") + '\\')">✕</button></td>';
      html += '</tr>';
    });

    // Totals row
    var totalCapCol = totalCapAvail >= 0 ? '#22c55e' : '#ef4444';
    html += '<tr style="border-top:2px solid #30363d;font-weight:bold">';
    html += '<td>TOTAL</td>';
    html += '<td style="text-align:right;color:#58a6ff">$' + fmt(totalInvested, 2) + '</td>';
    html += '<td></td>';
    html += '<td style="text-align:right">100%</td>';
    html += '<td style="text-align:right;color:' + totalCapCol + '">' + (totalCapAvail >= 0 ? '+' : '-') + '$' + fmt(Math.abs(totalCapAvail), 2) + '</td>';
    html += '<td style="text-align:right;color:#ffd700">$' + fmt(totalFees, 2) + '</td>';
    html += '<td style="text-align:right;color:#22c55e">' + (totalInvested > 0 ? fmt(totalFees / totalInvested * 100, 2) : '0.00') + '%</td>';
    html += '<td></td>';
    html += '</tr>';

    html += '</table></div>';
    document.getElementById('investors-table').innerHTML = html;
  }).catch(function(e) {
    document.getElementById('investors-table').innerHTML = '<div style="color:#ef4444">Failed to load: ' + e + '</div>';
  });
}

loadData();
setInterval(loadData, 60000); // refresh every 60s
</script>
</body></html>`;
}
