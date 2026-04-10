import type { CycleResult, RebalanceEvent, Regime } from '../types.js';
import type { ComparisonSnapshot } from '../paper/ledger.js';

// ANSI colour codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

const REGIME_COLOUR: Record<Regime, string> = {
  RANGING: BLUE,
  BULLISH_TREND: GREEN,
  BEARISH_TREND: RED,
  EXTREME: MAGENTA,
};

function fmt(n: number, decimals = 2): string {
  const sign = n >= 0 ? '' : '-';
  const abs = Math.abs(n);
  const parts = abs.toFixed(decimals).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + parts.join('.');
}

function fmtUsd(n: number): string {
  const colour = n >= 0 ? GREEN : RED;
  const sign = n >= 0 ? '+' : '';
  return `${colour}${sign}$${fmt(n)}${RESET}`;
}

function fmtPct(n: number): string {
  const colour = n >= 0 ? GREEN : RED;
  const sign = n >= 0 ? '+' : '';
  return `${colour}${sign}${fmt(n, 1)}%${RESET}`;
}

function proxColour(pct: number): string {
  if (pct > 75) return RED;
  if (pct > 50) return YELLOW;
  return GREEN;
}

function pad(s: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = len - stripped.length;
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

const W = 61; // box width
const SEP = '-'.repeat(W - 2);

let lastLineCount = 0;

export function printCycle(result: CycleResult, comparison: ComparisonSnapshot): void {
  // Clear previous output
  if (lastLineCount > 0) {
    process.stdout.write(`\x1b[${lastLineCount}A\x1b[0J`);
  }

  const ts = new Date(result.timestamp).toLocaleTimeString();
  const regimeColour = REGIME_COLOUR[result.regime];
  const inRangeStr = result.inRange
    ? `${GREEN}YES${RESET}`
    : `${RED}NO${RESET}`;
  const proxDown = Math.round(result.proxToLower * 100);
  const proxUp = Math.round(result.proxToUpper * 100);

  const b = comparison.bot;
  const n = comparison.naive;

  const lines: string[] = [];
  const hr = `+${SEP}+`;
  const hrMid = `+${'-'.repeat(26)}+${'-'.repeat(W - 29)}+`;
  const hrMidClose = `+${'-'.repeat(26)}+${'-'.repeat(W - 29)}+`;

  lines.push(hr);
  lines.push(`| ${BOLD}SOL/USDC LP Bot${RESET}  ${DIM}SHADOW MODE${RESET}  ${DIM}${ts}${RESET}`);
  lines.push(hr);
  lines.push(`|  SOL Price:  ${BOLD}$${fmt(result.price)}${RESET}          Regime: ${regimeColour}${BOLD}${result.regime}${RESET}`);
  lines.push(`|  In Range:   ${inRangeStr}              Prox: ${proxColour(proxDown)}${proxDown}%${RESET} down  ${proxColour(proxUp)}${proxUp}%${RESET} up`);

  // Range bar
  if (b.regime) {
    const pos = comparison.bot;
    lines.push(`|`);
  }

  lines.push(hrMid);
  lines.push(`|  ${BOLD}BOT STRATEGY${RESET}          |  ${BOLD}NAIVE BENCHMARK${RESET}`);
  lines.push(`|  Portfolio: ${pad(`$${fmt(b.portfolioValue)}`, 12)} |  Portfolio: $${fmt(n.portfolioValue)}`);
  lines.push(`|  Net P&L:   ${pad(fmtUsd(b.netPnl), 22)} |  Net P&L:   ${fmtUsd(n.netPnl)}`);
  lines.push(`|  Net APR:   ${pad(fmtPct(b.netApr), 22)} |  Net APR:   ${fmtPct(n.netApr)}`);
  lines.push(`|  Fees:      ${pad(fmtUsd(b.cumFees), 22)} |  Fees:      ${fmtUsd(n.cumFees)}`);
  lines.push(`|  IL cost:   ${pad(fmtUsd(b.cumIL), 22)} |  IL cost:   ${fmtUsd(n.cumIL)}`);
  lines.push(`|  Rebalances: ${pad(String(b.rebalanceCount), 11)} |  Rebalances: ${n.rebalanceCount}`);
  lines.push(hrMidClose);

  const advPct = n.netPnl !== 0
    ? ((comparison.advantage / Math.abs(n.netPnl)) * 100)
    : 0;
  lines.push(`|  Advantage: ${fmtUsd(comparison.advantage)}  (${fmtPct(advPct)} vs naive)`);
  lines.push(`|  Last event: ${BOLD}${result.eventType}${RESET}  ${DIM}${result.botState}${RESET}`);
  lines.push(hr);

  const output = lines.join('\n') + '\n';
  process.stdout.write(output);
  lastLineCount = lines.length;
}

export function printEvent(event: RebalanceEvent): void {
  const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const regimeColour = REGIME_COLOUR[event.regime] || '';
  console.log(
    `${DIM}[${time}]${RESET} ⚡ ${BOLD}${event.eventType}${RESET}  $${fmt(event.price)}  → ${event.note}  ${regimeColour}[${event.regime}]${RESET}`,
  );
}
