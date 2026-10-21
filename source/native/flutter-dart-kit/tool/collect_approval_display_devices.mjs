// Collect the independent public-fixture Apps; never read wallet data or keys.
import {readFile, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const root = resolve(process.argv[2]);
const tag = process.argv[3] ?? 'final';
assert.match(tag, /^[a-z0-9-]+$/);
const mode = process.argv[4] ?? 'comparison';
assert.ok(['comparison', 'candidate-only'].includes(mode));
const summary = {recordedAt:new Date().toISOString(), tag,
  mode,
  scope:'Native custody + public signature replay; not API/Engine cryptography or transaction end-to-end latency',
  results:{}, protectedUnchanged:false};
const stats = values => {
  const sorted = [...values].sort((a,b)=>a-b), n=sorted.length;
  return {samples:n, medianMs:(sorted[n/2-1]+sorted[n/2])/2,
    p95Ms:sorted[Math.ceil(n*.95)-1], minMs:sorted[0], maxMs:sorted[n-1]};
};
for (const variant of mode === 'candidate-only' ? ['candidate'] : ['baseline','candidate']) {
  const dir=join(root,variant);
  const devices=JSON.parse(await readFile(join(dir,'devices.json'),'utf8'));
  const build=JSON.parse(await readFile(join(dir,'build.json'),'utf8'));
  for (const platform of ['ios','android']) {
    const raw=platform==='ios' ? await readFile(devices.iosReport,'utf8')
      : (await run(join(homedir(),'Library/Android/sdk/platform-tools/adb'),
        ['-s',devices.serial,'shell','run-as',devices.androidPackage,'cat','files/report.json'],
        {timeout:20000,maxBuffer:1000000})).stdout;
    const result=JSON.parse(raw);
    assert.equal(result.directedTests,'PASS');
    assert.equal(result.error,undefined);
    assert.equal(result.chainReads,0); assert.equal(result.broadcasts,0);
    assert.equal(result.realCryptographicSigning,false);
    assert.equal(result.benchmark?.length,20);
    assert.ok(result.benchmark.every(row=>Object.values(row).every(value=>Number.isFinite(value)&&value>=0)));
    if (variant==='candidate') {
      assert.equal(result.approved?.operationApprovals,1);
      assert.equal(result.approved?.replayedSignatures,2);
      assert.equal(result.rejected?.signatures,0);
    }
    await writeFile(join(dir,`${platform}-${tag}.json`),raw);
    summary.results[`${variant}-${platform}`]={directedTests:result.directedTests,
      ...(result.approved ? {approved:result.approved,rejected:result.rejected}:{}),
      timings:Object.fromEntries(Object.keys(result.benchmark[0]).map(k=>
        [k,stats(result.benchmark.map(x=>x[k]))])), sourceHashes:build.sourceHashes};
  }
}
const protectedBefore=JSON.parse(await readFile(join(root,'protected-before.json'),'utf8'));
for (const [file,expected] of Object.entries(protectedBefore)) {
  const actual=createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual,expected,file);
}
summary.protectedUnchanged=true;
await writeFile(join(root,`device-summary-${tag}.json`),JSON.stringify(summary,null,2));
console.log(JSON.stringify({tag,protectedUnchanged:true,results:Object.fromEntries(
  Object.entries(summary.results).map(([k,v])=>[k,v.timings]))},null,2));
