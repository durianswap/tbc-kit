import Foundation
import CryptoKit

@MainActor private final class CustodyAccounts:NativeAccountSource {
 var current:NativeAccount;var revision:Int64=0;var unlocked=true
 var additional=[NativeAccount]();var signingAccounts:[NativeAccount]{[current]+additional}
 init(_ current:NativeAccount){self.current=current}
}
@MainActor private final class CustodyStore:NativePermissionBackend {
 let walletProtocol:NativeWalletProtocol
 init(_ walletProtocol:NativeWalletProtocol = .standard){self.walletProtocol=walletProtocol}
 var records=[String:PermissionSnapshot](),loads=0,writes=0
 func loadAll()throws->[String:PermissionSnapshot]{loads+=1;return records}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();try permissionNeed((self.records[origin]?.revision ?? 0)==expected,"TEST_CAS")
  let next=PermissionSnapshot(revision:expected+1,records:records);try fence();self.records[origin]=next;writes+=1
  return PermissionCommitResult(acknowledgedRevision:next.revision,current:next)
 }
}
@MainActor private final class CustodyUi:NativeApprovalPresenter {
 var pending=[String:@MainActor (Bool)->Void](),shown=0,dismissed=0
 var reviews=[String:NativeReview]()
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{
  shown+=1;precondition(pending[review.operationId]==nil);pending[review.operationId]=complete;reviews[review.operationId]=review
  return {self.pending.removeValue(forKey:review.operationId);self.dismissed+=1}
 }
 func choose(_ id:String,_ yes:Bool=true){pending.removeValue(forKey:id)!(yes)}
}
@MainActor private final class ReplaySigner:NativeDigestSigner {
 let samples:[String:[UInt8]];var calls=0,used=0,hold=false,wrongLength=false
 var identities=[String:NativeAccount]()
 var release:(@MainActor ()->Void)?
 init(_ samples:[String:[UInt8]]){self.samples=samples}
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  calls+=1
  let perform:@MainActor ()->Void={
   complete(Result{
    try requireCurrent();guard let value=self.samples[hex(digest)]else{throw PermissionFailure(code:"UNRECORDED_DIGEST")}
    try permissionNeed(self.identities[hex(digest)]==account,"WRONG_SIGNING_ACCOUNT")
    try permissionNeed(value.count==(encoding=="compact64" ? 64:65),"WRONG_ENCODING");self.used+=1
    return self.wrongLength ? [1]:value
   })
  }
  if hold{release=perform}else{perform()}
 }
}
@MainActor private final class NativeDocuments {var current=[String:[String:String]]()}
private func hex(_ b:[UInt8])->String{b.map{String(format:"%02x",$0)}.joined()}
private func unhex(_ s:String)->[UInt8]{let bytes=Array(s.utf8);return stride(from:0,to:bytes.count,by:2).map{UInt8(String(bytes:bytes[$0..<$0+2],encoding:.utf8)!,radix:16)!}}
private func hash(_ value:Any?)throws->String{hex(Array(SHA256.hash(data:Data(try PermissionJSON.canonical(value).utf8))))}
private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
@MainActor private var custodyChecks=0
@MainActor private func yes(_ value:Bool){if !value{FileHandle.standardError.write(Data("custody check \(custodyChecks+1) failed\n".utf8));exit(1)};custodyChecks+=1}
@MainActor private func rejects(_ f:()throws->Void){var rejected=false;do{try f()}catch{rejected=true};yes(rejected)}

