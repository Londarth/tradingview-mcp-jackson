# Low-Capital Scalp Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create two Pine Script v6 strategies for TradingView backtesting, designed for 200 GBP starting capital.

**Architecture:** Two standalone .pine files. Strategy A adapts the existing One Candle Scalp v2 with tighter targets. Strategy B is a new VWAP reversion strategy. Both use `initial_capital=200, currency=currency.GBP`.

**Tech Stack:** Pine Script v6, TradingView Strategy Tester

---

### Task 1: Write Opening Range Micro-Scalp (Strategy A)

**Files:**
- Create: `scripts/or_micro_scalp.pine`

- [ ] **Step 1: Write the full Pine Script**

```pine
//@version=6
strategy("OR Micro Scalp", overlay=true, max_bars_back=500, default_qty_type=strategy.percent_of_equity, default_qty_value=1, initial_capital=200, currency=currency.GBP)

// ─── Inputs ───
showBox          = input.bool(true, "Show Opening Range Box", group="Display")
showLabels       = input.bool(true, "Show Entry Labels", group="Display")
tradingStart     = input.int(930, "Session Start (HHMM)", group="Session")
tradingEnd       = input.int(1100, "Session End (HHMM)", group="Session")

// ATR filter
atrPctThreshold  = input.float(20.0, "Manipulation Candle ATR %", minval=10, maxval=40, group="ATR Filter")
useAtrFilter     = input.bool(true, "Require ATR Manipulation Filter", group="ATR Filter")

// RVOL filter
useRvolFilter    = input.bool(true, "Require RVOL Filter", group="Volume Filter")
rvolLength       = input.int(12, "Volume MA Length", minval=5, maxval=50, group="Volume Filter")
rvolThreshold    = input.float(1.2, "RVOL Threshold", minval=1.0, maxval=3.0, step=0.1, group="Volume Filter")

// Exit params
stopAtrMult      = input.float(0.5, "Stop ATR Multiplier", minval=0.2, maxval=1.5, step=0.1, group="Exits")
targetR         = input.float(1.5, "Target R:R", minval=1.0, maxval=3.0, step=0.1, group="Exits")

// ─── Session helpers ───
timeAllowed(t) =>
    hhmm = hour(t) * 100 + minute(t)
    hhmm >= tradingStart and hhmm < tradingEnd

isSessionStart(t) =>
    hhmm = hour(t) * 100 + minute(t)
    hhmm == tradingStart

// ─── 15-minute opening range tracking ───
var int    barInOpening    = 0
var bool   openingComplete = false
var float  openRangeHigh   = na
var float  openRangeLow    = na

if isSessionStart(time)
    barInOpening    := 0
    openingComplete := false
    openRangeHigh   := high
    openRangeLow    := low
    barInOpening    := 1
else if not openingComplete and barInOpening > 0 and barInOpening < 3
    openRangeHigh := math.max(openRangeHigh, high)
    openRangeLow  := math.min(openRangeLow, low)
    barInOpening  := barInOpening + 1
    if barInOpening == 3
        openingComplete := true

// ─── ATR manipulation filter ───
dailyATR  = request.security(syminfo.tickerid, "D", ta.atr(14))
rangeSize = openRangeHigh - openRangeLow
isManipulation = not na(dailyATR) and dailyATR > 0 and (rangeSize / dailyATR) * 100 >= atrPctThreshold
atrPass   = useAtrFilter ? (openingComplete and isManipulation) : openingComplete

// ─── RVOL filter ───
volMA     = ta.sma(volume, rvolLength)
rvol      = volMA > 0 ? volume / volMA : 0
rvolOk    = not useRvolFilter or rvol >= rvolThreshold

// ─── VWAP bias ───
bullBias = close > ta.vwap(hlc3)
bearBias = close < ta.vwap(hlc3)

// ─── Combined filter gate ───
filterPass = atrPass

// ─── State tracking ───
var bool   brokeAbove      = false
var bool   brokeBelow      = false
var bool   longEntryReady  = false
var bool   shortEntryReady = false
var bool   tradedToday     = false

if isSessionStart(time)
    brokeAbove      := false
    brokeBelow      := false
    longEntryReady  := false
    shortEntryReady := false
    tradedToday     := false

// ─── Breakout detection ───
if filterPass and not tradedToday and timeAllowed(time)
    if not brokeAbove and close > openRangeHigh and rvolOk
        brokeAbove     := true
        longEntryReady := true
    if not brokeBelow and close < openRangeLow and rvolOk
        brokeBelow      := true
        shortEntryReady := true

// ─── Retest entry ───
longRetest  = brokeAbove  and longEntryReady  and low <= openRangeHigh and close > openRangeHigh and bullBias
shortRetest = brokeBelow  and shortEntryReady and high >= openRangeLow and close < openRangeLow and bearBias

// ─── Wick confirmation ───
isHammer(o, h, l, c) =>
    candleRange = h - l
    candleRange > 0 ? (math.min(o, c) - l) / candleRange >= 0.6 : false

isInvHammer(o, h, l, c) =>
    candleRange = h - l
    candleRange > 0 ? (h - math.max(o, c)) / candleRange >= 0.6 : false

bullCandle = close > open
bearCandle = close < open
wickConfirmLong  = bullCandle and (isHammer(open, high, low, close) or bullCandle)
wickConfirmShort = bearCandle and (isInvHammer(open, high, low, close) or bearCandle)

// ─── Dynamic exits using ATR ───
atr5m     = ta.atr(14)
longStop  = openRangeLow  - atr5m * stopAtrMult
shortStop = openRangeHigh + atr5m * stopAtrMult
longRisk  = close - longStop
shortRisk = shortStop - close
longTP    = close + longRisk  * targetR
shortTP   = close - shortRisk * targetR

// ─── Entries ───
if longRetest and wickConfirmLong and not tradedToday and timeAllowed(time)
    strategy.entry("Long", strategy.long)
    strategy.exit("TP", "Long", stop=longStop, limit=longTP)
    longEntryReady  := false
    tradedToday     := true
    if showLabels
        label.new(bar_index, low, "L", color=color.green, textcolor=color.white, style=label.style_label_up, size=size.small)

if shortRetest and wickConfirmShort and not tradedToday and timeAllowed(time)
    strategy.entry("Short", strategy.short)
    strategy.exit("TP", "Short", stop=shortStop, limit=shortTP)
    shortEntryReady := false
    tradedToday     := true
    if showLabels
        label.new(bar_index, high, "S", color=color.red, textcolor=color.white, style=label.style_label_down, size=size.small)

// ─── Auto-close at session end ───
if not timeAllowed(time) and strategy.position_size != 0
    strategy.close_all(comment="Session End")

// ─── Draw opening range box ───
if showBox and openingComplete and isSessionStart(time[2])
    box.new(bar_index - 2, openRangeHigh, bar_index + 20, openRangeLow, bgcolor=color.new(color.purple, 85), border_color=color.purple)
    line.new(bar_index - 2, openRangeHigh, bar_index + 20, openRangeHigh, color=color.blue, style=line.style_dashed)
    line.new(bar_index - 2, openRangeLow,  bar_index + 20, openRangeLow,  color=color.orange, style=line.style_dashed)

// ─── Plots ───
plot(ta.vwap(hlc3), "VWAP", color=color.new(color.yellow, 30), style=plot.style_circles, linewidth=1)
```

