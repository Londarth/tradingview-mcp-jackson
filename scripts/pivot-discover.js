#!/usr/bin/env node
// scripts/pivot-discover.js
// Auto-discovery scanner for pivot reversion candidates
// Screens Alpaca's active stocks for microstructure traits that match
// the confirmed winners: PLTR, LCID, SOFI, MARA
//
// Key traits of pivot winners:
//   - ATR% >= 4.0% (volatile enough for pivot tests)
//   - ATR% <= 10% (not pure noise)
//   - Price $3-$60 (avoid sub-pennys, avoid mega-caps)
//   - NOT in S&P 500 (institutional flow steamrolls pivots)
//   - Avg daily volume < 5M (thin enough book)
//   - Min volume > 200K (not dead)

import 'dotenv/config';
import { fetchBarsPaginated, normD } from './lib/alpaca-data.js';

// ─── Confirmed winners / losers for reference ───
const CONFIRMED_WINNERS = ['PLTR', 'LCID', 'SOFI', 'MARA'];
const CONFIRMED_MARGINAL = ['IONQ', 'SOUN', 'RIOT', 'CCL'];
const CONFIRMED_LOSERS = ['RIVN', 'SNAP'];
const ORIGINAL_UNIVERSE = ['INTC', 'DIS', 'F', 'GM', 'SBUX', 'DAL', 'Z'];

// ─── S&P 500 exclusion (partial list of frequently traded ones) ───
// Full list would be 500+, but most are >$60 or <4% ATR so they'd be filtered anyway
const SP500_COMMON = new Set([
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK.B','UNH','JNJ','V','JPM',
  'XOM','PG','MA','HD','CVX','MRK','ABBV','PEP','KO','AVGO','COST','ADBE','WMT',
  'CRM','AMD','NFLX','TMO','CSCO','LIN','ORCL','ACN','MCD','ABT','NKE','DHR',
  'VZ','CMCSA','TXN','PM','UNP','COP','LOW','RTX','SBUX','INTC','DIS','F','GM',
  'DAL','SBUX','BAC','WFC','GS','MS','BLK','SCHW','C','AIG','MET','PFE','MRNA',
  'QCOM','INTU','ISRG','MDLZ','TJX','CI','HUM','EL','SYK','BDX','REGN','ILMN',
  'PLTR', // PLTR is S&P 500 but still works — it's the exception
]);

// ─── Pivot-specific microstructure filters ───
const FILTERS = {
  minPrice: 3,
  maxPrice: 60,
  minATRPct: 4.0,    // KEY: winners all have ATR% >= 4%
  maxATRPct: 10.0,
  minAvgVol: 200_000,   // not dead
  maxAvgVol: 5_000_000, // not too liquid (SNAP at 2.7M already borderline)
  excludeSP500: true,
};

