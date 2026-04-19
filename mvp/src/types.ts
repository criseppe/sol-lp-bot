export type Regime = 'RANGING' | 'BULLISH_TREND' | 'BEARISH_TREND' | 'EXTREME';

export type BotState =
  | 'IDLE'
  | 'ACTIVE'
  | 'REBALANCING'
  | 'HALTED';

export type EventType =
  | 'STARTUP'
  | 'PRICE_UPDATE'
  | 'REGIME_CHANGE'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'T1_DOWNSIDE'
  | 'T1_UPSIDE'
  | 'OOR_BELOW'
  | 'OOR_ABOVE'
  | 'PULLBACK_REENTRY'
  | 'PULLBACK_TIMEOUT'
  | 'FEE_HARVEST'
  | 'CIRCUIT_BREAKER'
  | 'CYCLE_SKIP'
  | 'LIQUIDITY_ADDED'
  | 'AUTO_DEPLOY'
  | 'STRATEGIC_REBALANCE';

export interface PythPrice {
  price: number;
  confidence: number;
  publishTime: number;
  valid: boolean;
}

export interface PoolState {
  tickCurrentIndex: number;
  sqrtPriceX64: string;
  liquidity: string;
  feeRate: number;         // on-chain feeRate (e.g. 3000 = 0.30%)
  lastUpdated: number;
}

export interface RegimeParams {
  rangeWidthPct: number;
  skewDown: number;
  skewUp: number;
  proxThresholdLower: number;
  proxThresholdUpper: number;
  deployPct: number;
  solReentrySplit: number;
  harvestIntervalDays: number;
  harvestSolConvertPct: number;
  usdcDepositPct: number; // fraction of deposit that must be USDC (reserve gate input)
  deployRatioTolerance: number; // max price deviation from range center for auto-deploy (0-1)
  basisGateThreshold: number; // price must be >= basis * threshold to open (e.g. 0.999 = 0.1% buffer)
  proximityDeployThreshold: number; // max proximity to lower bound before auto-deploy skips (0-1)
  reserveFloorPct: number; // reserve floor as fraction of portfolio (0-1)
  solConvertBasisMultiplier: number; // price must be >= basis × this (per-regime) before SolConvert fires (non-decay path)
  progressiveBasisDecayStartHours: number;    // per-regime grace period before decay starts
  progressiveBasisDecayPerInterval: number;   // per-regime decrement per interval (0.001 = 0.1%)
  progressiveBasisDecayMinThreshold: number;  // per-regime floor multiplier (e.g., 0.98 = 2% max loss)
}

export interface RangeBounds {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
}

export interface ProximityState {
  proxToLower: number;      // 0.0 (at centre) → 1.0 (at lower edge)
  proxToUpper: number;      // 0.0 (at centre) → 1.0 (at upper edge)
  inRange: boolean;
  centre: number;
}

export interface PaperPosition {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  entryPrice: number;
  solAmount: number;
  usdcAmount: number;
  entryTime: number;
  regime: Regime;
}

export interface PaperLedger {
  solBalance: number;
  usdcBalance: number;
  openPosition: PaperPosition | null;
  cumFeesSol: number;
  cumFeesUsdc: number;
  cumIL: number;
  cumGas: number;           // always near 0 on Solana, tracked for completeness
  rebalanceCount: number;
  t1TriggerCount: number;
  daysInRange: number;
  totalCycles: number;
  startTime: number;
  peakValue: number;
}

export interface CycleResult {
  timestamp: number;
  price: number;
  regime: Regime;
  botState: BotState;
  proxToLower: number;
  proxToUpper: number;
  inRange: boolean;
  eventType: EventType;
  eventNote: string;
  portfolioValue: number;
  cumFees: number;
  cumIL: number;
  netPnl: number;
  netApr: number;
}

export interface RebalanceEvent {
  timestamp: number;
  eventType: EventType;
  price: number;
  regime: Regime;
  note: string;
  solBefore: number;
  usdcBefore: number;
  solAfter: number;
  usdcAfter: number;
  feeSol: number;
  feeUsdc: number;
  ilAtClose: number;
}
