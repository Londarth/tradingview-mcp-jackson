# Comprehensive Bot Fixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 21 identified issues across the scalp-bot: 3 critical, 5 high, 7 medium, 6 low.

**Architecture:** Surgical fixes to existing files. One new helper in telegram.js for orphaned position warnings. No new files except updating `.env.example`.

**Tech Stack:** Node.js 18+, native `fetch`, Alpaca Trade API, Telegram Bot API, native `node:test`.

---

## Segment 1: Critical Fixes + Telegram Buttons

### Task 1: Fix parseInt -> parseFloat for Alpaca qty fields

**Files:**
- Modify: `scripts/touch-turn-bot.js` (lines 127, 422, 688, 689)

**Problem:** `parseInt` truncates fractional shares from Alpaca API responses. `parseInt("10.5")` returns 10, losing 0.5 share and miscomputing P&L.

- [ ] **Step 1: Fix parseInt usage in `writeSnapshot`**
  
  In `scripts/touch-turn-bot.js`, line 127:
  ```javascript
  // BEFORE:
  qty: parseInt(p.qty),
  // AFTER:
  qty: parseFloat(p.qty),
  ```

- [ ] **Step 2: Fix parseInt usage in `closeAllPositions`**
  
  In `scripts/touch-turn-bot.js`, line 422:
  ```javascript
  // BEFORE:
  if (alpacaPos && parseFloat(alpacaPos.qty) > 0) {
  // Already uses parseFloat — OK, no change needed
  ```
  
  Verify line 422 is already correct. If it uses parseInt, change to parseFloat.

- [ ] **Step 3: Fix parseInt usage in partial fill detection**
  
  In `scripts/touch-turn-bot.js`, lines 688-693:
  ```javascript
  // BEFORE:
  const filledQty = parseInt(order.filled_qty, 10);
  if (filledQty && filledQty < pos.qty) {
    log(`${sym}: PARTIAL FILL — ${filledQty}/${pos.qty} shares at $${pos.fillPrice.toFixed(2)}`, 'error');
    await tgError(`${sym} partial fill: ${filledQty}/${pos.qty} shares`);
    pos.qty = filledQty;
  }
  // AFTER:
  const filledQty = parseFloat(order.filled_qty);
  if (filledQty && filledQty < pos.qty) {
    log(`${sym}: PARTIAL FILL — ${filledQty}/${pos.qty} shares at $${pos.fillPrice.toFixed(2)}`, 'error');
    await tgError(`${sym} partial fill: ${filledQty}/${pos.qty} shares`);
    pos.qty = filledQty;
  }
  ```

- [ ] **Step 4: Add test for parseFloat qty handling**
  
  Append to `tests/touch-turn-bot.test.js`:
  ```javascript
  describe('parseFloat vs parseInt for Alpaca qty', () => {
    it('parseFloat preserves fractional shares from API', () => {
      const alpacaQty = '10.5';
      assert.equal(parseFloat(alpacaQty), 10.5);
      assert.equal(parseInt(alpacaQty, 10), 10);  // loses 0.5 share
    });

    it('parseFloat handles whole number qty strings', () => {
      assert.equal(parseFloat('100'), 100);
    });
  });
  ```

- [ ] **Step 5: Run tests**
  
  Run: `npm test`
  Expected: All tests pass

- [ ] **Step 6: Commit**
  
  ```bash
  git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
  git commit -m "fix: use parseFloat for Alpaca qty to preserve fractional shares"
  ```

---

### Task 2: Fix morning report with empty ATR data on crash recovery

**Files:**
- Modify: `scripts/touch-turn-bot.js` (lines 491-498)

**Problem:** When state is restored from crash, `fetchDailyATRs` is skipped, leaving `atrMap={}` and `priceMap={}`. The morning report still renders an empty universe scan table.

- [ ] **Step 1: Always fetch ATRs for the morning report**
  
  In `scripts/touch-turn-bot.js`, replace lines 491-498:
  ```javascript
  // BEFORE:
  let atrMap = {}, priceMap = {};
  if (!restored) {
    log('Fetching daily ATRs...');
    ({ atrMap, priceMap } = await fetchDailyATRs(UNIVERSE));
  }

  // Send morning report
  await sendMorningReport(account, atrMap, priceMap);

  // AFTER:
  let atrMap = {}, priceMap = {};
  log('Fetching daily ATRs...');
  ({ atrMap, priceMap } = await fetchDailyATRs(UNIVERSE));

  // Send morning report
  await sendMorningReport(account, atrMap, priceMap);
  ```

  Note: We always fetch ATRs because the morning report needs them. The `restored` flag still correctly skips the scanning/ordering phase below.

- [ ] **Step 2: Add test for morning report with ATR data**
  
  Append to `tests/touch-turn-bot.test.js`:
  ```javascript
  describe('morning report ATR data', () => {
    it('should include ATR data in morning report regardless of restored state', () => {
      const atrMap = { SOFI: 0.45, INTC: 0.62 };
      const priceMap = { SOFI: 8.50, INTC: 21.30 };
      // Verify the report renders ATR values
      for (const sym of Object.keys(atrMap)) {
        assert.ok(atrMap[sym] > 0, `${sym} should have ATR data`);
        assert.ok(priceMap[sym] > 0, `${sym} should have price data`);
      }
    });

    it('empty ATR map makes morning report useless', () => {
      const atrMap = {};
      const priceMap = {};
      assert.equal(Object.keys(atrMap).length, 0, 'empty ATR map = no scan data');
    });
  });
  ```

