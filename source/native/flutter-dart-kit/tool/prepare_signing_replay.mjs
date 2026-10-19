// Select already-recorded public-fixture signatures. No key access or signing.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const base=resolve(import.meta.dirname,'..'),p5=resolve(base,'../flutter-dart-live-token-exploration');
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(order(v));
function order(v){return Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;}
const seal=JSON.parse(await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json')));
async function pinned(relative,group){const bytes=await readFile(join(p5,relative));assert.equal(sha(bytes),group,relative);return JSON.parse(bytes);}
const source='matched/dart/fixture.json';
const fixture=await pinned(source,seal.sourceHashes[source]);
const baseline=await pinned('evidence/preflight-20261012/baseline.json',seal.evidenceHashes['preflight-20261012/baseline.json']);
assert.equal(sha(await readFile(baseline.library.path)),baseline.library.sha256);
const cases=[],provenance=[];
for(const [platform,path]of [['android','android-matched-dart-20261012-b/device-report.json'],['ios','ios-matched-dart-20261012-a/device-report.json']]){
 const report=await pinned('evidence/'+path,seal.evidenceHashes[path]);
 assert(report.controlledPublicFixtureOnly===true && report.broadcasts===0);
 const scope=report.lastScope.scope;
 const context=Object.fromEntries(['sessionId','origin','topOrigin','frame','navigationId','createdAt'].map(k=>[k,scope[k]]));context.transport='webview';
 for(const [index,method]of [[0,'tbc_signMessage'],[1,'tbc_signTransaction']]){
  const h=report.host[index],audit=h.audit;
  assert.equal(h.method,method);assert(h.ok);
  assert.equal(sha(canonical(context)),audit.binding.payload.contextHash);
  const request=method==='tbc_signTransaction'?fixture.request:{version:'1.0',chainId:fixture.account.chainId,from:fixture.account.address,message:audit.preview.message};
  assert.equal(sha(canonical(request)),audit.binding.payload.requestHash);
  cases.push({name:platform+'-'+method,platform,method,context,account:fixture.account,request,audit,result:report.page[index].value});
 }
 provenance.push({path:'evidence/'+path,sha256:seal.evidenceHashes[path]});
}
await mkdir(join(base,'test/fixtures/signing'),{recursive:true});
await writeFile(join(base,'test/fixtures/signing/replay.json'),JSON.stringify({
 proof:'Recorded controlled public-fixture signatures; replay is not native/device/chain acceptance',
 library:baseline.library,cases,provenance,
},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,privateKeys:0,newSignatures:0,networkHttp:0,broadcasts:0}));
