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
const V3_CRYPTO_DB = '17736d193e324254b76cbf9054b89184';     // VCL Clarity V3 — CRYPTO (ETH+SOL, Pair-tagged)
const V3_CRAIG_DB  = '72f82a1bf61a4a56ab81e61b6b2aabdf';     // Craig's own crypto log — separate board, own widget

async function computeV3Raw(token, dbId) {
  const trades = await queryAll(dbId, token);
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
      const data = view === 'calendar'
        ? await computeCalendarData(env.NOTION_TOKEN)
        : view === 'v3'
        ? await computeV3Raw(env.NOTION_TOKEN, V3_DB)
        : view === 'v3-crypto'
        ? await computeV3Raw(env.NOTION_TOKEN, V3_CRYPTO_DB)
        : view === 'v3-craig'
        ? await computeV3Raw(env.NOTION_TOKEN, V3_CRAIG_DB)
        : view === 'prop'
        ? await computePropData(env.NOTION_TOKEN)
        : await computeScoreboard(env.NOTION_TOKEN);
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