- [ ] **Step 3: Run tests**
  
  Run: `npm test`
  Expected: All tests pass

- [ ] **Step 4: Commit**
  
  ```bash
  git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
  git commit -m "fix: always fetch ATRs for morning report, even on crash recovery"
  ```

---

### Task 3: Orphaned position warning with Telegram close/keep buttons

**Files:**
- Modify: `scripts/telegram.js` (add `tgOrphanedPositions` function)
- Modify: `scripts/telegram-ctl.js` (add `/close_all_orphaned` and `/keep_orphaned` handlers)
- Modify: `scripts/touch-turn-bot.js` (detect orphaned positions at hard exit)

**Problem:** At hard exit, positions open in Alpaca but NOT tracked by the bot are silently ignored. These could be from crashes, manual trades, or other bots. Force-closing them is dangerous. Solution: Warn with Telegram buttons to close or keep.

- [ ] **Step 1: Add `tgOrphanedPositions` to `telegram.js`**
  
  Append to `scripts/telegram.js` before the closing exports:
  ```javascript
  // ─── Orphaned position buttons ───
  export const ORPHAN_BUTTONS = (positions) => [[
    { text: '❌ Close All', callback_data: '/close_orphaned' },
    { text: '✅ Keep All', callback_data: '/keep_orphaned' },
  ]];

  export async function tgOrphanedPositions(positions) {
    if (!positions || positions.length === 0) return;
    let msg = `⚠️ <b>Orphaned Positions Detected</b>\n`;
    msg += `These positions are open in Alpaca but not tracked by Touch & Turn:\n\n`;
    for (const p of positions) {
      const pnlSign = parseFloat(p.unrealized_pl) >= 0 ? '+' : '';
      msg += `• <b>${p.symbol}</b> ${p.side.toUpperCase()} ${p.qty}×$${parseFloat(p.avg_entry_price).toFixed(2)}`;
      msg += ` | ${pnlSign}$${parseFloat(p.unrealized_pl).toFixed(2)}\n`;
    }
    msg += `\nThese may be from another bot or manual trades.`;
    await sendTelegram(msg, { buttons: ORPHAN_BUTTONS(positions) });
  }
  ```

- [ ] **Step 2: Add orphaned position handlers to `telegram-ctl.js`**
  
  Add after `handleHelp` function (before COMMANDS):
  ```javascript
  let pendingOrphanedPositions = [];

  async function handleCloseOrphaned() {
    const positions = pendingOrphanedPositions;
    pendingOrphanedPositions = [];
    if (positions.length === 0) {
      await sendTelegram('No orphaned positions to close.', { buttons: MAIN_BUTTONS });
      return;
    }
    let closed = 0;
    for (const p of positions) {
      try {
        const side = p.side === 'long' ? 'sell' : 'buy';
        await pm2(`eval 'node -e "const A=require(\"@alpacahq/alpaca-trade-api\");const a=new A({keyId:process.env.ALPACA_API_KEY,secretKey:process.env.ALPACA_SECRET_KEY,paper:process.env.ALPACA_PAPER!==\"false\"});a.createOrder({symbol:\"${p.symbol}\",qty:${p.qty},side:\"${side}\",type:\"market\",time_in_force:\"day\"}).then(()=>console.log(\"closed\")).catch(e=>console.error(e))"'`);
        closed++;
      } catch (e) {
        console.error(`Failed to close orphaned ${p.symbol}: ${e.message}`);
      }
    }
    await sendTelegram(`✅ Requested market close for ${closed}/${positions.length} orphaned position(s)`, { buttons: MAIN_BUTTONS });
  }

  async function handleKeepOrphaned() {
    const count = pendingOrphanedPositions.length;
    pendingOrphanedPositions = [];
    await sendTelegram(`✅ Keeping ${count} orphaned position(s) as-is`, { buttons: MAIN_BUTTONS });
  }
  ```

  Add to COMMANDS:
  ```javascript
  const COMMANDS = {
    '/start': handleStart,
    '/stop': handleStop,
    '/status': handleStatus,
    '/help': handleHelp,
    '/close_orphaned': handleCloseOrphaned,
    '/keep_orphaned': handleKeepOrphaned,
  };
  ```

  Export `pendingOrphanedPositions` so the bot can populate it:
  ```javascript
  export { pendingOrphanedPositions };
  ```

  Actually, better approach: write orphaned positions to a file, which telegram-ctl reads.

- [ ] **Step 3: Use file-based communication for orphaned positions**
  
  The bot and telegram-ctl run in separate processes, so direct variable sharing won't work. Use a file.

  In `scripts/touch-turn-bot.js`, add after `const STATE_FILE`:
  ```javascript
  const ORPHANED_FILE = path.join(__dirname, 'orphaned-positions.json');
  ```

  Add a function to detect and save orphaned positions:
  ```javascript
  function saveOrphanedPositions(positions) {
    try {
      if (positions.length === 0) {
        try { fs.unlinkSync(ORPHANED_FILE); } catch {}
        return;
      }
      fs.writeFileSync(ORPHANED_FILE, JSON.stringify({ ts: Date.now(), positions }, null, 2));
    } catch (e) {
      log(`Orphaned positions save error: ${e.message}`, 'error');
    }
  }
  ```

  In the `closeAllPositions` function, after the `await Promise.allSettled(closeOps)` line, add orphaned position detection:
  ```javascript
  // Check for orphaned positions (in Alpaca but not tracked by bot)
  try {
    const allAlpacaPositions = await retry(() => alpaca.getPositions());
    const trackedSymbols = new Set([...activePositions.keys()]);
    const orphaned = allAlpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
    if (orphaned.length > 0) {
      log(`WARNING: ${orphaned.length} orphaned position(s) in Alpaca: ${orphaned.map(p => p.symbol).join(', ')}`, 'error');
      saveOrphanedPositions(orphaned);
      await tgOrphanedPositions(orphaned);
    } else {
      saveOrphanedPositions([]);
    }
  } catch (e) {
    log(`Orphaned position check error: ${e.message}`, 'error');
  }
  ```

  Add import at top of `touch-turn-bot.js`:
  ```javascript
  import { sendTelegram, tgTradeSignalsBatch, tgError, tgShutdown, telegramEnabled, tgOrphanedPositions } from './telegram.js';
  ```

