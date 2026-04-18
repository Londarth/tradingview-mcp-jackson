# Low-Capital Scalp Strategies Design

Two Pine Script strategies for TradingView backtesting, designed for 200 GBP starting capital. Both are scalping strategies with tight stops and high win rate targets. After backtesting, the winner(s) will be implemented as Alpaca bots.

## Constraints

- Starting capital: 200 GBP
- Market: US stocks via Alpaca (fractional shares available)
- Risk style: Tight & frequent (high win rate)
- Max 1 position at a time (capital constraint)
- Position size: 1% of equity per trade (~2 GBP at start)
- Both strategies use `initial_capital=200, currency=currency.GBP`

## Strategy A: Opening Range Micro-Scalp

**Edge:** Opening range breakout + retest, with tighter targets for higher win rate.

**Logic:**
1. Track 15-min opening range (3 bars on 5m chart, 9:30-9:45 ET)
2. Breakout above/below range
3. Enter on retest (pullback to breakout level) with VWAP confirmation
4. ATR manipulation filter: range must be >= 20% of daily ATR
5. RVOL filter: breakout candle volume >= 1.2x average

**Exits:**
- SL: Range low - 0.5 * ATR(14) for longs, Range high + 0.5 * ATR(14) for shorts
- TP: 1.5R from entry (instead of 2R — higher win rate)
- Session end close: close any open positions at 11:00 ET

**Filters:**
- ATR filter: range >= 20% of daily ATR (same as existing)
- RVOL filter: volume >= 1.2x average (same as existing)
- VWAP bias: long only if price > VWAP, short only if price < VWAP
- Wick confirmation: hammer/inverted hammer at retest

**Position sizing:** `default_qty_type=strategy.percent_of_equity, default_qty_value=1`

**Symbol suitability:** Stocks under $200 share price so 1% position buys meaningful fractional shares (AMD, SNAP, SIRI, etc.)

## Strategy B: VWAP Reversion Scalp

**Edge:** Fade extended moves away from VWAP — price tends to revert to VWAP intraday.

**Logic:**
1. Active session: 9:45-11:30 ET (after opening range settles)
2. Calculate ATR(14) on 5m chart
3. Track distance from VWAP in ATR units
4. Long when price is 1.5 ATR below VWAP
5. Short when price is 1.5 ATR above VWAP

**Exits:**
- SL: 0.5 ATR from entry (very tight)
- TP: VWAP touch (price returning to VWAP)
- Session end close: close any open positions at 11:30 ET

**Filters:**
- RSI filter: RSI < 70 for longs (avoid entering into strong downtrend), RSI > 30 for shorts (avoid entering into strong uptrend)
- Cooldown: 10 bars (50 min) between trades on same symbol to avoid choppy re-entries
- Volume filter: current bar volume > SMA(volume, 12) — only enter on active bars
- Max 1 position at a time

**Position sizing:** `default_qty_type=strategy.percent_of_equity, default_qty_value=1`

## Deliverables

Two Pine Script v6 files:
1. `scripts/or_micro_scalp.pine` — Strategy A
2. `scripts/vwap_reversion_scalp.pine` — Strategy B

Both set up for backtesting in TradingView with 200 GBP initial capital.

## Next Steps (after backtesting)

- Evaluate backtest results for both strategies
- Pick winner(s) to implement as Alpaca bot scripts
- Adapt the Alpaca bot framework from `scripts/alpaca-bot.js`