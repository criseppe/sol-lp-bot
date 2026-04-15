/**
 * Market Data Service — fetches external volatility & sentiment indicators
 * for enhanced regime detection. Polls every 15 minutes.
 * Falls back gracefully if any API is unavailable.
 */

const COINGECKO_URL = 'https://api.coingecko.com/api/v3';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalAnalysis {
  rsi14: number | null;         // RSI(14) from 30min candles — overbought >70, oversold <30
  bbWidth: number | null;       // Bollinger Band width % — squeeze <1%, expansion >3%
  bbPosition: number | null;    // Price position within BB: 0=lower, 0.5=middle, 1=upper
  sma20: number | null;         // 20-period SMA (30min candles = 10h lookback)
  ema9: number | null;          // 9-period EMA (30min candles = 4.5h lookback)
  trendDirection: 'UP' | 'DOWN' | 'FLAT' | null; // EMA9 vs SMA20 crossover
  support: number | null;       // Recent support level (lowest low in last 12 candles)
  resistance: number | null;    // Recent resistance level (highest high in last 12 candles)
  atr14: number | null;         // Average True Range — actual price volatility in $
  priceVsSma: number | null;    // % distance from SMA20 — mean reversion signal
}

export interface MarketSignals {
  // SOL volatility (from CoinGecko OHLC)
  vol1h: number | null;       // stddev of 30min log returns (last 24h)
  vol4h: number | null;       // stddev of 4h log returns (last 7d)
  solDelta24h: number | null;  // SOL price change % in last 24h
  solVolume24h: number | null;  // SOL 24h trading volume in USD

  // BTC correlation
  btcDelta24h: number | null;  // BTC price change % in last 24h
  btcPrice: number | null;

  // Volume
  volumeRatio4h: number | null; // latest 24h vol / rolling 7d avg vol

  // Sentiment
  fearGreedIndex: number | null;  // 0-100
  fearGreedLabel: string | null;  // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"

  // Technical Analysis (from 30min SOL candles)
  ta: TechnicalAnalysis | null;

  // Meta
  lastUpdated: number;
  errors: string[];
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map(v => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / values.length);
}

function logReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return returns;
}

// ── Technical Analysis Calculations ──

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcSMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcEMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollingerBands(closes: number[], period = 20, mult = 2): { upper: number; middle: number; lower: number; width: number; position: number } | null {
  const sma = calcSMA(closes, period);
  if (sma == null || closes.length < period) return null;
  const slice = closes.slice(-period);
  const std = stdDev(slice);
  const upper = sma + mult * std;
  const lower = sma - mult * std;
  const price = closes[closes.length - 1];
  const width = sma > 0 ? ((upper - lower) / sma) * 100 : 0;
  const position = upper !== lower ? (price - lower) / (upper - lower) : 0.5;
  return { upper, middle: sma, lower, width, position: Math.max(0, Math.min(1, position)) };
}

function calcATR(candles: OHLCV[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    atrSum += tr;
  }
  return atrSum / period;
}

function calcTA(candles: OHLCV[]): TechnicalAnalysis {
  const closes = candles.map(c => c.close);
  const rsi14 = calcRSI(closes);
  const sma20 = calcSMA(closes, 20);
  const ema9 = calcEMA(closes, 9);
  const bb = calcBollingerBands(closes);
  const atr14 = calcATR(candles);

  // Support/resistance from last 12 candles
  const recent = candles.slice(-12);
  const support = recent.length > 0 ? Math.min(...recent.map(c => c.low)) : null;
  const resistance = recent.length > 0 ? Math.max(...recent.map(c => c.high)) : null;

  // Trend from EMA9 vs SMA20
  let trendDirection: 'UP' | 'DOWN' | 'FLAT' | null = null;
  if (ema9 != null && sma20 != null) {
    const diff = ((ema9 - sma20) / sma20) * 100;
    trendDirection = diff > 0.1 ? 'UP' : diff < -0.1 ? 'DOWN' : 'FLAT';
  }

  const price = closes.length > 0 ? closes[closes.length - 1] : 0;
  const priceVsSma = sma20 != null && sma20 > 0 ? ((price - sma20) / sma20) * 100 : null;

  return {
    rsi14,
    bbWidth: bb?.width ?? null,
    bbPosition: bb?.position ?? null,
    sma20,
    ema9,
    trendDirection,
    support,
    resistance,
    atr14,
    priceVsSma,
  };
}

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch SOL OHLC from CoinGecko.
 * days=1 returns ~30min candles (48 points), days=7 returns 4h candles (42 points).
 */
