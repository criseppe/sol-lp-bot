import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';
import crypto from 'crypto';
import type { BotState, RebalanceEvent } from '../types.js';
import { type DailyPnlRow, getLiveSnapshots, getLiveInRangePct, getDecisionLogs, getRegimeHistory, getRebalanceEvents as dbGetRebalanceEvents, exportAllData, getRule2PerfComparison, getRule2EventsCsv, getConfig, setConfigBatch } from '../db/sqlite.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { REGIME_PARAMS } from '../constants.js';
import { runtime, exportConfig, applyConfigFromDb } from '../config.js';

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

export interface PoolStats {
  tvlUsdc: number;
  price: number;
  feeRate: number;          // e.g. 3000 = 0.30%
  volume24h: number;
  volume7d: number;
  volume30d: number;
  fees24h: number;
  fees7d: number;
  fees30d: number;
  yield24h: number;         // yieldOverTvl 24h
  yield7d: number;
  yield30d: number;
  priceDelta24h: number;    // % change
  volumeDelta24h: number;   // % change
  tokenBalanceA: number;    // SOL in pool
  tokenBalanceB: number;    // USDC in pool
  tickSpacing: number;
  lastFetched: number;
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
  estDailyFeesUsdc: number;
  estAprPct: number;
  regime: string;
  botState: BotState;
  liveEvents: RebalanceEvent[];
}

export interface DashboardServer {
  updateData(
    events: RebalanceEvent[],
    botState: BotState,
    dailyPnl?: DailyPnlRow[],
  ): void;
  updateLiveData(live: LiveData): void;
  onEmergencyStop(handler: () => Promise<void>): void;
  onPause(handler: () => void): void;
  onResume(handler: () => void): void;
  onHarvest(handler: () => Promise<{ feeSol: number; feeUsdc: number }>): void;
  onClosePosition(handler: () => Promise<void>): void;
  onToggleRule2(handler: (enabled: boolean) => void): void;
  onToggleAutoDeploy(handler: (enabled: boolean) => void): void;
  onAddLiquidity(handler: () => Promise<{ solDeposited: number; usdcDeposited: number; totalUsdc: number; liquidityAdded: string }>): void;
  onAddLiquidityPreview(handler: () => Promise<{ solAvailable: number; usdcAvailable: number; totalAvailableUsdc: number; estSolDeposit: number; estUsdcDeposit: number; estTotalUsdc: number; positionRange: string; needsSwap: string } | null>): void;
  getRule2Enabled(): boolean;
  setRule2Enabled(enabled: boolean): void;
  getAutoDeployEnabled(): boolean;
  setAutoDeployEnabled(enabled: boolean): void;
  getPoolStats(): PoolStats | null;
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

  let currentEvents: RebalanceEvent[] = [];
  let currentBotState: BotState = 'IDLE';
  let currentDailyPnl: DailyPnlRow[] = [];
  let currentLive: LiveData | null = null;
  let poolStats: PoolStats | null = null;
  let poolStatsFetchTime = 0;
  const POOL_STATS_TTL = 5 * 60_000; // refresh every 5 minutes
  const startTime = Date.now();

  async function fetchPoolStats(): Promise<void> {
    const now = Date.now();
    if (poolStats && now - poolStatsFetchTime < POOL_STATS_TTL) return;
    const whirlpoolAddr = process.env.WHIRLPOOL_ADDRESS;
    if (!whirlpoolAddr) return;
    try {
      const res = await fetch(`https://api.orca.so/v2/solana/pools/${whirlpoolAddr}`);
      if (!res.ok) return;
      const json = await res.json() as any;
      const d = json.data;
      if (!d) return;
      const s24 = d.stats?.['24h'] ?? {};
      const s7d = d.stats?.['7d'] ?? {};
      const s30d = d.stats?.['30d'] ?? {};
      poolStats = {
        tvlUsdc: parseFloat(d.tvlUsdc) || 0,
        price: parseFloat(d.price) || 0,
        feeRate: d.feeRate ?? 0,
        volume24h: parseFloat(s24.volume) || 0,
        volume7d: parseFloat(s7d.volume) || 0,
        volume30d: parseFloat(s30d.volume) || 0,
        fees24h: parseFloat(s24.fees) || 0,
        fees7d: parseFloat(s7d.fees) || 0,
        fees30d: parseFloat(s30d.fees) || 0,
        yield24h: parseFloat(s24.yieldOverTvl) || 0,
        yield7d: parseFloat(s7d.yieldOverTvl) || 0,
        yield30d: parseFloat(s30d.yieldOverTvl) || 0,
        priceDelta24h: parseFloat(s24.priceDelta) || 0,
        volumeDelta24h: parseFloat(s24.volumeDelta) || 0,
        tokenBalanceA: (parseFloat(d.tokenBalanceA) || 0) / 1e9,
        tokenBalanceB: (parseFloat(d.tokenBalanceB) || 0) / 1e6,
        tickSpacing: d.tickSpacing ?? 0,
        lastFetched: now,
      };
      poolStatsFetchTime = now;
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', msg: 'pool stats fetch failed', error: String(err), timestamp: now }));
    }
  }

