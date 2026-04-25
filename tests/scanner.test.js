// tests/scanner.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidate, filterMicrostructure, DEFAULT_PIVOT_FILTERS, DEFAULT_FILTERS } from '../scripts/lib/scanner.js';

describe('filterMicrostructure', () => {
  it('accepts low-volume, high-volatility stock (WLD-like)', () => {
    const result = filterMicrostructure({
      avgVolume: 3000000,   // 3M avg daily vol — thin
      atrPct: 4.5,          // 4.5% ATR — volatile (must be >= 4.0% for DEFAULT_PIVOT_FILTERS)
      price: 12.50,         // in sweet spot
    });
    assert.equal(result.passed, true);
  });

  it('rejects high-volume stock (too liquid, pivots steamrolled)', () => {
    const result = filterMicrostructure({
      avgVolume: 50000000,  // 50M — institutional liquidity
      atrPct: 1.5,
      price: 180,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('volume'));
  });

  it('rejects low-volatility stock (pivots dont get tested)', () => {
    const result = filterMicrostructure({
      avgVolume: 4000000,
      atrPct: 0.8,          // 0.8% — not volatile enough
      price: 250,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('ATR%'));
  });

  it('rejects very low price (micro-cap noise)', () => {
    const result = filterMicrostructure({
      avgVolume: 3000000,
      atrPct: 4.0,
      price: 1.50,
    });
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes('price'));
  });

  it('uses DEFAULT_PIVOT_FILTERS when none provided', () => {
    assert.ok(DEFAULT_PIVOT_FILTERS.maxAvgVolume);
    assert.ok(DEFAULT_PIVOT_FILTERS.minATRPct);
  });
});