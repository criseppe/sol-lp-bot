// Overnight experiment — send custom Telegram alerts
require('dotenv/config');

const message = process.argv[2] || 'Overnight experiment alert';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) { console.log('Missing TELEGRAM env vars'); process.exit(1); }

fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({chat_id: chatId, text: message, disable_web_page_preview: true}),
}).then(r => r.json()).then(j => {
  if (j.ok) console.log('SENT OK');
  else console.log('FAILED:', JSON.stringify(j));
}).catch(e => { console.log('ERROR:', e); });
