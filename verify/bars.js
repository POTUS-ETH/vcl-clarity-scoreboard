// Fetches SOLUSDT perpetual OHLC straight from Bybit's public v5 market API and
// caches it to disk. This is the SAME venue and instrument Craig's TradingView
// charts are drawn from ("SOLUSDT Perpetual Contract · Bybit"), so it is the
// underlying tape, not a proxy for it.
//
// Why not TradingView: TradingView publishes no data API. Every library that
// claims one is a reverse-engineered websocket that breaks on their releases and
// violates their terms. TradingView is a chart *viewer* — the data it renders here
// is Bybit's, and Bybit gives it away free with no auth. Go to the source.
//
// Bybit caps a response at 1000 bars and returns them NEWEST FIRST.
const fs = require('fs');
const path = require('path');

const API = 'https://api.bybit.com/v5/market/kline';
const CACHE = path.join(__dirname, 'cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// interval: '1' | '3' | '5' | '15' ... (minutes). Bybit has no sub-minute klines —
// see note in verify.js about what that costs us on the 15s rows.
async function fetchRange(symbol, interval, startMs, endMs) {
  const stepMs = Number(interval) * 60_000;
  const out = new Map(); // ts -> bar, dedupes overlapping pages
  // Bybit honours `end` and hands back the 1000 bars ENDING there, newest first.
  // So page BACKWARD: take a page, then move `end` to just before its oldest bar.
  // (Paging forward off `start` silently returns only the newest window — it looks
  // like success and quietly drops everything before it.)
  let cursorEnd = endMs;
  while (cursorEnd > startMs) {
    const url = `${API}?category=linear&symbol=${symbol}&interval=${interval}` +
                `&start=${startMs}&end=${cursorEnd}&limit=1000`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error(`Bybit ${j.retCode}: ${j.retMsg}`);
    const list = j.result.list || [];
    if (!list.length) break;
    for (const b of list) {
      out.set(+b[0], { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] });
    }
    const oldest = Math.min(...list.map(b => +b[0]));
    if (oldest >= cursorEnd) break;      // no backward progress, bail rather than spin
    cursorEnd = oldest - stepMs;
    await sleep(120);                     // be polite to a free public endpoint
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function load(symbol, interval, startISO, endISO) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = `${symbol}_${interval}m_${startISO}_${endISO}.json`.replace(/[:]/g, '');
  const file = path.join(CACHE, key);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const bars = await fetchRange(symbol, interval, Date.parse(startISO), Date.parse(endISO));
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

module.exports = { load, fetchRange };

if (require.main === module) {
  (async () => {
    const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
    console.log(`fetched ${bars.length} 1m bars`);
    console.log(`first ${new Date(bars[0].t).toISOString()}  last ${new Date(bars[bars.length-1].t).toISOString()}`);
    const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
    console.log(`range over the window: ${lo} – ${hi}`);
    // continuity check: a gap means a missing page, which would silently corrupt any
    // max-favorable-excursion computed across it
    let gaps = 0;
    for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i-1].t !== 60_000) gaps++;
    console.log(`bar gaps: ${gaps}`);
  })();
}
