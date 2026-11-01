// Redirect only Core test imports to a source build in memory; no frozen dist edits.
import {registerHooks} from 'node:module';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../source');
const {build}=createRequire(pathToFileURL(root+'/package.json'))('esbuild');
const result=await build({entryPoints:[root+'/packages/core/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const target=pathToFileURL(root+'/packages/core/dist/esm/index.js').href;
const hostTarget=pathToFileURL(root+'/packages/host/dist/esm/index.js').href;
const host=await build({entryPoints:[root+'/packages/host/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['@tbc-wallet/core'],logLevel:'silent'});
const releaseTarget=pathToFileURL(root+'/packages/core/dist/esm/release.js').href;
registerHooks({
 resolve(s,c,n){if(s==='@tbc-wallet/core')return{url:target,shortCircuit:true};if(s==='@tbc-wallet/host')return{url:hostTarget,shortCircuit:true};if(new URL(s,c.parentURL).href===releaseTarget)return{url:releaseTarget,shortCircuit:true};return n(s,c)},
 load(url,ctx,next){return url===target?{format:'module',source:result.outputFiles[0].text,shortCircuit:true}
 :url===hostTarget?{format:'module',source:host.outputFiles[0].text,shortCircuit:true}
 :url===releaseTarget?{format:'module',source:`export {TWS_RELEASE} from ${JSON.stringify(target)}`,shortCircuit:true}:next(url,ctx)}
});
