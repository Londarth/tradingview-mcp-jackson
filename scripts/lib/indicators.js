// scripts/lib/indicators.js

export function createSMA(length) {
  const buf = [];
  let sum = 0;
  return {
    push(val) { buf.push(val); sum += val; if (buf.length > length) sum -= buf.shift(); },
    value() { return buf.length >= length ? sum / buf.length : null; },
    ready() { return buf.length >= length; },
  };
}

export function createATR(period) {
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

export function createRSI(period) {
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
      if (avgGain === 0 && avgLoss === 0) return 50;
      if (avgLoss === 0) return 100;
      return 100 - 100 / (1 + avgGain / avgLoss);
    },
    ready() { return avgGain !== null; },
  };
}

export function checkPivotRejection({ bar, level, side, priorBars = [] }) {
  if (side === 'support') {
    // Bullish rejection: price dips below support then closes back above
    const pierced = bar.low <= level;
    const closedAbove = bar.close > level;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const bodySize = Math.abs(bar.close - bar.open);
    const isWick = pierced && closedAbove && lowerWick > bodySize * 0.5;

    // Failed breakout: prior bar broke below, current bar snapped back
    const failedBreakout = priorBars.length > 0 &&
      priorBars.some(pb => pb.close < level) && closedAbove;

    if (isWick) return { rejected: true, type: 'wick', direction: 'long' };
    if (failedBreakout) return { rejected: true, type: 'failed_breakout', direction: 'long' };
    return { rejected: false };
  }

  if (side === 'resistance') {
    // Bearish rejection: price spikes above resistance then closes back below
    const pierced = bar.high >= level;
    const closedBelow = bar.close < level;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const bodySize = Math.abs(bar.close - bar.open);
    const isWick = pierced && closedBelow && upperWick > bodySize * 0.5;

    // Failed breakout: prior bar broke above, current bar snapped back
    const failedBreakout = priorBars.length > 0 &&
      priorBars.some(pb => pb.close > level) && closedBelow;

    if (isWick) return { rejected: true, type: 'wick', direction: 'short' };
    if (failedBreakout) return { rejected: true, type: 'failed_breakout', direction: 'short' };
    return { rejected: false };
  }

  return { rejected: false };
}

export function createPivots() {
  let prevDay = null;

  function calcLevels(bar) {
    const P = (bar.high + bar.low + bar.close) / 3;
    return {
      P,
      R1: 2 * P - bar.low,
      S1: 2 * P - bar.high,
      R2: P + (bar.high - bar.low),
      S2: P - (bar.high - bar.low),
      R3: bar.high + 2 * (P - bar.low),
      S3: bar.low - 2 * (bar.high - P),
      midS1: ((2 * P - bar.high) + P) / 2,
      midR1: (P + (2 * P - bar.low)) / 2,
    };
  }

  return {
    setDaily(bar) { prevDay = bar; },
    value() { return prevDay ? calcLevels(prevDay) : null; },
    ready() { return prevDay !== null; },
  };
}

export function createSessionVWAP() {
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