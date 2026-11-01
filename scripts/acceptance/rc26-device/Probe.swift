import UIKit
import WebKit
import Foundation

// Isolated public fixtures. No Vault, network or real submission adapter.
@main @MainActor
final class Probe: UIResponder, UIApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: UIWindow?
    var web: WKWebView!
    let engine = try! TbcEngine(expectedArtifactSetId: "0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    let keyless = try! TbcKeylessEngine(expectedArtifactSetId: "0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let config = WKWebViewConfiguration(); config.userContentController.add(self,name:"probe")
        web = WKWebView(frame:.zero,configuration:config); web.navigationDelegate = self
        let controller=UIViewController(); controller.view=web
        window=UIWindow(frame:UIScreen.main.bounds);window?.rootViewController=controller;window?.makeKeyAndVisible()
        let file=Bundle.main.url(forResource:"index",withExtension:"html")!
        web.loadFileURL(file,allowingReadAccessTo:file.deletingLastPathComponent())
        return true
    }
    func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)}
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        guard let data=message.body as? [String:Any],let kind=data["kind"] as? String else{return}
        if kind == "report" || kind == "progress" {
            if let text=data["text"] as? String {
                let url=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent(kind == "report" ? "report.json" : "progress.json")
                try? Data(text.utf8).write(to:url,options:.atomic)
            };return
        }
        guard kind == "call",let id=data["id"] as? String,let family=data["family"] as? String,let method=data["method"] as? String,let input=data["input"] as? String else{return}
        Task {
            do {
                let value:String
                if family == "fence" {
                    let params=try JSONSerialization.jsonObject(with:Data(input.utf8)) as! [String:Double]
                    var tick=0.0
                    let fence=NativeSessionFence(now:{tick})
                    try fence.replaceVerifiedScope(.init(origin:"https://controlled.example",navigationID:"document",accountID:"fixture-account",chainID:"tbc:testnet"))
                    let ticket=try fence.capture(timeoutSeconds:120,authorizationBound:true)
                    tick=params["elapsed"]! / 1000
                    try fence.check(ticket)
                    throw TbcEngineError.invalidEnvelope
                }
                else if family == "engine", let m=TbcEngineMethod(rawValue:method){value=try await engine.callEnvelope(m,canonicalInput:input)}
                else if family == "keyless",let m=TbcKeylessOperation(rawValue:method){value=try await keyless.callEnvelope(m,canonicalInput:input)}
                else{throw TbcEngineError.invalidEnvelope}
                complete(id,value,nil)
            }catch{complete(id,nil,"Native bridge failure: \(error)")}
        }
    }
    func complete(_ id:String,_ value:String?,_ error:String?){
        let args:[Any]=[id,value as Any? ?? NSNull(),error as Any? ?? NSNull()]
        let json=String(data:try! JSONSerialization.data(withJSONObject:args,options:[.fragmentsAllowed]),encoding:.utf8)!
        web.evaluateJavaScript("globalThis.__nativeComplete(...\(json))",completionHandler:nil)
    }
}
