# Pivot Reversion Strategy Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a pivot point mean-reversion strategy to scalp-bot with indicator, backtest integration, and microstructure stock scanner.

**Architecture:** New `createPivots()` indicator closure in indicators.js, new Strategy D (`processBarPivotRevert`) in backtest.js following the same processBarFn pattern as strategies A/B/C, plus microstructure filters in scanner.js. All TDD.

**Tech Stack:** Node.js ESM, existing Alpaca data API, node:test runner

---

### Task 1: Write failing test for createPivots indicator

**Objective:** Test that createPivots correctly calculates floor trader pivot levels from prior day data.

**Files:**
- Modify: `tests/indicators.test.js`
- Source: `scripts/lib/indicators.js` (not yet modified)

**Step 1: Write failing test**

Add to `tests/indicators.test.js` after the existing `createSessionVWAP` describe block:

```js
import { createPivots } from '../scripts/lib/indicators.js';

describe('createPivots', () => {
  it('returns null until prior day is set', () => {
    const pivots = createPivots();
    assert.equal(pivots.value(), null);
    assert.equal(pivots.ready(), false);
  });

  it('calculates floor trader pivot levels from prior day H/L/C', () => {
    const pivots = createPivots();
    // Prior day: H=110, L=100, C=105
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    assert.equal(pivots.ready(), true);

    const levels = pivots.value();
    // P = (110 + 100 + 105) / 3 = 105
    assert.equal(levels.P, 105);
    // R1 = 2*P - L = 210 - 100 = 110
    assert.equal(levels.R1, 110);
    // S1 = 2*P - H = 210 - 110 = 100
    assert.equal(levels.S1, 100);
    // R2 = P + (H - L) = 105 + 10 = 115
    assert.equal(levels.R2, 115);
    // S2 = P - (H - L) = 105 - 10 = 95
    assert.equal(levels.S2, 95);
    // R3 = H + 2*(P - L) = 110 + 2*(5) = 120
    assert.equal(levels.R3, 120);
    // S3 = L - 2*(H - P) = 100 - 2*(5) = 90
    assert.equal(levels.S3, 90);
  });

  it('updates pivots when new daily bar is set', () => {
    const pivots = createPivots();
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    const first = pivots.value();
    assert.equal(first.P, 105);

    pivots.setDaily({ high: 120, low: 108, close: 112 });
    const second = pivots.value();
    // P = (120 + 108 + 112) / 3 = 340/3 ≈ 113.33
    assert.ok(Math.abs(second.P - 113.333) < 0.01);
  });

  it('returns midpoint levels between pivot and support/resistance', () => {
    const pivots = createPivots();
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    const levels = pivots.value();
    // midS1 = (S1 + P) / 2 = (100 + 105) / 2 = 102.5
    assert.equal(levels.midS1, 102.5);
    // midR1 = (P + R1) / 2 = (105 + 110) / 2 = 107.5
    assert.equal(levels.midR1, 107.5);
  });
});
```

**Step 2: Run test to verify failure**

Run: `node --test tests/indicators.test.js`
Expected: FAIL — `createPivots` is not exported from indicators.js

**Step 3: Write minimal implementation**

Add to `scripts/lib/indicators.js`:

```js
export function createPivots() {
  let prevDay = null;

  function calcLevels(bar) {
    const P = (bar.high + bar.low + bar.close) / 3;
    return {
      P,
      R1: 2 * P - bar.low,
      S1: 2 * P - bar.high,
      R2: P + (bar.high - bar.low),
      S2: P - (bar.high - bar.low),
      R3: bar.high + 2 * (P - bar.low),
      S3: bar.low - 2 * (bar.high - P),
      midS1: ((2 * P - bar.high) + P) / 2,
      midR1: (P + (2 * P - bar.low)) / 2,
    };
  }

  return {
    setDaily(bar) { prevDay = bar; },
    value() { return prevDay ? calcLevels(prevDay) : null; },
    ready() { return prevDay !== null; },
  };
}
```

**Step 4: Run test to verify pass**

Run: `node --test tests/indicators.test.js`
Expected: ALL PASS (including existing tests)

**Step 5: Commit**

