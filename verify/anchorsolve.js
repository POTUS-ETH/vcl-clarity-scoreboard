// Solve for the AVWAP anchor bar, then ask what kind of bar it is.
//
// Guessing an FVG definition and hoping it reproduces the entries is backwards — there are
// too many free parameters (timeframe, gap size, what counts as a reaction, how much volume)
// and 32 points will happily fit several of them. Invert it instead.
//
// Craig places the entry a slight gap beyond the AVWAP. So for every trade the AVWAP's
// value at fill is KNOWN to within a few ticks, and an anchored VWAP is fully determined by
// its anchor bar. Scanning candidate anchors backwards from entry and keeping the ones whose
// AVWAP lands the right distance beyond the entry therefore RECOVERS the anchor from the
// data — no FVG definition required. Only then does this ask what those bars have in
// common: are they swing extremes, do they carry unusual volume, do they sit in a 5m or a
// 15m fair value gap.
//
// That ordering matters. The FVG rule then gets CHECKED against recovered anchors rather
// than fitted to entries, and the 5m-vs-15m question gets answered by which one contains
// more of them — which is evidence, not a preference.
//
// Caveat stated up front: the AVWAP is evaluated at the entry bar. The limit is really
// placed when the fib is drawn and the line drifts afterwards, so a systematic one-sided
// miss here is the first thing to revisit.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503'};

const TICK = 0.01;
const MAX_GAP = 5 * TICK;      // "a slight gap" — generous, and reported so it can be judged
const LOOKBACK = 600;          // 10h of 1m bars
const dirOf = t => t.Direction === 'Long' ? 1 : -1;
const typical = b => (b.h + b.l + b.c) / 3;

function roll(bars, m) {
  if (m === 1) return bars;
  const out = [], step = m * 60_000; let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / step) * step;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return out;
}

/**
 * Fair value gaps: a three-bar imbalance where the outer two do not overlap.
 * Bullish -> low[i+1] > high[i-1], leaving an unfilled window price tends to revisit.
 * Returned as zones with the timestamp they became valid, so a zone is never used before
 * it existed.
 */
function fvgs(bars, bullish) {
  const out = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1], c = bars[i + 1];
    if (bullish ? c.l > a.h : c.h < a.l)
      out.push({ from: bullish ? a.h : c.h, to: bullish ? c.l : a.l, t: c.t, vol: bars[i].v });
  }
  return out;
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-01T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && r.t.entryTime && r.t.entry != null).sort((a, b) => a.n - b.n);

  const tf = { 5: roll(bars, 5), 15: roll(bars, 15) };
  const zones = { 5: { true: fvgs(tf[5], true), false: fvgs(tf[5], false) },
                  15: { true: fvgs(tf[15], true), false: fvgs(tf[15], false) } };

  let solved = 0, inFVG = { 5: 0, 15: 0 }, isExtreme = 0, volHot = 0;
  const dists = [], gaps = [], nsol = [];
  const detail = [];

  for (const { n, t } of rows) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    const d = dirOf(t);

    // walk the anchor backwards, keeping a running VWAP sum for O(n)
    const hits = [];
    let pv = 0, vv = 0;
    for (let a = i; a >= Math.max(1, i - LOOKBACK); a--) {
      pv += typical(bars[a]) * bars[a].v; vv += bars[a].v;
      if (vv <= 0) continue;
      const gap = d * (t.entry - pv / vv);          // entry beyond the AVWAP, in the trade's favour
      if (gap > 0 && gap <= MAX_GAP) hits.push({ a, gap });
    }
    if (!hits.length) { detail.push(`  #${String(n).padEnd(3)} no anchor in ${LOOKBACK} bars puts the entry within ${(MAX_GAP*100).toFixed(0)}c beyond the AVWAP`); continue; }

    solved++; nsol.push(hits.length);
    // the earliest anchor that works — an AVWAP anchored further back is the more
    // meaningful structure, and later ones are usually a trailing tail of near-misses
    const best = hits[hits.length - 1];
    const back = i - best.a;
    dists.push(back); gaps.push(best.gap);

    // what kind of bar is it?
    const w = 10;
    let ext = true;
    for (let k = Math.max(0, best.a - w); k <= Math.min(bars.length - 1, best.a + w); k++) {
      const v = d === 1 ? bars[k].l : bars[k].h;
      if (d === 1 ? v < bars[best.a].l : v > bars[best.a].h) { ext = false; break; }
    }
    if (ext) isExtreme++;

    const around = bars.slice(Math.max(0, best.a - 30), best.a + 1).map(b => b.v);
    const med = around.slice().sort((p, q) => p - q)[Math.floor(around.length / 2)];
    const hot = bars[best.a].v > med * 1.5;
    if (hot) volHot++;

    const px = d === 1 ? bars[best.a].l : bars[best.a].h;
    const inZone = m => zones[m][String(d === 1)].some(z =>
      z.t <= bars[best.a].t && Math.min(z.from, z.to) - TICK <= px && px <= Math.max(z.from, z.to) + TICK);
    const f5 = inZone(5), f15 = inZone(15);
    if (f5) inFVG[5]++; if (f15) inFVG[15]++;

    detail.push(`  #${String(n).padEnd(3)} ${t.Direction.padEnd(5)} anchor ${back} min before entry` +
      `  gap ${(best.gap * 100).toFixed(1)}c  ${hits.length} candidate${hits.length > 1 ? 's' : ''}` +
      `  ${ext ? 'swing-extreme' : '            '}  ${hot ? 'vol>1.5x' : '        '}` +
      `  ${f5 ? '5m-FVG ' : '       '}${f15 ? '15m-FVG' : ''}`);
  }

  console.log('=== SOLVING FOR THE AVWAP ANCHOR ===\n');
  console.log(`  entry must sit 0-${(MAX_GAP*100).toFixed(0)}c beyond the AVWAP; anchor searched back ${LOOKBACK} bars\n`);
  detail.forEach(d => console.log(d));

  const med = a => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
  console.log(`\n  rows with a workable anchor      : ${solved}/${rows.length}`);
  if (solved) {
    console.log(`  candidate anchors per row        : median ${med(nsol)}  (1 would mean uniquely determined)`);
    console.log(`  minutes back — min ${Math.min(...dists)}, median ${med(dists)}, max ${Math.max(...dists)}`);
    console.log(`  gap beyond AVWAP                 : median ${(med(gaps)*100).toFixed(1)}c`);
    console.log('\n  what those anchor bars look like:');
    console.log(`    a swing extreme (+/-10 bars)   : ${isExtreme}/${solved}`);
    console.log(`    volume > 1.5x local median     : ${volHot}/${solved}`);
    console.log(`    sits in a 5m FVG               : ${inFVG[5]}/${solved}`);
    console.log(`    sits in a 15m FVG              : ${inFVG[15]}/${solved}`);
    console.log(`\n  5m vs 15m: ${inFVG[15] > inFVG[5] ? '15m contains more recovered anchors' : inFVG[5] > inFVG[15] ? '5m contains more recovered anchors' : 'tied'}` +
                ` — but this is 32 rows and the anchor is not uniquely determined, so read it as a lead, not an answer.`);
  }
})();
