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
// Craig's database has since been split into multiple data sources server-side (the MCP tools
// address it as collection://f8aaa471-...  — a different ID from the database ID below). Querying
// it through the legacy /databases/{id}/query endpoint under the pre-split API version silently
// returns only one data source's rows with has_more:false, not an error — so it can't share
// queryAll()/NOTION_VERSION with the other (still single-source) boards. This path is scoped to
// Craig only; leave the rest on the old endpoint, which is working correctly for them.
const CRAIG_DATA_SOURCE = 'f8aaa471-18bb-4436-a1ae-8def2dc1033c'; // database: 72f82a1bf61a4a56ab81e61b6b2aabdf
const NOTION_VERSION_DS = '2025-09-03';

const METHODOLOGIES = [
  { label: '10m HA Trail',                 rCol: '10m HA Trail: R Outcome',                 exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail + 2R',            rCol: '10m HA Trail + 2R: R Outcome',            exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail +1R Scaling',     rCol: '10m HA Trail +1R Scaling: R Outcome',     exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail + 1R Full TP',    rCol: '10m HA Trail + 1R Full TP: R Outcome',    exitCol: '10m HA Trail: Exit Price' },
  { label: '10m HA Trail + 2R Full TP',    rCol: '10m HA Trail + 2R Full TP: R Outcome',    exitCol: '10m HA Trail: Exit Price' },
  { label: 'BoS Swing Trail',              rCol: 'BoS Swing Trail: R Outcome',              exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail + 2R',         rCol: 'BoS Swing Trail + 2R: R Outcome',         exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail +1R Scaling',  rCol: 'BoS Swing Trail +1R Scaling: R Outcome',  exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail + 1R Full TP', rCol: 'BoS Swing Trail + 1R Full TP: R Outcome', exitCol: 'BoS Swing Trail: Exit Price' },
  { label: 'BoS Swing Trail + 2R Full TP', rCol: 'BoS Swing Trail + 2R Full TP: R Outcome', exitCol: 'BoS Swing Trail: Exit Price' },
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
    // Sort ascending so array order IS chronological order. Consumers walk the
    // array to compute drawdown; without this Notion returns newest-first and
    // every peak-to-trough figure is measured over a reversed sequence.
    const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] };
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

async function queryAllDataSource(dataSourceId, token) {
  const rows = [];
  let cursor;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION_DS,
    'Content-Type': 'application/json',
  };
  do {
    const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/data_sources/${dataSourceId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Query data source ${dataSourceId} failed: ${r.status} ${await r.text()}`);
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
    case 'unique_id':
    case 'auto_increment_id': {
      const v = p[p.type];
      return (v && typeof v === 'object') ? (v.number ?? null) : (v ?? null);
    }
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
    avwap, method,
    combo: `${avwap} × ${method}`,
    trades: 0, wins: 0, losses: 0,
    totalR: 0, highestR: null,
    tradeLog: [], // { date, ct, r } for per-day drawdown calc
  };
}
function pushTrade(b, r, date, ct) {
  b.trades += 1; b.totalR += r;
  if (r > 0) b.wins += 1; else if (r < 0) b.losses += 1;
  if (b.highestR === null || r > b.highestR) b.highestR = r;
  if (date) b.tradeLog.push({ date, ct: ct || '', r });
}

// Worst intraday R drawdown = max peak-to-trough decline in cumulative R within a single day.
// Trades are ordered by createdTime within each day.
function computeWorstDayDD(tradeLog) {
  if (!tradeLog || !tradeLog.length) return { worstDayDD: 0, worstDayDate: null };
  const byDate = {};
  for (const t of tradeLog) {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }
  let worstDD = 0, worstDate = null;
  for (const [date, ts] of Object.entries(byDate)) {
    ts.sort((a, b) => (a.ct || '').localeCompare(b.ct || ''));
    let cum = 0, peak = 0, dayDD = 0;
    for (const t of ts) {
      cum += t.r;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > dayDD) dayDD = dd;
    }
    if (dayDD > worstDD) { worstDD = dayDD; worstDate = date; }
  }
  return { worstDayDD: worstDD, worstDayDate: worstDate };
}

function finalize(b) {
  const dd = computeWorstDayDD(b.tradeLog);
  const { tradeLog, ...rest } = b;
  return {
    ...rest,
    winRate: b.trades > 0 ? b.wins / b.trades : null,
    expectancy: b.trades > 0 ? b.totalR / b.trades : null,
    worstDayDD: dd.worstDayDD,
    worstDayDate: dd.worstDayDate,
  };
}

async function computeScoreboard(token) {
  const trades = await queryAll(MTL_DB, token);

  const byCombo = {}, byPairCombo = {}, bySessionCombo = {};

  for (const t of trades) {
    const avwapList = getProp(t, 'AVWAP TYPE') || [];
    const pair = getProp(t, 'Pair');
    const session = getProp(t, 'Session');
    const date = getProp(t, 'Date'); // ISO date string
    const ct = t.created_time || '';  // ISO createdTime string — used to order trades within a day
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
        pushTrade(byCombo[cKey], rNum, date, ct);

        if (pair) {
          const pKey = `${pair}||${cKey}`;
          if (!byPairCombo[pKey]) byPairCombo[pKey] = { pair, ...newBucket(avwap, m.label) };
          pushTrade(byPairCombo[pKey], rNum, date, ct);
        }
        if (session) {
          const sKey = `${session}||${cKey}`;
          if (!bySessionCombo[sKey]) bySessionCombo[sKey] = { session, ...newBucket(avwap, m.label) };
          pushTrade(bySessionCombo[sKey], rNum, date, ct);
        }
      }
    }
  }

  const allCombos = Object.values(byCombo).map(finalize).sort((a, b) => b.totalR - a.totalR);

  // Top 3 = best combo per AVWAP type, ranked by that type's winning combo's totalR.
  // No duplicate AVWAP types in the podium.
  const avwapMap = {};
  for (const b of allCombos) {
    if (!avwapMap[b.avwap] || b.totalR > avwapMap[b.avwap].totalR) avwapMap[b.avwap] = b;
  }
  const top3 = Object.values(avwapMap).sort((a, b) => b.totalR - a.totalR).slice(0, 3);
  const top3Keys = new Set(top3.map(c => c.combo));
  const remaining = allCombos.filter(c => !top3Keys.has(c.combo));

  const pairMap = {};
  for (const b of Object.values(byPairCombo)) {
    if (!pairMap[b.pair] || b.totalR > pairMap[b.pair].totalR) pairMap[b.pair] = b;
  }
  const PAIR_ORDER = ['MNQ', 'MES', 'SOL', 'MYM'];
  const byPair = PAIR_ORDER.map(p => pairMap[p]).filter(Boolean).map(finalize);

  const AVWAP_ORDER = ['Trend Swing Point', 'Sweep + BoS', 'Session H/L', 'Session Open'];
  const bestPerAvwap = AVWAP_ORDER.map(a => avwapMap[a]).filter(Boolean);

  // Worst 3 intraday drawdowns across all combos (the roughest days to sit through)
  const worstDD = allCombos
    .filter(c => c.worstDayDD > 0)
    .slice()
    .sort((a, b) => (b.worstDayDD ?? 0) - (a.worstDayDD ?? 0))
    .slice(0, 3);

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
    top3, byPair, bestPerAvwap, worstDD, topWR, bestPerSession, remaining,
  };
}

// Slim per-trade payload for the calendar view.
// Client filters/aggregates locally, so we send one row per trade with all R outcomes.
async function computeCalendarData(token) {
  const trades = await queryAll(MTL_DB, token);
  const rows = [];
  for (const t of trades) {
    const date = getProp(t, 'Date');
    if (!date) continue;
    const avwapList = getProp(t, 'AVWAP TYPE') || [];
    if (!avwapList.length) continue;
    const r = {};
    for (const m of METHODOLOGIES) {
      const val = getProp(t, m.rCol);
      const n = typeof val === 'number' ? val : parseFloat(val);
      if (val !== null && val !== undefined && !isNaN(n)) r[m.label] = n;
    }
    if (!Object.keys(r).length) continue;
    rows.push({
      id: t.id,
      date,
      ct: t.created_time || '',
      avwap: avwapList,
      pair: getProp(t, 'Pair') || null,
      session: getProp(t, 'Session') || null,
      trader: getProp(t, 'Trader') || null,
      direction: getProp(t, 'Direction') || null,
      r,
    });
  }
  return { generatedAt: new Date().toISOString(), tradeCount: rows.length, trades: rows };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

// ── VCL v3 (Sweep+BoS) ──────────────────────────────────────────────
// Returns RAW inputs only; the v3 widget recomputes R client-side using the
// corrected full-ladder model (single source of truth in v3.html).
const V3_DB = '1c62f731085940f095b489598b0f55c0';           // futures (MES/MNQ)
// ...which has since been split server-side exactly like Craig's board, so the legacy
// /databases/{id}/query path returns zero rows with has_more:false rather than erroring.
// ?view=v3 had been silently reporting an empty log while 116 trades sat in it.
const V3_DATA_SOURCE = 'a9821f82-d4cc-4652-a6ad-46969c4fc0da';
const V3_CRYPTO_DB = '17736d193e324254b76cbf9054b89184';     // VCL Clarity V3 — CRYPTO (ETH+SOL, Pair-tagged)
const V4_FUTURES_DATA_SOURCE = '36c587c3-62eb-4387-bd8c-f792ce46cf46'; // VCL Clarity V4 — FUTURES (MNQ/MES/MGC, 15s only)

// Craig's outcome columns. Read straight off the Notion formulas so there is exactly
// one place the R math lives.
// Remaining set = stop management (BE / PVS trail) x target (1.618 / 2.272)
// x fill scheme (Entry only / Entry+L1 / Entry+L1 with 50% off at the lock).
//
// EVS (O7-O12) retired 2026-08-16 — over 32 logged 1m trades the entry-VWAP trail
// returned a value identical to plain BE on every matched row (paired delta +0.000R).
// The O-numbers are deliberately NOT renumbered: this is an explicit key->column map,
// not a positional list, so retiring a methodology can never silently shift the others
// onto the wrong Notion column.
const CRAIG_OUTCOMES = {
  O1:  'O1 · BE 1.618 · Entry',   O2:  'O2 · BE 1.618 · Entry+L1',   O3:  'O3 · BE 1.618 · 50%',
  O4:  'O4 · BE 2.272 · Entry',   O5:  'O5 · BE 2.272 · Entry+L1',   O6:  'O6 · BE 2.272 · 50%',
  O13: 'O13 · PVS 1.618 · Entry', O14: 'O14 · PVS 1.618 · Entry+L1', O15: 'O15 · PVS 1.618 · 50%',
  O16: 'O16 · PVS 2.272 · Entry', O17: 'O17 · PVS 2.272 · Entry+L1', O18: 'O18 · PVS 2.272 · 50%',
};

async function computeCraig(token) {
  const trades = await queryAllDataSource(CRAIG_DATA_SOURCE, token);
  const rows = [];
  for (const t of trades) {
    const title = getProp(t, 'Trade') || '';
    if (title.toUpperCase().startsWith('TEST')) continue;
    // an empty "+ New" row has no Entry Price at all — distinct from a real trade with blank
    // outcomes, which must never be skipped. This is the one field every logged attempt has.
    if (getProp(t, 'Entry Price') == null) continue;
    const o = {};
    for (const [key, name] of Object.entries(CRAIG_OUTCOMES)) o[key] = getProp(t, name);
    rows.push({
      id:        t.id,            // stable row identity — lets a board figure be traced to a trade
      created:   t.created_time,  // the only reliable ordering key; Date has no time component
      Trade:     title,
      Direction: getProp(t, 'Direction'),
      Timeframe: getProp(t, 'Timeframe'),
      Session:   getProp(t, 'Session'),
      Pair:      getProp(t, 'Pair'),
      L1Filled:  getProp(t, 'L1 Filled'),
      RangePct:  getProp(t, 'Range %'),
      date:      getProp(t, 'Date'),
      entryTime: getProp(t, 'Entry Time'),  // chart-clock timestamp of the entry fill;
                                            // the key that makes a row machine-verifiable
                                            // against exchange tape. See verify/verify.js.
      // EVS Hit / EVS Price retired 2026-08-16 — the Notion fields are kept so the 8 rows
      // Craig already chart-read aren't destroyed, but nothing consumes them anymore.
      pvsHit1:   getProp(t, 'PVS Hit 1.618'),
      pvsHit2:   getProp(t, 'PVS Hit 2.272'),
      pvsPrice:  getProp(t, 'PVS Price'),
      retracedToEntry: getProp(t, 'Retraced to Entry After L1'), // definitive gate for the 50%-off partial firing
      movedStopToBE:   getProp(t, 'Moved Stop to BE'),
      closedAtBE:      getProp(t, 'Closed at BE'),
      // raw inputs, so a consumer can check a published R against its own geometry
      entry:     getProp(t, 'Entry Price'),
      l1:        getProp(t, 'L1 Price'),
      sl:        getProp(t, 'SL Price'),
      maxRun:    getProp(t, 'Max Run'),
      anchor:    getProp(t, '1 of Fib Price'),   // fib 1.0 — drives the BE move on all 18
      t1618:     getProp(t, '1.618 Price'),
      t2272:     getProp(t, '2.272 Price'),
      notes:     getProp(t, 'Notes'),
      o,
    });
  }
  return {
    updated: new Date().toISOString(),
    tradeCount: rows.length,
    queriedCount: trades.length,   // rows.length is post-filter; expose both so drops are visible
    skipped: trades.length - rows.length,
    trades: rows,
  };
}

// ── Grant's TCL fib backtest tracker ────────────────────────────────
// Own database, own data source — nothing shared with Craig's board. Every R
// field is a Notion formula already (see the tracker's own schema comments);
// this just reads them straight through, same as Craig's O1-O18.
const GRANT_DATA_SOURCE = '60340af5-26f9-4dff-94c6-87f1bd61ac24'; // database: 799c95fa12044ca49acc0f8d90de29d3

async function computeGrant(token) {
  const trades = await queryAllDataSource(GRANT_DATA_SOURCE, token);
  const rows = [];
  for (const t of trades) {
    const title = getProp(t, 'Trade') || '';
    // A TEST-prefixed title IS the test marker — the separate checkbox was redundant with
    // it. These rows come through rather than being skipped, because the board needs to
    // render its hazard banner over them; suppressing them here would just make a log full
    // of fake rows look like an empty one, which is how this bit went wrong before.
    const isTest = title.toUpperCase().startsWith('TEST');
    // an empty "+ New" row has no Entry Price at all — distinct from a real trade with blank
    // outcomes, which must never be skipped.
    if (getProp(t, 'Entry Price') == null) continue;
    rows.push({
      id:        t.id,
      created:   t.created_time,
      num:       getProp(t, '#'),
      isTest,                                 // synthetic row, never a real chart read
      Trade:     title,
      Direction: getProp(t, 'Direction'),
      Timeframe: getProp(t, 'Timeframe'),
      Session:   getProp(t, 'Session'),
      Pair:      getProp(t, 'Pair'),
      date:      getProp(t, 'Date'),
      // Only Entry and the 1-of-fib anchor are typed; the rest of the geometry is solved
      // in Notion off those two (v4's rule). Max Run and the trail exit are the outcomes.
      entry:     getProp(t, 'Entry Price'),
      anchor:    getProp(t, '1 of Fib Price'),
      maxRun:    getProp(t, 'Max Run'),
      bosExit:   getProp(t, 'Trailing BOS Exit'),
      // solved geometry, exposed so a consumer can re-derive any R independently
      fib0:      getProp(t, 'Fib 0 Price'),
      stop:      getProp(t, 'Stop Price'),
      tp:        getProp(t, 'TP Price'),
      oneR:      getProp(t, '1R (price)'),
      rangePct:  getProp(t, 'Range %'),
      notes:     getProp(t, 'Notes'),
      // the eight outcomes, straight off the Notion formulas
      maxRunR:     getProp(t, 'Max Run R'),
      bosExitR:    getProp(t, 'BOS Exit R'),          // = full size, no partial, BE + trail
      smFull1R:    getProp(t, 'Full TP @ 1R'),
      smFull2R:    getProp(t, 'Full TP @ 2R'),
      smFull3R:    getProp(t, 'Full TP @ 3R'),
      smFull5R:    getProp(t, 'Full TP @ 5R'),
      smCap1272:   getProp(t, '50% then cap 1.272'),
      smCap1866:   getProp(t, '50% then cap 1.866'),
      tpTrailBOS:  getProp(t, '50% then trail (incumbent)'),
    });
  }
  return {
    updated: new Date().toISOString(),
    tradeCount: rows.length,
    queriedCount: trades.length,
    skipped: trades.length - rows.length,
    trades: rows,
  };
}


// ── Trade Log v3 raw geometry ────────────────────────────────────────
// Exposes the fib inputs from the master log so the V5 outcome set can be re-scored
// against it. Entry Price is a TEXT property in this log (not number), so it is parsed
// rather than read straight through.
async function computeV3Raw2(token) {
  const trades = await queryAll(MTL_DB, token);
  const num = v => { if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  return {
    updated: new Date().toISOString(),
    tradeCount: trades.length,
    trades: trades.map(t => ({
      id: t.id, date: getProp(t, 'Date'), pair: getProp(t, 'Pair'),
      dir: getProp(t, 'Direction'), session: getProp(t, 'Session'),
      trader: getProp(t, 'Trader'), avwap: getProp(t, 'AVWAP TYPE') || [],
      entry: num(getProp(t, 'Entry Price')),
      l1:    num(getProp(t, 'L1 Price')),
      sl:    num(getProp(t, 'SL Price')),
      rangePct: getProp(t, 'Range %'),
      bosMaxR:  getProp(t, 'BoS Swing Trail: Max R Price'),
      bosExit:  getProp(t, 'BoS Swing Trail: Exit Price'),
      haMaxR:   getProp(t, '10m HA Trail: Max R Price'),
      haExit:   getProp(t, '10m HA Trail: Exit Price'),
    })),
  };
}


// ── Screenshot URLs for the V3 log ───────────────────────────────────
// Notion hands back short-lived signed S3 links for file properties; getProp() drops them
// because it has no 'files' case. This exposes them so chart images can actually be pulled
// down and looked at. Links expire in about an hour — re-fetch rather than caching them.
async function computeV3Shots(token) {
  const trades = await queryAllDataSource(V3_DATA_SOURCE, token);
  const fileUrls = page => {
    const p = page.properties?.['Screenshot'];
    if (!p || p.type !== 'files') return [];
    return (p.files || []).map(f => f?.file?.url || f?.external?.url).filter(Boolean);
  };
  return {
    updated: new Date().toISOString(),
    trades: trades.map(t => ({
      id: t.id, date: getProp(t, 'Date'), pair: getProp(t, 'Pair'),
      tf: getProp(t, 'Timeframe'), dir: getProp(t, 'Direction'),
      entry: getProp(t, 'Entry Price'), sl: getProp(t, 'SL Price'),
      l1: getProp(t, 'L1 Price'), maxRun: getProp(t, 'Max Run'),
      bosExit: getProp(t, 'BoS Exit'), notes: getProp(t, 'Notes'),
      shots: fileUrls(t),
    })),
  };
}

async function computeV3Raw(token, dbId) {
  const trades = dbId === V3_DB
    ? await queryAllDataSource(V3_DATA_SOURCE, token)   // split source; see note above
    : await queryAll(dbId, token);
  const rows = [];
  for (const t of trades) {
    const title = getProp(t, 'Trade') || '';
    if (title.toUpperCase().startsWith('TEST')) continue; // ignore scaffolding rows
    rows.push({
      Trade:      title,
      Direction:  getProp(t, 'Direction'),
      Timeframe:  getProp(t, 'Timeframe'),
      Session:    getProp(t, 'Session'),
      Pair:       getProp(t, 'Pair'),
      EntryPrice: getProp(t, 'Entry Price'),
      L1Price:    getProp(t, 'L1 Price'),
      SLPrice:    getProp(t, 'SL Price'),
      MaxRun:     getProp(t, 'Max Run'),
      BoSExit:    getProp(t, 'BoS Exit'),
      L1before:   getProp(t, 'L1 before Max Run'),
      L1after:    getProp(t, 'L1 after Max Run'),
      RangePct:   getProp(t, 'Range %'),
      date:       getProp(t, 'Date'),
      Session:    getProp(t, 'Session'),
      // The log's OWN scored outcomes — the ladder methodology as actually tested.
      // Needed to compare like-for-like against the V5 re-scoring rather than against
      // a number computed a different way.
      v3_full1R:  getProp(t, 'R Full @1R'),
      v3_full2R:  getProp(t, 'R Full @2R'),
      v3_half1R:  getProp(t, 'R 50% @1R'),
      v3_half2R:  getProp(t, 'R 50% @2R'),
    });
  }
  return { updated: new Date().toISOString(), generatedAt: new Date().toISOString(), tradeCount: rows.length, trades: rows };
}

// ── VCL v4 (Sweep+BoS, futures) ──────────────────────────────────────
// Same raw-inputs-only contract as v3: Notion holds geometry + hand-read outcomes,
// the widget (v4-futures.html) is the single place R gets computed. New here is
// the multi-source data model (queryAllDataSource, not queryAll) and two additions
// the log carries but this view does not yet consume: Taken/Skip Reason (so a
// rejected setup is on record instead of silently absent) and four timestamps
// (Entry Time, AVWAP Anchor Time, BoS Confirm Time, Exit Time) kept for future
// tape-verification the way Entry Time already works for Craig's crypto board.
async function computeV4Futures(token) {
  const trades = await queryAllDataSource(V4_FUTURES_DATA_SOURCE, token);
  const rows = [];
  for (const t of trades) {
    const title = getProp(t, 'Trade') || '';
    if (title.toUpperCase().startsWith('TEST')) continue; // ignore scaffolding rows
    // Skip only a setup EXPLICITLY marked as passed on. `Taken` was never actually added
    // to this log's schema, so getProp returns null for every row — and `!null` was
    // skipping all 11 logged trades, leaving the v4 board silently empty rather than
    // erroring. Absence of the field must mean "taken", not "not taken".
    if (getProp(t, 'Taken') === false) continue;
    if (getProp(t, 'Entry Price') == null) continue;      // an empty "+ New" row, not a trade
    rows.push({
      Trade:      title,
      Direction:  getProp(t, 'Direction'),
      Timeframe:  getProp(t, 'Timeframe'),
      Session:    getProp(t, 'Session'),
      Pair:       getProp(t, 'Pair'),
      EntryPrice: getProp(t, 'Entry Price'),
      L1Price:    getProp(t, 'L1 Price'),
      SLPrice:    getProp(t, 'SL Price'),
      MaxRun:     getProp(t, 'Max Run'),
      BoSExit:    getProp(t, 'BoS Exit'),
      L1before:   getProp(t, 'L1 before Max Run'),
      L1after:    getProp(t, 'L1 after Max Run'),
      RangePct:   getProp(t, 'Range %'),
      date:       getProp(t, 'Date'),
      // Max Adverse is the worst price reached BEFORE Max Run. It is what lets one row
      // score two models at once: compare it against fib 0 for the ladder stop, against
      // fib 0.085 for the Super Mario stop, and against fib 0.17 for the L1 fill. Without
      // it the tighter stop is a counterfactual no amount of bar data can settle once
      // 15s history ages out (~30 days).
      MaxAdverse: getProp(t, 'Max Adverse'),
      anchor:     getProp(t, '1 of Fib Price'),
      // Times are plain HHMM text plus a Timezone select — a calendar picker per row was
      // too slow to log during a session.
      entryTime:  getProp(t, 'Entry Time (HHMM)'),
      anchorTime: getProp(t, 'Anchor Time (HHMM)'),
      exitTime:   getProp(t, 'Exit Time (HHMM)'),
      tz:         getProp(t, 'Timezone'),
    });
  }
  return { updated: new Date().toISOString(), generatedAt: new Date().toISOString(), tradeCount: rows.length, trades: rows };
}

// ── Prop Firm Rotation Tracker (live Notion-backed dashboard) ─────────
// Read: GET ?view=prop returns accounts + trade log + payout log.
// Write: POST { token, action, ...} — token must match env.WRITE_TOKEN.
const PROP_ACCOUNTS_DB   = '62194cc58c014cbfbde3a0e5defd85d2';
const PROP_TRADE_LOG_DB  = '1f754291902c4d3bb671b7d7e83e22d2';
const PROP_PAYOUT_LOG_DB = 'ef64fac8910a4d4988970b7f5c28e1d5';
const PROP_FIRMS_DB      = 'b0efbedeffb84410ad9c3a55e80a9ed7';
const PORTFOLIO_HQ_PAGE  = '3a07e541-46b5-8191-9bdc-d67a995b6814';

async function notionCreatePage(dbId, properties, token) {
  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  if (!r.ok) throw new Error(`Create page failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function notionPatchPage(pageId, properties, token) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) throw new Error(`Patch page failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function notionQueryFiltered(dbId, filter, token) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100, ...(filter ? { filter } : {}) };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Query ${dbId} failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}
async function notionGetPage(pageId, token) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!r.ok) throw new Error(`Get page failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const relationIds = (page, name) => (page.properties?.[name]?.relation || []).map(r => r.id);

// Applies ONE new trade's P&L to an account's running stats and writes the delta back
// onto the Prop Firm Accounts row. Deliberately incremental (reads the account's current
// Current Balance / Peak Balance / Trading Days / Consistency / Completed Trades and adds
// to them) rather than rebuilding from the full Prop Trade Log history — a full-history
// rebuild silently discards any balance/peak/day-count that predates what's actually logged
// in the Trade Log, which is how a real account's tracked history got wiped out on 2026-08-03
// (its 51-day/$103,848 state existed only on the Account row, not as Trade Log rows).
//
// `priorTodayTotal` is the sum of this account's OTHER trades already logged for the same
// date (0 if none) — the caller must query this before creating the new Trade Log row, so
// the "is this a new trading day" and "best single day" math stays correct across multiple
// trades logged for the same account on the same day.
async function applyTradeToAccount(accountPageId, accountSize, pnl, priorTodayTotal, isNewDay, token) {
  const page = await notionGetPage(accountPageId, token);
  const prevBalance = getProp(page, 'Current Balance');
  const prevPeak = getProp(page, 'Peak Balance');
  const prevDays = getProp(page, 'Trading Days Completed') || 0;
  const prevConsistency = getProp(page, 'Consistency Rule %');
  const prevCompleted = getProp(page, 'Completed Trades') || 0;

  const baseBalance = prevBalance != null ? prevBalance : accountSize;
  const basePeak = prevPeak != null ? prevPeak : accountSize;

  const balance = baseBalance + pnl;
  const peak = Math.max(basePeak, balance);
  const tradingDays = prevDays + (isNewDay ? 1 : 0);
  const completedTrades = prevCompleted + 1;

  const prevTotalPnl = baseBalance - accountSize;
  const prevBestDay = (prevConsistency != null && prevTotalPnl !== 0) ? prevConsistency * prevTotalPnl : 0;
  const todayTotal = priorTodayTotal + pnl;
  const bestDay = Math.max(prevBestDay, todayTotal);
  const totalPnl = balance - accountSize;
  const consistency = totalPnl !== 0 ? bestDay / totalPnl : null;

  await notionPatchPage(accountPageId, {
    'Current Balance': { number: balance },
    'Peak Balance': { number: peak },
    'Trading Days Completed': { number: tradingDays },
    'Consistency Rule %': consistency === null ? { number: null } : { number: consistency },
    'Completed Trades': { number: completedTrades },
  }, token);

  return { balance, peak, tradingDays, consistency, completedTrades };
}

async function computePropData(token) {
  const [accountPages, tradePages, payoutPages, firmPages, hqPage] = await Promise.all([
    notionQueryFiltered(PROP_ACCOUNTS_DB, null, token),
    notionQueryFiltered(PROP_TRADE_LOG_DB, null, token),
    notionQueryFiltered(PROP_PAYOUT_LOG_DB, null, token),
    notionQueryFiltered(PROP_FIRMS_DB, null, token),
    notionGetPage(PORTFOLIO_HQ_PAGE, token),
  ]);
  const firmName = {};
  for (const f of firmPages) firmName[f.id] = getProp(f, 'Name') || getProp(f, 'Firm') || TITLE_of(f);

  function TITLE_of(page) {
    const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
    return titleProp ? titleProp.title.map(t => t.plain_text).join('') : '';
  }

  const accounts = accountPages.map(pg => {
    const firmIds = relationIds(pg, 'Firm');
    const pendingUntil = getProp(pg, 'Pending Payout Until');
    return {
      id: pg.id,
      name: TITLE_of(pg),
      role: getProp(pg, 'Account Role'),
      size: getProp(pg, 'Account Size'),
      cohort: getProp(pg, 'Cohort'),
      status: getProp(pg, 'Status'),
      firm: firmIds.length ? (firmName[firmIds[0]] || null) : null,
      balance: getProp(pg, 'Current Balance'),
      peak: getProp(pg, 'Peak Balance'),
      tradingDays: getProp(pg, 'Trading Days Completed'),
      consistency: getProp(pg, 'Consistency Rule %'),
      completedTrades: getProp(pg, 'Completed Trades'),
      mdd: getProp(pg, 'MDD $'),
      isLocked: getProp(pg, 'Is Locked'),
      lockedFloor: getProp(pg, 'Locked Floor $'),
      nowTrading: getProp(pg, 'Now Trading'),
      platformId: getProp(pg, 'Platform Account ID'),
      pendingPayoutUntil: pendingUntil,
      onIce: !!(pendingUntil && new Date(pendingUntil).getTime() > Date.now()),
      notes: getProp(pg, 'Notes'),
    };
  });
  const accountName = {};
  for (const a of accounts) accountName[a.id] = a.name;

  const trades = tradePages.map(pg => {
    const accId = relationIds(pg, 'Account')[0] || null;
    return {
      id: pg.id,
      accountId: accId,
      accountName: accId ? accountName[accId] : null,
      date: getProp(pg, 'Date'),
      pnl: getProp(pg, 'P&L $'),
      tradeGroup: getProp(pg, 'Trade Group'),
      notes: getProp(pg, 'Notes'),
    };
  }).filter(t => t.date).sort((a, b) => a.date.localeCompare(b.date));

  const payouts = payoutPages.map(pg => {
    const accId = relationIds(pg, 'Account')[0] || null;
    return {
      id: pg.id,
      accountId: accId,
      accountName: accId ? accountName[accId] : null,
      date: getProp(pg, 'Date'),
      amount: getProp(pg, 'Payout Amount $'),
      maxCap: getProp(pg, 'Max Payout Cap $'),
      payoutType: getProp(pg, 'Payout Type'),
      edgeState: getProp(pg, 'Edge State'),
    };
  }).filter(p => p.date).sort((a, b) => b.date.localeCompare(a.date));

  const hq = {
    moatManual:     getProp(hqPage, 'MOAT Balance $ (manual)'),
    fundedBreaches: getProp(hqPage, 'Funded Breaches (Build Total)'),
    cohortPhase:    getProp(hqPage, 'Current Cohort Phase'),
  };

  return { generatedAt: new Date().toISOString(), accounts, trades, payouts, hq };
}

const FIRM_ICE_HOURS = { Lucid: 48, Apex: 120 };

async function handlePropWrite(body, token) {
  const { action } = body;

  if (action === 'log-trade') {
    // body.tradeGroup, body.date, body.notes, body.entries: [{accountId, pnl}]
    // Look up same-day history PER ACCOUNT before creating any new rows, so "is this a new
    // trading day" and "today's running total" reflect only pre-existing trades.
    const sameDayInfo = {};
    for (const entry of body.entries || []) {
      if (sameDayInfo[entry.accountId]) continue;
      const existing = await notionQueryFiltered(PROP_TRADE_LOG_DB, {
        and: [
          { property: 'Account', relation: { contains: entry.accountId } },
          { property: 'Date', date: { equals: body.date } },
        ],
      }, token);
      sameDayInfo[entry.accountId] = {
        isNewDay: existing.length === 0,
        priorTodayTotal: existing.reduce((s, r) => s + (getProp(r, 'P&L $') || 0), 0),
      };
    }

    for (const entry of body.entries || []) {
      const props = {
        'Trade': { title: [{ text: { content: `${body.tradeGroup || body.date} · ${entry.accountId}` } }] },
        'Account': { relation: [{ id: entry.accountId }] },
        'Date': { date: { start: body.date } },
        'P&L $': { number: entry.pnl },
        'Trade Group': { rich_text: [{ text: { content: body.tradeGroup || '' } }] },
        'Notes': { rich_text: [{ text: { content: body.notes || '' } }] },
      };
      await notionCreatePage(PROP_TRADE_LOG_DB, props, token);
    }
    const results = {};
    for (const entry of body.entries || []) {
      const size = body.accountSizes && body.accountSizes[entry.accountId];
      if (size == null) continue; // client must send each affected account's starting size
      const { isNewDay, priorTodayTotal } = sameDayInfo[entry.accountId];
      results[entry.accountId] = await applyTradeToAccount(entry.accountId, size, entry.pnl, priorTodayTotal, isNewDay, token);
    }
    return { ok: true, updated: results };
  }

  if (action === 'set-rotation') {
    // body.activeAccountIds: string[], body.allAccountIds: string[]
    const active = new Set(body.activeAccountIds || []);
    for (const id of body.allAccountIds || []) {
      await notionPatchPage(id, { 'Now Trading': { checkbox: active.has(id) } }, token);
    }
    return { ok: true };
  }

  if (action === 'set-status') {
    await notionPatchPage(body.accountId, { 'Status': { select: { name: body.status } } }, token);
    return { ok: true };
  }

  if (action === 'thaw') {
    await notionPatchPage(body.accountId, { 'Pending Payout Until': { date: null } }, token);
    return { ok: true };
  }

  if (action === 'log-payout') {
    // body.accountId, accountName, firm, date, amount, maxPayoutCap, payoutType, edgeState, notes
    await notionCreatePage(PROP_PAYOUT_LOG_DB, {
      'Payout': { title: [{ text: { content: `${body.accountName || body.accountId} · ${body.date}` } }] },
      'Account': { relation: [{ id: body.accountId }] },
      'Date': { date: { start: body.date } },
      'Max Payout Cap $': { number: body.maxPayoutCap ?? body.amount ?? 0 },
      'Payout Type': body.payoutType ? { select: { name: body.payoutType } } : undefined,
      'Edge State': body.edgeState ? { select: { name: body.edgeState } } : undefined,
      'Notes': { rich_text: [{ text: { content: body.notes || '' } }] },
    }, token);
    const hrs = FIRM_ICE_HOURS[body.firm] || 48;
    const iceUntil = new Date(Date.now() + hrs * 3600 * 1000).toISOString();
    await notionPatchPage(body.accountId, { 'Pending Payout Until': { date: { start: iceUntil } } }, token);
    return { ok: true, iceUntil };
  }

  throw new Error(`Unknown action: ${action}`);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.NOTION_TOKEN) {
      return new Response(JSON.stringify({ error: 'Missing NOTION_TOKEN secret' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        if (!env.WRITE_TOKEN || body.token !== env.WRITE_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        }
        const result = await handlePropWrite(body, env.NOTION_TOKEN);
        return new Response(JSON.stringify(result), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
    }
    try {
      const url = new URL(request.url);
      const view = url.searchParams.get('view');
      // An unknown view must NOT silently fall through to the futures board —
      // a typo like ?view=v3craig used to serve a different database at 200.
      const VIEWS = {
        calendar:    () => computeCalendarData(env.NOTION_TOKEN),
        v3:          () => computeV3Raw(env.NOTION_TOKEN, V3_DB),
        'v3-crypto': () => computeV3Raw(env.NOTION_TOKEN, V3_CRYPTO_DB),
        'v4-futures': () => computeV4Futures(env.NOTION_TOKEN),
        'v3-craig':  () => computeCraig(env.NOTION_TOKEN),
        'v3-raw':    () => computeV3Raw2(env.NOTION_TOKEN),
        'v3-shots':  () => computeV3Shots(env.NOTION_TOKEN),
        grant:       () => computeGrant(env.NOTION_TOKEN),
        prop:        () => computePropData(env.NOTION_TOKEN),
        scoreboard:  () => computeScoreboard(env.NOTION_TOKEN),
      };
      if (view !== null && !Object.prototype.hasOwnProperty.call(VIEWS, view)) {
        return new Response(JSON.stringify({
          error: `Unknown view "${view}"`, known: Object.keys(VIEWS),
        }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      const data = await (VIEWS[view] || VIEWS.scoreboard)();
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