```bash
git add scripts/lib/indicators.js tests/indicators.test.js
git commit -m "feat: add createPivots indicator with floor trader levels"
```

---

### Task 2: Write failing test for pivot rejection confirmation

**Objective:** Create a `checkPivotRejection()` function that detects wick rejections, momentum stalls, and failed breakouts at pivot levels.

**Files:**
- Modify: `tests/indicators.test.js`
- Source: `scripts/lib/indicators.js` (not yet modified for this)

**Step 1: Write failing test**

Add to `tests/indicators.test.js`:

```js
import { checkPivotRejection } from '../scripts/lib/indicators.js';

describe('checkPivotRejection', () => {
  it('detects wick rejection below support (bullish)', () => {
    // Bar low pierces S1 but close is back above — wick rejection
    const result = checkPivotRejection({
      bar: { open: 99.5, high: 100.5, low: 98.5, close: 100 },
      level: 99,  // S1
      side: 'support',
      priorBars: [], // no prior bars for context
    });
    assert.equal(result.rejected, true);
    assert.equal(result.type, 'wick');
    assert.equal(result.direction, 'long');
  });

  it('detects wick rejection above resistance (bearish)', () => {
    const result = checkPivotRejection({
      bar: { open: 110.5, high: 112, low: 110, close: 110.5 },
      level: 111,
      side: 'resistance',
      priorBars: [],
    });
    assert.equal(result.rejected, true);
    assert.equal(result.type, 'wick');
    assert.equal(result.direction, 'short');
  });

  it('detects failed breakout with prior bar piercing', () => {
    // Prior bar closed below level, current bar pierced above then closed below
    const result = checkPivotRejection({
      bar: { open: 100, high: 111.5, low: 99, close: 100.5 },
      level: 110,
      side: 'resistance',
      priorBars: [
        { open: 109, high: 110.5, low: 108, close: 109.5 },
      ],
    });
    assert.equal(result.rejected, true);
    assert.equal(result.direction, 'short');
  });

  it('returns no rejection when bar cleanly breaks through', () => {
    const result = checkPivotRejection({
      bar: { open: 111, high: 113, low: 110.5, close: 112 },
      level: 110,
      side: 'resistance',
      priorBars: [],
    });
    assert.equal(result.rejected, false);
  });

  it('returns no rejection when bar is far from level', () => {
    const result = checkPivotRejection({
      bar: { open: 95, high: 96, low: 94, close: 95 },
      level: 99,
      side: 'support',
      priorBars: [],
    });
    assert.equal(result.rejected, false);
  });
});
```

**Step 2: Run test to verify failure**

Run: `node --test tests/indicators.test.js`
Expected: FAIL — `checkPivotRejection` is not exported

**Step 3: Write minimal implementation**

Add to `scripts/lib/indicators.js`:

```js
export function checkPivotRejection({ bar, level, side, priorBars = [] }) {
  const wickTolerance = 0.1; // bar must touch within 10% of range to count

  if (side === 'support') {
    // Bullish rejection: price dips below support then closes back above
    const pierced = bar.low <= level;
    const closedAbove = bar.close > level;
    const wickSize = bar.close - bar.low;
    const bodySize = Math.abs(bar.close - bar.open);
    const isWick = pierced && closedAbove && wickSize > bodySize * 0.5;

    // Failed breakout: prior bar broke below, current bar snapped back
    const failedBreakout = priorBars.length > 0 &&
      priorBars.some(pb => pb.close < level) && closedAbove;

    if (isWick) return { rejected: true, type: 'wick', direction: 'long' };
    if (failedBreakout) return { rejected: true, type: 'failed_breakout', direction: 'long' };
    return { rejected: false };
  }

  if (side === 'resistance') {
    // Bearish rejection: price spikes above resistance then closes back below
    const pierced = bar.high >= level;
    const closedBelow = bar.close < level;
    const wickSize = bar.high - bar.close;
    const bodySize = Math.abs(bar.close - bar.open);
    const isWick = pierced && closedBelow && wickSize > bodySize * 0.5;

    // Failed breakout: prior bar broke above, current bar snapped back
    const failedBreakout = priorBars.length > 0 &&
      priorBars.some(pb => pb.close > level) && closedBelow;

    if (isWick) return { rejected: true, type: 'wick', direction: 'short' };
    if (failedBreakout) return { rejected: true, type: 'failed_breakout', direction: 'short' };
    return { rejected: false };
  }

  return { rejected: false };
}
```

