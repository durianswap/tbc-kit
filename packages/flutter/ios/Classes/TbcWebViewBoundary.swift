import Foundation
import UIKit
import WebKit

/// Native view/document source fence. Kit owns protocol validation and business
/// logic. The host must synchronously revoke native custody in onInvalidated;
/// an asynchronous Dart notification alone cannot fence a production Vault.
@MainActor final class TbcWebViewBoundary: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    enum Failure: Error { case closed, invalidPageResource }
    let attachment = TbcWebViewAttachment()
    private weak var view: WKWebView?
    private weak var previous: WKNavigationDelegate?
    private let pageSource: String
    private let allowInsecureLoopback: Bool
    private let onNavigation: ([String:String]) -> Void
    private let onMessage: (String,[String:Any]) -> Void
    private let onInvalidated: ([String:String]?) -> Void
    private var revision = UUID(), scope: [String:String]?
    private var disposed = false
    private let timeFormat: DateFormatter = {
        let value = DateFormatter()
        value.locale = Locale(identifier:"en_US_POSIX")
        value.calendar = Calendar(identifier:.gregorian)
        value.timeZone = TimeZone(secondsFromGMT:0)
        value.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        return value
    }()

    init(pageSource:String,allowInsecureLoopback:Bool = false,
         onNavigation:@escaping ([String:String])->Void,
         onMessage:@escaping (String,[String:Any])->Void,
         onInvalidated:@escaping ([String:String]?)->Void) throws {
        guard !pageSource.isEmpty,pageSource.utf8.count<=2*1024*1024 else {throw Failure.invalidPageResource}
        self.pageSource=pageSource;self.allowInsecureLoopback=allowInsecureLoopback
        self.onNavigation=onNavigation;self.onMessage=onMessage;self.onInvalidated=onInvalidated
    }

    /// Install markerSource at Flutter creation, mount a blank view, then attach
    /// and load the DApp. Do not attach after granting a page access to custody.
    func attach(in root:UIView) throws {
        guard !disposed,view==nil else {throw Failure.closed}
        let web=try attachment.attach(in:root)
        view=web;previous=web.navigationDelegate;web.navigationDelegate=self
        let content=web.configuration.userContentController
        content.add(self,name:"tbcKitNative")
        content.addUserScript(WKUserScript(source:pageSource,injectionTime:.atDocumentStart,forMainFrameOnly:true))
    }

    private func canonicalOrigin(scheme:String?,host:String?,port:Int?) -> String? {
        guard let scheme=scheme?.lowercased(),let host=host?.lowercased(),!host.isEmpty,
              host.unicodeScalars.allSatisfy({$0.isASCII}),
              scheme=="https" || (scheme=="http" && allowInsecureLoopback &&
                ["127.0.0.1","localhost","::1","[::1]"].contains(host)) else{return nil}
        let effective=port ?? (scheme=="https" ? 443 : 80)
        guard effective>=1 && effective<=65535 else{return nil}
        let authority=host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let suffix=effective==(scheme=="https" ? 443 : 80) ? "" : ":\(effective)"
        return "\(scheme)://\(authority)\(suffix)"
    }
    private func origin(_ url:URL?) -> String? {
        guard let url,url.user==nil,url.password==nil else{return nil}
        return canonicalOrigin(scheme:url.scheme,host:url.host,port:url.port)
    }
    private func origin(_ value:WKSecurityOrigin) -> String? {
        canonicalOrigin(scheme:value.protocol,host:value.host,port:value.port==0 ? nil : value.port)
    }
    private func quote(_ value:Any) -> String? {
        guard let bytes=try? JSONSerialization.data(withJSONObject:value,options:[.fragmentsAllowed]) else{return nil}
        return String(data:bytes,encoding:.utf8)
    }
    func isCurrent(_ expected:[String:String])->Bool {
        guard let web=view else{return false};return current(expected,web)
    }
    private func current(_ expected:[String:String],_ web:WKWebView) -> Bool {
        !disposed && attachment.owns(web) && view===web && web.navigationDelegate===self &&
          scope==expected && origin(web.url)==expected["origin"]
    }

    /// Also call on native lock/account/network changes, before key access can
    /// run on another executor. A new document/session requires a fresh reload.
    func invalidate() {
        let old=scope;scope=nil;revision=UUID()
        onInvalidated(old)
        if let old,let web=view,let token=old["navigationId"],let q=quote(token) {
            web.evaluateJavaScript("window.__tbcFlutterPage && window.__tbcFlutterPage.close(\(q))",completionHandler:nil)
        }
    }
    /// A delayed Dart cleanup for the previous document cannot close its successor.
    @discardableResult func invalidate(expected:[String:String]) -> Bool {
        guard !disposed,scope==expected else{return false}
        invalidate();return true
    }
    func dispose() {
        guard !disposed else{return}
        invalidate();disposed=true;attachment.close()
        if let web=view {
            web.configuration.userContentController.removeScriptMessageHandler(forName:"tbcKitNative")
            if web.navigationDelegate===self {web.navigationDelegate=previous}
        }
        view=nil;previous=nil
    }
    override func responds(to selector:Selector!) -> Bool {
        super.responds(to:selector) || previous?.responds(to:selector)==true
    }
    override func forwardingTarget(for selector:Selector!) -> Any? {
        previous?.responds(to:selector)==true ? previous : super.forwardingTarget(for:selector)
    }
    private func navigationWillChange(_ action:WKNavigationAction) {
        guard action.targetFrame?.isMainFrame==true else{return}
        // Same-document fragment changes do not alter origin/document authority.
        if let before=view?.url,let after=action.request.url,before != after,
           var a=URLComponents(url:before,resolvingAgainstBaseURL:false),
           var b=URLComponents(url:after,resolvingAgainstBaseURL:false) {
            a.fragment=nil;b.fragment=nil
            if a==b {return}
        }
        invalidate()
    }
    func webView(_ web:WKWebView,decidePolicyFor action:WKNavigationAction,
                 decisionHandler:@escaping @MainActor (WKNavigationActionPolicy)->Void) {
        navigationWillChange(action)
        if previous?.webView?(web,decidePolicyFor:action,decisionHandler:decisionHandler)==nil {decisionHandler(.allow)}
    }
    @available(iOS 13.0, *)
    func webView(_ web:WKWebView,decidePolicyFor action:WKNavigationAction,preferences:WKWebpagePreferences,
                 decisionHandler:@escaping @MainActor (WKNavigationActionPolicy,WKWebpagePreferences)->Void) {
        navigationWillChange(action)
        if previous?.webView?(web,decidePolicyFor:action,preferences:preferences,decisionHandler:decisionHandler)==nil {
            // Preserve delegates implementing only the older policy overload.
            if previous?.webView?(web,decidePolicyFor:action,decisionHandler:{decisionHandler($0,preferences)})==nil {
                decisionHandler(.allow,preferences)
            }
        }
    }
    func webView(_ web:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!) {
        invalidate();previous?.webView?(web,didStartProvisionalNavigation:navigation)
    }
    func webView(_ web:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) {
        invalidate();previous?.webView?(web,didFailProvisionalNavigation:navigation,withError:error)
    }
    func webView(_ web:WKWebView,didFail navigation:WKNavigation!,withError error:Error) {
        invalidate();previous?.webView?(web,didFail:navigation,withError:error)
    }
    func webViewWebContentProcessDidTerminate(_ web:WKWebView) {
        invalidate();previous?.webViewWebContentProcessDidTerminate?(web)
    }
    func webView(_ web:WKWebView,didFinish navigation:WKNavigation!) {
        invalidate()
        if !disposed,attachment.owns(web),web.navigationDelegate===self,let origin=origin(web.url),let url=web.url?.absoluteString {
            let token=UUID().uuidString,captured=revision
            let next=["webViewInstanceId":attachment.instanceId,"sessionId":UUID().uuidString,"navigationId":token,
                      "committedUrl":url,"origin":origin,"topOrigin":origin,"frame":"top","createdAt":timeFormat.string(from:Date())]
            web.evaluateJavaScript("window.__tbcFlutterPage && window.__tbcFlutterPage.arm(\(quote(token)!))") { [weak self,weak web] value,error in
                guard let self,let web,!self.disposed,self.revision==captured,self.attachment.owns(web),
                      web.navigationDelegate===self,self.origin(web.url)==origin,error==nil,value as? Bool==true else{return}
                self.scope=next;self.onNavigation(next)
            }
        }
        previous?.webView?(web,didFinish:navigation)
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
        guard let web=view,let scope,current(scope,web),message.webView===web,message.frameInfo.isMainFrame,
              origin(message.frameInfo.securityOrigin)==scope["origin"],
              let text=message.body as? String,text.utf8.count<=8*1024*1024,
              let bytes=text.data(using:.utf8),let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],
              value.count==2,value["epoch"] as? String==scope["navigationId"],
              let serialized=value["serialized"] as? String,serialized.utf8.count<=4*1024*1024 else{return}
        // No page-provided source, account, origin or session fields are used.
        let source:[String:Any]=["webViewInstanceId":attachment.instanceId,"sessionId":scope["sessionId"]!,
          "navigationId":scope["navigationId"]!,"origin":scope["origin"]!,"topOrigin":scope["origin"]!,"isMainFrame":true]
        onMessage(serialized,source)
    }

    /// Only native callbacks may call these; each completion checks the same
    /// document again, and the page rejects delivery to a different document.
    func deliver(_ serialized:String,expected:[String:String],done:@escaping (Bool)->Void) {
        guard serialized.utf8.count<=4*1024*1024 else{done(false);return}
        evaluate("receive",argument:serialized,expected:expected,done:done)
    }
    func deliverLegacy(_ serialized:String,expected:[String:String],done:@escaping (Bool)->Void) {
        guard serialized.utf8.count<=4*1024*1024 else{done(false);return}
        evaluate("receiveLegacy",argument:serialized,expected:expected,done:done)
    }
    func describe(_ descriptor:[String:Any],expected:[String:String],done:@escaping (Bool)->Void) {
        evaluate("describe",argument:descriptor,expected:expected,done:done)
    }
    private func evaluate(_ method:String,argument:Any,expected:[String:String],done:@escaping (Bool)->Void) {
        guard let web=view,current(expected,web),let token=expected["navigationId"],
              let q=quote(token),let body=quote(argument) else{done(false);return}
        let captured=revision
        web.evaluateJavaScript("window.__tbcFlutterPage && window.__tbcFlutterPage.\(method)(\(q),\(body))") { [weak self,weak web] value,error in
            guard let self,let web,self.revision==captured,self.current(expected,web),error==nil,value as? Bool==true else{done(false);return}
            done(true)
        }
    }
}
