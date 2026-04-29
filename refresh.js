// scoreboard/refresh.js
// Runs in GitHub Actions. Fetches AVWAP Stats + Master Trade Log from Notion,
// computes leaderboard stats, writes scoreboard/data.json.

const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN env var');
  process.exit(1);
}

// IDs from your Notion workspace (public-API database IDs, i.e. page IDs as shown in URLs)
const AVWAP_DB = '92b9ba93-1e73-4533-bede-c70f7e7a492e';
const MTL_DB = 'a227e541-46b5-8367-a59d-01e9e0a499d3';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const headers = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

const METHODOLOGIES = [
  { code: 'FTP',  label: 'Full TP',           wrProp: 'Full TP WR%',           avgRProp: 'Full TP AvgR',           expProp: 'Full TP Exp',           totalRProp: 'Full TP Total R' },
  { code: 'EP',   label: 'Entry Partials',    wrProp: 'Entry Partials WR%',    avgRProp: 'Entry Partials AvgR',    expProp: 'Entry Partials Exp',    totalRProp: 'Entry Partials Total R' },
  { code: 'EL1',  label: 'Entry + L1',        wrProp: 'Entry + L1 WR%',        avgRProp: 'Entry + L1 AvgR',        expProp: 'Entry + L1 Exp',        totalRProp: 'Entry + L1 Total R' },
  { code: '5T',   label: '5m HA Trail',       wrProp: '5m HA Trail WR%',       avgRProp: '5m HA Trail AvgR',       expProp: '5m HA Trail Exp',       totalRProp: '5m HA Trail Total R' },
  { code: '5P',   label: '5m HA Partials',    wrProp: '5m HA Partials WR%',    avgRProp: '5m HA Partials AvgR',    expProp: '5m HA Partials Exp',    totalRProp: '5m HA Partials Total R' },
  { code: '10T',  label: '10m HA Trail',      wrProp: '10m HA Trail WR%',      avgRProp: '10m HA Trail AvgR',      expProp: '10m HA Trail Exp',      totalRProp: '10m HA Trail Total R' },
  { code: '10P',  label: '10m HA Partials',   wrProp: '10m HA Partials WR%',   avgRProp: '10m HA Partials AvgR',   expProp: '10m HA Partials Exp',   totalRProp: '10m HA Partials Total R' },
  { code: '15T',  label: '15m HA Trail',      wrProp: '15m HA Trail WR%',      avgRProp: '15m HA Trail AvgR',      expProp: '15m HA Trail Exp',      totalRProp: '15m HA Trail Total R' },
  { code: '15P',  label: '15m HA Partials',   wrProp: '15m HA Partials WR%',   avgRProp: '15m HA Partials AvgR',   expProp: '15m HA Partials Exp',   totalRProp: '15m HA Partials Total R' },
];

