// Local release binaries, frozen public vectors, sequential AB/BA runs.
// No network, wallet, funded signer, or broadcast path is reachable.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const [beforeArg,afterArg,vectorsArg,outArg]=process.argv.slice(2);
assert(beforeArg&&afterArg&&vectorsArg&&outArg,'BASELINE_RUNNER OPTIMIZED_RUNNER FROZEN_VECTORS NEW_OUTPUT');
const before=resolve(beforeArg),after=resolve(afterArg),vectors=resolve(vectorsArg),out=resolve(outArg);
await mkdir(out,{recursive:false});
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
const rows=[];
for(const [run,which]of ['before','after','after','before','before','after'].entries()){
  console.log(`Coin local comparison ${run+1}/6: ${which}`);
  const text=execFileSync(which==='before'?before:after,['--ignored','--nocapture'],{
    encoding:'utf8',maxBuffer:64*1024*1024,timeout:180000,
    env:{...process.env,COIN_PROFILE_VECTORS:vectors,COIN_PROFILE_ITERATIONS:'11'}});
  assert(text.includes('test result: ok.'));await writeFile(join(out,`${run}-${which}.log`),text);
  const data=text.split('\n').filter(l=>l.startsWith('COIN_PROFILE:')).map(l=>JSON.parse(l.slice(13)));
  rows.push({which,run,data});
}
const comparisons=rows[0].data.map(v=>{
  const values=which=>rows.filter(r=>r.which===which).flatMap(r=>r.data.find(x=>x.index===v.index).samples.map(s=>s.nanos/1e6));
  const a=values('before'),b=values('after');
  return {index:v.index,method:v.method,assetInputs:v.assetInputs,nativeInputs:v.nativeInputs,samplesPerVersion:a.length,
    beforeMedianMs:median(a),afterMedianMs:median(b),beforeP95Ms:p95(a),afterP95Ms:p95(b),
    deltaPercent:(median(b)/median(a)-1)*100};
});
const report={scope:'macOS release Core call_json; no signing UI or network',warmupPerVector:3,
  order:rows.map(x=>x.which),frozenVectors:JSON.parse(await readFile(vectors)).length,comparisons};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(comparisons.filter(v=>v.method==='plan'),null,2));
