// scoreboard/refresh-v3.js
// Runs in GitHub Actions (add `node refresh-v3.js` to the workflow after refresh.js).
// Fetches raw rows from VCL Trade Log v3 and writes scoreboard/v3-data.json.
// All R math + aggregation happens client-side in v3.html — this script only dumps raw inputs.

const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) { console.error('Missing NOTION_TOKEN env var'); process.exit(1); }

// Public-API database id for VCL Trade Log v3 (the database id from the URL).
// The "VCL Clarity Scoreboard" integration must be shared with this DB (Notion → DB → ⋯ → Connections).
const V3_DB = '1c62f731085940f095b489598b0f55c0';

const NOTION_API = 'https://api.notion.com/v1';
const headers = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

async function queryAll(dbId) {
  const rows = []; let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Query failed for ${dbId}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function val(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':     return p.title.map(t => t.plain_text).join('');
    case 'rich_text': return p.rich_text.map(t => t.plain_text).join('');
    case 'number':    return p.number;
    case 'select':    return p.select?.name || null;
    case 'date':      return p.date?.start || null;
    default:          return null;
  }
}

(async () => {
  console.log('Fetching VCL Trade Log v3...');
  const rows = await queryAll(V3_DB);
  console.log(`Got ${rows.length} rows`);
  const trades = rows
    .map(t => ({
      Trade: val(t, 'Trade'),
      Direction: val(t, 'Direction'),
      Timeframe: val(t, 'Timeframe'),
      Session: val(t, 'Session'),
      Outcome: val(t, 'Outcome'),
      'Entry Price': val(t, 'Entry Price'),
      'L1 Price': val(t, 'L1 Price'),
      'SL Price': val(t, 'SL Price'),
      'Runner Exit': val(t, 'Runner Exit'),
      'Range %': val(t, 'Range %'),
      date: val(t, 'Date'),
    }))
    // drop the TEST scaffolding rows automatically
    .filter(t => !(t.Trade || '').startsWith('TEST'));

  const data = { generatedAt: new Date().toISOString(), tradeCount: trades.length, trades };
  const outPath = path.join(__dirname, 'v3-data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath} with ${trades.length} trades`);
})().catch(err => { console.error(err); process.exit(1); });
