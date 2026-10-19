import Foundation
import CoreFoundation
import CryptoKit

// Constructed by the native wallet, never deserialized from a page/channel.
struct NativeBroadcastConfiguration {
 let chainId:String,sourceIdentity:String,apiOrigin:String
 init(network:String,apiOrigin:String?=nil,trustId:String?=nil,rpcOrigin:String?=nil)throws{
  let official=["mainnet":"https://api.turingbitchain.io","testnet":"https://api.tbcdev.org"]
  guard let base=official[network]else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_SOURCE")}
  self.chainId="tbc:"+network;self.apiOrigin=apiOrigin ?? base
  if apiOrigin==nil{try permissionNeed(trustId==nil && rpcOrigin==nil,"NATIVE_BROADCAST_SOURCE")}
  else{try permissionNeed(trustId?.range(of:"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",options:.regularExpression) != nil,"NATIVE_BROADCAST_SOURCE")}
  for origin in [self.apiOrigin,rpcOrigin].compactMap({$0}){
   _ = try NativeBroadcastHTTPRequest.validated(sourceIdentity:String(repeating:"0",count:64),apiOrigin:origin,method:"POST",path:"/api/tbc/broadcasttx",body:"{}",deadline:Date())
   try permissionNeed(origin==origin.lowercased() && URLComponents(string:origin)?.port != 443 && origin != official[network=="mainnet" ? "testnet":"mainnet"],"NATIVE_BROADCAST_SOURCE")
  }
  var endpoint:[String:Any]=["kind":trustId==nil ? "official":"trusted-custom","apiOrigin":self.apiOrigin,"trustId":trustId ?? "official:\(network)"]
  if let rpcOrigin{endpoint["rpcOrigin"]=rpcOrigin}
  let value:[String:Any]=["version":"1.0","network":network,"chainId":chainId,"endpoint":endpoint]
  sourceIdentity=SHA256.hash(data:Data(try PermissionJSON.canonical(value).utf8)).map{String(format:"%02x",$0)}.joined()
 }
}

