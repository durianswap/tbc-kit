// Source-only parity gate: does not package, sign, fetch, broadcast or install.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const result=spawnSync('cargo',['test','--manifest-path','packages/tbc-engine/rust/Cargo.toml','-p','tbc-keyless-core','--test','contract_identification','--locked','--','--nocapture'],{
 cwd:root,env:{...process.env,TOKEN_IDENTIFICATION_DUMP_WIRE:'1'},encoding:'utf8',maxBuffer:16*1024*1024});
if(result.status!==0){process.stderr.write(result.stdout+result.stderr);process.exit(result.status??1);}
const records=result.stdout.split('\n').filter(l=>l.startsWith('TOKEN_IDENTIFICATION_WIRE:')).map(l=>JSON.parse(l.slice('TOKEN_IDENTIFICATION_WIRE:'.length)));
assert.ok(records.some(r=>r.result.identities.length===7));
const compiled=await build({stdin:{contents:`export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts'; export {identifyTbcFungibleContracts} from './packages/kit/src/contract-identification.ts'; export {resolveFungibleBusinessIntent} from './packages/kit/src/fungible-business-route.ts'; export {assertValidTws} from './packages/core/src/index.ts';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
const url=new URL('./.contract-identification-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===url?{url,shortCircuit:true}:next(s,c);},load(u,c,next){return u===url?{source:compiled.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
const {createWasmTbcKeylessEngine,identifyTbcFungibleContracts,resolveFungibleBusinessIntent,assertValidTws}=await import(url);hooks.deregister();
const bytes=await readFile(new URL('../rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm',import.meta.url));
const engine=await createWasmTbcKeylessEngine(bytes);let pairCount=0;
for(const record of records){
 assert.deepEqual(JSON.parse(await engine.execute('inspectTokenMaterial',JSON.stringify(record.input))),record.result);
 assert.deepEqual(await identifyTbcFungibleContracts(record.input.pairs,{engine}),record.result.identities);
 pairCount+=record.input.pairs.length;
}
const pair=records.find(r=>r.result.identities.length===7).input.pairs[0];
let rejected=0;
for(const bad of [{...pair,codeSatoshis:1},{...pair,tapeSatoshis:1},{...pair,tapeScript:'006a'}]){
 await assert.rejects(identifyTbcFungibleContracts([bad],{engine}));rejected++;
}
const recognized=records.find(r=>r.result.identities.length===7);let routed=0,unsupported=0;
for(const [index,identity]of recognized.result.identities.entries())for(const operation of ['transfer','merge']){
 const input={family:identity.family,contractId:'11'.repeat(32),operation,...(operation==='transfer'?{to:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',amount:'1'}:{})};
 if(identity.generation==='historical'&&identity.protocolVersion!==4){await assert.rejects(resolveFungibleBusinessIntent(input,[recognized.input.pairs[index]],{engine}));unsupported++;continue;}
 const result=await resolveFungibleBusinessIntent(input,[recognized.input.pairs[index]],{engine});
 assertValidTws('transactionRequest',{version:'1.0',chainId:'tbc:testnet',from:input.to??'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',intent:result.intent});routed++;
}
assert.equal(routed,8);assert.equal(unsupported,6);
console.log(JSON.stringify({status:'PASS',nativeWasmRecords:records.length,identifiedPairs:pairCount,malformedKnownPairsRejected:rejected,routedSchemaValidIntents:routed,recognizedUnsupportedOperations:unsupported,networkRequests:0,signatures:0,broadcasts:0,packaged:false}));
