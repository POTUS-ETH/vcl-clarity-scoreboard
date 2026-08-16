// The VCL crypto setup detector — Craig's FVG variant, mechanised.
//
// Sequence (long; mirrored for shorts), straight from STRATEGY.md §3a:
//   1. price reacts to a 5m or 15m FVG
//   2. no 1m CLOSE beyond the gap's midpoint (a wick through is fine)
//   3. a BoS/ChoCh confirmed by a full 1m candle CLOSE above the level
//   4. anchor the AVWAP at that reaction low
//   5. fib 1 at the high of the BoS/ChoCh
//   6. entry at the AVWAP on the retrace; the 0 is then solved
//
// Volume is RECORDED, NEVER GATED. Craig's instruction is to observe it and find out
// whether it matters before deciding how to measure it. A threshold invented here would
// then be "discovered" to be important, which is circular.
//
// What this is for is not "does it find Craig's trades" alone. Recall is the easy half.
// The half that decides whether the strategy can be backtested at all is how many setups
// it fires on that he did NOT take — because there are zero rejected setups in the log,
// that number is the size of the gap between this detector and his judgement.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');

const TICK = 0.01, GAP = TICK;             // entry sits one tick beyond the AVWAP
const typical = b => (b.h + b.l + b.c) / 3;
const hhmmNY = ms => new Date(ms - 4 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');

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

/** 3-bar imbalance. `d`=1 bullish (low[i+1] > high[i-1]), d=-1 bearish. */
function fvgs(bars, d) {
  const out = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1], c = bars[i + 1];
    const ok = d === 1 ? c.l > a.h : c.h < a.l;
    if (!ok) continue;
    const near = d === 1 ? a.h : a.l, far = d === 1 ? c.l : c.h;
    out.push({ near, far, mid: (near + far) / 2, validAt: c.t, size: Math.abs(far - near) });
  }
  return out;
}

/** Most recent confirmed pivot before index i, in the direction the BoS must break. */
function priorPivot(bars, i, d, k = 2, look = 90) {
  for (let c = i - k - 1; c >= Math.max(k, i - look); c--) {
    let ok = true;
    for (let x = c - k; x <= c + k && ok; x++) {
      if (x === c) continue;
      if (d === 1 ? bars[x].h >= bars[c].h : bars[x].l <= bars[c].l) ok = false;
    }
    if (ok) return d === 1 ? bars[c].h : bars[c].l;
  }
  return null;
}

