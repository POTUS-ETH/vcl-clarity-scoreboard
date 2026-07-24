// refresh-v3.js — pulls VCL Trade Log v3 (Sweep+BoS) from Notion and writes v3-data.json
// Extracts RAW inputs only; the scoreboard (v3.html) recomputes R client-side using the
// corrected full-ladder model. Requires env NOTION_TOKEN. Run by the Actions cron loop.
const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const V3_DB = '1c62f731085940f095b489598b0f55c0';
const OUT = path.join(__dirname, 'v3-data.json');

if (!NOTION_TOKEN) { console.error('refresh-v3: NOTION_TOKEN missing'); process.exit(1); }

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
    // drop TEST scaffolding rows and rows with no Max Run (not yet resolved)
    .filter(r => !(r.Trade || '').toUpperCase().startsWith('TEST'));

    fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), trades: data }, null, 2));
    console.log(`refresh-v3: wrote ${data.length} trades to v3-data.json`);
  } catch (e) {
    console.error('refresh-v3 failed:', e.message);
    process.exit(1);
  }
})();
