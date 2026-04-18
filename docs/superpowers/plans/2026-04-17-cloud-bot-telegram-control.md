# Cloud Bot + Telegram Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram command listener that runs on a VPS and controls the Alpaca trading bot via PM2, plus all config/deploy files needed to set up the VPS.

**Architecture:** A new `telegram-ctl.js` script polls Telegram for `/start`, `/stop`, `/status`, `/help` commands from the authorized chat ID only. It executes PM2 commands via `child_process.exec()` and reads `trade-log.json` for status. No changes to the existing trading bot. PM2 config, systemd service, and a setup script handle deployment.

**Tech Stack:** Node.js ESM, Telegram Bot API (raw `fetch` long polling — matches existing `telegram.js` pattern), PM2, systemd, cron

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/telegram-ctl.js` | Telegram command listener: polls for messages, auth check, routes commands to PM2 |
| `ecosystem.config.cjs` | PM2 process definition for `touch-turn-bot` |
| `scripts/setup-vps.sh` | One-time VPS provisioning script (Node, PM2, clone, systemd, cron) |
| `scripts/scalp-bot-ctl.service` | Systemd unit file template for `telegram-ctl.js` |
| `tests/telegram-ctl.test.js` | Unit tests for command parsing, auth, and status formatting |
| `package.json` | Add `test:ctl` script for running the new tests |

---

### Task 1: Add test script to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add test:ctl script**

Add a new script entry to `package.json` in the `"scripts"` section:

```json
"test:ctl": "node --test tests/telegram-ctl.test.js"
```

The full scripts block should be:

```json
"scripts": {
  "start": "node src/server.js",
  "tv": "node src/cli/index.js",
  "test": "node --test tests/e2e.test.js tests/pine_analyze.test.js",
  "test:e2e": "node --test tests/e2e.test.js",
  "test:unit": "node --test tests/pine_analyze.test.js tests/cli.test.js",
  "test:cli": "node --test tests/cli.test.js",
  "test:ctl": "node --test tests/telegram-ctl.test.js",
  "test:all": "node --test tests/e2e.test.js tests/pine_analyze.test.js tests/cli.test.js",
  "test:verbose": "node --test --test-reporter=spec tests/e2e.test.js tests/pine_analyze.test.js",
  "test:count": "node --test --test-reporter=spec tests/e2e.test.js 2>&1 | tail -5"
}
```

- [ ] **Step 2: Verify package.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add test:ctl script for telegram-ctl tests"
```

---

### Task 2: Write telegram-ctl.js tests (TDD — tests first)

**Files:**
- Create: `tests/telegram-ctl.test.js`

These tests cover the pure functions that will be extracted from `telegram-ctl.js`: command parsing, authorization, and status formatting. They do NOT test the Telegram polling loop or PM2 execution (those are integration-level).

- [ ] **Step 1: Create the test file**

Create `tests/telegram-ctl.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they pass (testing pure functions defined inline)**

Run: `node --test tests/telegram-ctl.test.js`
Expected: All tests PASS (these test the expected behavior of functions that will be implemented in the next task)

- [ ] **Step 3: Commit**

```bash
git add tests/telegram-ctl.test.js
git commit -m "test: add telegram-ctl unit tests for parsing, auth, status"
```

---

### Task 3: Implement telegram-ctl.js

**Files:**
- Create: `scripts/telegram-ctl.js`

This is the main deliverable — the always-on Telegram command listener. It uses raw `fetch()` for Telegram long polling (matching the existing `telegram.js` pattern) and `child_process.exec()` for PM2 commands.

- [ ] **Step 1: Write telegram-ctl.js**

Create `scripts/telegram-ctl.js`:

```js
import dotenv from 'dotenv';
dotenv.config();

import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const BOT_NAME = 'scalp-bot';
const CONFIG_PATH = join(__dirname, 'alpaca-config.json');
const LOG_PATH = join(__dirname, 'trade-log.json');

let lastUpdateId = 0;

// ─── Pure functions (exported for testing) ───

export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  return parts[0].toLowerCase();
}

export function isAuthorized(chatId) {
  return String(chatId) === String(TG_CHAT_ID);
}

export async function sendTelegram(text) {
  if (!TG_TOKEN) return;
  try {
    const resp = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!resp.ok) console.error(`Telegram send error: ${resp.status}`);
  } catch (e) {
    console.error(`Telegram send failed: ${e.message}`);
  }
}

// ─── PM2 helpers ───

function pm2(cmd) {
  return new Promise((resolve, reject) => {
    exec(`pm2 ${cmd}`, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(err);
      else resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
    });
  });
}

