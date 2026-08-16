// What does "Retraced to Entry" actually mean?
//
// I assumed it meant "after L1 filled, price came back UP to entry". #11 kills that
// reading: its Max Run of 73.97 is above an entry of 73.90, so price plainly came back
// up, yet Craig logged false. So the column means something else, and rather than pick a
// second guess this scores every candidate reading against all 32 rows of ground truth.
//
// The honest risk here is fitting: six definitions against 32 rows will always produce a
// winner. A reading only counts as identified if it wins by a wide margin AND the losers
// fail in ways that make sense. A narrow win is noise and is reported as such.
//
// This column is currently INERT for scoring — the 50%-off gate moved from "price
// returns to entry" to "price hits the 1 of the fib" — so nothing downstream depends on
// the answer. It is worth settling only because the log should mean what it says.
const { load } = require('./bars');
const { barIndexForEntryTime, simulate } = require('./verify');
const { enteredTimestamps } = require('./derive');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503',33:'3bd7e54146b5801db3bbd1181437ffd6',34:'3bd7e54146b580cf9601ec38c2e498bc',35:'3bd7e54146b5808dace3d96dde3470fc'};

const dirOf = t => t.Direction === 'Long' ? 1 : -1;

/** Walk the trade's life once, evaluating every candidate reading in parallel. */
function readings(t, bars, i, endIdx) {
  const d = dirOf(t);
  const out = {
    'up-to-entry after L1 (strict)': false,
    'up-to-entry after L1 (touch)': false,
    'back DOWN to entry after moving in favour (strict)': false,
    'back DOWN to entry after moving in favour (touch)': false,
    'back to entry after clearing the anchor': false,
    'back DOWN to entry after reaching L1-or-better': false,
  };
  let l1Idx = null, moved = false, cleared = false;
  for (let k = i; k <= endIdx && k < bars.length; k++) {
    const b = bars[k];
    const fav = d === 1 ? b.h : b.l;
    const adv = d === 1 ? b.l : b.h;

    if (l1Idx !== null && k > l1Idx) {
      if (d * (fav - t.entry) > 0) out['up-to-entry after L1 (strict)'] = true;
      if (d * (fav - t.entry) >= 0) out['up-to-entry after L1 (touch)'] = true;
    }
    if (moved) {
      if (d * (adv - t.entry) < 0) out['back DOWN to entry after moving in favour (strict)'] = true;
      if (d * (adv - t.entry) <= 0) out['back DOWN to entry after moving in favour (touch)'] = true;
    }
    if (cleared && d * (adv - t.entry) <= 0) out['back to entry after clearing the anchor'] = true;
    if (l1Idx !== null && k > l1Idx && d * (adv - t.entry) <= 0)
      out['back DOWN to entry after reaching L1-or-better'] = true;

    if (t.l1 != null && l1Idx === null && b.l <= t.l1 && t.l1 <= b.h) l1Idx = k;
    if (d * (fav - t.entry) > 0) moved = true;
    if (t.anchor != null && d * (fav - t.anchor) > 0) cleared = true;
  }
  return out;
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const { entered } = enteredTimestamps(j.trades, bars);
  const ok = new Set(entered.map(t => t.id));

  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && ok.has(r.t.id) && r.t.retracedToEntry != null && r.t.Timeframe === '1m')
    .sort((a, b) => a.n - b.n);

  const score = {}, misses = {};
  for (const { n, t } of rows) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    const s = simulate(t, bars, i);
    const endIdx = bars.findIndex(b => b.t === Date.parse(s.exitTime));
    const r = readings(t, bars, i, endIdx < 0 ? Math.min(i + 720, bars.length - 1) : endIdx);
    for (const [name, val] of Object.entries(r)) {
      score[name] = (score[name] || 0) + (val === !!t.retracedToEntry ? 1 : 0);
      if (val !== !!t.retracedToEntry) (misses[name] = misses[name] || []).push(n);
    }
  }

  console.log(`=== "Retraced to Entry" — candidate readings vs ${rows.length} logged rows ===\n`);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  for (const [name, s] of ranked) {
    console.log(`  ${String(s).padStart(2)}/${rows.length}  ${name}`);
    if (misses[name]) console.log(`         misses: #${misses[name].join(', #')}`);
  }
  const [best, bs] = ranked[0], [, second] = ranked[1];
  console.log(`\n  best beats runner-up by ${bs - second} row(s) — ` +
    (bs - second >= 3 ? 'wide enough to call it identified.'
                      : 'NOT a wide enough margin to claim the reading is identified.'));
})();
