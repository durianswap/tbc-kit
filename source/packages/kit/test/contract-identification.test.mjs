import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/contract-identification.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'esm'});
const {identifyTbcFungibleContracts:identify,identifyTbcFungibleOrigin:identifyOrigin,identifyTbcNftOrigin:identifyNftOrigin,identifyTbcPoolOrigin:identifyPoolOrigin}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const material={codeScript:'51',codeSatoshis:500,tapeScript:'006a',tapeSatoshis:0};
const current={family:'tbc20',generation:'current',protocol:'tbc20-standard',protocolVersion:1,standardId:'tbc20-standard',codeIdentity:'11'.repeat(32)+'a30b',balanceRaw:'10',verification:'exact-template',assetIdentityVerified:false};

test('one local batch deduplicates exact pairs and preserves input positions before await',async()=>{
 let calls=0,finish;
 const pending=new Promise(resolve=>{finish=resolve;});const source={...material};
 const resultPromise=identify([source,{...material},{...material,codeScript:'52'}],{engine:{async execute(op,json){calls++;assert.equal(op,'inspectTokenMaterial');assert.deepEqual(JSON.parse(json),{phase:'identifyPairs',pairs:[material,{...material,codeScript:'52'}]});await pending;return JSON.stringify({identities:[current,null]});}}});
 source.codeScript='53';finish();const result=await resultPromise;
 assert.equal(calls,1);assert.deepEqual(result,[current,current,null]);assert.equal(result[0],result[1]);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result[0]));
});
test('invalid native response fails closed and is never retried',async()=>{
 for(const result of [{}, {identities:[]}, {identities:[{...current,assetIdentityVerified:true}]},
  {identities:[{...current,generation:'historical'}]}, {identities:[{...current,protocolVersion:4}]},
  {identities:[{...current,balanceRaw:'-1'}]}, {identities:[{...current,codeIdentity:'11'.repeat(32)}]},
  {identities:[{...current,protocol:'legacy-stablecoin',family:'tbc20Stablecoin',generation:'historical',protocolVersion:4}]}]){
  let calls=0;await assert.rejects(identify([material],{engine:{async execute(){calls++;return JSON.stringify(result);}}}));assert.equal(calls,1);
 }
 const failure=new Error('unsupported source phase');let calls=0;
 await assert.rejects(identify([material],{engine:{async execute(){calls++;throw failure;}}}),e=>e===failure);assert.equal(calls,1);
});
test('invalid material and permission-like extras are rejected before engine execution',async()=>{
 let calls=0;const options={engine:{async execute(){calls++;throw new Error('must not call');}}};
 for(const pairs of [[],Array(257).fill(material),[{...material,codeScript:'AB'}],[{...material,codeSatoshis:0.5}],
  [{...material,administrator:true}],[{...material,inputLock:{sequence:0,transactionLockTime:0}}],
  [{...material,get codeScript(){throw new Error('accessor must not execute');}}]]){
  await assert.rejects(identify(pairs,options),e=>e instanceof TypeError);
 }assert.equal(calls,0);
});
test('recognized historical templates do not inherit a current standard label',async()=>{
 const {standardId,...base}=current;
 const historical={...base,protocol:'legacy-ft',generation:'historical',protocolVersion:4};
 assert.deepEqual(await identify([material],{engine:{async execute(){return JSON.stringify({identities:[historical]});}}}),[historical]);
});

test('origin selection hint rejects non-string identities before coercion or Engine access',async()=>{
 let calls=0,coercions=0;
 const options={engine:{async execute(){calls++;throw new Error('must not call');}}};
 const disguised={toString(){coercions++;return '11'.repeat(32);}};
 for(const id of [disguised,null,undefined,11,'AA'.repeat(32),'11'.repeat(31)]){
  await assert.rejects(identifyOrigin(id,'00',options),TypeError);
 }
 for(const raw of ['', '0', 'AB', '00'.repeat(1_048_577), disguised]){
  await assert.rejects(identifyOrigin('11'.repeat(32),raw,options),TypeError);
 }
 assert.equal(coercions,0);assert.equal(calls,0);
});

test('origin hints never grant authority and reject malformed codec replies without fallback',async()=>{
 const hint={family:'tbc20',generation:'current',verification:'origin-template',assetIdentityVerified:false};
 for(const reply of [null,[],{}, {...hint,assetIdentityVerified:true},{...hint,family:'tbc721'},
  {...hint,generation:'latest'},{...hint,extra:true},{...hint,family:['tbc20']}]){
  let calls=0;
  await assert.rejects(identifyOrigin('11'.repeat(32),'00',{engine:{async execute(){calls++;return JSON.stringify(reply);}}}),TypeError);
  assert.equal(calls,1);
 }
 const result=await identifyOrigin('11'.repeat(32),'00',{engine:{async execute(op,input){
  assert.equal(op,'inspectTokenMaterial');assert.deepEqual(JSON.parse(input),{phase:'identifyOrigin',contractId:'11'.repeat(32),rawTransaction:'00'});
  return JSON.stringify(hint);
 }}});
 assert.deepEqual(result,hint);assert.ok(Object.isFrozen(result));
});

test('NFT origin uses the same strict local boundary but never accepts a fungible or Coin identity',async()=>{
 const hint={family:'tbc721',generation:'historical',verification:'origin-template',assetIdentityVerified:false};
 let calls=0;
 const engine={async execute(op,json){calls++;assert.equal(op,'inspectTokenMaterial');assert.equal(JSON.parse(json).phase,'identifyNftOrigin');return JSON.stringify(hint);}};
 assert.deepEqual(await identifyNftOrigin('11'.repeat(32),'00',{engine}),hint);assert.equal(calls,1);
 await assert.rejects(identifyNftOrigin({toString(){throw Error('No coercion');}},'00',{engine}),TypeError);assert.equal(calls,1);
 for(const family of ['tbc20','tbc20Stablecoin',['tbc721']]){
  await assert.rejects(identifyNftOrigin('11'.repeat(32),'00',{engine:{async execute(){return JSON.stringify({...hint,family});}}}),TypeError);
 }
});

test('Pool origin reuses the AMM codec with strict family and no asset authority',async()=>{
 for(const generation of ['historical','current']){
  const hint={family:'amm',generation,verification:'origin-template',assetIdentityVerified:false};
  let calls=0;
  const result=await identifyPoolOrigin('11'.repeat(32),'00',{engine:{async execute(op,json){
   calls++;assert.equal(op,'inspectAmmMaterial');assert.deepEqual(JSON.parse(json),{phase:'identifyPoolOrigin',pool:{txid:'11'.repeat(32),rawTransaction:'00'}});return JSON.stringify(hint);
  }}});
  assert.equal(calls,1);assert.deepEqual(result,hint);assert.ok(Object.isFrozen(result));
  for(const reply of [{...hint,family:'tbc20'},{...hint,assetIdentityVerified:true},{...hint,version:3}]){
   await assert.rejects(identifyPoolOrigin('11'.repeat(32),'00',{engine:{async execute(){return JSON.stringify(reply);}}}),TypeError);
  }
 }
 let calls=0;
 await assert.rejects(identifyPoolOrigin('AA'.repeat(32),'00',{engine:{async execute(){calls++;}}}),TypeError);
 assert.equal(calls,0);
});
