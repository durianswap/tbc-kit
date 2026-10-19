// Focused source Native/WASM parity. Public synthetic material only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createWasmTbcEngineBackend} from '../dist/esm/wasm.js';
const rust=new URL('../rust/',import.meta.url);
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop_public',
 'public_lop_match_rejects_distinct_fee_recipients_without_signing_tasks','--','--exact','--nocapture'],
 {cwd:rust,env:{...process.env,LOP_FEE_BOUNDARY_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
assert.equal(run.status,0,'Native boundary test failed; material withheld');
const marker='LOP_FEE_BOUNDARY:';
const rows=run.stdout.split('\n').filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
assert.equal(rows.length,4);
const bytes=await readFile(new URL('target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm',rust));
const engine=await createWasmTbcEngineBackend(bytes);
for(const row of rows){const result=JSON.parse(await engine.call('plan',JSON.stringify(row.input)));assert.deepEqual(result,row.result);assert.equal(result.ok,false);}
console.log(JSON.stringify({status:'LOP_FEE_BOUNDARY_PARITY_PASS',cases:rows.length,
 wasmSha256:createHash('sha256').update(bytes).digest('hex'),networkRequests:0,signing:0,broadcast:0,installedCandidate:false}));
