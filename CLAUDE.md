# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Alpaca trading bot with two strategies — Touch & Turn scalper and Pivot Reversion — with Telegram control, PM2 process management, and backtesting. Runs on a Hetzner VPS, controlled via Telegram commands, started by cron on trading days.

## Architecture

```
Phone (Telegram) ←→ telegram-ctl.js (always-on systemd service)
                       ↓ PM2 commands
pre-market-scan.js (8:55 ET) → watchlist.json
                       ↓
   ┌──────────────────┼──────────────────┐
   │                  │                   │
touch-turn-bot.js   pivot-revert-bot.js  pivot-discover.js
(session: 9:25–11:30)  (session: 9:45–11:30)  (scanner/discovery)
   │                  │
   └──────────┬───────┘
              ↓ REST API
         Alpaca API ←→ Market data + order execution
              ↓
         Telegram notifications
```

## Commands

```bash
# Run the bots
npm start                           # node scripts/touch-turn-bot.js

# Pre-market scanner (run at 8:55 ET before bot starts)
npm run pre-market                  # node scripts/pre-market-scan.js

# Tests
npm test                            # Run all test suites
npm run test:bot                    # Bot core logic tests only
npm run test:ctl                    # Telegram controller tests only
npm run test:indicators             # Indicator unit tests only

# Backtesting
npm run backtest                    # Day-trading strategies (single symbol)
npm run scan                        # Scanner-mode backtest (full universe, realistic sim)
npm run swing-backtest              # Swing trading strategies

# PM2 (on VPS)
pm2 start ecosystem.config.cjs --only touch-turn-bot
pm2 start ecosystem.config.cjs --only pivot-revert-bot
pm2 stop touch-turn-bot
pm2 stop pivot-revert-bot
pm2 logs touch-turn-bot
pm2 logs pivot-revert-bot
```

## Key Patterns

### Alpaca Data Field Names
Alpaca v2 bars use `OpenPrice`, `HighPrice`, `LowPrice`, `ClosePrice` (not `Open`, `High`, etc.). The bot's `norm()` function normalizes these. REST API calls for historical data require `feed=iex` for paper/free accounts.

### Env-Based Config
All configuration is via `.env` with sensible defaults. See `.env.example` for the full list. Strategy parameters override from env vars:

**Touch & Turn:**

| Env Var | Default | Description |
|---------|---------|-------------|
| `UNIVERSE` | PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK | Comma-separated symbols |
| `ATR_PCT_THRESHOLD` | 0.25 | Min range/ATR ratio for entry |
| `TARGET_FIB` | 0.618 | Fibonacci target level |
| `RR_RATIO` | 2.0 | Risk:reward ratio |
| `POSITION_PCT` | 10 | % of equity per trade |
| `RISK_PCT` | 0 | % of equity risk per trade (0 = use POSITION_PCT) |
| `SESSION_END` | 1100 | Entry window close (HHMM) |
| `HARD_EXIT` | 1130 | Force-close time (HHMM) |
| `POLL_INTERVAL_MS` | 30000 | Polling interval in ms |
| `MIN_ATR` | 0.50 | Min daily ATR filter |
| `MIN_POSITION_USD` | 100 | Min position size in USD |
| `WATCHLIST_PATH` | scripts/watchlist.json | Path to pre-market scan output |
| `SCANNER_TOP_N` | 5 | Number of candidates to select per day |
| `UNFILLED_TIMEOUT_MIN` | 15 | Cancel unfilled orders after N minutes |
| `DAILY_LOSS_LIMIT_PCT` | 3 | Max daily loss as % of equity |
| `MAX_EQUITY_PCT` | 30 | Max total equity usage % |
| `API_TIMEOUT_MS` | 30000 | Alpaca API timeout |
| `SLIPPAGE_BPS` | 5 | Slippage assumption for backtest (basis points) |
| `COMMISSION_PER_SHARE` | 0.005 | Commission per share for backtest |

**Pivot Reversion:**

