// The stop-touch boundary: does a wick that reaches the SL to the exact tick end the trade?
//
// This is not a rounding detail — it decides whole outcomes. #20 is the proof: the 18:09Z
// bar's low is 74.39 and the logged SL is 74.39. Read inclusively the trade is a full -1R
// loss; read strictly it survives, runs to 74.81, clears 1.618 and exits on the PVS trail.
// Same row, same tape, opposite result, one tick apart.
//
// Craig's log says it survived. That is evidence about what the SL column MEANS: it is the
// fib-0 level he drew, not the price his stop order sat at — real stops go a few ticks
// beyond the level so a wick to it doesn't lift them. Which reading is right is Craig's
// call, not mine, so this measures the blast radius instead of quietly picking one.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');
const { enteredTimestamps } = require('./derive');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503',33:'3bd7e54146b5801db3bbd1181437ffd6',34:'3bd7e54146b580cf9601ec38c2e498bc',35:'3bd7e54146b5808dace3d96dde3470fc'};

const dirOf = t => t.Direction === 'Long' ? 1 : -1;

/** Simulate with the stop touch read either inclusively or strictly. */
function run(t, bars, i, strict, buffer = 0) {
  const d = dirOf(t);
  const sl = t.sl - d * buffer;            // buffer pushes the stop BEYOND the fib level
  let mfe = t.entry, l1 = false, cleared = false;
  for (let k = i; k < bars.length && k - i <= 720; k++) {
    const b = bars[k];
    const stop = cleared ? t.entry : sl;
    const reach = d === 1 ? b.l : b.h;
    const out = strict ? d * (reach - stop) < 0 : d * (reach - stop) <= 0;
    if (t.l1 != null && !l1 && b.l <= t.l1 && t.l1 <= b.h) l1 = true;
    const fav = d === 1 ? b.h : b.l;
    if (d * (fav - mfe) > 0) mfe = fav;
    if (t.anchor != null && d * (fav - t.anchor) >= 0) cleared = true;
    if (out) return { mfe: +mfe.toFixed(4), l1, cleared, exitIdx: k, reason: 'stop' };
  }
  return { mfe: +mfe.toFixed(4), l1, cleared, exitIdx: null, reason: 'timeout' };
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const { entered } = enteredTimestamps(j.trades, bars);
  const ok = new Set(entered.map(t => t.id));

  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && r.t.entryTime && ok.has(r.t.id) && r.t.Timeframe === '1m')
    .sort((a, b) => a.n - b.n);

  console.log('=== THE STOP-TOUCH TICK ===\n');
  console.log('Comparing each row against what Craig LOGGED (Max Run, L1 Filled, Moved-to-BE).\n');

  const tally = { incl: 0, strict: 0 };
  const flips = [];

  for (const { n, t } of rows) {
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    const d = dirOf(t);
    const A = run(t, bars, i, false);   // inclusive: touching the level ends it
    const B = run(t, bars, i, true);    // strict: must trade THROUGH the level

    // agreement is judged on the FLAGS the log implies, not on Max Run's magnitude
    const impliedCleared = t.anchor != null && d * (t.maxRun - t.anchor) >= 0;
    const agree = s => s.cleared === impliedCleared && s.l1 === !!t.L1Filled;
    if (agree(A)) tally.incl++;
    if (agree(B)) tally.strict++;

    if (agree(A) !== agree(B)) {
      // find the bar that touched the level to the tick
      let tickBar = null;
      for (let k = i; k <= (A.exitIdx ?? i); k++) {
        const reach = d === 1 ? bars[k].l : bars[k].h;
        if (Math.abs(reach - t.sl) < 1e-9) { tickBar = k; break; }
      }
      flips.push({ n, t, A, B, tickBar, impliedCleared });
    }
  }

  console.log(`  rows compared ......................... ${rows.length}`);
  console.log(`  agree with the log — INCLUSIVE (<=) ... ${tally.incl}`);
  console.log(`  agree with the log — STRICT (<) ....... ${tally.strict}\n`);

  if (flips.length) {
    console.log('--- rows whose outcome turns on this single tick ---\n');
    for (const f of flips) {
      const b = f.tickBar != null ? bars[f.tickBar] : null;
      console.log(`  #${f.n}  ${f.t.date} ${f.t.Session} ${f.t.Direction}   SL ${f.t.sl}   logged Max Run ${f.t.maxRun}`);
      if (b) console.log(`     ${new Date(b.t).toISOString().slice(11,16)}Z touched the SL to the tick: o${b.o} h${b.h} l${b.l} c${b.c}`);
      console.log(`     inclusive -> stopped, Max Run ${f.A.mfe}, cleared-anchor ${f.A.cleared}`);
      console.log(`     strict    -> survived, Max Run ${f.B.mfe}, cleared-anchor ${f.B.cleared}`);
      console.log(`     Craig logged Max Run ${f.t.maxRun} (implies cleared-anchor ${f.impliedCleared}) -> ${f.B.mfe === f.t.maxRun ? 'STRICT reproduces it exactly' : f.A.mfe === f.t.maxRun ? 'INCLUSIVE reproduces it exactly' : 'neither reproduces it'}\n`);
    }
  }
})();
