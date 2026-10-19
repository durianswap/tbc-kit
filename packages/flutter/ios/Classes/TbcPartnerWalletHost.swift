import Flutter
import Foundation
import UIKit

/// Registration only. Does not install an account, approve, unlock or sign.
public final class TbcDartKitPlugin:NSObject,FlutterPlugin {
 public static func register(with registrar:FlutterPluginRegistrar) {
  let channel=FlutterMethodChannel(name:"io.tbc.kit.dart/package",binaryMessenger:registrar.messenger())
  channel.setMethodCallHandler{call,result in
   guard call.method=="computeArtifact",call.arguments==nil else{result(FlutterMethodNotImplemented);return}
   do{
    let (_,manifest)=try resources()
    guard let p=Bundle.main.url(forResource:"tbc-dart-native-pins",withExtension:"json"),
          let pins=try JSONSerialization.jsonObject(with:Data(contentsOf:p)) as? [String:String],
          pins["artifactId"]==manifest["artifactId"] as? String,
          let hash=pins["engineSha256"],hash.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,
          let frameworks=Bundle.main.privateFrameworksPath else{throw PermissionFailure(code:"PACKAGE_PINS")}
    result(["path":frameworks+"/TbcFlutterEngine.framework/TbcFlutterEngine","sha256":hash])
   }catch{result(FlutterError(code:"PACKAGE_PINS",message:"Run the supplied iOS build integration step",details:nil))}
  }
 }
 fileprivate static func resources()throws->(Bundle,[String:Any]){
  let module=Bundle(for:TbcDartKitPlugin.self)
  guard let url=module.url(forResource:"TbcDartKit",withExtension:"bundle"),let resources=Bundle(url:url),
        let manifestURL=resources.url(forResource:"distribution",withExtension:"json"),
        let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:manifestURL)) as? [String:Any] else{throw PermissionFailure(code:"PACKAGE_RESOURCES")}
  return(resources,manifest)
 }
}

/// Wallet-selected configuration, never constructed from a WebView message.
@MainActor public struct TbcPartnerNetwork {
 fileprivate let source:NativeBroadcastConfiguration
 fileprivate let accounts:NativeAccountSource
 fileprivate let approval:NativeApprovalPresenter
 fileprivate let signer:NativeDigestSigner
 fileprivate let crypto:NativeBie1Executor?
 fileprivate let enableBroadcast:Bool
 public init(network:String,accounts:NativeAccountSource,approval:NativeApprovalPresenter,
             signer:NativeDigestSigner,crypto:NativeBie1Executor?=nil,enableBroadcast:Bool=true,
             apiOrigin:String?=nil,trustId:String?=nil,rpcOrigin:String?=nil)throws{
  source=try NativeBroadcastConfiguration(network:network,apiOrigin:apiOrigin,trustId:trustId,rpcOrigin:rpcOrigin)
  self.accounts=accounts;self.approval=approval;self.signer=signer;self.crypto=crypto;self.enableBroadcast=enableBroadcast
 }
}

/// Own one instance per Flutter engine. UI and Vault callbacks stay wallet-owned.
/// Uses the existing verified host; this is not a second execution path.
@MainActor public final class TbcPartnerWalletHost {
 private let host:TbcDartWalletHost
 private let stores:[SystemPermissionBackend]
 private var disposed=false
 public init(messenger:FlutterBinaryMessenger,root:UIView,profile:String,
             network:TbcPartnerNetwork,additionalNetworks:[TbcPartnerNetwork]=[],legacy:Bool=true)throws{
  let (resources,manifest)=try TbcDartKitPlugin.resources()
  guard let page=resources.url(forResource:"tbc-webview-page",withExtension:"js"),
        let pageHash=manifest["pageSha256"] as? String else{throw PermissionFailure(code:"PACKAGE_RESOURCES")}
  let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("tbc-kit",isDirectory:true)
  var backends=[SystemPermissionBackend]()
  func lane(_ n:TbcPartnerNetwork)throws->NativeWalletNetwork{
   let standard=try SystemPermissionBackend(profile:profile,chain:n.source.chainId,directory:directory)
   backends.append(standard)
   let old=legacy ? try SystemPermissionBackend(profile:profile,chain:n.source.chainId,directory:directory,walletProtocol:.legacy):nil
   if let old{backends.append(old)}
   return NativeWalletNetwork(source:n.source,accounts:n.accounts,backend:standard,approval:n.approval,signer:n.signer,
    crypto:n.crypto,broadcastDirectory:n.enableBroadcast ? directory:nil,broadcastProfile:n.enableBroadcast ? profile:nil,legacyBackend:old)
  }
  let primary=try lane(network),additional=try additionalNetworks.map{try lane($0)}
  host=try TbcDartWalletHost(messenger:messenger,root:root,pageResource:page,expectedPageSHA256:pageHash,
   accounts:primary.accounts,chain:primary.source.chainId,backend:primary.backend,approval:primary.approval,signer:primary.signer,
   crypto:primary.crypto,broadcast:primary.broadcastDirectory==nil ? nil:primary.source,
   broadcastDirectory:primary.broadcastDirectory,broadcastProfile:primary.broadcastProfile,networkSource:primary.source,
   additionalNetworks:additional,legacyBackend:primary.legacyBackend)
  stores=backends
 }
 public func walletStateChanged(){host.walletStateChanged()}
 public func suspendViews(){host.suspendViews()}
 public func dispose(){guard !disposed else{return};disposed=true;host.dispose();for store in stores{store.close()}}
}
