// TCLV scorer vectors. Four typed prices: stop (fib 0), swing (fib 1), Max Run, Exit. The board
// solves L1 0.17 / entry 0.382 / TP 0.618 / runner 1.272, snaps each to the tick, and 1R is the
// risk of the snapped orders. Vectors use stop 61.8 / swing 161.8 (span 100) on MNQ: entry
// 100.00, L1 78.75, TP 123.50, runner 189.00, 1R = 38.20 + 16.95 = 55.15.
// Run: node verify/tclvscore.test.js
const fs=require('fs'), path=require('path');
const src=fs.readFileSync(process.argv[2]||path.join(__dirname,'..','tclv.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const num=x=>(x===null||x===undefined||x==='')?null:Number(x);
eval(src.match(/const TICK=\{[^\n]*\n/)[0]+src.match(/const FIB=\{[^\n]*\n/)[0]+src.match(/function computeR\(row\)\{[\s\S]*?\n\}/)[0]);
const oneR=55.15, BH=23.5/oneR, BE=11.75/oneR, L1R=21.25/oneR, RUN=(11.75+44.5)/oneR;
const L={Direction:'Long',Pair:'MNQ',StopPrice:61.8,Anchor:161.8};
const SH={Direction:'Short',Pair:'MNQ',StopPrice:138.2,Anchor:38.2};   // mirror: entry 100, L1 121.25, TP 76.5, runner 11.0
const cases=[
 // name, row, expected {bh,runE,runS}, expected exitR (as traded), why/note regex (null = no flag expected)
 ['TP printed, runner came back to entry (exit 100)',            {...L,MaxRun:130,ExitPrice:100,HitEntry:true},  {bh:BH,runE:BE,runS:BE}, BE, null],
 ['TP printed, exit at the swing (90), entry box unticked',       {...L,MaxRun:130,ExitPrice:90},                 {bh:BH,runE:BE,runS:(11.75-5)/oneR}, (11.75-5)/oneR, /came back after the partial/],
 ['1.272 printed, exit at the target',                            {...L,MaxRun:189,ExitPrice:189},                {bh:BH,runE:RUN,runS:RUN}, RUN, null],
 ['1.272 printed, trailed out higher (195), came back to entry first', {...L,MaxRun:200,ExitPrice:195,HitEntry:true}, {bh:BH,runE:BE,runS:RUN}, (11.75+47.5)/oneR, null],
 ['no 1.272, trailed out at 140',                                 {...L,MaxRun:150,ExitPrice:140},                {bh:BH,runE:(11.75+20)/oneR,runS:(11.75+20)/oneR}, (11.75+20)/oneR, null],
 ['never reached TP, exit at the stop → L1 inferred, −1R',       {...L,MaxRun:120,ExitPrice:61.8},               {bh:-1,runE:-1,runS:-1}, -1, /L1 must have filled/],
 ['never reached TP, manual close at 110',                        {...L,MaxRun:120,ExitPrice:110},                {bh:10/oneR,runE:10/oneR,runS:10/oneR}, 10/oneR, /closed before 0.618/],
 ['never reached TP, no exit → stop-out',                         {...L,MaxRun:120},                              {bh:-1,runE:-1,runS:-1}, null, /never reached 0.618/],
 ['L1 filled, closed back at entry',                              {...L,L1Filled:true,MaxRun:105,ExitPrice:100},  {bh:L1R,runE:L1R,runS:L1R}, L1R, null],
 ['L1 filled, stopped at 61.8',                                   {...L,L1Filled:true,MaxRun:90,ExitPrice:61.8},  {bh:-1,runE:-1,runS:-1}, -1, null],
 ['L1 filled, slipped a tick through the stop (61.55)',           {...L,L1Filled:true,MaxRun:90,ExitPrice:61.55}, {bh:(-38.45-17.2)/oneR,runE:(-38.45-17.2)/oneR,runS:(-38.45-17.2)/oneR}, (-38.45-17.2)/oneR, null],
 ['L1 filled, no exit → flagged',                                 {...L,L1Filled:true,MaxRun:105},                {bh:null,runE:null,runS:null}, null, /no exit price/],
 ['TP printed, no exit, no box → runners unknown',                {...L,MaxRun:130},                              {bh:BH,runE:null,runS:null}, null, /runner exits are unknown/],
 ['TP printed, no exit, entry box ticked',                        {...L,MaxRun:130,HitEntry:true},                {bh:BH,runE:BE,runS:null}, null, /runner exits are unknown/],
 ['TP touched exactly at its snapped price (123.50), exit 100',   {...L,MaxRun:123.5,ExitPrice:100},              {bh:BH,runE:BE,runS:BE}, BE, /came back after the partial/],
 ['one tick short of the snapped TP (123.25), closed at 110',     {...L,MaxRun:123.25,ExitPrice:110},             {bh:10/oneR,runE:10/oneR,runS:10/oneR}, 10/oneR, /closed before 0.618/],
 ['exit beyond Max Run → flagged',                                {...L,MaxRun:130,ExitPrice:140},                {bh:BH,runE:(11.75+20)/oneR,runS:(11.75+20)/oneR}, (11.75+20)/oneR, /beyond Max Run/],
 ['no Max Run, no exit → unscored',                               {...L},                                         {bh:null,runE:null,runS:null}, null, /nothing to score/],
 ['short mirror: TP printed, back to entry',                      {...SH,MaxRun:70,ExitPrice:100,HitEntry:true},  {bh:BH,runE:BE,runS:BE}, BE, null],
 ['short mirror: exit at the swing above entry (110)',            {...SH,MaxRun:70,ExitPrice:110},                {bh:BH,runE:BE,runS:(11.75-5)/oneR}, (11.75-5)/oneR, /came back after the partial/],
 ['short mirror: 1.272 printed, exit at 11',                      {...SH,MaxRun:11,ExitPrice:11},                 {bh:BH,runE:RUN,runS:RUN}, RUN, null],
 ['swing on the wrong side of the stop → unscored',               {...L,Anchor:60,MaxRun:130,ExitPrice:100},      null, null, /wrong side/],
];
let fails=0;
for(const [name,row,exp,exitR,why] of cases){
  const out=computeR(row); const bad=[];
  if(exp===null){ if(!Object.values(out.r).every(v=>v===null)||out.badAnchor!==true) bad.push('expected unscored, got '+JSON.stringify(out.r)); }
  else for(const k of Object.keys(exp)){
    const g=out.r[k], e=exp[k];
    if(e===null){ if(g!==null) bad.push(`${k}: got ${g}, expected null`); }
    else if(g==null||Math.abs(g-e)>1e-6) bad.push(`${k}: got ${g}, expected ${e.toFixed(4)}`); }
  if(exp!==null){ const g=out.exitR??null; if(exitR===null){ if(g!==null) bad.push(`exitR: got ${g}, expected null`); } else if(g==null||Math.abs(g-exitR)>1e-6) bad.push(`exitR: got ${g}, expected ${exitR.toFixed(4)}`); }
  const said=out.why||out.note||'';
  if(why && !why.test(said)) bad.push(`why/note: got "${said}", expected ${why}`);
  if(!why && exp!==null && (out.why||out.note)) bad.push(`unexpected flag/note: "${said}"`);
  console.log((bad.length?'FAIL ':'ok   ')+name); if(bad.length){fails++; bad.forEach(b=>console.log('    '+b));}
}
// Geometry: the snapped ladder on four instruments. SOL is the one where the snap bites.
const geo=[
 ['MNQ span 100',          {Direction:'Long',Pair:'MNQ',StopPrice:61.8,Anchor:161.8},        {entry:100,l1Price:78.75,tp:123.5,t1272:189,oneR:55.15}],
 ['MNQ typed on the grid', {Direction:'Long',Pair:'MNQ',StopPrice:31898,Anchor:32090.25},    {entry:31971.5,l1Price:31930.75,tp:32016.75,t1272:32142.5,oneR:106.25}],
 ['MGC span 6.3',          {Direction:'Long',Pair:'MGC',StopPrice:4000,Anchor:4006.3},       {entry:4002.4,l1Price:4001.1,tp:4003.9,t1272:4008,oneR:3.5}],
 ['SOL span 0.50 (snap bites)', {Direction:'Long',Pair:'SOL',StopPrice:190,Anchor:190.5},    {entry:190.2,l1Price:190.08,tp:190.3,t1272:190.64,oneR:0.28}],
];
for(const [name,row,exp] of geo){
  const g=computeR({...row,MaxRun:row.Anchor,ExitPrice:row.Anchor}); const bad=[];
  for(const k of Object.keys(exp)) if(g[k]==null||Math.abs(g[k]-exp[k])>1e-6) bad.push(`${k}: got ${g[k]}, expected ${exp[k]}`);
  console.log((bad.length?'FAIL ':'ok   ')+'geometry '+name+(bad.length?'':`  → base hit ${g.r.bh.toFixed(4)}R`)); if(bad.length){fails++; bad.forEach(b=>console.log('    '+b));}
}
console.log(fails?`\n${fails} FAILING`:'\nall vectors pass');
process.exit(fails?1:0);
