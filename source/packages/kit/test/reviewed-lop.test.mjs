import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundled=await build({entryPoints:[`${root}packages/kit/src/reviewed-lop.ts`],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {inspectReviewedLopOrders,inspectReviewedLopMaterials}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

// Bridge/ordering tests only. Real exact template and Native/WASM behavior is
// covered separately using the actual Rust public transaction fixtures.
test('LOP review deduplicates scripts in one local call and preserves positions across await',async()=>{
  const input=[{inputs:['51','52','52'],outputs:['52','53']}];let calls=0;
  const native={async execute(operation,request){
    calls++;assert.equal(operation,'inspectLopMaterial');
    assert.deepEqual(JSON.parse(request),{phase:'inspectOrderScripts',scripts:['51','52','53']});
    input[0].inputs.splice(0,3,'53');
    return JSON.stringify({orders:[null,{standardId:'tbc-lop',saleVolume:'9007199254740993'},null]});
  }};
  const [review]=await inspectReviewedLopOrders(native,input);
  assert.equal(calls,1);assert.deepEqual(review.inputs.map(v=>v.index),[1,2]);
  assert.deepEqual(review.outputs.map(v=>v.index),[0]);
  assert.equal(review.inputs[0].terms.saleVolume,'9007199254740993');
  assert.equal(review.assetIdentityVerified,false);
});
test('invalid bridge mapping and invalid or excessive input fail closed',async()=>{
  for(const result of [{},{orders:[]},{orders:[false]},{orders:[{standardId:'unknown'}]}]){
    await assert.rejects(inspectReviewedLopOrders({async execute(){return JSON.stringify(result)}},[{inputs:['51'],outputs:[]}]),/Invalid LOP/);
  }
  let calls=0;const native={async execute(){calls++;throw new Error('must not call');}};
  for(const inputs of [[],['AB'],['0'],['zz'],['00'.repeat(65537)],Array.from({length:257},(_,i)=>i.toString(16).padStart(4,'0'))]){
    await assert.rejects(inspectReviewedLopOrders(native,[{inputs,outputs:[]}]),/LOP review/);
  }
  assert.equal(calls,0);
});
test('escrow review requires exact controller mapping, separate from public order terms',async()=>{
  const terms={standardId:'tbc-lop'};
  for(const controllers of [undefined,[],[null],[false],['aa']]){
    await assert.rejects(inspectReviewedLopMaterials({async execute(){return JSON.stringify({orders:[terms],controllers});}},[{inputs:['51'],outputs:[]}]),/controller mapping/);
  }
  const [material]=await inspectReviewedLopMaterials({async execute(){return JSON.stringify({orders:[terms],controllers:['11'.repeat(20)]});}},[{inputs:['51'],outputs:['51']}]);
  assert.equal(material.inputControllers.get(0),'11'.repeat(20));assert.equal(material.outputControllers.get(0),'11'.repeat(20));
  assert.deepEqual(material.orders.inputs,[{index:0,terms}]);
});
