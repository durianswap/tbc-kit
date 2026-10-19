import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,relative} from 'node:path';
import {runInThisContext} from 'node:vm';
import {build} from 'esbuild';

// Independent keyless upstream assembly oracle; never used by production Kit.
export async function loadTokenUnlockSdkOracle(directory,deps){
 const upstream=resolve(directory),commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
 const built=await build({stdin:{contents:`
 export {buildTBC20UnlockScriptWithSignature as token} from './lib/util/tbc20/tbc20unlock.js';
 export {buildCoinTBC20UnlockScriptWithSignature as coin} from './lib/util/coin/coinTbc20unlock.js';`,resolveDir:upstream},
 bundle:true,write:false,metafile:true,platform:'node',format:'cjs',external:['tbc-lib-js','tbc-lib-js/*'],resolveExtensions:['.js','.json'],logLevel:'silent'});
 let files=0;
 for(const file of Object.keys(built.metafile.inputs)){
  if(file==='<stdin>')continue;
  const absolute=resolve(file),rel=relative(upstream,absolute);assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(absolute),execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));files++;
 }
 assert.equal(deps('tbc-lib-js/package.json').version,'1.0.31');const module={exports:{}};
 runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto')return deps(name);throw Error('Unexpected oracle import');
 });
 return {...module.exports,commit,files};
}
