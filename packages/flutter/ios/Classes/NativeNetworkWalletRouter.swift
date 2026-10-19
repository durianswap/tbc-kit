import Foundation
import CoreFoundation

// A lane reuses the existing custody/permission/signing/broadcast host. Its
// account source and endpoint identity are wallet configuration, never DApp data.
struct NativeNetworkLane {
 let sourceIdentity:String,custody:NativeCustody,wallet:NativeWalletHost
}

/// Package-owned native routing, shared by all WebViews. Selection is per
/// document; no global selected-account mutation and no chain API read occurs.
/// The Flutter registration layer must route every private call through here
/// when multiple lanes are installed, never directly to an inactive lane.
@MainActor final class NativeNetworkWalletRouter {
 var walletProtocol:NativeWalletProtocol{lanes[initialChain]!.custody.walletProtocol}
 private let lanes:[String:NativeNetworkLane],initialChain:String,approval:NativeApprovalPresenter
 private var sessions:NativeNetworkSessions!
 private var pending=[String:[String:@MainActor ()->Void]]()
 private var documents=[String:[String:String]]()
 private var closed=false,refreshing=false
 private var authorityChanged:((String,[String:String],[String:Any]?)->Void)?
 init(lanes:[String:NativeNetworkLane],initialChain:String,approval:NativeApprovalPresenter,
      nativeCurrent:@escaping(String,[String:String])->Bool)throws{
  guard lanes[initialChain] != nil else{throw NativeNetworkFailure(code:"NETWORK_CATALOG")}
  guard Set(lanes.values.map{$0.custody.walletProtocol}).count==1 else{throw NativeNetworkFailure(code:"PERMISSION_PROTOCOL")}
  // Do not permit two lane names to refer to the same mutable custody owner.
  guard Set(lanes.values.map{ObjectIdentifier($0.custody)}).count==lanes.count &&
   Set(lanes.values.map{ObjectIdentifier($0.wallet)}).count==lanes.count else{throw NativeNetworkFailure(code:"NETWORK_CATALOG")}
  for (chain,lane) in lanes{try lane.custody.validateNetworkLane(chainId:chain,sourceIdentity:lane.sourceIdentity)}
  self.lanes=lanes;self.initialChain=initialChain;self.approval=approval
  sessions=try NativeNetworkSessions(sources:lanes.mapValues{$0.sourceIdentity},nativeCurrent:{[weak self] owner,scope in
   self?.closed==false && nativeCurrent(owner,scope)
  },authority:{chain,origin in
   let a=try lanes[chain]!.custody.networkAuthority(origin:origin)
   return NativeNetworkAuthority(epoch:a.epoch,unlocked:a.unlocked,switchAccountIds:a.switchAccountIds,visibleAddresses:a.visibleAddresses)
  },fence:{[weak self] owner,_ in
   // This callback is synchronous, and must not recurse into sessions.invalidate.
   for lane in lanes.values{lane.wallet.fenceDocument(owner:owner)}
   self?.cancelDialogs(owner)
  },activate:{owner,scope,chain,ids in try lanes[chain]!.custody.activateAccounts(owner:owner,scope:scope,accountIds:ids)})
  for lane in lanes.values{try lane.wallet.installNetworkEvents{[weak self] owner,scope in
   guard let self else{throw NativeNetworkFailure(code:"NETWORK_STALE")};return try self.publicEvents(owner,scope)
  }}
 }
 private func needOpen()throws{if closed{throw NativeNetworkFailure(code:"NETWORK_STALE")}}
 func installAuthorityChanged(_ callback:@escaping(String,[String:String],[String:Any]?)->Void)throws{
  try needOpen();try need(authorityChanged==nil);authorityChanged=callback
 }
 func nativeAuthorityChanged(owner:String,scope:[String:String]){
  guard !closed,!refreshing,documents[owner]==scope else{return}
  do{authorityChanged?(owner,scope,try snapshotWire(owner:owner,scope:scope))}
  catch{invalidate(owner:owner);authorityChanged?(owner,scope,nil)}
 }
 private func notifyChanges(_ origin:String?,exceptOwner:String?=nil){
  for(owner,scope)in Array(documents) where owner != exceptOwner && (origin==nil || scope["origin"]==origin){nativeAuthorityChanged(owner:owner,scope:scope)}
 }
 private func cancelDialogs(_ owner:String){let callbacks=Array(pending.removeValue(forKey:owner)?.values ?? [:].values);for cancel in callbacks{cancel()}}
 func navigation(owner:String,scope:[String:String])throws{
  try needOpen();try sessions.navigation(owner:owner,scope:scope,initialChain:initialChain)
  do{for lane in lanes.values{try lane.wallet.navigation(owner:owner,scope:scope)};documents[owner]=scope}
  catch{invalidate(owner:owner);throw error}
 }
 func invalidate(owner:String){
  try? sessions.invalidate(owner:owner);cancelDialogs(owner)
  for lane in lanes.values{lane.wallet.invalidate(owner:owner)}
  documents.removeValue(forKey:owner)
 }
 func state(owner:String,scope:[String:String])throws->NativeNetworkState{try needOpen();return try sessions.state(owner:owner,scope:scope)}
 func sourceIdentity(owner:String,scope:[String:String],expected:NativeNetworkState)throws->String{
  try needOpen();return try sessions.requireState(owner:owner,scope:scope,expected:expected)
 }
 func snapshot(owner:String,scope:[String:String],expected:NativeNetworkState)throws->NativeWalletSnapshot{
  _ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
  return try lanes[expected.chainId]!.custody.snapshot(owner:owner,scope:scope)
 }
 func permissions(owner:String,scope:[String:String])throws->[[String:Any]]{
  _ = try state(owner:owner,scope:scope)
  return try lanes.keys.sorted().flatMap{try lanes[$0]!.custody.networkPermissions(origin:scope["origin"]!)}
 }
 // Target grants can be acquired before switching. This does not switch the
 // page or authorize a key; existing per-chain permission UI/storage is reused.
 func requestPermissions(owner:String,scope:[String:String],operation:String,target:String,expected:NativeNetworkState,
                         request:[String:Any],complete:@escaping @MainActor (Result<[[String:Any]],Error>)->Void)throws{
  _ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
  guard let lane=lanes[target] else{throw NativeNetworkFailure(code:"NETWORK_UNSUPPORTED")}
  try lane.custody.requestPermissions(owner:owner,scope:scope,id:operation,request:request){result in
   // Native persistence has already fenced affected custody sessions. Peers
   // receive a full committed projection, never a snapshot of the wrong lane.
   self.notifyChanges(scope["origin"],exceptOwner:owner)
   complete(Result{_ = try self.sourceIdentity(owner:owner,scope:scope,expected:expected);return try result.get()})
  }
 }
 private func requestPermissionGroup(owner:String,scope:[String:String],operation:String,expected:NativeNetworkState,
                                     requests:[String:[String:Any]],complete:@escaping @MainActor (Result<[[String:Any]],Error>)->Void){
  var grants=[NativePermissionGrant](),done=false,ownsPending=false,dismiss:(@MainActor ()->Void)?
  func finish(_ result:Result<[[String:Any]],Error>){
   guard !done else{return};done=true
   if ownsPending{pending[owner]?.removeValue(forKey:operation);if pending[owner]?.isEmpty==true{pending.removeValue(forKey:owner)}}
   for g in grants{g.detach()};complete(result);dismiss?()
  }
  let cancel:@MainActor ()->Void={finish(.failure(NativeNetworkFailure(code:"NETWORK_STALE")))}
  do{
   _ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
   try need(pending[owner]?[operation]==nil)
   pending[owner,default:[:]][operation]=cancel;ownsPending=true
   for chain in requests.keys.sorted(){
    grants.append(try lanes[chain]!.custody.prepareNetworkGrant(owner:owner,scope:scope,id:operation,request:requests[chain]!,cancel:cancel))
   }
   _ = try NativePermissions.groupBackend(grants)
   let detail=grants.map{g in let p=g.proposal;return p.accounts[0].chainId+": "+p.capabilities.joined(separator:", ")+"\nAccounts:\n"+p.accounts.map{$0.address}.joined(separator:"\n")}.joined(separator:"\n\n")
   let a=try snapshot(owner:owner,scope:scope,expected:expected).account
   let review=NativeReview(operationId:operation,origin:scope["origin"]!,chainId:expected.chainId,accountAddress:a.address,title:"Connect wallet networks",
    description:detail+"\n\nApprove all listed networks together. This does not switch this page. Each signature still requires approval.")
   dismiss=approval.present(lanes[initialChain]!.custody.walletProtocol.approvalReview(review)){yes in
    guard !done else{return}
    do{
     if !yes{throw NativeNetworkFailure(code:"NETWORK_REJECTED")}
     // Remove only this dialog before committed grants fence existing work.
     self.pending[owner]?.removeValue(forKey:operation)
     let records=try NativePermissions.approveGroup(grants){
      _ = try self.sourceIdentity(owner:owner,scope:scope,expected:expected)
     }
     self.notifyChanges(scope["origin"],exceptOwner:owner);finish(.success(records))
    }catch{self.notifyChanges(scope["origin"],exceptOwner:owner);finish(.failure(error))}
   }
   if done{dismiss?()}
  }catch{finish(.failure(error))}
 }
 // Only native registration/wallet changes call this, not a page event.
 func accountChanged(){
  for owner in Array(pending.keys){cancelDialogs(owner)}
  refreshing=true
  for lane in lanes.values{lane.wallet.accountChanged()}
  refreshing=false;notifyChanges(nil)
 }
 func cancelSwitch(owner:String,scope:[String:String],operation:String)throws{
  try needOpen();try sessions.cancel(owner:owner,scope:scope,operation:operation)
  let callback=pending[owner]?.removeValue(forKey:operation);if pending[owner]?.isEmpty==true{pending.removeValue(forKey:owner)};callback?()
 }
 func switchChain(owner:String,scope:[String:String],operation:String,target:String,expected:NativeNetworkState,
                  complete:@escaping @MainActor (Result<NativeNetworkCommit,Error>)->Void)throws{
  _ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
  let proposal=try sessions.prepare(owner:owner,scope:scope,operation:operation,target:target,expectedRevision:expected.revision)
  if target==expected.chainId{complete(Result{try sessions.commit(proposal,approved:false)});return}
  let targetAddresses=proposal.toAuthority.visibleAddresses.filter{proposal.toAuthority.switchAccountIds.contains(target+":"+$0)}
  var done=false;var dismiss:(@MainActor ()->Void)?
  func finish(_ result:Result<NativeNetworkCommit,Error>){
   guard !done else{return};done=true
   pending[owner]?.removeValue(forKey:operation);if pending[owner]?.isEmpty==true{pending.removeValue(forKey:owner)}
   complete(result);dismiss?()
  }
  pending[owner,default:[:]][operation]={finish(.failure(NativeNetworkFailure(code:"NETWORK_STALE")))}
  let name=target=="tbc:mainnet" ? "TBC Mainnet":"TBC Testnet"
  let review=NativeReview(operationId:operation,origin:scope["origin"]!,chainId:target,accountAddress:targetAddresses.first!,
   title:"Switch network",description:"Switch this page from \(expected.chainId) to \(name) (\(target)).\nAccounts:\n\(targetAddresses.joined(separator:"\n"))\nPending requests on the previous network will be cancelled. No transaction will be signed or sent.")
  dismiss=approval.present(lanes[initialChain]!.custody.walletProtocol.approvalReview(review)){yes in
   guard !done else{return}
   // Remove this callback before commit fences every other pending dialog.
   self.pending[owner]?.removeValue(forKey:operation)
   finish(Result{try self.sessions.commit(proposal,approved:yes)})
  }
  if done{dismiss?()}
 }
 func requireDelivery(_ commit:NativeNetworkCommit)throws{try needOpen();try sessions.requireDelivery(commit)}
 // Every asynchronous callback retains the original chain+revision. An old
 // worker must fail rather than dispatching or returning through the new lane.
 func dispatch(owner:String,scope:[String:String],expected:NativeNetworkState,method:String,fields:[String:Any],
               reply:@escaping @MainActor ([String:Any])->Void){
  func denied(){reply(["ok":false,"code":"NATIVE_DENIED"])}
  do{
   _ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
   guard fields["ownerId"]==nil && fields["scope"]==nil else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}
   // Disconnect is origin-wide; use disconnect() rather than revoking one lane.
   guard method != "permissions.disconnect" && method != "document.invalidate" else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}
   lanes[expected.chainId]!.wallet.dispatch(method:method,input:fields.merging(["ownerId":owner,"scope":scope]){a,_ in a}){result in
    do{_ = try self.sourceIdentity(owner:owner,scope:scope,expected:expected);reply(result)}catch{denied()}
   }
  }catch{denied()}
 }
 func allowDelivery(owner:String,scope:[String:String],expected:NativeNetworkState,text:String)->Bool{
  do{_ = try sourceIdentity(owner:owner,scope:scope,expected:expected);return lanes[expected.chainId]!.wallet.allowDelivery(owner:owner,scope:scope,text:text)}catch{return false}
 }
 // All lanes are attempted even if one store fails. A failure never becomes a
 // success response, and existing native store logic fails closed on uncertainty.
 func disconnect(owner:String,scope:[String:String],operation:String,expected:NativeNetworkState)throws{
  _ = try sourceIdentity(owner:owner,scope:scope,expected:expected);cancelDialogs(owner)
  for lane in lanes.values{lane.wallet.fenceDocument(owner:owner)}
  var failure:Error?
  for chain in lanes.keys.sorted(){do{try lanes[chain]!.custody.disconnect(owner:owner,scope:scope,id:operation)}catch{failure=error}}
  notifyChanges(scope["origin"],exceptOwner:owner)
  if let failure{throw failure}
 }
 func close(){guard !closed else{return};closed=true;for owner in Array(documents.keys){invalidate(owner:owner)}}

 // The sole multi-network private MethodChannel entry. No page endpoint,
 // document override or mutable current-network selection is accepted.
 private func need(_ b:Bool)throws{if !b{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}}
 private func map(_ v:Any?)throws->[String:Any]{guard let m=v as? [String:Any]else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")};return m}
 private func string(_ v:Any?)throws->String{guard let s=v as? String else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")};return s}
 private func parseState(_ v:Any?)throws->NativeNetworkState{
  let m=try map(v);try need(Set(m.keys)==["chainId","revision"])
  guard let n=m["revision"] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue==Double(n.intValue),(0...Int(Int32.max)).contains(n.intValue)else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}
  return try NativeNetworkState(chainId:string(m["chainId"]),revision:n.intValue)
 }
 func snapshotWire(owner:String,scope:[String:String])throws->[String:Any]{
  let s=try state(owner:owner,scope:scope)
  return ["network":["chainId":s.chainId,"revision":s.revision],"sources":lanes.mapValues{$0.sourceIdentity},
   "lanes":try lanes.mapValues{try NativeWalletHost.snapshotWire($0.custody.snapshot(owner:owner,scope:scope))},"permissions":try permissions(owner:owner,scope:scope)]
 }
 private func publicEvents(_ owner:String,_ scope:[String:String])throws->[[String:Any]]{
  let s=try state(owner:owner,scope:scope),a=try snapshot(owner:owner,scope:scope,expected:s)
  return [["name":"permissionsChanged","payload":try permissions(owner:owner,scope:scope)],["name":"accountsChanged","payload":a.connectedAccounts.map{$0.address}]]
 }
 private func remember(_ owner:String,_ scope:[String:String],_ expected:NativeNetworkState,_ id:String,_ method:String,_ result:Any?,_ events:[[String:Any]],check:@escaping()throws->Void={})throws{
  let epochs=try lanes.mapValues{try $0.custody.networkAuthority(origin:scope["origin"]!).epoch}
  try lanes[expected.chainId]!.wallet.rememberNetworkResult(owner:owner,scope:scope,operation:id,method:method,result:result,events:events){[weak self] in
   guard let self else{throw NativeNetworkFailure(code:"NETWORK_STALE")}
   _ = try self.sourceIdentity(owner:owner,scope:scope,expected:expected);try check()
   try self.need(self.lanes.mapValues{try $0.custody.networkAuthority(origin:scope["origin"]!).epoch}==epochs)
  }
 }
 func allowDelivery(owner:String,scope:[String:String],text:String)->Bool{
  do{return allowDelivery(owner:owner,scope:scope,expected:try state(owner:owner,scope:scope),text:text)}catch{return false}
 }
 func dispatch(method:String,input:Any?,reply:@escaping @MainActor ([String:Any])->Void){
  var done=false
  func respond(_ value:[String:Any]){if !done{done=true;reply(value)}}
  func fail(_ error:Error){
   let code=(error as? NativeNetworkFailure)?.code ?? (error as? NativeCustodyFailure)?.code
   respond(["ok":false,"code":code=="NETWORK_REJECTED" || code=="USER_REJECTED" ? "USER_REJECTED":code=="NETWORK_UNSUPPORTED" ? "UNSUPPORTED_CHAIN":"NATIVE_DENIED"])
  }
  do{
   let a=try map(input),owner=try string(a["ownerId"])
   guard let scope=a["scope"] as? [String:String]else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}
   func keys(_ fields:String...)throws{try need(Set(a.keys)==Set(["ownerId","scope","network"]+fields))}
   func id()throws->String{try string(a["operation"])}
   func send(_ value:Any?,snapshot:Bool=false)throws{
    var result:[String:Any]=["ok":true,"value":value ?? NSNull()];if snapshot{result["snapshot"]=try snapshotWire(owner:owner,scope:scope)};respond(result)
   }
   if method=="network.snapshot"{try need(Set(a.keys)==["ownerId","scope"]);try send(snapshotWire(owner:owner,scope:scope));return}
   let expected=try parseState(a["network"]);_ = try sourceIdentity(owner:owner,scope:scope,expected:expected)
   switch method{
   case "network.switch":
    try keys("operation","chainId");let operation=try id()
    try switchChain(owner:owner,scope:scope,operation:operation,target:string(a["chainId"]),expected:expected){r in
     do{let c=try r.get(),events=try JSONSerialization.jsonObject(with:Data(c.eventsJSON.utf8)) as! [[String:Any]]
      try self.remember(owner,scope,c.state,operation,"tbc_switchChain",nil,events){try self.requireDelivery(c)}
      try send(events,snapshot:true)
     }catch{fail(error)}
    }
   case "network.capabilities":
    try keys("operation","chainId","address");let target=try string(a["chainId"])
    guard let lane=lanes[target]else{throw NativeNetworkFailure(code:"NETWORK_UNSUPPORTED")}
    if !(a["address"] is NSNull){let address=try string(a["address"]);try need(lane.custody.networkAuthority(origin:scope["origin"]!).visibleAddresses.contains(address))}
    let result=try lane.wallet.networkCapabilities(owner:owner,scope:scope)
    try remember(owner,scope,expected,id(),"tbc_getCapabilities",result,[]);try send(result)
   case "permissions.request":
    try keys("operation","permissions","providerMethod");let request=try map(a["permissions"]),provider=try string(a["providerMethod"]),operation=try id()
    try need(["tbc_requestAccounts","wallet_requestPermissions"].contains(provider) && !request.isEmpty)
    var requests=[String:[String:Any]]()
    for(method,value)in request{
     let options=try map(value);guard let chains=options["chains"] as? [String]else{throw NativeNetworkFailure(code:"NETWORK_SCOPE")}
     try need(!chains.isEmpty && chains.count<=lanes.count && Set(chains).count==chains.count)
     for chain in chains{
      guard lanes[chain] != nil else{throw NativeNetworkFailure(code:"NETWORK_UNSUPPORTED")}
      requests[chain,default:[:]][method]=options.merging(["chains":[chain]]){_,b in b}
     }
    }
    try need(provider != "tbc_requestAccounts" || Set(requests.keys)==[expected.chainId])
    let complete:@MainActor (Result<[[String:Any]],Error>)->Void={r in
     do{let records=try r.get(),s=try self.snapshot(owner:owner,scope:scope,expected:expected),events=try self.publicEvents(owner,scope)
      try self.remember(owner,scope,expected,operation,provider,provider=="tbc_requestAccounts" ? s.connectedAccounts.map{$0.address} as Any:records as Any,events)
      try send(records,snapshot:true)
     }catch{fail(error)}
    }
    if requests.count==1{let target=requests.keys.first!;try requestPermissions(owner:owner,scope:scope,operation:operation,target:target,expected:expected,request:requests[target]!,complete:complete)}
    else{requestPermissionGroup(owner:owner,scope:scope,operation:operation,expected:expected,requests:requests,complete:complete)}
   case "permissions.disconnect":
    try keys("operation");try disconnect(owner:owner,scope:scope,operation:id(),expected:expected)
    try remember(owner,scope,expected,id(),"tbc_disconnect",nil,publicEvents(owner,scope));try send(nil,snapshot:true)
   case "operation.cancel":
    try keys("operation");let operation=try id();try cancelSwitch(owner:owner,scope:scope,operation:operation)
    for lane in lanes.values{try lane.custody.cancel(owner:owner,scope:scope,id:operation)};try send(nil)
   case "document.invalidate":try keys();invalidate(owner:owner);try send(nil)
   default:
    if method=="delivery.prepare",a["method"] as? String=="wallet_getPermissions"{
     try keys("method","requestId","serialized")
     let operation=try PermissionJSON.id("P4/rpc",scope["sessionId"]!,PermissionJSON.canonical(a["requestId"]))
     try remember(owner,scope,expected,operation,"wallet_getPermissions",permissions(owner:owner,scope:scope),[])
    }
    let fields=a.filter{!["ownerId","scope","network"].contains($0.key)}
    dispatch(owner:owner,scope:scope,expected:expected,method:method,fields:fields,reply:respond)
   }
  }catch{fail(error)}
 }
}
