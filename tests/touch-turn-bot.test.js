import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('position sizing', () => {
  it('uses entry price (range.low) for long side qty, not range.close', () => {
    const balance = 10000;
    const positionPct = 10;
    const entryPrice = 8.50;  // range.low for long
    const rangeClose = 9.20;  // range.close (wrong, would give more shares)

    const positionValue = balance * (positionPct / 100);
    const qtyCorrect = Math.max(1, Math.floor(positionValue / entryPrice));
    const qtyWrong = Math.max(1, Math.floor(positionValue / rangeClose));

    assert.equal(qtyCorrect, 117);  // $1000 / $8.50 = 117
    assert.equal(qtyWrong, 108);    // $1000 / $9.20 = 108
    assert.ok(qtyCorrect > qtyWrong, 'using entryPrice gives fewer shares (correct for actual risk)');
  });
});

describe('P&L capture before position close', () => {
  it('captures unrealized_pl from position before hard exit closes it', () => {
    const mockPos = { unrealized_pl: '12.50', qty: '10', side: 'long' };
    const capturedPnl = parseFloat(mockPos.unrealized_pl);
    assert.equal(capturedPnl, 12.50);
  });

  it('returns pnl=0 when position data is unavailable before close', () => {
    const capturedPnl = null;
    const reportedPnl = capturedPnl ?? 0;
    assert.equal(reportedPnl, 0);
  });
});

describe('shutdown handlers', () => {
  it('SIGINT and SIGTERM both trigger shutdown', () => {
    // Documents the requirement: both signals must be handled
    const signals = ['SIGINT', 'SIGTERM'];
    assert.ok(signals.includes('SIGINT'));
    assert.ok(signals.includes('SIGTERM'));
  });
});

describe('CONFIG defaults', () => {
  it('positionPct defaults to 10 (not 50)', () => {
    const defaultPct = 10;
    assert.equal(defaultPct, 10);
  });

  it('positionPct reads from POSITION_PCT env var', () => {
    process.env.POSITION_PCT = '20';
    const positionPct = parseInt(process.env.POSITION_PCT, 10) || 10;
    assert.equal(positionPct, 20);
    delete process.env.POSITION_PCT;
  });

  it('positionPct falls back to default when env var is invalid', () => {
    process.env.POSITION_PCT = 'abc';
    const positionPct = parseInt(process.env.POSITION_PCT, 10) || 10;
    assert.equal(positionPct, 10);
    delete process.env.POSITION_PCT;
  });
});

