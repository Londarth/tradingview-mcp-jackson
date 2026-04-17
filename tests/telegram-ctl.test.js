/**
 * Unit tests for telegram-ctl.js — command parsing, auth, status formatting.
 * Does NOT test the polling loop or PM2 execution (integration-level).
 *
 * Run: node --test tests/telegram-ctl.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We'll import from telegram-ctl.js once it exists.
// For now, define the functions inline and test the expected behavior.

describe('parseCommand', () => {
  // parseCommand extracts the command word from a Telegram message text
  function parseCommand(text) {
    if (!text || !text.startsWith('/')) return null;
    const parts = text.trim().split(/\s+/);
    return parts[0].toLowerCase();
  }

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
  // isAuthorized checks if a chat ID matches the allowed CHAT_ID
  function isAuthorized(chatId, allowedId) {
    return String(chatId) === String(allowedId);
  }

  it('allows matching chat ID', () => {
    assert.equal(isAuthorized(1738112874, '1738112874'), true);
  });

  it('rejects non-matching chat ID', () => {
    assert.equal(isAuthorized(999999, '1738112874'), false);
  });

  it('handles number vs string comparison', () => {
    assert.equal(isAuthorized('1738112874', 1738112874), true);
  });
});

describe('formatStatus', () => {
  // formatStatus builds the /status reply from PM2 info + trade log
  function formatStatus(pm2Status, tradeLog, config) {
    const running = pm2Status === 'online';
    const mode = config?.dryRun ? 'DRY RUN' : 'LIVE';
    const paper = config?.paper !== false ? 'PAPER' : 'LIVE';

    let msg = running ? '🟢 Bot is running' : '🔴 Bot is stopped';
    if (running) {
      msg += `\nMode: ${paper}${config?.dryRun ? ' (DRY RUN)' : ''}`;
      msg += `\nSymbols: ${config?.symbols?.join(', ') || 'unknown'}`;
    }

    if (tradeLog && tradeLog.length > 0) {
      const last10 = tradeLog.slice(-10);
      msg += '\n\n<b>Recent activity:</b>';
      for (const entry of last10) {
        const prefix = { info: 'ℹ️', trade: '📊', signal: '🔔', error: '❌', win: '✅', loss: '🛑' }[entry.type] || '·';
        msg += `\n${prefix} ${entry.msg}`;
      }
    } else {
      msg += '\n\n<i>No recent activity</i>';
    }
    return msg;
  }

  it('shows running status with mode and symbols', () => {
    const msg = formatStatus('online', [], { dryRun: true, paper: true, symbols: ['AMD', 'SPY'] });
    assert.ok(msg.includes('🟢 Bot is running'));
    assert.ok(msg.includes('PAPER'));
    assert.ok(msg.includes('DRY RUN'));
    assert.ok(msg.includes('AMD, SPY'));
  });

  it('shows stopped status', () => {
    const msg = formatStatus('stopped', [], {});
    assert.ok(msg.includes('🔴 Bot is stopped'));
  });

  it('includes recent trade log entries', () => {
    const log = [
      { ts: '2026-04-17T14:30:00Z', type: 'trade', msg: 'AMD LONG: qty=10 @ $152.30' },
      { ts: '2026-04-17T14:31:00Z', type: 'signal', msg: 'SPY breakout above 510.50' },
    ];
    const msg = formatStatus('online', log, { dryRun: false, symbols: ['AMD'] });
    assert.ok(msg.includes('📊 AMD LONG'));
    assert.ok(msg.includes('🔔 SPY breakout'));
  });

  it('shows no activity when log is empty', () => {
    const msg = formatStatus('stopped', [], {});
    assert.ok(msg.includes('No recent activity'));
  });
});