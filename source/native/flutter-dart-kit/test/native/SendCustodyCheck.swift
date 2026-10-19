import Foundation
import CryptoKit

// Public-signature replay against the real native owner. No key or HTTP.
private func map(_ x:Any?)->[String:Any]{x as! [String:Any]}
private func rows(_ x:Any?)->[[String:Any]]{x as! [[String:Any]]}
private func hash(_ x:Any)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(x).utf8)).map{String(format:"%02x",$0)}.joined()}
private func raw(_ s:String)->[UInt8]{let a=Array(s.utf8);return stride(from:0,to:a.count,by:2).map{UInt8(String(bytes:a[$0..<$0+2],encoding:.utf8)!,radix:16)!}}
@MainActor private var checks=0
@MainActor private func yes(_ v:Bool){precondition(v,"send custody check \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var failed=false;do{try f()}catch{failed=true};yes(failed)}
@MainActor private final class Accounts:NativeAccountSource{
 var current:NativeAccount,revision:Int64=0,unlocked=true
 let signingAccounts:[NativeAccount]
 init(_ a:[[String:Any]]){signingAccounts=a.map{NativeAccount(address:$0["address"] as! String,publicKey:$0["publicKey"] as! String,chainId:$0["chainId"] as! String)};current=signingAccounts[0]}
}
@MainActor private final class Store:NativePermissionBackend{
 var values=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{values}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{try fence();precondition((values[origin]?.revision ?? 0)==expected);let v=PermissionSnapshot(revision:expected+1,records:records);values[origin]=v;writes+=1;return PermissionCommitResult(acknowledgedRevision:v.revision,current:v)}
}
@MainActor private final class UI:NativeApprovalPresenter{
 var reviews=[String:NativeReview](),pending=[String:@MainActor (Bool)->Void](),shown=0
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;reviews[review.operationId]=review;pending[review.operationId]=complete;return {self.pending.removeValue(forKey:review.operationId)}}
 func choose(_ id:String,_ approved:Bool=true){pending.removeValue(forKey:id)!(approved)}
}
@MainActor private final class Signer:NativeDigestSigner{
 let signed:[[String:Any]];var calls=0
 init(_ signed:[[String:Any]]){self.signed=signed}
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  calls+=1;complete(Result{try requireCurrent();let d=digest.map{String(format:"%02x",$0)}.joined()
   guard let s=signed.first(where:{let t=map($0["task"]);return t["digest"] as? String==d && t["signatureEncoding"] as? String==encoding && t["accountId"] as? String==account.accountId && t["publicKey"] as? String==account.publicKey})else{throw NativeCustodyFailure(code:"TEST_UNRECORDED_TASK")}
   return raw(map(s["result"])["signature"] as! String)
  })
 }
}
@MainActor private final class Harness{
 let sample:[String:Any],accounts:Accounts,store=Store(),ui=UI(),signer:Signer,c:NativeCustody,scope:[String:String]
 var receipt=[String:Any]()
 lazy var host=NativeWalletHost(custody:c){_,_,_ in}
 var method:String{sample["method"] as! String}
 var workflow:Bool{sample["workflow"] as! Bool}
 let id:String
 init(_ s:[String:Any],enabled:Bool=true,source:String=String(repeating:"a",count:64),id:String="op",navigate:Bool=true)throws{
  self.id=id
  sample=s;accounts=Accounts(rows(s["accounts"]));signer=Signer(rows(s["signed"]))
  var scope=map(s["context"]).filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="send-check";scope["committedUrl"]=scope["origin"]!+"/dapp";self.scope=scope
  c=try NativeCustody(accounts:accounts,chain:accounts.current.chainId,backend:store,approval:ui,signer:signer,sendSourceIdentity:enabled ? source:nil){owner,value in owner=="view" && value==scope};if navigate{try c.navigation(owner:"view",scope:scope)}
 }
 func grant(omitting:String?=nil)throws{
  var request=[String:Any]()
  for p in sample["permissions"] as! [String] where p != omitting{request[p]=["chains":[accounts.current.chainId]]}
  request["tbc_accounts"]=["chains":[accounts.current.chainId],"maxAccounts":accounts.signingAccounts.count]
  var r:Result<[[String:Any]],Error>?;try c.requestPermissions(owner:"view",scope:scope,id:"grant",request:request){r=$0};ui.choose("grant");_ = try r!.get()
 }
 func begin()throws{_ = try c.begin(owner:"view",scope:scope,id:id,method:method,expectedRevision:c.snapshot(owner:"view",scope:scope).revision,expectedAccount:accounts.current)}
 func ready(approve:Bool=true)throws{
  try grant();try begin()
  let request=map(sample["request"]),context=map(sample["context"])
  if request["signingRoles"] != nil{_ = try c.resolveSigningAccounts(owner:"view",scope:scope,id:id,request:request,context:context)}
  var r:Result<Bool,Error>?;try c.consent(owner:"view",scope:scope,id:id,method:method,request:request,context:context){r=$0}
  yes(ui.shown==2 && r==nil);yes(ui.reviews[id]!.description.contains(NativePrepared.sends(method) ? "wallet will submit":"no broadcast") || (!NativePrepared.sends(method) && ui.reviews[id]!.description.contains("No broadcast")));ui.choose(id,approve);yes(try r!.get()==approve)
  if !approve{return}
  if workflow{var b:Result<[String:Any],Error>?;try c.bindWorkflow(owner:"view",scope:scope,id:id,binding:map(sample["binding"]),preview:map(sample["preview"]),plan:map(sample["plan"])){b=$0};receipt=try b!.get()}
  else{receipt=try c.bind(owner:"view",scope:scope,id:id,binding:map(sample["binding"]),preview:map(sample["preview"]),plan:map(sample["plan"]),envelope:nil)}
 }
 // Only approval IDs/tokens differ from the frozen public replay.
 func approved(_ value:Any)->Any{
  if let a=value as? [Any]{return a.map(approved)}
  guard var m=value as? [String:Any]else{return value}
  for (k,v) in m{m[k]=k=="approvalId" ? receipt["approvalId"]:(k=="bindingHash" ? receipt["bindingHash"]:approved(v))};return m
 }
 func authorize(_ bundle:[String:Any]?=nil,_ claimedWorkflow:[String:Any]?=nil)throws{
  let w=claimedWorkflow ?? (sample["result"] as? [String:Any]).map{map(approved($0))}
  let input:[String:Any]=["ownerId":"view","scope":scope,"operation":id,"receipt":receipt,"bundle":bundle ?? map(approved(sample["bundle"]!)),"workflow":w as Any? ?? NSNull()]
  var r:[String:Any]?,replies=0
  host.dispatch(method:"signing.broadcast.authorize",input:input){r=$0;replies+=1}
  yes(replies==1)
  if r?["ok"] as? Bool != true{yes(try PermissionJSON.canonical(r)==PermissionJSON.canonical(["ok":false,"code":"NATIVE_DENIED"]));throw NativeCustodyFailure(code:"TEST_CHANNEL_DENIED")}
  yes(r?["value"] as? Bool==true)
 }
 func selection(_ index:Int?)throws->[String:Any]{try c.broadcastSelection(owner:"view",scope:scope,id:id,receipt:receipt,index:index)}
 func finishSignatures()throws{
  for step in rows(sample["steps"]){
   if workflow{try c.enterWorkflowStep(owner:"view",scope:scope,id:id,receipt:receipt,entry:map(step["entry"]))}
   for stage in rows(step["stages"]){
    if let pending=stage["pending"]{try c.advance(owner:"view",scope:scope,id:id,receipt:receipt,pending:map(approved(pending)))}
    for task in rows(stage["tasks"]){var r:Result<[String:Any],Error>?;try c.sign(owner:"view",scope:scope,id:id,receipt:receipt,task:task){r=$0};_ = try r!.get()}
   }
   if workflow{var r:Result<Bool,Error>?;try c.finishWorkflowStep(owner:"view",scope:scope,id:id,receipt:receipt,outcome:map(approved(step["outcome"]!))){r=$0};yes(try r!.get())}
  }
 }
 func publicResult(_ statuses:[String]?=nil)->[String:Any]{
  let bundle=map(approved(sample["bundle"]!)),txs=rows(bundle["transactions"])
  if !workflow{var value=bundle;value["transactions"]=txs.map{tx in ["id":tx["id"]!,"txid":tx["txid"]!,"status":"submitted","role":tx["role"]!,"dependsOn":tx["dependsOn"]!]};return value}
  let states=statuses ?? txs.map{_ in "accepted"},set=Set(states)
  return ["version":"1.0","status":set.isSubset(of:["accepted","known"]) ? "complete":set==["unknown"] ? "unknown":set==["rejected"] ? "rejected":"partial","workflow":approved(sample["result"]!),"transactions":zip(txs,states).map{["txid":$0["txid"]!,"status":$1]}]
 }
 func finish(_ result:[String:Any])throws{try c.finishBroadcast(owner:"view",scope:scope,id:id,receipt:receipt,result:result)}
}
@main @MainActor struct SendCustodyCheck{
 static func main()async throws{
  let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),cases=rows(root["cases"])
  var signatures=0
  for row in rows(root["sources"]){
   let options=map(row["options"]),endpoint=options["endpoint"] as? [String:Any]
   let configuration=try NativeBroadcastConfiguration(network:options["network"] as! String,apiOrigin:endpoint?["apiOrigin"] as? String,trustId:endpoint?["trustId"] as? String,rpcOrigin:endpoint?["rpcOrigin"] as? String)
   yes(configuration.sourceIdentity==row["sourceIdentity"] as? String)
  }
  for sample in cases{
   let h=try Harness(sample);yes(try h.c.snapshot(owner:"view",scope:h.scope).optionalMethods.isEmpty);rejects{try h.host.installBroadcast{_,_,_ in}};try h.ready();rejects{try h.authorize()};rejects{_ = try h.selection(h.workflow ? nil:0)}
   try h.finishSignatures();signatures+=h.signer.calls
   var bundle=map(h.approved(sample["bundle"]!));bundle["from"]="foreign-account";rejects{try h.authorize(bundle)}
   bundle=map(h.approved(sample["bundle"]!));bundle["totalFee"]="0";rejects{try h.authorize(bundle)}
   bundle=map(h.approved(sample["bundle"]!));var txs=rows(bundle["transactions"]);txs[0]["txid"]=String(repeating:"0",count:64);bundle["transactions"]=txs;rejects{try h.authorize(bundle)}
   if h.workflow{var w=map(h.approved(sample["result"]!));w["steps"]=[];rejects{try h.authorize(nil,w)}}
   var wrongReceipt=h.receipt;wrongReceipt["approvalId"]="foreign";rejects{try h.c.authorizeBroadcast(owner:"view",scope:h.scope,id:"op",receipt:wrongReceipt,bundle:map(h.approved(sample["bundle"]!)))}
   try h.authorize();rejects{try h.authorize()}
   let selection=try h.selection(h.workflow ? nil:0)
   yes(selection["sourceIdentity"] as? String==String(repeating:"a",count:64));yes(try selection["accountScopeHash"] as? String==hash(h.accounts.current.identity));yes((selection["authorizationId"] as? String)?.count==64)
   let expected=rows(map(h.approved(sample["bundle"]!))["transactions"])
   yes(try PermissionJSON.canonical(selection["transactions"])==PermissionJSON.canonical(h.workflow ? expected:[expected[0]]))
   var changed=rows(selection["transactions"]);changed[0]["rawTransaction"]="00"
   yes(try PermissionJSON.canonical(h.selection(h.workflow ? nil:0)["transactions"])==PermissionJSON.canonical(selection["transactions"]))
   var denied:[String:Any]?
   h.host.dispatch(method:"signing.broadcast.authorize",input:["ownerId":"view","scope":h.scope,"operation":"op","receipt":h.receipt,"bundle":[:],"workflow":NSNull(),"endpoint":"https://untrusted.invalid"]){denied=$0}
   yes(try PermissionJSON.canonical(denied)==PermissionJSON.canonical(["ok":false,"code":"NATIVE_DENIED"]))
   rejects{_ = try h.selection(h.workflow ? 0:nil)};rejects{_ = try h.selection(-1)};rejects{_ = try h.selection(99)}
   h.accounts.unlocked=false;rejects{_ = try h.selection(h.workflow ? nil:0)};h.accounts.unlocked=true
   yes(h.ui.shown==2 && h.store.writes==1)
   try h.c.close(owner:"view",scope:h.scope,id:"op");yes(!h.c.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"));yes(!h.c.mayDeliverWorkflowResult(owner:"view",scope:h.scope,id:"op",method:h.method,resultHash:"none"));rejects{_ = try h.selection(h.workflow ? nil:0)}
  }
  for sample in cases{
   let h=try Harness(sample);try h.grant(omitting:"tbc_sendTransaction");rejects{try h.begin()};yes(h.signer.calls==0 && h.ui.shown==1)
   let disabled=try Harness(sample,enabled:false);rejects{try disabled.grant()};yes(disabled.ui.shown==0)
  }
  let single=cases.first{$0["workflow"] as? Bool==false}!
  do{let h=try Harness(single);try h.ready(approve:false);rejects{try h.authorize()};yes(h.signer.calls==0)}
  do{let h=try Harness(single);try h.ready();try h.finishSignatures();try h.authorize();try h.c.cancel(owner:"view",scope:h.scope,id:"op");rejects{_ = try h.selection(0)}}
  do{let h=try Harness(single);try h.ready();try h.finishSignatures();try h.authorize();h.c.invalidate(owner:"view");rejects{_ = try h.selection(0)}}
  do{let h=try Harness(single);try h.ready();try h.finishSignatures();try h.authorize();h.accounts.revision+=1;rejects{_ = try h.selection(0)}}
  do{let h=try Harness(single);try h.ready();try h.finishSignatures();try h.authorize();try h.c.disconnect(owner:"view",scope:h.scope,id:"revoke");rejects{_ = try h.selection(0)}}
  for sample in rows(root["signOnly"]){
   let h=try Harness(sample);try h.ready();try h.finishSignatures();rejects{try h.authorize()}
   try h.c.close(owner:"view",scope:h.scope,id:"op")
   if h.workflow{yes(try h.c.mayDeliverWorkflowResult(owner:"view",scope:h.scope,id:"op",method:h.method,resultHash:hash(h.approved(sample["result"]!))))}
   else{yes(h.c.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))}
  }
  var dispatchChecks=0
  var routerChecks=0
  if CommandLine.arguments.count==4{
   let before=checks;try await dispatchCases(cases,origin:CommandLine.arguments[2],directory:CommandLine.arguments[3]);dispatchChecks=checks-before
   let routed=checks;try await routerCases(cases,origin:CommandLine.arguments[2],directory:CommandLine.arguments[3]);routerChecks=checks-routed
  }
  print(String(data:try JSONSerialization.data(withJSONObject:["status":"PASS","checks":checks,"dispatchChecks":dispatchChecks,"routerChecks":routerChecks,"cases":cases.count,"signatureReplays":signatures,"broadcasts":0],options:.sortedKeys),encoding:.utf8)!)
 }
 static func dispatchCases(_ cases:[[String:Any]],origin:String,directory:String)async throws{
  let api="https://api.tbcdev.org",source=String(repeating:"a",count:64),http=try NativeBroadcastHTTP(sourceIdentity:source)
  func setup(_ sample:[String:Any],suffix:String,route:String?=nil)throws->(Harness,SystemBroadcastStore,NativeBroadcastDispatch,[String:Any],String){
   let h=try Harness(sample);try h.ready();try h.finishSignatures();try h.authorize()
   let chosen=try h.selection(h.workflow ? nil:0),txs=rows(chosen["transactions"])
   let key=(sample["name"] as! String)+suffix
   let params:[String:Any]=["version":"1.0","chainId":h.accounts.current.chainId,"idempotencyKey":key,h.workflow ? "transactions":"transaction":h.workflow ? txs as Any:txs[0] as Any]
   let call:[String:Any]=["callId":key,"operation":h.workflow ? "broadcast.submitBatch":"broadcast.submit","execution":["type":"session-only"],"params":params]
   let store=try SystemBroadcastStore(directory:URL(fileURLWithPath:directory),profile:key,sourceIdentity:source,accountScopeHash:chosen["accountScopeHash"] as! String)
   let adapter=try h.c.makeBroadcastDispatch(owner:"view",scope:h.scope,id:"op",receipt:h.receipt,index:h.workflow ? nil:0,store:store,apiOrigin:api,chainId:h.accounts.current.chainId,call:call){request,fence,reply in
    // Test-only socket destination; production validated origin is unchanged.
    let loop=NativeBroadcastHTTPRequest(sourceIdentity:request.sourceIdentity,method:request.method,url:URL(string:origin+(request.method=="POST" ? route ?? request.url.path:request.url.path))!,body:request.body,deadline:request.deadline)
    return try http.start(loop,fence:fence,complete:reply)
   }
   let body=try PermissionJSON.canonical(h.workflow ? txs.map{["txraw":$0["rawTransaction"]!]} as Any:["txraw":txs[0]["rawTransaction"]!] as Any)
   return(h,store,adapter,call,body)
  }
  func wire(_ a:NativeBroadcastDispatch,_ method:String,_ path:String,_ body:String?)async->Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>{
   await withCheckedContinuation{continuation in do{try a.wire(method:method,url:api+path,body:body){continuation.resume(returning:$0)};rejects{_ = try a.deliveryState()}}catch{continuation.resume(returning:.failure(NativeBroadcastHTTPFailure(code:"TEST_REJECTED")))}}
  }
  for sample in cases{
   let (h,store,a,call,body)=try setup(sample,suffix:"-ok");defer{store.close()}
   try a.guardCall(call);var changed=call;changed["callId"]="foreign";rejects{try a.guardCall(changed)}
   yes(try a.begin(a.identities).created);yes(try !a.begin(a.identities).created)
   rejects{_ = try a.deliveryState()};rejects{try h.finish(h.publicResult())}
   let id=a.identities[0];rejects{try a.complete(id,status:"accepted")};rejects{_ = try a.read("foreign")}
   rejects{try a.admit(Array(a.identities.reversed())+[id])};try a.admit(a.identities);rejects{try a.admit(a.identities)}
   rejects{_ = try a.deliveryState()}
   let path=h.workflow ? "/api/tbc/broadcasttxs":"/api/tbc/broadcasttx"
   rejects{try a.wire(method:"POST",url:"https://foreign.invalid"+path,body:body){_ in fatalError("foreign dispatch")}}
   rejects{try a.wire(method:"POST",url:api+path,body:"{\"txraw\":\"00\"}"){_ in fatalError("replacement dispatch")}}
   yes(try await wire(a,"POST",path,body).get().status==200)
   yes(try a.deliveryState().allSatisfy{$0["status"]=="unknown"});rejects{try h.finish(h.publicResult())}
   for identity in a.identities{try a.complete(identity,status:"accepted");yes(try a.read(identity.idempotencyKey)?.state=="completed")}
   rejects{try a.wire(method:"POST",url:api+path,body:body){_ in fatalError("replay")}}
   yes(try a.readByTxids(a.identities.map{$0.txid}).count==a.identities.count)
   if h.workflow || rows(map(sample["bundle"])["transactions"]).count==1{
    try h.finish(h.publicResult());rejects{try h.finish(h.publicResult())};rejects{try a.complete(id,status:"accepted")}
   }else{rejects{try h.finish(h.publicResult())}} // Unsubmitted tail cannot be called submitted.
   try h.c.close(owner:"view",scope:h.scope,id:"op");rejects{try a.guardCall(call)}
  }
  let batch=cases.first{$0["workflow"] as? Bool==true && rows(map($0["bundle"])["transactions"]).count==2}!
  for mode in ["unknown","rejected","partial"]{
   let (h,store,a,_,body)=try setup(batch,suffix:"-result-"+mode,route:"/result/"+mode);defer{store.close()}
   _ = try a.begin(a.identities);try a.admit(a.identities)
   let response=await wire(a,"POST","/api/tbc/broadcasttxs",body)
   if mode=="unknown"{if case .success=response{yes(false)}else{yes(true)}}
   else{
    yes(try response.get().status==200)
    for (i,id) in a.identities.enumerated(){try a.complete(id,status:mode=="partial" && i>0 ? "known":"rejected")}
   }
   let statuses=mode=="unknown" ? ["unknown","unknown"]:mode=="rejected" ? ["rejected","rejected"]:["rejected","unknown"]
   let result=h.publicResult(statuses)
   rejects{try h.finish(h.publicResult())}
   if mode=="partial"{rejects{try h.finish(h.publicResult(["rejected","known"]))}}
   var altered=result;var rs=rows(result["transactions"]);rs[0]["reason"]=String(repeating:"x",count:513);altered["transactions"]=rs;rejects{try h.finish(altered)}
   try h.finish(result);try h.c.close(owner:"view",scope:h.scope,id:h.id)
   yes(try h.c.mayDeliverSendResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:hash(result)))
   h.accounts.revision+=1;yes(try !h.c.mayDeliverSendResult(owner:"view",scope:h.scope,id:h.id,method:h.method,resultHash:hash(result)))
  }
  let single=cases.first{$0["workflow"] as? Bool==false}!
  for mode in ["prepared","admitted","fence","dropped","reconciled","cancel-started"]{
   let (h,store,a,call,body)=try setup(single,suffix:"-"+mode,route:["dropped","reconciled"].contains(mode) ? "/drop":mode=="cancel-started" ? "/slow":nil);defer{store.close()}
   _ = try a.begin(a.identities);if mode != "prepared"{try a.admit(a.identities)}
   if mode=="fence"{h.accounts.revision+=1;rejects{try a.wire(method:"POST",url:api+"/api/tbc/broadcasttx",body:body){_ in fatalError("stale dispatch")}}}
   if ["dropped","reconciled"].contains(mode){
    if case .success = await wire(a,"POST","/api/tbc/broadcasttx",body){yes(false)}else{yes(true)}
    yes(try store.read(a.identities[0].idempotencyKey)?.state=="uncertain")
    rejects{try a.abortPreflight(a.identities[0],code:"INVALID_INPUT")}
   }
   if mode=="reconciled"{
    rejects{try a.wire(method:"GET",url:api+"/api/tbc/decode/txid/"+String(repeating:"0",count:64),body:nil){_ in fatalError("foreign status")}}
    yes(try await wire(a,"GET","/api/tbc/decode/txid/"+a.identities[0].txid,nil).get().status==200)
    try a.complete(a.identities[0],status:"known");yes(try store.read(a.identities[0].idempotencyKey)?.resultStatus=="known")
   }
   if mode=="cancel-started"{
    Task{try? await Task.sleep(nanoseconds:30_000_000);try? h.c.cancel(owner:"view",scope:h.scope,id:"op")}
    if case .success = await wire(a,"POST","/api/tbc/broadcasttx",body){yes(false)}else{yes(true)}
    rejects{try a.complete(a.identities[0],status:"accepted")}
   }
   try h.c.cancel(owner:"view",scope:h.scope,id:"op");a.close()
   let state=mode=="reconciled" ? "completed":["dropped","cancel-started"].contains(mode) ? "uncertain":"not-submitted"
   yes(try store.read(a.identities[0].idempotencyKey)?.state==state);rejects{try a.guardCall(call)}
  }
 }
 static func routerCases(_ cases:[[String:Any]],origin:String,directory:String)async throws{
  let configuration=try NativeBroadcastConfiguration(network:"testnet"),source=configuration.sourceIdentity
  let http=try NativeBroadcastHTTP(sourceIdentity:source)
  rejects{_ = try NativeBroadcastConfiguration(network:"mainnet",apiOrigin:"https://api.tbcdev.org",trustId:"wrong")}
  rejects{_ = try NativeBroadcastConfiguration(network:"testnet",apiOrigin:"https://custom.invalid")}
  rejects{_ = try NativeBroadcastConfiguration(network:"testnet",apiOrigin:"https://custom.invalid:443",trustId:"bad")}
  for sample in cases{
   let id=try PermissionJSON.id("P4/rpc",map(sample["context"])["sessionId"] as! String,PermissionJSON.canonical("send-request"))
   let h=try Harness(sample,source:source,id:id,navigate:false)
   let router=NativeBroadcastRouter(custody:h.c,configuration:configuration,directory:URL(fileURLWithPath:directory),profile:"router-"+(sample["name"] as! String)){request,fence,reply in
    let loop=NativeBroadcastHTTPRequest(sourceIdentity:request.sourceIdentity,method:request.method,url:URL(string:origin+request.url.path)!,body:request.body,deadline:request.deadline)
    return try http.start(loop,fence:fence,complete:reply)
   };defer{router.close()}
   try h.host.installBroadcast{method,input,reply in router.dispatch(method:method,input:input,reply:reply)}
   rejects{try h.host.installBroadcast{_,_,_ in}}
   try h.c.navigation(owner:"view",scope:h.scope);yes(try h.c.snapshot(owner:"view",scope:h.scope).optionalMethods==NativePrepared.sendMethods)
   try h.ready();try h.finishSignatures();try h.authorize()
   let selected=try h.selection(h.workflow ? nil:0),txs=rows(selected["transactions"]),index:Any=h.workflow ? NSNull():0
   let params:[String:Any]=["version":"1.0","chainId":"tbc:testnet","idempotencyKey":"route",h.workflow ? "transactions":"transaction":h.workflow ? txs as Any:txs[0] as Any]
   let call:[String:Any]=["callId":"route","operation":h.workflow ? "broadcast.submitBatch":"broadcast.submit","execution":["type":"session-only"],"params":params]
   let base:[String:Any]=["ownerId":"view","scope":h.scope,"operation":h.id,"receipt":h.receipt,"index":index]
   func command(_ method:String,_ fields:[String:Any],base override:[String:Any]?=nil)async->[String:Any]{
    let encoded:String=await withCheckedContinuation{resume in h.host.dispatch(method:method,input:(override ?? base).merging(fields){_,b in b}){resume.resume(returning:try! PermissionJSON.canonical($0))}}
    return map(try! JSONSerialization.jsonObject(with:Data(encoded.utf8)))
   }
   func success(_ method:String,_ fields:[String:Any],base override:[String:Any]?=nil)async->[String:Any]{let r=await command(method,fields,base:override);yes(r["ok"] as? Bool==true);return r}
   let opened=await success("signing.broadcast.open",["call":call]);yes(map(opened["value"])["sourceIdentity"] as? String==source)
   yes((await command("signing.broadcast.open",["call":call]))["ok"] as? Bool==false)
   yes((await command("signing.broadcast.guard",["call":call,"endpoint":"https://foreign.invalid"]))["ok"] as? Bool==false)
   var wrong=base;wrong["receipt"]=["approvalId":"foreign"]
   yes((await command("signing.broadcast.guard",["call":call],base:wrong))["ok"] as? Bool==false)
   _ = await success("signing.broadcast.guard",["call":call])
   let identities=try txs.enumerated().map{i,tx -> [String:Any] in
    let key=h.workflow ? "route:\(i)":"route";var context:[String:Any]=["version":"1.0","callId":"route","operation":call["operation"]!,"params":params];if h.workflow{context["index"]=i}
    return ["idempotencyKey":"tbcnet-"+source.prefix(24)+"-"+(try hash(["idempotencyKey":key])),"rawHash":SHA256.hash(data:Data(raw(tx["rawTransaction"] as! String))).map{String(format:"%02x",$0)}.joined(),"txid":tx["txid"]!,"submitContextHash":try hash(context),"accountScopeHash":try hash(h.accounts.current.identity)]
   }
   _ = await success("signing.broadcast.journal",["action":"begin","arguments":["identities":identities]])
   _ = await success("signing.broadcast.journal",["action":"admit","arguments":["identities":identities]])
   let body=try PermissionJSON.canonical(h.workflow ? txs.map{["txraw":$0["rawTransaction"]!]} as Any:["txraw":txs[0]["rawTransaction"]!] as Any)
   var wire:[String:Any]=["method":"POST","url":configuration.apiOrigin+(h.workflow ? "/api/tbc/broadcasttxs":"/api/tbc/broadcasttx"),"body":body,"deadline":"2000-01-01T00:00:00Z"]
   yes((await command("signing.broadcast.wire",wire))["ok"] as? Bool==false)
   wire["deadline"]=ISO8601DateFormatter().string(from:Date().addingTimeInterval(15))
   let response=await success("signing.broadcast.wire",wire)
   yes(map(response["value"])["statusCode"] as? Int==200)
   yes(Data(base64Encoded:map(response["value"])["body"] as! String) != nil)
   for id in identities{_ = await success("signing.broadcast.journal",["action":"complete","arguments":["identity":id,"status":"accepted"]])}
   yes((await command("signing.broadcast.wire",wire))["ok"] as? Bool==false)
   let result=h.publicResult()
   func finish(_ r:[String:Any])async->Bool{(await command("signing.broadcast.finish",["result":r],base:base.filter{$0.key != "index"}))["ok"] as? Bool==true}
   let writes=h.store.writes,approvals=h.ui.shown
   if !h.workflow{
    let count=rows(map(sample["bundle"])["transactions"]).count
    for index in 1..<count{
     yes(!(await finish(result))) // A successful prefix is not the complete send.
     let tx=rows(try h.selection(index)["transactions"])[0],key="route-\(index)"
     let params:[String:Any]=["version":"1.0","chainId":"tbc:testnet","idempotencyKey":key,"transaction":tx]
     let call:[String:Any]=["callId":key,"operation":"broadcast.submit","execution":["type":"session-only"],"params":params]
     let stage=base.merging(["index":index]){_,b in b}
     _ = await success("signing.broadcast.open",["call":call],base:stage)
     let identity:[String:Any]=["idempotencyKey":"tbcnet-"+source.prefix(24)+"-"+(try hash(["idempotencyKey":key])),"rawHash":SHA256.hash(data:Data(raw(tx["rawTransaction"] as! String))).map{String(format:"%02x",$0)}.joined(),"txid":tx["txid"]!,"submitContextHash":try hash(["version":"1.0","callId":key,"operation":"broadcast.submit","params":params]),"accountScopeHash":try hash(h.accounts.current.identity)]
     _ = await success("signing.broadcast.journal",["action":"begin","arguments":["identities":[identity]]],base:stage)
     _ = await success("signing.broadcast.journal",["action":"admit","arguments":["identities":[identity]]],base:stage)
     let wire:[String:Any]=["method":"POST","url":configuration.apiOrigin+"/api/tbc/broadcasttx","body":try PermissionJSON.canonical(["txraw":tx["rawTransaction"]!]),"deadline":ISO8601DateFormatter().string(from:Date().addingTimeInterval(15))]
     let response=await success("signing.broadcast.wire",wire,base:stage);yes(map(response["value"])["statusCode"] as? Int==200)
     _ = await success("signing.broadcast.journal",["action":"complete","arguments":["identity":identity,"status":"accepted"]],base:stage)
     yes((await command("signing.broadcast.wire",wire,base:stage))["ok"] as? Bool==false)
    }
   }
   let canFinish=true
   do{
    var altered=result;altered["extra"]="not-authorized";yes(!(await finish(altered)))
    altered=result;var changed=rows(result["transactions"]);changed[0]["txid"]=String(repeating:"0",count:64);altered["transactions"]=changed;yes(!(await finish(altered)))
    changed=rows(result["transactions"]);changed[0]["status"]="unknown";altered=result;altered["transactions"]=changed;yes(!(await finish(altered)))
    yes(await finish(result));yes(!(await finish(result)))
   }
   yes(h.ui.shown==approvals && h.store.writes==writes)
   yes((await command("signing.broadcast.wire",wire))["ok"] as? Bool==false)
   try h.c.close(owner:"view",scope:h.scope,id:h.id)
   yes(!h.c.mayDeliverSignature(owner:"view",scope:h.scope,id:h.id))
   func delivery(_ value:[String:Any])throws->String{
    let payload:[String:Any]=["response":["jsonrpc":"2.0","id":"send-request","result":value],"events":[Any]()]
    return try PermissionJSON.canonical(["channel":"tws-webview/1","type":"delivery","sessionId":h.scope["sessionId"]!,"navigationId":h.scope["navigationId"]!,"messageId":"send-host","deliveryId":try hash(payload)].merging(payload){_,b in b})
   }
   func prepare(_ text:String,_ method:String?=nil)async->Bool{
    (await command("delivery.prepare",["method":method ?? h.method,"requestId":"send-request","serialized":text],base:["ownerId":"view","scope":h.scope]))["ok"] as? Bool==true
   }
   let text=try delivery(result)
   yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:text))
   yes(await prepare(text)==canFinish);yes(h.host.allowDelivery(owner:"view",scope:h.scope,text:text)==canFinish)
   var tampered=result;tampered["totalFee"]="0";let bad=try delivery(tampered)
   yes(!(await prepare(bad)) && !h.host.allowDelivery(owner:"view",scope:h.scope,text:bad))
   yes(!(await prepare(text,"tbc_signTransaction")))
   h.accounts.unlocked=false;yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:text));h.accounts.unlocked=true
   if canFinish{yes(h.host.allowDelivery(owner:"view",scope:h.scope,text:text));try h.c.disconnect(owner:"view",scope:h.scope,id:"revoke");yes(!h.host.allowDelivery(owner:"view",scope:h.scope,text:text))}
   yes((await command("signing.broadcast.guard",["call":call]))["ok"] as? Bool==false)
  }
 }
}
