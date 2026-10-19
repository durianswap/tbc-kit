import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {secp256k1} from '@noble/curves/secp256k1';
const [sdk,companion,consumer,gradle,android,udid,serial,profile]=process.argv.slice(2);
assert.ok(serial==='emulator-5554'&&udid&&android&&gradle&&consumer&&companion&&sdk&&
  (profile===undefined||profile==='--special'||profile==='--associated-htlc'||profile==='--amm-quote'||profile==='--current-associated'||profile==='--current-associated-locks'||profile==='--reviewed-admin'||profile==='--reviewed-raw-admin'||profile==='--reviewed-controller'||profile==='--reviewed-refund'||profile==='--lp-receipt')&&process.argv.length<=10);
const lpReceipt=profile==='--lp-receipt';
const reviewedRefund=profile==='--reviewed-refund';
const reviewedController=profile==='--reviewed-controller'||reviewedRefund;
const rawAdmin=profile==='--reviewed-raw-admin'||reviewedController;
const reviewedAdmin=profile==='--reviewed-admin'||rawAdmin;
const withAssociatedLocks=profile==='--current-associated-locks';
const currentAssociated=profile==='--current-associated'||withAssociatedLocks;
if(currentAssociated||reviewedAdmin||lpReceipt)assert.equal(udid,'C2C010B8-4071-4888-9E25-D91BF88EB461','Only Kit Latest is authorized');
const root=resolve(import.meta.dirname,'..'),repo=resolve(root,'../..'),out=await mkdtemp(join(sdk,'keyless-check-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const identity=JSON.parse(await readFile(join(sdk,'identity.json')));
const companionIdentity=JSON.parse(await readFile(join(companion,'identity.json')));
assert.equal(companionIdentity.artifactSetId,identity.keylessArtifactSetId);
assert.equal(sha(await readFile(join(companion,'artifacts/desktop/libtbc_keyless_native.dylib'))),identity.keylessHashes['desktop/libtbc_keyless_native.dylib']);
for(const [p,h]of Object.entries(identity.bindingSourceHashes))assert.equal(sha(await readFile(join(sdk,p))),h,p);
const run=(cmd,args,extra={})=>execFileSync(cmd,args,{cwd:out,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,...extra});
const log=async(name,cmd,args,extra={})=>{try{const result=run(cmd,args,extra);await writeFile(join(out,name+'.log'),result);return result;}catch(e){await writeFile(join(out,name+'.log'),String(e.stdout??'')+String(e.stderr??''));throw e;}};
const {createWasmTbcKeylessEngine,TWS_RELEASE_FINGERPRINT}=await import(pathToFileURL(join(consumer,'node_modules/@tbc/kit/dist/esm/wallet.js')));
assert.equal(TWS_RELEASE_FINGERPRINT,identity.protocolFingerprint,'Installed Kit and native SDK must share a protocol fingerprint');
if(reviewedAdmin){
 const {loadHolderInstalledHarness}=await import('../../../packages/tbc-engine/scripts/lib/holder-installed-harness.mjs');
 const delivery=JSON.parse(await readFile(rawAdmin?join(resolve(sdk,'..'),reviewedRefund?'candidate224-delivery.json':reviewedController?'candidate223-delivery.json':'candidate222-delivery.json'):
  '/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc219-source-aCa8rV/candidate219-delivery.json'));
 assert.equal(delivery.candidate,reviewedRefund?'0.1.0-candidate.224':reviewedController?'0.1.0-candidate.223':rawAdmin?'0.1.0-candidate.222':'0.1.0-candidate.219');
 if(reviewedController){
  assert.equal(delivery.protocolFingerprint,'e594e22d5d1289cd9a9e38520dacdc33496eb75904f83db9b1ea38393208201b');
  assert.equal(delivery.sha256,reviewedRefund?'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079':'ecd5e3b4854ec69501e044ac8a7a590f0f24aa1cff2c7f58360e9ad9a061251b');
 }else if(rawAdmin)assert.equal(delivery.protocolFingerprint,'548da949847ee6ff7c1b9c5fdfc4f6fbcc7b48e7bec2bb7b724969ff1cccfb1b');
 else assert.equal(delivery.sha256,'056c4a2b533c7ee19b55d7488a00cbc0e6ca0b423af0bb5aba32977ea10f6dca');
 assert.equal(identity.kitVersion,delivery.candidate);assert.equal(identity.artifactSetId,delivery.nativeSdkArtifactSetId);
 assert.equal(sha(await readFile(join(sdk,'identity.json'))),delivery.nativeSdkIdentitySha256);
 await loadHolderInstalledHarness({consumer,archive:delivery.tar,expectedSha:delivery.sha256,expectedVersion:delivery.candidate});
}
if(currentAssociated){
 const {loadHolderInstalledHarness}=await import('../../../packages/tbc-engine/scripts/lib/holder-installed-harness.mjs');
 if(withAssociatedLocks){
  const delivery=JSON.parse(await readFile('/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc218-source-w10lYU/candidate218-delivery.json'));
  assert.equal(delivery.candidate,'0.1.0-candidate.218');assert.equal(identity.kitVersion,delivery.candidate);
  assert.equal(identity.artifactSetId,delivery.nativeSdkArtifactSetId);
  assert.equal(sha(await readFile(join(sdk,'identity.json'))),delivery.nativeSdkIdentitySha256);
  await loadHolderInstalledHarness({consumer,archive:delivery.tar,expectedSha:delivery.sha256,expectedVersion:delivery.candidate});
 }else await loadHolderInstalledHarness({consumer,archive:'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc216-source-v3vVbx/pack-final/tbc-kit-0.1.0-candidate.216.tgz',
   expectedSha:'5ba6f188d98cff322882a72fb93e786f94b330f03da2227711af24d614182622',expectedVersion:'0.1.0-candidate.216'});
}
const wasm=await createWasmTbcKeylessEngine(await readFile(join(consumer,'node_modules/@tbc/kit/artifacts/wasm/tbc_keyless_wasm.wasm')));
const f=JSON.parse(await readFile(join(repo,'packages/kit/test/fixtures/controlled-pool.json')));
const info=Object.fromEntries(Object.entries(f.poolInfo).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
const nftTest=await readFile(join(repo,'packages/kit/test/receipt-verification.test.mjs'),'utf8');
const nftRaw=nftTest.match(/const NFT_RAW = "([a-f0-9]+)";/)?.[1];assert.ok(nftRaw);
const amm=JSON.parse(await readFile(join(repo,'packages/tbc-engine/rust/fixtures/amm-pool-proof.json')));
const ammGenesis=amm.sequences.find(sequence=>sequence.label==='public-plain')?.transactions[2];
assert.ok(ammGenesis&&amm.raws[ammGenesis]);
const inputs=[
 ['legacyPoolPreview',{operation:'increaseLp',ftContractId:'22'.repeat(32),ftDecimal:6,amount:'0.001',lockTime:0,pool:{ftLpRaw:'10000',ftARaw:'5000',tbcSat:'10000',poolValueSat:'11000',publicKeyLocked:false}}],
 ['preparePoolNft',{phase:'describe',contractId:f.poolContractId,ownerAddress:f.address,info,poolPreTxraw:f.rawTransactions[f.poolInfo.txid],ftContractTxraw:f.rawTransactions[f.ftContractId]}],
 ['prepareAssetAncestry',{phase:'inspect',items:[{parentTxid:f.ownerCandidate.txid,outputIndex:f.ownerCandidate.index,parentTxraw:f.rawTransactions[f.ownerCandidate.txid]}]}],
 ['inspectTokenReceipt',{rawTransaction:f.rawTransactions[f.ownerCandidate.txid]}],
 ['inspectNftReceipt',{rawTransaction:nftRaw}],
 ['inspectAmmMaterial',{phase:'inspectPool',pool:{txid:ammGenesis,rawTransaction:amm.raws[ammGenesis]}}],
];
const desktop=join(companion,'artifacts/desktop'),headers=join(companion,'artifacts/include');
run('cc',[join(repo,'packages/tbc-engine/scripts/keyless-native-runner.c'),'-I'+headers,join(desktop,'libtbc_keyless_native.dylib'),'-Wl,-rpath,'+desktop,'-o',join(out,'runner')]);
// Pin the probe to this extracted candidate, never the build-machine absolute
// install name embedded in an immutable Rust dylib.
const installName=run('otool',['-D',join(desktop,'libtbc_keyless_native.dylib')]).trim().split('\n').at(-1);
run('install_name_tool',['-change',installName,join(desktop,'libtbc_keyless_native.dylib'),join(out,'runner')]);
const vectors=[];
// Public synthetic vector: exercise both new native entry points without custody.
const scalar=new Uint8Array(32).fill(7),publicKey=Buffer.from(secp256k1.getPublicKey(scalar)).toString('hex');
const script='76a914'+'22'.repeat(20)+'88ac';
const raw='0a00000001'+'11'.repeat(32)+'0000000000ffffffff01282300000000000019'+script+'00000000';
const reviewed={format:'raw',request:{txraws:[raw],utxosSatoshis:[[10000]],scriptPubkeys:[[script]]},publicKey};
const stage=JSON.parse(await wasm.execute('prepareReviewedStage',JSON.stringify(reviewed)));
inputs.push(['prepareReviewedStage',reviewed],['finalizeReviewedStage',{stage,signatures:stage.digests.map(d=>secp256k1.sign(d,scalar).toCompactHex()),signatureEncoding:'compact64'}]);
let specialSourceVectors=0;
if(profile==='--special'||profile==='--amm-quote'){
 // Public fixtures only. Native/WASM and actual mobile libraries must agree
 // on the new material entry points and signature-index mapping; no custody.
 const suites=profile==='--amm-quote'?[
  {target:'amm_material',selected:'public_quote_matches_fixed_sdk_next_pool_without_an_account_or_network',env:{AMM_MATERIAL_DUMP_WIRE:'1'},pattern:/^AMM_MATERIAL_WIRE:/,count:32,operation:'inspectAmmMaterial',quoteOnly:true},
  {target:'amm_material',selected:'public_quote_add_ft_uses_existing_reserve_rounding',env:{AMM_MATERIAL_DUMP_WIRE:'1'},pattern:/^AMM_MATERIAL_WIRE:/,count:1,operation:'inspectAmmMaterial',quoteOnly:true},
 ]:[
  {target:'lop_material',env:{LOP_REVIEW_DUMP_WIRE:'1',LOP_MATERIAL_DUMP_WIRE:'1'},pattern:/^LOP_(REVIEW|MATERIAL)_WIRE:/,count:5,operation:'inspectLopMaterial'},
  {target:'token_material',env:{TOKEN_MATERIAL_DUMP_WIRE:'1'},pattern:/^TOKEN_MATERIAL_WIRE:/,count:6,operation:'inspectTokenMaterial'},
  {target:'reviewed',selected:'associated_lop_match_reuses_shared_proof_and_only_requests_needed_signatures',env:{REVIEWED_DUMP_WIRE:'1'},pattern:/^REVIEWED_WIRE:/,count:2},
 ];
 for(const suite of suites){
  let output;
  try{output=run('cargo',['test','--locked','--offline','-p','tbc-keyless-core','--test',suite.target,
    ...(suite.selected?[suite.selected,'--','--exact','--nocapture']:['--','--nocapture'])],
    {cwd:join(repo,'packages/tbc-engine/rust'),env:{...process.env,...suite.env},stdio:['ignore','pipe','pipe']});}
  catch{throw new Error('Special keyless fixture generation failed; material withheld');}
  assert.match(output,/test result: ok\./);
  const rows=output.split('\n').filter(l=>suite.pattern.test(l)).map(l=>JSON.parse(l.slice(l.indexOf(':')+1)));
  assert.equal(rows.length,suite.count);
  for(const row of rows){
   if(suite.quoteOnly&&row.input.phase!=='quote')continue;
   const method=suite.operation??row.operation;
   assert.deepEqual(JSON.parse(await wasm.execute(method,JSON.stringify(row.input))),row.result);
   inputs.push([method,row.input]);specialSourceVectors++;
  }
 }
}
for(const [method,data]of inputs){
 const input=JSON.stringify(data),expected=run(join(out,'runner'),[method,input]).trim();
 const oracle=await wasm.execute(method,input);assert.deepEqual(JSON.parse(expected),JSON.parse(oracle),method);assert.equal(JSON.parse(expected).error,undefined);
 vectors.push({method,input,expected});
 const bad='中文🍈',error=run(join(out,'runner'),[method,bad]).trim();
 await assert.rejects(wasm.execute(method,bad),e=>e.message===JSON.parse(error).error);vectors.push({method,input:bad,expected:error});
}
assert.equal(JSON.parse(run(join(out,'runner'),['sign','{}'])).error,'KEYLESS_OPERATION_UNAVAILABLE');
let associatedHtlcVectors=0;
if(profile==='--associated-htlc'){
 // Only public synthetic scalar-7 fixtures; never use a wallet or live preimage.
 let output;
 try{output=run('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_htlc','--','--nocapture'],
  {cwd:join(repo,'packages/tbc-engine/rust'),env:{...process.env,HTLC_ASSOCIATED_DUMP_WIRE:'1'},stdio:['ignore','pipe','pipe']});}
 catch{throw new Error('Public HTLC vector generation failed; material withheld');}
 const marker='HTLC_ASSOCIATED_WIRE:',rows=output.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length)));
 assert.equal(rows.length,33);
 for(const row of rows){
  const calls=row.kind==='valid'
   ?[['prepareReviewedStage',row.request,row.stage],['finalizeReviewedStage',row.finalRequest,row.result]]
   :[[row.kind==='invalid-prepare'?'prepareReviewedStage':'finalizeReviewedStage',row.request,{error:'Invalid associated HTLC witness'}]];
  for(const [method,data,reference] of calls){
   const input=JSON.stringify(data),expected=run(join(out,'runner'),[method,input]).trim();
   assert.deepEqual(JSON.parse(expected),reference,'Packaged desktop HTLC result');
   if(reference.error)await assert.rejects(wasm.execute(method,input),e=>e.message===reference.error);
   else assert.deepEqual(JSON.parse(await wasm.execute(method,input)),reference);
   vectors.push({method,input,expected});associatedHtlcVectors++;
  }
 }
 assert.equal(associatedHtlcVectors,42);
}
let currentAssociatedVectors=0,currentAssociatedFixtureSha256;
if(currentAssociated){
 // Already frozen public scalar-1 source vectors; no new fixture generation,
 // no live wallet/HTLC preimage, no platform custody or network.
 const bytes=await readFile(withAssociatedLocks
  ?'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-associated-host-NvR4QZ/public-vectors.json'
  :'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-associated-host-jJheGH/public-vectors.json');
 currentAssociatedFixtureSha256=sha(bytes);
 assert.equal(currentAssociatedFixtureSha256,withAssociatedLocks?'9185ccab854d38cda5af0ed653373237d2ab15c73af7906de9b8ce3e09c1fe4e':'6673561b11d62e12d85d0c83427821c33a01f881fffb05743fa4c99380848122');
 const fixture=JSON.parse(bytes);assert.equal(fixture.rows.length,withAssociatedLocks?26:14);assert.equal(fixture.failures.length,withAssociatedLocks?105:88);
 const calls=fixture.rows.flatMap(row=>[
  {method:'prepareReviewedStage',input:row.prepare,result:row.stage},
  {method:'finalizeReviewedStage',input:row.finalize,result:row.result},
 ]).concat(fixture.failures.map(row=>({method:row.operation,input:row.input,result:{error:row.error}})));
 for(const call of calls){const input=JSON.stringify(call.input),expected=run(join(out,'runner'),[call.method,input]).trim();
  assert.deepEqual(JSON.parse(expected),call.result,'Current associated desktop result');
  if(call.result.error)await assert.rejects(wasm.execute(call.method,input),e=>e.message===call.result.error);
  else assert.deepEqual(JSON.parse(await wasm.execute(call.method,input)),call.result);
  vectors.push({method:call.method,input,expected});currentAssociatedVectors++;
 }
 assert.equal(currentAssociatedVectors,withAssociatedLocks?157:116);
}
let reviewedAdminVectors=0,reviewedAdminFixtureSha256,rawAdminFixtureSha256;
if(reviewedAdmin){
 // Fixed public scalar1/2 fixtures; no wallet keys, real transactions or
 // HTLC preimages. The negative cases exercise actual library rejection.
 if(rawAdmin){
  run('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_coin_admin'],{
   cwd:join(repo,'packages/tbc-engine/rust'),env:{...process.env,TBC_REVIEWED_ADMIN_OUTPUT:join(out,'associated-public.json'),TBC_REVIEWED_RAW_ADMIN_OUTPUT:join(out,'raw-public.json')},stdio:['ignore','pipe','pipe']});
 }
 const bytes=await readFile(rawAdmin?join(out,'associated-public.json'):'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-reviewed-admin-host-IiQVVO/public-vectors.json');
 reviewedAdminFixtureSha256=sha(bytes);
 assert.equal(reviewedAdminFixtureSha256,'b4cead2356dde917b033dafa26df66644ef6a1136b0d2706cbed21a775197d33');
 const fixture=JSON.parse(bytes);assert.equal(fixture.fixtureOnly,true);assert.equal(fixture.network,false);assert.equal(fixture.rows.length,3);
 const rows=[...fixture.rows];
 if(rawAdmin){const rawBytes=await readFile(join(out,'raw-public.json'));rawAdminFixtureSha256=sha(rawBytes);
  assert.equal(rawAdminFixtureSha256,'e4302a0fc0760665795e0a8e84604a5289fa59c183dc48b411d3ed6b32dc05d6');
  const rawFixture=JSON.parse(rawBytes);assert.equal(rawFixture.fixtureOnly,true);assert.equal(rawFixture.network,false);assert.equal(rawFixture.rows.length,2);rows.push(...rawFixture.rows);}
 for(const row of rows){
  const calls=[['prepareReviewedStage',row.prepare,row.stage],['finalizeReviewedStage',row.finalize,row.result]];
  if(row.compact)calls.push(['finalizeReviewedStage',row.compact,row.result]);
  for(const field of ['inputIndex','digest','publicKey','algorithm']){
   const bad=structuredClone(row.finalize);
   bad.stage.signingTasks[0][field]=field==='inputIndex'?99:field==='digest'?'11'.repeat(32):field==='publicKey'?row.stage.publicKey:'secp256k1-ecdsa';
   calls.push(['finalizeReviewedStage',bad,null]);
  }
  const missing=structuredClone(row.finalize);delete missing.stage.signingTasks;
  const signature=structuredClone(row.finalize);signature.signatures[0]='00'.repeat(65);
  calls.push(['finalizeReviewedStage',missing,null],['finalizeReviewedStage',signature,null]);
  for(const [method,data,reference] of calls){
   const input=JSON.stringify(data),expected=run(join(out,'runner'),[method,input]).trim(),result=JSON.parse(expected);
   if(reference===null){assert.equal(typeof result.error,'string');await assert.rejects(wasm.execute(method,input),e=>e.message===result.error);}
   else{assert.deepEqual(result,reference);assert.deepEqual(JSON.parse(await wasm.execute(method,input)),reference);}
   vectors.push({method,input,expected});reviewedAdminVectors++;
  }
 }
 assert.equal(reviewedAdminVectors,rawAdmin?42:24);
}
let controllerVectors=0,controllerFixtureSha256;
if(reviewedController){
 // Frozen public scalar1/2 fixtures already checked against SDK/VM by4KE.
 // These are preparation parity checks, not new independent VM or custody proof.
 const bytes=await readFile('/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-reviewed-admin-host-A2sNHS/public-vectors.json');
 controllerFixtureSha256=sha(bytes);
 assert.equal(controllerFixtureSha256,'d5b5bd81dd5c8be2c6984bd2b26df07e7162bf577c95b29c8719d9dac6b25a67');
 const fixture=JSON.parse(bytes);
 assert.equal(fixture.fixtureOnly,true);assert.equal(fixture.network,false);assert.equal(fixture.rows.length,3);
 for(const row of fixture.rows){
  const bad=structuredClone(row.prepare);
  bad.request.sourceUtxos[0].satoshis++;
  for(const [data,negative]of [[row.prepare,false],[bad,true]]){
   const method='prepareReviewedStage',input=JSON.stringify(data),expected=run(join(out,'runner'),[method,input]).trim();
   const result=JSON.parse(expected);
   if(negative){assert.equal(typeof result.error,'string');await assert.rejects(wasm.execute(method,input),e=>e.message===result.error);}
   else{assert.equal(result.error,undefined);assert.deepEqual(JSON.parse(await wasm.execute(method,input)),result);}
   vectors.push({method,input,expected});controllerVectors++;
  }
 }
 assert.equal(controllerVectors,6);
}
let refundEvidence;
let lpReceiptEvidence;
if(lpReceipt){
 // Receipt inspection uses public synthetic transactions only. Generate from
 // the exact companion source and compare both packaged desktop and WASM.
 const workspace=join(companion,'source/packages/tbc-engine/rust');
 const paths=['crates/tbc-keyless-core/src/amm_material.rs','crates/tbc-keyless-core/tests/lp_receipt.rs'];
 const source={};
 for(const p of paths){source[p]=sha(await readFile(join(workspace,p)));
  assert.equal(source[p],sha(await readFile(join(repo,'packages/tbc-engine/rust',p))),p);}
 assert.equal(sha(await readFile(join(consumer,'node_modules/@tbc/kit/artifacts/wasm/tbc_keyless_wasm.wasm'))),
  sha(await readFile(join(sdk,'source-kit/package/artifacts/wasm/tbc_keyless_wasm.wasm'))));
 let output;
 try{output=run('cargo',['test','--locked','--offline','-p','tbc-keyless-core','--test','lp_receipt','--','--nocapture'],
  {cwd:workspace,env:{...process.env,CARGO_TARGET_DIR:join(companion,'target'),LP_RECEIPT_DUMP_WIRE:'1'},stdio:['ignore','pipe','pipe']});}
 catch{throw new Error('Public LP receipt fixture generation failed; material withheld');}
 assert.match(output,/test result: ok\. 4 passed; 0 failed;/);
 const marker='LP_RECEIPT_WIRE:',rows=output.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length)));
 let accepted=0,rejected=0;
 for(const row of rows){
  const method='inspectAmmMaterial',input=JSON.stringify(row.input),expected=run(join(out,'runner'),[method,input]).trim(),result=JSON.parse(expected);
  if(row.error){assert.equal(typeof result.error,'string');await assert.rejects(wasm.execute(method,input),e=>e.message===result.error);rejected++;}
  else{assert.deepEqual(result,row.result);assert.deepEqual(JSON.parse(await wasm.execute(method,input)),result);accepted++;}
  vectors.push({method,input,expected});
 }
 assert.equal(accepted,14);assert.equal(rejected,7);
 lpReceiptEvidence={source,accepted,rejected,fixtureOnly:true,networkRequests:0};
}
if(reviewedRefund){
 const {createHtlcRefundPlatformVectors}=await import('./htlc-refund-vectors.mjs');
 const refund=await createHtlcRefundPlatformVectors({sdk,companion,wasm,runDesktop:(method,input)=>run(join(out,'runner'),[method,input])});
 vectors.push(...refund.vectors);refundEvidence={...refund.evidence,helperSha256:sha(await readFile(new URL('./htlc-refund-vectors.mjs',import.meta.url)))};
}
await writeFile(join(out,'vectors.json'),JSON.stringify(vectors));
const devices=JSON.parse(run('xcrun',['simctl','list','devices','booted','-j']));const device=Object.values(devices.devices).flat().find(d=>d.udid===udid);assert.ok(device&&!/113|143/.test(device.name));
const slice=join(sdk,'apple/Artifacts/TbcEngineNative.xcframework/ios-arm64-simulator'),kslice=join(sdk,'apple/Artifacts/TbcKeylessNative.xcframework/ios-arm64-simulator');
assert.equal(sha(await readFile(join(kslice,'libtbc_keyless_native.a'))),identity.keylessHashes['TbcKeylessNative.xcframework/ios-arm64-simulator/libtbc_keyless_native.a']);
const flags=['-swift-version','6','-target','arm64-apple-ios15.1-simulator','-sdk',run('xcrun',['--sdk','iphonesimulator','--show-sdk-path']).trim()];
const includes=['-I',join(slice,'Headers'),'-I',join(kslice,'Headers')];
await log('swift-library','xcrun',['swiftc',...flags,'-emit-library','-emit-module','-module-name','TbcEngine',...['TbcEngine.swift','TbcEngineIdentity.swift','TbcKeylessEngine.swift'].map(p=>join(sdk,'apple/Sources/TbcEngine',p)),...includes,'-L',slice,'-ltbc_engine_native','-L',kslice,'-ltbc_keyless_native','-Xlinker','-install_name','-Xlinker','@rpath/libTbcEngine.dylib','-o',join(out,'libTbcEngine.dylib')]);
await log('swift-probe','xcrun',['swiftc',...flags,'-parse-as-library',join(root,'keyless/SwiftProbe.swift'),'-I',out,...includes,'-L',out,'-lTbcEngine','-Xlinker','-rpath','-Xlinker',out,'-o',join(out,'swift-probe')]);
for(const p of ['libTbcEngine.dylib','swift-probe'])run('codesign',['--force','--sign','-',join(out,p)]);
const iosResult=await log('ios-runtime','xcrun',['simctl','spawn',udid,join(out,'swift-probe'),join(out,'vectors.json'),identity.artifactSetId]);assert.ok(iosResult.includes(`KEYLESS_SWIFT_PASS cases=${vectors.length} concurrent=16`));
const cpFile=join(out,'classpath.json'),init=join(out,'classpath.gradle');
await writeFile(init,`allprojects { afterEvaluate { p -> if(p.name == 'engine') tasks.register('writeProbeClasspath') { doLast { file('${cpFile}').text=groovy.json.JsonOutput.toJson(configurations.releaseRuntimeClasspath.resolve().collect { it.absolutePath }) } } } }`);
await log('classpath',gradle,[':engine:writeProbeClasspath','--offline','--no-daemon','--console=plain','-I',init],{cwd:join(sdk,'android'),env:{...process.env,ANDROID_HOME:android}});
const jars=JSON.parse(await readFile(cpFile)).filter(p=>p.endsWith('.jar'));
const aar=join(sdk,'android/engine/build/outputs/aar/engine-release.aar');
const zip=p=>execFileSync('unzip',['-p',aar,p],{maxBuffer:32*1024*1024});
const adb=join(android,'platform-tools/adb'),abi=run(adb,['-s',serial,'shell','getprop','ro.product.cpu.abi']).trim();assert.equal(abi,'arm64-v8a');
for(const name of ['libtbc_engine_native.so','libtbc_engine_jni.so','libtbc_keyless_native.so'])await writeFile(join(out,name),zip('jni/'+abi+'/'+name));
assert.equal(sha(await readFile(join(out,'libtbc_keyless_native.so'))),identity.keylessHashes['android/'+abi+'/libtbc_keyless_native.so']);
await writeFile(join(out,'sdk.jar'),zip('classes.jar'));await mkdir(join(out,'classes'));
const androidJar=join(android,'platforms/android-36/android.jar');
await log('java','javac',['-source','17','-target','17','-cp',[androidJar,join(out,'sdk.jar'),...jars].join(':'),'-d',join(out,'classes'),join(root,'keyless/KeylessProbe.java')]);
run('jar',['cf',join(out,'probe.jar'),'-C',join(out,'classes'),'.']);
await log('dex',join(android,'build-tools/36.0.0/d8'),['--lib',androidJar,'--min-api','26','--output',join(out,'probe.zip'),join(out,'probe.jar'),join(out,'sdk.jar'),...jars]);
const remote='/data/local/tmp/tbc-keyless-'+out.split('/').at(-1);run(adb,['-s',serial,'shell','mkdir',remote]);
for(const p of ['probe.zip','vectors.json','libtbc_engine_native.so','libtbc_engine_jni.so','libtbc_keyless_native.so'])run(adb,['-s',serial,'push',join(out,p),remote+'/'+p]);
run(adb,['-s',serial,'shell','chmod','444',remote+'/probe.zip']);
const androidResult=await log('android-runtime',adb,['-s',serial,'shell',`CLASSPATH=${remote}/probe.zip app_process -Djava.library.path=${remote} /system/bin io.tbc.validation.KeylessProbe ${remote}/vectors.json ${identity.artifactSetId}`]);assert.ok(androidResult.includes(`KEYLESS_ANDROID_PASS cases=${vectors.length} concurrent=16`));
assert.match(remote,/^\/data\/local\/tmp\/tbc-keyless-keyless-check-[A-Za-z0-9]+$/);
run(adb,['-s',serial,'shell','rm',...['probe.zip','vectors.json','libtbc_engine_native.so','libtbc_engine_jni.so','libtbc_keyless_native.so'].map(p=>remote+'/'+p)]);
run(adb,['-s',serial,'shell','rmdir',remote]);
const report={status:'PASS',sdkVersion:identity.sdkVersion,artifactSetId:identity.artifactSetId,keylessArtifactSetId:identity.keylessArtifactSetId,sourceSha256:identity.keylessSourceSha256,aarSha256:sha(await readFile(aar)),vectorsSha256:sha(await readFile(join(out,'vectors.json'))),vectors:vectors.length,specialSourceVectors,associatedHtlcVectors,currentAssociatedVectors,currentAssociatedFixtureSha256,controllerVectors,controllerFixtureSha256,reviewedAdminVectors,reviewedAdminFixtureSha256,rawAdminFixtureSha256,acceptanceScriptSha256:sha(await readFile(import.meta.filename)),validOperations:[...new Set(vectors.map(v=>v.method))],concurrentPerPlatform:16,ios:{udid,result:iosResult.trim()},android:{serial,abi,result:androidResult.trim(),probeFilesCleaned:true},coreLogicChanged:false,appInstalled:false,broadcasts:0,fullWalletAcceptance:false,out};
if(refundEvidence)report.refundEvidence=refundEvidence;
if(lpReceiptEvidence)report.lpReceiptEvidence=lpReceiptEvidence;
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
