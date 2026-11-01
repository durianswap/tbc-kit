// Retain the dedicated rc.25 test accounts/journal. Replace only its isolated
// test shell's bundled JS with rc.26; never touch the partner wallet/App.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc26-ui');
const previous=JSON.parse(await readFile(join(root,'.verify/rc25-real/candidate.json')));
const candidate=join(root,'release/candidates/nft-approval-rc26');
const installed=JSON.parse(await readFile(join(candidate,'evidence/installed-check.json'))).installed;
assert.equal(JSON.parse(await readFile(join(installed,'package.json'))).version,'0.1.0-rc.26');
await mkdir(out);const app=join(out,'NativeKitLoop.app'),android=join(out,'android');
await cp(previous.iosApp,app,{recursive:true});
await cp(previous.android,android,{recursive:true,filter:p=>!p.split('/').some(x=>['build','.gradle','.cxx'].includes(x))});
const {build}=createRequire(join(root,'source/package.json'))('esbuild');
const boundary=join(root,'.verify/rc25-real/native/kit-runtime/host-boundary');
const built=await build({absWorkingDir:boundary,stdin:{resolveDir:boundary,contents:`import {openNativeWalletSession as open} from './wallet-entry.mjs';export function openNativeWalletSession(options){return open({...options,callHost:(method,input)=>{if(method==='signer.sign'||method==='reviewed.signStage')throw Error('EXPIRY_ONLY_SIGN_FORBIDDEN');if(method==='http.request'&&JSON.parse(input).method==='POST')throw Error('EXPIRY_ONLY_POST_FORBIDDEN');return options.callHost(method,input)}})}`},bundle:true,platform:'browser',format:'iife',globalName:'NativeWalletEntry',target:'es2022',minify:true,write:false,plugins:[{name:'exact-kit',setup(b){b.onResolve({filter:/^@tbc\/kit\/(wallet|engine|sqlite)$/},a=>({path:join(installed,`dist/esm/${a.path.split('/').at(-1)}.js`)}))}}],logLevel:'silent'});
const code=built.outputFiles[0].text;
await writeFile(join(app,'wallet.js'),code);
const rn=createRequire('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/ft-nft-rc11-device/android-build-deps/package.json');
const androidCode=rn('@babel/core').transformSync(code,{configFile:false,babelrc:false,sourceType:'script',compact:true,presets:[[rn.resolve('@react-native/babel-preset'),{unstable_transformProfile:'hermes-stable',enableBabelRuntime:false}]]}).code;
await writeFile(join(android,'src/main/assets/wallet.js'),androidCode);
let bridge=await readFile(join(android,'src/main/cpp/bridge.cpp'),'utf8');
assert(!bridge.includes('installTbcSha256'));
bridge=bridge.replace('#include <thread>','#include <thread>\n#include "sha256-jsi.hpp"').replace('auto &rt = *host->runtime;','auto &rt = *host->runtime;\n    installTbcSha256(rt, env);');
await writeFile(join(android,'src/main/cpp/bridge.cpp'),bridge);
await cp(join(root,'source/native/runtime-support/sha256-jsi.hpp'),join(android,'src/main/cpp/sha256-jsi.hpp'));
// Prevent any broadcast in this approval-expiry-only UI recheck, even if the
// operator clicks early. No Kit path or validation is replaced by this guard.
for(const file of ['wallet.js'])for(const p of [join(app,file),join(android,'src/main/assets',file)]){
 const s=await readFile(p,'utf8');assert(s.includes('broadcastSubmit')); // evidence of real wallet bundle
}
execFileSync('codesign',['--force','--sign','-',app],{stdio:'inherit'});
await cp(join(root,'.verify/rc25-real/dapp.html'),join(out,'dapp.html'));
await mkdir(join(out,'private'),{mode:0o700});await writeFile(join(out,'private/current-request.json'),JSON.stringify({method:'tbc_accounts'}),{mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
await writeFile(join(out,'build.json'),JSON.stringify({kit:'0.1.0-rc.26',installed,iosApp:app,android,iosJS:sha(code),androidJS:sha(androidCode),nativeSdk:'0.1.0-rc.23.native.2',harnessReportingVersion:'rc.25 (unchanged native shell)',dedicatedAccountsRetained:true,iosUDID:previous.iosUDID,iosBundle:previous.iosBundle,androidSerial:previous.androidSerial,androidBundle:previous.androidBundle,scope:'approval expiry only; never approve before displayed request expiry'},null,2));
console.log(out);
