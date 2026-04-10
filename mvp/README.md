# SOL/USDC LP Bot — MVP

Paper-trading bot that validates 6 regime-aware LP rules against live Solana market data. No real capital. Single Node.js process.

## Prerequisites
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Helius free API key (https://helius.dev)

## Setup (5 minutes)
1. `pnpm install`
2. `cp .env.example .env`
3. Fill in your Helius RPC URL in `.env`
4. `pnpm dev`

## What you'll see
- Terminal: live cycle output every 30 seconds
- Dashboard: http://localhost:3000

## Bot modes
BOT_MODE is always SHADOW in MVP (paper trading only).
No real money is ever spent or moved.

## Data
SQLite database at DB_PATH (default: ./data/mvp.db).
View with any SQLite browser or: `sqlite3 ./data/mvp.db`

## Stopping
Ctrl+C — state is saved automatically.
Restart with `pnpm dev` — state is restored.