// Rebind only proposal freshness for the offline native clock. The immutable
// oracle's business request, plan, transaction bytes and task digests stay exact.
private func freshPreparedRequest(_ request:[String:Any],_ method:String)throws->[String:Any]{
 guard method=="tbc_signPreparedTransaction" else{return request}
 var r=request,proposal=map(r["proposal"]),p=map(proposal["payload"]),e=map(p["evidence"])
 let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
 p["createdAt"]=f.string(from:Date());p["expiresAt"]=f.string(from:Date().addingTimeInterval(240));e["observedAt"]=p["createdAt"]
 p["evidence"]=e;proposal["payload"]=p;proposal["proposalHash"]=try hash(p);r["proposal"]=proposal;return r
}
@MainActor private final class CustodyHarness {
 let account:NativeAccount,accounts:CustodyAccounts,store:CustodyStore,ui:CustodyUi,signer:ReplaySigner,custody:NativeCustody
 let context:[String:Any],audit:[String:Any],method:String,request:[String:Any],tasks:[[String:Any]],signatures:[[String:Any]],scope:[String:String]
 let documents=NativeDocuments()
 init(_ sample:[String:Any],walletProtocol:NativeWalletProtocol = .standard)throws{
  let a=map(sample["account"]);account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
  accounts=CustodyAccounts(account);store=CustodyStore(walletProtocol);ui=CustodyUi()
  context=map(sample["context"]);audit=map(sample["audit"]);method=sample["method"] as! String;request=try freshPreparedRequest(map(sample["request"]),method)
  if NativePrepared.transaction(method){tasks=map(map(audit["plan"])["payload"])["signingTasks"] as! [[String:Any]]}
  else if let recorded=audit["tasks"] as? [[String:Any]]{tasks=recorded}
  else{tasks=[["taskId":"sign-message","purpose":"message","algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":map(audit["preview"])["digest"]!,"signatureEncoding":"compact65-recoverable","origin":context["origin"]!,"accountId":account.accountId,"publicKey":account.publicKey]]}
  signatures=audit["signatures"] as! [[String:Any]]
  let allTasks=(audit["stages"] as? [[String:Any]])?.flatMap{$0["tasks"] as! [[String:Any]]} ?? tasks
  var samples=[String:[UInt8]]();for t in allTasks{samples[t["digest"] as! String]=unhex(signatures.first{$0["taskId"] as? String==t["taskId"] as? String}!["signature"] as! String)}
  signer=ReplaySigner(samples)
  accounts.additional=(sample["additionalAccounts"] as? [[String:String]] ?? (method=="tbc_signPreparedTransaction" ? map(map(audit["material"])["snapshot"])["payload"].map{map($0)["signingAccounts"] as? [[String:String]] ?? []} ?? []:[])).map{NativeAccount(address:$0["address"]!,publicKey:$0["publicKey"]!,chainId:$0["chainId"]!)}
  for t in allTasks{signer.identities[t["digest"] as! String]=accounts.signingAccounts.first{$0.accountId==t["accountId"] as? String && $0.publicKey==t["publicKey"] as? String}}
  let documents=self.documents
  custody=try NativeCustody(accounts:accounts,chain:account.chainId,backend:store,approval:ui,signer:signer,walletProtocol:walletProtocol){owner,scope in documents.current[owner]==scope}
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String}
  scope["webViewInstanceId"]="native-check";scope["committedUrl"]=(context["origin"] as! String)+"/dapp";self.scope=scope
  documents.current["view"]=scope;try custody.navigation(owner:"view",scope:scope)
 }
 func reviewId(_ id:String)->String{custody.walletProtocol == .legacy ? PermissionJSON.id(custody.walletProtocol.rawValue,"review",id):id}
 func grant()throws{
  var value:Result<[[String:Any]],Error>?
  try custody.requestPermissions(owner:"view",scope:scope,id:"grant",request:["tbc_accounts":["chains":[account.chainId],"maxAccounts":accounts.signingAccounts.count ],NativePrepared.permission(method):["chains":[account.chainId]]]){value=$0}
  yes(value==nil && store.writes==0);ui.choose(reviewId("grant"));_ = try value!.get();yes(store.writes==1)
 }
 func begin(_ id:String="op",owner:String="view",scope:[String:String]?=nil)throws{
  let scope=scope ?? self.scope
  _ = try custody.begin(owner:owner,scope:scope,id:id,method:method,expectedRevision:custody.snapshot(owner:owner,scope:scope).revision,expectedAccount:account)
  if owner=="view" && request["signingRoles"] != nil{_ = try custody.resolveSigningAccounts(owner:owner,scope:scope,id:id,request:request,context:context)}
 }
 func consent(_ id:String="op",complete:@escaping @MainActor (Result<Bool,Error>)->Void={_ in})throws{
  try custody.consent(owner:"view",scope:scope,id:id,method:method,request:request,context:context,complete:complete)
  if let intent=request["intent"] as? [String:Any],["tbc20.transfer","tbc20Stablecoin.transfer"].contains(intent["type"] as? String ?? ""){
   let description=ui.reviews[id]!.description
   let receivers=(intent["receivers"] as? [[String:Any]]) ?? [intent]
   for row in receivers{precondition(description.contains("Send \(row["amount"] as! String) token atomic to \(row["to"] as! String)."))}
   if let payment=intent["payment"] as? [String:Any]{precondition(description.contains("Also send \(payment["amount"] as! String) TBC atomic to \(payment["to"] as! String)."))}
  }
  if let intent=request["intent"] as? [String:Any],(intent["type"] as? String)?.hasPrefix("tbc20Stablecoin.")==true{
   precondition(ui.reviews[id]!.description.contains("Stablecoin \(intent["contractId"] as! String)"))
  }
  if let intent=request["intent"] as? [String:Any],intent["type"] as? String=="tbc721.transfer"{
   let description=ui.reviews[id]!.description
   precondition(description.contains("Send NFT \(intent["contractId"] as! String) to \(intent["to"] as! String)."))
   if let payment=intent["payment"] as? [String:Any]{precondition(description.contains("Also send \(payment["amount"] as! String) TBC atomic to \(payment["to"] as! String)."))}
  }
 }
 func material(_ id:String="op",badBinding:Bool=false)throws->[String:Any]{
  var b=try PermissionJSON.records("["+PermissionJSON.canonical(audit["binding"])+"]")[0],p=map(b["payload"])
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];p["expiresAt"]=f.string(from:Date().addingTimeInterval(120))
  if badBinding{p["requestHash"]=String(repeating:"00",count:32)};b["payload"]=p;b["bindingHash"]=try hash(p)
  return try custody.bind(owner:"view",scope:scope,id:id,binding:b,preview:map(audit["preview"]),plan:audit["plan"] as? [String:Any],envelope:method=="tbc_signMessage" ? ["type":"tbc.message","version":"1.0","message":request["message"]!]:audit["envelope"] as? [String:Any])
 }
 func ready()throws->[String:Any]{try grant();try begin();try consent();ui.choose(reviewId("op"));return try material()}
 func pending(_ receipt:[String:Any],_ stage:Int=0)throws->[String:Any]{
  var p=try PermissionJSON.records("["+PermissionJSON.canonical((audit["stages"] as! [[String:Any]])[stage]["result"])+"]")[0]
  var c=map(p["continuation"]);c["bindingHash"]=receipt["bindingHash"];c["approvalId"]=receipt["approvalId"];p["continuation"]=c;return p
 }
 func signFirst(_ receipt:[String:Any])throws{
  for task in tasks{var result:Result<[String:Any],Error>?;try custody.sign(owner:"view",scope:scope,id:"op",receipt:receipt,task:task){result=$0};_ = try result!.get()}
 }
}

@MainActor private func preparedCheck(_ samples:[[String:Any]])throws{
 for sample in samples{
  let h=try CustodyHarness(sample),receipt=try h.ready(),stages=h.audit["stages"] as! [[String:Any]]
  yes(h.ui.shown==2 && h.ui.reviews["op"]!.description.contains("no broadcast"))
  for (index,stage) in stages.enumerated(){
   if index>0{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:h.pending(receipt,index-1))}
   for task in stage["tasks"] as! [[String:Any]]{
    var result:Result<[String:Any],Error>?
    try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){result=$0}
    yes(try PermissionJSON.canonical(result!.get())==PermissionJSON.canonical(h.signatures.first{$0["taskId"] as? String==task["taskId"] as? String}!))
   }
  }
  rejects{try h.signFirst(receipt)}
  try h.custody.close(owner:"view",scope:h.scope,id:"op")
  yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op") && h.signer.used==h.signatures.count && h.store.writes==1)
  h.accounts.unlocked=false;yes(!h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
 }
 for mutation in ["hash","profile","intent","expired","observation"]{
  let h=try CustodyHarness(samples[0]);try h.grant();try h.begin()
  var r=h.request,proposal=map(r["proposal"]),p=map(proposal["payload"])
  switch mutation{
  case "profile":p["engineProfile"]="arbitrary-engine"
  case "intent":p["intentHash"]=String(repeating:"00",count:32)
  case "expired":p["expiresAt"]="2020-01-01T00:00:00Z"
  case "observation":var e=map(p["evidence"]);e["observedAt"]="2020-01-01T00:00:00Z";p["evidence"]=e
  default:break
  }
  proposal["payload"]=p;proposal["proposalHash"]=mutation=="hash" ? String(repeating:"00",count:32):try hash(p);r["proposal"]=proposal
  rejects{try h.custody.consent(owner:"view",scope:h.scope,id:"op",method:h.method,request:r,context:h.context){_ in fatalError("UNREACHABLE")}}
  yes(h.ui.shown==1 && h.signer.used==0)
 }
 for mutation in ["fee","raw","role","edge","full-request-hash","method","deadline"]{
  let sample=samples.first{$0["name"] as? String=="create-tbc20-fragmented"}!,h=try CustodyHarness(sample)
  try h.grant();try h.begin();var r=h.request,proposal=map(r["proposal"]),p=map(proposal["payload"])
  if ["fee","raw","role","edge"].contains(mutation){
   var txs=p["transactions"] as! [[String:Any]]
   switch mutation{
   case "fee":p["estimatedTotalFee"]="1"
   case "raw":txs[0]["unsignedTransaction"]="00000000"
   case "role":txs[0]["role"]="primary"
   default:var edges=txs[1]["deferredInputs"] as! [[String:Any]];edges[0]["sourceOutputIndex"]=99;txs[1]["deferredInputs"]=edges
   }
   p["transactions"]=txs;proposal["payload"]=p;proposal["proposalHash"]=try hash(p);r["proposal"]=proposal
  }
  try h.custody.consent(owner:"view",scope:h.scope,id:"op",method:h.method,request:r,context:h.context){_ = try! $0.get()};h.ui.choose("op")
  var b=map(h.audit["binding"]),payload=map(b["payload"])
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  payload["expiresAt"]=f.string(from:Date().addingTimeInterval(mutation=="deadline" ? 290:120))
  if mutation=="full-request-hash"{payload["requestHash"]=try hash(r)}
  if mutation=="method"{payload["method"]="tbc_signTransaction"}
  b["payload"]=payload;b["bindingHash"]=try hash(payload)
  rejects{_ = try h.custody.bind(owner:"view",scope:h.scope,id:"op",binding:b,preview:map(h.audit["preview"]),plan:map(h.audit["plan"]),envelope:nil)}
  yes(h.signer.used==0 && h.ui.shown==2 && h.store.writes==1)
 }
 do{
  let h=try CustodyHarness(samples[0]);rejects{try h.begin()};try h.grant();try h.begin();var result:Result<Bool,Error>?
  try h.consent{result=$0};h.ui.choose("op",false);yes(try result!.get()==false);rejects{_ = try h.material()};yes(h.signer.used==0)
 }
 do{
  let h=try CustodyHarness(samples[0]),r=try h.ready();h.signer.hold=true;var result:Result<[String:Any],Error>?
  try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:r,task:h.tasks[0]){result=$0}
  h.accounts.unlocked=false;h.signer.release!();if case .failure?=result{yes(true)}else{yes(false)};yes(h.signer.used==0)
 }
}