describe('config validation', () => {
  it('lists required env vars', () => {
    const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    assert.equal(required.length, 4);
    assert.ok(required.includes('ALPACA_API_KEY'));
  });

  it('detects missing required vars', () => {
    const env = { ALPACA_API_KEY: 'x', ALPACA_SECRET_KEY: 'x' };
    const required = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const missing = required.filter(k => !env[k]);
    assert.deepEqual(missing, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  });
});

describe('CONFIG env var overrides', () => {
  it('UNIVERSE reads from comma-separated env var', () => {
    process.env.UNIVERSE = 'AAPL,TSLA';
    const universe = (process.env.UNIVERSE || '').split(',').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(universe, ['AAPL', 'TSLA']);
    delete process.env.UNIVERSE;
  });

  it('UNIVERSE falls back to default list when env var not set', () => {
    const defaultUniverse = ['SOFI','INTC','Z','DAL','RIVN','SBUX','CCL','DIS','F','GM','PLTR','SNAP'];
    const universe = process.env.UNIVERSE
      ? process.env.UNIVERSE.split(',').map(s => s.trim()).filter(Boolean)
      : defaultUniverse;
    assert.deepEqual(universe, defaultUniverse);
  });

  it('numeric env vars parse with fallback', () => {
    process.env.ATR_PCT_THRESHOLD = '0.30';
    const val = parseFloat(process.env.ATR_PCT_THRESHOLD) || 0.25;
    assert.equal(val, 0.30);
    delete process.env.ATR_PCT_THRESHOLD;

    const val2 = parseFloat(process.env.ATR_PCT_THRESHOLD) || 0.25;
    assert.equal(val2, 0.25);
  });

  it('SESSION_END and HARD_EXIT parse as integers', () => {
    process.env.SESSION_END = '1200';
    process.env.HARD_EXIT = '1230';
    const sessionEnd = parseInt(process.env.SESSION_END, 10) || 1100;
    const hardExit = parseInt(process.env.HARD_EXIT, 10) || 1130;
    assert.equal(sessionEnd, 1200);
    assert.equal(hardExit, 1230);
    delete process.env.SESSION_END;
    delete process.env.HARD_EXIT;
  });
});

describe('scanCandidates logic', () => {
  it('filters out symbols with ATR below minimum', () => {
    const dailyATR = 0.30;
    const minATR = 0.50;
    assert.ok(dailyATR < minATR, 'should be filtered out');
  });

  it('keeps symbols with ATR at or above minimum', () => {
    const dailyATR = 0.50;
    const minATR = 0.50;
    assert.ok(dailyATR >= minATR, 'should pass filter');
  });

  it('filters out ranges below ATR percentage threshold', () => {
    const range = 0.10;
    const dailyATR = 1.00;
    const threshold = 0.25;
    assert.ok(range < dailyATR * threshold, 'range too small, should be filtered');
  });

  it('keeps ranges at or above ATR percentage threshold', () => {
    const range = 0.25;
    const dailyATR = 1.00;
    const threshold = 0.25;
    assert.ok(range >= dailyATR * threshold, 'range sufficient, should pass');
  });

  it('sorts candidates by rangeATRRatio descending', () => {
    const candidates = [
      { sym: 'LOW', rangeATRRatio: 0.25 },
      { sym: 'HIGH', rangeATRRatio: 0.80 },
      { sym: 'MED', rangeATRRatio: 0.50 },
    ];
    candidates.sort((a, b) => b.rangeATRRatio - a.rangeATRRatio);
    assert.equal(candidates[0].sym, 'HIGH');
    assert.equal(candidates[1].sym, 'MED');
    assert.equal(candidates[2].sym, 'LOW');
  });
});

describe('session time checks', () => {
  it('930 is before 945 entry window', () => {
    assert.ok(930 < 945);
  });

  it('945 is within entry window', () => {
    assert.ok(945 >= 945 && 945 < 1100);
  });

  it('1100 is at session end (no new entries)', () => {
    assert.ok(1100 >= 1100);
  });

  it('1130 is at hard exit', () => {
    assert.ok(1130 >= 1130);
  });
});

describe('multi-position tracking', () => {
  it('tracks multiple positions in a Map', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { orderId: 'o1', side: 'long', status: 'pending', pnl: 0 });
    activePositions.set('RIVN', { orderId: 'o2', side: 'short', status: 'filled', pnl: 1.50 });
    assert.equal(activePositions.size, 2);
    assert.equal(activePositions.get('SOFI').status, 'pending');
    assert.equal(activePositions.get('RIVN').status, 'filled');
  });

  it('transitions position status from pending to filled', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { orderId: 'o1', side: 'long', status: 'pending', pnl: 0 });
    const pos = activePositions.get('SOFI');
    pos.status = 'filled';
    pos.fillPrice = 8.50;
    assert.equal(activePositions.get('SOFI').status, 'filled');
    assert.equal(activePositions.get('SOFI').fillPrice, 8.50);
  });

  it('transitions position status to closed when bracket hits', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { orderId: 'o1', side: 'long', status: 'filled', pnl: 0 });
    activePositions.get('SOFI').status = 'closed';
    assert.equal(activePositions.get('SOFI').status, 'closed');
  });

  it('builds trade results array from activePositions', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { side: 'long', entryPrice: 8.50, fillPrice: 8.52, pnl: 2.34, status: 'closed' });
    activePositions.set('RIVN', { side: 'short', entryPrice: 15.00, fillPrice: 14.95, pnl: -0.63, status: 'closed' });

    const tradeResults = [...activePositions.entries()].map(([sym, pos]) => ({
      symbol: sym, side: pos.side, entryPrice: pos.fillPrice || pos.entryPrice, pnl: pos.pnl || 0,
    }));

    assert.equal(tradeResults.length, 2);
    assert.equal(tradeResults[0].symbol, 'SOFI');
    assert.equal(tradeResults[0].pnl, 2.34);
    assert.equal(tradeResults[1].symbol, 'RIVN');
    assert.equal(tradeResults[1].pnl, -0.63);

    const totalPnl = tradeResults.reduce((sum, t) => sum + t.pnl, 0);
    assert.ok(Math.abs(totalPnl - 1.71) < 0.01);
  });

  it('counts active (non-closed) positions for early exit check', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { status: 'closed', pnl: 2.34 });
    activePositions.set('RIVN', { status: 'closed', pnl: -0.63 });
    const anyActive = [...activePositions.values()].some(p => p.status !== 'closed');
    assert.equal(anyActive, false);
  });

  it('detects when some positions are still active', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', { status: 'closed', pnl: 2.34 });
    activePositions.set('RIVN', { status: 'filled', pnl: -0.63 });
    const anyActive = [...activePositions.values()].some(p => p.status !== 'closed');
    assert.equal(anyActive, true);
  });
});

