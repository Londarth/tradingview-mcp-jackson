# Scalp Bot

Alpaca trading bot with two strategies, Telegram control, and backtesting. Runs on a VPS, controlled via Telegram commands, started by cron on trading days.

**Strategies:**
- **Touch & Turn** — Opening range breakout scalper. One trade per day per symbol.
- **Pivot Reversion** — Fades S1/R1 pivot rejections on thin-orderbook stocks. Up to 3 trades per day.

---

## Architecture

```
Phone (Telegram) ←→ VPS
                       ├── telegram-ctl.js  (always-on systemd service)
                       ├── PM2 process manager
                       │     ├── touch-turn-bot.js   (T&T: 9:25–11:30 ET)
                       │     └── pivot-revert-bot.js  (Pivot: 9:45–11:30 ET)
                       └── cron
                             ├── 8:55 ET → pre-market-scan.js
                             └── 9:25 ET → start bots
```

---

## Touch & Turn Strategy

1. Wait for 15-min opening range (9:30–9:45 ET) to close
2. Confirm liquidity candle: range >= 25% of daily ATR(14)
3. Red candle (close < open) → LONG limit at range low
4. Green candle (close > open) → SHORT limit at range high
5. Target: 61.8% of range from entry (Fibonacci)
6. Stop: half the target distance (2:1 R:R)
7. Cancel unfilled orders at 11:00 ET, close open positions at 11:30 ET
8. One trade per day max

---

## Pivot Reversion Strategy

1. Compute floor trader pivots (P, R1-R3, S1-S3, midS1, midR1) from prior day H/L/C
2. Filter stocks by microstructure: ATR% >= 4%, avg volume < 10M, price $3-$60
3. Detect wick rejections and failed breakouts at S1/R1
4. Enter long on S1 rejection (target P), short on R1 rejection (target P)
5. Stop-loss just beyond pivot level (0.3× ATR)
6. Min R:R of 1.5, max 3 trades/day per symbol, 30-min cooldown between entries

**Confirmed edge** (PF >= 1.3): PLTR, SMR, LCID, SOFI, BTDR, DKNG, QS

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/Londarth/scalp-bot.git ~/scalp-bot
cd ~/scalp-bot
npm install
```

### 2. Configure credentials

Copy the template and fill in your values:

```bash
cp .env.example .env
```

Required env vars:

```
ALPACA_API_KEY=***
ALPACA_SECRET_KEY=***
ALPACA_PAPER=true
TELEGRAM_BOT_TOKEN=***
TELEGRAM_CHAT_ID=...
```

### 3. Run locally (paper mode)

```bash
node scripts/touch-turn-bot.js
node scripts/pivot-revert-bot.js
```

Or use PM2:

```bash
pm2 start ecosystem.config.cjs --only touch-turn-bot
pm2 start ecosystem.config.cjs --only pivot-revert-bot
```

---

## Telegram Commands

Send commands to your Telegram bot from anywhere:

| Command | Action |
|---------|--------|
| `/start` | Start the T&T trading bot via PM2 |
| `/stop` | Stop the T&T trading bot |
| `/status` | Show bot status + recent activity |
| `/help` | List available commands |

Only messages from your `TELEGRAM_CHAT_ID` are processed.

---

## VPS Deployment

### Automated setup

```bash
git clone https://github.com/Londarth/scalp-bot.git /root/scalp-bot
cd /root/scalp-bot
bash scripts/setup-vps.sh
```

This installs Node.js, PM2, sets up systemd for the Telegram controller, and configures cron jobs for session scheduling.

### Manual VPS management

```bash
pm2 list                         # Show managed processes
pm2 logs touch-turn-bot          # T&T bot logs
pm2 logs pivot-revert-bot        # Pivot bot logs
pm2 describe touch-turn-bot      # T&T status
sudo systemctl status scalp-bot-ctl  # Telegram controller status
```

---

## Resilience

- **Retry/backoff**: All Alpaca and Telegram API calls retry with exponential backoff (3 retries, 1s base delay)
- **Graceful shutdown**: SIGINT/SIGTERM cancels open orders, closes positions past hard-exit time, saves logs
- **Config validation**: Bot exits with a clear error if required env vars are missing
- **Periodic log saving**: Trade log saved every 5 minutes during monitoring
- **Orphan detection**: Positions not tracked by the bot trigger a Telegram warning with close/keep buttons

---

## Backtesting

```bash
npm run backtest            # Day-trading strategies (Aziz ORB, T&T, Pivot Reversion)
npm run scan                # Scanner-mode backtest (full universe, realistic sim)
npm run swing-backtest      # Swing trading strategies (CRSI2, IBS, Failed Breakout)
```

---

## Configuration

| File | Purpose |
|------|---------|
| `.env` | All secrets and config (gitignored). See `.env.example` for full list. |
| `.env.example` | Template documenting all required and optional env vars |
| `ecosystem.config.cjs` | PM2 process definitions for both bots |

All strategy parameters are configurable via env vars with sensible defaults. No code edits needed.

---

## Project Structure

```
scalp-bot/
├── scripts/
│   ├── touch-turn-bot.js       # T&T trading bot
│   ├── pivot-revert-bot.js     # Pivot reversion trading bot
│   ├── pivot-discover.js       # Pivot stock discovery scanner
│   ├── telegram.js             # Unified Telegram module
│   ├── telegram-ctl.js         # Telegram command listener (VPS)
│   ├── lib/
│   │   ├── retry.js            # Retry/backoff utility
│   │   ├── indicators.js       # SMA, ATR, RSI, VWAP, Pivots, PivotRejection
│   │   ├── alpaca-data.js     # Fetch bars, normalize, ATR map
│   │   ├── backtest-utils.js  # Stats, combine results, calcQty
│   │   ├── scanner.js          # Scanner filters + microstructure filter
│   │   └── time.js             # ET timezone helpers
│   ├── backtest.js             # Day-trading backtester (4 strategies)
│   ├── pre-market-scan.js     # Pre-market scanner
│   ├── swing-backtest.js       # Swing trading backtester
│   ├── setup-vps.sh            # VPS provisioning script
│   └── scalp-bot-ctl.service   # Systemd unit file template
├── tests/
│   ├── touch-turn-bot.test.js  # Bot core logic tests
│   ├── telegram-ctl.test.js   # Telegram controller tests
│   ├── indicators.test.js      # Indicator unit tests
│   ├── scanner.test.js         # Scanner/microstructure tests
│   └── retry.test.js           # Retry/backoff tests
├── skills/
│   └── scalp-bot/SKILL.md      # Claude Code skill
├── docs/
│   └── plans/                  # Implementation plans
├── ecosystem.config.cjs        # PM2 config (2 bots)
├── .env.example                # Env var template
└── .env                        # Credentials (gitignored)
```

---

## Disclaimer

This project is provided **for personal, educational, and research purposes only**. Trading involves significant risk. Use at your own risk.

## License

MIT — see [LICENSE](LICENSE).