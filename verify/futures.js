// 1-minute CME futures OHLC (MNQ/MES/MGC), cached to disk.
//
// bars.js covers crypto off Bybit; that venue has no futures and no sub-minute klines.
// This is the futures equivalent, and the two are deliberately separate modules rather
// than one with a venue switch — they have different auth, different limits, different
// failure modes, and conflating them is how a silent wrong-instrument fetch happens.
//
// WHY 1m IS ENOUGH TO ADJUDICATE A 15s CHART. The question a backtest actually asks is
// "did price trade at level X before it traded at level Y". A 1m bar's high/low is the
// EXACT envelope of the four 15s bars inside it, so:
//     1m high >= X  =>  some 15s bar inside that minute touched X   (definitive)
//     1m high <  X  =>  no 15s bar inside it did                     (definitive)
// Touch questions are answered exactly. The ONLY thing 1m cannot do is ORDER two events
// that fall inside the same minute. checkStopTouched() below reports that case as
// 'ambiguous' instead of guessing, because guessing is what produces a backtest that
// looks rigorous and is quietly wrong.
//
// HISTORY LIMIT: this source serves 1m for roughly the last 30 days only. It is therefore
// a FORWARD verification tool — run it while trades are fresh. It cannot retroactively
// audit a log older than that, which is why entry timestamps have to be captured at
// logging time rather than reconstructed later.
const fs = require('fs');
const path = require('path');

const API = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CACHE = path.join(__dirname, 'cache');
const UA = 'Mozilla/5.0';

// Yahoo's continuous-front-month symbols. MNQ=F is the micro; NQ=F is the full-size
// contract and prints the same path at a different tick, so it is a usable fallback for
// level-touch questions but NOT for anything denominated in ticks or dollars.
const SYMBOLS = { MNQ: 'MNQ=F', MES: 'MES=F', MGC: 'MGC=F', NQ: 'NQ=F', ES: 'ES=F' };

async function fetchRange(pair, startMs, endMs) {
  const sym = SYMBOLS[pair];
  if (!sym) throw new Error(`No futures symbol mapped for "${pair}"`);
  const p1 = Math.floor(startMs / 1000), p2 = Math.ceil(endMs / 1000);
  const url = `${API}/${sym}?interval=1m&period1=${p1}&period2=${p2}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await res.json();
  const err = j?.chart?.error;
  if (err) {
    // The 30-day wall arrives as a normal 200 with an error object, not an HTTP failure.
    // Surfacing it verbatim matters: "0 bars" and "too old" are different problems and
    // must not be allowed to look alike.
    throw new Error(`${sym}: ${err.code} — ${err.description || ''}`);
  }
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    // Yahoo pads gaps with nulls; a null OHLC is a hole, not a bar, and must be dropped
    // rather than coerced to 0 — a zero low would make every stop look touched.
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    out.push({ t: r.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function load(pair, startISO, endISO) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = `fut_${pair}_1m_${startISO}_${endISO}.json`.replace(/[:]/g, '');
  const file = path.join(CACHE, key);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const bars = await fetchRange(pair, Date.parse(startISO), Date.parse(endISO));
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

/**
 * Did the trade touch `stop` before it reached `maxRunPx`, given 1m bars?
 * `dir` is +1 long / -1 short. `fromMs` is the entry timestamp.
 *
 * Returns { verdict, stopBar, runBar } where verdict is one of:
 *   'stopped'    — a minute touched the stop strictly before any minute reached max run
 *   'survived'   — max run was reached first, or the stop was never touched at all
 *   'ambiguous'  — both happened inside the SAME minute; 1m cannot order them and this
 *                  is reported rather than resolved
 *   'no-data'    — no bars covered the window
 */
function checkStopTouched(bars, fromMs, dir, stop, maxRunPx) {
  const win = bars.filter(b => b.t >= fromMs);
  if (!win.length) return { verdict: 'no-data' };
  const touches = b => dir === 1 ? b.l <= stop : b.h >= stop;
  const reaches = b => dir === 1 ? b.h >= maxRunPx : b.l <= maxRunPx;
  const si = win.findIndex(touches);
  const ri = win.findIndex(reaches);
  if (si === -1) return { verdict: 'survived', stopBar: null, runBar: ri === -1 ? null : win[ri].t };
  if (ri === -1) return { verdict: 'stopped', stopBar: win[si].t, runBar: null };
  if (si < ri) return { verdict: 'stopped', stopBar: win[si].t, runBar: win[ri].t };
  if (ri < si) return { verdict: 'survived', stopBar: win[si].t, runBar: win[ri].t };
  return { verdict: 'ambiguous', stopBar: win[si].t, runBar: win[ri].t };
}

/** VCL V5 levels solved from the two prices a trade actually records. */
function v5Levels(entry, fib0) {
  const range = (entry - fib0) / 0.382;         // signed: fib0 -> anchor
  const at = f => fib0 + f * range;
  return { fib0, anchor: at(1), stop: at(0.085), tp: at(0.68),
           oneR: Math.abs(entry - at(0.085)), at };
}

module.exports = { load, fetchRange, checkStopTouched, v5Levels, SYMBOLS };

if (require.main === module) {
  (async () => {
    const end = new Date(), start = new Date(end - 3 * 864e5);
    const bars = await load('MNQ', start.toISOString(), end.toISOString());
    console.log(`MNQ 1m bars over the last 3 days: ${bars.length}`);
    if (!bars.length) return;
    console.log(`  ${new Date(bars[0].t).toISOString()} -> ${new Date(bars.at(-1).t).toISOString()}`);
    const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
    console.log(`  range ${lo} - ${hi}`);

    // Worked demonstration of the envelope argument on a real bar.
    const b = bars[Math.floor(bars.length / 2)];
    const lv = v5Levels(b.c, b.c - 40);
    console.log(`\n  sample: entry ${b.c}, fib0 ${(b.c - 40).toFixed(2)}`);
    console.log(`    V5 stop (fib 0.085) ${lv.stop.toFixed(2)} · TP (0.68) ${lv.tp.toFixed(2)} · 1R ${lv.oneR.toFixed(2)}`);
    console.log(`    the 0.085 stop sits ${((0.382 - 0.085) / 0.382 * 100).toFixed(1)}% of the way from entry back to fib 0`);
  })();
}