**Step 4: Run test to verify pass**

Run: `node --test tests/indicators.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add scripts/lib/indicators.js tests/indicators.test.js
git commit -m "feat: add checkPivotRejection for wick/failed breakout detection"
```

---

### Task 3: Add microstructure filters to scanner.js

**Objective:** Add thin-orderbook filters (avg volume, ATR%, price range) to the scanner that identify stocks with WLD-like microstructure.

**Files:**
- Modify: `tests/indicators.test.js` (or create new scanner test if preferred)
- Modify: `scripts/lib/scanner.js`

**Step 1: Write failing test**

Create `tests/scanner.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidate, filterMicrostructure, DEFAULT_PIVOT_FILTERS } from '../scripts/lib/scanner.js';

describe('filterMicrostructure', () => {
  it('accepts low-volume, high-volatility stock (WLD-like)', () => {
    const result = filterMicrostructure({
      avgVolume: 3000000,   // 3M avg daily vol — thin
      atrPct: 3.5,          // 3.5% ATR — volatile
      price: 12.50,         // in sweet spot
    });
    assert.equal(result.passed, true);
  });

  it('rejects high-volume stock (too liquid, pivots steamrolled)', () => {
    const result = filterMicrostructure({
      avgVolume: 50000000,  // 50M — institutional liquidity
      atrPct: 1.5,
      price: 180,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('volume'));
  });

  it('rejects low-volatility stock (pivots dont get tested)', () => {
    const result = filterMicrostructure({
      avgVolume: 4000000,
      atrPct: 0.8,          // 0.8% — not volatile enough
      price: 250,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('ATR%'));
  });

  it('rejects very low price (micro-cap noise)', () => {
    const result = filterMicrostructure({
      avgVolume: 3000000,
      atrPct: 4.0,
      price: 1.50,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('price'));
  });

  it('uses DEFAULT_PIVOT_FILTERS when none provided', () => {
    assert.ok(DEFAULT_PIVOT_FILTERS.maxAvgVolume);
    assert.ok(DEFAULT_PIVOT_FILTERS.minATRPct);
  });
});
```

**Step 2: Run test to verify failure**

Run: `node --test tests/scanner.test.js`
Expected: FAIL — `filterMicrostructure` and `DEFAULT_PIVOT_FILTERS` not exported

**Step 3: Write minimal implementation**

Add to `scripts/lib/scanner.js`:

