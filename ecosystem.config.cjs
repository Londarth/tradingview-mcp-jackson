module.exports = {
  apps: [{
    name: 'alpaca-bot',
    script: 'scripts/alpaca-bot.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 10,
    restart_delay: 5000,
    autorestart: true,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/alpaca-bot-error.log',
    out_file: 'logs/alpaca-bot-out.log',
    merge_logs: true,
  }, {
    name: 'touch-turn-bot',
    script: 'scripts/touch-turn-bot.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 3,
    autorestart: false,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/touch-turn-bot-error.log',
    out_file: 'logs/touch-turn-bot-out.log',
    merge_logs: true,
  }],
};