import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { parsePriceData, PriceStatus } from '@pythnetwork/client';

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const wsUrl = process.env.RPC_WS_URL!;
  const feedAddr = process.env.PYTH_SOL_USD_FEED!;

  console.log('RPC URL:', rpcUrl.replace(/api-key=.*/, 'api-key=***'));
  console.log('WS URL:', wsUrl.replace(/api-key=.*/, 'api-key=***'));
  console.log('Feed:', feedAddr);

  // 1. Try HTTP fetch first
  const conn = new Connection(rpcUrl);
  console.log('\n--- HTTP fetch ---');
  try {
    const accountInfo = await conn.getAccountInfo(new PublicKey(feedAddr));
    if (!accountInfo) {
      console.log('Account not found!');
      return;
    }
    console.log('Account data length:', accountInfo.data.length);
    const priceData = parsePriceData(accountInfo.data);
    console.log('Status:', PriceStatus[priceData.aggregate.status]);
    console.log('Price:', priceData.aggregate.price);
    console.log('Confidence:', priceData.aggregate.confidence);
    console.log('Publish slot:', priceData.aggregate.publishSlot);
  } catch (err) {
    console.log('HTTP fetch error:', err);
  }

  // 2. Try WebSocket subscription
  console.log('\n--- WebSocket subscription ---');
  const wsConn = new Connection(rpcUrl, { wsEndpoint: wsUrl });
  let received = false;
  const subId = wsConn.onAccountChange(
    new PublicKey(feedAddr),
    (accountInfo) => {
      console.log('WS update received! Data length:', accountInfo.data.length);
      const priceData = parsePriceData(accountInfo.data);
      console.log('Status:', PriceStatus[priceData.aggregate.status]);
      console.log('Price:', priceData.aggregate.price);
      received = true;
    },
    'confirmed',
  );
  console.log('Subscription ID:', subId);

  // Wait up to 10s
  for (let i = 0; i < 100; i++) {
    if (received) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!received) {
    console.log('No WS updates received in 10s');
  }

  await wsConn.removeAccountChangeListener(subId);
  process.exit(0);
}

main();
