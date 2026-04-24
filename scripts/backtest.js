#!/usr/bin/env node
import 'dotenv/config';
import { fetchBarsPaginated, norm5, normD, computeDailyATRMap } from './lib/alpaca-data.js';
import { createSMA, createATR, createRSI, createSessionVWAP, createPivots, checkPivotRejection } from './lib/indicators.js';
import { computeStats, combineSymbolResults } from './lib/backtest-utils.js';

import { filterCandidate, rankCandidates, DEFAULT_FILTERS } from './lib/scanner.js';
import { getHHMM_ET, getDateStr } from './lib/time.js';

const SCANNER_UNIVERSE = (process.env.UNIVERSE || 'PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK')
  .split(',').map(s => s.trim()).filter(Boolean);

// Cost model
const SLIPPAGE_BPS = parseFloat(process.env.SLIPPAGE_BPS) || 5;  // 5 bps = 0.05%
const COMMISSION_PER_SHARE = parseFloat(process.env.COMMISSION_PER_SHARE) || 0.005;  // $0.005/share

// ─── Bot Scanner (matches touch-turn-bot.js logic) ───

function computeBotSelections(allBars5m, allDailyATRMaps, topN = 1) {
  const dayCandidates = new Map();

  // Pre-index: group each symbol's bars by date, track prevClose and volume SMA
  const symbolIndex = {};
  for (const [symbol, bars] of Object.entries(allBars5m)) {
    const dailyATRMap = allDailyATRMaps[symbol];
    if (!dailyATRMap) continue;

    const byDate = new Map();
    let prevClose = null;

    for (const bar of bars) {
      const dateStr = getDateStr(bar.ts);
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr).push(bar);

      // Track previous day's last close
      const lastInDay = byDate.get(dateStr);
      if (lastInDay.length > 0) prevClose = lastInDay[lastInDay.length - 1].close;
    }

    // Pre-compute volume SMA per symbol (rolling)
    const volumeSMA = new Map();
    const sma = createSMA(12);
    for (const bar of bars) {
      const dateStr = getDateStr(bar.ts);
      sma.push(bar.volume);
      volumeSMA.set(dateStr, sma.ready() ? sma.value() : null);
    }

    symbolIndex[symbol] = { byDate, dailyATRMap, volumeSMA };
  }

  // Collect all unique dates
  const allDates = new Set();
  for (const { byDate } of Object.values(symbolIndex)) {
    for (const d of byDate.keys()) allDates.add(d);
  }

  for (const dateStr of [...allDates].sort()) {
    const candidates = [];

    for (const [symbol, { byDate, dailyATRMap, volumeSMA }] of Object.entries(symbolIndex)) {
      const dailyATR = dailyATRMap.get(dateStr);
      if (!dailyATR || dailyATR <= 0) continue;

      const dayBars = byDate.get(dateStr);
      if (!dayBars || dayBars.length < 3) continue;

      // Opening range = first 3 five-minute bars (9:30, 9:35, 9:40)
      const orBars = dayBars.filter(b => {
        const hhmm = getHHMM_ET(b.ts);
        return hhmm >= 930 && hhmm < 945;
      }).slice(0, 3);
      if (orBars.length < 3) continue;

      const rangeHigh = Math.max(...orBars.map(b => b.high));
      const rangeLow = Math.min(...orBars.map(b => b.low));
      const rangeOpen = orBars[0].open;
      const rangeClose = orBars[2].close;
      const range = rangeHigh - rangeLow;
      const price = rangeClose;

      // Previous close: last bar of previous date
      const dateList = [...byDate.keys()].sort();
      const dateIdx = dateList.indexOf(dateStr);
      const prevDate = dateIdx > 0 ? dateList[dateIdx - 1] : null;
      const prevClose = prevDate ? byDate.get(prevDate).slice(-1)[0].close : null;

      // RVOL from pre-computed volume SMA
      const openBar = dayBars.find(b => getHHMM_ET(b.ts) === 930);
      const volMA = volumeSMA.get(dateStr);
      const rvol = (volMA && openBar && volMA > 0) ? openBar.volume / volMA : 0;

      const atrPct = dailyATR / price * 100;
      const gapPct = prevClose ? Math.abs(rangeOpen - prevClose) / prevClose * 100 : 0;
      const rangeATRRatio = range / dailyATR;

      // Apply shared filters
      const result = filterCandidate({
        symbol, dailyATR, price, prevClose, openPrice: rangeOpen,
        rangeHigh, rangeLow, rangeOpen, rangeClose,
      });

      if (result.passed) {
        candidates.push({
          symbol, dailyATR, price, rangeHigh, rangeLow, rangeOpen, rangeClose,
          range, rvol, atrPct, gapPct, rangeATRRatio, reason: result.reason,
        });
      }
    }

    if (candidates.length > 0) {
      rankCandidates(candidates, { rvol: 0.30, atrPct: 0.20, gapPct: 0.15, rangeAtrRatio: 0.35 });
      dayCandidates.set(dateStr, candidates.slice(0, topN));
    }
  }

  return dayCandidates;
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