const MIN_TRADES_FOR_WR = 5; // ignore rows with fewer trades when ranking by win rate

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Query failed for ${dbId}: ${r.status} ${text}`);
    }
    const j = await r.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function getProp(page, name) {
  return page.properties?.[name];
}

function getPropValue(page, name) {
  const p = getProp(page, name);
  if (!p) return null;
  switch (p.type) {
    case 'title':       return p.title.map(t => t.plain_text).join('');
    case 'rich_text':   return p.rich_text.map(t => t.plain_text).join('');
    case 'number':      return p.number;
    case 'select':      return p.select?.name || null;
    case 'rollup':      return rollupValue(p.rollup);
    case 'formula':     return formulaValue(p.formula);
    case 'relation':    return p.relation.map(r => r.id);
    case 'checkbox':    return p.checkbox;
    case 'date':        return p.date?.start || null;
    default:            return null;
  }
}

function rollupValue(rollup) {
  if (!rollup) return null;
  switch (rollup.type) {
    case 'number': return rollup.number;
    case 'date':   return rollup.date?.start || null;
    case 'array':  return rollup.array;
    default:       return null;
  }
}

function formulaValue(f) {
  if (!f) return null;
  switch (f.type) {
    case 'number':  return f.number;
    case 'string':  return f.string;
    case 'boolean': return f.boolean;
    case 'date':    return f.date?.start || null;
    default:        return null;
  }
}

// Convert a value that may be either a numeric percentage rate (0-1) or a
// formatted string like "88.89%" into a 0-1 rate for ranking comparisons.
function toRate(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const m = val.match(/(-?\d+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    // Strings with "%" come pre-multiplied by 100; convert back to rate.
    return val.includes('%') ? n / 100 : n;
  }
  return 0;
}

async function getPageTitle(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, { headers });
  if (!r.ok) return null;
  const j = await r.json();
  return getPropValue(j, 'AVWAP') || getPropValue(j, 'Title') || pageId;
}

async function patchTradesRelation(pageId, tradeIds) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      properties: { Trades: { relation: tradeIds.map(id => ({ id })) } },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`PATCH failed for ${pageId}: ${r.status} ${text}`);
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function scrubAvwapStats(avwapRows, allAliveTradeIds, byAvwap, byAvwapTrader) {
  console.log('Scrubbing AVWAP Stats relations...');
  const idLookup = {};
  for (const r of avwapRows) idLookup[r.id] = r;

  const updates = [];
  for (const row of avwapRows) {
    const title = getPropValue(row, 'AVWAP');
    const trader = getPropValue(row, 'Trader');
    const parentItem = getPropValue(row, 'Parent item');
    const isSubRow = parentItem && parentItem.length > 0;

    let correctIds;
    if (!isSubRow) {
      // Parent or ALL aggregate row
      if (title && /ALL/i.test(title)) {
        correctIds = allAliveTradeIds.slice();
      } else {
        correctIds = (byAvwap[title] || []).slice();
      }
    } else {
      // Sub-row: filter by parent's AVWAP × this row's Trader
      const parentRow = idLookup[parentItem[0]];
      const parentTitle = parentRow ? getPropValue(parentRow, 'AVWAP') : null;
      correctIds = (byAvwapTrader[`${parentTitle}|${trader}`] || []).slice();
    }

    const currentRel = getPropValue(row, 'Trades') || [];
    if (!setsEqual(new Set(currentRel), new Set(correctIds))) {
      updates.push({ pageId: row.id, ids: correctIds, label: title || `${trader} sub-row` });
    }
  }

  console.log(`${updates.length} of ${avwapRows.length} rows need scrubbing`);

  // Notion API rate-limits to ~3 requests/sec; batch with small concurrency + brief pauses
  const BATCH = 3;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await Promise.all(batch.map(async u => {
      try {
        await patchTradesRelation(u.pageId, u.ids);
        console.log(`  scrubbed ${u.label} → ${u.ids.length} trades`);
      } catch (e) {
        console.error(`  failed to scrub ${u.label}: ${e.message}`);
      }
    }));
    if (i + BATCH < updates.length) await new Promise(r => setTimeout(r, 400));
  }

  if (updates.length > 0) {
    console.log('Waiting 8s for Notion to recompute formulas/rollups...');
    await new Promise(r => setTimeout(r, 8000));
  }
  console.log('Scrub complete.');
}

(async () => {
  console.log('Fetching Master Trade Log...');
  const trades = await queryAll(MTL_DB);
  console.log(`Got ${trades.length} trades`);

  // Build (avwap, trader) groupings from the source-of-truth (alive MTL rows)
  const byAvwap = {};
  const byAvwapTrader = {};
  const allAliveTradeIds = [];
  for (const t of trades) {
    const avwap = getPropValue(t, 'AVWAP TYPE');
    const trader = getPropValue(t, 'Trader');
    allAliveTradeIds.push(t.id);
    if (avwap) {
      (byAvwap[avwap] = byAvwap[avwap] || []).push(t.id);
      if (trader) {
        const k = `${avwap}|${trader}`;
        (byAvwapTrader[k] = byAvwapTrader[k] || []).push(t.id);
      }
    }
  }

  console.log('Fetching AVWAP Stats DB (pre-scrub)...');
  let avwapRows = await queryAll(AVWAP_DB);
  console.log(`Got ${avwapRows.length} AVWAP Stats rows`);

  // Scrub stale Trades relations against the source-of-truth
  await scrubAvwapStats(avwapRows, allAliveTradeIds, byAvwap, byAvwapTrader);

  // Re-fetch with fresh formula/rollup values after scrub
  console.log('Re-fetching AVWAP Stats DB (post-scrub)...');
  avwapRows = await queryAll(AVWAP_DB);

  // Identify sub-rows (have a Parent item) and parents (don't)
  const subRows = [];
  const parentRows = {};
  for (const row of avwapRows) {
    const parentItem = getPropValue(row, 'Parent item');
    const trader = getPropValue(row, 'Trader');
    if (parentItem && parentItem.length > 0 && trader) {
      subRows.push({ row, parentId: parentItem[0], trader });
    } else if (!parentItem || parentItem.length === 0) {
      const title = getPropValue(row, 'AVWAP');
      parentRows[row.id] = { row, title };
    }
  }
  console.log(`Sub-rows: ${subRows.length}, Parent rows: ${Object.keys(parentRows).length}`);

  // Build leaderboard structures
  // Each sub-row × each methodology = one (Trader × AVWAP × Methodology) combo
  const combos = [];
  for (const sub of subRows) {
    const trader = sub.trader;
    const avwapTitle = parentRows[sub.parentId]?.title || '?';
    const totalTrades = getPropValue(sub.row, 'Total') || 0;
    for (const m of METHODOLOGIES) {
      combos.push({
        trader,
        avwap: avwapTitle,
        methodology: m.label,
        methodologyCode: m.code,
        totalTrades,
        winRate: toRate(getPropValue(sub.row, m.wrProp)),
        avgR: getPropValue(sub.row, m.avgRProp) || 0,
        expectancy: getPropValue(sub.row, m.expProp) || 0,
        totalR: getPropValue(sub.row, m.totalRProp) || 0,
      });
    }
  }

  // Compute leaders
  const safeMax = (arr, by) => {
    if (!arr.length) return null;
    let best = arr[0];
    for (const x of arr) if ((by(x) ?? -Infinity) > (by(best) ?? -Infinity)) best = x;
    return best;
  };

  const topCumulativeR = safeMax(combos, c => c.totalR);
  const topWinRate = safeMax(combos.filter(c => c.totalTrades >= MIN_TRADES_FOR_WR), c => c.winRate);
  const topExpectancy = safeMax(combos, c => c.expectancy);

  // Most trades by trader×AVWAP (not per methodology — methodology doesn't change Total)
  const traderAvwapTotals = {};
  for (const sub of subRows) {
    const key = `${sub.trader} on ${parentRows[sub.parentId]?.title || '?'}`;
    traderAvwapTotals[key] = getPropValue(sub.row, 'Total') || 0;
  }
  let mostTradesKey = null, mostTradesValue = -Infinity;
  for (const [k, v] of Object.entries(traderAvwapTotals)) {
    if (v > mostTradesValue) { mostTradesKey = k; mostTradesValue = v; }
  }

  // Biggest single trade — find the max-magnitude R across all 9 methodology
  // outcomes on each trade, then pick the trade with the highest such value.
  // (The MTL `R Outcome` formula returns a binary win/loss flag, not actual R.)
  const TRADE_R_PROPS = [
    'Full TP/R',
    'Entry Partials/R',
    'Entry + L1 Partials/R',
    '5m HA trail/R',
    '5m HA Partials/R',
    '10m HA trail/R',
    '10m HA Partials/R',
    '15m HA trail/R',
    '15m HA Partials/R',
  ];
  let biggestTrade = null, biggestAbs = -Infinity;
  console.log('--- biggest-trade scan ---');
  for (const t of trades) {
    const tradeTrader = getPropValue(t, 'Trader');
    const tradeAvwap = getPropValue(t, 'AVWAP TYPE');
    let bestForThisTrade = null;
    let bestForThisTradeMethod = null;
    const allRs = {};
    for (const p of TRADE_R_PROPS) {
      const v = getPropValue(t, p);
      allRs[p] = v;
      if (v === null || v === undefined) continue;
      const num = typeof v === 'number' ? v : parseFloat(v);
      if (isNaN(num)) continue;
      if (bestForThisTrade === null || Math.abs(num) > Math.abs(bestForThisTrade)) {
        bestForThisTrade = num;
        bestForThisTradeMethod = p.replace('/R', '');
      }
    }
    console.log(`${tradeTrader || '?'} on ${tradeAvwap || '?'}: max=${bestForThisTrade} via ${bestForThisTradeMethod} | values=${JSON.stringify(allRs)}`);
    if (bestForThisTrade === null) continue;
    if (Math.abs(bestForThisTrade) > biggestAbs) {
      biggestAbs = Math.abs(bestForThisTrade);
      biggestTrade = {
        r: bestForThisTrade,
        method: bestForThisTradeMethod,
        trader: tradeTrader,
        avwap: tradeAvwap,
        date: getPropValue(t, 'Date'),
      };
    }
  }
  console.log(`--- biggest selected: ${JSON.stringify(biggestTrade)} ---`);

  // Best AVWAP — for each AVWAP, find the methodology that yields the highest aggregate
  // Total R across all traders for that AVWAP, then pick the AVWAP whose best score is highest.
  // (Avoids the double-counting of summing total R across all 9 methodologies for one AVWAP.)
  const avwapMethodMatrix = {}; // avwap -> methodology -> sum of totalR across traders
  for (const c of combos) {
    if (!avwapMethodMatrix[c.avwap]) avwapMethodMatrix[c.avwap] = {};
    avwapMethodMatrix[c.avwap][c.methodology] = (avwapMethodMatrix[c.avwap][c.methodology] || 0) + (c.totalR || 0);
  }
  const avwapBestScores = Object.entries(avwapMethodMatrix).map(([avwap, methods]) => {
    const [bestMethodology, bestR] = Object.entries(methods).sort((a, b) => b[1] - a[1])[0] || ['(none)', 0];
    return { avwap, bestMethodology, bestR };
  });
  const bestAvwap = avwapBestScores.sort((a, b) => b.bestR - a.bestR)[0] || { avwap: '(no data)', bestMethodology: '', bestR: 0 };

  // Best Methodology — for each methodology, sum total R across all (trader × AVWAP) combos
  // using that methodology. Each trade is counted once per methodology (no double counting).
  const methodTotals = {};
  for (const c of combos) {
    methodTotals[c.methodology] = (methodTotals[c.methodology] || 0) + (c.totalR || 0);
  }
  const bestMethodology = Object.entries(methodTotals).sort((a, b) => b[1] - a[1])[0] || ['(no data)', 0];

  // Top 3 (AVWAP × Methodology) combos — sum total R across all traders for each pair, take top 3
  const avwapMethodTotals = {}; // "avwap||methodology" -> sum
  for (const c of combos) {
    const k = `${c.avwap}||${c.methodology}`;
    avwapMethodTotals[k] = (avwapMethodTotals[k] || 0) + (c.totalR || 0);
  }
  const topCombos = Object.entries(avwapMethodTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, value]) => {
      const [avwap, methodology] = k.split('||');
      return { avwap, methodology, value };
    });

  const data = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    leaders: {
      topCombos: topCombos.map(c => ({
        avwap: c.avwap,
        methodology: c.methodology,
        label: `${c.avwap} × ${c.methodology}`,
        value: `${c.value >= 0 ? '+' : ''}${c.value.toFixed(2)}R`,
      })),
      topWinRate: topWinRate ? {
        label: `${topWinRate.trader} on ${topWinRate.avwap}`,
        sublabel: `${topWinRate.methodology} · ${topWinRate.totalTrades} trades`,
        value: `${(topWinRate.winRate * 100).toFixed(1)}%`,
      } : null,
      mostTrades: mostTradesKey ? {
        label: mostTradesKey,
        sublabel: '',
        value: `${mostTradesValue}`,
      } : null,
      biggestTrade: biggestTrade ? {
        label: `${biggestTrade.trader || '?'} on ${biggestTrade.avwap || '?'}`,
        sublabel: biggestTrade.method ? `${biggestTrade.method}${biggestTrade.date ? ' · ' + biggestTrade.date : ''}` : (biggestTrade.date || ''),
        value: `${biggestTrade.r >= 0 ? '+' : ''}${biggestTrade.r.toFixed(2)}R`,
      } : null,
      topExpectancy: topExpectancy ? {
        label: `${topExpectancy.trader} on ${topExpectancy.avwap}`,
        sublabel: topExpectancy.methodology,
        value: `${topExpectancy.expectancy >= 0 ? '+' : ''}${topExpectancy.expectancy.toFixed(2)}R`,
      } : null,
    },
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
