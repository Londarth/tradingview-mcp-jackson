#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import Alpaca from '@alpacahq/alpaca-trade-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  sendTelegram, tgTradeSignal, tgDryRunSignal, tgError, tgEODSummary, tgShutdown,
  telegramEnabled,
} from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───
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

// ─── Alpaca client ───
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: process.env.ALPACA_PAPER !== 'false',
  feed: 'iex',
});

const IS_PAPER = process.env.ALPACA_PAPER !== 'false';
const LOG_FILE = path.join(__dirname, 'touch-turn-log.json');
const SNAPSHOT_FILE = path.join(__dirname, 'account-snapshot.json');

// ─── Logging ───
const tradeLog = [];
function log(msg, level = 'info') {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const prefix = level === 'error' ? 'ERR' : level === 'trade' ? 'TRD' : 'INF';
  console.log(`[${ts} ET] [${prefix}] ${msg}`);
  tradeLog.push({ ts, level, msg });
  if (tradeLog.length > 5000) tradeLog.splice(0, 2000);
}

function saveLog() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(tradeLog, null, 2));
  } catch (e) { /* ignore */ }
}

async function writeSnapshot(extra = {}) {
  try {
    const acct = await alpaca.getAccount();
    const positions = await alpaca.getPositions();
    const posData = positions.map(p => ({
      symbol: p.symbol,
      side: p.side,
      qty: parseInt(p.qty),
      entryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      unrealizedPl: parseFloat(p.unrealized_pl),
      targetPrice: parseFloat(p.avg_entry_price) + parseFloat(p.unrealized_pl),
      stopPrice: 0,
    }));
    const snap = {
      ts: Date.now(),
      mode: IS_PAPER ? 'PAPER' : 'LIVE',
      dryRun: DRY_RUN,
      equity: parseFloat(acct.portfolio_value),
      cash: parseFloat(acct.cash),
      positions: posData,
      ...extra,
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
  } catch (e) {
    log(`Snapshot write error: ${e.message}`, 'error');
  }
}

// ─── Time helpers ───
function getNYTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getHHMM() {
  const ny = getNYTime();
  return ny.getHours() * 100 + ny.getMinutes();
}

function getTodayStr() {
  return getNYTime().toISOString().split('T')[0];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── ATR calculation ───
function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

// ─── Fetch daily ATR for universe ───
async function fetchDailyATRs(symbols) {
  const atrMap = {};
  const priceMap = {};
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };

  for (const sym of symbols) {
    try {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${start}&end=${end}&limit=21&feed=iex`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      const rawBars = data.bars?.[sym] || [];
      const bars = rawBars.map(b => ({ high: b.h, low: b.l, close: b.c }));
      if (bars.length > 0) priceMap[sym] = bars[bars.length - 1].close;
      atrMap[sym] = calcATR(bars, 14);
      log(`${sym}: ATR=$${atrMap[sym]?.toFixed(2) ?? 'N/A'} | Last=$${priceMap[sym]?.toFixed(2) ?? 'N/A'}`);
    } catch (err) {
      log(`${sym} ATR fetch error: ${err.message}`, 'error');
      atrMap[sym] = null;
    }
  }
  return { atrMap, priceMap };
}

// ─── Fetch today's opening range (first 3 five-min bars) ───
async function fetchOpeningRange(symbol) {
  const today = getTodayStr();
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };

  try {
    // Fetch bars starting from 9:30 today
    const start = `${today}T09:30:00-04:00`;
    const end = `${today}T09:50:00-04:00`;
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=5Min&start=${start}&end=${end}&limit=5&feed=iex`;
    const resp = await fetch(url, { headers });
    const data = await resp.json();
    const rawBars = data.bars?.[symbol] || [];

    if (rawBars.length < 3) {
      log(`${symbol}: Only ${rawBars.length} bars, need 3 for opening range`);
      return null;
    }

    const bars = rawBars.slice(0, 3);
    const high = Math.max(...bars.map(b => b.h));
    const low = Math.min(...bars.map(b => b.l));
    const open = bars[0].o;
    const close = bars[2].c;
    const range = high - low;

    return { high, low, open, close, range, isRed: close < open, isGreen: close > open };
  } catch (err) {
    log(`${symbol} opening range fetch error: ${err.message}`, 'error');
    return null;
  }
}

// ─── Scanner: find best candidate ───
async function scanCandidates(atrMap, priceMap) {
  const candidates = [];

  for (const sym of UNIVERSE) {
    const dailyATR = atrMap[sym];
    const lastPrice = priceMap[sym];

    // Pre-filter: ATR too low
    if (!dailyATR || dailyATR < CONFIG.minATR) {
      log(`${sym}: Skipped — ATR $${dailyATR?.toFixed(2) ?? 'N/A'} < $${CONFIG.minATR}`);
      continue;
    }

    const range = await fetchOpeningRange(sym);
    if (!range) continue;

    // ATR filter: range must be >= 25% of daily ATR
    if (range.range < dailyATR * CONFIG.atrPctThreshold) {
      log(`${sym}: Skipped — range $${range.range.toFixed(2)} < ${CONFIG.atrPctThreshold * 100}% of ATR $${dailyATR.toFixed(2)}`);
      continue;
    }

    // Must have clear direction
    if (!range.isRed && !range.isGreen) {
      log(`${sym}: Skipped — doji opening candle`);
      continue;
    }

    const rangeATRRatio = range.range / dailyATR;
    candidates.push({ sym, range, dailyATR, rangeATRRatio, lastPrice });
    log(`${sym}: ✓ Range $${range.range.toFixed(2)} = ${(rangeATRRatio * 100).toFixed(0)}% of ATR | ${range.isRed ? 'RED→LONG' : 'GREEN→SHORT'}`);
  }

  if (candidates.length === 0) return null;

  // Sort by range/ATR ratio (strongest manipulation candle first)
  candidates.sort((a, b) => b.rangeATRRatio - a.rangeATRRatio);
  log(`Best candidate: ${candidates[0].sym} (${(candidates[0].rangeATRRatio * 100).toFixed(0)}% of ATR)`);
  return candidates[0];
}

// ─── Place bracket order ───
async function placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty) {
  const direction = side === 'long' ? 'buy' : 'sell';

  if (DRY_RUN) {
    const rr = side === 'long' ? (targetPrice - entryPrice) / (entryPrice - stopPrice) : (entryPrice - targetPrice) / (stopPrice - entryPrice);
    log(`${sym} ${side.toUpperCase()} signal: qty=${qty} @ $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | R:R=${rr.toFixed(1)} | DRY RUN`, 'trade');
    await tgDryRunSignal(sym, side, entryPrice, stopPrice, targetPrice, rr, qty);
    return { id: 'dry-run', status: 'dry_run' };
  }

  try {
    const order = await alpaca.createOrder({
      symbol: sym,
      qty,
      side: direction,
      type: 'limit',
      limit_price: entryPrice.toFixed(2),
      time_in_force: 'day',
      order_class: 'bracket',
      stop_loss: { stop_price: stopPrice.toFixed(2) },
      take_profit: { limit_price: targetPrice.toFixed(2) },
    });

    const rr = side === 'long' ? (targetPrice - entryPrice) / (entryPrice - stopPrice) : (entryPrice - targetPrice) / (stopPrice - entryPrice);
    log(`${sym} ${side.toUpperCase()} order placed: qty=${qty} @ limit $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | Order: ${order.id}`, 'trade');
    await tgTradeSignal(sym, side, entryPrice, stopPrice, targetPrice, rr, qty);
    return order;
  } catch (err) {
    log(`${sym} ORDER ERROR: ${err.message}`, 'error');
    await tgError(`${sym} order failed: ${err.message}`);
    return null;
  }
}

// ─── Monitor order status ───
async function monitorOrder(orderId, sym, untilHHMM) {
  while (getHHMM() < untilHHMM) {
    try {
      if (DRY_RUN) {
        // Simulate: assume not filled
        log(`${sym}: DRY RUN — monitoring (would cancel at ${untilHHMM})`);
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      const order = await alpaca.getOrder(orderId);
      log(`${sym}: Order ${orderId} status: ${order.status}`);

      if (order.status === 'filled') {
        const fillPrice = parseFloat(order.filled_avg_price);
        log(`${sym}: FILLED at $${fillPrice.toFixed(2)}`, 'trade');
        await writeSnapshot();
        return { filled: true, fillPrice };
      }

      if (order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired') {
        log(`${sym}: Order ${order.status}`, 'trade');
        return { filled: false, status: order.status };
      }

      // Still pending — wait
      await sleep(CONFIG.pollIntervalMs);
    } catch (err) {
      log(`${sym}: Error checking order: ${err.message}`, 'error');
      await sleep(CONFIG.pollIntervalMs);
    }
  }

  // Time's up — cancel unfilled order
  if (!DRY_RUN && orderId !== 'dry-run') {
    try {
      await alpaca.cancelOrder(orderId);
      log(`${sym}: Cancelled unfilled order (time limit)`, 'trade');
    } catch (err) {
      log(`${sym}: Cancel error: ${err.message}`, 'error');
    }
  }

  return { filled: false, status: 'cancelled_timeout' };
}

// ─── Monitor position until hard exit ───
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

// ─── Morning report ───
async function sendMorningReport(account, atrMap, priceMap) {
  const mode = IS_PAPER ? 'PAPER' : 'LIVE';
  const balance = parseFloat(account.portfolio_value);
  const positionValue = (balance * CONFIG.positionPct / 100);
  const dateStr = getNYTime().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  let msg = `⚡️ <b>TOUCH &amp; TURN BOT</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Account: <b>$${balance.toFixed(2)}</b> (${mode}${DRY_RUN ? ' DRY' : ''})\n`;
  msg += `📅 ${dateStr}\n\n`;
  msg += `📊 <b>UNIVERSE SCAN</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  for (const sym of UNIVERSE) {
    const atr = atrMap[sym];
    const price = priceMap[sym];
    const atrPct = atr && price ? (atr / price * 100) : 0;
    const ok = atr && atr >= CONFIG.minATR;
    const icon = ok ? '✅' : '⛔';
    const reason = !atr ? 'no data' : atr < CONFIG.minATR ? 'low vol' : '';
    msg += `${icon} <b>${sym.padEnd(5)}</b> ATR $${atr?.toFixed(2) ?? '??.??'}  (${atrPct.toFixed(1)}%)${reason ? '  ' + reason : ''}\n`;
  }

  msg += `\n📐 Position: <b>${CONFIG.positionPct}%</b> ($${positionValue.toFixed(2)})\n`;
  msg += `🕐 Window: 9:45 – ${String(CONFIG.sessionEnd).padStart(4, '0')} ET`;

  await sendTelegram(msg);
}

// ─── EOD report ───
async function sendEODReport(sym, side, entryPrice, exitPrice, pnl) {
  const results = [{ symbol: sym, side: side || 'none', pnl: pnl || 0 }];
  if (!sym) {
    results.length = 0;
  }
  let msg = `📊 <b>End of Day Report</b>\n`;
  msg += `${getNYTime().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n\n`;

  if (results.length === 0) {
    msg += `🤷 No trade today (no candidates passed filters)`;
  } else {
    const emoji = pnl >= 0 ? '✅' : '🛑';
    msg += `${emoji} <b>${sym}</b> ${side?.toUpperCase() ?? '—'}: ${pnl >= 0 ? '+' : ''}$${pnl?.toFixed(2) ?? '0.00'}\n`;
    if (entryPrice) msg += `Entry: $${entryPrice.toFixed(2)} | Exit: $${exitPrice?.toFixed(2) ?? 'N/A'}\n`;
  }

  const acct = await alpaca.getAccount().catch(() => null);
  if (acct) msg += `\n💰 Balance: <b>$${parseFloat(acct.portfolio_value).toFixed(2)}</b>`;

  await sendTelegram(msg);
}

// ─── Main bot ───
async function runBot() {
  log('═'.repeat(60));
  log(`Touch & Turn Bot — ${IS_PAPER ? 'PAPER' : 'LIVE'} — DRY_RUN=${DRY_RUN}`);
  log(`Universe: ${UNIVERSE.join(', ')}`);
  log(`Window: 9:45–${CONFIG.sessionEnd} ET | Hard exit: ${CONFIG.hardExit} ET`);
  log(`Telegram: ${telegramEnabled() ? 'ON' : 'OFF'}`);
  log('═'.repeat(60));

  // Write initial snapshot
  await writeSnapshot();

  // Verify Alpaca connection
  let account;
  try {
    account = await alpaca.getAccount();
    log(`Connected: $${parseFloat(account.cash).toFixed(2)} cash | $${parseFloat(account.portfolio_value).toFixed(2)} portfolio | ${account.status}`);
  } catch (err) {
    log(`FATAL: Cannot connect to Alpaca — ${err.message}`, 'error');
    await tgError(`Cannot connect to Alpaca: ${err.message}`);
    process.exit(1);
  }

  // Fetch daily ATRs for universe
  log('Fetching daily ATRs...');
  const { atrMap, priceMap } = await fetchDailyATRs(UNIVERSE);

  // Send morning report
  await sendMorningReport(account, atrMap, priceMap);

  // Wait for 9:45 (opening range complete)
  let hhmm = getHHMM();
  if (hhmm < 945) {
    const waitSec = (945 - hhmm) * 60; // rough estimate
    log(`Waiting for 9:45 ET (current: ${hhmm})...`);
    while (getHHMM() < 945) {
      await sleep(10000);
    }
    log('9:45 ET reached — scanning universe');
  }

  // Check if within trading window
  hhmm = getHHMM();
  if (hhmm >= CONFIG.sessionEnd) {
    log('Past trading window — exiting');
    await sendEODReport(null, null, null, null, 0);
    saveLog();
    return;
  }

  // Scan for best candidate
  const candidate = await scanCandidates(atrMap, priceMap);

  if (!candidate) {
    log('No candidates passed filters — no trade today');
    await sendEODReport(null, null, null, null, 0);
    await tgError('No candidates passed filters today — skipping');
    saveLog();
    return;
  }

  const { sym, range, dailyATR } = candidate;

  // Calculate entry/exit levels
  let side, entryPrice, targetPrice, stopPrice;
  if (range.isRed) {
    side = 'long';
    entryPrice = range.low;
    targetPrice = range.low + CONFIG.targetFib * range.range;
    stopPrice = range.low - (CONFIG.targetFib * range.range) / CONFIG.rrRatio;
  } else {
    side = 'short';
    entryPrice = range.high;
    targetPrice = range.high - CONFIG.targetFib * range.range;
    stopPrice = range.high + (CONFIG.targetFib * range.range) / CONFIG.rrRatio;
  }

  log(`${sym} ${side.toUpperCase()}: Entry=$${entryPrice.toFixed(2)} | Target=$${targetPrice.toFixed(2)} | Stop=$${stopPrice.toFixed(2)}`);

  // Calculate position size
  const balance = parseFloat(account.portfolio_value);
  const positionValue = balance * (CONFIG.positionPct / 100);
  const qty = Math.max(1, Math.floor(positionValue / range.close)); // use close for qty calc

  log(`${sym}: Position = $${positionValue.toFixed(2)} (${CONFIG.positionPct}%) = ${qty} shares @ $${range.close.toFixed(2)}`);

  // Place bracket order
  const order = await placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty);

  // Write snapshot with order info
  await writeSnapshot({
    order: {
      symbol: sym, side, qty,
      price: entryPrice, stop: stopPrice, target: targetPrice,
    },
  });

  if (!order) {
    log('Order failed — exiting');
    await sendEODReport(sym, side, null, null, 0);
    saveLog();
    return;
  }

  saveLog();

  // Monitor order until session end
  const orderResult = await monitorOrder(order.id, sym, CONFIG.sessionEnd);

  if (!orderResult.filled) {
    log(`${sym}: Order not filled — no trade executed`);
    await sendEODReport(sym, side, null, null, 0);
    saveLog();
    return;
  }

  // Order filled — monitor position until hard exit
  const posResult = await monitorPosition(sym, CONFIG.hardExit);

  // Get final P&L from monitorPosition result
  let pnl = posResult.pnl || 0;
  if (!DRY_RUN && posResult.byBracket) {
    // If closed by bracket (stop/target), try to get realized P&L from closed position
    try {
      const closedPos = await alpaca.getPosition(sym).catch(() => null);
      if (closedPos) pnl = parseFloat(closedPos.unrealized_pl);
    } catch (e) { /* position already closed */ }
  }

  log(`${sym}: Session complete — P&L: $${pnl.toFixed(2)}`, 'trade');
  await sendEODReport(sym, side, orderResult.fillPrice || entryPrice, null, pnl);
  await writeSnapshot();
  saveLog();
}

// ─── Start ───
runBot().catch(err => {
  log(`FATAL: ${err.message}`, 'error');
  tgError(`Bot crashed: ${err.message}`);
  saveLog();
  process.exit(1);
});

process.on('SIGINT', async () => {
  log('Shutting down...');
  await tgShutdown();
  saveLog();
  process.exit(0);
});