import dotenv from 'dotenv';
dotenv.config();

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

let enabled = !!(TG_TOKEN && TG_CHAT_ID && TG_TOKEN !== 'your_telegram_bot_token');

export function telegramEnabled() { return enabled; }

export async function sendTelegram(text, parseMode = 'HTML') {
  if (!enabled) return;
  try {
    const body = { chat_id: TG_CHAT_ID, text, parse_mode: parseMode };
    const resp = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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

export async function tgBreakout(sym, direction, level, atrPct, rvol) {
  const arrow = direction === 'above' ? '⬆️' : '⬇️';
  await sendTelegram(
    `${arrow} <b>${sym} breakout ${direction}</b> ${level.toFixed(2)}\n` +
    `ATR%: ${atrPct.toFixed(1)} | RVOL: ${rvol.toFixed(2)}`
  );
}

export async function tgMorningBrief(symData) {
  let msg = `☀️ <b>Morning Brief</b>\n${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n\n`;
  for (const s of symData) {
    msg += `<b>${s.symbol}</b>: ATR=$${s.atr?.toFixed(2) ?? 'N/A'} | Last=$${s.lastPrice?.toFixed(2) ?? 'N/A'}\n`;
  }
  msg += `\nSession: 9:30–11:00 ET | Max trades: 2/day/symbol`;
  await sendTelegram(msg);
}

export async function tgEODSummary(results) {
  let msg = `📊 <b>End of Day Report</b>\n${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n\n`;
  let totalPnl = 0;
  for (const r of results) {
    const emoji = r.pnl >= 0 ? '✅' : '🛑';
    msg += `${emoji} <b>${r.symbol}</b> ${r.side.toUpperCase()}: ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}\n`;
    totalPnl += r.pnl;
  }
  msg += `\n<b>Total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`;
  await sendTelegram(msg);
}

export async function tgError(message) {
  await sendTelegram(`❌ <b>Error</b>\n${message}`);
}

export async function tgStartup(mode, symbols) {
  await sendTelegram(
    `🚀 <b>Touch &amp; Turn Bot Started</b>\n` +
    `Mode: ${mode}\n` +
    `Symbols: ${symbols.join(', ')}\n` +
    `Window: 9:45–11:00 ET`
  );
}

export async function tgShutdown() {
  await sendTelegram(`🛑 <b>Bot Stopped</b>`);
}