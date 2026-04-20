// Dynamic wallet-aware operational parameters (Phase 19).
//
// Replaces hardcoded capital/USDC/SOL thresholds with formulas derived from
// operating_capital = min(wallet_equity, maxLiveCapitalUsdc).
//
// All dynamic values follow:
//   value = max(floor, operating_capital * pct)
//
// Why a floor? Percent-of-capital goes to zero on a shrinking wallet and leaves
// no sane absolute minimum (e.g. a $0.05 min-deploy would still pass the
// percent check but burns gas on dust). Floors clip the bottom.
//
// Why a cap? Excess idle capital above maxLiveCapitalUsdc sits in the wallet
// untouched. The bot operates ONLY on operating_capital, so scaling up the
// wallet past the cap doesn't inflate risk.

// Capital percentage scaling constants.
// Tuned so current $1k-scale wallet hits the floors (behavior unchanged),
// while a $25k wallet scales proportionally.
export const CAPITAL_PCT = {
  // Phase 19A (core 4)
  MIN_DEPLOY: 0.020,              // 2.0% of capital → min position size
  SOL_RESERVE: 0.0017,            // 0.17% of capital in SOL value (rent + slippage buffer)
  IDLE_REBALANCE_MIN: 0.012,      // 1.2% of capital → min idle to rebalance
  USDC_RESERVE: 0.0002,           // 0.02% of capital → wallet USDC floor (rent + dust)

  // Phase 19B (additional 6)
  STRATEGIC_REBALANCE_MIN: 0.010,       // 1.0%
  SOL_CONVERT_MIN: 0.005,               // 0.5%
  MANUAL_SWAP_DETECTION: 0.0005,        // 0.05%
  IDLE_REBALANCE_MIN_IMBALANCE: 0.001,  // 0.1%
  DEPLOY_MIN_THRESHOLD: 0.005,          // 0.5%
} as const;

// Hard floors. Used when the percent-of-capital calculation falls below these.
// Also the defaults for the runtime.*Floor config keys.
export const FLOOR_DEFAULTS = {
  MIN_DEPLOY_USDC: 50,
  SOL_RESERVE_SOL: 0.10,
  IDLE_REBALANCE_MIN_USDC: 50,
  USDC_RESERVE: 5,
  PAUSE_THRESHOLD_USDC: 100,

  STRATEGIC_REBALANCE_MIN_PORTFOLIO_USDC: 100,
  SOL_CONVERT_MIN_AMOUNT_USDC: 50,
  MANUAL_SWAP_DETECTION_MIN_SOL: 0.5,
  MANUAL_SWAP_DETECTION_MIN_USDC: 10,
  IDLE_REBALANCE_MIN_IMBALANCE_USDC: 5,
  DEPLOY_MIN_THRESHOLD_USDC: 5,
} as const;

export interface OperatingState {
  walletEquity: number;        // full portfolio value (wallet + position)
  operatingCapital: number;    // min(walletEquity, maxCap)
  maxCap: number;              // runtime.maxLiveCapitalUsdc
  excessIdle: number;          // walletEquity - operatingCapital (sits in wallet untouched)
  paused: boolean;             // true when walletEquity < pauseThreshold
  pauseReason?: string;
}

export function computeOperatingState(
  walletEquity: number,
  maxCap: number,
  pauseThreshold: number,
): OperatingState {
  if (walletEquity < pauseThreshold) {
    return {
      walletEquity,
      operatingCapital: 0,
      maxCap,
      excessIdle: 0,
      paused: true,
      pauseReason: `wallet_below_pause_threshold($${pauseThreshold.toFixed(0)})`,
    };
  }
  const operatingCapital = Math.min(walletEquity, maxCap);
  const excessIdle = Math.max(0, walletEquity - operatingCapital);
  return {
    walletEquity,
    operatingCapital,
    maxCap,
    excessIdle,
    paused: false,
  };
}

