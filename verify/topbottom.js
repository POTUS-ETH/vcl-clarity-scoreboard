// What separates Craig's best trades from his worst?
//
// He asked for the top ten and the bottom ten, to infer what works. The honest framing
// matters more than the numbers: with 32 trades, ten per group, and a dozen features
// measured, SOMETHING will always look like it separates them. Ten coin flips split by
// ten random features produces apparent signal every time.
//
// So this reports effect sizes and group counts plainly and refuses to rank features by
// how cleanly they split. A feature is worth acting on only if the gap is large, the
// direction makes mechanical sense, and it survives being stated as a rule someone could
// have applied beforehand. Everything here is a lead to test on more data, not a finding.
const { load } = require('./bars');
const V = require('./vcl');
const { barIndexForEntryTime } = require('./verify');

const K = (o, n) => { const k = Object.keys(o).find(x => x.split(' · ')[0] === n);
                      const v = o[k]; return (v == null || v === '') ? null : +v; };
// one score per trade per methodology, dispatched by whether L1 actually filled
const pick = (t, solo, lad) => K(t.o || {}, t.L1Filled ? lad : solo);
const METH = [['BE 1.618','O1','O2'], ['BE 2.272','O4','O5'],
              ['PVS 1.618','O13','O14'], ['PVS 2.272','O16','O17']];