// Exact private Flutter commands. No exported raw sender or page URL/store
// selection. Shared Dart still owns REST response decoding and reconciliation.
@MainActor final class NativeBroadcastRouter {
 private let custody:NativeCustody,configuration:NativeBroadcastConfiguration,directory:URL,profile:String,send:NativeBroadcastDispatch.Sender
 private var stores=[String:SystemBroadcastStore](),entries=[String:NativeBroadcastDispatch](),closed=false
 init(custody:NativeCustody,configuration:NativeBroadcastConfiguration,directory:URL,profile:String,send:@escaping NativeBroadcastDispatch.Sender){self.custody=custody;self.configuration=configuration;self.directory=directory;self.profile=profile;self.send=send}
 private func need(_ b:Bool)throws{if !b{throw NativeCustodyFailure(code:"NATIVE_DENIED")}}
 private func map(_ x:Any?)throws->[String:Any]{guard let m=x as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return m}
 private func string(_ x:Any?)throws->String{guard let s=x as? String else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return s}
 private func identity(_ value:Any?)throws->NativeBroadcastIdentity{
  let m=try map(value);try need(Set(m.keys)==["idempotencyKey","rawHash","txid","submitContextHash","accountScopeHash"])
  return try NativeBroadcastIdentity(idempotencyKey:string(m["idempotencyKey"]),rawHash:string(m["rawHash"]),txid:string(m["txid"]),submitContextHash:string(m["submitContextHash"]),accountScopeHash:string(m["accountScopeHash"]))
 }
 private func ids(_ value:Any?)throws->[NativeBroadcastIdentity]{guard let list=value as? [Any],(1...32).contains(list.count)else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};return try list.map(identity)}
 private func record(_ row:NativeBroadcastRecord?)->Any{
  guard let r=row else{return NSNull()};let id=r.identity
  var m:[String:Any]=["idempotencyKey":id.idempotencyKey,"rawHash":id.rawHash,"txid":id.txid,"submitContextHash":id.submitContextHash,"accountScopeHash":id.accountScopeHash,"state":r.state,"createdAt":r.createdAt]
  if let result=r.result{m["result"]=result};return m
 }
 func dispatch(method:String,input:[String:Any],reply:@escaping @MainActor ([String:Any])->Void){
  var replied=false
  func answer(_ value:Any){if !replied{replied=true;reply(["ok":true,"value":value])}}
  func fail(_ code:String="NATIVE_DENIED"){if !replied{replied=true;reply(["ok":false,"code":code])}}
  do{
   try need(!closed)
   let owner=try string(input["ownerId"]),operation=try string(input["operation"]),receipt=try map(input["receipt"])
   guard let scope=input["scope"] as? [String:String]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   let index:Int?
   if input["index"] is NSNull{index=nil}
   else if let n=input["index"] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue==Double(n.intValue),(0..<32).contains(n.intValue){index=n.intValue}
   else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
   func keys(_ fields:String...)throws{try need(Set(input.keys)==Set(["ownerId","scope","operation","receipt","index"]+fields))}
   // Scope/receipt equality is rechecked by every attached adapter fence.
   let key=PermissionJSON.id("broadcast",owner,try PermissionJSON.canonical(scope),operation,index.map(String.init) ?? "batch")
   switch method{
   case "signing.broadcast.open":
    try keys("call");try need(entries[key]==nil && entries.count<128)
    let selected=try custody.broadcastSelection(owner:owner,scope:scope,id:operation,receipt:receipt,index:index)
    try need(selected["sourceIdentity"] as? String==configuration.sourceIdentity)
    let account=try string(selected["accountScopeHash"])
    let store:SystemBroadcastStore
    if let existing=stores[account]{store=existing}
    else{try need(stores.count<16);store=try SystemBroadcastStore(directory:directory,profile:profile,sourceIdentity:configuration.sourceIdentity,accountScopeHash:account);stores[account]=store}
    let adapter=try custody.makeBroadcastDispatch(owner:owner,scope:scope,id:operation,receipt:receipt,index:index,store:store,apiOrigin:configuration.apiOrigin,chainId:configuration.chainId,call:map(input["call"]),onClose:{[weak self] in self?.entries.removeValue(forKey:key)},send:send)
    entries[key]=adapter
    answer(["sourceIdentity":configuration.sourceIdentity,"accountScopeHash":account])
   case "signing.broadcast.guard":
    try keys("call");guard let a=entries[key]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    try current(owner,scope,operation,receipt)
    try a.guardCall(map(input["call"]));answer(true)
   case "signing.broadcast.journal":
    try keys("action","arguments");guard let a=entries[key]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    try current(owner,scope,operation,receipt)
    let args=try map(input["arguments"]),action=try string(input["action"])
    func shape(_ names:String...)throws{try need(Set(args.keys)==Set(names))}
    switch action{
    case "begin":try shape("identities");let r=try a.begin(ids(args["identities"]));answer(["created":r.created,"records":r.records.map(record)])
    case "read":try shape("key");answer(try record(a.read(string(args["key"]))))
    case "readByTxids":try shape("txids");guard let txids=args["txids"] as? [String]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")};answer(try a.readByTxids(txids).map{record($0)})
    case "admit":try shape("identities");try a.admit(ids(args["identities"]));answer(true)
    case "complete":try shape("identity","status");try a.complete(identity(args["identity"]),status:string(args["status"]));answer(true)
    case "abortPreflight":try shape("identity","code");try a.abortPreflight(identity(args["identity"]),code:string(args["code"]));answer(true)
    default:throw NativeCustodyFailure(code:"NATIVE_DENIED")
    }
   case "signing.broadcast.wire":
    try keys("method","url","body","deadline");guard let a=entries[key]else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    try current(owner,scope,operation,receipt)
    let text=try string(input["deadline"]),f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
    guard let deadline=f.date(from:text) ?? ISO8601DateFormatter().date(from:text)else{throw NativeCustodyFailure(code:"NATIVE_DENIED")}
    let body=input["body"] is NSNull ? nil:try string(input["body"])
    try a.wire(method:string(input["method"]),url:string(input["url"]),body:body,deadline:deadline){r in
     switch r{case .success(let value):answer(["statusCode":value.status,"body":value.body.base64EncodedString()])
     case .failure(let e):fail(["NODE_REQUEST_FAILED","NODE_RESPONSE_INVALID"].contains(e.code) ? e.code:"NODE_REQUEST_FAILED")}
    }
   default:throw NativeCustodyFailure(code:"NATIVE_DENIED")
   }
  }catch{fail()}
 }
 // Bind incoming channel receipt as well as the adapter's captured receipt.
 // Avoid returning/copying raw transactions on hot private-channel calls.
 private func current(_ owner:String,_ scope:[String:String],_ operation:String,_ receipt:[String:Any])throws{
  _ = try custody.broadcastAuthorization(owner:owner,scope:scope,id:operation,receipt:receipt)
 }
 func close(){guard !closed else{return};closed=true;let active=Array(entries.values);entries.removeAll();for a in active{a.close()};for s in stores.values{s.close()};stores.removeAll()}
}