// ── Phase 19A: core 4 dynamic getters ─────────────────────────────────────
export function getDynamicMinDeployUsdc(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.MIN_DEPLOY);
}
export function getDynamicSolReserve(capital: number, solPrice: number, floorSol: number): number {
  if (solPrice <= 0) return floorSol;
  const usdReserve = capital * CAPITAL_PCT.SOL_RESERVE;
  const solReserve = usdReserve / solPrice;
  return Math.max(floorSol, solReserve);
}
export function getDynamicIdleRebalanceMinUsdc(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.IDLE_REBALANCE_MIN);
}
export function getDynamicUsdcReserve(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.USDC_RESERVE);
}

// ── Phase 19B: additional 6 dynamic getters ───────────────────────────────
export function getDynamicStrategicRebalanceMinPortfolio(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.STRATEGIC_REBALANCE_MIN);
}
export function getDynamicSolConvertMinAmount(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.SOL_CONVERT_MIN);
}
export function getDynamicManualSwapDetectionMinSol(capital: number, solPrice: number, floorSol: number): number {
  if (solPrice <= 0) return floorSol;
  const usd = capital * CAPITAL_PCT.MANUAL_SWAP_DETECTION;
  return Math.max(floorSol, usd / solPrice);
}
export function getDynamicManualSwapDetectionMinUsdc(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.MANUAL_SWAP_DETECTION);
}
export function getDynamicIdleRebalanceMinImbalance(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.IDLE_REBALANCE_MIN_IMBALANCE);
}
export function getDynamicDeployMinThreshold(capital: number, floor: number): number {
  return Math.max(floor, capital * CAPITAL_PCT.DEPLOY_MIN_THRESHOLD);
}

// ── DynamicParams: bundle that main cycle computes once per tick ──────────
export interface DynamicParams {
  minDeployUsdc: number;
  solReserveSol: number;
  idleRebalanceMinUsdc: number;
  usdcReserveUsdc: number;
  // Phase 19B will populate these as well; keep optional until wired.
  strategicRebalanceMinPortfolioUsdc?: number;
  solConvertMinAmountUsdc?: number;
  manualSwapDetectionMinSol?: number;
  manualSwapDetectionMinUsdc?: number;
  idleRebalanceMinImbalanceUsdc?: number;
  deployMinThresholdUsdc?: number;
}

export interface FloorsInput {
  minDeployUsdcFloor: number;
  solReserveFloor: number;           // in SOL
  idleRebalanceMinUsdcFloor: number;
  usdcReserveFloor: number;
  // Phase 19B floors — optional in 19A.
  strategicRebalanceMinPortfolioUsdcFloor?: number;
  solConvertMinAmountUsdcFloor?: number;
  manualSwapDetectionMinSolFloor?: number;
  manualSwapDetectionMinUsdcFloor?: number;
  idleRebalanceMinImbalanceUsdcFloor?: number;
  deployMinThresholdUsdcFloor?: number;
}