async function fetchCoinGeckoOHLC(days: 1 | 7): Promise<OHLCV[]> {
  const url = `${COINGECKO_URL}/coins/solana/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}`);
  const json = await res.json() as Array<[number, number, number, number, number]>;
  if (!Array.isArray(json)) return [];
  return json.map(([ts, open, high, low, close]) => ({
    timestamp: ts,
    open,
    high,
    low,
    close,
    volume: 0, // CoinGecko OHLC doesn't include volume
  }));
}

/**
 * Fetch SOL market data including 24h volume from CoinGecko.
 */
async function fetchSolMarketData(): Promise<{ price: number; delta24h: number; volume24h: number } | null> {
  const url = `${COINGECKO_URL}/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko SOL ${res.status}`);
  const json = await res.json() as { solana?: { usd: number; usd_24h_change: number; usd_24h_vol: number } };
  if (!json.solana) return null;
  return { price: json.solana.usd, delta24h: json.solana.usd_24h_change, volume24h: json.solana.usd_24h_vol };
}

async function fetchBtcPrice(): Promise<{ price: number; delta24h: number } | null> {
  const url = `${COINGECKO_URL}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const json = await res.json() as { bitcoin?: { usd: number; usd_24h_change: number } };
  if (!json.bitcoin) return null;
  return { price: json.bitcoin.usd, delta24h: json.bitcoin.usd_24h_change };
}

/**
 * Fetch 7-day SOL volume history from CoinGecko market_chart.
 * Returns latest volume, 7-day average, and ratio (instant — no accumulation needed).
 */
async function fetchVolumeRatio7d(): Promise<{ latest: number; avg7d: number; ratio: number } | null> {
  const url = `${COINGECKO_URL}/coins/solana/market_chart?vs_currency=usd&days=7`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko market_chart ${res.status}`);
  const json = await res.json() as { total_volumes?: Array<[number, number]> };
  if (!json.total_volumes || json.total_volumes.length < 10) return null;
  const vols = json.total_volumes;
  const latest = vols[vols.length - 1][1];
  const avg = vols.reduce((s, v) => s + v[1], 0) / vols.length;
  if (avg <= 0) return null;
  return { latest, avg7d: avg, ratio: latest / avg };
}

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  const res = await fetchWithTimeout(FEAR_GREED_URL);
  if (!res.ok) throw new Error(`F&G ${res.status}`);
  const json = await res.json() as { data?: Array<{ value: string; value_classification: string }> };
  if (!json.data?.[0]) return null;
  return { value: parseInt(json.data[0].value), label: json.data[0].value_classification };
}

export class MarketDataService {
  private signals: MarketSignals | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private fetchCount = 0;

  async start(): Promise<void> {
    // Initial fetch
    await this.refresh();

    // Poll every 15 minutes
    this.pollInterval = setInterval(() => {
      this.refresh().catch(err => {
        console.log(JSON.stringify({ level: 'warn', msg: 'market data refresh failed', error: String(err), timestamp: Date.now() }));
      });
    }, 15 * 60_000);

    console.log(JSON.stringify({ level: 'info', msg: 'market data service started (15min polling)', timestamp: Date.now() }));
  }

