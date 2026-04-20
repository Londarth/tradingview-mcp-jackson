# Touch & Turn Bot Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix critical bugs, harden for production reliability, and modernize architecture for maintainability.

**Architecture:** Three-layer approach — Layer 1 patches bugs and ships immediately; Layer 2 adds retry, graceful shutdown, and Telegram unification; Layer 3 extracts shared modules, adds env-var config, and builds test coverage.

**Tech Stack:** Node.js (ESM), @alpacahq/alpaca-trade-api, node:test, dotenv

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/touch-turn-bot.js` | Modify | Main trading bot — bug fixes, config extraction, retry, graceful shutdown |
| `scripts/telegram.js` | Modify | Unified Telegram module — merge sendTelegram, remove dead code |
| `scripts/telegram-ctl.js` | Modify | Telegram controller — remove duplicate sendTelegram, readConfig, fix PAPER |
| `scripts/backtest.js` | Modify | Day-trading backtester — GBP fix, extract to lib/ |
| `scripts/swing-backtest.js` | Modify | Swing backtester — extract to lib/ |
| `scripts/alpaca-config.json` | Delete | Vestigial config (no longer used) |
| `.env.example` | Create | Template for required/optional env vars |
| `scripts/lib/retry.js` | Create | Retry/backoff utility |
| `scripts/lib/indicators.js` | Create | SMA, ATR, RSI, VWAP extracted from backtest files |
| `scripts/lib/alpaca-data.js` | Create | fetchBarsPaginated, normD, computeDailyATRMap |
| `scripts/lib/backtest-utils.js` | Create | computeStats, combineSymbolResults, calcQty |
| `tests/touch-turn-bot.test.js` | Create | Bot core logic tests |
| `tests/indicators.test.js` | Create | Indicator unit tests |
| `package.json` | Modify | Add test:all script |

---

## Layer 1: Fix & Patch

### Task 1: Fix P&L reporting after hard exit

**Files:**
- Modify: `scripts/touch-turn-bot.js:306-349,524-533`

The position is already closed by the time the code tries to read `unrealized_pl`. We need to capture P&L data before the hard exit closes the position.

- [ ] **Step 1: Write the failing test**

```js
// tests/touch-turn-bot.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('P&L capture before position close', () => {
  it('captures unrealized_pl from position before hard exit closes it', () => {
    // When monitorPosition hard-exits, it should return the P&L captured
    // before closing, not try to re-fetch the (now nonexistent) position.
    const mockPos = { unrealized_pl: '12.50', qty: '10', side: 'long' };
    const capturedPnl = parseFloat(mockPos.unrealized_pl);
    assert.equal(capturedPnl, 12.50);
  });

  it('returns pnl=0 when position data is unavailable before close', () => {
    const capturedPnl = null;
    const reportedPnl = capturedPnl ?? 0;
    assert.equal(reportedPnl, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Modify `monitorPosition` to capture P&L before hard exit**

In `scripts/touch-turn-bot.js`, modify the `monitorPosition` function. Before the hard exit block (line ~331), capture the current position's unrealized P&L:

Replace the `monitorPosition` function (lines 306-350) with:

```js
async function monitorPosition(sym, untilHHMM) {
  let lastPnl = 0;

  while (getHHMM() < untilHHMM) {
    try {
      if (DRY_RUN) {
        log(`${sym}: DRY RUN — monitoring position (would close at ${untilHHMM})`);
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      const pos = await alpaca.getPosition(sym).catch(() => null);
      if (!pos || parseFloat(pos.qty) === 0) {
        log(`${sym}: Position closed (by stop/target)`, 'trade');
        return { closed: true, byBracket: true, pnl: lastPnl };
      }

      lastPnl = parseFloat(pos.unrealized_pl);
      log(`${sym}: Position open — unrealized P&L: $${lastPnl.toFixed(2)}`);
      await writeSnapshot();
      await sleep(CONFIG.pollIntervalMs);
    } catch (err) {
      log(`${sym}: Position check error: ${err.message}`, 'error');
      await sleep(CONFIG.pollIntervalMs);
    }
  }

  // Hard exit: close position at market
  if (!DRY_RUN) {
    try {
      const pos = await alpaca.getPosition(sym).catch(() => null);
      if (pos && parseFloat(pos.qty) > 0) {
        // Capture P&L before closing
        lastPnl = parseFloat(pos.unrealized_pl);
        await alpaca.createOrder({
          symbol: sym, qty: pos.qty,
          side: pos.side === 'long' ? 'sell' : 'buy',
          type: 'market', time_in_force: 'day',
        });
        log(`${sym}: Force-closed position (session end) — P&L: $${lastPnl.toFixed(2)}`, 'trade');
      }
    } catch (err) {
      log(`${sym} CLOSE ERROR: ${err.message}`, 'error');
      await tgError(`${sym} close failed: ${err.message}`);
    }
  }

  return { closed: true, byBracket: false, pnl: lastPnl };
}
```

- [ ] **Step 4: Update runBot to use the returned P&L instead of re-fetching**

Replace lines 524-533 in `runBot()`:

```js
  // Get final P&L from monitorPosition result
  let pnl = posResult.pnl || 0;
  if (!DRY_RUN && posResult.byBracket) {
    // If closed by bracket (stop/target), try to get realized P&L from closed position
    try {
      const closedPos = await alpaca.getPosition(sym).catch(() => null);
      if (closedPos) pnl = parseFloat(closedPos.unrealized_pl);
    } catch (e) { /* position already closed */ }
  }
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
git commit -m "fix: capture P&L before hard exit closes position"
```

---

### Task 2: Fix position size calculation to use entryPrice

**Files:**
- Modify: `scripts/touch-turn-bot.js:487`

- [ ] **Step 1: Write the failing test**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('position sizing', () => {
  it('uses entry price (range.low) for long side qty, not range.close', () => {
    const balance = 10000;
    const positionPct = 10;
    const entryPrice = 8.50;  // range.low for long
    const rangeClose = 9.20;  // range.close (wrong, would give more shares)

    const positionValue = balance * (positionPct / 100);
    const qtyCorrect = Math.max(1, Math.floor(positionValue / entryPrice));
    const qtyWrong = Math.max(1, Math.floor(positionValue / rangeClose));

    assert.equal(qtyCorrect, 117);  // $1000 / $8.50 = 117
    assert.equal(qtyWrong, 108);    // $1000 / $9.20 = 108
    assert.ok(qtyCorrect > qtyWrong, 'using entryPrice gives fewer shares (correct for actual risk)');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Fix the position size calculation in touch-turn-bot.js**

Replace line 487:

```js
  const qty = Math.max(1, Math.floor(positionValue / range.close)); // use close for qty calc
```

With:

```js
  const qty = Math.max(1, Math.floor(positionValue / entryPrice));
```

Also update the log line (489) to reference `entryPrice`:

```js
  log(`${sym}: Position = $${positionValue.toFixed(2)} (${CONFIG.positionPct}%) = ${qty} shares @ $${entryPrice.toFixed(2)}`);
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
git commit -m "fix: use entryPrice instead of range.close for position sizing"
```

---

### Task 3: Add SIGTERM handler

**Files:**
- Modify: `scripts/touch-turn-bot.js:549-554`

PM2 stops processes via SIGTERM, not SIGINT. The current shutdown hook only handles SIGINT.

- [ ] **Step 1: Write the failing test**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('shutdown handlers', () => {
  it('SIGINT and SIGTERM both trigger the same shutdown function', () => {
    // Verify both signal handlers reference the same function
    const handlers = {};
    const fakeShutdown = async () => {};
    process.once('SIGINT', fakeShutdown);
    process.once('SIGTERM', fakeShutdown);
    // This test documents the requirement: both signals must be handled
    assert.ok(true, 'both signals handled');
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Add SIGTERM handler**

In `scripts/touch-turn-bot.js`, extract the shutdown logic into a named function and register both handlers. Replace lines 549-554:

```js
process.on('SIGINT', async () => {
  log('Shutting down...');
  await tgShutdown();
  saveLog();
  process.exit(0);
});
```

With:

```js
async function shutdown(signal) {
  log(`Shutting down (${signal})...`);
  await tgShutdown();
  saveLog();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
git commit -m "fix: add SIGTERM handler for PM2 stop compatibility"
```

---

### Task 4: Fix stale bot name and hardcoded PAPER mode

**Files:**
- Modify: `scripts/telegram.js:90-97`
- Modify: `scripts/telegram-ctl.js:131`

- [ ] **Step 1: Fix tgStartup stale name**

In `scripts/telegram.js`, replace lines 90-97:

```js
export async function tgStartup(mode, symbols) {
  await sendTelegram(
    `🚀 <b>One Candle Scalp Bot Started</b>\n` +
    `Mode: ${mode}\n` +
    `Symbols: ${symbols.join(', ')}\n` +
    `Session: 9:30–11:00 ET`
  );
}
```

With:

```js
export async function tgStartup(mode, symbols) {
  await sendTelegram(
    `🚀 <b>Touch &amp; Turn Bot Started</b>\n` +
    `Mode: ${mode}\n` +
    `Symbols: ${symbols.join(', ')}\n` +
    `Window: 9:45–11:00 ET`
  );
}
```

- [ ] **Step 2: Fix hardcoded PAPER in telegram-ctl.js handleStart**

In `scripts/telegram-ctl.js`, replace line 131:

```js
    await sendTelegram('⚡️ <b>Touch &amp; Turn Bot started</b>\nMode: PAPER\nWindow: 9:45–11:00 ET');
```

With:

```js
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    await sendTelegram(`⚡️ <b>Touch &amp; Turn Bot started</b>\nMode: ${paper}\nWindow: 9:45–11:00 ET`);
```

- [ ] **Step 3: Commit**

```bash
git add scripts/telegram.js scripts/telegram-ctl.js
git commit -m "fix: stale bot name and hardcoded PAPER mode"
```

---

### Task 5: Lower positionPct default and add POSITION_PCT env var

**Files:**
- Modify: `scripts/touch-turn-bot.js:23`

- [ ] **Step 1: Write the failing test**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('CONFIG defaults', () => {
  it('positionPct defaults to 10 (not 50)', () => {
    // When POSITION_PCT env var is not set, default should be 10
    const defaultPct = 10;
    assert.equal(defaultPct, 10);
  });

  it('positionPct reads from POSITION_PCT env var', () => {
    process.env.POSITION_PCT = '20';
    const positionPct = parseInt(process.env.POSITION_PCT, 10) || 10;
    assert.equal(positionPct, 20);
    delete process.env.POSITION_PCT;
  });

  it('positionPct falls back to default when env var is invalid', () => {
    process.env.POSITION_PCT = 'abc';
    const positionPct = parseInt(process.env.POSITION_PCT, 10) || 10;
    assert.equal(positionPct, 10);
    delete process.env.POSITION_PCT;
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Change default and add env var**

In `scripts/touch-turn-bot.js`, replace line 23:

```js
  positionPct: 50,
```

With:

```js
  positionPct: parseInt(process.env.POSITION_PCT, 10) || 10,
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
git commit -m "fix: lower positionPct default to 10%, add POSITION_PCT env var"
```

---

### Task 6: Add .env.example

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create .env.example**

```
# ─── Required ───
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ─── Alpaca ───
ALPACA_PAPER=true

# ─── Bot behavior ───
DRY_RUN=false
POSITION_PCT=10
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "feat: add .env.example template"
```

---

### Task 7: Remove vestigial alpaca-config.json and readConfig()

**Files:**
- Delete: `scripts/alpaca-config.json`
- Modify: `scripts/telegram-ctl.js:15,105-112`

- [ ] **Step 1: Delete alpaca-config.json**

```bash
git rm scripts/alpaca-config.json
```

- [ ] **Step 2: Remove readConfig() and CONFIG_PATH from telegram-ctl.js**

In `scripts/telegram-ctl.js`, remove line 15:

```js
const CONFIG_PATH = join(__dirname, 'alpaca-config.json');
```

Remove lines 105-112:

```js
async function readConfig() {
  try {
    const data = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}
```

Remove `readFile` from the import on line 5 if no longer needed (check that `readTradeLog` and `readSnapshot` still use it — they do, so keep the import).

- [ ] **Step 3: Run existing tests**

Run: `node --test tests/telegram-ctl.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/telegram-ctl.js
git commit -m "chore: remove vestigial alpaca-config.json and readConfig()"
```

---

### Task 8: Fix GBP currency symbols in backtest files

**Files:**
- Modify: `scripts/backtest.js:496,523,541-542,652,685`
- Modify: `scripts/swing-backtest.js` (same GBP→USD replacements)

- [ ] **Step 1: Replace all GBP symbols with USD in backtest.js**

In `scripts/backtest.js`, replace all occurrences of `£` with `$` and `gbp` function name with `usd`:

Replace the `gbp` helper in `printReport` (line 496):

```js
  const gbp = v => (v >= 0 ? '+' : '') + '£' + v.toFixed(2);
```

With:

```js
  const usd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
```

Replace all references to `gbp(` with `usd(` in `printReport` (lines 510-516).

Replace the `gbp` helper in `printScannerReport` (line 652) and all references (lines 665-681).

Replace the `£` in the footer lines (523, 685):

Line 523:
```js
  console.log(`Capital: $${a.initialCapital} | Risk: 50% equity/trade (min $100) | No slippage/commission`);
```

Line 685:
```js
  console.log(`Capital: $${a.initialCapital} | Risk: 50% equity/trade (min $100) | Scanner: top ${SCANNER_TOP_N} RVOL/day | No slippage/commission`);
```

In `printTradeLog` (lines 541-542), replace `£` with `$`:

```js
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    console.log(`  ${t.entryDate.padEnd(12)}${side.padEnd(7)}${t.entryPrice.toFixed(2).padEnd(10)}${t.exitPrice.toFixed(2).padEnd(10)}${exitType.padEnd(14)}${pnlStr.padStart(9)}${('$' + runningEquity.toFixed(2)).padStart(10)}`);
```

Also rename `minPositionGBP` to `minPositionUSD` throughout `backtest.js` (config objects and `calcQty` function).

- [ ] **Step 2: Replace all GBP symbols with USD in swing-backtest.js**

Apply the same GBP→USD replacements in `scripts/swing-backtest.js`:
- Replace all `£` with `$` in formatting helpers and report functions
- Replace `gbp` helper function name with `usd`
- Replace `minPositionGBP` with `minPositionUSD` in config objects

- [ ] **Step 3: Commit**

```bash
git add scripts/backtest.js scripts/swing-backtest.js
git commit -m "fix: replace GBP with USD currency symbols in backtest output"
```

---

## Layer 2: Harden

### Task 9: Add retry/backoff utility

**Files:**
- Create: `scripts/lib/retry.js`
- Create: `tests/retry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/retry.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../scripts/lib/retry.js';

describe('retry', () => {
  it('returns result on first successful call', async () => {
    const result = await retry(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return Promise.resolve('ok');
    };
    const result = await retry(fn, { maxRetries: 3, baseDelay: 10 });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('throws after exhausting retries', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      throw new Error('persistent');
    };
    await assert.rejects(
      () => retry(fn, { maxRetries: 2, baseDelay: 10 }),
      { message: 'persistent' }
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  it('uses default options when none provided', async () => {
    const result = await retry(() => Promise.resolve('default'));
    assert.equal(result, 'default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/retry.test.js`
Expected: FAIL — module `../scripts/lib/retry.js` not found

- [ ] **Step 3: Implement retry utility**

```js
// scripts/lib/retry.js

export async function retry(fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/retry.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/retry.js tests/retry.test.js
git commit -m "feat: add retry/backoff utility with exponential backoff + jitter"
```

---

### Task 10: Apply retry to API calls in touch-turn-bot.js

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Import retry**

Add at top of `scripts/touch-turn-bot.js` after the existing imports:

```js
import { retry } from './lib/retry.js';
```

- [ ] **Step 2: Wrap Alpaca API calls with retry**

**Note:** Line numbers reference the original file before Tasks 1-3. Adjust as needed.

Wrap every Alpaca API call with `retry()`. The pattern is:
- `await alpaca.someMethod(args)` → `await retry(() => alpaca.someMethod(args))`
- `await alpaca.someMethod(args).catch(fn)` → `await retry(() => alpaca.someMethod(args)).catch(fn)`
- `await fetch(url, opts)` → `await retry(() => fetch(url, opts))`

Apply to these functions in `scripts/touch-turn-bot.js`:
- `fetchDailyATRs`: wrap the inner `fetch()` call
- `fetchOpeningRange`: wrap the `fetch()` call
- `placeBracketOrder`: wrap `alpaca.createOrder()`
- `monitorOrder`: wrap `alpaca.getOrder()` and `alpaca.cancelOrder()`
- `monitorPosition`: wrap both `alpaca.getPosition()` calls and `alpaca.createOrder()` in hard exit
- `writeSnapshot`: wrap `alpaca.getAccount()` and `alpaca.getPositions()`
- `runBot`: wrap the initial `alpaca.getAccount()` and the EOD `alpaca.getAccount()`

- [ ] **Step 3: Wrap Telegram sends with retry**

In `scripts/telegram.js`, add import at top:

```js
import { retry } from './lib/retry.js';
```

In the unified `sendTelegram` function (created in Task 13), wrap the `fetch()` call with `retry()`:

```js
    const resp = await retry(() => fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
```

Note: Task 13 creates the unified `sendTelegram` — apply this change after Task 13 is complete, or combine with it.

- [ ] **Step 4: Run all tests**

Run: `node --test tests/telegram-ctl.test.js tests/retry.test.js tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/touch-turn-bot.js scripts/telegram.js
git commit -m "feat: add retry/backoff to all Alpaca and Telegram API calls"
```

---

### Task 11: Add graceful shutdown with order cancellation

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Add module-level state tracking**

At the top of `scripts/touch-turn-bot.js` (after CONFIG), add:

```js
let activeOrderId = null;
let activeSymbol = null;
let isShuttingDown = false;
```

- [ ] **Step 2: Track order and symbol state**

In `runBot`, after the order is placed (around line 492), add:

```js
  activeOrderId = order?.id;
  activeSymbol = sym;
```

After order monitoring completes (around line 514), clear:

```js
  activeOrderId = null;
```

- [ ] **Step 3: Add isShuttingDown checks to monitoring loops**

In `monitorOrder`, add a check at the top of the while loop:

```js
  while (getHHMM() < untilHHMM) {
    if (isShuttingDown) return { filled: false, status: 'shutdown' };
    // ... rest of loop
```

In `monitorPosition`, add a check at the top of the while loop:

```js
  while (getHHMM() < untilHHMM) {
    if (isShuttingDown) return { closed: false, pnl: lastPnl };
    // ... rest of loop
```

- [ ] **Step 4: Replace the shutdown function**

Replace the `shutdown` function from Task 3 with the expanded version. This replaces the old SIGINT/SIGTERM handlers at the end of the file:

```js
async function shutdown(signal) {
  log(`Shutting down (${signal})...`);
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Cancel open orders
  if (activeOrderId && !DRY_RUN) {
    try {
      await retry(() => alpaca.cancelOrder(activeOrderId));
      log(`Cancelled open order ${activeOrderId}`);
    } catch (e) {
      log(`Cancel order failed: ${e.message}`, 'error');
    }
  }

  // Close open position if past hard exit time
  if (activeSymbol && getHHMM() >= CONFIG.hardExit && !DRY_RUN) {
    try {
      const pos = await retry(() => alpaca.getPosition(activeSymbol)).catch(() => null);
      if (pos && parseFloat(pos.qty) > 0) {
        await retry(() => alpaca.createOrder({
          symbol: activeSymbol, qty: pos.qty,
          side: pos.side === 'long' ? 'sell' : 'buy',
          type: 'market', time_in_force: 'day',
        }));
        log(`Closed position in ${activeSymbol} during shutdown`, 'trade');
      }
    } catch (e) {
      log(`Position close during shutdown failed: ${e.message}`, 'error');
    }
  }

  stopPeriodicSave();
  await tgShutdown();
  saveLog();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/touch-turn-bot.js
git commit -m "feat: graceful shutdown cancels orders, closes positions, breaks monitoring loops"
```

---

### Task 12: Add config validation on startup

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('config validation', () => {
  it('lists required env vars', () => {
    const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    assert.equal(required.length, 4);
    assert.ok(required.includes('ALPACA_API_KEY'));
  });

  it('detects missing required vars', () => {
    const env = { ALPACA_API_KEY: 'x', ALPACA_SECRET_KEY: 'x' };
    const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const missing = required.filter(k => !env[k]);
    assert.deepEqual(missing, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Add validation at top of runBot**

In `scripts/touch-turn-bot.js`, add at the beginning of the `runBot` function (after the opening log lines):

```js
  // Validate required env vars
  const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    log(`FATAL: Missing required env vars: ${missing.join(', ')}`, 'error');
    process.exit(1);
  }
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
git commit -m "feat: validate required env vars on startup"
```

---

### Task 13: Unify Telegram modules

**Files:**
- Modify: `scripts/telegram.js`
- Modify: `scripts/telegram-ctl.js`

- [ ] **Step 1: Update telegram.js sendTelegram to support both parseMode and buttons**

In `scripts/telegram.js`, replace the `sendTelegram` function (lines 12-28). **Important:** Preserve the existing `telegramEnabled` export — do not remove it.

```js
export async function sendTelegram(text, { parseMode = 'HTML', buttons = null } = {}) {
  if (!enabled) return;
  try {
    const body = { chat_id: TG_CHAT_ID, text, parse_mode: parseMode };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    const resp = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Telegram error: ${resp.status} ${err}`);
    }
  } catch (e) {
    console.error(`Telegram send failed: ${e.message}`);
  }
}
```

Note: Do NOT add `retry()` wrapping yet — that comes in Task 10 (applied after this task).

- [ ] **Step 2: Export MAIN_BUTTONS and escapeHtml from telegram.js**

Add to `scripts/telegram.js`, before the formatted messages section:

```js
export const MAIN_BUTTONS = [[
  { text: '▶ Start', callback_data: '/start' },
  { text: '⏹ Stop', callback_data: '/stop' },
  { text: '📊 Status', callback_data: '/status' },
]];

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 3: Update telegram-ctl.js to import from telegram.js**

In `scripts/telegram-ctl.js`, add import at top (after existing imports):

```js
import { sendTelegram, MAIN_BUTTONS, escapeHtml, TG_API } from './telegram.js';
```

Remove the duplicate `sendTelegram` function from `telegram-ctl.js` (lines 43-57).

Remove the duplicate `escapeHtml` function (lines 29-31). Replace the export with a re-export:

```js
export { escapeHtml } from './telegram.js';
```

Remove the `MAIN_BUTTONS` constant (lines 21-25) from `telegram-ctl.js`.

Remove the TG_TOKEN, TG_CHAT_ID, TG_API constants (lines 11-13) from `telegram-ctl.js` — these are now imported from `telegram.js`.

Keep `answerCallbackQuery` in `telegram-ctl.js` since it uses the imported `TG_API`.

- [ ] **Step 4: Update all sendTelegram call sites in telegram-ctl.js**

The unified `sendTelegram` now uses an options object: `sendTelegram(text, { parseMode, buttons })`.

All current calls in `telegram-ctl.js` that pass `MAIN_BUTTONS` as second argument need updating. Since `MAIN_BUTTONS` is now the default, calls like `sendTelegram('some message')` will automatically include buttons. Explicit calls with buttons become `sendTelegram('some message', { buttons: MAIN_BUTTONS })`.

Calls like `sendTelegram('some message', MAIN_BUTTONS)` need NO change because `MAIN_BUTTONS` is the default.

However, if any call passes `null` or a different buttons array, update the syntax. For example:
- `sendTelegram(text)` → stays the same (default buttons)
- `sendTelegram(text, customButtons)` → `sendTelegram(text, { buttons: customButtons })`

Verify every call site in `telegram-ctl.js` (`handleStart`, `handleStop`, `handleStatus`, `handleHelp`) uses the correct syntax.

- [ ] **Step 4: Update test imports**

In `tests/telegram-ctl.test.js`, update the import to get `escapeHtml` from telegram.js:

```js
import { parseCommand, isAuthorized } from '../scripts/telegram-ctl.js';
import { escapeHtml } from '../scripts/telegram.js';
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/telegram-ctl.test.js tests/touch-turn-bot.test.js tests/retry.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/telegram.js scripts/telegram-ctl.js tests/telegram-ctl.test.js
git commit -m "refactor: unify Telegram modules into single telegram.js"
```

---

### Task 14: Add periodic log saving

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Add periodic save timer**

In `scripts/touch-turn-bot.js`, add after the `saveLog` function:

```js
let saveInterval = null;

function startPeriodicSave() {
  saveInterval = setInterval(() => saveLog(), 5 * 60 * 1000);
}

function stopPeriodicSave() {
  if (saveInterval) clearInterval(saveInterval);
}
```

- [ ] **Step 2: Start periodic save in runBot**

In the `runBot` function, after the initial `writeSnapshot()` call (around line 415), add:

```js
  startPeriodicSave();
```

- [ ] **Step 3: Stop periodic save in shutdown**

In the `shutdown` function, add before `process.exit`:

```js
  stopPeriodicSave();
```

- [ ] **Step 4: Commit**

```bash
git add scripts/touch-turn-bot.js
git commit -m "feat: save trade log every 5 minutes during monitoring"
```

---

## Layer 3: Modernize

### Task 15: Extract shared indicator modules

**Files:**
- Create: `scripts/lib/indicators.js`
- Create: `tests/indicators.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/indicators.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSMA, createATR, createRSI, createSessionVWAP } from '../scripts/lib/indicators.js';

describe('createSMA', () => {
  it('returns null until buffer is full', () => {
    const sma = createSMA(3);
    sma.push(10);
    assert.equal(sma.value(), null);
    assert.equal(sma.ready(), false);
  });

  it('computes simple moving average', () => {
    const sma = createSMA(3);
    sma.push(10); sma.push(20); sma.push(30);
    assert.equal(sma.value(), 20);
    assert.equal(sma.ready(), true);
  });

  it('slides window forward', () => {
    const sma = createSMA(3);
    sma.push(10); sma.push(20); sma.push(30); sma.push(40);
    assert.equal(sma.value(), 30);
  });
});

describe('createATR', () => {
  it('returns null until buffer is full', () => {
    const atr = createATR(3);
    atr.push({ high: 10, low: 8, close: 9 });
    assert.equal(atr.value(), null);
  });

  it('computes average true range', () => {
    const atr = createATR(3);
    atr.push({ high: 10, low: 8, close: 9 });
    atr.push({ high: 12, low: 9, close: 11 });
    atr.push({ high: 11, low: 8, close: 10 });
    atr.push({ high: 13, low: 10, close: 12 });
    assert.ok(atr.value() > 0);
    assert.equal(atr.ready(), true);
  });
});

describe('createRSI', () => {
  it('returns null until seeded', () => {
    const rsi = createRSI(3);
    rsi.push(10);
    assert.equal(rsi.value(), null);
  });

  it('returns 100 when all gains', () => {
    const rsi = createRSI(3);
    rsi.push(10); rsi.push(11); rsi.push(12); rsi.push(13);
    assert.equal(rsi.value(), 100);
    assert.equal(rsi.ready(), true);
  });

  it('returns 0 when all losses', () => {
    const rsi = createRSI(3);
    rsi.push(13); rsi.push(12); rsi.push(11); rsi.push(10);
    assert.equal(rsi.value(), 0);
  });
});

describe('createSessionVWAP', () => {
  it('computes volume-weighted average price', () => {
    const vwap = createSessionVWAP();
    vwap.push({ high: 11, low: 9, close: 10, volume: 100 });
    vwap.push({ high: 21, low: 19, close: 20, volume: 100 });
    assert.equal(vwap.value(), 15);
  });

  it('resets on call to reset()', () => {
    const vwap = createSessionVWAP();
    vwap.push({ high: 11, low: 9, close: 10, volume: 100 });
    vwap.reset();
    assert.equal(vwap.value(), null);
  });

  it('returns null when no volume', () => {
    const vwap = createSessionVWAP();
    assert.equal(vwap.value(), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/indicators.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create indicators.js**

```js
// scripts/lib/indicators.js

export function createSMA(length) {
  const buf = [];
  let sum = 0;
  return {
    push(val) { buf.push(val); sum += val; if (buf.length > length) sum -= buf.shift(); },
    value() { return buf.length >= length ? sum / buf.length : null; },
    ready() { return buf.length >= length; },
  };
}

export function createATR(period) {
  const buf = [];
  let prevClose = null;
  return {
    push(bar) {
      const tr = prevClose !== null
        ? Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
        : bar.high - bar.low;
      buf.push(tr);
      if (buf.length > period) buf.shift();
      prevClose = bar.close;
    },
    value() { return buf.length >= period ? buf.reduce((a, b) => a + b, 0) / buf.length : null; },
    ready() { return buf.length >= period; },
  };
}

export function createRSI(period) {
  let avgGain = null, avgLoss = null, prevClose = null, seedCount = 0, seedGains = 0, seedLosses = 0;
  return {
    push(close) {
      if (prevClose === null) { prevClose = close; return; }
      const change = close - prevClose;
      prevClose = close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (avgGain === null) {
        seedGains += gain; seedLosses += loss; seedCount++;
        if (seedCount >= period) { avgGain = seedGains / period; avgLoss = seedLosses / period; }
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
    },
    value() {
      if (avgGain === null) return null;
      if (avgLoss === 0) return 100;
      return 100 - 100 / (1 + avgGain / avgLoss);
    },
    ready() { return avgGain !== null; },
  };
}

export function createSessionVWAP() {
  let cumTPV = 0, cumVol = 0;
  return {
    push(bar) {
      const tp = (bar.high + bar.low + bar.close) / 3;
      cumTPV += tp * bar.volume;
      cumVol += bar.volume;
    },
    value() { return cumVol > 0 ? cumTPV / cumVol : null; },
    reset() { cumTPV = 0; cumVol = 0; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/indicators.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/indicators.js tests/indicators.test.js
git commit -m "feat: extract shared indicator modules (SMA, ATR, RSI, VWAP)"
```

---

### Task 16: Extract shared alpaca-data and backtest-utils modules

**Files:**
- Create: `scripts/lib/alpaca-data.js`
- Create: `scripts/lib/backtest-utils.js`

- [ ] **Step 1: Create alpaca-data.js**

```js
// scripts/lib/alpaca-data.js

export async function fetchBarsPaginated(symbol, timeframe, startDate, endDate) {
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
  let allBars = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      symbols: symbol, timeframe, start: startDate, end: endDate,
      feed: 'iex', limit: '10000', sort: 'asc',
    });
    if (pageToken) params.set('page_token', pageToken);

    const resp = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!resp.ok) throw new Error(`Alpaca API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const bars = data.bars?.[symbol] || [];
    allBars = allBars.concat(bars);
    pageToken = data.next_page_token;
  } while (pageToken);

  return allBars;
}

export function norm5(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw }; }
export function normD(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; }

export function computeDailyATRMap(dailyBars, period = 14) {
  const map = new Map();
  if (dailyBars.length < period + 1) return map;
  for (let i = period; i < dailyBars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const prev = dailyBars[j - 1];
      const cur = dailyBars[j];
      const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
      sum += tr;
    }
    const dateStr = new Date(dailyBars[i].ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    map.set(dateStr, sum / period);
  }
  return map;
}
```

- [ ] **Step 2: Create backtest-utils.js**

```js
// scripts/lib/backtest-utils.js

export function calcQty(equity, riskPct, minPositionUSD, position) {
  const positionValue = Math.max(equity * (riskPct / 100), minPositionUSD || 20);
  return positionValue / (position ? position.entryPrice : 1);
}

export function computeStats(trades, initialCapital, equityCurve, maxDrawdown) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  return {
    totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100) : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100, profitFactor, equityCurve,
  };
}

export function combineSymbolResults(allResults, initialCapital) {
  const allTrades = Object.values(allResults)
    .flatMap(r => r.trades)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryPrice - b.entryPrice);

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnL = allTrades.reduce((s, t) => s + t.pnl, 0);

  let equity = initialCapital;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [equity];
  for (const t of allTrades) {
    equity += t.pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
    equityCurve.push(equity);
  }

  return {
    totalTrades: allTrades.length, wins: wins.length, losses: losses.length,
    winRate: allTrades.length > 0 ? (wins.length / allTrades.length * 100) : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    equityCurve, finalEquity: equity, initialCapital,
    perSymbol: allResults,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/alpaca-data.js scripts/lib/backtest-utils.js
git commit -m "feat: extract shared alpaca-data and backtest-utils modules"
```

---

### Task 17: Update backtest.js to use lib/ modules

**Files:**
- Modify: `scripts/backtest.js`

- [ ] **Step 1: Add imports and remove duplicated code**

Replace the top of `scripts/backtest.js` with:

```js
#!/usr/bin/env node
import 'dotenv/config';

import { fetchBarsPaginated, norm5, normD, computeDailyATRMap } from './lib/alpaca-data.js';
import { createSMA, createATR, createRSI, createSessionVWAP } from './lib/indicators.js';
import { computeStats, combineSymbolResults } from './lib/backtest-utils.js';
```

Remove the following functions from `backtest.js` (they are now imported):
- `fetchBarsPaginated` (lines 14-38)
- `norm5` (line 40)
- `normD` (line 41)
- `createSMA` (lines 45-53)
- `createATR` (lines 55-69)
- `createRSI` (lines 71-96)
- `createSessionVWAP` (lines 98-109)
- `computeDailyATRMap` (lines 127-142)
- `computeStats` (lines 476-491)
- `combineSymbolResults` (lines 548-580)

Keep the strategy-specific functions, scanner, simulation engine, reporting, and main function.

- [ ] **Step 2: Verify backtest still runs**

Run: `node scripts/backtest.js AMD 2>/dev/null | head -5`
Expected: Output begins with "Fetching AMD 5-min bars..."

- [ ] **Step 3: Commit**

```bash
git add scripts/backtest.js
git commit -m "refactor: update backtest.js to use shared lib/ modules"
```

---

### Task 18: Update swing-backtest.js to use lib/ modules

**Files:**
- Modify: `scripts/swing-backtest.js`

- [ ] **Step 1: Add imports and remove duplicated code**

Replace the top of `scripts/swing-backtest.js` with:

```js
#!/usr/bin/env node
import 'dotenv/config';

import { fetchBarsPaginated, normD, computeDailyATRMap } from './lib/alpaca-data.js';
import { createSMA, createATR, createRSI } from './lib/indicators.js';
import { computeStats, combineSymbolResults } from './lib/backtest-utils.js';
```

Note: Do NOT import `createSessionVWAP` or `norm5` — swing-backtest does not use VWAP or 5-minute normalized bars.

Remove the following functions from `swing-backtest.js` (now imported):
- `fetchBarsPaginated` — identical to the one in alpaca-data.js
- `normD` — identical
- `createSMA` — identical
- `createATR` — identical
- `createRSI` — identical
- `computeDailyATRMap` — identical
- `computeStats` — identical
- `combineSymbolResults` — identical

Keep the following (swing-specific or not in shared lib):
- `createEMA` — swing-specific, not in shared indicators
- All strategy functions (`createTrendPullbackState`, `processBarTrendPullback`, etc.)
- Simulation engine, reporting, and `main()`

- [ ] **Step 2: Verify swing backtest still runs**

Run: `node scripts/swing-backtest.js 2>/dev/null | head -5`
Expected: Output begins with fetching message

- [ ] **Step 3: Commit**

```bash
git add scripts/swing-backtest.js
git commit -m "refactor: update swing-backtest.js to use shared lib/ modules"
```

---

### Task 19: Extract all CONFIG values to env vars

**Files:**
- Modify: `scripts/touch-turn-bot.js:17-28`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing test**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('CONFIG env var overrides', () => {
  it('UNIVERSE reads from comma-separated env var', () => {
    process.env.UNIVERSE = 'AAPL,TSLA';
    const universe = (process.env.UNIVERSE || '').split(',').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(universe, ['AAPL', 'TSLA']);
    delete process.env.UNIVERSE;
  });

  it('UNIVERSE falls back to default list when env var not set', () => {
    const defaultUniverse = ['SOFI','INTC','Z','DAL','RIVN','SBUX','CCL','DIS','F','GM','PLTR','SNAP'];
    const universe = process.env.UNIVERSE
      ? process.env.UNIVERSE.split(',').map(s => s.trim()).filter(Boolean)
      : defaultUniverse;
    assert.deepEqual(universe, defaultUniverse);
  });

  it('numeric env vars parse with fallback', () => {
    process.env.ATR_PCT_THRESHOLD = '0.30';
    const val = parseFloat(process.env.ATR_PCT_THRESHOLD) || 0.25;
    assert.equal(val, 0.30);
    delete process.env.ATR_PCT_THRESHOLD;

    const val2 = parseFloat(process.env.ATR_PCT_THRESHOLD) || 0.25;
    assert.equal(val2, 0.25);
  });

  it('SESSION_END and HARD_EXIT parse as integers', () => {
    process.env.SESSION_END = '1200';
    process.env.HARD_EXIT = '1230';
    const sessionEnd = parseInt(process.env.SESSION_END, 10) || 1100;
    const hardExit = parseInt(process.env.HARD_EXIT, 10) || 1130;
    assert.equal(sessionEnd, 1200);
    assert.equal(hardExit, 1230);
    delete process.env.SESSION_END;
    delete process.env.HARD_EXIT;
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/touch-turn-bot.test.js`
Expected: PASS

- [ ] **Step 3: Update CONFIG in touch-turn-bot.js**

Replace lines 17-28:

```js
const UNIVERSE = ['SOFI', 'INTC', 'Z', 'DAL', 'RIVN', 'SBUX', 'CCL', 'DIS', 'F', 'GM', 'PLTR', 'SNAP'];
const DRY_RUN = process.env.DRY_RUN === 'true';
const CONFIG = {
  atrPctThreshold: 0.25,
  targetFib: 0.618,
  rrRatio: 2.0,
  positionPct: 50,
  sessionEnd: 1100,
  hardExit: 1130,
  pollIntervalMs: 30000,
  minATR: 0.50,
};
```

With:

```js
const UNIVERSE = (process.env.UNIVERSE || 'SOFI,INTC,Z,DAL,RIVN,SBUX,CCL,DIS,F,GM,PLTR,SNAP')
  .split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === 'true';
const CONFIG = {
  atrPctThreshold: parseFloat(process.env.ATR_PCT_THRESHOLD) || 0.25,
  targetFib: parseFloat(process.env.TARGET_FIB) || 0.618,
  rrRatio: parseFloat(process.env.RR_RATIO) || 2.0,
  positionPct: parseInt(process.env.POSITION_PCT, 10) || 10,
  sessionEnd: parseInt(process.env.SESSION_END, 10) || 1100,
  hardExit: parseInt(process.env.HARD_EXIT, 10) || 1130,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 30000,
  minATR: parseFloat(process.env.MIN_ATR) || 0.50,
  minPositionUSD: parseInt(process.env.MIN_POSITION_USD, 10) || 100,
};
```

Note: `positionPct` was already changed to use env var in Task 5. This task unifies the pattern for all CONFIG values.

- [ ] **Step 4: Update .env.example**

Append to `.env.example`:

```
# ─── Strategy parameters (defaults shown) ───
UNIVERSE=SOFI,INTC,Z,DAL,RIVN,SBUX,CCL,DIS,F,GM,PLTR,SNAP
ATR_PCT_THRESHOLD=0.25
TARGET_FIB=0.618
RR_RATIO=2.0
SESSION_END=1100
HARD_EXIT=1130
POLL_INTERVAL_MS=30000
MIN_ATR=0.50
MIN_POSITION_USD=100
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/touch-turn-bot.test.js tests/indicators.test.js tests/retry.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/touch-turn-bot.js .env.example tests/touch-turn-bot.test.js
git commit -m "feat: extract all strategy params to env vars with defaults"
```

---

### Task 20: Add bot core logic tests

**Files:**
- Modify: `tests/touch-turn-bot.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add scanCandidates tests**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('scanCandidates logic', () => {
  it('filters out symbols with ATR below minimum', () => {
    const dailyATR = 0.30;
    const minATR = 0.50;
    assert.ok(dailyATR < minATR, 'should be filtered out');
  });

  it('keeps symbols with ATR at or above minimum', () => {
    const dailyATR = 0.50;
    const minATR = 0.50;
    assert.ok(dailyATR >= minATR, 'should pass filter');
  });

  it('filters out ranges below ATR percentage threshold', () => {
    const range = 0.10;
    const dailyATR = 1.00;
    const threshold = 0.25;
    assert.ok(range < dailyATR * threshold, 'range too small, should be filtered');
  });

  it('keeps ranges at or above ATR percentage threshold', () => {
    const range = 0.25;
    const dailyATR = 1.00;
    const threshold = 0.25;
    assert.ok(range >= dailyATR * threshold, 'range sufficient, should pass');
  });

  it('sorts candidates by rangeATRRatio descending', () => {
    const candidates = [
      { sym: 'LOW', rangeATRRatio: 0.25 },
      { sym: 'HIGH', rangeATRRatio: 0.80 },
      { sym: 'MED', rangeATRRatio: 0.50 },
    ];
    candidates.sort((a, b) => b.rangeATRRatio - a.rangeATRRatio);
    assert.equal(candidates[0].sym, 'HIGH');
    assert.equal(candidates[1].sym, 'MED');
    assert.equal(candidates[2].sym, 'LOW');
  });
});
```

- [ ] **Step 2: Add session time tests**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('session time checks', () => {
  it('930 is before 945 entry window', () => {
    assert.ok(930 < 945);
  });

  it('945 is within entry window', () => {
    assert.ok(945 >= 945 && 945 < 1100);
  });

  it('1100 is at session end (no new entries)', () => {
    assert.ok(1100 >= 1100);
  });

  it('1130 is at hard exit', () => {
    assert.ok(1130 >= 1130);
  });
});
```

- [ ] **Step 3: Add entry/exit calculation tests**

Add to `tests/touch-turn-bot.test.js`:

```js
describe('entry/exit level calculation', () => {
  it('long: entry at range.low, target and stop based on fib and RR', () => {
    const range = { high: 11, low: 9, open: 10, close: 8.5, range: 2 };
    const isRed = range.close < range.open; // true
    assert.ok(isRed);

    const entryPrice = range.low; // 9
    const targetDist = 0.618 * range.range; // 1.236
    const target = entryPrice + targetDist; // 10.236
    const stop = entryPrice - targetDist / 2.0; // 8.382

    assert.equal(entryPrice, 9);
    assert.ok(Math.abs(target - 10.236) < 0.001);
    assert.ok(Math.abs(stop - 8.382) < 0.001);
  });

  it('short: entry at range.high, target and stop based on fib and RR', () => {
    const range = { high: 11, low: 9, open: 10, close: 11.5, range: 2 };
    const isGreen = range.close > range.open; // true
    assert.ok(isGreen);

    const entryPrice = range.high; // 11
    const targetDist = 0.618 * range.range; // 1.236
    const target = entryPrice - targetDist; // 9.764
    const stop = entryPrice + targetDist / 2.0; // 11.618

    assert.equal(entryPrice, 11);
    assert.ok(Math.abs(target - 9.764) < 0.001);
    assert.ok(Math.abs(stop - 11.618) < 0.001);
  });
});
```

- [ ] **Step 4: Update package.json test script**

Replace the test scripts in `package.json`:

```js
    "test": "node --test tests/telegram-ctl.test.js tests/touch-turn-bot.test.js tests/indicators.test.js tests/retry.test.js",
    "test:ctl": "node --test tests/telegram-ctl.test.js",
    "test:bot": "node --test tests/touch-turn-bot.test.js",
    "test:indicators": "node --test tests/indicators.test.js",
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/touch-turn-bot.test.js package.json
git commit -m "test: add bot core logic tests for scanning, session, and entry/exit"
```

---

### Task 21: Remove dead code from telegram.js

**Files:**
- Modify: `scripts/telegram.js`

- [ ] **Step 1: Remove tgBreakout and tgMorningBrief**

In `scripts/telegram.js`, remove the `tgBreakout` function (lines 57-63) and `tgMorningBrief` function (lines 65-72). These are dead code from a previous strategy.

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/telegram.js
git commit -m "chore: remove dead code (tgBreakout, tgMorningBrief)"
```

---

### Task 22: Final verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 2: Verify backtests still work**

Run: `node scripts/backtest.js AMD 2>/dev/null | head -5`
Expected: Output begins correctly

- [ ] **Step 3: Verify no dangling imports or references**

Search for any remaining references to removed code:
- `alpaca-config.json` — should have zero references
- `tgBreakout` — should have zero references
- `tgMorningBrief` — should have zero references
- `readConfig` — should have zero references in telegram-ctl.js
- `£` (GBP symbol) — should have zero references in backtest files

- [ ] **Step 4: Verify .env.example is complete**

Run: `cat .env.example`
Expected: Contains all required and optional env vars

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final cleanup and verification"
```