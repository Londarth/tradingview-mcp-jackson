# TradingView MCP

Control TradingView Desktop from Claude Code via MCP, plus an autonomous Alpaca trading bot with Telegram notifications.

> [!WARNING]
> **Not affiliated with TradingView Inc. or Anthropic.** This tool connects to your locally running TradingView Desktop app via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass any TradingView paywall. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing happens locally.** Nothing is sent anywhere. No TradingView data leaves your machine.

---

## Two Systems

| System | What it does |
|--------|-------------|
| **MCP Server** | 81 tools for controlling TradingView Desktop via CDP — chart manipulation, Pine Script, data reading, drawing, alerts, replay, UI automation |
| **Alpaca Bot** | Autonomous trading bot implementing the "One Candle Scalp" opening range breakout strategy via Alpaca's API, with Telegram trade notifications |

---

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)

Alpaca Bot (standalone) ←→ Alpaca API (REST + WebSocket) ←→ Market data + order execution
                              ←→ Telegram Bot API ←→ Trade notifications
```

### MCP Server Layers

- **`connection.js`** — CDP client. Connects to `localhost:9222`, discovers TradingView tab, injects JS via `Runtime.evaluate()`. Caches client, reconnects on failure.
- **`core/`** — Pure business logic. No MCP imports. Plain JS objects in/out. Can be imported independently via `import { chart } from 'tradingview-mcp/core'`.
- **`tools/`** — MCP registration layer. Zod schemas, wraps `core/` functions, registers on `McpServer`. Shared `jsonResult()` helper in `_format.js`.
- **`cli/`** — Terminal interface. `tv` command with subcommands. Wraps `core/` functions with arg parsing.

All chart manipulation works by constructing JS strings that access `window.TradingViewApi` internal paths, then evaluating them in the TradingView page context.

### Alpaca Bot

- **`scripts/alpaca-bot.js`** — Main bot. Subscribes to Alpaca's real-time 5-min bar stream, implements opening range breakout strategy, places bracket orders.
- **`scripts/telegram.js`** — Sends formatted HTML messages via Telegram Bot API (trade signals, morning brief, EOD summary, errors).
- **`scripts/alpaca-config.json`** — Strategy parameters, symbol list, risk settings, dry-run toggle.

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/Londarth/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

### 2. Set up your rules

```bash
cp rules.example.json rules.json
```

Open `rules.json` and fill in:
- Your **watchlist** (symbols to scan each morning)
- Your **bias criteria** (what makes something bullish/bearish/neutral for you)
- Your **risk rules** (the rules you want Claude to check before every session)

### 3. Launch TradingView with CDP

TradingView must be running with the debug port enabled.

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

Or use the MCP tool after setup: `"Use tv_launch to start TradingView in debug mode"`

### 4. Add to Claude Code

Add to `~/.claude/.mcp.json` (merge with any existing servers):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `YOUR_USERNAME` with your actual username. On Mac: `echo $USER` to check.

### 5. Verify

Restart Claude Code, then ask: *"Use tv_health_check to verify TradingView is connected"*

---

## MCP Server — Tool Reference (81 tools)

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use |
|------|------------|
| `data_get_pine_lines` | Horizontal price levels (support/resistance, session levels) |
| `data_get_pine_labels` | Text annotations + prices ("PDH 24550", "Bias Long") |
| `data_get_pine_tables` | Data tables (session stats, analytics dashboards) |
| `data_get_pine_boxes` | Price zones as {high, low} pairs |

**Always use `study_filter`** to target a specific indicator: `study_filter: "MyIndicator"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Morning Brief

| Tool | What it does |
|------|-------------|
| `morning_brief` | Scan watchlist, read indicators, return structured data for session bias. Reads `rules.json` automatically. |
| `session_save` | Save the generated brief to `~/.tradingview-mcp/sessions/YYYY-MM-DD.json` |
| `session_get` | Retrieve today's brief (or yesterday's if today not saved yet) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Multi-Pane, Alerts, Drawings, UI

| Tool | What it does |
|------|-------------|
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_set_symbol` | Set symbol on any pane |
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `tv_launch` / `tv_health_check` | Launch TradingView and verify connection |

### Tool Decision Tree

| You say... | Claude uses... |
|------------|----------------|
| "Run my morning brief" | `morning_brief` → apply rules → `session_save` |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `capture_screenshot` |
| "Switch to BTCUSD daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` |
| "Draw a level at 94200" | `draw_shape` (horizontal_line) |

---

## Alpaca Trading Bot

Autonomous bot that implements the "One Candle Scalp" opening range breakout strategy on 5-minute charts.

### Strategy logic

1. Track the 15-minute opening range (3 bars on 5m chart, 9:30–9:40 ET)
2. Wait for a breakout above/below the range
3. Enter on the retest (pullback to the breakout level) with VWAP confirmation + wick confirmation
4. Bracket order: SL below the range, TP at 2x the range size
5. Close at session end (11:00 ET) or when TP/SL is hit

### Pine Script strategies

Two versions included in `scripts/`:

| File | Description |
|------|-------------|
| `one_candle_scalp.pine` | V1 — Basic breakout + retest with ATR filter |
| `one_candle_scalp_v2.pine` | V2 — Adds RVOL filter, range width filter, 1H trend filter, max trades/day |

### Setup

**VPS deployment** (Hetzner, `178.104.163.255`):
```bash
ssh root@178.104.163.255
```

1. Copy `.env.example` to `.env` and fill in your Alpaca + Telegram credentials
2. Edit `scripts/alpaca-config.json` for your symbols, session times, and risk settings
3. Start in dry-run mode (default): `node scripts/alpaca-bot.js`
4. Or use the `/scalp-bot` skill in Claude Code: `start`, `stop`, `status`, `dry-run`

### Configuration

| File | Purpose |
|------|---------|
| `.env` | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (gitignored) |
| `scripts/alpaca-config.json` | Strategy params: symbols, session times, ATR/RVOL thresholds, risk settings, dryRun toggle |
| `rules.json` | Watchlist, bias criteria, risk rules for morning brief |

---

## CLI Commands

```bash
tv brief                           # run morning brief
tv session get                     # get today's saved brief
tv session save --brief "..."      # save a brief

tv status                          # check connection
tv quote                           # current price
tv symbol BTCUSD                   # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv stream quote | jq '.close'      # monitor price ticks
```

Full command list: `tv --help`

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | TradingView isn't running with `--remote-debugging-port=9222`. Use the launch script. |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| `morning_brief` — "No rules.json found" | Run `cp rules.example.json rules.json` and fill it in |
| Tools return stale data | TradingView still loading — wait a few seconds |
| Pine Editor tools fail | Open Pine Editor panel first: `ui_open_panel pine-editor open` |

---

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag.

By using this software you agree that:

1. You are solely responsible for ensuring your use complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. This tool accesses undocumented internal TradingView APIs that may change at any time.
3. This tool must not be used to redistribute, resell, or commercially exploit TradingView's market data.
4. The authors are not responsible for any account bans, suspensions, or other consequences.

**Use at your own risk.**

## License

MIT — see [LICENSE](LICENSE). Applies to source code only, not to TradingView's software, data, or trademarks.