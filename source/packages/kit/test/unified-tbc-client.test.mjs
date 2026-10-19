import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/client.ts',import.meta.url))],bundle:true,write:false,metafile:true,platform:'browser',format:'esm',target:'es2022'});
const url=new URL('../src/.unified-tbc-client-test.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===url?{url,shortCircuit:true}:next(s,c);},load(u,c,next){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
const {createTbcClient}=await import(url);hooks.deregister();
const FROM='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
async function connect(network='testnet',reject=false){
 const calls=[];let seq=0;
 const failure=new Error('test provider failure');
 const provider={async request(call){calls.push(call);if(call.method==='tbc_requestAccounts')return [FROM];if(reject)throw failure;return {test:true};},on(){},removeListener(){},destroy(){}};
 const wallet=await createTbcClient({network,provider,requestIdFactory:()=>`request-${++seq}`,api:{fetch:()=>{throw new Error('Unexpected data fetch by a light client');}}}).connect();
 return {wallet,calls,failure};
}

test('canonical TBC entry and compatibility names are one implementation',async()=>{
 const {wallet,calls}=await connect();
 assert.ok(Object.isFrozen(wallet.tbc));
 assert.equal(wallet.tbc.transfer,wallet.sendTbc);assert.equal(wallet.tbc.merge,wallet.maintenance.mergeTbc);
 const input={to:FROM,amount:'1000',constraints:{maxFee:'500',inputOutpoints:[{txid:'11'.repeat(32),vout:0}]}};
 await wallet.tbc.transfer(input);await wallet.sendTbc(input);await wallet.tbc.merge();await wallet.maintenance.mergeTbc({constraints:{maxFee:'700'}});
 assert.equal(calls.length,5,'one account request + exactly one Provider request per action');
 const sent=calls.slice(1);assert.ok(sent.every(c=>c.method==='tbc_sendTransaction'));
 assert.deepEqual(sent[0].params.intent,{type:'tbc.transfer',version:'1.0',to:FROM,amount:'1000'});
 assert.deepEqual(sent[1].params.intent,sent[0].params.intent);assert.deepEqual(sent[0].params.constraints,input.constraints);
 assert.deepEqual(sent[2].params.intent,{type:'tbc.maintenance.merge',version:'1.0'});assert.equal(sent[3].params.constraints.maxFee,'700');
 assert.deepEqual(sent.map(c=>c.params.clientRequestId),['request-1','request-2','request-3','request-4']);
 for(const c of sent){assert.equal(c.params.chainId,'tbc:testnet');assert.equal(c.params.from,FROM);assert.ok(Object.isFrozen(c.params.intent));}
 assert.deepEqual(input,{to:FROM,amount:'1000',constraints:{maxFee:'500',inputOutpoints:[{txid:'11'.repeat(32),vout:0}]}});
});

test('TBC canonical methods cannot be switched to another intent by untyped input',async()=>{
 const {wallet,calls}=await connect('mainnet');
 await wallet.tbc.transfer({to:FROM,amount:'1000',type:'tbc.ft.create',version:'bogus'});
 await wallet.tbc.merge({type:'tbc.pool.create',version:'bogus'});
 assert.deepEqual(calls.slice(1).map(c=>[c.params.chainId,c.params.intent.type,c.params.intent.version]),[
  ['tbc:mainnet','tbc.transfer','1.0'],['tbc:mainnet','tbc.maintenance.merge','1.0']]);
});

test('canonical TBC rejection does not retry an old alias or fetch a fallback',async()=>{
 const {wallet,calls,failure}=await connect('testnet',true);
 await assert.rejects(wallet.tbc.transfer({to:FROM,amount:'1'}),error=>error===failure);
 await assert.rejects(wallet.tbc.merge(),error=>error===failure);assert.equal(calls.length,3);
});

test('wallet-built TBC methods never fetch or initialize WASM',async t=>{
 const fail=()=>{throw new Error('Unexpected Engine initialization or HTTP fetch');};
 t.mock.method(globalThis,'fetch',fail);t.mock.method(WebAssembly,'compile',fail);t.mock.method(WebAssembly,'instantiate',fail);
 const {wallet,calls}=await connect();await wallet.tbc.transfer({to:FROM,amount:'1'});await wallet.tbc.merge();assert.equal(calls.length,3);
 // Lazy JS inspection adapters are allowed, actual binaries and the legacy
 // contract SDK must not be embedded in this lightweight client bundle.
 const inputs=Object.keys(bundled.metafile.inputs);
 assert.ok(inputs.every(path=>!/(?:\.wasm$|tbc-contract\/|tbc-lib-js\/)/u.test(path)),inputs.join('\n'));
});
