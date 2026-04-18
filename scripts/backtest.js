#!/usr/bin/env node
import 'dotenv/config';

const SCANNER_UNIVERSE = [
  // Proven winners from training (PF > 1.5)
  'SOFI', 'INTC', 'Z', 'DAL', 'RIVN', 'SBUX', 'CCL',
  // Similar profile: cheap-mid range, moderate volatility
  'DIS', 'F', 'GM', 'KEYS', 'MU', 'PLTR', 'SNAP',
];
const SCANNER_TOP_N = 5;

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

// ─── Timezone helpers ───

function getHHMM_ET(isoTs) {
  const d = new Date(isoTs);
  const s = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 100 + m;
}

function getDateStr(isoTs) {
  const d = new Date(isoTs);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

// ─── RVOL Scanner ───

function computeScannerSelections(allBars5m, allDailyATRMaps) {
  const dayRankings = new Map();

  for (const [symbol, bars] of Object.entries(allBars5m)) {
    const smaVolume = createSMA(12);
    const dailyATRMap = allDailyATRMaps[symbol];
    if (!dailyATRMap) continue;

    let prevDayClose = null;
    let lastClose = null;
    let prevDate = null;

    for (const bar of bars) {
      smaVolume.push(bar.volume);
      const dateStr = getDateStr(bar.ts);
      const hhmm = getHHMM_ET(bar.ts);

      // Track previous day's close for overnight gap
      if (prevDate && prevDate !== dateStr) {
        prevDayClose = lastClose;
      }
      lastClose = bar.close;
      prevDate = dateStr;

      if (hhmm !== 930 || !smaVolume.ready()) continue;

      const volMA = smaVolume.value();
      if (!volMA || volMA <= 0) continue;

      const rvol = bar.volume / volMA;
      const dailyATR = dailyATRMap.get(dateStr) || 0;
      const price = bar.close;

      // Filter: price < $100, ATR > $0.50, ATR < 5% of price, overnight gap < 3%
      const gapPct = prevDayClose !== null ? Math.abs(bar.open - prevDayClose) / prevDayClose * 100 : 999;
      const atrPct = dailyATR > 0 ? dailyATR / price * 100 : 0;
      if (price >= 100 || dailyATR <= 0.5 || atrPct >= 5 || gapPct >= 3) continue;

      if (!dayRankings.has(dateStr)) dayRankings.set(dateStr, []);
      dayRankings.get(dateStr).push({ symbol, rvol, price, atr: dailyATR });
    }
  }

  const selections = new Map();
  for (const [dateStr, rankings] of dayRankings) {
    rankings.sort((a, b) => b.rvol - a.rvol);
    selections.set(dateStr, rankings.slice(0, SCANNER_TOP_N));
  }

  return selections;
}

// ─── Exit check ───

function checkExits(bar, position, sessionEnd, vwap) {
  const hhmm = getHHMM_ET(bar.ts);
  if (hhmm >= sessionEnd) return { closed: true, exitPrice: bar.close, exitType: 'session_end' };

  // VWAP stop: bar close past VWAP
  if (position.stopType === 'vwap' && vwap) {
    if (position.side === 'long' && bar.close < vwap) return { closed: true, exitPrice: bar.close, exitType: 'stop' };
    if (position.side === 'short' && bar.close > vwap) return { closed: true, exitPrice: bar.close, exitType: 'stop' };
  }

  // Fixed stop/target
  if (position.side === 'long') {
    if (position.stopType !== 'vwap' && bar.low <= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    if (bar.high >= position.targetPrice) return { closed: true, exitPrice: position.targetPrice, exitType: 'target' };
  } else {
    if (position.stopType !== 'vwap' && bar.high >= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    if (bar.low <= position.targetPrice) return { closed: true, exitPrice: position.targetPrice, exitType: 'target' };
  }
  return { closed: false };
}

// ─── Strategy A: Aziz ORB + VWAP ───

function createStrategyAState() {
  return { openRangeHigh: null, openRangeLow: null, openingComplete: false, tradedToday: false };
}

function processBarStrategyA(bar, state, hhmm, ind) {
  const { sessionVWAP, smaVolume, dailyATRMap, config } = ind;
  if (hhmm < 930 || hhmm >= 1130) return { action: 'none' };

  // Single-bar opening range (9:30 bar)
  if (hhmm === 930) {
    state.openRangeHigh = bar.high;
    state.openRangeLow = bar.low;
    state.openingComplete = true;
  }

  if (!state.openingComplete) return { action: 'none' };

  // ATR filter: OR range must be < daily ATR
  const rangeSize = state.openRangeHigh - state.openRangeLow;
  const dateStr = getDateStr(bar.ts);
  const dailyATR = dailyATRMap.get(dateStr);
  if (config.useAtrFilter && dailyATR && dailyATR > 0 && rangeSize >= dailyATR) return { action: 'none' };

  // RVOL filter
  const volMA = smaVolume.value();
  const rvol = volMA && volMA > 0 ? bar.volume / volMA : 0;
  if (config.useRvolFilter && rvol < config.rvolThreshold) return { action: 'none' };

  const vwap = sessionVWAP.value();
  if (!vwap || state.tradedToday) return { action: 'none' };

  // Breakout entry — no retest, no wick filter
  if (bar.close > state.openRangeHigh && bar.close > vwap) {
    const risk = bar.close - vwap;
    const target = bar.close + risk * config.targetR;
    state.tradedToday = true;
    return { action: 'enter', side: 'long', stop: vwap, target, stopType: 'vwap' };
  }

  if (bar.close < state.openRangeLow && bar.close < vwap) {
    const risk = vwap - bar.close;
    const target = bar.close - risk * config.targetR;
    state.tradedToday = true;
    return { action: 'enter', side: 'short', stop: vwap, target, stopType: 'vwap' };
  }

  return { action: 'none' };
}

// ─── Strategy B: VWAP Reversion Scalp (tuned) ───

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
    return { action: 'enter', side: 'long', stop, target, stopType: 'fixed' };
  }

  if (distFromVwap >= config.atrDistMult && (!config.useRsiFilter || rsi > config.rsiMinShort) && volOk) {
    const stop = bar.close + atr * config.stopAtrMult;
    const target = vwap;
    state.barsSinceLast = 0;
    return { action: 'enter', side: 'short', stop, target, stopType: 'fixed' };
  }

  return { action: 'none' };
}

// ─── Strategy C: Touch and Turn Scalper ───

function createTouchTurnState() {
  return {
    openRangeHigh: null,
    openRangeLow: null,
    openRangeOpen: null,
    openRangeClose: null,
    openingBars: 0,
    rangeConfirmed: false,
    tradedToday: false,
  };
}

function processBarTouchTurn(bar, state, hhmm, ind) {
  const { dailyATRMap, config } = ind;

  // Build 15-min opening range from first 3 five-minute bars (9:30, 9:35, 9:40)
  if (hhmm >= 930 && hhmm < 945) {
    if (state.openRangeHigh === null) {
      state.openRangeHigh = bar.high;
      state.openRangeLow = bar.low;
      state.openRangeOpen = bar.open;
    } else {
      state.openRangeHigh = Math.max(state.openRangeHigh, bar.high);
      state.openRangeLow = Math.min(state.openRangeLow, bar.low);
    }
    state.openRangeClose = bar.close;
    state.openingBars++;
    if (state.openingBars >= 3) state.rangeConfirmed = true;
    return { action: 'none' };
  }

  // Only trade within first 90 minutes (entries after 9:45, before 11:00)
  if (hhmm < 945 || hhmm >= 1100) return { action: 'none' };

  if (!state.rangeConfirmed || state.tradedToday) return { action: 'none' };

  // ATR filter: opening range must be >= 25% of daily ATR
  const range = state.openRangeHigh - state.openRangeLow;
  const dateStr = getDateStr(bar.ts);
  const dailyATR = dailyATRMap.get(dateStr);
  if (config.useAtrFilter && dailyATR && dailyATR > 0 && range < dailyATR * config.atrPctThreshold) {
    return { action: 'none' };
  }

  // Direction: red candle (close < open) → LONG at low, green candle → SHORT at high
  const isRed = state.openRangeClose < state.openRangeOpen;
  const isGreen = state.openRangeClose > state.openRangeOpen;

  if (isRed) {
    // LONG: limit order at low of range
    const entry = state.openRangeLow;
    if (bar.low <= entry) {
      const targetDist = 0.618 * range;
      const target = entry + targetDist;
      const stop = entry - targetDist / 2;
      state.tradedToday = true;
      return { action: 'enter', side: 'long', stop, target, stopType: 'fixed' };
    }
  } else if (isGreen) {
    // SHORT: limit order at high of range
    const entry = state.openRangeHigh;
    if (bar.high >= entry) {
      const targetDist = 0.618 * range;
      const target = entry - targetDist;
      const stop = entry + targetDist / 2;
      state.tradedToday = true;
      return { action: 'enter', side: 'short', stop, target, stopType: 'fixed' };
    }
  }

  return { action: 'none' };
}

// ─── Simulation engine ───

function runBacktest(bars, processBarFn, stateInitFn, config, dailyATRMap, scannerDays = null) {
  const initialCapital = config.initialCapital || 200;
  let equity = initialCapital;
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

  function calcQty() {
    const positionValue = Math.max(equity * (config.riskPct / 100), config.minPositionGBP || 20);
    return positionValue / (position ? position.entryPrice : 1);
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barDate = getDateStr(bar.ts);
    const hhmm = getHHMM_ET(bar.ts);

    if (barDate !== currentDate) {
      currentDate = barDate;
      sessionVWAP.reset();
      state = stateInitFn();
    }

    sessionVWAP.push(bar);
    smaVolume.push(bar.volume);
    atr5m.push(bar);
    rsi14.push(bar.close);

    // Check exits first
    if (position) {
      const exit = checkExits(bar, position, config.sessionEnd, sessionVWAP.value());
      if (exit.closed) {
        const qty = calcQty();
        const pnl = (exit.exitPrice - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
        equity += pnl;
        trades.push({ ...position, exitPrice: exit.exitPrice, exitType: exit.exitType, pnl, qty });
        position = null;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
        equityCurve.push(equity);
      }
    }

    // Check entries (skip if scanner mode and day not selected)
    if (!position && (!scannerDays || scannerDays.has(barDate))) {
      const signal = processBarFn(bar, state, hhmm, {
        sessionVWAP, smaVolume, atr5m, rsi14, dailyATRMap, config,
      });
      if (signal.action === 'enter') {
        const positionValue = Math.max(equity * (config.riskPct / 100), config.minPositionGBP || 20);
        const qty = positionValue / bar.close;
        position = {
          side: signal.side, entryPrice: bar.close,
          stopPrice: signal.stop, targetPrice: signal.target,
          stopType: signal.stopType || 'fixed',
          entryDate: barDate,
        };
      }
    }
  }

  // Force-close at end of data
  if (position) {
    const lastBar = bars[bars.length - 1];
    const positionValue = Math.max(equity * (config.riskPct / 100), config.minPositionGBP || 20);
    const qty = positionValue / position.entryPrice;
    const pnl = (lastBar.close - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
    equity += pnl;
    trades.push({ ...position, exitPrice: lastBar.close, exitType: 'data_end', pnl, qty });
    equityCurve.push(equity);
  }

  return { trades, ...computeStats(trades, initialCapital, equityCurve, maxDrawdown), finalEquity: equity, initialCapital };
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

function printReport(a, b, c, symbol, startDate, endDate) {
  const gbp = v => (v >= 0 ? '+' : '') + '£' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);

  console.log('='.repeat(78));
  console.log(`  BACKTEST: ${symbol}  (${startDate} to ${endDate})`);
  console.log('='.repeat(78));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'Aziz ORB+VWAP'.padStart(18)}${'VWAP Reversion'.padStart(18)}${'Touch & Turn'.padStart(18)}`);
  console.log('-'.repeat(76));
  console.log(`${'Total Trades'.padEnd(22)}${String(a.totalTrades).padStart(18)}${String(b.totalTrades).padStart(18)}${String(c.totalTrades).padStart(18)}`);
  console.log(`${'Wins'.padEnd(22)}${String(a.wins).padStart(18)}${String(b.wins).padStart(18)}${String(c.wins).padStart(18)}`);
  console.log(`${'Losses'.padEnd(22)}${String(a.losses).padStart(18)}${String(b.losses).padStart(18)}${String(c.losses).padStart(18)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(a.winRate).padStart(18)}${pct(b.winRate).padStart(18)}${pct(c.winRate).padStart(18)}`);
  console.log(`${'Net P&L'.padEnd(22)}${gbp(a.netPnL).padStart(18)}${gbp(b.netPnL).padStart(18)}${gbp(c.netPnL).padStart(18)}`);
  console.log(`${'Final Equity'.padEnd(22)}${gbp(a.finalEquity).padStart(18)}${gbp(b.finalEquity).padStart(18)}${gbp(c.finalEquity).padStart(18)}`);
  console.log(`${'Avg Win'.padEnd(22)}${gbp(a.avgWin).padStart(18)}${gbp(b.avgWin).padStart(18)}${gbp(c.avgWin).padStart(18)}`);
  console.log(`${'Avg Loss'.padEnd(22)}${gbp(a.avgLoss).padStart(18)}${gbp(b.avgLoss).padStart(18)}${gbp(c.avgLoss).padStart(18)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(a.maxDrawdown).padStart(18)}${pct(b.maxDrawdown).padStart(18)}${pct(c.maxDrawdown).padStart(18)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(a.profitFactor).padStart(18)}${num(b.profitFactor).padStart(18)}${num(c.profitFactor).padStart(18)}`);
  console.log('-'.repeat(76));

  printTradeLog('AZIZ ORB+VWAP', a.trades, a.initialCapital);
  printTradeLog('VWAP REVERSION', b.trades, b.initialCapital);
  printTradeLog('TOUCH & TURN', c.trades, c.initialCapital);

  console.log('');
  console.log(`Capital: £${a.initialCapital} | Risk: 10% equity/trade (min £20) | No slippage/commission`);
}

function printTradeLog(name, trades, initialCapital) {
  if (!trades || trades.length === 0) {
    console.log(`\n  ${name} — No trades`);
    return;
  }
  console.log('');
  console.log(`  ${name} — Trade Log`);
  console.log(`  ${'Date'.padEnd(12)}${'Side'.padEnd(7)}${'Entry'.padEnd(10)}${'Exit'.padEnd(10)}${'Type'.padEnd(14)}${'P&L'.padStart(9)}${'Equity'.padStart(10)}`);
  console.log(`  ${'----'.padEnd(12)}${'----'.padEnd(7)}${'-----'.padEnd(10)}${'----'.padEnd(10)}${'----'.padEnd(14)}${'---'.padStart(9)}${'-------'.padStart(10)}`);

  let runningEquity = initialCapital;
  for (const t of trades) {
    runningEquity += t.pnl;
    const side = t.side === 'long' ? 'LONG' : 'SHORT';
    const exitType = t.exitType === 'target' ? 'TP' : t.exitType === 'stop' ? 'SL' : t.exitType === 'session_end' ? 'EOD' : 'END';
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '£' + t.pnl.toFixed(2);
    console.log(`  ${t.entryDate.padEnd(12)}${side.padEnd(7)}${t.entryPrice.toFixed(2).padEnd(10)}${t.exitPrice.toFixed(2).padEnd(10)}${exitType.padEnd(14)}${pnlStr.padStart(9)}${('£' + runningEquity.toFixed(2)).padStart(10)}`);
  }
}

// ─── Scanner mode ───

function combineSymbolResults(allResults, initialCapital) {
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

async function runScannerMode(startDate, endDate) {
  console.log(`Scanner mode: fetching data for ${SCANNER_UNIVERSE.length} symbols...`);
  const allBars5m = {};
  const allDailyATRMaps = {};
  let fetched = 0;

  for (const symbol of SCANNER_UNIVERSE) {
    try {
      const raw5 = await fetchBarsPaginated(symbol, '5Min', startDate, endDate);
      if (raw5.length === 0) { console.log(`  ${symbol}: no data`); continue; }
      allBars5m[symbol] = raw5.map(norm5);

      const dailyStart = new Date(Date.parse(startDate) - 45 * 86400000).toISOString().split('T')[0];
      const rawD = await fetchBarsPaginated(symbol, '1Day', dailyStart, endDate);
      const dailyBars = rawD.map(normD);
      allDailyATRMaps[symbol] = computeDailyATRMap(dailyBars, 14);
      fetched++;
      console.log(`  ${symbol}: ${allBars5m[symbol].length} bars`);
    } catch (e) {
      console.log(`  ${symbol}: ${e.message}`);
    }
  }

  console.log(`\nFetched ${fetched}/${SCANNER_UNIVERSE.length} symbols`);

  const selections = computeScannerSelections(allBars5m, allDailyATRMaps);
  console.log(`Scanner: ${selections.size} trading days with selections\n`);

  // Print scanner selections
  console.log('='.repeat(60));
  console.log('  RVOL SCANNER — Top 5 per Day');
  console.log('='.repeat(60));
  for (const [dateStr, stocks] of selections) {
    const names = stocks.map(s => `${s.symbol}(${s.rvol.toFixed(1)}x)`).join(', ');
    console.log(`  ${dateStr}: ${names}`);
  }

  // Run Aziz ORB+VWAP only on scanner-selected symbols
  const configA = {
    sessionEnd: 1130, riskPct: 25, minPositionGBP: 50, initialCapital: 200,
    useAtrFilter: true,
    useRvolFilter: true, rvolThreshold: 1.5, volumeMALength: 12,
    targetR: 2.0,
  };

  const configC = {
    sessionEnd: 1130, riskPct: 25, minPositionGBP: 50, initialCapital: 200,
    useAtrFilter: true, atrPctThreshold: 0.25,
  };

  const resultsA = {};
  const resultsC = {};

  for (const symbol of Object.keys(allBars5m)) {
    const selectedDays = new Set();
    for (const [dateStr, stocks] of selections) {
      if (stocks.some(s => s.symbol === symbol)) selectedDays.add(dateStr);
    }
    if (selectedDays.size === 0) continue;

    resultsA[symbol] = runBacktest(allBars5m[symbol], processBarStrategyA, createStrategyAState, configA, allDailyATRMaps[symbol], selectedDays);
    resultsC[symbol] = runBacktest(allBars5m[symbol], processBarTouchTurn, createTouchTurnState, configC, allDailyATRMaps[symbol], selectedDays);
  }

  const combinedA = combineSymbolResults(resultsA, configA.initialCapital);
  const combinedC = combineSymbolResults(resultsC, configC.initialCapital);
  printScannerReport(combinedA, combinedC, startDate, endDate);
}

function printScannerReport(a, c, startDate, endDate) {
  const gbp = v => (v >= 0 ? '+' : '') + '£' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);

  console.log('\n' + '='.repeat(76));
  console.log(`  SCANNER (${startDate} to ${endDate})`);
  console.log('='.repeat(76));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'Aziz ORB+VWAP'.padStart(18)}${'Touch & Turn'.padStart(18)}`);
  console.log('-'.repeat(58));
  console.log(`${'Total Trades'.padEnd(22)}${String(a.totalTrades).padStart(18)}${String(c.totalTrades).padStart(18)}`);
  console.log(`${'Wins'.padEnd(22)}${String(a.wins).padStart(18)}${String(c.wins).padStart(18)}`);
  console.log(`${'Losses'.padEnd(22)}${String(a.losses).padStart(18)}${String(c.losses).padStart(18)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(a.winRate).padStart(18)}${pct(c.winRate).padStart(18)}`);
  console.log(`${'Net P&L'.padEnd(22)}${gbp(a.netPnL).padStart(18)}${gbp(c.netPnL).padStart(18)}`);
  console.log(`${'Final Equity'.padEnd(22)}${gbp(a.finalEquity).padStart(18)}${gbp(c.finalEquity).padStart(18)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(a.maxDrawdown).padStart(18)}${pct(c.maxDrawdown).padStart(18)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(a.profitFactor).padStart(18)}${num(c.profitFactor).padStart(18)}`);
  console.log('-'.repeat(58));

  for (const [name, data] of [['Aziz ORB+VWAP', a], ['Touch & Turn', c]]) {
    const symbols = Object.keys(data.perSymbol || {}).filter(s => data.perSymbol[s].totalTrades > 0);
    if (symbols.length === 0) continue;

    console.log(`\n  ${name} — Per-Symbol Breakdown`);
    console.log(`  ${'Symbol'.padEnd(8)}${'Trades'.padStart(8)}${'WR%'.padStart(8)}${'P&L'.padStart(10)}${'PF'.padStart(8)}`);
    console.log(`  ${'------'.padEnd(8)}${'------'.padStart(8)}${'---'.padStart(8)}${'---'.padStart(10)}${'--'.padStart(8)}`);
    for (const sym of symbols.sort()) {
      const r = data.perSymbol[sym];
      console.log(`  ${sym.padEnd(8)}${String(r.totalTrades).padStart(8)}${pct(r.winRate).padStart(8)}${gbp(r.netPnL).padStart(10)}${num(r.profitFactor).padStart(8)}`);
    }
  }

  console.log(`\nCapital: £${a.initialCapital} | Risk: 25% equity/trade (min £50) | Scanner: top ${SCANNER_TOP_N} RVOL/day | No slippage/commission`);
}

// ─── Main ───

async function main() {
  const mode = process.argv[2];

  if (mode === 'scan') {
    const startDate = process.argv[3] || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const endDate = process.argv[4] || new Date().toISOString().split('T')[0];
    await runScannerMode(startDate, endDate);
    return;
  }

  const symbol = mode || 'AMD';
  const startDate = process.argv[3] || new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
  const endDate = process.argv[4] || new Date().toISOString().split('T')[0];
  const dailyStart = new Date(Date.parse(startDate) - 45 * 86400000).toISOString().split('T')[0];

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
    sessionEnd: 1130, riskPct: 10, minPositionGBP: 20, initialCapital: 200,
    useAtrFilter: true,
    useRvolFilter: true, rvolThreshold: 1.5, volumeMALength: 12,
    targetR: 2.0,
  };

  const configB = {
    sessionEnd: 1130, riskPct: 10, minPositionGBP: 20, initialCapital: 200,
    atrDistMult: 1.0, stopAtrMult: 0.5,
    useRsiFilter: true, rsiMaxLong: 70, rsiMinShort: 30,
    useVolFilter: true, volumeMALength: 12,
    cooldownBars: 10,
  };

  const configC = {
    sessionEnd: 1130, riskPct: 10, minPositionGBP: 20, initialCapital: 200,
    useAtrFilter: true, atrPctThreshold: 0.25,
  };

  console.log('Running Aziz ORB + VWAP backtest...');
  const resultA = runBacktest(bars, processBarStrategyA, createStrategyAState, configA, dailyATRMap);

  console.log('Running VWAP Reversion backtest...');
  const resultB = runBacktest(bars, processBarStrategyB, createStrategyBState, configB, dailyATRMap);

  console.log('Running Touch and Turn backtest...');
  const resultC = runBacktest(bars, processBarTouchTurn, createTouchTurnState, configC, dailyATRMap);

  printReport(resultA, resultB, resultC, symbol, startDate, endDate);
}

main().catch(e => { console.error(e); process.exit(1); });