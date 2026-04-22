#!/usr/bin/env node
import 'dotenv/config';
import { fetchBarsPaginated, normD, computeDailyATRMap } from './lib/alpaca-data.js';
import { createSMA, createATR, createRSI } from './lib/indicators.js';
import { computeStats, combineSymbolResults } from './lib/backtest-utils.js';
import { getDateStr } from './lib/time.js';

const SLIPPAGE_BPS = parseFloat(process.env.SLIPPAGE_BPS) || 5;
const COMMISSION_PER_SHARE = parseFloat(process.env.COMMISSION_PER_SHARE) || 0.005;

function applyCosts(entryPrice, exitPrice, qty) {
  const slippageCost = (entryPrice + exitPrice) * qty * (SLIPPAGE_BPS / 10000);
  const commissionCost = qty * COMMISSION_PER_SHARE * 2;
  return slippageCost + commissionCost;
}

const ETF_UNIVERSE = ['SPY', 'QQQ', 'DIA', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLU'];
const STOCK_UNIVERSE = ['SOFI', 'INTC', 'Z', 'DAL', 'RIVN', 'SBUX', 'CCL'];
const FULL_UNIVERSE = [...ETF_UNIVERSE, ...STOCK_UNIVERSE];

// ─── Indicator closures (swing-specific) ───

function createEMA(length) {
  const buf = [];
  let ema = null;
  let sum = 0;
  return {
    push(val) {
      if (ema !== null) {
        const k = 2 / (length + 1);
        ema = val * k + ema * (1 - k);
      } else {
        buf.push(val);
        sum += val;
        if (buf.length >= length) {
          ema = sum / length;
        }
      }
    },
    value() { return ema; },
    ready() { return ema !== null; },
  };
}

function createNDayHigh(period) {
  const buf = [];
  return {
    push(bar) {
      buf.push(bar.high);
      if (buf.length > period) buf.shift();
    },
    value() { return buf.length >= period ? Math.max(...buf) : null; },
    isNewHigh(bar) { return buf.length >= period && bar.high >= Math.max(...buf); },
    ready() { return buf.length >= period; },
  };
}

function computeIBS(bar) {
  const range = bar.high - bar.low;
  return range > 0 ? (bar.close - bar.low) / range : 0.5;
}

// ─── Swing exit check ───

function checkSwingExit(bar, position, barsInPosition, prevBarHigh, ind) {
  const atr = ind.atr.value();

  if (position.strategy === 'crsi2') {
    // Exit: close > SMA(5)
    const sma5Val = ind.sma5.value();
    if (sma5Val && bar.close > sma5Val) return { closed: true, exitPrice: bar.close, exitType: 'target' };
    return { closed: false };
  }

  if (position.strategy === 'ibs') {
    // Exit: IBS > 0.8 OR held >= 3 bars
    const ibs = computeIBS(bar);
    if (ibs > 0.8) return { closed: true, exitPrice: bar.close, exitType: 'target' };
    if (barsInPosition >= 3) return { closed: true, exitPrice: bar.close, exitType: 'time' };
    // Stop: 1x ATR below entry
    if (atr && bar.low <= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    return { closed: false };
  }

  if (position.strategy === 'failed_breakout') {
    // Exit: close > yesterday's high OR held >= 4 bars
    if (prevBarHigh !== null && bar.close > prevBarHigh) return { closed: true, exitPrice: bar.close, exitType: 'target' };
    if (barsInPosition >= 4) return { closed: true, exitPrice: bar.close, exitType: 'time' };
    // Stop: 1.5x ATR below entry
    if (atr && bar.low <= position.stopPrice) return { closed: true, exitPrice: position.stopPrice, exitType: 'stop' };
    return { closed: false };
  }

  return { closed: false };
}

// ─── Strategy 1: Connors RSI(2) Mean Reversion ───

function createCRSI2State() {
  return {};
}

function processBarCRSI2(bar, state, ind) {
  const { sma200, rsi2, sma5 } = ind;
  if (!sma200.ready() || !rsi2.ready()) return { action: 'none' };

  const sma200Val = sma200.value();
  const rsi2Val = rsi2.value();

  // Long only: price > 200-SMA AND RSI(2) < 5
  if (bar.close > sma200Val && rsi2Val < 5) {
    return { action: 'enter', side: 'long', strategy: 'crsi2' };
  }

  return { action: 'none' };
}

// ─── Strategy 2: IBS Mean Reversion ───

function createIBSState() {
  return {};
}

function processBarIBS(bar, state, ind) {
  const { sma200, atr } = ind;
  if (!sma200.ready() || !atr.ready()) return { action: 'none' };

  const sma200Val = sma200.value();
  const atrVal = atr.value();

  // Long only: IBS < 0.2 AND price > 200-SMA
  const ibs = computeIBS(bar);
  if (ibs < 0.2 && bar.close > sma200Val) {
    const stop = bar.close - atrVal * 1.0;
    return { action: 'enter', side: 'long', strategy: 'ibs', stop };
  }

  return { action: 'none' };
}

// ─── Strategy 3: Failed 10-Day Breakout ───

function createFailedBreakoutState() {
  return {};
}

function processBarFailedBreakout(bar, state, ind) {
  const { nDayHigh, atr } = ind;
  if (!nDayHigh.ready() || !atr.ready()) return { action: 'none' };

  const atrVal = atr.value();
  const isNewHigh = nDayHigh.isNewHigh(bar);
  const ibs = computeIBS(bar);

  // Long: new 10-day high AND IBS < 0.15
  if (isNewHigh && ibs < 0.15) {
    const stop = bar.close - atrVal * 1.5;
    return { action: 'enter', side: 'long', strategy: 'failed_breakout', stop };
  }

  return { action: 'none' };
}

// ─── Swing simulation engine ───

function runSwingBacktest(bars, processBarFn, stateInitFn, config, startDate) {
  const initialCapital = config.initialCapital || 250;
  let equity = initialCapital;
  let position = null;
  let barsInPosition = 0;
  let prevBarHigh = null;
  const trades = [];
  let state = stateInitFn();

  const sma200 = createSMA(200);
  const sma5 = createSMA(5);
  const rsi2 = createRSI(2);
  const atr = createATR(14);
  const nDayHigh = createNDayHigh(10);

  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [equity];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barDate = getDateStr(bar.ts);

    // Update indicators
    sma200.push(bar.close);
    sma5.push(bar.close);
    rsi2.push(bar.close);
    atr.push(bar);
    nDayHigh.push(bar);

    const ind = { sma200, sma5, rsi2, atr, nDayHigh };

    // Check exits first
    if (position) {
      barsInPosition++;
      const exit = checkSwingExit(bar, position, barsInPosition, prevBarHigh, ind);
      if (exit.closed) {
        const costs = applyCosts(position.entryPrice, exit.exitPrice, position.qty);
        const pnl = (exit.exitPrice - position.entryPrice) * position.qty - costs;
        equity += pnl;
        trades.push({
          ...position, exitPrice: exit.exitPrice, exitType: exit.exitType,
          pnl, barsHeld: barsInPosition, costs,
        });
        position = null;
        barsInPosition = 0;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
        equityCurve.push(equity);
      }
    }

    // Check entries (only within test period)
    if (!position && barDate >= startDate) {
      const signal = processBarFn(bar, state, ind);
      if (signal.action === 'enter') {
        const positionValue = Math.max(equity * (config.riskPct / 100), config.minPositionUSD || 25);
        const qty = positionValue / bar.close;
        position = {
          side: signal.side, entryPrice: bar.close,
          strategy: signal.strategy,
          stopPrice: signal.stop || null,
          entryDate: barDate,
          qty,
        };
        barsInPosition = 0;
      }
    }

    prevBarHigh = bar.high;
  }

  // Force-close at end of data
  if (position) {
    const lastBar = bars[bars.length - 1];
    const costs = applyCosts(position.entryPrice, lastBar.close, position.qty);
    const pnl = (lastBar.close - position.entryPrice) * position.qty - costs;
    equity += pnl;
    trades.push({
      ...position, exitPrice: lastBar.close, exitType: 'data_end',
      pnl, barsHeld: barsInPosition, costs,
    });
    equityCurve.push(equity);
  }

  return { trades, ...computeStats(trades, initialCapital, equityCurve, maxDrawdown), finalEquity: equity, initialCapital };
}

// ─── Reporting ───

function printSwingReport(results, symbol, startDate, endDate) {
  const usd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);

  const [crsi2, ibs, fb] = results;

  console.log('='.repeat(70));
  console.log(`  SWING BACKTEST: ${symbol}  (${startDate} to ${endDate})`);
  console.log('='.repeat(70));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'CRSI(2)'.padStart(16)}${'IBS'.padStart(16)}${'Fail Breakout'.padStart(16)}`);
  console.log('-'.repeat(70));
  console.log(`${'Total Trades'.padEnd(22)}${String(crsi2.totalTrades).padStart(16)}${String(ibs.totalTrades).padStart(16)}${String(fb.totalTrades).padStart(16)}`);
  console.log(`${'Wins'.padEnd(22)}${String(crsi2.wins).padStart(16)}${String(ibs.wins).padStart(16)}${String(fb.wins).padStart(16)}`);
  console.log(`${'Losses'.padEnd(22)}${String(crsi2.losses).padStart(16)}${String(ibs.losses).padStart(16)}${String(fb.losses).padStart(16)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(crsi2.winRate).padStart(16)}${pct(ibs.winRate).padStart(16)}${pct(fb.winRate).padStart(16)}`);
  console.log(`${'Net P&L'.padEnd(22)}${usd(crsi2.netPnL).padStart(16)}${usd(ibs.netPnL).padStart(16)}${usd(fb.netPnL).padStart(16)}`);
  console.log(`${'Final Equity'.padEnd(22)}${usd(crsi2.finalEquity).padStart(16)}${usd(ibs.finalEquity).padStart(16)}${usd(fb.finalEquity).padStart(16)}`);
  console.log(`${'Avg Win'.padEnd(22)}${usd(crsi2.avgWin).padStart(16)}${usd(ibs.avgWin).padStart(16)}${usd(fb.avgWin).padStart(16)}`);
  console.log(`${'Avg Loss'.padEnd(22)}${usd(crsi2.avgLoss).padStart(16)}${usd(ibs.avgLoss).padStart(16)}${usd(fb.avgLoss).padStart(16)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(crsi2.maxDrawdown).padStart(16)}${pct(ibs.maxDrawdown).padStart(16)}${pct(fb.maxDrawdown).padStart(16)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(crsi2.profitFactor).padStart(16)}${num(ibs.profitFactor).padStart(16)}${num(fb.profitFactor).padStart(16)}`);
  console.log('-'.repeat(70));

  printSwingTradeLog('CRSI(2)', crsi2.trades, crsi2.initialCapital);
  printSwingTradeLog('IBS', ibs.trades, ibs.initialCapital);
  printSwingTradeLog('FAIL BREAKOUT', fb.trades, fb.initialCapital);

  console.log('');
  console.log(`Capital: $${crsi2.initialCapital} | Risk: ${crsi2.initialCapital * 0.15 / crsi2.initialCapital * 100}% equity/trade (min $25) | Daily bars | Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share`);
}

function printSwingTradeLog(name, trades, initialCapital) {
  if (!trades || trades.length === 0) {
    console.log(`\n  ${name} — No trades`);
    return;
  }
  console.log('');
  console.log(`  ${name} — Trade Log`);
  console.log(`  ${'Date'.padEnd(12)}${'Side'.padEnd(7)}${'Entry'.padEnd(10)}${'Exit'.padEnd(10)}${'Type'.padEnd(10)}${'Held'.padEnd(5)}${'P&L'.padStart(9)}${'Equity'.padStart(10)}`);
  console.log(`  ${'----'.padEnd(12)}${'----'.padEnd(7)}${'-----'.padEnd(10)}${'----'.padEnd(10)}${'----'.padEnd(10)}${'---'.padEnd(5)}${'---'.padStart(9)}${'-------'.padStart(10)}`);

  let runningEquity = initialCapital;
  for (const t of trades) {
    runningEquity += t.pnl;
    const side = t.side === 'long' ? 'LONG' : 'SHORT';
    const exitType = t.exitType === 'target' ? 'TP' : t.exitType === 'stop' ? 'SL' : t.exitType === 'time' ? 'TIME' : 'END';
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    console.log(`  ${t.entryDate.padEnd(12)}${side.padEnd(7)}${t.entryPrice.toFixed(2).padEnd(10)}${t.exitPrice.toFixed(2).padEnd(10)}${exitType.padEnd(10)}${String(t.barsHeld).padEnd(5)}${pnlStr.padStart(9)}${('$' + runningEquity.toFixed(2)).padStart(10)}`);
  }
}

// ─── Scanner mode ───

async function runScannerMode(startDate, endDate) {
  const lookbackStart = new Date(Date.parse(startDate) - 400 * 86400000).toISOString().split('T')[0];
  const universe = FULL_UNIVERSE;

  console.log(`Swing scanner: fetching daily bars for ${universe.length} symbols...`);
  console.log(`  Lookback: ${lookbackStart} (for 200-SMA warmup)`);
  console.log(`  Test period: ${startDate} to ${endDate}\n`);

  const config = { initialCapital: 250, riskPct: 15, minPositionUSD: 25 };
  const allResultsCRSI2 = {};
  const allResultsIBS = {};
  const allResultsFB = {};
  let fetched = 0;

  for (const symbol of universe) {
    try {
      const rawD = await fetchBarsPaginated(symbol, '1Day', lookbackStart, endDate);
      if (rawD.length === 0) { console.log(`  ${symbol}: no data`); continue; }
      const bars = rawD.map(normD);
      console.log(`  ${symbol}: ${bars.length} daily bars`);
      fetched++;

      allResultsCRSI2[symbol] = runSwingBacktest(bars, processBarCRSI2, createCRSI2State, config, startDate);
      allResultsIBS[symbol] = runSwingBacktest(bars, processBarIBS, createIBSState, config, startDate);
      allResultsFB[symbol] = runSwingBacktest(bars, processBarFailedBreakout, createFailedBreakoutState, config, startDate);
    } catch (e) {
      console.log(`  ${symbol}: ${e.message}`);
    }
  }

  console.log(`\nFetched ${fetched}/${universe.length} symbols`);

  const combinedCRSI2 = combineSymbolResults(allResultsCRSI2, config.initialCapital);
  const combinedIBS = combineSymbolResults(allResultsIBS, config.initialCapital);
  const combinedFB = combineSymbolResults(allResultsFB, config.initialCapital);

  printScannerReport([combinedCRSI2, combinedIBS, combinedFB], startDate, endDate);
}

function printScannerReport(results, startDate, endDate) {
  const usd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
  const pct = v => v.toFixed(1) + '%';
  const num = v => v.toFixed(2);

  const [crsi2, ibs, fb] = results;

  console.log('\n' + '='.repeat(70));
  console.log(`  SWING SCANNER (${startDate} to ${endDate})`);
  console.log('='.repeat(70));
  console.log('');
  console.log(`${'Metric'.padEnd(22)}${'CRSI(2)'.padStart(16)}${'IBS'.padStart(16)}${'Fail Breakout'.padStart(16)}`);
  console.log('-'.repeat(70));
  console.log(`${'Total Trades'.padEnd(22)}${String(crsi2.totalTrades).padStart(16)}${String(ibs.totalTrades).padStart(16)}${String(fb.totalTrades).padStart(16)}`);
  console.log(`${'Wins'.padEnd(22)}${String(crsi2.wins).padStart(16)}${String(ibs.wins).padStart(16)}${String(fb.wins).padStart(16)}`);
  console.log(`${'Losses'.padEnd(22)}${String(crsi2.losses).padStart(16)}${String(ibs.losses).padStart(16)}${String(fb.losses).padStart(16)}`);
  console.log(`${'Win Rate'.padEnd(22)}${pct(crsi2.winRate).padStart(16)}${pct(ibs.winRate).padStart(16)}${pct(fb.winRate).padStart(16)}`);
  console.log(`${'Net P&L'.padEnd(22)}${usd(crsi2.netPnL).padStart(16)}${usd(ibs.netPnL).padStart(16)}${usd(fb.netPnL).padStart(16)}`);
  console.log(`${'Final Equity'.padEnd(22)}${usd(crsi2.finalEquity).padStart(16)}${usd(ibs.finalEquity).padStart(16)}${usd(fb.finalEquity).padStart(16)}`);
  console.log(`${'Max Drawdown'.padEnd(22)}${pct(crsi2.maxDrawdown).padStart(16)}${pct(ibs.maxDrawdown).padStart(16)}${pct(fb.maxDrawdown).padStart(16)}`);
  console.log(`${'Profit Factor'.padEnd(22)}${num(crsi2.profitFactor).padStart(16)}${num(ibs.profitFactor).padStart(16)}${num(fb.profitFactor).padStart(16)}`);
  console.log('-'.repeat(70));

  // Per-symbol breakdown for each strategy
  for (const [name, data] of [['CRSI(2)', crsi2], ['IBS', ibs], ['FAIL BREAKOUT', fb]]) {
    const symbols = Object.keys(data.perSymbol || {}).filter(s => data.perSymbol[s].totalTrades > 0);
    if (symbols.length === 0) continue;

    console.log(`\n  ${name} — Per-Symbol Breakdown`);
    console.log(`  ${'Symbol'.padEnd(8)}${'Trades'.padStart(8)}${'WR%'.padStart(8)}${'P&L'.padStart(10)}${'PF'.padStart(8)}`);
    console.log(`  ${'------'.padEnd(8)}${'------'.padStart(8)}${'---'.padStart(8)}${'---'.padStart(10)}${'--'.padStart(8)}`);
    for (const sym of symbols.sort()) {
      const r = data.perSymbol[sym];
      console.log(`  ${sym.padEnd(8)}${String(r.totalTrades).padStart(8)}${pct(r.winRate).padStart(8)}${usd(r.netPnL).padStart(10)}${num(r.profitFactor).padStart(8)}`);
    }
  }

  console.log(`\nCapital: $${crsi2.initialCapital} | Risk: 15% equity/trade (min $25) | Daily bars | Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share`);
}

// ─── Main ───

async function main() {
  const mode = process.argv[2];

  if (mode === 'scan') {
    const startDate = process.argv[3] || new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];
    const endDate = process.argv[4] || new Date().toISOString().split('T')[0];
    await runScannerMode(startDate, endDate);
    return;
  }

  const symbol = mode || 'SPY';
  const endDate = process.argv[4] || new Date().toISOString().split('T')[0];
  const startDate = process.argv[3] || new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];

  // Look back 400 days before start for 200-SMA warmup
  const lookbackStart = new Date(Date.parse(startDate) - 400 * 86400000).toISOString().split('T')[0];

  console.log(`Fetching ${symbol} daily bars (${lookbackStart} to ${endDate})...`);
  console.log(`  Warmup: ${lookbackStart} → ${startDate} (200-SMA)`);
  console.log(`  Test: ${startDate} → ${endDate}`);

  const rawD = await fetchBarsPaginated(symbol, '1Day', lookbackStart, endDate);
  const bars = rawD.map(normD);
  console.log(`  Got ${bars.length} daily bars`);

  const config = { initialCapital: 250, riskPct: 15, minPositionUSD: 25 };

  console.log('Running Connors RSI(2)...');
  const resultCRSI2 = runSwingBacktest(bars, processBarCRSI2, createCRSI2State, config, startDate);

  console.log('Running IBS Mean Reversion...');
  const resultIBS = runSwingBacktest(bars, processBarIBS, createIBSState, config, startDate);

  console.log('Running Failed 10-Day Breakout...');
  const resultFB = runSwingBacktest(bars, processBarFailedBreakout, createFailedBreakoutState, config, startDate);

  printSwingReport([resultCRSI2, resultIBS, resultFB], symbol, startDate, endDate);
}

main().catch(e => { console.error(e); process.exit(1); });