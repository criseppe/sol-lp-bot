import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';
import crypto from 'crypto';
import type { BotState, RebalanceEvent } from '../types.js';
import type { ComparisonSnapshot } from '../paper/ledger.js';
import { type DailyPnlRow, getLiveSnapshots, getLiveInRangePct, getDecisionLogs, getRegimeHistory, getRebalanceEvents as dbGetRebalanceEvents, exportAllData } from '../db/sqlite.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { REGIME_PARAMS } from '../constants.js';

interface OnChainTx {
  signature: string;
  time: string;
  fee: number;
  feeSol: number;
  status: string;
  slot: number;
}

async function fetchRecentTransactions(rpcUrl: string, walletAddress: string, limit = 10): Promise<OnChainTx[]> {
  try {
    const conn = new Connection(rpcUrl);
    const wallet = new PublicKey(walletAddress);
    const sigs = await conn.getSignaturesForAddress(wallet, { limit });
    const txs: OnChainTx[] = [];
    for (const sig of sigs) {
      const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      txs.push({
        signature: sig.signature,
        time: new Date((sig.blockTime ?? 0) * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        fee: tx?.meta?.fee ?? 0,
        feeSol: (tx?.meta?.fee ?? 0) / 1e9,
        status: tx?.meta?.err ? 'FAILED' : 'OK',
        slot: sig.slot,
      });
    }
    return txs;
  } catch {
    return [];
  }
}

export interface LiveData {
  walletAddress: string;
  solBalance: number;
  usdcBalance: number;
  totalValueUsdc: number;
  solPrice: number;
  positionMint: string | null;
  positionRange: { lower: number; upper: number } | null;
  positionLiquidity: string | null;
  feeOwedSol: string | null;
  feeOwedUsdc: string | null;
  positionSol: number;
  positionUsdc: number;
  positionValueUsdc: number;
  totalValueWithPosition: number;
  pendingFeesSol: number;
  pendingFeesUsdc: number;
  pendingFeesTotal: number;
  cumHarvestedFeesSol: number;
  cumHarvestedFeesUsdc: number;
  totalFeesUsdc: number;
  entryPrice: number | null;
  entrySol: number | null;
  entryUsdc: number | null;
  ilUsdc: number;
  realizedIlUsdc: number;
  gasSol: number;
  gasUsdc: number;
  txCount: number;
  regime: string;
  botState: BotState;
  liveEvents: RebalanceEvent[];
}

export interface DashboardServer {
  updateData(
    comparison: ComparisonSnapshot,
    events: RebalanceEvent[],
    botState: BotState,
    dailyPnl?: DailyPnlRow[],
  ): void;
  updateLiveData(live: LiveData): void;
  onEmergencyStop(handler: () => Promise<void>): void;
  onPause(handler: () => void): void;
  onResume(handler: () => void): void;
  onHarvest(handler: () => Promise<{ feeSol: number; feeUsdc: number }>): void;
  setDb(db: any): void;
  stop(): void;
}

export function startDashboard(port: number): DashboardServer {
  const app = express();
  let server: Server;

  // --- Basic auth middleware ---
  const dashUser = process.env.DASHBOARD_USER;
  const dashPass = process.env.DASHBOARD_PASS;

  if (dashUser && dashPass) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="SOL LP Bot Dashboard"');
        res.status(401).send('Authentication required');
        return;
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const userMatch = crypto.timingSafeEqual(Buffer.from(user), Buffer.from(dashUser));
      const passMatch = crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(dashPass));
      if (!userMatch || !passMatch) {
        res.setHeader('WWW-Authenticate', 'Basic realm="SOL LP Bot Dashboard"');
        res.status(401).send('Invalid credentials');
        return;
      }
      next();
    });
    console.log(JSON.stringify({ level: 'info', msg: 'dashboard auth enabled', timestamp: Date.now() }));
  }

  let currentComparison: ComparisonSnapshot | null = null;
  let currentEvents: RebalanceEvent[] = [];
  let currentBotState: BotState = 'IDLE';
  let currentDailyPnl: DailyPnlRow[] = [];
  let currentLive: LiveData | null = null;
  const startTime = Date.now();

  app.get('/api/data', (_req, res) => {
    res.json({
      comparison: currentComparison,
      recentEvents: currentEvents.slice(0, 10),
      dailyPnl: currentDailyPnl,
      botState: currentBotState,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  app.get('/api/live', (_req, res) => {
    res.json(currentLive);
  });

  // Data export and analysis endpoints
  let dbRef: ReturnType<typeof import('../db/sqlite.js')['initDb']> | null = null;

  app.get('/api/export', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(exportAllData(dbRef));
  });

  app.get('/api/decisions', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getDecisionLogs(dbRef, parseInt((_req.query as any).limit ?? '100')));
  });

  app.get('/api/snapshots', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    const hours = parseInt((_req.query as any).hours ?? '24');
    res.json(getLiveSnapshots(dbRef, hours));
  });

  app.get('/api/regime-history', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getRegimeHistory(dbRef, 50));
  });

  app.get('/api/events', (_req, res) => {
    res.json(currentEvents.slice(0, 50));
  });

  // Insights page
  app.get('/insights', async (_req, res) => {
    if (!dbRef) { res.type('html').send('<h1>DB not ready</h1>'); return; }
    const snapshots = getLiveSnapshots(dbRef, 24);
    const snapshots7d = getLiveSnapshots(dbRef, 168); // 7 days
    const inRangePct1h = getLiveInRangePct(dbRef, 1);
    const inRangePct24h = getLiveInRangePct(dbRef, 24);
    const inRangePctAll = getLiveInRangePct(dbRef, 9999);
    const allDecisions = getDecisionLogs(dbRef, 100);
    const regimeEvals = allDecisions.filter(d => d.decision === 'REGIME_EVAL' || d.decision === 'REGIME_CHANGE').slice(0, 10);
    const decisions = allDecisions.filter(d => d.decision !== 'REGIME_EVAL').slice(0, 10);
    const regimeHist = getRegimeHistory(dbRef, 20);
    const events = dbGetRebalanceEvents(dbRef, 30);
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const rpcUrl = process.env.RPC_URL ?? '';
    const walletAddr = currentLive?.walletAddress ?? '';
    const recentTxs = (rpcUrl && walletAddr) ? await fetchRecentTransactions(rpcUrl, walletAddr, 10) : [];
    res.type('html').send(renderInsightsHtml({ snapshots, snapshots7d, inRangePct1h, inRangePct24h, inRangePctAll, decisions, regimeEvals, regimeHist, events, recentTxs, uptime }));
  });

  // Strategy page
  app.get('/strategy', (_req, res) => {
    res.type('html').send(renderStrategyHtml());
  });

  // Health check state
  interface HealthCheck {
    name: string;
    description: string;
    status: 'ok' | 'error' | 'checking';
    detail: string;
    lastChecked: number;
  }
  let healthChecks: HealthCheck[] = [];
  let healthCheckRunning = false;

  async function runHealthChecks(): Promise<HealthCheck[]> {
    if (healthCheckRunning) return healthChecks;
    healthCheckRunning = true;
    const checks: HealthCheck[] = [];
    const now = Date.now();
    const rpcUrl = process.env.RPC_URL ?? '';
    const walletAddr = currentLive?.walletAddress ?? '';

    // 1. Pyth Oracle (Hermes)
    try {
      const feedId = process.env.PYTH_SOL_USD_FEED ?? '';
      const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
      const json = await res.json() as any;
      const price = json.parsed?.[0]?.price;
      if (price) {
        const p = Number(price.price) * Math.pow(10, price.expo);
        checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'ok', detail: `$${p.toFixed(2)} | conf: ${(Number(price.conf) * Math.pow(10, price.expo)).toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'error', detail: 'No price data returned', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Pyth Oracle (Hermes)', description: 'SOL/USD price feed', status: 'error', detail: String(err), lastChecked: now }); }

    // 2. Solana RPC
    try {
      const conn2 = new Connection(rpcUrl);
      const slot = await conn2.getSlot();
      checks.push({ name: 'Solana RPC', description: 'Helius mainnet RPC', status: 'ok', detail: `Slot: ${slot}`, lastChecked: now });
    } catch (err) { checks.push({ name: 'Solana RPC', description: 'Helius mainnet RPC', status: 'error', detail: String(err), lastChecked: now }); }

    // 3. Wallet balance
    try {
      if (walletAddr) {
        const conn2 = new Connection(rpcUrl);
        const bal = await conn2.getBalance(new PublicKey(walletAddr));
        checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: bal > 10000000 ? 'ok' : 'error', detail: `${(bal / 1e9).toFixed(6)} SOL${bal <= 10000000 ? ' — LOW, need SOL for gas!' : ''}`, lastChecked: now });
      } else {
        checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: 'error', detail: 'No wallet address', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Wallet SOL Balance', description: 'On-chain SOL balance', status: 'error', detail: String(err), lastChecked: now }); }

    // 4. Orca Whirlpool
    try {
      const conn2 = new Connection(rpcUrl);
      const poolAddr = process.env.WHIRLPOOL_ADDRESS ?? '';
      const accInfo = await conn2.getAccountInfo(new PublicKey(poolAddr));
      checks.push({ name: 'Orca Whirlpool', description: 'SOL/USDC pool account', status: accInfo ? 'ok' : 'error', detail: accInfo ? `Data: ${accInfo.data.length} bytes` : 'Account not found', lastChecked: now });
    } catch (err) { checks.push({ name: 'Orca Whirlpool', description: 'SOL/USDC pool account', status: 'error', detail: String(err), lastChecked: now }); }

    // 5. Pool price
    try {
      if (currentLive?.solPrice) {
        checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'ok', detail: `$${currentLive.solPrice.toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'error', detail: 'No price from pool service', lastChecked: now });
      }
    } catch { checks.push({ name: 'Pool Price', description: 'Orca pool current price', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 6. Position data
    try {
      if (currentLive?.positionMint) {
        checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'ok', detail: `Mint: ${currentLive.positionMint.slice(0, 12)}... | Liq: ${currentLive.positionLiquidity ?? '--'}`, lastChecked: now });
      } else {
        checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'ok', detail: 'No open position (normal if IDLE)', lastChecked: now });
      }
    } catch { checks.push({ name: 'Position Data', description: 'On-chain position account', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 7. Pending fees (collectFeesQuote)
    try {
      if (currentLive?.positionMint) {
        const pf = currentLive.pendingFeesTotal;
        checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'ok', detail: `$${pf.toFixed(4)} (${currentLive.pendingFeesSol.toFixed(6)} SOL + ${currentLive.pendingFeesUsdc.toFixed(4)} USDC)`, lastChecked: now });
      } else {
        checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'ok', detail: 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'Pending Fees', description: 'collectFeesQuote off-chain', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 8. Gas tracking
    try {
      checks.push({ name: 'Gas Tracking', description: 'On-chain tx fee reading', status: (currentLive?.txCount ?? 0) > 0 ? 'ok' : 'ok', detail: `${currentLive?.gasSol?.toFixed(6) ?? '0'} SOL cumulative (${currentLive?.txCount ?? 0} txs)`, lastChecked: now });
    } catch { checks.push({ name: 'Gas Tracking', description: 'On-chain tx fee reading', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 9. Position composition
    try {
      if (currentLive?.positionMint && currentLive.positionValueUsdc > 0) {
        checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: 'ok', detail: `${currentLive.positionSol.toFixed(4)} SOL + ${currentLive.positionUsdc.toFixed(2)} USDC = $${currentLive.positionValueUsdc.toFixed(2)}`, lastChecked: now });
      } else {
        checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: currentLive?.positionMint ? 'error' : 'ok', detail: currentLive?.positionMint ? 'Value is 0' : 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'Position Composition', description: 'Token amounts from liquidity', status: 'error', detail: 'Failed', lastChecked: now }); }

    // 10. SQLite DB
    try {
      if (dbRef) {
        const count = (dbRef.prepare('SELECT COUNT(*) as c FROM live_snapshots').get() as any).c;
        checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'ok', detail: `${count} snapshots recorded`, lastChecked: now });
      } else {
        checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'error', detail: 'DB not initialized', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'SQLite Database', description: 'Local data persistence', status: 'error', detail: String(err), lastChecked: now }); }

    // 11. Telegram
    try {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const tgChat = process.env.TELEGRAM_CHAT_ID;
      if (tgToken && tgChat) {
        const res = await fetch(`https://api.telegram.org/bot${tgToken}/getMe`);
        const json = await res.json() as any;
        checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: json.ok ? 'ok' : 'error', detail: json.ok ? `@${json.result.username}` : 'Bot unreachable', lastChecked: now });
      } else {
        checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: 'error', detail: 'Not configured', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Telegram Bot', description: 'Hourly report delivery', status: 'error', detail: String(err), lastChecked: now }); }

    // 12. IL calculation
    try {
      if (currentLive?.entryPrice && currentLive.positionMint) {
        checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'ok', detail: `Entry: $${currentLive.entryPrice.toFixed(2)} → Now: $${currentLive.solPrice.toFixed(2)} | IL: $${currentLive.ilUsdc.toFixed(4)}`, lastChecked: now });
      } else {
        checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'ok', detail: 'No position', lastChecked: now });
      }
    } catch { checks.push({ name: 'IL Calculation', description: 'Impermanent loss from entry', status: 'error', detail: 'Failed', lastChecked: now }); }

    healthChecks = checks;
    healthCheckRunning = false;
    return checks;
  }

  // Run health checks every 30 minutes
  setInterval(() => { runHealthChecks().catch(() => {}); }, 30 * 60_000);

  // Status page
  app.get('/status', async (_req, res) => {
    const checks = await runHealthChecks();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    res.type('html').send(renderStatusHtml(checks, uptime));
  });

  app.get('/api/health', async (_req, res) => {
    const checks = await runHealthChecks();
    res.json(checks);
  });

  // Redirect root to live page
  app.get('/', (_req, res) => {
    res.redirect('/live');
  });

  // Live wallet page — reads events from DB for full history
  app.get('/live', (_req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const allEvents = dbRef ? dbGetRebalanceEvents(dbRef, 50) : currentEvents;
    res.type('html').send(renderLiveHtml(currentLive, allEvents, uptime));
  });

  // Bot control APIs
  let onEmergencyStop: (() => Promise<void>) | null = null;
  let onPause: (() => void) | null = null;
  let onResume: (() => void) | null = null;
  let isPaused = false;

  app.post('/api/emergency-stop', async (_req, res) => {
    if (onEmergencyStop) {
      try {
        await onEmergencyStop();
        res.json({ success: true, msg: 'Position closed and bot stopped.' });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No emergency stop handler registered.' });
    }
  });

  app.post('/api/pause', (_req, res) => {
    if (onPause) {
      onPause();
      isPaused = true;
      res.json({ success: true, msg: 'Bot paused. Position stays open on-chain.' });
    } else {
      res.status(400).json({ success: false, msg: 'No pause handler registered.' });
    }
  });

  app.post('/api/resume', (_req, res) => {
    if (onResume) {
      onResume();
      isPaused = false;
      res.json({ success: true, msg: 'Bot resumed.' });
    } else {
      res.status(400).json({ success: false, msg: 'No resume handler registered.' });
    }
  });

  let onHarvest: (() => Promise<{ feeSol: number; feeUsdc: number }>) | null = null;

  app.post('/api/harvest', async (_req, res) => {
    if (onHarvest) {
      try {
        const fees = await onHarvest();
        res.json({ success: true, msg: `Harvested ${fees.feeSol.toFixed(6)} SOL + ${fees.feeUsdc.toFixed(6)} USDC` });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No harvest handler registered.' });
    }
  });

  app.get('/api/bot-status', (_req, res) => {
    res.json({ paused: isPaused, botState: currentBotState });
  });

  server = app.listen(port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: `dashboard running on http://localhost:${port}`,
      timestamp: Date.now(),
    }));
  });

  return {
    updateData(comparison, events, botState, dailyPnl) {
      currentComparison = comparison;
      currentEvents = events;
      currentBotState = botState;
      if (dailyPnl) currentDailyPnl = dailyPnl;
    },
    updateLiveData(live) {
      currentLive = live;
    },
    onEmergencyStop(handler) {
      onEmergencyStop = handler;
    },
    onPause(handler) {
      onPause = handler;
    },
    onResume(handler) {
      onResume = handler;
    },
    onHarvest(handler) {
      onHarvest = handler;
    },
    setDb(d) {
      dbRef = d;
    },
    stop() {
      server.close();
    },
  };
}

