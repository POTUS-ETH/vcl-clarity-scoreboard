// Does each logged Entry Time land on a bar that ACTUALLY TRADED the logged entry price?
//
// This is the cheapest possible check and it catches the worst failure mode. Anchoring by
// timestamp is exact — but only if the timestamp is right. Feed it a minute that is off by
// ten and it still returns a bar, still simulates forward, still prints a confident result:
// a complete reconstruction of a trade that never happened. Nothing downstream can tell
// that apart from a real one.
//
// The entry price is an independent witness to the timestamp. Craig read the clock off the
// chart and typed it; he read the fill price off the same chart and typed that too. If the
// bar at that minute never traded that price, one of the two is wrong and the row must not
// be scored until it's settled. Where the true bar is unambiguous nearby, this says so —
// but it never silently relocates the trade. A near-miss on a 1m chart is normal (the fill
// may sit a bar either side of the minute the operator noted), so the search widens by
// degrees and reports the distance rather than passing or failing on an exact hit.
const { load } = require('./bars');
const { barIndexForEntryTime, CHART_TZ } = require('./verify');
const { enteredTimestamps } = require('./derive');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503',33:'3bd7e54146b5801db3bbd1181437ffd6',34:'3bd7e54146b580cf9601ec38c2e498bc',35:'3bd7e54146b5808dace3d96dde3470fc'};

const touched = (b, p) => b.l <= p && p <= b.h;
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);
const ny = ms => new Date(ms - 4 * 3600e3).toISOString().slice(11, 16);

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const { entered } = enteredTimestamps(j.trades, bars);
  const ok = new Set(entered.map(t => t.id));

  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
                     .filter(r => r.t).sort((a, b) => a.n - b.n);

  const exact = [], near = [], bad = [], skipped = [];

  for (const { n, t } of rows) {
    if (!t.entryTime || !ok.has(t.id)) { skipped.push(n); continue; }
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) { bad.push({ n, t, why: 'no bar at that minute' }); continue; }

    if (touched(bars[i], t.entry)) { exact.push({ n, t, i }); continue; }

    // widen: how far away is the nearest bar that DID trade the entry price?
    let best = null;
    for (let d = 1; d <= 45; d++) {
      for (const k of [i - d, i + d]) {
        if (k < 0 || k >= bars.length) continue;
        if (new Date(bars[k].t).toISOString().slice(0, 10) !== t.date) continue;
        if (touched(bars[k], t.entry)) { best = { k, d: k - i }; break; }
      }
      if (best) break;
    }
    const rec = { n, t, i, best, gap: +Math.min(Math.abs(bars[i].l - t.entry), Math.abs(bars[i].h - t.entry)).toFixed(2) };
    (best && Math.abs(best.d) <= 3 ? near : bad).push(rec);
  }

  console.log(`=== ENTRY TIME vs ENTRY PRICE (SOLUSDT 1m, times read as ${CHART_TZ}) ===\n`);
  console.log(`  bar traded the logged entry ....... ${exact.length}`);
  console.log(`  within 3 bars ..................... ${near.length}`);
  console.log(`  WRONG — nowhere near ............... ${bad.length}`);
  console.log(`  not yet timestamped ............... ${skipped.length}${skipped.length ? '  (#' + skipped.join(', #') + ')' : ''}\n`);

  const show = (title, list) => {
    if (!list.length) return;
    console.log(`--- ${title} ---`);
    for (const r of list) {
      const b = bars[r.i];
      console.log(`  #${r.n}  ${r.t.date} ${r.t.Session} ${r.t.Direction}   entry ${r.t.entry}`);
      console.log(`     logged ${ny(b.t)} NY (${hhmm(b.t)}Z) — that bar traded ${b.l}–${b.h}, ${r.gap} away from entry`);
      if (r.best) {
        const c = bars[r.best.k];
        console.log(`     nearest bar that traded ${r.t.entry}: ${ny(c.t)} NY (${hhmm(c.t)}Z), ${r.best.d > 0 ? '+' : ''}${r.best.d} min — ${c.l}–${c.h}`);
      } else {
        console.log(`     no bar on ${r.t.date} within 45 min traded ${r.t.entry}`);
      }
      console.log('');
    }
  };
  show('WRONG — the reconstruction from this timestamp is fiction', bad);
  show('within 3 bars — probably just the minute noted vs the minute filled', near);
})();
