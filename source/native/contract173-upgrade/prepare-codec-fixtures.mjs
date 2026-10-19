// Upstream oracle only: no keys, signer, HTTP, transaction submission or package overwrite.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const upstream=resolve(process.argv[2]??'/private/tmp/tbc-contract-audit-20261014');
const root=resolve(import.meta.dirname,'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(join(upstream,'npm-1.7.3.tgz'))),'32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e');
const req=createRequire(join(upstream,'package/index.js'));
// NODE_PATH supplies only the already installed tbc-lib-js dependency.
const tape=req('./lib/util/tbc-amm/tape.js'),fees=req('./lib/util/tbc-amm/fees.js'),code=req('./lib/util/tbc-amm/artifacts.js');
const math=req('./lib/util/tbc-amm/math.js');
const address='13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL';
const json=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
const sourceHashes={};
for(const p of ['lib/util/tbc-amm/tape.js','lib/util/tbc-amm/fees.js','lib/util/tbc-amm/math.js','lib/util/tbc-amm/artifacts.js','lib/util/tbc-amm/artifacts/pool.json','lib/util/tbc-amm/artifacts/pool_hash_lock.json']) sourceHashes[p]=sha(await readFile(join(upstream,'package',p)));
const rateRows=[[0,0,0,0],[25,0,10,0],[200,0,130,0],[0,600,0,0],[600,0,0,0],[25,100,10,5],[0,0,0,601],[0,0,0,9999],[1,1,1,1]];
const feeRows=rateRows.map(([lpFeeRate,taxFeeRate,serviceProviderFeeRate,protocolFeeRate])=>{
 const rates={lpFeeRate,taxFeeRate,serviceProviderFeeRate,protocolFeeRate};
 const policy=fees.resolveSwapFeePolicy(rates,address);
 return {input:{...rates,feeAddress:address},totalFeeBps:policy.totalFeeBps,
  samples:[0n,1n,286n,999n,1000n,3000n,9999n,10000n,10001n,1000000000n,9223372036854775807n].map(base=>fees.calculateSwapFees(base,policy))};
});
const tapes=[];
for(const row of feeRows)for(const controlled of [false,true])for(const locked of [false,true]){
 const {feeAddress:_,...rates}=row.input;
 const fields={ftLpPartialHash:Buffer.alloc(32,1),ftLpCodeSize:2659,ftAPartialHash:Buffer.alloc(32,2),ftACodeSize:500,
  ftLpAmount:1000000n,ftAAmount:2000000n,tbcAmount:3000000n,ftAContractId:'03'.repeat(32),...rates,
  feeAddress:fees.deriveFeeRecipient(address).feePubKeyHash20,withSwapHashLock:controlled,withLpLocktime:locked,withLpHashLock:controlled};
 const encoded=tape.encodePoolTape(fields);
 assert.equal(encoded.length,168);tape.decodePoolTape(encoded);
 tapes.push({rates,controlled,locked,hex:encoded.toString('hex')});
}
const codes=[];
for(const controllers of [0,1,3,5])for(const length of [0,1,4,75,76,255,256]){
 const tag=Buffer.alloc(length,0x41);if(length>=10)Buffer.from('POOLCODE2').copy(tag,0);
 const controllerPubKeyHashes=Array.from({length:controllers},(_,i)=>(i+1).toString(16).padStart(2,'0').repeat(20));
 const options={originalUTXO:Buffer.alloc(36,4),tbcFeeScriptHash:fees.deriveFeeRecipient(address).feeScriptHash32,ftTapeSize:66,
  authorization:controllers?{kind:'controller',controllerPubKeyHashes}:{kind:'public'},serviceProviderTag:tag};
 const raw=code.instantiatePoolCode(options).toBuffer();const parsed=code.parsePoolCode(raw);assert.deepEqual(parsed.serviceProviderTag,tag);
 codes.push({controllers,tagHex:tag.toString('hex'),feeScriptHash:options.tbcFeeScriptHash.toString('hex'),hex:raw.toString('hex'),sha256:sha(raw)});
}
const out=join(root,'packages/tbc-engine/rust/fixtures/amm-explicit173.json');
await writeFile(out,json({upstream:{version:'1.7.3',commit:'2f3fe7873e05d8b6f1f53b8720f066776b847b03',sourceHashes},fees:feeRows,tapes,codes}),{flag:'wx'});
console.log(JSON.stringify({status:'UPSTREAM_CODEC_FIXTURES',fees:feeRows.length,tapes:tapes.length,codes:codes.length,path:out,sha256:sha(await readFile(out))}));
