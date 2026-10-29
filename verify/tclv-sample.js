// Deterministic sample payload in the worker's tclv shape, for previewing the board before
// the Notion integration is connected: node verify/tclv-sample.js → verify/tclv-sample.json,
// then open tclv.html?src=verify/tclv-sample.json. Numbers are invented; the SHAPE is real.
const fs=require('fs'), path=require('path');
let seed=20261029; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/2**32; };
const pick=a=>a[Math.floor(rnd()*a.length)];
const PX={MNQ:[25400,0.25,'15s'],MES:[6850,0.25,'15s'],MGC:[4010,0.1,'15s'],MYM:[47200,1,'15s'],BTC:[110500,0.02,'1m'],ETH:[3920,0.02,'1m'],SOL:[192,0.02,'1m']};
const SESS=[['Asia',[1,3]],['London',[9,11]],['NY AM',[14.5,16.5]],['NY PM',[18,21]]];
const dates=[]; for(let d=12; d<=28; d++){ const dt=new Date(Date.UTC(2026,9,d)); if(dt.getUTCDay()%6) dates.push(`2026-10-${String(d).padStart(2,'0')}`); }
const snap=(v,t)=>+(Math.round(v/t)*t).toFixed(6);
const rows=[]; let n=0;
for(const date of dates){
  const k=2+Math.floor(rnd()*3);
  for(let i=0;i<k;i++){
    const pair=pick(Object.keys(PX)), [base,tick,tf]=PX[pair];
    const [session,[h0,h1]]=pick(SESS);
    const hh=h0+rnd()*(h1-h0) - (rnd()<0.12?0.4:0);
    const hhmm=String(Math.floor(hh)).padStart(2,'0')+String(Math.floor((hh%1)*60)).padStart(2,'0');
    const dir=rnd()<0.55?'Long':'Short', sgn=dir==='Long'?1:-1;
    const S=snap(base*(1+(rnd()-0.5)*0.01),tick);                       // the stop: fib 0, typed
    const span=snap(base*(0.0012+rnd()*0.0025),tick);                   // fib span, ~0.12–0.37% of price
    const A=snap(S+sgn*span,tick), fib=x=>snap(S+sgn*x*span,tick);       // the swing: fib 1, typed
    const u=rnd(); const row={id:'s'+(++n), n, Trade:`${pair} ${dir} ${date}`, date, Session:session, Pair:pair, Direction:dir, Timeframe:tf, Trader:(tf==='15s'||rnd()<0.15)?'POTUS':'Gonza',
      Timezone:'Berlin (CET/CEST)', EntryTime:hhmm, StopPrice:S, Anchor:A, MaxRun:null, SwingLow:null,
      L1Filled:false, HitEntry:false, HitSwingStop:false, EmaAligned:rnd()<0.6, Stopped:false, Notes:''};
    if(u<0.24){ row.L1Filled=true; row.Stopped=rnd()<0.42; row.MaxRun=row.Stopped?fib(0.25):fib(0.382+rnd()*0.1); }
    else if(u<0.42){ row.MaxRun=fib(0.42+rnd()*0.17); }
    else if(u<0.66){ row.MaxRun=fib(0.62+rnd()*0.55); row.HitEntry=true; if(rnd()<0.5){ row.HitSwingStop=true; row.SwingLow=fib(0.30+rnd()*0.25); } }
    else if(u<0.88){ row.MaxRun=fib(1.272+rnd()*0.9); if(rnd()<0.3) row.HitEntry=true; }
    else { row.MaxRun=fib(0.7+rnd()*0.5); row.HitSwingStop=true; row.SwingLow=fib(0.45+rnd()*0.12); }
    rows.push(row);
  }
}
// two rows the board should flag
rows.push({id:'s'+(++n), n, Trade:'MNQ Long bad swing', date:'2026-10-27', Session:'London', Pair:'MNQ', Direction:'Long', Timeframe:'15s', Trader:'POTUS', Timezone:'Berlin (CET/CEST)', EntryTime:'0930', StopPrice:25410, Anchor:25380, MaxRun:25450, SwingLow:null, L1Filled:false, HitEntry:false, HitSwingStop:false, EmaAligned:true, Stopped:false, Notes:'swing typed on the wrong side'});
rows.push({id:'s'+(++n), n, Trade:'MES Short swing blank', date:'2026-10-27', Session:'NY AM', Pair:'MES', Direction:'Short', Timeframe:'15s', Trader:'POTUS', Timezone:'Berlin (CET/CEST)', EntryTime:'1500', StopPrice:6856.25, Anchor:6843.75, MaxRun:6845, SwingLow:null, L1Filled:false, HitEntry:false, HitSwingStop:true, EmaAligned:false, Stopped:false, Notes:'swing ticked, no price'});
fs.writeFileSync(path.join(__dirname,'tclv-sample.json'), JSON.stringify({trades:rows, tests:[], source:'sample', generated:'2026-10-29'}, null, 1));
console.log(rows.length,'sample trades → verify/tclv-sample.json');
