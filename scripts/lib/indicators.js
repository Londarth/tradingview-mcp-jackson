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
      if (avgLoss === 0) return 100;
      return 100 - 100 / (1 + avgGain / avgLoss);
    },
    ready() { return avgGain !== null; },
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