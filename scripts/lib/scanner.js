// scripts/lib/scanner.js
// Shared scanner logic for pre-market scan and backtest

export const DEFAULT_WEIGHTS = { rvol: 0.40, atrPct: 0.25, gapPct: 0.20, rangeAtrRatio: 0.15 };

export const DEFAULT_FILTERS = {
  minPrice: 2,
  maxPrice: 100,
  minATR: 0.50,
  minATRPct: 1.5,
  maxATRPct: 8.0,
  minGapPct: 0,       // zero gap is fine for T&T (range matters, not gap)
  maxGapPct: 15,       // extreme gaps = exhaustion risk
  atrPctThreshold: 0.25,
};

// Filter a single candidate. Returns { passed, reason }.
export function filterCandidate({ symbol, dailyATR, price, prevClose, openPrice, rangeHigh, rangeLow, rangeOpen, rangeClose }, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const range = rangeHigh - rangeLow;

  if (price < f.minPrice) return { passed: false, reason: `price $${price.toFixed(2)} < $${f.minPrice}` };
  if (price > f.maxPrice) return { passed: false, reason: `price $${price.toFixed(2)} > $${f.maxPrice}` };
  if (!dailyATR || dailyATR < f.minATR) return { passed: false, reason: `ATR $${dailyATR?.toFixed(2) ?? 'N/A'} < $${f.minATR}` };

  const atrPct = dailyATR / price * 100;
  if (atrPct < f.minATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% < ${f.minATRPct}%` };
  if (atrPct > f.maxATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% > ${f.maxATRPct}%` };

  if (prevClose !== null && prevClose > 0) {
    const gapPct = Math.abs(openPrice - prevClose) / prevClose * 100;
    if (gapPct > f.maxGapPct) return { passed: false, reason: `gap ${gapPct.toFixed(1)}% > ${f.maxGapPct}%` };
  }

  if (range < dailyATR * f.atrPctThreshold) return { passed: false, reason: `range $${range.toFixed(2)} < ${f.atrPctThreshold * 100}% of ATR` };

  const isRed = rangeClose < rangeOpen;
  const isGreen = rangeClose > rangeOpen;
  if (!isRed && !isGreen) return { passed: false, reason: 'doji opening candle' };

  return { passed: true, reason: `${isRed ? 'RED→LONG' : 'GREEN→SHORT'}` };
}

// Rank candidates by composite score. Each factor is normalized to 0-100 within the group.
export function rankCandidates(candidates, weights = DEFAULT_WEIGHTS) {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    const scored = [{ ...candidates[0], score: 100 }];
    return scored;
  }

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const keys = Object.keys(w);

  // Clone candidates so we don't mutate caller's data
  const scored = candidates.map(c => ({ ...c }));

  // Normalize each metric to 0-100 rank
  for (const key of keys) {
    const values = scored.map(c => c[key] ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    for (const c of scored) {
      c[`_${key}Rank`] = ((c[key] ?? 0) - min) / range * 100;
    }
  }

  for (const c of scored) {
    c.score = keys.reduce((sum, key) => sum + w[key] * (c[`_${key}Rank`] ?? 0), 0);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}