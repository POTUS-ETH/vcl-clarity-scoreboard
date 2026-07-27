// refresh-v3-crypto.js — pulls VCL Clarity V3 — CRYPTO (Sweep+BoS, ETH+SOL) from Notion
// and writes v3-crypto-data.json. Extracts RAW inputs only; the scoreboard (v3-crypto.html)
// recomputes R client-side using the corrected full-ladder model, then filters by Pair
// for the ETH/SOL toggle — one fetch, no cross-pair mixing. Requires env NOTION_TOKEN.
// Run by the Actions cron loop.
const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const V3_DB = '17736d193e324254b76cbf9054b89184'; // VCL Clarity V3 — CRYPTO Trade Log
const OUT = path.join(__dirname, 'v3-crypto-data.json');

if (!NOTION_TOKEN) { console.error('refresh-v3-crypto: NOTION_TOKEN missing'); process.exit(1); }

const NUM  = p => (p && p.type === 'number') ? p.number : null;
const SEL  = p => (p && p.type === 'select' && p.select) ? p.select.name : null;
const CHK  = p => (p && p.type === 'checkbox') ? !!p.checkbox : false;
const DATE = p => (p && p.type === 'date' && p.date) ? p.date.start : null;
const TITLE = p => (p && p.type === 'title') ? (p.title.map(t => t.plain_text).join('') || '') : '';

async function queryAll() {
  const rows = [];
  let cursor = undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${V3_DB}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) throw new Error(`Notion query ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

(async () => {
  try {
    const pages = await queryAll();
    const data = pages.map(pg => {
      const p = pg.properties || {};
      return {
        Trade:      TITLE(p['Trade']),
        Direction:  SEL(p['Direction']),
        Timeframe:  SEL(p['Timeframe']),
        Session:    SEL(p['Session']),
        Pair:       SEL(p['Pair']),
        EntryPrice: NUM(p['Entry Price']),
        L1Price:    NUM(p['L1 Price']),
        SLPrice:    NUM(p['SL Price']),
        MaxRun:     NUM(p['Max Run']),
        BoSExit:    NUM(p['BoS Exit']),
        L1before:   CHK(p['L1 before Max Run']),
        L1after:    CHK(p['L1 after Max Run']),
        RangePct:   NUM(p['Range %']),
        date:       DATE(p['Date']),
      };
    })
    // drop TEST scaffolding rows
    .filter(r => !(r.Trade || '').toUpperCase().startsWith('TEST'));

    fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), trades: data }, null, 2));
    console.log(`refresh-v3-crypto: wrote ${data.length} trades to v3-crypto-data.json`);
  } catch (e) {
    console.error('refresh-v3-crypto failed:', e.message);
    process.exit(1);
  }
})();
