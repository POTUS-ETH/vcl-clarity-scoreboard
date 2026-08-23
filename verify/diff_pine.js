// Diff the Pine detector against detect_lib.js over the cached Bybit window.
// Two independent implementations of STRATEGY.md §3a. Agreement is evidence;
// divergence names a bar to go look at.
const { roll, detect } = require('./detect_lib.js');
const { load } = require('./bars.js');
const fs = require('fs');

const START = '2026-07-20T00:00:00Z', END = '2026-08-09T00:00:00Z';
const iso = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  const m1 = await load('SOLUSDT', '1', START, END);
  const htf = roll(m1, 5);
  const js = [...detect(m1, htf, 1), ...detect(m1, htf, -1)]
    .sort((a, b) => a.entryIdx - b.entryIdx)
    .filter((s, i, arr) => i === 0 || s.entryIdx > arr[i - 1].entryIdx);

  const s0 = Date.parse(START), s1 = Date.parse(END);
  const pine = fs.readFileSync(__dirname + '/pine_detections_2026-08-21.txt', 'utf8').trim().split('\n')
    .map(l => l.split('|'))
    .map(r => ({ d: r[0] === 'L' ? 1 : -1, t: +r[1], entryPx: +r[2], anchorC: +r[3], zero: +r[4], anchorS: +r[5], vol: +r[6] }))
    .filter(p => p.t >= s0 && p.t < s1);

  console.log(`window        ${iso(s0)} -> ${iso(s1)} UTC  (${m1.length} 1m bars cached)`);
  console.log(`detect_lib.js ${js.length} setups`);
  console.log(`pine          ${pine.length} setups\n`);

  const TOL = 3 * 60_000;   // 3 minutes
  const usedJ = new Set();
  const pairs = [];
  for (const p of pine) {
    let best = -1, bd = Infinity;
    js.forEach((j, i) => {
      if (usedJ.has(i) || j.d !== p.d) return;
      const dt = Math.abs(j.t - p.t);
      if (dt <= TOL && dt < bd) { bd = dt; best = i; }
    });
    if (best >= 0) { usedJ.add(best); pairs.push([p, js[best], bd]); }
  }

  console.log(`matched       ${pairs.length}`);
  console.log(`pine only     ${pine.length - pairs.length}`);
  console.log(`js only       ${js.length - pairs.length}\n`);

  if (pairs.length) {
    console.log('=== agreement on the ladder, for matched setups ===');
    console.log('  time              dir   entry(py/js)        anchor(py/js)       zero(py/js)');
    let exact = 0;
    for (const [p, j, dt] of pairs) {
      const de = Math.abs(p.entryPx - j.entryPx), da = Math.abs(p.anchorC - j.anchorCraig);
      const dz = Math.abs(p.zero - (j.entryPx - 0.382 * j.anchorCraig) / 0.618);
      if (de <= 0.01 && da <= 0.01) exact++;
      const flag = (de <= 0.01 && da <= 0.01) ? '  ' : ' *';
      console.log(`${flag}${iso(p.t)}  ${p.d === 1 ? 'L' : 'S'}   ${p.entryPx.toFixed(2)}/${j.entryPx.toFixed(2)}  ${de <= 0.01 ? ' ' : '!'}   ${p.anchorC.toFixed(2)}/${j.anchorCraig.toFixed(2)}  ${da <= 0.01 ? ' ' : '!'}   ${p.zero.toFixed(3)}/${((j.entryPx - 0.382 * j.anchorCraig) / 0.618).toFixed(3)}`);
    }
    console.log(`\n  ladder agrees to <=1 tick on ${exact}/${pairs.length} matched setups`);
  }

  const unmatchedP = pine.filter(p => !pairs.some(x => x[0] === p));
  const unmatchedJ = js.filter((j, i) => !usedJ.has(i));
  if (unmatchedP.length) {
    console.log('\n=== pine only (js did not fire) ===');
    unmatchedP.forEach(p => console.log(`  ${iso(p.t)}  ${p.d === 1 ? 'L' : 'S'}  entry ${p.entryPx}  anchor ${p.anchorC}`));
  }
  if (unmatchedJ.length) {
    console.log('\n=== js only (pine did not fire) ===');
    unmatchedJ.forEach(j => console.log(`  ${iso(j.t)}  ${j.d === 1 ? 'L' : 'S'}  entry ${j.entryPx}  anchor ${j.anchorCraig}`));
  }
})();
