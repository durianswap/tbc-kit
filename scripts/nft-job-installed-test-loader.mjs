// Resolve package test imports into the fresh installed candidate; do not edit dist.
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.TBC_STRESS_SOURCE_ROOT?resolve(process.env.TBC_STRESS_SOURCE_ROOT,'packages/kit'):resolve(import.meta.dirname,'../source/packages/kit');
const installed=process.env.TBC_TEST_INSTALLED_KIT;
if(!installed)throw Error('TBC_TEST_INSTALLED_KIT is required');
const prefix=pathToFileURL(root+'/dist/').href;
registerHooks({resolve(s,c,n){
 if(s==='@wallet-standard/core')return n(pathToFileURL(resolve(installed,'../../@wallet-standard/core/lib/esm/index.js')).href,c);
 if(s==='@tbc/kit')return n(pathToFileURL(installed+'/dist/esm/index.node.js').href,c);
 let u;try{u=new URL(s,c.parentURL).href}catch{return n(s,c)}
 if(u.startsWith(prefix))return n(pathToFileURL(installed+'/dist/'+u.slice(prefix.length)).href,c);
 return n(s,c);
}});