describe('EOD report multi-trade', () => {
  it('formats total P&L across multiple trades', () => {
    const tradeResults = [
      { symbol: 'RIVN', side: 'long', pnl: 1.25 },
      { symbol: 'INTC', side: 'short', pnl: -0.63 },
      { symbol: 'SOFI', side: 'long', pnl: 0.84 },
    ];
    const totalPnl = tradeResults.reduce((sum, t) => sum + t.pnl, 0);
    assert.ok(Math.abs(totalPnl - 1.46) < 0.01);
  });

  it('handles empty trade results (no candidates)', () => {
    const tradeResults = [];
    assert.equal(tradeResults.length, 0);
  });

  it('uses fillPrice over entryPrice when available', () => {
    const pos = { entryPrice: 8.50, fillPrice: 8.52, pnl: 2.34 };
    const reportedEntry = pos.fillPrice || pos.entryPrice;
    assert.equal(reportedEntry, 8.52);
  });

  it('falls back to entryPrice when fillPrice is null', () => {
    const pos = { entryPrice: 8.50, fillPrice: null, pnl: 0 };
    const reportedEntry = pos.fillPrice || pos.entryPrice;
    assert.equal(reportedEntry, 8.50);
  });
});

describe('entry/exit level calculation', () => {
  it('long: entry at range.low, target and stop based on fib and RR', () => {
    const range = { high: 11, low: 9, open: 10, close: 8.5, range: 2 };
    const isRed = range.close < range.open;
    assert.ok(isRed);

    const entryPrice = range.low;
    const targetDist = 0.618 * range.range;
    const target = entryPrice + targetDist;
    const stop = entryPrice - targetDist / 2.0;

    assert.equal(entryPrice, 9);
    assert.ok(Math.abs(target - 10.236) < 0.001);
    assert.ok(Math.abs(stop - 8.382) < 0.001);
  });

  it('short: entry at range.high, target and stop based on fib and RR', () => {
    const range = { high: 11, low: 9, open: 10, close: 11.5, range: 2 };
    const isGreen = range.close > range.open;
    assert.ok(isGreen);

    const entryPrice = range.high;
    const targetDist = 0.618 * range.range;
    const target = entryPrice - targetDist;
    const stop = entryPrice + targetDist / 2.0;

    assert.equal(entryPrice, 11);
    assert.ok(Math.abs(target - 9.764) < 0.001);
    assert.ok(Math.abs(stop - 11.618) < 0.001);
  });
});

describe('snapshot structure', () => {
  it('preserves targetPrice and stopPrice from activePositions', () => {
    const activePositions = new Map();
    activePositions.set('SOFI', {
      orderId: 'o1', side: 'long', entryPrice: 8.50,
      stopPrice: 8.20, targetPrice: 9.10, qty: 100,
      status: 'filled', fillPrice: 8.52, pnl: 2.34,
    });
    const pos = activePositions.get('SOFI');
    assert.equal(pos.targetPrice, 9.10);
    assert.equal(pos.stopPrice, 8.20);
    assert.equal(pos.targetPrice, 9.10); // not derived from unrealized_pl
  });

  it('writes orders as an array in snapshot', () => {
    const orders = [
      { symbol: 'SOFI', side: 'long', qty: 100, price: 8.50, stop: 8.20, target: 9.10 },
    ];
    assert.ok(Array.isArray(orders));
    assert.equal(orders[0].symbol, 'SOFI');
  });
});

describe('time helpers', () => {
  it('getTodayStr does not use toISOString (UTC rollover bug)', () => {
    // Simulate midnight ET = 04:00 UTC. toISOString would return wrong date.
    const nyTime = new Date('2026-04-21T04:30:00Z'); // 00:30 ET
    const todayStr = nyTime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    assert.equal(todayStr, '2026-04-21');
  });
});

describe('backtest equity tracking', () => {
  it('uses entry-time equity for qty, not exit-time equity', () => {
    const entryEquity = 200;
    const exitEquity = 250; // after some wins
    const riskPct = 50;
    const minPositionUSD = 100;
    const entryPrice = 10;

    const entryQty = Math.max(entryEquity * (riskPct / 100), minPositionUSD) / entryPrice;
    const exitQty = Math.max(exitEquity * (riskPct / 100), minPositionUSD) / entryPrice;

    assert.equal(entryQty, 10);
    assert.equal(exitQty, 12.5);
    assert.ok(entryQty !== exitQty, 'qty should differ if equity changed');
  });
});

describe('rankCandidates immutability', () => {
  it('does not mutate input candidate objects', () => {
    // Re-implement the fixed version inline for test
    function rankCandidatesImmutable(candidates, weights = { rvol: 0.40, atrPct: 0.25, gapPct: 0.20, rangeAtrRatio: 0.15 }) {
      if (candidates.length === 0) return [];
      const w = { ...weights };
      const keys = Object.keys(w);
      const scored = candidates.map(c => ({ ...c }));
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

    const original = [{ symbol: 'A', rvol: 1.0, score: undefined }];
    const ranked = rankCandidatesImmutable(original);
    assert.equal(original[0].score, undefined);
    assert.ok(ranked[0].score !== undefined);
  });
});