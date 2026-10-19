// Public, synthetic holder-use oracles from the immutable Kit/WASM. Never
// enable stablecoin administration in the candidate or send network requests.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {frozenOracle,base,repo,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),sources={},cases=[];
async function fixture(path){const b=await readFile(join(repo,path));sources[path]=sha(b);return JSON.parse(b);}
const coin=await fixture('packages/tbc-engine/rust/fixtures/coin-proof.json');
assert.deepEqual(coin.upstream.publicScalars,[1,2]);
const inspect=raw=>o.api.inspectTbcTransaction(raw).transaction,txid=raw=>o.api.turingTransactionId(raw);
const raw={},remember=r=>{const id=txid(r);raw[id]=r;return id;};
for(const v of coin.vectors){remember(v.parentRaw);remember(v.signedRaw);for(const a of v.ancestorsRaw)remember(a);}
const first=coin.vectors.find(v=>v.id==='first-0'),contract=txid(first.ancestorsRaw[0]);
const native=[{txid:'22'.repeat(32),index:0,value:'10000000',height:990}];
function decode(rawTransaction,id){
 const tx=inspect(rawTransaction);return {hex:rawTransaction,txid:id,confirmations:11,
  vin:tx.inputs.map(i=>({txid:i.txid,vout:i.vout})),
  vout:tx.outputs.map((o,n)=>({n,valueSat:o.satoshis.toString(),scriptPubKey:{hex:Buffer.from(o.scriptPubKey).toString('hex'),addresses:[]}}))};
}
async function pairs(id){
 const tx=inspect(raw[id]),rows=[];
 for(let i=0;i<tx.outputs.length-1;i++){
  if(tx.outputs[i].satoshis!==500n||tx.outputs[i+1].satoshis!==0n)continue;
  const result=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'identifyPairs',pairs:[{codeScript:Buffer.from(tx.outputs[i].scriptPubKey).toString('hex'),codeSatoshis:500,tapeScript:Buffer.from(tx.outputs[i+1].scriptPubKey).toString('hex'),tapeSatoshis:0}]})));
  const identity=result.identities[0];assert.equal(identity.family,'tbc20Stablecoin');
  rows.push({txid:id,index:i,tbc_value:'500',ft_value:identity.balanceRaw,height:990});
 }
 assert(rows.length);return rows;
}
async function capture(name,{contract,rows,intent,stateTxid,unknownHeight=false,minConfirmations='0',constraints={}}){
 const trace=[],snapshotId='stablecoin-'+name;
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32),mediantime:1800000000},
  [`/api/tbc/utxo/address/${address}`]:{utxos:native},
  [`/api/tbc/stablecoin/utxo/combinescript/751e76e8199196d454941c45d1b3a323f1433bd600/stablecoinid/${contract}`]:{utxos:rows.map(row=>unknownHeight?Object.fromEntries(Object.entries(row).filter(([k])=>k!=='height')):row)},
  ...Object.fromEntries(Object.entries(raw).flatMap(([id,txraw])=>[['/api/tbc/txraw/txid/'+id,{txraw}],['/api/tbc/decode/txid/'+id,decode(txraw,id)]])),
  ...(stateTxid?{['/api/tbc/stablecoin/info/stablecoinid/'+contract]:{stablecoin_id:contract,utxo:{txid:stateTxid,vout:0}}}:{}),
 };
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  confirmationPolicy:{minConfirmations},fetch:async(input,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(input)).pathname;trace.push(path);assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',contractId:contract,...intent},constraints:{maxFee:'10000',...constraints}};
 const amount=intent.type.endsWith('.merge')?undefined:(intent.amount??intent.receivers.reduce((sum,r)=>sum+BigInt(r.amount),0n).toString());
 const requirement={intentType:intent.type,includeAncestry:true,contractIds:[contract],...(constraints.inputOutpoints?{inputOutpoints:constraints.inputOutpoints}:{}),
  ...(intent.payment?{nativeAmount:intent.payment.amount}:{}),assets:[{kind:'native',...(intent.payment?{minimumAmount:intent.payment.amount}:{})},{kind:'stablecoin',contractId:contract,...(amount?{minimumAmount:amount}:{})}]};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash,name+JSON.stringify(policy));
 const signed=await o.sign(name,request,snapshot,policy),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name,version:snapshot.payload.contracts[0].protocolVersion,reads:coldTrace.length,warm:trace.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
 return signed;
}
const issued=await pairs(txid(first.parentRaw)),split=await pairs(txid(first.signedRaw));
await capture('current-coin-transfer',{contract,rows:issued,intent:{type:'tbc20Stablecoin.transfer',to:address,amount:'250'}});
await capture('current-coin-receivers',{contract,rows:issued,intent:{type:'tbc20Stablecoin.transfer',receivers:[{to:address,amount:'250'},{to:address,amount:'300'}]}});
await capture('current-coin-payment',{contract,rows:issued,intent:{type:'tbc20Stablecoin.transfer',to:address,amount:'250',payment:{to:address,amount:'1000'}}});
await capture('current-coin-merge',{contract,rows:split,intent:{type:'tbc20Stablecoin.merge'}});
await capture('current-coin-unknown-zero',{contract,rows:issued,unknownHeight:true,intent:{type:'tbc20Stablecoin.transfer',to:address,amount:'250'}});
await capture('current-coin-positive-floor',{contract,rows:issued,unknownHeight:true,minConfirmations:'1',intent:{type:'tbc20Stablecoin.transfer',to:address,amount:'250'}});
// Extract only public synthetic history from an unchanged source test. The
// independent frozen WASM still validates every constructed usage transaction.
const logBytes=await readFile('/private/tmp/tbc-dart-stablecoin-source-oracle-20261012.log');
const log=logBytes.toString();assert(log.includes('test result: ok. 1 passed'));
const plans=log.split('\n').flatMap(line=>{const at=line.indexOf('UNIFIED_BUSINESS_WIRE:');return at<0?[]:[JSON.parse(line.slice(at+'UNIFIED_BUSINESS_WIRE:'.length))];})
 .filter(c=>c.method==='plan'&&c.input.request.intent.type.startsWith('tbc20Stablecoin.'));
