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
    const { stdout } = await pm2('describe alpaca-bot');
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
    await pm2('stop alpaca-bot');
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