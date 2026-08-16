// Is the outcome math right?
//
// Two questions that get confused for each other, so they are answered separately:
//
//   A. FORMULA AUDIT — does Notion compute what we think it computes?
//      Rebuild all twelve outcomes from first principles using the inputs Craig LOGGED,
//      and diff against the live formula values. This needs no tape and covers all 32
//      rows including the 15s ones. A disagreement means the formula does something
//      other than what we believe, which is the more dangerous kind of error: every
//      statistic on the board inherits it silently.
//
//   B. INPUT AUDIT — is the formula being fed the truth?
//      Run the SAME model twice, once on Craig's logged flags and once on flags
//      rebuilt from Bybit's tape, and diff the resulting R. This isolates errors in the
//      readings from errors in the arithmetic. Only 1m rows with a verified Entry Time
//      qualify; PVS Price is a hand read with no tape equivalent, so PVS scenarios are
//      compared only where the target paid and the trail never mattered.
//
// THE MODEL, stated explicitly so it can be argued with:
//   1R = (Entry - SL) + (L1 - SL) — the full two-fill risk, ALWAYS the denominator,
//   whether or not L1 filled. That is the law: R measures risk taken against the risk
//   the structure puts up, and the fill is the market's decision, not the trader's.
//   The NUMERATOR, though, is only the fills that actually happened — a trade where L1
//   never filled and then stopped out lost (SL-Entry), which is less than 1R. Losing
//   less because the second order never filled is a real outcome, not a bookkeeping
//   trick, and forcing it to -1R would overstate every entry-only loss.
const { load } = require('./bars');
const { barIndexForEntryTime, simulate } = require('./verify');
const { enteredTimestamps } = require('./derive');

const NUM = {1:'3b87e54146b580d0a320fffb77d95b40',2:'3b87e54146b5800aac62f0b464812d18',3:'3b87e54146b5805c87ecd7eea75f6a28',4:'3b87e54146b5808e9259c2a27fe8adb2',5:'3b87e54146b5803f8bf6fe1940676b22',6:'3b87e54146b580a1b93ac4fe7a8d8256',7:'3b87e54146b58025acc6cd3af11215bb',8:'3b87e54146b5806d86bce959c8e7667b',9:'3b87e54146b5809d88d1c99367fa1563',10:'3b87e54146b58026aaffcaf56c6c66f5',11:'3b87e54146b58032b0bfe9820538a103',12:'3b87e54146b580459af9e110f643d205',13:'3b87e54146b580c88541d2cc3e0abe30',14:'3b87e54146b5802791c3fd049318798d',15:'3b87e54146b5806bbb5cf0f3a0004282',16:'3b87e54146b5802db4c7ecb4a88d8e13',17:'3b87e54146b5805186b4c012bc407a35',18:'3b87e54146b580ee9b6fcc714593160a',19:'3b87e54146b58017bccff50cfccb0c79',20:'3b87e54146b5809bb231f7600e390481',21:'3b87e54146b58087a277ec5401008230',22:'3b97e54146b58013b2b5f1fafbe7fc41',23:'3b97e54146b5807ba2f0c7970ddc1cf9',24:'3b97e54146b580669023e67da12923c4',25:'3b97e54146b5800899e5fa9446dd1730',26:'3b97e54146b5804bbc63f235d82de141',27:'3bc7e54146b580868325d5d87b87a6f5',28:'3bc7e54146b58087b51cd2a57344a20d',29:'3bc7e54146b58003934cfc2c9601c5a1',30:'3bc7e54146b580649073cdc3d1648539',31:'3bc7e54146b580149855e7826d2ca79d',32:'3bc7e54146b580bcbaaae787f3c9a503',33:'3bd7e54146b5801db3bbd1181437ffd6',34:'3bd7e54146b580cf9601ec38c2e498bc',35:'3bd7e54146b5808dace3d96dde3470fc'};

const dirOf = t => t.Direction === 'Long' ? 1 : -1;
const at = (t, n) => { const k = Object.keys(t.o || {}).find(x => x.split(' · ')[0] === n);
                       const v = (t.o || {})[k]; return (v == null || v === '') ? null : +v; };

/**
 * Score one methodology on one trade.
 * `facts` supplies the three things a scenario resolves against — did the anchor clear,
 * did the target pay, and where did the trail let go — so the SAME arithmetic can be
 * driven by Craig's readings or by the tape.
 */
