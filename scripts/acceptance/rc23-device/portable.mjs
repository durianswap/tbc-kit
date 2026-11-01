import * as clientKit from '@frozen/client';
import * as walletKit from '@frozen/wallet';
import * as engineKit from '@frozen/engine';
import {assertTestnetAddress,turingTransactionId,inspectTbcTransaction} from '@frozen/api';
import {Buffer} from 'buffer';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {signControlledTask} from '@fixture/signer';
globalThis.Buffer=Buffer;
const kit={...clientKit,...walletKit,...engineKit};
const {createDefaultTbcChainDataResolver,hashCanonical}=kit;
const stable=v=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const assert={ok(v,m='assertion failed'){if(!v)throw Error(m)},equal(a,b,m='values differ'){if(a!==b)throw Error(m+': '+String(a)+' != '+String(b))},deepEqual(a,b,m='objects differ'){if(stable(a)!==stable(b))throw Error(m)},async rejects(p,check){try{await p}catch(e){if(check&&!check(e))throw Error('unexpected rejection: '+JSON.stringify({message:e.message,code:e.code,data:e.data}));return}throw Error('expected rejection')}};
const tests=[],metrics=[],nftMetrics=[],nativeCalls=[],results=[];
let activeTest='',seq=0;const pending=new Map();
function send(message){if(globalThis.TbcProbe)globalThis.TbcProbe.postMessage(JSON.stringify(message));else globalThis.webkit.messageHandlers.probe.postMessage(message)}
globalThis.__nativeComplete=(id,value,error)=>{const p=pending.get(id);if(!p)return;pending.delete(id);error?p.reject(Error(error)):p.resolve(value)};
async function nativeCall(family,method,input){const id=String(++seq),start=performance.now();try{return await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({kind:'call',id,family,method,input})})}finally{nativeCalls.push({test:activeTest,family,method,ms:performance.now()-start,inputBytes:input.length})}}
const native=kit.createNativeTbcKeylessEngine((m,i)=>nativeCall('keyless',m,i));
const backend=kit.createNativeTbcEngineBackend((m,i)=>nativeCall('engine',m,i));
function test(name,fn){tests.push({name,fn})}
/*FIXTURES*/
const row=fixture.cases.find(c=>!c.controlled&&!c.locked);
const zeroPoint={txid:'00'.repeat(32),vout:2};
const fixtureScalar='01'.padStart(64,'0'); // Published synthetic test scalar only.
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const account={address,chainId:'tbc:testnet',accountId:`tbc:testnet:${address}`,publicKey:Buffer.from(secp256k1.getPublicKey(fixtureScalar,true)).toString('hex')};
const nowMs=Date.parse('2026-11-01T00:00:00Z'),now=()=>new Date(nowMs).toISOString(),origin='https://controlled-port-errors.example';
// Fixture decoding only; all transaction planning/validation/finalization runs
// through the frozen Kit and actual iOS/Android Native SDK.
const tbc={Transaction:class{constructor(raw){this.outputs=inspectTbcTransaction(raw).transaction.outputs.map(o=>({satoshis:Number(o.satoshis),script:{toHex:()=>Buffer.from(o.scriptPubKey).toString('hex')}}))}}};
/*HOST_TESTS*/
{
/*NFT_TESTS*/
}
async function main(){
  const started=performance.now();
  for(const {name,fn} of tests){activeTest=name;document.querySelector('#status').textContent=`${results.length}/${tests.length}\n${name}`;const begin=performance.now();try{await fn({diagnostic(){}});results.push({name,status:'PASS',ms:performance.now()-begin})}catch(e){results.push({name,status:'FAIL',message:String(e.message).slice(0,900),ms:performance.now()-begin})}send({kind:'progress',text:JSON.stringify(results.at(-1))})}
  const report={status:results.every(r=>r.status==='PASS')?'PASS':'FAIL',kit:'0.1.0-rc.23',native:'0.1.0-rc.23.native.2',userAgent:navigator.userAgent,elapsedMs:performance.now()-started,tests:results,metrics,nftMetrics:nftMetrics.map(m=>({test:m.test,reads:m.calls,statusBatchLengths:m.batches.map(b=>b.length),maxStatusConcurrency:m.state.maxActive})),nativeCalls,network:'synthetic fixtures; network forbidden',signer:'public synthetic scalar; deterministic JS fixture signer',approval:'controlled approval adapter; one receipt per operation',realBroadcasts:0,physicalDevice:false};
  document.querySelector('#status').textContent=JSON.stringify({status:report.status,tests:results},null,2);send({kind:'report',text:JSON.stringify(report)});
}
main().catch(e=>send({kind:'report',text:JSON.stringify({status:'FAIL',message:String(e.message).slice(0,900)})}));
