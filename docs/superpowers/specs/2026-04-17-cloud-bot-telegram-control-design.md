# Cloud Bot with Telegram Control — Design Spec

**Date**: 2026-04-17
**Status**: Draft

## Goal

Run the Alpaca trading bot on a cloud VPS and control it (start, stop, status) via Telegram messages from a phone.

## Architecture

```
Your Phone (Telegram)
    ↕ /start, /stop, /status
VPS ($5/month — Hetzner, DigitalOcean, or Linode)
    ├── telegram-ctl.js  (always-on Node process, ~30MB RAM)
    │     └── Polls Telegram for commands, spawns/kills bot via PM2
    ├── PM2 process manager
    │     └── Manages alpaca-bot.js — start, stop, restart, crash recovery, logs
    ├── alpaca-bot.js   (runs during session hours)
    │     └── Connects to Alpaca API, trades, sends notification messages
    └── cron jobs
          ├── 9:25 AM ET Mon-Fri → pm2 start alpaca-bot
          └── 11:05 AM ET Mon-Fri → pm2 stop alpaca-bot
```

The Telegram listener is the control plane — it stays up even if the trading bot crashes, so you can always reach it.

## Components

### 1. `telegram-ctl.js` — Command Listener

Always-on Node.js process that polls Telegram using `node-telegram-bot-api`.

**Commands:**

| Command | Action | Reply |
|---------|--------|-------|
| `/start` | `pm2 start alpaca-bot` (or restart if already in PM2) | Mode, symbols, session time |
| `/stop` | `pm2 stop alpaca-bot` | "Bot stopped" |
| `/status` | `pm2 describe alpaca-bot` + read last 10 from trade-log.json | Running/stopped, uptime, recent trades |
| `/help` | Lists available commands | Command list |

**Auth**: Only messages from `TELEGRAM_CHAT_ID` are processed. All other messages are silently ignored.

**Implementation**: Uses long polling (not webhooks) so no need for a public URL or HTTPS setup. The bot token and chat ID come from the existing `.env` file.

### 2. PM2 Configuration — `ecosystem.config.cjs`

```js
module.exports = {
  apps: [{
    name: 'alpaca-bot',
    script: 'scripts/alpaca-bot.js',
    cwd: '/root/tradingview-mcp-jackson',
    env: { NODE_ENV: 'production' },
    max_restarts: 10,
    restart_delay: 5000,
    autorestart: true,
  }]
};
```

PM2 handles:
- Auto-restart on crash (up to 10 times)
- Log rotation (`pm2 install pm2-logrotate`)
- Process status tracking (`pm2 describe`)

### 3. Systemd Service for `telegram-ctl.js`

A systemd unit file ensures the Telegram listener starts on boot and stays running:

```ini
[Unit]
Description=Scalp Bot Telegram Controller
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/tradingview-mcp-jackson/scripts/telegram-ctl.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
WorkingDirectory=/root/tradingview-mcp-jackson

[Install]
WantedBy=multi-user.target
```

### 4. Cron Jobs — Session Scheduling

```cron
25 9 * * 1-5 cd /root/tradingview-mcp-jackson && pm2 start alpaca-bot
5 11 * * 1-5 cd /root/tradingview-mcp-jackson && pm2 stop alpaca-bot
```

- **9:25 AM ET** — starts bot 5 min before session, gives time to connect, fetch ATR, send morning brief
- **11:05 AM ET** — stops bot after session (positions already force-closed at 11:00 by bot logic)

Timezone: VPS should be set to `America/New_York` or cron should use `TZ=America/New_York` prefix.

### 5. No Changes to Bot Behavior

The trading bot itself (`alpaca-bot.js`) needs **no modifications**. It continues to:
- Force-close positions at session end (11:00 AM ET)
- Send trade signals, morning brief, EOD report via Telegram
- Log to `trade-log.json`
- Crash gracefully with log save

The `closeOnSessionEnd` config option from the brainstorm is **not added** — option 1 (force-close at session end) stays as the current behavior.

## Data Flow

```
Telegram message from user
    → telegram-ctl.js receives command
    → Executes pm2 start/stop/describe via child_process.exec()
    → Reads trade-log.json for /status
    → Replies via Telegram sendMessage
```

```
Cron trigger (9:25 AM)
    → pm2 start alpaca-bot
    → Bot connects to Alpaca, starts trading session
    → Morning brief sent via Telegram
    → Trades execute, notifications sent
    → 11:00 AM: positions force-closed
    → 11:05 AM: cron stops bot via pm2 stop
```

## Security

- **Auth**: Only `TELEGRAM_CHAT_ID` can issue commands. All other users are ignored.
- **No public ports**: Telegram uses outbound long polling — no inbound connections, no firewall rules needed.
- **Secrets**: `.env` file on VPS with same credentials as local. File permissions set to `600`.
- **SSH key auth only**: VPS disables password auth.
- **No TradingView dependency**: Bot doesn't need TradingView Desktop, browser, or GUI. Just Node.js.

## Deployment Steps (Manual, One-Time Setup)

1. Create VPS (Hetzner/DigitalOcean/Linode, Ubuntu 22.04+, $5/month)
2. SSH in, install Node.js 20+ and PM2
3. Clone repo to `/root/tradingview-mcp-jackson`
4. Copy `.env` with Alpaca + Telegram credentials
5. Install dependencies: `npm install`
6. Copy `ecosystem.config.cjs` to project root
7. Copy `telegram-ctl.js` to `scripts/`
8. Create systemd service for `telegram-ctl.js`
9. Enable systemd service: `systemctl enable scalp-bot-ctl`
10. Set up cron jobs for session scheduling
11. Start systemd service: `systemctl start scalp-bot-ctl`
12. Test: send `/start`, `/status`, `/stop` from Telegram

## Future Considerations (Not In Scope)

- `/config` command to change dryRun, symbols, or risk settings via Telegram
- `/positions` command to query current Alpaca positions
- `/pnl` command for on-demand P&L report
- Web dashboard for monitoring
- `closeOnSessionEnd: false` option (let positions ride past session)
- Docker-based deployment