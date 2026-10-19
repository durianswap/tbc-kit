import Foundation
import CoreFoundation
import CryptoKit

// Private Flutter channel and emission owner, never registered on a page.
// The same instance receives native navigation, wallet changes and delivery.
@MainActor final class NativeWalletHost {
 var walletProtocol:NativeWalletProtocol{custody.walletProtocol}
 private struct Stamp:Equatable {
  let scope:[String:String],revision:Int,accountRevision:Int64,account:NativeAccount,unlocked:Bool
 }
 private struct Committed {let stamp:Stamp,method:String,resultHash:String;var eventsHash:String?=nil;var current:(()throws->Void)?=nil}
 private struct Frame {let stamp:Stamp,method:String,operation:String,resultHash:String,error:Bool}
 private let custody:NativeCustody,authorityChanged:(String,[String:String],NativeWalletSnapshot)->Void
 private var committed=[String:[String:Committed]](),frames=[String:[String:Frame]](),documents=[String:[String:String]]()
 typealias BroadcastHandler=(String,[String:Any],@escaping @MainActor ([String:Any])->Void)->Void
 private var broadcastHandler:BroadcastHandler?
 private var networkEvents:((String,[String:String])throws->[[String:Any]])?
 func installNetworkEvents(_ read:@escaping(String,[String:String])throws->[[String:Any]])throws{try need(networkEvents==nil);networkEvents=read}
 // Native registration only. No private-channel command can inject a result
 // or a validation closure. Signing/crypto/broadcast results are excluded.
 func rememberNetworkResult(owner:String,scope:[String:String],operation:String,method:String,result:Any?,events:[[String:Any]],current:@escaping()throws->Void)throws{
  try need(["tbc_switchChain","wallet_getPermissions","tbc_getCapabilities","tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect"].contains(method))
  try current();let s=try custody.snapshot(owner:owner,scope:scope)
  try control(owner,scope,operation,method,result,s)
  committed[owner]![operation]!.eventsHash=try hash(events);committed[owner]![operation]!.current=current
 }
 func networkCapabilities(owner:String,scope:[String:String])throws->[String:Any]{
  var result=capabilities(try custody.snapshot(owner:owner,scope:scope)),methods=result["methods"] as! [String:String]
  methods["tbc_switchChain"]="1.0";result["methods"]=methods;return result
 }
 func installBroadcast(_ handler:@escaping BroadcastHandler)throws{try need(broadcastHandler==nil);try custody.registerBroadcast();broadcastHandler=handler}
 init(custody:NativeCustody,authorityChanged:@escaping(String,[String:String],NativeWalletSnapshot)->Void){self.custody=custody;self.authorityChanged=authorityChanged}
 func navigation(owner:String,scope:[String:String])throws{try custody.navigation(owner:owner,scope:scope);forget(owner);documents[owner]=scope}
 func invalidate(owner:String){custody.invalidate(owner:owner);forget(owner);documents.removeValue(forKey:owner)}
 func fenceDocument(owner:String){custody.fenceDocument(owner:owner);forget(owner)}
 func accountChanged(){custody.accountChanged();committed.removeAll();frames.removeAll();notifyChanges(nil)}
 private func forget(_ owner:String){committed.removeValue(forKey:owner);frames.removeValue(forKey:owner)}
 private func notifyChanges(_ origin:String?,exceptOwner:String?=nil){
  for (owner,scope) in documents where owner != exceptOwner && (origin==nil || scope["origin"]==origin){
   if let s=try? custody.snapshot(owner:owner,scope:scope){authorityChanged(owner,scope,s)}
  }
 }
 private func need(_ ok:Bool)throws{if !ok{throw NativeCustodyFailure(code:"NATIVE_DENIED")}}
 private func map(_ value:Any?)throws->[String:Any]{guard let m=value as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return m}
 private func string(_ value:Any?)throws->String{guard let s=value as? String else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return s}
 private func scope(_ value:Any?)throws->[String:String]{guard let s=value as? [String:String]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return s}
 private func optionalMap(_ value:Any?)throws->[String:Any]?{if value==nil || value is NSNull{return nil};return try map(value)}
 private func stamp(_ scope:[String:String],_ s:NativeWalletSnapshot)->Stamp{Stamp(scope:scope,revision:s.revision,accountRevision:s.accountRevision,account:s.account,unlocked:s.unlocked)}
 static func snapshotWire(_ s:NativeWalletSnapshot)->[String:Any]{["account":s.account.identity,"revision":s.revision,"accountRevision":s.accountRevision,"unlocked":s.unlocked,"permissions":s.permissions,"connectedAccounts":s.connectedAccounts.map{$0.identity},"optionalMethods":s.optionalMethods]}
 private func has(_ s:NativeWalletSnapshot,_ name:String)->Bool{s.unlocked && s.permissions.contains{$0["parentCapability"] as? String==name}}
 private func addresses(_ s:NativeWalletSnapshot)->[String]{has(s,"tbc_accounts") ? s.connectedAccounts.map{$0.address}:[]}
 private func publicPermissions(_ s:NativeWalletSnapshot)->[[String:Any]]{s.unlocked ? s.permissions:[]}
 private func events(_ s:NativeWalletSnapshot)->[[String:Any]]{[["name":"permissionsChanged","payload":publicPermissions(s)],["name":"accountsChanged","payload":addresses(s)]]}
 private func canonical(_ value:Any?)throws->String{try PermissionJSON.canonical(value)}
 private func hash(_ value:Any?)throws->String{textHash(try canonical(value))}
 private func textHash(_ value:String)->String{SHA256.hash(data:Data(value.utf8)).map{String(format:"%02x",$0)}.joined()}
 private func operation(_ scope:[String:String],_ requestId:Any?)throws->String{
  let integer=(requestId as? NSNumber).map{CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && $0.doubleValue.rounded()==$0.doubleValue && abs($0.doubleValue)<=9007199254740991} ?? false
  try need(requestId is String || integer)
  return PermissionJSON.id("P4/rpc",scope["sessionId"]!,try canonical(requestId))
 }
 private func capabilities(_ s:NativeWalletSnapshot)->[String:Any]{[
  "standard":"1.0.0","provider":"1.0.0","chainId":s.account.chainId,
  "methods":Dictionary(uniqueKeysWithValues:(["tbc_chainId","tbc_accounts","tbc_requestAccounts","tbc_getAccount","tbc_getCapabilities","wallet_getPermissions","wallet_requestPermissions","tbc_disconnect","tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_signPreparedTransaction","tbc_signWorkflow","tbc_signPreparedWorkflow"]+(custody.supportsReviewed ? [NativeReviewed.method]:[])+s.optionalMethods).map{($0,"1.0")}),
  "intents":["tbc-lop-create":["1.0"],"tbc-lop-cancel":["1.0"],"tbc-lop-match":["1.0"],"tbc-htlc-lock":["1.0"],"tbc-htlc-claim":["1.0"],"tbc-htlc-refund":["1.0"],"tbc-timelock-lock":["1.0"],"tbc-timelock-unlock":["1.0"],"amm.swap":["1.0"],"amm.addLiquidity":["1.0"],"amm.removeLiquidity":["1.0"],"amm.mergeToken":["1.0"],"tbc20Lp.transfer":["1.0"],"tbc20Lp.lock":["1.0"],"tbc20Lp.unlock":["1.0"],"tbc20Lp.merge":["1.0"],"tbc20Lp.burn":["1.0"],"tbc20.transfer":["1.0"],"tbc20.merge":["1.0"],"tbc20-standard-create":["1.0"],"tbc721-standard-create-collection":["1.0"],"tbc721-standard-mint":["1.0"],"tbc721-standard-batch-mint":["1.0"],"tbc-amm-create":["1.0"],"tbc-amm-add-liquidity":["1.0"],"tbc-amm-remove-liquidity":["1.0"],"tbc-amm-swap":["1.0"],"tbc20-lp-transfer":["1.0"],"tbc20-lp-merge":["1.0"],"tbc20-lp-lock":["1.0"],"tbc20-lp-unlock":["1.0"],"tbc.pool.swap.exactTbcForToken":["1.0"],"tbc.pool.swap.exactTokenForTbc":["1.0"],"tbc.pool.liquidity.add":["1.0"],"tbc.pool.liquidity.remove":["1.0"],"tbc.pool.ft.merge":["1.0"],"tbc.pool.ftlp.merge":["1.0"],"tbc.pool.ftlp.burn":["1.0"],"tbc721.transfer":["1.0"],"tbc20Stablecoin.transfer":["1.0"],"tbc20Stablecoin.merge":["1.0"],"tbc.transfer":["1.0"],"tbc.maintenance.merge":["1.0"]],"limits":["workflowSteps":5,"transactionBundleSize":32],"profiles":["transport:webview"]]}
 private func readResult(_ method:String,_ s:NativeWalletSnapshot)throws->Any{
  switch method{
  case "tbc_chainId":return s.account.chainId
  case "tbc_accounts":return addresses(s)
  case "wallet_getPermissions":return publicPermissions(s)
  case "tbc_getAccount":try need(has(s,"tbc_accounts") && has(s,"tbc_accountMetadata"));return s.account.identity.merging(["features":["tbc:provider"]]){a,_ in a}
  case "tbc_getCapabilities":return capabilities(s)
  default:throw NativeCustodyFailure(code:"NATIVE_DENIED")
  }
 }
 // Package-owned API information, not a native ledger attestation. Validate
 // its canonical shape/account here, then fence grant+epoch at actual emission.
 // Never accepted as a signature, approval material or spendability proof.
 private func validateBalance(_ value:Any?,_ s:NativeWalletSnapshot)throws{
  let r=try map(value),atomic=try string(r["balanceAtomic"])
  try need(walletProtocol == .legacy && has(s,"tbc_accounts") &&
   Set(r.keys)==["chainId","address","balanceAtomic","decimals"] &&
   r["chainId"] as? String==s.account.chainId && r["address"] as? String==s.account.address &&
   addresses(s).contains(s.account.address) && canonical(r["decimals"])=="6" &&
   atomic.range(of:"^(0|[1-9][0-9]{0,15})$",options:.regularExpression) != nil)
  guard let amount=UInt64(atomic)else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
  try need(amount<=9007199254740991)
 }
 private func control(_ owner:String,_ scope:[String:String],_ id:String,_ method:String,_ value:Any?,_ s:NativeWalletSnapshot)throws{
  try need((committed[owner]?.count ?? 0)<128 || committed[owner]?[id] != nil)
  committed[owner,default:[:]][id]=Committed(stamp:stamp(scope,s),method:method,resultHash:try hash(value))
 }
 private func validResult(_ owner:String,_ scope:[String:String],_ f:Frame,_ s:NativeWalletSnapshot)throws->Bool{
  if f.error{return true} // Scope is always checked. Errors grant no authority.
  if f.stamp != stamp(scope,s){return false}
  if let c=committed[owner]?[f.operation],let check=c.current{
   try check();return c.method==f.method && c.resultHash==f.resultHash && c.stamp==stamp(scope,s)
  }
  switch f.method{
  case "wallet_mergeMaintenance","wallet_runMultiRoundMerge":return custody.mayDeliverMaintenanceResult(owner:owner,scope:scope,id:f.operation,resultHash:f.resultHash)
  case "wallet_readBalance":return walletProtocol == .legacy && has(s,"tbc_accounts") && addresses(s).contains(s.account.address)
  case "tbc_getAccount":
   guard has(s,"tbc_accounts") && has(s,"tbc_accountMetadata") else{return false}
   return try s.connectedAccounts.contains{a in
    let granted=s.permissions.contains{p in p["parentCapability"] as? String=="tbc_accountMetadata" && (p["caveats"] as? [[String:Any]] ?? []).contains{$0["type"] as? String=="restrictAccounts" && ($0["value"] as? [String] ?? []).contains(a.accountId)}}
    return try granted && hash(a.identity.merging(["features":["tbc:provider"]]){x,_ in x})==f.resultHash
   }
  case "tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_signPreparedTransaction","tbc_signReviewedTransaction":return custody.mayDeliverSignature(owner:owner,scope:scope,id:f.operation)
  case "tbc_encrypt","tbc_decrypt":return custody.mayDeliverCryptoResult(owner:owner,scope:scope,id:f.operation,method:f.method,resultHash:f.resultHash)
  case "tbc_signWorkflow","tbc_signPreparedWorkflow":return custody.mayDeliverWorkflowResult(owner:owner,scope:scope,id:f.operation,method:f.method,resultHash:f.resultHash)
  case "tbc_sendTransaction","tbc_sendPreparedTransaction","tbc_sendWorkflow","tbc_sendPreparedWorkflow":return custody.mayDeliverSendResult(owner:owner,scope:scope,id:f.operation,method:f.method,resultHash:f.resultHash)
  case "tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect":
   guard let c=committed[owner]?[f.operation]else{return false}
   return c.method==f.method && c.resultHash==f.resultHash && c.stamp==stamp(scope,s)
  default:return try hash(readResult(f.method,s))==f.resultHash
  }
 }
 private func prepareDelivery(_ owner:String,_ scope:[String:String],_ method:String,_ id:Any?,_ text:String)throws{
  let s=try custody.snapshot(owner:owner,scope:scope);try need(text.utf8.count<=4*1024*1024)
  let m=try map(JSONSerialization.jsonObject(with:Data(text.utf8)));try need(canonical(m)==text)
  try need(Set(m.keys)==["channel","type","sessionId","navigationId","messageId","deliveryId","response","events"])
  try need(m["channel"] as? String==walletProtocol.wireChannel && m["type"] as? String=="delivery" && m["sessionId"] as? String==scope["sessionId"] && m["navigationId"] as? String==scope["navigationId"])
  try need(m["deliveryId"] as? String==hash(["response":m["response"]!,"events":m["events"]!]))
  let response=try map(m["response"]),error=response.keys.contains("error")
  try need(Set(response.keys)==["jsonrpc","id",error ? "error":"result"] && response["jsonrpc"] as? String=="2.0" && canonical(response["id"])==canonical(id))
  guard let emitted=m["events"] as? [Any]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
  if error{
   let e=try map(response["error"]);try need(Set(e.keys)==["code","message"] && emitted.isEmpty)
   let expected:[Int:Set<String>]=[4001:["Request rejected"],4100:["Unauthorized","Authorization changed"],4200:["Unsupported method or profile"],4901:["Unsupported chain"],-32602:["Invalid parameters"],-32603:["Wallet operation unavailable"]]
   guard let code=e["code"] as? NSNumber,CFGetTypeID(code) != CFBooleanGetTypeID(),code.doubleValue==Double(code.intValue),let message=e["message"] as? String else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   try need(expected[code.intValue]?.contains(message)==true)
  }else if let c=committed[owner]?[try operation(scope,id)],let expected=c.eventsHash{
   try need(c.method==method && hash(emitted)==expected)
  }else if !emitted.isEmpty{
   try need(["tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect"].contains(method) && canonical(emitted)==canonical(events(s)))
  }
  if !error && method=="wallet_readBalance"{try validateBalance(response["result"],s)}
  let resultHash = error ? "" : try method=="wallet_runMultiRoundMerge" ? custody.maintenanceProjectionHash(owner:owner,scope:scope,id:operation(scope,id),result:response["result"]) : hash(response["result"])
  let frame=Frame(stamp:stamp(scope,s),method:method,operation:try operation(scope,id),resultHash:resultHash,error:error)
  try need(validResult(owner,scope,frame,s));let digest=textHash(text)
  try need((frames[owner]?.count ?? 0)<256 || frames[owner]?[digest] != nil);frames[owner,default:[:]][digest]=frame
 }
 // Call without an intervening await immediately before native WebView release.
 func allowDelivery(owner:String,scope:[String:String],text:String)->Bool{
  do{
   let s=try custody.snapshot(owner:owner,scope:scope);try need(text.utf8.count<=4*1024*1024)
   if let f=frames[owner]?[textHash(text)]{try need(f.stamp.scope==scope);return try validResult(owner,scope,f,s)}
   let m=try map(JSONSerialization.jsonObject(with:Data(text.utf8)))
   try need(canonical(m)==text && m["channel"] as? String==walletProtocol.wireChannel && m["sessionId"] as? String==scope["sessionId"] && m["navigationId"] as? String==scope["navigationId"])
   if m["type"] as? String=="event"{
    try need(Set(m.keys)==["channel","type","sessionId","navigationId","messageId","event"])
    let event=try canonical(m["event"])
    let permitted=try networkEvents?(owner,scope) ?? events(s)
    return try permitted.contains{try canonical($0)==event}
   }
   try need(Set(m.keys)==["channel","type","sessionId","navigationId","messageId","origin","chainId"])
   return m["type"] as? String=="initialize" && m["origin"] as? String==scope["origin"] && m["chainId"] as? String==s.account.chainId
  }catch{return false}
 }
 // Fixed private replies only: no exception descriptions or callback arguments.
 func dispatch(method:String,input:Any?,reply:@escaping @MainActor ([String:Any])->Void){
  var done=false
  func send(_ value:Any?,snapshot:NativeWalletSnapshot?=nil){if !done{done=true;var r:[String:Any]=["ok":true,"value":value ?? NSNull()];if let snapshot{r["snapshot"]=Self.snapshotWire(snapshot)};reply(r)}}
  func fail(_ error:Error){if !done{done=true
   let code=method=="signing.sign" && error is NativeWorkflowStepUnavailable ? "NATIVE_WORKFLOW_STEP_UNAVAILABLE":(method=="signing.crypto" && error is NativeWorkflowCryptoUnavailable ? "NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE":((error as? NativeCustodyFailure)?.code=="USER_REJECTED" ? "USER_REJECTED":"NATIVE_DENIED"))
   reply(["ok":false,"code":code])
  }}
  do{
   let a=try map(input),owner=try string(a["ownerId"]),scope=try scope(a["scope"])
   func keys(_ fields:String...)throws{try need(Set(a.keys)==Set(["ownerId","scope"]+fields))}
   func id()throws->String{try string(a["operation"])}
   switch method{
   case "snapshot":try keys();send(Self.snapshotWire(try custody.snapshot(owner:owner,scope:scope)))
   case "permissions.request":
    try keys("operation","permissions","providerMethod");let provider=try string(a["providerMethod"])
    try need(["tbc_requestAccounts","wallet_requestPermissions"].contains(provider))
    try custody.requestPermissions(owner:owner,scope:scope,id:id(),request:map(a["permissions"])){r in
     do{let granted=try r.get(),s=try self.custody.snapshot(owner:owner,scope:scope)
      try self.control(owner,scope,id(),provider,provider=="tbc_requestAccounts" ? self.addresses(s) as Any:granted as Any,s)
      self.notifyChanges(scope["origin"],exceptOwner:owner);send(granted,snapshot:s)
     }catch{fail(error)}
    }
   case "permissions.disconnect":
    try keys("operation");try custody.disconnect(owner:owner,scope:scope,id:id());let s=try custody.snapshot(owner:owner,scope:scope)
    try control(owner,scope,id(),"tbc_disconnect",nil,s);notifyChanges(scope["origin"],exceptOwner:owner);send(nil,snapshot:s)
   case "signing.begin":
    try keys("operation","method","revision","account");let account=try map(a["account"])
    let selected=NativeAccount(address:try string(account["address"]),publicKey:try string(account["publicKey"]),chainId:try string(account["chainId"]))
    try need(canonical(account)==canonical(selected.identity))
    guard let revision=a["revision"] as? NSNumber,CFGetTypeID(revision) != CFBooleanGetTypeID(),revision.doubleValue>=0,revision.doubleValue<=Double(Int32.max),revision.doubleValue==Double(revision.intValue)else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    send(Self.snapshotWire(try custody.begin(owner:owner,scope:scope,id:id(),method:string(a["method"]),expectedRevision:revision.intValue,expectedAccount:selected)))
   case "maintenance.begin","maintenance.noop":
    if method=="maintenance.noop"{try keys("operation","revision","account","consent","result")}else{try keys("operation","revision","account","consent")};let account=try map(a["account"])
    let selected=NativeAccount(address:try string(account["address"]),publicKey:try string(account["publicKey"]),chainId:try string(account["chainId"]))
    try need(canonical(account)==canonical(selected.identity))
    guard let revision=Int(try canonical(a["revision"])),revision>=0,revision<=Int32.max else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    try custody.beginMaintenance(owner:owner,scope:scope,id:id(),expectedRevision:revision,expectedAccount:selected,consent:map(a["consent"]),noopResult:method=="maintenance.noop" ? map(a["result"]):nil){r in do{send(try r.get())}catch{fail(error)}}
   case "maintenance.step":
    try keys("operation","parent","step","request","selectedInputs")
    guard let inputs=a["selectedInputs"] as? [String]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    send(Self.snapshotWire(try custody.beginMaintenanceStep(owner:owner,scope:scope,parent:string(a["parent"]),id:id(),step:map(a["step"]),request:map(a["request"]),selectedInputs:inputs)))
   case "maintenance.finish":try keys("operation","result");try custody.finishMaintenance(owner:owner,scope:scope,id:id(),result:map(a["result"]));send(true)
   case "maintenance.close":try keys("operation");try custody.closeMaintenance(owner:owner,scope:scope,id:id());send(true)
   case "signing.check":try keys("operation");try custody.check(owner:owner,scope:scope,id:id());send(true)
   case "signing.roles":
    try keys("operation","request","context")
    send(try custody.resolveSigningAccounts(owner:owner,scope:scope,id:id(),request:map(a["request"]),context:map(a["context"])))
   case "signing.consent":
    if a["review"] != nil{try keys("operation","method","request","context","review")}else{try keys("operation","method","request","context")}
    try custody.consent(owner:owner,scope:scope,id:id(),method:string(a["method"]),request:map(a["request"]),context:map(a["context"]),review:optionalMap(a["review"])){r in do{send(try r.get())}catch{fail(error)}}
   case "signing.bind":
    if NativeWorkflow.methods.contains((try map(map(a["binding"])["payload"]))["method"] as? String ?? ""){
     try keys("operation","binding","preview","plan","envelope");try need(optionalMap(a["envelope"])==nil)
     try custody.bindWorkflow(owner:owner,scope:scope,id:id(),binding:map(a["binding"]),preview:map(a["preview"]),plan:map(a["plan"])){r in do{send(try r.get())}catch{fail(error)}}
    }else if a["reviewed"] != nil{
     try keys("operation","binding","preview","plan","envelope","reviewed");try need(optionalMap(a["envelope"])==nil)
     try custody.bindReviewed(owner:owner,scope:scope,id:id(),binding:map(a["binding"]),preview:map(a["preview"]),plan:map(a["plan"]),packet:map(a["reviewed"])){r in do{send(try r.get())}catch{fail(error)}}
    }else{
     try keys("operation","binding","preview","plan","envelope")
     send(try custody.bind(owner:owner,scope:scope,id:id(),binding:map(a["binding"]),preview:map(a["preview"]),plan:optionalMap(a["plan"]),envelope:optionalMap(a["envelope"])))
    }
   case "signing.workflow.enter":
    try keys("operation","receipt","entry");try custody.enterWorkflowStep(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),entry:map(a["entry"]));send(true)
   case "signing.workflow.finish":
    try keys("operation","receipt","outcome");try custody.finishWorkflowStep(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),outcome:map(a["outcome"])){r in do{send(try r.get())}catch{fail(error)}}
   case "signing.advance":
    try keys("operation","receipt","pending")
    if try map(a["pending"])["kind"] as? String=="reviewed"{
     try custody.advanceReviewed(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),pending:map(a["pending"])){r in do{send(try r.get())}catch{fail(error)}}
    }else{try custody.advance(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),pending:map(a["pending"]));send(true)}
   case "signing.sign":
    try keys("operation","receipt","task")
    try custody.sign(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),task:map(a["task"])){r in do{send(try r.get())}catch{fail(error)}}
   case "signing.crypto":
    try keys("operation","receipt","task")
    try custody.executeCrypto(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),task:map(a["task"])){r in do{send(try r.get())}catch{fail(error)}}
   case "signing.broadcast.authorize":
    try keys("operation","receipt","bundle","workflow")
    try custody.authorizeBroadcast(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),bundle:map(a["bundle"]),workflow:optionalMap(a["workflow"]));send(true)
   case "signing.broadcast.open","signing.broadcast.guard","signing.broadcast.journal","signing.broadcast.wire":
    guard let broadcastHandler else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    broadcastHandler(method,a){value in if !done{done=true;reply(value)}}
   case "signing.broadcast.finish":
    try keys("operation","receipt","result")
    try custody.finishBroadcast(owner:owner,scope:scope,id:id(),receipt:map(a["receipt"]),result:map(a["result"]));send(true)
   case "signing.close":try keys("operation");try custody.close(owner:owner,scope:scope,id:id());send(nil)
   case "operation.cancel":try keys("operation");try custody.cancel(owner:owner,scope:scope,id:id());send(nil)
   case "document.invalidate":try keys();_ = try custody.snapshot(owner:owner,scope:scope);invalidate(owner:owner);send(nil)
   case "delivery.prepare":try keys("method","requestId","serialized");try prepareDelivery(owner,scope,string(a["method"]),a["requestId"],string(a["serialized"]));send(true)
   case "delivery.acknowledge":
    try keys("requestId");_ = try custody.snapshot(owner:owner,scope:scope);let op=try operation(scope,a["requestId"])
    try need(frames[owner]?.values.contains(where:{$0.operation==op && $0.stamp.scope==scope})==true)
    try custody.forgetResult(owner:owner,scope:scope,id:op);committed[owner]?.removeValue(forKey:op)
    frames[owner]=frames[owner]?.filter{$0.value.operation != op};send(true)
   default:throw NativeCustodyFailure(code:"NATIVE_DENIED")
   }
  }catch{fail(error)}
 }
}