function score(t, { cleared, paid, trailExit }, { partial, l1Filled }) {
  // Risk and P&L are both DIRECTIONAL. On a short the stop sits above entry, so an
  // undirected (entry - sl) comes out negative and silently disqualifies every short.
  const d = dirOf(t);
  const R = d * ((t.entry - t.sl) + (t.l1 - t.sl));
  if (!(R > 0)) return null;
  const legs = l1Filled ? [t.entry, t.l1] : [t.entry];
  const pnl = px => legs.reduce((a, e) => a + d * (px - e), 0);

  // Never cleared the anchor: the original stop takes it, and no partial was ever
  // available — the anchor IS the partial gate.
  if (!cleared) return pnl(t.sl) / R;

  const exit = paid.hit ? paid.px : trailExit;
  if (exit == null) return null;
  // BREAK-EVEN IS NOT THE ENTRY PRICE. When both orders fill, the position's break-even
  // is the blended average of the two, so a stop "at break even" returns exactly zero —
  // not the small profit you'd book by closing a two-leg position at the entry leg's
  // price. Putting the stop at `entry` instead credits every BE-stopped two-fill trade
  // with the L1 leg's gain, which would have flattered BE·2.272 on three rows here.
  const pnlAt = px => px === 'BE' ? 0 : pnl(px);
  if (!partial) return pnlAt(exit) / R;
  // half off at the anchor, the remainder rides to whatever ended the trade
  return (pnl(t.anchor) / 2 + pnlAt(exit) / 2) / R;
}

/** The twelve columns, as (id, methodology, target, partial). */
const COLS = [
  ['O1','BE',1618,false], ['O2','BE',1618,false], ['O3','BE',1618,true],
  ['O4','BE',2272,false], ['O5','BE',2272,false], ['O6','BE',2272,true],
  ['O13','PVS',1618,false],['O14','PVS',1618,false],['O15','PVS',1618,true],
  ['O16','PVS',2272,false],['O17','PVS',2272,false],['O18','PVS',2272,true],
];
// O1/O4/O13/O16 are the entry-only columns; O2/O5/O14/O17 the entry+L1 ones; the
// partial columns serve both and are dispatched by the row's own L1 Filled.
const ENTRY_ONLY = new Set(['O1','O4','O13','O16']);
const WITH_L1    = new Set(['O2','O5','O14','O17']);