function fmt(n: number, d = 2): string {
  const parts = Math.abs(n).toFixed(d).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + parts.join('.');
}

// ── Shared styles ─────────────────────────────────────────────────────────

const SHARED_STYLES = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'SF Mono',Menlo,monospace;font-size:13px;padding:16px;-webkit-text-size-adjust:100%}
.banner{text-align:center;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px}
.banner h1{font-size:16px;color:#58a6ff}
.banner .mode{font-size:11px;text-transform:uppercase;letter-spacing:2px}
.nav{display:flex;gap:6px;justify-content:center;margin-bottom:12px;flex-wrap:wrap}
.nav a{color:#8b949e;text-decoration:none;padding:8px 14px;border:1px solid #30363d;border-radius:6px;font-size:12px;transition:all 0.2s;white-space:nowrap}
.nav a:hover,.nav a.active{color:#c9d1d9;border-color:#58a6ff;background:#161b22}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:13px;color:#8b949e;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d;gap:8px;flex-wrap:wrap}
.row .label{color:#8b949e;flex-shrink:0}
.row .value{font-weight:bold;text-align:right;word-break:break-word}
.green{color:#22c55e}.red{color:#ef4444}.amber{color:#eab308}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold}
.full{grid-column:1/-1}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d;white-space:nowrap}
td{padding:6px 4px;border-bottom:1px solid #21262d;vertical-align:top}
td:last-child{color:#8b949e;font-size:11px;line-height:1.4;max-width:500px}
.dots{display:flex;gap:8px;align-items:center}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.big-number{text-align:center;padding:12px 0}
.big-number .val{font-size:28px;font-weight:bold}
.big-number .sub{color:#8b949e;font-size:11px;margin-top:4px}
.range-bar{position:relative;height:24px;background:#21262d;border-radius:4px;margin:8px 0;overflow:hidden}
.range-fill{position:absolute;height:100%;background:#58a6ff20;border-left:2px solid #58a6ff;border-right:2px solid #58a6ff}
.range-cursor{position:absolute;top:0;width:3px;height:100%;background:#f0883e}
@media(max-width:700px){
  body{padding:8px;font-size:12px}
  .grid{grid-template-columns:1fr;gap:10px}
  .card{padding:12px}
  .card h2{font-size:12px;margin-bottom:8px}
  .banner{padding:10px}
  .banner h1{font-size:15px}
  .nav a{padding:8px 10px;font-size:11px;flex:1;text-align:center;min-width:0}
  .big-number .val{font-size:22px}
  .row{font-size:12px}
  .row .value{font-size:12px}
  table{font-size:11px}
  th,td{padding:5px 3px}
  td:last-child{max-width:200px}
}
`;

const NAV_HTML = `
<div class="nav">
  <a href="/live" id="nav-live">Live Wallet</a>
  <a href="/insights" id="nav-insights">Insights</a>
  <a href="/strategy" id="nav-strategy">Strategy</a>
  <a href="/status" id="nav-status">Status</a>
</div>`;

// ── Paper page ────────────────────────────────────────────────────────────

function renderPaperHtml(data: {
  comparison: ComparisonSnapshot | null;
  recentEvents: RebalanceEvent[];
  dailyPnl: DailyPnlRow[];
  botState: BotState;
  uptime: number;
}): string {
  const c = data.comparison;
  const regimeColours: Record<string, string> = {
    RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7',
  };
  const stateColours: Record<string, string> = {
    IDLE: '#888', ACTIVE: '#22c55e', REBALANCING: '#eab308', HALTED: '#ef4444', WAITING_PULLBACK: '#f97316',
  };

  const price = c ? `$${fmt(c.price)}` : '--';
  const regime = c ? c.bot.regime : 'RANGING';
  const regimeCol = regimeColours[regime] || '#888';
  const stateCol = stateColours[data.botState] || '#888';

  const botVal = c ? `$${fmt(c.bot.portfolioValue)}` : '--';
  const naiveVal = c ? `$${fmt(c.naive.portfolioValue)}` : '--';
  const botPnl = c ? `${c.bot.netPnl >= 0 ? '+' : ''}$${fmt(c.bot.netPnl)}` : '--';
  const naivePnl = c ? `${c.naive.netPnl >= 0 ? '+' : ''}$${fmt(c.naive.netPnl)}` : '--';
  const botApr = c ? `${c.bot.netApr >= 0 ? '+' : ''}${fmt(c.bot.netApr, 1)}%` : '--';
  const naiveApr = c ? `${c.naive.netApr >= 0 ? '+' : ''}${fmt(c.naive.netApr, 1)}%` : '--';
  const botFees = c ? `+$${fmt(c.bot.cumFees)}` : '--';
  const naiveFees = c ? `+$${fmt(c.naive.cumFees)}` : '--';
  const botIL = c ? `$${fmt(c.bot.cumIL)}` : '--';
  const naiveIL = c ? `$${fmt(c.naive.cumIL)}` : '--';
  const advantage = c ? `${c.advantage >= 0 ? '+' : ''}$${fmt(c.advantage)}` : '--';
  const advCol = c && c.advantage >= 0 ? '#22c55e' : '#ef4444';

  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  const eventRows = data.recentEvents.map(e => {
    const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `<tr><td>${t}</td><td>${e.eventType}</td><td>$${fmt(e.price)}</td><td>${e.regime}</td><td>${e.note || ''}</td></tr>`;
  }).join('');

  const maxPnl = Math.max(1, ...data.dailyPnl.map(d => Math.abs(d.net_pnl ?? 0)));
  const pnlBars = data.dailyPnl.slice(-7).map(d => {
    const pnl = d.net_pnl ?? 0;
    const h = Math.max(2, Math.abs(pnl) / maxPnl * 80);
    const col = pnl >= 0 ? '#22c55e' : '#ef4444';
    const y = pnl >= 0 ? 90 - h : 90;
    return `<rect x="0" y="${y}" width="30" height="${h}" fill="${col}" rx="2"/><text x="15" y="108" text-anchor="middle" fill="#888" font-size="9">${d.date.slice(5)}</text>`;
  }).map((bar, i) => bar.replace(/x="0"/g, `x="${i * 40 + 5}"`)).join('');

  const dailyLoss = c ? ((1000 - c.bot.portfolioValue) / 1000 * 100) : 0;
  const cbDaily = dailyLoss > 5 ? '#ef4444' : dailyLoss > 3 ? '#eab308' : '#22c55e';
  const cbIL = c && Math.abs(c.bot.cumIL) > 80 ? '#ef4444' : '#22c55e';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>SOL/USDC LP Bot - Paper Simulation</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#f0883e">Paper Simulation</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | State: <span style="color:${stateCol}">${data.botState}</span></div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-paper').classList.add('active')</script>

<div class="grid">
  <div class="card">
    <h2>Market</h2>
    <div class="row"><span class="label">SOL Price</span><span class="value">${price}</span></div>
    <div class="row"><span class="label">Regime</span><span class="badge" style="background:${regimeCol}20;color:${regimeCol}">${regime}</span></div>
    <div class="row"><span class="label">Circuit Breakers</span><span class="dots"><span class="dot" style="background:${cbDaily}" title="Daily Loss"></span><span class="dot" style="background:${cbIL}" title="IL"></span></span></div>
  </div>

  <div class="card">
    <h2>Advantage</h2>
    <div class="big-number">
      <div class="val" style="color:${advCol}">${advantage}</div>
      <div class="sub">vs naive benchmark</div>
    </div>
  </div>

  <div class="card">
    <h2>Bot Strategy</h2>
    <div class="row"><span class="label">Portfolio</span><span class="value">${botVal}</span></div>
    <div class="row"><span class="label">Net P&L</span><span class="value ${c && c.bot.netPnl >= 0 ? 'green' : 'red'}">${botPnl}</span></div>
    <div class="row"><span class="label">Net APR</span><span class="value ${c && c.bot.netApr >= 0 ? 'green' : 'red'}">${botApr}</span></div>
    <div class="row"><span class="label">Fees</span><span class="value green">${botFees}</span></div>
    <div class="row"><span class="label">IL Cost</span><span class="value red">${botIL}</span></div>
    <div class="row"><span class="label">Rebalances</span><span class="value">${c ? c.bot.rebalanceCount : '--'}</span></div>
  </div>

  <div class="card">
    <h2>Naive Benchmark</h2>
    <div class="row"><span class="label">Portfolio</span><span class="value">${naiveVal}</span></div>
    <div class="row"><span class="label">Net P&L</span><span class="value ${c && c.naive.netPnl >= 0 ? 'green' : 'red'}">${naivePnl}</span></div>
    <div class="row"><span class="label">Net APR</span><span class="value ${c && c.naive.netApr >= 0 ? 'green' : 'red'}">${naiveApr}</span></div>
    <div class="row"><span class="label">Fees</span><span class="value green">${naiveFees}</span></div>
    <div class="row"><span class="label">IL Cost</span><span class="value red">${naiveIL}</span></div>
    <div class="row"><span class="label">Rebalances</span><span class="value">${c ? c.naive.rebalanceCount : '--'}</span></div>
  </div>

  <div class="card full">
    <h2>7-Day P&L</h2>
    <svg width="100%" height="120" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid meet">
      ${pnlBars || '<text x="150" y="60" text-anchor="middle" fill="#8b949e" font-size="12">No data yet</text>'}
    </svg>
  </div>

  <div class="card full">
    <h2>Recent Events</h2>
    <table>
      <thead><tr><th>Time</th><th>Event</th><th>Price</th><th>Regime</th><th>Description</th></tr></thead>
      <tbody>${eventRows || '<tr><td colspan="5" style="text-align:center;color:#8b949e">No events yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<script>window.__DATA__ = ${JSON.stringify(data)};</script>
</body>
</html>`;
}

// ── Live page ─────────────────────────────────────────────────────────────

function renderLiveHtml(live: LiveData | null, liveEvents: RebalanceEvent[], uptime: number): string {
  const regimeColours: Record<string, string> = {
    RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7',
  };
  const stateColours: Record<string, string> = {
    IDLE: '#888', ACTIVE: '#22c55e', REBALANCING: '#eab308', HALTED: '#ef4444', WAITING_PULLBACK: '#f97316',
  };

  const uptimeMin = Math.floor(uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  if (!live) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="10">
<title>SOL/USDC LP Bot - Live Wallet</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#ef4444">Live Wallet</div>
  <h1>SOL/USDC LP Bot</h1>
</div>
${NAV_HTML}
<script>document.getElementById('nav-live').classList.add('active')</script>
<div class="card" style="text-align:center;padding:40px">
  <h2>Not Available</h2>
  <p style="color:#8b949e;margin-top:12px">Bot is running in SHADOW mode. Set <code>BOT_MODE=LIVE</code> in .env to enable.</p>
</div>
</body>
</html>`;
  }

  const regimeCol = regimeColours[live.regime] || '#888';
  const stateCol = stateColours[live.botState] || '#888';
  const totalValue = `$${fmt(live.totalValueUsdc)}`;
  const solValue = live.solBalance * live.solPrice;

  // Position range bar
  let rangeBarHtml = '<div style="color:#8b949e;text-align:center;padding:8px">No open position</div>';
  if (live.positionRange) {
    const r = live.positionRange;
    const rangeWidth = r.upper - r.lower;
    const centre = (r.lower + r.upper) / 2;
    const halfWidth = rangeWidth / 2;
    const cursorPos = Math.max(0, Math.min(100, ((live.solPrice - r.lower) / rangeWidth) * 100));
    const entryPos = live.entryPrice ? Math.max(0, Math.min(100, ((live.entryPrice - r.lower) / rangeWidth) * 100)) : null;

    // Proximity thresholds for current regime
    const regimeKey = live.regime as keyof typeof REGIME_PARAMS;
    const params = REGIME_PARAMS[regimeKey] ?? REGIME_PARAMS.RANGING;
    // Downside threshold: triggers when price drops to centre - threshold * halfWidth
    const downsidePrice = centre - params.proxThresholdLower * halfWidth;
    const downsidePos = Math.max(0, Math.min(100, ((downsidePrice - r.lower) / rangeWidth) * 100));
    // Upside threshold: triggers when price rises to centre + threshold * halfWidth
    const upsidePrice = centre + params.proxThresholdUpper * halfWidth;
    const upsidePos = Math.max(0, Math.min(100, ((upsidePrice - r.lower) / rangeWidth) * 100));
    // Current proximity values
    const proxToLower = Math.max(0, (centre - live.solPrice) / halfWidth);
    const proxToUpper = Math.max(0, (live.solPrice - centre) / halfWidth);
    const proxDownPct = Math.round(proxToLower * 100);
    const proxUpPct = Math.round(proxToUpper * 100);
    const downThreshPct = Math.round(params.proxThresholdLower * 100);
    const upThreshPct = Math.round(params.proxThresholdUpper * 100);

    rangeBarHtml = `
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#8b949e;margin-bottom:4px">
        <span>$${fmt(r.lower)}</span>
        <span style="color:#f0883e">$${fmt(live.solPrice)} (current)</span>
        <span>$${fmt(r.upper)}</span>
      </div>
      <div class="range-bar" style="height:32px">
        <div class="range-fill" style="left:0;width:100%"></div>
        <!-- Danger zones: beyond thresholds -->
        <div style="position:absolute;top:0;left:0;width:${downsidePos}%;height:100%;background:rgba(249,115,22,0.15);border-right:2px dashed #f97316" title="Downside exit at $${fmt(downsidePrice)} (${downThreshPct}%)"></div>
        <div style="position:absolute;top:0;right:0;width:${(100 - upsidePos).toFixed(1)}%;height:100%;background:rgba(88,166,255,0.15);border-left:2px dashed #58a6ff" title="Upside exit at $${fmt(upsidePrice)} (${upThreshPct}%)"></div>
        <!-- Threshold labels -->
        <div style="position:absolute;top:1px;left:${downsidePos}%;transform:translateX(-100%);font-size:9px;color:#f97316;padding:0 3px;white-space:nowrap">&#x25BC; ${downThreshPct}%</div>
        <div style="position:absolute;top:1px;left:${upsidePos}%;transform:translateX(0%);font-size:9px;color:#58a6ff;padding:0 3px;white-space:nowrap">${upThreshPct}% &#x25B2;</div>
        ${entryPos !== null ? `<div style="position:absolute;top:0;width:3px;height:100%;background:#a855f7;left:${entryPos}%" title="Entry: $${fmt(live.entryPrice!)}"></div>` : ''}
        <div class="range-cursor" style="left:${cursorPos}%"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:10px;margin-top:6px">
        <span><span style="display:inline-block;width:8px;height:8px;background:#f0883e;border-radius:2px;margin-right:3px"></span>Current: $${fmt(live.solPrice)}</span>
        ${live.entryPrice ? `<span><span style="display:inline-block;width:8px;height:8px;background:#a855f7;border-radius:2px;margin-right:3px"></span>Entry: $${fmt(live.entryPrice)}</span>` : '<span></span>'}
        <span><span style="display:inline-block;width:8px;height:2px;border-top:2px dashed #f97316;margin-right:3px;vertical-align:middle"></span>Down: $${fmt(downsidePrice)}</span>
        <span><span style="display:inline-block;width:8px;height:2px;border-top:2px dashed #58a6ff;margin-right:3px;vertical-align:middle"></span>Up: $${fmt(upsidePrice)}</span>
      </div>
      <div style="display:flex;gap:12px;font-size:10px;margin-top:6px;color:#8b949e;flex-wrap:wrap">
        <span>Prox &#x25BC; <b style="color:${proxDownPct >= downThreshPct ? '#f97316' : '#c9d1d9'}">${proxDownPct}%</b>/${downThreshPct}%</span>
        <span>Prox &#x25B2; <b style="color:${proxUpPct >= upThreshPct ? '#58a6ff' : '#c9d1d9'}">${proxUpPct}%</b>/${upThreshPct}%</span>
        <span>(${live.regime})</span>
      </div>
      ${(() => {
        let entryStr = '';
        if (live.entryPrice) {
          entryStr = `<span style="color:#a855f7;font-size:10px">At entry: ${fmt(live.entrySol ?? 0)} SOL + ${fmt(live.entryUsdc ?? 0)} USDC</span>`;
        }
        return `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px;font-size:10px">
          <span style="color:#f0883e">Now: ${fmt(live.positionSol)} SOL + ${fmt(live.positionUsdc)} USDC</span>
          ${entryStr}
        </div>`;
      })()}`;
  }

  // Events — each event is a full card with description
  const eventCards = liveEvents.map(e => {
    const t = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const d = new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const typeColors: Record<string, string> = {
      POSITION_OPENED: '#22c55e', POSITION_CLOSED: '#ef4444',
      T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308',
      PULLBACK_REENTRY: '#22c55e', PULLBACK_TIMEOUT: '#a855f7',
      FEE_HARVEST: '#58a6ff', CIRCUIT_BREAKER: '#ef4444',
      REGIME_CHANGE: '#a855f7',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="event-card">
      <div class="event-header">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span class="event-meta">${d} ${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div class="event-desc">${(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
      ${e.feeSol || e.feeUsdc ? `<div class="event-balances" style="color:#22c55e">Fees: ${fmt(e.feeSol, 6)} SOL + ${fmt(e.feeUsdc, 4)} USDC${e.ilAtClose ? ` | IL: $${fmt(e.ilAtClose, 4)}` : ''}</div>` : ''}
      ${e.solBefore || e.usdcBefore || e.solAfter || e.usdcAfter ? `<div class="event-balances">Before: ${fmt(e.solBefore, 4)} SOL / ${fmt(e.usdcBefore, 2)} USDC &rarr; After: ${fmt(e.solAfter, 4)} SOL / ${fmt(e.usdcAfter, 2)} USDC${!e.feeSol && !e.feeUsdc && e.ilAtClose ? ` | IL: $${fmt(e.ilAtClose, 4)}` : ''}</div>` : ''}
    </div>`;
  }).join('');

  // Solscan link
  const solscanUrl = `https://solscan.io/account/${live.walletAddress}`;
  const shortAddr = live.walletAddress.slice(0, 6) + '...' + live.walletAddress.slice(-4);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>SOL/USDC LP Bot - Live Wallet</title>
<style>${SHARED_STYLES}
.wallet-addr{font-size:11px;color:#58a6ff;text-decoration:none}
.wallet-addr:hover{text-decoration:underline}
.event-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:8px}
.event-header{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.event-meta{font-size:11px;color:#8b949e}
.event-desc{font-size:12px;color:#c9d1d9;line-height:1.5;margin-bottom:4px}
.event-balances{font-size:11px;color:#8b949e;border-top:1px solid #21262d;padding-top:6px;margin-top:6px}
.ctrl-btn{border:none;padding:12px 24px;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;font-family:inherit;width:100%;transition:all 0.2s;-webkit-tap-highlight-color:transparent}
.ctrl-btn:disabled{background:#555!important;cursor:not-allowed;color:#888!important}
.ctrl-red{background:#dc2626;color:white}.ctrl-red:hover{background:#b91c1c}
.ctrl-amber{background:#d97706;color:white}.ctrl-amber:hover{background:#b45309}
.ctrl-green{background:#16a34a;color:white}.ctrl-green:hover{background:#15803d}
.ctrl-blue{background:#2563eb;color:white}.ctrl-blue:hover{background:#1d4ed8}
.stop-confirm{display:none;background:#1c1917;border:2px solid #dc2626;border-radius:8px;padding:16px;margin-top:12px;text-align:center}
.ctrl-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.fees-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.fees-cell{text-align:center;padding:12px 0}
.fees-cell:not(:last-child){border-right:1px solid #21262d}
.il-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.il-cell{text-align:center;padding:8px 0}
.wallet-split{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:12px;border-top:1px solid #21262d;padding-top:12px}
.wallet-half{text-align:center}
.wallet-half:first-child{border-right:1px solid #21262d}
@media(max-width:700px){
  .ctrl-grid{grid-template-columns:1fr 1fr;gap:8px}
  .fees-grid{grid-template-columns:1fr}
  .fees-cell{border-right:none!important;border-bottom:1px solid #21262d;padding:10px 0}
  .fees-cell:last-child{border-bottom:none}
  .il-grid{grid-template-columns:1fr}
  .il-cell{border-bottom:1px solid #21262d;padding:10px 0}
  .il-cell:last-child{border-bottom:none}
  .wallet-split{grid-template-columns:1fr}
  .wallet-half{padding:8px 0}
  .wallet-half:first-child{border-right:none;border-bottom:1px solid #21262d}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#ef4444">Live Wallet &mdash; Real Money</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">
    Uptime: ${uptimeStr} | State: <span style="color:${stateCol}">${live.botState}</span> |
    <a href="${solscanUrl}" target="_blank" class="wallet-addr">${shortAddr}</a>
  </div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-live').classList.add('active')</script>

<div class="grid">
  <div class="card full">
    <h2>Total Portfolio Value</h2>
    <div class="big-number">
      <div class="val" style="color:#58a6ff">$${fmt(live.totalValueWithPosition)}</div>
      <div class="sub">Wallet + Liquidity Position</div>
    </div>
    <div class="wallet-split">
      <div class="wallet-half">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Wallet</div>
        <div style="font-size:16px;font-weight:bold">$${fmt(live.totalValueUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.solBalance, 4)} SOL + ${fmt(live.usdcBalance, 2)} USDC</div>
      </div>
      <div class="wallet-half">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Liquidity Position</div>
        <div style="font-size:16px;font-weight:bold">${live.positionMint ? `$${fmt(live.positionValueUsdc)}` : '--'}</div>
        <div style="font-size:11px;color:#8b949e">${live.positionMint ? `${fmt(live.positionSol, 4)} SOL + ${fmt(live.positionUsdc, 2)} USDC` : 'No position open'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Market</h2>
    <div class="row"><span class="label">SOL Price</span><span class="value">$${fmt(live.solPrice)}</span></div>
    <div class="row"><span class="label">Regime</span><span class="badge" style="background:${regimeCol}20;color:${regimeCol}">${live.regime}</span></div>
    <div class="row"><span class="label">Bot State</span><span class="value" style="color:${stateCol}">${live.botState}</span></div>
  </div>

  <div class="card">
    <h2>Position Details</h2>
    <div class="row"><span class="label">Status</span><span class="value">${live.positionMint ? 'OPEN' : 'NONE'}</span></div>
    ${live.positionMint ? `
    <div class="row"><span class="label">SOL in Position</span><span class="value">${fmt(live.positionSol, 6)} <span style="color:#8b949e;font-weight:normal">($${fmt(live.positionSol * live.solPrice)})</span></span></div>
    <div class="row"><span class="label">USDC in Position</span><span class="value">${fmt(live.positionUsdc, 6)}</span></div>
    <div class="row"><span class="label">Position Value</span><span class="value" style="color:#58a6ff">$${fmt(live.positionValueUsdc)}</span></div>
    <div class="row"><span class="label">Entry Price</span><span class="value">$${fmt(live.entryPrice ?? 0)}</span></div>
    ` : ''}
  </div>

  <div class="card full">
    <h2>Fees, IL &amp; PnL</h2>
    <div class="fees-grid">
      <div class="fees-cell">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Pending Fees</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.pendingFeesTotal)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.pendingFeesSol, 6)} SOL</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.pendingFeesUsdc, 4)} USDC</div>
      </div>
      <div class="fees-cell">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Harvested Fees</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.cumHarvestedFeesSol * live.solPrice + live.cumHarvestedFeesUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.cumHarvestedFeesSol, 6)} SOL</div>
        <div style="font-size:11px;color:#8b949e">${fmt(live.cumHarvestedFeesUsdc, 4)} USDC</div>
      </div>
      <div class="fees-cell" style="border-right:none">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Total Fees Earned</div>
        <div style="font-size:20px;font-weight:bold;color:#22c55e">$${fmt(live.totalFeesUsdc)}</div>
        <div style="font-size:11px;color:#8b949e">Pending + Harvested</div>
      </div>
    </div>
    <div style="border-top:1px solid #21262d;margin-top:8px;padding-top:12px">
      <div class="il-grid">
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Potential IL (unrealized)</div>
          <div style="font-size:20px;font-weight:bold;color:${live.ilUsdc < 0 ? '#ef4444' : '#22c55e'}">${live.ilUsdc < 0 ? '-' : '+'}$${fmt(Math.abs(live.ilUsdc), 4)}</div>
          <div style="font-size:11px;color:#8b949e">${live.entryPrice ? `Entry $${fmt(live.entryPrice)} → $${fmt(live.solPrice)} (${((live.solPrice - live.entryPrice) / live.entryPrice * 100).toFixed(2)}%)` : '--'}</div>
        </div>
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Realized IL (from closes)</div>
          <div style="font-size:20px;font-weight:bold;color:${live.realizedIlUsdc < 0 ? '#ef4444' : '#22c55e'}">${live.realizedIlUsdc < 0 ? '-' : '+'}$${fmt(Math.abs(live.realizedIlUsdc), 4)}</div>
          <div style="font-size:11px;color:#8b949e">Cumulative from closed positions</div>
        </div>
        <div class="il-cell">
          <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Gas Fees (on-chain)</div>
          <div style="font-size:20px;font-weight:bold;color:#ef4444">-$${fmt(live.gasUsdc, 4)}</div>
          <div style="font-size:11px;color:#8b949e">${fmt(live.gasSol, 6)} SOL (${live.txCount} txs)</div>
        </div>
      </div>
    </div>
    <div style="border-top:1px solid #21262d;margin-top:8px;padding-top:12px;text-align:center">
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Net PnL (Fees - IL - Gas)</div>
      ${(() => { const totalIl = live.ilUsdc + live.realizedIlUsdc; const net = live.totalFeesUsdc + totalIl - live.gasUsdc; return `<div style="font-size:24px;font-weight:bold;color:${net >= 0 ? '#22c55e' : '#ef4444'}">${net >= 0 ? '+' : '-'}$${fmt(Math.abs(net))}</div><div style="font-size:11px;color:#8b949e">${net >= 0 ? 'Profitable' : 'Underwater'} | Fees $${fmt(live.totalFeesUsdc)} - IL $${fmt(Math.abs(totalIl))} - Gas $${fmt(live.gasUsdc, 4)}</div>`; })()}
    </div>
  </div>

  <div class="card full">
    <h2>Position Range</h2>
    ${rangeBarHtml}
    ${live.positionMint ? `<div style="font-size:11px;color:#8b949e;margin-top:8px">Position: <a href="https://solscan.io/token/${live.positionMint}" target="_blank" class="wallet-addr">${live.positionMint.slice(0, 12)}...</a> | Liquidity: ${live.positionLiquidity || '--'}</div>` : ''}
  </div>

  <div class="card full">
    <h2>Bot Controls</h2>
    <div class="ctrl-grid">
      <div>
        <button id="harvest-btn" class="ctrl-btn ctrl-blue" onclick="harvestFees()">
          Harvest Fees
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Collect pending fees from position to wallet.</div>
      </div>
      <div>
        <button id="pause-btn" class="ctrl-btn ctrl-amber" onclick="controlBot('pause')">
          Pause Bot
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Stops decision loop. Position stays open.</div>
      </div>
      <div>
        <button id="resume-btn" class="ctrl-btn ctrl-green" onclick="controlBot('resume')">
          Resume Bot
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Restarts decision loop and rebalancing.</div>
      </div>
      <div>
        <button id="estop-btn" class="ctrl-btn ctrl-red" onclick="document.getElementById('stop-confirm').style.display='block'">
          Close &amp; Stop
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Closes position, withdraws all, shuts down.</div>
      </div>
    </div>
    <div id="ctrl-result" style="font-size:12px;text-align:center;min-height:20px"></div>
    <div class="stop-confirm" id="stop-confirm">
      <p style="color:#ef4444;font-weight:bold;margin-bottom:8px">Are you sure?</p>
      <p style="color:#8b949e;font-size:12px;margin-bottom:12px">This will close your liquidity position on-chain and shut down the bot process.</p>
      <button class="ctrl-btn ctrl-red" id="confirm-stop-btn" onclick="executeStop()">
        Yes, Close &amp; Stop Now
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('stop-confirm').style.display='none'">
        Cancel
      </button>
      <div id="stop-result" style="margin-top:12px;font-size:12px"></div>
    </div>
  </div>


</div>

<script>
window.__LIVE_DATA__ = ${JSON.stringify(live)};

function harvestFees() {
  var btn = document.getElementById('harvest-btn');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  btn.textContent = 'Harvesting...';
  result.innerHTML = '<span style="color:#eab308">Collecting fees from on-chain position...</span>';

  fetch('/api/harvest', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      btn.disabled = false;
      btn.textContent = 'Harvest Fees';
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Harvest Fees';
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
    });
}

function controlBot(action) {
  var result = document.getElementById('ctrl-result');
  var btn = document.getElementById(action === 'pause' ? 'pause-btn' : 'resume-btn');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">' + (action === 'pause' ? 'Pausing...' : 'Resuming...') + '</span>';

  fetch('/api/' + action, { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        if (action === 'pause') {
          document.getElementById('pause-btn').disabled = true;
          document.getElementById('resume-btn').disabled = false;
        } else {
          document.getElementById('pause-btn').disabled = false;
          document.getElementById('resume-btn').disabled = true;
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
        btn.disabled = false;
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function executeStop() {
  var btn = document.getElementById('confirm-stop-btn');
  var result = document.getElementById('stop-result');
  btn.disabled = true;
  btn.textContent = 'Closing position...';
  result.innerHTML = '<span style="color:#eab308">Sending close transaction to Solana...</span>';

  fetch('/api/emergency-stop', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">Position closed. Bot stopped.</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">Error: ' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Retry Close & Stop';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Retry Close & Stop';
    });
}
</script>
</body>
</html>`;
}

// ── Insights page ─────────────────────────────────────────────────────────

interface InsightsData {
  snapshots: Array<{ timestamp: number; price: number; total_value_usdc: number; pending_fees_sol: number; pending_fees_usdc: number; cum_fees_sol: number; cum_fees_usdc: number; il_usdc: number; in_range: number; regime: string }>;
  snapshots7d: Array<{ timestamp: number; total_value_usdc: number; total_with_position: number; position_value: number }>;
  inRangePct1h: number;
  inRangePct24h: number;
  inRangePctAll: number;
  decisions: Array<{ timestamp: number; price: number; regime: string; bot_state: string; prox_lower: number | null; prox_upper: number | null; in_range: number | null; decision: string; reasoning: string; params_json: string | null }>;
  regimeEvals: Array<{ timestamp: number; price: number; regime: string; bot_state: string; decision: string; reasoning: string; params_json: string | null }>;
  regimeHist: Array<{ timestamp: number; old_regime: string; new_regime: string; price: number; dir_ratio: number | null; realised_vol: number | null; price_count: number | null }>;
  events: RebalanceEvent[];
  recentTxs: OnChainTx[];
  uptime: number;
}

function renderInsightsHtml(data: InsightsData): string {
  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  const snaps = data.snapshots;
  let chartSvg = '<text x="200" y="40" text-anchor="middle" fill="#8b949e" font-size="12">Collecting data...</text>';
  if (snaps.length > 2) {
    const values = snaps.map(s => (s as any).total_with_position ?? s.total_value_usdc);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = maxV - minV || 1;
    const w = 580;
    const h = 80;

    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w + 10;
      const y = h - ((v - minV) / range) * (h - 10) + 5;
      return `${x},${y}`;
    }).join(' ');

    const firstTime = new Date(snaps[0].timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const lastTime = new Date(snaps[snaps.length - 1].timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const lastVal = values[values.length - 1];
    const firstVal = values[0];
    const lineColor = lastVal >= firstVal ? '#22c55e' : '#ef4444';
    const changePct = firstVal > 0 ? ((lastVal - firstVal) / firstVal * 100) : 0;

    chartSvg = `
      <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2"/>
      <text x="10" y="98" fill="#8b949e" font-size="9">${firstTime}</text>
      <text x="${w}" y="98" text-anchor="end" fill="#8b949e" font-size="9">${lastTime}</text>
      <text x="10" y="12" fill="#8b949e" font-size="9">$${fmt(maxV)}</text>
      <text x="10" y="${h}" fill="#8b949e" font-size="9">$${fmt(minV)}</text>
      <circle cx="${w + 10}" cy="${h - ((lastVal - minV) / range) * (h - 10) + 5}" r="3" fill="${lineColor}"/>
      <text x="${w - 80}" y="12" fill="${lineColor}" font-size="10" font-weight="bold">$${fmt(lastVal)} (${changePct >= 0 ? '+' : ''}${fmt(changePct, 1)}%)</text>`;
  }

  function gauge(pct: number, label: string): string {
    const col = pct > 80 ? '#22c55e' : pct > 50 ? '#eab308' : '#ef4444';
    return `<div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${col}">${fmt(pct, 1)}%</div>
      <div style="font-size:11px;color:#8b949e">${label}</div>
    </div>`;
  }

  const regimeCards = data.regimeHist.map(r => {
    const t = new Date(r.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const regimeColours: Record<string, string> = { RANGING: '#4a9eff', BULLISH_TREND: '#22c55e', BEARISH_TREND: '#ef4444', EXTREME: '#a855f7' };
    const oldCol = regimeColours[r.old_regime] || '#888';
    const newCol = regimeColours[r.new_regime] || '#888';
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="color:#8b949e;font-size:11px">${t}</span>
        <span class="badge" style="background:${oldCol}20;color:${oldCol}">${r.old_regime}</span>
        <span style="color:#8b949e">&rarr;</span>
        <span class="badge" style="background:${newCol}20;color:${newCol}">${r.new_regime}</span>
        <span style="color:#8b949e;font-size:11px">at $${fmt(r.price)}</span>
      </div>
      <div style="font-size:11px;color:#8b949e;margin-top:4px">
        dirRatio: ${r.dir_ratio?.toFixed(3) ?? '--'} | realisedVol: ${r.realised_vol?.toFixed(4) ?? '--'} | ${r.price_count ?? '--'} daily closes
      </div>
    </div>`;
  }).join('') || '<div style="color:#8b949e;text-align:center;padding:16px">No regime changes yet</div>';

  const decisionCards = data.decisions.map(d => {
    const t = new Date(d.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const decColours: Record<string, string> = {
      HOLD: '#8b949e', T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308', PULLBACK_REENTRY: '#22c55e',
      PULLBACK_TIMEOUT: '#a855f7', FEE_HARVEST: '#58a6ff', POSITION_OPENED: '#22c55e',
    };
    const col = decColours[d.decision] || '#8b949e';
    const proxStr = d.prox_lower !== null ? `prox: ${(d.prox_lower * 100).toFixed(0)}%down ${((d.prox_upper ?? 0) * 100).toFixed(0)}%up` : '';
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge" style="background:${col}20;color:${col}">${d.decision}</span>
        <span style="color:#8b949e;font-size:11px">${t} &middot; $${fmt(d.price)} &middot; ${d.regime}</span>
        ${proxStr ? `<span style="color:#8b949e;font-size:11px">${proxStr}</span>` : ''}
      </div>
      <div style="font-size:12px;color:#c9d1d9;margin-top:4px;line-height:1.4">${d.reasoning.replace(/\n/g, '<br/>')}</div>
    </div>`;
  }).join('') || '<div style="color:#8b949e;text-align:center;padding:16px">No decisions logged yet</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>SOL/USDC LP Bot - Insights</title>
<style>${SHARED_STYLES}
.section-title{font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d}
.gauge-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px}
@media(max-width:700px){
  .gauge-row{grid-template-columns:1fr;gap:8px}
  .section-title{font-size:13px;margin:16px 0 10px}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#a855f7">Insights &amp; Analytics</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | Snapshots: ${snaps.length}</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-insights').classList.add('active')</script>

<div class="card" style="margin-bottom:16px">
  <h2>Total Portfolio Value (24h) — Wallet + Liquidity Position</h2>
  <svg width="100%" height="105" viewBox="0 0 600 105" preserveAspectRatio="xMidYMid meet">
    ${chartSvg}
  </svg>
</div>

${(() => {
  // Group 7d snapshots by date, take last snapshot of each day
  const dailyMap = new Map<string, { total: number; wallet: number; position: number }>();
  data.snapshots7d.forEach(s => {
    const date = new Date(s.timestamp).toISOString().slice(0, 10);
    const total = (s as any).total_with_position ?? s.total_value_usdc;
    const position = (s as any).position_value ?? 0;
    dailyMap.set(date, { total, wallet: s.total_value_usdc, position });
  });
  const days = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);

  if (days.length === 0) return '<div class="card" style="margin-bottom:16px"><h2>Daily Portfolio Value (7 days)</h2><div style="color:#8b949e;text-align:center;padding:20px">Collecting data...</div></div>';

  const maxVal = Math.max(...days.map(d => d[1].total));
  const minVal = Math.min(...days.map(d => d[1].total));
  const barW = Math.floor(500 / days.length) - 8;
  const chartH = 100;
  const baseY = chartH + 5;
  // Scale bars relative to min-max range, but start bars from bottom
  const scaleRange = maxVal - minVal || 1;

  const bars = days.map(([date, val], i) => {
    const x = i * (barW + 8) + 40;
    const barH = Math.max(4, ((val.total - minVal) / scaleRange) * chartH * 0.8 + chartH * 0.2);
    const posH = val.position > 0 ? (val.position / val.total) * barH : 0;
    const walH = barH - posH;
    const y = baseY - barH;
    const dayLabel = date.slice(5); // MM-DD
    const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const change = i > 0 ? val.total - days[i-1][1].total : 0;
    const changeCol = change >= 0 ? '#22c55e' : '#ef4444';
    return `
      <rect x="${x}" y="${y + walH}" width="${barW}" height="${posH}" fill="#58a6ff" rx="0"/>
      <rect x="${x}" y="${y}" width="${barW}" height="${walH}" fill="#22c55e80" rx="2"/>
      <text x="${x + barW/2}" y="${baseY + 12}" text-anchor="middle" fill="#8b949e" font-size="9">${dayLabel}</text>
      <text x="${x + barW/2}" y="${baseY + 22}" text-anchor="middle" fill="#8b949e" font-size="8">${dayName}</text>
      <text x="${x + barW/2}" y="${y - 3}" text-anchor="middle" fill="#c9d1d9" font-size="9">$${fmt(val.total, 0)}</text>
      ${i > 0 ? `<text x="${x + barW/2}" y="${y - 13}" text-anchor="middle" fill="${changeCol}" font-size="8">${change >= 0 ? '+' : ''}${fmt(change, 2)}</text>` : ''}`;
  }).join('');

  return `<div class="card" style="margin-bottom:16px">
  <h2>Daily Portfolio Value (7 days) — <span style="color:#22c55e80">Wallet</span> + <span style="color:#58a6ff">Position</span></h2>
  <svg width="100%" height="140" viewBox="0 0 600 140" preserveAspectRatio="xMidYMid meet">
    <text x="5" y="12" fill="#8b949e" font-size="9">$${fmt(maxVal, 0)}</text>
    <text x="5" y="${baseY}" fill="#8b949e" font-size="9">$${fmt(minVal, 0)}</text>
    <line x1="35" y1="5" x2="35" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    <line x1="35" y1="${baseY}" x2="590" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
    ${bars}
  </svg>
</div>`;
})()}

<div class="section-title">In-Range Performance</div>
<div class="gauge-row">
  <div class="card">${gauge(data.inRangePct1h, 'Last 1 Hour')}</div>
  <div class="card">${gauge(data.inRangePct24h, 'Last 24 Hours')}</div>
  <div class="card">${gauge(data.inRangePctAll, 'All Time')}</div>
</div>

<div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Regime Changes</div>
<div class="card" style="margin-bottom:16px">
  ${regimeCards}
</div>

<div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Event Log <span style="font-size:11px;color:#8b949e;font-weight:normal">(last 10 — <a href="/api/events" target="_blank" style="color:#58a6ff">download full log</a>)</span></div>
${data.events.slice(0, 10).length > 0 ? data.events.slice(0, 10).map(e => {
    const t = new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const typeColors: Record<string, string> = {
      POSITION_OPENED: '#22c55e', POSITION_CLOSED: '#ef4444',
      T1_DOWNSIDE: '#f97316', T1_UPSIDE: '#eab308',
      OOR_BELOW: '#ef4444', OOR_ABOVE: '#eab308',
      PULLBACK_REENTRY: '#22c55e', PULLBACK_TIMEOUT: '#a855f7',
      FEE_HARVEST: '#58a6ff', CIRCUIT_BREAKER: '#ef4444',
      REGIME_CHANGE: '#a855f7',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span style="color:#8b949e;font-size:11px">${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div style="font-size:12px;color:#c9d1d9;line-height:1.5">${(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
      ${e.solBefore || e.usdcBefore || e.solAfter || e.usdcAfter ? `<div style="font-size:11px;color:#8b949e;border-top:1px solid #21262d;padding-top:6px;margin-top:6px">Before: ${fmt(e.solBefore, 4)} SOL / ${fmt(e.usdcBefore, 2)} USDC &rarr; After: ${fmt(e.solAfter, 4)} SOL / ${fmt(e.usdcAfter, 2)} USDC</div>` : ''}
    </div>`;
  }).join('') : '<div class="card" style="text-align:center;color:#8b949e;padding:20px">No events yet</div>'}

<div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">On-Chain Transactions (last 10)</div>
<div class="card" style="margin-bottom:16px">
${data.recentTxs.length > 0 ? `
  <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Time</th>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Gas Fee</th>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Status</th>
        <th style="text-align:left;color:#8b949e;padding:6px 4px;border-bottom:1px solid #30363d">Transaction</th>
      </tr>
    </thead>
    <tbody>
      ${data.recentTxs.map(tx => `
        <tr>
          <td style="padding:6px 4px;border-bottom:1px solid #21262d;white-space:nowrap">${tx.time}</td>
          <td style="padding:6px 4px;border-bottom:1px solid #21262d;color:#ef4444">${tx.fee.toLocaleString()} lamports<br/><span style="color:#8b949e">${tx.feeSol.toFixed(6)} SOL</span></td>
          <td style="padding:6px 4px;border-bottom:1px solid #21262d"><span style="color:${tx.status === 'OK' ? '#22c55e' : '#ef4444'}">${tx.status}</span></td>
          <td style="padding:6px 4px;border-bottom:1px solid #21262d"><a href="https://solscan.io/tx/${tx.signature}" target="_blank" style="color:#58a6ff;text-decoration:none;font-family:monospace;font-size:11px">${tx.signature.slice(0, 16)}...</a></td>
        </tr>
      `).join('')}
    </tbody>
  </table></div>
  <div style="font-size:11px;color:#8b949e;margin-top:8px;text-align:right">
    <a href="https://solscan.io/account/${data.recentTxs.length > 0 ? '' : ''}Evga86Xco1D5XCeSF2T3Ff8DsJAhr2SoaVrPWALoLU6z" target="_blank" style="color:#58a6ff;text-decoration:none">View all on Solscan &rarr;</a>
  </div>
` : '<div style="color:#8b949e;text-align:center;padding:16px">No transactions found</div>'}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Download Logs</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">Decision logs and regime evaluations are recorded every 60 seconds. Download for offline analysis.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <a href="/api/export" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Full JSON Export</a>
    <a href="/api/decisions?limit=500" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Decision Log (500)</a>
    <a href="/api/snapshots?hours=168" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Snapshots (7 days)</a>
    <a href="/api/regime-history" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Regime History</a>
  </div>
</div>

</body>
</html>`;
}

// ── Strategy page ─────────────────────────────────────────────────────────

function renderStrategyHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP Bot - Strategy</title>
<style>${SHARED_STYLES}
.flow{display:flex;flex-direction:column;gap:2px;margin:12px 0}
.flow-step{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px}
.flow-step h3{font-size:13px;margin-bottom:6px}
.flow-arrow{text-align:center;color:#30363d;font-size:18px}
.param-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#30363d;border-radius:8px;overflow:hidden;margin:12px 0}
.param-grid .cell{background:#161b22;padding:8px;font-size:11px;text-align:center}
.param-grid .header{background:#0d1117;color:#8b949e;font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.param-grid .regime-col{font-weight:bold}
.rule-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px}
.rule-card h3{color:#58a6ff;font-size:14px;margin-bottom:8px}
.rule-card .trigger{color:#f0883e;font-size:12px;font-style:italic;margin-top:8px}
.rule-num{display:inline-block;background:#58a6ff20;color:#58a6ff;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:bold;margin-right:8px}
.logic-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:12px;font-family:monospace;color:#c9d1d9;margin:8px 0;line-height:1.6;white-space:pre-wrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin:0 2px}
.tag-ranging{background:#4a9eff20;color:#4a9eff}
.tag-bull{background:#22c55e20;color:#22c55e}
.tag-bear{background:#ef444420;color:#ef4444}
.tag-extreme{background:#a855f720;color:#a855f7}
.adv-risks{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){
  .param-grid{overflow-x:auto;display:block;-webkit-overflow-scrolling:touch}
  .param-grid-inner{display:grid;grid-template-columns:repeat(5,minmax(70px,1fr));gap:1px;min-width:400px}
  .flow-step{padding:10px 12px}
  .flow-step h3{font-size:12px}
  .rule-card{padding:12px}
  .rule-card h3{font-size:13px}
  .logic-box{font-size:11px;padding:10px;overflow-x:auto}
  .adv-risks{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#58a6ff">Strategy &amp; Rules</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">How the bot detects market regimes and manages liquidity positions</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-strategy').classList.add('active')</script>

<div class="card" style="margin-bottom:16px">
  <h2>Overview</h2>
  <p style="color:#c9d1d9;font-size:13px;line-height:1.6">
    The bot runs a <b>30-second decision loop</b> that reads live SOL/USD price data, detects the current market regime,
    and manages a concentrated liquidity position on the <b>Orca SOL/USDC Whirlpool</b>. It uses 6 rules that adapt
    their parameters based on market conditions. The goal: maximize fee yield while minimizing impermanent loss.
  </p>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Decision Flow (every 30 seconds)</h2>
  <div class="flow">
    <div class="flow-step"><h3>1. Fetch Price</h3><div style="font-size:12px;color:#8b949e">Get SOL/USD from Pyth Hermes oracle. Validate confidence &lt; 0.5% and staleness &lt; 60s. Skip cycle if invalid.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>2. Detect Regime (every 60s)</h3><div style="font-size:12px;color:#8b949e">Analyze last 7 days of daily closes. Compute directional ratio + realised volatility. Classify market state.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>3. Check Safety</h3><div style="font-size:12px;color:#8b949e">Circuit breakers: daily loss &gt; 5% or IL &gt; 8% or &gt; 10 rebalances/hour &#x2192; HALT.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>4. Position Decision</h3><div style="font-size:12px;color:#8b949e">No position &#x2192; open one. Has position &#x2192; check proximity to edges. Out of range &#x2192; rebalance or pullback watch.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>5. Fee Harvest</h3><div style="font-size:12px;color:#8b949e">If enough time since last harvest &#x2192; collect accrued trading fees from the on-chain position.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>6. Record &amp; Report</h3><div style="font-size:12px;color:#8b949e">Log decision + reasoning to DB. Update dashboard. Record wallet snapshot. Telegram report hourly.</div></div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Regime Detection</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:12px">Uses 2 days of daily closing prices to classify the market.</p>
  <div class="logic-box"><b>dirRatio</b> = |net move| / total path
  1.0 = straight line (strong trend)
  0.0 = oscillating (ranging)

<b>realisedVol</b> = stddev of daily log returns
  Normal SOL: 3-5%. Crisis: &gt; 8%

<b>Classification:</b>
  if realisedVol &gt; 0.08        &#x2192; <span class="tag tag-extreme">EXTREME</span>
  if dirRatio &gt; 0.35 &amp; up    &#x2192; <span class="tag tag-bull">BULLISH_TREND</span>
  if dirRatio &gt; 0.35 &amp; down  &#x2192; <span class="tag tag-bear">BEARISH_TREND</span>
  else                         &#x2192; <span class="tag tag-ranging">RANGING</span></div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Strategy Parameters by Regime</h2>
  <div class="param-grid">
  <div class="param-grid-inner">
    <div class="cell header">Parameter</div>
    <div class="cell header" style="color:#4a9eff">Ranging</div>
    <div class="cell header" style="color:#22c55e">Bullish</div>
    <div class="cell header" style="color:#ef4444">Bearish</div>
    <div class="cell header" style="color:#a855f7">Extreme</div>
    <div class="cell" style="text-align:left;color:#8b949e">Range Width</div><div class="cell" style="color:#4a9eff">1.5%</div><div class="cell" style="color:#22c55e">3%</div><div class="cell" style="color:#ef4444">4%</div><div class="cell" style="color:#a855f7">6%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Skew (down/up)</div><div class="cell">30/70%</div><div class="cell">20/80%</div><div class="cell">40/60%</div><div class="cell">50/50%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Downside Exit</div><div class="cell">65%</div><div class="cell">70%</div><div class="cell">55%</div><div class="cell">50%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Upside Exit</div><div class="cell">88%</div><div class="cell">92%</div><div class="cell">82%</div><div class="cell">80%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Capital Deployed</div><div class="cell" style="color:#22c55e">100%</div><div class="cell">85%</div><div class="cell" style="color:#eab308">50%</div><div class="cell" style="color:#ef4444">25%</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL Re-entry Split</div><div class="cell">50%</div><div class="cell">50%</div><div class="cell">30%</div><div class="cell">20%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Harvest Interval</div><div class="cell">7 days</div><div class="cell">4 days</div><div class="cell">2 days</div><div class="cell">1 day</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL&#x2192;USDC on Harvest</div><div class="cell">0%</div><div class="cell">70%</div><div class="cell" style="color:#ef4444">100%</div><div class="cell" style="color:#ef4444">100%</div>
  </div></div>
  <div style="font-size:11px;color:#8b949e">Ranging = tight, max fees. Trending = wider, less risk. Extreme = widest, minimal exposure.</div>
</div>

<div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">The 6 Rules</div>

<div class="rule-card">
  <h3><span class="rule-num">1</span> Asymmetric Range Calculator</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Calculates the price range for the position. Skewed based on regime to give more room in the expected direction.</p>
  <div class="logic-box">lower = price &#xD7; (1 - rangeWidth &#xD7; skewDown)
upper = price &#xD7; (1 + rangeWidth &#xD7; skewUp)</div>
  <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6">
    <div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Example: SOL at $85, RANGING regime</div>
    <div style="color:#c9d1d9">rangeWidth = 1.5%, skewDown = 30%, skewUp = 70%</div>
    <div style="color:#c9d1d9">lower = $85 &#xD7; (1 - 0.015 &#xD7; 0.30) = $85 &#xD7; 0.9955 = <b>$84.62</b></div>
    <div style="color:#c9d1d9">upper = $85 &#xD7; (1 + 0.015 &#xD7; 0.70) = $85 &#xD7; 1.0105 = <b>$85.89</b></div>
    <div style="color:#8b949e;margin-top:4px">Range: $84.62 &#x2014; $85.89. Width = $1.27. Room below: $0.38 (30%), room above: $0.89 (70%). The skew gives price more room to rise before going OOR, based on the assumption that ranging markets oscillate slightly upward.</div>
  </div>
  <div class="trigger">Triggers: Every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">2</span> Proximity Monitor &amp; Early Exit</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Measures how close price is to range edges. Exit <b>before</b> going out of range to reduce IL.</p>
  <div class="logic-box">proxToLower = (centre - price) / halfWidth    0%=safe, 100%=edge
proxToUpper = (price - centre) / halfWidth

Downside: proxToLower &#x2265; threshold &#x2192; close + reopen at current price
Upside:   proxToUpper &#x2265; threshold &#x2192; close + enter pullback watch</div>
  <div class="table-wrap"><table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:12px">
    <tr style="border-bottom:1px solid #21262d">
      <th style="text-align:left;padding:6px 8px;color:#8b949e">Regime</th>
      <th style="text-align:center;padding:6px 8px;color:#f97316">Downside Threshold</th>
      <th style="text-align:center;padding:6px 8px;color:#58a6ff">Upside Threshold</th>
    </tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#c9d1d9">RANGING</td>
      <td style="text-align:center;padding:6px 8px;color:#f97316;font-weight:bold">65%</td>
      <td style="text-align:center;padding:6px 8px;color:#58a6ff;font-weight:bold">88%</td>
    </tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#c9d1d9">BULLISH</td>
      <td style="text-align:center;padding:6px 8px;color:#f97316;font-weight:bold">70%</td>
      <td style="text-align:center;padding:6px 8px;color:#58a6ff;font-weight:bold">92%</td>
    </tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#c9d1d9">BEARISH</td>
      <td style="text-align:center;padding:6px 8px;color:#f97316;font-weight:bold">55%</td>
      <td style="text-align:center;padding:6px 8px;color:#58a6ff;font-weight:bold">82%</td>
    </tr>
    <tr>
      <td style="padding:6px 8px;color:#c9d1d9">EXTREME</td>
      <td style="text-align:center;padding:6px 8px;color:#f97316;font-weight:bold">50%</td>
      <td style="text-align:center;padding:6px 8px;color:#58a6ff;font-weight:bold">80%</td>
    </tr>
  </table></div>
  <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6">
    <div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Example: T1_DOWNSIDE trigger</div>
    <div style="color:#c9d1d9">Position range: $84.62 &#x2014; $85.89, centre = $85.26, halfWidth = $0.64</div>
    <div style="color:#c9d1d9">Price drops to $84.84</div>
    <div style="color:#c9d1d9">proxToLower = ($85.26 - $84.84) / $0.64 = <b>66%</b></div>
    <div style="color:#c9d1d9">RANGING threshold = 65% &#x2192; 66% &#x2265; 65% &#x2192; <b style="color:#f97316">TRIGGER!</b></div>
    <div style="color:#8b949e;margin-top:4px">Bot closes the position now at 66% proximity instead of waiting for full OOR at 100%. This avoids the worst IL that happens in the last 35% of drift. It then reopens a new position centered at $84.84.</div>
  </div>
  <div class="trigger">Triggers: Every 30s cycle when position is in range</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">3</span> Pullback Re-entry Timing</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After upside exit, wait for a pullback or timeout. Avoids re-entering at a local peak.</p>
  <div class="logic-box">After upside exit, track peak price.

if pullback &#x2265; 2.5% from peak &#x2192; re-enter (PULLBACK)
if waited &#x2265; 5 minutes        &#x2192; re-enter (TIMEOUT)
if single drop &#x2265; 5%          &#x2192; flash crash, wait 15 min</div>
  <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6">
    <div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Example: Pullback re-entry</div>
    <div style="color:#c9d1d9">T1_UPSIDE fires at $85.89. Bot closes position, enters pullback watch.</div>
    <div style="color:#c9d1d9">Price continues to $86.50 (new peak tracked).</div>
    <div style="color:#c9d1d9">Price then drops to $84.34.</div>
    <div style="color:#c9d1d9">Pullback = ($86.50 - $84.34) / $86.50 = <b>2.5%</b> &#x2192; <b style="color:#22c55e">RE-ENTER</b></div>
    <div style="color:#8b949e;margin-top:4px">By waiting for the pullback, the bot avoids opening at $86.50 (local peak) and instead re-enters at $84.34 &#x2014; a better entry price. If no pullback happens within 5 minutes, it re-enters anyway to avoid missing fees.</div>
  </div>
  <div class="trigger">Triggers: Every cycle while WAITING_PULLBACK</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">4</span> Re-entry SOL/USDC Split</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After downside exit, the SOL/USDC holding ratio depends on regime. Less SOL in bearish markets.</p>
  <div class="logic-box"><span class="tag tag-ranging">RANGING</span>  50/50    <span class="tag tag-bull">BULLISH</span>  50/50
<span class="tag tag-bear">BEARISH</span> 30/70    <span class="tag tag-extreme">EXTREME</span> 20/80</div>
  <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6">
    <div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Example: BEARISH re-entry with $46 capital</div>
    <div style="color:#c9d1d9">Price dropped and triggered OOR_BELOW. Regime is BEARISH.</div>
    <div style="color:#c9d1d9">Split = 30% SOL / 70% USDC &#x2192; target: $13.80 in SOL + $32.20 in USDC</div>
    <div style="color:#c9d1d9">At $85/SOL: hold 0.162 SOL + $32.20 USDC before depositing.</div>
    <div style="color:#8b949e;margin-top:4px">In bearish markets, holding less SOL reduces exposure to further drops. The 30/70 split means more capital stays in stable USDC. Note: the actual deposited ratio into the position is determined by concentrated liquidity math, but the wallet balance targets this split.</div>
  </div>
  <div class="trigger">Triggers: After downside exit (OOR_BELOW, T1_DOWNSIDE)</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">5</span> Position Sizing</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Controls what % of capital goes into the position vs held as reserve. More volatile = more reserve. The bot calculates total wallet value (SOL + USDC), then deploys the regime percentage.</p>
  <div class="logic-box"><span class="tag tag-ranging">RANGING</span>  100% deployed, 0% reserve    (max fee earning)
<span class="tag tag-bull">BULLISH</span>  85% deployed, 15% reserve
<span class="tag tag-bear">BEARISH</span>  50% deployed, 50% reserve   (half safe)
<span class="tag tag-extreme">EXTREME</span> 25% deployed, 75% reserve   (mostly safe)

<b>Capital deployment steps:</b>
1. Calculate total wallet value = SOL &#xD7; price + USDC
2. Target deploy = total &#xD7; deployPct (regime-based)
3. Determine ideal SOL:USDC ratio for the position
   (ask SDK: "for 1 SOL, how much USDC is needed?")
4. Calculate ideal wallet split to deploy maximum capital
5. If wallet is imbalanced &#x2192; swap to match ideal ratio
6. Open position with the balanced wallet
7. Always reserve 0.05 SOL (gas) + $1 USDC

<b>Pre-deposit swap (wallet rebalancing):</b>
The position ratio depends on where price sits in the range:
  &#x2022; Price near lower bound &#x2192; position is mostly SOL
  &#x2022; Price at centre &#x2192; ~50/50
  &#x2022; Price near upper bound &#x2192; position is mostly USDC

If the wallet doesn't match the required ratio, most capital
would sit idle. The bot fixes this automatically:

  1. Compute ideal split for total available capital
  2. Compare to actual wallet balances
  3. SOL deficit &#x2192; swap USDC &#x2192; SOL via Orca pool
     USDC deficit &#x2192; swap SOL &#x2192; USDC via Orca pool
     Balanced &#x2192; no swap needed
  4. Re-quote with new balances and open position

Example: Wallet has 0.07 SOL ($6) + $35 USDC
  Position needs ratio 1 SOL : 9 USDC at current price
  Ideal: 0.44 SOL + $3.90 USDC
  SOL deficit: 0.37 SOL &#x2192; swap $32 USDC &#x2192; 0.38 SOL
  Result: deploys ~$31 instead of only ~$7

Slippage tolerance: 2%. Swap uses the same Orca SOL/USDC pool.

<b>Reserves:</b> Always keeps 0.05 SOL (gas) + $1 USDC.</div>
  <div class="trigger">Triggers: Every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">6</span> Fee Harvest</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Collects accrued trading fees from the on-chain position. More frequent in volatile markets to lock gains before IL erases them.</p>
  <div class="logic-box"><span class="tag tag-ranging">RANGING</span>  every 7 days   (let fees accumulate)
<span class="tag tag-bull">BULLISH</span>  every 4 days
<span class="tag tag-bear">BEARISH</span>  every 2 days   (lock gains quickly)
<span class="tag tag-extreme">EXTREME</span> every 1 day    (harvest ASAP)</div>
  <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6">
    <div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Example: RANGING harvest cycle</div>
    <div style="color:#c9d1d9">Position opened on Day 1 with $40 liquidity in range $84&#x2014;$86.</div>
    <div style="color:#c9d1d9">Over 7 days, traders swap SOL/USDC through the pool. Your position earns a share of the 0.05% fee on every swap that crosses your range.</div>
    <div style="color:#c9d1d9">Day 7: bot checks &#x2014; daysSinceHarvest = 7 &#x2265; 7 &#x2192; <b style="color:#22c55e">HARVEST</b></div>
    <div style="color:#c9d1d9">Sends collectFees transaction &#x2192; receives 0.001 SOL + 0.08 USDC to wallet.</div>
    <div style="color:#c9d1d9">Cumulative tracker updated. Timer resets for next harvest.</div>
    <div style="color:#8b949e;margin-top:4px">Why not harvest every cycle? Each harvest is an on-chain transaction. While Solana fees are tiny (~$0.001), harvesting too often adds complexity. In EXTREME regime, fees are harvested daily to lock gains before a crash erases them via IL. In RANGING, fees accumulate safely for a week.</div>
  </div>
  <div class="trigger">Triggers: Every cycle, checked against last harvest time</div>
</div>

<div style="font-size:14px;color:#ef4444;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">Circuit Breakers</div>
<div class="card" style="margin-bottom:16px">
  <div class="logic-box"><b>Daily Loss:</b>        portfolio drops &gt; 5%         &#x2192; HALT
<b>Weekly Drawdown:</b>   drops &gt; 15% from peak      &#x2192; HALT
<b>Max IL:</b>            impermanent loss &gt; 8%       &#x2192; force rebalance
<b>Rebalance Limit:</b>  &gt; 10 per hour               &#x2192; pause 30 min
<b>Min Position:</b>     &lt; $100 USDC                  &#x2192; skip
<b>Flash Crash:</b>      &gt; 5% single drop             &#x2192; wait 15 min</div>
</div>

<div style="font-size:14px;color:#58a6ff;margin:20px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d">How Concentrated Liquidity Works</div>
<div class="card" style="margin-bottom:16px">
  <p style="font-size:12px;color:#c9d1d9;line-height:1.6;margin-bottom:12px">
    Unlike traditional AMMs (liquidity spread $0 to &#x221E;), concentrated liquidity focuses your capital in a <b>specific price range</b>.
    Higher fee yield per $, but you must actively manage the range.
  </p>
  <div class="adv-risks">
    <div style="background:#0d1117;border-radius:6px;padding:12px">
      <div style="color:#22c55e;font-weight:bold;font-size:12px;margin-bottom:4px">Advantages</div>
      <ul style="font-size:11px;color:#c9d1d9;padding-left:16px;line-height:1.6">
        <li>Much higher fee yield per $ of liquidity</li>
        <li>Capital efficient</li>
        <li>Earn proportional to your share in the active range</li>
      </ul>
    </div>
    <div style="background:#0d1117;border-radius:6px;padding:12px">
      <div style="color:#ef4444;font-weight:bold;font-size:12px;margin-bottom:4px">Risks</div>
      <ul style="font-size:11px;color:#c9d1d9;padding-left:16px;line-height:1.6">
        <li><b>Impermanent loss</b> if price moves</li>
        <li><b>Out of range</b> = zero fees</li>
        <li>Narrower range = more fees but more IL risk</li>
      </ul>
    </div>
  </div>
  <div class="logic-box" style="margin-top:12px">Token composition changes with price:

At lower bound  &#x2192; 100% SOL,  0% USDC  (bought the dip)
At centre       &#x2192; ~50% SOL, ~50% USDC
At upper bound  &#x2192;  0% SOL, 100% USDC  (sold the top)

This is why the deposited ratio isn't 50/50.</div>
</div>

</body>
</html>`;
}

// ── Status page ───────────────────────────────────────────────────────────

function renderStatusHtml(checks: Array<{ name: string; description: string; status: string; detail: string; lastChecked: number }>, uptime: number): string {
  const uptimeMin = Math.floor(uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
  const okCount = checks.filter(c => c.status === 'ok').length;
  const errorCount = checks.filter(c => c.status === 'error').length;
  const allOk = errorCount === 0;

  const rows = checks.map(c => {
    const dot = c.status === 'ok' ? '#22c55e' : '#ef4444';
    return `<div style="display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid #21262d">
      <div style="min-width:12px;padding-top:3px;flex-shrink:0"><div class="dot" style="background:${dot}"></div></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-weight:bold;font-size:13px;color:#c9d1d9">${c.name}</div>
          <div style="font-size:10px;color:#8b949e">${new Date(c.lastChecked).toLocaleTimeString('en-US', { hour12: false })}</div>
        </div>
        <div style="font-size:11px;color:#8b949e;margin-top:2px">${c.description}</div>
        <div style="font-size:12px;color:${c.status === 'ok' ? '#c9d1d9' : '#ef4444'};margin-top:4px;font-family:monospace;word-break:break-word">${c.detail}</div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>SOL/USDC LP Bot - Status</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:${allOk ? '#22c55e' : '#ef4444'}">${allOk ? 'All Systems Operational' : errorCount + ' Issue(s) Detected'}</div>
  <h1>Live Data Status</h1>
  <div style="color:#8b949e;font-size:11px">Uptime: ${uptimeStr} | ${okCount}/${checks.length} checks passing | Auto-refreshes every 30 min</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-status').classList.add('active')</script>

<div class="card" style="margin-bottom:16px">
  <div style="display:flex;gap:16px;justify-content:center;padding:8px 0">
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:#22c55e">${okCount}</div>
      <div style="font-size:11px;color:#8b949e">Passing</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${errorCount > 0 ? '#ef4444' : '#8b949e'}">${errorCount}</div>
      <div style="font-size:11px;color:#8b949e">Failing</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:28px;font-weight:bold;color:#8b949e">${checks.length}</div>
      <div style="font-size:11px;color:#8b949e">Total</div>
    </div>
  </div>
</div>

<div class="card">
  <h2>Data Sources &amp; Services</h2>
  ${rows}
</div>

<div style="text-align:center;margin-top:16px">
  <a href="/api/health" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:12px">View as JSON</a>
</div>

</body>
</html>`;
}
