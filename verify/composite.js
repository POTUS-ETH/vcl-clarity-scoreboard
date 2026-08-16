// Bybit-only AVWAP vs a Bybit+Binance consolidated AVWAP, same setups, same everything else.
//
// The ONLY difference between the two runs is which volume the entry line is computed from.
// The sweep, the fib-1, the ladder, the stop and the scoring are identical, so any gap in
// expectancy is attributable to the AVWAP and nothing else. That is the whole point of
// running it as a paired comparison rather than two separate backtests.
const { load } = require('./bars');
const Vn = require('./venues');
const V = require('./vcl');

const TICK = 0.01, typical = b => (b.h + b.l + b.c) / 3;

/** Cumulative price*volume and volume, aligned onto the Bybit timestamp grid. */
function cum(series, grid) {
  const map = new Map(series.map(b => [b.t, b]));
  const pv = new Float64Array(grid.length + 1), vv = new Float64Array(grid.length + 1);
  for (let i = 0; i < grid.length; i++) {
    const b = map.get(grid[i].t);
    pv[i + 1] = pv[i] + (b ? typical(b) * b.v : 0);
    vv[i + 1] = vv[i] + (b ? b.v : 0);
  }
  return { pv, vv };
}

function run(m1, setups, cums, label) {
  const rows = [];
  for (const s of setups) {
    // recompute the entry from THIS volume basis, walking forward from the sweep anchor
    let entry = -1, entryPx = null, fib1 = s.d === 1 ? m1[s.bosIdx].h : m1[s.bosIdx].l;
    for (let j = s.bosIdx + 1; j < Math.min(m1.length, s.bosIdx + 240); j++) {
      const ext = s.d === 1 ? m1[j].h : m1[j].l;
      if (s.d * (ext - fib1) > 0) fib1 = ext;
      let pv = 0, vv = 0;
      for (const c of cums) { pv += c.pv[j + 1] - c.pv[s.swIdx]; vv += c.vv[j + 1] - c.vv[s.swIdx]; }
      if (vv <= 0) continue;
      const want = +(pv / vv + s.d * TICK).toFixed(2);
      if (m1[j].l <= want && want <= m1[j].h) { entry = j; entryPx = want; break; }
      if (s.d === 1 ? m1[j].l < s.sweptTo : m1[j].h > s.sweptTo) break;
    }
    if (entry < 0) continue;
    const zero = (entryPx - 0.382 * fib1) / 0.618;
    const ok = s.d === 1 ? (zero < entryPx && entryPx < fib1) : (fib1 < entryPx && entryPx < zero);
    if (!ok) continue;
    const range = Math.abs(fib1 - zero);
    if (range < 0.25) continue;
    const at = f => zero + f * (fib1 - zero);
    const t = { d: s.d, entryIdx: entry, entryPx, zero: +zero.toFixed(2), L1: +at(0.17).toFixed(2),
                fib1: +fib1.toFixed(2), t1618: +at(1.618).toFixed(2), t2272: +at(2.272).toFixed(2), range };
    // simulate
    let l1 = false, cleared = false, mfe = entryPx, exit = 'timeout';
    for (let j = entry; j < Math.min(m1.length, entry + 720); j++) {
      const b = m1[j], fav = s.d === 1 ? b.h : b.l;
      if (s.d * (fav - mfe) > 0) mfe = fav;
      const active = cleared ? (l1 ? (entryPx + t.L1) / 2 : entryPx) : t.zero;
      const out = s.d === 1 ? b.l < active : b.h > active;
      if (!l1 && b.l <= t.L1 && t.L1 <= b.h && (!out || s.d * (t.L1 - active) > 0)) l1 = true;
      if (s.d * (fav - t.fib1) >= 0) cleared = true;
      if (out) { exit = 'stop'; break; }
    }
    const R = 0.552 * range;
    const legs = l1 ? [entryPx, t.L1] : [entryPx];
    const pnl = px => legs.reduce((a, e) => a + s.d * (px - e), 0);
    const sc = tg => !cleared ? pnl(t.zero) / R : (s.d * (mfe - tg) >= 0 ? pnl(tg) / R : 0);
    rows.push({ r1: sc(t.t1618), r2: sc(t.t2272), l1, cleared, range });
  }
  const st = a => { const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1 || 1));
    return { m, se: sd / Math.sqrt(a.length), w: a.filter(v => v > 0).length / a.length * 100 }; };
  const A = st(rows.map(r => r.r1)), B = st(rows.map(r => r.r2));
  console.log(`  ${label.padEnd(26)} n=${String(rows.length).padStart(3)}   ` +
    `BE1.618 ${A.m.toFixed(3).padStart(6)}R (win ${A.w.toFixed(0)}%, CI ${(A.m-2.04*A.se).toFixed(2)} to ${(A.m+2.04*A.se).toFixed(2)})   ` +
    `BE2.272 ${B.m.toFixed(3).padStart(6)}R`);
  return rows;
}

(async () => {
  const m1 = await load('SOLUSDT', '1', '2026-07-20T00:00:00Z', '2026-08-09T00:00:00Z');
  const bnb = await Vn.load('binance', 'SOLUSDT', '2026-07-20T00:00:00Z', '2026-08-09T00:00:00Z');
  const setups = V.detect(m1, [5, 15], 1, { macroTf: 60, noTrend: true });
  const cB = cum(m1, m1), cN = cum(bnb, m1);
  console.log(`=== AVWAP BASIS TEST — ${setups.length} long setups, identical in every respect but the volume basis ===\n`);
  run(m1, setups, [cB], 'Bybit only (26% of tape)');
  run(m1, setups, [cN], 'Binance only (74%)');
  run(m1, setups, [cB, cN], 'CONSOLIDATED (both)');
  console.log('\n  Same sweeps, same fib-1, same ladder maths, same simulation. Only the line moves.');
})();
