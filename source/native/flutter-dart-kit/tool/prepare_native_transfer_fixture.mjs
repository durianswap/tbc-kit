// Generate an offline oracle from the immutable Kit archive, not current TS
// source or the Dart implementation. Public synthetic descriptors; no network.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const archive=join(repo,'release/kit-amm4-20261011/tbc-kit-0.1.0-platform-slim.20261011.4.tgz');
const sha=b=>createHash('sha256').update(b).digest('hex');
const archiveSha256=sha(await readFile(archive));
assert.equal(archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
const work=await mkdtemp('/private/tmp/tbc-dart-native-reference-');
execFileSync('tar',['-xzf',archive,'-C',work]);
await symlink(join(repo,'node_modules'),join(work,'node_modules'),'dir');
const kit=await import(pathToFileURL(join(work,'package/dist/esm/wallet.node.js')));
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>sha(canonical(v));
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const id=n=>n.toString(16).padStart(64,'0');
const row=(n,value,height=990)=>({txid:id(n),index:0,value:String(value),height});
const specs=[
 {name:'transfer-single',type:'tbc.transfer',amount:'1000',rows:[row(2,5000000),row(1,20000)]},
 {name:'transfer-multiple',type:'tbc.transfer',amount:'27000',rows:[row(2,8000),row(1,20000)]},
 {name:'transfer-exact-requested',type:'tbc.transfer',amount:'1000',rows:[row(2,5000000),row(1,20000)],points:[{txid:id(2),vout:0}]},
 {name:'merge-two',type:'tbc.maintenance.merge',rows:[row(2,5000000),row(1,20000)]},
 {name:'merge-limit',type:'tbc.maintenance.merge',rows:Array.from({length:101},(_,i)=>row(i+1,(102-i)*1000))},
 {name:'mainnet-transfer',network:'mainnet',type:'tbc.transfer',amount:'1000',rows:[row(1,20000)]},
 {name:'insufficient',type:'tbc.transfer',amount:'1000',rows:[row(1,1079)]},
 {name:'merge-single-rejected',type:'tbc.maintenance.merge',rows:[row(1,20000)]},
 {name:'missing-explicit',type:'tbc.transfer',amount:'1000',rows:[row(1,20000)],points:[{txid:id(9),vout:0}]},
 {name:'merge-explicit-not-supported',type:'tbc.maintenance.merge',rows:[row(1,20000),row(2,20000)],points:[{txid:id(1),vout:0}]},
 {name:'duplicate-index',type:'tbc.transfer',amount:'1000',rows:[row(1,20000),row(1,20000)]},
 {name:'future-height',type:'tbc.transfer',amount:'1000',rows:[row(1,20000,1001)]},
];
const cases=[];
for(const spec of specs){
 const network=kit.createTbcNetworkContext({network:spec.network??'testnet'});
 const account={accountId:`${network.chainId}:${address}`,address,publicKey,chainId:network.chainId};
 const now='2026-10-12T12:00:00.123Z',snapshotId='native-'+spec.name,trace=[];
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},[`/api/tbc/utxo/address/${address}`]:{utxos:spec.rows}};
 const api=kit.createDefaultTbcNetwork({network,accounts:{current:async()=>[account]},now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  fetch:async(input,init)=>{assert(!init?.method||init.method==='GET');const path=new URL(String(input)).pathname;trace.push(path);assert(replies[path],path);return new Response(JSON.stringify({code:'200',data:replies[path]}));}});
 const request={version:'1.0',chainId:network.chainId,from:address,intent:{version:'1.0',type:spec.type,...(spec.amount?{to:address,amount:spec.amount}:{})},constraints:{maxFee:'100000',...(spec.points?{inputOutpoints:spec.points}:{})}};
 const requirement={intentType:spec.type,assets:[{kind:'native',...(spec.amount?{minimumAmount:spec.amount}:{})}],includeAncestry:spec.type==='tbc.transfer',...(spec.amount?{nativeAmount:spec.amount}:{}),...(spec.points?{inputOutpoints:spec.points}:{})};
 const snapshot=await api.chainData.resolve({version:'1.0',accountId:account.accountId,chainId:account.chainId,requirement},account);
 const policy=snapshot?.snapshotHash?await api.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash}):null;
 cases.push({name:spec.name,network:spec.network??'testnet',now,snapshotId,request,account,replies,trace,snapshot,policy});
}
const report={status:'FROZEN_KIT_NATIVE_TRANSFER_ORACLE',archiveSha256,kitVersion:'0.1.0-platform-slim.20261011.4',publicFixtureOnly:true,networkHttp:0,broadcasts:0,cases};
await writeFile(join(base,'test/fixtures/native-transfers.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,reference:work,cases:cases.map(c=>({name:c.name,reads:c.trace.length,snapshot:c.snapshot?.portError??'ok',policy:c.policy?.portError??'ok'}))}));
