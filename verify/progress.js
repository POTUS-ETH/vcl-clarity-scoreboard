// Renders a status page for the V5 re-scoring audit, built from real state on disk —
// which dates have cached bars, how each trade classified — so it cannot drift from
// what has actually been done. Regenerate any time: node verify/progress.js
const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, 'cache');
const DATES = ['2026-06-23','2026-06-24','2026-06-25','2026-06-26','2026-06-29',
               '2026-06-30','2026-07-01','2026-07-02','2026-07-13'];

const v3 = JSON.parse(fs.readFileSync('/tmp/v3.json', 'utf8'));
const note = t => (t.Notes || t.notes || '');
const T = v3.trades.filter(t => t.Pair === 'MNQ' && t.Timeframe === '15s'
  && ['EntryPrice','SLPrice','MaxRun','BoSExit'].every(k => t[k] != null) && t.Direction
  && !note(t).toLowerCase().includes('calibrate'));

const barsFor = d => {
  const f = path.join(CACHE, `tv_MNQ_1m_${d}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const SESS = { 'Asia':[22,7], 'London':[7,13.5], 'NY AM':[13.5,16], 'NY PM':[16,20] };
const hourOf = ts => { const d = new Date(ts * 1000); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const inSess = (ts, s) => { const w = SESS[s]; if (!w) return true;
  const h = hourOf(ts); return w[0] < w[1] ? (h >= w[0] && h < w[1]) : (h >= w[0] || h < w[1]); };

// Classify one survivor: 'clear' / 'stopped' / 'split' / 'intra-minute' / 'no-bars'
function classify(t) {
  const dr = t.Direction === 'Long' ? 1 : -1;
  const zero = t.SLPrice, rng = (t.EntryPrice - zero) / 0.382;
  const stop = zero + 0.085 * rng;
  if (dr * (t.BoSExit - zero) <= 1e-9) return { k: 'v3stop', stop };
  const bars = barsFor(t.date);
  if (!bars) return { k: 'no-bars', stop };
  const e = t.EntryPrice, mr = t.MaxRun;
  const touch = [], reach = [];
  bars.forEach((b, i) => {
    if (b.low <= e && e <= b.high) touch.push(i);
    if (dr === 1 ? b.high >= mr : b.low <= mr) reach.push(i);
  });
  if (!touch.length || !reach.length) return { k: 'no-window', stop };
  const inS = touch.filter(i => inSess(bars[i].time, t.Session));
  const iW = (inS.length ? inS : touch)[0];
  const iM = reach.find(i => i > iW) ?? reach[reach.length - 1];
  const iN = Math.max(...touch.filter(i => i <= iM), iW);
  const adv = i0 => { const seg = bars.slice(i0, iM + 1);
    if (!seg.length) return null;
    return dr === -1 ? Math.max(...seg.map(b => b.high)) : Math.min(...seg.map(b => b.low)); };
  const pW = adv(iW), pN = adv(iN);
  if (pW == null || pN == null) return { k: 'no-window', stop };
  const hW = dr === -1 ? pW >= stop : pW <= stop;
  const hN = dr === -1 ? pN >= stop : pN <= stop;
  // the entry bar itself straddling the stop is the case 1m provably cannot order
  const eb = bars[iN];
  const straddle = (dr === -1 ? eb.high >= stop : eb.low <= stop) && eb.low <= e && e <= eb.high;
  if (straddle) return { k: 'intra-minute', stop, pW, pN };
  if (hW === hN) return { k: hW ? 'stopped' : 'clear', stop, pW, pN };
  return { k: 'split', stop, pW, pN };
}

const rows = T.map(t => ({ t, c: classify(t) }));
const count = k => rows.filter(r => r.c.k === k).length;
const cached = DATES.filter(d => barsFor(d));
const byDate = DATES.map(d => {
  const rs = rows.filter(r => r.t.date === d);
  return { d, bars: barsFor(d)?.length || 0, n: rs.length,
           done: rs.filter(r => ['clear','stopped','v3stop'].includes(r.c.k)).length };
});

const S = { v3stop: count('v3stop'), clear: count('clear'), stopped: count('stopped'),
            split: count('split'), intra: count('intra-minute'),
            nobars: count('no-bars') + count('no-window') };
const decided = S.v3stop + S.clear + S.stopped;
const pct = n => (n / rows.length * 100).toFixed(0);

const bar = (label, n, colour) => n === 0 ? '' : `
  <div class="row"><div class="lbl">${label}</div>
    <div class="track"><div class="fill" style="width:${n / rows.length * 100}%;background:${colour}"></div></div>
    <div class="num">${n}</div></div>`;

const html = `<title>V5 Audit Progress</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,'JetBrains Mono',Menlo,monospace;background:#0e1117;color:#e6e8ec;padding:22px;font-size:13px}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:16px;letter-spacing:.5px;margin-bottom:2px}
.sub{font-size:10.5px;color:#8b93a1;margin-bottom:16px}
.card{background:#161b24;border:1px solid #232a36;border-radius:10px;padding:14px;margin-bottom:11px}
.lbl2{font-size:9px;letter-spacing:1.1px;text-transform:uppercase;color:#8b93a1;margin-bottom:9px}
.row{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.lbl{width:210px;font-size:11px;color:#c3c9d4}
.track{flex:1;height:15px;background:#0e1117;border-radius:3px;overflow:hidden}
.fill{height:100%}
.num{width:30px;text-align:right;font-weight:700;font-size:11.5px}
table{width:100%;border-collapse:collapse;font-size:11px}
td,th{padding:5px 7px;border-bottom:1px solid #232a36;text-align:right}
td:first-child,th:first-child{text-align:left}
th{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:#7b8494}
.ok{color:#3fb950}.warn{color:#e0b341}.bad{color:#e66767}.mut{color:#8b93a1}
.big{font-size:26px;font-weight:700}
.note{font-size:10.5px;color:#8b93a1;line-height:1.6;margin-top:9px}
</style>
<div class="wrap">
<h1>VCL V5 RE-SCORING — AUDIT PROGRESS</h1>
<div class="sub">85 MNQ 15s trades · asking of each: would the tighter V5 stop (fib 0.085) have taken it out?</div>

<div class="card">
  <div class="lbl2">Overall</div>
  <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:12px">
    <div class="big ${decided === rows.length ? 'ok' : 'warn'}">${decided}/${rows.length}</div>
    <div class="mut" style="font-size:11px">trades with a settled verdict &nbsp;·&nbsp; ${pct(decided)}%</div>
  </div>
  ${bar('v3 stop-out (−1R either way)', S.v3stop, '#4a5568')}
  ${bar('survived V5 stop — clear', S.clear, '#3fb950')}
  ${bar('stopped by V5 stop', S.stopped, '#e66767')}
  ${bar('split — entry timing decides', S.split, '#e0b341')}
  ${bar('intra-minute — 1m cannot order', S.intra, '#a371f7')}
  ${bar('bars not yet pulled', S.nobars, '#2a3140')}
</div>

<div class="card">
  <div class="lbl2">Bar data — ${cached.length}/${DATES.length} dates cached</div>
  <table>
    <tr><th>date</th><th>1m bars</th><th>trades</th><th>settled</th><th>status</th></tr>
    ${byDate.map(b => `<tr>
      <td>${b.d}</td>
      <td class="${b.bars ? 'mut' : 'bad'}">${b.bars || '—'}</td>
      <td class="mut">${b.n}</td>
      <td>${b.bars ? b.done : '—'}</td>
      <td class="${b.bars ? 'ok' : 'bad'}">${b.bars ? 'cached' : 'pending'}</td></tr>`).join('')}
  </table>
</div>

<div class="card">
  <div class="lbl2">How a verdict is reached</div>
  <div class="note">
  Each survivor is tested under two entry definitions — the earliest plausible (first 0.382 touch in
  session) and the latest (last 0.382 touch before max run). <b>Where both agree the verdict is safe.</b>
  Where they disagree the answer depends on exactly when the fill happened, and only the chart decides.<br><br>
  A separate case is flagged when the entry bar <i>itself</i> straddles the stop: the fill and a move
  through the stop occur inside the same minute, and 1m bars cannot order two events within one bar.
  Those are <b>not resolvable from this data at all</b> — 15s history stops ~30 days back, and these
  trades are older. They are reported, never guessed.
  </div>
</div>
</div>`;

fs.writeFileSync(path.join(__dirname, 'progress.html'), html);
console.log(`decided ${decided}/${rows.length}  ·  clear ${S.clear}  stopped ${S.stopped}  split ${S.split}  intra-minute ${S.intra}  pending-bars ${S.nobars}`);
console.log(`dates cached: ${cached.length}/${DATES.length}`);
