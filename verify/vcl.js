// VCL detector, rebuilt around what Craig's markups actually showed.
//
// The previous version went straight to FVG detection and sold into a bull continuation
// because it had no idea which way the market was going. Three stages were missing, and
// they run in this order because each one gates the next:
//
//   1. TREND     1H bias must agree with the trade. NOT the 15m — on 2026-07-20 the 15m
//                reads DOWN at every setting and vetoing on it would kill his long. The
//                15m down-move IS the correction; the 1H is what it corrects against.
//   2. SWEEP     an EXCURSION that takes out a prior swing extreme and closes back inside
//                it. The anchor is the deepest wick of the excursion, not the close-back bar.
//   3. CONFLUENCE the sweep must land in a higher-timeframe FVG. On crypto a bare sweep is
//                too noisy to trade; the gap is what makes it trustworthy. Craig: "it
//                sweeps and confirms the fvg."
//
// Then the BoS/ChoCh level is the LAST SWING HIGH OF THE CORRECTIVE MOVE — the level price
// closes back above to confirm the change of character — not the arbitrary pivot lookback
// the old version used.
//
// VALIDATION CASE. 2026-07-20 03:18 is a known-good trade Craig marked by hand and which
// already reproduces to the cent by construction. `node vcl.js --validate` replays only
// that window. Any change to this file that stops reproducing it is wrong, whatever it
// does to the overall count — a detector tuned to a better hit rate while losing the one
// trade we know is correct has been fitted, not fixed.
const { load } = require('./bars');

const TICK = 0.01;
const typical = b => (b.h + b.l + b.c) / 3;
const ny = ms => new Date(ms - 4 * 3600e3);
const nyHM = ms => ny(ms).toISOString().slice(11, 16);
const nyDate = ms => ny(ms).toISOString().slice(0, 10);

function roll(bars, m) {
  if (m === 1) return bars;
  const out = [], step = m * 60_000; let cur = null;
  for (const b of bars) { const k = Math.floor(b.t / step) * step;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; } }
  return out;
}

/** Confirmed swing pivots: strictly the extreme within +/-k. */
function pivots(bars, k, high) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true;
    for (let x = i - k; x <= i + k && ok; x++) {
      if (x === i) continue;
      if (high ? bars[x].h >= bars[i].h : bars[x].l <= bars[i].l) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * STAGE 1 — market structure at a point in time.
 * Up while the last two confirmed highs AND the last two confirmed lows are both rising;
 * down when both are falling; otherwise no bias, which is a real answer and not a failure.
 * "Structure still intact" is exactly this: the sequence has not broken.
 */
function bias(bars, upto, k = 3) {
  const seg = bars.filter(b => b.t <= upto);
  if (seg.length < 4 * k) return 0;
  const H = pivots(seg, k, true).slice(-2), L = pivots(seg, k, false).slice(-2);
  if (H.length < 2 || L.length < 2) return 0;
  const hUp = seg[H[1]].h > seg[H[0]].h, lUp = seg[L[1]].l > seg[L[0]].l;
  if (hUp && lUp) return 1;
  if (!hUp && !lUp) return -1;
  return 0;
}

/** 3-bar imbalance on `bars`. d=1 bullish. */
function fvgs(bars, d) {
  const out = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1], c = bars[i + 1];
    if (d === 1 ? c.l > a.h : c.h < a.l) {
      const near = d === 1 ? a.h : a.l, far = d === 1 ? c.l : c.h;
      out.push({ lo: Math.min(near, far), hi: Math.max(near, far), validAt: c.t });
    }
  }
  return out;
}

/**
 * STAGE 2 — the sweep. Price takes out the most recent confirmed swing extreme and closes
 * back on the right side of it within a few bars. That close-back is what separates a sweep
 * from a genuine break.
 */
