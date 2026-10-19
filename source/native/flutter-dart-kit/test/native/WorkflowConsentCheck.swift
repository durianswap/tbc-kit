import Foundation
import CryptoKit

// Real native consent/receipt owner, no keys or signatures. Full batch execution
// remains gated; a parent receipt alone must not permit arbitrary signing.
private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func copy(_ v:[String:Any])throws->[String:Any]{map(try JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:v)))}
private func hash(_ v:Any)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
@MainActor private var checks=0
@MainActor private func yes(_ v:Bool){precondition(v,"workflow consent check \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var bad=false;do{try f()}catch{bad=true};yes(bad)}
@MainActor private final class Accounts:NativeAccountSource{
 let current:NativeAccount;var revision:Int64=0,unlocked=true
 let signingAccounts:[NativeAccount]
 init(_ values:[[String:Any]]){signingAccounts=values.map{NativeAccount(address:$0["address"] as! String,publicKey:$0["publicKey"] as! String,chainId:$0["chainId"] as! String)};current=signingAccounts[0]}
}
@MainActor private final class Store:NativePermissionBackend{
 var values=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{values}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{try fence();precondition((values[origin]?.revision ?? 0)==expected);let v=PermissionSnapshot(revision:expected+1,records:records);values[origin]=v;writes+=1;return PermissionCommitResult(acknowledgedRevision:v.revision,current:v)}
}
@MainActor private final class UI:NativeApprovalPresenter{
 var shown=0,reviews=[String:NativeReview](),pending=[String:@MainActor (Bool)->Void]()
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;reviews[review.operationId]=review;pending[review.operationId]=complete;return {self.pending.removeValue(forKey:review.operationId)}}
 func choose(_ id:String,_ yes:Bool=true){let f=pending.removeValue(forKey:id)!;f(yes)}
}
@MainActor private final class NoKey:NativeDigestSigner,NativeReviewedComputer{
 var signs=0,computes=0
 var recorded=[[String:Any]](),held:(@MainActor ()->Void)?,hold=false
 var failure:String?
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  signs+=1
  let finish: @MainActor ()->Void = {complete(Result{
   // A late unavailable callback deliberately omits the adapter's own fence;
   // custody must still prioritize lock/cancel over a recoverable classification.
   if !(self.failure=="unavailable" && self.hold){try requireCurrent()}
   if self.failure=="unavailable"{throw NativeSignerUnavailable()}
   if self.failure=="forged"{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_STEP_UNAVAILABLE")}
   if self.failure=="opaque"{throw NativeCustodyFailure(code:"TEST_PRIVATE_ERROR")}
   let digestHex=digest.map{String(format:"%02x",$0)}.joined()
   guard let row=self.recorded.first(where:{let t=map($0["task"]);return t["digest"] as? String==digestHex && t["signatureEncoding"] as? String==encoding && t["publicKey"] as? String==account.publicKey && t["accountId"] as? String==account.accountId})else{throw NativeCustodyFailure(code:"TEST_NO_KEY")}
   let raw=map(row["result"])["signature"] as! String,b=Array(raw.utf8)
   return stride(from:0,to:b.count,by:2).map{UInt8(String(bytes:b[$0..<$0+2],encoding:.utf8)!,radix:16)!}
  })}
  if hold{held=finish}else{finish()}
 }
 func call(method:String,input:String,complete:@escaping @MainActor (Result<String,Error>)->Void){computes+=1;complete(.failure(NativeCustodyFailure(code:"TEST_NO_COMPUTE")))}
}
@MainActor private final class Harness{
 let sample:[String:Any],accounts:Accounts,store=Store(),ui=UI(),key=NoKey(),c:NativeCustody,scope:[String:String],context:[String:Any]
 var request:[String:Any];var answer:Result<Bool,Error>?
 var method:String{sample["method"] as! String}
 init(_ s:[String:Any])throws{
  sample=s;accounts=Accounts(s["accounts"] as! [[String:Any]]);request=map(s["request"]);context=map(s["context"])
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="workflow-consent";scope["committedUrl"]=(context["origin"] as! String)+"/dapp";self.scope=scope
  c=try NativeCustody(accounts:accounts,chain:accounts.current.chainId,backend:store,approval:ui,signer:key,reviewedComputer:key){owner,value in owner=="v" && value==scope};try c.navigation(owner:"v",scope:scope)
 }
 func grant(omitting:String?=nil,maxAccounts:Int?=nil)throws{
  let chain=accounts.current.chainId;var request:[String:Any]=["tbc_accounts":["chains":[chain],"maxAccounts":maxAccounts ?? accounts.signingAccounts.count]]
  for method in ["tbc_signWorkflow","tbc_signTransaction","tbc_signMessage","tbc_signTypedData"] where method != omitting{request[method]=["chains":[chain]]}
  var result:Result<[[String:Any]],Error>?;try c.requestPermissions(owner:"v",scope:scope,id:"grant",request:request){result=$0};ui.choose("grant");_ = try result!.get()
 }
 func begin()throws{_ = try c.begin(owner:"v",scope:scope,id:"op",method:method,expectedRevision:c.snapshot(owner:"v",scope:scope).revision,expectedAccount:accounts.current)}
 func consent(review:[String:Any]?=nil)throws{try c.consent(owner:"v",scope:scope,id:"op",method:method,request:request,context:context,review:review ?? (sample["consentReview"] as? [String:Any])){self.answer=$0}}
 func bind()throws->[String:Any]{
  var reply:Result<[String:Any],Error>?
  try c.bindWorkflow(owner:"v",scope:scope,id:"op",binding:map(sample["binding"]),preview:map(sample["preview"]),plan:map(sample["plan"])){reply=$0}
  return try reply!.get()
 }
 func noAuthority()throws{
  rejects{_ = try self.c.bind(owner:"v",scope:self.scope,id:"op",binding:[:],preview:[:],plan:nil,envelope:nil)}
  rejects{try self.c.sign(owner:"v",scope:self.scope,id:"op",receipt:[:],task:[:]){_ in}}
  try c.close(owner:"v",scope:scope,id:"op");yes(!c.mayDeliverSignature(owner:"v",scope:scope,id:"op"));yes(key.signs==0 && key.computes==0 && store.writes==1)
 }
 func enter(_ receipt:[String:Any],_ entry:[String:Any])throws{try c.enterWorkflowStep(owner:"v",scope:scope,id:"op",receipt:receipt,entry:entry)}
 func sign(_ receipt:[String:Any],_ task:[String:Any])throws->[String:Any]{var result:Result<[String:Any],Error>?;try c.sign(owner:"v",scope:scope,id:"op",receipt:receipt,task:task){result=$0};return try result!.get()}
 func finish(_ receipt:[String:Any],_ outcome:[String:Any])throws{var result:Result<Bool,Error>?;try c.finishWorkflowStep(owner:"v",scope:scope,id:"op",receipt:receipt,outcome:outcome){result=$0};yes(try result!.get())}
}
@main @MainActor struct WorkflowConsentCheck{
 static func main()throws{
  let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),cases=root["cases"] as! [[String:Any]]
  for sample in cases{
   let h=try Harness(sample);try h.grant();try h.begin()
   if h.accounts.signingAccounts.count>1{let resolved=try h.c.resolveSigningAccounts(owner:"v",scope:h.scope,id:"op",request:h.request,context:h.context);yes(resolved.count==h.accounts.signingAccounts.count-1)}
   try h.consent();yes(h.ui.shown==2 && h.answer==nil && h.store.writes==1)
   let text=h.ui.reviews["op"]!.description
   for step in h.request["steps"] as! [[String:Any]]{yes(text.contains("\(step["id"]!)"));if let secret=(step["intent"] as? [String:Any])?["preimage"] as? String{yes(!text.contains(secret))}}
   if let secret=sample["mustNotRender"] as? String{yes(!text.contains(secret))}
   h.ui.choose("op");yes(try h.answer!.get());rejects{try h.consent()};try h.noAuthority()
  }
  let sample=cases.first{$0["name"] as? String=="native-message"}!
  do{let h=try Harness(sample);try h.grant(omitting:"tbc_signMessage");try h.begin();rejects{try h.consent()};yes(h.ui.shown==1 && h.key.signs==0)}
  do{let h=try Harness(sample);try h.grant(omitting:"tbc_signWorkflow");rejects{try h.begin()};yes(h.ui.shown==1)}
  do{let h=try Harness(sample);try h.grant();try h.begin();try h.consent();h.ui.choose("op",false);yes(try !h.answer!.get());try h.noAuthority()}
  do{let h=try Harness(sample);try h.grant();try h.begin();try h.consent();h.accounts.unlocked=false;h.ui.choose("op");rejects{_ = try h.answer!.get()};yes(h.key.signs==0)}
  do{let h=try Harness(sample);try h.grant();try h.begin();try h.consent();h.c.invalidate(owner:"v");rejects{_ = try h.answer!.get()};yes(h.ui.pending.isEmpty && h.key.signs==0)}
  do{let h=try Harness(sample);try h.grant();try h.begin();h.request["expiresAt"]="2020-01-01T00:00:00Z";rejects{try h.consent()};yes(h.ui.shown==1)}
  do{let h=try Harness(sample);try h.grant();try h.begin();h.request.removeValue(forKey:"maxTotalFee");rejects{try h.consent()};yes(h.ui.shown==1)}
  do{let h=try Harness(sample);try h.grant();try h.begin();h.request.removeValue(forKey:"maxTotalFee");try h.consent(review:["kind":"workflow","steps":[],"prepared":["workflowPlanHash":String(repeating:"0",count:64),"totalFee":"100000"]]);yes(h.ui.reviews["op"]!.description.contains("Total fee at most 100000"));h.ui.choose("op");yes(try h.answer!.get());try h.noAuthority()}
  let roles=cases.first{$0["name"] as? String=="controller-message"}!
  do{let h=try Harness(roles);try h.grant(maxAccounts:1);try h.begin();rejects{try h.consent()};yes(h.ui.shown==1)}
  do{let h=try Harness(roles);try h.grant();try h.begin();_ = try h.c.resolveSigningAccounts(owner:"v",scope:h.scope,id:"op",request:h.request,context:h.context);h.request["maxTotalFee"]="99";rejects{try h.consent()};yes(h.ui.shown==1)}
  var receipts=0
  for sample in cases where sample["plan"] != nil{
   let h=try Harness(sample);try h.grant();try h.begin();try h.consent();h.ui.choose("op");yes(try h.answer!.get())
   if !(map(sample["reviews"])).isEmpty{
    rejects{_ = try h.bind()};yes(h.key.computes==1 && h.key.signs==0);try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"));continue
   }
   let receipt=try h.bind();receipts+=1
   yes(receipt["status"] as? String=="approved" && receipt["bindingHash"] as? String==map(sample["binding"])["bindingHash"] as? String)
   yes(h.ui.shown==2 && h.key.signs==0 && h.key.computes==0 && h.store.writes==1)
   rejects{_ = try h.bind()}
   let first=(map(map(sample["plan"])["payload"])["immediateSigningTasks"] as! [[String:Any]]).first!
   rejects{try h.c.sign(owner:"v",scope:h.scope,id:"op",receipt:receipt,task:map(first["task"])){_ in}}
   try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"));yes(h.key.signs==0)
  }
  // A prepared commitment shown at consent is binding even if the outer fee
  // cap was already supplied. Neither metadata nor approval can be substituted.
  for change in ["plan","fee","reject","locked"]{
   let h=try Harness(sample);try h.grant();try h.begin()
   let plan=map(sample["plan"]),p=map(plan["payload"])
   try h.consent(review:["kind":"workflow","steps":[],"prepared":["workflowPlanHash":change=="plan" ? String(repeating:"0",count:64):plan["workflowPlanHash"]!,"totalFee":change=="fee" ? "0":p["totalFee"]!]])
   h.ui.choose("op",change != "reject");if change=="locked"{h.accounts.unlocked=false}
   if change=="fee"{
    // Bound requests approve their explicit maxTotalFee, not the estimate.
    _ = try h.bind()
   }else{rejects{_ = try h.bind()}}
   yes(h.key.signs==0 && h.ui.shown==2)
  }
  let variants=root["receiptVariants"] as! [[String:Any]]
  for row in variants{
   let h=try Harness(map(row["sample"]));try h.grant();try h.begin();try h.consent();h.ui.choose("op");yes(try h.answer!.get())
   if row["accept"] as! Bool{_ = try h.bind()}else{rejects{_ = try h.bind()}}
   yes(h.key.signs==0 && h.key.computes==0 && h.ui.shown==2 && h.store.writes==1)
   try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"))
  }
  // Public signatures come from the frozen Engine-verified workflow fixture.
  // These checks exercise custody, not cryptographic generation or delivery.
  let execution=root["stepCases"] as! [[String:Any]];var stepCount=0,replays=0
  for row in execution{
   let h=try Harness(map(row["sample"]));h.key.recorded=row["signed"] as! [[String:Any]]
   try h.grant();try h.begin();try h.consent();h.ui.choose("op");let receipt=try h.bind()
   let plan=map(h.sample["plan"]),payload=map(plan["payload"])
   for source in row["steps"] as! [[String:Any]]{
    let id=source["id"] as! String,deferred=(row["deferred"] as! [[String:Any]]).first{$0["stepId"] as? String==id}
    let resolved=deferred.map{map($0["resolved"])},tasks=resolved.map{[map($0["concreteTask"])]} ?? (payload["immediateSigningTasks"] as! [[String:Any]]).filter{$0["stepId"] as? String==id}.map{map($0["task"])}
    var entry:[String:Any]=["kind":"workflow-step","stepId":id,"workflowPlanHash":plan["workflowPlanHash"]!,"tasks":tasks]
    if let resolved{entry["resolvedDeferredSigningTask"]=resolved
     var changed=resolved;changed["sourceValue"]=[String(repeating:"0",count:64)];var wrong=entry;wrong["resolvedDeferredSigningTask"]=changed;rejects{try h.enter(receipt,wrong)}
    }
    rejects{_ = try h.sign(receipt,tasks[0])}
    var wrong=entry;wrong["stepId"]="not-the-active-child";rejects{try h.enter(receipt,wrong)}
    wrong=entry;var changedTasks=tasks;changedTasks[0]["digest"]=String(repeating:"0",count:64);wrong["tasks"]=changedTasks;rejects{try h.enter(receipt,wrong)}
    var changedReceipt=receipt;changedReceipt["approvalId"]="other-approval";rejects{try h.enter(changedReceipt,entry)}
    try h.enter(receipt,entry);rejects{try h.enter(receipt,entry)}
    var result=try copy(map(source["result"]));if result["approvalId"] != nil{result["approvalId"]=receipt["approvalId"]}
    let outcome:[String:Any]=["kind":"workflow-step-outcome","stepId":id,"workflowPlanHash":plan["workflowPlanHash"]!,"status":"completed","result":result]
    rejects{try h.finish(receipt,outcome)}
    for task in tasks{_ = try h.sign(receipt,task);rejects{_ = try h.sign(receipt,task)}}
    var badResult=try copy(result)
    if var txs=badResult["transactions"] as? [[String:Any]]{txs[0]["txid"]=String(repeating:"0",count:64);badResult["transactions"]=txs}else{badResult["digest"]=String(repeating:"0",count:64)}
    var badOutcome=outcome;badOutcome["result"]=badResult;rejects{try h.finish(receipt,badOutcome)}
    try h.finish(receipt,outcome);rejects{try h.finish(receipt,outcome)};stepCount+=1
   }
   yes(h.ui.shown==2 && h.store.writes==1 && h.key.computes==0);replays+=h.key.signs
   try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"))
   var delivered=try copy(map(row["result"]));delivered["requestHash"]=payload["requestHash"];delivered["workflowPlanHash"]=plan["workflowPlanHash"];delivered["approvalId"]=receipt["approvalId"]
   var expectedRows=delivered["steps"] as! [[String:Any]]
   for i in expectedRows.indices{var result=map(expectedRows[i]["result"]);if result["approvalId"] != nil{result["approvalId"]=receipt["approvalId"]};expectedRows[i]["result"]=result};delivered["steps"]=expectedRows
   let resultHash=try hash(delivered)
   yes(h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:resultHash))
   yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:String(repeating:"0",count:64)))
   yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method=="tbc_signWorkflow" ? "tbc_signPreparedWorkflow":"tbc_signWorkflow",resultHash:resultHash))
   h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:resultHash));h.accounts.unlocked=true
   try h.c.forgetResult(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:resultHash))
  }
  // A recoverable failure must originate in the actual signer callback, not a
  // page/worker error claim. Only approved independent work may continue.
  let failureModes=["continue","atomic","lock","cancel","opaque","forged"]
  for mode in failureModes{
   let row=execution.first{map($0["sample"])["name"] as? String==(mode=="atomic" ? "messages-no-chain":"independent-failure-mode")}!,h=try Harness(map(row["sample"]))
   h.key.recorded=row["signed"] as! [[String:Any]];try h.grant();try h.begin();try h.consent();h.ui.choose("op");let receipt=try h.bind(),plan=map(h.sample["plan"]),p=map(plan["payload"]),steps=h.request["steps"] as! [[String:Any]],first=steps[0]
   func entry(_ step:[String:Any])->[String:Any]{["kind":"workflow-step","stepId":step["id"]!,"workflowPlanHash":plan["workflowPlanHash"]!,"tasks":(p["immediateSigningTasks"] as! [[String:Any]]).filter{$0["stepId"] as? String==step["id"] as? String}.map{map($0["task"]) }]}
   let firstEntry=entry(first),task=(firstEntry["tasks"] as! [[String:Any]])[0]
   try h.enter(receipt,firstEntry)
   let failure:[String:Any]=["kind":"workflow-step-outcome","stepId":first["id"]!,"workflowPlanHash":plan["workflowPlanHash"]!,"status":"failed","error":["code":"HOST_UNAVAILABLE","message":"Workflow step failed: signer.sign"]]
   rejects{try h.finish(receipt,failure)}
   h.key.failure=["opaque","forged"].contains(mode) ? mode:"unavailable";h.key.hold=["lock","cancel"].contains(mode)
   let host=NativeWalletHost(custody:h.c){_,_,_ in};var reply=[String:Any]()
   host.dispatch(method:"signing.sign",input:["ownerId":"v","scope":h.scope,"operation":"op","receipt":receipt,"task":task]){reply=$0}
   if h.key.hold{yes(reply.isEmpty);if mode=="lock"{h.accounts.unlocked=false}else{try h.c.cancel(owner:"v",scope:h.scope,id:"op")};h.key.held!()}
   yes(reply["ok"] as? Bool==false && reply["code"] as? String==(mode=="continue" ? "NATIVE_WORKFLOW_STEP_UNAVAILABLE":"NATIVE_DENIED"))
   rejects{_ = try h.sign(receipt,task)};yes(h.key.signs==1)
   if mode=="continue"{
    var bad=failure;bad["error"]=["code":"HOST_UNAVAILABLE","message":"untrusted detail"];rejects{try h.finish(receipt,bad)}
    try h.finish(receipt,failure);rejects{try h.finish(receipt,failure)};rejects{try h.enter(receipt,entry(steps[1]))}
    h.key.failure=nil;let third=steps[2],thirdEntry=entry(third);try h.enter(receipt,thirdEntry)
    for t in thirdEntry["tasks"] as! [[String:Any]]{_ = try h.sign(receipt,t)}
    let finalStep=(row["steps"] as! [[String:Any]]).first{$0["id"] as? String==third["id"] as? String}!
    try h.finish(receipt,["kind":"workflow-step-outcome","stepId":third["id"]!,"workflowPlanHash":plan["workflowPlanHash"]!,"status":"completed","result":finalStep["result"]!])
    var result=try copy(map(row["result"]));result["requestHash"]=p["requestHash"];result["workflowPlanHash"]=plan["workflowPlanHash"];result["approvalId"]=receipt["approvalId"]
    result["steps"]=[["id":first["id"]!,"kind":first["kind"]!,"status":"failed","error":failure["error"]!],["id":steps[1]["id"]!,"kind":steps[1]["kind"]!,"status":"skipped","error":["code":"DEPENDENCY_FAILED","message":"Workflow dependency failed"]],finalStep]
    try h.c.close(owner:"v",scope:h.scope,id:"op");let digest=try hash(result)
    yes(h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:digest));yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"));yes(h.key.signs==2)
    result["steps"]=[finalStep];yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:try hash(result)))
    h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:digest))
   }else{rejects{try h.finish(receipt,failure)};try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverWorkflowResult(owner:"v",scope:h.scope,id:"op",method:h.method,resultHash:String(repeating:"0",count:64)))}
   yes(h.ui.shown==2 && h.store.writes==1 && h.key.computes==0)
  }
  // A callback arriving after lock/cancel cannot complete the active child or
  // produce a delivery permit; no extra approval or automatic retry occurs.
  for fence in ["lock","cancel"]{
   let row=execution.first!,h=try Harness(map(row["sample"]));h.key.recorded=row["signed"] as! [[String:Any]]
   try h.grant();try h.begin();try h.consent();h.ui.choose("op");let receipt=try h.bind(),plan=map(h.sample["plan"]),p=map(plan["payload"]),source=(row["steps"] as! [[String:Any]])[0]
   let tasks=(p["immediateSigningTasks"] as! [[String:Any]]).filter{$0["stepId"] as? String==source["id"] as? String}.map{map($0["task"])}
   try h.enter(receipt,["kind":"workflow-step","stepId":source["id"]!,"workflowPlanHash":plan["workflowPlanHash"]!,"tasks":tasks]);h.key.hold=true
   var result:Result<[String:Any],Error>?;try h.c.sign(owner:"v",scope:h.scope,id:"op",receipt:receipt,task:tasks[0]){result=$0}
   yes(result==nil);if fence=="lock"{h.accounts.unlocked=false}else{try h.c.cancel(owner:"v",scope:h.scope,id:"op")}
   h.key.held!();rejects{_ = try result!.get()};yes(h.key.signs==1);try h.c.close(owner:"v",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"))
  }
  let jsonCases=root["jsonCases"] as! [[String:Any]]
  for j in jsonCases{let input=j["input"] as! String,field=j["field"] as! String,ids=j["txids"] as! [String],output=j["expected"] as! String
   try NativeWorkflowJSON.template(input,field:field);try NativeWorkflowJSON.verify(template:input,field:field,ids:ids,resolved:output);yes(true)
   rejects{try NativeWorkflowJSON.verify(template:input,field:field,ids:[String(repeating:"0",count:64)],resolved:output)}
   rejects{try NativeWorkflowJSON.verify(template:input,field:field,ids:ids,resolved:"{\"injected\":true,"+output.dropFirst())}
  }
  for input in ["[]","{\"txids\":1}","{\"__proto__\":{},\"txids\":[]}","{\"x\":01}","{\"x\":1.}","{\"x\":1e}","{\"x\":NaN}","{\"x\":\"\\q\"}","{\"x\":true,}","{\"x\":[1,]}","{}trailing"]{rejects{try NativeWorkflowJSON.template(input,field:"txids")}}
  print("{\"status\":\"PASS\",\"cases\":\(cases.count),\"receiptCases\":\(receipts),\"receiptVariants\":\(variants.count),\"stepCases\":\(execution.count),\"completedSteps\":\(stepCount),\"replayedSignatures\":\(replays),\"jsonCases\":\(jsonCases.count),\"failureCases\":\(failureModes.count),\"checks\":\(checks),\"signatures\":0,\"proof\":\"native-dependent-child-execution-and-result-permits\"}")
 }
}
