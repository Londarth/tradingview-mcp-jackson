---
name: scalp-bot
description: Control the Touch & Turn and Pivot Reversion Alpaca trading bots via PM2 and Telegram.
---

# Scalp Bot Skill

Control the Touch & Turn and Pivot Reversion Alpaca trading bots. The bots run on a VPS via PM2 and can be managed through Telegram or PM2 commands.

## `/scalp-bot start`

1. **Start the T&T bot via PM2**:
   ```
   cd ~/scalp-bot && pm2 start ecosystem.config.cjs --only touch-turn-bot
   ```
2. **Confirm startup** — check logs contain "Connected:" and "Touch & Turn Bot"
3. **Report to user**: bot is running, current mode (PAPER/LIVE, DRY_RUN)

## `/scalp-bot stop`

1. Stop the T&T bot:
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

The T&T bot uses `DRY_RUN=true` in `.env` to enable dry-run mode (signals only, no orders placed).

1. Read `~/scalp-bot/.env`
2. Toggle `DRY_RUN` value (true → false or false → true)
3. Write updated `.env`
4. Report the new mode
5. Remind user that the bot must be restarted for changes to take effect

## Two Strategies

The project has two bots that share the same Alpaca paper account:

1. **Touch & Turn (`touch-turn-bot`)** — Opening range breakout scalper. One trade per day per symbol. Entry 9:30-11:00, hard exit 11:30.
2. **Pivot Reversion (`pivot-revert-bot`)** — Fades S1/R1 pivot rejections on thin-orderbook stocks (ATR% >= 4%). Up to 3 trades/day, entry 9:45-11:15, 30-min cooldown.

Both track their own positions independently. They share the Telegram module and Alpaca credentials but use separate log files and PM2 processes.

## Cloud Deployment (VPS)

The bots run on a cloud VPS with Telegram-based control.

### Setup

```bash
# On a fresh Ubuntu VPS:
git clone https://github.com/Londarth/scalp-bot.git /root/scalp-bot
cd /root/scalp-bot
bash scripts/setup-vps.sh
```

### Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Start the T&T bot via PM2 |
| `/stop` | Stop the T&T bot via PM2 |
| `/status` | Show running state, mode, recent trades |
| `/help` | List available commands |

Only messages from `TELEGRAM_CHAT_ID` (set in `.env`) are processed.

### VPS Management

- `pm2 list` — Show managed processes
- `pm2 logs touch-turn-bot` — T&T bot logs
- `pm2 logs pivot-revert-bot` — Pivot bot logs
- `pm2 describe touch-turn-bot` — T&T status
- `sudo systemctl status scalp-bot-ctl` — Telegram controller status
- `sudo journalctl -u scalp-bot-ctl -f` — Controller logs

## Configuration

- **Credentials**: `~/scalp-bot/.env`
  - Required: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  - `ALPACA_PAPER` — true (paper) or false (live)
  - `DRY_RUN=true` — signals only, no orders placed

- **Touch & Tun strategy** (all optional, with defaults):
  - `UNIVERSE` — Comma-separated symbols (default: PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK)
  - `POSITION_PCT` — % of equity per trade (default: 10)
  - `ATR_PCT_THRESHOLD` — Min range/ATR ratio (default: 0.25)
  - `TARGET_FIB` — Fibonacci target level (default: 0.618)
  - `RR_RATIO` — Risk:reward ratio (default: 2.0)
  - `SESSION_END` — Entry window close HHMM (default: 1100)
  - `HARD_EXIT` — Force-close time HHMM (default: 1130)
  - `POLL_INTERVAL_MS` — Polling interval (default: 30000)
  - `MIN_ATR` — Min daily ATR filter (default: 0.50)
  - `MIN_POSITION_USD` — Min position size USD (default: 100)
  - `RISK_PCT` — % of equity risk per trade (default: 0, uses POSITION_PCT)
  - `SCANNER_TOP_N` — Candidates selected per day (default: 5)
  - `UNFILLED_TIMEOUT_MIN` — Cancel unfilled orders after N min (default: 15)
  - `DAILY_LOSS_LIMIT_PCT` — Max daily loss % of equity (default: 3)
  - `MAX_EQUITY_PCT` — Max total equity usage % (default: 30)

- **Pivot Reversion strategy** (all optional, with defaults):
  - `PIVOT_UNIVERSE` — Falls back to UNIVERSE if not set
  - `PIVOT_MAX_TRADES` — Max trades per day (default: 3)
  - `PIVOT_STOP_ATR_MULT` — Stop-loss ATR multiplier (default: 0.3)
  - `PIVOT_MIN_RR` — Min risk:reward (default: 1.5)
  - `PIVOT_SESSION_START` — Entry window open HHMM (default: 945)
  - `PIVOT_SESSION_END` — Entry window close HHMM (default: 1115)
  - `PIVOT_COOLDOWN_BARS` — Cooldown after trade (default: 6)
  - `PIVOT_MIN_ATR_PCT` — Min ATR% filter (default: 4.0)
  - `PIVOT_MAX_ATR_PCT` — Max ATR% filter (default: 10.0)

- **Backtest params**:
  - `SLIPPAGE_BPS` — Slippage in basis points (default: 5)
  - `COMMISSION_PER_SHARE` — Commission per share (default: 0.005)
  - `API_TIMEOUT_MS` — Alpaca API timeout (default: 30000)

See `.env.example` for the full list.

## Safety Rules

- Always warn the user before switching from paper to live trading (`ALPACA_PAPER=false`)
- Always warn before disabling dry-run mode
- Never modify `.env` API keys without explicit user instruction
- Both bots auto-close all positions at their respective hard-exit times
- Orphan positions (not tracked by either bot) trigger a Telegram warning with close/keep buttons
- The bots validate required env vars on startup and exit with a clear error if any are missing
- SIGTERM (from PM2) and SIGINT both trigger graceful shutdown: cancel open orders, close positions past hard-exit time, save logs