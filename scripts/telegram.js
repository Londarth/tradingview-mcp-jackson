import dotenv from 'dotenv';
dotenv.config();

import { retry } from './lib/retry.js';

export const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

let enabled = !!(TG_TOKEN && TG_CHAT_ID && TG_TOKEN !== 'your_telegram_bot_token');

export function telegramEnabled() { return enabled; }

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const MAIN_BUTTONS = [[
  { text: '▶ Start', callback_data: '/start' },
  { text: '⏹ Stop', callback_data: '/stop' },
  { text: '📊 Status', callback_data: '/status' },
]];

export async function sendTelegram(text, { parseMode = 'HTML', buttons = null } = {}) {
  if (!enabled) return;
  try {
    const body = { chat_id: TG_CHAT_ID, text, parse_mode: parseMode };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
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

// ─── Formatted messages ───

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