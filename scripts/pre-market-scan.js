#!/usr/bin/env node
// Pre-market scanner: runs before the bot starts to select today's best candidates.
// Outputs top N symbols to scripts/watchlist.json for the bot to read.
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { filterCandidate, rankCandidates, DEFAULT_FILTERS } from './lib/scanner.js';
import { sendTelegram, telegramEnabled } from './telegram.js';
import { retry } from './lib/retry.js';
import { getNYTime, getTodayStr } from './lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNIVERSE = (process.env.UNIVERSE || 'SOFI,INTC,Z,DAL,RIVN,SBUX,CCL,DIS,F,GM,PLTR,SNAP')
  .split(',').map(s => s.trim()).filter(Boolean);
const TOP_N = parseInt(process.env.SCANNER_TOP_N, 10) || 5;
const WATCHLIST_PATH = process.env.WATCHLIST_PATH || path.join(__dirname, 'watchlist.json');

// ─── Alpaca API helpers ───

const headers = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// ─── Fetch daily ATR for universe ───

async function fetchDailyData(symbols) {
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 45 * 86400000).toISOString().split('T')[0];
  const results = {};

  const BATCH_SIZE = 4;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const outcomes = await Promise.allSettled(batch.map(async (sym) => {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${start}&end=${end}&limit=25&feed=iex`;
      const resp = await retry(() => fetch(url, { headers }));
      const data = await resp.json();
      const rawBars = data.bars?.[sym] || [];
      if (rawBars.length < 15) throw new Error(`${sym}: insufficient daily data`);

      // Compute 14-period ATR
      let atrSum = 0;
      for (let j = rawBars.length - 14; j < rawBars.length; j++) {
        const prev = rawBars[j - 1];
        const cur = rawBars[j];
        const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
        atrSum += tr;
      }
      const dailyATR = atrSum / 14;
      const lastClose = rawBars[rawBars.length - 1].c;
      const prevClose = rawBars.length > 1 ? rawBars[rawBars.length - 2].c : lastClose;

      // Compute 20-day average volume
      const avgVol = rawBars.slice(-20).reduce((s, b) => s + b.v, 0) / Math.min(20, rawBars.length);

      return { sym, dailyATR, lastClose, prevClose, avgVol };
    }));

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        const { sym, dailyATR, lastClose, prevClose, avgVol } = outcome.value;
        results[sym] = { dailyATR, lastClose, prevClose, avgVol };
        console.log(`  ${sym}: ATR=$${dailyATR.toFixed(2)} | Last=$${lastClose.toFixed(2)} | AvgVol=${(avgVol / 1e6).toFixed(1)}M`);
      } else {
        const msg = outcome.reason?.message || String(outcome.reason);
        console.log(`  ${msg}`);
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

// ─── Fetch today's opening range ───

async function fetchOpeningRange(symbol) {
  const today = getTodayStr();
  try {
    const start = `${today}T09:30:00-04:00`;
    const end = `${today}T09:50:00-04:00`;
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=5Min&start=${start}&end=${end}&limit=5&feed=iex`;
    const resp = await retry(() => fetch(url, { headers }));
    const data = await resp.json();
    const rawBars = data.bars?.[symbol] || [];

    if (rawBars.length < 3) return null;

    const bars = rawBars.slice(0, 3);
    const high = Math.max(...bars.map(b => b.h));
    const low = Math.min(...bars.map(b => b.l));
    const open = bars[0].o;
    const close = bars[2].c;
    const volume = bars.reduce((s, b) => s + b.v, 0);
    const range = high - low;

    return { high, low, open, close, range, volume, isRed: close < open, isGreen: close > open };
  } catch (err) {
    console.log(`  ${symbol} opening range error: ${err.message}`);
    return null;
  }
}

// ─── Main ───

async function main() {
  console.log(`Pre-market scan: ${UNIVERSE.length} symbols, selecting top ${TOP_N}`);
  console.log(`Fetching daily data...`);

  const dailyData = await fetchDailyData(UNIVERSE);
  const candidates = [];

  console.log(`\nScanning opening ranges...`);

  for (const sym of UNIVERSE) {
    const dd = dailyData[sym];
    if (!dd) continue;

    const range = await fetchOpeningRange(sym);
    if (!range) { console.log(`  ${sym}: no opening range`); continue; }

    const atrPct = dd.dailyATR / dd.lastClose * 100;
    const gapPct = Math.abs(range.open - dd.prevClose) / dd.prevClose * 100;
    const rvol = dd.avgVol > 0 ? range.volume / (dd.avgVol / 78) : 0; // 78 bars in a day, rough pre-market estimate
    const rangeATRRatio = range.range / dd.dailyATR;

    const result = filterCandidate({
      symbol: sym, dailyATR: dd.dailyATR, price: dd.lastClose,
      prevClose: dd.prevClose, openPrice: range.open,
      rangeHigh: range.high, rangeLow: range.low,
      rangeOpen: range.open, rangeClose: range.close,
    });

    if (result.passed) {
      candidates.push({
        symbol: sym, dailyATR: dd.dailyATR, price: dd.lastClose,
        rangeHigh: range.high, rangeLow: range.low,
        rangeOpen: range.open, rangeClose: range.close,
        range: range.range, rvol, atrPct, gapPct, rangeATRRatio,
        reason: result.reason,
      });
      console.log(`  ${sym}: OK — range=$${range.range.toFixed(2)} (${(rangeATRRatio * 100).toFixed(0)}% ATR) | ${result.reason}`);
    } else {
      console.log(`  ${sym}: SKIP — ${result.reason}`);
    }
  }

  const ranked = rankCandidates(candidates);
  const selected = ranked.slice(0, TOP_N);

  const watchlist = {
    date: getTodayStr(),
    generatedAt: new Date().toISOString(),
    topN: TOP_N,
    candidates: selected.map(c => ({
      symbol: c.symbol,
      side: c.reason.includes('LONG') ? 'long' : 'short',
      entryPrice: c.reason.includes('LONG') ? c.rangeLow : c.rangeHigh,
      rangeHigh: c.rangeHigh,
      rangeLow: c.rangeLow,
      dailyATR: c.dailyATR,
      rangeATRRatio: c.rangeATRRatio,
      score: c.score?.toFixed(1),
    })),
    allRanked: ranked.map(c => ({ symbol: c.symbol, score: c.score?.toFixed(1), rangeATRRatio: c.rangeATRRatio?.toFixed(2) })),
  };

  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2));
  console.log(`\nWrote watchlist to ${WATCHLIST_PATH}`);

  if (selected.length > 0) {
    console.log(`\nTop ${TOP_N} candidates:`);
    for (const c of selected) {
      console.log(`  ${c.symbol} — ${c.reason} | range/ATR ${(c.rangeATRRatio * 100).toFixed(0)}% | score ${c.score?.toFixed(1)}`);
    }
  } else {
    console.log('\nNo candidates passed filters — no trades today');
  }

  // Send to Telegram if enabled
  if (telegramEnabled() && selected.length > 0) {
    const lines = selected.map(c =>
      `${c.symbol} ${c.reason} | range/ATR ${(c.rangeATRRatio * 100).toFixed(0)}% | score ${c.score?.toFixed(1)}`
    );
    await sendTelegram(`Pre-market scan (${getTodayStr()}):\n${lines.join('\n')}`).catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });