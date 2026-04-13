/**
 * Comprehensive bot health check — run via: node scripts/health-check.js
 * Returns JSON report for monitoring.
 */
const Database = require('better-sqlite3');
const db = new Database('./data/mvp.db');

const now = Date.now();
const snap = db.prepare('SELECT * FROM live_snapshots ORDER BY timestamp DESC LIMIT 1').get();
const prevSnap = db.prepare('SELECT * FROM live_snapshots WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(now - 600_000);
const state = db.prepare('SELECT * FROM bot_state WHERE id=1').get();
const recentDecisions = db.prepare("SELECT timestamp, decision, substr(reasoning, 1, 200) as reason, price FROM decision_log ORDER BY timestamp DESC LIMIT 5").all();
const actionCount10m = db.prepare("SELECT COUNT(*) as c FROM decision_log WHERE timestamp > ? AND decision NOT IN ('HOLD','REGIME_EVAL','RESTORED','DEPLOY_SKIP')").get(now - 600_000).c;
const actionCount1h = db.prepare("SELECT COUNT(*) as c FROM decision_log WHERE timestamp > ? AND decision NOT IN ('HOLD','REGIME_EVAL','RESTORED','DEPLOY_SKIP')").get(now - 3_600_000).c;
const errorDecisions1h = db.prepare("SELECT COUNT(*) as c FROM decision_log WHERE timestamp > ? AND (decision LIKE '%ERROR%' OR decision LIKE '%FLASH%' OR decision = 'CIRCUIT_BREAKER')").get(now - 3_600_000).c;
const rebalances24h = db.prepare("SELECT COUNT(*) as c FROM rebalance_events WHERE timestamp > ? AND event_type IN ('T1_DOWNSIDE','T1_UPSIDE','OOR_BELOW','OOR_ABOVE','POSITION_OPENED','POSITION_CLOSED')").get(now - 86_400_000).c;
const harvests24h = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(fee_sol),0) as sol, COALESCE(SUM(fee_usdc),0) as usdc FROM rebalance_events WHERE timestamp > ? AND event_type = 'FEE_HARVEST'").get(now - 86_400_000);
const lastRegimeChange = db.prepare("SELECT * FROM regime_history ORDER BY timestamp DESC LIMIT 1").get();
const todaySummary = db.prepare("SELECT * FROM daily_summary ORDER BY date DESC LIMIT 1").get();
const yesterdaySummary = db.prepare("SELECT * FROM daily_summary ORDER BY date DESC LIMIT 1 OFFSET 1").get();
const snapCount1h = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN in_range=1 THEN 1 ELSE 0 END) as inRange FROM live_snapshots WHERE timestamp > ?").get(now - 3_600_000);

// Position info from state
let pos = null;
try { if (state.position_json && state.position_json !== 'null') pos = JSON.parse(state.position_json); } catch {}

const report = {};

// 1. Process health
report.process = {
  state: state.state,
  regime: state.regime,
  snapAge: snap ? Math.floor((now - snap.timestamp) / 1000) : null,
  stale: snap ? (now - snap.timestamp > 180_000) : true, // >3min = stale
};

// 2. Price & position
if (snap) {
  report.price = {
    current: snap.price,
    change10m: prevSnap ? ((snap.price - prevSnap.price) / prevSnap.price * 100) : null,
  };
  report.portfolio = {
    total: snap.total_with_position,
    wallet: snap.total_value_usdc,
    position: snap.position_value,
    change10m: prevSnap ? (snap.total_with_position - prevSnap.total_with_position) : null,
  };
}

// 3. Range & proximity
if (pos && snap) {
  const centre = (pos.priceLower + pos.priceUpper) / 2;
  const halfWidth = (pos.priceUpper - pos.priceLower) / 2;
  const proxToLower = halfWidth > 0 ? Math.max(0, (centre - snap.price) / halfWidth) : 0;
  const proxToUpper = halfWidth > 0 ? Math.max(0, (snap.price - centre) / halfWidth) : 0;
  const inRange = snap.price >= pos.priceLower && snap.price <= pos.priceUpper;
  const distToLower = ((snap.price - pos.priceLower) / snap.price * 100);
  const distToUpper = ((pos.priceUpper - snap.price) / snap.price * 100);
  report.position = {
    range: `$${pos.priceLower.toFixed(2)}-$${pos.priceUpper.toFixed(2)}`,
    width: `${((pos.priceUpper - pos.priceLower) / centre * 100).toFixed(1)}%`,
    inRange,
    proxToLower: `${(proxToLower * 100).toFixed(0)}%`,
    proxToUpper: `${(proxToUpper * 100).toFixed(0)}%`,
    distToLower: `${distToLower.toFixed(2)}% ($${(snap.price - pos.priceLower).toFixed(2)})`,
    distToUpper: `${distToUpper.toFixed(2)}% ($${(pos.priceUpper - snap.price).toFixed(2)})`,
    entryPrice: pos.entryPrice,
    priceVsEntry: pos.entryPrice ? `${((snap.price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%` : null,
    age: pos.entryTime ? `${((now - pos.entryTime) / 3_600_000).toFixed(1)}h` : null,
  };
  // Warnings
  if (proxToLower > 0.5 || proxToUpper > 0.5) {
    report.position.WARNING = proxToLower > proxToUpper
      ? `Price drifting toward LOWER bound (${(proxToLower*100).toFixed(0)}% proximity)`
      : `Price drifting toward UPPER bound (${(proxToUpper*100).toFixed(0)}% proximity)`;
  }
} else if (!pos) {
  report.position = { status: 'NO POSITION', pullbackActive: state.pullback_active === 1 };
}

