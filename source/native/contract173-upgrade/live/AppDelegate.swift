import Flutter
import UIKit
import CryptoKit

@main @objc class AppDelegate:FlutterAppDelegate {
 private var host:TbcDartWalletHost?
 override func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?)->Bool{
  GeneratedPluginRegistrant.register(with:self)
  let controller=window!.rootViewController as! FlutterViewController
  do{
   let wallet=try PrivateTestnetWallet(controller)
   let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("contract173-private-testnet")
   try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
   host=try TbcDartWalletHost(messenger:controller.binaryMessenger,root:controller.view,
    pageResource:Bundle.main.url(forResource:"tbc-webview-page",withExtension:"js")!,expectedPageSHA256:"9efa0a281e4de99f455fd2983e90db38836e8e9217e1dcf8aaee6c8a1d8f6a72",
    accounts:wallet,chain:wallet.current.chainId,backend:SystemPermissionBackend(profile:"contract173-live",chain:wallet.current.chainId,directory:directory),approval:wallet,signer:wallet,allowInsecureLoopback:true,
    broadcast:try NativeBroadcastConfiguration(network:"testnet",apiOrigin:"https://devapi.tbcdev.org",trustId:"contract173-live"),broadcastDirectory:directory,broadcastProfile:"contract173-live")
   FlutterMethodChannel(name:"io.tbc.dartkit/live-harness",binaryMessenger:controller.binaryMessenger).setMethodCallHandler{[weak self] call,result in
    do{
     switch call.method{
     case "paths":result(["engine":Bundle.main.privateFrameworksPath!+"/TbcFlutterEngine.framework/TbcFlutterEngine"])
     case "stats":result(wallet.stats())
     case "unlock":try wallet.unlock();self?.host?.walletStateChanged();result(wallet.current.identity)
     case "admitRun":
      let id=call.arguments as? String ?? ""
      try permissionNeed(id.range(of:"^[a-z0-9-]{1,100}$",options:.regularExpression) != nil,"RUN_ID")
      // Once admitted, crashes/errors require read-only reconciliation; no rerun.
      let url=directory.appendingPathComponent(id+".started.json")
      try Data(id.utf8).write(to:url,options:.withoutOverwriting);result(true)
     case "record":
      var report=call.arguments as! [String:Any];report["native"]=wallet.stats();report["pid"]=ProcessInfo.processInfo.processIdentifier
      let dest=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("live-report.json")
      try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]).write(to:dest,options:.atomic);result(nil)
     default:result(FlutterError(code:"HARNESS_METHOD",message:nil,details:nil))
     }
    }catch{result(FlutterError(code:(error as? PermissionFailure)?.code ?? "LIVE_HARNESS_DENIED",message:nil,details:nil))}
   }
  }catch{fatalError("Isolated private Testnet host unavailable")}
  return super.application(application,didFinishLaunchingWithOptions:options)
 }
 override func applicationWillResignActive(_ application:UIApplication){host?.suspendViews();super.applicationWillResignActive(application)}
}
