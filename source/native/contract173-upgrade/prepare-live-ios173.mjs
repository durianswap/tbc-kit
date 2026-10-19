// Maintainer-only isolated private Testnet consumer; never a partner package.
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,unlink,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pairedNativeSource,verifiedDartNativeCandidate} from './dart-native-candidate.mjs';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'native/flutter-dart-kit');
const [sdkArg,outArg,candidateArg,runId,planArg]=process.argv.slice(2);
assert(runId&&/^[a-z0-9-]{1,100}$/.test(runId));
const sdk=resolve(sdkArg),out=resolve(outArg),candidate=resolve(candidateArg);
assert.match(out,/^\/private\/tmp\/tbc-dart-kit-f3-contract173-ios-live-[a-z]+$/);
const manifest=await verifiedDartNativeCandidate(candidate);
const account=JSON.parse(await readFile(join(root,'native/flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json'))).accounts.ios;
const plan=planArg?JSON.parse(await readFile(resolve(planArg))):{id:runId,method:'tbc_sendTransaction',request:{version:'1.0',chainId:'tbc:testnet',from:account.address,intent:{version:'1.0',type:'tbc.transfer',to:account.address,amount:'1000'},constraints:{maxFee:'5000'}}};
assert.equal(plan.id,runId);assert.equal(plan.method,'tbc_sendTransaction');
assert.equal(plan.request.chainId,'tbc:testnet');assert.equal(plan.request.from,account.address);
assert(['tbc.transfer','tbc20-standard-create','tbc20.transfer','tbc-amm-create','tbc-amm-add-liquidity','tbc-amm-swap','tbc-amm-remove-liquidity'].includes(plan.request.intent.type));
assert(BigInt(plan.request.constraints.maxFee)<=100000n);
execFileSync(process.execPath,[join(base,'tool/prepare_consumer.mjs'),sdk,out,'ios','contract173',candidate],{cwd:root,stdio:'inherit'});
// This generator owns the new directory. Drop unused public fixture assets and
// fixture signer source before compilation, not any shared/frozen source.
for(const file of await readdir(join(out,'assets')))if(file!=='native-hashes.json')await unlink(join(out,'assets',file));
await unlink(join(out,'ios/Runner/FixtureWallet.swift'));
const sourceHashes={};
for(const file of ['main.dart','AppDelegate.swift','PrivateTestnetWallet.swift']){
 const input=await readFile(join(import.meta.dirname,'live',file));sourceHashes[file]=sha256(input);
 await writeFile(join(out,file==='main.dart'?'lib/main.dart':'ios/Runner/'+file),pairedNativeSource(file,input,manifest));
}
const page=(await readFile(join(base,'acceptance/dapp.html'),'utf8')).replaceAll('io.tbc.dartkit.f1','io.tbc.dartkit.contract173').replace('Public-fixture verification · NO broadcast','Private Testnet acceptance · one-shot broadcast');
await writeFile(join(out,'assets/dapp.html'),page);
await writeFile(join(out,'assets/live-plan.json'),JSON.stringify(plan));
await writeFile(join(out,'ios/Runner/native-account.json'),JSON.stringify(account));
execFileSync('ruby',['-rxcodeproj','-e',`
p=Xcodeproj::Project.open('ios/Runner.xcodeproj');t=p.targets.find{|x|x.name=='Runner'};g=p.main_group.find_subpath('Runner')
if old=g.files.find{|x|x.path=='FixtureWallet.swift'};old.remove_from_project;end
t.source_build_phase.add_file_reference(g.new_file('PrivateTestnetWallet.swift'))
t.resources_build_phase.add_file_reference(g.new_file('native-account.json'))
t.build_configurations.each{|c|c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']='io.tbc.dartkit.contract173'}
p.save
`],{cwd:out,stdio:'inherit'});
const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
provenance.publicFixtureOnly=false;provenance.privateTestnetOnly=true;provenance.bundleId='io.tbc.dartkit.contract173';
provenance.liveHarness={sourceHashes,planSha256:sha256(JSON.stringify(plan)),runId,endpoint:'https://devapi.tbcdev.org',scope:'Native account/approval/signer adapter only. Production Dart/Swift host, default HTTPS reads and native broadcast unchanged.'};
await writeFile(join(out,'consumer-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({status:'PRIVATE_TESTNET_CONSUMER_PREPARED',out,runId,account:account.address,kitIdentity:manifest.kitIdentity}));
