// Real loopback wire behavior on macOS Foundation and actual Android emulator.
// No public node, wallet App, keys, TLS override or blockchain submission.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const javaHome=process.env.JAVA_HOME;assert(javaHome);
const android=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),device=process.env.TBC_ANDROID_DEVICE??'emulator-5554';
assert(/^emulator-[0-9]+$/.test(device));
const adb=join(android,'platform-tools/adb'),jarRoot=join(homedir(),'.gradle/caches/modules-2/files-2.1');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function jar(group,name,version){const root=join(jarRoot,group,name,version),hits=[];
 for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(root,d.name)))if(f===`${name}-${version}.jar`)hits.push(join(root,d.name,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(v=>jar(...v)));
const scratch=await mkdtemp('/private/tmp/tbc-dart-broadcast-http-'),remote='/data/local/tmp/'+scratch.split('/').at(-1);
const opts={cwd:base,maxBuffer:2**20,timeout:120000,env:{...process.env,JAVA_HOME:javaHome}};
const swift=['platform/ios/Classes/NativeBroadcastHTTP.swift','platform/ios/Classes/NativeBroadcastStore.swift','test/native/BroadcastHTTPCheck.swift'],
 kotlin=['platform/android/src/main/kotlin/io/tbc/kit/dart/NativeBroadcastHTTP.kt','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeBroadcastStore.kt','test/native/BroadcastHTTPCheck.kt'];
let port,trace=[],active='setup';
const server=createServer((req,res)=>{
 const row={platform:active,path:req.url,method:req.method,bodyBytes:0};trace.push(row);
 req.on('data',b=>{row.bodyBytes+=b.length;});req.on('error',()=>{});res.on('error',()=>{});
 req.on('end',()=>{
  row.ended=true;row.contentType=req.headers['content-type']??null;
  row.cookiePresent=!!req.headers.cookie;row.authorizationPresent=!!req.headers.authorization;
  switch(req.url){
   case '/ok':res.writeHead(200,{'Content-Type':'application/json'});res.end('{"code":200}');break;
   case '/redirect':res.writeHead(307,{Location:`http://127.0.0.1:${port}/target`});res.end('redirect');break;
   case '/not-found':res.writeHead(404);res.end('{}');break;
   case '/auth':res.writeHead(401,{'WWW-Authenticate':'Basic realm="test"'});res.end('{}');break;
   case '/large-header':res.writeHead(200,{'Content-Length':'5000'});res.end('x'.repeat(5000));break;
   case '/large-stream':res.writeHead(200);res.write('x'.repeat(3000));setTimeout(()=>res.end('x'.repeat(3000)),10);break;
   case '/slow':case '/slow-cancel':setTimeout(()=>{if(!res.destroyed){res.writeHead(200);res.end('late');}},600);break;
   case '/drop':req.socket.destroy();break;
   default:res.writeHead(500);res.end('{}');
  }
 });
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 assert.equal((await run(adb,['-s',device,'get-state'],opts)).stdout.trim(),'device');
 const api=(await run(adb,['-s',device,'shell','getprop','ro.build.version.sdk'],opts)).stdout.trim();
 const androidJar=join(android,'platforms/android-36/android.jar');
 const compiles=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-swift-version','6','-parse-as-library',...swift,'-o',join(scratch,'http-check')],opts),
  run(join(javaHome,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin],opts),
 ]);
 await run(join(javaHome,'bin/jar'),['cf',join(scratch,'http.jar'),'-C',join(scratch,'classes'),'.'],opts);
 const dex=await run(join(android,'build-tools/36.0.0/d8'),['--lib',androidJar,'--min-api','26','--output',join(scratch,'http-dex.jar'),join(scratch,'http.jar'),compiler[1]],opts);
 await run(adb,['-s',device,'shell','mkdir','-p',remote],opts);
 await run(adb,['-s',device,'push',join(scratch,'http-dex.jar'),remote+'/http.jar'],opts);
 await run(adb,['-s',device,'reverse',`tcp:${port}`,`tcp:${port}`],opts);
 const origin=`http://127.0.0.1:${port}`,results=[];
 const parse=r=>{const line=r.stdout.trim().split('\n').findLast(l=>l.startsWith('{')&&l.includes('"status"'));assert(line,r.stdout.slice(-2000));return JSON.parse(line);};
 for(const platform of ['swift-macos-foundation','kotlin-android-httpurlconnection']){
  active=platform;
  const start=Date.now();
  const result=platform.startsWith('swift')?
   await run(join(scratch,'http-check'),[origin,join(scratch,'swift-db')],opts):
   await run(adb,['-s',device,'shell',`CLASSPATH=${remote}/http.jar`,'/system/bin/app_process','/system/bin','io.tbc.kit.dart.BroadcastHTTPCheckKt',origin,remote+'/db'],opts);
  const native=parse(result);assert.equal(native.status,'PASS');
  const calls=trace.filter(r=>r.platform===platform);
  for(const path of ['/ok','/redirect','/not-found','/auth','/large-header','/large-stream','/slow','/drop'])assert.equal(calls.filter(r=>r.path===path).length,1,platform+path);
  assert(calls.filter(r=>r.path==='/slow-cancel').length<=1);
  for(const path of ['/target','/forbidden','/expired','/foreign'])assert.equal(calls.filter(r=>r.path===path).length,0,platform+path);
  assert(calls.every(r=>!r.cookiePresent&&!r.authorizationPresent));
  assert(calls.filter(r=>r.method==='POST').every(r=>r.bodyBytes===22&&r.contentType==='application/json'));
  assert.equal(calls.filter(r=>r.method==='GET').length,1);
  results.push({platform,...native,observedRequests:calls,totalHarnessMilliseconds:Date.now()-start,diagnostics:result.stderr});
 }
 assert.deepEqual(results[0].cases,results[1].cases);
 const protection=JSON.parse((await run(process.execPath,['tool/check_protected.mjs'],opts)).stdout);
 const sourceHashes={};for(const p of [...swift,...kotlin,'tool/check_native_broadcast_http.mjs'])sourceHashes[p]=sha(await readFile(join(base,p)));
 const parentPath='evidence/f3-send-lifecycle-design.json';
 const report={status:'F3_NATIVE_BROADCAST_HTTP_ADMISSION_LOOPBACK_PASS',recordedAt:new Date().toISOString(),
  parent:{path:parentPath,sha256:sha(await readFile(join(base,parentPath)))},sourceHashes,results,protection,scratch,
  android:{device,api,remote,runner:'test-only app_process shell; no wallet App changed'},
  warnings:[...compiles.map(r=>r.stderr),dex.stderr].filter(Boolean),
  proof:['Actual Foundation/Android HTTP sockets, bounded streamed responses, fixed configured timeout, cancellation completion once, one request and no follow/retry for redirect/auth/drop fixtures.',
   'Each synthetic POST enters actual native SQLite one-use admission first; revoke before start audits not-submitted and creates no request. Actual started failure remains uncertain; consumed admission cannot replay.',
   'Production request factory permits fixed HTTPS-origin paths only, no credentials/query/fragment; isolated loopback wire values exist only in test code. No production TLS validation override.',
   'No new HTTP/database dependency, read-before-POST, second approval, transaction computation or signing-only persistence. Response data remains in memory and native error messages are fixed.'],
  limits:['Transport and store integration only, not native consent/task/final-bundle authorization, Flutter private-channel/worker or Provider send integration.',
   'Swift executed on macOS, Android on actual API36 shell runner, not installed iOS/Android wallet App or minimum-OS/physical device.',
   'No HTTPS live-node, private wallet/Testnet, matched transaction performance, App size or final partner delivery acceptance. Loopback harness durations are not signing/performance measurements.'],
  next:'Bind this native transport to exact approved operation/finalized result and opaque admission inside NativeCustody, with wallet-owned source. Then private channel/worker and public sends, installed paired device/private Testnet and remaining final scope.',
  loopbackHttp:trace.length,publicNodeHttp:0,blockchainBroadcasts:0,publicDeviceMethods:17,requiredMethods:22,
  acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
 const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results:results.map(r=>({platform:r.platform,checks:r.checks,cases:r.cases.length,requests:r.observedRequests.length})),sha256:sha(bytes),scratch,output}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-8000),stdout:e.stdout?.slice(-2500),trace,scratch}));process.exitCode=1;}
finally{
 if(port)await run(adb,['-s',device,'reverse','--remove',`tcp:${port}`],opts).catch(()=>{});
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
