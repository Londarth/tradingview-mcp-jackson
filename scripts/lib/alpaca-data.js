// scripts/lib/alpaca-data.js

export async function fetchBarsPaginated(symbol, timeframe, startDate, endDate) {
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
  let allBars = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      symbols: symbol, timeframe, start: startDate, end: endDate,
      feed: 'iex', limit: '10000', sort: 'asc',
    });
    if (pageToken) params.set('page_token', pageToken);

    const resp = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!resp.ok) throw new Error(`Alpaca API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const bars = data.bars?.[symbol] || [];
    allBars = allBars.concat(bars);
    pageToken = data.next_page_token;
  } while (pageToken);

  return allBars;
}

export function norm5(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw }; }
export function normD(b) { return { ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; }

export function computeDailyATRMap(dailyBars, period = 14) {
  const map = new Map();
  if (dailyBars.length < period + 1) return map;
  for (let i = period; i < dailyBars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const prev = dailyBars[j - 1];
      const cur = dailyBars[j];
      const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
      sum += tr;
    }
    const dateStr = new Date(dailyBars[i].ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    map.set(dateStr, sum / period);
  }
  return map;
}