function sweeps(m1, d, k = 3, look = 120, maxSpan = 6) {
  const piv = pivots(m1, k, d !== 1);          // lows for a long, highs for a short
  const out = [];
  for (let i = k + 1; i < m1.length; i++) {
    let last = null;
    for (let q = piv.length - 1; q >= 0; q--) {
      if (piv[q] + k < i && i - piv[q] <= look) { last = piv[q]; break; }
      if (piv[q] + k < i) break;
    }
    if (last == null) continue;
    const lvl = d === 1 ? m1[last].l : m1[last].h;
    if (!(d === 1 ? m1[i].l < lvl : m1[i].h > lvl)) continue;     // this bar takes it out
    if (d === 1 ? m1[i - 1].l < lvl : m1[i - 1].h > lvl) continue; // ...for the first time

    // THE SWEEP IS AN EXCURSION, NOT A BAR. Price may spend several bars beyond the level
    // before rejecting it. The event completes when a bar CLOSES back on the right side,
    // and the ANCHOR is the deepest wick of the whole excursion — the SOP is explicit that
    // the VWAP goes on "the highest/lowest candle wick that swept the prior low/high".
    // 2026-07-20 is exactly this: 03:17 and 03:18 both trade below 75.62, 03:19 closes
    // back above it, and the anchor is 03:18 at 75.49, the deepest of the three.
    let close = -1, deep = i, ext = d === 1 ? m1[i].l : m1[i].h;
    for (let j = i; j < Math.min(m1.length, i + maxSpan); j++) {
      const e = d === 1 ? m1[j].l : m1[j].h;
      if (d * (e - ext) < 0) { ext = e; deep = j; }
      if (d === 1 ? m1[j].c > lvl : m1[j].c < lvl) { close = j; break; }
    }
    if (close < 0) continue;
    out.push({ i: deep, closeIdx: close, lvl, swept: ext, priorIdx: last });
  }
  return out;
}

function detect(m1, htfList, d, opts) {
  const { minRange = 0.25, maxWaitBoS = 120, maxWaitFill = 240, requireFVG = true, macroTf = 60 } = opts;
  const biasBars = roll(m1, macroTf);
  const zoneSets = htfList.map(M => ({ M, z: fvgs(roll(m1, M), d) }));
  const out = [];

  for (const sw of sweeps(m1, d)) {
    const i = sw.i;

    // STAGE 1 — trend, read on the 1H.
    //
    // NOT on the 15m. Craig's 2026-07-20 long has a 15m bias of DOWN at every pivot
    // setting, and demanding the 15m agree would veto the trade — which is incoherent for
    // archetype A, where the ChoCh IS the moment the correction ends. The 15m down-move is
    // the correction; the 1H is the trend it is correcting against, and it reads UP. That
    // matches his own words: daily, then 1 hour, then 15 minute.
    if (bias(biasBars, m1[i].t) !== d) continue;

    // STAGE 3 — the sweep must land in a higher-timeframe gap.
    let fvgTf = null;
    for (const { M, z } of zoneSets) {
      if (z.some(g => g.validAt <= m1[i].t && sw.swept <= g.hi + TICK && m1[i].h >= g.lo - TICK &&
                      (d === 1 ? sw.swept <= g.hi : sw.swept >= g.lo))) { fvgTf = M; break; }
    }
    if (requireFVG && fvgTf == null) continue;

    // BoS/ChoCh — the last swing high of the CORRECTIVE move, closed back through.
    const cp = pivots(m1.slice(0, sw.closeIdx), 2, d === 1).slice(-1)[0];
    if (cp == null) continue;
    const level = d === 1 ? m1[cp].h : m1[cp].l;
    let bos = -1;
    for (let j = sw.closeIdx; j < Math.min(m1.length, i + maxWaitBoS); j++) {
      if (d === 1 ? m1[j].c > level : m1[j].c < level) { bos = j; break; }
      if (d === 1 ? m1[j].l < sw.swept : m1[j].h > sw.swept) break;   // sweep low broken: dead
    }
    if (bos < 0) continue;

    // AVWAP from the sweep candle; fib 1 is the extreme after the BoS; entry a tick beyond.
    let pv = 0, vv = 0, entry = -1, entryPx = null, fib1 = d === 1 ? m1[bos].h : m1[bos].l;
    for (let j = i; j < Math.min(m1.length, bos + maxWaitFill); j++) {
      pv += typical(m1[j]) * m1[j].v; vv += m1[j].v;
      if (j <= bos) continue;
      const ext = d === 1 ? m1[j].h : m1[j].l;
      if (d * (ext - fib1) > 0) fib1 = ext;
      const want = +(pv / vv + d * TICK).toFixed(2);
      if (m1[j].l <= want && want <= m1[j].h) { entry = j; entryPx = want; break; }
      if (d === 1 ? m1[j].l < sw.swept : m1[j].h > sw.swept) break;
    }
    if (entry < 0) continue;

    const zero = (entryPx - 0.382 * fib1) / 0.618;
    const ordered = d === 1 ? (zero < entryPx && entryPx < fib1) : (fib1 < entryPx && entryPx < zero);
    if (!ordered) continue;
    const range = Math.abs(fib1 - zero);
    if (range < minRange) continue;
    const at = f => zero + f * (fib1 - zero);
    out.push({ d, swIdx: i, sweptLevel: +sw.lvl.toFixed(2), sweptTo: +sw.swept.toFixed(2), fvgTf,
      bosIdx: bos, level: +level.toFixed(2), entryIdx: entry, entryPx,
      zero: +zero.toFixed(2), L1: +at(0.17).toFixed(2), fib1: +fib1.toFixed(2),
      t1618: +at(1.618).toFixed(2), t2272: +at(2.272).toFixed(2),
      range: +range.toFixed(3), oneR: +(0.552 * range).toFixed(4),
      tSweep: m1[i].t, tBos: m1[bos].t, tEntry: m1[entry].t });
  }
  return out.sort((a, b) => a.entryIdx - b.entryIdx)
            .filter((s, k2, arr) => k2 === 0 || s.entryIdx > arr[k2 - 1].entryIdx + 5);
}

