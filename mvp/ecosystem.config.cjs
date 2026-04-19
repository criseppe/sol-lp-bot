// pm2 process config for sol-lp-bot.
//
// Crash-loop alarm: if the bot exits within min_uptime of starting, pm2
// counts it as a failed boot. After max_restarts such failures, pm2 stops
// retrying — the process goes 'errored' and surfaces loudly in `pm2 status`
// instead of silently looping forever.
//
// Apply changes with:
//   pm2 delete sol-lp-bot
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// .cjs because package.json has "type": "module".
module.exports = {
  apps: [{
    name: 'sol-lp-bot',
    script: 'npx',
    args: 'tsx src/main.ts',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    min_uptime: 30000,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 5000,
    out_file: '/home/botuser/.pm2/logs/sol-lp-bot-out.log',
    error_file: '/home/botuser/.pm2/logs/sol-lp-bot-error.log',
    merge_logs: true,
    time: false,
  }],
};
