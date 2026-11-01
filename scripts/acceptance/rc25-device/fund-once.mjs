import{readFile}from'node:fs/promises';import{resolve,join}from'node:path';import assert from'node:assert/strict';
const root=resolve(import.meta.dirname,'../../../.verify/rc25-real'),platform=process.argv[2];assert(['ios','android'].includes(platform));
let source=await readFile('/Users/alex/Documents/Codex/2026-09-02/tws-standard-mobile-p0/native/kit-runtime/closed-loop/fund-testnet-native.mjs','utf8');
assert.equal(source.split("'10000'").length,5);
source=source.replaceAll("'10000'","'1000000'").replaceAll("'200'","'2000'").replaceAll("new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z')","new Date().toISOString()");
const c=JSON.parse(await readFile(join(root,'candidate.json')));
process.argv=['node','reviewed-testnet-funding-helper',c.consumer,join(root,platform+'-account.json'),join(root,'funding-'+platform),'--fund-once'];
try{await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}catch(e){console.error(JSON.stringify({stage:'funding-helper',error:e.message}));process.exitCode=1;}
