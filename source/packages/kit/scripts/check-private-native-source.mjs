// Focused source gate; no dist rebuild, native wallet, secrets or network.
import {build} from 'esbuild';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const result=await build({entryPoints:[root+'packages/kit/test/legacy-wallet-private-native.test.mjs'],
  alias:{'@tbc-wallet/core':root+'packages/core/src/index.ts'},
  plugins:[{name:'source-private-native',setup(b){
    b.onResolve({filter:/dist\/esm\/wallet\.js$/},()=>({path:root+'packages/kit/src/legacy-wallet-private-native.ts'}));
  }}],bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
const url=new URL('../src/.private-native-source-check.mjs',import.meta.url).href;
const hook=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},
  load(u,c,n){return u===url?{source:result.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
await import(url);hook.deregister();
