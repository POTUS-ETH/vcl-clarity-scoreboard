// Runs the tape reconstruction against every logged trade and prints a diff.
const { load } = require('./bars');
const { verify } = require('./verify');

const WORKER = 'https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig';

// Craig's Notion "#" column -> page id, so findings are reported in HIS numbering
const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503',33:'3bd7e54146b5801db3bbd1181437ffd6',34:'3bd7e54146b580cf9601ec38c2e498bc',35:'3bd7e54146b5808dace3d96dde3470fc'};

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch(WORKER + '&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const num = {}; Object.entries(NUM).forEach(([n, id]) => { if (byId[id]) num[id] = +n; });

  const only = process.argv[2] ? process.argv.slice(2).map(Number) : null;
  const rows = Object.entries(NUM)
    .map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t && (!only || only.includes(r.n)))
    .sort((a, b) => a.n - b.n);

  const tally = { ok: 0, mismatch: 0, unresolvable: 0, nocand: 0, ambiguous: 0 };
  const findings = [];

  for (const { n, t } of rows) {
    const r = verify(t, bars);
    if (r.status === 'UNRESOLVABLE') { tally.unresolvable++; continue; }
    if (r.status === 'NO-CANDIDATE') {
      tally.nocand++;
      findings.push(`#${n} ${t.date} ${t.Session} ${t.Direction} — NO CANDIDATE: price never traded through entry ${t.entry} in that session`);
      continue;
    }
    const b = r.best;
    const diffs = [];
    // Max Run is NEVER compared as a magnitude. Every formula that touches it does a
    // threshold test (cleared anchor / hit target), so its size beyond the furthest
    // target is immaterial — a peak of 73.33 and one of 74.28 produce identical
    // outcomes. What must agree are the FLAGS it implies, checked below. A raw diff
    // here would manufacture failures out of a definitional ambiguity.
    const dirn = t.Direction === 'Long' ? 1 : -1;
    const impliesCleared = t.anchor != null && dirn * (t.maxRun - t.anchor) >= 0;
    if (impliesCleared !== b.clearedAnchor)
      diffs.push(`cleared-anchor: log implies ${impliesCleared}, tape ${b.clearedAnchor}`);
    if (t.t1618 != null) {
      const impl = dirn * (t.maxRun - t.t1618) >= 0;
      if (impl !== b.hit1618) diffs.push(`reached 1.618: log implies ${impl}, tape ${b.hit1618}`);
    }
    if (t.t2272 != null) {
      const impl = dirn * (t.maxRun - t.t2272) >= 0;
      if (impl !== b.hit2272) diffs.push(`reached 2.272: log implies ${impl}, tape ${b.hit2272}`);
    }
    if (!!t.L1Filled !== b.l1Filled) diffs.push(`L1 Filled logged ${!!t.L1Filled} vs tape ${b.l1Filled}`);
    if (t.retracedToEntry != null && !!t.retracedToEntry !== b.retracedAfterL1)
      diffs.push(`Retraced-to-entry logged ${!!t.retracedToEntry} vs tape ${b.retracedAfterL1}`);
    if (t.movedStopToBE != null && !!t.movedStopToBE !== b.clearedAnchor)
      diffs.push(`Moved-stop-to-BE logged ${!!t.movedStopToBE} vs tape cleared-anchor ${b.clearedAnchor}`);
    if (t.pvsHit1 != null && !!t.pvsHit1 !== b.hit1618)
      diffs.push(`reached 1.618: logged PVS-hit ${!!t.pvsHit1} vs tape ${b.hit1618}`);

    if (r.nClose > 1) tally.ambiguous++;
    if (diffs.length) {
      tally.mismatch++;
      findings.push(`#${n} ${t.date} ${t.Session} ${t.Direction} @${b.entryTime.slice(11,16)}Z` +
                    (r.nClose > 1 ? ` [${r.nClose} candidate windows]` : '') +
                    '\n     ' + diffs.join('\n     '));
    } else tally.ok++;
  }

  console.log('=== TAPE RECONSTRUCTION vs LOG (Bybit SOLUSDT 1m) ===\n');
  console.log(`  matched cleanly : ${tally.ok}`);
  console.log(`  MISMATCHED      : ${tally.mismatch}`);
  console.log(`  no candidate    : ${tally.nocand}`);
  console.log(`  15s unresolvable: ${tally.unresolvable}`);
  console.log(`  ambiguous window: ${tally.ambiguous}\n`);
  findings.forEach(f => console.log('  ' + f + '\n'));
})();