(async () => {
  const m1 = await load('SOLUSDT', '1', '2026-07-20T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const b60 = V.roll(m1, 60), b15 = V.roll(m1, 15), b5 = V.roll(m1, 5);
  const swL = V.sweeps(m1, 1), swS = V.sweeps(m1, -1);
  const z5 = { 1: V.fvgs(V.roll(m1,5), 1), '-1': V.fvgs(V.roll(m1,5), -1) };
  const z15 = { 1: V.fvgs(V.roll(m1,15), 1), '-1': V.fvgs(V.roll(m1,15), -1) };

  const rows = [];
  for (const t of j.trades) {
    if (!t.entryTime || t.entry == null || t.anchor == null || t.sl == null) continue;
    const { i } = barIndexForEntryTime(t.entryTime, t.date, m1);
    if (i < 0) continue;
    const d = t.Direction === 'Long' ? 1 : -1;
    const scores = METH.map(([, s, l]) => pick(t, s, l)).filter(v => v != null);
    if (!scores.length) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    const sw = (d === 1 ? swL : swS).filter(s => s.i <= i && i - s.i <= 180).slice(-1)[0];
    const inZone = zs => zs[String(d)].some(g => g.validAt <= m1[i].t &&
      (sw ? (d === 1 ? sw.swept <= g.hi + 0.01 && sw.swept >= g.lo - 0.05
                     : sw.swept >= g.lo - 0.01 && sw.swept <= g.hi + 0.05) : false));
    const volAt = sw ? (() => { const w = m1.slice(Math.max(0, sw.i - 30), sw.i + 1).map(b => b.v);
      const med = w.slice().sort((a, b) => a - b)[Math.floor(w.length / 2)];
      return +(m1[sw.i].v / (med || 1)).toFixed(2); })() : null;

    rows.push({
      date: t.date, dir: d, hm: V.nyHM(m1[i].t), sess: t.Session, mean: +mean.toFixed(3),
      byMeth: METH.map(([n, s, l]) => [n, pick(t, s, l)]),
      range: +Math.abs(t.anchor - t.sl).toFixed(2),
      b60: V.bias(b60, m1[i].t), b15: V.bias(b15, m1[i].t), b5: V.bias(b5, m1[i].t),
      swMin: sw ? i - sw.i : null, swVol: volAt,
      fvg5: inZone(z5), fvg15: inZone(z15),
      l1: !!t.L1Filled, tf: t.Timeframe,
      hour: +V.nyHM(m1[i].t).slice(0, 2),
      dow: new Date(m1[i].t - 4*3600e3).getUTCDay(),
    });
  }
  rows.sort((a, b) => b.mean - a.mean);
  const top = rows.slice(0, 10), bot = rows.slice(-10);

  const show = (title, g) => {
    console.log(`\n=== ${title} ===\n`);
    console.log('   date        dir   time   sess     meanR    range  1H  15m 5m  sweep  swVol  FVG5 FVG15 L1');
    for (const r of g) console.log(
      `  ${r.date}  ${(r.dir===1?'L':'S')}    ${r.hm}  ${(r.sess||'').padEnd(7)} ${String(r.mean).padStart(7)}  ${String(r.range).padEnd(6)} ` +
      `${String(r.b60).padStart(2)}  ${String(r.b15).padStart(3)} ${String(r.b5).padStart(2)}  ${String(r.swMin??'-').padStart(4)}m  ${String(r.swVol??'-').padStart(5)}  ` +
      `${r.fvg5?' Y ':' . '} ${r.fvg15?'  Y  ':'  .  '} ${r.l1?'Y':'.'}`);
  };
  show('TOP 10 by mean R across the four methodologies', top);
  show('BOTTOM 10', bot);

  const num = (g, f) => { const v = g.map(f).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : NaN; };
  const cnt = (g, f) => g.filter(f).length;
  console.log('\n\n=== WHAT ACTUALLY SEPARATES THEM ===\n');
  console.log('  feature                       top 10      bottom 10    gap');
  const line = (name, a, b, fmt = x => x.toFixed(2)) =>
    console.log(`  ${name.padEnd(28)} ${fmt(a).padStart(8)}    ${fmt(b).padStart(9)}    ${(a-b>=0?'+':'')+fmt(a-b)}`);
  line('mean R', num(top,r=>r.mean), num(bot,r=>r.mean));
  line('fib range', num(top,r=>r.range), num(bot,r=>r.range));
  line('1H bias agrees (of 10)', cnt(top,r=>r.b60===r.dir), cnt(bot,r=>r.b60===r.dir), x=>String(x));
  line('15m bias AGAINST (of 10)', cnt(top,r=>r.b15===-r.dir), cnt(bot,r=>r.b15===-r.dir), x=>String(x));
  line('15m bias agrees (of 10)', cnt(top,r=>r.b15===r.dir), cnt(bot,r=>r.b15===r.dir), x=>String(x));
  line('5m bias agrees (of 10)', cnt(top,r=>r.b5===r.dir), cnt(bot,r=>r.b5===r.dir), x=>String(x));
  line('minutes sweep to entry', num(top,r=>r.swMin), num(bot,r=>r.swMin));
  line('sweep volume x median', num(top,r=>r.swVol), num(bot,r=>r.swVol));
  line('sweep in a 5m FVG (of 10)', cnt(top,r=>r.fvg5), cnt(bot,r=>r.fvg5), x=>String(x));
  line('sweep in a 15m FVG (of 10)', cnt(top,r=>r.fvg15), cnt(bot,r=>r.fvg15), x=>String(x));
  line('L1 filled (of 10)', cnt(top,r=>r.l1), cnt(bot,r=>r.l1), x=>String(x));
  line('longs (of 10)', cnt(top,r=>r.dir===1), cnt(bot,r=>r.dir===1), x=>String(x));
  line('entry hour (NY)', num(top,r=>r.hour), num(bot,r=>r.hour));
  console.log('\n  Sessions — top:    ' + [...new Set(top.map(r=>r.sess))].map(s=>`${s} ${cnt(top,r=>r.sess===s)}`).join(', '));
  console.log('  Sessions — bottom: ' + [...new Set(bot.map(r=>r.sess))].map(s=>`${s} ${cnt(bot,r=>r.sess===s)}`).join(', '));
  console.log('\n  Ten per group. Any split this small will show separation on something —');
  console.log('  treat every line above as a lead to test on more data, not a result.');
})();
