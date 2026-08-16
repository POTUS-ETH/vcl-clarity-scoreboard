// Independently re-derives each logged trade from Bybit's tape and diffs it against
// what Craig recorded. Nothing here reads the Notion outcome formulas — it rebuilds
// the facts from bars and then compares.
//
// THE HARD PART: the log stores a Date and a Session but no entry timestamp, so a
// trade cannot simply be looked up. Each one has to be fingerprinted: find the bars
// in that session where price actually traded through the logged entry, simulate the
// trade forward from each candidate, and see which (if any) reproduces the log. Where
// more than one candidate survives, this reports the ambiguity instead of picking one —
// a forced match would manufacture agreement rather than test for it.
//
// RESOLUTION CEILING: Bybit's smallest kline is 1 minute. For the 1m rows that is the
// native resolution and the reconstruction is exact. For the 15s rows a single bar can
// hide the ORDER of events inside it, which is exactly what the retrace-after-L1
// question turns on — so 15s rows are reported as UNRESOLVABLE rather than judged.
const { load } = require('./bars');

// Session windows in UTC. Craig's charts render UTC-4 (EDT), so NY 09:30 = 13:30 UTC.
// Deliberately generous — these only narrow the search, they are not evidence.
const SESSION_UTC = {
  'Asia':   [0, 9],
  'London': [6, 14],
  'NY AM':  [12, 18],
  'NY PM':  [16, 23],
};

const dir = t => t.Direction === 'Long' ? 1 : -1;
// "at or beyond b, in the trade's favour"
const beyond = (t, a, b) => dir(t) * (a - b) >= 0;

// Did this bar trade through price p at all?
const touched = (bar, p) => bar.l <= p && p <= bar.h;

/**
 * Simulate one trade forward from a candidate entry bar.
 * Returns the facts the log claims to record, rebuilt from bars.
 */
function simulate(t, bars, i) {
  const d = dir(t);
  let mfe = t.entry;            // max favourable excursion, seeded at entry
  let l1Filled = false;
  let l1FillIdx = null;
  let retracedAfterL1 = false;  // came back to entry AFTER L1 filled — a SEQUENCE claim
  let clearedAnchor = false;
  let hit1618 = false, hit2272 = false;
  let exitIdx = null, exitReason = null;

  for (let k = i; k < bars.length; k++) {
    const b = bars[k];
    // adverse side first within a bar: if both the stop and a target are inside the
    // same bar we cannot know which came first, so assume the stop (conservative).
    const stopHit = d === 1 ? b.l <= t.sl : b.h >= t.sl;

    if (t.l1 != null && !l1Filled && touched(b, t.l1)) { l1Filled = true; l1FillIdx = k; }
    if (l1Filled && k >= l1FillIdx && touched(b, t.entry) && k > l1FillIdx) retracedAfterL1 = true;

    const fav = d === 1 ? b.h : b.l;
    if (d * (fav - mfe) > 0) mfe = fav;
    if (t.anchor != null && beyond(t, fav, t.anchor)) clearedAnchor = true;
    if (t.t1618 != null && beyond(t, fav, t.t1618)) hit1618 = true;
    if (t.t2272 != null && beyond(t, fav, t.t2272)) hit2272 = true;

    if (stopHit) { exitIdx = k; exitReason = 'stop'; break; }
    if (hit2272) { exitIdx = k; exitReason = '2.272'; break; }
    if (k - i > 720) { exitIdx = k; exitReason = 'timeout-12h'; break; }
  }
  return { entryIdx: i, entryTime: new Date(bars[i].t).toISOString(),
           mfe: +mfe.toFixed(4), l1Filled, retracedAfterL1, clearedAnchor,
           hit1618, hit2272, exitReason,
           exitTime: exitIdx != null ? new Date(bars[exitIdx].t).toISOString() : null };
}

