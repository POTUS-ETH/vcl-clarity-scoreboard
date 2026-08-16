// What, exactly, is Craig's PVS line?
//
// Four rows carry a hand-read PVS Price. That is four numbers to hit, and several
// plausible rules that could produce them — AVWAP anchored at the peak, at entry, or at
// the swing low that started the leg; exit AT the VWAP or at a structural level it
// permits. Guessing between them from a screenshot's pixels is not evidence. This prints
// what each candidate rule actually produces on the tape so the four hand reads can
// arbitrate. A rule that only fits after its parameters are tuned to these four points
// has not been validated — it has been drawn around them.
const { load } = require('./bars');
const { simulate, barIndexForEntryTime } = require('./verify');
const { avwapFrom } = require('./derive');
const { enteredTimestamps } = require('./derive');

const NUM = {9:'3b87e54146b5809d88d1c99367fa1563',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',20:'3b87e54146b5809bb231f7600e390481'};

const dirOf = t => t.Direction === 'Long' ? 1 : -1;

// first bar at/after `from` whose CLOSE is on the wrong side of the series
function firstLoss(bars, series, from, endIdx, d) {
  for (let k = from; k <= endIdx && k < bars.length; k++) {
    const v = series[k];
    if (v == null) continue;
    if (d === 1 ? bars[k].c < v : bars[k].c > v) return { k, v: +v.toFixed(4) };
  }
  return null;
}

// the swing low (long) / high (short) that launched the leg into entry
function legStart(bars, entryIdx, d, look = 60) {
  let best = entryIdx, bv = d === 1 ? bars[entryIdx].l : bars[entryIdx].h;
  for (let k = Math.max(0, entryIdx - look); k <= entryIdx; k++) {
    const v = d === 1 ? bars[k].l : bars[k].h;
    if (d === 1 ? v < bv : v > bv) { bv = v; best = k; }
  }
  return best;
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);

  for (const [n, id] of Object.entries(NUM)) {
    const t = byId[id];
    const d = dirOf(t);
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) { console.log(`#${n}: no bar`); continue; }
    const s = simulate(t, bars, i);
    const endIdx = bars.findIndex(b => b.t === Date.parse(s.exitTime));
    const end = endIdx < 0 ? Math.min(i + 720, bars.length - 1) : endIdx;

    // peak bar
    let peakIdx = i, peak = d === 1 ? bars[i].h : bars[i].l;
    for (let k = i; k <= end; k++) {
      const f = d === 1 ? bars[k].h : bars[k].l;
      if (d * (f - peak) > 0) { peak = f; peakIdx = k; }
    }
    const lsIdx = legStart(bars, i, d);

    console.log(`\n#${n}  ${t.date} ${t.Session} ${t.Direction}  entry ${t.entry}  SL ${t.sl}  anchor(1) ${t.anchor}  1.618 ${t.t1618}`);
    console.log(`   LOGGED PVS PRICE ............ ${t.pvsPrice}`);
    console.log(`   entry bar ${new Date(bars[i].t).toISOString().slice(11,16)}Z   peak ${peak} @${new Date(bars[peakIdx].t).toISOString().slice(11,16)}Z   window ends ${new Date(bars[end].t).toISOString().slice(11,16)}Z (${s.exitReason})`);

    for (const [label, a] of [['AVWAP @ peak', peakIdx], ['AVWAP @ entry', i], ['AVWAP @ leg start', lsIdx]]) {
      const vw = avwapFrom(bars, a, end);
      const hit = firstLoss(bars, vw, Math.max(a, peakIdx), end, d);
      const at = hit ? hit.v : null;
      const mark = at != null ? ` [diff ${(at - t.pvsPrice >= 0 ? '+' : '') + (at - t.pvsPrice).toFixed(3)}]` : '';
      console.log(`   ${label.padEnd(18)} anchor ${new Date(bars[a].t).toISOString().slice(11,16)}Z  ` +
        (hit ? `lost at ${new Date(bars[hit.k].t).toISOString().slice(11,16)}Z, VWAP there = ${at}${mark}` : 'never lost in window'));
    }

    // structural levels sitting near the logged price, for the BoS reading
    const near = [];
    for (let k = i; k <= end; k++) {
      for (const [lbl, p] of [['low', bars[k].l], ['high', bars[k].h], ['close', bars[k].c]]) {
        if (Math.abs(p - t.pvsPrice) <= 0.015) near.push(`${new Date(bars[k].t).toISOString().slice(11,16)}Z ${lbl} ${p}`);
      }
    }
    console.log(`   bars touching ${t.pvsPrice} ±1.5c : ${near.length ? near.slice(0, 6).join(' | ') + (near.length > 6 ? ` …${near.length - 6} more` : '') : 'NONE'}`);
  }
})();
