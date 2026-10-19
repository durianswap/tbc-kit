import Foundation
import CryptoKit

private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func json(_ v:Any?)throws->String{try PermissionJSON.canonical(v)}
private func parse(_ s:String)throws->[String:Any]{map(try JSONSerialization.jsonObject(with:Data(s.utf8)))}
private struct TraceFailure:Error{let sample:String,call:String,reason:String}
private func unhex(_ s:String)->[UInt8]{let b=Array(s.utf8);return stride(from:0,to:b.count,by:2).map{UInt8(String(bytes:b[$0..<$0+2],encoding:.utf8)!,radix:16)!}}
@MainActor private var checks=0
@MainActor private func yes(_ v:Bool){precondition(v,"reviewed actual compute \(checks+1)");checks+=1}
@MainActor private func wait(_ action:(@escaping @MainActor (Result<String,Error>)->Void)throws->Void)async throws->String{
 try await withCheckedThrowingContinuation{c in do{try action{MainActor.preconditionIsolated();c.resume(with:$0)}}catch{c.resume(throwing:error)}}
}
@MainActor private final class Accounts:NativeAccountSource{let current:NativeAccount;var revision:Int64=0,unlocked=true;init(_ a:NativeAccount){current=a}}
@MainActor private final class Store:NativePermissionBackend{
 var all=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{all}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();precondition((all[origin]?.revision ?? 0)==expected);let s=PermissionSnapshot(revision:expected+1,records:records);all[origin]=s;writes+=1;return PermissionCommitResult(acknowledgedRevision:s.revision,current:s)
 }
}
@MainActor private final class UI:NativeApprovalPresenter{
 var pending:(@MainActor (Bool)->Void)?,shown=0
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;pending=complete;return {self.pending=nil}}
 func choose(){let f=pending!;pending=nil;f(true)}
}
// Signatures alone are public replay. Every prepare/finalize/digest is freshly
// computed by the linked frozen Rust, and the custody path verifies that result.
@MainActor private final class Signer:NativeDigestSigner{
 let rows:[[String:Any]];var calls=0
 var unavailable=Set<String>()
 init(_ rows:[[String:Any]]){self.rows=rows}
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){complete(Result{
  try requireCurrent();let h=digest.map{String(format:"%02x",$0)}.joined()
  // Inject one unavailable attempt, not permanent failure of this digest:
  // independent approved steps may legitimately sign the same message.
  if self.unavailable.remove(h) != nil{throw NativeSignerUnavailable()}
  for row in rows{let t=row["tasks"] as! [[String:Any]];if let i=t.firstIndex(where:{$0["digest"] as? String==h}){
   precondition(encoding==t[i]["signatureEncoding"] as? String && t[i]["accountId"] as? String==account.accountId && t[i]["publicKey"] as? String==account.publicKey);calls+=1;return unhex((row["signatures"] as! [String])[i])
  }};throw NativeCustodyFailure(code:"UNKNOWN_TEST_DIGEST")
 })}
}
@MainActor private final class CountedCompute:NativeReviewedComputer{
 let inner:NativeReviewedRust;var calls=0
 init(_ inner:NativeReviewedRust){self.inner=inner}
 func call(method:String,input:String,complete:@escaping @MainActor (Result<String,Error>)->Void){calls+=1;inner.call(method:method,input:input,complete:complete)}
}
@main @MainActor struct ReviewedComputeCheck{
 static func main()async throws{
  let d=try parse(String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8)),cases=d["cases"] as! [[String:Any]],computer=try NativeReviewedRust()
  var stages=0
  for s in cases{
   let rows=s["stages"] as! [[String:Any]]
   for row in rows{
    let actual=try await wait{computer.call(method:"prepareReviewedStage",input:try json(row["prepare"]),complete:$0)}
    yes(try json(parse(actual))==json(row["stage"]))
    let final=try await wait{computer.call(method:"finalizeReviewedStage",input:try json(["stage":parse(actual),"signatures":row["signatures"]!,"signatureEncoding":"compact64"]),complete:$0)}
    yes(try json(parse(final))==json(row["finalized"]));stages+=1
   }
   let a=map(s["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String),accounts=Accounts(account),store=Store(),ui=UI(),signer=Signer(rows)
   let context=map(s["context"]),audit=map(s["audit"]),packet=map(s["packet"])
   var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="actual-reviewed";scope["committedUrl"]=(context["origin"] as! String)+"/dapp"
   let custody=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:signer,reviewedComputer:computer){owner,v in owner=="v" && v==scope}
   let host=NativeWalletHost(custody:custody){_,_,_ in};try host.navigation(owner:"v",scope:scope)
   let op=PermissionJSON.id("P4/rpc",scope["sessionId"]!,try json("reviewed"))
   var grant:Result<[[String:Any]],Error>?
   try custody.requestPermissions(owner:"v",scope:scope,id:"grant",request:["tbc_accounts":["chains":[account.chainId]],"tbc_signTransaction":["chains":[account.chainId]]]){grant=$0};ui.choose();_ = try grant!.get()
   _ = try custody.begin(owner:"v",scope:scope,id:op,method:NativeReviewed.method,expectedRevision:custody.snapshot(owner:"v",scope:scope).revision,expectedAccount:account)
   var consent:Result<Bool,Error>?
   try custody.consent(owner:"v",scope:scope,id:op,method:NativeReviewed.method,request:map(s["request"]),context:context,review:map(packet["review"])){consent=$0};ui.choose();yes(try consent!.get())
   let receipt=try parse(await wait{done in try custody.bindReviewed(owner:"v",scope:scope,id:op,binding:map(audit["binding"]),preview:map(audit["preview"]),plan:map(audit["plan"]),packet:packet){r in done(r.flatMap{v in Result{try json(v)}})}})
   for i in rows.indices{
    if i>0{
     let pending:[String:Any]=["kind":"reviewed","planHash":map(audit["plan"])["planHash"]!,"stageIndex":i,"previousTransactions":rows.prefix(i).map{map($0["finalized"])["txraw"]!},"stage":rows[i]["stage"]!,"signingRequests":rows[i]["tasks"]!]
     let advanced=try await wait{done in try custody.advanceReviewed(owner:"v",scope:scope,id:op,receipt:receipt,pending:pending){done($0.map{String($0)})}};yes(advanced=="true")
    }
    for (j,t) in (rows[i]["tasks"] as! [[String:Any]]).enumerated(){var signed:Result<[String:Any],Error>?;try custody.sign(owner:"v",scope:scope,id:op,receipt:receipt,task:t){signed=$0};yes(try signed!.get()["signature"] as? String==(rows[i]["signatures"] as! [String])[j])}
   }
   try custody.close(owner:"v",scope:scope,id:op);yes(custody.mayDeliverSignature(owner:"v",scope:scope,id:op));yes(ui.shown==2 && store.writes==1)
   let response:[String:Any]=["jsonrpc":"2.0","id":"reviewed","result":s["result"]!],events=[Any]()
   let digest=SHA256.hash(data:Data(try json(["response":response,"events":events]).utf8)).map{String(format:"%02x",$0)}.joined()
   let text=try json(["channel":"tws-webview/1","type":"delivery","sessionId":scope["sessionId"]!,"navigationId":scope["navigationId"]!,"messageId":"reviewed-result","deliveryId":digest,"response":response,"events":events])
   var delivery=[String:Any]();host.dispatch(method:"delivery.prepare",input:["ownerId":"v","scope":scope,"method":NativeReviewed.method,"requestId":"reviewed","serialized":text]){delivery=$0}
   yes(delivery["ok"] as? Bool==true);yes(host.allowDelivery(owner:"v",scope:scope,text:text))
   accounts.unlocked=false;yes(!custody.mayDeliverSignature(owner:"v",scope:scope,id:op));yes(!host.allowDelivery(owner:"v",scope:scope,text:text))
  }
  // Use the frozen Core's batch plan, not NativeReviewed.workflowPlan, as the
  // test input. Native custody independently projects and computes its child.
  let w=map(d["workflow"]),a=map(w["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String),context=map(w["context"])
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="actual-workflow";scope["committedUrl"]=(context["origin"] as! String)+"/dapp"
  for interrupt in [false,true]{
   let accounts=Accounts(account),store=Store(),ui=UI(),signer=Signer([]),counted=CountedCompute(computer)
   let custody=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:signer,reviewedComputer:counted){owner,v in owner=="v" && v==scope}
   let host=NativeWalletHost(custody:custody){_,_,_ in};try host.navigation(owner:"v",scope:scope)
   var grant:Result<[[String:Any]],Error>?
   var permissions:[String:Any]=[:];for method in ["tbc_accounts","tbc_signWorkflow","tbc_signTransaction","tbc_signMessage"]{permissions[method]=["chains":[account.chainId]]}
   try custody.requestPermissions(owner:"v",scope:scope,id:"grant",request:permissions){grant=$0};ui.choose();_ = try grant!.get()
   _ = try custody.begin(owner:"v",scope:scope,id:"batch",method:w["method"] as! String,expectedRevision:custody.snapshot(owner:"v",scope:scope).revision,expectedAccount:account)
   let plan=map(w["plan"]),p=map(plan["payload"])
   let review:[String:Any]=["kind":"workflow","steps":map(w["reviews"]).map{["stepId":$0.key,"review":$0.value]},"prepared":["workflowPlanHash":plan["workflowPlanHash"]!,"totalFee":p["totalFee"]!]]
   var approved:Result<Bool,Error>?
   try custody.consent(owner:"v",scope:scope,id:"batch",method:w["method"] as! String,request:map(w["request"]),context:context,review:review){approved=$0};ui.choose();yes(try approved!.get())
   let reply=try parse(await wait{done in
    host.dispatch(method:"signing.bind",input:["ownerId":"v","scope":scope,"operation":"batch","binding":w["binding"]!,"preview":w["preview"]!,"plan":plan,"envelope":NSNull()]){r in done(Result{try json(r)})}
    if interrupt{accounts.unlocked=false}
   })
   yes(reply["ok"] as? Bool == !interrupt);yes(counted.calls==1 && signer.calls==0 && ui.shown==2 && store.writes==1)
   if !interrupt{let receipt=map(reply["value"]);yes(receipt["bindingHash"] as? String==map(w["binding"])["bindingHash"] as? String);try custody.close(owner:"v",scope:scope,id:"batch")}
   yes(!custody.mayDeliverSignature(owner:"v",scope:scope,id:"batch"))
  }
  let traces=d["workflowTraces"] as! [[String:Any]];var workflowSteps=0,workflowAdvances=0,workflowSignatures=0,workflowFailures=0
  for sample in traces{
   let a=map(sample["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String),context=map(sample["context"]),events=sample["trace"] as! [[String:Any]],method=sample["method"] as! String
   let rows=events.filter{$0["call"] as? String=="sign"}.map{["tasks":[map($0["task"])],"signatures":[map($0["result"])["signature"]!]]}
   let accounts=Accounts(account),store=Store(),ui=UI(),signer=Signer(rows),counted=CountedCompute(computer)
   signer.unavailable=Set(events.filter{$0["call"] as? String=="signUnavailable"}.map{map($0["task"])["digest"] as! String})
   var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="workflow-trace";scope["committedUrl"]=(context["origin"] as! String)+"/dapp"
   let custody=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:signer,reviewedComputer:counted){owner,v in owner=="v" && v==scope}
   let host=NativeWalletHost(custody:custody){_,_,_ in};try host.navigation(owner:"v",scope:scope)
   let requestId="trace-"+(sample["name"] as! String),op=PermissionJSON.id("P4/rpc",scope["sessionId"]!,try json(requestId))
   var permissions:[String:Any]=[:];for name in ["tbc_accounts","tbc_signWorkflow","tbc_signTransaction","tbc_signMessage","tbc_signTypedData"]{permissions[name]=["chains":[account.chainId]]}
   var grant:Result<[[String:Any]],Error>?;try custody.requestPermissions(owner:"v",scope:scope,id:"grant",request:permissions){grant=$0};ui.choose();_ = try grant!.get()
   _ = try custody.begin(owner:"v",scope:scope,id:op,method:method,expectedRevision:custody.snapshot(owner:"v",scope:scope).revision,expectedAccount:account)
   var receipt=[String:Any]()
   for event in events{do{
    switch event["call"] as! String{
    case "consent":
     var consent:Result<Bool,Error>?;try custody.consent(owner:"v",scope:scope,id:op,method:method,request:map(event["request"]),context:context,review:event["review"] as? [String:Any]){consent=$0};ui.choose();yes(try consent!.get())
    case "bind":
     receipt=try parse(await wait{done in try custody.bindWorkflow(owner:"v",scope:scope,id:op,binding:map(event["binding"]),preview:map(event["preview"]),plan:map(event["plan"])){r in done(r.flatMap{v in Result{try json(v)}})}})
    case "enter":try custody.enterWorkflowStep(owner:"v",scope:scope,id:op,receipt:receipt,entry:map(event["entry"]));workflowSteps+=1
    case "advance":
     var pending=map(event["pending"])
     if pending["kind"] as? String=="reviewed"{yes(try await wait{done in try custody.advanceReviewed(owner:"v",scope:scope,id:op,receipt:receipt,pending:pending){done($0.map{String($0)})}}=="true")}
     else{var continuation=map(pending["continuation"]);continuation["approvalId"]=receipt["approvalId"];pending["continuation"]=continuation;try custody.advance(owner:"v",scope:scope,id:op,receipt:receipt,pending:pending);yes(true)}
     workflowAdvances+=1
    case "sign":
     var reply:Result<[String:Any],Error>?;try custody.sign(owner:"v",scope:scope,id:op,receipt:receipt,task:map(event["task"])){reply=$0};yes(try json(reply!.get())==json(event["result"]))
    case "signUnavailable":
     var reply=[String:Any]();host.dispatch(method:"signing.sign",input:["ownerId":"v","scope":scope,"operation":op,"receipt":receipt,"task":event["task"]!]){reply=$0}
     yes(reply["ok"] as? Bool==false && reply["code"] as? String=="NATIVE_WORKFLOW_STEP_UNAVAILABLE");workflowFailures+=1
    case "finish":
     var outcome=map(event["outcome"])
     if var result=outcome["result"] as? [String:Any]{if result["approvalId"] != nil{result["approvalId"]=receipt["approvalId"]};outcome["result"]=result}
     yes(try await wait{done in try custody.finishWorkflowStep(owner:"v",scope:scope,id:op,receipt:receipt,outcome:outcome){done($0.map{String($0)})}}=="true")
    default:preconditionFailure("Unknown offline trace operation")
    }
   }catch{throw TraceFailure(sample:sample["name"] as! String,call:event["call"] as! String,reason:(error as? NativeCustodyFailure)?.code ?? "NATIVE_TRACE_REJECTED")}}
   try custody.close(owner:"v",scope:scope,id:op);yes(!custody.mayDeliverSignature(owner:"v",scope:scope,id:op));yes(ui.shown==2 && store.writes==1)
   var result=map(sample["result"]);result["approvalId"]=receipt["approvalId"]
   result["steps"]=(result["steps"] as! [[String:Any]]).map{source in var row=source;if var r=row["result"] as? [String:Any],r["approvalId"] != nil{r["approvalId"]=receipt["approvalId"];row["result"]=r};return row}
   let response:[String:Any]=["jsonrpc":"2.0","id":requestId,"result":result],emitted=[Any](),payload:[String:Any]=["response":["jsonrpc":"2.0","id":requestId,"result":result],"events":[Any]()]
   let digest=SHA256.hash(data:Data(try json(payload).utf8)).map{String(format:"%02x",$0)}.joined()
   let text=try json(["channel":"tws-webview/1","type":"delivery","sessionId":scope["sessionId"]!,"navigationId":scope["navigationId"]!,"messageId":"trace-result","deliveryId":digest,"response":response,"events":emitted])
   var reply=[String:Any]();host.dispatch(method:"delivery.prepare",input:["ownerId":"v","scope":scope,"method":method,"requestId":requestId,"serialized":text]){reply=$0}
   yes(reply["ok"] as? Bool==true && host.allowDelivery(owner:"v",scope:scope,text:text));accounts.unlocked=false;yes(!host.allowDelivery(owner:"v",scope:scope,text:text))
   yes(counted.calls==(sample["name"] as? String=="reviewed-then-message" ? 6:0));workflowSignatures+=signer.calls
  }
  var rejected=false;do{_ = try await wait{computer.call(method:"sign",input:"{}",complete:$0)}}catch{rejected=true};yes(rejected)
  let malformed=try await wait{computer.call(method:"prepareReviewedStage",input:"{}",complete:$0)};yes(try parse(malformed)["error"] is String)
  print("{\"status\":\"PASS\",\"checks\":\(checks),\"cases\":\(cases.count),\"stages\":\(stages),\"workflowReceiptCases\":1,\"workflowInterruptedCases\":1,\"workflowTraceCases\":\(traces.count),\"workflowSteps\":\(workflowSteps),\"workflowAdvances\":\(workflowAdvances),\"workflowReplayedSignatures\":\(workflowSignatures),\"workflowRecoverableFailures\":\(workflowFailures),\"scope\":\"actual-rust-cabi-and-workflow-native-trace\"}")
 }
}