// ─── Strategy D: Pivot Reversion Scalper ───

function createPivotRevertState() {
  return {
    pivots: null,
    pivotSet: false,
    tradesToday: 0,
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
  if (state.tradesToday >= (config.pivotMaxTrades || 4)) return { action: 'none' };

  // Set pivots from prior day data (passed via ind.pivotLevels)
  if (!state.pivotSet && ind.pivotLevels) {
    state.pivots = ind.pivotLevels;
    state.pivotSet = true;
  }

  if (!state.pivots) return { action: 'none' };

  // Track recent bars for rejection context
  state.recentBars.push(bar);
  if (state.recentBars.length > 3) state.recentBars.shift();

  const { P, R1, S1 } = state.pivots;
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
      const stopMult = config.pivotStopAtrMult || 0.3;
      const stop = S1 - dailyATR * stopMult;
      const target = P;  // reversion target: pivot midpoint
      const risk = bar.close - stop;
      const reward = target - bar.close;
      const minRR = config.pivotMinRR || 1.5;
      if (risk > 0 && reward / risk >= minRR) {
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
      const stopMult = config.pivotStopAtrMult || 0.3;
      const stop = R1 + dailyATR * stopMult;
      const target = P;  // reversion target: pivot midpoint
      const risk = stop - bar.close;
      const reward = bar.close - target;
      const minRR = config.pivotMinRR || 1.5;
      if (risk > 0 && reward / risk >= minRR) {
        state.tradesToday++;
        state.cooldownBars = state.cooldownNeeded;
        return { action: 'enter', side: 'short', stop, target, stopType: 'fixed' };
      }
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
  const dailyLossLimitPct = config.dailyLossLimitPct || 0;
  let dailyPnl = 0;

  function calcQty() {
    if (!position) return 0;
    const positionValue = Math.max(position.entryEquity * (config.riskPct / 100), config.minPositionUSD || 20);
    return positionValue / position.entryPrice;
  }

  function applyCosts(entryPrice, exitPrice, qty, side) {
    const slippageCost = (entryPrice + exitPrice) * qty * (SLIPPAGE_BPS / 10000);
    const commissionCost = qty * COMMISSION_PER_SHARE * 2; // entry + exit
    return slippageCost + commissionCost;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barDate = getDateStr(bar.ts);
    const hhmm = getHHMM_ET(bar.ts);

    if (barDate !== currentDate) {
      currentDate = barDate;
      sessionVWAP.reset();
      state = stateInitFn();
      dailyPnl = 0;
    }

    sessionVWAP.push(bar);
    smaVolume.push(bar.volume);
    atr5m.push(bar);
    rsi14.push(bar.close);

    // Compute pivot levels from prior day's daily bar (for Strategy D)
    const pivotLevels = config._priorDayBars?.get(barDate) || null;

    // Check exits first
    if (position) {
      const exit = checkExits(bar, position, config.sessionEnd, sessionVWAP.value());
      if (exit.closed) {
        const qty = calcQty();
        const rawPnl = (exit.exitPrice - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
        const costs = applyCosts(position.entryPrice, exit.exitPrice, qty, position.side);
        const pnl = rawPnl - costs;
        equity += pnl;
        dailyPnl += pnl;
        trades.push({ ...position, exitPrice: exit.exitPrice, exitType: exit.exitType, pnl, qty, costs });
        position = null;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
        equityCurve.push(equity);

        // Daily loss limit check
        if (dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / (equity - dailyPnl + initialCapital * config.riskPct / 100)) * 100 > dailyLossLimitPct) {
          // Stop trading for the rest of this day (state resets on new day anyway)
          state.tradedToday = true; // prevent re-entry in strategies that use this flag
        }
      }
    }

    // Check entries (skip if scanner mode and day not selected)
    if (!position && (!scannerDays || scannerDays.has(barDate))) {
      // Daily loss limit: skip entries if limit hit
      if (dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / equity * 100) > dailyLossLimitPct) {
        continue;
      }

      const signal = processBarFn(bar, state, hhmm, {
        sessionVWAP, smaVolume, atr5m, rsi14, dailyATRMap, config,
        pivotLevels,
      });
      if (signal.action === 'enter') {
        const entryEquity = equity;
        const positionValue = Math.max(entryEquity * (config.riskPct / 100), config.minPositionUSD || 20);
        const qty = positionValue / bar.close;
        position = {
          side: signal.side, entryPrice: bar.close,
          stopPrice: signal.stop, targetPrice: signal.target,
          stopType: signal.stopType || 'fixed',
          entryDate: barDate,
          entryEquity,
        };
      }
    }
  }

  // Force-close at end of data
  if (position) {
    const lastBar = bars[bars.length - 1];
    const positionValue = Math.max(position.entryEquity * (config.riskPct / 100), config.minPositionUSD || 20);
    const qty = positionValue / position.entryPrice;
    const rawPnl = (lastBar.close - position.entryPrice) * qty * (position.side === 'short' ? -1 : 1);
    const costs = applyCosts(position.entryPrice, lastBar.close, qty, position.side);
    const pnl = rawPnl - costs;
    equity += pnl;
    trades.push({ ...position, exitPrice: lastBar.close, exitType: 'data_end', pnl, qty, costs });
    equityCurve.push(equity);
  }

  return { trades, ...computeStats(trades, initialCapital, equityCurve, maxDrawdown), finalEquity: equity, initialCapital };
}

// ─── Reporting ───

function printReport(a, b, c, d, symbol, startDate, endDate) {
  const usd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);
  const sharpe = v => v === 0 ? 'N/A' : v.toFixed(2);
  const calmar = v => v === 0 ? 'N/A' : v.toFixed(2);

  console.log('='.repeat(96));
  console.log(`  BACKTEST: ${symbol}  (${startDate} to ${endDate})`);
  console.log('='.repeat(96));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'Aziz ORB+VWAP'.padStart(18)}${'VWAP Reversion'.padStart(18)}${'Touch & Turn'.padStart(18)}${'Pivot Revert'.padStart(18)}`);
  console.log('-'.repeat(94));
  console.log(`${'Total Trades'.padEnd(22)}${String(a.totalTrades).padStart(18)}${String(b.totalTrades).padStart(18)}${String(c.totalTrades).padStart(18)}${String(d.totalTrades).padStart(18)}`);
  console.log(`${'Wins'.padEnd(22)}${String(a.wins).padStart(18)}${String(b.wins).padStart(18)}${String(c.wins).padStart(18)}${String(d.wins).padStart(18)}`);
  console.log(`${'Losses'.padEnd(22)}${String(a.losses).padStart(18)}${String(b.losses).padStart(18)}${String(c.losses).padStart(18)}${String(d.losses).padStart(18)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(a.winRate).padStart(18)}${pct(b.winRate).padStart(18)}${pct(c.winRate).padStart(18)}${pct(d.winRate).padStart(18)}`);
  console.log(`${'Net P&L'.padEnd(22)}${usd(a.netPnL).padStart(18)}${usd(b.netPnL).padStart(18)}${usd(c.netPnL).padStart(18)}${usd(d.netPnL).padStart(18)}`);
  console.log(`${'Final Equity'.padEnd(22)}${usd(a.finalEquity).padStart(18)}${usd(b.finalEquity).padStart(18)}${usd(c.finalEquity).padStart(18)}${usd(d.finalEquity).padStart(18)}`);
  console.log(`${'Avg Win'.padEnd(22)}${usd(a.avgWin).padStart(18)}${usd(b.avgWin).padStart(18)}${usd(c.avgWin).padStart(18)}${usd(d.avgWin).padStart(18)}`);
  console.log(`${'Avg Loss'.padEnd(22)}${usd(a.avgLoss).padStart(18)}${usd(b.avgLoss).padStart(18)}${usd(c.avgLoss).padStart(18)}${usd(d.avgLoss).padStart(18)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(a.maxDrawdown).padStart(18)}${pct(b.maxDrawdown).padStart(18)}${pct(c.maxDrawdown).padStart(18)}${pct(d.maxDrawdown).padStart(18)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(a.profitFactor).padStart(18)}${num(b.profitFactor).padStart(18)}${num(c.profitFactor).padStart(18)}${num(d.profitFactor).padStart(18)}`);
  console.log(`${'Sharpe Ratio'.padEnd(22)}${sharpe(a.sharpeRatio).padStart(18)}${sharpe(b.sharpeRatio).padStart(18)}${sharpe(c.sharpeRatio).padStart(18)}${sharpe(d.sharpeRatio).padStart(18)}`);
  console.log(`${'Calmar Ratio'.padEnd(22)}${calmar(a.calmarRatio).padStart(18)}${calmar(b.calmarRatio).padStart(18)}${calmar(c.calmarRatio).padStart(18)}${calmar(d.calmarRatio).padStart(18)}`);
  console.log('-'.repeat(94));

  printTradeLog('AZIZ ORB+VWAP', a.trades, a.initialCapital);
  printTradeLog('VWAP REVERSION', b.trades, b.initialCapital);
  printTradeLog('TOUCH & TURN', c.trades, c.initialCapital);
  printTradeLog('PIVOT REVERT', d.trades, d.initialCapital);

  console.log('');
  console.log(`Capital: $${a.initialCapital} | Risk: 50% equity/trade (min $100) | Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share`);
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
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    console.log(`  ${t.entryDate.padEnd(12)}${side.padEnd(7)}${t.entryPrice.toFixed(2).padEnd(10)}${t.exitPrice.toFixed(2).padEnd(10)}${exitType.padEnd(14)}${pnlStr.padStart(9)}${('$' + runningEquity.toFixed(2)).padStart(10)}`);
  }
}

// ─── Scanner mode (realistic bot simulation) ───

async function runScannerMode(startDate, endDate) {
  console.log(`Scanner mode: fetching data for ${SCANNER_UNIVERSE.length} symbols...`);
  const allBars5m = {};
  const allDailyATRMaps = {};

  // Parallelize data fetching
  const fetchResults = await Promise.allSettled(SCANNER_UNIVERSE.map(async (symbol) => {
    const raw5 = await fetchBarsPaginated(symbol, '5Min', startDate, endDate);
    if (raw5.length === 0) return { symbol, error: 'no data' };
    const bars = raw5.map(norm5);

    const dailyStart = new Date(Date.parse(startDate) - 45 * 86400000).toISOString().split('T')[0];
    const rawD = await fetchBarsPaginated(symbol, '1Day', dailyStart, endDate);
    const dailyBars = rawD.map(normD);
    const dailyATRMap = computeDailyATRMap(dailyBars, 14);

    return { symbol, bars, dailyATRMap, barCount: bars.length };
  }));

  let fetched = 0;
  for (const result of fetchResults) {
    if (result.status === 'rejected') {
      console.log(`  ${'?'}: ${result.reason?.message || 'fetch error'}`);
      continue;
    }
    const { symbol, bars, dailyATRMap, barCount, error } = result.value;
    if (error) {
      console.log(`  ${symbol}: ${error}`);
      continue;
    }
    allBars5m[symbol] = bars;
    allDailyATRMaps[symbol] = dailyATRMap;
    fetched++;
    console.log(`  ${symbol}: ${barCount} bars`);
  }

  console.log(`\nFetched ${fetched}/${SCANNER_UNIVERSE.length} symbols`);

  // Run simulations for top-1, top-3, top-5 selection
  for (const topN of [1, 3, 5]) {
    const selections = computeBotSelections(allBars5m, allDailyATRMaps, topN);
    const result = runBotSimulation(allBars5m, allDailyATRMaps, selections, topN);
    printSimulationReport(result, startDate, endDate, topN);
  }
}

// Simulate the bot trading one position at a time with scanner selections
function runBotSimulation(allBars5m, allDailyATRMaps, selections, topN) {
  const config = {
    sessionEnd: 1100, hardExit: 1130, positionPct: 10, minPositionUSD: 100, initialCapital: 400,
    targetFib: 0.618, rrRatio: 2.0, atrPctThreshold: 0.25,
    riskPct: 0, dailyLossLimitPct: 3,
  };

  let equity = config.initialCapital;
  let position = null;
  const trades = [];
  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [equity];
  const perDayLog = [];
  let dailyPnl = 0;

  // Pre-index bars by (date, symbol) for fast lookup
  const barsByDateSymbol = new Map();
  const allDates = new Set();
  for (const [symbol, bars] of Object.entries(allBars5m)) {
    for (const bar of bars) {
      const dateStr = getDateStr(bar.ts);
      allDates.add(dateStr);
      const key = `${dateStr}|${symbol}`;
      if (!barsByDateSymbol.has(key)) barsByDateSymbol.set(key, []);
      barsByDateSymbol.get(key).push(bar);
    }
  }

  for (const dateStr of [...allDates].sort()) {
    const selectedToday = selections.get(dateStr) || [];
    const selectedSymbols = new Set(selectedToday.map(s => s.symbol));

    // Build opening range for each selected symbol from pre-indexed data
    const openRanges = new Map();
    for (const cand of selectedToday) {
      const key = `${dateStr}|${cand.symbol}`;
      const dayBars = barsByDateSymbol.get(key);
      if (!dayBars) continue;
      const orBars = dayBars
        .filter(b => { const hhmm = getHHMM_ET(b.ts); return hhmm >= 930 && hhmm < 945; })
        .slice(0, 3);
      if (orBars.length >= 3) {
        openRanges.set(cand.symbol, {
          high: Math.max(...orBars.map(b => b.high)),
          low: Math.min(...orBars.map(b => b.low)),
          open: orBars[0].open,
          close: orBars[2].close,
          range: Math.max(...orBars.map(b => b.high)) - Math.min(...orBars.map(b => b.low)),
        });
      }
    }

    let tradedToday = false;
    let daySymbol = selectedToday.length > 0 ? selectedToday[0].symbol : '—';
    dailyPnl = 0;

    // Process bars for selected symbols only (in time order)
    const dayBarsAll = [];
    for (const sym of selectedSymbols) {
      const key = `${dateStr}|${sym}`;
      const symBars = barsByDateSymbol.get(key) || [];
      for (const b of symBars) dayBarsAll.push({ ...b, symbol: sym });
    }
    dayBarsAll.sort((a, b) => a.ts.localeCompare(b.ts));

    for (const bar of dayBarsAll) {
      const hhmm = getHHMM_ET(bar.ts);

      // Check exit on current position
      if (position) {
        let exit = null;
        if (hhmm >= config.hardExit) {
          exit = { exitPrice: bar.close, exitType: 'EOD' };
        } else if (hhmm >= config.sessionEnd) {
          exit = { exitPrice: bar.close, exitType: 'EOD' };
        } else if (position.side === 'long') {
          if (bar.low <= position.stopPrice) exit = { exitPrice: position.stopPrice, exitType: 'SL' };
          else if (bar.high >= position.targetPrice) exit = { exitPrice: position.targetPrice, exitType: 'TP' };
        } else {
          if (bar.high >= position.stopPrice) exit = { exitPrice: position.stopPrice, exitType: 'SL' };
          else if (bar.low <= position.targetPrice) exit = { exitPrice: position.targetPrice, exitType: 'TP' };
        }

        if (exit) {
          const rawPnl = (exit.exitPrice - position.entryPrice) * position.qty * (position.side === 'short' ? -1 : 1);
          const costs = (position.entryPrice + exit.exitPrice) * position.qty * (SLIPPAGE_BPS / 10000) + position.qty * COMMISSION_PER_SHARE * 2;
          const pnl = rawPnl - costs;
          equity += pnl;
          dailyPnl += pnl;
          trades.push({
            symbol: position.symbol, side: position.side,
            entryPrice: position.entryPrice, exitPrice: exit.exitPrice,
            exitType: exit.exitType, pnl, qty: position.qty, entryDate: dateStr,
          });
          position = null;
          peakEquity = Math.max(peakEquity, equity);
          maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
          equityCurve.push(equity);

          // Daily loss limit check
          if (config.dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / equity * 100) > config.dailyLossLimitPct) {
            break; // stop trading for the day
          }
        }
      }

      // Check entry: only for scanner-selected symbols, one trade per day
      if (!position && !tradedToday && selectedSymbols.has(bar.symbol) && hhmm >= 945 && hhmm < 1100) {
        // Skip if daily loss limit hit
        if (config.dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / equity * 100) > config.dailyLossLimitPct) {
          continue;
        }

        const or = openRanges.get(bar.symbol);
        if (or && or.range > 0) {
          const dailyATR = allDailyATRMaps[bar.symbol]?.get(dateStr) || 0;
          if (dailyATR > 0 && or.range >= dailyATR * config.atrPctThreshold) {
            const isRed = or.close < or.open;
            const isGreen = or.close > or.open;
            let entry = null, side = null, target = null, stop = null;

            if (isRed && bar.low <= or.low) {
              side = 'long'; entry = or.low;
              const targetDist = config.targetFib * or.range;
              target = entry + targetDist;
              stop = entry - targetDist / config.rrRatio;
            } else if (isGreen && bar.high >= or.high) {
              side = 'short'; entry = or.high;
              const targetDist = config.targetFib * or.range;
              target = entry - targetDist;
              stop = entry + targetDist / config.rrRatio;
            }

            if (side) {
              const positionValue = Math.max(equity * config.positionPct / 100, config.minPositionUSD);
              const qty = positionValue / entry;
              position = { symbol: bar.symbol, side, entryPrice: entry, stopPrice: stop, targetPrice: target, qty };
              tradedToday = true;
              daySymbol = bar.symbol;
            }
          }
        }
      }
    }

    // Force-close any open position at end of day
    if (position) {
      const key = `${dateStr}|${position.symbol}`;
      const symBars = barsByDateSymbol.get(key) || [];
      const lastBar = symBars[symBars.length - 1];
      if (lastBar) {
        const rawPnl = (lastBar.close - position.entryPrice) * position.qty * (position.side === 'short' ? -1 : 1);
        const costs = (position.entryPrice + lastBar.close) * position.qty * (SLIPPAGE_BPS / 10000) + position.qty * COMMISSION_PER_SHARE * 2;
        const pnl = rawPnl - costs;
        equity += pnl;
        dailyPnl += pnl;
        trades.push({
          symbol: position.symbol, side: position.side,
          entryPrice: position.entryPrice, exitPrice: lastBar.close,
          exitType: 'EOD', pnl, qty: position.qty, entryDate: dateStr,
        });
      }
      position = null;
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
      equityCurve.push(equity);
    }

    perDayLog.push({ date: dateStr, selected: selectedToday.map(s => `${s.symbol}(${(s.rangeATRRatio * 100).toFixed(0)}%)`), traded: tradedToday ? daySymbol : '—' });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnL = trades.reduce((s, t) => s + t.pnl, 0);

  // Compute Sharpe and Calmar from equity curve
  const sharpeRatio = computeSharpe(equityCurve);
  const calmarRatio = computeCalmar(equityCurve, maxDrawdown);

  return {
    trades, perDayLog, topN,
    totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    equityCurve, finalEquity: equity, initialCapital: config.initialCapital,
    sharpeRatio, calmarRatio,
    daysWithSelection: selections.size,
    perSymbol: trades.reduce((acc, t) => {
      if (!acc[t.symbol]) acc[t.symbol] = { trades: [], totalTrades: 0, netPnL: 0 };
      acc[t.symbol].trades.push(t);
      acc[t.symbol].totalTrades++;
      acc[t.symbol].netPnL += t.pnl;
      return acc;
    }, {}),
  };
}

function computeSharpe(equityCurve) {
  if (equityCurve.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(252);
}

function computeCalmar(equityCurve, maxDrawdown) {
  if (maxDrawdown === 0 || equityCurve.length < 2) return 0;
  const initial = equityCurve[0];
  const final = equityCurve[equityCurve.length - 1];
  const totalReturn = (final - initial) / initial;
  const years = Math.max(equityCurve.length / 252, 1 / 252);
  const cagr = Math.pow(1 + totalReturn, 1 / years) - 1;
  return cagr / (maxDrawdown * 100 || 1);
}

function printSimulationReport(result, startDate, endDate, topN) {
  const usd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);
  const sharpe = v => v === 0 ? 'N/A' : v.toFixed(2);
  const calmar = v => v === 0 ? 'N/A' : v.toFixed(2);

  console.log('\n' + '='.repeat(76));
  console.log(`  BOT SIMULATION — Top ${topN}/day (${startDate} to ${endDate})`);
  console.log('='.repeat(76));
  console.log('');
  console.log(`  Selection: rank by range/ATR + composite | Filters: ${JSON.stringify(DEFAULT_FILTERS)}`);
  console.log(`  Capital: $${result.initialCapital} | Risk: 10% equity/trade (min $100) | Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share | Daily loss limit: 3%`);
  console.log(`  Days with selections: ${result.daysWithSelection}`);
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'Value'.padStart(18)}`);
  console.log('-'.repeat(40));
  console.log(`${'Total Trades'.padEnd(22)}${String(result.totalTrades).padStart(18)}`);
  console.log(`${'Wins'.padEnd(22)}${String(result.wins).padStart(18)}`);
  console.log(`${'Losses'.padEnd(22)}${String(result.losses).padStart(18)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(result.winRate).padStart(18)}`);
  console.log(`${'Net P&L'.padEnd(22)}${usd(result.netPnL).padStart(18)}`);
  console.log(`${'Final Equity'.padEnd(22)}${usd(result.finalEquity).padStart(18)}`);
  console.log(`${'Avg Win'.padEnd(22)}${usd(result.avgWin).padStart(18)}`);
  console.log(`${'Avg Loss'.padEnd(22)}${usd(result.avgLoss).padStart(18)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(result.maxDrawdown).padStart(18)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(result.profitFactor).padStart(18)}`);
  console.log(`${'Sharpe Ratio'.padEnd(22)}${sharpe(result.sharpeRatio).padStart(18)}`);
  console.log(`${'Calmar Ratio'.padEnd(22)}${calmar(result.calmarRatio).padStart(18)}`);
  console.log('-'.repeat(40));

  // Per-symbol breakdown
  const symbols = Object.keys(result.perSymbol).sort();
  if (symbols.length > 0) {
    console.log(`\n  Per-Symbol Breakdown`);
    console.log(`  ${'Symbol'.padEnd(8)}${'Trades'.padStart(8)}${'P&L'.padStart(10)}`);
    console.log(`  ${'------'.padEnd(8)}${'------'.padStart(8)}${'---'.padStart(10)}`);
    for (const sym of symbols) {
      const r = result.perSymbol[sym];
      console.log(`  ${sym.padEnd(8)}${String(r.totalTrades).padStart(8)}${usd(r.netPnL).padStart(10)}`);
    }
  }

  // Trade log
  if (result.trades.length > 0) {
    console.log(`\n  Trade Log`);
    console.log(`  ${'Date'.padEnd(12)}${'Symbol'.padEnd(8)}${'Side'.padEnd(7)}${'Entry'.padEnd(10)}${'Exit'.padEnd(10)}${'Type'.padEnd(6)}${'P&L'.padStart(9)}${'Equity'.padStart(10)}`);
    console.log(`  ${'----'.padEnd(12)}${'------'.padEnd(8)}${'----'.padEnd(7)}${'-----'.padEnd(10)}${'----'.padEnd(10)}${'----'.padEnd(6)}${'---'.padStart(9)}${'-------'.padStart(10)}`);
    let runEq = result.initialCapital;
    for (const t of result.trades) {
      runEq += t.pnl;
      const side = t.side === 'long' ? 'LONG' : 'SHORT';
      const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
      console.log(`  ${t.entryDate.padEnd(12)}${t.symbol.padEnd(8)}${side.padEnd(7)}${t.entryPrice.toFixed(2).padEnd(10)}${t.exitPrice.toFixed(2).padEnd(10)}${t.exitType.padEnd(6)}${pnlStr.padStart(9)}${('$' + runEq.toFixed(2)).padStart(10)}`);
    }
  }

  // Daily selection log (first 20 days)
  if (result.perDayLog.length > 0) {
    console.log(`\n  Daily Selections (first 20 days)`);
    console.log(`  ${'Date'.padEnd(12)}${'Selected'.padEnd(40)}${'Traded'.padEnd(8)}`);
    console.log(`  ${'----'.padEnd(12)}${'--------'.padEnd(40)}${'------'.padEnd(8)}`);
    for (const day of result.perDayLog.slice(0, 20)) {
      const sel = day.selected.join(', ') || '—';
      console.log(`  ${day.date.padEnd(12)}${sel.padEnd(40)}${day.traded.padEnd(8)}`);
    }
    if (result.perDayLog.length > 20) {
      console.log(`  ... and ${result.perDayLog.length - 20} more days`);
    }
  }
}

