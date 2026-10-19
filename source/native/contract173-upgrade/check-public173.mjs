import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
const root=resolve(import.meta.dirname,'../..');
async function source(path) {
  const output=await build({entryPoints:[resolve(root,path)],bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
  return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
}
const {normalizeAmmFeePolicy,describeAmmFeePolicy}=await source('packages/kit/src/amm-fee-policy.ts');
const {isValidTws}=await source('packages/core/src/validation.ts');
const f=JSON.parse(await readFile(resolve(root,'packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json')));
const base=JSON.parse(await readFile(resolve(root,'packages/tbc-engine/rust/fixtures/tbc-transfer.json'))).planInput.request;
let checks=0;
for(const row of f.cases){
  const feePolicy={...row.rates,feeAddress:row.feeAddress};
  assert.deepEqual(normalizeAmmFeePolicy(feePolicy),feePolicy);
  assert.equal(describeAmmFeePolicy(feePolicy).totalFeeBps,Object.values(row.rates).reduce((a,b)=>a+b));
  const request={...base,intent:{type:'tbc-amm-create',version:'1.0',ftContractId:row.ftGenesisId,feePolicy,lpTimelock:row.locked,
    serviceProviderTag:Buffer.from(row.serviceProviderTag,'hex').toString('utf8')}};
  assert.equal(isValidTws('transactionRequest',request),true);
  for(const extra of [{lpPlan:1},{serviceFeeRate:35},{feePolicy:{...feePolicy,lpFeeRate:-1}},
    {feePolicy:{...feePolicy,taxFeeRate:1.5}},{feePolicy:{...feePolicy,protocolFeeRate:10000}},{feePolicy:{...feePolicy,extra:0}}]){
    assert.equal(isValidTws('transactionRequest',{...request,intent:{...request.intent,...extra}}),false);checks++;
  }
  for(const [field,value] of [['feeAddress','bad'],['lpFeeRate',10000],['lpFeeRate',-1],['lpFeeRate',0.5],['taxFeeRate',9999]]){
    assert.throws(()=>normalizeAmmFeePolicy({...feePolicy,[field]:value}));checks++;
  }
}
const recipient=f.cases[0].feeAddress;
for(const lp of [0,600,601,9999]) assert.equal(normalizeAmmFeePolicy({lpFeeRate:lp,taxFeeRate:0,protocolFeeRate:0,serviceProviderFeeRate:0,feeAddress:recipient}).lpFeeRate,lp);
assert.throws(()=>normalizeAmmFeePolicy({lpFeeRate:5000,taxFeeRate:5000,protocolFeeRate:0,serviceProviderFeeRate:0,feeAddress:recipient}));
assert.throws(()=>normalizeAmmFeePolicy(Object.defineProperty({taxFeeRate:0,protocolFeeRate:0,serviceProviderFeeRate:0,feeAddress:recipient},'lpFeeRate',{get(){throw Error('must not execute getter');},enumerable:true})));
console.log(JSON.stringify({status:'PUBLIC173_PASS',createProfiles:f.cases.length,negativeChecks:checks+2,feeBound:'sum <10000, not 600',http:0,scope:'source helper and generated shared schema; not device/chain acceptance'}));
