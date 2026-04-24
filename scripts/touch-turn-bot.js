#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import Alpaca from '@alpacahq/alpaca-trade-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  sendTelegram, tgTradeSignalsBatch, tgError, tgShutdown,
  telegramEnabled, tgOrphanedPositions,
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
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT) || 3,
  riskPct: parseFloat(process.env.RISK_PCT) || 0,
  maxEquityPct: parseFloat(process.env.MAX_EQUITY_PCT) || 30,
  unfilledTimeoutMin: parseInt(process.env.UNFILLED_TIMEOUT_MIN, 10) || 15,
  apiTimeoutMs: parseInt(process.env.API_TIMEOUT_MS, 10) || 30000,
  maxSlippageBps: parseFloat(process.env.MAX_SLIPPAGE_BPS) || 75,      // reject fills with worse slippage
  cooldownStoppedOutMin: parseInt(process.env.COOLDOWN_STOPPED_MIN, 10) || 60,   // cooldown after stop-out
  cooldownUnfilledMin: parseInt(process.env.COOLDOWN_UNFILLED_MIN, 10) || 30,    // cooldown after unfilled timeout
  cooldownSlippageMin: parseInt(process.env.COOLDOWN_SLIPPAGE_MIN, 10) || 240,   // cooldown after bad fill (rest of session)
  staleLimitReplaceMin: parseInt(process.env.STALE_LIMIT_REPLACE_MIN, 10) || 3,  // seconds to wait before replacing stale limit
  rollingWindowBars: parseInt(process.env.ROLLING_WINDOW_BARS, 10) || 3,         // bars for rolling range in re-scan
};

// Multi-position tracking: symbol -> { orderId, side, entryPrice, stopPrice, targetPrice, qty, status, fillPrice, pnl }
const activePositions = new Map();
let isShuttingDown = false;
let dailyPnl = 0;

// ─── Symbol cooldown tracking ───
// Map<symbol, { reason: 'stopped_out'|'unfilled'|'slippage', until: Date }>
const symbolCooldowns = new Map();

// ─── Snapshot debounce cache ───
let lastSnapshotData = null;
let lastSnapshotWrite = 0;
const SNAPSHOT_DEBOUNCE_MS = 10000;

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
const STATE_FILE = path.join(__dirname, 'bot-state.json');
const ORPHANED_FILE = path.join(__dirname, 'orphaned-positions.json');
const WATCHLIST_FILE = process.env.WATCHLIST_PATH || path.join(__dirname, 'watchlist.json');

// ─── Cooldown helper ───
function isOnCooldown(sym) {
  const cd = symbolCooldowns.get(sym);
  if (!cd) return false;
  if (Date.now() >= cd.until.getTime()) {
    symbolCooldowns.delete(sym);
    return false;
  }
  return true;
}

function setCooldown(sym, reason) {
  const minutes = reason === 'stopped_out' ? CONFIG.cooldownStoppedOutMin
    : reason === 'unfilled' ? CONFIG.cooldownUnfilledMin
    : CONFIG.cooldownSlippageMin;
  const until = new Date(Date.now() + minutes * 60000);
  symbolCooldowns.set(sym, { reason, until });
  log(`${sym}: ⏳ Cooldown (${reason}) until ${until.toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}`, 'trade');
}

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

function persistState() {
  try {
    const state = {
      date: getTodayStr(),
      positions: [...activePositions.entries()].map(([sym, pos]) => [sym, { ...pos }]),
      dailyPnl: dailyPnl,
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
    for (const [sym, pos] of data.positions) {
      // Only recover positions that are still active (pending, filled, or dry_run)
      if (pos.status === 'pending' || pos.status === 'filled' || pos.status === 'dry_run') {
        activePositions.set(sym, pos);
      }
    }
    log(`Restored ${activePositions.size} active position(s) from state file`);
    return activePositions.size > 0;
  } catch (e) {
    log(`State restore error: ${e.message}`, 'error');
    return false;
  }
}

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

async function writeSnapshot(extra = {}) {
  try {
    const now = Date.now();
    // If we have recent snapshot data (< 10s old) and no extra data forcing a refresh,
    // just update the timestamp and extra data without new API calls
    if (lastSnapshotData && (now - lastSnapshotWrite < SNAPSHOT_DEBOUNCE_MS) && Object.keys(extra).length === 0) {
      const snap = { ...lastSnapshotData, ts: now, ...extra };
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
      return;
    }
    const acct = await retry(() => alpaca.getAccount());
    const positions = await retry(() => alpaca.getPositions());
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
    if (i + BATCH_SIZE < symbols.length) await sleep(500);
  }

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      log(`${symbols[i]} ATR fetch error: ${results[i].reason?.message}`, 'error');
      atrMap[symbols[i]] = atrMap[symbols[i]] ?? null;
    }
  }
  return { atrMap, priceMap };
}

