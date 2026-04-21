// scripts/lib/backtest-utils.js

export function calcQty(equity, riskPct, minPositionUSD, position) {
  const positionValue = Math.max(equity * (riskPct / 100), minPositionUSD || 20);
  return positionValue / (position ? position.entryPrice : 1);
}

export function computeStats(trades, initialCapital, equityCurve, maxDrawdown) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  // Daily returns from equity curve for Sharpe calculation
  const sharpeRatio = computeSharpe(equityCurve);
  // Calmar = CAGR / max drawdown
  const calmarRatio = computeCalmar(equityCurve, maxDrawdown);

  return {
    totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100) : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100, profitFactor, equityCurve,
    sharpeRatio, calmarRatio,
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
  // Annualize: ~252 trading days, ~78 bars per day (5-min), so ~252 * 78 = 19656 bars/year
  // But equity curve points are trade exits, not bars. Use sqrt(252) for daily-like returns
  return (mean / stdDev) * Math.sqrt(252);
}

function computeCalmar(equityCurve, maxDrawdown) {
  if (maxDrawdown === 0 || equityCurve.length < 2) return 0;
  const initial = equityCurve[0];
  const final = equityCurve[equityCurve.length - 1];
  const totalReturn = (final - initial) / initial;
  // Assume roughly 252 trading days per year
  // Count unique days from trade dates if available, otherwise approximate
  const years = Math.max(equityCurve.length / 252, 1 / 252);
  const cagr = Math.pow(1 + totalReturn, 1 / years) - 1;
  return cagr / (maxDrawdown * 100 || 1);
}

export function combineSymbolResults(allResults, initialCapital) {
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

  const sharpeRatio = computeSharpe(equityCurve);
  const calmarRatio = computeCalmar(equityCurve, maxDrawdown);

  return {
    totalTrades: allTrades.length, wins: wins.length, losses: losses.length,
    winRate: allTrades.length > 0 ? (wins.length / allTrades.length * 100) : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    equityCurve, finalEquity: equity, initialCapital,
    sharpeRatio, calmarRatio,
    perSymbol: allResults,
  };
}