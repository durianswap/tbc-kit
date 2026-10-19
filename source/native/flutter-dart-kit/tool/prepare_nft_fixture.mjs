// Offline synthetic current/historical NFT oracle. Historical public bytes come
// from the Rust test fixture; forbidden issuance stays disabled in runtime.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {frozenOracle,base,repo,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),sources={},cases=[];
async function fixture(path){const b=await readFile(join(repo,path));sources[path]=sha(b);return JSON.parse(b);}
const nft=await fixture('packages/tbc-engine/rust/fixtures/tbc721-standard-proof.json');assert.equal(nft.publicTestScalar,'1');
const script='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac';
const native=[{txid:'22'.repeat(32),index:0,value:'10000000',height:990}];
const inspect=raw=>o.api.inspectTbcTransaction(raw).transaction;
const txid=raw=>o.api.turingTransactionId(raw);
const raw={},remember=r=>{const id=txid(r);raw[id]=r;return id;};
async function capture(name,contract,current,{payment,minConfirmations='0',unknownHeight=false}={}){
 const snapshotId='nft-'+name,mint=inspect(raw[contract]),tx=inspect(raw[current]);
 const collection=mint.inputs[0].txid,code=Buffer.from(mint.outputs[0].scriptPubKey).toString('hex');
 const scriptHash=Buffer.from(sha(Buffer.from(code,'hex')),'hex').reverse().toString('hex');
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},
  [`/api/tbc/utxo/address/${address}`]:{utxos:native},
  [`/api/tbc/nft/utxo/scriptpubkeyhash/${scriptHash}`]:{utxos:[{txid:current,vout:0,value:200,...(unknownHeight?{}:{height:990}),nft_contract_id:contract,collection_id:collection,script_pubkey:code}]},
  ...Object.fromEntries(Object.entries(raw).map(([id,txraw])=>['/api/tbc/txraw/txid/'+id,{txraw}])),
  ['/api/tbc/decode/txid/'+current]:{txid:current,hex:raw[current],confirmations:11},
 };
 const statusBody={txos:[{txid:current,index:1}]},statusReply={results:[{txid:current,index:1,value:100,scriptpubkey:Buffer.from(tx.outputs[1].scriptPubKey).toString('hex'),status:{spent:false}}]},trace=[];
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},
  fetch:async(input,init)=>{const path=new URL(String(input)).pathname,method=init?.method??'GET';trace.push({method,path});
   if(path==='/api/tbc/txo/status'){assert.equal(method,'POST');assert.equal(canonical(JSON.parse(init.body)),canonical(statusBody));return new Response(JSON.stringify({code:200,data:statusReply}));}
   assert.equal(method,'GET');assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const request={version:'1.0',chainId:account.chainId,from:address,intent:{type:'tbc721.transfer',version:'1.0',contractId:contract,to:address,...(payment?{payment:{to:address,amount:payment}}:{})},constraints:{maxFee:'10000'}};
 const requirement={intentType:'tbc721.transfer',includeAncestry:true,contractIds:[contract],...(payment?{nativeAmount:payment}:{}),assets:[{kind:'native',...(payment?{minimumAmount:payment}:{})},{kind:'nft',contractId:contract,minimumAmount:'1'}]};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,replies,statusBody,statusReply,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
 return signed;
}
for(const v of nft.vectors){remember(v.grandparentRaw);remember(v.parentRaw);remember(v.signedRaw);}
const mint=txid(nft.vectors[0].parentRaw),descendant=txid(nft.vectors[0].signedRaw);
await capture('current-nft-mint-output',mint,mint);
await capture('current-nft-descendant',mint,descendant);
await capture('current-nft-payment',mint,descendant,{payment:'1000'});
await capture('current-nft-unknown-zero',mint,mint,{unknownHeight:true});
// Source tests provide public historical bytes without enabling forbidden
// issuance in the frozen runtime. The frozen WASM independently validates usage.
const historical=await fixture('native/flutter-dart-kit/test/fixtures/historical-nft-source.json');
for(const c of historical.cases){
 assert.equal(c.account.address,address);assert.equal(c.account.publicKey,account.publicKey);
 for(const p of c.parents)assert.equal(remember(p.rawTransaction),p.txid);
 const id=c.contract.contractId,current=c.contract.currentOutpoint.txid;
 const s=await capture('historical-nft-'+c.name,id,current);
 const child=s.result.transactions[0];remember(child.rawTransaction);
 await capture('historical-nft-'+c.name+'-descendant',id,child.txid);
}
await writeFile(join(base,'test/fixtures/nft-signing.json'),JSON.stringify({status:'FROZEN_NFT_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sources,publicScalarOneOnly:true,networkHttp:0,broadcasts:0,historicalSeedOnly:true,cases},null,2)+'\n',{flag:'wx'});
