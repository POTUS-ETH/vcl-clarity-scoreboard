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
    // The ACTIVE stop follows the system's universal rule: it sits at the original SL
    // until price clears the 1-of-fib anchor, and moves to break-even (entry) the moment
    // it does. So the position's life ends at the original stop OR, once risk-free, on a
    // return to entry. Running to the original SL regardless would stretch the window for
    // hours past the point the trade was actually closed and inflate Max Run.
    const activeStop = clearedAnchor ? t.entry : t.sl;
    // adverse side first within a bar: if both the stop and a target sit inside the same
    // bar we cannot know which came first, so assume the stop (conservative).
    const stopHit = d === 1 ? b.l <= activeStop : b.h >= activeStop;

    if (t.l1 != null && !l1Filled && touched(b, t.l1)) { l1Filled = true; l1FillIdx = k; }
    if (l1Filled && k >= l1FillIdx && touched(b, t.entry) && k > l1FillIdx) retracedAfterL1 = true;

    const fav = d === 1 ? b.h : b.l;
    if (d * (fav - mfe) > 0) mfe = fav;
    if (t.anchor != null && beyond(t, fav, t.anchor)) clearedAnchor = true;
    if (t.t1618 != null && beyond(t, fav, t.t1618)) hit1618 = true;
    if (t.t2272 != null && beyond(t, fav, t.t2272)) hit2272 = true;

    // Do NOT stop tracking when a target is touched. Max Run gates EVERY methodology's
    // outcome, so truncating it at one methodology's exit is circular — you would need
    // the exit to compute Max Run while Max Run is what decides the exit. The excursion
    // runs until the original stop takes the position out (or the window caps).
    if (stopHit) { exitIdx = k; exitReason = 'stop'; break; }
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

// Craig reads the clock off a TradingView chart rendered in New York time.
const CHART_TZ = 'America/New_York';

// Offset of CHART_TZ, in minutes, on a given UTC instant — derived from the IANA
// database rather than hardcoded, so DST is handled and this keeps working in winter.
function tzOffsetMinutes(utcMs, tz) {
  const d = new Date(utcMs);
  const s = d.toLocaleString('en-US', { timeZone: tz, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
  const asUTC = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5], +m[6]);
  return Math.round((asUTC - utcMs) / 60000);
}

// Convert a wall-clock time in `tz` to a UTC instant (two passes settles DST edges).
function wallClockToUTC(y, mo, d, hh, mm, tz) {
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let k = 0; k < 2; k++) guess = Date.UTC(y, mo - 1, d, hh, mm, 0) - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}

/**
 * Anchor a trade to a bar.
 *
 * The DAY comes from the Date column and the TIME-OF-DAY from Entry Time. That split
 * is deliberate: Notion's date picker defaults to TODAY when you click the field, so
 * the date attached to Entry Time is unreliable while the clock time — the part Craig
 * actually reads off the chart — is exactly what he typed. Date is already correct on
 * every row, so trusting it removes a whole class of silent error instead of asking
 * him to retype the date and hoping.
 */
function barIndexForEntryTime(entryTimeISO, tradeDate, bars) {
  // Read the wall-clock characters as stored; Notion writes local time plus its offset,
  // so "…T09:46:00.000-04:00" means the operator saw and typed 09:46.
  const wall = entryTimeISO.match(/T(\d{2}):(\d{2})/);
  if (!wall) return { i: -1, why: `unparseable Entry Time: ${entryTimeISO}` };
  const [y, mo, d] = tradeDate.split('-').map(Number);
  const ms = wallClockToUTC(y, mo, d, +wall[1], +wall[2], CHART_TZ);
  const floored = Math.floor(ms / 60_000) * 60_000;
  const i = bars.findIndex(b => b.t === floored);
  return { i, ms, floored, wallHHMM: `${wall[1]}:${wall[2]}` };
}

function verify(t, bars) {
  // EXACT PATH: an entry timestamp removes the fingerprinting problem entirely.
  if (t.entryTime && t.date) {
    const { i, floored, wallHHMM, why } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (why) return { row: t, status: 'BAD-TIME', why };
    if (i < 0) return { row: t, status: 'TIME-OUT-OF-RANGE',
                        why: `no bar at ${new Date(floored).toISOString()} (${wallHHMM} ${CHART_TZ} on ${t.date}) — extend the cached range` };
    // informational only: the date on the stamp is ignored by design, but if it
    // disagrees with the Date column it's worth surfacing once so nobody is surprised
    const stampDay = t.entryTime.slice(0, 10);
    const note = stampDay !== t.date
      ? `Entry Time's own date (${stampDay}) ignored — day taken from the Date column (${t.date})`
      : null;
    if (t.Timeframe === '15s') {
      return { row: t, status: 'UNRESOLVABLE', anchored: true, note,
               why: '15s trade — entry time is known, but 1m bars still cannot order events inside a bar' };
    }
    const s = simulate(t, bars, i);
    return { row: t, status: 'OK', best: s, err: +Math.abs(s.mfe - t.maxRun).toFixed(4),
             nCandidates: 1, nClose: 1, exact: true, note, wallHHMM };
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

module.exports = { verify, simulate, candidates, load, barIndexForEntryTime, CHART_TZ };

/**
 * Replay one trade under EVERY scenario the board scores, from tape alone.
 *
 * A row is not one path — it is the same trade replayed under BE and PVS, at 1.618 and
 * 2.272, full-send and 50%-off. Some scenarios close at a target, some at break-even,
 * some take the full stop, and they can disagree on the SAME trade. So the tape's job is
 * to establish the facts (did L1 fill, did the anchor clear, how far did price reach) and
 * let each scenario resolve itself from those. Asking "what was the exit" is malformed.
 */
function scenarios(t, bars, i) {
  const s = simulate(t, bars, i);
  const out = {};
  for (const [name, tgt, reached] of [['1.618', t.t1618, s.hit1618], ['2.272', t.t2272, s.hit2272]]) {
    if (tgt == null) { out[`BE·${name}`] = 'unscoreable — no target price logged'; continue; }
    out[`BE·${name}`] = !s.clearedAnchor ? 'full stop (−1R): never reached the anchor'
                      : reached          ? `target ${tgt}`
                                         : 'break-even (0R): cleared the anchor, missed target';
  }
  return { facts: s, scenarios: out };
}
module.exports.scenarios = scenarios;
