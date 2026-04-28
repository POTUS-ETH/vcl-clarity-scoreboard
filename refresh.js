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

async function getPageTitle(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, { headers });
  if (!r.ok) return null;
  const j = await r.json();
  return getPropValue(j, 'AVWAP') || getPropValue(j, 'Title') || pageId;
}

(async () => {
  console.log('Fetching AVWAP Stats DB...');
  const avwapRows = await queryAll(AVWAP_DB);
  console.log(`Got ${avwapRows.length} AVWAP Stats rows`);

  console.log('Fetching Master Trade Log...');
  const trades = await queryAll(MTL_DB);
  console.log(`Got ${trades.length} trades`);

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
        winRate: getPropValue(sub.row, m.wrProp) || 0,
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

  // Biggest single trade — from MTL R Outcome
  let biggestTrade = null, biggestAbs = -Infinity;
  for (const t of trades) {
    const r = getPropValue(t, 'R Outcome');
    if (r === null || r === undefined) continue;
    if (Math.abs(r) > biggestAbs) {
      biggestAbs = Math.abs(r);
      biggestTrade = {
        r,
        trader: getPropValue(t, 'Trader'),
        avwap: getPropValue(t, 'AVWAP TYPE'),
        date: getPropValue(t, 'Date'),
      };
    }
  }

  // Best AVWAP — by max combo total R aggregated across methodologies in that AVWAP
  const avwapTotals = {};
  for (const c of combos) {
    avwapTotals[c.avwap] = (avwapTotals[c.avwap] || 0) + (c.totalR || 0);
  }
  const bestAvwap = Object.entries(avwapTotals).sort((a, b) => b[1] - a[1])[0] || ['(no data)', 0];

  // Best Methodology — by max total R aggregated across all combos for that methodology
  const methodTotals = {};
  for (const c of combos) {
    methodTotals[c.methodology] = (methodTotals[c.methodology] || 0) + (c.totalR || 0);
  }
  const bestMethodology = Object.entries(methodTotals).sort((a, b) => b[1] - a[1])[0] || ['(no data)', 0];

  // Best AVWAP × Methodology combo — sum total R across all traders for each (avwap, methodology) pair
  const avwapMethodTotals = {};
  for (const c of combos) {
    const k = `${c.avwap} × ${c.methodology}`;
    avwapMethodTotals[k] = (avwapMethodTotals[k] || 0) + (c.totalR || 0);
  }
  const bestAvwapMethod = Object.entries(avwapMethodTotals).sort((a, b) => b[1] - a[1])[0] || ['(no data)', 0];

  const data = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    leaders: {
      topCumulativeR: topCumulativeR ? {
        label: `${topCumulativeR.trader} on ${topCumulativeR.avwap}`,
        sublabel: topCumulativeR.methodology,
        value: `${topCumulativeR.totalR.toFixed(2)}R`,
      } : null,
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
        sublabel: biggestTrade.date || '',
        value: `${biggestTrade.r >= 0 ? '+' : ''}${biggestTrade.r.toFixed(2)}R`,
      } : null,
      topExpectancy: topExpectancy ? {
        label: `${topExpectancy.trader} on ${topExpectancy.avwap}`,
        sublabel: topExpectancy.methodology,
        value: `${topExpectancy.expectancy >= 0 ? '+' : ''}${topExpectancy.expectancy.toFixed(2)}R`,
      } : null,
      bestAvwap: {
        label: bestAvwap[0],
        sublabel: 'aggregated across methodologies',
        value: `${bestAvwap[1].toFixed(2)}R`,
      },
      bestMethodology: {
        label: bestMethodology[0],
        sublabel: 'aggregated across AVWAPs',
        value: `${bestMethodology[1].toFixed(2)}R`,
      },
      bestAvwapMethod: {
        label: bestAvwapMethod[0],
        sublabel: 'aggregated across traders',
        value: `${bestAvwapMethod[1].toFixed(2)}R`,
      },
    },
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