  app.get('/api/data', (_req, res) => {
    res.json({
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

  app.get('/api/rule2-perf', (_req, res) => {
    if (!dbRef) { res.status(500).json({ error: 'DB not available' }); return; }
    res.json(getRule2PerfComparison(dbRef));
  });

  app.get('/api/rule2-events.csv', (_req, res) => {
    if (!dbRef) { res.status(500).send('DB not available'); return; }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rebalance_events_rule2.csv"');
    res.send(getRule2EventsCsv(dbRef));
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

  // Config page + API
  app.get('/config', (_req, res) => {
    res.type('html').send(renderConfigHtml());
  });

  app.get('/api/config', (_req, res) => {
    res.json(exportConfig());
  });

  app.use(express.json());
  app.post('/api/config', (req, res) => {
    try {
      const entries = req.body as Record<string, string>;
      if (!entries || typeof entries !== 'object') {
        res.status(400).json({ error: 'Expected JSON object of key-value pairs' });
        return;
      }
      if (!dbRef) { res.status(500).json({ error: 'DB not initialized' }); return; }
      setConfigBatch(dbRef, entries);
      applyConfigFromDb(entries);
      console.log(JSON.stringify({ level: 'info', msg: `Config updated: ${Object.keys(entries).length} keys`, keys: Object.keys(entries), timestamp: Date.now() }));
      res.json({ success: true, updated: Object.keys(entries).length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
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

    // 13-20. Orca Pool Stats API
    try {
      await fetchPoolStats();
      if (poolStats) {
        const ps = poolStats;
        const ok = 'ok' as const;
        checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: ok, detail: `Last fetched: ${new Date(ps.lastFetched).toLocaleTimeString('en-US', { hour12: false })}`, lastChecked: now });
        checks.push({ name: 'Pool TVL', description: 'Total value locked in pool', status: ps.tvlUsdc > 0 ? ok : 'error', detail: `$${fmt(ps.tvlUsdc, 0)}`, lastChecked: now });
        checks.push({ name: 'Pool Volume (24h)', description: 'Trading volume last 24 hours', status: ok, detail: `$${fmt(ps.volume24h, 0)} | 7d: $${fmt(ps.volume7d, 0)} | 30d: $${fmt(ps.volume30d, 0)}`, lastChecked: now });
        checks.push({ name: 'Pool Fees (24h)', description: 'Fees generated last 24 hours', status: ok, detail: `$${fmt(ps.fees24h)} | 7d: $${fmt(ps.fees7d)} | 30d: $${fmt(ps.fees30d)}`, lastChecked: now });
        checks.push({ name: 'Pool APR', description: 'Annualized yield from fees', status: ok, detail: `24h: ${fmt(ps.yield24h * 365 * 100, 1)}% | 7d: ${fmt(ps.yield7d * (365/7) * 100, 1)}% | 30d: ${fmt(ps.yield30d * (365/30) * 100, 1)}%`, lastChecked: now });
        checks.push({ name: 'Pool Price', description: 'Orca pool SOL/USDC price', status: ps.price > 0 ? ok : 'error', detail: `$${fmt(ps.price)} | 24h change: ${ps.priceDelta24h >= 0 ? '+' : ''}${fmt(ps.priceDelta24h * 100, 2)}%`, lastChecked: now });
        checks.push({ name: 'Pool Balances', description: 'Token reserves in pool', status: ok, detail: `${fmt(ps.tokenBalanceA, 2)} SOL + ${fmt(ps.tokenBalanceB, 0)} USDC`, lastChecked: now });
        checks.push({ name: 'Pool Fee Rate', description: 'Swap fee tier', status: ok, detail: `${(ps.feeRate / 10000).toFixed(2)}% (${ps.feeRate / 100} bps) | tick spacing: ${ps.tickSpacing}`, lastChecked: now });
      } else {
        checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: 'error', detail: 'Failed to fetch pool stats', lastChecked: now });
      }
    } catch (err) { checks.push({ name: 'Orca API', description: 'Pool stats API connection', status: 'error', detail: String(err), lastChecked: now }); }

    healthChecks = checks;
    healthCheckRunning = false;
    return checks;
  }

  // Run health checks every 30 minutes
  setInterval(() => { runHealthChecks().catch((err) => { console.log(JSON.stringify({ level: 'error', msg: 'health check error', error: String(err), timestamp: Date.now() })); }); }, 30 * 60_000);

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
  app.get('/live', async (_req, res) => {
    await fetchPoolStats();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const allEvents = dbRef ? dbGetRebalanceEvents(dbRef, 50) : currentEvents;
    res.type('html').send(renderLiveHtml(currentLive, allEvents, uptime, poolStats, rule2Enabled, autoDeployEnabled));
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

  let onClosePosition: (() => Promise<void>) | null = null;

  app.post('/api/close-position', async (_req, res) => {
    if (onClosePosition) {
      try {
        await onClosePosition();
        res.json({ success: true, msg: 'Position closed. Bot paused in IDLE state. Click Resume to restart.' });
      } catch (err) {
        res.status(500).json({ success: false, msg: String(err) });
      }
    } else {
      res.status(400).json({ success: false, msg: 'No close-position handler registered.' });
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

  // Rule 2 toggle
  let onToggleRule2: ((enabled: boolean) => void) | null = null;
  let rule2Enabled = true;

  app.post('/api/toggle-rule2', (req, res) => {
    rule2Enabled = !rule2Enabled;
    if (onToggleRule2) {
      onToggleRule2(rule2Enabled);
    }
    res.json({ success: true, rule2Enabled, msg: rule2Enabled ? 'Rule 2 (proximity exit) enabled.' : 'Rule 2 (proximity exit) disabled. Positions will only close when fully out of range.' });
  });

  app.get('/api/rule2-status', (_req, res) => {
    res.json({ rule2Enabled });
  });

  // Auto-deploy toggle
  let onToggleAutoDeploy: ((enabled: boolean) => void) | null = null;
  let autoDeployEnabled = true;

  app.post('/api/toggle-auto-deploy', (_req, res) => {
    autoDeployEnabled = !autoDeployEnabled;
    if (onToggleAutoDeploy) {
      onToggleAutoDeploy(autoDeployEnabled);
    }
    res.json({ success: true, autoDeployEnabled, msg: autoDeployEnabled ? 'Auto capital deployment enabled.' : 'Auto capital deployment disabled.' });
  });

  app.get('/api/auto-deploy-status', (_req, res) => {
    res.json({ autoDeployEnabled });
  });

  // Add liquidity
  let onAddLiquidity: (() => Promise<{ solDeposited: number; usdcDeposited: number; totalUsdc: number; liquidityAdded: string }>) | null = null;
  let onAddLiquidityPreview: (() => Promise<{ solAvailable: number; usdcAvailable: number; totalAvailableUsdc: number; estSolDeposit: number; estUsdcDeposit: number; estTotalUsdc: number; positionRange: string; needsSwap: string } | null>) | null = null;

  app.get('/api/add-liquidity-preview', async (_req, res) => {
    if (!onAddLiquidityPreview) { res.status(400).json({ error: 'No handler registered' }); return; }
    try {
      const preview = await onAddLiquidityPreview();
      if (!preview) { res.json({ available: false, reason: 'No open position or insufficient wallet balance' }); return; }
      res.json({ available: true, ...preview });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/add-liquidity', async (_req, res) => {
    if (!onAddLiquidity) { res.status(400).json({ success: false, msg: 'No handler registered' }); return; }
    try {
      const result = await onAddLiquidity();
      res.json({ success: true, ...result, msg: `Added ${result.solDeposited.toFixed(4)} SOL + ${result.usdcDeposited.toFixed(2)} USDC ($${result.totalUsdc.toFixed(2)}) to position` });
    } catch (err) {
      res.status(500).json({ success: false, msg: String(err) });
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
    updateData(events, botState, dailyPnl) {
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
    onClosePosition(handler) {
      onClosePosition = handler;
    },
    onToggleRule2(handler) {
      onToggleRule2 = handler;
    },
    onToggleAutoDeploy(handler) {
      onToggleAutoDeploy = handler;
    },
    onAddLiquidity(handler) {
      onAddLiquidity = handler;
    },
    onAddLiquidityPreview(handler) {
      onAddLiquidityPreview = handler;
    },
    getRule2Enabled() {
      return rule2Enabled;
    },
    setRule2Enabled(enabled: boolean) {
      rule2Enabled = enabled;
    },
    getAutoDeployEnabled() {
      return autoDeployEnabled;
    },
    setAutoDeployEnabled(enabled: boolean) {
      autoDeployEnabled = enabled;
    },
    getPoolStats() {
      return poolStats;
    },
    setDb(d) {
      dbRef = d;
    },
    stop() {
      server.close();
    },
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  <a href="/config" id="nav-config">Config</a>
  <a href="/status" id="nav-status">Status</a>
</div>`;

// ── Paper page ────────────────────────────────────────────────────────────

function renderPaperHtml(data: {
  comparison: any;
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

function renderLiveHtml(live: LiveData | null, liveEvents: RebalanceEvent[], uptime: number, pool: PoolStats | null = null, rule2Enabled = true, autoDeployEnabled = true): string {
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
${pool ? `<div class="card" style="margin-top:12px">
  <h2>SOL/USDC Pool <span style="font-size:10px;color:#8b949e;font-weight:normal;text-transform:none;letter-spacing:0">(Orca Whirlpool &middot; tick ${pool.tickSpacing} &middot; ${(pool.feeRate / 10000).toFixed(2)}% fee)</span></h2>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#58a6ff">$${fmt(pool.tvlUsdc, 0)}</div>
      <div style="font-size:10px;color:#8b949e">TVL</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#22c55e">$${fmt(pool.volume24h, 0)}</div>
      <div style="font-size:10px;color:#8b949e">Volume 24h</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:bold;color:#eab308">${fmt(pool.yield24h * 365 * 100, 1)}%</div>
      <div style="font-size:10px;color:#8b949e">APR (24h)</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d"></th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">24h</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">7d</th>
      <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">30d</th>
    </tr></thead>
    <tbody>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Volume</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume24h, 0)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume7d, 0)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.volume30d, 0)}</td></tr>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Fees</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees24h)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees7d)}</td><td style="padding:6px 8px;text-align:right">$${fmt(pool.fees30d)}</td></tr>
      <tr style="border-bottom:1px solid #21262d"><td style="padding:6px 8px;color:#8b949e">Yield / TVL</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield24h * 100, 4)}%</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield7d * 100, 4)}%</td><td style="padding:6px 8px;text-align:right">${fmt(pool.yield30d * 100, 3)}%</td></tr>
      <tr><td style="padding:6px 8px;color:#8b949e">APR</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield24h * 365 * 100, 1)}%</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield7d * (365/7) * 100, 1)}%</td><td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield30d * (365/30) * 100, 1)}%</td></tr>
    </tbody>
  </table>
  <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#8b949e;flex-wrap:wrap">
    <span>Pool SOL: ${fmt(pool.tokenBalanceA, 2)}</span>
    <span>Pool USDC: ${fmt(pool.tokenBalanceB, 0)}</span>
    <span>Price 24h: <span style="color:${pool.priceDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.priceDelta24h >= 0 ? '+' : ''}${fmt(pool.priceDelta24h * 100, 2)}%</span></span>
    <span>Vol 24h: <span style="color:${pool.volumeDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.volumeDelta24h >= 0 ? '+' : ''}${fmt(pool.volumeDelta24h * 100, 1)}%</span> vs prior</span>
  </div>
