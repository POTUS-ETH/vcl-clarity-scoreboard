// The fib is SOLVED, not drawn.
//
// Craig: the 1-of-fib is pinned to structure, the entry is placed one tick beyond the
// selected AVWAP — ABOVE it on a long, BELOW it on a short — and the 0 is then whatever
// it has to be for the entry to land on 0.382 of the 0->1 range.
//
//     zero = (entry - 0.382 * anchor) / 0.618
//
// The solve is direction-agnostic because it is linear: on a short the anchor sits below
// the entry and the arithmetic carries the sign for free. That is worth checking rather
// than assuming, so results are reported split by direction — a rule that only worked on
// longs would be a rule I had fitted to the majority class without noticing.
//
// If this holds, five of the six levels are arithmetic and the geometry has exactly two
// discretionary inputs: the structural anchor and the AVWAP selection.
const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503'};

const TICK = 0.01;                       // SOLUSDT perp tick size, from instruments-info
const solveZero = (entry, anchor) => (entry - 0.382 * anchor) / 0.618;
const levelAt   = (zero, anchor, f) => zero + f * (anchor - zero);

(async () => {
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && r.t.entry != null && r.t.anchor != null && r.t.sl != null)
    .sort((a, b) => a.n - b.n);

  const by = { Long: [], Short: [] };
  const forced = { 'L1 (0.17)': [], '1.618': [], '2.272': [] };
  const worst = [];

  for (const { n, t } of rows) {
    const z = solveZero(t.entry, t.anchor);
    const err = Math.abs(z - t.sl);
    by[t.Direction].push(err);
    worst.push({ n, dir: t.Direction, err, z, sl: t.sl });
    // with 0 and 1 pinned every remaining level is forced — check them too
    if (t.l1    != null) forced['L1 (0.17)'].push(Math.abs(levelAt(t.sl, t.anchor, 0.17)  - t.l1));
    if (t.t1618 != null) forced['1.618']    .push(Math.abs(levelAt(t.sl, t.anchor, 1.618) - t.t1618));
    if (t.t2272 != null) forced['2.272']    .push(Math.abs(levelAt(t.sl, t.anchor, 2.272) - t.t2272));
  }

  const stat = a => ({ n: a.length,
                       tick: a.filter(v => v <= TICK * 1.5).length,
                       mean: a.reduce((x, y) => x + y, 0) / a.length,
                       max: Math.max(...a) });

  console.log('=== zero = (entry - 0.382*anchor) / 0.618 ===\n');
  console.log('  direction   rows   within 1 tick   mean abs err   worst');
  for (const d of ['Long', 'Short']) {
    const s = stat(by[d]);
    console.log(`  ${d.padEnd(11)} ${String(s.n).padStart(4)}   ${String(s.tick + '/' + s.n).padStart(13)}   ${s.mean.toFixed(4).padStart(12)}   ${s.max.toFixed(4)}`);
  }
  const all = stat([...by.Long, ...by.Short]);
  console.log(`  ${'ALL'.padEnd(11)} ${String(all.n).padStart(4)}   ${String(all.tick + '/' + all.n).padStart(13)}   ${all.mean.toFixed(4).padStart(12)}   ${all.max.toFixed(4)}`);

  console.log('\n=== and with 0 and 1 pinned, the remaining levels are forced ===\n');
  for (const [k, a] of Object.entries(forced)) {
    const s = stat(a);
    console.log(`  ${k.padEnd(12)} within 1 tick ${String(s.tick + '/' + s.n).padStart(6)}   mean abs ${s.mean.toFixed(4)}   worst ${s.max.toFixed(4)}`);
  }

  // A mean error near half a tick is the signature of rounding a computed number to 2dp.
  // A mean error well above that would mean the level was chosen, not calculated.
  const verdict = all.mean <= TICK * 0.75 && all.tick === all.n;
  console.log(`\n  ${verdict ? 'HOLDS' : 'DOES NOT HOLD'} — mean error ${all.mean.toFixed(4)} against a tick of ${TICK}.`);
  console.log(`  ${verdict ? 'That is two-decimal rounding of a computed level, not a judgement call.' : 'Errors exceed rounding; the 0 is not simply solved from entry and anchor.'}`);
  const bad = worst.sort((a, b) => b.err - a.err).slice(0, 3);
  console.log(`\n  largest deviations: ${bad.map(b => `#${b.n} ${b.dir} solved ${b.z.toFixed(3)} vs logged ${b.sl} (${b.err.toFixed(3)})`).join('  |  ')}`);
})();
