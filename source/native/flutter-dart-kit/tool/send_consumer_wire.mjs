// Acceptance-only generated-source transform. Never applied to runtime source.
// Native validates the official source/path/body and owns the journal/fence;
// only the final wire destination is substituted, using public fixture keys.
import assert from 'node:assert/strict';
export function sendConsumerSource(file,bytes,profile){
 if(profile!=='send')return bytes;
 const replacements={
  'TbcDartWalletHost.swift':[
   'try http.start(request,fence:fence,complete:reply)',
   'try http.start(NativeBroadcastHTTPRequest(sourceIdentity:request.sourceIdentity,method:request.method,url:URL(string:"http://127.0.0.1:41878"+request.url.path)!,body:request.body,deadline:request.deadline,maximumResponseBytes:request.maximumResponseBytes),fence:fence,complete:reply)',
  ],
  'TbcDartWalletHost.kt':[
   'http.start(request,fence,reply)',
   'http.start(NativeBroadcastHTTPRequest(request.sourceIdentity,request.method,java.net.URL("http://127.0.0.1:41878"+request.url.path),request.body,request.deadline,request.maximumResponseBytes),fence,reply)',
  ],
  'AppDelegate.swift':[
   'crypto:wallet,allowInsecureLoopback:true)',
   'crypto:wallet,allowInsecureLoopback:true,broadcast:try NativeBroadcastConfiguration(network:"testnet"),broadcastDirectory:directory,broadcastProfile:"f3-send-"+UUID().uuidString)',
  ],
  'MainActivity.kt':[
   'crypto=wallet)',
   'crypto=wallet,broadcast=NativeBroadcastConfiguration("testnet"),broadcastDirectory=filesDir,broadcastProfile="f3-send-"+java.util.UUID.randomUUID().toString())',
  ],
 };
 if(!replacements[file])return bytes;
 const [before,after]=replacements[file],text=bytes.toString();
 assert.equal(text.split(before).length,2,`One explicit test seam in ${file}`);
 return Buffer.from(text.replace(before,after));
}
