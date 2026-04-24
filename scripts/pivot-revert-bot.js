#!/usr/bin/env node
// scripts/pivot-revert-bot.js
// Pivot Reversion Scalper — fades S1/R1 rejections, targets pivot midpoint P
// Runs as a separate PM2 process alongside touch-turn-bot.js
// Shares the same Alpaca paper account but tracks its own positions

import dotenv from 'dotenv';
dotenv.config();

import Alpaca from '@alpacahq/alpaca-trade-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  sendTelegram, tgTradeSignalsBatch, tgError, tgShutdown,
  telegramEnabled,
} from './telegram.js';
import { retry } from './lib/retry.js';
import { getNYTime, getHHMM, getTodayStr } from './lib/time.js';
import { createPivots, checkPivotRejection } from './lib/indicators.js';
import { createATR, createSMA } from './lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───
const PIVOT_UNIVERSE = (process.env.PIVOT_UNIVERSE || process.env.UNIVERSE ||
  'PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK')
  .split(',').map(s => s.trim()).filter(Boolean);

const DRY_RUN = process.env.DRY_RUN === 'true';
const CONFIG = {
  maxTradesPerDay: parseInt(process.env.PIVOT_MAX_TRADES || '3', 10),
  stopAtrMult: parseFloat(process.env.PIVOT_STOP_ATR_MULT || '0.3'),
  minRR: parseFloat(process.env.PIVOT_MIN_RR || '1.5'),
  positionPct: parseInt(process.env.POSITION_PCT || '10', 10),
  minPositionUSD: parseInt(process.env.MIN_POSITION_USD || '100', 10),
  sessionStart: parseInt(process.env.PIVOT_SESSION_START || '945', 10),   // HHMM, after opening range
  sessionEnd: parseInt(process.env.PIVOT_SESSION_END || '1115', 10),      // stop looking for new entries
  hardExit: parseInt(process.env.HARD_EXIT || '1130', 10),                // force close all
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),  // check every 60s
  throttleAfterEmpty: parseInt(process.env.THROTTLE_AFTER_EMPTY || '5', 10),  // after N empty scans
  throttleIntervalMs: parseInt(process.env.THROTTLE_INTERVAL_MS || '300000', 10),  // slow to 5min
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '3'),
  cooldownBars: parseInt(process.env.PIVOT_COOLDOWN_BARS || '6', 10),     // 6 x 5min = 30min
  minATR: parseFloat(process.env.MIN_ATR || '0.50'),
  minATRPct: parseFloat(process.env.PIVOT_MIN_ATR_PCT || '4.0'),         // KEY GATE
  maxATRPct: parseFloat(process.env.PIVOT_MAX_ATR_PCT || '10.0'),
  maxEquityPct: parseFloat(process.env.MAX_EQUITY_PCT || '30'),
  apiTimeoutMs: parseInt(process.env.API_TIMEOUT_MS || '30000', 10),
};

// ─── Position tracking ───
const activePositions = new Map(); // symbol -> { orderId, side, entryPrice, stopPrice, targetPrice, pivotLevel, qty, status, fillPrice }
let isShuttingDown = false;
let dailyPnl = 0;
let tradesToday = 0;
let cooldownUntil = 0; // HHMM cooldown after last trade
let consecutiveEmptyScans = 0; // throttle after N empty scans

// ─── State persistence ───
const LOG_FILE = path.join(__dirname, 'pivot-revert-log.json');
const SNAPSHOT_FILE = path.join(__dirname, 'pivot-snapshot.json');
const STATE_FILE = path.join(__dirname, 'pivot-state.json');

// ─── Alpaca client ───
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: process.env.ALPACA_PAPER !== 'false',
  feed: 'iex',
});

const IS_PAPER = process.env.ALPACA_PAPER !== 'false';

// ─── Logging ───
const tradeLog = [];
function log(msg, level = 'info') {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const prefix = level === 'error' ? 'ERR' : level === 'trade' ? 'TRD' : 'INF';
  console.log(`[${ts} ET] [${prefix}] [PIVOT] ${msg}`);
  tradeLog.push({ ts, level, msg });
  if (tradeLog.length > 5000) tradeLog.splice(0, 2000);
}

function saveLog() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(tradeLog, null, 2));
  } catch (e) { /* ignore */ }
}

let saveInterval = null;
function startPeriodicSave() { saveInterval = setInterval(() => saveLog(), 5 * 60 * 1000); }
function stopPeriodicSave() { if (saveInterval) clearInterval(saveInterval); }