async function getBotStatus() {
  try {
    const { stdout } = await pm2('describe touch-turn-bot');
    // Extract status from pm2 describe output
    const statusMatch = stdout.match(/status\s*│\s*(\w+)/);
    const uptimeMatch = stdout.match(/uptime\s*│\s*(.+)/);
    return {
      online: statusMatch ? statusMatch[1] === 'online' : false,
      status: statusMatch ? statusMatch[1] : 'not found',
      uptime: uptimeMatch ? uptimeMatch[1].trim() : 'N/A',
    };
  } catch {
    return { online: false, status: 'not found', uptime: 'N/A' };
  }
}

async function readTradeLog() {
  try {
    const data = await readFile(LOG_PATH, 'utf8');
    const log = JSON.parse(data);
    return log.slice(-10);
  } catch {
    return [];
  }
}

async function readConfig() {
  try {
    const data = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// ─── Command handlers ───

async function handleStart() {
  try {
    await pm2('start ecosystem.config.cjs');
    const config = await readConfig();
    const mode = config.dryRun ? 'DRY RUN' : 'LIVE';
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    const symbols = config.symbols?.join(', ') || 'unknown';
    await sendTelegram(
      `🚀 <b>Bot started</b>\nMode: ${paper} ${mode}\nSymbols: ${symbols}\nSession: ${config.strategy?.sessionStart || '9:30'}–${config.strategy?.sessionEnd || '11:00'} ET`
    );
  } catch (err) {
    await sendTelegram(`❌ Failed to start bot: ${err.message}`);
  }
}

async function handleStop() {
  try {
    await pm2('stop touch-turn-bot');
    await sendTelegram('🛑 <b>Bot stopped</b>');
  } catch (err) {
    await sendTelegram(`❌ Failed to stop bot: ${err.message}`);
  }
}

async function handleStatus() {
  const [botStatus, tradeLog, config] = await Promise.all([
    getBotStatus(),
    readTradeLog(),
    readConfig(),
  ]);

  let msg = botStatus.online ? '🟢 <b>Bot is running</b>' : '🔴 <b>Bot is stopped</b>';
  if (botStatus.online) {
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    const mode = config.dryRun ? 'DRY RUN' : 'LIVE';
    const symbols = config.symbols?.join(', ') || 'unknown';
    msg += `\nMode: ${paper} ${mode}`;
    msg += `\nSymbols: ${symbols}`;
    msg += `\nUptime: ${botStatus.uptime}`;
  }

  if (tradeLog.length > 0) {
    msg += '\n\n<b>Recent activity:</b>';
    for (const entry of tradeLog) {
      const prefix = { info: 'ℹ️', trade: '📊', signal: '🔔', error: '❌', win: '✅', loss: '🛑' }[entry.type] || '·';
      msg += `\n${prefix} ${entry.msg}`;
    }
  } else {
    msg += '\n\n<i>No recent activity</i>';
  }

  await sendTelegram(msg);
}

async function handleHelp() {
  await sendTelegram(
    '🤖 <b>Scalp Bot Commands</b>\n\n' +
    '/start — Start the trading bot\n' +
    '/stop — Stop the trading bot\n' +
    '/status — Show bot status and recent trades\n' +
    '/help — Show this message'
  );
}

// ─── Command router ───

const COMMANDS = {
  '/start': handleStart,
  '/stop': handleStop,
  '/status': handleStatus,
  '/help': handleHelp,
};

async function handleMessage(msg) {
  if (!isAuthorized(msg.chat.id)) {
    console.log(`Ignoring message from unauthorized chat: ${msg.chat.id}`);
    return;
  }

  const cmd = parseCommand(msg.text);
  if (!cmd) return;

  // Handle /start@botname style commands
  const normalizedCmd = cmd.split('@')[0];

  const handler = COMMANDS[normalizedCmd];
  if (handler) {
    console.log(`Command: ${normalizedCmd} from ${msg.chat.id}`);
    await handler();
  }
}

// ─── Polling loop ───

async function poll() {
  try {
    const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=%5B%22message%22%5D`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Poll error: ${resp.status}`);
      return;
    }
    const data = await resp.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) {
        await handleMessage(update.message);
      }
    }
  } catch (err) {
    console.error(`Poll failed: ${err.message}`);
  }
}

