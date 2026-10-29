// TCLV scorer vectors. You type the two ends of the fib — stop (0) and swing (1); the board
// solves L1 0.17 / entry 0.382 / TP 0.618 / runner 1.272, snaps each to the tick, and 1R is
// the risk of the snapped orders. Vectors use stop 61.8 / swing 161.8 (span 100) on MNQ:
// entry 100.00, L1 78.75 (78.8 snapped), TP 123.50 (123.6 snapped), runner 189.00,
// 1R = 38.20 + 16.95 = 55.15. Run: node verify/tclvscore.test.js
const fs=require('fs'), path=require('path');
const src=fs.readFileSync(process.argv[2]||path.join(__dirname,'..','tclv.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const num=x=>(x===null||x===undefined||x==='')?null:Number(x);
// One eval: TICK and FIB are block-scoped to it, and computeR closes over them.
eval(src.match(/const TICK=\{[^\n]*\n/)[0]+src.match(/const FIB=\{[^\n]*\n/)[0]+src.match(/function computeR\(row\)\{[\s\S]*?\n\}/)[0]);
const oneR=55.15, BH=23.5/oneR, BE=11.75/oneR, L1R=21.25/oneR, RUN=(11.75+44.5)/oneR, SW110=(11.75+5)/oneR;
const L={Direction:'Long',Pair:'MNQ',StopPrice:61.8,Anchor:161.8};
const SH={Direction:'Short',Pair:'MNQ',StopPrice:138.2,Anchor:38.2};   // mirror: entry 100, L1 121.25, TP 76.5, runner 11.0
const cases=[
 ['entry only, TP printed, runner came back to entry',        {...L,MaxRun:130,HitEntry:true},                 {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['entry only, TP printed, swing stop hit at 110',             {...L,MaxRun:130,HitSwingStop:true,SwingLow:110}, {bh:BH,runE:null,runS:SW110}, /runner exit is unknown/],
 ['entry only, both stops hit, swing at 110',                  {...L,MaxRun:130,HitEntry:true,HitSwingStop:true,SwingLow:110}, {bh:BH,runE:BE,runS:SW110}, null],
 ['entry only, ran to 1.272',                                  {...L,MaxRun:189.0},                             {bh:BH,runE:RUN,runS:RUN}, null],
 ['entry only, ran past 1.272, entry stop ticked = came back first', {...L,MaxRun:200,HitEntry:true},           {bh:BH,runE:BE,runS:RUN}, null],
 ['entry only, never reached TP, nothing ticked',              {...L,MaxRun:120},                               {bh:-1,runE:-1,runS:-1}, /never reached 0.618/],
 ['entry only, never reached TP, stopped ticked (still −1R)',  {...L,MaxRun:120,Stopped:true},                  {bh:-1,runE:-1,runS:-1}, /tick L1 Filled too/],
 ['L1 filled, back to entry',                                  {...L,L1Filled:true,MaxRun:105},                 {bh:L1R,runE:L1R,runS:L1R}, null],
 ['L1 filled, stopped',                                        {...L,L1Filled:true,Stopped:true,MaxRun:90},     {bh:-1,runE:-1,runS:-1}, null],
 ['L1 filled, not stopped, max run never back to entry → flagged', {...L,L1Filled:true,MaxRun:95},              {bh:L1R,runE:L1R,runS:L1R}, /never got back to entry/],
 ['TP touched exactly at its snapped price (123.50) counts',   {...L,MaxRun:123.5,HitEntry:true},               {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['one tick short of the snapped TP (123.25) is a miss',       {...L,MaxRun:123.25},                            {bh:-1,runE:-1,runS:-1}, /never reached 0.618/],
 ['swing stop ticked but Swing Low blank',                     {...L,MaxRun:130,HitSwingStop:true},             {bh:BH,runE:null,runS:null}, /Swing Low is blank/],
 ['no Max Run, not stopped → unscored',                        {...L},                                          {bh:null,runE:null,runS:null}, /nothing to score/],
 ['short mirror: TP printed, came back to entry',              {...SH,MaxRun:70,HitEntry:true},                 {bh:BH,runE:BE,runS:null}, /runner exit is unknown/],
 ['short mirror: swing at 90, 1.272 printed → runS at swing',  {...SH,MaxRun:10,HitSwingStop:true,SwingLow:90}, {bh:BH,runE:RUN,runS:SW110}, null],
 ['swing on the wrong side of the stop → unscored',            {...L,Anchor:60,MaxRun:130},                     null, /wrong side/],
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
// Geometry: the snapped ladder on four instruments. SOL is the one where the snap bites.
const geo=[
 ['MNQ span 100',          {Direction:'Long',Pair:'MNQ',StopPrice:61.8,Anchor:161.8},        {entry:100,l1Price:78.75,tp:123.5,t1272:189,oneR:55.15}],
 ['MNQ Notion TEST row',   {Direction:'Long',Pair:'MNQ',StopPrice:31898,Anchor:32090.25},    {entry:31971.5,l1Price:31930.75,tp:32016.75,t1272:32142.5,oneR:106.25}],
 ['MGC span 6.3',          {Direction:'Long',Pair:'MGC',StopPrice:4000,Anchor:4006.3},       {entry:4002.4,l1Price:4001.1,tp:4003.9,t1272:4008,oneR:3.5}],
 ['SOL span 0.50 (snap bites)', {Direction:'Long',Pair:'SOL',StopPrice:190,Anchor:190.5},    {entry:190.2,l1Price:190.08,tp:190.3,t1272:190.64,oneR:0.28}],
];
for(const [name,row,exp] of geo){
  const g=computeR({...row,MaxRun:row.Anchor}); const bad=[];
  for(const k of Object.keys(exp)) if(g[k]==null||Math.abs(g[k]-exp[k])>1e-6) bad.push(`${k}: got ${g[k]}, expected ${exp[k]}`);
  console.log((bad.length?'FAIL ':'ok   ')+'geometry '+name+(bad.length?'':`  → base hit ${g.r.bh.toFixed(4)}R`)); if(bad.length){fails++; bad.forEach(b=>console.log('    '+b));}
}
console.log('     nominal R marks: TP '+((0.618-0.382)/0.552).toFixed(4)+' · swing '+((1-0.382)/0.552).toFixed(4)+' · 1.272 '+((1.272-0.382)/0.552).toFixed(4));
console.log(fails?`\n${fails} FAILING`:'\nall vectors pass');
process.exit(fails?1:0);