@MainActor private func typedNegativeCheck(_ sample:[String:Any],_ invalid:[[String:Any]])throws{
 for bad in invalid{
  var changed=sample;changed["request"]=bad["request"]
  let h=try CustodyHarness(changed);try h.grant();try h.begin()
  rejects{try h.consent()};yes(h.ui.shown==1 && h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample)
  try h.custody.requestPermissions(owner:"view",scope:h.scope,id:"message-only",request:["tbc_accounts":["chains":[h.account.chainId]],"tbc_signMessage":["chains":[h.account.chainId]]]){_ = try! $0.get()}
  h.ui.choose("message-only");rejects{try h.begin()};yes(h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample);try h.grant()
  rejects{_ = try h.custody.begin(owner:"view",scope:h.scope,id:"ordinary",method:"tbc_signMessage",expectedRevision:h.custody.snapshot(owner:"view",scope:h.scope).revision,expectedAccount:h.account)}
  yes(h.signer.calls==0)
 }
 for mutation in 0..<7{
  let h=try CustodyHarness(sample);try h.grant();try h.begin();try h.consent();h.ui.choose("op")
  var b=map(h.audit["binding"]),p=map(b["payload"]),review=map(h.audit["preview"]),envelope=map(h.audit["envelope"])
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  p["expiresAt"]=f.string(from:Date().addingTimeInterval(120))
  switch mutation{
  case 0:p["operationHash"]=String(repeating:"00",count:32);review["digest"]=p["operationHash"]
  case 1:envelope["message"]=["amount":"999"]
  case 2:review["domain"]=["name":"Unapproved","chainId":h.account.chainId]
  case 3:envelope["types"]=["Transfer":[["name":"to","type":"different"]]]
  case 4:p["operationKind"]="message"
  case 5:review["message"]=["amount":"999"]
  default:review["primaryType"]="Changed"
  }
  b["payload"]=p;b["bindingHash"]=try hash(p)
  rejects{_ = try h.custody.bind(owner:"view",scope:h.scope,id:"op",binding:b,preview:review,plan:nil,envelope:envelope)}
  yes(h.signer.calls==0 && h.ui.shown==2)
 }
}

@MainActor private func controllerNegativeCheck(_ sample:[String:Any])throws{
 do{
  let h=try CustodyHarness(sample),roles=h.accounts.additional;h.accounts.additional=[];try h.grant();h.accounts.additional=roles
  rejects{try h.begin()};yes(h.ui.shown==1 && h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample);try h.grant()
  _ = try h.custody.begin(owner:"view",scope:h.scope,id:"op",method:h.method,expectedRevision:h.custody.snapshot(owner:"view",scope:h.scope).revision,expectedAccount:h.account)
  rejects{try h.consent()};yes(h.ui.shown==1 && h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample);try h.grant();try h.begin()
  rejects{_ = try h.custody.resolveSigningAccounts(owner:"view",scope:h.scope,id:"op",request:h.request,context:h.context)}
  var changed=h.request;changed["constraints"]=["maxFee":"99999"]
  rejects{try h.custody.consent(owner:"view",scope:h.scope,id:"op",method:h.method,request:changed,context:h.context){_ in fatalError("UNREACHABLE")}}
  yes(h.ui.shown==1 && h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample);try h.grant();try h.begin();var result:Result<Bool,Error>?
  try h.consent{result=$0};h.accounts.additional=[];h.ui.choose("op")
  if case .failure?=result{yes(true)}else{yes(false)};yes(h.signer.calls==0)
 }
 do{
  let h=try CustodyHarness(sample),receipt=try h.ready();h.signer.hold=true;var result:Result<[String:Any],Error>?
  let task=h.tasks.first{$0["accountId"] as? String != h.account.accountId}!
  try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){result=$0}
  let controller=h.accounts.additional[0]
  h.accounts.additional=[NativeAccount(address:controller.address,publicKey:h.account.publicKey,chainId:controller.chainId)]
  h.signer.release!();if case .failure?=result{yes(true)}else{yes(false)};yes(h.signer.used==0)
 }
 do{
  let h=try CustodyHarness(sample),receipt=try h.ready();try h.signFirst(receipt)
  try h.custody.close(owner:"view",scope:h.scope,id:"op");yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
  h.accounts.additional=[];yes(!h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
 }
 do{
  let h=try CustodyHarness(sample);try h.grant();try h.begin();try h.consent();h.ui.choose("op")
  var review=map(h.audit["preview"]);review.removeValue(forKey:"signingRoles")
  rejects{_ = try h.custody.bind(owner:"view",scope:h.scope,id:"op",binding:map(h.audit["binding"]),preview:review,plan:map(h.audit["plan"]),envelope:nil)}
  yes(h.signer.calls==0)
 }
}

