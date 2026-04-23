// tests/indicators.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSMA, createATR, createRSI, createPivots, checkPivotRejection, createSessionVWAP } from '../scripts/lib/indicators.js';

describe('createSMA', () => {
  it('returns null until buffer is full', () => {
    const sma = createSMA(3);
    sma.push(10);
    assert.equal(sma.value(), null);
    assert.equal(sma.ready(), false);
  });

  it('computes simple moving average', () => {
    const sma = createSMA(3);
    sma.push(10); sma.push(20); sma.push(30);
    assert.equal(sma.value(), 20);
    assert.equal(sma.ready(), true);
  });

  it('slides window forward', () => {
    const sma = createSMA(3);
    sma.push(10); sma.push(20); sma.push(30); sma.push(40);
    assert.equal(sma.value(), 30);
  });
});

describe('createATR', () => {
  it('returns null until buffer is full', () => {
    const atr = createATR(3);
    atr.push({ high: 10, low: 8, close: 9 });
    assert.equal(atr.value(), null);
  });

  it('computes average true range', () => {
    const atr = createATR(3);
    atr.push({ high: 10, low: 8, close: 9 });
    atr.push({ high: 12, low: 9, close: 11 });
    atr.push({ high: 11, low: 8, close: 10 });
    atr.push({ high: 13, low: 10, close: 12 });
    assert.ok(atr.value() > 0);
    assert.equal(atr.ready(), true);
  });
});

describe('createRSI', () => {
  it('returns null until seeded', () => {
    const rsi = createRSI(3);
    rsi.push(10);
    assert.equal(rsi.value(), null);
  });

  it('returns 100 when all gains', () => {
    const rsi = createRSI(3);
    rsi.push(10); rsi.push(11); rsi.push(12); rsi.push(13);
    assert.equal(rsi.value(), 100);
    assert.equal(rsi.ready(), true);
  });

  it('returns 0 when all losses', () => {
    const rsi = createRSI(3);
    rsi.push(13); rsi.push(12); rsi.push(11); rsi.push(10);
    assert.equal(rsi.value(), 0);
  });

  it('returns 50 when no price movement', () => {
    const rsi = createRSI(3);
    rsi.push(10); rsi.push(10); rsi.push(10); rsi.push(10);
    assert.equal(rsi.value(), 50);
  });
});

describe('createPivots', () => {
  it('returns null until prior day is set', () => {
    const pivots = createPivots();
    assert.equal(pivots.value(), null);
    assert.equal(pivots.ready(), false);
  });

  it('calculates floor trader pivot levels from prior day H/L/C', () => {
    const pivots = createPivots();
    // Prior day: H=110, L=100, C=105
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    assert.equal(pivots.ready(), true);

    const levels = pivots.value();
    // P = (110 + 100 + 105) / 3 = 105
    assert.equal(levels.P, 105);
    // R1 = 2*P - L = 210 - 100 = 110
    assert.equal(levels.R1, 110);
    // S1 = 2*P - H = 210 - 110 = 100
    assert.equal(levels.S1, 100);
    // R2 = P + (H - L) = 105 + 10 = 115
    assert.equal(levels.R2, 115);
    // S2 = P - (H - L) = 105 - 10 = 95
    assert.equal(levels.S2, 95);
    // R3 = H + 2*(P - L) = 110 + 2*(5) = 120
    assert.equal(levels.R3, 120);
    // S3 = L - 2*(H - P) = 100 - 2*(5) = 90
    assert.equal(levels.S3, 90);
  });

  it('updates pivots when new daily bar is set', () => {
    const pivots = createPivots();
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    const first = pivots.value();
    assert.equal(first.P, 105);

    pivots.setDaily({ high: 120, low: 108, close: 112 });
    const second = pivots.value();
    // P = (120 + 108 + 112) / 3 = 340/3 ≈ 113.33
    assert.ok(Math.abs(second.P - 113.333) < 0.01);
  });

  it('returns midpoint levels between pivot and support/resistance', () => {
    const pivots = createPivots();
    pivots.setDaily({ high: 110, low: 100, close: 105 });
    const levels = pivots.value();
    // midS1 = (S1 + P) / 2 = (100 + 105) / 2 = 102.5
    assert.equal(levels.midS1, 102.5);
    // midR1 = (P + R1) / 2 = (105 + 110) / 2 = 107.5
    assert.equal(levels.midR1, 107.5);
  });
});

describe('checkPivotRejection', () => {
  it('detects wick rejection below support (bullish)', () => {
    const result = checkPivotRejection({
      bar: { open: 99.5, high: 100.5, low: 98.5, close: 100 },
      level: 99,
      side: 'support',
      priorBars: [],
    });
    assert.equal(result.rejected, true);
    assert.equal(result.type, 'wick');
    assert.equal(result.direction, 'long');
  });

  it('detects wick rejection above resistance (bearish)', () => {
    const result = checkPivotRejection({
      bar: { open: 110.5, high: 112, low: 110, close: 110.5 },
      level: 111,
      side: 'resistance',
      priorBars: [],
    });
    assert.equal(result.rejected, true);
    assert.equal(result.type, 'wick');
    assert.equal(result.direction, 'short');
  });

  it('detects failed breakout at resistance', () => {
    const result = checkPivotRejection({
      bar: { open: 100, high: 111.5, low: 99, close: 100.5 },
      level: 110,
      side: 'resistance',
      priorBars: [
        { open: 109, high: 110.5, low: 108, close: 109.5 },
      ],
    });
    assert.equal(result.rejected, true);
    assert.equal(result.direction, 'short');
  });

  it('returns no rejection when bar cleanly breaks through', () => {
    const result = checkPivotRejection({
      bar: { open: 111, high: 113, low: 110.5, close: 112 },
      level: 110,
      side: 'resistance',
      priorBars: [],
    });
    assert.equal(result.rejected, false);
  });

  it('returns no rejection when bar is far from level', () => {
    const result = checkPivotRejection({
      bar: { open: 95, high: 96, low: 94, close: 95 },
      level: 99,
      side: 'support',
      priorBars: [],
    });
    assert.equal(result.rejected, false);
  });
});

describe('createSessionVWAP', () => {
  it('computes volume-weighted average price', () => {
    const vwap = createSessionVWAP();
    vwap.push({ high: 11, low: 9, close: 10, volume: 100 });
    vwap.push({ high: 21, low: 19, close: 20, volume: 100 });
    assert.equal(vwap.value(), 15);
  });

  it('resets on call to reset()', () => {
    const vwap = createSessionVWAP();
    vwap.push({ high: 11, low: 9, close: 10, volume: 100 });
    vwap.reset();
    assert.equal(vwap.value(), null);
  });

  it('returns null when no volume', () => {
    const vwap = createSessionVWAP();
    assert.equal(vwap.value(), null);
  });
});