// ─── Fetch opening range or rolling recent range ───
// mode='opening': first 3 bars of day (9:30-9:45) — for initial entry
// mode='rolling': last N bars before now — for re-scan entries
async function fetchOpeningRange(symbol, mode = 'opening') {
  const today = getTodayStr();
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };

  try {
    let start, end, numBars;
    if (mode === 'rolling') {
      // Fetch last 6 bars (30 min lookback), use last CONFIG.rollingWindowBars
      const now = new Date();
      const lookbackMin = 35; // fetch 35 min of bars to ensure we get enough
      const startDate = new Date(now.getTime() - lookbackMin * 60000);
      start = startDate.toISOString();
      end = now.toISOString();
      numBars = 6; // fetch extra to ensure we have enough after market-open filter
    } else {
      // Original: first 3 five-min bars (9:30-9:45)
      start = `${today}T09:30:00-04:00`;
      end = `${today}T09:50:00-04:00`;
      numBars = 5;
    }

    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=5Min&start=${start}&end=${end}&limit=${numBars}&feed=iex`;
    const resp = await retry(() => fetch(url, { headers, signal: AbortSignal.timeout(CONFIG.apiTimeoutMs) }));
    if (!resp.ok) throw new Error(`Alpaca API ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
    const data = await resp.json();
    const rawBars = data.bars?.[symbol] || [];

    const windowSize = mode === 'rolling' ? CONFIG.rollingWindowBars : 3;

    if (rawBars.length < windowSize) {
      log(`${symbol}: Only ${rawBars.length} bars, need ${windowSize} for ${mode} range`);
      return null;
    }

    // Use the last windowSize bars for rolling, first 3 for opening
    const bars = mode === 'rolling'
      ? rawBars.slice(-windowSize)
      : rawBars.slice(0, windowSize);

    const high = Math.max(...bars.map(b => b.h));
    const low = Math.min(...bars.map(b => b.l));
    const open = bars[0].o;
    const close = bars[bars.length - 1].c;
    const range = high - low;

    return { high, low, open, close, range, isRed: close < open, isGreen: close > open };
  } catch (err) {
    log(`${symbol} ${mode} range fetch error: ${err.message}`, 'error');
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
async function scanCandidates(atrMap, priceMap, rangeMode = 'opening') {
  const candidates = [];

  const filteredSymbols = UNIVERSE.filter(sym => {
    const dailyATR = atrMap[sym];
    if (!dailyATR || dailyATR < CONFIG.minATR) {
      log(`${sym}: Skipped — ATR $${dailyATR?.toFixed(2) ?? 'N/A'} < $${CONFIG.minATR}`);
      return false;
    }
    if (isOnCooldown(sym)) {
      const cd = symbolCooldowns.get(sym);
      log(`${sym}: Skipped — cooldown (${cd.reason}) until ${cd.until.toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}`);
      return false;
    }
    return true;
  });

  const rangeResults = await Promise.allSettled(
    filteredSymbols.map(async (sym) => ({ sym, range: await fetchOpeningRange(sym, rangeMode) }))
  );

  for (const result of rangeResults) {
    if (result.status === 'rejected') continue;
    const { sym, range } = result.value;
    if (!range) continue;

    const dailyATR = atrMap[sym];
    const lastPrice = priceMap[sym];

    if (range.range < dailyATR * CONFIG.atrPctThreshold) {
      log(`${sym}: Skipped — range $${range.range.toFixed(2)} < ${CONFIG.atrPctThreshold * 100}% of ATR $${dailyATR.toFixed(2)}`);
      continue;
    }

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
  const rr = side === 'long'
    ? (targetPrice - entryPrice) / (entryPrice - stopPrice)
    : (entryPrice - targetPrice) / (stopPrice - entryPrice);

  if (DRY_RUN) {
    log(`${sym} ${side.toUpperCase()} signal: qty=${qty} @ $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | R:R=${rr.toFixed(1)} | DRY RUN`, 'trade');
    return { id: 'dry-run', status: 'dry_run', rr };
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

    log(`${sym} ${side.toUpperCase()} order placed: qty=${qty} @ limit $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | Order: ${order.id}`, 'trade');

    // Verify bracket child orders exist
    try {
      const orderDetail = await retry(() => alpaca.getOrder(order.id));
      const legs = orderDetail.legs || [];
      if (legs.length < 2) {
        log(`${sym}: WARNING — bracket order has ${legs.length} leg(s), expected 2 (SL+TP)`, 'error');
        await tgError(`${sym} bracket order placed but only ${legs.length}/2 child orders created — position may have no stop!`);
      } else {
        log(`${sym}: Bracket verified — ${legs.length} child orders`);
      }
    } catch (e) {
      log(`${sym}: Could not verify bracket legs: ${e.message}`, 'error');
    }

    return { ...order, rr };
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
    msg += `🤷 No trade today (all candidates filtered by equity cap, min position size, or no scan matches)`;
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
  const closeOps = [];
  for (const [sym, pos] of activePositions) {
    if (pos.status === 'closed') continue;

    if (pos.status === 'pending' && pos.orderId && pos.orderId !== 'dry-run' && !DRY_RUN) {
      closeOps.push((async () => {
        try {
          await retry(() => alpaca.cancelOrder(pos.orderId));
          log(`${sym}: Cancelled pending order at hard exit`, 'trade');
          pos.status = 'closed';
        } catch (e) {
          log(`${sym}: Cancel failed: ${e.message}`, 'error');
          // Don't mark closed on failure
        }
      })());
      continue;
    }

    if (pos.status === 'filled' && !DRY_RUN) {
      closeOps.push((async () => {
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
            pos.status = 'closed';
          } else {
            pos.status = 'closed';
          }
        } catch (e) {
          log(`${sym}: Close failed: ${e.message}`, 'error');
          await tgError(`${sym} close failed at hard exit: ${e.message}`);
          // Don't mark closed on failure — position may still be open on Alpaca
        }
      })());
      continue;
    }

    if (pos.status === 'dry_run') {
      log(`${sym}: DRY RUN — would close position at hard exit`, 'trade');
      pos.status = 'closed';
    }
  }

  await Promise.allSettled(closeOps);
}

// ─── Main bot ───
async function runBot() {
  log('═'.repeat(60));
  log(`Touch & Turn Bot — ${IS_PAPER ? 'PAPER' : 'LIVE'} — DRY_RUN=${DRY_RUN}`);
  log(`Universe: ${UNIVERSE.join(', ')}`);
  log(`Window: 9:45–${CONFIG.sessionEnd} ET | Hard exit: ${CONFIG.hardExit} ET`);
  log(`Daily loss limit: ${CONFIG.dailyLossLimitPct}% | Max equity at risk: ${CONFIG.maxEquityPct}%`);
  if (CONFIG.riskPct > 0) log(`Risk-based sizing: ${CONFIG.riskPct}% equity risk per trade`);
  log(`Slippage guard: ${CONFIG.maxSlippageBps} bps | Cooldown: stopped=${CONFIG.cooldownStoppedOutMin}min, unfilled=${CONFIG.cooldownUnfilledMin}min, slippage=${CONFIG.cooldownSlippageMin}min`);
  log(`Unfilled timeout: ${CONFIG.unfilledTimeoutMin} min (replace with market) | API timeout: ${CONFIG.apiTimeoutMs} ms`);
  log(`Telegram: ${telegramEnabled() ? 'ON' : 'OFF'}`);
  log('═'.repeat(60));

  // Validate required env vars
  const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    log(`FATAL: Missing required env vars: ${missing.join(', ')}`, 'error');
    process.exit(1);
  }

  // Try to restore state from crash recovery
  const restored = restoreState();
  startPeriodicSave();

  // Clean up any stale orphaned positions file from previous run
  try { fs.unlinkSync(ORPHANED_FILE); } catch {}

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

  // Write initial snapshot (reuse account we just fetched)
  await writeSnapshot();

  // Fetch daily ATRs for universe (always — needed for morning report even on crash recovery)
  let atrMap = {}, priceMap = {};
  log('Fetching daily ATRs...');
  ({ atrMap, priceMap } = await fetchDailyATRs(UNIVERSE));

  // Send morning report
  await sendMorningReport(account, atrMap, priceMap);

  // Wait for 9:45 (opening range complete) — also check for shutdown signal
  let hhmm = getHHMM();
  if (hhmm < 945 && !restored) {
    log(`Waiting for 9:45 ET (current: ${hhmm})...`);
    while (getHHMM() < 945 && !isShuttingDown) {
      await sleep(10000);
    }
    if (isShuttingDown) { saveLog(); return; }
    log('9:45 ET reached — scanning universe');
  }

  // Check if within trading window
  hhmm = getHHMM();
  if (hhmm >= CONFIG.sessionEnd && !restored) {
    log('Past trading window — exiting');
    await sendEODReport([]);
    saveLog();
    return;
  }

  // Scan for candidates (prefer watchlist from pre-market scanner)
  let candidates = [];
  if (!restored) {
    const watchlist = readWatchlist();
    if (watchlist) {
      log(`Using watchlist from pre-market scan (${watchlist.candidates.length} candidates)`);
      const rangeResults = await Promise.allSettled(
        watchlist.candidates.map(async (c) => ({ sym: c.symbol, range: await fetchOpeningRange(c.symbol), c }))
      );
      for (const r of rangeResults) {
        if (r.status === 'rejected' || !r.value.range) {
          const sym = r.status === 'rejected' ? 'unknown' : r.value.sym;
          log(`Watchlist symbol ${sym} opening range unavailable`);
          continue;
        }
        const { sym, range, c } = r.value;
        candidates.push({
          sym, range, dailyATR: c.dailyATR,
          rangeATRRatio: range.range / c.dailyATR, lastPrice: c.entryPrice,
          side: c.side,
        });
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
  }

  // Place bracket orders for all candidates (skip if restored from crash)
  const balance = parseFloat(account.portfolio_value);
  let equityAtRiskPct = 0;
  const placedTrades = [];

  if (!restored) {
    log(`Placing orders for ${candidates.length} candidate(s): ${candidates.map(c => c.sym).join(', ')}`);

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

      // Max equity risk cap: skip if total equity at risk would exceed limit
      const thisTradeRiskPct = (CONFIG.positionPct / 100);
      if ((equityAtRiskPct + thisTradeRiskPct) * 100 > CONFIG.maxEquityPct) {
        log(`${sym}: Skipped — max equity at risk ${CONFIG.maxEquityPct}% reached (${(equityAtRiskPct * 100).toFixed(0)}% already used)`);
        continue;
      }

      // Position sizing: risk-based if RISK_PCT is set, otherwise percentage of equity
      let qty;
      const stopDistance = Math.abs(entryPrice - stopPrice);
      if (CONFIG.riskPct > 0 && stopDistance > 0) {
        const riskDollars = balance * (CONFIG.riskPct / 100);
        qty = Math.max(1, Math.floor(riskDollars / stopDistance));
        log(`${sym}: Risk-based sizing: risk $${riskDollars.toFixed(2)} / stop $${stopDistance.toFixed(2)} = ${qty} shares`);
      } else {
        const positionValue = Math.max(balance * (CONFIG.positionPct / 100), CONFIG.minPositionUSD);
        qty = Math.max(1, Math.floor(positionValue / entryPrice));
      }

      // Enforce min position USD
      if (qty * entryPrice < CONFIG.minPositionUSD) {
        log(`${sym}: Skipped — position $${(qty * entryPrice).toFixed(2)} < min $${CONFIG.minPositionUSD}`);
        continue;
      }

      log(`${sym} ${side.toUpperCase()}: Entry=$${entryPrice.toFixed(2)} | Target=$${targetPrice.toFixed(2)} | Stop=$${stopPrice.toFixed(2)} | Qty=${qty}`);

      const order = await placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty);

      if (order) {
        activePositions.set(sym, {
          orderId: order.id, side, entryPrice, stopPrice, targetPrice, qty,
          status: DRY_RUN ? 'dry_run' : 'pending',
          fillPrice: null, pnl: null, placedAt: Date.now(),
        });
        equityAtRiskPct += thisTradeRiskPct;
        placedTrades.push({ sym, side, price: entryPrice, stop: stopPrice, target: targetPrice, rr: order.rr, qty });
        persistState();
      }
    }
  }

  if (placedTrades.length > 0) {
    await tgTradeSignalsBatch(placedTrades, { dryRun: DRY_RUN });
  }

  if (activePositions.size === 0) {
    log('No orders placed — all candidates filtered by equity cap, min position size, or no scan matches');
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
      if (isShuttingDown) break;
      if (pos.status === 'closed') continue;
      anyActive = true;

      if (pos.status === 'pending') {
        // Unfilled order timeout: cancel + replace with market order if still within session
        const ageMin = (Date.now() - (pos.placedAt || 0)) / 60000;
        if (!DRY_RUN && pos.orderId && pos.orderId !== 'dry-run' && ageMin >= CONFIG.unfilledTimeoutMin) {
          try {
            await retry(() => alpaca.cancelOrder(pos.orderId));
            log(`${sym}: Cancelled unfilled order (timeout ${ageMin.toFixed(0)} min)`, 'trade');
            setCooldown(sym, 'unfilled');
            // Replace with market order if we're still within session time
            if (currentTime < CONFIG.sessionEnd) {
              log(`${sym}: Replacing stale limit with market order...`);
              try {
                const marketOrder = await retry(() => alpaca.createOrder({
                  symbol: sym,
                  qty: pos.qty,
                  side: pos.side,
                  type: 'market',
                  time_in_force: 'day',
                }));
                pos.orderId = marketOrder.id;
                pos.entryPrice = pos.side === 'long' ? pos.entryPrice : pos.entryPrice; // will update on fill
                pos.status = 'pending';
                pos.placedAt = Date.now();
                pos.replacedWithMarket = true;
                log(`${sym}: Market order placed (order ${marketOrder.id})`, 'trade');
                await sendTelegram(
                  `⚡ ${sym}: Replaced stale limit → market order\n` +
                  `Side: ${pos.side} | Qty: ${pos.qty}\n` +
                  `Stop: $${pos.stopPrice} | Target: $${pos.targetPrice}`,
                  { parseMode: 'HTML' }
                );
              } catch (mErr) {
                log(`${sym}: Market order replace failed: ${mErr.message}`, 'error');
                pos.status = 'closed';
              }
            } else {
              pos.status = 'closed';
            }
            persistState();
            continue;
          } catch (e) {
            log(`${sym}: Unfilled timeout cancel failed: ${e.message}`, 'error');
          }
        }

        // Cancel unfilled orders past session end
        if (currentTime >= CONFIG.sessionEnd) {
          if (!DRY_RUN && pos.orderId && pos.orderId !== 'dry-run') {
            try { await retry(() => alpaca.cancelOrder(pos.orderId)); } catch {}
          }
          pos.status = 'closed';
          log(`${sym}: Cancelled unfilled order (session end)`, 'trade');
          persistState();
          continue;
        }

        // Check order status
        try {
          const order = await retry(() => alpaca.getOrder(pos.orderId));
          log(`${sym}: Order status: ${order.status}`);
          if (order.status === 'filled') {
            pos.status = 'filled';
            pos.fillPrice = parseFloat(order.filled_avg_price);
            // Partial fill detection
            const filledQty = parseFloat(order.filled_qty);
            if (filledQty && filledQty < pos.qty) {
              log(`${sym}: PARTIAL FILL — ${filledQty}/${pos.qty} shares at $${pos.fillPrice.toFixed(2)}`, 'error');
              await tgError(`${sym} partial fill: ${filledQty}/${pos.qty} shares`);
              pos.qty = filledQty;
            }
            // Slippage tracking
            const slippage = pos.fillPrice - pos.entryPrice;
            const slippageBps = Math.abs((slippage / pos.entryPrice) * 10000);
            const adverseSlippage = (pos.side === 'short' ? slippage > 0 : slippage < 0);
            log(`${sym}: FILLED at $${pos.fillPrice.toFixed(2)} (slippage: ${slippage >= 0 ? '+' : ''}$${slippage.toFixed(4)} / ${slippageBps.toFixed(1)} bps${adverseSlippage ? ' ⚠️ ADVERSE' : ''})`, 'trade');

            // ── Slippage guard: reject fills with excessive adverse slippage ──
            if (adverseSlippage && slippageBps > CONFIG.maxSlippageBps) {
              log(`${sym}: 🚫 SLIPPAGE GUARD triggered — ${slippageBps.toFixed(0)} bps exceeds ${CONFIG.maxSlippageBps} bps limit. Liquidating position.`, 'error');
              await tgError(`${sym} slippage guard: ${slippageBps.toFixed(0)} bps adverse fill — liquidating immediately`);
              try {
                // Cancel bracket legs (stop + target), then market close
                const orderDetail = await retry(() => alpaca.getOrder(pos.orderId));
                const legs = orderDetail.legs || [];
                for (const legId of legs) {
                  try { await retry(() => alpaca.cancelOrder(legId)); } catch {}
                }
                const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                await retry(() => alpaca.closePosition(sym));
                log(`${sym}: Slippage guard — position liquidated via market close`, 'trade');
              } catch (closeErr) {
                log(`${sym}: Slippage guard liquidation failed: ${closeErr.message} — will rely on hard exit`, 'error');
              }
              pos.status = 'closed';
              pos.pnl = 0; // will be updated when we reconcile
              setCooldown(sym, 'slippage');
              persistState();
              continue;
            }

            await writeSnapshot();
            persistState();
          } else if (['canceled', 'rejected', 'expired'].includes(order.status)) {
            pos.status = 'closed';
            log(`${sym}: Order ${order.status}`, 'trade');
            persistState();
          }
        } catch (err) {
          log(`${sym}: Error checking order: ${err.message}`, 'error');
        }
      } else if (pos.status === 'filled') {
        // Check if position closed by bracket (stop/target)
        try {
          const alpacaPos = await retry(() => alpaca.getPosition(sym)).catch(() => null);
          if (!alpacaPos || parseFloat(alpacaPos.qty) === 0) {
            // Position closed by bracket — capture final P&L
            // Try to get realized P&L from Alpaca order history
            let realizedPnl = pos.pnl; // keep last known unrealized if available
            try {
              const orders = await retry(() => alpaca.getOrders({
                status: 'closed',
                limit: 20,
                symbols: sym,
                direction: 'desc',
              }));
              const exitSide = pos.side === 'long' ? 'sell' : 'buy';
              for (const o of orders) {
                if (o.side === exitSide && o.filled_avg_price && parseFloat(o.filled_qty) > 0) {
                  // Prefer matching by parent_order_id (bracket legs relationship)
                  if (o.parent_order_id && o.parent_order_id === pos.orderId) {
                    const exitPrice = parseFloat(o.filled_avg_price);
                    const filledQty = parseFloat(o.filled_qty) || pos.qty;
                    realizedPnl = (exitPrice - (pos.fillPrice ?? pos.entryPrice)) * filledQty * (pos.side === 'short' ? -1 : 1);
                    break;
                  } else if (!o.parent_order_id) {
                    // Fallback: if no parent_order_id field, use first matching exit
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
            pos.pnl = realizedPnl ?? 0;
            dailyPnl += pos.pnl;
            pos.status = 'closed';
            log(`${sym}: Position closed (by stop/target) — P&L: $${pos.pnl.toFixed(2)}`, 'trade');
            // Cooldown after stop-out (losing trade)
            if (pos.pnl < 0) {
              setCooldown(sym, 'stopped_out');
            }
            persistState();

            // Daily loss limit check
            const dailyLossPct = (dailyPnl / balance) * -100;
            if (dailyPnl < 0 && dailyLossPct > CONFIG.dailyLossLimitPct) {
              log(`DAILY LOSS LIMIT HIT: -$${Math.abs(dailyPnl).toFixed(2)} (${dailyLossPct.toFixed(1)}%) exceeds ${CONFIG.dailyLossLimitPct}% — stopping`, 'error');
              await tgError(`Daily loss limit hit: -$${Math.abs(dailyPnl).toFixed(2)} (${dailyLossPct.toFixed(1)}%) — stopping all trading`);
              // Close all remaining positions
              await closeAllPositions();
              break;
            }
          } else {
            pos.pnl = parseFloat(alpacaPos.unrealized_pl);
          }
        } catch (err) {
          log(`${sym}: Position check error: ${err.message}`, 'error');
        }
      }
      // dry_run positions stay in dry_run status until hard exit
    }

    if (isShuttingDown) break;

    if (!anyActive && currentTime < CONFIG.sessionEnd) {
      // All orders cancelled/closed — re-scan for new candidates using rolling range
      log('All positions closed — re-scanning for new candidates (rolling range)...');
      try {
        const { atrMap: freshATR, priceMap: freshPrices } = await fetchDailyATRs(UNIVERSE);
        const freshCandidates = await scanCandidates(freshATR, freshPrices, 'rolling');
        if (freshCandidates && freshCandidates.length > 0) {
          log(`Re-scan found ${freshCandidates.length} candidate(s): ${freshCandidates.map(c => c.sym).join(', ')}`);
          const acct = await retry(() => alpaca.getAccount());
          const bal = parseFloat(acct.portfolio_value);
          let eqRisk = 0;
          const trades = [];
          for (const c of freshCandidates) {
            const { sym, range, dailyATR } = c;
            const side = range.isRed ? 'long' : 'short';
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
            const thisRiskPct = CONFIG.positionPct / 100;
            if ((eqRisk + thisRiskPct) * 100 > CONFIG.maxEquityPct) continue;
            let qty;
            if (CONFIG.riskPct > 0) {
              const riskDollars = bal * (CONFIG.riskPct / 100);
              qty = Math.max(1, Math.floor(riskDollars / Math.abs(entryPrice - stopPrice)));
            } else {
              const posVal = Math.max(bal * CONFIG.positionPct / 100, CONFIG.minPositionUSD);
              qty = Math.max(1, Math.floor(posVal / entryPrice));
            }
            if (qty * entryPrice < CONFIG.minPositionUSD) continue;
            const order = await placeBracketOrder(sym, side, entryPrice, stopPrice, targetPrice, qty);
            if (order) {
              activePositions.set(sym, {
                orderId: order.id, side, entryPrice, stopPrice, targetPrice, qty,
                status: DRY_RUN ? 'dry_run' : 'pending',
                fillPrice: null, pnl: null, placedAt: Date.now(),
              });
              eqRisk += thisRiskPct;
              trades.push({ sym, side, price: entryPrice, stop: stopPrice, target: targetPrice, rr: order.rr, qty });
              persistState();
            }
          }
          if (trades.length > 0) {
            await tgTradeSignalsBatch(trades, { dryRun: DRY_RUN });
          }
          continue; // go back to monitoring
        }
      } catch (e) {
        log(`Re-scan error: ${e.message}`, 'error');
      }
      log('Re-scan found no candidates — will monitor until hard exit');
    }

    if (!anyActive && currentTime >= CONFIG.sessionEnd) {
      log('All positions closed after session end — waiting for hard exit');
    }

    // Log portfolio state each cycle
    try {
      const acct = await retry(() => alpaca.getAccount()).catch(() => null);
      if (acct) {
        lastSnapshotWrite = 0; // Force snapshot refresh on next writeSnapshot call
        const equity = parseFloat(acct.portfolio_value);
        const totalUnrealized = [...activePositions.values()]
          .filter(p => p.status === 'filled' && p.pnl != null)
          .reduce((sum, p) => sum + p.pnl, 0);
        log(`Portfolio: equity $${equity.toFixed(2)} | unrealized P&L $${totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)} | daily realized $${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}`);
      }
    } catch {}

    await sleep(CONFIG.pollIntervalMs);
  }

  // Hard exit: cancel pending orders, close filled positions
  await closeAllPositions();

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

  // Build trade results for EOD report
  const tradeResults = [...activePositions.entries()].map(([sym, pos]) => ({
    symbol: sym,
    side: pos.side,
    entryPrice: pos.fillPrice ?? pos.entryPrice,
    pnl: pos.pnl ?? 0,
  }));

  await sendEODReport(tradeResults);
  await writeSnapshot();
  saveLog();

  // Clean up state file
  try { fs.unlinkSync(STATE_FILE); } catch {}
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

  // Save logs first (always, even if close fails)
  saveLog();

  try {
    await closeAllPositions();

    // Check for orphaned positions (in Alpaca but not tracked by bot)
    try {
      const allAlpacaPositions = await retry(() => alpaca.getPositions());
      const trackedSymbols = new Set([...activePositions.keys()]);
      const orphaned = allAlpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
      if (orphaned.length > 0) {
        log(`WARNING: ${orphaned.length} orphaned position(s) in Alpaca: ${orphaned.map(p => p.symbol).join(', ')}`, 'error');
        saveOrphanedPositions(orphaned);
        await tgOrphanedPositions(orphaned);
      }
    } catch (e) {
      log(`Orphaned position check error during shutdown: ${e.message}`, 'error');
    }
  } catch (e) {
    log(`closeAllPositions error during shutdown: ${e.message}`, 'error');
  }

  stopPeriodicSave();
  persistState();
  await tgShutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));