@MainActor private func creationCheck(_ sample:[String:Any])throws{
 let h=try CustodyHarness(sample),receipt=try h.ready(),stages=h.audit["stages"] as! [[String:Any]],intent=map(h.request["intent"])
 let description=h.ui.reviews["op"]!.description
 let mint=["tbc721-standard-mint","tbc721-standard-batch-mint"].contains(intent["type"] as? String ?? "")
 let amm=intent["type"] as? String=="tbc-amm-create"
 let pool=["tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap"].contains(intent["type"] as? String ?? "")
 if pool{yes(description.contains(intent["poolContractId"] as! String) && description.contains("authenticated Pool fees"))}
 else if amm{
  yes(description.contains(intent["ftContractId"] as! String) && description.contains("adding liquidity is separate"))
  yes(description.contains("LP timelock: \((intent["lpTimelock"] as! Bool))."))
  for c in intent["controllers"] as? [String] ?? ["Public (no controller)"]{yes(description.contains(c))}
 }else if mint{
  yes(description.contains(intent["collectionId"] as! String))
  let items=intent["type"] as? String=="tbc721-standard-mint" ? [intent]:intent["items"] as! [[String:Any]]
  for item in items{yes(try description.contains("Slot \(item["slot"]!):") && description.contains(item["name"] as! String) && description.contains(PermissionJSON.canonical(item["attributes"])) && description.contains(item["to"] as? String ?? h.account.address))}
 }else{yes(description.contains(intent["name"] as! String) && description.contains(intent["to"] as? String ?? h.account.address))}
 yes(description.contains("no broadcast") && description.contains("input consolidation"))
 if intent["type"] as? String=="tbc20-standard-create"{
  yes(description.contains(intent["symbol"] as! String) && description.contains(intent["initialSupply"] as! String) && description.contains("dependent funding/source/genesis"))
 }else if !mint && !amm && !pool{yes(try description.contains(hash(intent["media"])) && description.contains(intent["supply"] as! String))}
 for (index,stage) in stages.enumerated(){
  if index>0{
   let p=try h.pending(receipt,index-1)
   if mint || amm || pool{var wrong=p,c=map(p["continuation"]);c["family"]="ft";wrong["continuation"]=c;rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:wrong)}}
   if pool{for mutation in ["planHash","stage","taskDigest"]{
    var wrong=try PermissionJSON.records("["+PermissionJSON.canonical(p)+"]")[0],c=map(p["continuation"])
    if mutation=="planHash"{c[mutation]="wrong"}else if mutation=="stage"{c[mutation]=index+1}else{var tasks=wrong["signingRequests"] as! [[String:Any]];tasks[0]["digest"]=String(repeating:"00",count:32);wrong["signingRequests"]=tasks}
    wrong["continuation"]=c;rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:wrong)}
   }}
   try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:p);rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:p)}
  }
  for task in stage["tasks"] as! [[String:Any]]{
   var result:Result<[String:Any],Error>?
   try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){result=$0}
   yes(try PermissionJSON.canonical(result!.get())==PermissionJSON.canonical(h.signatures.first{$0["taskId"] as? String==task["taskId"] as? String}!))
  }
 }
 try h.custody.close(owner:"view",scope:h.scope,id:"op")
 yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op") && h.ui.shown==2 && h.signer.used==h.signatures.count && h.store.writes==1)
 if (mint || amm || pool) && stages.count>1{
  let x=try CustodyHarness(sample),r=try x.ready();try x.signFirst(r);try x.custody.close(owner:"view",scope:x.scope,id:"op")
  yes(!x.custody.mayDeliverSignature(owner:"view",scope:x.scope,id:"op"));rejects{try x.custody.advance(owner:"view",scope:x.scope,id:"op",receipt:r,pending:x.pending(r))}
 }
 // Rehashed but unconsented warning/maintenance shape must still fail custody.
 if (stages.count==3 && !pool) || (pool && !(map(h.audit["preview"])["warnings"] as! [String]).isEmpty){for mutation in ["warning","role"]{
  var bad=try PermissionJSON.records("["+PermissionJSON.canonical(sample)+"]")[0],a=map(sample["audit"]),plan=map(a["plan"]),p=map(plan["payload"]),preview=map(a["preview"])
  if mutation=="warning"{preview["warnings"]=["MULTI_TRANSACTION","UNKNOWN"]}else{var tx=p["transactions"] as! [[String:Any]];tx[0]["role"]="primary";p["transactions"]=tx}
  p["preview"]=preview;plan["payload"]=p;plan["planHash"]=try hash(p);a["preview"]=preview;a["plan"]=plan
  var binding=map(a["binding"]),b=map(binding["payload"]);b["operationHash"]=plan["planHash"];binding["payload"]=b;binding["bindingHash"]=try hash(b);a["binding"]=binding;bad["audit"]=a
  let x=try CustodyHarness(bad);try x.grant();try x.begin();try x.consent();x.ui.choose("op");rejects{_ = try x.material()};yes(x.signer.used==0)
 }}
}

@MainActor private func ammFeeReview(_ sample:[String:Any],_ rows:[[String:Any]])throws{
 for row in rows{
  var changed=sample,request=map(sample["request"]),intent=map(request["intent"])
  intent["lpPlan"]=row["lpPlan"];intent["serviceFeeRate"]=row["totalFeeBps"];request["intent"]=intent;changed["request"]=request
  let h=try CustodyHarness(changed);try h.grant();try h.begin();try h.consent()
  let text=h.ui.reviews["op"]!.description,total=(row["totalFeeBps"] as! NSNumber).intValue,lp=(row["lpFeeBps"] as! NSNumber).intValue
  yes(text.contains("total \(total) bps; LP \(lp) bps; service \(total-lp) bps"))
  yes(text.contains(row["serviceFeeAddress"] as! String) && h.signer.used==0)
  try h.custody.cancel(owner:"view",scope:h.scope,id:"op");yes(h.ui.pending.isEmpty)
 }
}
@MainActor private func explicitAmmFeeReview(_ sample:[String:Any])throws{
 let intent=map(map(sample["request"])["intent"]),fees=map(intent["feePolicy"])
 let h=try CustodyHarness(sample);try h.grant();try h.begin();try h.consent()
 let text=h.ui.reviews["op"]!.description
 let fields=["lpFeeRate","taxFeeRate","serviceProviderFeeRate","protocolFeeRate"],labels=["LP","tax","service provider","protocol"]
 let rates=fields.map{(fees[$0] as! NSNumber).intValue},total=rates.reduce(0,+)
 for (index,label) in labels.enumerated(){yes(text.contains("\(label) \(rates[index]) bps"))}
 yes(text.contains("Total \(total) bps") && text.contains("Combined non-LP \(total-rates[0]) bps") && text.contains(fees["feeAddress"] as! String))
 yes(h.signer.used==0);try h.custody.cancel(owner:"view",scope:h.scope,id:"op")
 for mutation in ["negative","fraction","total","address","missing","lpPlan"]{
  var changed=sample,request=map(sample["request"]),i=intent,f=fees
  switch mutation{
   case "negative":f["lpFeeRate"] = -1
   case "fraction":f["lpFeeRate"]=0.5
   case "total":f["lpFeeRate"]=9999;f["taxFeeRate"]=1
   case "address":f["feeAddress"]="invalid"
   case "missing":f.removeValue(forKey:"protocolFeeRate")
   default:i["lpPlan"]=6
  }
  i["feePolicy"]=f;request["intent"]=i;changed["request"]=request
  let x=try CustodyHarness(changed);try x.grant();try x.begin();rejects{try x.consent()};yes(x.signer.used==0 && x.ui.pending.isEmpty)
 }
}
@MainActor private func stagedCheck(_ sample:[String:Any])throws{
 let h=try CustodyHarness(sample),receipt=try h.ready(),pending=try h.pending(receipt)
 rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:pending)}
 try h.signFirst(receipt)
 for mutation in ["planHash","approvalId","stage","session","taskDigest","taskId","family"]{
  var p=try PermissionJSON.records("["+PermissionJSON.canonical(pending)+"]")[0],c=map(p["continuation"])
  switch mutation{
   case "planHash","approvalId":c[mutation]="wrong"
   case "stage":c["stage"]=2
   case "session":c["sessionId"]=String(repeating:"00",count:32)
   case "family":c["family"]="unknown"
   case "taskDigest","taskId":var t=p["signingRequests"] as! [[String:Any]];t[0][mutation=="taskDigest" ? "digest":"taskId"]=String(repeating:"00",count:32);p["signingRequests"]=t
   default:break
  };p["continuation"]=c
  rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:p)}
 }
 try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:pending)
 rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:pending)}
 for task in pending["signingRequests"] as! [[String:Any]]{
  var result:Result<[String:Any],Error>?
  try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){result=$0}
  yes(try PermissionJSON.canonical(result!.get())==PermissionJSON.canonical(h.signatures.first{$0["taskId"] as? String==task["taskId"] as? String}!))
  rejects{try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){_ in fatalError("REPLAY")}}
 }
 rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:pending)}
 let stages=h.audit["stages"] as! [[String:Any]]
 for index in 2..<stages.count{
  let next=try h.pending(receipt,index-1)
  try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:next)
  for task in next["signingRequests"] as! [[String:Any]]{
   var result:Result<[String:Any],Error>?
   try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){result=$0}
   yes(try PermissionJSON.canonical(result!.get())==PermissionJSON.canonical(h.signatures.first{$0["taskId"] as? String==task["taskId"] as? String}!))
   rejects{try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:task){_ in fatalError("REPLAY")}}
  }
  rejects{try h.custody.advance(owner:"view",scope:h.scope,id:"op",receipt:receipt,pending:next)}
 }
 try h.custody.close(owner:"view",scope:h.scope,id:"op")
 yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op") && h.ui.shown==2 && h.signer.used==h.signatures.count && h.store.writes==1)
 for cancelled in [false,true]{
  let x=try CustodyHarness(sample),r=try x.ready();try x.signFirst(r)
  if cancelled{try x.custody.cancel(owner:"view",scope:x.scope,id:"op")}
  else{try x.custody.close(owner:"view",scope:x.scope,id:"op")}
  yes(!x.custody.mayDeliverSignature(owner:"view",scope:x.scope,id:"op"))
  rejects{try x.custody.advance(owner:"view",scope:x.scope,id:"op",receipt:r,pending:x.pending(r))}
  yes(x.signer.used==x.tasks.count)
 }
}