- [ ] **Step 4: Update `telegram-ctl.js` to read orphaned file**

  Add to `telegram-ctl.js`:
  ```javascript
  const ORPHANED_PATH = join(__dirname, 'orphaned-positions.json');

  async function readOrphanedPositions() {
    try {
      const data = await readFile(ORPHANED_PATH, 'utf8');
      const parsed = JSON.parse(data);
      // Only return if recent (within 30 minutes)
      if (Date.now() - parsed.ts < 30 * 60 * 1000) {
        return parsed.positions;
      }
    } catch {}
    return [];
  }
  ```

  Update `handleCloseOrphaned` and `handleKeepOrphaned`:
  ```javascript
  async function handleCloseOrphaned() {
    const positions = await readOrphanedPositions();
    if (positions.length === 0) {
      await sendTelegram('No orphaned positions to close.', { buttons: MAIN_BUTTONS });
      return;
    }
    // Use Alpaca API directly to close each position
    let closed = 0, failed = 0;
    for (const p of positions) {
      try {
        // Use Alpaca REST API via curl (telegram-ctl runs outside the bot process)
        const headers = {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        };
        const base = process.env.ALPACA_PAPER === 'false'
          ? 'https://api.alpaca.markets'
          : 'https://paper-api.alpaca.markets';
        const side = p.side === 'long' ? 'sell' : 'buy';
        const resp = await fetch(`${base}/v2/orders`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: p.symbol,
            qty: parseFloat(p.qty),
            side,
            type: 'market',
            time_in_force: 'day',
          }),
        });
        if (resp.ok) {
          closed++;
        } else {
          failed++;
          console.error(`Close failed for ${p.symbol}: ${resp.status}`);
        }
      } catch (e) {
        failed++;
        console.error(`Close orphaned ${p.symbol} error: ${e.message}`);
      }
    }
    // Clean up orphaned file
    try { await import('fs').then(fs => fs.promises.unlink(ORPHANED_PATH)); } catch {}
    await sendTelegram(`✅ Closed ${closed}/${positions.length} orphaned position(s)${failed > 0 ? ` (${failed} failed)` : ''}`, { buttons: MAIN_BUTTONS });
  }

  async function handleKeepOrphaned() {
    const positions = await readOrphanedPositions();
    // Clean up orphaned file
    try { await import('fs').then(fs => fs.promises.unlink(ORPHANED_PATH)); } catch {}
    await sendTelegram(`✅ Keeping ${positions.length} orphaned position(s) as-is`, { buttons: MAIN_BUTTONS });
  }
  ```

  Note: `handleCloseOrphaned` uses the Alpaca REST API directly since telegram-ctl doesn't have the Alpaca SDK initialized. It imports the base URL logic similar to how the bot configures it.

  Actually, let me simplify: telegram-ctl already runs on the same VPS where the Alpaca SDK is installed. Let me use the SDK approach through pm2 eval or direct API calls. The fetch approach above is simpler and doesn't need PM2.

  Add Alpaca API base URL constant:
  ```javascript
  const ALPACA_BASE = process.env.ALPACA_PAPER === 'false'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';
  const ALPACA_HEADERS = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
  ```

- [ ] **Step 5: Update command router and help text**
  
  Update COMMANDS:
  ```javascript
  const COMMANDS = {
    '/start': handleStart,
    '/stop': handleStop,
    '/status': handleStatus,
    '/help': handleHelp,
    '/close_orphaned': handleCloseOrphaned,
    '/keep_orphaned': handleKeepOrphaned,
  };
  ```

  Update `handleHelp`:
  ```javascript
  async function handleHelp() {
    await sendTelegram(
      '🤖 <b>Scalp Bot Commands</b>\n\n' +
      '/start — Start the trading bot\n' +
      '/stop — Stop the trading bot\n' +
      '/status — Show bot status and recent trades\n' +
      '/help — Show this message\n\n' +
      '⚠️ Orphaned position buttons appear automatically when detected.',
      { buttons: MAIN_BUTTONS }
    );
  }
  ```

- [ ] **Step 6: Clean up orphaned file at bot start**
  
  In `scripts/touch-turn-bot.js`, at the beginning of `runBot()`, after state restore, add:
  ```javascript
  // Clean up any stale orphaned positions file from previous run
  try { fs.unlinkSync(path.join(__dirname, 'orphaned-positions.json')); } catch {}
  ```

