/**
 * Market Data Service — fetches external volatility & sentiment indicators
 * for enhanced regime detection. Polls every 15 minutes.
 * Falls back gracefully if any API is unavailable.
 */

const BIRDEYE_OHLCV_URL = 'https://public-api.birdeye.so/defi/ohlcv';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSignals {
  // SOL volatility (from Birdeye OHLCV)
  vol1h: number | null;       // stddev of 1h log returns (last 24h)
  vol4h: number | null;       // stddev of 4h log returns (last 7d)
  solDelta24h: number | null;  // SOL price change % in last 24h

  // BTC correlation
  btcDelta24h: number | null;  // BTC price change % in last 24h
  btcPrice: number | null;

  // Volume
  volumeRatio4h: number | null; // current 4h vol / 7d avg 4h vol

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

async function fetchBirdeyeOHLCV(timeframe: '1H' | '4H' | '1D', timeFrom: number, timeTo: number): Promise<OHLCV[]> {
  const url = `${BIRDEYE_OHLCV_URL}?address=${SOL_ADDRESS}&type=${timeframe}&time_from=${timeFrom}&time_to=${timeTo}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Birdeye ${res.status}`);
  const json = await res.json() as { data?: { items?: Array<{ c: number; o: number; h: number; l: number; v: number; unixTime: number }> } };
  if (!json.data?.items) return [];
  return json.data.items.map(item => ({
    timestamp: item.unixTime * 1000,
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
  }));
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

  async refresh(): Promise<void> {
    const errors: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. SOL 1H candles (last 24h) for short-term vol
    let vol1h: number | null = null;
    let solDelta24h: number | null = null;
    let candles1h: OHLCV[] = [];
    try {
      candles1h = await fetchBirdeyeOHLCV('1H', now - 86400, now);
      if (candles1h.length >= 3) {
        const closes = candles1h.map(c => c.close);
        vol1h = stdDev(logReturns(closes));
        solDelta24h = closes.length >= 2 ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;
      }
    } catch (err) {
      errors.push(`birdeye-1h: ${String(err).slice(0, 80)}`);
    }

    // 2. SOL 4H candles (last 7d) for medium-term vol + volume ratio
    let vol4h: number | null = null;
    let volumeRatio4h: number | null = null;
    try {
      const candles4h = await fetchBirdeyeOHLCV('4H', now - 7 * 86400, now);
      if (candles4h.length >= 6) {
        const closes = candles4h.map(c => c.close);
        vol4h = stdDev(logReturns(closes));

        // Volume ratio: last 4h volume vs 7d average
        const volumes = candles4h.map(c => c.volume);
        const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const lastVol = volumes[volumes.length - 1];
        volumeRatio4h = avgVol > 0 ? lastVol / avgVol : null;
      }
    } catch (err) {
      errors.push(`birdeye-4h: ${String(err).slice(0, 80)}`);
    }

    // 3. BTC price & 24h change
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

    // 4. Fear & Greed Index
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
