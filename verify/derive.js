// Derives, from exchange tape alone, every field Craig currently types by hand that
// isn't a discretionary chart read. What survives as manual input is only: Date,
// Entry Time, Pair, Timeframe, and the six fib prices — the fib placement being a
// swing HE picks (verified: the anchor matches a tape high exactly, but the fib-0 sits
// 26c off the window low, so it is a judgement call no algorithm can recover).
//
// PVS IS AN INTERPRETATION, NOT A READING — and reading Craig's screenshots settled what
// it looks like without settling how to compute it. On his charts PVS and EVS are drawn
// levels: an anchored-VWAP curve (magenta for PVS, cyan for EVS) runs forward from its
// anchor, and where price gives it up a horizontal ray carries that value across the
// chart, labelled and tagged on the price axis. So the number in the log is a level he
// read off a line, and the screenshots are a direct, auditable source for it.
//
// That audit has been done on all four rows carrying a hand-read PVS Price: #13 (74.11),
// #14 (73.50) and #20 (74.57) match the chart exactly; #9 does not — its ray sits below
// the 0.618 line at ~73.81 while the log says 73.92, which is above it.
//
// What it did NOT settle is the anchor. None of the three candidates tried here — peak,
// entry, or leg start — reproduces all four rays, and with four points and a free
// lookback any rule can be bent to fit. So pvsTrail below remains UNVALIDATED and its
// output is never written back. The screenshots are the source of truth for PVS; this
// code is a hypothesis about them.
const { load } = require('./bars');
const { simulate } = require('./verify');

const dirOf = t => t.Direction === 'Long' ? 1 : -1;
const typical = b => (b.h + b.l + b.c) / 3;

/**
 * Anchored VWAP series from bar index `a` forward: Σ(typical·vol)/Σ(vol).
 * Volume is present on every cached bar (checked: 8641/8641), so this needs no chart.
 */
function avwapFrom(bars, a, upto) {
  const out = [];
  let pv = 0, vv = 0;
  for (let k = a; k <= upto && k < bars.length; k++) {
    pv += typical(bars[k]) * bars[k].v;
    vv += bars[k].v;
    out[k] = vv > 0 ? pv / vv : null;
  }
  return out;
}

/**
 * PVS trail: VWAP re-anchored at each new favourable extreme after the fills; the trade
 * runs while price holds that VWAP and exits when it loses it.
 *
 * Returns the exit price and which targets were reached BEFORE the trail let go — which
 * is the distinction the PVS Hit checkboxes encode, and the reason those are not simply
 * "did price ever touch the level".
 */
function pvsTrail(t, bars, entryIdx, endIdx, pivot = 2) {
  const d = dirOf(t);
  let peakIdx = entryIdx, peak = d === 1 ? bars[entryIdx].h : bars[entryIdx].l;
  let vw = avwapFrom(bars, peakIdx, endIdx);
  let hit1618 = false, hit2272 = false;
  let trailStop = null;                       // the BoS level the stop sits behind

  // a confirmed structural pivot `pivot` bars back: the level the stop trails behind
  const pivotAt = k => {
    const c = k - pivot;
    if (c - pivot < entryIdx) return null;
    for (let x = c - pivot; x <= c + pivot && x <= k; x++) {
      if (x === c) continue;
      if (d === 1 ? bars[x].l < bars[c].l : bars[x].h > bars[c].h) return null;
    }
    return d === 1 ? bars[c].l : bars[c].h;
  };

  for (let k = entryIdx; k <= endIdx && k < bars.length; k++) {
    const b = bars[k];
    const fav = d === 1 ? b.h : b.l;
    if (t.t1618 != null && d * (fav - t.t1618) >= 0) hit1618 = true;
    if (t.t2272 != null && d * (fav - t.t2272) >= 0) hit2272 = true;
    if (hit2272) return { exit: t.t2272, exitIdx: k, hit1618: true, hit2272: true, reason: 'target 2.272' };

    if (d * (fav - peak) > 0) { peak = fav; peakIdx = k; vw = avwapFrom(bars, peakIdx, endIdx); }

    // THE RULE: the stop trails BREAK OF STRUCTURE, and the AVWAP is the PERMISSION to
    // keep trailing — not the exit itself. So the trail only advances to a new pivot
    // while price is still protected by the peak-anchored VWAP, and the position leaves
    // at the trailed STRUCTURAL level. (An earlier version exited at the VWAP value
    // itself; that is a different rule and it did not reproduce the hand reads.)
    const v = vw[k];
    const protectedByVwap = v == null ? true : (d === 1 ? b.c >= v : b.c <= v);
    if (protectedByVwap) {
      const p = pivotAt(k);
      if (p != null && (trailStop == null || d * (p - trailStop) > 0)) trailStop = p;
    }

    if (trailStop != null) {
      const broke = d === 1 ? b.l <= trailStop : b.h >= trailStop;
      if (broke) return { exit: +trailStop.toFixed(4), exitIdx: k, hit1618, hit2272,
                          reason: 'trailed BoS broken' };
    }
  }
  return { exit: null, exitIdx: endIdx, hit1618, hit2272, reason: 'window ended with trail intact' };
}

