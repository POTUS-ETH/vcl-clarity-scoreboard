// Cloudflare Worker: computes VCL Clarity V2 scoreboard directly from Notion.
// Deploy via `wrangler deploy` (see README in this folder).
//
// Env vars required (set via `wrangler secret put`):
//   NOTION_TOKEN — Notion integration secret
//
// Public endpoint: GET /  →  returns same JSON shape as v2/data.json.
// Widget fetches from this Worker URL for near-instant refresh.

const MTL_DB = '5057e541-46b5-82f2-be48-015ef5718571'; // Trade Log v3 database ID
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const METHODOLOGIES = [
  { label: '10m HA Trail',         rCol: '10m HA Trail: R Outcome',         exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail + 2R',    rCol: '10m HA Trail + 2R: R Outcome',    exitCol: '10m HA Trail: Exit Price' },
  { label: 'BoS Swing Trail',      rCol: 'BoS Swing Trail: R Outcome',      exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail + 2R', rCol: 'BoS Swing Trail + 2R: R Outcome', exitCol: 'BoS Swing Trail: Exit Price' },
];

async function queryAll(dbId, token) {
  const rows = [];
  let cursor;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Query ${dbId} failed: ${r.status} ${await r.text()}`);
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
  return { avwap, method, combo: `${avwap} × ${method}`, trades: 0, wins: 0, losses: 0, totalR: 0, highestR: null };
}
function pushTrade(b, r) {
  b.trades += 1; b.totalR += r;
  if (r > 0) b.wins += 1; else if (r < 0) b.losses += 1;
  if (b.highestR === null || r > b.highestR) b.highestR = r;
}
function finalize(b) {
  return { ...b, winRate: b.trades > 0 ? b.wins / b.trades : null, expectancy: b.trades > 0 ? b.totalR / b.trades : null };
}

async function computeScoreboard(token) {
  const trades = await queryAll(MTL_DB, token);

  const byCombo = {}, byPairCombo = {}, bySessionCombo = {};

  for (const t of trades) {
    const avwapList = getProp(t, 'AVWAP TYPE') || [];
    const pair = getProp(t, 'Pair');
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
  const top3 = allCombos.slice(0, 3);
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

  return {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    top3, byPair, bestPerAvwap, topWR, bestPerSession, remaining,
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.NOTION_TOKEN) {
      return new Response(JSON.stringify({ error: 'Missing NOTION_TOKEN secret' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    try {
      const data = await computeScoreboard(env.NOTION_TOKEN);
      return new Response(JSON.stringify(data), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};
