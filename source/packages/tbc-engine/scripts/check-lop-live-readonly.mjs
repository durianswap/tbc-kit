// Bounded real Testnet index/Code compatibility, never signing or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const [contractId]=process.argv.slice(2);
assert.match(contractId??'',/^[0-9a-f]{64}$/u,'Usage: verified public new-Coin asset ID');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({stdin:{contents:`export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createTbcOfficialApi} from './packages/kit/src/official-api.ts';`,resolveDir:root,loader:'ts'},
  bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const kit=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const keyless=await kit.createWasmTbcKeylessEngine(readFileSync(`${root}packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
let requests=0;
const fetchReadonly=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://api.tbcdev.org');assert.equal(init?.method??'GET','GET');
  assert.ok(/^\/api\/tbc\/(stablecoin\/info\/stablecoinid|txraw\/txid)\/[0-9a-f]{64}$/u.test(url.pathname));
  requests++;assert.ok(requests<=3,'Bounded identity check exceeds three GETs');
  return fetch(input,{...init,signal:AbortSignal.timeout(15000)});
};
const api=kit.createTbcOfficialApi({network:'testnet',fetch:fetchReadonly});
const info=await api.stablecoinInfo({stablecoin_id:contractId});
assert.equal(info.stablecoin_id,contractId);assert.match(info.utxo?.txid??'',/^[0-9a-f]{64}$/u);
const [issuer,parent]=await Promise.all([api.rawTransaction({txid:contractId}),api.rawTransaction({txid:info.utxo.txid})]);
const input={phase:'coinSample',issuer:{txid:contractId,rawTransaction:issuer.txraw},parent:{txid:info.utxo.txid,rawTransaction:parent.txraw}};
try{
  const sample=JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify(input)));
  assert.equal(sample.standardId,'tbc20-stablecoin');
  console.log(JSON.stringify({status:'LOP_LIVE_COIN_IDENTITY_PASS',contractId,stateTxid:info.utxo.txid,sample:{txid:sample.txid,vout:sample.vout},
    requests,signatures:0,broadcasts:0,scope:'trusted API plus local issuer-bound Code/Tape; not LOP lifecycle or node proof'}));
}catch(error){
  console.log(JSON.stringify({status:'LOP_LIVE_COIN_IDENTITY_BLOCKED',contractId,stateTxid:info.utxo.txid,reason:error.message,
    requests,signatures:0,broadcasts:0}));process.exitCode=1;
}