/** Everything the tape can settle for one trade. */
function derive(t, bars, entryIdx) {
  const s = simulate(t, bars, entryIdx);
  const endIdx = bars.findIndex(b => b.t === Date.parse(s.exitTime));
  const pvs = pvsTrail(t, bars, entryIdx, endIdx < 0 ? bars.length - 1 : endIdx);
  const utc = new Date(bars[entryIdx].t);
  const hh = utc.getUTCHours();
  return {
    maxRun: s.mfe,
    l1Filled: s.l1Filled,
    movedStopToBE: s.clearedAnchor,          // clearing the anchor IS the BE trigger
    closedAtBE: s.clearedAnchor && s.exitReason === 'stop',
    pvsHit1618: pvs.hit1618,
    pvsHit2272: pvs.hit2272,
    pvsPrice: pvs.hit2272 ? null : pvs.exit, // inert when the target paid
    pvsReason: pvs.reason,
    direction: dirOf(t) === 1 ? 'Long' : 'Short',
    sessionUTCHour: hh,
  };
}

/**
 * Check the PVS interpretation against rows where Craig already read the trail by hand.
 * Only rows carrying BOTH an Entry Time (so they can be anchored exactly) and a manual
 * PVS Price are usable — anything else would be comparing against a guess.
 */
/**
 * An Entry Time is only real if someone typed it. Notion's picker seeds the field with
 * today's date and a fixed clock time, so an untouched row still carries a timestamp —
 * one that is syntactically valid, lands on a real bar, and is completely fictional.
 * Scoring such a row yields a full, confident reconstruction of a trade that never
 * happened, indistinguishable by eye from a genuine finding.
 *
 * THE TEST: the entry PRICE is an independent witness to the entry TIME. Craig read the
 * clock off the chart and typed it; he read the fill off the same chart and typed that
 * too. If the bar at that minute never traded that price, the two disagree and the row is
 * not scoreable. Pass `bars` to get this check — it is the reliable one.
 *
 * Without `bars` this falls back to a collision heuristic (a clock time shared across
 * rows whose stamp dates differ from their trade dates). That fallback is weaker and
 * demonstrably misses cases: #31 and #32 both carried the default 09:46, which collides
 * with #1's GENUINE 09:46, and only two rows had the date tell — under the collision
 * threshold. The price test caught both immediately, at 81c and 87c off their own entries.
 *
 * The tolerance is deliberately loose. Logged prices are drawn fib levels, not fill
 * prices, so a real entry can miss its bar's range by a cent (#23 does, by exactly that).
 * A placeholder misses by most of a dollar. Nothing lives in between.
 */
const ENTRY_PRICE_TOLERANCE = 0.02;

function enteredTimestamps(trades, bars) {
  if (bars) {
    const { barIndexForEntryTime } = require('./verify');
    const good = t => {
      if (!t.entryTime || !t.date || t.entry == null) return false;
      const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
      if (i < 0) return false;
      const b = bars[i];
      if (b.l <= t.entry && t.entry <= b.h) return true;
      return Math.min(Math.abs(b.l - t.entry), Math.abs(b.h - t.entry)) <= ENTRY_PRICE_TOLERANCE;
    };
    return {
      entered: trades.filter(t => t.entryTime && good(t)),
      placeholder: trades.filter(t => t.entryTime && !good(t)),
    };
  }

  const byHM = {};
  trades.filter(t => t.entryTime).forEach(t => {
    const hm = t.entryTime.slice(11, 16);
    (byHM[hm] = byHM[hm] || []).push(t);
  });
  const suspect = new Set(
    Object.entries(byHM)
      .filter(([, rows]) => rows.length > 2 && rows.filter(r => r.entryTime.slice(0, 10) !== r.date).length > 2)
      .flatMap(([, rows]) => rows.map(r => r.id))
  );
  return {
    entered: trades.filter(t => t.entryTime && !suspect.has(t.id)),
    placeholder: trades.filter(t => t.entryTime && suspect.has(t.id)),
  };
}

function validatePVS(trades, bars) {
  const { barIndexForEntryTime } = require('./verify');
  // Both conditions are required. Without Entry Time the trade cannot be anchored, and
  // without a hand-read PVS Price there is nothing to check the interpretation against.
  const { entered } = enteredTimestamps(trades, bars);
  const usable = entered.filter(t => t.date && t.pvsPrice != null && t.Timeframe === '1m');
  const rows = [];
  for (const t of usable) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    const d = derive(t, bars, i);
    rows.push({
      date: t.date, session: t.Session, dir: t.Direction,
      manual: t.pvsPrice, computed: d.pvsPrice,
      diff: d.pvsPrice == null ? null : +(d.pvsPrice - t.pvsPrice).toFixed(4),
      reason: d.pvsReason,
      hitsManual: `${!!t.pvsHit1}/${!!t.pvsHit2}`,
      hitsComputed: `${d.pvsHit1618}/${d.pvsHit2272}`,
    });
  }
  const priced = rows.filter(r => r.diff != null);
  return {
    eligible: usable.length,
    compared: priced.length,
    withinACent: priced.filter(r => Math.abs(r.diff) <= 0.01).length,
    hitsAgree: rows.filter(r => r.hitsManual === r.hitsComputed).length,
    rows,
  };
}

module.exports = { derive, pvsTrail, avwapFrom, validatePVS, enteredTimestamps };