export function computeDynamicParams(
  opState: OperatingState,
  solPrice: number,
  floors: FloorsInput,
  scalingEnabled: boolean,
): DynamicParams {
  if (!scalingEnabled) {
    return {
      minDeployUsdc: floors.minDeployUsdcFloor,
      solReserveSol: floors.solReserveFloor,
      idleRebalanceMinUsdc: floors.idleRebalanceMinUsdcFloor,
      usdcReserveUsdc: floors.usdcReserveFloor,
      strategicRebalanceMinPortfolioUsdc: floors.strategicRebalanceMinPortfolioUsdcFloor,
      solConvertMinAmountUsdc: floors.solConvertMinAmountUsdcFloor,
      manualSwapDetectionMinSol: floors.manualSwapDetectionMinSolFloor,
      manualSwapDetectionMinUsdc: floors.manualSwapDetectionMinUsdcFloor,
      idleRebalanceMinImbalanceUsdc: floors.idleRebalanceMinImbalanceUsdcFloor,
      deployMinThresholdUsdc: floors.deployMinThresholdUsdcFloor,
    };
  }
  const cap = opState.operatingCapital;
  return {
    minDeployUsdc: getDynamicMinDeployUsdc(cap, floors.minDeployUsdcFloor),
    solReserveSol: getDynamicSolReserve(cap, solPrice, floors.solReserveFloor),
    idleRebalanceMinUsdc: getDynamicIdleRebalanceMinUsdc(cap, floors.idleRebalanceMinUsdcFloor),
    usdcReserveUsdc: getDynamicUsdcReserve(cap, floors.usdcReserveFloor),
    strategicRebalanceMinPortfolioUsdc: floors.strategicRebalanceMinPortfolioUsdcFloor != null
      ? getDynamicStrategicRebalanceMinPortfolio(cap, floors.strategicRebalanceMinPortfolioUsdcFloor)
      : undefined,
    solConvertMinAmountUsdc: floors.solConvertMinAmountUsdcFloor != null
      ? getDynamicSolConvertMinAmount(cap, floors.solConvertMinAmountUsdcFloor)
      : undefined,
    manualSwapDetectionMinSol: floors.manualSwapDetectionMinSolFloor != null
      ? getDynamicManualSwapDetectionMinSol(cap, solPrice, floors.manualSwapDetectionMinSolFloor)
      : undefined,
    manualSwapDetectionMinUsdc: floors.manualSwapDetectionMinUsdcFloor != null
      ? getDynamicManualSwapDetectionMinUsdc(cap, floors.manualSwapDetectionMinUsdcFloor)
      : undefined,
    idleRebalanceMinImbalanceUsdc: floors.idleRebalanceMinImbalanceUsdcFloor != null
      ? getDynamicIdleRebalanceMinImbalance(cap, floors.idleRebalanceMinImbalanceUsdcFloor)
      : undefined,
    deployMinThresholdUsdc: floors.deployMinThresholdUsdcFloor != null
      ? getDynamicDeployMinThreshold(cap, floors.deployMinThresholdUsdcFloor)
      : undefined,
  };
}

// ── Module-level "latest" holders ─────────────────────────────────────────
// Main cycle writes; all other call sites read through these.
// Initialised to floors so startup reads before first cycle still work.
let currentOpState: OperatingState = {
  walletEquity: 0, operatingCapital: 0, maxCap: 0, excessIdle: 0, paused: false,
};
let currentDyn: DynamicParams = {
  minDeployUsdc: FLOOR_DEFAULTS.MIN_DEPLOY_USDC,
  solReserveSol: FLOOR_DEFAULTS.SOL_RESERVE_SOL,
  idleRebalanceMinUsdc: FLOOR_DEFAULTS.IDLE_REBALANCE_MIN_USDC,
  usdcReserveUsdc: FLOOR_DEFAULTS.USDC_RESERVE,
  strategicRebalanceMinPortfolioUsdc: FLOOR_DEFAULTS.STRATEGIC_REBALANCE_MIN_PORTFOLIO_USDC,
  solConvertMinAmountUsdc: FLOOR_DEFAULTS.SOL_CONVERT_MIN_AMOUNT_USDC,
  manualSwapDetectionMinSol: FLOOR_DEFAULTS.MANUAL_SWAP_DETECTION_MIN_SOL,
  manualSwapDetectionMinUsdc: FLOOR_DEFAULTS.MANUAL_SWAP_DETECTION_MIN_USDC,
  idleRebalanceMinImbalanceUsdc: FLOOR_DEFAULTS.IDLE_REBALANCE_MIN_IMBALANCE_USDC,
  deployMinThresholdUsdc: FLOOR_DEFAULTS.DEPLOY_MIN_THRESHOLD_USDC,
};

export function setCurrent(opState: OperatingState, dyn: DynamicParams): void {
  currentOpState = opState;
  currentDyn = dyn;
}

export function getCurrentOperatingState(): OperatingState {
  return currentOpState;
}

export function getCurrentDyn(): DynamicParams {
  return currentDyn;
}
