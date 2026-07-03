// scoreboard/v2/refresh.js
// Runs in GitHub Actions. Fetches Trade Log v3 from Notion, computes
// scoreboard stats for the VCL Clarity V2 widget, writes scoreboard/v2/data.json.

const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN env var');
  process.exit(1);
}

// Trade Log v3 (the master trade log for VCL Clarity V2)
// Note: This is the DATABASE block ID (not the collection ID). The Notion
// public API endpoint /v1/databases/{id}/query requires the database ID.
const MTL_DB = '5057e541-46b5-82f2-be48-015ef5718571';
// AVWAP Stats v3 — used to auto-link trades based on AVWAP TYPE + Pair
const AVWAP_STATS_DB = 'fde7e541-46b5-8276-adef-01079d995d0d';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const headers = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

// Four V2 methodologies. Each has an R Outcome formula and an Exit Price
// column that tells us the methodology was actually used on that trade.
const METHODOLOGIES = [
  { label: '10m HA Trail',         rCol: '10m HA Trail: R Outcome',         exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail + 2R',    rCol: '10m HA Trail + 2R: R Outcome',    exitCol: '10m HA Trail: Exit Price' },
  { label: 'BoS Swing Trail',      rCol: 'BoS Swing Trail: R Outcome',      exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail + 2R', rCol: 'BoS Swing Trail + 2R: R Outcome', exitCol: 'BoS Swing Trail: Exit Price' },
];

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
  const p = page.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title.map(t => t.plain_text).join('');
    case 'rich_text':    return p.rich_text.map(t => t.plain_text).join('');
    case 'number':       return p.number;
    case 'select':       return p.select?.name || null;
    case 'multi_select': return p.multi_select?.map(s => s.name) || [];
    case 'checkbox':     return p.checkbox;
    case 'date':         return p.date?.start || null;
    case 'formula':
      switch (p.formula.type) {
        case 'number':  return p.formula.number;
        case 'string':  return p.formula.string;
        case 'boolean': return p.formula.boolean;
        default:        return null;
      }
    default: return null;
  }
}

function newBucket(avwap, method) {
  return {
    avwap, method, combo: `${avwap} × ${method}`,
    trades: 0, wins: 0, losses: 0,
    totalR: 0, highestR: null,
  };
}

function pushTrade(bucket, r) {
  bucket.trades += 1;
  bucket.totalR += r;
  if (r > 0) bucket.wins += 1;
  else if (r < 0) bucket.losses += 1;
  if (bucket.highestR === null || r > bucket.highestR) bucket.highestR = r;
}

function finalize(bucket) {
  const trades = bucket.trades;
  return {
    ...bucket,
    winRate:    trades > 0 ? bucket.wins / trades : null,
    expectancy: trades > 0 ? bucket.totalR / trades : null,
  };
}

// --- Auto-link helpers -------------------------------------------------------
// For each AVWAP row we need the raw relation array (list of {id} objects).
function getRelationIds(page, name) {
  const p = page.properties?.[name];
  if (!p || p.type !== 'relation') return [];
  return p.relation.map(r => r.id);
}
function getParentRelationIds(page) {
  return getRelationIds(page, 'Parent item');
}

