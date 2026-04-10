import { HermesClient } from '@pythnetwork/hermes-client';
import type { PythPrice } from '../types.js';

// Hermes SSE EventSource type
type HermesEventSource = { close: () => void; onmessage: ((event: { data: string }) => void) | null; onerror: ((error: unknown) => void) | null };

export class OracleService {
  private client: HermesClient;
  private feedId: string;
  private maxConfidencePct: number;
  private maxStalenessSec: number;
  private lastPrice: PythPrice | null = null;
  private lastUpdateTime = 0;
  private badPriceCount = 0;
  private eventSource: HermesEventSource | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(feedId: string, maxConfidencePct: number, maxStalenessSec: number, hermesUrl = 'https://hermes.pyth.network') {
    this.client = new HermesClient(hermesUrl);
    this.feedId = feedId;
    this.maxConfidencePct = maxConfidencePct;
    this.maxStalenessSec = maxStalenessSec;
  }

  async start(): Promise<void> {
    // Do an initial fetch
    await this.fetchLatest();

    // Then poll every 2 seconds for updates
    this.pollInterval = setInterval(() => {
      this.fetchLatest().catch((err) => {
        console.log(JSON.stringify({
          level: 'error',
          msg: 'hermes poll error',
          error: String(err),
          timestamp: Date.now(),
        }));
      });
    }, 2000);

    console.log(JSON.stringify({
      level: 'info',
      msg: 'oracle started (hermes polling)',
      feed: this.feedId,
      timestamp: Date.now(),
    }));
  }

  private async fetchLatest(): Promise<void> {
    const response = await this.client.getLatestPriceUpdates([this.feedId], { parsed: true });
    if (!response.parsed || response.parsed.length === 0) return;

    for (const feed of response.parsed) {
      this.handlePriceUpdate(feed);
    }
  }

  handlePriceUpdate(feed: { id: string; price: { price: string; expo: number; conf: string; publish_time: number } }): void {
    const rawPrice = Number(feed.price.price) * Math.pow(10, feed.price.expo);
    const rawConf = Number(feed.price.conf) * Math.pow(10, feed.price.expo);
    const publishTime = feed.price.publish_time;

    // Validate staleness
    const ageSec = Date.now() / 1000 - publishTime;
    if (ageSec > this.maxStalenessSec) {
      this.badPriceCount++;
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'pyth price rejected',
        reason: `stale: ${ageSec.toFixed(1)}s > ${this.maxStalenessSec}s`,
        badPriceCount: this.badPriceCount,
        timestamp: Date.now(),
      }));
      return;
    }

    // Validate price is positive
    if (rawPrice <= 0 || !isFinite(rawPrice)) {
      this.badPriceCount++;
      console.log(JSON.stringify({
        level: 'warn', msg: 'pyth price rejected', reason: `invalid price: ${rawPrice}`,
        badPriceCount: this.badPriceCount, timestamp: Date.now(),
      }));
      return;
    }

    // Validate confidence
    const confidencePct = (rawConf / rawPrice) * 100;
    if (!isFinite(confidencePct) || confidencePct > this.maxConfidencePct) {
      this.badPriceCount++;
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'pyth price rejected',
        reason: `confidence too wide: ${confidencePct.toFixed(3)}% > ${this.maxConfidencePct}%`,
        price: rawPrice,
        confidence: rawConf,
        badPriceCount: this.badPriceCount,
        timestamp: Date.now(),
      }));
      return;
    }

    this.lastPrice = {
      price: rawPrice,
      confidence: rawConf,
      publishTime,
      valid: true,
    };
    this.lastUpdateTime = Date.now();
  }

  getPrice(): PythPrice | null {
    if (!this.lastPrice) return null;
    const ageSec = (Date.now() - this.lastUpdateTime) / 1000;
    if (ageSec > this.maxStalenessSec) return null;
    return this.lastPrice;
  }

  getBadPriceCount(): number {
    return this.badPriceCount;
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    console.log(JSON.stringify({
      level: 'info',
      msg: 'oracle stopped',
      timestamp: Date.now(),
    }));
  }
}
