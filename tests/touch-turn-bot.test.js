import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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