  private refreshing = false;

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try { return await this._doRefresh(); } finally { this.refreshing = false; }
  }

  private async _doRefresh(): Promise<void> {
    const errors: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. SOL 30min candles (last 24h) for short-term vol + TA — via CoinGecko OHLC
    let vol1h: number | null = null;
    let solDelta24h: number | null = null;
    let ta: TechnicalAnalysis | null = null;
    try {
      const candles1d = await fetchCoinGeckoOHLC(1); // ~30min candles
      if (candles1d.length >= 6) {
        const closes = candles1d.map(c => c.close);
        vol1h = stdDev(logReturns(closes));
        solDelta24h = closes.length >= 2 ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;
        // Technical analysis from 30min candles
        if (candles1d.length >= 15) {
          ta = calcTA(candles1d);
        }
      }
    } catch (err) {
      errors.push(`coingecko-ohlc-1d: ${String(err).slice(0, 80)}`);
    }

    // 2. SOL 4H candles (last 7d) for medium-term vol — via CoinGecko OHLC
    let vol4h: number | null = null;
    let volumeRatio4h: number | null = null;
    let solVolume24h: number | null = null;
    try {
      const candles7d = await fetchCoinGeckoOHLC(7); // 4h candles
      if (candles7d.length >= 6) {
        const closes = candles7d.map(c => c.close);
        vol4h = stdDev(logReturns(closes));
      }
    } catch (err) {
      errors.push(`coingecko-ohlc-7d: ${String(err).slice(0, 80)}`);
    }

    // 3. SOL 24h volume + volume ratio (instant from 7d history, no accumulation needed)
    try {
      const solData = await fetchSolMarketData();
      if (solData) {
        if (solDelta24h == null) solDelta24h = solData.delta24h;
        solVolume24h = solData.volume24h;
      }
    } catch (err) {
      errors.push(`coingecko-sol: ${String(err).slice(0, 80)}`);
    }
    try {
      const volRatio = await fetchVolumeRatio7d();
      if (volRatio) {
        volumeRatio4h = volRatio.ratio;
        if (solVolume24h == null) solVolume24h = volRatio.latest;
      }
    } catch (err) {
      errors.push(`coingecko-vol-ratio: ${String(err).slice(0, 80)}`);
    }

    // 4. BTC price & 24h change
    let btcPrice: number | null = null;
    let btcDelta24h: number | null = null;
    try {
      const btc = await fetchBtcPrice();
      if (btc) {
        btcPrice = btc.price;
        btcDelta24h = btc.delta24h;
      }
    } catch (err) {
      errors.push(`coingecko: ${String(err).slice(0, 80)}`);
    }

    // 5. Fear & Greed Index
    let fearGreedIndex: number | null = null;
    let fearGreedLabel: string | null = null;
    try {
      const fng = await fetchFearGreed();
      if (fng) {
        fearGreedIndex = fng.value;
        fearGreedLabel = fng.label;
      }
    } catch (err) {
      errors.push(`fng: ${String(err).slice(0, 80)}`);
    }

    this.signals = {
      vol1h,
      vol4h,
      solDelta24h,
      solVolume24h,
      btcDelta24h,
      btcPrice,
      volumeRatio4h,
      fearGreedIndex,
      fearGreedLabel,
      ta,
      lastUpdated: Date.now(),
      errors,
    };

    this.fetchCount++;
    console.log(JSON.stringify({
      level: 'info',
      msg: 'market data refreshed',
      vol1h: vol1h?.toFixed(4) ?? 'n/a',
      vol4h: vol4h?.toFixed(4) ?? 'n/a',
      solDelta24h: solDelta24h != null ? `${solDelta24h.toFixed(2)}%` : 'n/a',
      btcDelta24h: btcDelta24h != null ? `${btcDelta24h.toFixed(2)}%` : 'n/a',
      volumeRatio4h: volumeRatio4h?.toFixed(2) ?? 'n/a',
      solVolume24h: solVolume24h != null ? `$${(solVolume24h / 1e6).toFixed(0)}M` : 'n/a',
      fearGreed: fearGreedIndex != null ? `${fearGreedIndex} (${fearGreedLabel})` : 'n/a',
      ta: ta ? `RSI=${ta.rsi14?.toFixed(0)} BB=${ta.bbWidth?.toFixed(1)}% trend=${ta.trendDirection} ATR=$${ta.atr14?.toFixed(2)} S=$${ta.support?.toFixed(2)} R=$${ta.resistance?.toFixed(2)}` : 'n/a',
      errors: errors.length > 0 ? errors : undefined,
      timestamp: Date.now(),
    }));
  }

  getSignals(): MarketSignals | null {
    return this.signals;
  }

  getFetchCount(): number {
    return this.fetchCount;
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log(JSON.stringify({ level: 'info', msg: 'market data service stopped', timestamp: Date.now() }));
  }
}