/** Detect every setup for one direction and one FVG timeframe. */
// `minGap` and `reactWin` are PARAMETERS I DO NOT GET TO CHOOSE. They are surfaced as
// arguments and swept, never hardcoded to whatever fits, because a minimum FVG size in
// particular is a real strategy decision — the median 5m gap here is four ticks, which is
// microstructure noise rather than the imbalance the model is about.
function detect(m1, htf, d, minGap = 0, reactWin = 30, minRangePct = 0.25, maxWaitBoS = 120, maxWaitFill = 240) {
  const zones = fvgs(htf, d);
  const out = [];
  for (const z of zones) {
    if (z.size < minGap) continue;            // see note on gap size below
    let i0 = m1.findIndex(b => b.t >= z.validAt);
    if (i0 < 0) continue;
    // 2. THE REACTION IS AN EVENT, NOT A WINDOW. The midpoint rule invalidates the
    // reaction Craig is trading, so it can only apply while that reaction is unfolding.
    // Policing it across hours of subsequent tape means any gap is eventually violated —
    // that read took 203 candidates to 2 and matched none of his trades.
    let first = -1;
    for (let i = i0; i < Math.min(m1.length, i0 + 240); i++) {
      const b = m1[i];
      if (d === 1 ? b.l <= z.near : b.h >= z.near) { first = i; break; }
    }
    if (first < 0) continue;
    let react = -1, lo = null;
    for (let i = first; i < Math.min(m1.length, first + reactWin); i++) {
      const b = m1[i];
      if (d === 1 ? b.c < z.mid : b.c > z.mid) { react = -2; break; }   // closed beyond mid
      const px = d === 1 ? b.l : b.h;
      if (lo == null || d * (px - lo) < 0) { lo = px; react = i; }
    }
    if (react < 0) continue;

    // 3. BoS/ChoCh — a FULL 1m CLOSE beyond the prior structural pivot
    const level = priorPivot(m1, react, d);
    if (level == null) continue;
    let bos = -1;
    for (let i = react + 1; i < Math.min(m1.length, react + maxWaitBoS); i++) {
      if (d === 1 ? m1[i].c > level : m1[i].c < level) { bos = i; break; }
      // the reaction low is invalidated if price closes beyond the midpoint before the BoS
      if (d === 1 ? m1[i].c < z.mid : m1[i].c > z.mid) break;
    }
    if (bos < 0) continue;

    // 5. fib 1 — Craig: the BoS candle's own extreme. SOP: the extreme AFTER the BoS.
    const anchorCraig = d === 1 ? m1[bos].h : m1[bos].l;

    // 4 + 6. AVWAP from the reaction low; entry when price retraces one tick beyond it
    let pv = 0, vv = 0, entry = -1, entryPx = null, anchorSOP = anchorCraig;
    for (let i = react; i < Math.min(m1.length, bos + maxWaitFill); i++) {
      pv += typical(m1[i]) * m1[i].v; vv += m1[i].v;
      if (i <= bos) continue;
      const ext = d === 1 ? m1[i].h : m1[i].l;
      if (d * (ext - anchorSOP) > 0) anchorSOP = ext;
      const v = pv / vv, want = v + d * GAP;
      if (m1[i].l <= want && want <= m1[i].h) { entry = i; entryPx = +want.toFixed(2); break; }
    }
    if (entry < 0) continue;

    // THE FULL LADDER. Everything is forced once 0 and 1 are pinned, and a detector that
    // stops at "entry and stop" is testing a third of the strategy. L1 at 0.17 is not
    // optional garnish — it is the second resting order that decides which outcome column
    // the trade lands in and halves the effective basis when it fills.
    const zero = (entryPx - 0.382 * anchorCraig) / 0.618;
    const at = f => zero + f * (anchorCraig - zero);
    const L1 = at(0.17), t1618 = at(1.618), t2272 = at(2.272);

    // A ladder must be ordered. On a long: 0 < entry < 1. Anything else is not a trade,
    // it is arithmetic that happened to produce numbers — a stop on the wrong side of the
    // entry cannot be filled in the order the strategy requires.
    const ordered = d === 1 ? (zero < entryPx && entryPx < anchorCraig)
                            : (anchorCraig < entryPx && entryPx < zero);
    if (!ordered) continue;

    // Craig: do not take a setup whose range is under 0.25%. His own logged minimum is
    // 0.174%, so this is a rule he is imposing, not a threshold fitted to his sample.
    const rangePct = Math.abs(anchorCraig - zero) / zero * 100;
    if (rangePct < minRangePct) continue;

    const volWin = m1.slice(Math.max(0, react - 30), react + 1).map(b => b.v);
    const med = volWin.slice().sort((a, b) => a - b)[Math.floor(volWin.length / 2)];
    out.push({ d, reactIdx: react, bosIdx: bos, entryIdx: entry, entryPx,
               anchorCraig: +anchorCraig.toFixed(2), anchorSOP: +anchorSOP.toFixed(2),
               volRatio: +(m1[react].v / (med || 1)).toFixed(2),
               t: m1[entry].t });
  }
  // one trade at a time: drop any setup whose entry precedes the previous one's entry+1
  return out.sort((a, b) => a.entryIdx - b.entryIdx)
            .filter((s, i, arr) => i === 0 || s.entryIdx > arr[i - 1].entryIdx);
}


module.exports = { roll, fvgs, priorPivot, detect };
