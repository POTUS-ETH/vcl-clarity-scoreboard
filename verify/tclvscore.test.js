// TCLV scorer vectors. One fib, two fills: stop 0, L1 0.17, entry 0.382, anchor 1, TP 0.618,
// runner 1.272. 1R = 0.552 of the fib on every trade. The vectors use entry 100 / anchor
// 161.8 so the fib span is exactly 100: stop 61.8, L1 78.8, TP 123.6, 1.272 at 189.0, 1R 55.2.
// Run: node verify/tclvscore.test.js
const fs=require('fs'), path=require('path');
const src=fs.readFileSync(process.argv[2]||path.join(__dirname,'..','tclv.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const num=x=>(x===null||x===undefined||x==='')?null:Number(x);
// One eval: TICK and FIB are block-scoped to it, and computeR closes over them.
eval(src.match(/const TICK=\{[^\n]*\n/)[0]+src.match(/const FIB=\{[^\n]*\n/)[0]+src.match(/function computeR\(row\)\{[\s\S]*?\n\}/)[0]);
const R=x=>x/0.552, BH=R(0.236), BE=R(0.118), RUN=R(0.118+0.445), L1=R(0.212);
const L={Direction:'Long',Pair:'MNQ',EntryPrice:100,Anchor:161.8};
const cases=[
 ['entry only, TP printed, runner came back to entry',        {...L,MaxRun:130,HitEntry:true},                 {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['entry only, TP printed, swing stop hit at 110 (fib 0.482)', {...L,MaxRun:130,HitSwingStop:true,SwingLow:110}, {bh:BH,runE:null,runS:R(0.118+0.5*(0.482-0.382))}, /runner exit is unknown/],
 ['entry only, both stops hit, swing at 110',                  {...L,MaxRun:130,HitEntry:true,HitSwingStop:true,SwingLow:110}, {bh:BH,runE:BE,runS:R(0.118+0.05)}, null],
 ['entry only, ran to 1.272',                                  {...L,MaxRun:189.0},                             {bh:BH,runE:RUN,runS:RUN}, null],
 ['entry only, ran past 1.272, entry stop ticked = came back first', {...L,MaxRun:200,HitEntry:true},           {bh:BH,runE:BE,runS:RUN}, null],
 ['entry only, never reached TP, nothing ticked',              {...L,MaxRun:120},                               {bh:-1,runE:-1,runS:-1}, /never printed TP|never reached 0.618/],
 ['entry only, never reached TP, stopped ticked (contradiction, still a loss)', {...L,MaxRun:120,Stopped:true}, {bh:-1,runE:-1,runS:-1}, /tick L1 Filled too/],
 ['L1 filled, back to entry',                                  {...L,L1Filled:true,MaxRun:105},                 {bh:L1,runE:L1,runS:L1}, null],
 ['L1 filled, stopped',                                        {...L,L1Filled:true,Stopped:true,MaxRun:90},     {bh:-1,runE:-1,runS:-1}, null],
 ['L1 filled, not stopped, max run never back to entry → flagged', {...L,L1Filled:true,MaxRun:95},              {bh:L1,runE:L1,runS:L1}, /never got back to entry/],
 ['TP within half a tick counts (MNQ 0.25 → 123.475)',         {...L,MaxRun:123.5,HitEntry:true},               {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['TP missed by more than half a tick (123.4)',                {...L,MaxRun:123.4},                             {bh:-1,runE:-1,runS:-1}, /never printed TP|never reached 0.618/],
 ['swing stop ticked but Swing Low blank',                     {...L,MaxRun:130,HitSwingStop:true},             {bh:BH,runE:null,runS:null}, /Swing Low is blank/],
 ['no Max Run, not stopped → unscored',                        {...L},                                          {bh:null,runE:null,runS:null}, /nothing to score/],
 ['short mirror: TP printed, came back to entry',              {Direction:'Short',Pair:'MNQ',EntryPrice:100,Anchor:38.2,MaxRun:70,HitEntry:true}, {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['short mirror: swing at 90 (fib 0.482), 1.272 printed → runS at swing', {Direction:'Short',Pair:'MNQ',EntryPrice:100,Anchor:38.2,MaxRun:10,HitSwingStop:true,SwingLow:90}, {bh:BH,runE:RUN,runS:R(0.118+0.05)}, null],
 ['anchor on the wrong side → unscored',                       {...L,Anchor:60,MaxRun:130},                     null, /wrong side/],
];
let fails=0;
for(const [name,row,exp,why] of cases){
  const out=computeR(row); const bad=[];
  if(exp===null){ if(!Object.values(out.r).every(v=>v===null)||out.badAnchor!==true) bad.push('expected unscored, got '+JSON.stringify(out.r)); }
  else for(const k of Object.keys(exp)){
    const g=out.r[k], e=exp[k];
    if(e===null){ if(g!==null) bad.push(`${k}: got ${g}, expected null`); }
    else if(g==null||Math.abs(g-e)>1e-6) bad.push(`${k}: got ${g}, expected ${e.toFixed(4)}`); }
  const said=out.why||out.note||'';
  if(why && !why.test(said)) bad.push(`why/note: got "${said}", expected ${why}`);
  if(!why && exp!==null && out.why) bad.push(`unexpected hard flag: "${out.why}"`);
  console.log((bad.length?'FAIL ':'ok   ')+name); if(bad.length){fails++; bad.forEach(b=>console.log('    '+b));}
}
// geometry on the Notion TEST row (MNQ): entry 31971.5, anchor 32090.25
const g=computeR({Direction:'Long',Pair:'MNQ',EntryPrice:31971.5,Anchor:32090.25,MaxRun:32080.5});
const geo=[['stop',g.stop,31898.098],['L1',g.l1Price,31930.764],['TP',g.tp,32016.848],['1R',g.oneR,106.068]];
for(const [k,v,e] of geo){ const ok=Math.abs(v-e)<0.01; console.log((ok?'ok   ':'FAIL ')+`geometry ${k} = ${v.toFixed(3)}`); if(!ok){fails++; console.log(`    expected ${e}`);} }
console.log('     R marks: TP '+((0.618-0.382)/0.552).toFixed(4)+'R · anchor '+((1-0.382)/0.552).toFixed(4)+'R · 1.272 '+((1.272-0.382)/0.552).toFixed(4)+'R');
console.log(fails?`\n${fails} FAILING`:'\nall vectors pass');
process.exit(fails?1:0);
