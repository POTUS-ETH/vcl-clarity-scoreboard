// Where does the fib actually get anchored?
//
// Craig: the 1-of-fib goes either at a change of character after a corrective move, or —
// for a trend continuation — at the break-of-structure high. Both of those are STRUCTURAL
// EXTREMES, which makes the claim testable without knowing which archetype a given row
// was: if the anchor is always a swing high (long) or swing low (short), then every logged
// anchor should land exactly on a pivot in the bars BEFORE entry.
//
// It has to be before entry — entry is a retracement from the anchor, so the anchor forms
// first. That ordering is itself a check: an "anchor" found only after the entry bar would
// mean the level was not available to draw at the time, and the setup could not have been
// taken as described.
//
// This sweeps the pivot strength k and the timeframe the fib might be drawn on, and just
// reports the match rate. It does NOT pick a winner — a k that fits 32 points is a k
// fitted to 32 points. The purpose is to find out whether the structural claim holds at
// all, and roughly what scale Craig is reading.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503'};

const dirOf = t => t.Direction === 'Long' ? 1 : -1;
const TICK = 0.01;

/** Aggregate 1m bars into `m`-minute bars aligned to the epoch. */
function roll(bars, m) {
  if (m === 1) return bars;
  const out = [], step = m * 60_000;
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / step) * step;
    if (!cur || cur.t !== bucket) { cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return out;
}

/** Indices of confirmed pivots: strictly the extreme within +/- k bars. */
function pivots(bars, k, high) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++) {
      if (j === i) continue;
      if (high ? bars[j].h >= bars[i].h : bars[j].l <= bars[i].l) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

(async () => {
  const m1 = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && r.t.entryTime && r.t.anchor != null).sort((a, b) => a.n - b.n);

  console.log('=== IS THE 1-OF-FIB A STRUCTURAL EXTREME? ===\n');
  console.log('For each row: does the logged anchor price sit exactly on a swing high (long)');
  console.log('or swing low (short) formed BEFORE the entry bar?\n');
  console.log('  tf    k    anchor on a pivot   fib-0 on a pivot');

  const best = {};
  for (const tf of [1, 5, 15]) {
    const bars = roll(m1, tf);
    for (const k of [2, 3, 5, 8, 12]) {
      let aHit = 0, zHit = 0, n = 0;
      for (const { t } of rows) {
        const { i } = barIndexForEntryTime(t.entryTime, t.date, m1);
        if (i < 0) continue;
        const entryMs = m1[i].t;
        const ei = bars.findIndex(b => b.t > entryMs);       // first bar after entry
        const upto = ei < 0 ? bars.length : ei;
        if (upto < 2 * k + 2) continue;
        n++;
        const d = dirOf(t);
        // anchor is a HIGH for a long, a LOW for a short; fib-0 the opposite
        const aPiv = pivots(bars.slice(0, upto), k, d === 1);
        const zPiv = pivots(bars.slice(0, upto), k, d !== 1);
        const aPx = aPiv.map(x => d === 1 ? bars[x].h : bars[x].l);
        const zPx = zPiv.map(x => d === 1 ? bars[x].l : bars[x].h);
        if (aPx.some(p => Math.abs(p - t.anchor) < TICK / 2)) aHit++;
        if (t.sl != null && zPx.some(p => Math.abs(p - t.sl) < TICK / 2)) zHit++;
      }
      const key = `${tf}m/k${k}`;
      best[key] = aHit;
      console.log(`  ${String(tf + 'm').padEnd(5)} ${String(k).padEnd(4)} ${String(aHit + '/' + n).padStart(10)}         ${String(zHit + '/' + n).padStart(8)}`);
    }
  }

  // How far back does the anchor sit, and is it the highest point of its leg?
  console.log('\n=== how far before entry does the anchor sit, and is it the leg extreme? ===\n');
  let atExtreme = 0, tot = 0; const dists = [];
  for (const { n, t } of rows) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, m1);
    if (i < 0) continue;
    const d = dirOf(t);
    // walk back for the most recent bar whose extreme equals the anchor
    let hit = null;
    for (let k2 = i; k2 >= Math.max(0, i - 480); k2--) {
      const px = d === 1 ? m1[k2].h : m1[k2].l;
      if (Math.abs(px - t.anchor) < TICK / 2) { hit = k2; break; }
    }
    tot++;
    if (hit != null) {
      dists.push(i - hit);
      // was it the extreme of everything between it and entry?
      let ext = true;
      for (let k2 = hit; k2 <= i; k2++) {
        const px = d === 1 ? m1[k2].h : m1[k2].l;
        if (d * (px - t.anchor) > 1e-9) { ext = false; break; }
      }
      if (ext) atExtreme++;
    } else {
      console.log(`  #${n}  anchor ${t.anchor} never printed in the 8h before entry — drawn on a higher timeframe, or a level not a wick`);
    }
  }
  dists.sort((a, b) => a - b);
  console.log(`\n  anchor price actually printed before entry : ${dists.length}/${tot}`);
  if (dists.length) {
    console.log(`  and was the running extreme up to entry   : ${atExtreme}/${tot}`);
    console.log(`  minutes back from entry — min ${dists[0]}, median ${dists[Math.floor(dists.length/2)]}, max ${dists[dists.length-1]}`);
  }
})();