@MainActor private func hostCheck(_ sample:[String:Any])throws{
 let h=try CustodyHarness(sample);var changed=[String]()
 let host=NativeWalletHost(custody:h.custody){owner,_,_ in changed.append(owner)}
 try host.navigation(owner:"view",scope:h.scope)
 var other=h.scope;other["webViewInstanceId"]="other";other["sessionId"]="other-session";other["navigationId"]="other-nav"
 h.documents.current["other"]=other;try host.navigation(owner:"other",scope:other)
 func base()->[String:Any]{["ownerId":"view","scope":h.scope]}
 func call(_ method:String,_ fields:[String:Any]=[:])->[String:Any]{
  var reply:[String:Any]?;host.dispatch(method:method,input:base().merging(fields){_,b in b}){reply=$0};return reply!
 }
 func frame(_ type:String,_ extra:[String:Any])throws->String{try PermissionJSON.canonical(["channel":"tws-webview/1","type":type,"sessionId":h.scope["sessionId"]!,"navigationId":h.scope["navigationId"]!,"messageId":"native-check"].merging(extra){_,b in b})}
 func delivery(_ id:String,_ value:Any)throws->String{
  let payload:[String:Any]=["response":["jsonrpc":"2.0","id":id,"result":value],"events":[Any]()]
  return try frame("delivery",payload.merging(["deliveryId":try hash(payload)]){_,b in b})
 }
 func prepare(_ method:String,_ id:String,_ text:String)->[String:Any]{call("delivery.prepare",["method":method,"requestId":id,"serialized":text])}
 func allow(_ text:String)->Bool{host.allowDelivery(owner:"view",scope:h.scope,text:text)}
 func op(_ id:String)throws->String{PermissionJSON.id("P4/rpc",h.scope["sessionId"]!,try PermissionJSON.canonical(id))}
 yes(call("delivery.acknowledge",["requestId":"never-prepared"])["ok"] as? Bool==false)
 for i in 0...300{
  let id="ack-read-\(i)",text=try delivery(id,h.account.chainId)
  yes(prepare("tbc_chainId",id,text)["ok"] as? Bool==true && allow(text))
  yes(call("delivery.acknowledge",["requestId":id])["ok"] as? Bool==true)
  yes(!allow(text))
 }
 let initial=try frame("initialize",["origin":h.scope["origin"]!,"chainId":h.account.chainId]);yes(allow(initial))
 yes(try !allow(frame("initialize",["origin":"https://forged.invalid","chainId":h.account.chainId])))
 let empty=try delivery("empty",[String]());yes(prepare("tbc_accounts","empty",empty)["ok"] as? Bool==true && allow(empty))
 for (id,message,emitted,accepted) in [("chain-error","Unsupported chain",[Any](),true),("bad-chain-error","internal detail",[Any](),false),("chain-error-event","Unsupported chain",[["name":"chainChanged","payload":"tbc:mainnet"]] as [Any],false)]{
  let payload:[String:Any]=["response":["jsonrpc":"2.0","id":id,"error":["code":4901,"message":message]],"events":emitted]
  let text=try frame("delivery",payload.merging(["deliveryId":try hash(payload)]){_,b in b})
  yes((prepare("tbc_switchChain",id,text)["ok"] as? Bool==true)==accepted && allow(text)==accepted)
 }
 let forged=try delivery("forged",[h.account.address]);yes(prepare("tbc_accounts","forged",forged)["ok"] as? Bool==false && !allow(forged))
 let unknown=call("signing.unknown");yes(try PermissionJSON.canonical(unknown)==PermissionJSON.canonical(["ok":false,"code":"NATIVE_DENIED"]) && h.store.writes==0)
 var grant:[String:Any]?;let grantOp=try op("grant")
 host.dispatch(method:"permissions.request",input:base().merging(["operation":grantOp,"providerMethod":"tbc_requestAccounts","permissions":["tbc_accounts":["chains":[h.account.chainId],"maxAccounts":h.accounts.signingAccounts.count],NativePrepared.permission(h.method):["chains":[h.account.chainId]]]]){_,b in b}){grant=$0}
 yes(grant==nil);h.ui.choose(grantOp);yes(grant!["ok"] as? Bool==true && changed==["other"])
 let connected=try delivery("grant",h.accounts.signingAccounts.map{$0.address});yes(prepare("tbc_requestAccounts","grant",connected)["ok"] as? Bool==true && allow(connected))
 yes(!allow(empty));let badGrant=try delivery("invented",[h.account.address]);yes(prepare("tbc_requestAccounts","invented",badGrant)["ok"] as? Bool==false)
 let metadata=try delivery("metadata",h.account.identity.merging(["features":["tbc:provider"]]){_,b in b})
 yes(prepare("tbc_getAccount","metadata",metadata)["ok"] as? Bool==false)
 let event=try frame("event",["event":["name":"accountsChanged","payload":h.accounts.signingAccounts.map{$0.address}]])
 yes(allow(event));yes(try !allow(frame("event",["event":["name":"accountsChanged","payload":["forged"]]])))
 let signed=try delivery("signed",sample["result"]!);yes(prepare(h.method,"signed",signed)["ok"] as? Bool==false)
 let operation=try op("signed"),before=h.store.writes
 yes(try call("signing.begin",["operation":operation,"method":h.method,"revision":h.custody.snapshot(owner:"view",scope:h.scope).revision,"account":h.account.identity])["ok"] as? Bool==true)
 if h.request["signingRoles"] != nil{
  yes(call("signing.roles",["operation":operation,"request":h.request,"context":h.context,"account":h.account.identity])["ok"] as? Bool==false)
  let resolved=call("signing.roles",["operation":operation,"request":h.request,"context":h.context])
  yes(try resolved["ok"] as? Bool==true && PermissionJSON.canonical(resolved["value"])==PermissionJSON.canonical(h.accounts.additional.map{$0.identity}))
 }
 var consent:[String:Any]?
 host.dispatch(method:"signing.consent",input:base().merging(["operation":operation,"method":h.method,"request":h.request,"context":h.context]){_,b in b}){consent=$0}
 yes(consent==nil);h.ui.choose(operation);yes(consent!["value"] as? Bool==true)
 let receipt=try h.material(operation)
 for task in h.tasks{yes(call("signing.sign",["operation":operation,"receipt":receipt,"task":task])["ok"] as? Bool==true)}
 for index in 0..<max(0,((h.audit["stages"] as? [Any])?.count ?? 1)-1){
  let pending=try h.pending(receipt,index)
  yes(call("signing.advance",["operation":operation,"receipt":receipt,"pending":pending])["value"] as? Bool==true)
  for task in pending["signingRequests"] as! [[String:Any]]{yes(call("signing.sign",["operation":operation,"receipt":receipt,"task":task])["ok"] as? Bool==true)}
 }
 yes(call("signing.close",["operation":operation])["ok"] as? Bool==true)
 yes(prepare(h.method,"signed",signed)["ok"] as? Bool==true && allow(signed))
 yes(h.store.writes==before && h.ui.shown==2)
 yes(call("operation.cancel",["operation":operation])["ok"] as? Bool==true && !allow(signed))
 if !h.accounts.additional.isEmpty{
  let role=h.accounts.additional[0]
  let roleMetadata=try delivery("role-metadata",role.identity.merging(["features":["tbc:provider"]]){_,new in new})
  yes(prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"] as? Bool==false)
  let metadataOp=try op("metadata-grant");var metadataGrant:[String:Any]?
  host.dispatch(method:"permissions.request",input:base().merging(["operation":metadataOp,"providerMethod":"wallet_requestPermissions","permissions":["tbc_accountMetadata":["chains":[h.account.chainId]]]]){_,new in new}){metadataGrant=$0}
  yes(metadataGrant==nil);h.ui.choose(metadataOp);yes(metadataGrant?["ok"] as? Bool==true)
  yes(prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"] as? Bool==true && allow(roleMetadata))
  let wrong=try delivery("wrong-key",role.identity.merging(["publicKey":h.account.publicKey,"features":["tbc:provider"]]){_,new in new})
  yes(prepare("tbc_getAccount","wrong-key",wrong)["ok"] as? Bool==false && !allow(wrong))
  yes((map(call("snapshot")["value"])["connectedAccounts"] as! [[String:Any]]).count==2)
  h.accounts.additional=[];h.accounts.revision+=1;host.accountChanged()
  yes(!allow(roleMetadata) && prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"] as? Bool==false)
 }
 h.accounts.unlocked=false;host.accountChanged();yes(!allow(connected) && !allow(event))
 let locked=try delivery("locked",[Any]());yes(prepare("wallet_getPermissions","locked",locked)["ok"] as? Bool==true && allow(locked))
 yes(try allow(frame("event",["event":["name":"accountsChanged","payload":[Any]()]])))
 host.invalidate(owner:"view");yes(!allow(initial) && !allow(locked))
}

@main private struct CustodyCheck {
 @MainActor static func main()throws{
  let replay=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="legacy-message"{
   for sample in replay["singles"] as! [[String:Any]]{
    let h=try CustodyHarness(sample,walletProtocol:.legacy),receipt=try h.ready();try h.signFirst(receipt)
    yes(h.ui.shown==2 && h.signer.used==1 && h.store.writes==1)
    yes(try PermissionJSON.canonical(NativeSigningEnvelope.result(map(h.audit["envelope"]),task:h.tasks[0],signature:h.signatures[0],account:h.account,walletProtocol:.legacy))==PermissionJSON.canonical(sample["result"]))
    rejects{try h.signFirst(receipt)};try h.custody.close(owner:"view",scope:h.scope,id:"op");yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
    let wrong=try CustodyHarness(sample);rejects{_ = try wrong.ready()};yes(wrong.signer.calls==0)
    var changed=sample,audit=map(sample["audit"]),binding=map(audit["binding"]),payload=map(binding["payload"]),preview=map(audit["preview"])
    payload["operationHash"]=String(repeating:"00",count:32);binding["payload"]=payload;binding["bindingHash"]=try hash(payload)
    preview["digest"]=payload["operationHash"];audit["binding"]=binding;audit["preview"]=preview;changed["audit"]=audit
    let forged=try CustodyHarness(changed,walletProtocol:.legacy);rejects{_ = try forged.ready()};yes(forged.signer.calls==0)
   }
   for s in replay["workflows"] as! [[String:Any]]{
    let a=map(s["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
    let format=ISO8601DateFormatter();format.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
    func bind(_ protocolId:NativeWalletProtocol)throws->NativeWorkflow.Binding{try NativeWorkflow.bind(method:s["method"] as! String,request:map(s["request"]),context:map(s["context"]),account:account,accounts:[],plan:map(s["plan"]),preview:map(s["preview"]),binding:map(s["binding"]),reviews:[:],walletProtocol:protocolId,now:format.date(from:s["now"] as! String)!)}
    yes(try PermissionJSON.canonical(bind(.legacy).plan)==PermissionJSON.canonical(s["plan"]))
    rejects{_ = try bind(.standard)}
    for d in map(s["expected"])["deferred"] as! [[String:Any]]{
     let resolved=map(d["resolved"]),sourceId=map(resolved["source"])["stepId"] as! String
     let descriptor=(map(map(s["plan"])["payload"])["deferredSigningTasks"] as! [[String:Any]]).first{$0["targetStepId"] as? String==d["stepId"] as? String}!
     let completed=[sourceId:map(d["sourceBundle"])],origin=map(s["context"])["origin"] as! String
     let pair=try NativeWorkflow.resolve(descriptor,claimed:resolved,completed:completed,account:account,origin:origin,walletProtocol:.legacy)
     yes(try PermissionJSON.canonical(pair.task)==PermissionJSON.canonical(resolved["concreteTask"]))
     rejects{_ = try NativeWorkflow.resolve(descriptor,claimed:resolved,completed:completed,account:account,origin:origin)}
     rejects{_ = try NativeWorkflow.resolve(descriptor,claimed:resolved,completed:[:],account:account,origin:origin,walletProtocol:.legacy)}
    }
   }
   print("{\"platform\":\"swift-macos\",\"status\":\"PASS\",\"checks\":\(custodyChecks),\"legacyMessages\":4,\"legacyWorkflows\":2,\"deviceAcceptance\":false}");return
  }
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="contract173"{
   let samples=(replay["cases"] as! [[String:Any]]).map{s -> [String:Any] in var s=s;s["additionalAccounts"]=s["signingAccounts"];return s}
   for s in samples{try creationCheck(s);if s["kind"] as? String=="create"{try explicitAmmFeeReview(s)}}
   print("{\"platform\":\"swift-macos\",\"checks\":\(custodyChecks),\"cases\":\(samples.count),\"status\":\"PASS\",\"deviceAcceptance\":false}");return
  }
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="prepared"{
   let samples=replay["cases"] as! [[String:Any]];try preparedCheck(samples)
   let before=custodyChecks;try hostCheck(samples[0]);try hostCheck(samples.first{$0["name"] as? String=="amm-controller-plain-add"}!);let hostChecks=custodyChecks-before
   print("{\"platform\":\"swift-macos\",\"checks\":\(custodyChecks),\"hostChecks\":\(hostChecks),\"status\":\"PASS\",\"deviceAcceptance\":false}");return
  }
  if CommandLine.arguments.count>2 && ["creation","mint","amm","pool-dependent"].contains(CommandLine.arguments[2]){
   let samples=replay["cases"] as! [[String:Any]]
   for s in samples{try creationCheck(s)}
   if CommandLine.arguments[2]=="amm"{let fees=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any];try ammFeeReview(samples[0],fees["presets"] as! [[String:Any]])}
   let before=custodyChecks;try hostCheck(samples[1]);try hostCheck(samples[CommandLine.arguments[2]=="creation" ? 4:0]);let hostChecks=custodyChecks-before
   print("{\"platform\":\"swift-macos\",\"checks\":\(custodyChecks),\"hostChecks\":\(hostChecks),\"status\":\"PASS\",\"deviceAcceptance\":false}");return
  }
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="staged"{
   let samples=replay["cases"] as! [[String:Any]]
   for s in samples{try stagedCheck(s)}
   let before=custodyChecks;try hostCheck(samples[0]);let hostChecks=custodyChecks-before
   print("{\"platform\":\"swift-macos\",\"checks\":\(custodyChecks),\"hostChecks\":\(hostChecks),\"status\":\"PASS\",\"deviceAcceptance\":false}");return
  }
  // Both hosts use the same frozen vectors, not host-specific new fixtures.
  let controllerMode=CommandLine.arguments.count>2 && ["controller","controller-extended"].contains(CommandLine.arguments[2])
  let nativeMode=CommandLine.arguments.count>2 && ["native","controller","controller-extended","typed"].contains(CommandLine.arguments[2])
  let samples=(replay["cases"] as! [[String:Any]]).filter{nativeMode || ($0["name"] as! String).hasPrefix("android-")}
  if controllerMode{try controllerNegativeCheck(samples[0])}
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="typed"{try typedNegativeCheck(samples[0],replay["invalid"] as! [[String:Any]])}
  for sample in samples{
   if controllerMode && (map(sample["audit"])["stages"] as! [[String:Any]]).count>1{try creationCheck(sample);continue}
   let h=try CustodyHarness(sample);try h.grant();try h.begin();try h.consent();h.ui.choose("op")
   if controllerMode{
    let controller=h.accounts.additional[0],description=h.ui.reviews["op"]!.description
    yes(h.ui.reviews["grant"]!.description.contains(controller.address))
    yes(description.contains("Asset/fee account: \(h.account.address)") && description.contains("Pool controller: \(controller.address) (pool-controller)"))
   }
   let intent=h.request["intent"] as? [String:Any] ?? [:],profile=intent["type"] as? String ?? ""
   if profile.hasPrefix("tbc-lop-"){
    let text=h.ui.reviews["op"]!.description
    yes(text.contains(h.account.address) && text.contains("no broadcast"))
    if profile=="tbc-lop-create"{
     let o=map(intent["order"])
     for f in ["side","market","saleVolume","unitPrice","feeRate","feeRecipient"]{yes(text.contains(o[f] as! String))}
     for a in [map(o["assetA"]),o["assetB"].map{map($0)}].compactMap({$0}){yes(text.contains(a["contractId"] as! String) && text.contains(a["standard"] as! String))}
     yes(text.contains("1000000") && text.contains("partially fill") && text.contains("Only the owner"))
     if o["side"] as! String != "sell" || o["market"] as! String != "native-token"{yes(text.contains("300 order atomic") && text.contains("500 per token holding"))}
    }else{
     for p in intent["targetOutpoints"] as! [[String:Any]]{yes(text.contains("\(p["txid"] as! String):\(p["vout"]!)"))}
     yes(text.contains("No other orders are swept") && text.contains("paired asset availability"))
     yes(text.contains(profile=="tbc-lop-cancel" ? "same owner":"cannot be overridden"))
    }
   }
   if ["tbc-htlc-lock","tbc-htlc-claim","tbc-htlc-refund"].contains(profile){
    let text=h.ui.reviews["op"]!.description
    yes(text.contains(h.account.address) && text.contains("no broadcast"))
    if let standard=intent["assetStandard"] as? String{yes(text.contains(standard) && text.contains(intent["contractId"] as! String))}
    if profile=="tbc-htlc-lock"{
     for field in ["amount","to","hashlock","lockTime"]{yes(text.contains(intent[field] as! String))}
     let height=UInt64(intent["lockTime"] as! String)!<500000000
     yes(text.contains(height ? "block height (inclusive)":"chain median time (strictly greater, not local time)"))
     yes(text.contains("remains possible after this threshold"))
    }else{
     let points=(intent["assetStandard"] != nil ? intent["targetOutpoints"]:map(h.request["constraints"])["inputOutpoints"]) as! [[String:Any]]
     for p in points{yes(text.contains("\(p["txid"] as! String):\(p["vout"]!)"))}
     if intent["assetStandard"] != nil{yes(text.contains("paired native escrow") && text.contains("Full balance"))}
     yes(text.contains("No other deposits are swept"))
     if profile=="tbc-htlc-claim"{
      yes(text.contains("before broadcast") && text.contains("reveals the preimage") && !text.contains(intent["preimage"] as! String))
     }else{yes(text.contains("sender role") && text.contains("local time is not authority"))}
    }
   }
   if ["tbc-timelock-lock","tbc-timelock-unlock"].contains(profile){
    let text=h.ui.reviews["op"]!.description
    yes(text.contains(h.account.address) && text.contains("no broadcast"))
    if profile=="tbc-timelock-lock"{
     yes(text.contains(intent["amount"] as! String) && text.contains(intent["lockTime"] as! String) && text.contains("not a timestamp"))
    }else{
     for p in map(h.request["constraints"])["inputOutpoints"] as! [[String:Any]]{yes(text.contains("\(p["txid"] as! String):\(p["vout"]!)"))}
     yes(text.contains("No other deposits are swept") && text.contains("maturity"))
    }
   }
   if profile.hasPrefix("amm.") || profile.hasPrefix("tbc20Lp."){
    let description=h.ui.reviews["op"]!.description
    yes(description.contains(intent["poolContractId"] as! String) && description.contains("no broadcast"))
    for field in ["amount","lpAmount","minimumOutput","minimumLpAmount","minimumTbcAmount","minimumFtAmount","initialFtAmount","maximumFtAmount","maximumTbcAmount","lockTime","to","receiver"]{
     if let value=intent[field] as? String{yes(description.contains(value))}
    }
    if profile=="amm.mergeToken"{yes(description.contains("up to four") && description.contains("tokens stay in this pool"))}
    if profile=="tbc20Lp.burn"{yes(description.contains("Permanently destroy") && description.contains("no TBC or FT reserves are returned") && description.contains(h.account.address))}
    if ["tbc20Lp.merge","tbc20Lp.lock","tbc20Lp.unlock"].contains(profile){yes(description.contains("maturity") && description.contains(h.account.address))}
   }
   if profile.hasPrefix("tbc.pool."){
    let description=h.ui.reviews["op"]!.description
    yes(description.contains("Existing Pool2") && description.contains(intent["poolContractId"] as! String))
    for field in ["tbcAmount","ftAmount","lpAmount","minimumFtAmount","minimumTbcAmount","minimumLpAmount","receiver"]{
     if let value=intent[field] as? String{yes(description.contains(value))}
    }
    yes(description.contains(map(h.request["constraints"])["expiresAt"] as! String))
    yes(description.contains("authenticated Pool fees") && description.contains("no broadcast"))
    if profile=="tbc.pool.liquidity.add"{yes(description.contains("proportional pooled FT"))}
    if profile=="tbc.pool.ft.merge"{yes(description.contains("up to four") && description.contains("tokens stay in this pool"))}
    if profile=="tbc.pool.ftlp.merge"{yes(description.contains("up to five mature") && description.contains(h.account.address))}
    if profile=="tbc.pool.ftlp.burn"{yes(description.contains("Permanently destroy") && description.contains("no TBC or FT reserves are returned") && description.contains(h.account.address))}
   }
   if ["tbc20-lp-transfer","tbc20-lp-merge","tbc20-lp-lock","tbc20-lp-unlock"].contains(profile){
    let description=h.ui.reviews["op"]!.description
    yes(description.contains(intent["poolContractId"] as! String) && description.contains("maturity") && description.contains("no broadcast"))
    for field in ["amount","to","lockTime"]{if let value=intent[field] as? String{yes(description.contains(value))}}
    if profile != "tbc20-lp-transfer"{yes(description.contains(h.account.address))}
    if profile == "tbc20-lp-lock"{yes(description.contains("block height"))}
   }
   if ["tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap"].contains(profile){
    let description=h.ui.reviews["op"]!.description
    yes(description.contains(intent["poolContractId"] as! String) && description.contains(h.account.address))
    for field in ["amount","lpAmount","minimumOutput","minimumLpAmount","minimumTbcAmount","minimumFtAmount","initialFtAmount","maximumFtAmount","maximumTbcAmount","lockTime"]{
     if let value=intent[field] as? String{yes(description.contains(value))}
    }
    yes(description.contains("authenticated Pool fees") && description.contains("no broadcast"))
   }
   rejects{_ = try h.material(badBinding:true)};let receipt=try h.material(),before=h.store.writes
   yes(h.ui.shown==2);rejects{try h.consent()}
   for t in h.tasks{
    var altered=t;altered["digest"]=String(repeating:"00",count:32)
    rejects{try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:altered){_ in fatalError("UNREACHABLE")}}
    var value:Result<[String:Any],Error>?
    try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:t){value=$0}
    yes(try PermissionJSON.canonical(value!.get())==PermissionJSON.canonical(h.signatures.first{$0["taskId"] as? String==t["taskId"] as? String}!))
    rejects{try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:t){_ in fatalError("UNREACHABLE")}}
   }
   try h.custody.close(owner:"view",scope:h.scope,id:"op");yes(h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
   rejects{try h.custody.check(owner:"view",scope:h.scope,id:"op")};yes(h.store.loads==1 && h.store.writes==before && h.signer.used==h.tasks.count)
   try h.custody.disconnect(owner:"view",scope:h.scope,id:"disconnect");yes(!h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
  }
  let sample=samples.last!
  do{
   let h=try CustodyHarness(sample);try h.grant();try h.custody.cancel(owner:"view",scope:h.scope,id:"late-begin");rejects{try h.begin("late-begin")}
   try h.begin();var consent:Result<Bool,Error>?;try h.consent{consent=$0};let late=h.ui.pending["op"]!
   try h.custody.cancel(owner:"view",scope:h.scope,id:"op");yes(isFailure(consent) && h.ui.pending.isEmpty);late(true)
   rejects{_ = try h.material()};yes(h.signer.calls==0)
  }
  do{
   let h=try CustodyHarness(sample),receipt=try h.ready();h.signer.hold=true;var value:Result<[String:Any],Error>?
   try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:h.tasks[0]){value=$0};yes(value==nil)
   h.accounts.revision+=1;h.custody.accountChanged();yes(isFailure(value));h.signer.release!()
   yes(h.signer.used==0 && !h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
  }
  do{
   let h=try CustodyHarness(sample),receipt=try h.ready();h.signer.wrongLength=true;var value:Result<[String:Any],Error>?
   try h.custody.sign(owner:"view",scope:h.scope,id:"op",receipt:receipt,task:h.tasks[0]){value=$0};yes(isFailure(value))
   try h.custody.close(owner:"view",scope:h.scope,id:"op");yes(!h.custody.mayDeliverSignature(owner:"view",scope:h.scope,id:"op"))
  }
  do{
   let h=try CustodyHarness(sample);try h.grant();try h.begin();var cancelled:Result<Bool,Error>?;try h.consent{cancelled=$0}
   var other=h.scope;other["webViewInstanceId"]="other";other["sessionId"]="other-session";other["navigationId"]="other-nav"
   h.documents.current["other"]=other;try h.custody.navigation(owner:"other",scope:other);try h.begin("other-op",owner:"other",scope:other)
   h.custody.invalidate(owner:"view");try h.custody.check(owner:"other",scope:other,id:"other-op")
   yes(h.accounts.unlocked && h.signer.calls==0 && isFailure(cancelled));rejects{try h.custody.check(owner:"view",scope:h.scope,id:"op")}
  }
  let beforeHost=custodyChecks;try hostCheck(sample)
  if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="controller-extended"{try hostCheck(samples.last!)}
  let hostChecks=custodyChecks-beforeHost
  print("{\"platform\":\"swift-macos\",\"checks\":\(custodyChecks),\"hostChecks\":\(hostChecks),\"status\":\"PASS\",\"recordedSignatureReplay\":true,\"newSignatures\":0,\"deviceAcceptance\":false}")
 }
 static func isFailure<T>(_ value:Result<T,Error>?)->Bool{if case .failure?=value{return true};return false}
}