// 4. Fees & PnL
report.fees = {
  pendingSol: snap?.pending_fees_sol ?? 0,
  pendingUsdc: snap?.pending_fees_usdc ?? 0,
  pendingTotal: snap ? (snap.pending_fees_sol * snap.price + snap.pending_fees_usdc) : 0,
  cumHarvestedSol: state.cum_fees_sol,
  cumHarvestedUsdc: state.cum_fees_usdc,
  cumHarvestedTotal: snap ? (state.cum_fees_sol * snap.price + state.cum_fees_usdc) : 0,
  realizedIL: state.realized_il,
  harvests24h: { count: harvests24h.c, sol: harvests24h.sol, usdc: harvests24h.usdc },
};
if (snap) {
  const totalFees = report.fees.pendingTotal + report.fees.cumHarvestedTotal;
  const totalIL = (snap.il_usdc || 0) + state.realized_il;
  const gasSol = state.cum_gas_lamports / 1e9;
  report.fees.net = totalFees + totalIL - gasSol * snap.price;
  report.fees.netBreakdown = `fees $${totalFees.toFixed(2)} + IL $${totalIL.toFixed(2)} - gas $${(gasSol * snap.price).toFixed(2)}`;
}

// 5. In-range rate
report.inRange1h = snapCount1h.total > 0
  ? `${(snapCount1h.inRange / snapCount1h.total * 100).toFixed(0)}% (${snapCount1h.inRange}/${snapCount1h.total} snapshots)`
  : 'no data';

// 6. Activity
report.activity = {
  actions10m: actionCount10m,
  actions1h: actionCount1h,
  errors1h: errorDecisions1h,
  rebalances24h,
  txCount: state.tx_count,
  gasSol: (state.cum_gas_lamports / 1e9).toFixed(6),
};

// 7. Daily performance
if (todaySummary) {
  report.today = {
    date: todaySummary.date,
    total: todaySummary.total_usdc,
    change: todaySummary.portfolio_change,
    changePct: todaySummary.total_usdc > 0 ? (todaySummary.portfolio_change / todaySummary.total_usdc * 100) : 0,
    injected: todaySummary.injected_usdc,
    feesEarned: todaySummary.fees_earned_usdc,
  };
}
if (yesterdaySummary) {
  report.yesterday = {
    date: yesterdaySummary.date,
    total: yesterdaySummary.total_usdc,
    change: yesterdaySummary.portfolio_change,
    feesEarned: yesterdaySummary.fees_earned_usdc,
  };
}

// 8. Regime
report.regime = {
  current: state.regime,
  lastChange: lastRegimeChange ? {
    from: lastRegimeChange.old_regime,
    to: lastRegimeChange.new_regime,
    ago: `${((now - lastRegimeChange.timestamp) / 3_600_000).toFixed(1)}h`,
    price: lastRegimeChange.price,
  } : null,
};

// 9. Recent non-HOLD decisions
report.recentDecisions = recentDecisions
  .filter(d => d.decision !== 'HOLD' && d.decision !== 'DEPLOY_SKIP')
  .slice(0, 3)
  .map(d => ({
    ago: `${((now - d.timestamp) / 60_000).toFixed(0)}m`,
    decision: d.decision,
    price: d.price,
    reason: d.reason,
  }));

// 10. Last regime eval with market signals (from decision_log params_json)
const lastRegimeEval = db.prepare("SELECT params_json FROM decision_log WHERE decision IN ('REGIME_EVAL','REGIME_CHANGE') AND params_json IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get();
if (lastRegimeEval?.params_json) {
  try {
    const p = JSON.parse(lastRegimeEval.params_json);
    report.marketSignals = {};
    if (p.vol1h != null) report.marketSignals.vol1h = p.vol1h;
    if (p.vol4h != null) report.marketSignals.vol4h = p.vol4h;
    if (p.solDelta24h != null) report.marketSignals.solDelta24h = `${p.solDelta24h > 0 ? '+' : ''}${p.solDelta24h.toFixed(1)}%`;
    if (p.btcDelta24h != null) report.marketSignals.btcDelta24h = `${p.btcDelta24h > 0 ? '+' : ''}${p.btcDelta24h.toFixed(1)}%`;
    if (p.volumeRatio4h != null) report.marketSignals.volumeRatio = `${p.volumeRatio4h.toFixed(1)}x`;
    if (p.fearGreedIndex != null) report.marketSignals.fearGreed = p.fearGreedIndex;
    if (p.baseRegime) report.marketSignals.baseRegime = p.baseRegime;
    if (p.overrideReason) report.marketSignals.overrideReason = p.overrideReason;
    if (p.confidence != null) report.marketSignals.confidence = `${p.confidence}/5`;
  } catch {}
}

// 11. Alerts
const alerts = [];
if (report.process.stale) alerts.push('STALE: no snapshot in >3min — bot may be stuck');
if (state.state === 'HALTED') alerts.push('HALTED: circuit breaker triggered');
if (!pos && state.pullback_active !== 1) alerts.push('NO POSITION and not in pullback watch');
if (snap && pos && snap.price < pos.priceLower) alerts.push(`OUT OF RANGE BELOW: $${snap.price.toFixed(2)} < $${pos.priceLower.toFixed(2)}`);
if (snap && pos && snap.price > pos.priceUpper) alerts.push(`OUT OF RANGE ABOVE: $${snap.price.toFixed(2)} > $${pos.priceUpper.toFixed(2)}`);
if (errorDecisions1h > 0) alerts.push(`${errorDecisions1h} error decisions in last hour`);
if (rebalances24h > 8) alerts.push(`High rebalance count: ${rebalances24h} in 24h`);
report.alerts = alerts.length > 0 ? alerts : ['none'];

console.log(JSON.stringify(report, null, 2));
db.close();
