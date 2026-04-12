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

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  const res = await fetchWithTimeout(FEAR_GREED_URL);
  if (!res.ok) throw new Error(`F&G ${res.status}`);
  const json = await res.json() as { data?: Array<{ value: string; value_classification: string }> };
  if (!json.data?.[0]) return null;
  return { value: parseInt(json.data[0].value), label: json.data[0].value_classification };
}

// Max volume history entries: 7 days * 4 readings/hour * 24 hours = 672
// At 15-min polling we get 96/day * 7 = 672 readings
const MAX_VOLUME_HISTORY = 672;

export class MarketDataService {
  private signals: MarketSignals | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private fetchCount = 0;
  // Rolling 24h volume readings for computing volume ratio
  private volumeHistory: Array<{ timestamp: number; volume24h: number }> = [];

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

  async refresh(): Promise<void> {
    const errors: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. SOL 30min candles (last 24h) for short-term vol — via CoinGecko OHLC
    let vol1h: number | null = null;
    let solDelta24h: number | null = null;
    try {
      const candles1d = await fetchCoinGeckoOHLC(1); // ~30min candles
      if (candles1d.length >= 6) {
        const closes = candles1d.map(c => c.close);
        vol1h = stdDev(logReturns(closes));
        solDelta24h = closes.length >= 2 ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;
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

    // 3. SOL 24h volume + volume ratio from rolling history
    try {
      const solData = await fetchSolMarketData();
      if (solData) {
        if (solDelta24h == null) solDelta24h = solData.delta24h;
        solVolume24h = solData.volume24h;

        // Store in rolling history
        this.volumeHistory.push({ timestamp: Date.now(), volume24h: solData.volume24h });
        if (this.volumeHistory.length > MAX_VOLUME_HISTORY) {
          this.volumeHistory = this.volumeHistory.slice(-MAX_VOLUME_HISTORY);
        }

        // Compute volume ratio: current vs 7-day average
        // Need at least 24h of data (~96 readings at 15min) for meaningful average
        if (this.volumeHistory.length >= 4) {
          const avgVol = this.volumeHistory.reduce((sum, v) => sum + v.volume24h, 0) / this.volumeHistory.length;
          volumeRatio4h = avgVol > 0 ? solData.volume24h / avgVol : null;
        }
      }
    } catch (err) {
      errors.push(`coingecko-sol-vol: ${String(err).slice(0, 80)}`);
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
