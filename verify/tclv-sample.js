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
const addMin=(hhmm,m)=>{ const t=(parseInt(hhmm.slice(0,2))*60+parseInt(hhmm.slice(2))+m)%1440; return String(Math.floor(t/60)).padStart(2,'0')+String(t%60).padStart(2,'0'); };
const ri=(a,b)=>a+Math.floor(rnd()*(b-a+1));
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
    const E=fib(0.382), T=fib(1.272);
    const u=rnd(); const row={id:'s'+(++n), n, Trade:`${pair} ${dir} ${date}`, date, Trader:(tf==='15s'||rnd()<0.15)?'POTUS':'Gonza', Session:session, Pair:pair, Direction:dir, Timeframe:tf,
      Timezone:'Berlin (CET/CEST)', EntryTime:hhmm, StopPrice:S, Anchor:A, MaxRun:null, ExitPrice:null,
      L1Filled:false, EmaAligned:rnd()<0.6, TpTime:null, BackTime:null, ExitTime:null, Notes:''};
    if(u<0.24){ const stopped=rnd()<0.42; row.L1Filled=rnd()<0.8; row.MaxRun=stopped?fib(0.25):fib(0.382+rnd()*0.1); row.ExitPrice=stopped?(rnd()<0.3?snap(S-sgn*tick,tick):S):E; row.ExitTime=addMin(hhmm,ri(3,28)); }
    else if(u<0.40){ row.MaxRun=fib(0.50+rnd()*0.09); row.ExitPrice=rnd()<0.7?S:fib(0.40+rnd()*0.09); row.ExitTime=addMin(hhmm,ri(2,22)); }   // never TP: the stop (L1 read off the exit) or an early close under the max run
    else if(u<0.64){ row.MaxRun=fib(0.62+rnd()*0.55); const tp=ri(2,12); row.TpTime=addMin(hhmm,tp); if(rnd()<0.7) row.BackTime=addMin(hhmm,tp+ri(2,15)); row.ExitPrice=rnd()<0.5?E:fib(0.30+rnd()*0.07); row.ExitTime=addMin(hhmm,tp+ri(5,35)); }   // back to entry, or out at the swing
    else if(u<0.86){ row.MaxRun=fib(1.272+rnd()*0.9); const tp=ri(2,12), t12=tp+ri(3,30); row.TpTime=addMin(hhmm,tp); if(rnd()<0.3) row.BackTime=addMin(hhmm,tp+ri(1,Math.max(1,t12-tp-1))); row.ExitPrice=rnd()<0.6?T:fib(1.1+rnd()*0.17); row.ExitTime=addMin(hhmm,t12+ri(0,20)); }  // 1.272 printed; a trailed exit stays under the max run
    else { row.MaxRun=fib(0.7+rnd()*0.5); const tp=ri(2,12); row.TpTime=addMin(hhmm,tp); row.ExitPrice=fib(0.45+rnd()*0.2); row.ExitTime=addMin(hhmm,tp+ri(5,45)); }   // trailed out above entry
    rows.push(row);
  }
}
// two rows the board should flag
rows.push({id:'s'+(++n), n, Trade:'MNQ Long bad swing', date:'2026-10-27', Trader:'POTUS', Session:'London', Pair:'MNQ', Direction:'Long', Timeframe:'15s', Timezone:'Berlin (CET/CEST)', EntryTime:'0930', StopPrice:25410, Anchor:25380, MaxRun:25450, ExitPrice:25440, L1Filled:false, EmaAligned:true, TpTime:null, BackTime:null, ExitTime:'0950', Notes:'swing typed on the wrong side'});
rows.push({id:'s'+(++n), n, Trade:'MES Short exit past max run', date:'2026-10-27', Trader:'POTUS', Session:'NY AM', Pair:'MES', Direction:'Short', Timeframe:'15s', Timezone:'Berlin (CET/CEST)', EntryTime:'1500', StopPrice:6856.25, Anchor:6843.75, MaxRun:6845, ExitPrice:6840, L1Filled:false, EmaAligned:false, TpTime:'1506', BackTime:null, ExitTime:'1520', Notes:'exit beyond max run'});
fs.writeFileSync(path.join(__dirname,'tclv-sample.json'), JSON.stringify({trades:rows, tests:[], source:'sample', generated:'2026-10-29'}, null, 1));
console.log(rows.length,'sample trades → verify/tclv-sample.json');