```js
export const DEFAULT_PIVOT_FILTERS = {
  minPrice: 3,
  maxPrice: 60,
  maxAvgVolume: 10_000_000,  // 10M shares daily — filters out liquid names
  minATRPct: 2.0,             // needs enough volatility for pivot tests
  maxATRPct: 10.0,            // too volatile = noise, not structure
};

export function filterMicrostructure({ avgVolume, atrPct, price }, filters = DEFAULT_PIVOT_FILTERS) {
  const f = { ...DEFAULT_PIVOT_FILTERS, ...filters };

  if (price < f.minPrice) return { passed: false, reason: `price $${price.toFixed(2)} < $${f.minPrice}` };
  if (price > f.maxPrice) return { passed: false, reason: `price $${price.toFixed(2)} > $${f.maxPrice}` };
  if (avgVolume > f.maxAvgVolume) return { passed: false, reason: `avg volume ${avgVolume.toLocaleString()} > ${f.maxAvgVolume.toLocaleString()}` };
  if (atrPct < f.minATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% < ${f.minATRPct}%` };
  if (atrPct > f.maxATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% > ${f.maxATRPct}%` };

  return { passed: true, reason: 'pivot-suitable' };
}
```

**Step 4: Run test to verify pass**

Run: `node --test tests/scanner.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add scripts/lib/scanner.js tests/scanner.test.js
git commit -m "feat: add microstructure filters for pivot-suitable stocks"
```

---

### Task 4: Add Strategy D (Pivot Reversion) to backtest.js

**Objective:** Implement `processBarPivotRevert` following the same pattern as strategies A/B/C, using createPivots and checkPivotRejection.

**Files:**
- Modify: `scripts/backtest.js`

**Step 1: Write implementation directly (backtest strategies aren't unit-tested the same way — they're validated against historical data)**

Add imports at top of backtest.js:

```js
import { createPivots, checkPivotRejection } from './lib/indicators.js';
```

Add Strategy D after Strategy C:

```js
// ─── Strategy D: Pivot Reversion Scalper ───

function createPivotRevertState() {
  return {
    pivots: null,
    pivotSet: false,
    tradesToday: 0,
    maxTradesPerDay: 4,
    cooldownBars: 0,
    cooldownNeeded: 6,  // 6 x 5min bars = 30 min cooldown
    recentBars: [],      // last 3 bars for rejection context
  };
}

function processBarPivotRevert(bar, state, hhmm, ind) {
  const { dailyATRMap, config } = ind;

  // Only trade during active session (9:45 - 11:15)
  if (hhmm < 945 || hhmm >= 1115) return { action: 'none' };

  // Cooldown after last trade
  if (state.cooldownBars > 0) {
    state.cooldownBars--;
    return { action: 'none' };
  }

  // Max trades per day
  if (state.tradesToday >= state.maxTradesPerDay) return { action: 'none' };

  // Set pivots from daily ATR map (use prior day's data)
  // In backtest, we compute pivots from daily bars passed via config
  if (!state.pivotSet && ind.pivotLevels) {
    state.pivots = ind.pivotLevels;
    state.pivotSet = true;
  }

  if (!state.pivots) return { action: 'none' };

  // Track recent bars for rejection context
  state.recentBars.push(bar);
  if (state.recentBars.length > 3) state.recentBars.shift();

  const { P, R1, S1, midS1, midR1 } = state.pivots;
  const dailyATR = dailyATRMap.get(getDateStr(bar.ts));
  if (!dailyATR || dailyATR <= 0) return { action: 'none' };

  // Only look at S1/R1 — stronger levels, more reliable rejections
  const nearS1 = Math.abs(bar.close - S1) / dailyATR < 1.5;
  const nearR1 = Math.abs(bar.close - R1) / dailyATR < 1.5;

  // Check for bullish rejection at S1
  if (nearS1) {
    const rejection = checkPivotRejection({
      bar,
      level: S1,
      side: 'support',
      priorBars: state.recentBars.slice(0, -1),
    });
    if (rejection.rejected && rejection.direction === 'long') {
      const stop = S1 - dailyATR * 0.3;  // stop just below S1
      const target = P;                     // target pivot midpoint
      const risk = bar.close - stop;
      const reward = target - bar.close;
      if (reward / risk >= config.pivotMinRR) {
        state.tradesToday++;
        state.cooldownBars = state.cooldownNeeded;
        return { action: 'enter', side: 'long', stop, target, stopType: 'fixed' };
      }
    }
  }

  // Check for bearish rejection at R1
  if (nearR1) {
    const rejection = checkPivotRejection({
      bar,
      level: R1,
      side: 'resistance',
      priorBars: state.recentBars.slice(0, -1),
    });
    if (rejection.rejected && rejection.direction === 'short') {
      const stop = R1 + dailyATR * 0.3;   // stop just above R1
      const target = P;                     // target pivot midpoint
      const risk = stop - bar.close;
      const reward = bar.close - target;
      if (reward / risk >= config.pivotMinRR) {
        state.tradesToday++;
        state.cooldownBars = state.cooldownNeeded;
        return { action: 'enter', side: 'short', stop, target, stopType: 'fixed' };
      }
    }
  }

  return { action: 'none' };
}
```

**Step 2: Integrate into backtest runner**

Modify `runBacktest()` to pass `pivotLevels` in the `ind` object. Need to compute prior-day pivots from daily bar data.

In the bar processing loop, before entries check, compute pivot levels from prior day:

```js
// Pivot levels from prior day's daily bar (for Strategy D)
let prevDayBar = null;
let pivotLevels = null;

// After the per-day reset block:
if (ind.dailyATRMap) {
  // Find prior day bar from dailyBars (passed via config)
  // This needs daily bars data indexed by date
  const dateStr = getDateStr(bar.ts);
  if (ind.priorDayBars && ind.priorDayBars.has(dateStr)) {
    prevDayBar = ind.priorDayBars.get(dateStr);
    const p = createPivots();
    p.setDaily(prevDayBar);
    pivotLevels = p.value();
  }
}
```

Add to the signal processing call:

```js
const signal = processBarFn(bar, state, hhmm, {
  sessionVWAP, smaVolume, atr5m, rsi14, dailyATRMap, config,
  pivotLevels,  // <-- new
});
```

**Step 3: Add to the report comparison**

Add Strategy D column to `printReport()` and the per-symbol backtest execution.

**Step 4: Run backtest to verify**

Run: `node scripts/backtest.js SOFI 2025-01-01 2025-04-01`
Expected: Strategy D column appears with trade data

**Step 5: Commit**

```bash
git add scripts/backtest.js
git commit -m "feat: add Strategy D pivot reversion scalper to backtest"
```

---

### Task 5: Compute prior-day bars for pivot levels in backtest data pipeline

**Objective:** Ensure the backtest data pipeline provides prior-day H/L/C data so Strategy D can compute pivots.

**Files:**
- Modify: `scripts/backtest.js`

**Details:** When fetching data in single-symbol mode, also fetch daily bars and build a `priorDayBars` Map indexed by date (each entry = the *previous* trading day's OHLC). Pass this through the `ind` object to the strategy.

This is plumbing work within `backtest.js` main flow. Key changes:
1. In single-symbol mode: fetch daily bars alongside 5min bars
2. Build `Map<dateStr, { high, low, close }>` where each date maps to the *prior* day's bar
3. Pass as `ind.priorDayBars` to `runBacktest`

---

### Task 6: Add pivot-specific config to backtest

**Objective:** Add env-configurable parameters for the pivot strategy.

**Files:**
- Modify: `scripts/backtest.js`
- Modify: `.env.example`

**New config vars:**

| Env Var | Default | Description |
|---|---|---|
| `PIVOT_MIN_RR` | 1.5 | Min risk:reward for pivot entries |
| `PIVOT_MAX_TRADES` | 4 | Max pivot trades per day |
| `PIVOT_COOLDOWN_BARS` | 6 | Cooldown bars between pivot entries |
| `PIVOT_STOP_ATR_MULT` | 0.3 | ATR multiplier for stop distance beyond pivot |

---

### Task 7: Run scanner-mode backtest comparing all strategies

**Objective:** Run the full universe scanner backtest and compare T&T vs Pivot Reversion across all stocks.

**Step 1: Run backtest**

```bash
node scripts/backtest.js scan
```

This will naturally include Strategy D once it's in the report loop.

**Step 2: Analyze results**

Look for:
- Which stocks pivot strategy trades (should be thin ones)
- Win rate comparison
- Profit factor comparison
- Does it trade more frequently than T&T?

---

### Task 8: Add pivot strategy to the daily report output

**Objective:** Make the bot's morning report and Telegram messages aware of the pivot strategy.

**Files:**
- Modify: `scripts/touch-turn-bot.js` (only if we go live later — skip for now)

---

## Implementation Status

All tasks completed and deployed. Additional work done after the original plan:

- **Live pivot bot** (`pivot-revert-bot.js`) — 709 lines, fully operational
- **Pivot discovery scanner** (`pivot-discover.js`) — 210 lines, identifies pivot-suitable stocks
- **Confirmed universe** — 13 stocks with PF >= 1.0, 7 with PF >= 1.3 (PLTR, SMR, LCID, SOFI, BTDR, DKNG, QS)
- **Microstructure filter** — ATR% >= 4% is the strongest predictor of edge
- **Scanner tests** — `tests/scanner.test.js` added
- **Ecosystem config** — Updated to include both `touch-turn-bot` and `pivot-revert-bot` PM2 processes
- **Pre-market improvements** — 7 patches applied (batch API calls, debounce snapshots, RSI fix, Calmar fix, etc.)

### Key findings
- ATR% >= 4% is the gate for pivot suitability; stocks below 3.5% ATR% don't work
- S1/R1 rejections with mid-point targets (P) give best risk:reward
- Original T&T universe mostly incompatible with pivot strategy (too liquid)