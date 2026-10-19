import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundled=await build({entryPoints:[`${root}packages/kit/src/reviewed-token.ts`],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {inspectReviewedTokenCodes:codes,inspectReviewedTokenPairs:pairs}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const descriptor={standardId:'tbc20-standard',tapeSize:61,controller:'11'.repeat(20)+'00',codeIdentity:'22'.repeat(34),
  verification:'exact-template',assetIdentityVerified:false,originalOutpoint:{txid:'33'.repeat(32),vout:2}};
test('batched local inspection deduplicates and snapshots positions; no authority is fabricated',async()=>{
  const input=['51','52','51'];let calls=0;
  const result=await codes({async execute(op,raw){calls++;assert.equal(op,'inspectTokenMaterial');
    assert.deepEqual(JSON.parse(raw),{phase:'inspectCodes',scripts:['51','52']});input.splice(0,3,'53');
    return JSON.stringify({codes:[descriptor,null]});}},input);
  assert.equal(calls,1);assert.deepEqual(result,[descriptor,null,descriptor]);assert.ok(Object.isFrozen(result[0].originalOutpoint));
  const pair={codeScript:'51',codeSatoshis:500,tapeScript:'006a',tapeSatoshis:0},array=[pair,pair];
  const decoded=await pairs({async execute(op,raw){calls++;assert.equal(op,'inspectTokenMaterial');
    assert.deepEqual(JSON.parse(raw),{phase:'inspectPairs',pairs:[pair]});pair.codeScript='53';
    return JSON.stringify({pairs:[{code:descriptor,balanceRaw:'55340232221128654842'}]});}},array);
  assert.equal(calls,2);assert.equal(decoded[0],decoded[1]);assert.equal(decoded[0].balanceRaw,'55340232221128654842');
});
test('malformed results, unsupported ranges and claimed identity authority fail closed',async()=>{
  for(const value of [{...descriptor,assetIdentityVerified:true},{...descriptor,tapeSize:0},{...descriptor,codeIdentity:'0'},
      {...descriptor,originalOutpoint:{txid:'33'.repeat(32),vout:-1}},false]){
    await assert.rejects(codes({async execute(){return JSON.stringify({codes:[value]});}},['51']),/Invalid reviewed/);
  }
  const pair={codeScript:'51',codeSatoshis:500,tapeScript:'006a',tapeSatoshis:0};
  for(const value of [{code:descriptor,balanceRaw:'55340232221128654843'},{code:descriptor,balanceRaw:'1',lockTime:0},
    {code:{...descriptor,standardId:'tbc20-stablecoin'},balanceRaw:'1'}]){
    await assert.rejects(pairs({async execute(){return JSON.stringify({pairs:[value]});}},[pair]),/Invalid reviewed/);
  }
  let calls=0;const native={async execute(){calls++;throw new Error('must not call');}};
  for(const value of [[],['AB'],['0'],['00'.repeat(65537)],Array(257).fill('51')]){
    await assert.rejects(codes(native,value),/reviewed Token|Reviewed Token/);
  }
  await assert.rejects(pairs(native,[{...pair,codeSatoshis:0}]),/pair values/);assert.equal(calls,0);
});
test('Coin input lock checks are bound to the pair request without granting admin or maturity',async()=>{
  const {originalOutpoint,...base}=descriptor;
  const coin={...base,standardId:'tbc20-stablecoin',tapeSize:66,coinNftCodeHash:'33'.repeat(32),adminPubkeyHash:'44'.repeat(20)};
  const pair={codeScript:'51',codeSatoshis:500,tapeScript:'006a',tapeSatoshis:0,inputLock:{sequence:4294967294,transactionLockTime:12}};
  const native={async execute(op,raw){assert.deepEqual(JSON.parse(raw).pairs[0].inputLock,pair.inputLock);
    return JSON.stringify({pairs:[{code:coin,balanceRaw:'1',lockTime:12,inputLockChecked:true}]});}};
  assert.equal((await pairs(native,[pair]))[0].inputLockChecked,true);
  await assert.rejects(pairs({async execute(){return JSON.stringify({pairs:[{code:coin,balanceRaw:'1',lockTime:12}]});}},[pair]),/input lock result/);
  await assert.rejects(pairs(native,[{...pair,inputLock:{...pair.inputLock,administrator:true}}]),/input lock/);
});
