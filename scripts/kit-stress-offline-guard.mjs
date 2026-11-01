// Test-only: forbid accidental public network access in the offline stress suite.
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const allowed=h=>['localhost','127.0.0.1','::1','[::1]'].includes(h);
const fetch=globalThis.fetch;
globalThis.fetch=(input,...rest)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed(url.hostname))throw Error('Offline stress forbids public fetch: '+url.origin);return fetch(input,...rest)};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const opt=args[0];let host;
 if(typeof opt==='object'&&opt&&!Array.isArray(opt))host=opt.host;
 else if(typeof opt==='number'&&typeof args[1]==='string')host=args[1];
 if(host&&!allowed(host))throw Error('Offline stress forbids external socket');return connect.apply(this,args)};
syncBuiltinESMExports();