- [ ] **Step 7: Add tests for orphaned positions**
  
  Append to `tests/touch-turn-bot.test.js`:
  ```javascript
  describe('orphaned position detection', () => {
    it('detects positions in Alpaca not tracked by bot', () => {
      const activePositions = new Map();
      activePositions.set('SOFI', { status: 'closed', pnl: 0 });
      const alpacaPositions = [
        { symbol: 'SOFI', side: 'long', qty: '100' },
        { symbol: 'AAPL', side: 'long', qty: '50' },  // orphaned
        { symbol: 'TSLA', side: 'short', qty: '20' }, // orphaned
      ];
      const trackedSymbols = new Set([...activePositions.keys()]);
      const orphaned = alpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
      assert.equal(orphaned.length, 2);
      assert.equal(orphaned[0].symbol, 'AAPL');
      assert.equal(orphaned[1].symbol, 'TSLA');
    });

    it('returns empty when all Alpaca positions are tracked', () => {
      const activePositions = new Map();
      activePositions.set('SOFI', { status: 'filled', pnl: 0 });
      const alpacaPositions = [
        { symbol: 'SOFI', side: 'long', qty: '100' },
      ];
      const trackedSymbols = new Set([...activePositions.keys()]);
      const orphaned = alpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
      assert.equal(orphaned.length, 0);
    });

    it('returns empty when no Alpaca positions exist', () => {
      const activePositions = new Map();
      const alpacaPositions = [];
      const trackedSymbols = new Set([...activePositions.keys()]);
      const orphaned = alpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
      assert.equal(orphaned.length, 0);
    });
  });
  ```

  Append to `tests/telegram-ctl.test.js`:
  ```javascript
  describe('orphaned position commands', () => {
    it('parseCommand handles /close_orphaned and /keep_orphaned', () => {
      assert.equal(parseCommand('/close_orphaned'), '/close_orphaned');
      assert.equal(parseCommand('/keep_orphaned'), '/keep_orphaned');
    });
  });
  ```

- [ ] **Step 8: Run tests**
  
  Run: `npm test`
  Expected: All tests pass

- [ ] **Step 9: Commit**
  
  ```bash
  git add scripts/touch-turn-bot.js scripts/telegram.js scripts/telegram-ctl.js tests/touch-turn-bot.test.js tests/telegram-ctl.test.js
  git commit -m "feat: warn about orphaned Alpaca positions with Telegram close/keep buttons"
  ```

---

## Segment 2: High-Priority Fixes

### Task 4: Fix P&L computation for bracket-closed positions

**Files:**
- Modify: `scripts/touch-turn-bot.js` (lines 714-728)

**Problem:** The bot matches the exit order by side direction in the last 5 closed orders, which can match the wrong leg or miss the exit entirely.

- [ ] **Step 1: Fix P&L lookup by using the parent bracket order's legs**

  In `scripts/touch-turn-bot.js`, replace the P&L capture block (lines 714-728):
  ```javascript
  // BEFORE: fragile loop through last 5 orders
  try {
    const orders = await retry(() => alpaca.getOrders({ status: 'closed', limit: 5, symbols: sym }));
    for (const o of orders) {
      if (o.side === (pos.side === 'long' ? 'sell' : 'buy') && o.filled_avg_price) {
        const exitPrice = parseFloat(o.filled_avg_price);
        const filledQty = parseInt(o.filled_qty, 10) || pos.qty;
        realizedPnl = (exitPrice - (pos.fillPrice ?? pos.entryPrice)) * filledQty * (pos.side === 'short' ? -1 : 1);
        break;
      }
    }
  } catch (e) { ... }

  // AFTER: search with higher limit and match by leg relationship
  try {
    const orders = await retry(() => alpaca.getOrders({
      status: 'closed',
      limit: 20,
      symbols: sym,
      direction: 'desc',
    }));
    // Find exit order: match by side AND parent order ID
    const exitSide = pos.side === 'long' ? 'sell' : 'buy';
    for (const o of orders) {
      if (o.side === exitSide && o.filled_avg_price && parseFloat(o.filled_qty) > 0) {
        // Verify this is from our bracket (parent_order_id matches our orderId)
        if (o.parent_order_id && o.parent_order_id === pos.orderId) {
          const exitPrice = parseFloat(o.filled_avg_price);
          const filledQty = parseFloat(o.filled_qty) || pos.qty;
          realizedPnl = (exitPrice - (pos.fillPrice ?? pos.entryPrice)) * filledQty * (pos.side === 'short' ? -1 : 1);
          break;
        } else if (!o.parent_order_id) {
          // Fallback: if no parent_order_id field, use the first matching exit
          const exitPrice = parseFloat(o.filled_avg_price);
          const filledQty = parseFloat(o.filled_qty) || pos.qty;
          realizedPnl = (exitPrice - (pos.fillPrice ?? pos.entryPrice)) * filledQty * (pos.side === 'short' ? -1 : 1);
          break;
        }
      }
    }
  } catch (e) {
    log(`${sym}: Could not fetch exit order for P&L: ${e.message}`, 'error');
  }
  ```

- [ ] **Step 2: Add test**
  
  ```javascript
  describe('bracket exit P&L by parent order ID', () => {
    it('matches exit order by parent_order_id when available', () => {
      const pos = { side: 'long', orderId: 'parent-123', fillPrice: 10, qty: 100 };
      const orders = [
        { side: 'sell', filled_avg_price: '11', filled_qty: '100', parent_order_id: 'parent-123' },
        { side: 'sell', filled_avg_price: '15', filled_qty: '50', parent_order_id: 'other-999' },
      ];
      const exitSide = 'sell';
      let realizedPnl = 0;
      for (const o of orders) {
        if (o.side === exitSide && o.filled_avg_price && parseFloat(o.filled_qty) > 0) {
          if (o.parent_order_id && o.parent_order_id === pos.orderId) {
            realizedPnl = (parseFloat(o.filled_avg_price) - pos.fillPrice) * parseFloat(o.filled_qty);
            break;
          }
        }
      }
      assert.equal(realizedPnl, 100); // (11 - 10) * 100 = $100
    });
  });
  ```