// weekdays, London (03:00 NY) through the NY close (16:00 NY)
const inSession = ms => { const d = ny(ms).getUTCDay(), h = ny(ms).getUTCHours();
  return d >= 1 && d <= 5 && h >= 3 && h < 16; };

module.exports = { detect, bias, sweeps, fvgs, roll, pivots, inSession, nyHM, nyDate };

if (require.main === module) (async () => {
  const validate = process.argv.includes('--validate');
  const [from, to] = validate ? ['2026-07-19T00:00:00Z', '2026-07-21T00:00:00Z']
                              : ['2026-07-20T00:00:00Z', '2026-08-09T00:00:00Z'];
  const m1 = await load('SOLUSDT', '1', from, to);
  const opts = {};
  const all = [...detect(m1, [5, 15], 1, opts), ...detect(m1, [5, 15], -1, opts)]
              .filter(s => inSession(s.tEntry)).sort((a, b) => a.tEntry - b.tEntry);

  if (validate) {
    console.log('=== VALIDATION — does it still find the 2026-07-20 trade Craig marked? ===\n');
    const hit = all.find(s => nyDate(s.tEntry) === '2026-07-20' && s.d === 1);
    if (!hit) { console.log('  NOT FOUND. The rebuild broke the one trade known to be correct.\n');
      console.log(`  (it found ${all.length} other setups in the window)`); return; }
    const exp = { entryPx: 75.84, zero: 75.72, fib1: 76.04, L1: 75.77, t1618: 76.24, t2272: 76.45 };
    console.log(`  sweep ${nyHM(hit.tSweep)} took ${hit.sweptLevel} down to ${hit.sweptTo}, in a ${hit.fvgTf}m FVG`);
    console.log(`  BoS   ${nyHM(hit.tBos)} closed through ${hit.level}`);
    console.log(`  entry ${nyHM(hit.tEntry)} at ${hit.entryPx}\n`);
    console.log('  level        detector   Craig marked   ');
    for (const [k, v] of Object.entries(exp))
      console.log(`  ${k.padEnd(12)} ${String(hit[k]).padEnd(10)} ${String(v).padEnd(14)} ${Math.abs(hit[k]-v)<=0.011?'MATCH':'MISMATCH'}`);
    return;
  }

  console.log('=== VCL DETECTOR v2 — trend + sweep + FVG confluence ===\n');
  console.log(`  ${nyDate(m1[0].t)} to ${nyDate(m1[m1.length-1].t)}, weekdays, London/NY, fib range >= 0.25\n`);
  console.log(`  setups: ${all.length}   long ${all.filter(s=>s.d===1).length}   short ${all.filter(s=>s.d===-1).length}\n`);
  console.log('   date         dir    sweep   BoS     entry   entry px    0      L1     1     1.618   2.272   range   FVG');
  for (const s of all)
    console.log(`  ${nyDate(s.tEntry)}  ${(s.d===1?'LONG ':'SHORT')}  ${nyHM(s.tSweep)}   ${nyHM(s.tBos)}   ${nyHM(s.tEntry)}   ${String(s.entryPx).padEnd(9)} ${String(s.zero).padEnd(6)} ${String(s.L1).padEnd(6)} ${String(s.fib1).padEnd(6)} ${String(s.t1618).padEnd(7)} ${String(s.t2272).padEnd(7)} ${String(s.range).padEnd(7)} ${s.fvgTf}m`);
})();