// ─── Main ───

async function main() {
  const mode = process.argv[2];

  if (mode === 'scan') {
    const startDate = process.argv[3] || new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
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
    sessionEnd: 1130, riskPct: 50, minPositionUSD: 100, initialCapital: 400,
    useAtrFilter: true,
    useRvolFilter: true, rvolThreshold: 1.5, volumeMALength: 12,
    targetR: 2.0,
  };

  const configB = {
    sessionEnd: 1130, riskPct: 50, minPositionUSD: 100, initialCapital: 400,
    atrDistMult: 1.0, stopAtrMult: 0.5,
    useRsiFilter: true, rsiMaxLong: 70, rsiMinShort: 30,
    useVolFilter: true, volumeMALength: 12,
    cooldownBars: 10,
  };

  const configC = {
    sessionEnd: 1130, riskPct: 50, minPositionUSD: 100, initialCapital: 400,
    useAtrFilter: true, atrPctThreshold: 0.25,
  };

  const configD = {
    sessionEnd: 1130, riskPct: 50, minPositionUSD: 100, initialCapital: 400,
    pivotMinRR: 1.5, pivotMaxTrades: 4, pivotStopAtrMult: 0.3,
  };

  // Build prior-day bars map for pivot levels: dateStr -> prior day { high, low, close }
  const priorDayBarsMap = new Map();
  for (let i = 1; i < dailyBars.length; i++) {
    const prevBar = dailyBars[i - 1];
    const curDate = new Date(dailyBars[i].ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const pivots = createPivots();
    pivots.setDaily({ high: prevBar.high, low: prevBar.low, close: prevBar.close });
    priorDayBarsMap.set(curDate, pivots.value());
  }
  configD._priorDayBars = priorDayBarsMap;

  console.log('Running Aziz ORB + VWAP backtest...');
  const resultA = runBacktest(bars, processBarStrategyA, createStrategyAState, configA, dailyATRMap);

  console.log('Running VWAP Reversion backtest...');
  const resultB = runBacktest(bars, processBarStrategyB, createStrategyBState, configB, dailyATRMap);

  console.log('Running Touch and Turn backtest...');
  const resultC = runBacktest(bars, processBarTouchTurn, createTouchTurnState, configC, dailyATRMap);

  console.log('Running Pivot Reversion backtest...');
  const resultD = runBacktest(bars, processBarPivotRevert, createPivotRevertState, configD, dailyATRMap);

  printReport(resultA, resultB, resultC, resultD, symbol, startDate, endDate);
}

main().catch(e => { console.error(e); process.exit(1); });