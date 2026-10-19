// Pure request mapping from the immutable current Kit; metadata supplied by
// public test data, not network or a second Legacy material loader.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const base=resolve(import.meta.dirname,'..'),pkg=resolve(base,'../../release/kit-contract173-20261014-c/package');
const identity=await verifiedKitCandidate(pkg);
assert.equal(identity.artifactId,'9601507ee4961e9d99bac98984d112a80854b3ef8a979f8b0728f152ae335626');
const k=await import(pathToFileURL(join(pkg,'dist/esm/wallet.js')));
for(const name of ['legacyAtomicAmount','legacyDisplayAmount','createLegacyFtTransferIntentResolver','createLegacyStablecoinTransferIntentResolver','normalizeLegacyGenericBatchRequests','createTbcKitLegacyBatchSendResolver','createLegacyNftIntentResolver'])assert.equal(typeof k[name],'function',name);
const {account}=JSON.parse(await readFile(join(base,'test/fixtures/legacy-mapping.json')));
const cases=[],contract='AB'.repeat(32);
const ft=currentStandard=>k.createLegacyFtTransferIntentResolver({chainId:account.chainId,
 metadata:{network:{chainId:account.chainId},getFtInfo:async contractId=>({contractId,decimals:6,name:'Fixture',symbol:'FIX'})},
 resolveCurrentStandard:async()=>currentStandard});
async function add(name,kind,input,call,extra={}){
 let expected,error=false;try{expected=await call()}catch{error=true}
 cases.push({name,kind,input,...extra,...(error?{error:true}:{expected})});
}
const tbc=k.createTbcKitLegacyBatchSendResolver({chainId:account.chainId,transactions:{}});
const nft=k.createLegacyNftIntentResolver({chainId:account.chainId});
for(const [name,input] of Object.entries({
 valid:{flag:'NFT_TRANSFER',nft_contract_address:contract.toLowerCase(),address:account.address},
 uppercase:{flag:'NFT_TRANSFER',nft_contract_address:contract,address:account.address},
 badAddress:{flag:'NFT_TRANSFER',nft_contract_address:contract.toLowerCase(),address:'wrong'},
 extra:{flag:'NFT_TRANSFER',nft_contract_address:contract.toLowerCase(),address:account.address,endpoint:'wrong'},
}))await add('nft-'+name,'nft',input,()=>nft.resolve(input,account.address));
for(const value of [42,'42',0,-1,0.1,'01']){
 const input={flag:'P2PKH',address:account.address,satoshis:value,broadcastEnabled:false};
 await add(`tbc-${typeof value}-${value}`,'tbc',input,()=>tbc({params:input,chainId:account.chainId,from:account.address}));
}
for(const value of [0,1,1.25,0.000001,0.0000001,1e20,'0','1.230','18446744073709551615','18446744073709551616','01','-1']) {
 for(const decimals of [0,6]) {
  await add(`amount-${value}-${decimals}`,'amount',value,()=>k.legacyAtomicAmount(k.legacyDisplayAmount(value,true),decimals),{decimals});
 }
}
for(const currentStandard of [false,true])for(const amount of [1.25,'1.25','0.000001','0','1.0000001']) {
 const input={flag:'FT_TRANSFER',ft_contract_address:contract,address:account.address,ft_amount:amount,broadcastEnabled:false};
 await add(`ft-${currentStandard}-${typeof amount}-${amount}`,'ft',input,()=>ft(currentStandard).resolve(input,account.address),{decimals:6,currentStandard});
}
for(const currentStandard of [false,true]){
 const input={flag:'FT_TRANSFER',ft_contract_address:contract,address:account.address,ft_amount:'2',tbc_amount:'0.000001'};
 await add(`ft-attached-${currentStandard}`,'ft',[input],()=>ft(currentStandard).resolve([input],account.address),{decimals:6,currentStandard});
}
const stable=k.createLegacyStablecoinTransferIntentResolver({chainId:account.chainId,resolveDecimals:()=>6});
for(const amount of [1.25,'1.25','0','1.0000001']){
 const input={flag:'STABLECOIN_TRANSFER',ft_contract_address:contract,address:account.address,ft_amount:amount,tbc_amount:'0.000001'};
 await add(`stable-${typeof amount}-${amount}`,'stable',input,()=>stable.resolve(input,account.address),{decimals:6});
}
for(const input of [
 [{method:'sendTransaction',params:{flag:'FT_TRANSFER',ft_amount:1.25,broadcastEnabled:false}}],
 [{method:'sendTransaction',params:{flag:'FT_TRANSFER',ft_amount:0.1,broadcastEnabled:false}}],
])await add('decimal-batch-'+cases.length,'normalize',input,()=>k.normalizeLegacyGenericBatchRequests(input));
const report={status:'LEGACY_BUSINESS_MAPPING_FROZEN_KIT_ORACLE',kitIdentity:identity,account,cases,
 proof:'Network-bound metadata decimals are fixture inputs, no metadata cache/integration claim. Source standard selection still requires shared authenticated metadata; zero reads, approvals, key use or broadcast.'};
const dest=join(base,'test/fixtures/legacy-business-mapping.json');
if(process.argv[2]==='--check')assert.deepEqual(JSON.parse(await readFile(dest)),report);
else {assert.equal(process.argv.length,2);await writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:report.status,cases:cases.length,rejections:cases.filter(c=>c.error).length}));