</div>` : ''}
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
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">
        <tbody>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Price</td>
            <td style="padding:6px 8px;color:#f0883e;font-weight:bold">$${fmt(live.solPrice)}</td>
            <td style="padding:6px 8px;color:#8b949e">Prox &#x25BC;</td>
            <td style="padding:6px 8px"><b style="color:${proxDownPct >= downThreshPct ? '#f97316' : '#c9d1d9'}">${proxDownPct}%</b><span style="color:#8b949e">/${downThreshPct}%</span></td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Entry</td>
            <td style="padding:6px 8px;color:#a855f7;font-weight:bold">${live.entryPrice ? `$${fmt(live.entryPrice)}` : '--'}</td>
            <td style="padding:6px 8px;color:#8b949e">Prox &#x25B2;</td>
            <td style="padding:6px 8px"><b style="color:${proxUpPct >= upThreshPct ? '#58a6ff' : '#c9d1d9'}">${proxUpPct}%</b><span style="color:#8b949e">/${upThreshPct}%</span></td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">Range</td>
            <td style="padding:6px 8px;color:#8b949e">$${fmt(r.lower)}&#x2013;$${fmt(r.upper)}</td>
            <td style="padding:6px 8px;color:#8b949e">Now</td>
            <td style="padding:6px 8px;color:#f0883e">${fmt(live.positionSol, 4)} SOL + ${fmt(live.positionUsdc)} USDC</td>
          </tr>
          <tr style="border-bottom:1px solid #21262d">
            <td style="padding:6px 8px;color:#8b949e">R2 Exit</td>
            <td style="padding:6px 8px"><span style="color:#f97316">$${fmt(downsidePrice)}</span> <span style="color:#8b949e">/</span> <span style="color:#58a6ff">$${fmt(upsidePrice)}</span></td>
            <td style="padding:6px 8px;color:#8b949e">At entry</td>
            <td style="padding:6px 8px;color:#a855f7">${fmt(live.entrySol ?? 0, 4)} SOL + ${fmt(live.entryUsdc ?? 0)} USDC</td>
          </tr>
        </tbody>
      </table>`;
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
      REGIME_CHANGE: '#a855f7', LIQUIDITY_ADDED: '#22c55e',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="event-card">
      <div class="event-header">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span class="event-meta">${d} ${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div class="event-desc">${escHtml(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
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
<meta id="auto-refresh" http-equiv="refresh" content="30">
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
.ctrl-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:12px;margin-bottom:12px}
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
    <div class="row"><span class="label">Proximity Exit</span><span id="rule2-market-badge" class="badge" style="background:${rule2Enabled ? '#22c55e20' : '#f9731620'};color:${rule2Enabled ? '#22c55e' : '#f97316'}">${rule2Enabled ? 'ACTIVE' : 'BYPASSED'}</span></div>
    <div class="row"><span class="label">Auto Deploy</span><span id="autodeploy-market-badge" class="badge" style="background:${autoDeployEnabled ? '#22c55e20' : '#f9731620'};color:${autoDeployEnabled ? '#22c55e' : '#f97316'}">${autoDeployEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
  </div>

  <div class="card">
    <h2>Position Details</h2>
    <div class="row"><span class="label">Status</span><span class="value">${live.positionMint ? 'OPEN' : 'NONE'}</span></div>
    ${live.positionMint ? `
    <div class="row"><span class="label">SOL in Position</span><span class="value">${fmt(live.positionSol, 6)} <span style="color:#8b949e;font-weight:normal">($${fmt(live.positionSol * live.solPrice)})</span></span></div>
    <div class="row"><span class="label">USDC in Position</span><span class="value">${fmt(live.positionUsdc, 6)}</span></div>
    <div class="row"><span class="label">Position Value</span><span class="value" style="color:#58a6ff">$${fmt(live.positionValueUsdc)}</span></div>
    <div class="row"><span class="label">Entry Price</span><span class="value">$${fmt(live.entryPrice ?? 0)}</span></div>
    <div class="row"><span class="label">Est. Yield 24h</span><span class="value" style="color:#eab308">$${fmt(live.estDailyFeesUsdc, 4)}</span></div>
    <div class="row"><span class="label">Est. APR</span><span class="value" style="color:#eab308">${fmt(live.estAprPct, 1)}%</span></div>
    ${(() => {
      const solReserve = 0.05; const usdcReserve = 1;
      const idleSol = Math.max(0, live.solBalance - solReserve);
      const idleUsdcRaw = Math.max(0, live.usdcBalance - usdcReserve);
      const idleUsdc = idleSol * live.solPrice + idleUsdcRaw;
      const idealPrice = live.positionRange ? Math.sqrt(live.positionRange.lower * live.positionRange.upper).toFixed(2) : '--';
      const deviation = live.positionRange ? Math.abs(live.solPrice / Math.sqrt(live.positionRange.lower * live.positionRange.upper) - 1) * 100 : 0;
      return `<div class="row"><span class="label">Idle Capital</span><span class="value" style="color:${idleUsdc > 10 ? '#eab308' : '#8b949e'}">$${fmt(idleUsdc)}</span></div>
    <div class="row"><span class="label">Ideal Deploy Price</span><span class="value">$${idealPrice} <span style="color:#8b949e;font-weight:normal">(${deviation.toFixed(1)}% off)</span></span></div>`;
    })()}
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

  ${pool ? `<div class="card full">
    <h2>SOL/USDC Pool <span style="font-size:10px;color:#8b949e;font-weight:normal;text-transform:none;letter-spacing:0">(Orca Whirlpool &middot; tick ${pool.tickSpacing} &middot; ${(pool.feeRate / 10000).toFixed(2)}% fee)</span></h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#58a6ff">$${fmt(pool.tvlUsdc, 0)}</div>
        <div style="font-size:10px;color:#8b949e">TVL</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#22c55e">$${fmt(pool.volume24h, 0)}</div>
        <div style="font-size:10px;color:#8b949e">Volume 24h</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:bold;color:#eab308">${fmt(pool.yield24h * 365 * 100, 1)}%</div>
        <div style="font-size:10px;color:#8b949e">APR (24h)</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d"></th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">24h</th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">7d</th>
          <th style="text-align:right;padding:6px 8px;color:#8b949e;border-bottom:1px solid #30363d">30d</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Volume</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume24h, 0)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume7d, 0)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.volume30d, 0)}</td>
        </tr>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Fees</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees24h)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees7d)}</td>
          <td style="padding:6px 8px;text-align:right">$${fmt(pool.fees30d)}</td>
        </tr>
        <tr style="border-bottom:1px solid #21262d">
          <td style="padding:6px 8px;color:#8b949e">Yield / TVL</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield24h * 100, 4)}%</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield7d * 100, 4)}%</td>
          <td style="padding:6px 8px;text-align:right">${fmt(pool.yield30d * 100, 3)}%</td>
        </tr>
        <tr>
          <td style="padding:6px 8px;color:#8b949e">APR</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield24h * 365 * 100, 1)}%</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield7d * (365/7) * 100, 1)}%</td>
          <td style="padding:6px 8px;text-align:right;color:#eab308;font-weight:bold">${fmt(pool.yield30d * (365/30) * 100, 1)}%</td>
        </tr>
      </tbody>
    </table>
    <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#8b949e;flex-wrap:wrap">
      <span>Pool SOL: ${fmt(pool.tokenBalanceA, 2)}</span>
      <span>Pool USDC: ${fmt(pool.tokenBalanceB, 0)}</span>
      <span>Price 24h: <span style="color:${pool.priceDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.priceDelta24h >= 0 ? '+' : ''}${fmt(pool.priceDelta24h * 100, 2)}%</span></span>
      <span>Vol 24h: <span style="color:${pool.volumeDelta24h >= 0 ? '#22c55e' : '#ef4444'}">${pool.volumeDelta24h >= 0 ? '+' : ''}${fmt(pool.volumeDelta24h * 100, 1)}%</span> vs prior</span>
    </div>
  </div>` : ''}

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
        <button id="close-pos-btn" class="ctrl-btn ctrl-amber" onclick="stopAutoRefresh();document.getElementById('close-pos-confirm').style.display='block'">
          Close Position
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Closes position, bot stays running in IDLE.</div>
      </div>
      <div>
        <button id="estop-btn" class="ctrl-btn ctrl-red" onclick="stopAutoRefresh();document.getElementById('stop-confirm').style.display='block'">
          Close &amp; Stop
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">Closes position, withdraws all, shuts down.</div>
      </div>
      <div>
        <button id="rule2-btn" class="ctrl-btn ${rule2Enabled ? 'ctrl-amber' : 'ctrl-green'}" onclick="toggleRule2()">
          ${rule2Enabled ? 'Disable' : 'Enable'} Rule 2
        </button>
        <div style="font-size:10px;margin-top:4px;text-align:center"><span id="rule2-status" style="color:${rule2Enabled ? '#22c55e' : '#f97316'};font-weight:600">${rule2Enabled ? 'ACTIVE' : 'BYPASSED'}</span> <span style="color:#8b949e">— Proximity early exit.</span></div>
      </div>
      <div>
        <button id="add-liq-btn" class="ctrl-btn ctrl-blue" onclick="previewAddLiquidity()" ${live?.positionMint ? '' : 'disabled'}>
          Add Liquidity
        </button>
        <div style="font-size:10px;color:#8b949e;margin-top:4px;text-align:center">${live?.positionMint ? 'Add wallet balance to open position.' : 'No open position.'}</div>
      </div>
      <div>
        <button id="autodeploy-btn" class="ctrl-btn ${autoDeployEnabled ? 'ctrl-amber' : 'ctrl-green'}" onclick="toggleAutoDeploy()">
          ${autoDeployEnabled ? 'Disable' : 'Enable'} Auto Deploy
        </button>
        <div style="font-size:10px;margin-top:4px;text-align:center"><span id="autodeploy-status" style="color:${autoDeployEnabled ? '#22c55e' : '#f97316'};font-weight:600">${autoDeployEnabled ? 'ENABLED' : 'DISABLED'}</span> <span style="color:#8b949e">— Auto capital deployment.</span></div>
      </div>
    </div>
    <div id="ctrl-result" style="font-size:12px;text-align:center;min-height:20px"></div>
    <div class="stop-confirm" id="close-pos-confirm">
      <p style="color:#d97706;font-weight:bold;margin-bottom:8px">Close position?</p>
      <p style="color:#8b949e;font-size:12px;margin-bottom:12px">This will close your liquidity position on-chain. The bot stays running in IDLE. Click Resume to open a new position.</p>
      <button class="ctrl-btn ctrl-amber" id="confirm-close-pos-btn" onclick="executeClosePosition()">
        Yes, Close Position
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('close-pos-confirm').style.display='none'">
        Cancel
      </button>
      <div id="close-pos-result" style="margin-top:12px;font-size:12px"></div>
    </div>
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
    <div class="stop-confirm" id="add-liq-confirm" style="display:none">
      <p style="color:#58a6ff;font-weight:bold;margin-bottom:8px">Add Liquidity to Position</p>
      <div id="add-liq-preview" style="font-size:12px;color:#c9d1d9;margin-bottom:12px">Loading preview...</div>
      <button class="ctrl-btn ctrl-blue" id="confirm-add-liq-btn" onclick="executeAddLiquidity()">
        Yes, Add Liquidity
      </button>
      <button style="background:#30363d;color:#c9d1d9;border:none;padding:10px 24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%;margin-top:8px" onclick="document.getElementById('add-liq-confirm').style.display='none'">
        Cancel
      </button>
      <div id="add-liq-result" style="margin-top:12px;font-size:12px"></div>
    </div>
  </div>


</div>

<script>
window.__LIVE_DATA__ = ${JSON.stringify(live)};

function stopAutoRefresh() {
  var meta = document.getElementById('auto-refresh');
  if (meta) meta.remove();
}

function harvestFees() {
  stopAutoRefresh();
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
  stopAutoRefresh();
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

function toggleRule2() {
  var btn = document.getElementById('rule2-btn');
  var status = document.getElementById('rule2-status');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">Toggling Rule 2...</span>';

  fetch('/api/toggle-rule2', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        var mBadge = document.getElementById('rule2-market-badge');
        if (data.rule2Enabled) {
          btn.textContent = 'Disable Rule 2';
          btn.className = 'ctrl-btn ctrl-amber';
          status.textContent = 'ACTIVE';
          status.style.color = '#22c55e';
          if (mBadge) { mBadge.textContent = 'ACTIVE'; mBadge.style.background = '#22c55e20'; mBadge.style.color = '#22c55e'; }
        } else {
          btn.textContent = 'Enable Rule 2';
          btn.className = 'ctrl-btn ctrl-green';
          status.textContent = 'BYPASSED';
          status.style.color = '#f97316';
          if (mBadge) { mBadge.textContent = 'BYPASSED'; mBadge.style.background = '#f9731620'; mBadge.style.color = '#f97316'; }
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
      btn.disabled = false;
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function toggleAutoDeploy() {
  var btn = document.getElementById('autodeploy-btn');
  var status = document.getElementById('autodeploy-status');
  var result = document.getElementById('ctrl-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:#eab308">Toggling Auto Deploy...</span>';

  fetch('/api/toggle-auto-deploy', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        var mBadge = document.getElementById('autodeploy-market-badge');
        if (data.autoDeployEnabled) {
          btn.textContent = 'Disable Auto Deploy';
          btn.className = 'ctrl-btn ctrl-amber';
          status.textContent = 'ENABLED';
          status.style.color = '#22c55e';
          if (mBadge) { mBadge.textContent = 'ENABLED'; mBadge.style.background = '#22c55e20'; mBadge.style.color = '#22c55e'; }
        } else {
          btn.textContent = 'Enable Auto Deploy';
          btn.className = 'ctrl-btn ctrl-green';
          status.textContent = 'DISABLED';
          status.style.color = '#f97316';
          if (mBadge) { mBadge.textContent = 'DISABLED'; mBadge.style.background = '#f9731620'; mBadge.style.color = '#f97316'; }
        }
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
      }
      btn.disabled = false;
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
    });
}

function previewAddLiquidity() {
  stopAutoRefresh();
  var preview = document.getElementById('add-liq-preview');
  var confirmDiv = document.getElementById('add-liq-confirm');
  var resultDiv = document.getElementById('add-liq-result');
  resultDiv.innerHTML = '';
  preview.innerHTML = '<span style="color:#eab308">Loading preview...</span>';
  confirmDiv.style.display = 'block';

  fetch('/api/add-liquidity-preview')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.available) {
        preview.innerHTML = '<span style="color:#ef4444">' + (data.reason || 'Not available') + '</span>';
        document.getElementById('confirm-add-liq-btn').disabled = true;
        return;
      }
      document.getElementById('confirm-add-liq-btn').disabled = false;
      preview.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:8px">' +
        '<span style="color:#8b949e">Position Range</span><span>' + data.positionRange + '</span>' +
        '<span style="color:#8b949e">Available SOL</span><span>' + data.solAvailable.toFixed(4) + ' SOL</span>' +
        '<span style="color:#8b949e">Available USDC</span><span>$' + data.usdcAvailable.toFixed(2) + '</span>' +
        '<span style="color:#8b949e">Total Available</span><span style="color:#58a6ff;font-weight:bold">$' + data.totalAvailableUsdc.toFixed(2) + '</span>' +
        '</div>' +
        '<div style="border-top:1px solid #21262d;padding-top:8px;margin-top:4px">' +
        '<div style="color:#8b949e;margin-bottom:4px">Estimated deposit:</div>' +
        '<div style="font-weight:bold;color:#22c55e">' + data.estSolDeposit.toFixed(4) + ' SOL + $' + data.estUsdcDeposit.toFixed(2) + ' USDC = $' + data.estTotalUsdc.toFixed(2) + '</div>' +
        (data.needsSwap !== 'none' ? '<div style="color:#eab308;font-size:11px;margin-top:4px">Swap needed: ' + data.needsSwap + '</div>' : '') +
        '</div>';
    })
    .catch(function(err) {
      preview.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
    });
}

function executeAddLiquidity() {
  var btn = document.getElementById('confirm-add-liq-btn');
  var result = document.getElementById('add-liq-result');
  btn.disabled = true;
  btn.textContent = 'Adding liquidity...';
  result.innerHTML = '<span style="color:#eab308">Executing swap + deposit on Solana...</span>';

  fetch('/api/add-liquidity', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
        setTimeout(function() { location.reload(); }, 3000);
      } else {
        result.innerHTML = '<span style="color:#ef4444">' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Yes, Add Liquidity';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Yes, Add Liquidity';
    });
}

function executeClosePosition() {
  var btn = document.getElementById('confirm-close-pos-btn');
  var result = document.getElementById('close-pos-result');
  btn.disabled = true;
  btn.textContent = 'Closing position...';
  result.innerHTML = '<span style="color:#eab308">Sending close transaction to Solana...</span>';

  fetch('/api/close-position', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        result.innerHTML = '<span style="color:#22c55e">' + data.msg + '</span>';
      } else {
        result.innerHTML = '<span style="color:#ef4444">Error: ' + data.msg + '</span>';
        btn.disabled = false;
        btn.textContent = 'Retry Close Position';
      }
    })
    .catch(function(err) {
      result.innerHTML = '<span style="color:#ef4444">Error: ' + err + '</span>';
      btn.disabled = false;
      btn.textContent = 'Retry Close Position';
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
  // Detect capital injections from snapshot jumps (covers both LIQUIDITY_ADDED and wallet deposits)
  // An injection is a jump where wallet balance increases significantly between consecutive snapshots
  // that can't be explained by price movement alone (price would need to change >50% in one cycle)
  interface Injection { timestamp: number; amount: number; price: number }
  const detectedInjections: Injection[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    const prevTotal = (prev as any).total_with_position ?? prev.total_value_usdc;
    const currTotal = (curr as any).total_with_position ?? curr.total_value_usdc;
    const jump = currTotal - prevTotal;
    // If total jumped by more than 5% of previous value in a single cycle, it's likely an injection
    // (SOL price can't move 5%+ in 30 seconds under normal conditions)
    if (jump > Math.max(5, prevTotal * 0.05)) {
      detectedInjections.push({ timestamp: curr.timestamp, amount: jump, price: curr.price });
    }
  }
  // Also include LIQUIDITY_ADDED events not captured by snapshot jumps (e.g. if position value stayed flat)
  const liqEvents = data.events.filter(e => e.eventType === 'LIQUIDITY_ADDED');
  const totalInjected = detectedInjections.reduce((sum, inj) => sum + inj.amount, 0);

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

    // Mark capital injections as vertical dashed lines
    const tMin = snaps[0].timestamp;
    const tMax = snaps[snaps.length - 1].timestamp;
    const tRange = tMax - tMin || 1;
    const injectionMarkers = detectedInjections
      .filter(inj => inj.timestamp >= tMin && inj.timestamp <= tMax)
      .map(inj => {
        const x = ((inj.timestamp - tMin) / tRange) * w + 10;
        return `<line x1="${x}" y1="5" x2="${x}" y2="${h}" stroke="#a855f7" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${x}" y="${h + 9}" text-anchor="middle" fill="#a855f7" font-size="8">+$${fmt(inj.amount, 0)}</text>`;
      }).join('');

    chartSvg = `
      <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2"/>
      ${injectionMarkers}
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
      LIQUIDITY_ADDED: '#22c55e', RULE2_ENABLED: '#22c55e', RULE2_DISABLED: '#f97316',
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
  ${detectedInjections.length > 0 ? `<div style="font-size:11px;color:#a855f7;margin-bottom:6px">Capital injected: $${fmt(totalInjected, 2)} (${detectedInjections.length} event${detectedInjections.length > 1 ? 's' : ''}) — marked with <span style="border-left:2px dashed #a855f7;padding-left:4px">dashed lines</span></div>` : ''}
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

  // Detect capital injections from 7d snapshot jumps (same logic as 24h chart)
  const dailyInjections = new Map<string, number>();
  const allSnaps7d = data.snapshots7d;
  for (let i = 1; i < allSnaps7d.length; i++) {
    const prev = allSnaps7d[i - 1];
    const curr = allSnaps7d[i];
    const prevTotal = (prev as any).total_with_position ?? prev.total_value_usdc;
    const currTotal = (curr as any).total_with_position ?? curr.total_value_usdc;
    const jump = currTotal - prevTotal;
    if (jump > Math.max(5, prevTotal * 0.05)) {
      const date = new Date(curr.timestamp).toISOString().slice(0, 10);
      dailyInjections.set(date, (dailyInjections.get(date) ?? 0) + jump);
    }
  }

  if (days.length === 0) return '<div class="card" style="margin-bottom:16px"><h2>Daily Portfolio Value (7 days)</h2><div style="color:#8b949e;text-align:center;padding:20px">Collecting data...</div></div>';

  const maxVal = Math.max(...days.map(d => d[1].total));
  const minVal = Math.min(...days.map(d => d[1].total));
  const barW = Math.floor(500 / days.length) - 8;
  const chartH = 100;
  const topPad = 35; // space for labels above bars
  const baseY = chartH + topPad;
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
    const rawChange = i > 0 ? val.total - days[i-1][1].total : 0;
    const injected = dailyInjections.get(date) ?? 0;
    const organicChange = rawChange - injected;
    const changeCol = organicChange >= 0 ? '#22c55e' : '#ef4444';
    const injLabel = injected > 0 ? `<text x="${x + barW/2}" y="${Math.max(10, y - 23)}" text-anchor="middle" fill="#a855f7" font-size="8">+$${fmt(injected, 0)} injected</text>` : '';
    return `
      <rect x="${x}" y="${y + walH}" width="${barW}" height="${posH}" fill="#58a6ff" rx="0"/>
      <rect x="${x}" y="${y}" width="${barW}" height="${walH}" fill="#22c55e80" rx="2"/>
      <text x="${x + barW/2}" y="${baseY + 12}" text-anchor="middle" fill="#8b949e" font-size="9">${dayLabel}</text>
      <text x="${x + barW/2}" y="${baseY + 22}" text-anchor="middle" fill="#8b949e" font-size="8">${dayName}</text>
      <text x="${x + barW/2}" y="${Math.max(topPad + 5, y - 3)}" text-anchor="middle" fill="#c9d1d9" font-size="9">$${fmt(val.total, 0)}</text>
      ${i > 0 ? `<text x="${x + barW/2}" y="${Math.max(topPad - 5, y - 13)}" text-anchor="middle" fill="${changeCol}" font-size="8">${organicChange >= 0 ? '+' : ''}${fmt(organicChange, 2)} organic</text>` : ''}
      ${injLabel}`;
  }).join('');

  return `<div class="card" style="margin-bottom:16px">
  <h2>Daily Portfolio Value (7 days) — <span style="color:#22c55e80">Wallet</span> + <span style="color:#58a6ff">Position</span>${dailyInjections.size > 0 ? ' + <span style="color:#a855f7">Injections</span>' : ''}</h2>
  <svg width="100%" height="170" viewBox="0 0 600 170" preserveAspectRatio="xMidYMid meet">
    <text x="5" y="${topPad + 5}" fill="#8b949e" font-size="9">$${fmt(maxVal, 0)}</text>
    <text x="5" y="${baseY}" fill="#8b949e" font-size="9">$${fmt(minVal, 0)}</text>
    <line x1="35" y1="${topPad}" x2="35" y2="${baseY}" stroke="#21262d" stroke-width="1"/>
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
      REGIME_CHANGE: '#a855f7', LIQUIDITY_ADDED: '#22c55e',
    };
    const col = typeColors[e.eventType] || '#8b949e';
    return `<div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="badge" style="background:${col}20;color:${col}">${e.eventType}</span>
        <span style="color:#8b949e;font-size:11px">${t} &middot; $${fmt(e.price)} &middot; ${e.regime}</span>
      </div>
      <div style="font-size:12px;color:#c9d1d9;line-height:1.5">${escHtml(e.note || 'No description').replace(/\n/g, '<br/>')}</div>
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
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">Decision logs are recorded every 30 minutes (HOLD) and regime evaluations every 1 hour. Download for offline analysis.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <a href="/api/export" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Full JSON Export</a>
    <a href="/api/decisions?limit=500" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Decision Log (500)</a>
    <a href="/api/snapshots?hours=168" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Snapshots (7 days)</a>
    <a href="/api/regime-history" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Regime History</a>
    <a href="/api/rule2-perf" target="_blank" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Rule 2 Performance (JSON)</a>
    <a href="/api/rule2-events.csv" style="background:#21262d;color:#58a6ff;padding:10px 12px;border-radius:6px;text-decoration:none;font-size:12px;text-align:center">Events CSV (with Rule 2 flag)</a>
  </div>
</div>

</body>
</html>`;
}

