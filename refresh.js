// scoreboard/refresh.js
// Runs in GitHub Actions. Fetches AVWAP Stats + Trade Log v2 from Notion,
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
// Trade Log v2 — the new master trade log with structured price inputs and convention-A R math.
// (This is the inline-view block id on VCL Clarity, which doubles as the public-API database id.)
const MTL_DB = 'edba84db-7e45-4f54-8b23-d8d7c9059c6e';

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
  return updates.length;  // caller can decide if a re-fetch is needed
}

// Map from methodology label → R column name on Trade Log v2
const METHOD_R_COL = {
  'Full TP':         'Full TP R',
  'Entry Partials':  'Entry Partials R',
  'Entry + L1':      'Entry + L1 R',
  '5m HA Trail':     '5m HA Trail R',
  '5m HA Partials':  '5m HA Partials R',
  '10m HA Trail':    '10m HA Trail R',
  '10m HA Partials': '10m HA Partials R',
  '15m HA Trail':    '15m HA Trail R',
  '15m HA Partials': '15m HA Partials R',
};

(async () => {
  console.log('Fetching Trade Log v2...');
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
  const scrubbedCount = await scrubAvwapStats(avwapRows, allAliveTradeIds, byAvwap, byAvwapTrader);

  // Only re-fetch if the scrub actually changed something — otherwise we already have
  // valid formula/rollup values from the first query, and avoiding a second query
  // sidesteps Notion's flaky permission cache.
  if (scrubbedCount > 0) {
    console.log('Re-fetching AVWAP Stats DB (post-scrub)...');
    try {
      avwapRows = await queryAll(AVWAP_DB);
    } catch (e) {
      console.error(`post-scrub re-fetch failed (${e.message}); using pre-scrub data`);
    }
  } else {
    console.log('No scrub changes — using leaders from pre-scrub data');
  }

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

  // Aggregate per (AVWAP × Methodology) — sum across traders.
  // winSum / tradeSum gives weighted win rate. totalR is summed directly.
  const aggByKey = {}; // "avwap||methodology" -> { totalR, winSum, tradeSum, avwap, methodology, code }
  for (const sub of subRows) {
    const avwap = parentRows[sub.parentId]?.title || '?';
    const tradeCount = getPropValue(sub.row, 'Total') || 0;
    for (const m of METHODOLOGIES) {
      const key = `${avwap}||${m.label}`;
      if (!aggByKey[key]) {
        aggByKey[key] = { totalR: 0, winSum: 0, tradeSum: 0, avwap, methodology: m.label, code: m.code };
      }
      const wr = toRate(getPropValue(sub.row, m.wrProp));
      const tr = getPropValue(sub.row, m.totalRProp) || 0;
      aggByKey[key].totalR += tr;
      aggByKey[key].winSum += wr * tradeCount;
      aggByKey[key].tradeSum += tradeCount;
    }
  }

  // Highest single R per (AVWAP × Methodology) — scan trades.
  const highestByKey = {}; // "avwap||methodology" -> { r, trader, date }
  for (const t of trades) {
    const avwap = getPropValue(t, 'AVWAP TYPE');
    if (!avwap) continue;
    for (const [methLabel, rCol] of Object.entries(METHOD_R_COL)) {
      const v = getPropValue(t, rCol);
      if (v === null || v === undefined) continue;
      const num = typeof v === 'number' ? v : parseFloat(v);
      if (isNaN(num)) continue;
      const key = `${avwap}||${methLabel}`;
      if (!highestByKey[key] || num > highestByKey[key].r) {
        highestByKey[key] = { r: num, trader: getPropValue(t, 'Trader'), date: getPropValue(t, 'Date') };
      }
    }
  }

  // Build leaderboard rows, sorted by Total R descending.
  const leaderboard = Object.values(aggByKey)
    .map(c => {
      const key = `${c.avwap}||${c.methodology}`;
      const highest = highestByKey[key]?.r ?? null;
      return {
        avwap: c.avwap,
        methodology: c.methodology,
        code: c.code,
        trades: c.tradeSum,
        winRate: c.tradeSum > 0 ? c.winSum / c.tradeSum : null,
        expectancy: c.tradeSum > 0 ? c.totalR / c.tradeSum : null,
        totalR: c.totalR,
        highestR: highest,
      };
    })
    .sort((a, b) => b.totalR - a.totalR);

  const data = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    leaderboard,
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath} with ${leaderboard.length} combos`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