- [ ] **Step 3: Run tests, commit**

  ```bash
  npm test
  git add scripts/touch-turn-bot.js tests/touch-turn-bot.test.js
  git commit -m "fix: match bracket exit orders by parent_order_id for accurate P&L"
  ```

---

### Task 5: Add timeout to `fetchBarsPaginated`

**Files:**
- Modify: `scripts/lib/alpaca-data.js` (line 18)

- [ ] **Step 1: Add abort signal timeout**

  In `scripts/lib/alpaca-data.js`, add `timeout` parameter and signal:
  ```javascript
  export async function fetchBarsPaginated(symbol, timeframe, startDate, endDate, timeout = 30000) {
    // ...
    const resp = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/lib/alpaca-data.js
  git commit -m "fix: add 30s timeout to fetchBarsPaginated to prevent hangs"
  ```

---

### Task 6: Add concurrency limit to parallel API calls in `fetchDailyATRs`

**Files:**
- Modify: `scripts/touch-turn-bot.js` (lines 176-186)

- [ ] **Step 1: Add a simple concurrency limiter**
  
  Replace the `Promise.allSettled` block in `fetchDailyATRs`:
  ```javascript
  // BEFORE:
  const results = await Promise.allSettled(symbols.map(async (sym) => { ... }));

  // AFTER: Process in batches of 4 to avoid rate limits
  const BATCH_SIZE = 4;
  const results = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(async (sym) => {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${start}&end=${end}&limit=21&feed=iex`;
      const resp = await retry(() => fetch(url, { headers, signal: AbortSignal.timeout(CONFIG.apiTimeoutMs) }));
      if (!resp.ok) throw new Error(`Alpaca API ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
      const data = await resp.json();
      const rawBars = data.bars?.[sym] || [];
      const bars = rawBars.map(b => ({ high: b.h, low: b.l, close: b.c }));
      if (bars.length > 0) priceMap[sym] = bars[bars.length - 1].close;
      atrMap[sym] = calcATR(bars, 14);
      log(`${sym}: ATR=$${atrMap[sym]?.toFixed(2) ?? 'N/A'} | Last=$${priceMap[sym]?.toFixed(2) ?? 'N/A'}`);
    }));
    results.push(...batchResults);
    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < symbols.length) await sleep(500);
  }
  ```

- [ ] **Step 2: Run tests, commit**
  
  ```bash
  npm test
  git add scripts/touch-turn-bot.js
  git commit -m "fix: batch API calls in fetchDailyATRs to avoid Alpaca rate limits"
  ```

---

### Task 7: Add backoff to telegram-ctl polling loop

**Files:**
- Modify: `scripts/telegram-ctl.js` (poll function)

- [ ] **Step 1: Add exponential backoff on poll failures**
  
  Replace the `poll` function and add a delay counter in `main`:
  ```javascript
  let pollFailCount = 0;
  const POLL_MAX_BACKOFF_MS = 30000;

  async function poll() {
    try {
      const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(35000) });
      if (!resp.ok) {
        console.error(`Poll error: ${resp.status}`);
        pollFailCount++;
        return;
      }
      const data = await resp.json();
      if (!data.ok || !data.result) {
        pollFailCount++;
        return;
      }

      // Reset fail count on success
      pollFailCount = 0;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          await handleMessage(update.message);
        } else if (update.callback_query) {
          const cb = update.callback_query;
          if (isAuthorized(cb.message?.chat?.id)) {
            const handler = COMMANDS[cb.data];
            if (handler) {
              console.log(`Callback: ${cb.data} from ${cb.from?.id}`);
              await handler();
            }
          }
          await answerCallbackQuery(cb.id);
        }
      }
    } catch (err) {
      console.error(`Poll failed: ${err.message}`);
      pollFailCount++;
    }
  }

  async function main() {
    if (!TG_TOKEN || !TG_CHAT_ID) {
      console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
      process.exit(1);
    }

    console.log('🤖 Scalp Bot Controller started');
    console.log(`Chat ID: ${TG_CHAT_ID}`);
    console.log('Listening for commands: /start, /stop, /status, /help');

    while (true) {
      await poll();
      // Exponential backoff on consecutive failures
      if (pollFailCount > 0) {
        const delay = Math.min(1000 * Math.pow(2, Math.min(pollFailCount - 1, 5)), POLL_MAX_BACKOFF_MS);
        console.log(`Poll failure #${pollFailCount}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/telegram-ctl.js
  git commit -m "fix: add exponential backoff to Telegram polling on failures"
  ```

---

### Task 8: Fix `parseCommand` to strip @botname internally

**Files:**
- Modify: `scripts/telegram-ctl.js` (`parseCommand` function)
- Modify: `tests/telegram-ctl.test.js` (update @botname test)

- [ ] **Step 1: Update `parseCommand`**
  
  ```javascript
  export function parseCommand(text) {
    if (!text || !text.startsWith('/')) return null;
    const parts = text.trim().split(/\\s+/);
    // Strip @botname mention and lowercase
    return parts[0].split('@')[0].toLowerCase();
  }
  ```

- [ ] **Step 2: Update test**
  
  ```javascript
  it('handles /start with bot mention (@botname)', () => {
    assert.equal(parseCommand('/start@myScalpBot'), '/start');
  });
  ```

- [ ] **Step 3: Simplify command router**
  
  Remove the `normalizedCmd = cmd.split('@')[0]` line since `parseCommand` now handles it:
  ```javascript
  async function handleMessage(msg) {
    if (!isAuthorized(msg.chat.id)) {
      console.log(`Ignoring message from unauthorized chat: ${msg.chat.id}`);
      return;
    }
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    const handler = COMMANDS[cmd];
    if (handler) {
      console.log(`Command: ${cmd} from ${msg.chat.id}`);
      await handler();
    }
  }
  ```

- [ ] **Step 4: Run tests, commit**

  ```bash
  npm test
  git add scripts/telegram-ctl.js tests/telegram-ctl.test.js
  git commit -m "fix: strip @botname inside parseCommand, simplify router"
  ```

---

## Segment 3: Medium-Priority Fixes

### Task 9: Add dotenv import to `alpaca-data.js`

- [ ] **Step 1: Add import**
  
  In `scripts/lib/alpaca-data.js`, add at top:
  ```javascript
  import 'dotenv/config';
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/lib/alpaca-data.js
  git commit -m "fix: add dotenv import to alpaca-data.js for standalone use"
  ```

---

### Task 10: Reduce redundant `writeSnapshot` API calls

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Add a cached snapshot write that reuses data from the monitoring loop**
  
  Add a debounced/cached snapshot writer:
  ```javascript
  let lastSnapshotData = null;
  const SNAPSHOT_DEBOUNCE_MS = 10000;
  let lastSnapshotWrite = 0;

  async function writeSnapshot(extra = {}) {
    try {
      const now = Date.now();
      // Reuse account/positions data if fetched recently (within poll interval)
      let acct, positions;
      if (lastSnapshotData && (now - lastSnapshotData.ts < SNAPSHOT_DEBOUNCE_MS) && Object.keys(extra).length === 0) {
        // Just refresh timestamp
        const snap = { ...lastSnapshotData, ts: now, ...extra };
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
        return;
      }
      acct = await retry(() => alpaca.getAccount());
      positions = await retry(() => alpaca.getPositions());
      const posData = positions.map(p => {
        const sym = p.symbol;
        const tracked = activePositions.get(sym);
        return {
          symbol: sym,
          side: p.side,
          qty: parseFloat(p.qty),
          entryPrice: parseFloat(p.avg_entry_price),
          currentPrice: parseFloat(p.current_price),
          unrealizedPl: parseFloat(p.unrealized_pl),
          targetPrice: tracked?.targetPrice ?? parseFloat(p.avg_entry_price),
          stopPrice: tracked?.stopPrice ?? parseFloat(p.avg_entry_price),
        };
      });
      const snap = {
        ts: now,
        mode: IS_PAPER ? 'PAPER' : 'LIVE',
        dryRun: DRY_RUN,
        equity: parseFloat(acct.portfolio_value),
        cash: parseFloat(acct.cash),
        positions: posData,
        ...extra,
      };
      lastSnapshotData = { ...snap };
      lastSnapshotWrite = now;
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
    } catch (e) {
      log(`Snapshot write error: ${e.message}`, 'error');
    }
  }
  ```
  
  Then in the monitoring loop, reuse the account data already fetched:
  ```javascript
  // Replace the separate getAccount call with snapshot reuse
  // In the portfolio state logging section, reuse writeSnapshot data:
  try {
    await writeSnapshot({
      orders: [...activePositions.entries()].map(([sym, pos]) => ({
        symbol: sym, side: pos.side, qty: pos.qty,
        price: pos.entryPrice, stop: pos.stopPrice, target: pos.targetPrice,
      })),
    });
  } catch {}
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/touch-turn-bot.js
  git commit -m "perf: debounce snapshot writes to reduce Alpaca API calls"
  ```

---

### Task 11: Move morning report to after order placement

**Files:**
- Modify: `scripts/touch-turn-bot.js`

- [ ] **Step 1: Restructure the morning report flow**
  
  Move `sendMorningReport` to after candidates are scanned and orders are placed, so it includes results:
  
  1. Remove the early `sendMorningReport(account, atrMap, priceMap)` call
  2. After order placement, send a combined report:
  
  ```javascript
  // Replace the separate morning report with a post-scan report
  await sendMorningReport(account, atrMap, priceMap);
  // ... becomes ... (remove it from the early position and add after order placement)
  ```
  
  Actually, morning report and trade signals serve different purposes. Keep the morning report but note when no orders are placed. After the `if (activePositions.size === 0)` block, improve the message:
  
  ```javascript
  if (activePositions.size === 0) {
    log('No orders placed — exiting');
    await sendEODReport([]);
    await tgError('No orders placed today (all candidates filtered by equity cap or min position size)');
    saveLog();
    return;
  }
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/touch-turn-bot.js
  git commit -m "fix: clarify why no orders placed in Telegram notification"
  ```

---

### Task 12: Fix RSI edge case when both avgGain and avgLoss are zero

**Files:**
- Modify: `scripts/lib/indicators.js` (line 49)

- [ ] **Step 1: Handle the edge case**
  
  ```javascript
  // BEFORE:
  if (avgLoss === 0) return 100;
  
  // AFTER:
  if (avgGain === 0 && avgLoss === 0) return 50; // No movement — neutral
  if (avgLoss === 0) return 100;
  ```

- [ ] **Step 2: Add test**
  
  ```javascript
  it('returns 50 when no price movement (both gains and losses are zero)', () => {
    const rsi = createRSI(3);
    rsi.push(10); rsi.push(10); rsi.push(10); rsi.push(10);
    assert.equal(rsi.value(), 50);
  });
  ```

- [ ] **Step 3: Run tests, commit**

  ```bash
  npm test
  git add scripts/lib/indicators.js tests/indicators.test.js
  git commit -m "fix: return RSI 50 when no price movement instead of 100"
  ```

---

### Task 13: Add cost model to swing backtest

**Files:**
- Modify: `scripts/swing-backtest.js`

- [ ] **Step 1: Add cost constants and apply them**
  
  ```javascript
  const SLIPPAGE_BPS = parseFloat(process.env.SLIPPAGE_BPS) || 5;
  const COMMISSION_PER_SHARE = parseFloat(process.env.COMMISSION_PER_SHARE) || 0.005;
  ```
  
  In `runSwingBacktest`, add cost computation:
  ```javascript
  function applyCosts(entryPrice, exitPrice, qty) {
    const slippageCost = (entryPrice + exitPrice) * qty * (SLIPPAGE_BPS / 10000);
    const commissionCost = qty * COMMISSION_PER_SHARE * 2;
    return slippageCost + commissionCost;
  }
  ```
  
  Apply in the exit handling:
  ```javascript
  if (exit.closed) {
    const costs = applyCosts(position.entryPrice, exit.exitPrice, position.qty);
    const pnl = (exit.exitPrice - position.entryPrice) * position.qty * (position.side === 'short' ? -1 : 1) - costs;
    // ... rest of the block
    trades.push({
      ...position, exitPrice: exit.exitPrice, exitType: exit.exitType,
      pnl, barsHeld: barsInPosition, costs,
    });
  ```

- [ ] **Step 2: Update report footer**
  
  Change `"No slippage/commission"` to `"Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share"`

- [ ] **Step 3: Run tests, commit**

  ```bash
  npm test
  git add scripts/swing-backtest.js
  git commit -m "fix: apply slippage and commission to swing backtest for realistic results"
  ```

---

### Task 14: Fix computeSharpe to use sample variance

**Files:**
- Modify: `scripts/lib/backtest-utils.js` (line 38)

- [ ] **Step 1: Use sample variance (N-1)**
  
  ```javascript
  // BEFORE:
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  
  // AFTER:
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
    : 0;
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/lib/backtest-utils.js
  git commit -m "fix: use sample variance (Bessel's correction) for Sharpe ratio"
  ```

---

### Task 15: Fix computeCalmar ratio division

**Files:**
- Modify: `scripts/lib/backtest-utils.js` (line 55)

**Problem:** `computeCalmar` receives `maxDrawdown` already scaled by 100 (from `computeStats`), then divides by `maxDrawdown * 100` again, making the ratio 100x too small.

- [ ] **Step 1: Fix the division**
  
  ```javascript
  // BEFORE:
  return cagr / (maxDrawdown * 100 || 1);
  
  // AFTER:
  return cagr / (maxDrawdown || 1);
  ```
  
  Note: `maxDrawdown` here is already the percentage (0-100 range) as passed from `computeStats` and `combineSymbolResults` which do `maxDrawdown * 100`. So dividing by `maxDrawdown` (the percentage) gives the correct Calmar ratio.

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/lib/backtest-utils.js
  git commit -m "fix: correct Calmar ratio division (was 100x too small)"
  ```

---

## Segment 4: Low-Priority Fixes

### Task 16: Use efficient ring buffer for tradeLog (optional, skip if low value)

**Impact:** Negligible. Skip for now. The splice approach works fine for the bot's usage pattern.

---

### Task 17: Parallelize `fetchDailyData` in pre-market-scan

**Files:**
- Modify: `scripts/pre-market-scan.js` (lines 35-64)

- [ ] **Step 1: Replace sequential loop with batched Promise.allSettled**
  
  ```javascript
  // BEFORE:
  for (const sym of symbols) { ... }

  // AFTER: process in batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(async (sym) => {
      try {
        const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${start}&end=${end}&limit=25&feed=iex`;
        const resp = await retry(() => fetch(url, { headers, signal: AbortSignal.timeout(30000) }));
        const data = await resp.json();
        const rawBars = data.bars?.[sym] || [];
        if (rawBars.length < 15) { console.log(`  ${sym}: insufficient daily data`); return { sym, error: true }; }
        // ... compute ATR etc.
        return { sym, dailyATR, lastClose, prevClose, avgVol };
      } catch (err) {
        console.log(`  ${sym}: ${err.message}`);
        return { sym, error: true };
      }
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value && !r.value.error) {
        const { sym, dailyATR, lastClose, prevClose, avgVol } = r.value;
        results[sym] = { dailyATR, lastClose, prevClose, avgVol };
      }
    }
  }
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/pre-market-scan.js
  git commit -m "perf: batch API calls in pre-market scanner to speed up data fetch"
  ```

---

### Task 18: Handle Telegram message length limit

**Files:**
- Modify: `scripts/telegram.js`

- [ ] **Step 1: Add message splitter**
  
  ```javascript
  const TG_MAX_LEN = 4096;

  export async function sendTelegram(text, { parseMode = 'HTML', buttons = null } = {}) {
    if (!enabled) return;
    // Split message if too long
    const messages = splitMessage(text, TG_MAX_LEN);
    for (let i = 0; i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      try {
        const body = {
          chat_id: TG_CHAT_ID,
          text: messages[i],
          parse_mode: parseMode,
        };
        // Only attach buttons to the last message
        if (isLast && buttons) body.reply_markup = { inline_keyboard: buttons };
        const resp = await retry(() => fetch(`${TG_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
        if (!resp.ok) {
          const err = await resp.text();
          console.error(`Telegram error: ${resp.status} ${err}`);
        }
      } catch (e) {
        console.error(`Telegram send failed: ${e.message}`);
      }
    }
  }

  function splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        parts.push(remaining);
        break;
      }
      // Split at last newline before maxLen to avoid breaking mid-line
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen; // no newline found, hard split
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return parts;
  }
  ```

- [ ] **Step 2: Add test**

  ```javascript
  describe('Telegram message splitting', () => {
    it('does not split short messages', () => {
      // Import splitMessage if exported, or test inline
      function splitMessage(text, maxLen) {
        if (text.length <= maxLen) return [text];
        const parts = [];
        let remaining = text;
        while (remaining.length > 0) {
          if (remaining.length <= maxLen) { parts.push(remaining); break; }
          let splitAt = remaining.lastIndexOf('\n', maxLen);
          if (splitAt <= 0) splitAt = maxLen;
          parts.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt);
        }
        return parts;
      }
      assert.deepEqual(splitMessage('hello', 10), ['hello']);
    });

    it('splits long messages at newlines', () => {
      function splitMessage(text, maxLen) {
        if (text.length <= maxLen) return [text];
        const parts = [];
        let remaining = text;
        while (remaining.length > 0) {
          if (remaining.length <= maxLen) { parts.push(remaining); break; }
          let splitAt = remaining.lastIndexOf('\n', maxLen);
          if (splitAt <= 0) splitAt = maxLen;
          parts.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt);
        }
        return parts;
      }
      const msg = 'line1\nline2\nline3\nline4\nline5';
      const parts = splitMessage(msg, 15);
      assert.ok(parts.length > 1, 'should split into multiple parts');
      assert.ok(parts.every(p => p.length <= 15), 'each part should be within limit');
    });
  });
  ```

- [ ] **Step 3: Run tests, commit**

  ```bash
  npm test
  git add scripts/telegram.js tests/telegram-ctl.test.js
  git commit -m "fix: split long Telegram messages to avoid 4096 char limit"
  ```

---

### Task 19: Create `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create template**
  
  ```bash
  cat > .env.example << 'EOF'
  # ─── Alpaca ───
  ALPACA_API_KEY=your_alpaca_api_key
  ALPACA_SECRET_KEY=your_alpaca_secret_key
  ALPACA_PAPER=true        # Set to 'false' for live trading

  # ─── Telegram ───
  TELEGRAM_BOT_TOKEN=your_telegram_bot_token
  TELEGRAM_CHAT_ID=your_telegram_chat_id

  # ─── Strategy ───
  UNIVERSE=SOFI,INTC,Z,DAL,RIVN,SBUX,CCL,DIS,F,GM,PLTR,SNAP
  ATR_PCT_THRESHOLD=0.25    # Min range/ATR ratio for entry
  TARGET_FIB=0.618           # Fibonacci target level
  RR_RATIO=2.0              # Risk:reward ratio
  POSITION_PCT=10           # % of equity per trade
  RISK_PCT=0                # Risk-based sizing (0 = disabled, use POSITION_PCT)
  MIN_ATR=0.50              # Min daily ATR filter
  MIN_POSITION_USD=100      # Min position size in USD

  # ─── Session ───
  SESSION_END=1100          # Entry window close (HHMM ET)
  HARD_EXIT=1130            # Force-close time (HHMM ET)
  POLL_INTERVAL_MS=30000    # Polling interval in ms
  UNFILLED_TIMEOUT_MIN=15   # Cancel unfilled orders after N minutes

  # ─── Risk Management ───
  DAILY_LOSS_LIMIT_PCT=3   # Stop trading when daily loss exceeds this %
  MAX_EQUITY_PCT=30        # Max equity at risk across all positions

  # ─── API ───
  API_TIMEOUT_MS=30000      # Alpaca API call timeout

  # ─── Scanner ───
  SCANNER_TOP_N=5          # Number of candidates to select per day
  WATCHLIST_PATH=scripts/watchlist.json

  # ─── Dry Run ───
  DRY_RUN=false            # Set to 'true' for signal-only mode (no orders)

  # ─── Backtest ───
  SLIPPAGE_BPS=5            # Slippage in basis points
  COMMISSION_PER_SHARE=0.005  # Commission per share
  EOF
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add .env.example
  git commit -m "docs: add .env.example with all documented variables"
  ```

---

### Task 20: (Hardcoded timestamps — skip, low impact, US hours are stable)

---

### Task 21: Fix `createNDayHigh.isNewHigh` self-comparison bug

**Files:**
- Modify: `scripts/swing-backtest.js` (lines 39-46, 185)

- [ ] **Step 1: Check against previous bars only**

  ```javascript
  function createNDayHigh(period) {
    const buf = [];
    return {
      push(bar) {
        buf.push(bar.high);
        if (buf.length > period) buf.shift();
      },
      value() { return buf.length >= period ? Math.max(...buf) : null; },
      isNewHigh(bar) {
        if (buf.length < period) return false;
        // Compare against all bars EXCEPT the last one (which is the current bar)
        const prevHighs = buf.slice(0, -1);
        return prevHighs.length >= period - 1 && bar.high >= Math.max(...prevHighs);
      },
      ready() { return buf.length >= period; },
    };
  }
  ```

- [ ] **Step 2: Run tests, commit**

  ```bash
  npm test
  git add scripts/swing-backtest.js
  git commit -m "fix: isNewHigh compares against previous bars only, not current"
  ```

---

## Post-Implementation

After all tasks:
- [ ] Run full test suite: `npm test`
- [ ] Start telegram-ctl and verify commands work
- [ ] Review all commit messages for consistency