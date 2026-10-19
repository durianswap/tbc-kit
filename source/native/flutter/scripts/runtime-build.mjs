import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {configuredFlutterPeerModules,flutterBuildRequire} from './build-tools.mjs';
import {verifiedKitCandidate} from './candidate-inputs.mjs';
import {normalizeRuntimeModuleLabels} from './runtime-module-labels.mjs';
const root=resolve(import.meta.dirname,'../../..');
export async function buildFlutterRuntime({kit,peerModules=configuredFlutterPeerModules(),entry=join(root,'native/flutter/runtime/plugin-entry.mjs')}){
  const kitIdentity=await verifiedKitCandidate(kit);
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
  for(const item of provenance.artifacts)assert.equal(sha(await readFile(join(kit,item.path))),item.sha256,item.path);
  const built=await build({entryPoints:[entry],bundle:true,write:false,format:'iife',platform:'browser',metafile:true,
    nodePaths:[join(root,'node_modules'),peerModules],logLevel:'silent',plugins:[{
      name:'frozen-kit-and-utf8-only',setup(b){
        b.onLoad({filter:/whatwg-url\/lib\/utils\.js$/},async a=>{
          const original=await readFile(a.path,'utf8');
          const intrinsic='const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);';
          assert.equal(original.split(intrinsic).length,2,'Review updated URL intrinsic before bundling');
          // Babel lowers async generators to ordinary factory functions: their
          // Function.prototype has no .prototype. URL has no async iterators;
          // provide the spec-shaped fallback intrinsic instead of inspecting a
          // native async generator that Hermes does not implement. URL parsing,
          // IDNA, percent encoding and generated synchronous iterators unchanged.
          return {contents:original.replace(intrinsic,'const AsyncIteratorPrototype = Object.defineProperty(Object.create(Object.prototype), Symbol.asyncIterator, { value: function () { return this; }, writable: true, configurable: true });'),loader:'js'};
        });
        // Kit peers use Buffer for byte serialization. Do not inherit a peer's
        // browser:false alias, which silently creates an empty module in Hermes.
        // Pin our own Buffer: an arbitrary RN peer may be v5, whose missing
        // BigInt uint64 readers break Reviewed transaction amount parsing.
        b.onResolve({filter:/^buffer\/?$/},()=>({path:join(root,'native/flutter/runtime/node_modules/buffer/index.js')}));
        b.onResolve({filter:/^crypto$/},a=>{
          assert.ok(a.importer.endsWith('/brorand/index.js'),'Audit new native crypto import before enabling it');
          return {path:join(root,'native/flutter/runtime/native-random.mjs')};
        });
        b.onResolve({filter:/^@tbc\/kit\/(wallet|engine|sqlite)$/},a=>({path:join(kit,'dist/esm',a.path.split('/').at(-1)+'.js')}));
        b.onResolve({filter:/^\.\/encoding-indexes\.js$/},a=>{
          assert.ok(a.importer.endsWith('/text-encoding/lib/encoding.js'));
          return {path:'utf8-only',namespace:'tbc-encoding'};
        });
        b.onLoad({filter:/.*/,namespace:'tbc-encoding'},()=>({contents:'module.exports={"encoding-indexes":{}};',loader:'js'}));
      },
    }]});
  const require=flutterBuildRequire(peerModules);
  const transformed=require('@babel/core').transformSync(built.outputFiles[0].text,{configFile:false,babelrc:false,sourceType:'script',compact:true,
    presets:[[require.resolve('@react-native/babel-preset'),{unstable_transformProfile:'hermes-stable',enableBabelRuntime:false}]]}).code;
  const source=normalizeRuntimeModuleLabels(transformed,kit,[
    {path:join(root,'node_modules'),label:'workspace-dependency'},
    {path:peerModules,label:'peer-dependency'},
  ]);
  const sources={};
  for(const p of Object.keys(built.metafile.inputs)){
    if(p.startsWith('tbc-encoding:'))continue;
    assert.ok(!p.startsWith('(disabled):'),`Unresolved browser dependency ${p} from ${Object.entries(built.metafile.inputs).filter(([,v])=>v.imports.some(i=>i.path===p)).map(([name])=>name).join(', ')}`);
    sources[resolve(p)]=sha(await readFile(resolve(p)));
  }
  return {source,sources,sha256:sha(source),kitIdentity};
}
