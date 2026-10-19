// Exact installed package only; independently validated public refund fixtures.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
import {checkAssociatedHtlcHost} from './lib/check-associated-htlc-host.mjs';
const [consumer,archive,expectedSha,expectedVersion,vectorsPath,vectorsSha,backend='wasm']=process.argv.slice(2);
assert.ok(consumer&&archive&&expectedSha&&expectedVersion&&vectorsPath&&vectorsSha);
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=await readFile(vectorsPath);assert.equal(sha(bytes),vectorsSha);
const vectors=JSON.parse(bytes);assert.equal(vectors.fixtureOnly,true);assert.equal(vectors.realSecrets,false);
assert.equal(vectors.sdkCommit,'af77616121db340e15bb8b73c197bc2f8d1ee986');assert.equal(vectors.cases.length,2);
assert.equal(bytes.includes(Buffer.from('33'.repeat(32))),false);
const installed=await loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion,backend});
const {kit,native:keyless}=installed,tbc=createRequire(resolve(import.meta.dirname,'../../../package.json'))('tbc-lib-js');
globalThis.fetch=()=>{throw Error('Actual network forbidden');};
const checks=[];let vmInputs=0,stages=0;
for(const row of vectors.cases){
 assert.equal(row.publicSyntheticScalar,1);assert.equal(row.expectedRaws.length,2);
 const signer=new tbc.PrivateKey(new tbc.crypto.BN(1));assert.equal(signer.publicKey.toString(),row.account.publicKey);
 const finalized=[];
 for(let transactionIndex=0;transactionIndex<2;transactionIndex++){
  const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({...row.keylessRequest,transactionIndex,previousTransactions:finalized})));
  const signatures=stage.digests.map(d=>secp256k1.sign(d,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
  const result=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
  assert.equal(result.txraw,row.expectedRaws[transactionIndex],'Installed package differs from independently validated fixed SDK');
  const tx=new tbc.Transaction(result.txraw);tx.inputs.forEach((input,n)=>{
   const p=stage.inputs[n];input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(p.script),satoshis:p.satoshis});
   assert.equal(tx.verifyScript(n).success,true);vmInputs++;
  });finalized.push(result.txraw);stages++;
 }
 assert.equal(new tbc.Transaction(finalized[1]).inputs[0].prevTxId.toString('hex'),new tbc.Transaction(finalized[0]).id);
 const reads=[],responses=new Map(row.responses);
 const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({materialNative:keyless,network:kit.createTbcNetworkContext({network:'testnet'}),
  fetch:async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://api.tbcdev.org');assert.equal(u.search,'');
   const key=JSON.stringify([u.pathname,init.method??'GET',init.body??null]);assert.ok(responses.has(key),'Unexpected fixture lookup');
   reads.push(u.pathname);return new Response(responses.get(key),{status:200});}});
 const results=await checkAssociatedHtlcHost({kit,keyless,account:row.account,request:row.request,reviewer,signer,
  expectedRaws:row.expectedRaws,claim:false,preimage:'33'.repeat(32),reads});
 checks.push(...results.map(r=>({profile:row.profile,...r})));
}
assert.equal(checks.length,18);assert.equal(stages,4);
const directory=await mkdtemp(join(tmpdir(),'tbc-htlc-refund-installed-')),path=join(directory,'report.json');
const report={status:'PASS_INSTALLED_HTLC_REFUND',installed:installed.evidence,vectorsSha256:vectorsSha,checks,stages,vmInputs,
 actualHttp:0,broadcasts:0,deviceAcceptance:false,realCustody:false,
 acceptanceScriptSha256:sha(await readFile(new URL(import.meta.url))),helperSha256:sha(await readFile(new URL('./lib/check-associated-htlc-host.mjs',import.meta.url)))};
const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(path,reportBytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(reportBytes),checks:checks.length,stages,vmInputs,backend}));
