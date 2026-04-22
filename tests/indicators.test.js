// tests/indicators.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSMA, createATR, createRSI, createSessionVWAP } from '../scripts/lib/indicators.js';

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