function persistState() {
  try {
    const state = {
      date: getTodayStr(),
      positions: [...activePositions.entries()].map(([sym, pos]) => [sym, { ...pos }]),
      dailyPnl, tradesToday, cooldownUntil,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`State persist error: ${e.message}`, 'error');
  }
}

function restoreState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data.date !== getTodayStr()) return false;
    dailyPnl = data.dailyPnl ?? 0;
    tradesToday = data.tradesToday ?? 0;
    cooldownUntil = data.cooldownUntil ?? 0;
    for (const [sym, pos] of data.positions) {
      if (pos.status === 'pending' || pos.status === 'filled' || pos.status === 'dry_run') {
        activePositions.set(sym, pos);
      }
    }
    log(`Restored ${activePositions.size} position(s), ${tradesToday} trades today`);
    return activePositions.size > 0;
  } catch (e) {
    log(`State restore error: ${e.message}`, 'error');
    return false;
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

// ─── Fetch daily bars and compute pivot levels ───
async function fetchPivotLevels(symbols) {
  const today = getTodayStr();
  const start = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };

  const pivotMap = {};  // symbol -> { P, R1, S1, R2, S2, R3, S3, midR1, midS1 }
  const atrMap = {};    // symbol -> dailyATR
  const priceMap = {};  // symbol -> lastClose
  const BATCH_SIZE = 4;
  const results = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(async (sym) => {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${start}&end=${today}&limit=21&feed=iex`;
      const resp = await retry(() => fetch(url, { headers, signal: AbortSignal.timeout(CONFIG.apiTimeoutMs) }));
      if (!resp.ok) throw new Error(`Alpaca API ${resp.status}`);
      const data = await resp.json();
      const rawBars = data.bars?.[sym] || [];
      const bars = rawBars.map(b => ({ high: b.h, low: b.l, close: b.c }));
      return { sym, bars };
    }));
    results.push(...batchResults);
    if (i + BATCH_SIZE < symbols.length) await sleep(500);
  }

  for (const result of results) {
    if (result.status === 'rejected') continue;
    const { sym, bars } = result.value;
    if (bars.length < 2) continue;

    const prevDay = bars[bars.length - 2]; // yesterday for pivot calc
    const dailyATR = calcATR(bars, 14);
    const lastClose = bars[bars.length - 1].close;

    if (!dailyATR) continue;

    const pivots = createPivots();
    pivots.setDaily({ high: prevDay.high, low: prevDay.low, close: prevDay.close });
    const levels = pivots.value();

    pivotMap[sym] = levels;
    atrMap[sym] = dailyATR;
    priceMap[sym] = lastClose;

    const atrPct = (dailyATR / lastClose * 100).toFixed(1);
    const ok = dailyATR >= CONFIG.minATR && atrPct >= CONFIG.minATRPct && atrPct <= CONFIG.maxATRPct;
    log(`${sym}: ATR=$${dailyATR.toFixed(2)} (${atrPct}%) P=$${levels.P.toFixed(2)} R1=$${levels.R1.toFixed(2)} S1=$${levels.S1.toFixed(2)} Last=$${lastClose.toFixed(2)} ${ok ? '✅' : '⛔'}`);
  }

  return { pivotMap, atrMap, priceMap };
}

// ─── Fetch current 5-min bar ───
async function fetchCurrentBar(symbol) {
  const today = getTodayStr();
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };

  try {
    const start = `${today}T09:30:00-04:00`;
    const end = `${today}T20:00:00-04:00`;
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=5Min&start=${start}&end=${end}&limit=78&feed=iex`;
    const resp = await retry(() => fetch(url, { headers, signal: AbortSignal.timeout(CONFIG.apiTimeoutMs) }));
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    const rawBars = data.bars?.[symbol] || [];
    if (rawBars.length === 0) return null;

    // Return the latest complete bar
    const bar = rawBars[rawBars.length - 1];
    return {
      ts: bar.t,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    };
  } catch (err) {
    log(`${symbol} bar fetch error: ${err.message}`, 'error');
    return null;
  }
}

// ─── Place bracket order ───
async function placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty, pivotLevel) {
  const direction = side === 'long' ? 'buy' : 'sell';
  const rr = side === 'long'
    ? (targetPrice - entryPrice) / (entryPrice - stopPrice)
    : (entryPrice - targetPrice) / (stopPrice - entryPrice);

  if (DRY_RUN) {
    log(`${sym} ${side.toUpperCase()} signal @ $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | R:R=${rr.toFixed(1)} | Level=${pivotLevel} | DRY RUN`, 'trade');
    return { id: `dry-${sym}`, status: 'dry_run', rr };
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

    log(`${sym} ${side.toUpperCase()} order placed: qty=${qty} @ $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | R:R=${rr.toFixed(1)} | Order: ${order.id}`, 'trade');

    // Verify bracket legs
    try {
      const orderDetail = await retry(() => alpaca.getOrder(order.id));
      const legs = orderDetail.legs || [];
      if (legs.length < 2) {
        log(`${sym}: WARNING — bracket has ${legs.length}/2 legs`, 'error');
        await tgError(`${sym} [PIVOT] bracket order only ${legs.length}/2 child orders!`);
      }
    } catch (e) {
      log(`${sym}: Could not verify bracket legs: ${e.message}`, 'error');
    }

    return { ...order, rr };
  } catch (err) {
    log(`${sym} ORDER ERROR: ${err.message}`, 'error');
    await tgError(`${sym} [PIVOT] order failed: ${err.message}`);
    return null;
  }
}