async function patchAvwapStatsRelation(tradeId, avwapStatsIds) {
  const r = await fetch(`${NOTION_API}/pages/${tradeId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      properties: { 'AVWAP Stats': { relation: avwapStatsIds.map(id => ({ id })) } },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`PATCH ${tradeId} failed: ${r.status} ${text}`);
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function autoLinkTrades(trades) {
  console.log('Auto-linking trades to AVWAP Stats rows...');
  const statsRows = await queryAll(AVWAP_STATS_DB);
  console.log(`Got ${statsRows.length} AVWAP Stats rows`);

  // Classify rows into parents (ALL) and sub-rows (per pair)
  // Parents have no "Parent item" relation; sub-rows do.
  const parentByAvwap = {};       // "Trend Swing Point" -> pageId
  const subByAvwapPair = {};       // "Trend Swing Point|MNQ" -> pageId
  for (const row of statsRows) {
    const title = getProp(row, 'AVWAP') || '';
    const pair = getProp(row, 'Pair');
    const parents = getParentRelationIds(row);
    const isSubRow = parents.length > 0;
    // Titles like "🔵 Trend Swing Point" (parent) or "MNQ" (sub-row, title is pair)
    // Match the parent AVWAP by scanning known AVWAP names in the title.
    const AVWAP_NAMES = ['Trend Swing Point', 'Sweep + BoS', 'Session H/L'];
    if (!isSubRow) {
      for (const name of AVWAP_NAMES) {
        if (title.includes(name)) parentByAvwap[name] = row.id;
      }
    } else {
      // Sub-row: figure out parent's AVWAP name from its parent row (or fallback via pair + AVWAP)
      const parentId = parents[0];
      const parent = statsRows.find(r => r.id === parentId);
      const parentTitle = parent ? (getProp(parent, 'AVWAP') || '') : '';
      let parentAvwap = null;
      for (const name of AVWAP_NAMES) if (parentTitle.includes(name)) parentAvwap = name;
      if (parentAvwap && pair) subByAvwapPair[`${parentAvwap}|${pair}`] = row.id;
    }
  }
  console.log('Parent rows found:', Object.keys(parentByAvwap).join(', '));
  console.log('Sub-rows found:', Object.keys(subByAvwapPair).join(', '));

  // For each trade, compute desired relation set = parent(s) + sub-row(s) per AVWAP TYPE
  let updatedCount = 0;
  const updates = [];
  for (const t of trades) {
    const avwapList = getProp(t, 'AVWAP TYPE') || [];
    const pair = getProp(t, 'Pair');
    const desired = new Set();
    for (const avwap of avwapList) {
      if (parentByAvwap[avwap]) desired.add(parentByAvwap[avwap]);
      if (pair && subByAvwapPair[`${avwap}|${pair}`]) desired.add(subByAvwapPair[`${avwap}|${pair}`]);
    }
    const current = new Set(getRelationIds(t, 'AVWAP Stats'));
    if (!setsEqual(current, desired)) {
      updates.push({ id: t.id, ids: [...desired] });
    }
  }
  console.log(`${updates.length} trades need relation updates`);

  // Rate-limit friendly: batches of 3, with a brief pause
  const BATCH = 3;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await Promise.all(batch.map(async u => {
      try {
        await patchAvwapStatsRelation(u.id, u.ids);
        updatedCount += 1;
      } catch (e) {
        console.error(`  relation patch failed for ${u.id}: ${e.message}`);
      }
    }));
    if (i + BATCH < updates.length) await new Promise(r => setTimeout(r, 350));
  }
  console.log(`Auto-linked ${updatedCount} trades`);
  return updatedCount;
}
// -----------------------------------------------------------------------------

(async () => {
  console.log('Fetching Trade Log v3...');
  const trades = await queryAll(MTL_DB);
  console.log(`Got ${trades.length} trades`);

  // Auto-link every trade to the correct AVWAP Stats row(s) based on AVWAP TYPE + Pair
  try {
    await autoLinkTrades(trades);
  } catch (e) {
    console.error('Auto-link failed (continuing to compute scoreboard anyway):', e.message);
  }

  const byCombo = {};
  const byPairCombo = {};
  const bySessionCombo = {};

  for (const t of trades) {
    const avwapList = getProp(t, 'AVWAP TYPE') || [];
    const pair    = getProp(t, 'Pair');
    const session = getProp(t, 'Session');
    if (!avwapList.length) continue;

    for (const avwap of avwapList) {
      for (const m of METHODOLOGIES) {
        const exit = getProp(t, m.exitCol);
        if (exit === null || exit === undefined) continue;
        const r = getProp(t, m.rCol);
        const rNum = typeof r === 'number' ? r : parseFloat(r);
        if (r === null || r === undefined || isNaN(rNum)) continue;

        const cKey = `${avwap}||${m.label}`;
        if (!byCombo[cKey]) byCombo[cKey] = newBucket(avwap, m.label);
        pushTrade(byCombo[cKey], rNum);

        if (pair) {
          const pKey = `${pair}||${cKey}`;
          if (!byPairCombo[pKey]) byPairCombo[pKey] = { pair, ...newBucket(avwap, m.label) };
          pushTrade(byPairCombo[pKey], rNum);
        }
        if (session) {
          const sKey = `${session}||${cKey}`;
          if (!bySessionCombo[sKey]) bySessionCombo[sKey] = { session, ...newBucket(avwap, m.label) };
          pushTrade(bySessionCombo[sKey], rNum);
        }
      }
    }
  }

  const allCombos = Object.values(byCombo).map(finalize).sort((a, b) => b.totalR - a.totalR);
  const top3      = allCombos.slice(0, 3);
  const remaining = allCombos.slice(3);

  const pairMap = {};
  for (const b of Object.values(byPairCombo)) {
    if (!pairMap[b.pair] || b.totalR > pairMap[b.pair].totalR) pairMap[b.pair] = b;
  }
  const PAIR_ORDER = ['MNQ', 'MES', 'SOL', 'MYM'];
  const byPair = PAIR_ORDER.map(p => pairMap[p]).filter(Boolean).map(finalize);

  const avwapMap = {};
  for (const b of allCombos) {
    if (!avwapMap[b.avwap] || b.totalR > avwapMap[b.avwap].totalR) avwapMap[b.avwap] = b;
  }
  const AVWAP_ORDER = ['Trend Swing Point', 'Sweep + BoS', 'Session H/L'];
  const bestPerAvwap = AVWAP_ORDER.map(a => avwapMap[a]).filter(Boolean);

  const topWR = allCombos
    .filter(c => c.trades >= 1 && c.winRate !== null)
    .slice()
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, 3);

  const sessionMap = {};
  for (const b of Object.values(bySessionCombo)) {
    if (!sessionMap[b.session] || b.totalR > sessionMap[b.session].totalR) sessionMap[b.session] = b;
  }
  const SESSION_ORDER = ['ASIA', 'LON', 'NY'];
  const bestPerSession = SESSION_ORDER.map(s => sessionMap[s]).filter(Boolean).map(finalize);

  const data = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    top3,
    byPair,
    bestPerAvwap,
    topWR,
    bestPerSession,
    remaining,
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath}: ${allCombos.length} combos`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
