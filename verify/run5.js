// Craig's crypto VCL, run under his stated constraints:
//   fib range >= 0.25 in PRICE (not percent), weekdays only, London or NY sessions.
// The midpoint rule is run BOTH ways because he hasn't ruled: judged on 1m closes as I
// first built it, and judged on the HTF candle close, which is my suspicion — the FVG is
// a 5m/15m read and the 1m is only execution, so a 1m poke through a 4-tick midpoint
// should not invalidate a zone the 5m never closed through.
const { load } = require('./bars');
const typical = b => (b.h + b.l + b.c) / 3;
const nyH = ms => new Date(ms - 4*3600e3).getUTCHours();
const nyD = ms => new Date(ms - 4*3600e3).getUTCDay();
const nyStr = ms => new Date(ms - 4*3600e3).toISOString().slice(0,16).replace('T',' ');

function roll(bars, m) {
  if (m === 1) return bars;
  const out = [], step = m*60_000; let cur = null;
  for (const b of bars) { const k = Math.floor(b.t/step)*step;
    if (!cur || cur.t !== k) { cur = {t:k,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}; out.push(cur); }
    else { cur.h=Math.max(cur.h,b.h); cur.l=Math.min(cur.l,b.l); cur.c=b.c; cur.v+=b.v; } }
  return out;
}
function fvgs(bars, d) {
  const out = [];
  for (let i=1;i<bars.length-1;i++){ const a=bars[i-1], c=bars[i+1];
    if (d===1 ? c.l>a.h : c.h<a.l) { const near=d===1?a.h:a.l, far=d===1?c.l:c.h;
      out.push({near,far,mid:(near+far)/2,validAt:c.t,size:Math.abs(far-near)}); } }
  return out;
}
function priorPivot(b,i,d,k=2,look=90){
  for(let c=i-k-1;c>=Math.max(k,i-look);c--){ let ok=true;
    for(let x=c-k;x<=c+k&&ok;x++){ if(x===c) continue;
      if(d===1? b[x].h>=b[c].h : b[x].l<=b[c].l) ok=false; }
    if(ok) return d===1?b[c].h:b[c].l; }
  return null;
}
// London 03:00-08:00 NY, New York 08:00-16:00 NY. Weekdays only.
const inSession = ms => { const d=nyD(ms), h=nyH(ms);
  return d>=1 && d<=5 && h>=3 && h<16; };

function detect(m1, htf, d, midOnHTF, minRange=0.25, reactWin=30) {
  const out=[];
  for (const z of fvgs(htf,d)) {
    let i0=m1.findIndex(b=>b.t>=z.validAt); if(i0<0) continue;
    let first=-1;
    for(let i=i0;i<Math.min(m1.length,i0+240);i++)
      if(d===1? m1[i].l<=z.near : m1[i].h>=z.near){first=i;break;}
    if(first<0) continue;
    // the midpoint test, on whichever close Craig means
    const closedThrough = i => {
      if (!midOnHTF) return d===1 ? m1[i].c < z.mid : m1[i].c > z.mid;
      const hb = htf.filter(b => b.t <= m1[i].t).pop();
      return hb ? (d===1 ? hb.c < z.mid : hb.c > z.mid) : false;
    };
    let react=-1, lo=null;
    for(let i=first;i<Math.min(m1.length,first+reactWin);i++){
      if(closedThrough(i)){react=-2;break;}
      const px=d===1?m1[i].l:m1[i].h;
      if(lo==null||d*(px-lo)<0){lo=px;react=i;}}
    if(react<0) continue;
    const level=priorPivot(m1,react,d); if(level==null) continue;
    let bos=-1;
    for(let i=react+1;i<Math.min(m1.length,react+120);i++){
      if(d===1? m1[i].c>level : m1[i].c<level){bos=i;break;}
      if(closedThrough(i)) break; }
    if(bos<0) continue;
    let pv=0,vv=0,entry=-1,entryPx=null,fib1=d===1?m1[bos].h:m1[bos].l;
    for(let i=react;i<Math.min(m1.length,bos+240);i++){
      pv+=typical(m1[i])*m1[i].v; vv+=m1[i].v;
      if(i<=bos) continue;
      const ext=d===1?m1[i].h:m1[i].l;
      if(d*(ext-fib1)>0) fib1=ext;                      // the extreme AFTER the BoS
      const want=pv/vv + d*0.01;
      if(m1[i].l<=want&&want<=m1[i].h){entry=i;entryPx=+want.toFixed(2);break;} }
    if(entry<0) continue;
    if(!inSession(m1[entry].t)) continue;
    const zero=(entryPx-0.382*fib1)/0.618;
    const ordered = d===1 ? (zero<entryPx&&entryPx<fib1) : (fib1<entryPx&&entryPx<zero);
    if(!ordered) continue;
    const range=Math.abs(fib1-zero);
    if(range<minRange) continue;
    const at=f=>zero+f*(fib1-zero);
    out.push({d,react,bos,entry,entryPx,fib1:+fib1.toFixed(2),zero:+zero.toFixed(2),
      L1:+at(0.17).toFixed(2),t1618:+at(1.618).toFixed(2),t2272:+at(2.272).toFixed(2),
      range:+range.toFixed(3), oneR:+(0.552*range).toFixed(4), z, level:+level.toFixed(2),
      t:m1[entry].t});
  }
  return out.sort((a,b)=>a.entry-b.entry).filter((s,i,a)=>i===0||s.entry>a[i-1].entry+5);
}

(async () => {
  const m1 = await load('SOLUSDT','1','2026-07-20T00:00:00Z','2026-08-09T00:00:00Z');
  console.log(`tape: ${m1.length} 1m bars, ${nyStr(m1[0].t)} to ${nyStr(m1[m1.length-1].t)} NY`);
  console.log(`filters: weekdays, London/NY (03:00-16:00 NY), fib range >= 0.25, ladder ordered\n`);
  for (const midOnHTF of [false,true]) {
    console.log(`--- midpoint judged on ${midOnHTF ? 'the HTF candle close' : '1m closes'} ---`);
    for (const M of [5,15]) {
      const htf=roll(m1,M);
      const all=[...detect(m1,htf,1,midOnHTF),...detect(m1,htf,-1,midOnHTF)].sort((a,b)=>a.entry-b.entry);
      console.log(`  ${M}m FVG : ${all.length} setups`);
      if (midOnHTF && M===5) require('fs').writeFileSync(
        '/private/tmp/claude-501/-Users-patrickstorey-Documents-Paladin-Paladin-Obsidian-PaladinV0/ab670618-d262-493f-9c39-acce87c5401c/scratchpad/run5.json',
        JSON.stringify(all.map(s=>{const a=Math.max(0,s.react-25), b=Math.min(m1.length-1,s.entry+20);
          return {...s,
            tReact:m1[s.react].t, tBos:m1[s.bos].t, tEntry:m1[s.entry].t,   // ABSOLUTE, not indices
            iReact:s.react-a, iBos:s.bos-a, iEntry:s.entry-a,               // positions within the slice
            t0:m1[a].t, gaps:(()=>{let g=0;for(let k=a+1;k<=b;k++) if(m1[k].t-m1[k-1].t!==60000)g++;return g;})(),
            bars:m1.slice(a,b+1).map(x=>[+x.o.toFixed(2),+x.h.toFixed(2),+x.l.toFixed(2),+x.c.toFixed(2)])};})));
    }
    console.log('');
  }
})();
