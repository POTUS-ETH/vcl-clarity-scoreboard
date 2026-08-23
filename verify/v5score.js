// Score VCL V5 rows across all eight exit outcomes.
//
// WHY THIS IS TRIVIAL AND THE MNQ AUDIT WAS NOT. The 85 MNQ rows were logged under the
// ladder, whose stop sat at fib 0. Re-scoring them under V5's 0.085 stop is a
// COUNTERFACTUAL: their Max Run is conditioned on the wrong stop, so "did the tighter
// stop take it out first" needs bars, entry timestamps and intrabar ordering — and for
// trades older than ~30 days that data does not exist at any price.
//
// A row logged natively under V5 has none of that. It was TRADED with the 0.085 stop,
// so Max Run is already conditioned correctly and Trailing BOS Exit is the real exit.
// Every outcome is then pure arithmetic on the four typed prices. No bars. No timestamps.
// No ambiguity, no bounds, no unresolved bucket. That is the entire payoff of logging
// forward instead of auditing backward.
const FIB = { stop: 0.085, entry: 0.382, tp: 0.68, r2: 0.976, r3: 1.272, r5: 1.866 };

/** Solve the row's geometry from the only two prices that are typed. */
function levels(entry, oneOfFib) {
  const range = (oneOfFib - entry) / (1 - FIB.entry);   // signed: entry -> anchor
  const zero = entry - FIB.entry * range;
  const at = f => zero + f * range;
  const stop = at(FIB.stop);
  return { zero, anchor: oneOfFib, stop, tp: at(FIB.tp), at,
           oneR: Math.abs(entry - stop), dir: range > 0 ? 1 : -1 };
}

/**
 * Score one row. `row` needs: entry, oneOfFib, maxRun, bosExit.
 * Returns the eight outcomes in R, plus `stopped` and the geometry.
 */
function score(row) {
  const L = levels(row.entry, row.oneOfFib);
  const R = p => L.dir * (p - row.entry) / L.oneR;      // price -> R from entry
  const mr = R(row.maxRun), be = R(row.bosExit), tp = R(L.tp);

  // A native V5 row is stopped iff its real exit is at or beyond the stop. No inference.
  const stopped = L.dir * (row.bosExit - L.stop) <= 1e-9;
  if (stopped) {
    const dead = -1;
    return { ...L, mr, be, tp, stopped,
      f1: dead, f2: dead, f3: dead, f5: dead, trail: dead,
      c1272: dead, c1866: dead, half: dead };
  }
  // EPS: a Max Run typed at exactly the target price lands on 4.999999999999999 after the
  // price->R divide, and a bare >= then scores a 5R trade as -1R. Boundary hits are the
  // common case here (targets are levels people actually take profit at), not an edge case.
  const EPS = 1e-9;
  const hit = N => mr >= N - EPS;                        // Max Run gates every target
  const tpHit = mr >= tp - EPS;
  // Runner half is scored at its cap if the cap printed, else at the real trail exit.
  const runner = cap => tpHit ? 0.5 * tp + 0.5 * (hit(cap) ? cap : be) : -1;
  return { ...L, mr, be, tp, stopped,
    f1: hit(1) ? 1 : -1, f2: hit(2) ? 2 : -1, f3: hit(3) ? 3 : -1, f5: hit(5) ? 5 : -1,
    trail: be,                                           // full size, BE + BOS trail
    c1272: runner(3), c1866: runner(5),
    half: tpHit ? 0.5 * tp + 0.5 * be : -1 };
}

const KEYS = ['trail','c1866','c1272','half','f1','f2','f3','f5'];
const NAMES = { trail:'Full size -> BE + trail', c1866:'50% -> cap 1.866', c1272:'50% -> cap 1.272',
  half:'50% -> uncapped trail', f1:'Full TP @ 1R', f2:'Full TP @ 2R', f3:'Full TP @ 3R', f5:'Full TP @ 5R' };

/** Mean and 95% interval for one outcome across rows. */
function stat(vals) {
  const n = vals.length, m = vals.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, m, e: NaN };
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, m, e: 1.96 * sd / Math.sqrt(n) };
}

function report(rows) {
  const s = rows.map(score);
  const stops = s.filter(r => r.stopped).length;
  console.log(`  ${rows.length} rows · ${stops} stopped (${(stops / rows.length * 100).toFixed(0)}%) · ${rows.length - stops} live to a target`);
  console.log(`  no bars read · no entry timestamps needed · 0 unresolved\n`);
  console.log('  outcome                       exp        95% interval');
  console.log('  ' + '-'.repeat(52));
  KEYS.map(k => [k, stat(s.map(r => r[k]))])
      .sort((a, b) => b[1].m - a[1].m)
      .forEach(([k, t]) => console.log(
        `  ${NAMES[k].padEnd(26)} ${t.m >= 0 ? '+' : ''}${t.m.toFixed(3)}R` +
        (isNaN(t.e) ? '' : `   [${(t.m - t.e >= 0 ? '+' : '') + (t.m - t.e).toFixed(2)}, ${(t.m + t.e >= 0 ? '+' : '') + (t.m + t.e).toFixed(2)}]`)));
  return s;
}

module.exports = { levels, score, report, stat, KEYS, NAMES, FIB };
