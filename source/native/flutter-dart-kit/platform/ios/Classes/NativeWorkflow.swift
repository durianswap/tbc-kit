import Foundation
import CryptoKit

// Data/binding strategy for the existing NativeCustody owner. No receipt,
// permission, Vault, signing, HTTP, journal or default approval lives here.
// Binding alone is NOT permission to sign: the owner must also run the existing
// family verifier, own task consumption and validate completion/delivery.
enum NativeWorkflow {
 static let methods:Set<String>=["tbc_signWorkflow","tbc_signPreparedWorkflow","tbc_sendWorkflow","tbc_sendPreparedWorkflow"]
 struct Binding {
  let request:[String:Any],plan:[String:Any],binding:[String:Any]
  let children:[[String:Any]],requiredPermissions:Set<String>
 }
 private static func need(_ v:Bool)throws{if !v{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")}}
 private static func map(_ v:Any?)throws->[String:Any]{guard let m=v as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")};return m}
 private static func rows(_ v:Any?)throws->[[String:Any]]{guard let a=v as? [[String:Any]]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")};return a}
 private static func strings(_ v:Any?)throws->[String]{guard let a=v as? [String]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")};return a}
 private static func text(_ v:Any?)throws->String{guard let s=v as? String else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")};return s}
 private static func equal(_ a:Any?,_ b:Any?)throws->Bool{try PermissionJSON.canonical(a)==PermissionJSON.canonical(b)}
 private static func hash(_ v:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
 private static func owned(_ v:[String:Any])throws->[String:Any]{try map(JSONSerialization.jsonObject(with:Data(PermissionJSON.canonical(v).utf8)))}
 private static func shape(_ v:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])throws{
  try need(required.isSubset(of:Set(v.keys)) && Set(v.keys).isSubset(of:required.union(optional)) && !v.values.contains{$0 is NSNull})
 }
 private static func amount(_ v:Any?)throws->String{let s=try text(v);try need(s.range(of:"^(0|[1-9][0-9]*)$",options:.regularExpression) != nil);return s}
 private static func le(_ a:String,_ b:String)->Bool{a.count != b.count ? a.count<b.count:a<=b}
 private static func add(_ a:String,_ b:String)->String{
  let x=Array(a.utf8.reversed()),y=Array(b.utf8.reversed());var out=[UInt8](),carry=0
  for i in 0..<max(x.count,y.count){let n=(i<x.count ? Int(x[i])-48:0)+(i<y.count ? Int(y[i])-48:0)+carry;out.append(UInt8(n%10+48));carry=n/10}
  if carry>0{out.append(UInt8(carry+48))};return String(bytes:out.reversed(),encoding:.utf8)!
 }
 private static func date(_ v:Any?)throws->Date{
  let s=try text(v),f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  if let d=f.date(from:s){return d};f.formatOptions=[.withInternetDateTime]
  guard let d=f.date(from:s)else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")};return d
 }
 private static func transaction(_ s:[String:Any])->Bool{["transaction","preparedTransaction"].contains(s["kind"] as? String ?? "")}
 // The worker owns exact JS-compatible message serialization. Native custody
 // independently proves unchanged template semantics and the owned source,
 // then hashes the actual bytes being signed; it does not add a JS formatter.
 static func resolve(_ d:[String:Any],claimed:[String:Any],completed:[String:[String:Any]],account:NativeAccount,origin:String,walletProtocol:NativeWalletProtocol = .standard)throws->(envelope:[String:Any],task:[String:Any]){
  let source=try map(d["source"]),sourceId=try text(source["stepId"]),output=try text(source["output"])
  guard let result=completed[sourceId] else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_DEPENDENCY")}
  let txs=try rows(result["transactions"]),value:Any
  if output=="transactionIds"{value=try txs.map{try text($0["txid"])}}
  else if output=="primaryTransactionId"{let primary=txs.filter{$0["role"] as? String=="primary"};try need(primary.count==1);value=try text(primary[0]["txid"])}
  else{try need(["artifacts.collectionId","artifacts.contractId","artifacts.poolContractId"].contains(output));value=try text(map(result["artifacts"])[String(output.dropFirst(10))])}
  let ids=try (value as? [String]) ?? [text(value)]
  for id in ids{try need(id.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil)}
  let template=try map(d["envelopeTemplate"]),envelope=try map(claimed["resolvedEnvelope"]),purpose=try text(d["purpose"]),target=try text(d["target"])
  try need(target.hasPrefix("/message/") && ["message","typedData"].contains(purpose));let field=String(target.dropFirst(9))
  var expected=template,message=try map(template["message"])
  if purpose=="message"{
   let actual=try map(envelope["message"]);try shape(actual,["data","encoding"]);try need(actual["encoding"] as? String=="utf8" && message["encoding"] as? String=="utf8")
   guard let ids=value as? [String]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_BINDING")}
   try NativeWorkflowJSON.verify(template:text(message["data"]),field:field,ids:ids,resolved:text(actual["data"]))
   message["data"]=actual["data"]
  }else{try need(equal(message[field],["$tbcBinding":"unresolved"]));message[field]=value}
  expected["message"]=message;try need(equal(envelope,expected))
  let digest=try NativeSigningEnvelope.digest(envelope,purpose:purpose,walletProtocol:walletProtocol)
  let task:[String:Any]=["taskId":d["taskId"]!,"purpose":purpose,"algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":digest,"signatureEncoding":"compact65-recoverable","origin":origin,"accountId":account.accountId,"publicKey":account.publicKey]
  let resolved:[String:Any]=["planTaskId":d["taskId"]!,"source":source,"sourceValue":value,"targetStepId":d["targetStepId"]!,"target":target,"targetType":d["targetType"]!,"purpose":purpose,"resolvedEnvelope":envelope,"canonical":try PermissionJSON.canonical(envelope),"digest":digest,"concreteTask":task]
  try need(equal(claimed,resolved));return (try owned(envelope),try owned(task))
 }
 // Same header commitment as the pinned Rust Transaction::tbc_txid and the
 // Dart transaction reader. TBC txid is NOT SHA256d(serialized Bitcoin bytes).
 private static func transactionId(_ bytes:[UInt8])throws->String{
  var offset=0
  func take(_ n:Int)throws->[UInt8]{try need(n>=0 && n<=bytes.count-offset);let v=Array(bytes[offset..<offset+n]);offset+=n;return v}
  func uint(_ n:Int)throws->UInt64{let b=try take(n);return b.enumerated().reduce(0){$0 | UInt64($1.element)<<($1.offset*8)}}
  func size()throws->Int{
   let tag=try uint(1);if tag<253{return Int(tag)}
   let n=tag==253 ? 2:tag==254 ? 4:8,value=try uint(n),minimum:UInt64=n==2 ? 253:n==4 ? 65536:4294967296
   try need(value>=minimum && value<=UInt64(bytes.count));return Int(value)
  }
  func script()throws->[UInt8]{let n=try size();try need(n<=10000);return try take(n)}
  func sha(_ data:[UInt8])->[UInt8]{Array(SHA256.hash(data:Data(data)))}
  func little(_ n:Int)->[UInt8]{(0..<4).map{UInt8((n>>($0*8))&255)}}
  let version=try take(4);try need(version==[10,0,0,0])
  let ni=try size();try need((1...10000).contains(ni));var input=[UInt8](),unlocks=[UInt8](),output=[UInt8]()
  for _ in 0..<ni{input+=try take(36);unlocks+=sha(try script());input+=try take(4)}
  let no=try size();try need((1...10000).contains(no))
  for _ in 0..<no{output+=try take(8);output+=sha(try script())}
  let lock=try take(4);try need(offset==bytes.count)
  let header=version+lock+little(ni)+little(no)+sha(input)+sha(unlocks)+sha(output)
  return sha(sha(header)).reversed().map{String(format:"%02x",$0)}.joined()
 }
 // The shared worker has already run Engine/Reviewed final validation. Bind
 // its result metadata and raw-derived IDs to the native-consumed child before
 // allowing those IDs to become a later workflow source. This is not a VM.
 static func completedBundle(_ result:[String:Any],account:NativeAccount,requestHash:String,approvalId:String,fee:String,transactions:[[String:Any]]?,reviewed:NativeReviewed.Bound?,limit:Int=32)throws->[[String:Any]]{
  try shape(result,["version","chainId","from","requestHash","approvalId","totalFee","transactions"],["artifacts","detachedSignatures"])
  try need(result["version"] as? String=="1.0" && result["chainId"] as? String==account.chainId && result["from"] as? String==account.address && result["requestHash"] as? String==requestHash && result["approvalId"] as? String==approvalId && result["totalFee"] as? String==fee)
  let values=try rows(result["transactions"]),count=reviewed?.transactionCount ?? transactions?.count ?? 0
  try need((1...limit).contains(count) && values.count==count)
  var seen=Set<String>()
  for (i,t) in values.enumerated(){
   try shape(t,["id","role","dependsOn","rawTransaction","txid"])
   let expected:[String:Any]
   if let reviewed{expected=["id":"tx-\(i+1)","role":reviewed.associated && i<count-1 ? "prerequisite":"primary","dependsOn":reviewed.associated && i>0 ? ["tx-\(i)"]:[String]() ]}
   else{expected=transactions![i]}
   for key in ["id","role","dependsOn"]{try need(equal(t[key],expected[key]))}
   let raw=try text(t["rawTransaction"]),id=try text(t["txid"]),bytes=Array(raw.utf8)
   try need(!bytes.isEmpty && bytes.count<=8*1024*1024 && bytes.count%2==0 && bytes.allSatisfy{(48...57).contains($0)||(97...102).contains($0)})
   let data=stride(from:0,to:bytes.count,by:2).map{UInt8(String(bytes:bytes[$0..<$0+2],encoding:.utf8)!,radix:16)!}
   let computed=try transactionId(data)
   try need(id==computed && seen.insert(id).inserted)
  }
  if reviewed==nil || reviewed!.associated{try need(result["detachedSignatures"]==nil)}
  if let reviewed,!reviewed.associated{try need((result["detachedSignatures"] as? [Any])?.count==count)}
  return values
 }
 // Only public approval fields are projected here. Callers must render their
 // existing family description, never canonicalize a whole request containing
 // an HTLC preimage or an associated unlocking template into the native UI.
 static func children(method:String,request:[String:Any])throws->[[String:Any]]{
  try need(methods.contains(method));try shape(request,["version","chainId","from","steps"],["clientRequestId","expiresAt","maxTotalFee","failureMode"])
  try need(request["version"] as? String=="1.0" && ["tbc:mainnet","tbc:testnet"].contains(request["chainId"] as? String ?? ""))
  let steps=try rows(request["steps"]);try need((1...5).contains(steps.count))
  var seen=Set<String>(),out=[[String:Any]]()
  for s in steps{
   let id=try text(s["id"]),kind=try text(s["kind"]),depends=try strings(s["dependsOn"])
   try need(id.range(of:"^[A-Za-z][A-Za-z0-9._-]{0,63}$",options:.regularExpression) != nil && !seen.contains(id) && Set(depends).count==depends.count && depends.allSatisfy{seen.contains($0)})
   var r:[String:Any]=["version":"1.0","chainId":request["chainId"]!,"from":request["from"]!];let childMethod:String
   if transaction(s){
    let prepared=["tbc_signPreparedWorkflow","tbc_sendPreparedWorkflow"].contains(method);try need(kind==(prepared ? "preparedTransaction":"transaction"))
    try shape(s,Set(["id","kind","dependsOn","intent"]+(prepared ? ["proposal"]:[])),["constraints","signingRoles"])
    r["intent"]=try map(s["intent"]);for k in ["constraints","signingRoles","proposal"]{if let v=s[k]{r[k]=v}}
    childMethod=prepared ? "tbc_signPreparedTransaction":"tbc_signTransaction"
   }else if kind=="reviewedTransaction"{
    try shape(s,["id","kind","dependsOn","request"]);r["request"]=try map(s["request"]);childMethod=NativeReviewed.method
   }else if kind=="message"{
    try shape(s,["id","kind","dependsOn","message"],["bindings"]);r["message"]=try map(s["message"]);childMethod="tbc_signMessage"
   }else if kind=="typedData"{
    try shape(s,["id","kind","dependsOn","data","bindings"]);r["data"]=try map(s["data"]);childMethod="tbc_signTypedData"
   }else if kind=="encrypt" || kind=="decrypt"{
    let field=kind=="encrypt" ? "message":"ciphertext"
    try shape(s,["id","kind","dependsOn","algorithm",field]);r["algorithm"]=s["algorithm"];r[field]=s[field];childMethod="tbc_"+kind
   }else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_PROFILE_NOT_INSTALLED")}
   seen.insert(id);out.append(["id":id,"kind":kind,"dependsOn":depends,"method":childMethod,"request":r])
  }
  return try out.map{try owned($0)}
 }
 // Envelopes are derived by the same native normalizer used by single calls;
 // there is no injected page/worker digest or normalizer. Reviews must be the
 // exact native consent records from the existing Reviewed verification path.
 static func bind(method:String,request:[String:Any],context:[String:Any],account:NativeAccount,
  accounts:[NativeAccount],plan:[String:Any],preview:[String:Any],binding:[String:Any],
  reviews:[String:[String:Any]],walletProtocol:NativeWalletProtocol = .standard,now:Date=Date())throws->Binding{
  let children=try self.children(method:method,request:request),steps=try rows(request["steps"])
  try need(request["chainId"] as? String==account.chainId && request["from"] as? String==account.address)
  let origin=try text(context["origin"]),session=try text(context["sessionId"])
  try need(!origin.isEmpty && !session.isEmpty && context["frame"] as? String=="top" && equal(context["origin"],context["topOrigin"]))
  let selected=[account]+accounts;try need(Set(selected.map{$0.accountId}).count==selected.count && Set(selected.map{$0.publicKey.dropFirst(2)}).count==selected.count)
  let identities=Dictionary(uniqueKeysWithValues:selected.map{($0.accountId,$0.identity)})
  try shape(plan,["payload","workflowPlanHash"]);try shape(binding,["payload","bindingHash"])
  let p=try map(plan["payload"]),expiry=try date(p["expiresAt"])
  try need(expiry>now && expiry<=now.addingTimeInterval(301))
  if let e=request["expiresAt"]{try need(expiry<=date(e))}
  let mode=try text(request["failureMode"] ?? "atomic");try need(["atomic","continue-independent"].contains(mode))
  let transactionPlans=try rows(p["transactionPlans"]),reviewTasks=try rows(p["reviewedTransactionTasks"])
  var expectedImmediate=[[String:Any]](),expectedDeferred=[[String:Any]](),expectedReviews=[[String:Any]](),cryptoTasks=[[String:Any]](),flows=[String:Any](),roles=[[String:Any]](),warnings=[String](),planWarnings=[String](),reviewWarnings=[String](),fee="0"
  func warn(_ values:Any?)throws{for w in try strings(values){if !warnings.contains(w){warnings.append(w)}}}
  var transactionIndex=0,reviewIndex=0,permissions:Set<String>=["tbc_signWorkflow"]
  if NativePrepared.sends(method){permissions.insert("tbc_sendTransaction")}
  for (index,s) in steps.enumerated(){
   let id=try text(s["id"]),child=children[index],childRequest=try map(child["request"]),kind=try text(s["kind"])
   permissions.insert(NativePrepared.permission(try text(child["method"])))
   if kind=="encrypt" || kind=="decrypt"{
    cryptoTasks.append(try NativeCrypto.task(childRequest,method:text(child["method"]),context:context,account:account,id:"crypto-"+id))
   }else if transaction(s){
    try need(transactionIndex<transactionPlans.count);let entry=transactionPlans[transactionIndex];transactionIndex+=1
    try shape(entry,["stepId","plan"]);try need(entry["stepId"] as? String==id)
    let plan=try map(entry["plan"]),body=try map(plan["payload"]),review=try map(body["preview"])
    try shape(plan,["payload","planHash"])
    try need(plan["planHash"] as? String==hash(body) && body["requestHash"] as? String==hash(NativePrepared.request(childRequest,try text(child["method"]))) && body["accountId"] as? String==account.accountId && body["chainId"] as? String==account.chainId && expiry<=date(body["expiresAt"]))
    if kind=="preparedTransaction"{_ = try NativePrepared.consent(childRequest,now:now)}
    var stepFee="0";for tx in try rows(body["transactions"]){stepFee=add(stepFee,try amount(tx["fee"]))}
    try need(equal(review["totalFee"],stepFee));fee=add(fee,stepFee)
    if let cap=(childRequest["constraints"] as? [String:Any])?["maxFee"]{try need(le(stepFee,amount(cap)))}
    let requested=(s["signingRoles"] as? [[String:Any]]) ?? [];var expectedRoles=[[String:Any]]()
    for r in requested{try shape(r,["role","accountId"]);try need(r["role"] as? String=="pool-controller");guard let a=identities[try text(r["accountId"])]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_ACCOUNT")};expectedRoles.append(["role":"pool-controller","account":a])}
    try need(expectedRoles.count<=1 && equal(review["signingRoles"] ?? [],expectedRoles))
    for r in expectedRoles{roles.append(r.merging(["stepId":id]){_,b in b})}
    let allowed=[account.identity]+(try expectedRoles.map{try map($0["account"])})
    for task in try rows(body["signingTasks"]){
     try need(allowed.contains{a in a["accountId"] as? String==task["accountId"] as? String && a["publicKey"] as? String==task["publicKey"] as? String})
     expectedImmediate.append(["stepId":id,"task":task])
    }
    flows[id]=review["assetFlows"];planWarnings.append(contentsOf:try strings(review["warnings"]))
   }else if kind=="reviewedTransaction"{
    try need(reviewIndex<reviewTasks.count);reviewIndex+=1
    guard let review=reviews[id]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_REVIEW_REQUIRED")}
    let consent=try NativeReviewed.consent(request:childRequest,review:review,now:now),rp=try map(consent["payload"])
    try need(expiry<=date(rp["expiresAt"]))
    expectedReviews.append(["taskId":"review-\(id)","purpose":"reviewedTransaction","contextHash":try hash(context),"requestHash":try hash(s["request"]),"reviewHash":consent["reviewHash"]!,"policyMaterial":rp["policyMaterial"]!,"chainId":account.chainId,"accountId":account.accountId,"publicKey":account.publicKey,"request":s["request"]!])
    fee=add(fee,try amount(rp["totalFee"]));flows[id]=rp["preview"];reviewWarnings.append(contentsOf:try strings(map(rp["preview"])["warnings"]))
   }
  }
  try need(transactionIndex==transactionPlans.count && reviewIndex==reviewTasks.count && Set(reviews.keys)==Set(steps.filter{$0["kind"] as? String=="reviewedTransaction"}.map{$0["id"] as! String}))
  // Frozen Core groups immediate message and typed tasks by kind, not by the
  // graph's execution order. Preserve that commitment; execution uses stepOrder.
  for kind in ["message","typedData"]{for s in steps where s["kind"] as? String==kind{
   let id=try text(s["id"]),e=try NativeSigningEnvelope.workflow(s,chain:account.chainId,from:account.address,origin:origin),bindings=try rows(s["bindings"] ?? [])
   try need(e["version"] as? String=="1.0" && e["type"] as? String==(kind=="message" ? "tbc.message":"tbc.typedData"))
   if kind=="message"{try need(equal(e["message"],s["message"]))}
   else{let d=try map(s["data"]);for k in ["domain","message","primaryType"]{try need(equal(e[k],d[k]))}}
   try need(bindings.count<=1)
   if bindings.isEmpty{
    expectedImmediate.append(["stepId":id,"envelope":e,"task":["taskId":"sign-\(id)","purpose":kind,"algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":try NativeSigningEnvelope.digest(e,purpose:kind,walletProtocol:walletProtocol),"signatureEncoding":"compact65-recoverable","origin":context["origin"]!,"accountId":account.accountId,"publicKey":account.publicKey]])
   }else{
    let b=bindings[0],source=try map(b["source"]),target=try text(b["target"])
    try shape(b,["source","target"]);try shape(source,["stepId","output"])
    guard let parent=steps.first(where:{$0["id"] as? String==source["stepId"] as? String})else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_SOURCE")}
    try need(strings(s["dependsOn"]).contains(text(source["stepId"])) && (transaction(parent) || (kind=="message" && parent["kind"] as? String=="reviewedTransaction")))
    let output=try text(source["output"]),field=kind=="message" ? target:String(target.dropFirst(9)),targetType:String
    try need(field.range(of:"^[A-Za-z][A-Za-z0-9_]{0,63}$",options:.regularExpression) != nil && !["__proto__","constructor","prototype"].contains(field))
    if kind=="message"{
     let message=try map(e["message"]);try need(output=="transactionIds" && message["encoding"] as? String=="utf8")
     try NativeWorkflowJSON.template(text(message["data"]),field:field);targetType="json-string-array"
    }else{
     try need(target.hasPrefix("/message/") && ["transactionIds","primaryTransactionId","artifacts.collectionId","artifacts.contractId","artifacts.poolContractId"].contains(output))
     let fields=try rows(map(e["types"])[text(e["primaryType"])]),matches=fields.filter{$0["name"] as? String==field}
     try need(matches.count==1);targetType=try text(matches[0]["type"])
     try need(targetType==(output=="transactionIds" ? "bytes32[]":"bytes32") && equal(map(e["message"])[field],["$tbcBinding":"unresolved"]))
    }
    expectedDeferred.append(["taskId":"sign-\(id)","source":source,"targetStepId":id,"target":kind=="message" ? "/message/\(field)":target,"targetType":targetType,"purpose":kind,"publicKey":account.publicKey,"envelopeTemplate":e])
   }
  }}
  try warn(planWarnings+reviewWarnings)
  if !expectedDeferred.isEmpty && !warnings.contains("DYNAMIC_BINDING"){warnings.append("DYNAMIC_BINDING")}
  let cap=try amount(request["maxTotalFee"] ?? fee);try need(le(fee,cap))
  let previewSteps=try steps.map{s->[String:Any] in
   let id=try text(s["id"]),kind=try text(s["kind"]);var row:[String:Any]=["id":id,"kind":kind,"dependsOn":s["dependsOn"]!]
   if transaction(s){row["assetFlows"]=flows[id]}else if kind=="reviewedTransaction"{row["reviewedTransactionPreview"]=flows[id]}else if kind=="encrypt" || kind=="decrypt"{row["algorithm"]=s["algorithm"];let field=kind=="encrypt" ? "message":"ciphertext";row[field]=s[field]}else{row[kind=="message" ? "message":"typedData"]=s[kind=="message" ? "message":"data"]};return row
  }
  let previewBindings=try expectedDeferred.map{d->[String:Any] in let s=try map(d["source"]);return ["sourceStepId":s["stepId"]!,"sourceOutput":s["output"]!,"target":d["target"]!,"targetType":d["targetType"]!]}
  var expectedPreview:[String:Any]=["operationKind":"workflow","failureMode":mode,"steps":previewSteps,"bindings":previewBindings,"totalFee":fee,"warnings":warnings]
  if !roles.isEmpty{expectedPreview["signingRoles"]=roles}
  let expected:[String:Any]=["version":"1.0","requestHash":try hash(request),"chainId":account.chainId,"accountId":account.accountId,"expiresAt":p["expiresAt"]!,"failureMode":mode,"stepOrder":steps.map{$0["id"]!},"transactionPlans":transactionPlans,"immediateSigningTasks":expectedImmediate,"deferredSigningTasks":expectedDeferred,"legacyBitcoinMessageStepIds":walletProtocol == .legacy ? steps.filter{$0["kind"] as? String=="message"}.map{$0["id"]!}:[],"cryptoTasks":cryptoTasks,"reviewedTransactionTasks":expectedReviews,"maxTotalFee":cap,"totalFee":fee,"preview":expectedPreview]
  try need(equal(p,expected) && plan["workflowPlanHash"] as? String==hash(expected) && equal(preview,expectedPreview))
  let expectedBinding:[String:Any]=["version":"1.0","method":method,"operationKind":"workflow","contextHash":try hash(context),"origin":context["origin"]!,"sessionId":context["sessionId"]!,"chainId":account.chainId,"accountId":account.accountId,"requestHash":try hash(request),"operationHash":plan["workflowPlanHash"]!,"expiresAt":p["expiresAt"]!]
  try need(equal(binding["payload"],expectedBinding) && binding["bindingHash"] as? String==hash(expectedBinding))
  return Binding(request:try owned(request),plan:try owned(plan),binding:try owned(binding),children:children,requiredPermissions:permissions)
 }
}

// A narrow semantic verifier, never a JSON wire serializer. The authoritative
// Dart formatter preserves JSON.parse/stringify bytes (including key order and
// shortest floats). Native checks that only the approved top-level target has
// changed. UTF-16 values preserve escaped lone surrogates without Foundation's
// lossy conversion; numbers follow JS binary64/overflow-to-null semantics.
enum NativeWorkflowJSON {
 private indirect enum Value:Equatable{case null,bool(Bool),number(Double),string([UInt16]),array([Value]),object([[UInt16]:Value])}
 private static func need(_ b:Bool)throws{if !b{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")}}
 private struct Parser{
  let s:[UInt16];var i=0,nodes=0
  init(_ text:String)throws{try need(text.utf8.count<=65536);s=Array(text.utf16)}
  mutating func ws(){while i<s.count && [9,10,13,32].contains(s[i]){i+=1}}
  mutating func take(_ c:UInt16)->Bool{if i<s.count && s[i]==c{i+=1;return true};return false}
  mutating func string()throws->[UInt16]{
   try need(take(34));var out=[UInt16]()
   while i<s.count{let c=s[i];i+=1;if c==34{return out};try need(c>=32)
    if c != 92{out.append(c);continue};try need(i<s.count);let e=s[i];i+=1
    if e==117{try need(i+4<=s.count);var n:UInt16=0;for c in s[i..<i+4]{let d:Int;if (48...57).contains(c){d=Int(c)-48}else if (65...70).contains(c){d=Int(c)-55}else if (97...102).contains(c){d=Int(c)-87}else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")};n=n*16+UInt16(d)};i+=4;out.append(n)}
    else{guard let c:[UInt16]=[34:[34],92:[92],47:[47],98:[8],102:[12],110:[10],114:[13],116:[9]][e]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")};out+=c}
   };throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")
  }
  mutating func value(_ depth:Int=0)throws->Value{
   ws();nodes+=1;try need(depth<=128 && nodes<=65536 && i<s.count)
   if s[i]==34{return .string(try string())}
   if take(123){var object=[[UInt16]:Value]();ws();if take(125){return .object(object)}
    while true{ws();let k=try string();ws();try need(take(58));object[k]=try value(depth+1);ws();if take(125){return .object(object)};try need(take(44))}}
   if take(91){var array=[Value]();ws();if take(93){return .array(array)}
    while true{array.append(try value(depth+1));ws();if take(93){return .array(array)};try need(take(44))}}
   for (word,v) in [("null",Value.null),("true",Value.bool(true)),("false",Value.bool(false))]{let a=Array(word.utf16);if i+a.count<=s.count && Array(s[i..<i+a.count])==a{i+=a.count;return v}}
   let start=i;_ = take(45)
   if !take(48){try need(i<s.count && (49...57).contains(s[i]));while i<s.count && (48...57).contains(s[i]){i+=1}}
   if take(46){let before=i;while i<s.count && (48...57).contains(s[i]){i+=1};try need(i>before)}
   if take(101) || take(69){if !take(43){_ = take(45)};let before=i;while i<s.count && (48...57).contains(s[i]){i+=1};try need(i>before)}
   guard let number=Double(String(decoding:s[start..<i],as:UTF16.self))else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")};return number.isFinite ? .number(number):.null
  }
  mutating func root()throws->[[UInt16]:Value]{let v=try value();ws();try need(i==s.count);guard case let .object(o)=v else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")};return o}
 }
 private static func object(_ text:String,field:String)throws->[[UInt16]:Value]{
  try need(field.range(of:"^[A-Za-z][A-Za-z0-9_]{0,63}$",options:.regularExpression) != nil)
  let denied=["__proto__","constructor","prototype"].map{Array($0.utf16)},key=Array(field.utf16);var parser=try Parser(text);let value=try parser.root()
  try need(!denied.contains(key) && denied.allSatisfy{value[$0]==nil})
  if let existing=value[key]{guard case .array=existing else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_JSON")}};return value
 }
 static func template(_ text:String,field:String)throws{_ = try object(text,field:field)}
 static func verify(template:String,field:String,ids:[String],resolved:String)throws{
  var expected=try object(template,field:field);expected[Array(field.utf16)] = .array(ids.map{.string(Array($0.utf16))})
  try need(object(resolved,field:field)==expected)
 }
}