// ── Config page ──────────────────────────────────────────────────────────

function renderConfigHtml(): string {
  const c = runtime;
  const rp = c.regimeParams;
  const regimes = ['RANGING', 'BULLISH_TREND', 'BEARISH_TREND', 'EXTREME'] as const;
  const rpFields = [
    { key: 'rangeWidthPct', label: 'Range width %', desc: 'Width of LP position as % of price. Tighter = more fees but more OOR.', ex: '1.5→2%: range goes from ~$1.28 to ~$1.70 at $85 SOL.' },
    { key: 'skewDown', label: 'Skew down', desc: 'Fraction of range below current price (0-1). Higher = more downside room.', ex: '0.30→0.50: symmetric range. 0.30: 30% below, 70% above.' },
    { key: 'skewUp', label: 'Skew up', desc: 'Fraction of range above current price (0-1). Auto = 1 - skewDown.', ex: '0.70→0.50: symmetric. Should sum to 1.0 with skewDown.' },
    { key: 'proxThresholdLower', label: 'Downside exit %', desc: 'Rule 2 fires when proximity to lower bound reaches this (0-1).', ex: '0.65→0.50: exits earlier (halfway to bound). Less IL but more rebalances.' },
    { key: 'proxThresholdUpper', label: 'Upside exit %', desc: 'Rule 2 fires when proximity to upper bound reaches this (0-1).', ex: '0.88→0.95: holds almost to bound. More fees but risks full OOR.' },
    { key: 'deployPct', label: 'Deploy %', desc: 'Fraction of total capital deployed into position (0-1). Rest = reserve.', ex: '1.00→0.75: keeps 25% as reserve. Less fees but safer in volatility.' },
    { key: 'solReentrySplit', label: 'SOL re-entry split', desc: 'Target SOL fraction of wallet after downside exit (0-1).', ex: '0.50→0.30: hold 30% SOL / 70% USDC. Less SOL exposure on drops.' },
    { key: 'harvestIntervalDays', label: 'Harvest days', desc: 'Collect fees every N days. Lower = lock gains sooner.', ex: '7→3: harvest twice a week instead of once. More TXs but locks gains.' },
    { key: 'harvestSolConvertPct', label: 'SOL→USDC harvest %', desc: 'After harvest, convert this % of SOL fees to USDC (0-1).', ex: '0→0.50: convert half of harvested SOL to USDC. De-risks gains.' },
  ];

  function rpRow(field: typeof rpFields[0]): string {
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#8b949e;font-size:11px;min-width:120px" title="${field.desc}&#10;&#10;Example: ${field.ex}">${field.label} <span style="color:#30363d;cursor:help" title="${field.desc}&#10;&#10;Example: ${field.ex}">&#x2753;</span></td>
      ${regimes.map(r => `<td style="padding:4px 6px"><input type="number" step="any" class="cfg-input" data-key="regime.${r}.${field.key}" value="${(rp[r] as any)[field.key]}" style="width:60px"></td>`).join('')}
    </tr>`;
  }

  function field(key: string, value: string | number, label: string, desc: string, ex: string, inputType = 'number'): string {
    const inputStyle = 'background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px;width:80px';
    const isToggle = inputType === 'toggle';
    const inputHtml = isToggle
      ? `<select class="cfg-input" data-key="${key}" style="${inputStyle};width:90px"><option value="null" ${value === 'null' ? 'selected' : ''}>OFF</option><option value="${typeof value === 'number' ? value : ''}" ${value !== 'null' && value !== '' ? 'selected' : ''}>ON</option></select>`
      : `<input type="${inputType}" step="any" class="cfg-input" data-key="${key}" value="${value}" style="${inputStyle}">`;
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:8px;color:#c9d1d9;font-size:12px">${label}</td>
      <td style="padding:8px">${inputHtml}</td>
      <td style="padding:8px;color:#8b949e;font-size:11px;max-width:250px">${desc}</td>
      <td style="padding:8px;color:#58a6ff;font-size:11px;max-width:250px">${ex}</td>
    </tr>`;
  }

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOL/USDC LP Bot - Configuration</title>
<style>${SHARED_STYLES}
.cfg-section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.cfg-section h3{color:#58a6ff;font-size:14px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #21262d}
.cfg-input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px}
.cfg-input:focus{border-color:#58a6ff;outline:none}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 8px;color:#8b949e;font-size:11px;border-bottom:1px solid #30363d}
.save-bar{position:sticky;bottom:0;background:#0d1117;border-top:2px solid #58a6ff;padding:12px 16px;display:flex;align-items:center;gap:12px;z-index:10}
.save-btn{background:#238636;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer}
.save-btn:hover{background:#2ea043}
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
.modal-box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:450px;width:90%}
.modal-box h3{color:#f0883e;margin-bottom:12px}
.modal-box p{color:#c9d1d9;font-size:13px;line-height:1.6;margin-bottom:16px}
.modal-btns{display:flex;gap:12px;justify-content:flex-end}
.modal-btns button{padding:8px 20px;border-radius:6px;border:none;font-size:13px;cursor:pointer}
.btn-cancel{background:#21262d;color:#c9d1d9}
.btn-confirm{background:#da3633;color:#fff}
#save-status{font-size:13px}
</style></head><body>
<div class="banner">
  <div class="mode" style="color:#f0883e">Configuration</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">All changes take effect immediately. No restart required.</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-config').classList.add('active')</script>

<!-- SECTION 1: Decision Loop -->
<div class="cfg-section">
  <h3>1. Decision Loop</h3>
  <table>
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('decisionIntervalSeconds', c.decisionIntervalSeconds, 'Cycle interval (sec)', 'How often the bot reads price and makes decisions.', 'At 30s: faster OOR detection but 2x RPC calls. At 120s: saves RPC but slower reaction.')}
    ${field('regimeWindowDays', c.regimeWindowDays, 'Regime window (days)', 'Days of daily closes for regime detection.', 'At 14 days: smoother regime, slower to react. At 3 days: reactive but may flap.')}
    ${field('trendThreshold', c.trendThreshold, 'Trend threshold', 'dirRatio above this = trending. Higher = stays RANGING longer.', 'At 0.50: only strong trends flip regime. At 0.20: even mild trends trigger.')}
  </table>
</div>

<!-- SECTION 2: Position Rules -->
<div class="cfg-section">
  <h3>2. Position Rules</h3>
  <table style="margin-bottom:16px">
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    <tr style="border-bottom:1px solid #21262d">
      <td style="padding:8px;color:#c9d1d9;font-size:12px">Range width override</td>
      <td style="padding:8px">
        <select id="rwo-toggle" class="cfg-input" style="width:60px" onchange="document.getElementById('rwo-val').style.display=this.value==='on'?'inline':'none'">
          <option value="off" ${c.rangeWidthOverride == null ? 'selected' : ''}>OFF</option>
          <option value="on" ${c.rangeWidthOverride != null ? 'selected' : ''}>ON</option>
        </select>
        <input type="number" step="any" id="rwo-val" class="cfg-input" data-key="rangeWidthOverride" value="${c.rangeWidthOverride ?? 1.5}" style="width:60px;margin-left:4px;${c.rangeWidthOverride == null ? 'display:none' : ''}">
      </td>
      <td style="padding:8px;color:#8b949e;font-size:11px">Force fixed range width regardless of regime. OFF = adaptive.</td>
      <td style="padding:8px;color:#58a6ff;font-size:11px">ON at 1.5%: always tight range. OFF: adapts 1.5-6% by regime.</td>
    </tr>
  </table>
  <div style="color:#8b949e;font-size:11px;margin-bottom:8px">Per-regime parameters (hover <span style="color:#30363d">&#x2753;</span> for description + example):</div>
  <div style="overflow-x:auto">
  <table>
    <tr>
      <th></th>
      <th style="color:#4a9eff;text-align:center">Ranging</th>
      <th style="color:#22c55e;text-align:center">Bullish</th>
      <th style="color:#ef4444;text-align:center">Bearish</th>
      <th style="color:#a855f7;text-align:center">Extreme</th>
    </tr>
    ${rpFields.map(f => rpRow(f)).join('')}
  </table>
  </div>
</div>

<!-- SECTION 3: Capital & Reserves -->
<div class="cfg-section">
  <h3>3. Capital &amp; Reserves</h3>
  <table>
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('maxLiveCapitalUsdc', c.maxLiveCapitalUsdc, 'Max live capital ($)', 'Safety cap. Bot refuses to start if wallet exceeds this.', 'At $10k: allows large wallet. At $500: stops on accidental deposits.')}
    ${field('solReserve', c.solReserve, 'SOL reserve', 'Always kept for gas + rent. Never deposited.', 'At 0.2: more buffer for rapid rebalancing (~$17 idle).')}
    ${field('usdcReserve', c.usdcReserve, 'USDC reserve ($)', 'Minimum USDC always in wallet.', 'At $5: more buffer. At $0: risk token account errors.')}
    ${field('minPositionSizeUsdc', c.minPositionSizeUsdc, 'Min position size ($)', 'Won&#39;t open below this. Prevents dust positions.', 'At $500: only meaningful positions. At $50: allows small deploys.')}
  </table>
</div>

<!-- SECTION 4: Auto Deploy -->
<div class="cfg-section">
  <h3>4. Auto Deploy (Rule 7)</h3>
  <table>
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('autoDeployCheckMinutes', c.autoDeployCheckMinutes, 'Check frequency (min)', 'How often to check for idle funds. Each check = 2 RPC calls.', 'At 10 min: half RPC cost. At 1 min: very responsive but noisy.')}
    ${field('autoDeployCooldownMinutes', c.autoDeployCooldownMinutes, 'Cooldown (min)', 'Minimum time between deployments.', 'At 15 min: faster cleanup of swap leftovers. At 60: less activity.')}
    ${field('minIdleUsdc', c.minIdleUsdc, 'Min idle USDC ($)', 'Min idle USDC after reserve to trigger deploy.', 'At $20: ignores small amounts. At $1: deploys tiny leftovers.')}
    ${field('minIdleSol', c.minIdleSol, 'Min idle SOL', 'Min idle SOL after reserve to trigger deploy.', 'At 0.5 SOL (~$42): only meaningful amounts. At 0.01: deploys dust.')}
    ${field('minDeployUsdc', c.minDeployUsdc, 'Min deploy ($)', 'Min total deployable value to trigger.', 'At $50: only worthwhile deploys. At $5: deploys very small amounts.')}
    ${field('deployRatioTolerance', c.deployRatioTolerance, 'Price ratio tolerance', 'Max deviation from geometric mean (0-1). Wider = more deploy opportunities.', 'At 0.05: deploys even near range edges. At 0.01: only near center.')}
  </table>
</div>

<!-- SECTION 5: Re-entry -->
<div class="cfg-section">
  <h3>5. Re-entry (Rule 3)</h3>
  <table>
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('pullbackThresholdPct', c.pullbackThresholdPct, 'Pullback threshold (%)', 'Price must drop this % from peak to re-enter.', 'At 5%: bigger pullback, better entry but longer wait. At 1%: quick re-entry.')}
    ${field('timeoutHours', c.timeoutHours, 'Timeout (hours)', 'Re-enter after this long even without pullback.', 'At 8h: more patience. At 1h: re-enters quickly, prioritizes fee earning.')}
    ${field('flashCrashPct', c.flashCrashPct, 'Flash crash threshold (%)', 'Drop this % in ~5 min = flash crash. Triggers cooldown.', 'At 10%: only extreme crashes trigger. At 3%: even moderate drops pause.')}
    ${field('flashCrashWaitMinutes', c.flashCrashWaitMinutes, 'Flash crash cooldown (min)', 'Block re-entry for this long after crash. Also resets peak + timeout.', 'At 30 min: more settle time. At 5 min: minimal wait.')}
  </table>
</div>

<!-- SECTION 6: Circuit Breakers -->
<div class="cfg-section">
  <h3>6. Circuit Breakers</h3>
  <table>
    <tr><th>Parameter</th><th>Value</th><th>Description</th><th>Example</th></tr>
    ${field('dailyLossLimitPct', c.dailyLossLimitPct, 'Daily loss limit (%)', 'HALT if portfolio drops more than this in a day.', 'At 10%: more tolerance for volatile days. At 3%: very conservative.')}
    ${field('weeklyDrawdownLimitPct', c.weeklyDrawdownLimitPct, 'Weekly drawdown (%)', 'HALT if portfolio drops this from weekly peak.', 'At 25%: allows larger drawdown. At 10%: halts early in downtrends.')}
    ${field('maxIlPct', c.maxIlPct, 'Max IL (%)', 'Force rebalance if IL exceeds this on any position.', 'At 15%: allows more IL (wider ranges). At 5%: very tight IL control.')}
    ${field('rebalanceLoopLimit', c.rebalanceLoopLimit, 'Rebalance limit (/hour)', 'Max close+reopen cycles per hour.', 'At 20: more activity in volatile markets. At 5: stricter limit.')}
  </table>
</div>

<!-- SAVE BAR -->
<div class="save-bar">
  <button class="save-btn" onclick="showConfirm()">Save Configuration</button>
  <span id="save-status"></span>
</div>

<!-- CONFIRMATION MODAL -->
<div class="modal-overlay" id="confirm-modal">
  <div class="modal-box">
    <h3>Confirm Configuration Change</h3>
    <p>These changes take effect <b>immediately</b> on the running bot. No restart required.<br><br>
    <span id="change-count"></span> parameter(s) will be updated.</p>
    <div id="change-list" style="max-height:200px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:8px;font-size:11px;color:#8b949e;margin-bottom:12px"></div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="hideConfirm()">Cancel</button>
      <button class="btn-confirm" onclick="doSave()">Apply Changes</button>
    </div>
  </div>
</div>

<script>
var originalValues = {};
document.querySelectorAll('.cfg-input').forEach(function(el) {
  originalValues[el.dataset.key || el.id] = el.value;
});

function getChanges() {
  var changes = {};
  document.querySelectorAll('.cfg-input').forEach(function(el) {
    var key = el.dataset.key;
    if (!key) return;
    var val = el.value;
    // Handle range width override toggle
    if (key === 'rangeWidthOverride') {
      var toggle = document.getElementById('rwo-toggle');
      if (toggle.value === 'off') val = 'null';
    }
    if (val !== originalValues[key]) {
      changes[key] = val;
    }
  });
  return changes;
}

function showConfirm() {
  var changes = getChanges();
  var keys = Object.keys(changes);
  if (keys.length === 0) {
    document.getElementById('save-status').textContent = 'No changes to save.';
    document.getElementById('save-status').style.color = '#8b949e';
    return;
  }
  document.getElementById('change-count').textContent = keys.length;
  var list = keys.map(function(k) {
    return '<div style="padding:2px 0"><span style="color:#58a6ff">' + k + '</span>: ' + (originalValues[k] || '(default)') + ' → <b style="color:#f0883e">' + changes[k] + '</b></div>';
  }).join('');
  document.getElementById('change-list').innerHTML = list;
  document.getElementById('confirm-modal').style.display = 'flex';
}

function hideConfirm() {
  document.getElementById('confirm-modal').style.display = 'none';
}

function doSave() {
  hideConfirm();
  var changes = getChanges();
  var status = document.getElementById('save-status');
  status.textContent = 'Saving...';
  status.style.color = '#f0883e';
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes)
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.success) {
      status.textContent = 'Saved ' + data.updated + ' parameter(s). Changes are live.';
      status.style.color = '#22c55e';
      // Update original values to reflect saved state
      Object.keys(changes).forEach(function(k) { originalValues[k] = changes[k]; });
    } else {
      status.textContent = 'Error: ' + (data.error || 'unknown');
      status.style.color = '#ef4444';
    }
  }).catch(function(err) {
    status.textContent = 'Error: ' + err;
    status.style.color = '#ef4444';
  });
}
</script>
</body></html>`;
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
.param-grid{background:#30363d;border-radius:8px;overflow:hidden;margin:12px 0}
.param-grid-inner{display:grid;grid-template-columns:repeat(5,1fr);gap:1px}
.param-grid .cell{background:#161b22;padding:8px;font-size:11px;text-align:center}
.param-grid .header{background:#0d1117;color:#8b949e;font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.rule-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px}
.rule-card h3{color:#58a6ff;font-size:14px;margin-bottom:8px}
.rule-card .trigger{color:#f0883e;font-size:11px;font-style:italic;margin-top:8px;padding-top:8px;border-top:1px solid #21262d}
.rule-num{display:inline-block;background:#58a6ff20;color:#58a6ff;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:bold;margin-right:8px}
.logic-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:12px;font-family:monospace;color:#c9d1d9;margin:8px 0;line-height:1.6;white-space:pre-wrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
.example-box{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;margin:8px 0;font-size:12px;line-height:1.6}
.example-title{color:#58a6ff;font-weight:bold;margin-bottom:4px}
.example-text{color:#c9d1d9}
.example-note{color:#8b949e;margin-top:4px}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin:0 2px}
.tag-ranging{background:#4a9eff20;color:#4a9eff}
.tag-bull{background:#22c55e20;color:#22c55e}
.tag-bear{background:#ef444420;color:#ef4444}
.tag-extreme{background:#a855f720;color:#a855f7}
.section-title{font-size:14px;margin:24px 0 12px;padding-bottom:8px;border-bottom:1px solid #21262d}
@media(max-width:700px){
  .param-grid{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .param-grid-inner{grid-template-columns:repeat(5,minmax(70px,1fr));min-width:400px}
  .flow-step{padding:10px 12px}
  .flow-step h3{font-size:12px}
  .rule-card{padding:12px}
  .rule-card h3{font-size:13px}
  .logic-box{font-size:11px;padding:10px;overflow-x:auto}
}
</style>
</head>
<body>
<div class="banner">
  <div class="mode" style="color:#58a6ff">Strategy &amp; Rules</div>
  <h1>SOL/USDC LP Bot</h1>
  <div style="color:#8b949e;font-size:11px">Regime-adaptive concentrated liquidity on Orca Whirlpool</div>
</div>
${NAV_HTML}
<script>document.getElementById('nav-strategy').classList.add('active')</script>

<!-- ── OVERVIEW ──────────────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Overview</h2>
  <p style="color:#c9d1d9;font-size:13px;line-height:1.6">
    A <b>30-second decision loop</b> reads live SOL/USD prices, classifies the market into one of four regimes,
    and manages a concentrated liquidity position on the <b>Orca SOL/USDC Whirlpool</b>.
    Seven rules adapt range width, exit thresholds, capital sizing, fee harvesting and idle-fund deployment
    to current conditions. The goal: maximize fee yield while minimizing impermanent loss.
  </p>
</div>

<!-- ── DECISION FLOW ────────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Decision Flow</h2>
  <p style="font-size:11px;color:#8b949e;margin-bottom:8px">Every 30 seconds. Sub-checks run on their own cadence (noted below).</p>
  <div class="flow">
    <div class="flow-step"><h3>1. Fetch Price</h3><div style="font-size:12px;color:#8b949e">SOL/USD from Pyth Hermes. Reject if confidence &gt; 0.5% or stale &gt; 60s.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>2. Regime Detection <span style="color:#8b949e;font-weight:normal;font-size:11px">(every 1h)</span></h3><div style="font-size:12px;color:#8b949e">Classify market from daily closes: RANGING / BULLISH / BEARISH / EXTREME.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>3. Safety Checks</h3><div style="font-size:12px;color:#8b949e">Circuit breakers: daily loss &gt; 5%, IL &gt; 8%, rebalances &gt; 10/hr &#x2192; HALT.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>4. Position Decision</h3><div style="font-size:12px;color:#8b949e">No position &#x2192; open (Rules 1, 3&#x2013;5). In range &#x2192; monitor proximity (Rule 2). Out of range &#x2192; rebalance.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>5. Fee Harvest <span style="color:#8b949e;font-weight:normal;font-size:11px">(check every 1h)</span></h3><div style="font-size:12px;color:#8b949e">If harvest interval elapsed (Rule 6) &#x2192; collect accrued fees from position.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>6. Auto Deploy <span style="color:#8b949e;font-weight:normal;font-size:11px">(check every 5min)</span></h3><div style="font-size:12px;color:#8b949e">If idle wallet funds exist and position is in range (Rule 7) &#x2192; add liquidity.</div></div>
    <div class="flow-arrow">&#x25BC;</div>
    <div class="flow-step"><h3>7. Record &amp; Report</h3><div style="font-size:12px;color:#8b949e">Log decision to DB (every 30min). Telegram report (every 1h). Dashboard snapshot.</div></div>
  </div>
</div>

<!-- ── REGIME DETECTION ─────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Regime Detection</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:8px">Evaluated every 1 hour using 2 days of daily closing prices.</p>
  <div class="logic-box"><b>dirRatio</b> = |net move| / total path
  1.0 = straight line (strong trend)
  0.0 = oscillating (ranging)

<b>realisedVol</b> = stddev of daily log returns
  Normal SOL: 3&#x2013;5%. Crisis: &gt; 8%

<b>Classification:</b>
  realisedVol &gt; 0.08            &#x2192; <span class="tag tag-extreme">EXTREME</span>
  dirRatio &gt; 0.35 &amp; price up   &#x2192; <span class="tag tag-bull">BULLISH_TREND</span>
  dirRatio &gt; 0.35 &amp; price down &#x2192; <span class="tag tag-bear">BEARISH_TREND</span>
  otherwise                      &#x2192; <span class="tag tag-ranging">RANGING</span></div>
  <div class="example-box">
    <div class="example-title">Example: $80 &#x2192; $83 &#x2192; $82 over 2 days</div>
    <div class="example-text">dirRatio = |$82-$80| / (|$83-$80|+|$82-$83|) = 2/4 = <b>0.50</b></div>
    <div class="example-text">realisedVol = stddev(ln(83/80), ln(82/83)) = <b>0.025</b></div>
    <div class="example-text">0.025 &lt; 0.08 &#x2192; not EXTREME. 0.50 &gt; 0.35 &amp; up &#x2192; <span class="tag tag-bull">BULLISH_TREND</span></div>
    <div class="example-note">$80 &#x2192; $81 &#x2192; $80 would give dirRatio = 0.0 &#x2192; <span class="tag tag-ranging">RANGING</span>. A crash like $80 &#x2192; $95 &#x2192; $70 pushes vol past 0.08 &#x2192; <span class="tag tag-extreme">EXTREME</span>.</div>
  </div>
</div>

<!-- ── PARAMETERS GRID ──────────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Parameters by Regime</h2>
  <div class="param-grid">
  <div class="param-grid-inner">
    <div class="cell header">Parameter</div>
    <div class="cell header" style="color:#4a9eff">Ranging</div>
    <div class="cell header" style="color:#22c55e">Bullish</div>
    <div class="cell header" style="color:#ef4444">Bearish</div>
    <div class="cell header" style="color:#a855f7">Extreme</div>
    <div class="cell" style="text-align:left;color:#8b949e">Range Width (R1)</div><div class="cell" style="color:#4a9eff">1.5%</div><div class="cell" style="color:#22c55e">3%</div><div class="cell" style="color:#ef4444">4%</div><div class="cell" style="color:#a855f7">6%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Skew down/up (R1)</div><div class="cell">30/70</div><div class="cell">20/80</div><div class="cell">40/60</div><div class="cell">50/50</div>
    <div class="cell" style="text-align:left;color:#8b949e">Downside Exit (R2)</div><div class="cell">65%</div><div class="cell">70%</div><div class="cell">55%</div><div class="cell">50%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Upside Exit (R2)</div><div class="cell">88%</div><div class="cell">92%</div><div class="cell">82%</div><div class="cell">80%</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL Re-entry (R4)</div><div class="cell">50%</div><div class="cell">50%</div><div class="cell">30%</div><div class="cell">20%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Capital Deploy (R5)</div><div class="cell" style="color:#22c55e">100%</div><div class="cell">85%</div><div class="cell" style="color:#eab308">50%</div><div class="cell" style="color:#ef4444">25%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Harvest (R6)</div><div class="cell">7d</div><div class="cell">4d</div><div class="cell">2d</div><div class="cell">1d</div>
    <div class="cell" style="text-align:left;color:#8b949e">SOL&#x2192;USDC Harvest</div><div class="cell">0%</div><div class="cell">70%</div><div class="cell" style="color:#ef4444">100%</div><div class="cell" style="color:#ef4444">100%</div>
    <div class="cell" style="text-align:left;color:#8b949e">Auto Deploy (R7)</div><div class="cell" style="color:#22c55e">Yes</div><div class="cell" style="color:#22c55e">Yes</div><div class="cell" style="color:#ef4444">Blocked</div><div class="cell" style="color:#ef4444">Blocked</div>
  </div></div>
  <div style="font-size:11px;color:#8b949e;margin-top:4px">Ranging = tight range, max fees. Trending = wider, less risk. Extreme = widest, minimal exposure. (Rn) = which rule uses the parameter.</div>
</div>

<!-- ── THE 7 RULES ──────────────────────────────────────────────────── -->

<div class="section-title" style="color:#58a6ff">The 7 Rules</div>

<div class="rule-card">
  <h3><span class="rule-num">1</span> Asymmetric Range</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Sets the price range for the position. Skewed by regime to give more room in the expected direction.</p>
  <div class="logic-box">lower = price &#xD7; (1 - rangeWidth &#xD7; skewDown)
upper = price &#xD7; (1 + rangeWidth &#xD7; skewUp)</div>
  <div class="example-box">
    <div class="example-title">SOL = $85, RANGING</div>
    <div class="example-text">lower = $85 &#xD7; (1 - 0.015 &#xD7; 0.30) = <b>$84.62</b></div>
    <div class="example-text">upper = $85 &#xD7; (1 + 0.015 &#xD7; 0.70) = <b>$85.89</b></div>
    <div class="example-note">Total range $1.27. Room below $0.38 (30%), room above $0.89 (70%). The 30/70 skew gives price more room to rise before going OOR.</div>
  </div>
  <div class="trigger">Runs: on every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">2</span> Proximity Monitor &amp; Early Exit</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Measures how close price is to range edges. Exits <b>before</b> going out of range to reduce IL. Can be toggled on/off from the dashboard.</p>
  <div class="logic-box">proxToLower = (centre - price) / halfWidth    0% = safe, 100% = edge
proxToUpper = (price - centre) / halfWidth

Downside: proxToLower &#x2265; threshold &#x2192; close + reopen at current price
Upside:   proxToUpper &#x2265; threshold &#x2192; close + enter pullback watch (Rule 3)</div>
  <div class="example-box">
    <div class="example-title">Downside exit in RANGING</div>
    <div class="example-text">Range $84.62&#x2013;$85.89, centre = $85.26, halfWidth = $0.64</div>
    <div class="example-text">Price drops to $84.84 &#x2192; proxToLower = ($85.26 - $84.84) / $0.64 = <b>66%</b></div>
    <div class="example-text">RANGING threshold = 65% &#x2192; 66% &#x2265; 65% &#x2192; <b style="color:#f97316">EXIT</b></div>
    <div class="example-note">Closes at 66% instead of waiting for 100% (full OOR). Avoids the worst IL in the last 35% of drift, then reopens centered at $84.84.</div>
  </div>
  <div class="trigger">Runs: every 30s cycle when position is in range. Disabled = only close on full OOR.</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">3</span> Pullback Re-entry</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After an upside exit or OOR above, waits for price to pull back before re-entering. Avoids opening at a local peak. Includes flash crash protection.</p>
  <div class="logic-box">After upside exit, track peak price.

pullback &#x2265; 2.5% from peak   &#x2192; re-enter immediately
waited &#x2265; 4 hours            &#x2192; re-enter (timeout)

<b>Flash crash guard:</b>
If price drops &#x2265; 5% in last ~5 min (10 candles):
  1. Block re-entry for 15 minutes
  2. Reset peak to current price (forget old peak)
  3. Reset 4h timeout from now (full new window)
This prevents re-entering during a crash AND prevents
the timeout from firing immediately after cooldown.</div>
  <div class="example-box">
    <div class="example-title">Normal pullback re-entry</div>
    <div class="example-text">OOR above at $85.15. Peak tracks to $86.50, then drops to $84.34.</div>
    <div class="example-text">Pullback = ($86.50 - $84.34) / $86.50 = <b>2.5%</b> &#x2192; <b style="color:#22c55e">RE-ENTER</b></div>
    <div class="example-note">If no 2.5% pullback within 4 hours, re-enters anyway to avoid missing fees indefinitely.</div>
  </div>
  <div class="example-box">
    <div class="example-title">Flash crash during pullback watch</div>
    <div class="example-text">Peak is $86.50. At hour 3:50, SOL crashes from $85 to $80 in 5 min (6% drop).</div>
    <div class="example-text">Flash crash detected &#x2192; 15-min cooldown. Peak reset to $80. Timeout reset to now + 4h.</div>
    <div class="example-text">Hour 4:05: cooldown expires. Peak is $80. Timeout not until hour 7:50.</div>
    <div class="example-text">Bot watches from $80: needs 2.5% pullback to $78 or waits until 7:50.</div>
    <div class="example-note">Without this fix, the old 4h timeout would have already expired and the bot would jump in at $80 right after the 15-min pause &#x2014; right into a still-falling market.</div>
  </div>
  <div class="trigger">Runs: every 30s cycle while WAITING_PULLBACK</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">4</span> Re-entry SOL/USDC Split</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">After a downside exit, determines the SOL/USDC wallet ratio before opening a new position. Less SOL in bearish markets to reduce exposure.</p>
  <div class="logic-box"><span class="tag tag-ranging">RANGING</span>  50% SOL / 50% USDC    <span class="tag tag-bull">BULLISH</span>  50 / 50
<span class="tag tag-bear">BEARISH</span> 30% SOL / 70% USDC    <span class="tag tag-extreme">EXTREME</span> 20 / 80</div>
  <div class="example-box">
    <div class="example-title">BEARISH re-entry with $46</div>
    <div class="example-text">OOR_BELOW triggered. Regime is BEARISH &#x2192; target 30/70 split.</div>
    <div class="example-text">$13.80 in SOL (0.162 SOL at $85) + $32.20 USDC.</div>
    <div class="example-note">Holding less SOL limits losses if price keeps falling. The actual deposit ratio is determined by concentrated liquidity math; this split targets the wallet balance before deposit.</div>
  </div>
  <div class="trigger">Runs: on position open after downside exit (OOR_BELOW, T1_DOWNSIDE)</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">5</span> Position Sizing</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Controls what % of capital goes into the position. More volatile = more reserve. Opens with the constraining token (no swap); Rule 7 auto-deploy tops up the rest.</p>
  <div class="logic-box"><b>Capital allocation:</b>
<span class="tag tag-ranging">RANGING</span>  100% deployed   <span class="tag tag-bull">BULLISH</span>  85% deployed
<span class="tag tag-bear">BEARISH</span>  50% deployed   <span class="tag tag-extreme">EXTREME</span> 25% deployed

<b>Position open process:</b>
1. Total value = SOL &#xD7; price + USDC
2. Deploy target = total &#xD7; regime deployPct
3. Quote with constraining token (SOL or USDC &#x2014; whichever limits)
4. Open position with available capital (NO pre-swap)
5. Reserve: 0.1 SOL (gas + rent) + $1 USDC always kept

<b>Why no swap on open?</b>
Swapping before position open is risky: if the swap succeeds
but the position TX fails (rent, slippage), the wallet is left
imbalanced with no position. Instead, the position opens with
partial capital, and Rule 7 (auto-deploy) adds the remaining
idle funds within 5 minutes &#x2014; including any needed swap.
The swap inside auto-deploy is safe because the position already
exists and is earning fees.</div>
  <div class="example-box">
    <div class="example-title">Open with partial capital, auto-deploy tops up</div>
    <div class="example-text">Wallet: 0.5 SOL ($42) + $3,000 USDC. Position needs SOL:USDC ratio ~1:36.</div>
    <div class="example-text">Constraining token is SOL &#x2192; deposits 0.4 SOL + ~$14 USDC = $48.</div>
    <div class="example-text">~$2,985 USDC sits idle. Rule 7 detects idle funds in 5 min.</div>
    <div class="example-text">Auto-deploy swaps ~$1,500 USDC &#x2192; SOL, deposits both &#x2192; full capital deployed.</div>
    <div class="example-note">Total time to full deployment: ~5 min. Missed fees on idle portion: ~$0.01. But no risk of failed-swap + no-position deadlock.</div>
  </div>
  <div class="trigger">Runs: on every position open</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">6</span> Fee Harvest</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Collects accrued trading fees from the position. More frequent in volatile markets to lock gains before IL erases them. After collection, converts harvested SOL to USDC based on regime policy.</p>
  <div class="logic-box"><b>Harvest intervals:</b>
<span class="tag tag-ranging">RANGING</span>  every 7 days   (let fees accumulate)
<span class="tag tag-bull">BULLISH</span>  every 4 days
<span class="tag tag-bear">BEARISH</span>  every 2 days   (lock gains quickly)
<span class="tag tag-extreme">EXTREME</span> every 1 day    (harvest ASAP)

<b>Post-harvest SOL &#x2192; USDC conversion:</b>
<span class="tag tag-ranging">RANGING</span>  0% (keep SOL)   <span class="tag tag-bull">BULLISH</span>  70% converted
<span class="tag tag-bear">BEARISH</span> 100% converted   <span class="tag tag-extreme">EXTREME</span> 100% converted</div>
  <div class="example-box">
    <div class="example-title">BEARISH: harvest + full SOL conversion</div>
    <div class="example-text">Day 2: collectFees tx &#x2192; 0.001 SOL + 0.08 USDC to wallet.</div>
    <div class="example-text">BEARISH policy = 100% convert &#x2192; swap 0.001 SOL &#x2192; ~$0.08 USDC.</div>
    <div class="example-text">Result: all harvested value in USDC, protected from further SOL decline.</div>
    <div class="example-note">In RANGING, harvested SOL stays as SOL (0% conversion). In trending/volatile markets, converting to USDC locks gains and reduces exposure.</div>
  </div>
  <div class="trigger">Runs: checked every 1 hour against last harvest time</div>
</div>

<div class="rule-card">
  <h3><span class="rule-num">7</span> Auto Capital Deployment</h3>
  <p style="font-size:12px;color:#c9d1d9;line-height:1.5">Deploys idle wallet funds into an <b>existing in-range position</b>. Does not open new positions &#x2014; Rules 1&#x2013;5 handle that. Only runs after all exit rules have been evaluated and none triggered.</p>
  <div class="logic-box"><b>6 conditions must ALL pass:</b>
  1. Feature enabled          (dashboard toggle)
  2. Regime allows it         (blocked in BEARISH and EXTREME)
  3. Idle funds &gt; threshold   (SOL &gt; 0.05 or USDC &gt; $5, after reserves)
  4. Cooldown elapsed         (max 1 deploy per hour)
  5. Capital cap headroom     (position below regime deploy % cap)
  6. Price near ideal         (within 2% of geometric mean of range)

<b>Reserves:</b>  0.05 SOL (gas) + $1 USDC always kept
<b>Cooldown:</b>  1 hour between deployments</div>
  <div class="example-box">
    <div class="example-title">Auto deploy after manual wallet top-up</div>
    <div class="example-text">You send $150 USDC to the wallet. Position range $83.65&#x2013;$84.97, price $84.25.</div>
    <div class="example-text">$149 idle (after $1 reserve). Price within 2% of ideal $84.31. RANGING = 100% cap.</div>
    <div class="example-text">Bot swaps ~$75 USDC &#x2192; SOL to match ratio, deposits both &#x2192; $148 deployed.</div>
    <div class="example-text">Wallet after: 0.065 SOL + $1.00 USDC (reserves only).</div>
  </div>
  <div class="example-box">
    <div class="example-title">Skipped: price near range edge</div>
    <div class="example-text">Range $83.65&#x2013;$84.97. Ideal (geometric mean) = $84.31. Price = $83.72.</div>
    <div class="example-text">Deviation = |$83.72/$84.31 - 1| = 0.7%. Within 2% tolerance, but...</div>
    <div class="example-text">If price drops further to $83.50 &#x2192; deviation 1.0%. Still passes.</div>
    <div class="example-text">At $82.60 &#x2192; deviation 2.03% &#x2192; <b style="color:#f97316">SKIPPED</b>. Deposit ratio would be too SOL-heavy.</div>
    <div class="example-note">The 2% tolerance prevents deploying when the required token ratio is heavily skewed, which would waste swap fees.</div>
  </div>
  <div class="example-box">
    <div class="example-title">Bot is idle (no position) &#x2014; auto deploy does NOT run</div>
    <div class="example-text">After a Rule 2 exit or during pullback watch, no position exists.</div>
    <div class="example-text">Auto deploy requires an existing position. Rules 1&#x2013;5 handle opening.</div>
    <div class="example-note">Once a new position is opened, auto deploy activates on the next 5-minute check.</div>
  </div>
  <div class="trigger">Runs: checked every 5 minutes when position is in range</div>
</div>

<!-- ── RULE EXECUTION ORDER ─────────────────────────────────────────── -->

<div class="card" style="margin-bottom:16px">
  <h2>Rule Execution Order</h2>
  <p style="font-size:12px;color:#8b949e;margin-bottom:8px">Rules are evaluated in strict order each cycle. If any rule triggers an action, the cycle returns immediately &#x2014; later rules are skipped.</p>
  <div class="logic-box">1. No position?  &#x2192; Open (R1, R4, R5) or pullback watch (R3)    <b style="color:#f97316">return</b>
2. Out of range? &#x2192; Close + reopen (below) or pullback (above)  <b style="color:#f97316">return</b>
3. Rule 2 exit?  &#x2192; Proximity triggered &#x2192; close + act           <b style="color:#f97316">return</b>
4. Rule 6        &#x2192; Harvest if due (no return, continues)
5. Rule 7        &#x2192; Auto deploy if conditions met
6. Log HOLD      &#x2192; Record state to DB</div>
  <div style="font-size:11px;color:#8b949e;margin-top:4px">This ordering ensures auto deploy (R7) never conflicts with exit rules (R2, OOR). It only runs when the position is safely in range and holding.</div>
</div>

<!-- ── CIRCUIT BREAKERS ─────────────────────────────────────────────── -->

<div class="section-title" style="color:#ef4444">Circuit Breakers</div>
<div class="card" style="margin-bottom:16px">
  <div class="logic-box"><b>Daily Loss</b>        portfolio drops &gt; 5%         &#x2192; HALT
<b>Weekly Drawdown</b>   drops &gt; 15% from peak      &#x2192; HALT
<b>Max IL</b>            impermanent loss &gt; 8%       &#x2192; force rebalance
<b>Rebalance Limit</b>  &gt; 10 per hour               &#x2192; pause
<b>Min Position</b>     &lt; $100 USDC                  &#x2192; skip open
<b>Flash Crash</b>      &gt; 5% single drop             &#x2192; wait 15 min</div>
</div>

<!-- ── CONCENTRATED LIQUIDITY PRIMER ────────────────────────────────── -->

<div class="section-title" style="color:#58a6ff">How Concentrated Liquidity Works</div>
<div class="card" style="margin-bottom:16px">
  <p style="font-size:12px;color:#c9d1d9;line-height:1.6;margin-bottom:8px">
    Unlike traditional AMMs (liquidity from $0 to &#x221E;), concentrated liquidity focuses capital in a <b>specific price range</b>.
    Higher fee yield per $, but the range must be actively managed.
  </p>
  <div class="logic-box">At lower bound  &#x2192; 100% SOL,  0% USDC  (bought the dip)
At centre       &#x2192; ~50% SOL, ~50% USDC
At upper bound  &#x2192;  0% SOL, 100% USDC  (sold the top)

This is why deposit ratio isn't 50/50 and why Rule 5 swaps to match.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
    <div style="background:#0d1117;border-radius:6px;padding:10px;font-size:11px">
      <div style="color:#22c55e;font-weight:bold;margin-bottom:4px">Advantages</div>
      <div style="color:#c9d1d9;line-height:1.5">Higher fee yield per $. Capital efficient. Earn on every swap through your range.</div>
    </div>
    <div style="background:#0d1117;border-radius:6px;padding:10px;font-size:11px">
      <div style="color:#ef4444;font-weight:bold;margin-bottom:4px">Risks</div>
      <div style="color:#c9d1d9;line-height:1.5">Impermanent loss on price moves. Out of range = zero fees. Narrower range = more fees but more IL.</div>
    </div>
  </div>
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

<div class="card" style="margin-bottom:16px">
  <h2>Data Sources &amp; Services</h2>
  ${rows}
</div>

<div style="text-align:center;margin-top:16px">
  <a href="/api/health" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:12px">View as JSON</a>
</div>

</body>
</html>`;
}