// ─── Universe of stocks to screen (curated list of active/volatile names) ───
// Alpaca IEX feed limits batch fetching, so we use a pre-built universe
// of ~200 popular active stocks to screen against
const SCREEN_UNIVERSE = [
  // Tech / Growth
  'PLTR','LCID','SOFI','MARA','IONQ','SOUN','RIOT','RIVN','SNAP',
  'AMD','NVDA','TSLA','AAPL','GOOGL','AMZN','META','NFLX','CRM',
  'COIN','HOOD','RBLX','U','AFRM','UPST','LCID','RIVN','NIO',
  'XPEV','LI','PDD','BABA','JD','SQ','SHOP','DKNG','RBLX','ROKU',
  'ZM','PINS','ETSY','ABNB','COIN','HOOD','LCID','MSTR','CLSK',
  // Crypto-adjacent
  'MARA','RIOT','CLSK','MSTR','HUT','BTBT','CIFR','BTDR','CORZ',
  // Meme / Retail favorites  
  'AMC','GME','BBBY','BULL','SNDL','TLRY','ACB','CGC','CRON',
  // Biotech (high vol)
  'MRNA','BNTX','NVAX','VFC','DNA','RPRX','PTCT','ALNY','RXRX',
  // Small cap growth
  'RKLB','ASTS','LUNR','IONQ','QS','RIVN','LCID','JOBY','ACHR',
  'NNE','OKLO','SMR','CCJ','UEC','URA','LEU',
  // Energy / Materials
  'CCJ','UEC','URNM','COP','XOM','CVX','SLB','OXY','MPC',
  // Financials / Fintech
  'SOFI','HOOD','COIN','AFRM','UPST','LC','INTU','MQ',
  // Travel / Leisure
  'CCL','RCL','NCLH','DAL','UAL','AAL','JBLU','ALK','SAVE',
  // Auto / EV
  'RIVN','LCID','TSLA','NIO','XPEV','LI','F','GM','STLA','TM',
  // Defense / Aero
  'LMT','NOC','RTX','BA','GD','TDY','LHX','GE',
  // Consumer
  'PLTR','SQ','DKNG','ROKU','ZG','ANGI','YELP',
  // Semis
  'AMD','NVDA','INTC','AVGO','QCOM','MRVL','MRAC','ON','SWKS',
  // More small/mid caps
  'SOUN','BBAI','LUNR','ASTS','RKLB','JOBY','ACHR','NNE','OKLO',
  'BIGZ','BULL','MCW','GCT','CWM','AULT','MGI','MIRA','RERE',
  'VSTS','PAYX','WKEY','MDVL','MDJH','MNSO','MMAT','MOTS','MTC',
  'RXST','SANA','SESN','SVFD','TCDA','TLC','TRIT','VKTX','WHLR',
  'XP','YOU','ZIM','ZETA',
];

const UNIQUE_UNIVERSE = [...new Set(SCREEN_UNIVERSE)];

// ─── Fetch daily stats for all screen candidates ───
async function fetchDailyStats(symbols) {
  const results = {};
  let fetched = 0;
  let errors = 0;

  // Fetch one at a time (Alpaca free tier pagination)
  for (const sym of symbols) {
    try {
      const rawD = await fetchBarsPaginated(sym, '1Day', '2026-03-01', '2026-04-22');
      const daily = rawD.map(normD);
      if (daily.length < 10) { errors++; continue; }

      const recent = daily.slice(-30);
      const lastPrice = recent[recent.length - 1].close;
      const avgVol = Math.round(recent.reduce((s, b) => s + b.volume, 0) / recent.length);
      const avgRange = recent.reduce((s, b) => s + (b.high - b.low), 0) / recent.length;
      const atrPct = avgRange / lastPrice * 100;

      results[sym] = { lastPrice, avgVol, atrPct, avgRange };
      fetched++;

      if (fetched % 20 === 0) process.stdout.write(`  ${fetched}/${symbols.length} screened...\n`);
    } catch (e) {
      errors++;
    }
  }

  console.log(`  Screened ${fetched}/${symbols.length} (${errors} errors)`);
  return results;
}