| Env Var | Default | Description |
|---------|---------|-------------|
| `PIVOT_UNIVERSE` | (falls back to UNIVERSE) | Comma-separated symbols for pivot bot |
| `PIVOT_MAX_TRADES` | 3 | Max trades per day |
| `PIVOT_STOP_ATR_MULT` | 0.3 | Stop-loss ATR multiplier |
| `PIVOT_MIN_RR` | 1.5 | Min risk:reward ratio |
| `PIVOT_SESSION_START` | 945 | Entry window open (HHMM) |
| `PIVOT_SESSION_END` | 1115 | Entry window close (HHMM) |
| `PIVOT_COOLDOWN_BARS` | 6 | Cooldown bars after trade (6×5min = 30min) |
| `PIVOT_MIN_ATR_PCT` | 4.0 | Min ATR% to trade (key gate) |
| `PIVOT_MAX_ATR_PCT` | 10.0 | Max ATR% to trade |

### Resilience
- **Retry/backoff**: All Alpaca and Telegram API calls use exponential backoff with jitter (3 retries, 1s base delay)
- **Graceful shutdown**: SIGINT/SIGTERM cancels open orders, closes positions past hard-exit time, saves logs
- **Config validation**: Bot exits with clear error if required env vars are missing
- **Periodic log saving**: Trade log saved every 5 minutes during monitoring loops
- **Orphan detection**: Detects positions not tracked by the bot and sends Telegram warning with close/keep buttons

### Telegram Module
`telegram.js` is the single source for all Telegram messaging. It exports `sendTelegram(text, {parseMode, buttons})`, `telegramEnabled()`, `tgTradeSignal()`, `tgDryRunSignal()`, `tgTradeSignalsBatch()`, `tgError()`, `tgShutdown()`, `MAIN_BUTTONS`, `escapeHtml`, and `TG_API`. The controller (`telegram-ctl.js`) imports from it.

### PM2 Process Names
- `touch-turn-bot` — T&T trading bot (session-only, autorestart: false)
- `pivot-revert-bot` — Pivot reversion trading bot (session-only, autorestart: false)
- The systemd service `scalp-bot-ctl` manages `telegram-ctl.js` (always-on)

## Configuration Files

- **`.env`** — All secrets and config (gitignored). See `.env.example` for full list.
- **`.env.example`** — Template documenting all required and optional env vars
- **`ecosystem.config.cjs`** — PM2 process definition for both bots

## Scalp Bot Skill

The `/scalp-bot` skill manages the trading bot:
- `start` — Starts T&T bot via PM2
- `stop` — Stops T&T bot via PM2
- `status` — Shows running state + recent trades
- `dry-run` — Toggles DRY_RUN in `.env` (requires restart)

## Key Files

| File | Purpose |
|------|---------|
| `scripts/touch-turn-bot.js` | Main T&T trading bot |
| `scripts/pivot-revert-bot.js` | Pivot reversion trading bot |
| `scripts/pivot-discover.js` | Pivot stock discovery scanner |
| `scripts/telegram.js` | Unified Telegram module (send, format, buttons) |
| `scripts/telegram-ctl.js` | Telegram command listener (VPS daemon) |
| `scripts/lib/retry.js` | Retry/backoff utility for API calls |
| `scripts/lib/indicators.js` | SMA, ATR, RSI, VWAP, createPivots, checkPivotRejection |
| `scripts/lib/alpaca-data.js` | Fetch bars, normalize, compute daily ATR map |
| `scripts/lib/backtest-utils.js` | Stats, combine results, calcQty |
| `scripts/lib/scanner.js` | Shared scanner filters, filterMicrostructure |
| `scripts/lib/time.js` | ET timezone helpers (`getNYTime`, `getTodayStr`, `getHHMM_ET`) |
| `scripts/backtest.js` | Day-trading backtester (4 strategies: A/B/C/D) |
| `scripts/pre-market-scan.js` | Pre-market scanner (writes watchlist.json) |
| `scripts/swing-backtest.js` | Swing trading backtester |
| `scripts/setup-vps.sh` | VPS provisioning script |
| `scripts/scalp-bot-ctl.service` | Systemd unit file template |
| `tests/touch-turn-bot.test.js` | Bot core logic tests |
| `tests/telegram-ctl.test.js` | Telegram controller unit tests |
| `tests/indicators.test.js` | Indicator unit tests |
| `tests/retry.test.js` | Retry/backoff unit tests |
| `tests/scanner.test.js` | Scanner and microstructure filter tests |