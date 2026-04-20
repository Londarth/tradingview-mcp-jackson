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

  return {
    totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100) : 0,
    netPnL, avgWin: wins.length > 0 ? totalWins / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    maxDrawdown: maxDrawdown * 100, profitFactor, equityCurve,
  };
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