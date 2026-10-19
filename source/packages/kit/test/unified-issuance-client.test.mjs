import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/client.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022'});
const url=new URL('../src/.unified-issuance-test.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===url?{url,shortCircuit:true}:next(s,c);},load(u,c,next){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
const {createTbcClient}=await import(url);hooks.deregister();
const FROM='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',ID='11'.repeat(32);
async function connect(network='testnet',fail=false){
 const calls=[],error=new Error('No fallback');let seq=0;
 const provider={async request(call){calls.push(call);if(call.method==='tbc_requestAccounts')return [FROM];if(fail)throw error;return {ok:true};},on(){},removeListener(){},destroy(){}};
 const wallet=await createTbcClient({network,provider,requestIdFactory:()=>`issuance-${++seq}`}).connect();return {wallet,calls,error};
}
test('canonical latest issuance and administration share the exact old function references',async()=>{
 const {wallet,calls}=await connect();
 assert.equal(typeof wallet.tbc20?.create,'function');assert.ok(Object.isFrozen(wallet.tbc20));
 assert.equal(wallet.tbc20.create,wallet.createTbc20);assert.ok(Object.isFrozen(wallet.tbc20Stablecoin));
 for(const method of ['create','mint','freeze','unfreeze'])assert.equal(wallet.tbc20Stablecoin[method],wallet.coin[method]);
 const roles=[{role:'coin-admin',accountId:'tbc:testnet:independent-admin'}];
 const constraints={maxFee:'2000'};
 const cases=[['create',{name:'Test',symbol:'T',decimals:0,initialSupply:'1000'}],
  ['mint',{contractId:ID,to:FROM,amount:'7'}],
  ['freeze',{contractId:ID,targetOutpoints:[{txid:ID,vout:0}],lockTime:'900000'}],
  ['unfreeze',{contractId:ID,targetOutpoints:[{txid:ID,vout:0}]}]];
 await wallet.tbc20.create({name:'Token',symbol:'TK',decimals:0,initialSupply:'100',constraints});
 for(const [method,fields] of cases){
  const input={...fields,signingRoles:roles,constraints};
  await wallet.tbc20Stablecoin[method](input);await wallet.coin[method](input);
  const [a,b]=calls.slice(-2);assert.deepEqual(a.params.intent,b.params.intent);assert.deepEqual(a.params.signingRoles,roles);
  assert.deepEqual(a.params.constraints,constraints);assert.equal(a.params.intent.signingRoles,undefined);
  assert.equal(a.params.intent.type,`tbc20-stablecoin-${method}`);assert.equal(a.params.intent.version,'1.0');
 }
 assert.equal(calls.length,10);assert.ok(calls.slice(1).every(c=>c.method==='tbc_sendTransaction'&&c.params.chainId==='tbc:testnet'&&c.params.from===FROM));
 assert.equal(new Set(calls.slice(1).map(c=>c.params.clientRequestId)).size,9);
});
test('untyped inputs cannot switch creation or administration to a historical intent',async()=>{
 const {wallet,calls}=await connect('mainnet');
 await wallet.tbc20.create({type:'tbc.ft.create',version:'old',name:'T'});
 for(const method of ['create','mint','freeze','unfreeze'])await wallet.tbc20Stablecoin[method]({type:'tbc.nft.mint',version:'old',contractId:ID});
 assert.deepEqual(calls.slice(1).map(c=>c.params.intent.type),['tbc20-standard-create',...['create','mint','freeze','unfreeze'].map(m=>`tbc20-stablecoin-${m}`)]);
 assert.ok(calls.slice(1).every(c=>c.params.chainId==='tbc:mainnet'&&c.params.intent.version==='1.0'));
});
test('light issuance client adds no network/engine initialization or failure retry',async t=>{
 const fail=()=>{throw Error('Unexpected chain read or Engine initialization');};
 t.mock.method(globalThis,'fetch',fail);t.mock.method(WebAssembly,'compile',fail);t.mock.method(WebAssembly,'instantiate',fail);
 const {wallet,calls,error}=await connect('testnet',true);
 await assert.rejects(wallet.tbc20.create({name:'T'}),e=>e===error);
 for(const method of ['create','mint','freeze','unfreeze'])await assert.rejects(wallet.tbc20Stablecoin[method]({contractId:ID}),e=>e===error);
 assert.equal(calls.length,6);
});

test('unified holder methods send one generic request and retain constraints, without client-side reads or retry',async t=>{
 const fail=()=>{throw Error('Unexpected chain read or Engine initialization');};
 t.mock.method(globalThis,'fetch',fail);t.mock.method(WebAssembly,'compile',fail);t.mock.method(WebAssembly,'instantiate',fail);
 for(const network of ['mainnet','testnet']){
  const {wallet,calls}=await connect(network);
  for(const family of ['tbc20','tbc20Stablecoin'])for(const op of ['transfer','merge']){
   const constraints={maxFee:'2000'};
   const input={contractId:ID,...(op==='transfer'?{receivers:[{to:FROM,amount:'2'}],payment:{to:FROM,amount:'3'}}:{}),constraints};
   await wallet[family][op](input);
   const call=calls.at(-1);assert.equal(call.method,'tbc_sendTransaction');
   const {constraints:ignored,...fields}=input;
   assert.deepEqual(call.params.intent,{...fields,type:`${family}.${op}`,version:'1.0'});
   assert.deepEqual(call.params.constraints,constraints);assert.equal(call.params.chainId,`tbc:${network}`);
  }
  assert.equal(calls.length,5);
  await wallet.tbc721.transfer({contractId:ID,to:FROM,payment:{to:FROM,amount:'24'},constraints:{maxFee:'2000'}});
  assert.equal(calls.at(-1).params.intent.type,'tbc721.transfer');
  assert.deepEqual(calls.at(-1).params.constraints,{maxFee:'2000'});
  await wallet.transferTbc20({contractId:ID,to:FROM,amount:'1'});
  assert.equal(calls.at(-1).params.intent.type,'tbc20-standard-transfer','explicit existing method does not change semantics');
 }
 const {wallet,calls,error}=await connect('testnet',true);
 for(const family of ['tbc20','tbc20Stablecoin'])for(const op of ['transfer','merge']){
  await assert.rejects(wallet[family][op]({contractId:ID,to:FROM,amount:'1'}),e=>e===error);
 }
 assert.equal(calls.length,5,'no old-method fallback after a rejected generic request');
 await assert.rejects(wallet.tbc721.transfer({contractId:ID,to:FROM}),e=>e===error);
 assert.equal(calls.length,6,'NFT rejection must not retry the concrete or historical method');
});

test('AMM business helpers preserve fields and controller roles through one generic call with no reads or fallback',async t=>{
 const fail=()=>{throw Error('Unexpected read or WASM initialization');};
 t.mock.method(globalThis,'fetch',fail);t.mock.method(WebAssembly,'compile',fail);t.mock.method(WebAssembly,'instantiate',fail);
 for(const network of ['testnet','mainnet']){
  const {wallet,calls}=await connect(network);
  const signingRoles=[{role:'pool-controller',accountId:`tbc:${network}:controller`}],constraints={maxFee:'9000'};
  const inputs={swap:{poolContractId:ID,direction:'ft-to-tbc',amount:'100',minimumOutput:'1'},
   addLiquidity:{poolContractId:ID,budgetAsset:'tbc',amount:'1000',minimumLpAmount:'1'},
   removeLiquidity:{poolContractId:ID,lpAmount:'100',minimumFtAmount:'1',minimumTbcAmount:'1'}};
  for(const [method,fields] of Object.entries(inputs)){
   await wallet.amm[method]({...fields,signingRoles,constraints});
   const call=calls.at(-1);assert.equal(call.method,'tbc_sendTransaction');
   assert.deepEqual(call.params.intent,{...fields,type:`amm.${method}`,version:'1.0'});
   assert.deepEqual(call.params.signingRoles,signingRoles);assert.deepEqual(call.params.constraints,constraints);
   assert.equal(call.params.chainId,`tbc:${network}`);
  }
  assert.equal(calls.length,4);
 }
 const {wallet,calls,error}=await connect('testnet',true);
 for(const method of ['swap','addLiquidity','removeLiquidity'])await assert.rejects(wallet.amm[method]({poolContractId:ID}),e=>e===error);
 assert.equal(calls.length,4,'rejection never retries a concrete or historical method');
});

test('LP and Pool maintenance names send generic requests while explicit old helpers keep their semantics',async t=>{
 const fail=()=>{throw Error('Light client must not load chain material');};
 t.mock.method(globalThis,'fetch',fail);t.mock.method(WebAssembly,'compile',fail);t.mock.method(WebAssembly,'instantiate',fail);
 const {wallet,calls}=await connect();
 for(const method of ['transfer','lock','unlock','merge','burn']){
  const fields={poolContractId:ID,...(method==='transfer'?{to:FROM,amount:'1'}:method==='lock'?{amount:'1',lockTime:'900000'}:{})};
  await wallet.tbc20Lp[method]({...fields,constraints:{maxFee:'2000'}});
  assert.deepEqual(calls.at(-1).params.intent,{...fields,type:`tbc20Lp.${method}`,version:'1.0'});
  assert.deepEqual(calls.at(-1).params.constraints,{maxFee:'2000'});
 }
 await wallet.amm.mergeToken({poolContractId:ID});assert.equal(calls.at(-1).params.intent.type,'amm.mergeToken');
 await wallet.lp.merge({poolContractId:ID});assert.equal(calls.at(-1).params.intent.type,'tbc20-lp-merge');
 await wallet.maintenance.mergeFtlp({poolContractId:ID});assert.equal(calls.at(-1).params.intent.type,'tbc.pool.ftlp.merge');
 const rejected=await connect('testnet',true);
 for(const method of ['transfer','lock','unlock','merge','burn'])await assert.rejects(rejected.wallet.tbc20Lp[method]({poolContractId:ID}),e=>e===rejected.error);
 await assert.rejects(rejected.wallet.amm.mergeToken({poolContractId:ID}),e=>e===rejected.error);
 assert.equal(rejected.calls.length,7,'No concrete or legacy fallback');
});
