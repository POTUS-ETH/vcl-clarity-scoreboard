// Print, in full mechanical detail, what the detector actually did on a handful of setups
// — so Craig can look at where it goes wrong rather than at a match-rate number.
const { load } = require('./bars');
const { barIndexForEntryTime } = require('./verify');
const D = require('./detect_lib');
const ny = ms => new Date(ms - 4*3600e3).toISOString().slice(5,16).replace('T',' ');
(async () => {
  const m1 = await load('SOLUSDT','1','2026-08-01T00:00:00Z','2026-08-09T00:00:00Z');
  const j = await (await fetch('https://vcl-clarity-scoreboard.potus-eth.workers.dev/?view=v3-craig&t='+Date.now())).json();
  const logged = j.trades.filter(t=>t.entryTime&&t.entry!=null).map(t=>{
    const {i}=barIndexForEntryTime(t.entryTime,t.date,m1);
    return {t,i,d:t.Direction==='Long'?1:-1};}).filter(x=>x.i>=0);
  const htf5 = D.roll(m1,5);
  const all = [...D.detect(m1,htf5,1,0,30), ...D.detect(m1,htf5,-1,0,30)].sort((a,b)=>a.entryIdx-b.entryIdx);
  const pick = all.slice(0,5);
  const out = [];
  pick.forEach((s,n) => {
    const near = logged.filter(L=>Math.abs(L.i-s.entryIdx)<=90)
                       .sort((a,b)=>Math.abs(a.i-s.entryIdx)-Math.abs(b.i-s.entryIdx))[0];
    const zero = (s.entryPx - 0.382*s.anchorCraig)/0.618;
    console.log(`\n--- setup ${n+1}  ${s.d===1?'LONG':'SHORT'}  (5m FVG) ---`);
    console.log(`  FVG zone            ${s.z.near.toFixed(2)} .. ${s.z.far.toFixed(2)}   mid ${s.z.mid.toFixed(3)}   size ${(s.z.size*100).toFixed(1)}c   formed ${ny(s.z.validAt)}`);
    console.log(`  reaction extreme    ${(s.d===1?m1[s.reactIdx].l:m1[s.reactIdx].h).toFixed(2)}  at ${ny(m1[s.reactIdx].t)}   <- I anchor the AVWAP here`);
    console.log(`  BoS level I used    ${s.level.toFixed(2)}  (my 5-bar pivot)`);
    console.log(`  BoS candle          ${ny(m1[s.bosIdx].t)}  close ${m1[s.bosIdx].c.toFixed(2)}  high ${m1[s.bosIdx].h.toFixed(2)}`);
    console.log(`  fib 1 (BoS high)    ${s.anchorCraig.toFixed(2)}       post-BoS extreme ${s.anchorSOP.toFixed(2)}`);
    console.log(`  entry (AVWAP+1t)    ${s.entryPx.toFixed(2)}  at ${ny(m1[s.entryIdx].t)}   -> solved 0 = ${zero.toFixed(2)}`);
    console.log(`  reaction volume     ${s.volRatio}x the 30-bar median`);
    console.log(`  nearest logged      ${near ? `#? ${near.t.Direction} entry ${near.t.entry} at ${ny(m1[near.i].t)}  (${near.i-s.entryIdx} min away, anchor ${near.t.anchor}, SL ${near.t.sl})` : 'none within 90 min'}`);
    const a = Math.max(0,s.reactIdx-25), b = Math.min(m1.length-1,s.entryIdx+15);
    out.push({n:n+1, dir:s.d, zone:[+s.z.near.toFixed(2),+s.z.far.toFixed(2)], mid:+s.z.mid.toFixed(3),
      react:s.reactIdx-a, bos:s.bosIdx-a, entry:s.entryIdx-a, level:+s.level.toFixed(2),
      fib1:s.anchorCraig, entryPx:s.entryPx, zero:+zero.toFixed(2),
      loggedIdx: near && Math.abs(near.i-s.entryIdx)<=90 ? near.i-a : null,
      loggedEntry: near?near.t.entry:null, loggedAnchor: near?near.t.anchor:null,
      t0: ny(m1[a].t),
      bars: m1.slice(a,b+1).map(x=>[+x.o.toFixed(2),+x.h.toFixed(2),+x.l.toFixed(2),+x.c.toFixed(2)])});
  });
  require('fs').writeFileSync('/private/tmp/claude-501/-Users-patrickstorey-Documents-Paladin-Paladin-Obsidian-PaladinV0/ab670618-d262-493f-9c39-acce87c5401c/scratchpad/five.json', JSON.stringify(out));
  console.log('\n(chart data written)');
})();
