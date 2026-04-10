import 'dotenv/config';
import { initDb } from '../src/db/sqlite.js';
import { startTelegramReporter } from '../src/output/telegram.js';
import type { LiveData } from '../src/output/dashboard.js';

const db = initDb(process.env.DB_PATH!);

// Fetch live data from the running bot's API
async function getLiveFromApi(): Promise<LiveData | null> {
  try {
    const res = await fetch('http://localhost:3000/api/live');
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const liveData = await getLiveFromApi();
  console.log('Live data:', liveData ? `$${liveData.totalValueWithPosition?.toFixed(2)}, gas: ${liveData.gasSol?.toFixed(6)} SOL` : 'not available');

  const reporter = startTelegramReporter(
    { botToken: process.env.TELEGRAM_BOT_TOKEN!, chatId: process.env.TELEGRAM_CHAT_ID!, intervalMs: 999999 },
    db,
    () => liveData,
  );

  await reporter.sendNow();
  console.log('sent');
  process.exit(0);
}

main();
