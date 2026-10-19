// Run the independently checked public LOP vectors through an EXACT installed
// Kit. No production source imports, network, wallet keys, devices or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
import {checkAssociatedLopHost} from './lib/check-associated-lop-host.mjs';
const [consumer,archive,expectedSha,expectedVersion,vectorsPath,vectorsSha,backend='wasm']=process.argv.slice(2);
assert.ok(consumer&&archive&&expectedSha&&expectedVersion&&vectorsPath&&vectorsSha);
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=await readFile(vectorsPath);assert.equal(sha(bytes),vectorsSha);
const vectors=JSON.parse(bytes);assert.equal(vectors.fixtureOnly,true);assert.equal(vectors.realSecrets,false);assert.equal(vectors.cases.length,4);
const installed=await loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion,backend});
const {kit,native:keyless}=installed,tbc=createRequire(resolve(import.meta.dirname,'../../../package.json'))('tbc-lib-js');
globalThis.fetch=()=>{throw Error('Actual network forbidden');};
const checks=[];
for(const row of vectors.cases){
  assert.ok([1,4].includes(row.publicSyntheticScalar));
  const signer=new tbc.PrivateKey(new tbc.crypto.BN(row.publicSyntheticScalar));assert.equal(signer.publicKey.toString(),row.account.publicKey);
  let reads=0;const responses=new Map(row.responses);
  const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({materialNative:keyless,network:kit.createTbcNetworkContext({network:'testnet'}),
    fetch:async(url,init)=>{const u=new URL(String(url));assert.equal(u.search,'');
      const key=JSON.stringify([u.pathname,init.method??'GET',init.body??null]);assert.ok(responses.has(key),'No unrecorded fixture lookup permitted');reads++;
      return new Response(responses.get(key),{status:200});}});
  const results=await checkAssociatedLopHost({kit,keyless,account:row.account,request:row.request,reviewer,signer,
    expectedRaw:row.expectedRaw,expectedOrders:row.expectedOrders,expectedReads:row.expectedReads,readCount:()=>reads});
  checks.push(...results.map(result=>({index:row.index,intent:row.intent,profiles:row.profiles,...result})));
}
assert.equal(checks.length,36);
const directory=await mkdtemp(join(tmpdir(),'tbc-lop-installed-')),path=join(directory,'report.json');
const report={status:'PASS_INSTALLED_LOP_HOST',installed:installed.evidence,vectorsSha256:vectorsSha,checks,
  actualHttp:0,broadcasts:0,deviceAcceptance:false,realCustody:false,
  acceptanceScriptSha256:sha(await readFile(new URL(import.meta.url))),helperSha256:sha(await readFile(new URL('./lib/check-associated-lop-host.mjs',import.meta.url)))};
const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(path,reportBytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(reportBytes),checks:checks.length,backend}));
