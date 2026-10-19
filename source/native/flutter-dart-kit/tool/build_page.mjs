// Build only untrusted Provider/discovery/Legacy page code. No Hermes runtime,
// Engine, private native binding or wallet backend belongs in this artifact.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
import {sourceIdentifier} from '../../flutter/scripts/webview-source-identity.mjs';
import {normalizeMinifiedDependencyLabels} from '../../flutter/scripts/runtime-module-labels.mjs';
const [kitArg,outArg]=process.argv.slice(2);assert(kitArg&&outArg,'FROZEN_KIT NEW_OUTPUT');
const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..'),kit=resolve(kitArg),out=resolve(outArg);
const sha=b=>createHash('sha256').update(b).digest('hex'),kitIdentity=await verifiedKitCandidate(kit);
const built=await build({absWorkingDir:root,entryPoints:[join(base,'runtime/webview-page-entry.mjs')],
 bundle:true,write:false,metafile:true,platform:'browser',format:'iife',target:'safari15',minify:true,
 nodePaths:[join(root,'node_modules')],logLevel:'silent',plugins:[{name:'pinned-kit',setup(b){
 b.onResolve({filter:/^@tbc\/kit$/},()=>({path:join(kit,'dist/esm/index.js')}));}}]});
const sources={};for(const p of Object.keys(built.metafile.inputs)){
 assert(!p.startsWith('(disabled):'));sources[sourceIdentifier(root,kit,resolve(root,p))]=sha(await readFile(resolve(root,p)));
}
const retained=Object.entries(Object.values(built.metafile.outputs)[0].inputs).filter(([,v])=>v.bytesInOutput>0).map(([p])=>sourceIdentifier(root,kit,resolve(root,p)));
for(const p of retained)assert(!/(?:\/host\/|\/engine\/|\/wallet\.js$|native-driver|wallet-runtime|private-host|sqlite|custody)/.test(p),p);
const legacySha=sha(await readFile(join(base,'runtime/legacy-page.mjs')));
const output=normalizeMinifiedDependencyLabels(built.outputFiles[0].text,[{path:join(root,'node_modules'),label:'workspace-dependency'}])+`\n/* tbc-dart-legacy-page:${legacySha} */\n`;
const bytes=Buffer.from(output);assert(bytes.length<2*1024*1024);
await mkdir(out);await writeFile(join(out,'tbc-webview-page.js'),bytes,{flag:'wx'});
const manifest={schema:1,status:'BUILT_NOT_DEVICE_ACCEPTED',kitIdentity,sha256:sha(bytes),bytes:bytes.length,
 sources,retainedSources:retained,legacySha256:legacySha,generatorSha256:sha(await readFile(new URL(import.meta.url))),
 channels:['tws-webview/1','legacy-window-turing-shared/1'],privilegedRuntime:false,signer:false,businessExecution:false,
 note:'Standard bridge and frozen Provider reused. Only canonical RPC transport and page DTO projection in Legacy; dormant until native initializes its registered lane.'};
await writeFile(join(out,'page-provenance.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:manifest.status,out,sha256:manifest.sha256,bytes:bytes.length}));
