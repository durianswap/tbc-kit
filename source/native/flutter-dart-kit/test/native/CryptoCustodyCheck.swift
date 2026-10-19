import Foundation
import CryptoKit

private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func hash(_ v:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
@MainActor private var checks=0
@MainActor private func yes(_ v:Bool){precondition(v,"crypto check \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var rejected=false;do{try f()}catch{rejected=true};yes(rejected)}
@MainActor private final class Accounts:NativeAccountSource{
 var current:NativeAccount;var revision:Int64=0;var unlocked=true
 init(_ a:NativeAccount){current=a}
}
@MainActor private final class Store:NativePermissionBackend{
 var rows=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{rows}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();precondition((rows[origin]?.revision ?? 0)==expected);let s=PermissionSnapshot(revision:expected+1,records:records);rows[origin]=s;writes+=1;return PermissionCommitResult(acknowledgedRevision:s.revision,current:s)
 }
}
@MainActor private final class UI:NativeApprovalPresenter{
 var pending:(@MainActor (Bool)->Void)?,shown=0
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;pending=complete;return {self.pending=nil}}
 func choose(_ value:Bool=true){let f=pending!;pending=nil;f(value)}
}
@MainActor private final class Digest:NativeDigestSigner{
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){preconditionFailure("crypto used digest signer")}
}
@MainActor private final class Vault:NativeBie1Executor{
 let account:NativeAccount,expected:[UInt8],output:[UInt8];var calls=0,used=0,hold=false,fail=false
 var release:(@MainActor ()->Void)?,afterUse:(@MainActor ()->Void)?
 init(_ sample:[String:Any],_ a:NativeAccount)throws{
  account=a;let audit=map(sample["audit"]);expected=try NativeCrypto.input(map(audit["task"]))
  let r=map(audit["cryptoResult"]);output=Array(Data(base64Encoded:(r["ciphertext"] ?? map(r["message"])["data"]) as! String)!)
 }
 func execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:[UInt8],requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  calls+=1;let work={@MainActor in complete(Result{
   try requireCurrent();precondition(account==self.account && input==self.expected)
   if self.fail{throw NativeCustodyFailure(code:"OPAQUE_CRYPTO_FAILURE")};self.used+=1;self.afterUse?();return self.output
  })};if hold{release=work}else{work()}
 }
}
@MainActor private final class Document{var scope:[String:String]?}
@MainActor private final class Harness{
 let sample:[String:Any],account:NativeAccount,accounts:Accounts,store=Store(),ui=UI(),digest=Digest(),vault:Vault,custody:NativeCustody
 let scope:[String:String],context:[String:Any],request:[String:Any],audit:[String:Any],method:String,document=Document()
 let id:String
 init(_ sample:[String:Any],enabled:Bool=true)throws{
  self.sample=sample;let a=map(sample["account"]);account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
  accounts=Accounts(account);vault=try Vault(sample,account);context=map(sample["context"]);request=map(sample["request"]);audit=map(sample["audit"]);method=sample["method"] as! String
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="crypto-test";scope["committedUrl"]=(context["origin"] as! String)+"/dapp";self.scope=scope
  id=PermissionJSON.id("P4/rpc",scope["sessionId"]!,try PermissionJSON.canonical("crypto-request"))
  let doc=document;doc.scope=scope
  custody=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:digest,crypto:enabled ? vault:nil){_,s in doc.scope==s}
  try custody.navigation(owner:"view",scope:scope)
 }
 func grant(crypto:Bool=true)throws{
  var result:Result<[[String:Any]],Error>?
  var request:[String:Any]=["tbc_accounts":["chains":[account.chainId]]];if crypto{request["tbc_crypto"]=["chains":[account.chainId]]}
  try custody.requestPermissions(owner:"view",scope:scope,id:"grant",request:request){result=$0};ui.choose();_ = try result!.get()
 }
 func begin()throws{_ = try custody.begin(owner:"view",scope:scope,id:id,method:method,expectedRevision:custody.snapshot(owner:"view",scope:scope).revision,expectedAccount:account)}
 func consent(_ approve:Bool=true)throws{
  var result:Result<Bool,Error>?;try custody.consent(owner:"view",scope:scope,id:id,method:method,request:request,context:context){result=$0};ui.choose(approve);yes(try result!.get()==approve)
 }
 func bind(_ plan:[String:Any]?=nil)throws->[String:Any]{try custody.bind(owner:"view",scope:scope,id:id,binding:map(audit["binding"]),preview:map(audit["preview"]),plan:plan ?? map(audit["plan"]),envelope:nil)}
 func ready()throws->[String:Any]{try grant();try begin();try consent();return try bind()}
 func run(_ receipt:[String:Any],task:[String:Any]?=nil,complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  try custody.executeCrypto(owner:"view",scope:scope,id:id,receipt:receipt,task:task ?? map(audit["task"]),complete:complete)
 }
}
@MainActor private func hostCheck(_ sample:[String:Any],fail:Bool=false)throws{
 let h=try Harness(sample),host=NativeWalletHost(custody:h.custody){_,_,_ in}
 try host.navigation(owner:"view",scope:h.scope)
 let receipt=try h.ready()
 func call(_ method:String,_ fields:[String:Any])->[String:Any]{
  var reply:[String:Any]?;host.dispatch(method:method,input:["ownerId":"view","scope":h.scope].merging(fields){_,b in b}){reply=$0};return reply!
 }
 func delivery(_ result:Any)throws->String{
  let payload:[String:Any]=["response":["jsonrpc":"2.0","id":"crypto-request","result":result],"events":[Any]()]
  return try PermissionJSON.canonical(["channel":"tws-webview/1","type":"delivery","sessionId":h.scope["sessionId"]!,"navigationId":h.scope["navigationId"]!,"messageId":"crypto-host","deliveryId":try hash(payload)].merging(payload){_,b in b})
 }
 func prepare(_ text:String,_ method:String?=nil)->Bool{call("delivery.prepare",["method":method ?? h.method,"requestId":"crypto-request","serialized":text])["ok"] as? Bool==true}
 func allow(_ text:String)->Bool{host.allowDelivery(owner:"view",scope:h.scope,text:text)}
 let text=try delivery(sample["result"]!)
 yes(!prepare(text) && !allow(text))
 h.vault.fail=fail
 let reply=call("signing.crypto",["operation":h.id,"receipt":receipt,"task":h.audit["task"]!])
 if fail{
  yes(try PermissionJSON.canonical(reply)==PermissionJSON.canonical(["ok":false,"code":"NATIVE_DENIED"]))
  yes(!prepare(text) && !allow(text));return
 }
 yes(try reply["ok"] as? Bool==true && PermissionJSON.canonical(reply["value"]) == PermissionJSON.canonical(h.audit["cryptoResult"]))
 yes(call("signing.close",["operation":h.id])["ok"] as? Bool==true)
 yes(!allow(text));yes(prepare(text) && allow(text))
 var changed=map(sample["result"]);changed["from"]="other-account";let altered=try delivery(changed)
 yes(!prepare(altered) && !allow(altered))
 yes(!prepare(text,h.method=="tbc_encrypt" ? "tbc_decrypt":"tbc_encrypt"))
 h.accounts.unlocked=false;yes(!allow(text))
}
@main struct CryptoCustodyCheck{
 @MainActor static func main()throws{
  let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),original=root["original"] as! [[String:Any]],cases=root["fresh"] as! [[String:Any]]
  for s in original{
   let h=try Harness(s),p=try NativeCrypto.plan(h.request,method:h.method,context:h.context,account:h.account,expiresAt:map(map(h.audit["plan"])["payload"])["expiresAt"] as! String)
   yes(try PermissionJSON.canonical(p)==PermissionJSON.canonical(h.audit["plan"]))
   yes(try PermissionJSON.canonical(NativeCrypto.bound(request:h.request,method:h.method,context:h.context,account:h.account,binding:map(h.audit["binding"]),plan:p,preview:map(h.audit["preview"])))==PermissionJSON.canonical(h.audit["task"]))
  }
  for s in cases{
   let h=try Harness(s),r=try h.ready();var result:Result<[String:Any],Error>?
   try h.run(r){result=$0};let value=try result!.get()
   yes(try PermissionJSON.canonical(value)==PermissionJSON.canonical(h.audit["cryptoResult"]));yes(h.ui.shown==2 && h.vault.used==1 && h.store.writes==1)
   rejects{try h.run(r){_ in}};try h.custody.close(owner:"view",scope:h.scope,id:h.id)
   let digest=try hash(s["result"])
   yes(h.custody.mayDeliverCryptoResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:digest))
   yes(!h.custody.mayDeliverCryptoResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:String(repeating:"0",count:64)))
   yes(!h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:h.id))
   h.accounts.unlocked=false;yes(!h.custody.mayDeliverCryptoResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:digest))
  }
  try hostCheck(cases[0]);try hostCheck(cases[1]);try hostCheck(cases[1],fail:true)
  let sample=cases[0]
  do {
   let h=try Harness(sample),task=map(h.audit["task"])
   for (text,allowed) in [(String(repeating:"中",count:21845)+"a",true),(String(repeating:"😀",count:16384),true),(String(repeating:"中",count:21846),false),(String(repeating:"😀",count:16385),false)] {
    var t=task;t["message"]=["encoding":"utf8","data":text]
    if allowed{yes(try NativeCrypto.input(t).count==65536)}else{rejects{_ = try NativeCrypto.input(t)}}
   }
   for (encoding,data) in [("hex",String(repeating:"01",count:65536)),("base64",Data(repeating:1,count:65536).base64EncodedString())] {
    var t=task;t["message"]=["encoding":encoding,"data":data];yes(try NativeCrypto.input(t).count==65536)
   }
   var t=task;t["purpose"]="decrypt"
   let old=String(repeating:"中",count:24000),value=try NativeCrypto.result(t,output:Array(old.utf8))
   yes(map(value["message"])["encoding"] as? String=="utf8" && map(value["message"])["data"] as? String==old)
   rejects{_ = try NativeCrypto.result(t,output:Array(repeating:255,count:72000))}
   rejects{_ = try NativeCrypto.result(t,output:Array(repeating:97,count:65539))}
   let short=try NativeCrypto.result(t,output:Array("中".utf8));yes(map(short["message"])["encoding"] as? String=="base64")
  }
  do{let h=try Harness(sample,enabled:false);yes(try h.custody.snapshot(owner:"view",scope:h.scope).optionalMethods.isEmpty);rejects{try h.grant()};try h.grant(crypto:false);rejects{try h.begin()};yes(h.vault.calls==0)}
  do{let h=try Harness(sample);yes(try Set(h.custody.snapshot(owner:"view",scope:h.scope).optionalMethods)==NativeCrypto.methods)}
  do{let h=try Harness(sample);try h.grant(crypto:false);rejects{try h.begin()};yes(h.vault.calls==0)}
  do{let h=try Harness(sample);try h.grant();try h.begin();try h.consent(false);rejects{_ = try h.bind()};yes(h.vault.calls==0)}
  do{let h=try Harness(sample),r=try h.ready();var t=map(h.audit["task"]);t["origin"]="https://other.example";rejects{try h.run(r,task:t){_ in}};yes(h.vault.calls==0)}
  do{let h=try Harness(sample);try h.grant();try h.begin();try h.consent();var p=map(h.audit["plan"]),body=map(p["payload"]),t=map(body["task"]);t["publicKey"]="other";body["task"]=t;p["payload"]=body;p["planHash"]=try hash(body);rejects{_ = try h.bind(p)};yes(h.vault.calls==0)}
  for mode in ["lock-before","lock-after","navigation","failure"]{
   let h=try Harness(sample),r=try h.ready();var result:Result<[String:Any],Error>?,count=0
   h.vault.hold=true;try h.run(r){result=$0;count+=1};yes(result==nil)
   if mode=="lock-before"{h.accounts.unlocked=false}
   if mode=="lock-after"{h.vault.afterUse={h.accounts.unlocked=false}}
   if mode=="navigation"{h.document.scope=nil;h.custody.invalidate(owner:"view")}
   if mode=="failure"{h.vault.fail=true}
   h.vault.release!();yes(result != nil);rejects{_ = try result!.get()};yes(count==1 && h.vault.used==(mode=="lock-after" ? 1:0))
   yes(!h.custody.mayDeliverCryptoResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:try hash(sample["result"])))
  }
  print("{\"status\":\"PASS\",\"cases\":\(cases.count),\"checks\":\(checks),\"proof\":\"native-custody-public-replay\",\"broadcasts\":0}")
 }
}
