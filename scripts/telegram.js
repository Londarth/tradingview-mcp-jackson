import dotenv from 'dotenv';
dotenv.config();

import { retry } from './lib/retry.js';

export const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const TG_MAX_LEN = 4096;

let enabled = !!(TG_TOKEN && TG_CHAT_ID && TG_TOKEN !== 'your_telegram_bot_token');

export function telegramEnabled() { return enabled; }

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return parts;
}

export const MAIN_BUTTONS = [[
  { text: '▶ Start', callback_data: '/start' },
  { text: '⏹ Stop', callback_data: '/stop' },
  { text: '📊 Status', callback_data: '/status' },
]];

export async function sendTelegram(text, { parseMode = 'HTML', buttons = null } = {}) {
  if (!enabled) return;
  const messages = splitMessage(text, TG_MAX_LEN);
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    try {
      const body = { chat_id: TG_CHAT_ID, text: messages[i], parse_mode: parseMode };
      if (isLast && buttons) body.reply_markup = { inline_keyboard: buttons };
      const resp = await retry(() => fetch(`${TG_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!resp.ok) {
        const err = await resp.text();
        console.error(`Telegram error: ${resp.status} ${err}`);
      }
    } catch (e) {
      console.error(`Telegram send failed: ${e.message}`);
    }
  }
}

// ─── Formatted messages ───

export async function tgTradeSignalsBatch(signals, { dryRun = false } = {}) {
  if (!signals || signals.length === 0) return;
  const header = dryRun
    ? '⚡️ <b>TOUCH &amp; TURN SIGNALS (DRY RUN)</b>'
    : '⚡️ <b>TOUCH &amp; TURN SIGNALS</b>';
  let msg = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━`;
  for (const s of signals) {
    const dir = s.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
    msg += `\n\n<b>${dir} ${s.sym}</b>\n`;
    msg += `Entry: $${s.price.toFixed(2)} | Stop: $${s.stop.toFixed(2)} | Target: $${s.target.toFixed(2)}\n`;
    msg += `R:R = 1:${s.rr.toFixed(1)} | Qty: ${s.qty}`;
  }
  await sendTelegram(msg);
}

export async function tgTradeSignal(sym, side, price, stop, target, rr, qty) {
  const dir = side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  await sendTelegram(
    `<b>${dir} ${sym}</b>\n` +
    `Entry: $${price.toFixed(2)}\n` +
    `Stop: $${stop.toFixed(2)}\n` +
    `Target: $${target.toFixed(2)}\n` +
    `R:R = 1:${rr.toFixed(1)}\n` +
    `Qty: ${qty}`
  );
}

export async function tgDryRunSignal(sym, side, price, stop, target, rr, qty) {
  const dir = side === 'long' ? '🟢 LONG (DRY)' : '🔴 SHORT (DRY)';
  await sendTelegram(
    `<b>${dir} ${sym}</b>\n` +
    `Signal: $${price.toFixed(2)}\n` +
    `Would stop: $${stop.toFixed(2)}\n` +
    `Would target: $${target.toFixed(2)}\n` +
    `R:R = 1:${rr.toFixed(1)}\n` +
    `Qty: ${qty}\n` +
    `<i>No order placed (dry run)</i>`
  );
}

export async function tgError(message) {
  await sendTelegram(`❌ <b>Error</b>\n${message}`);
}

export async function tgShutdown() {
  await sendTelegram(`🛑 <b>Bot Stopped</b>`);
}

// ─── Orphaned position buttons ───

export const ORPHAN_BUTTONS = [[
  { text: '❌ Close All', callback_data: '/close_orphaned' },
  { text: '✅ Keep All', callback_data: '/keep_orphaned' },
]];

export async function tgOrphanedPositions(positions) {
  if (!positions || positions.length === 0) return;
  let msg = `⚠️ <b>Orphaned Positions Detected</b>\n`;
  msg += `These positions are open in Alpaca but not tracked by Touch &amp; Turn:\n\n`;
  for (const p of positions) {
    const pnlSign = parseFloat(p.unrealized_pl) >= 0 ? '+' : '';
    msg += `• <b>${p.symbol}</b> ${p.side.toUpperCase()} ${p.qty}×$${parseFloat(p.avg_entry_price).toFixed(2)}`;
    msg += ` | ${pnlSign}$${parseFloat(p.unrealized_pl).toFixed(2)}\n`;
  }
  msg += `\nThese may be from another bot or manual trades.`;
  await sendTelegram(msg, { buttons: ORPHAN_BUTTONS });
}