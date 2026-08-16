// Trend context, built the way Vorwald reads it rather than as a binary flag.
//
// My bias() asked "is this market up or down" and answered "neither" on roughly eighteen
// of Craig's thirty-two trades, because the market is usually inside a range and the
// question has no answer there. Vorwald never asks it. He locates the enclosing range,
// notes where price sits inside it, and — the part that actually carries information —
// checks whether a breakout at either edge was REJECTED. A rejected push above the top of
// a range is what tells him to expect a move to the downside.
//
// So this returns a description, not a verdict: the range, the position inside it, and any
// recent rejection. Callers decide what to do with it. Keeping the read separate from the
// decision is what lets the same context be measured against Craig's trades without
// baking in a rule I have not earned yet.
const pivots = (bars, k, high) => {
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
};

/**
 * The enclosing range and what has happened at its edges.
 *
 * `rejected` is the load-bearing field. A breakout that closes back inside the range is
 * failure at that edge, and failure at one edge points at the other — which is exactly
 * the inference Vorwald draws on the daily before ever looking at an entry.
 */
function context(bars, upto, { k = 3, rejectLook = 40 } = {}) {
  const seg = bars.filter(b => b.t <= upto);
  if (seg.length < 4 * k) return null;
  const H = pivots(seg, k, true), L = pivots(seg, k, false);
  if (!H.length || !L.length) return null;

  // the range is the most recent significant swing high and low that enclose price
  const hi = seg[H[H.length - 1]].h, lo = seg[L[L.length - 1]].l;
  const top = Math.max(hi, lo), bot = Math.min(hi, lo);
  if (!(top > bot)) return null;
  const px = seg[seg.length - 1].c;
  const pos = (px - bot) / (top - bot);          // <0 or >1 means price is outside

  // structural read — Craig: higher highs AND higher lows, mirrored for down
  let structure = 0;
  if (H.length >= 2 && L.length >= 2) {
    const hUp = seg[H[H.length-1]].h > seg[H[H.length-2]].h;
    const lUp = seg[L[L.length-1]].l > seg[L[L.length-2]].l;
    structure = (hUp && lUp) ? 1 : (!hUp && !lUp) ? -1 : 0;
  }

  // rejection: price exceeded an edge and closed back inside, within rejectLook bars
  const tail = seg.slice(-rejectLook);
  let rejectedTop = false, rejectedBottom = false;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].h > top && tail.slice(i).some(b => b.c < top)) rejectedTop = true;
    if (tail[i].l < bot && tail.slice(i).some(b => b.c > bot)) rejectedBottom = true;
  }
  return { top: +top.toFixed(2), bot: +bot.toFixed(2), pos: +pos.toFixed(3),
           structure, rejectedTop, rejectedBottom };
}

/**
 * Vorwald's volume-exhaustion read, made testable.
 *
 * "When a reversal occurs the volume also increases... and when it then trades back down
 * from that increased volume, I've had exhaustion. But if it doesn't trade below this
 * volume, I have to wait."
 *
 * For a long that means: the sweep bar carries unusual volume, and price then closes back
 * THROUGH that bar's range in the trade's direction. The second half is the part traders
 * skip — a volume spike with no follow-through is a reason to wait, not to enter.
 */
function exhaustion(m1, swIdx, d, { lookback = 30, mult = 1.5, within = 20 } = {}) {
  const w = m1.slice(Math.max(0, swIdx - lookback), swIdx + 1).map(b => b.v);
  const med = w.slice().sort((a, b) => a - b)[Math.floor(w.length / 2)] || 1;
  const ratio = m1[swIdx].v / med;
  const edge = d === 1 ? m1[swIdx].h : m1[swIdx].l;     // the far side of the volume bar
  let clearedAt = -1;
  for (let j = swIdx + 1; j < Math.min(m1.length, swIdx + within); j++) {
    if (d === 1 ? m1[j].c > edge : m1[j].c < edge) { clearedAt = j; break; }
  }
  return { ratio: +ratio.toFixed(2), elevated: ratio >= mult,
           edge: +edge.toFixed(2), clearedAt, confirmed: ratio >= mult && clearedAt > 0 };
}

module.exports = { context, exhaustion, pivots };
