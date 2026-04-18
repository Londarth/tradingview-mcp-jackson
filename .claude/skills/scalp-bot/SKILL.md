---
name: scalp-bot
description: Control the Touch & Turn Alpaca trading bot via PM2 and Telegram.
---

# Scalp Bot Skill

Control the Touch & Turn Alpaca trading bot. The bot runs on a VPS via PM2 and can be managed through Telegram or PM2 commands.

## `/scalp-bot start`

1. **Start the bot via PM2**:
   ```
   cd ~/scalp-bot && pm2 start ecosystem.config.cjs --only touch-turn-bot
   ```

2. **Confirm startup** — check logs contain "Connected:" and "Touch & Turn Bot"

3. **Report to user**: bot is running, current mode (PAPER/LIVE, DRY_RUN)

## `/scalp-bot stop`

1. Stop the bot:
   ```
   pm2 stop touch-turn-bot
   ```
2. Confirm process is stopped
3. Report to user that the bot has been stopped

## `/scalp-bot status`

1. Check if the bot process is running: `pm2 describe touch-turn-bot`
2. Read the last 10 entries from `scripts/touch-turn-log.json` to show recent activity
3. Report: running/stopped, uptime, last activity

## `/scalp-bot dry-run`

The Touch & Turn bot uses `DRY_RUN=true` in `.env` to enable dry-run mode (signals only, no orders placed).

1. Read `~/scalp-bot/.env`
2. Toggle `DRY_RUN` value (true → false or false → true)
3. Write updated `.env`
4. Report the new mode
5. Remind user that the bot must be restarted for changes to take effect

## Configuration

- **Credentials**: `~/scalp-bot/.env`
  - `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER`
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  - `DRY_RUN=true` — signals only, no orders placed

## Safety Rules

- Always warn the user before switching from paper to live trading (`ALPACA_PAPER=false`)
- Always warn before disabling dry-run mode
- Never modify `.env` API keys without explicit user instruction
- The bot auto-closes all positions at 11:30 AM ET