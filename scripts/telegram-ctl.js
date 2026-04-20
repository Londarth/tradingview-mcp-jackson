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
const BOT_NAME = 'touch-turn';
const CONFIG_PATH = join(__dirname, 'alpaca-config.json');
const LOG_PATH = join(__dirname, 'touch-turn-log.json');
const SNAPSHOT_PATH = join(__dirname, 'account-snapshot.json');

let lastUpdateId = 0;

const MAIN_BUTTONS = [[
  { text: '▶ Start', callback_data: '/start' },
  { text: '⏹ Stop', callback_data: '/stop' },
  { text: '📊 Status', callback_data: '/status' },
]];

// ─── Pure functions (exported for testing) ───

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  return parts[0].toLowerCase();
}

export function isAuthorized(chatId) {
  return String(chatId) === String(TG_CHAT_ID);
}

export async function sendTelegram(text, buttons = MAIN_BUTTONS) {
  if (!TG_TOKEN) return;
  try {
    const body = { chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    const resp = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`Telegram send error: ${resp.status}`);
  } catch (e) {
    console.error(`Telegram send failed: ${e.message}`);
  }
}

async function answerCallbackQuery(callbackQueryId) {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (e) { /* ignore */ }
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

async function readSnapshot() {
  try {
    const data = await readFile(SNAPSHOT_PATH, 'utf8');
    const snap = JSON.parse(data);
    const age = Date.now() - snap.ts;
    const ageMin = Math.round(age / 60000);
    return { ...snap, ageMin };
  } catch {
    return null;
  }
}

// ─── Command handlers ───

async function handleStart() {
  try {
    await pm2('start ecosystem.config.cjs --only touch-turn-bot');
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    await sendTelegram(`⚡️ <b>Touch &amp; Turn Bot started</b>\nMode: ${paper}\nWindow: 9:45–11:00 ET`);
  } catch (err) {
    await sendTelegram(`❌ Failed to start bot: ${err.message}`);
  }
}

async function handleStop() {
  try {
    await pm2('stop touch-turn-bot');
    await sendTelegram('🛑 <b>Touch &amp; Turn Bot stopped</b>');
  } catch (err) {
    await sendTelegram(`❌ Failed to stop bot: ${err.message}`);
  }
}

async function handleStatus() {
  const [botStatus, tradeLog, snapshot] = await Promise.all([
    getBotStatus(),
    readTradeLog(),
    readSnapshot(),
  ]);

  let msg = botStatus.online ? '🟢 <b>Touch &amp; Turn Bot is running</b>' : '🔴 <b>Bot is stopped</b>';
  if (botStatus.online) {
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    msg += `\nMode: ${paper}`;
    msg += `\nUptime: ${botStatus.uptime}`;
  }

  // Live account data from snapshot
  if (snapshot) {
    const paper = snapshot.mode || 'PAPER';
    const dryTag = snapshot.dryRun ? ' DRY' : '';
    msg += `\n\n💰 <b>Account</b> (${paper}${dryTag})`;
    msg += `\nEquity: <b>$${Number(snapshot.equity).toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>`;
    msg += `\nCash: $${Number(snapshot.cash).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    if (snapshot.positions && snapshot.positions.length > 0) {
      msg += `\n\n📊 <b>Open Positions</b>`;
      for (const p of snapshot.positions) {
        const pnlSign = p.unrealizedPl >= 0 ? '+' : '';
        const pnlPct = p.entryPrice ? ((p.unrealizedPl / (p.entryPrice * p.qty)) * 100).toFixed(1) : '0.0';
        msg += `\n• <b>${p.symbol}</b> ${p.side.toUpperCase()} ${p.qty}×$${Number(p.entryPrice).toFixed(2)}`;
        msg += ` | ${pnlSign}$${Number(p.unrealizedPl).toFixed(2)} (${pnlSign}${pnlPct}%)`;
        msg += `\n  Now: $${Number(p.currentPrice).toFixed(2)} → $${Number(p.targetPrice).toFixed(2)} / SL $${Number(p.stopPrice).toFixed(2)}`;
      }
    } else {
      msg += `\n\n📋 No open positions`;
    }

    if (snapshot.order) {
      const o = snapshot.order;
      msg += `\n\n⏳ <b>Pending Order</b>`;
      msg += `\n${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ $${Number(o.price).toFixed(2)}`;
      msg += `\nSL: $${Number(o.stop).toFixed(2)} | TP: $${Number(o.target).toFixed(2)}`;
    }

    msg += `\n\n<i>Snapshot ${snapshot.ageMin}m old</i>`;
  }

  if (tradeLog.length > 0) {
    msg += '\n\n<b>Recent activity:</b>';
    for (const entry of tradeLog.slice(-5)) {
      const prefix = entry.level === 'error' ? '❌' : entry.level === 'trade' ? '📊' : 'ℹ️';
      msg += `\n${prefix} ${escapeHtml(entry.msg)}`;
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
    const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
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
      } else if (update.callback_query) {
        const cb = update.callback_query;
        if (isAuthorized(cb.message?.chat?.id)) {
          const handler = COMMANDS[cb.data];
          if (handler) {
            console.log(`Callback: ${cb.data} from ${cb.from?.id}`);
            await handler();
          }
        }
        await answerCallbackQuery(cb.id);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}