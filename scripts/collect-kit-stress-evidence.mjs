// Collect already-executed checks; this script never executes transactions.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'..'),out=resolve(process.argv[2]);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const check=await json(join(out,'evidence/installed-check.json'));
assert.equal(check.status,'PASS');
const dirs={matrix:'rc25-sealed-matrix',rust:'rc25-rust-release',timing:'rc25-idle-timing',red:'rc24-extreme-red',contended:'rc25-paired-timing'};
for(const [prefix,dir]of Object.entries(dirs)){
 const base=join(repo,'docs/acceptance/evidence',dir);
 for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isFile())await copyFile(join(base,entry.name),join(out,'evidence',prefix+'-'+entry.name));
}
const matrix=await json(join(out,'evidence/matrix-results.json'));
const rust=await json(join(out,'evidence/rust-rust-results.json'));
const timing=await json(join(out,'evidence/timing-timing.json'));
for(const result of [matrix,rust,timing])assert.equal(result.status,'PASS');
assert.equal(matrix.installed,check.installed);
assert.equal(timing.after,'0.1.0-rc.25');
const build=await json(join(out,'evidence/build.json'));
const rustSources={};
for(const [p,h]of Object.entries(build.sourceFiles))if(p.startsWith('source/packages/tbc-engine/rust/')){
 assert.equal(hash(await readFile(join(rust.sourceRoot,p.slice('source/'.length)))),h,'Tested Rust source differs: '+p);
 rustSources[p]=h;
}
assert.ok(Object.keys(rustSources).length>0);
await writeFile(join(out,'evidence/rust-source-parity.json'),JSON.stringify({status:'PASS',sourceRoot:rust.sourceRoot,files:rustSources},null,2)+'\n');
const old=join(repo,'.verify/extreme-rc25-final-consumer/node_modules/@tbc/kit');
async function hashes(base,rel){const rows={};for(const entry of await readdir(join(base,rel),{withFileTypes:true})){const p=join(rel,entry.name);if(entry.isDirectory())Object.assign(rows,await hashes(base,p));else rows[p]=hash(await readFile(join(base,p)))}return rows}
const oldFiles={...await hashes(old,'dist'),...await hashes(old,'artifacts/wasm')};
const newFiles={...await hashes(check.installed,'dist'),...await hashes(check.installed,'artifacts/wasm')};
assert.deepEqual(newFiles,oldFiles,'Preseal test-only snapshot must not change runtime or compute artifacts');
const equivalence={status:'PASS',previousInstalled:old,finalInstalled:check.installed,identicalRuntimeAndWasmFiles:Object.keys(newFiles).length,files:newFiles};
await writeFile(join(out,'evidence/runtime-equivalence.json'),JSON.stringify(equivalence,null,2)+'\n');
const summary={status:'PASS',kitSha256:check.kitSha256,matrixPassed:matrix.results.reduce((n,r)=>n+r.passed,0),matrixSkipped:matrix.results.reduce((n,r)=>n+r.skipped,0),rustPassed:rust.passed,rustIgnored:rust.ignored,installedSupplementPassed:check.checks.reduce((n,r)=>n+r.passed,0),countsMayOverlap:true,realBroadcasts:0,deviceAcceptance:false};
await writeFile(join(out,'evidence/stress-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