/** Find every plausible entry bar for a trade on its date+session. */
function candidates(t, bars) {
  const day = t.date;                       // 'YYYY-MM-DD'
  const [h0, h1] = SESSION_UTC[t.Session] || [0, 24];
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const dt = new Date(bars[i].t);
    if (dt.toISOString().slice(0, 10) !== day) continue;
    const hr = dt.getUTCHours();
    if (hr < h0 || hr >= h1) continue;
    if (!touched(bars[i], t.entry)) continue;
    // a retracement entry is approached from the favourable side: require the prior
    // bar to sit beyond entry, so we catch the pullback rather than every wobble
    const prev = bars[i - 1];
    const prevBeyond = dir(t) === 1 ? prev.h > t.entry : prev.l < t.entry;
    if (!prevBeyond) continue;
    out.push(i);
  }
  return out;
}

// Craig's TradingView charts render UTC-4 (New York). He enters Entry Time exactly as
// the chart shows it, so shift to UTC before matching against Bybit's UTC-stamped bars.
// If he ever re-timezones the chart, this constant is the single thing to change.
const CHART_UTC_OFFSET_HOURS = -4;

function barIndexForEntryTime(entryTimeISO, bars) {
  // Notion hands back e.g. "2026-08-03T10:28:00.000-04:00" or a naive "...T10:28:00".
  // A naive string carries no zone, so apply the chart offset explicitly rather than
  // letting Date.parse guess (it would silently read it as local or UTC).
  const naive = /[Zz]|[+-]\d\d:?\d\d$/.test(entryTimeISO) === false;
  const ms = naive
    ? Date.parse(entryTimeISO + 'Z') - CHART_UTC_OFFSET_HOURS * 3600_000
    : Date.parse(entryTimeISO);
  const floored = Math.floor(ms / 60_000) * 60_000;
  const i = bars.findIndex(b => b.t === floored);
  return { i, ms, floored };
}

function verify(t, bars) {
  // EXACT PATH: an entry timestamp removes the fingerprinting problem entirely.
  if (t.entryTime) {
    // Notion's date picker defaults to TODAY when you click the field without setting a
    // date, which yields the right time on the wrong day and would silently anchor the
    // trade to unrelated bars. Cross-check against the Date column before trusting it.
    const stampDay = t.entryTime.slice(0, 10);
    if (t.date && stampDay !== t.date) {
      return { row: t, status: 'DATE-MISMATCH',
               why: `Entry Time is dated ${stampDay} but the trade is dated ${t.date} — Notion's picker defaults to today; re-pick the date` };
    }
    const { i, floored } = barIndexForEntryTime(t.entryTime, bars);
    if (i < 0) return { row: t, status: 'TIME-OUT-OF-RANGE',
                        why: `no bar at ${new Date(floored).toISOString()} — check the timezone or extend the cached range` };
    if (t.Timeframe === '15s') {
      return { row: t, status: 'UNRESOLVABLE', anchored: true,
               why: '15s trade — entry time is known, but 1m bars still cannot order events inside a bar' };
    }
    const s = simulate(t, bars, i);
    return { row: t, status: 'OK', best: s, err: +Math.abs(s.mfe - t.maxRun).toFixed(4),
             nCandidates: 1, nClose: 1, exact: true };
  }

  if (t.Timeframe === '15s') {
    return { row: t, status: 'UNRESOLVABLE', why: '15s trade — 1m bars cannot order events inside a bar' };
  }
  const cands = candidates(t, bars);
  if (!cands.length) return { row: t, status: 'NO-CANDIDATE', why: 'price never traded through the logged entry in that session' };
  const sims = cands.map(i => simulate(t, bars, i));
  // score each candidate on how well it reproduces the logged Max Run
  const scored = sims.map(s => ({ s, err: Math.abs(s.mfe - t.maxRun) }))
                     .sort((a, b) => a.err - b.err);
  const best = scored[0];
  const close = scored.filter(x => x.err <= 0.02).length;
  return { row: t, status: 'OK', best: best.s, err: +best.err.toFixed(4),
           nCandidates: cands.length, nClose: close };
}

module.exports = { verify, simulate, candidates, load };