// ─── Main ───
async function main() {
  console.log('🔍 PIVOT REVERSION CANDIDATE DISCOVERY');
  console.log('='.repeat(60));
  console.log(`\nFilters: ATR% ${FILTERS.minATRPct}%-${FILTERS.maxATRPct}%, Price $${FILTERS.minPrice}-$${FILTERS.maxPrice}, Vol ${FILTERS.minAvgVol.toLocaleString()}-${FILTERS.maxAvgVol.toLocaleString()}`);

  // Step 1: Screen the universe
  console.log('\nScreening universe for pivot reversion candidates...');
  console.log(`  ${UNIQUE_UNIVERSE.length} unique symbols to screen`);

  // Step 2: Fetch daily stats
  console.log('\nFetching daily bar stats for screening...');
  const stats = await fetchDailyStats(UNIQUE_UNIVERSE);
  console.log(`  Got stats for ${Object.keys(stats).length} symbols`);

  // Step 3: Apply filters
  const candidates = [];
  const known = new Set([...CONFIRMED_WINNERS, ...CONFIRMED_MARGINAL, ...CONFIRMED_LOSERS, ...ORIGINAL_UNIVERSE]);

  for (const [sym, s] of Object.entries(stats)) {
    // Skip if already known
    if (known.has(sym)) {
      // Still log them for reference
      continue;
    }

    if (s.lastPrice < FILTERS.minPrice || s.lastPrice > FILTERS.maxPrice) continue;
    if (s.atrPct < FILTERS.minATRPct || s.atrPct > FILTERS.maxATRPct) continue;
    if (s.avgVol < FILTERS.minAvgVol || s.avgVol > FILTERS.maxAvgVol) continue;
    if (FILTERS.excludeSP500 && SP500_COMMON.has(sym)) continue;

    candidates.push({ symbol: sym, ...s });
  }

  // Sort by ATR% descending (more volatile = more pivot tests = more trades)
  candidates.sort((a, b) => b.atrPct - a.atrPct);

  // Step 4: Print results
  console.log('\n' + '='.repeat(60));
  console.log('  CONFIRMED WINNERS (for reference)');
  console.log('='.repeat(60));
  console.log('  Symbol   Price   ATR%       AvgVol  Status');
  console.log('  ------   -----   ----     ------  ------');

  // Show known stocks for reference
  const allKnown = [
    ...CONFIRMED_WINNERS.map(s => ({ sym: s, ...stats[s], status: '🏆 WINNER' })),
    ...CONFIRMED_MARGINAL.map(s => ({ sym: s, ...stats[s], status: '⚠️ MARGINAL' })),
    ...CONFIRMED_LOSERS.map(s => ({ sym: s, ...stats[s], status: '❌ LOSER' })),
  ].filter(s => s.lastPrice);

  for (const s of allKnown) {
    console.log(`  ${s.sym.padEnd(8)} $${s.lastPrice.toFixed(2).padStart(6)} ${s.atrPct.toFixed(1).padStart(5)}% ${s.avgVol.toLocaleString().padStart(10)}  ${s.status}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  NEW DISCOVERIES (${candidates.length} found)`);
  console.log('='.repeat(60));
  console.log('  Symbol   Price   ATR%       AvgVol  Rank');
  console.log('  ------   -----   ----     ------  ----');

  for (let i = 0; i < Math.min(candidates.length, 50); i++) {
    const c = candidates[i];
    const rank = i < 5 ? '🔥🔥🔥' : i < 15 ? '🔥🔥' : i < 30 ? '🔥' : '';
    console.log(`  ${c.symbol.padEnd(8)} $${c.lastPrice.toFixed(2).padStart(6)} ${c.atrPct.toFixed(1).padStart(5)}% ${c.avgVol.toLocaleString().padStart(10)}  ${rank}`);
  }

  if (candidates.length > 50) {
    console.log(`  ... and ${candidates.length - 50} more`);
  }

  // Step 5: Output top candidates as comma-separated list for easy copy to UNIVERSE
  const topNew = candidates.slice(0, 20).map(c => c.symbol);
  console.log('\n' + '='.repeat(60));
  console.log('  RECOMMENDED UNIVERSE UPDATE');
  console.log('='.repeat(60));
  console.log(`\n  Current winners: ${CONFIRMED_WINNERS.join(',')}`);
  console.log(`  Top new discoveries: ${topNew.join(',')}`);
  console.log(`\n  Combined universe for .env:`);
  console.log(`  UNIVERSE=${[...CONFIRMED_WINNERS, ...topNew].join(',')}`);

  // Step 6: Also show which current universe members to DROP
  console.log(`\n  ⚠️  REMOVE from universe (bad for pivot reversion):`);
  console.log(`  ${ORIGINAL_UNIVERSE.join(',')} — ATR% too low / institutional flow`);
  console.log(`  RIVN, SNAP — confirmed negative PF`);

  return candidates;
}

main().catch(e => { console.error(e); process.exit(1); });