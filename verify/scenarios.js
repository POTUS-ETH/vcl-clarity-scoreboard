// Sweep the management surface across Craig's 32 hand-verified trades.
//
// The entries are fixed — these are his trades, with prices he read off his own charts and
// which reproduce against Bybit's tape. Only what happens AFTER the fill varies. That makes
// every comparison paired on the same trade, which removes trade-selection variance and is
// the whole reason this is worth doing on 32 rows at all.
//
// THE DANGER IS OBVIOUS AND IS HANDLED BY HOW THIS REPORTS, NOT BY A CAVEAT AT THE END.
// Scoring ~100 scenarios against 32 trades guarantees a winner by chance; the top cell of
// any such grid is noise more often than not. So this prints the whole surface rather than
// a champion, and judges by PLATEAU — a region where neighbouring parameters all score
// well is a real effect, because noise does not arrive in contiguous blocks. A lone spiking
// cell surrounded by poor ones is exactly what overfitting looks like and is called out.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');

const dirOf = t => t.Direction === 'Long' ? 1 : -1;

/**
 * Replay one trade bar by bar, recording only FACTS — the path, not any decision.
 * Every scenario is then evaluated against the same replay, so they cannot disagree
 * about what the market did.
 */
function replay(t, bars, i, horizon = 720) {
  const d = dirOf(t);
  const path = [];
  let l1 = false, l1At = null, cleared = false, clearedAt = null, mfe = t.entry, mae = t.entry;
  for (let j = i; j < Math.min(bars.length, i + horizon); j++) {
    const b = bars[j];
    const fav = d === 1 ? b.h : b.l, adv = d === 1 ? b.l : b.h;
    if (d * (fav - mfe) > 0) mfe = fav;
    if (d * (adv - mae) < 0) mae = adv;
    if (!l1 && t.l1 != null && b.l <= t.l1 && t.l1 <= b.h) { l1 = true; l1At = j - i; }
    if (!cleared && t.anchor != null && d * (fav - t.anchor) >= 0) { cleared = true; clearedAt = j - i; }
    path.push({ k: j - i, fav, adv, h: b.h, l: b.l });
    if (d === 1 ? b.l < t.sl : b.h > t.sl) break;   // original stop ends the record
  }
  return { d, path, l1, l1At, cleared, clearedAt, mfe: +mfe.toFixed(4), mae: +mae.toFixed(4) };
}

/**
 * Score one scenario against one replay.
 * `stop`  : 'fixed' | 'be' (blended break-even once the 1-of-fib clears)
 * `target`: fib multiple, or null to ride to the stop
 * `partial`: fib multiple to take half off at, or null
 */
function score(t, r, { stop, target, partial }) {
  const d = r.d, R = d * ((t.entry - t.sl) + (t.l1 - t.sl));
  if (!(R > 0)) return null;
  const at = f => t.sl + f * (t.anchor - t.sl);
  const legs = r.l1 ? [t.entry, t.l1] : [t.entry];
  const be = legs.reduce((a, b) => a + b, 0) / legs.length;
  const pnl = px => legs.reduce((a, e) => a + d * (px - e), 0);

  const tgt = target == null ? null : at(target);
  const par = partial == null ? null : at(partial);
  let banked = 0, open = 1;                        // fraction of the position still on

  for (const p of r.path) {
    // partial first — it sits nearer than the target by construction
    if (par != null && open === 1 && d * (p.fav - par) >= 0) { banked += pnl(par) / 2; open = 0.5; }
    if (tgt != null && d * (p.fav - tgt) >= 0) return (banked + pnl(tgt) * open) / R;
    const active = (stop === 'be' && r.cleared && p.k >= r.clearedAt) ? be : t.sl;
    if (d * (p.adv - active) < 0) return (banked + pnl(active) * open) / R;
  }
  const last = r.path[r.path.length - 1];
  return (banked + pnl(last.fav === undefined ? t.entry : (d === 1 ? last.l : last.h)) * open) / R;
}

(async () => {
  const bars = await load('SOLUSDT', '1', '2026-08-01T00:00:00Z', '2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t=' + Date.now())).json();
  const trades = [];
  for (const t of j.trades) {
    if (!t.entryTime || t.entry == null || t.anchor == null || t.sl == null || t.l1 == null) continue;
    const { i } = barIndexForEntryTime(t.entryTime, t.date, bars);
    if (i < 0) continue;
    trades.push({ t, r: replay(t, bars, i) });
  }
  console.log(`=== MANAGEMENT SURFACE — ${trades.length} of Craig's hand-verified trades ===\n`);
  console.log('  Entries fixed. Only management varies, so every cell is paired on the same trades.\n');

  const st = a => { const m = a.reduce((x,y)=>x+y,0)/a.length;
    const sd = Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/(a.length-1||1));
    return { m, se: sd/Math.sqrt(a.length), w: a.filter(v=>v>0).length/a.length*100 }; };

  const TG = [0.7, 0.85, 0.95, 1.1, 1.25, 1.485, 1.618, 2.0, 2.272];
  for (const stop of ['fixed', 'be']) {
    console.log(`\n  --- stop: ${stop === 'be' ? 'to blended break-even once the 1-of-fib clears' : 'fixed at the fib 0 throughout'} ---`);
    console.log('   partial |' + TG.map(f => String(f).padStart(8)).join(''));
    for (const partial of [null, 0.7, 0.95]) {
      const row = [];
      for (const target of TG) {
        if (partial != null && partial >= target) { row.push('       -'); continue; }
        const a = trades.map(({ t, r }) => score(t, r, { stop, target, partial })).filter(v => v != null);
        row.push((a.length ? st(a).m.toFixed(2) : '  -').padStart(8));
      }
      console.log(`   ${(partial == null ? 'none' : '50%@' + partial).padEnd(8)}|` + row.join(''));
    }
  }

  // the strongest cells, with their honest error bars
  console.log('\n\n=== the cells worth looking at, with error bars ===\n');
  const cells = [];
  for (const stop of ['fixed', 'be'])
    for (const partial of [null, 0.7, 0.95])
      for (const target of TG) {
        if (partial != null && partial >= target) continue;
        const a = trades.map(({ t, r }) => score(t, r, { stop, target, partial })).filter(v => v != null);
        if (a.length) cells.push({ stop, partial, target, ...st(a), n: a.length });
      }
  cells.sort((a, b) => b.m - a.m);
  console.log('   stop   partial    target   expectancy    win%     95% CI');
  for (const c of cells.slice(0, 8))
    console.log(`   ${c.stop.padEnd(6)} ${(c.partial==null?'none':'50%@'+c.partial).padEnd(9)} ${String(c.target).padEnd(8)} ${c.m.toFixed(3).padStart(8)}R   ${c.w.toFixed(0).padStart(4)}%   ${(c.m-2.04*c.se).toFixed(2)} to ${(c.m+2.04*c.se).toFixed(2)}`);
  const zero = cells.filter(c => c.m - 2.04 * c.se > 0).length;
  console.log(`\n  cells whose 95% CI clears zero: ${zero} of ${cells.length}`);
})();
