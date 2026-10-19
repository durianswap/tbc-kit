import Foundation
import CryptoKit

// Public frozen Engine plans/signatures only. Synthetic native journal states
// exercise custody advancement, not HTTP/node acceptance or new key use.
private func map(_ x:Any?)->[String:Any]{x as! [String:Any]}
private func rows(_ x:Any?)->[[String:Any]]{x as! [[String:Any]]}
private func hash(_ x:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(x).utf8)).map{String(format:"%02x",$0)}.joined()}
private func stamp(_ seconds:Double)->String{let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f.string(from:Date().addingTimeInterval(seconds))}
@MainActor private var checks=0
@MainActor private func yes(_ b:Bool){precondition(b,"maintenance check \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var denied=false;do{try f()}catch{denied=true};yes(denied)}
@MainActor private final class Accounts:NativeAccountSource{
 var current:NativeAccount,revision:Int64=0,unlocked=true
 init(_ a:NativeAccount){current=a}
}
@MainActor private final class Store:NativePermissionBackend{
 var records=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{records}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{try fence();precondition((self.records[origin]?.revision ?? 0)==expected);let s=PermissionSnapshot(revision:expected+1,records:records);self.records[origin]=s;writes+=1;return PermissionCommitResult(acknowledgedRevision:s.revision,current:s)}
}
@MainActor private final class UI:NativeApprovalPresenter{
 var pending=[String:@MainActor (Bool)->Void](),shown=0
 func present(_ r:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;pending[r.operationId]=complete;return {self.pending.removeValue(forKey:r.operationId)}}
 func choose(_ id:String,_ approved:Bool=true){pending.removeValue(forKey:id)!(approved)}
}
@MainActor private final class Signer:NativeDigestSigner{
 let sample:[String:Any];var calls=0
 init(_ s:[String:Any]){sample=s}
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  complete(Result{try requireCurrent();let audit=map(sample["audit"]),tasks=rows(map(map(audit["plan"])["payload"])["signingTasks"]),d=digest.map{String(format:"%02x",$0)}.joined()
   guard let t=tasks.first(where:{$0["digest"] as? String==d && $0["accountId"] as? String==account.accountId && $0["publicKey"] as? String==account.publicKey && $0["signatureEncoding"] as? String==encoding}),let s=rows(audit["signatures"]).first(where:{$0["taskId"] as? String==t["taskId"] as? String})else{throw NativeCustodyFailure(code:"UNRECORDED_TASK")}
   calls+=1;let raw=Array((s["signature"] as! String).utf8);return stride(from:0,to:raw.count,by:2).map{UInt8(String(bytes:raw[$0..<$0+2],encoding:.utf8)!,radix:16)!}
  })
 }
}
@MainActor private final class Harness{
 let sample:[String:Any],account:NativeAccount,accounts:Accounts,store=Store(),ui=UI(),signer:Signer,c:NativeCustody,scope:[String:String],context:[String:Any]
 var consent:[String:Any],approval=[String:Any](),request=[String:Any](),step=[String:Any](),receipt=[String:Any]()
 var id="child",inputs:[String];var status="accepted"
 var parent="merge"
 lazy var host=NativeWalletHost(custody:c){_,_,_ in}
 init(_ s:[String:Any],register:Bool=true)throws{
  sample=s;let a=map(s["account"]);account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String);accounts=Accounts(account);signer=Signer(s)
  context=map(s["context"]);var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="merge-test";scope["committedUrl"]=scope["origin"]!+"/dapp";self.scope=scope
  consent=map(s["consent"]);var limits=map(consent["limits"]);limits["expiresAt"]=stamp(240);consent["limits"]=limits;inputs=s["selectedInputs"] as! [String]
  c=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:signer,sendSourceIdentity:String(repeating:"a",count:64)){owner,value in owner=="view" && value==scope}
  if register{try c.registerBroadcast()};try c.navigation(owner:"view",scope:scope)
 }
 func grant(_ send:Bool=true)throws{
  var req:[String:Any]=["tbc_accounts":["chains":[account.chainId]]];if send{req["tbc_sendTransaction"]=["chains":[account.chainId]]}
  var r:Result<[[String:Any]],Error>?;try c.requestPermissions(owner:"view",scope:scope,id:"grant",request:req){r=$0};ui.choose("grant");_ = try r!.get()
 }
 func approve(_ choice:Bool=true)throws{
  var reply:[String:Any]?;host.dispatch(method:"maintenance.begin",input:["ownerId":"view","scope":scope,"operation":parent,"revision":try c.snapshot(owner:"view",scope:scope).revision,"account":account.identity,"consent":consent]){reply=$0}
  if reply==nil{yes(ui.pending[parent] != nil);ui.choose(parent,choice)}
  guard reply?["ok"] as? Bool==true else{throw NativeCustodyFailure(code:"TEST_DENIED")};approval=map(reply!["value"])
 }
 func prepare(index:Int=1,fee:String="100000")throws{
  let expiry=map(consent["limits"])["expiresAt"]!,identity=try hash(["domain":"tbc-kit/multi-round-step/1","scopeHash":hash(consent),"approvalId":approval["approvalId"]!,"stepIndex":index])
  request=map(sample["request"]);request["clientRequestId"]="kit-multi-round-"+identity;request["constraints"]=["maxFee":fee,"feePreference":"standard","expiresAt":expiry]
  step=["version":"1.0","stepId":"merge-\(index)","stepIndex":index,"authority":consent["authority"]!,"asset":consent["asset"]!,"stateHash":consent["initialStateHash"]!,"materialHash":try hash(request),"inputCount":inputs.count,"outputCount":1,"feeKind":"maximum","fee":fee,"expiresAt":expiry,"dependsOn":[String]()]
 }
 func begin()throws{var r:[String:Any]?;host.dispatch(method:"maintenance.step",input:["ownerId":"view","scope":scope,"parent":parent,"operation":id,"step":step,"request":request,"selectedInputs":inputs]){r=$0};guard r?["ok"] as? Bool==true else{throw NativeCustodyFailure(code:"TEST_DENIED")}}
 func consentChild()throws{var r:Result<Bool,Error>?;try c.consent(owner:"view",scope:scope,id:id,method:"tbc_sendTransaction",request:request,context:context){r=$0};yes(try r!.get());yes(ui.shown==2)}
 func bind(_ mutation:String?=nil)throws{
  let audit=map(sample["audit"]);var p=map(map(audit["plan"])["payload"]),preview=map(audit["preview"])
  if mutation=="recipient"{var f=rows(preview["assetFlows"]);f[0]["to"]="other";preview["assetFlows"]=f}
  if mutation=="fee"{preview["totalFee"]="100001"}
  p["requestHash"]=try hash(request);p["expiresAt"]=map(request["constraints"])["expiresAt"];p["preview"]=preview
  let plan:[String:Any]=["payload":p,"planHash":try hash(p)];var b=map(map(audit["binding"])["payload"])
  b["requestHash"]=try hash(request);b["operationHash"]=plan["planHash"];b["method"]="tbc_sendTransaction";b["expiresAt"]=stamp(120)
  receipt=try c.bind(owner:"view",scope:scope,id:id,binding:["payload":b,"bindingHash":try hash(b)],preview:preview,plan:plan,envelope:nil)
 }
 func signAndOwn()throws->[String:Any]{
  let tasks=rows(map(map(map(sample["audit"])["plan"])["payload"])["signingTasks"])
  for t in tasks{var r:Result<[String:Any],Error>?;try c.sign(owner:"view",scope:scope,id:id,receipt:receipt,task:t){r=$0};_ = try r!.get()}
  var bundle=map(sample["result"]);bundle["approvalId"]=receipt["approvalId"];bundle["requestHash"]=try hash(request)
  try c.authorizeBroadcast(owner:"view",scope:scope,id:id,receipt:receipt,bundle:bundle)
  let txs=rows(bundle["transactions"]);try c.ownBroadcast(owner:"view",scope:scope,id:id,key:"single:0",state:{[["txid":txs[0]["txid"] as! String,"status":self.status]]},close:{},recoveryId:"native-journal-fixture")
  bundle["transactions"]=txs.map{["id":$0["id"]!,"txid":$0["txid"]!,"role":$0["role"]!,"dependsOn":$0["dependsOn"]!,"status":"submitted"]};return bundle
 }
 func ready()throws{try grant();try approve();try prepare();try begin();try consentChild()}
 func summary(_ sent:[String:Any]?,terminal:String?=nil)throws->[String:Any]{
  var row:[String:Any]=["stepId":step["stepId"]!,"status":terminal ?? status,"fee":sent?["totalFee"] ?? "0","inputCount":inputs.count,"outputCount":1,"dependsOn":step["dependsOn"]!]
  if terminal==nil{row["txid"]=rows(sent!["transactions"])[0]["txid"]}
  if terminal=="uncertain"{row["fee"]=step["fee"];row["recoveryId"]="native-journal-fixture"}
  let initial=consent["initialUtxoCount"] as! Int,final=terminal==nil ? initial-inputs.count+1:initial
  let complete=terminal==nil && final<=1
  return ["version":"1.0","scopeHash":try hash(consent),"approvalId":approval["approvalId"]!,"initialUtxoCount":initial,"finalUtxoCount":final,"totalFee":row["fee"]!,"steps":[row],"status":terminal=="uncertain" ? "uncertain":terminal != nil ? "stopped":complete ? "complete":"partial","reason":terminal=="uncertain" ? "broadcast-uncertain":terminal != nil ? "step-failed":complete ? "target-reached":"index-stalled"]
 }
 func finish(_ value:[String:Any])throws{
  var reply:[String:Any]?;host.dispatch(method:"maintenance.finish",input:["ownerId":"view","scope":scope,"operation":parent,"result":value]){reply=$0}
  guard reply?["ok"] as? Bool==true else{throw NativeCustodyFailure(code:"TEST_DENIED")}
 }
 func noopResult()throws->[String:Any]{["version":"1.0","status":"complete","reason":"already-below-target","scopeHash":try hash(consent),"initialUtxoCount":consent["initialUtxoCount"]!,"finalUtxoCount":consent["initialUtxoCount"]!,"totalFee":"0","steps":[]]}
 func noop(_ value:[String:Any])throws{
  var reply:[String:Any]?;host.dispatch(method:"maintenance.noop",input:["ownerId":"view","scope":scope,"operation":parent,"revision":try c.snapshot(owner:"view",scope:scope).revision,"account":account.identity,"consent":consent,"result":value]){reply=$0}
  guard reply?["ok"] as? Bool==true else{throw NativeCustodyFailure(code:"TEST_DENIED")}
  yes(try PermissionJSON.canonical(reply!["value"])==PermissionJSON.canonical(["status":"not-required"]))
 }
 func delivery(_ result:[String:Any],method:String="wallet_mergeMaintenance")throws->String{
  let response:[String:Any]=["jsonrpc":"2.0","id":"rpc-merge","result":result]
  let envelope:[String:Any]=["channel":"tws-webview/1","type":"delivery","sessionId":scope["sessionId"]!,"navigationId":scope["navigationId"]!,"messageId":"delivery","deliveryId":try hash(["response":response,"events":[]]),"response":response,"events":[]]
  let text=try PermissionJSON.canonical(envelope);var reply:[String:Any]?
  host.dispatch(method:"delivery.prepare",input:["ownerId":"view","scope":scope,"method":method,"requestId":"rpc-merge","serialized":text]){reply=$0}
  guard reply?["ok"] as? Bool==true else{throw NativeCustodyFailure(code:"TEST_DENIED")};return text
 }
 func projected(_ core:[String:Any])->[String:Any]{
  func row(_ phase:String,_ index:Int,_ count:Int,_ utxos:Any,_ fee:Any)->[String:Any]{["phase":phase,"stepIndex":index,"transactionCount":count,"utxoCount":utxos,"totalFee":fee,"targetUtxoCount":map(consent["limits"])["targetUtxoCount"]!]}
  let count=rows(core["steps"]).count
  var progress=[[String:Any]]()
  if core["approvalId"] != nil{progress.append(row("approval",0,0,core["initialUtxoCount"]!,"0"))}
  progress.append(row(core["status"] as? String=="complete" ? "complete":"executing",count,count,core["finalUtxoCount"]!,core["totalFee"]!))
  return core.merging(["atomic":false,"progress":progress]){_,b in b}
 }
}
@main @MainActor struct MaintenanceCheck{
 static func main()throws{
  let cases=rows(map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))))["cases"])
  var signatures=0
  for sample in cases{
   let h=try Harness(sample);try h.ready();try h.bind();let result=try h.signAndOwn();signatures+=h.signer.calls
   try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:result);rejects{try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:result)}
   try h.c.close(owner:"view",scope:h.scope,id:h.id);yes(try h.c.mayDeliverSendResult(owner:"view",scope:h.scope,id:h.id,method:"tbc_sendTransaction",resultHash:hash(result)));yes(h.ui.shown==2 && h.store.writes==1)
   let summary=try h.summary(result)
   for key in ["totalFee","approvalId","scopeHash","steps","status","finalUtxoCount"]{
    var bad=summary;bad[key]=key=="steps" ? []:key=="finalUtxoCount" ? -1:key=="status" ? "complete":"tampered"
    rejects{try h.finish(bad)}
   }
   for key in ["txid","fee","status","inputCount","dependsOn"]{
    var altered=rows(summary["steps"]);altered[0][key]=key=="inputCount" ? 0:key=="dependsOn" ? ["foreign"]:"tampered"
    var bad=summary;bad["steps"]=altered;rejects{try h.finish(bad)}
   }
   try h.finish(summary);yes(try h.c.mayDeliverMaintenanceResult(owner:"view",scope:h.scope,id:"merge",resultHash:hash(summary)))
   let projected=h.projected(summary)
   yes(try h.c.maintenanceProjectionHash(owner:"view",scope:h.scope,id:h.parent,result:projected)==hash(summary))
   for key in ["atomic","totalFee","progress","extra"]{
    var bad=projected;bad[key]=key=="atomic" ? true:key=="progress" ? []:"tampered"
    rejects{_ = try h.c.maintenanceProjectionHash(owner:"view",scope:h.scope,id:h.parent,result:bad)}
   }
   for key in ["phase","stepIndex","targetUtxoCount","transactionCount","utxoCount","totalFee","extra"]{
    var bad=projected,progress=rows(projected["progress"])
    progress[0][key]=key=="phase" ? "complete":key=="totalFee" ? "999999999":key=="extra" ? "secret":-1;bad["progress"]=progress
    rejects{_ = try h.c.maintenanceProjectionHash(owner:"view",scope:h.scope,id:h.parent,result:bad)}
   }
   yes(try !h.c.mayDeliverSendResult(owner:"view",scope:h.scope,id:h.id,method:"tbc_sendTransaction",resultHash:hash(result)))
   yes(!h.c.mayDeliverSignature(owner:"view",scope:h.scope,id:"merge"));yes(try !h.c.mayDeliverSendResult(owner:"view",scope:h.scope,id:"merge",method:"tbc_sendTransaction",resultHash:hash(summary)));rejects{try h.finish(summary)}
   h.id="next";try h.prepare(index:2,fee:String(100000-Int(result["totalFee"] as! String)!));rejects{try h.begin()}
   try h.c.closeMaintenance(owner:"view",scope:h.scope,id:"merge");rejects{try h.begin()}
  }
  let sample=cases[0]
  for count in [0,1]{
   let h=try Harness(sample);try h.grant();h.consent["initialUtxoCount"]=count;h.parent=PermissionJSON.id("P4/rpc",h.scope["sessionId"]!,"\"rpc-merge\"")
   let result=try h.noopResult();try h.noop(result);yes(h.ui.shown==1 && h.signer.calls==0 && h.store.writes==1)
   let text=try h.delivery(result);yes(h.host.allowDelivery(owner:"view",scope:h.scope,text:text))
   let wrapped=try h.delivery(h.projected(result),method:"wallet_runMultiRoundMerge");yes(h.host.allowDelivery(owner:"view",scope:h.scope,text:wrapped))
   rejects{_ = try h.delivery(result,method:"wallet_runMultiRoundMerge")};rejects{_ = try h.delivery(h.projected(result))}
   rejects{_ = try h.delivery(result,method:"tbc_sendTransaction")};rejects{_ = try h.delivery(result.merging(["totalFee":"1"]){_,b in b})}
   rejects{try h.noop(result)};h.accounts.unlocked=false;yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:text));yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:wrapped))
  }
  for change in ["above-target","negative","result","send-grant","account-grant","locked"]{
   let h=try Harness(sample);if change != "account-grant"{try h.grant(change != "send-grant")};h.consent["initialUtxoCount"]=change=="above-target" ? 2:change=="negative" ? -1:1
   if change=="locked"{h.accounts.unlocked=false};var result=try h.noopResult();if change=="result"{result["approvalId"]="forged"}
   let shown=h.ui.shown;rejects{try h.noop(result)};yes(h.ui.shown==shown && h.signer.calls==0)
  }
  do{
   let h=try Harness(sample);h.parent=PermissionJSON.id("P4/rpc",h.scope["sessionId"]!,"\"rpc-merge\"");try h.ready();try h.bind();let sent=try h.signAndOwn()
   try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:sent);try h.c.close(owner:"view",scope:h.scope,id:h.id);let result=try h.summary(sent);try h.finish(result)
   let text=try h.delivery(result);yes(h.host.allowDelivery(owner:"view",scope:h.scope,text:text));try h.c.disconnect(owner:"view",scope:h.scope,id:"disconnect");yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:text))
  }
  for terminal in ["failed","uncertain"]{
   let h=try Harness(sample);try h.ready();try h.bind()
   if terminal=="uncertain"{_ = try h.signAndOwn();h.status="unknown"}
   try h.c.close(owner:"view",scope:h.scope,id:h.id)
   let result=try h.summary(nil,terminal:terminal)
   var bad=result;bad["status"]="complete";bad["reason"]="target-reached";rejects{try h.finish(bad)}
   if terminal=="uncertain"{var r=rows(result["steps"]);r[0]["recoveryId"]="foreign";bad=result;bad["steps"]=r;rejects{try h.finish(bad)}}
   try h.finish(result);yes(try h.c.mayDeliverMaintenanceResult(owner:"view",scope:h.scope,id:"merge",resultHash:hash(result)))
   h.accounts.revision+=1;yes(try !h.c.mayDeliverMaintenanceResult(owner:"view",scope:h.scope,id:"merge",resultHash:hash(result)))
  }
  do{
   let h=try Harness(sample);h.consent["initialUtxoCount"]=h.inputs.count;try h.ready();try h.bind();let sent=try h.signAndOwn();try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:sent)
   let result=try h.summary(sent);rejects{try h.finish(result)};try h.c.close(owner:"view",scope:h.scope,id:h.id);try h.finish(result)
   yes(result["status"] as? String=="complete");try h.c.disconnect(owner:"view",scope:h.scope,id:"disconnect");yes(try !h.c.mayDeliverMaintenanceResult(owner:"view",scope:h.scope,id:"merge",resultHash:hash(result)))
  }
  for maximum in [1,3]{
   let h=try Harness(sample);var limits=map(h.consent["limits"]);limits["maxTransactions"]=maximum;h.consent["limits"]=limits
   try h.ready();try h.bind();let result=try h.signAndOwn();try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:result);try h.c.close(owner:"view",scope:h.scope,id:h.id)
   let txid=rows(result["transactions"])[0]["txid"] as! String
   h.id="next";h.inputs=[txid+":0",String(repeating:"c",count:64)+":0"]
   try h.prepare(index:2);h.step["dependsOn"]=[txid];rejects{try h.begin()} // Cannot reset the already spent fee budget.
   try h.prepare(index:2,fee:String(100000-Int(result["totalFee"] as! String)!));h.step["dependsOn"]=[txid]
   if maximum==1{rejects{try h.begin()}}else{try h.begin();try h.consentChild();rejects{try h.bind()}} // New round may start without UI, but old inputs cannot bind.
   yes(h.ui.shown==2);try h.c.closeMaintenance(owner:"view",scope:h.scope,id:"merge")
  }
  for change in ["recipient","fee"]{let h=try Harness(sample);try h.ready();rejects{try h.bind(change)};yes(h.signer.calls==0)}
  for change in ["account","lock","navigation","revoke","parent-cancel","child-close"]{
   let h=try Harness(sample);try h.ready();try h.bind()
   switch change{case "account":h.accounts.revision+=1;case "lock":h.accounts.unlocked=false;case "navigation":h.c.invalidate(owner:"view");case "revoke":try h.c.disconnect(owner:"view",scope:h.scope,id:"disconnect");case "parent-cancel":try h.c.cancel(owner:"view",scope:h.scope,id:"merge");default:try h.c.close(owner:"view",scope:h.scope,id:h.id)}
   rejects{_ = try h.signAndOwn()};yes(h.signer.calls==0)
  }
  do{let h=try Harness(sample);try h.ready();try h.bind();let result=try h.signAndOwn();h.status="unknown";rejects{try h.c.finishBroadcast(owner:"view",scope:h.scope,id:h.id,receipt:h.receipt,result:result)};try h.c.close(owner:"view",scope:h.scope,id:h.id);h.id="next";try h.prepare(index:2);rejects{try h.begin()}}
  for change in ["scope","expiry","transactions","fee","impact","field"]{
   let h=try Harness(sample);try h.grant()
   switch change{case "scope":var a=map(h.consent["authority"]);a["origin"]="https://evil.invalid";h.consent["authority"]=a
   case "impact":h.consent["impact"]=["custody":"other"]
   case "field":h.consent["approved"]=true
   default:var l=map(h.consent["limits"]);if change=="expiry"{l["expiresAt"]=stamp(-10)}else if change=="transactions"{l["maxTransactions"]=65}else{l["maxTotalFee"]="2100000000000001"};h.consent["limits"]=l}
   rejects{try h.approve()};yes(h.ui.shown==1)
  }
  for change in ["intent","index","fee","dependency","inputs","field"]{
   let h=try Harness(sample);try h.grant();try h.approve();try h.prepare()
   switch change{case "intent":h.request["intent"]=["version":"1.0","type":"tbc.transfer","to":h.account.address,"amount":"1"];h.step["materialHash"]=try hash(h.request)
   case "index":try h.prepare(index:2)
   case "fee":try h.prepare(fee:"100001")
   case "dependency":h.step["dependsOn"]=[String(repeating:"a",count:64)]
   case "field":h.request["approved"]=true;h.step["materialHash"]=try hash(h.request)
   default:h.inputs=[h.inputs[0],h.inputs[0]]}
   rejects{try h.begin()};yes(h.signer.calls==0 && h.ui.shown==2)
  }
  do{let h=try Harness(sample,register:false);try h.grant();rejects{try h.approve()};yes(h.ui.shown==1)}
  do{let h=try Harness(sample);try h.grant(false);rejects{try h.approve()};yes(h.ui.shown==1)}
  do{let h=try Harness(sample);try h.grant();rejects{try h.approve(false)};yes(h.ui.shown==2)}
  print(String(data:try JSONSerialization.data(withJSONObject:["status":"NATIVE_MAINTENANCE_PASS","checks":checks,"cases":cases.count,"signatureReplays":signatures,"broadcasts":0],options:.sortedKeys),encoding:.utf8)!)
 }
}
