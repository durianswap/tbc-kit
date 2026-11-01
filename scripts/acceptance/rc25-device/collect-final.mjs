import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc25-real'),dest=join(root,'docs/acceptance/evidence/rc25-devices');
const json=async p=>JSON.parse(await readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const protectedFiles=await json('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/flutter-rc16-sync/protected-before.json');
for(const[p,h]of Object.entries(protectedFiles))assert.equal(hash(await readFile(p)),h,p);
const frozen=join(root,'release/candidates/kit-stress-rc25');
for(const line of (await readFile(join(frozen,'DOWNLOADS.SHA256'),'utf8')).trim().split('\n')){
 const[h,file]=line.split(/\s+/);assert.equal(hash(await readFile(join(frozen,file))),h,file);
}
assert.equal(hash(await readFile(join(root,'artifacts/tbc-kit.tgz'))),'14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b');
const lock=await json(join(frozen,'native-sdk-lock.json'));
for(const[p,h]of Object.entries(lock.files))assert.equal(hash(await readFile(join(root,'.verify/rc23-native/sdk',p))),h,p);
const cases=[];
for(const platform of ['ios','android']){
 const kinds=['collection',platform==='ios'?'mint11-envelope':'mint11','partial-budget-new-process',platform==='ios'?'expired-before-dispatch':'expired-unused-slot',platform==='ios'?'expiry-during-approval':'expiry-during-approval-ready'];
 for(const kind of kinds){
  const r=await json(join(out,'private',platform+'-'+kind+'-report.json')),last=r.results.at(-1),prev=r.results.at(-2),all=r.metrics??[];
  const ends=all.map((m,i)=>m.phase==='wallet-return'?i:-1).filter(i=>i>=0);
  const metrics=all.slice((ends.at(-2)??-1)+1,ends.at(-1)+1),approval=metrics.findLast(m=>m.phase==='approved'),signs=metrics.filter(m=>m.phase==='signature'),ret=metrics.at(-1);
  const delta=Object.fromEntries(['approvalUI','approved','job.authorize','signer.sign','broadcast.POST','http.GET','engine.plan','engine.validate'].map(k=>[k,(last.counts[k]??0)-(prev?.counts[k]??0)]));
  const sum=p=>metrics.filter(m=>m.phase===p).reduce((s,m)=>s+(m.elapsedMs??m.nativeMs??0),0);
  const measured=p=>metrics.some(m=>m.phase===p)?sum(p):null;
  const postMs=metrics.filter(m=>m.phase==='http-end'&&m.method==='POST').reduce((s,m)=>s+m.elapsedMs,0);
  cases.push({platform,kind,result:last.publicResult??{errorCode:last.code},deltas:delta,approvalToLastSignatureMs:approval&&signs.length?signs.at(-1).monoMs-approval.monoMs:null,approvalToWalletReturnMs:approval?ret.monoMs-approval.monoMs:null,nativeSignMs:sum('signature'),engineMeasuredMs:measured('engine'),signerPortMeasuredMs:measured('signer-port'),broadcastHttpMs:postMs,prefetchStartedBeforeApproval:approval?metrics.filter(m=>m.phase==='http-start'&&m.method==='GET').every(m=>m.monoMs<approval.monoMs):null,metrics});
 }
 const build=await json(join(out,platform+'-build-report.json'));
 // Only public build metadata, never private vault state.
 await writeFile(join(dest,platform+'-real-build.json'),JSON.stringify(build,null,2));
}
for(const item of cases){
 if(['mint11','mint11-envelope'].includes(item.kind)){
  assert.equal(item.result.minted,11);assert.equal(item.result.status,'complete');assert.equal(item.deltas.approvalUI,1);assert.equal(item.deltas['broadcast.POST'],11);assert.equal(item.deltas['http.GET'],3);assert(item.prefetchStartedBeforeApproval);
 }else if(item.kind==='partial-budget-new-process'){
  assert.equal(item.result.minted,10);assert.equal(item.result.reason,'fee-budget');assert.equal(item.deltas.approvalUI,1);assert.equal(item.deltas['broadcast.POST'],10);assert.equal(item.deltas['http.GET'],3);assert(item.prefetchStartedBeforeApproval);
 }else if(item.kind.startsWith('expired')){
  assert.equal(item.result.reason,'expired');assert.equal(item.deltas['signer.sign'],0);assert.equal(item.deltas['broadcast.POST'],0);assert.equal(item.deltas['http.GET'],0);
 }else if(item.kind.startsWith('expiry-during')){
  assert.equal(item.result.errorCode,'-32603');assert.equal(item.deltas['signer.sign'],0);assert.equal(item.deltas['broadcast.POST'],0);
 }
}
await mkdir(join(dest,'runtime'),{recursive:true});
for(const [from,to]of [['WalletApp.swift','WalletApp.swift'],['android/src/main/java/io/tbc/kitloop/NativeHost.kt','NativeHost.kt'],['bootstrap.js','bootstrap.js'],['android/host-bootstrap.js','android-host-bootstrap.js']])await copyFile(join(out,'native/kit-runtime/closed-loop',from),join(dest,'runtime',to));
await copyFile(join(out,'dapp.html'),join(dest,'runtime/dapp.html'));
const chain=await json(join(dest,'chain-reconciliation.json'));
const summary={at:new Date().toISOString(),kit:'0.1.0-rc.25',native:'0.1.0-rc.23.native.2',overall:'TARGETED_ACCEPTANCE_WITH_OPEN_FINDING',integrity:{protectedPartnerFiles:Object.keys(protectedFiles).length,changed:0,rc25SealedFilesUnchanged:true,currentKitUnchanged:true,nativeFilesUnchanged:true},controlledGroups:{ios:11,android:11},realBusinessTransactions:{accepted:chain.accepted,confirmed:chain.confirmed,pending:chain.pending,chainHeight:chain.chainHeight},findings:[{id:'RC25-DEVICE-EXPIRY',status:'OPEN',scope:'Kit NFT job approval adapter rejection after deadline',impact:'Safe stop but generic Provider -32603; missing stopped/expired result',signatures:0,broadcasts:0},{id:'RC25-ANDROID-TIMING',status:'DIAGNOSIS_REQUIRED',scope:'Instrumented standalone Hermes Android simulator runtime',impact:'11-item task slower than iOS; native signing and HTTP alone do not explain the residual; not proven a Kit regression'}],cases};
await writeFile(join(dest,'final-summary.json'),JSON.stringify(summary,null,2));
const files=[];async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(join(dir,entry.name),name+'/');else if(name!=='evidence-sha256.json')files.push({file:name,sha256:hash(await readFile(join(dir,entry.name)))});}}await walk(dest);
await writeFile(join(dest,'evidence-sha256.json'),JSON.stringify(files,null,2));
console.log(JSON.stringify({...summary,cases:cases.map(c=>({...c,result:{status:c.result.status,reason:c.result.reason,minted:c.result.minted,errorCode:c.result.errorCode},metrics:undefined}))}));
