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
import { retry } from './lib/retry.js';
import { getNYTime, getHHMM, getTodayStr } from './lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───
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

// Multi-position tracking: symbol -> { orderId, side, entryPrice, stopPrice, targetPrice, qty, status, fillPrice, pnl }
const activePositions = new Map();
let isShuttingDown = false;

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
const WATCHLIST_FILE = process.env.WATCHLIST_PATH || path.join(__dirname, 'watchlist.json');

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

let saveInterval = null;

function startPeriodicSave() {
  saveInterval = setInterval(() => saveLog(), 5 * 60 * 1000);
}

function stopPeriodicSave() {
  if (saveInterval) clearInterval(saveInterval);
}

async function writeSnapshot(extra = {}) {
  try {
    const acct = await retry(() => alpaca.getAccount());
    const positions = await retry(() => alpaca.getPositions());
    const posData = positions.map(p => {
      const sym = p.symbol;
      const tracked = activePositions.get(sym);
      return {
        symbol: sym,
        side: p.side,
        qty: parseInt(p.qty),
        entryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPl: parseFloat(p.unrealized_pl),
        targetPrice: tracked?.targetPrice ?? parseFloat(p.avg_entry_price),
        stopPrice: tracked?.stopPrice ?? parseFloat(p.avg_entry_price),
      };
    });
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
      const resp = await retry(() => fetch(url, { headers }));
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
    const resp = await retry(() => fetch(url, { headers }));
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

function readWatchlist() {
  try {
    const data = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const wl = JSON.parse(data);
    if (wl.date === getTodayStr() && wl.candidates?.length > 0) {
      return wl;
    }
    log(`Watchlist stale (dated ${wl.date}, today ${getTodayStr()}) — ignoring`);
  } catch (e) { /* no watchlist file */ }
  return null;
}
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
  log(`Found ${candidates.length} candidate(s): ${candidates.map(c => `${c.sym} (${(c.rangeATRRatio * 100).toFixed(0)}% ATR)`).join(', ')}`);
  return candidates;
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
    const order = await retry(() => alpaca.createOrder({
      symbol: sym,
      qty,
      side: direction,
      type: 'limit',
      limit_price: entryPrice.toFixed(2),
      time_in_force: 'day',
      order_class: 'bracket',
      stop_loss: { stop_price: stopPrice.toFixed(2) },
      take_profit: { limit_price: targetPrice.toFixed(2) },
    }));

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
async function sendEODReport(tradeResults) {
  let msg = `📊 <b>End of Day Report</b>\n`;
  msg += `${getNYTime().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n\n`;

  if (!tradeResults || tradeResults.length === 0) {
    msg += `🤷 No trade today (no candidates passed filters)`;
  } else {
    msg += `${tradeResults.length} trade(s) today:\n`;
    let totalPnl = 0;
    for (const t of tradeResults) {
      const emoji = t.pnl >= 0 ? '✅' : '🛑';
      msg += `${emoji} <b>${t.symbol}</b> ${t.side?.toUpperCase() ?? '—'}: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}\n`;
      totalPnl += t.pnl;
    }
    msg += `\n<b>Total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`;
  }

  const acct = await retry(() => alpaca.getAccount()).catch(() => null);
  if (acct) msg += `\n💰 Balance: <b>$${parseFloat(acct.portfolio_value).toFixed(2)}</b>`;

  await sendTelegram(msg);
}

// ─── Close all positions at hard exit ───
async function closeAllPositions() {
  for (const [sym, pos] of activePositions) {
    if (pos.status === 'closed') continue;

    if (pos.status === 'pending' && pos.orderId && pos.orderId !== 'dry-run' && !DRY_RUN) {
      try {
        await retry(() => alpaca.cancelOrder(pos.orderId));
        log(`${sym}: Cancelled pending order at hard exit`, 'trade');
      } catch (e) {
        log(`${sym}: Cancel failed: ${e.message}`, 'error');
      }
    }

    if (pos.status === 'filled' && !DRY_RUN) {
      try {
        const alpacaPos = await retry(() => alpaca.getPosition(sym)).catch(() => null);
        if (alpacaPos && parseFloat(alpacaPos.qty) > 0) {
          pos.pnl = parseFloat(alpacaPos.unrealized_pl);
          await retry(() => alpaca.createOrder({
            symbol: sym, qty: alpacaPos.qty,
            side: alpacaPos.side === 'long' ? 'sell' : 'buy',
            type: 'market', time_in_force: 'day',
          }));
          log(`${sym}: Force-closed position (hard exit) — P&L: $${pos.pnl.toFixed(2)}`, 'trade');
        }
      } catch (e) {
        log(`${sym}: Close failed: ${e.message}`, 'error');
        await tgError(`${sym} close failed at hard exit: ${e.message}`);
      }
    }

    if (pos.status === 'dry_run') {
      log(`${sym}: DRY RUN — would close position at hard exit`, 'trade');
    }

    pos.status = 'closed';
  }
}

// ─── Main bot ───
async function runBot() {
  log('═'.repeat(60));
  log(`Touch & Turn Bot — ${IS_PAPER ? 'PAPER' : 'LIVE'} — DRY_RUN=${DRY_RUN}`);
  log(`Universe: ${UNIVERSE.join(', ')}`);
  log(`Window: 9:45–${CONFIG.sessionEnd} ET | Hard exit: ${CONFIG.hardExit} ET`);
  log(`Telegram: ${telegramEnabled() ? 'ON' : 'OFF'}`);
  log('═'.repeat(60));

  // Validate required env vars
  const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    log(`FATAL: Missing required env vars: ${missing.join(', ')}`, 'error');
    process.exit(1);
  }

  // Write initial snapshot
  await writeSnapshot();
  startPeriodicSave();

  // Verify Alpaca connection
  let account;
  try {
    account = await retry(() => alpaca.getAccount());
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
    await sendEODReport([]);
    saveLog();
    return;
  }

  // Scan for candidates (prefer watchlist from pre-market scanner)
  let candidates = [];
  const watchlist = readWatchlist();
  if (watchlist) {
    log(`Using watchlist from pre-market scan (${watchlist.candidates.length} candidates)`);
    for (const c of watchlist.candidates) {
      const range = await fetchOpeningRange(c.symbol);
      if (range) {
        candidates.push({
          sym: c.symbol, range, dailyATR: c.dailyATR,
          rangeATRRatio: range.range / c.dailyATR, lastPrice: c.entryPrice,
          side: c.side,
        });
      } else {
        log(`Watchlist symbol ${c.symbol} opening range unavailable`);
      }
    }
    if (candidates.length === 0) {
      log('No valid watchlist candidates — falling back to scan');
    }
  }
  if (candidates.length === 0) {
    const scanned = await scanCandidates(atrMap, priceMap);
    candidates = scanned || [];
  }

  if (candidates.length === 0) {
    log('No candidates passed filters — no trade today');
    await sendEODReport([]);
    await tgError('No candidates passed filters today — skipping');
    saveLog();
    return;
  }

  log(`Placing orders for ${candidates.length} candidate(s): ${candidates.map(c => c.sym).join(', ')}`);

  // Place bracket orders for all candidates
  const balance = parseFloat(account.portfolio_value);
  for (const candidate of candidates) {
    const { sym, range, dailyATR, side: watchlistSide } = candidate;

    const side = watchlistSide || (range.isRed ? 'long' : 'short');
    let entryPrice, targetPrice, stopPrice;
    if (side === 'long') {
      entryPrice = range.low;
      targetPrice = range.low + CONFIG.targetFib * range.range;
      stopPrice = range.low - (CONFIG.targetFib * range.range) / CONFIG.rrRatio;
    } else {
      entryPrice = range.high;
      targetPrice = range.high - CONFIG.targetFib * range.range;
      stopPrice = range.high + (CONFIG.targetFib * range.range) / CONFIG.rrRatio;
    }

    const positionValue = Math.max(balance * (CONFIG.positionPct / 100), CONFIG.minPositionUSD);
    const qty = Math.max(1, Math.floor(positionValue / entryPrice));

    log(`${sym} ${side.toUpperCase()}: Entry=$${entryPrice.toFixed(2)} | Target=$${targetPrice.toFixed(2)} | Stop=$${stopPrice.toFixed(2)} | Qty=${qty}`);

    const order = await placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty);

    if (order) {
      activePositions.set(sym, {
        orderId: order.id, side, entryPrice, stopPrice, targetPrice, qty,
        status: DRY_RUN ? 'dry_run' : 'pending',
        fillPrice: null, pnl: 0,
      });
    }
  }

  if (activePositions.size === 0) {
    log('No orders placed — exiting');
    await sendEODReport([]);
    saveLog();
    return;
  }

  await writeSnapshot({
    orders: [...activePositions.entries()].map(([sym, pos]) => ({
      symbol: sym, side: pos.side, qty: pos.qty,
      price: pos.entryPrice, stop: pos.stopPrice, target: pos.targetPrice,
    })),
  });
  saveLog();

  // Main monitoring loop: poll all orders/positions until hardExit
  while (getHHMM() < CONFIG.hardExit && !isShuttingDown) {
    const currentTime = getHHMM();
    let anyActive = false;

    for (const [sym, pos] of activePositions) {
      if (pos.status === 'closed') continue;
      anyActive = true;

      if (pos.status === 'pending') {
        // Cancel unfilled orders past session end
        if (currentTime >= CONFIG.sessionEnd) {
          if (!DRY_RUN && pos.orderId && pos.orderId !== 'dry-run') {
            try { await retry(() => alpaca.cancelOrder(pos.orderId)); } catch {}
          }
          pos.status = 'closed';
          log(`${sym}: Cancelled unfilled order (session end)`, 'trade');
          continue;
        }

        // Check order status
        try {
          const order = await retry(() => alpaca.getOrder(pos.orderId));
          log(`${sym}: Order status: ${order.status}`);
          if (order.status === 'filled') {
            pos.status = 'filled';
            pos.fillPrice = parseFloat(order.filled_avg_price);
            log(`${sym}: FILLED at $${pos.fillPrice.toFixed(2)}`, 'trade');
            await writeSnapshot();
          } else if (['canceled', 'rejected', 'expired'].includes(order.status)) {
            pos.status = 'closed';
            log(`${sym}: Order ${order.status}`, 'trade');
          }
        } catch (err) {
          log(`${sym}: Error checking order: ${err.message}`, 'error');
        }
      } else if (pos.status === 'filled') {
        // Check if position closed by bracket (stop/target)
        try {
          const alpacaPos = await retry(() => alpaca.getPosition(sym)).catch(() => null);
          if (!alpacaPos || parseFloat(alpacaPos.qty) === 0) {
            pos.status = 'closed';
            log(`${sym}: Position closed (by stop/target)`, 'trade');
          } else {
            pos.pnl = parseFloat(alpacaPos.unrealized_pl);
            log(`${sym}: Position open — unrealized P&L: $${pos.pnl.toFixed(2)}`);
          }
        } catch (err) {
          log(`${sym}: Position check error: ${err.message}`, 'error');
        }
      }
      // dry_run positions stay in dry_run status until hard exit
    }

    if (!anyActive) {
      log('All positions closed — exiting early');
      break;
    }

    await sleep(CONFIG.pollIntervalMs);
  }

  // Hard exit: cancel pending orders, close filled positions
  await closeAllPositions();

  // Build trade results for EOD report
  const tradeResults = [...activePositions.entries()].map(([sym, pos]) => ({
    symbol: sym,
    side: pos.side,
    entryPrice: pos.fillPrice || pos.entryPrice,
    pnl: pos.pnl || 0,
  }));

  await sendEODReport(tradeResults);
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

async function shutdown(signal) {
  log(`Shutting down (${signal})...`);
  if (isShuttingDown) return;
  isShuttingDown = true;

  await closeAllPositions();

  stopPeriodicSave();
  await tgShutdown();
  saveLog();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));