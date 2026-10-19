import Foundation
import CryptoKit

private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func hash(_ v:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
@MainActor private var checks=0
@MainActor private func yes(_ value:Bool){precondition(value,"crypto workflow check \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var bad=false;do{try f()}catch{bad=true};yes(bad)}
@MainActor private final class Accounts:NativeAccountSource{
 let current:NativeAccount;var revision:Int64=0,unlocked=true
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
 var shown=0,pending:(@MainActor (Bool)->Void)?
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;pending=complete;return {self.pending=nil}}
 func choose(_ value:Bool=true){let f=pending!;pending=nil;f(value)}
}
@MainActor private final class Key:NativeDigestSigner,NativeBie1Executor{
 let sample:[String:Any];var calls=0,hold=false,failure:String?,afterUse:(@MainActor ()->Void)?,release:(@MainActor ()->Void)?
 init(_ s:[String:Any]){sample=s}
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){preconditionFailure("crypto used digest signer")}
 func execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:[UInt8],requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  let row=(sample["crypto"] as! [[String:Any]])[calls];calls+=1
  let f={@MainActor in complete(Result{
   try requireCurrent();let task=map(row["task"])
   precondition(account.accountId==task["accountId"] as? String && account.publicKey==task["publicKey"] as? String)
   let expected=try NativeCrypto.input(task);precondition(input==expected)
   if self.failure=="forged"{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE")}
   if self.failure=="opaque"{throw NativeCustodyFailure(code:"SECRET_BACKEND_DETAIL")}
   if row["unavailable"] as? Bool==true{throw NativeCryptoUnavailable()}
   let result=map(row["result"]);self.afterUse?()
   return Array(Data(base64Encoded:(result["ciphertext"] ?? map(result["message"])["data"]) as! String)!)
  })};if hold{release=f}else{f()}
 }
}
@MainActor private final class Document{var scope:[String:String]?}
@MainActor private final class Harness{
 let sample:[String:Any],account:NativeAccount,accounts:Accounts,store=Store(),ui=UI(),key:Key,c:NativeCustody,host:NativeWalletHost,document=Document()
 let scope:[String:String],context:[String:Any],id:String
 var method:String{sample["method"] as! String}
 init(_ s:[String:Any],enabled:Bool=true)throws{
  sample=s;let a=map(s["account"]);account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String);accounts=Accounts(account);key=Key(s);context=map(s["context"])
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="crypto-workflow";scope["committedUrl"]=(context["origin"] as! String)+"/dapp";self.scope=scope
  id=PermissionJSON.id("P4/rpc",scope["sessionId"]!,try PermissionJSON.canonical("crypto-workflow"));let doc=document;doc.scope=scope
  c=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:key,crypto:enabled ? key:nil){_,s in doc.scope==s}
  host=NativeWalletHost(custody:c){_,_,_ in};try host.navigation(owner:"view",scope:scope)
 }
 func grant(crypto:Bool=true)throws{
  var request:[String:Any]=[:];for name in ["tbc_accounts","tbc_signWorkflow"]+(crypto ? ["tbc_crypto"]:[]){request[name]=["chains":[account.chainId]]}
  var result:Result<[[String:Any]],Error>?;try c.requestPermissions(owner:"view",scope:scope,id:"grant",request:request){result=$0};ui.choose();_ = try result!.get()
 }
 func begin()throws{_ = try c.begin(owner:"view",scope:scope,id:id,method:method,expectedRevision:c.snapshot(owner:"view",scope:scope).revision,expectedAccount:account)}
 func consent()throws{var r:Result<Bool,Error>?;try c.consent(owner:"view",scope:scope,id:id,method:method,request:map(sample["request"]),context:context){r=$0};ui.choose();yes(try r!.get())}
 func ready()throws->[String:Any]{try grant();try begin();try consent();var r:Result<[String:Any],Error>?;try c.bindWorkflow(owner:"view",scope:scope,id:id,binding:map(sample["binding"]),preview:map(sample["preview"]),plan:map(sample["plan"])){r=$0};return try r!.get()}
 func entry(_ row:[String:Any])->[String:Any]{["kind":"workflow-step","stepId":row["stepId"]!,"workflowPlanHash":map(sample["plan"])["workflowPlanHash"]!,"tasks":[row["task"]!]]}
 func enter(_ r:[String:Any],_ row:[String:Any])throws{try c.enterWorkflowStep(owner:"view",scope:scope,id:id,receipt:r,entry:entry(row))}
 func crypto(_ r:[String:Any],_ t:[String:Any])->[String:Any]{var reply:[String:Any]?;host.dispatch(method:"signing.crypto",input:["ownerId":"view","scope":scope,"operation":id,"receipt":r,"task":t]){reply=$0};return reply!}
 func finish(_ r:[String:Any],_ row:[String:Any],_ result:[String:Any]?)throws{
  var outcome:[String:Any]=["kind":"workflow-step-outcome","stepId":row["stepId"]!,"workflowPlanHash":map(sample["plan"])["workflowPlanHash"]!,"status":result==nil ? "failed":"completed"]
  if let result{outcome["result"]=result}else{outcome["error"]=["code":"HOST_UNAVAILABLE","message":"Workflow step failed: crypto.execute"]}
  var answer:Result<Bool,Error>?;try c.finishWorkflowStep(owner:"view",scope:scope,id:id,receipt:r,outcome:outcome){answer=$0};yes(try answer!.get())
 }
}
@main @MainActor struct CryptoWorkflowCheck{
 static func main()throws{
  let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),original=root["original"] as! [[String:Any]],cases=root["fresh"] as! [[String:Any]]
  for s in original{
   let a=map(s["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
   let result=try NativeWorkflow.bind(method:s["method"] as! String,request:map(s["request"]),context:map(s["context"]),account:account,accounts:[],plan:map(s["plan"]),preview:map(s["preview"]),binding:map(s["binding"]),reviews:[:],now:NativeCrypto.time(s["now"]))
   yes(result.requiredPermissions.contains("tbc_crypto"))
   var bad=map(s["plan"]),p=map(bad["payload"]),tasks=p["cryptoTasks"] as! [[String:Any]];tasks[0]["publicKey"]="other";p["cryptoTasks"]=tasks;bad["payload"]=p;bad["workflowPlanHash"]=try hash(p)
   rejects{_ = try NativeWorkflow.bind(method:s["method"] as! String,request:map(s["request"]),context:map(s["context"]),account:account,accounts:[],plan:bad,preview:map(s["preview"]),binding:map(s["binding"]),reviews:[:],now:NativeCrypto.time(s["now"]))}
  }
  for s in cases{
   let h=try Harness(s),r=try h.ready(),rows=s["crypto"] as! [[String:Any]]
   yes(h.ui.shown==2 && h.store.writes==1)
   yes(h.crypto(r,map(rows[0]["task"]))["ok"] as? Bool==false)
   for row in rows{
    try h.enter(r,row)
    rejects{try h.c.sign(owner:"view",scope:h.scope,id:h.id,receipt:r,task:map(row["task"])){_ in}}
    let reply=h.crypto(r,map(row["task"]))
    if row["unavailable"] as? Bool==true{yes(reply["code"] as? String=="NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE");try h.finish(r,row,nil)}
    else{yes(try PermissionJSON.canonical(reply["value"])==PermissionJSON.canonical(row["result"]));var altered=map(row["result"]);altered["taskId"]="other";rejects{try h.finish(r,row,altered)};try h.finish(r,row,map(reply["value"]))}
    yes(h.crypto(r,map(row["task"]))["ok"] as? Bool==false)
   }
   try h.c.close(owner:"view",scope:h.scope,id:h.id)
   var expected=map(s["result"]);expected["approvalId"]=r["approvalId"]
   yes(h.c.mayDeliverWorkflowResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:try hash(expected)))
   yes(h.key.calls==2 && h.ui.shown==2 && h.store.writes==1)
   h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:try hash(expected)))
  }
  let s=cases[0]
  do{let h=try Harness(s,enabled:false);try h.grant(crypto:false);try h.begin();rejects{try h.consent()};yes(h.ui.shown==1 && h.key.calls==0)}
  for mode in ["lock-before","lock-after","navigation","opaque","forged"]{
   let h=try Harness(s),r=try h.ready(),row=(s["crypto"] as! [[String:Any]])[0];try h.enter(r,row)
   h.key.hold=true;var reply:Result<[String:Any],Error>?
   try h.c.executeCrypto(owner:"view",scope:h.scope,id:h.id,receipt:r,task:map(row["task"])){reply=$0}
   if mode=="lock-before"{h.accounts.unlocked=false};if mode=="lock-after"{h.key.afterUse={h.accounts.unlocked=false}}
   if mode=="navigation"{h.document.scope=nil;h.c.invalidate(owner:"view")};if mode=="opaque" || mode=="forged"{h.key.failure=mode}
   h.key.release!();rejects{_ = try reply!.get()};rejects{try h.finish(r,row,map(row["result"]))}
   yes(!h.c.mayDeliverWorkflowResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:try hash(s["result"])))
  }
  print("{\"status\":\"PASS\",\"bindingCases\":\(original.count),\"executionCases\":\(cases.count),\"checks\":\(checks),\"proof\":\"native-host-public-replay\",\"broadcasts\":0}")
 }
}
