// refresh-prop.js — redundant snapshot of the Prop Firm Rotation Tracker in case the
// Worker (prop-tracker.html's primary data source) has an outage. Requires env NOTION_TOKEN.
// Mirrors refresh-v3.js's shape/pattern. Run by the Actions cron loop.
const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROP_ACCOUNTS_DB   = '62194cc58c014cbfbde3a0e5defd85d2';
const PROP_TRADE_LOG_DB  = '1f754291902c4d3bb671b7d7e83e22d2';
const PROP_PAYOUT_LOG_DB = 'ef64fac8910a4d4988970b7f5c28e1d5';
const PROP_FIRMS_DB      = 'b0efbedeffb84410ad9c3a55e80a9ed7';
const NOTION_VERSION = '2022-06-28';
const OUT = path.join(__dirname, 'prop-data.json');

if (!NOTION_TOKEN) { console.error('refresh-prop: NOTION_TOKEN missing'); process.exit(1); }

function getProp(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title.map(t => t.plain_text).join('');
    case 'rich_text':    return p.rich_text.map(t => t.plain_text).join('');
    case 'number':       return p.number;
    case 'select':       return p.select?.name || null;
    case 'checkbox':     return p.checkbox;
    case 'date':         return p.date?.start || null;
    case 'relation':     return p.relation.map(r => r.id);
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

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) throw new Error(`Notion query ${dbId} ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

(async () => {
  try {
    const [accountPages, tradePages, payoutPages, firmPages] = await Promise.all([
      queryAll(PROP_ACCOUNTS_DB), queryAll(PROP_TRADE_LOG_DB), queryAll(PROP_PAYOUT_LOG_DB), queryAll(PROP_FIRMS_DB),
    ]);

    const firmName = {};
    for (const f of firmPages) firmName[f.id] = getProp(f, 'Firm');

    const accounts = accountPages.map(pg => {
      const firmIds = getProp(pg, 'Firm') || [];
      const pendingUntil = getProp(pg, 'Pending Payout Until');
      return {
        id: pg.id,
        name: getProp(pg, 'Account'),
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
      const accId = (getProp(pg, 'Account') || [])[0] || null;
      return {
        id: pg.id, accountId: accId, accountName: accId ? accountName[accId] : null,
        date: getProp(pg, 'Date'), pnl: getProp(pg, 'P&L $'),
        tradeGroup: getProp(pg, 'Trade Group'), notes: getProp(pg, 'Notes'),
      };
    }).filter(t => t.date);

    const payouts = payoutPages.map(pg => {
      const accId = (getProp(pg, 'Account') || [])[0] || null;
      return {
        id: pg.id, accountId: accId, accountName: accId ? accountName[accId] : null,
        date: getProp(pg, 'Date'), amount: getProp(pg, 'Payout Amount $'),
        maxCap: getProp(pg, 'Max Payout Cap $'), payoutType: getProp(pg, 'Payout Type'),
        edgeState: getProp(pg, 'Edge State'),
      };
    }).filter(p => p.date);

    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), accounts, trades, payouts }, null, 2));
    console.log(`refresh-prop: wrote ${accounts.length} accounts, ${trades.length} trades, ${payouts.length} payouts to prop-data.json`);
  } catch (e) {
    console.error('refresh-prop failed:', e.message);
    process.exit(1);
  }
})();
