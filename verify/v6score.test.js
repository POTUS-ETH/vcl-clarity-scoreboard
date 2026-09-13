// V6 scorer vectors. Prices are POTUS's three-fib screenshot (MNQ 15s, 2026-09-13):
// entry 30298.75, stop 30250.00, 1R = 48.75, so XR sits at fib X+1. The third case is the
// one the structure-stop model exists to make visible — hit 1R, reverse, stop at the
// original level — and the case the inherited "stopped => everything -1R" short-circuit
// got wrong. Run: node verify/v6score.test.js
const fs=require('fs');
const src=fs.readFileSync(process.argv[2]||require("path").join(__dirname,"..","v6-obvs.html"),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const num=x=>(x===null||x===undefined||x==='')?null:Number(x);
eval(src.match(/function computeR\(row\)\{[\s\S]*?\n\}/)[0]);
// POTUS's Full-TP fib, MNQ 15s 2026-09-13: entry 30298.75, stop 30250 → 1R = 48.75
const L={Direction:'Long',Pair:'MNQ',EntryPrice:30298.75,StopPrice:30250};
const at=R=>30298.75+R*48.75;
const cases=[
 ['ran to 5R exactly, trailed out at 4.128R', {...L,MaxRun:at(5),TrailStop:30500},
   {f1:1,f2:2,f3:3,f4:4,f5:5,a2:2,a3:3,a4:0.5+0.5*4.1282,a5:0.5+0.5*4.1282,b3:3,b4:1+0.5*4.1282,b5:1+0.5*4.1282}],
 ['never reached 1R, stopped at the original stop', {...L,MaxRun:at(0.9),TrailStop:30250},
   {f1:-1,f2:-1,f3:-1,f4:-1,f5:-1,a2:-1,a3:-1,a4:-1,a5:-1,b3:-1,b4:-1,b5:-1}],
 ['HIT 1R, then reversed to the original stop (no BoS)', {...L,MaxRun:at(1),TrailStop:30250},
   {f1:1,f2:-1,f3:-1,f4:-1,f5:-1,a2:0,a3:0,a4:0,a5:0,b3:-1,b4:-1,b5:-1}],
 ['hit 2R, BoS moved stop, trailed out at +0.5R', {...L,MaxRun:at(2),TrailStop:at(0.5)},
   {f1:1,f2:2,f3:0.5,f4:0.5,f5:0.5,a2:0.5+0.25,a3:0.75,a4:0.75,a5:0.75,b3:1+0.25,b4:1.25,b5:1.25}],
 ['ran 9R (fib 10), trailed out at 7R', {...L,MaxRun:at(9),TrailStop:at(7)},
   {f1:1,f2:2,f3:3,f4:4,f5:5,a2:2,a3:3,a4:4,a5:5,b3:3,b4:4,b5:5}],
 ['stop typed on the wrong side → unscored', {...L,StopPrice:30350,MaxRun:at(2),TrailStop:at(1)}, null],
 ['short mirror: hit 1R then stopped', {Direction:'Short',Pair:'MNQ',EntryPrice:30299.25,StopPrice:30347.75,MaxRun:30299.25-48.5,TrailStop:30347.75},
   {f1:1,f2:-1,f3:-1,f4:-1,f5:-1,a2:0,a3:0,a4:0,a5:0,b3:-1,b4:-1,b5:-1}],
];
let fails=0;
for(const [name,row,exp] of cases){
  const out=computeR(row);
  if(exp===null){ const ok=Object.values(out.r).every(v=>v===null)&&out.badStop===true;
    console.log((ok?'ok   ':'FAIL ')+name); if(!ok){fails++;console.log('   ',out.r,out.badStop);} continue; }
  const bad=Object.keys(exp).filter(k=>out.r[k]==null||Math.abs(out.r[k]-exp[k])>1e-3);
  // the stopped flag must agree with the exit: at or through the stop <=> true
  const wantStopped = (row.Direction==='Long'?1:-1)*(row.TrailStop-row.StopPrice) <= 1e-9;
  if(out.stopped!==wantStopped) bad.push('stopped');
  console.log((bad.length?'FAIL ':'ok   ')+name);
  if(bad.length){fails++; bad.forEach(k=>console.log(k==='stopped'?`    stopped: got ${out.stopped}`:`    ${k}: got ${out.r[k]}, expected ${exp[k]}`));}
}
console.log(fails?`\n${fails} FAILING`:'\nall vectors pass');
process.exit(fails?1:0);
