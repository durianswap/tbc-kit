import Flutter
import Foundation
import UIKit
import CryptoKit

/// One Flutter engine and its explicit app-owned view root. Keep this object
/// alive with that engine and call dispose before detaching it. No global-window
/// lookup, private WebView-plugin API or page-controlled view identity is used.
/// invalidateCustody MUST atomically fence that owner's native key operations;
/// the subsequent Dart event is notification, not the production Vault fence.
@MainActor public final class TbcFlutterWebViewHost {
    public enum Failure: Error { case invalidPageResource }
    private weak var root:UIView?
    private let channel:FlutterMethodChannel
    private let pageSource:String,allowInsecureLoopback:Bool
    private let supportsLegacyPage:Bool
    private let invalidateCustody:(String,[String:String]?)->Void
    private let verifiedNavigation:(String,[String:String])->Void
    private let allowDelivery:(String,[String:String],String)->Bool
    private let allowLegacyDelivery:(String,[String:String],String)->Bool
    private var owners=[String:TbcWebViewBoundary]()
    private var closed=false

    public init(messenger:FlutterBinaryMessenger,root:UIView,pageResource:URL,
                expectedPageSHA256:String,allowInsecureLoopback:Bool=false,
                invalidateCustody:@escaping (String,[String:String]?)->Void,
                verifiedNavigation:@escaping (String,[String:String])->Void,
                allowDelivery:@escaping (String,[String:String],String)->Bool,
                allowLegacyDelivery:@escaping (String,[String:String],String)->Bool = {_,_,_ in false}) throws {
        let bytes=try Data(contentsOf:pageResource)
        let digest=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()
        guard bytes.count>0,bytes.count<=2*1024*1024,digest==expectedPageSHA256,
              let source=String(data:bytes,encoding:.utf8) else{throw Failure.invalidPageResource}
        self.root=root;pageSource=source;self.allowInsecureLoopback=allowInsecureLoopback
        self.supportsLegacyPage=source.range(of:"/\\* tbc-dart-legacy-page:[0-9a-f]{64} \\*/",options:.regularExpression) != nil
        self.invalidateCustody=invalidateCustody;self.verifiedNavigation=verifiedNavigation;self.allowDelivery=allowDelivery;self.allowLegacyDelivery=allowLegacyDelivery
        channel=FlutterMethodChannel(name:"io.tbc.kit.dart/private-webview",binaryMessenger:messenger)
        channel.setMethodCallHandler{[weak self] call,result in
            guard let self else{result(FlutterError(code:"WEBVIEW_CLOSED",message:nil,details:nil));return}
            self.handle(call,result:result)
        }
    }
    /// Native lock/account/network events call this before another key operation.
    /// Existing owners can navigate again, but each new document needs new grants.
    public func isCurrent(owner:String,expected:[String:String])->Bool {
        !closed && owners[owner]?.isCurrent(expected)==true
    }
    public func invalidateAll(){for owner in Array(owners.values){owner.invalidate()}}
    public func dispose(){
        guard !closed else{return}
        closed=true
        let previous=Array(owners.values)
        owners.removeAll()
        for owner in previous{owner.dispose()}
        channel.setMethodCallHandler(nil)
    }
    private func event(_ owner:String,_ type:String,_ body:[String:Any]){
        guard !closed,owners[owner] != nil else{return}
        channel.invokeMethod("event",arguments:["ownerId":owner,"type":type,"body":body])
    }
    private func handle(_ call:FlutterMethodCall,result:@escaping FlutterResult){
        guard !closed,let root else{result(FlutterError(code:"WEBVIEW_CLOSED",message:nil,details:nil));return}
        guard let args=call.arguments as? [String:Any] else{result(FlutterError(code:"WEBVIEW_INVALID_INPUT",message:nil,details:nil));return}
        do{
            if call.method=="create"{
                guard args.isEmpty,owners.count<8 else{throw TbcWebViewBoundary.Failure.closed}
                let id=UUID().uuidString
                let owner=try TbcWebViewBoundary(pageSource:pageSource,allowInsecureLoopback:allowInsecureLoopback,
                    onNavigation:{[weak self] scope in
                        self?.verifiedNavigation(id,scope);self?.event(id,"navigation",scope)},
                    onMessage:{[weak self] text,source in self?.event(id,"message",["serialized":text,"source":source])},
                    onInvalidated:{[weak self] scope in
                        guard let self else{return}
                        // Native fence is synchronous even when Dart is busy or gone.
                        self.invalidateCustody(id,scope)
                        self.event(id,"invalidated",["navigation":scope as Any? ?? NSNull()])
                    })
                owners[id]=owner
                result(["ownerId":id,"webViewInstanceId":owner.attachment.instanceId,
                        "markerSource":owner.attachment.markerSource,"legacyPageSupported":supportsLegacyPage]);return
            }
            guard let id=args["ownerId"] as? String,let owner=owners[id] else{throw TbcWebViewBoundary.Failure.closed}
            switch call.method{
            case "attach":
                guard args.count==1 else{throw TbcWebViewBoundary.Failure.closed}
                do{try owner.attach(in:root);result(true)}catch TbcWebViewAttachment.Failure.missing{result(false)}
            case "dispose":
                guard args.count==1 else{throw TbcWebViewBoundary.Failure.closed}
                owner.dispose();owners.removeValue(forKey:id);result(nil)
            case "close","deliver","deliverLegacy","describe":
                let delivery=call.method=="deliver" || call.method=="deliverLegacy"
                let keys:Set<String>=call.method=="close" ? ["ownerId","expected"] : ["ownerId","expected",delivery ? "serialized" : "descriptor"]
                guard Set(args.keys)==keys,let expected=args["expected"] as? [String:String],
                      Set(expected.keys)==Set(["webViewInstanceId","sessionId","navigationId","committedUrl","origin","topOrigin","frame","createdAt"]),
                      expected["webViewInstanceId"]==owner.attachment.instanceId else{throw TbcWebViewBoundary.Failure.closed}
                if call.method=="close"{result(owner.invalidate(expected:expected));return}
                if delivery{
                    guard let text=args["serialized"] as? String else{throw TbcWebViewBoundary.Failure.closed}
                    let allowed=call.method=="deliverLegacy" ? allowLegacyDelivery(id,expected,text):allowDelivery(id,expected,text)
                    guard allowed else{result(false);return}
                    if call.method=="deliverLegacy" {owner.deliverLegacy(text,expected:expected,done:result)}
                    else {owner.deliver(text,expected:expected,done:result)}
                }else{
                    guard let descriptor=args["descriptor"] as? [String:Any] else{throw TbcWebViewBoundary.Failure.closed}
                    owner.describe(descriptor,expected:expected,done:result)
                }
            default:result(FlutterError(code:"WEBVIEW_UNSUPPORTED_OPERATION",message:nil,details:nil))
            }
        }catch{result(FlutterError(code:"WEBVIEW_OPERATION_FAILED",message:nil,details:nil))}
    }
}
