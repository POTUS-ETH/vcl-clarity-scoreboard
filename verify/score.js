// Detect, then SCORE. Every run so far counted setups and never simulated one forward,
// so "15 setups" said nothing about whether the model makes money.
//
// Only the BE methodologies are scored. PVS needs the trail, which is still unvalidated —
// scoring it would put a number on an interpretation rather than on the strategy.
//
// The filters that showed no discriminating power on Craig's own trades are OFF: the 1H
// binary trend read (which also rejected 17 of his 32) and the session gate (Asia held
// four of his best five longs). What stays is what survived testing: the sweep, the FVG
// confluence, the ladder ordering check, and his 0.25 fib-range floor.
const { load } = require('./bars');
const V = require('./vcl');

const TICK = 0.01;

function simulate(m1, s) {
  const d = s.d, R = 0.552 * s.range;
  let l1 = false, cleared = false, mfe = s.entryPx;
  for (let j = s.entryIdx; j < Math.min(m1.length, s.entryIdx + 720); j++) {
    const b = m1[j];
    const stop = cleared ? null : s.zero;            // null => BE, handled below
    const fav = d === 1 ? b.h : b.l;
    if (d * (fav - mfe) > 0) mfe = fav;
    // L1 fills only if it is reached before the active stop on this bar
    const active = cleared ? (l1 ? (s.entryPx + s.L1) / 2 : s.entryPx) : s.zero;
    const out = d === 1 ? b.l < active : b.h > active;
    if (!l1 && b.l <= s.L1 && s.L1 <= b.h && (!out || d * (s.L1 - active) > 0)) l1 = true;
    if (d * (fav - s.fib1) >= 0) cleared = true;
    if (out) return { exit: 'stop', l1, cleared, mfe: +mfe.toFixed(2), bars: j - s.entryIdx };
  }
  return { exit: 'timeout', l1, cleared, mfe: +mfe.toFixed(2), bars: 720 };
}

/** R for one BE methodology, using the law: 1R is always the full two-fill ladder risk. */
function scoreBE(s, sim, target) {
  const d = s.d, R = 0.552 * s.range;
  const legs = sim.l1 ? [s.entryPx, s.L1] : [s.entryPx];
  const pnl = px => legs.reduce((a, e) => a + d * (px - e), 0);
  if (!sim.cleared) return pnl(s.zero) / R;                  // never cleared: full stop
  if (d * (sim.mfe - target) >= 0) return pnl(target) / R;   // target paid
  return 0;                                                  // closed at break-even
}

(async () => {
  const m1 = await load('SOLUSDT', '1', '2026-07-20T00:00:00Z', '2026-08-09T00:00:00Z');
  const all = V.detect(m1, [5, 15], 1, { macroTf: 60 });
  // rerun without the trend gate by scoring every sweep-derived setup the detector built
  const raw = V.detect(m1, [5, 15], 1, { macroTf: 60, noTrend: true });
  const setups = (raw.length ? raw : all);
  console.log(`=== SCORED RUN — LONGS ONLY, ${setups.length} setups ===\n`);
  console.log('   date        entry   px      0      1      1.618   range   L1  cleared  BE1.618  BE2.272');
  let n = 0; const s1 = [], s2 = [];
  for (const s of setups) {
    const sim = simulate(m1, s);
    const r1 = scoreBE(s, sim, s.t1618), r2 = scoreBE(s, sim, s.t2272);
    s1.push(r1); s2.push(r2); n++;
    console.log(`  ${V.nyDate(s.tEntry)}  ${V.nyHM(s.tEntry)}  ${String(s.entryPx).padEnd(6)} ${String(s.zero).padEnd(6)} ${String(s.fib1).padEnd(6)} ${String(s.t1618).padEnd(7)} ${String(s.range).padEnd(7)} ${sim.l1?'Y':'.'}   ${sim.cleared?'Y':'.'}       ${r1.toFixed(2).padStart(6)}   ${r2.toFixed(2).padStart(6)}`);
  }
  const st = a => { const m = a.reduce((x,y)=>x+y,0)/a.length;
    const sd = Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/(a.length-1||1));
    return { m, sd, se: sd/Math.sqrt(a.length), w: a.filter(v=>v>0).length/a.length*100 }; };
  console.log(`\n  n = ${n}`);
  for (const [lbl, a] of [['BE 1.618', s1], ['BE 2.272', s2]]) {
    const x = st(a);
    console.log(`  ${lbl}   expectancy ${x.m.toFixed(3)}R   win ${x.w.toFixed(0)}%   95% CI ${(x.m-2.04*x.se).toFixed(2)} to ${(x.m+2.04*x.se).toFixed(2)}`);
  }
  console.log(`\n  For scale: the SOP claims 55% WR / 0.60R on crypto, gross of fees.`);
  console.log(`  Fees at the median range here cost roughly 20-60% of 1R depending on maker vs taker.`);
})();