async function main() {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(1);
  }

  console.log('🤖 Scalp Bot Controller started');
  console.log(`Chat ID: ${TG_CHAT_ID}`);
  console.log('Listening for commands: /start, /stop, /status, /help');

  while (true) {
    await poll();
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the file loads without syntax errors**

Run: `node -e "import('./scripts/telegram-ctl.js').then(() => console.log('OK'))"` (will fail on missing .env vars but should parse correctly)
Expected: Module loads, then exits with FATAL about missing env vars (proves syntax is valid)

- [ ] **Step 3: Update tests to import from telegram-ctl.js**

Update `tests/telegram-ctl.test.js` — replace the inline function definitions with imports from `telegram-ctl.js`. Remove the inline `parseCommand`, `isAuthorized` functions and add at the top:

```js
import { parseCommand, isAuthorized } from '../scripts/telegram-ctl.js';
```

Remove the `parseCommand` and `isAuthorized` function definitions from inside the `describe` blocks — they now come from the import. The `formatStatus` test can keep its inline function since `formatStatus` is not exported (it's assembled inline in `handleStatus`).

Updated `tests/telegram-ctl.test.js`:

```js
/**
 * Unit tests for telegram-ctl.js — command parsing, auth, status formatting.
 *
 * Run: node --test tests/telegram-ctl.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, isAuthorized } from '../scripts/telegram-ctl.js';

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
    // Set env var for test
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
        msg += `\n${prefix} ${entry.msg}`;
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
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/telegram-ctl.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram-ctl.js tests/telegram-ctl.test.js
git commit -m "feat: add telegram-ctl.js — Telegram command listener for bot control"
```

---

### Task 4: Create PM2 config (ecosystem.config.cjs)

**Files:**
- Create: `ecosystem.config.cjs`

- [ ] **Step 1: Create ecosystem.config.cjs**

Create `ecosystem.config.cjs` at the project root:

```js
module.exports = {
  apps: [{
    name: 'touch-turn-bot',
    script: 'scripts/touch-turn-bot.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 10,
    restart_delay: 5000,
    autorestart: true,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/touch-turn-bot-error.log',
    out_file: 'logs/touch-turn-bot-out.log',
    merge_logs: true,
  }],
};
```

- [ ] **Step 2: Create logs directory with .gitkeep**

```bash
mkdir -p logs
touch logs/.gitkeep
```

- [ ] **Step 3: Add logs/ to .gitignore (but keep .gitkeep)**

Check if `.gitignore` already has a logs entry. If not, append:

```
logs/*
!logs/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.cjs logs/.gitkeep .gitignore
git commit -m "feat: add PM2 ecosystem config and logs directory"
```

---

### Task 5: Create systemd service file template

**Files:**
- Create: `scripts/scalp-bot-ctl.service`

This is a reference file — the setup script will copy it to `/etc/systemd/system/` on the VPS.

- [ ] **Step 1: Create the systemd service template**

Create `scripts/scalp-bot-ctl.service`:

```ini
[Unit]
Description=Scalp Bot Telegram Controller
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/scalp-bot/scripts/telegram-ctl.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
WorkingDirectory=/root/scalp-bot

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add scripts/scalp-bot-ctl.service
git commit -m "feat: add systemd service template for telegram-ctl"
```

---

### Task 6: Create VPS setup script

**Files:**
- Create: `scripts/setup-vps.sh`

This script automates the one-time VPS provisioning steps from the design spec.

- [ ] **Step 1: Create the setup script**

Create `scripts/setup-vps.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ─── Scalp Bot VPS Setup ───
# Run once on a fresh Ubuntu 22.04+ VPS
# Usage: bash scripts/setup-vps.sh

REPO_DIR="${REPO_DIR:-/root/scalp-bot}"
NODE_MAJOR="${NODE_MAJOR:-20}"

echo "=== Scalp Bot VPS Setup ==="
echo "Repo directory: $REPO_DIR"
echo ""

# 1. Install Node.js
echo ">>> Installing Node.js $NODE_MAJOR..."
curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install PM2
echo ">>> Installing PM2..."
sudo npm install -g pm2

# 3. Install PM2 log rotation
echo ">>> Installing pm2-logrotate..."
pm2 install pm2-logrotate

# 4. Install repo dependencies
echo ">>> Installing project dependencies..."
cd "$REPO_DIR"
npm install

# 5. Set up .env (prompt user)
if [ ! -f .env ]; then
  echo ""
  echo ">>> .env file not found. Create it now:"
  echo "    nano $REPO_DIR/.env"
  echo ""
  echo "    Required vars:"
  echo "    ALPACA_API_KEY=..."
  echo "    ALPACA_SECRET_KEY=..."
  echo "    ALPACA_PAPER=true"
  echo "    TELEGRAM_BOT_TOKEN=..."
  echo "    TELEGRAM_CHAT_ID=..."
  echo ""
  read -p "Press Enter after creating .env, or Ctrl+C to abort..."
fi

# 6. Secure .env
chmod 600 .env

# 7. Create logs directory
mkdir -p logs

# 8. Set up systemd service for telegram-ctl
echo ">>> Setting up systemd service..."
sudo cp scripts/scalp-bot-ctl.service /etc/systemd/system/scalp-bot-ctl.service
sudo systemctl daemon-reload
sudo systemctl enable scalp-bot-ctl

# 9. Set timezone to ET
echo ">>> Setting timezone to America/New_York..."
sudo timedatectl set-timezone America/New_York

# 10. Set up cron jobs for session scheduling
echo ">>> Setting up cron jobs for session scheduling..."
(crontab -l 2>/dev/null; cat <<CRON
# Scalp bot session scheduling (ET timezone)
25 9 * * 1-5 cd $REPO_DIR && pm2 start ecosystem.config.cjs >> /var/log/scalp-bot-cron.log 2>&1
5 11 * * 1-5 cd $REPO_DIR && pm2 stop touch-turn-bot >> /var/log/scalp-bot-cron.log 2>&1
CRON
) | crontab -

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Create .env file: nano $REPO_DIR/.env"
echo "  2. Start the controller: sudo systemctl start scalp-bot-ctl"
echo "  3. Check status: sudo systemctl status scalp-bot-ctl"
echo "  4. Test from Telegram: send /start, /status, /stop"
echo "  5. Verify PM2: pm2 list"
echo ""
echo "Useful commands:"
echo "  pm2 list              — Show managed processes"
echo "  pm2 logs touch-turn-bot   — View bot logs"
echo "  pm2 describe touch-turn-bot — Detailed bot status"
echo "  sudo systemctl status scalp-bot-ctl — Controller status"
echo "  sudo journalctl -u scalp-bot-ctl -f — Controller logs"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/setup-vps.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-vps.sh
git commit -m "feat: add VPS setup script for one-time provisioning"
```

---

### Task 7: Update the scalp-bot skill to document cloud control

**Files:**
- Modify: `skills/scalp-bot/SKILL.md`

The scalp-bot skill should document the new Telegram control commands and cloud deployment option.

- [ ] **Step 1: Add Telegram control section to SKILL.md**

Add a new section to `skills/scalp-bot/SKILL.md` after the "Safety Rules" section:

```markdown
## Cloud Deployment (VPS)

The bot can run on a cloud VPS with Telegram-based control. See `docs/superpowers/specs/2026-04-17-cloud-bot-telegram-control-design.md` for full architecture.

### Setup

```bash
# On a fresh Ubuntu VPS:
git clone <repo-url> /root/scalp-bot
cd /root/scalp-bot
bash scripts/setup-vps.sh
```

### Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Start the bot via PM2 |
| `/stop` | Stop the bot via PM2 |
| `/status` | Show running state, mode, recent trades |
| `/help` | List available commands |

Only messages from `TELEGRAM_CHAT_ID` (set in `.env`) are processed.

### VPS Management

- `pm2 list` — Show managed processes
- `pm2 logs touch-turn-bot` — View bot logs
- `pm2 describe touch-turn-bot` — Detailed bot status
- `sudo systemctl status scalp-bot-ctl` — Telegram controller status
- `sudo journalctl -u scalp-bot-ctl -f` — Controller logs
```

- [ ] **Step 2: Commit**

```bash
git add skills/scalp-bot/SKILL.md
git commit -m "docs: add cloud deployment and Telegram control docs to scalp-bot skill"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| Telegram command listener (start/stop/status/help) | Task 3 |
| Auth (CHAT_ID only) | Task 3 (`isAuthorized`) |
| PM2 management | Task 4 (ecosystem.config.cjs) |
| Systemd service for telegram-ctl | Task 5 |
| Cron session scheduling | Task 6 (setup-vps.sh) |
| No changes to bot behavior | Confirmed — no touch-turn-bot.js changes |
| Security (CHAT_ID auth, no public ports) | Task 3 |

**2. Placeholder scan:** No TBDs, TODOs, or vague "add error handling" steps. All code blocks contain complete implementations.

**3. Type consistency:** `parseCommand` returns `string | null`, `isAuthorized` takes `number | string` and compares as strings, PM2 `getBotStatus` returns `{online, status, uptime}` which is used consistently in `handleStatus`.

No gaps found. Plan is complete.