import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc25-real');
const prior='/Users/alex/Documents/Codex/2026-08-29/wo/outputs/htlc-review-rc16-device/native/kit-runtime';
try{await access(join(out,'prepared.json'));throw Error('Already prepared; do not overwrite live evidence');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(out,{recursive:true});
await cp(prior,join(out,'native/kit-runtime'),{recursive:true,filter:p=>!p.split('/').some(x=>['build','node_modules','target','.gradle','.cxx'].includes(x))});
await cp(join(root,'source/registry'),join(out,'registry'),{recursive:true});
const loop=join(out,'native/kit-runtime/closed-loop');
const edit=async(p,fn)=>writeFile(p,fn(await readFile(p,'utf8')));
for(const name of ['run-ios.mjs','prepare-android.mjs'])await edit(join(loop,name),s=>s.replaceAll("'0.1.0-rc.11'","'0.1.0-rc.25'").replaceAll('org.tbc.rc11.acceptance','org.tbc.rc25.realfunds').replaceAll('io.tbc.rc11.acceptance','io.tbc.rc25.realfunds').replace("['-swift-version', '6',","['-O','-swift-version', '6',").replace('join("/Users/alex/Documents/Codex/2026-08-29/wo/outputs/ft-nft-rc11-device",\'dapp.html\')',`join(${JSON.stringify(out)},'dapp.html')`));
await edit(join(loop,'android/build.gradle'),s=>s.replaceAll('io.tbc.rc11.acceptance','io.tbc.rc25.realfunds'));
for(const name of ['run-ios.mjs','prepare-android.mjs'])await edit(join(loop,name),s=>s.replace("from 'esbuild'",`from ${JSON.stringify(join(root,'source/node_modules/esbuild/lib/main.js'))}`));
await edit(join(loop,'WalletApp.swift'),s=>s.replace('"candidate":"0.1.0-rc.16"','"candidate":"0.1.0-rc.25"'));
await edit(join(loop,'android/src/main/java/io/tbc/kitloop/NativeHost.kt'),s=>s.replaceAll('0.1.0-rc.11','0.1.0-rc.25').replaceAll('0.1.0-rc.12+android-runtime.1','0.1.0-rc.25').replaceAll('0.1.0-rc.16','0.1.0-rc.25'));
// Verify against the frozen separate Native distribution, not the old all-platform npm layout.
await writeFile(join(loop,'engine-delivery.mjs'),`import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
export async function verifyEngineDelivery(installed,sdk){const lock=JSON.parse(await readFile(${JSON.stringify(join(root,'release/candidates/kit-stress-rc25/native-sdk-lock.json'))}));const identity=JSON.parse(await readFile(join(sdk,'identity.json')));assert.equal(JSON.parse(await readFile(join(installed,'package.json'))).version,'0.1.0-rc.25');assert.equal(identity.artifactSetId,lock.artifactSetId);assert.equal(identity.protocolFingerprint,lock.protocolFingerprint);assert.equal(identity.protocolFingerprint,JSON.parse(await readFile(join(installed,'artifacts/provenance.json'))).protocolFingerprint);for(const[file,hash]of Object.entries(lock.files))assert.equal(createHash('sha256').update(await readFile(join(sdk,file))).digest('hex'),hash,file);return identity;}
`);
const page=(await readFile('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/htlc-review-rc16-device/dapp.html','utf8')).replaceAll('rc.16','rc.25').replaceAll('HTLC / raw 26 inputs','NFT batch').replace('resultKeys:Object.keys(result.result??{})','resultKeys:Object.keys(result.result??{}),status:result.result?.status,reason:result.result?.reason,minted:result.result?.minted,requested:result.result?.requested');
await writeFile(join(out,'dapp.html'),page);
// A bounded create profile; recipient is bound by the native account, and the
// Engine/Host continues to enforce normal ownership, budget and expiry checks.
await writeFile(join(out,'collection-profile.json'),JSON.stringify({title:'Test RC25 NFT collection',intent:{type:'tbc721-standard-create-collection',version:'1.0',name:'RC25 NFT targeted',description:'Independent Testnet acceptance',supply:'22',media:{kind:'uri',uri:'https://example.com/rc25-nft-targeted'}},maxFee:'5000'},null,2));
await mkdir(join(out,'private'),{recursive:true,mode:0o700});
await writeFile(join(out,'private/current-request.json'),JSON.stringify({method:'tbc_accounts'}));
await writeFile(join(out,'prepared.json'),JSON.stringify({at:new Date().toISOString(),source:prior,kit:'0.1.0-rc.25',native:'0.1.0-rc.23.native.2',iosBundle:'org.tbc.rc25.realfunds',androidBundle:'io.tbc.rc25.realfunds',pageSha256:createHash('sha256').update(page).digest('hex')},null,2));
console.log(out);