const historical=new Map();for(const p of plans)if(!historical.has(p.input.request.intent.type))historical.set(p.input.request.intent.type,p.input);
assert.equal(historical.size,2);
for(const [type,input]of historical){
 assert.equal(input.snapshot.payload.account.publicKey,account.publicKey);
 for(const p of input.snapshot.payload.parents)assert.equal(remember(p.rawTransaction),p.txid);
 const c=input.snapshot.payload.contracts[0],indexed=input.snapshot.payload.utxos.filter(u=>u.classification==='stablecoin');
 const all=(await pairs(indexed[0].txid)).filter(r=>indexed.some(u=>u.txid===r.txid&&u.vout===r.index));
 const common={contract:c.contractId,rows:all,stateTxid:c.creationTxid};
 if(type.endsWith('.merge'))await capture('historical-stablecoin-merge',{...common,intent:{type}});
 else{
  await capture('historical-stablecoin-transfer',{...common,intent:{type,to:address,amount:'400'}});
  await capture('historical-stablecoin-payment',{...common,intent:{type,to:address,amount:'400',payment:{to:address,amount:'1000'}}});
 }
}
for(const path of ['packages/tbc-engine/rust/crates/tbc-engine-core/tests/nft_stablecoin.rs','packages/tbc-engine/rust/crates/tbc-engine-core/tests/support/unified_business.rs'])sources[path]=sha(await readFile(join(repo,path)));
await writeFile(join(base,'test/fixtures/stablecoin-signing.json'),JSON.stringify({status:'FROZEN_STABLECOIN_HOLDER_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sources,historicalPublicSourceLogSha256:sha(logBytes),publicScalarOneOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