- [ ] **Step 2: Push to TradingView and compile**

```bash
cd ~/tradingview-mcp-jackson
cp scripts/or_micro_scalp.pine scripts/current.pine
node scripts/pine_push.js
```

Expected: `Compiled clean — 0 errors`

If `pine_push.js` fails, use CLI:
```bash
node src/cli/index.js pine new
node src/cli/index.js pine set --file scripts/or_micro_scalp.pine
node src/cli/index.js pine compile
```

- [ ] **Step 3: Commit**

```bash
git add scripts/or_micro_scalp.pine
git commit -m "feat: add OR Micro Scalp Pine strategy (200 GBP)"
```

---

### Task 2: Write VWAP Reversion Scalp (Strategy B)

**Files:**
- Create: `scripts/vwap_reversion_scalp.pine`

- [ ] **Step 1: Write the full Pine Script**

```pine
//@version=6
strategy("VWAP Reversion Scalp", overlay=true, max_bars_back=500, default_qty_type=strategy.percent_of_equity, default_qty_value=1, initial_capital=200, currency=currency.GBP)

// ─── Inputs ───
showLabels    = input.bool(true, "Show Entry Labels", group="Display")
tradingStart  = input.int(945, "Session Start (HHMM)", group="Session")
tradingEnd    = input.int(1130, "Session End (HHMM)", group="Session")

// Reversion params
atrLength     = input.int(14, "ATR Length", minval=5, maxval=50, group="Reversion")
atrDistMult   = input.float(1.5, "Distance from VWAP (ATR×)", minval=0.5, maxval=3.0, step=0.1, group="Reversion", tooltip="Enter when price is this many ATRs away from VWAP")
stopAtrMult   = input.float(0.5, "Stop ATR Multiplier", minval=0.2, maxval=1.5, step=0.1, group="Exits")

// Filters
useRsiFilter  = input.bool(true, "Require RSI Filter", group="Filters")
rsiLength     = input.int(14, "RSI Length", group="Filters")
rsiMaxLong    = input.int(70, "RSI Max for Longs", minval=50, maxval=80, group="Filters")
rsiMinShort   = input.int(30, "RSI Min for Shorts", minval=20, maxval=50, group="Filters")
useVolFilter  = input.bool(true, "Require Volume Filter", group="Filters")
volLength     = input.int(12, "Volume MA Length", group="Filters")
cooldownBars  = input.int(10, "Cooldown Bars Between Trades", minval=1, maxval=30, group="Filters")

// ─── Session helpers ───
timeAllowed(t) =>
    hhmm = hour(t) * 100 + minute(t)
    hhmm >= tradingStart and hhmm < tradingEnd

isSessionStart(t) =>
    hhmm = hour(t) * 100 + minute(t)
    hhmm == tradingStart

// ─── Core calculations ───
vwapVal  = ta.vwap(hlc3)
atr5m    = ta.atr(atrLength)
rsiVal   = ta.rsi(close, rsiLength)
volMA    = ta.sma(volume, volLength)
volOk    = not useVolFilter or (volMA > 0 and volume > volMA)

// Distance from VWAP in ATR units
distFromVwap = (close - vwapVal) / (atr5m > 0 ? atr5m : 1)

// ─── Entry conditions ───
rsiOkLong   = not useRsiFilter or rsiVal < rsiMaxLong
rsiOkShort  = not useRsiFilter or rsiVal > rsiMinShort

longSignal  = distFromVwap <= -atrDistMult and rsiOkLong and volOk
shortSignal = distFromVwap >=  atrDistMult and rsiOkShort and volOk

// ─── State tracking ───
var int  barsSinceLast = 999
var bool tradedToday   = false

if isSessionStart(time)
    barsSinceLast := 999
    tradedToday   := false

if barsSinceLast < 999
    barsSinceLast := barsSinceLast + 1

// ─── Entries ───
canTrade = timeAllowed(time) and strategy.position_size == 0 and barsSinceLast >= cooldownBars

if longSignal and canTrade
    stopLevel  = close - atr5m * stopAtrMult
    tpLevel    = vwapVal
    strategy.entry("Long", strategy.long)
    strategy.exit("TP", "Long", stop=stopLevel, limit=tpLevel)
    barsSinceLast := 0
    if showLabels
        label.new(bar_index, low, "L", color=color.green, textcolor=color.white, style=label.style_label_up, size=size.small)

if shortSignal and canTrade
    stopLevel  = close + atr5m * stopAtrMult
    tpLevel    = vwapVal
    strategy.entry("Short", strategy.short)
    strategy.exit("TP", "Short", stop=stopLevel, limit=tpLevel)
    barsSinceLast := 0
    if showLabels
        label.new(bar_index, high, "S", color=color.red, textcolor=color.white, style=label.style_label_down, size=size.small)

// ─── Auto-close at session end ───
if not timeAllowed(time) and strategy.position_size != 0
    strategy.close_all(comment="Session End")

// ─── Plots ───
plot(vwapVal, "VWAP", color=color.new(color.yellow, 20), linewidth=2)

// Plot the entry zones
upperZone = vwapVal + atr5m * atrDistMult
lowerZone = vwapVal - atr5m * atrDistMult
plot(upperZone, "Short Zone", color=color.new(color.red, 60), style=plot.style_stepline, linewidth=1)
plot(lowerZone, "Long Zone",  color=color.new(color.green, 60), style=plot.style_stepline, linewidth=1)

// Highlight when price is in entry zone
bgcolor(distFromVwap <= -atrDistMult ? color.new(color.green, 92) : na, title="Long Zone Highlight")
bgcolor(distFromVwap >=  atrDistMult ? color.new(color.red, 92) : na, title="Short Zone Highlight")
```

- [ ] **Step 2: Push to TradingView and compile**

```bash
cd ~/tradingview-mcp-jackson
cp scripts/vwap_reversion_scalp.pine scripts/current.pine
node scripts/pine_push.js
```

Expected: `Compiled clean — 0 errors`

If `pine_push.js` fails, use CLI:
```bash
node src/cli/index.js pine new
node src/cli/index.js pine set --file scripts/vwap_reversion_scalp.pine
node src/cli/index.js pine compile
```

- [ ] **Step 3: Commit**

```bash
git add scripts/vwap_reversion_scalp.pine
git commit -m "feat: add VWAP Reversion Scalp Pine strategy (200 GBP)"
```

---

### Task 3: Push and verify both strategies in TradingView

- [ ] **Step 1: Push to remote**

```bash
cd ~/tradingview-mcp-jackson
git push origin main
```

- [ ] **Step 2: Verify both scripts compile in TV**

Load each into TradingView's Pine Editor, compile, add to chart, and check the Strategy Tester shows metrics (not 0 trades). If 0 trades appear, adjust the symbol or date range and re-test.