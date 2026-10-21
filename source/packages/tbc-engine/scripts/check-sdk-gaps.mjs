#!/usr/bin/env node
// Offline public-fixture checks only. No keys, node requests or broadcasts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const rust=fileURLToPath(new URL('../rust/',import.meta.url));
const require=createRequire(new URL('../../kit/package.json',import.meta.url));
const tbc=require('tbc-lib-js');
async function source(url){
  const result=await build({entryPoints:[fileURLToPath(url)],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
try {
  const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core',
    '--test','ft','--test','tbc20_public','--test','tbc_transfer','sdk_gap_','--','--nocapture','--test-threads=1'],
    {cwd:rust,env:{...process.env,TBC_SDK_GAP_DUMP:'1'},encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024});
  assert.equal(run.status,0,'focused Rust vector generation failed; material withheld');
  const marker='SDK_GAP_VECTOR:';
  const records=run.stdout.split(/\r?\n/u).filter(line=>line.includes(marker)).map(line=>JSON.parse(line.slice(line.indexOf(marker)+marker.length)));
  assert.equal(records.length,6);
  const {createWasmTbcEngineBackend}=await source(new URL('../src/wasm.ts',import.meta.url));
  const {assertValidTws}=await source(new URL('../../core/src/validation.ts',import.meta.url));
  const wasm=await createWasmTbcEngineBackend(readFileSync(process.argv[2] ??
    fileURLToPath(new URL('../../kit/artifacts/wasm/tbc_engine_wasm.wasm',import.meta.url))));
  let calls=0, vmInputs=0, signatureTamperRejections=0;
  for(const record of records){
    for(const [method,input,expected,inputSchema,outputSchema] of [
      ['plan',record.input,record.planned,'planParams','planResult'],
      ...(record.finalizeInput ? [['finalize',record.finalizeInput,record.finalized,'finalizeParams','finalizeResult']] : []),
    ]){
      for(const [name,value] of [[inputSchema,input],[outputSchema,expected]]) {
        try { assertValidTws(name,value); }
        catch(error) { throw new Error(`${record.case} ${name}: ${JSON.stringify(error.issues?.map(({instancePath,keyword,message})=>({instancePath,keyword,message})))}`); }
      }
      const actual=JSON.parse(await wasm.call(method,JSON.stringify(input)));
      assert.equal(actual.ok,true);assert.deepEqual(actual.result,expected,`${record.case} Native/WASM ${method}`);calls++;
    }
    if(!record.finalized)continue;
    const snapshot=record.input.snapshot.payload;
    const parents=new Map(snapshot.parents.map(parent=>[parent.txid,new tbc.Transaction(parent.rawTransaction)]));
    for(const item of record.finalized.bundle.transactions){
      const tx=new tbc.Transaction(item.rawTransaction);
      assert.equal(tx.id,item.txid);
      for(const [i,input] of tx.inputs.entries()){
        const txid=input.prevTxId.toString('hex'),vout=input.outputIndex;
        const indexed=snapshot.utxos.find(utxo=>utxo.txid===txid&&utxo.vout===vout);
        input.output=parents.get(txid)?.outputs[vout] ?? (indexed && new tbc.Transaction.Output({
          script:tbc.Script.fromHex(indexed.scriptPubKey),satoshis:Number(indexed.satoshis),
        }));
        assert.ok(input.output,`${record.case} missing independent prevout`);
        const checked=tx.verifyScript(i);
        assert.equal(checked.success,true,`${record.case} VM input ${i}: ${checked.error}`);vmInputs++;
      }
      // Changing a reviewed payment/recipient after signing must invalidate signatures.
      const tampered=new tbc.Transaction(item.rawTransaction);
      for(let i=0;i<tx.inputs.length;i++)tampered.inputs[i].output=tx.inputs[i].output;
      tampered.outputs[0].setScript(tbc.Script.buildPublicKeyHashOut('1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP'));
      assert.equal(tampered.verifyScript(0).success,false);signatureTamperRejections++;
      parents.set(tx.id,tx);
    }
  }
  console.log(JSON.stringify({result:'SDK_GAPS_NATIVE_WASM_VM_PASS',vectors:records.length,calls,vmInputs,signatureTamperRejections,http:0,broadcasts:0}));
}catch(error){
  // Imported data URLs can make default exception stacks enormous.
  console.error(error instanceof Error ? error.message : 'SDK gap check failed');process.exitCode=1;
}
