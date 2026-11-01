// Redirect only Core test imports to a source build in memory; no frozen dist edits.
import {registerHooks} from 'node:module';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../source');
const {build}=createRequire(pathToFileURL(root+'/package.json'))('esbuild');
const result=await build({entryPoints:[root+'/packages/core/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const target=pathToFileURL(root+'/packages/core/dist/esm/index.js').href;
registerHooks({load(url,ctx,next){return url===target?{format:'module',source:result.outputFiles[0].text,shortCircuit:true}:next(url,ctx)}});
