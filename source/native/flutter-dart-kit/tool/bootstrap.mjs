// One-time, provenance-checked mechanical extraction; never alters predecessors.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..'),p5=join(root,'native/flutter-dart-live-token-exploration');
const sha=b=>createHash('sha256').update(b).digest('hex'),json=async p=>JSON.parse(await readFile(p));
const sealFile=join(p5,'evidence/sealed-final-20261012-b/seal.json'),seal=await json(sealFile);
assert.equal(seal.status,'P5_SEALED_DUAL_CONFIRMED_LOCAL_CANDIDATE');assert(seal.goalComplete);
const protectedFiles={...seal.protectedFiles};
for(const [p,h] of Object.entries(seal.sourceHashes))protectedFiles[join(p5,p)]=h;
for(const f of ['seal.json','completion.json','report.json']){const p=join(p5,'evidence/sealed-final-20261012-b',f);protectedFiles[p]=sha(await readFile(p));}
for(const a of Object.values(seal.artifacts))protectedFiles[a.path]=a.sha256;
for(const [p,h] of Object.entries(protectedFiles))assert.equal(sha(await readFile(p)),h,p);
assert.equal(sha(await readFile(seal.frozenKit.path)),seal.frozenKit.sha256);
const bridge=join(root,'release/flutter-native-bridge-20261012-b/tbc_kit_flutter');
const receipt=await json(join(root,'release/flutter-amm4-handoff2-20261012/receipt.json'));
const kitDir=join((await json(join(root,'native/flutter-dart-token-exploration/evidence/reference-20261012/captured.json'))).out,'package');
// Extract the contract catalogue directly from the pinned archive, not mutable sources.
const catalogueBytes=execFileSync('tar',['-xOf',seal.frozenKit.path,'package/dist/esm/business-capabilities.js']);
assert.equal(sha(await readFile(join(kitDir,'dist/esm/business-capabilities.js'))),sha(catalogueBytes));
const catalogue=await import(pathToFileURL(join(kitDir,'dist/esm/business-capabilities.js')));
const acceptance=join(root,'release/flutter-amm4-handoff2-20261012/docs/acceptance.md');
const text=await readFile(acceptance,'utf8'),methods=[...text.matchAll(/`((?:tbc|wallet)_[A-Za-z]+)`/g)].map(m=>m[1]);
assert.equal(new Set(methods).size,22);
const prototypeMethods=new Set(['tbc_chainId','tbc_accounts','tbc_getAccount','tbc_getCapabilities','wallet_getPermissions','wallet_requestPermissions','tbc_requestAccounts','tbc_disconnect','tbc_signMessage','tbc_signTransaction']);
const excluded=new Set(['tbc.collection.create','tbc20-stablecoin-create','tbc20-stablecoin-mint','tbc20-stablecoin-freeze','tbc20-stablecoin-unfreeze']);
const provider=[...new Set(methods)].map(name=>({name,required:true,candidate:'not-integrated',reference:'accepted-handoff-representative',predecessor:prototypeMethods.has(name)?'limited-P5-prototype-only':'not-in-P5',evidence:[]}));
const intents=catalogue.TBC_KIT_WALLET_INTENTS.map(name=>({name,required:!excluded.has(name),reason:excluded.has(name)?'Partner scope excludes historical creation and stablecoin administration':null,candidate:excluded.has(name)?'excluded':'not-integrated',predecessor:name==='tbc20.transfer'?'P5-current-template-one-transaction-live-confirmed':'not-in-P5',evidence:[]}));
const matrix={status:'F0_SCOPE_FROZEN_NOT_IMPLEMENTED',source:{acceptance:acceptance.slice(root.length+1),sha256:sha(await readFile(acceptance)),kit:receipt.kit,catalogueSha256:sha(catalogueBytes)},provider,intents,templateProfiles:catalogue.TBC_KIT_UNIFIED_TEMPLATE_SUPPORT,legacy:{required:true,candidate:'not-integrated',rule:'Default switchable compatibility; map included operations to shared new lifecycle; excluded creation/admin/multisig stay unsupported.'},proofLevels:['source','frozen-output-parity','package-consumer','native-lifecycle','representative-Testnet-confirmed','matched-performance'],notes:['Aliases are separate interface rows, not extra business capabilities.','P5 supports only the current TBC20 template and bounded single-transaction transfer.','Accepted Kit results are a comparison baseline, not acceptance of the new Dart package.','Do not expose excluded catalogue entries through a fallback.']};
const provenance=[];
async function save(path,data){await mkdir(dirname(path),{recursive:true});await writeFile(path,data,{flag:'wx'});}
const copies=[
 ['configuration.dart',join(bridge,'lib/src/configuration.dart')],
 ['internal/protocol_codec.dart',join(p5,'lib/pilot_codec.dart')],
 ['internal/native_compute.dart',join(p5,'lib/compute_probe.dart')],
 ['internal/transaction_read.dart',join(p5,'lib/transaction_read.dart')],
 ['internal/tbc20_material.dart',join(p5,'lib/tbc20_material.dart')],
];
for(const [to,from] of copies){
 const original=await readFile(from),target=join(base,'lib/src',to);
 const result=original.toString().replaceAll("'pilot_codec.dart'","'protocol_codec.dart'");
 await save(target,result);provenance.push({source:from.slice(root.length+1),sourceSha256:sha(original),destination:'lib/src/'+to,sha256:sha(result),change:'Import filename only; implementation retained'});
}
await save(join(base,'scope-matrix.json'),JSON.stringify(matrix,null,2)+'\n');
await save(join(base,'evidence/f0-baseline.json'),JSON.stringify({status:'F0_PINNED_AND_MECHANICAL_EXTRACTION_COMPLETE',recordedAt:new Date().toISOString(),predecessor:sealFile,protectedFiles,frozenKit:seal.frozenKit,provenance,providerMethods:provider.length,requiredIntentRows:intents.filter(r=>r.required).length,excludedIntentRows:intents.filter(r=>!r.required).length,published:false,productionReplacement:false},null,2)+'\n');
console.log(JSON.stringify({status:'F0_PINNED_AND_MECHANICAL_EXTRACTION_COMPLETE',protectedFiles:Object.keys(protectedFiles).length,extractedSources:provenance.length,providerMethods:provider.length,requiredIntentRows:intents.filter(r=>r.required).length,excludedIntentRows:intents.filter(r=>!r.required).length}));