function expected(t, col, meth, tgtName, partial, facts) {
  const l1 = !!t.L1Filled;
  if (ENTRY_ONLY.has(col) && l1) return null;   // not this row's column
  if (WITH_L1.has(col) && !l1) return null;
  const T = tgtName === 1618 ? t.t1618 : t.t2272;
  if (T == null || t.anchor == null) return null;
  const d = dirOf(t);
  const hit = meth === 'BE' ? facts.reachedBE(T) : facts.reachedPVS(tgtName);
  return score(t, { cleared: facts.cleared, paid: { hit, px: T },
                    trailExit: meth === 'BE' ? 'BE' : t.pvsPrice },
               { partial, l1Filled: l1 });
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const byId = {}; j.trades.forEach(t => byId[t.id.replace(/-/g, '')] = t);
  const { entered } = enteredTimestamps(j.trades, bars);
  const verifiable = new Set(entered.filter(t => t.Timeframe === '1m').map(t => t.id));
  const rows = Object.entries(NUM).map(([n, id]) => ({ n: +n, t: byId[id] }))
    .filter(r => r.t).sort((a, b) => a.n - b.n);

  // ---------- A. FORMULA AUDIT ----------
  // A cell only matters if the board READS it. tradeR() picks the entry-only column when
  // L1 did not fill, the Entry+L1 column when it did, and always the single partial
  // column — so a value sitting in the column that was NOT dispatched is inert. Inert is
  // not the same as harmless (anyone averaging that column directly gets a wrong number)
  // but it is the difference between a cosmetic defect and a corrupted statistic, so the
  // two are counted apart rather than pooled into one alarming total.
  const dispatched = (col, l1) => WITH_L1.has(col) ? l1 : ENTRY_ONLY.has(col) ? !l1 : true;

  let cells = 0, bad = 0, stray = 0, missing = 0;
  const faults = [], strays = [];
  for (const { n, t } of rows) {
    const d = dirOf(t);
    const beyond = (a, b) => a != null && b != null && d * (a - b) >= 0;
    const facts = {
      cleared: beyond(t.maxRun, t.anchor),
      reachedBE: T => beyond(t.maxRun, T),
      reachedPVS: name => name === 1618 ? !!t.pvsHit1 : !!t.pvsHit2,
    };
    const l1 = !!t.L1Filled;
    for (const [col, meth, tgt, partial] of COLS) {
      const live = at(t, col);
      if (!dispatched(col, l1)) {
        // the column this row does not occupy — it must be empty
        if (live != null) { stray++;
          // what WOULD that column hold if it were computed honestly for this row?
          const honest = score(t, { cleared: facts.cleared,
              paid: { hit: meth === 'BE' ? facts.reachedBE(tgt === 1618 ? t.t1618 : t.t2272) : facts.reachedPVS(tgt), px: tgt === 1618 ? t.t1618 : t.t2272 },
              trailExit: meth === 'BE' ? 'BE' : t.pvsPrice }, { partial, l1Filled: false });
          strays.push(`  #${n} ${col}  holds ${live.toFixed(3)} on an L1-filled row` +
                      (honest != null ? `  (an honest entry-only figure would be ${honest.toFixed(3)})` : ''));
        }
        continue;
      }
      const mine = expected(t, col, meth, tgt, partial, facts);
      if (mine == null && live == null) continue;
      cells++;
      if (mine == null || live == null) { missing++;
        faults.push(`  #${n} ${col}  mine ${mine == null ? 'blank' : mine.toFixed(3)}  vs Notion ${live == null ? 'blank' : live.toFixed(3)}`);
        continue; }
      if (Math.abs(mine - live) > 0.005) { bad++;
        faults.push(`  #${n} ${col}  mine ${mine.toFixed(3)}  vs Notion ${live.toFixed(3)}  (diff ${(mine - live).toFixed(3)})`); }
    }
  }
  console.log('=== A. FORMULA AUDIT — my model vs Notion, on Craig\'s own logged inputs ===\n');
  console.log('  -- cells the board actually reads (these decide every statistic) --');
  console.log(`  compared              : ${cells}`);
  console.log(`  value mismatches      : ${bad}`);
  console.log(`  blank/filled mismatch : ${missing}`);
  if (faults.length) console.log('\n' + faults.join('\n'));
  else console.log('\n  Every dispatched cell reproduces from first principles.');
  console.log(`\n  -- cells in the column the row does NOT occupy (never read by the board) --`);
  console.log(`  populated when they should be empty : ${stray}`);
  if (strays.length) {
    console.log('\n' + strays.slice(0, 8).join('\n'));
    if (strays.length > 8) console.log(`  …${strays.length - 8} more, same shape`);
  }

  // ---------- B. INPUT AUDIT ----------
  console.log('\n\n=== B. INPUT AUDIT — same arithmetic, Craig\'s readings vs Bybit tape ===\n');
  let comp = 0, diff = 0, skipped = 0;
  const drift = [];
  for (const { n, t } of rows) {
    if (!verifiable.has(t.id)) { skipped++; continue; }
    const d = dirOf(t);
    const beyond = (a, b) => a != null && b != null && d * (a - b) >= 0;
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    const s = simulate(t, bars, i);
    const logged = { cleared: beyond(t.maxRun, t.anchor), reachedBE: T => beyond(t.maxRun, T),
                     reachedPVS: nm => nm === 1618 ? !!t.pvsHit1 : !!t.pvsHit2 };
    const taped  = { cleared: s.clearedAnchor, reachedBE: T => beyond(s.mfe, T),
                     reachedPVS: nm => nm === 1618 ? s.hit1618 : s.hit2272 };
    for (const [col, meth, tgt, partial] of COLS) {
      // L1 Filled decides which column a row occupies; use the tape's answer for the
      // tape run so a wrong flag shows up as a dispatch difference, not silence.
      const a = expected(t, col, meth, tgt, partial, logged);
      const b = expected({ ...t, L1Filled: s.l1Filled }, col, meth, tgt, partial, taped);
      if (a == null && b == null) continue;
      comp++;
      const av = a == null ? 'blank' : a.toFixed(3), bv = b == null ? 'blank' : b.toFixed(3);
      if (av !== bv && !(a != null && b != null && Math.abs(a - b) <= 0.005)) {
        diff++; drift.push(`  #${n} ${col}  from log ${av}  from tape ${bv}`);
      }
    }
  }
  console.log(`  rows verifiable (1m, real Entry Time) : ${rows.length - skipped} of ${rows.length}`);
  console.log(`  scored cells compared                : ${comp}`);
  console.log(`  cells where the readings change the R: ${diff}`);
  if (drift.length) console.log('\n' + drift.join('\n'));
  else console.log('\n  Every scored cell survives replacing Craig\'s readings with the tape.');
})();
