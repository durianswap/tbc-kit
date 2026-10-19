import Flutter
import Foundation
import UIKit

// Typed wallet configuration. The canonical source identity is shared with
// reads and submission; supplying a source alone does not enable broadcast.
struct NativeWalletNetwork {
 let source:NativeBroadcastConfiguration,accounts:NativeAccountSource,backend:NativePermissionBackend
 let approval:NativeApprovalPresenter,signer:NativeDigestSigner
 var crypto:NativeBie1Executor?=nil
 var broadcastDirectory:URL?=nil
 var broadcastProfile:String?=nil
 var legacyBackend:NativePermissionBackend?=nil
}

/// Register once in the wallet's Flutter engine, on the main actor. Required
/// account, permission persistence, UI and digest signing stay wallet-owned.
/// Wallet lock/unlock/selection must call walletStateChanged before key use;
/// application suspension calls suspendViews, engine detach calls dispose.
@MainActor final class TbcDartWalletHost {
 private let channel:FlutterMethodChannel,accounts:NativeAccountSource,chain:String
 private var protocols:NativeProtocolWalletRouter!,webview:TbcFlutterWebViewHost!
 private var broadcastRouters=[NativeBroadcastRouter]()
 private var networkRouters=[NativeWalletProtocol:NativeNetworkWalletRouter]()
 private var accountSources=[String:NativeAccountSource]()
 private var closed=false
 // Private Flutter calls only. This principal can never be acquired by a WebView.
 private static let localOrigin="https://native.wallet.tbc.invalid"
 private var localScopes=[String:[String:String]]()
 private func current(_ owner:String,_ scope:[String:String])->Bool{
  guard !closed else{return false}
  if let local=localScopes[owner]{return local==scope}
  return scope["origin"] != Self.localOrigin && webview?.isCurrent(owner:owner,expected:scope)==true
 }
 init(messenger:FlutterBinaryMessenger,root:UIView,pageResource:URL,expectedPageSHA256:String,
      accounts:NativeAccountSource,chain:String,backend:NativePermissionBackend,
      approval:NativeApprovalPresenter,signer:NativeDigestSigner,crypto:NativeBie1Executor?=nil,allowInsecureLoopback:Bool=false,
      broadcast:NativeBroadcastConfiguration?=nil,broadcastDirectory:URL?=nil,broadcastProfile:String?=nil,
      networkSource:NativeBroadcastConfiguration?=nil,additionalNetworks:[NativeWalletNetwork]=[],
      legacyBackend:NativePermissionBackend?=nil)throws{
  self.accounts=accounts;self.chain=chain
  channel=FlutterMethodChannel(name:"io.tbc.kit.dart/private-wallet",binaryMessenger:messenger)
  let compute=try NativeReviewedRust()
  try permissionNeed(broadcast==nil ? broadcastDirectory==nil && broadcastProfile==nil : broadcast?.chainId==chain && broadcastDirectory != nil && broadcastProfile != nil,"NATIVE_BROADCAST_CONFIGURATION")
  let primarySource=try networkSource ?? broadcast ?? NativeBroadcastConfiguration(network:String(chain.dropFirst(4)))
  try permissionNeed(primarySource.chainId==chain && (broadcast==nil || broadcast?.sourceIdentity==primarySource.sourceIdentity),"NATIVE_NETWORK_SOURCE")
  func makeLane(_ n:NativeWalletNetwork,_ protocolId:NativeWalletProtocol)throws->NativeNetworkLane{
   try permissionNeed((n.broadcastDirectory==nil)==(n.broadcastProfile==nil),"NATIVE_BROADCAST_CONFIGURATION")
   let sending=n.broadcastDirectory != nil
   let selectedBackend=protocolId == .standard ? n.backend:n.legacyBackend!
   let custody=try NativeCustody(accounts:n.accounts,chain:n.source.chainId,backend:selectedBackend,approval:n.approval,signer:n.signer,reviewedComputer:compute,crypto:n.crypto,sendSourceIdentity:sending ? n.source.sourceIdentity:nil,walletProtocol:protocolId){[weak self] owner,scope in
    guard let self else{return false};return self.current(owner,scope)
   }
   let host=NativeWalletHost(custody:custody){[weak self] owner,scope,snapshot in
    guard let self,!self.closed else{return}
    if let router=self.networkRouters[protocolId]{router.nativeAuthorityChanged(owner:owner,scope:scope)}
    else{self.notify(protocolId,owner,scope,NativeWalletHost.snapshotWire(snapshot))}
   }
   if sending{
    let http=try NativeBroadcastHTTP(sourceIdentity:n.source.sourceIdentity)
    let router=NativeBroadcastRouter(custody:custody,configuration:n.source,directory:n.broadcastDirectory!,profile:n.broadcastProfile!,send:{request,fence,reply in try http.start(request,fence:fence,complete:reply)})
    try host.installBroadcast{method,input,reply in router.dispatch(method:method,input:input,reply:reply)};broadcastRouters.append(router)
   }
   return NativeNetworkLane(sourceIdentity:n.source.sourceIdentity,custody:custody,wallet:host)
  }
  let configurations=[NativeWalletNetwork(source:primarySource,accounts:accounts,backend:backend,approval:approval,signer:signer,crypto:crypto,broadcastDirectory:broadcastDirectory,broadcastProfile:broadcastProfile,legacyBackend:legacyBackend)]+additionalNetworks
  try permissionNeed(configurations.count<=2 && Set(configurations.map{$0.source.chainId}).count==configurations.count,"NATIVE_NETWORK_CATALOG")
  // All configured networks must explicitly supply the isolated Legacy store;
  // omission disables that protocol. Never fall back to Standard permissions.
  try permissionNeed(configurations.allSatisfy{$0.backend.walletProtocol == .standard && ($0.legacyBackend != nil)==(legacyBackend != nil) && ($0.legacyBackend==nil || $0.legacyBackend?.walletProtocol == .legacy)},"PERMISSION_PROTOCOL")
  func makeProtocol(_ protocolId:NativeWalletProtocol)throws->NativeProtocolLane{
   var lanes=[String:NativeNetworkLane]()
   for n in configurations{lanes[n.source.chainId]=try makeLane(n,protocolId);accountSources[n.source.chainId]=n.accounts}
   if additionalNetworks.isEmpty{return try NativeProtocolLane(wallet:lanes[chain]!.wallet)}
   let router=try NativeNetworkWalletRouter(lanes:lanes,initialChain:chain,approval:approval){[weak self] owner,scope in
    guard let self else{return false};return self.current(owner,scope)
   }
   try router.installAuthorityChanged{[weak self] owner,scope,snapshot in
    guard let self,!self.closed else{return};self.notify(protocolId,owner,scope,snapshot as Any? ?? NSNull())
   };networkRouters[protocolId]=router
   return try NativeProtocolLane(wallet:lanes[chain]!.wallet,network:router)
  }
  protocols=try NativeProtocolWalletRouter(standard:makeProtocol(.standard),legacy:legacyBackend==nil ? nil:makeProtocol(.legacy))
  webview=try TbcFlutterWebViewHost(messenger:messenger,root:root,pageResource:pageResource,expectedPageSHA256:expectedPageSHA256,
   allowInsecureLoopback:allowInsecureLoopback,invalidateCustody:{[weak self] owner,_ in self?.invalidate(owner)},
   verifiedNavigation:{[weak self] owner,scope in
    guard let self else{return}
    do{try permissionNeed(scope["origin"] != Self.localOrigin,"NATIVE_DENIED");try self.protocols.navigation(owner:owner,scope:scope)}catch{self.invalidate(owner)}
   },allowDelivery:{[weak self] owner,scope,text in
    guard let self else{return false};return self.protocols.allowDelivery(owner:owner,scope:scope,text:text)
   },allowLegacyDelivery:{[weak self] owner,scope,text in
    guard let self else{return false};return self.protocols.allowDelivery(owner:owner,scope:scope,text:text,walletProtocol:.legacy)
   })
  channel.setMethodCallHandler{[weak self] call,result in
   guard let self,!self.closed else{result(["ok":false,"code":"NATIVE_DENIED"]);return}
   if call.method.hasPrefix("local.") {self.localCall(call.method,call.arguments,result);return}
   if let args=call.arguments as? [String:Any],let owner=args["ownerId"] as? String,self.localScopes[owner] != nil,args["walletProtocol"] != nil{result(["ok":false,"code":"NATIVE_DENIED"]);return}
   self.protocols.dispatch(method:call.method,input:call.arguments){value in result(value)}
  }
 }
 private func localCall(_ method:String,_ input:Any?,_ reply:FlutterResult){
  do{
   guard let args=input as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   if method=="local.open"{
    try permissionNeed(args.isEmpty && localScopes.isEmpty,"NATIVE_DENIED")
    let owner="local_"+UUID().uuidString,session=UUID().uuidString
    let scope=["webViewInstanceId":owner,"sessionId":session,"navigationId":UUID().uuidString,"committedUrl":Self.localOrigin+"/","origin":Self.localOrigin,"topOrigin":Self.localOrigin,"frame":"top","createdAt":ISO8601DateFormatter().string(from:Date())]
    localScopes[owner]=scope
    do{try protocols.navigation(owner:owner,scope:scope)}catch{localScopes.removeValue(forKey:owner);throw error}
    reply(["ok":true,"value":["ownerId":owner,"scope":scope]]);return
   }
   guard let owner=args["ownerId"] as? String,let scope=args["scope"] as? [String:String],localScopes[owner]==scope else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   if method=="local.close"{
    try permissionNeed(Set(args.keys)==["ownerId","scope"],"NATIVE_DENIED")
    localScopes.removeValue(forKey:owner);protocols.invalidate(owner:owner);reply(["ok":true,"value":NSNull()]);return
   }
   try permissionNeed(method=="local.deliver" && Set(args.keys)==["ownerId","scope","text"],"NATIVE_DENIED")
   guard let text=args["text"] as? String else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   reply(["ok":true,"value":protocols.allowDelivery(owner:owner,scope:scope,text:text)])
  }catch{reply(["ok":false,"code":"NATIVE_DENIED"])}
 }
 private func invalidateLocal(){
  let previous=localScopes;localScopes.removeAll()
  for (owner,scope) in previous{protocols.invalidate(owner:owner);notify(.standard,owner,scope,NSNull())}
 }
 private func notify(_ protocolId:NativeWalletProtocol,_ owner:String,_ scope:[String:String],_ snapshot:Any){
  var event:[String:Any]=["ownerId":owner,"scope":scope,"snapshot":snapshot]
  if protocolId != .standard{event["walletProtocol"]=protocolId.rawValue}
  channel.invokeMethod("authorityChanged",arguments:event)
 }
 private func invalidate(_ owner:String){protocols.invalidate(owner:owner)}
 func walletStateChanged(){
  guard !closed else{return}
  if accountSources.contains(where:{$0.value.current.chainId != $0.key}){webview.invalidateAll();invalidateLocal()}
  else{protocols.accountChanged()}
 }
 func suspendViews(){if !closed{webview.invalidateAll();invalidateLocal()}}
 func dispose(){guard !closed else{return};invalidateLocal();closed=true;webview.dispose();protocols.close();for r in broadcastRouters{r.close()};channel.setMethodCallHandler(nil)}
}
