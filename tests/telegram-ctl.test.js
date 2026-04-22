/**
 * Unit tests for telegram-ctl.js — command parsing, auth, status formatting.
 *
 * Run: node --test tests/telegram-ctl.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, isAuthorized } from '../scripts/telegram-ctl.js';
import { escapeHtml } from '../scripts/telegram.js';

describe('parseCommand', () => {
  it('extracts /start from plain command', () => {
    assert.equal(parseCommand('/start'), '/start');
  });

  it('extracts /stop from command with arguments', () => {
    assert.equal(parseCommand('/stop now'), '/stop');
  });

  it('extracts /status', () => {
    assert.equal(parseCommand('/status'), '/status');
  });

  it('extracts /help', () => {
    assert.equal(parseCommand('/help'), '/help');
  });

  it('returns null for non-command text', () => {
    assert.equal(parseCommand('hello'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseCommand(''), null);
  });

  it('returns null for undefined', () => {
    assert.equal(parseCommand(undefined), null);
  });

  it('handles /start with bot mention (@botname)', () => {
    assert.equal(parseCommand('/start@myScalpBot'), '/start@myscalpbot');
  });
});

describe('isAuthorized', () => {
  it('allows matching chat ID', () => {
    process.env.TELEGRAM_CHAT_ID = '1738112874';
    assert.equal(isAuthorized(1738112874), true);
  });

  it('rejects non-matching chat ID', () => {
    process.env.TELEGRAM_CHAT_ID = '1738112874';
    assert.equal(isAuthorized(999999), false);
  });

  it('handles string comparison', () => {
    process.env.TELEGRAM_CHAT_ID = '1738112874';
    assert.equal(isAuthorized('1738112874'), true);
  });
});

describe('formatStatus (inline logic test)', () => {
  // Testing the status formatting logic that's inlined in handleStatus
  function formatStatus(status, tradeLog, config) {
    let msg = status.online ? '🟢 <b>Bot is running</b>' : '🔴 <b>Bot is stopped</b>';
    if (status.online) {
      msg += `\nMode: ${config.paper} ${config.dryRun ? 'DRY RUN' : 'LIVE'}`;
      msg += `\nSymbols: ${config.symbols?.join(', ') || 'unknown'}`;
    }
    if (tradeLog.length > 0) {
      msg += '\n\n<b>Recent activity:</b>';
      for (const entry of tradeLog) {
        const prefix = { info: 'ℹ️', trade: '📊', signal: '🔔', error: '❌', win: '✅', loss: '🛑' }[entry.type] || '·';
        msg += `\n${prefix} ${escapeHtml(entry.msg)}`;
      }
    } else {
      msg += '\n\n<i>No recent activity</i>';
    }
    return msg;
  }

  it('shows running status with mode and symbols', () => {
    const msg = formatStatus(
      { online: true },
      [],
      { dryRun: true, paper: 'PAPER', symbols: ['AMD', 'SPY'] }
    );
    assert.ok(msg.includes('🟢'));
    assert.ok(msg.includes('PAPER'));
    assert.ok(msg.includes('DRY RUN'));
    assert.ok(msg.includes('AMD, SPY'));
  });

  it('shows stopped status', () => {
    const msg = formatStatus({ online: false }, [], {});
    assert.ok(msg.includes('🔴'));
    assert.ok(msg.includes('stopped'));
  });

  it('includes recent trade log entries', () => {
    const log = [
      { ts: '2026-04-17T14:30:00Z', type: 'trade', msg: 'AMD LONG: qty=10 @ $152.30' },
      { ts: '2026-04-17T14:31:00Z', type: 'signal', msg: 'SPY breakout above 510.50' },
    ];
    const msg = formatStatus({ online: true }, log, { dryRun: false, symbols: ['AMD'] });
    assert.ok(msg.includes('📊'));
    assert.ok(msg.includes('AMD LONG'));
  });

  it('shows no activity when log is empty', () => {
    const msg = formatStatus({ online: false }, [], {});
    assert.ok(msg.includes('No recent activity'));
  });

  it('escapes HTML in trade log messages', () => {
    const log = [
      { ts: '2026-04-17T14:30:00Z', type: 'info', msg: 'DAL: Skipped — range $0.67 < 25% of ATR $3.12' },
      { ts: '2026-04-17T14:31:00Z', type: 'info', msg: 'Touch & Turn Bot — PAPER' },
    ];
    const msg = formatStatus({ online: true }, log, { dryRun: false, symbols: ['AMD'] });
    assert.ok(msg.includes('&lt;'));
    assert.ok(msg.includes('&amp;'));
    assert.ok(!msg.includes('$0.67 < 25%'));
  });
});

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    assert.equal(escapeHtml('Touch & Turn'), 'Touch &amp; Turn');
  });

  it('escapes less-than', () => {
    assert.equal(escapeHtml('range < 25%'), 'range &lt; 25%');
  });

  it('escapes greater-than', () => {
    assert.equal(escapeHtml('price > 100'), 'price &gt; 100');
  });

  it('handles strings without special chars', () => {
    assert.equal(escapeHtml('INTC LONG order placed'), 'INTC LONG order placed');
  });
});

describe('orphaned position commands', () => {
  it('parseCommand handles /close_orphaned and /keep_orphaned', () => {
    assert.equal(parseCommand('/close_orphaned'), '/close_orphaned');
    assert.equal(parseCommand('/keep_orphaned'), '/keep_orphaned');
  });
});