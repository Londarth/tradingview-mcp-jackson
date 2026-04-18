#!/usr/bin/env node
import 'dotenv/config';

// ─── Data fetching ───

async function fetchBarsPaginated(symbol, timeframe, startDate, endDate) {
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

function norm5(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw }; }
function normD(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; }

// ─── Indicator closures ───

function createSMA(length) {
  const buf = [];
  let sum = 0;
  return {
    push(val) { buf.push(val); sum += val; if (buf.length > length) sum -= buf.shift(); },
    value() { return buf.length >= length ? sum / buf.length : null; },
    ready() { return buf.length >= length; },
  };
}

function createATR(period) {
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

function createRSI(period) {
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

function createSessionVWAP() {
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

// ─── Timezone helper ───

function getHHMM_ET(isoTs) {
  const d = new Date(isoTs);
  const s = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 100 + m;
}

function getDateStr(isoTs) {
  // Get the ET date so session boundaries align correctly
  const d = new Date(isoTs);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// ─── Daily ATR map ───

function computeDailyATRMap(dailyBars, period = 14) {
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
    const dateStr = getDateStr(dailyBars[i].ts);
    map.set(dateStr, sum / period);
  }
  return map;
}

// ─── Exit check ───

function checkExits(bar, position, sessionEnd) {
  const hhmm = getHHMM_ET(bar.ts);
  if (hhmm >= sessionEnd) return { closed: true, exitPrice: bar.close, exitType: 'session_end' };

  if (position.side === 'long') {
    if (bar.low <= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    if (bar.high >= position.targetPrice) return { closed: true, exitPrice: position.targetPrice, exitType: 'target' };
  } else {
    if (bar.high >= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    if (bar.low <= position.targetPrice) return { closed: true, exitPrice: position.targetPrice, exitType: 'target' };
  }
  return { closed: false };
}

// ─── Strategy A: OR Micro Scalp ───

function createStrategyAState() {
  return {
    openRangeHigh: null, openRangeLow: null, openingBarCount: 0, openingComplete: false,
    brokeAbove: false, brokeBelow: false, longEntryReady: false, shortEntryReady: false,
    tradedToday: false,
  };
}

function processBarStrategyA(bar, state, hhmm, ind) {
  const { sessionVWAP, smaVolume, atr5m, dailyATRMap, config } = ind;
  if (hhmm < 930 || hhmm >= 1100) return { action: 'none' };

  // Build opening range (first 3 bars: 9:30, 9:35, 9:40)
  if (!state.openingComplete) {
    if (state.openingBarCount === 0) {
      state.openRangeHigh = bar.high; state.openRangeLow = bar.low; state.openingBarCount = 1;
    } else if (state.openingBarCount < 3) {
      state.openRangeHigh = Math.max(state.openRangeHigh, bar.high);
      state.openRangeLow = Math.min(state.openRangeLow, bar.low);
      state.openingBarCount++;
      if (state.openingBarCount === 3) state.openingComplete = true;
    }
    return { action: 'none' };
  }

  // ATR filter
  const rangeSize = state.openRangeHigh - state.openRangeLow;
  const dateStr = getDateStr(bar.ts);
  const dailyATR = dailyATRMap.get(dateStr);
  const atrPct = dailyATR && dailyATR > 0 ? (rangeSize / dailyATR) * 100 : 0;
  if (config.useAtrFilter && atrPct < config.atrPctThreshold) return { action: 'none' };

  // RVOL
  const volMA = smaVolume.value();
  const rvol = volMA && volMA > 0 ? bar.volume / volMA : 0;
  if (config.useRvolFilter && rvol < config.rvolThreshold) return { action: 'none' };

  const vwap = sessionVWAP.value();
  if (!vwap) return { action: 'none' };

  // Breakout detection
  if (!state.tradedToday) {
    if (!state.brokeAbove && bar.close > state.openRangeHigh && (!config.useRvolFilter || rvol >= config.rvolThreshold)) {
      state.brokeAbove = true; state.longEntryReady = true;
    }
    if (!state.brokeBelow && bar.close < state.openRangeLow && (!config.useRvolFilter || rvol >= config.rvolThreshold)) {
      state.brokeBelow = true; state.shortEntryReady = true;
    }
  }

  const atrVal = atr5m.value();
  if (!atrVal) return { action: 'none' };

  // Long retest + wick
  if (state.longEntryReady && !state.tradedToday) {
    const longRetest = bar.low <= state.openRangeHigh && bar.close > state.openRangeHigh && bar.close > vwap;
    const range = bar.high - bar.low;
    const isHammer = range > 0 ? (Math.min(bar.open, bar.close) - bar.low) / range >= 0.6 : false;
    if (longRetest && isHammer) {
      const stop = state.openRangeLow - atrVal * config.stopAtrMult;
      const risk = bar.close - stop;
      const target = bar.close + risk * config.targetR;
      state.tradedToday = true; state.longEntryReady = false;
      return { action: 'enter', side: 'long', stop, target };
    }
  }

  // Short retest + wick
  if (state.shortEntryReady && !state.tradedToday) {
    const shortRetest = bar.high >= state.openRangeLow && bar.close < state.openRangeLow && bar.close < vwap;
    const range = bar.high - bar.low;
    const isInvHammer = range > 0 ? (bar.high - Math.max(bar.open, bar.close)) / range >= 0.6 : false;
    if (shortRetest && isInvHammer) {
      const stop = state.openRangeHigh + atrVal * config.stopAtrMult;
      const risk = stop - bar.close;
      const target = bar.close - risk * config.targetR;
      state.tradedToday = true; state.shortEntryReady = false;
      return { action: 'enter', side: 'short', stop, target };
    }
  }

  return { action: 'none' };
}

// ─── Strategy B: VWAP Reversion Scalp ───

function createStrategyBState() {
  return { barsSinceLast: 9999 };
}

function processBarStrategyB(bar, state, hhmm, ind) {
  const { sessionVWAP, smaVolume, atr5m, rsi14, config } = ind;
  if (hhmm < 945 || hhmm >= 1130) return { action: 'none' };

  if (!atr5m.ready() || !rsi14.ready() || !smaVolume.ready()) return { action: 'none' };

  const atr = atr5m.value();
  const rsi = rsi14.value();
  const vwap = sessionVWAP.value();
  const volMA = smaVolume.value();
  if (!atr || atr <= 0 || !vwap || !volMA) return { action: 'none' };

  // Cooldown
  if (state.barsSinceLast < 9999) state.barsSinceLast++;
  if (state.barsSinceLast < config.cooldownBars) return { action: 'none' };

  const distFromVwap = (bar.close - vwap) / atr;
  const volOk = !config.useVolFilter || bar.volume > volMA;

  if (distFromVwap <= -config.atrDistMult && (!config.useRsiFilter || rsi < config.rsiMaxLong) && volOk) {
    const stop = bar.close - atr * config.stopAtrMult;
    const target = vwap;
    state.barsSinceLast = 0;
    return { action: 'enter', side: 'long', stop, target };
  }

  if (distFromVwap >= config.atrDistMult && (!config.useRsiFilter || rsi > config.rsiMinShort) && volOk) {
    const stop = bar.close + atr * config.stopAtrMult;
    const target = vwap;
    state.barsSinceLast = 0;
    return { action: 'enter', side: 'short', stop, target };
  }

  return { action: 'none' };
}

// ─── Simulation engine ───

function runBacktest(bars, processBarFn, stateInitFn, config, dailyATRMap) {
  let equity = 200;
  let position = null;
  const trades = [];
  let state = stateInitFn();
  let currentDate = null;
  const sessionVWAP = createSessionVWAP();
  const smaVolume = createSMA(config.volumeMALength || 12);
  const atr5m = createATR(14);
  const rsi14 = createRSI(14);
  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [equity];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barDate = getDateStr(bar.ts);
    const hhmm = getHHMM_ET(bar.ts);

    // New session: reset VWAP and strategy state
    if (barDate !== currentDate) {
      currentDate = barDate;
      sessionVWAP.reset();
      state = stateInitFn();
    }

    // Feed indicators
    sessionVWAP.push(bar);
    smaVolume.push(bar.volume);
    atr5m.push(bar);
    rsi14.push(bar.close);

    // Check exits first
    if (position) {
      const exit = checkExits(bar, position, config.sessionEnd);
      if (exit.closed) {
        const qty = (equity * (config.riskPct / 100)) / position.entryPrice;
        const pnl = (exit.exitPrice - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
        equity += pnl;
        trades.push({ ...position, exitPrice: exit.exitPrice, exitType: exit.exitType, pnl, qty });
        position = null;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
        equityCurve.push(equity);
      }
    }

    // Check entries (only if flat)
    if (!position) {
      const signal = processBarFn(bar, state, hhmm, {
        sessionVWAP, smaVolume, atr5m, rsi14, dailyATRMap, config,
      });
      if (signal.action === 'enter') {
        const qty = (equity * (config.riskPct / 100)) / bar.close;
        position = {
          side: signal.side, entryPrice: bar.close,
          stopPrice: signal.stop, targetPrice: signal.target,
          entryDate: barDate,
        };
      }
    }
  }

  // Force-close at end of data
  if (position) {
    const lastBar = bars[bars.length - 1];
    const qty = (equity * (config.riskPct / 100)) / position.entryPrice;
    const pnl = (lastBar.close - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
    equity += pnl;
    trades.push({ ...position, exitPrice: lastBar.close, exitType: 'data_end', pnl, qty });
    equityCurve.push(equity);
  }

  return computeStats(trades, 200, equityCurve, maxDrawdown);
}

// ─── Stats ───

function computeStats(trades, initialCapital, equityCurve, maxDrawdown) {
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

// ─── Reporting ───

function printReport(a, b, symbol, startDate, endDate) {
  const gbp = v => (v >= 0 ? '+' : '') + '£' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);

  console.log('='.repeat(60));
  console.log(`  BACKTEST: ${symbol}  (${startDate} to ${endDate})`);
  console.log('='.repeat(60));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'OR Micro Scalp'.padStart(18)}${'VWAP Reversion'.padStart(18)}`);
  console.log('-'.repeat(58));
  console.log(`${'Total Trades'.padEnd(22)}${String(a.totalTrades).padStart(18)}${String(b.totalTrades).padStart(18)}`);
  console.log(`${'Wins'.padEnd(22)}${String(a.wins).padStart(18)}${String(b.wins).padStart(18)}`);
  console.log(`${'Losses'.padEnd(22)}${String(a.losses).padStart(18)}${String(b.losses).padStart(18)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(a.winRate).padStart(18)}${pct(b.winRate).padStart(18)}`);
  console.log(`${'Net P&L'.padEnd(22)}${gbp(a.netPnL).padStart(18)}${gbp(b.netPnL).padStart(18)}`);
  console.log(`${'Avg Win'.padEnd(22)}${gbp(a.avgWin).padStart(18)}${gbp(b.avgWin).padStart(18)}`);
  console.log(`${'Avg Loss'.padEnd(22)}${gbp(a.avgLoss).padStart(18)}${gbp(b.avgLoss).padStart(18)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(a.maxDrawdown).padStart(18)}${pct(b.maxDrawdown).padStart(18)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(a.profitFactor).padStart(18)}${num(b.profitFactor).padStart(18)}`);
  console.log('-'.repeat(58));
  console.log('');
  console.log(`Initial capital: £200 | Position size: 1% equity | No slippage/commission`);
}

// ─── Main ───

async function main() {
  const symbol = process.argv[2] || 'AMD';
  const startDate = process.argv[3] || new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
  const endDate = process.argv[4] || new Date().toISOString().split('T')[0];
  const dailyStart = new Date(Date.parse(startDate) - 45 * 86400000).toISOString().split('T')[0]; // 45 days extra for daily ATR

  console.log(`Fetching ${symbol} 5-min bars (${startDate} to ${endDate})...`);
  const raw5 = await fetchBarsPaginated(symbol, '5Min', startDate, endDate);
  const bars = raw5.map(norm5);
  console.log(`  Got ${bars.length} 5-min bars`);

  console.log(`Fetching ${symbol} daily bars for ATR...`);
  const rawD = await fetchBarsPaginated(symbol, '1Day', dailyStart, endDate);
  const dailyBars = rawD.map(normD);
  const dailyATRMap = computeDailyATRMap(dailyBars, 14);
  console.log(`  Got ${dailyBars.length} daily bars, ATR map: ${dailyATRMap.size} dates`);

  const configA = {
    sessionEnd: 1100, riskPct: 1,
    useAtrFilter: true, atrPctThreshold: 20,
    useRvolFilter: true, rvolThreshold: 1.2, volumeMALength: 12,
    stopAtrMult: 0.5, targetR: 1.5,
  };

  const configB = {
    sessionEnd: 1130, riskPct: 1,
    atrDistMult: 1.5, stopAtrMult: 0.5,
    useRsiFilter: true, rsiMaxLong: 70, rsiMinShort: 30,
    useVolFilter: true, volumeMALength: 12,
    cooldownBars: 10,
  };

  console.log('Running OR Micro Scalp backtest...');
  const resultA = runBacktest(bars, processBarStrategyA, createStrategyAState, configA, dailyATRMap);

  console.log('Running VWAP Reversion Scalp backtest...');
  const resultB = runBacktest(bars, processBarStrategyB, createStrategyBState, configB, dailyATRMap);

  printReport(resultA, resultB, symbol, startDate, endDate);
}

main().catch(e => { console.error(e); process.exit(1); });