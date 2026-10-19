// Public recorded/synthetic fixtures only. Never fetches or broadcasts.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';

const [baseArg, candidateArg, outArg] = process.argv.slice(2);
assert.ok(outArg, 'INSTALLED_BASE INSTALLED_CANDIDATE NEW_EVIDENCE_DIRECTORY');
const base=resolve(baseArg), candidate=resolve(candidateArg), out=resolve(outArg);
const root=resolve(import.meta.dirname,'../../..');
await mkdir(out);
// Installed trees may have test-only files, so bind runtime to their receipts.
const identities=await Promise.all([base,candidate].map(verifiedKitCandidate));
const require=createRequire(join(candidate,'package.json'));
assert.throws(()=>require.resolve('tbc-lib-js'),{code:'MODULE_NOT_FOUND'});
const samples=[];
const parents=new Map();
const {parseTbcTransaction,turingTransactionId}=await import(pathToFileURL(join(candidate,'dist/esm/api.js')));
for(const name of ['controlled-pool','controlled-pool-key1','controlled-pool-remove']) {
  const fixture=JSON.parse(await readFile(join(root,`packages/kit/test/fixtures/${name}.json`)));
  for(const [txid,raw]of Object.entries(fixture.rawTransactions)) {
    samples.push({name:`${name}:${txid}`,raw});parents.set(txid,parseTbcTransaction(raw));
  }
}
const fixture=await import(pathToFileURL(join(root,'packages/kit/test/fixtures/real-ft-mint.mjs')));
for(const [name,raw]of Object.entries(fixture.REAL_FT_MINT_FIXTURE)) if(typeof raw==='string'&&/raw/i.test(name)){
  samples.push({name,raw});parents.set(turingTransactionId(raw),parseTbcTransaction(raw));
}
const report={status:'PASS_PARSER_DEPENDENCY_PARITY',identities,formats:[],realNetwork:false,realBroadcast:false};
for(const format of ['esm','cjs']) {
  const roots=[base,candidate].map(p=>join(p,`dist/${format}/vendor/tbc-tx-parser`));
  const modules=await Promise.all(roots.map(p=>import(pathToFileURL(join(p,'adapters/partial-sha256.js')))));
  let hashes=0;
  for(const length of [0,1,55,56,63,64,65,127,128,129,193,512,1024,4096])for(const pattern of [0,0xff,0x51]){
    const input=Buffer.alloc(length,pattern);
    assert.equal(modules[1].calculatePartialSha256(input),modules[0].calculatePartialSha256(input),`${format}:${length}:${pattern}`); hashes++;
  }
  const parsers=await Promise.all(roots.map(p=>import(pathToFileURL(join(p,'index.js')))));
  let decoded=0,missingParentRejected=0;
  for(const {name,raw}of samples){
    const tx=parseTbcTransaction(raw);
    const inputUtxos=tx.inputs.map((input,inputIndex)=>{
      const output=parents.get(input.txid)?.outputs[input.vout];
      return output ? {inputIndex,txid:input.txid,outputIndex:input.vout,satoshis:Number(output.satoshis),
        lockingScript:Buffer.from(output.scriptPubKey).toString('hex')} : undefined;
    });
    if(inputUtxos.some(v=>!v)){
      const reject=async p=>{try{await p.decodeTxRaw(raw);return null}catch(e){return {name:e.name,message:e.message}}};
      const errors=await Promise.all(parsers.map(reject));assert.ok(errors[0]);assert.deepEqual(errors[1],errors[0]);missingParentRejected++;
    }else{
      const values=await Promise.all(parsers.map(p=>p.decodeTxRaw(raw,{inputUtxos})));
      assert.deepEqual(values[1],values[0],name);decoded++;
    }
  }
  assert.ok(decoded>0,'Expected complete parent-material parser cases');
  const malformed=['', '00', 'zz', samples[0].raw.slice(0,-2)];
  for(const raw of malformed){
    const result=async p=>{try{return {ok:true,value:await p.decodeTxRaw(raw)}}catch(e){return {ok:false,name:e.name,message:e.message}}};
    assert.deepEqual(await result(parsers[1]),await result(parsers[0]));
  }
  report.formats.push({format,partialHashCases:hashes,decodedCases:decoded,missingParentRejected,malformedRawCases:malformed.length});
}
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