// ─── Cancel all pending orders for a symbol ───
async function cancelPendingOrders(sym) {
  if (DRY_RUN) return;
  try {
    const orders = await retry(() => alpaca.getOrders({ status: 'open', symbols: [sym] }));
    for (const order of orders) {
      await retry(() => alpaca.cancelOrder(order.id));
      log(`${sym}: Cancelled pending order ${order.id}`);
    }
  } catch (e) {
    log(`${sym}: Error cancelling orders: ${e.message}`, 'error');
  }
}

// ─── Close position at market ───
async function closePosition(sym) {
  if (DRY_RUN) {
    log(`${sym}: Closing position (DRY RUN)`, 'trade');
    return true;
  }
  try {
    await retry(() => alpaca.closePosition(sym));
    log(`${sym}: Position closed at market`, 'trade');
    return true;
  } catch (e) {
    log(`${sym}: Error closing position: ${e.message}`, 'error');
    return false;
  }
}

// ─── Morning report ───
async function sendMorningReport(account, pivotMap, atrMap, priceMap) {
  const balance = parseFloat(account.portfolio_value);
  const mode = IS_PAPER ? 'PAPER' : 'LIVE';
  const dateStr = getNYTime().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  let msg = `🔄 <b>PIVOT REVERT BOT</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Account: <b>$${balance.toFixed(2)}</b> (${mode}${DRY_RUN ? ' DRY' : ''})\n`;
  msg += `📅 ${dateStr}\n`;
  msg += `📊 Max trades/day: ${CONFIG.maxTradesPerDay} | Cooldown: ${CONFIG.cooldownBars} bars\n\n`;
  msg += `📈 <b>PIVOT LEVELS</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  for (const sym of PIVOT_UNIVERSE) {
    const pivots = pivotMap[sym];
    const atr = atrMap[sym];
    const price = priceMap[sym];
    if (!pivots || !atr || !price) continue;

    const atrPct = (atr / price * 100).toFixed(1);
    const filtered = parseFloat(atrPct) >= CONFIG.minATRPct && parseFloat(atrPct) <= CONFIG.maxATRPct;
    const icon = filtered ? '✅' : '⛔';

    msg += `${icon} <b>${sym}</b> $${price.toFixed(2)} (${atrPct}% ATR)\n`;
    msg += `   P=$${pivots.P.toFixed(2)} R1=$${pivots.R1.toFixed(2)} S1=$${pivots.S1.toFixed(2)}\n`;
  }

  // Check for T&T bot positions to avoid conflicts
  try {
    const positions = await retry(() => alpaca.getPositions());
    if (positions.length > 0) {
      msg += `\n⚠️ <b>Existing positions:</b>\n`;
      for (const p of positions) {
        msg += `   ${p.side === 'long' ? '🟢' : '🔴'} ${p.symbol} ${parseFloat(p.qty)} @ $${parseFloat(p.avg_entry_price).toFixed(2)} ($${parseFloat(p.unrealized_pl).toFixed(2)} P&L)\n`;
      }
    }
  } catch (e) { /* ignore */ }

  await sendTelegram(msg, { parseMode: 'HTML' });
}

// ─── Check pivot rejection and generate signal ───
function checkPivotSignal(bar, pivots, dailyATR, symbol) {
  const { P, R1, S1 } = pivots;

  // Near S1? Check for bullish rejection
  const nearS1 = Math.abs(bar.close - S1) / dailyATR < 1.5;
  if (nearS1) {
    const rejection = checkPivotRejection({
      bar,
      level: S1,
      side: 'support',
      priorBars: [],  // We don't have prior bars in live mode, use current bar only
    });

    if (rejection.rejected && rejection.direction === 'long') {
      const stop = S1 - dailyATR * CONFIG.stopAtrMult;
      const target = P; // reversion to pivot midpoint
      const risk = bar.close - stop;
      const reward = target - bar.close;
      const rr = risk > 0 ? reward / risk : 0;

      if (rr >= CONFIG.minRR) {
        return { side: 'long', stop, target, entryPrice: bar.close, pivotLevel: `S1=$${S1.toFixed(2)}`, rr };
      }
    }
  }

  // Near R1? Check for bearish rejection
  const nearR1 = Math.abs(bar.close - R1) / dailyATR < 1.5;
  if (nearR1) {
    const rejection = checkPivotRejection({
      bar,
      level: R1,
      side: 'resistance',
      priorBars: [],
    });

    if (rejection.rejected && rejection.direction === 'short') {
      const stop = R1 + dailyATR * CONFIG.stopAtrMult;
      const target = P;
      const risk = stop - bar.close;
      const reward = bar.close - target;
      const rr = risk > 0 ? reward / risk : 0;

      if (rr >= CONFIG.minRR) {
        return { side: 'short', stop, target, entryPrice: bar.close, pivotLevel: `R1=$${R1.toFixed(2)}`, rr };
      }
    }
  }

  return null;
}

// ─── Main trading loop ───
async function monitorPositions() {
  const signals = [];

  for (const [sym, pos] of activePositions) {
    if (pos.status === 'dry_run') {
      // In dry run, simulate the exit based on current price
      const bar = await fetchCurrentBar(sym);
      if (!bar) continue;

      if (pos.side === 'long') {
        if (bar.low <= pos.stopPrice) {
          log(`${sym} DRY RUN: Stop hit at $${pos.stopPrice.toFixed(2)} (low=$${bar.low.toFixed(2)})`, 'trade');
          const pnl = (pos.stopPrice - pos.entryPrice) * pos.qty;
          dailyPnl += pnl;
          activePositions.delete(sym);
          continue;
        }
        if (bar.high >= pos.targetPrice) {
          log(`${sym} DRY RUN: Target hit at $${pos.targetPrice.toFixed(2)} (high=$${bar.high.toFixed(2)})`, 'trade');
          const pnl = (pos.targetPrice - pos.entryPrice) * pos.qty;
          dailyPnl += pnl;
          activePositions.delete(sym);
          continue;
        }
      } else {
        if (bar.high >= pos.stopPrice) {
          log(`${sym} DRY RUN: Stop hit at $${pos.stopPrice.toFixed(2)} (high=$${bar.high.toFixed(2)})`, 'trade');
          const pnl = (pos.entryPrice - pos.stopPrice) * pos.qty;
          dailyPnl += pnl;
          activePositions.delete(sym);
          continue;
        }
        if (bar.low <= pos.targetPrice) {
          log(`${sym} DRY RUN: Target hit at $${pos.targetPrice.toFixed(2)} (low=$${bar.low.toFixed(2)})`, 'trade');
          const pnl = (pos.entryPrice - pos.targetPrice) * pos.qty;
          dailyPnl += pnl;
          activePositions.delete(sym);
          continue;
        }
      }
      continue; // Still in dry-run position, skip
    }

    // Real positions — check if bracket order filled
    try {
      const order = await retry(() => alpaca.getOrder(pos.orderId));
      if (order.status === 'filled') {
        pos.status = 'filled';
        pos.fillPrice = parseFloat(order.filled_avg_price) || pos.entryPrice;
        log(`${sym}: Entry filled @ $${pos.fillPrice.toFixed(2)}`);
        // Bracket will manage SL/TP automatically — just track
      } else if (order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired') {
        log(`${sym}: Order ${order.status}, removing position`, 'trade');
        activePositions.delete(sym);
      }
    } catch (e) {
      // Order might not exist anymore (bracket completed)
      try {
        const positions = await retry(() => alpaca.getPositions());
        const stillOpen = positions.some(p => p.symbol === sym);
        if (!stillOpen) {
          log(`${sym}: Position closed (bracket completed)`, 'trade');
          activePositions.delete(sym);
        }
      } catch (e2) {
        log(`${sym}: Error checking position: ${e2.message}`, 'error');
      }
    }
  }
}

async function main() {
  log('🔄 Pivot Revert Bot starting...');
  log(`Universe: ${PIVOT_UNIVERSE.join(', ')}`);
  log(`Config: maxTrades=${CONFIG.maxTradesPerDay}, minRR=${CONFIG.minRR}, stopMult=${CONFIG.stopAtrMult}, minATRPct=${CONFIG.minATRPct}%`);
  log(`Mode: ${IS_PAPER ? 'PAPER' : 'LIVE'}${DRY_RUN ? ' DRY-RUN' : ''}`);

  // Restore state
  restoreState();

  // Fetch pivot levels for entire universe
  const { pivotMap, atrMap, priceMap } = await fetchPivotLevels(PIVOT_UNIVERSE);

  // Send morning report
  try {
    const account = await retry(() => alpaca.getAccount());
    await sendMorningReport(account, pivotMap, atrMap, priceMap);
  } catch (e) {
    log(`Morning report error: ${e.message}`, 'error');
  }

  // Main loop
  log('Entering main loop...');

  while (!isShuttingDown) {
    const now = getHHMM();
    const todayStr = getTodayStr();

    // Reset daily state if new day
    const stateDate = fs.existsSync(STATE_FILE) ?
      JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).date : null;
    if (stateDate !== todayStr) {
      dailyPnl = 0;
      tradesToday = 0;
      cooldownUntil = 0;
      consecutiveEmptyScans = 0;
      activePositions.clear();
      log('New day — reset state');
    }

    // Hard exit: close everything after hard exit time
    if (now >= CONFIG.hardExit) {
      log(`Hard exit time (${CONFIG.hardExit}) — closing all positions`);
      for (const [sym, pos] of activePositions) {
        if (pos.status === 'filled') {
          await closePosition(sym);
          await cancelPendingOrders(sym);
        }
        activePositions.delete(sym);
      }
      // Wait until next day or shutdown
      persistState();
      await sleep(CONFIG.pollIntervalMs);
      continue;
    }

    // Daily loss limit check
    try {
      const account = await retry(() => alpaca.getAccount());
      const equity = parseFloat(account.portfolio_value);
      if (CONFIG.dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / equity * 100) > CONFIG.dailyLossLimitPct) {
        log(`Daily loss limit hit: $${dailyPnl.toFixed(2)} / ${CONFIG.dailyLossLimitPct}% of equity`);
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }
    } catch (e) { /* continue */ }

    // Check existing positions
    await monitorPositions();

    // Only look for new entries during session
    if (now >= CONFIG.sessionStart && now < CONFIG.sessionEnd) {
      // Cooldown check
      if (cooldownUntil > 0 && now < cooldownUntil) {
        log(`Cooldown until ${cooldownUntil} — waiting`);
      } else if (tradesToday < CONFIG.maxTradesPerDay && activePositions.size === 0) {
        // No active positions and under trade limit — scan for signals
        let scannedCount = 0;
        for (const sym of PIVOT_UNIVERSE) {
          if (activePositions.has(sym)) continue;

          const pivots = pivotMap[sym];
          const dailyATR = atrMap[sym];
          const lastPrice = priceMap[sym];

          if (!pivots || !dailyATR || !lastPrice) continue;
          if (dailyATR < CONFIG.minATR) continue;

          const atrPct = dailyATR / lastPrice * 100;
          if (atrPct < CONFIG.minATRPct || atrPct > CONFIG.maxATRPct) continue;

          // Check if we already have a real position in this symbol (from T&T bot or manual)
          try {
            const existingPos = await retry(() => alpaca.getPosition(sym));
            if (existingPos) {
              log(`${sym}: Already have ${existingPos.side} position (${existingPos.qty} shares) — skipping`);
              continue;
            }
          } catch (e) {
            // No position — good to proceed
          }

          // Fetch latest bar
          const bar = await fetchCurrentBar(sym);
          if (!bar) continue;

          scannedCount++;

          // Check for pivot rejection signal
          const signal = checkPivotSignal(bar, pivots, dailyATR, sym);
          if (!signal) {
            const nearS1 = Math.abs(bar.close - pivots.S1) / dailyATR < 1.5;
            const nearR1 = Math.abs(bar.close - pivots.R1) / dailyATR < 1.5;
            if (nearS1 || nearR1) {
              log(`${sym}: Near ${nearS1 ? 'S1' : 'R1'} but no rejection — close=$${bar.close.toFixed(2)} low=$${bar.low.toFixed(2)} high=$${bar.high.toFixed(2)} | S1=$${pivots.S1.toFixed(2)} R1=$${pivots.R1.toFixed(2)}`);
            }
            continue;
          }

          log(`${sym}: PIVOT SIGNAL — ${signal.side.toUpperCase()} @ $${signal.entryPrice.toFixed(2)} | ${signal.pivotLevel} → P $${signal.target.toFixed(2)} | R:R=${signal.rr.toFixed(1)}`, 'trade');

          // Calculate position size
          try {
            const account = await retry(() => alpaca.getAccount());
            const equity = parseFloat(account.portfolio_value);
            const positionValue = Math.max(equity * CONFIG.positionPct / 100, CONFIG.minPositionUSD);
            const qty = Math.max(1, Math.floor(positionValue / signal.entryPrice));

            // Place order
            const order = await placeBracketOrder(sym, signal.side, signal.entryPrice, signal.stop, signal.target, qty, signal.pivotLevel);
            if (order) {
              activePositions.set(sym, {
                orderId: order.id,
                side: signal.side,
                entryPrice: signal.entryPrice,
                stopPrice: signal.stop,
                targetPrice: signal.target,
                pivotLevel: signal.pivotLevel,
                qty,
                status: order.status === 'dry_run' ? 'dry_run' : 'pending',
                fillPrice: null,
              });

              tradesToday++;

              // Set cooldown: cooldownBars * 5 minutes (each bar is 5 min, convert to HHMM)
              const cooldownMinutes = CONFIG.cooldownBars * 5;
              const currentHour = Math.floor(now / 100);
              const currentMin = now % 100;
              const totalMin = currentHour * 60 + currentMin + cooldownMinutes;
              cooldownUntil = Math.floor(totalMin / 60) * 100 + (totalMin % 60);

              persistState();

              // Send trade notification
              const tradeMsg = `🔄 <b>PIVOT TRADE</b>\n` +
                `${signal.side === 'long' ? '🟢' : '🔴'} ${sym} ${signal.side.toUpperCase()}\n` +
                `Entry: $${signal.entryPrice.toFixed(2)}\n` +
                `SL: $${signal.stop.toFixed(2)} | TP: $${signal.target.toFixed(2)}\n` +
                `Level: ${signal.pivotLevel} → P\n` +
                `R:R = ${signal.rr.toFixed(1)} | Trade #${tradesToday}/${CONFIG.maxTradesPerDay}`;
              await sendTelegram(tradeMsg, { parseMode: 'HTML' });

              consecutiveEmptyScans = 0; // reset throttle on successful entry
              break; // One trade at a time per cycle
            }
          } catch (e) {
            log(`${sym}: Error placing order: ${e.message}`, 'error');
          }
        }
        log(`Scan complete: ${scannedCount} stocks checked, no signals`);
        consecutiveEmptyScans++;
      }
    }

    // Session end: stop looking for new entries
    if (now >= CONFIG.sessionEnd && now < CONFIG.hardExit) {
      log(`Session ended (${CONFIG.sessionEnd}) — monitoring existing positions only`);
    }

    persistState();
    const effectiveInterval = consecutiveEmptyScans >= CONFIG.throttleAfterEmpty
      ? CONFIG.throttleIntervalMs
      : CONFIG.pollIntervalMs;
    if (consecutiveEmptyScans === CONFIG.throttleAfterEmpty) {
      log(`Throttling: ${consecutiveEmptyScans} empty scans, slowing to ${CONFIG.throttleIntervalMs / 1000}s interval`);
    }
    await sleep(effectiveInterval);
  }

  // Graceful shutdown
  log('Shutting down...');
  if (!DRY_RUN) {
    for (const [sym, pos] of activePositions) {
      if (pos.status === 'filled') {
        await closePosition(sym);
        await cancelPendingOrders(sym);
      }
    }
  }
  persistState();
  saveLog();
  await tgShutdown('Pivot Revert Bot shutting down');
}

// ─── Signal handlers ───
process.on('SIGINT', () => {
  log('SIGINT received, initiating graceful shutdown...');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  log('SIGTERM received, initiating graceful shutdown...');
  isShuttingDown = true;
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`, 'error');
  tgError(`Pivot Revert Bot crashed: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`, 'error');
});

// ─── Start ───
startPeriodicSave();
main().catch(e => {
  log(`Fatal error: ${e.message}`, 'error');
  tgError(`Pivot Revert Bot fatal error: ${e.message}`);
  stopPeriodicSave();
  process.exit(1);
});