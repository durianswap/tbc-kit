// Page-facing Provider only, distinct from the privileged Hermes resource.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {extractLegacyPageBootstrap} from './legacy-page-bootstrap.mjs';
import {verifiedKitCandidate} from './candidate-inputs.mjs';
import {sourceIdentifier} from './webview-source-identity.mjs';
import {normalizeMinifiedDependencyLabels} from './runtime-module-labels.mjs';
const args=process.argv.slice(2);
assert.equal(args.length,2,'EXTRACTED_FROZEN_KIT NEW_OUTPUT');
const [kit,out]=args.map(p=>resolve(p)),root=resolve(import.meta.dirname,'../../..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const kitIdentity=await verifiedKitCandidate(kit);
const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
for(const a of provenance.artifacts)assert.equal(sha(await readFile(join(kit,a.path))),a.sha256,a.path);
// The historical page script is a public-page constant from the SAME pinned
// Kit as the VM. Extract only its literal assignment; do not bundle wallet.js
// (or any Host/Engine code) into the WebView resource.
const legacyModule=join(kit,'dist/esm/wallet.js');
const legacyModuleSource=await readFile(legacyModule,'utf8');
const legacyScript=extractLegacyPageBootstrap(legacyModuleSource);
const built=await build({entryPoints:[join(root,'native/flutter/runtime/webview-page-entry.mjs')],
  bundle:true,write:false,metafile:true,platform:'browser',format:'iife',target:'safari13.1',minify:true,
  nodePaths:[join(root,'node_modules')],logLevel:'silent',
  plugins:[{name:'frozen-kit',setup(b){b.onResolve({filter:/^@tbc\/kit$/},()=>({path:join(kit,'dist/esm/index.js')}));}}]});
const sources={};
for(const p of Object.keys(built.metafile.inputs)){
  assert.ok(!p.startsWith('(disabled):'),p);
  const id=sourceIdentifier(root,kit,resolve(p));
  assert.ok(!Object.hasOwn(sources,id),`Duplicate page input: ${id}`);
  sources[id]=sha(await readFile(resolve(p)));
}
sources[sourceIdentifier(root,kit,legacyModule)]=sha(legacyModuleSource);
// Tree shaking may parse the root barrel's other files; forbid privileged code
// actually retained in the page output, not merely listed as a parsed input.
const retained=Object.entries(Object.values(built.metafile.outputs)[0].inputs).filter(([,v])=>v.bytesInOutput>0)
  .map(([p])=>sourceIdentifier(root,kit,resolve(p)));
for(const p of retained)assert.ok(!/(?:\/host\/|\/engine\/|\/wallet\.js$|native-driver|wallet-runtime|private-host|sqlite|custody)/.test(p),p);
await mkdir(out);
// The bootstrap remains dormant until a native verified Legacy initialize.
// When wallet.legacy is false, the VM never opens that lane; this resource
// creates no window.Turing merely by being injected.
const legacyShim=';(()=>{const b=window.__tbcFlutterPage;if(!b||Object.hasOwn(window,"ReactNativeWebView"))return;Object.defineProperty(window,"ReactNativeWebView",{value:Object.freeze({postMessage(s){if(!b.legacyPost(s))throw Error("Legacy wallet session closed");}}),writable:false,configurable:false});})();\n';
const legacyMarker=`/* tbc-flutter-legacy-page:${sha(legacyScript)} */\n`;
const pageBundle=normalizeMinifiedDependencyLabels(built.outputFiles[0].text,[
  {path:join(root,'node_modules'),label:'workspace-dependency'},
]);
const bytes=Buffer.concat([Buffer.from(pageBundle),Buffer.from(legacyMarker+legacyShim+legacyScript+'\n')]);
await writeFile(join(out,'tbc-webview-page.js'),bytes);
await writeFile(join(out,'page-provenance.json'),JSON.stringify({schema:2,status:'BUILT_NOT_DEVICE_ACCEPTED',kit:kitIdentity.version,kitIdentity,
  sha256:sha(bytes),bytes:bytes.length,sources,retainedSources:retained,
  legacyBootstrapSha256:sha(legacyScript),legacyBootstrapSource:sourceIdentifier(root,kit,legacyModule),
  generatorSha256:sha(await readFile(new URL(import.meta.url))),
  bootstrapExtractorSha256:sha(await readFile(new URL('./legacy-page-bootstrap.mjs',import.meta.url))),
  sourceIdentitySha256:sha(await readFile(new URL('./webview-source-identity.mjs',import.meta.url))),
  privilegedRuntime:false,signer:false,realChainAcceptance:false},null,2)+'\n');
console.log(JSON.stringify({out,bytes:bytes.length,sha256:sha(bytes)}));
