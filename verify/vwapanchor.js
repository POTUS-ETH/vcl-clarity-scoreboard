// Where is the AVWAP anchored?
//
// Craig places the entry one tick beyond the selected AVWAP. That turns every logged
// entry into a MEASUREMENT of that AVWAP: whatever it is, its value must have been
// entry - (1 tick in the trade's direction). 32 trades, 32 constraints, and the anchor is
// a single choice per trade — so the true anchor should reproduce all of them to within
// a tick or two, while a wrong one will miss by a lot on most.
//
// THE OVERFIT RISK IS REAL AND IS THE POINT OF THE THRESHOLDS BELOW. Sweeping a dozen
// candidates against 32 points will always produce a "best". A best that lands inside a
// tick on nearly every row is a rule; a best that merely beats the others is noise with a
// ranking. So this reports the full distribution per candidate, not a winner, and refuses
// to call anything identified unless it clears an absolute bar rather than a relative one.
//
// Anchors are evaluated at the ENTRY bar. That is an assumption worth stating: the limit
// is placed when the fib is drawn and the AVWAP drifts afterwards, so if every candidate
// misses by a consistent drift this is the first thing to revisit.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503'};

const TICK = 0.01;
const dirOf = t => t.Direction === 'Long' ? 1 : -1;
const typical = b => (b.h + b.l + b.c) / 3;

/** AVWAP from bar index a, evaluated at bar index upto. */
function avwap(bars, a, upto) {
  let pv = 0, vv = 0;
  for (let k = a; k <= upto; k++) { pv += typical(bars[k]) * bars[k].v; vv += bars[k].v; }
  return vv > 0 ? pv / vv : null;
}

/** Index of the first bar at or after a given UTC hour on the entry bar's own day. */
function todayAt(bars, i, utcHour) {
  const day = new Date(bars[i].t); day.setUTCHours(utcHour, 0, 0, 0);
  const ms = day.getTime();
  if (ms > bars[i].t) return -1;
  for (let k = i; k >= 0; k--) if (bars[k].t <= ms) return k;
  return 0;
}

/** Most recent bar before `i` whose extreme is the running high/low over `look` bars. */
function swing(bars, i, look, high) {
  let best = -1, bv = null;
  for (let k = Math.max(1, i - look); k < i; k++) {
    const v = high ? bars[k].h : bars[k].l;
    if (bv == null || (high ? v > bv : v < bv)) { bv = v; best = k; }
  }
  return best;
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && r.t.entryTime && r.t.entry != null).sort((a, b) => a.n - b.n);

  // Candidate anchors. NY is UTC-4 in August, so NY 09:30 = 13:30 UTC etc.
  const CAND = {
    'UTC midnight'        : (b, i) => todayAt(b, i, 0),
    'NY midnight (04Z)'   : (b, i) => todayAt(b, i, 4),
    'Asia open (00Z)'     : (b, i) => todayAt(b, i, 0),
    'London open (07Z)'   : (b, i) => todayAt(b, i, 7),
    'NY open (13:30Z)'    : (b, i) => { const k = todayAt(b, i, 13); if (k < 0) return -1;
                                        for (let x = k; x <= i; x++) if (new Date(b[x].t).getUTCMinutes() >= 30) return x; return k; },
    'anchor-structure bar': (b, i, t) => { const d = dirOf(t);
        for (let k = i; k >= Math.max(0, i - 480); k--) {
          const px = d === 1 ? b[k].h : b[k].l;
          if (Math.abs(px - t.anchor) < TICK / 2) return k; } return -1; },
    'swing low 120b'      : (b, i) => swing(b, i, 120, false),
    'swing high 120b'     : (b, i) => swing(b, i, 120, true),
    'counter-swing 120b'  : (b, i, t) => swing(b, i, 120, dirOf(t) !== 1),
    'entry - 60 bars'     : (b, i) => Math.max(0, i - 60),
    'entry - 240 bars'    : (b, i) => Math.max(0, i - 240),
  };

  const res = {};
  for (const name of Object.keys(CAND)) res[name] = [];

  for (const { n, t } of rows) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    const d = dirOf(t);
    const target = t.entry - d * TICK;          // what the AVWAP must have read
    for (const [name, fn] of Object.entries(CAND)) {
      const a = fn(bars, i, t);
      if (a < 0 || a > i) continue;
      const v = avwap(bars, a, i);
      if (v == null) continue;
      res[name].push({ n, err: Math.abs(v - target), signed: v - target });
    }
  }

  console.log('=== which AVWAP does the entry sit one tick beyond? ===\n');
  console.log('  Every logged entry measures the AVWAP: it must have read entry -/+ 1 tick.\n');
  console.log('  candidate anchor        n   <=1 tick  <=3 ticks   mean err   median signed');
  const ranked = Object.entries(res).map(([name, a]) => {
    const errs = a.map(x => x.err).sort((p, q) => p - q);
    const sg = a.map(x => x.signed).sort((p, q) => p - q);
    return { name, n: a.length,
             t1: a.filter(x => x.err <= TICK * 1.5).length,
             t3: a.filter(x => x.err <= TICK * 3.5).length,
             mean: errs.reduce((p, q) => p + q, 0) / (errs.length || 1),
             med: sg[Math.floor(sg.length / 2)] };
  }).sort((a, b) => b.t1 - a.t1 || a.mean - b.mean);

  for (const r of ranked)
    console.log(`  ${r.name.padEnd(22)} ${String(r.n).padStart(2)}   ${String(r.t1).padStart(7)}   ${String(r.t3).padStart(8)}   ${r.mean.toFixed(4).padStart(8)}   ${(r.med >= 0 ? '+' : '') + r.med.toFixed(4)}`);

  const top = ranked[0];
  const IDENTIFIED = top.t1 >= top.n * 0.8;
  console.log(`\n  best: "${top.name}" — ${top.t1}/${top.n} inside one tick, mean error ${top.mean.toFixed(4)}`);
  console.log(`  ${IDENTIFIED ? 'That clears the bar: this is the anchor.'
    : 'NOT IDENTIFIED. Beating the other candidates is not the same as being right —\n' +
      '  the true anchor should land inside a tick on nearly every row, and none does.\n' +
      '  The anchor is something not in this list, or it is not evaluated at the entry bar.'}`);
})();
