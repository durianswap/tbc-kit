import Foundation
import CryptoKit

// Prepared is a business proposal, not permission to sign caller-provided
// digests. The private worker authenticates chain evidence and validates the
// Rust plan. Custody independently binds consent to that plan's exact bytes,
// dependencies, fees and deadline, using the existing transaction grant.
enum NativePrepared {
 static let sendMethods=["tbc_sendTransaction","tbc_sendPreparedTransaction","tbc_sendWorkflow","tbc_sendPreparedWorkflow"]
 static func sends(_ method:String)->Bool{sendMethods.contains(method)}
 static func prepared(_ method:String)->Bool{["tbc_signPreparedTransaction","tbc_sendPreparedTransaction"].contains(method)}
 static func transaction(_ method:String)->Bool{["tbc_signTransaction","tbc_sendTransaction"].contains(method) || prepared(method)}
 static func permission(_ method:String)->String{
  if NativeCrypto.methods.contains(method){return "tbc_crypto"}
  if NativeWorkflow.methods.contains(method){return "tbc_signWorkflow"}
  if method=="tbc_sendPreparedTransaction"{return "tbc_sendTransaction"}
  return ["tbc_signPreparedTransaction","tbc_signReviewedTransaction"].contains(method) ? "tbc_signTransaction":method
 }
 static func request(_ request:[String:Any],_ method:String)->[String:Any]{prepared(method) ? request.filter{$0.key != "proposal"}:request}
 private static func need(_ ok:Bool)throws{if !ok{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}}
 private static func map(_ value:Any?)throws->[String:Any]{guard let v=value as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")};return v}
 private static func hash(_ value:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(value).utf8)).map{String(format:"%02x",$0)}.joined()}
 private static func equal(_ a:Any?,_ b:Any?)throws->Bool{try PermissionJSON.canonical(a)==PermissionJSON.canonical(b)}
 private static func date(_ value:Any?)throws->Date{
  guard let value=value as? String else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  if let d=f.date(from:value){return d};f.formatOptions=[.withInternetDateTime]
  guard let d=f.date(from:value)else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")};return d
 }
 static func consent(_ request:[String:Any],now:Date=Date())throws->[String:Any]{
  let required:Set<String>=["version","chainId","from","intent","proposal"]
  try need(required.isSubset(of:Set(request.keys)) && Set(request.keys).isSubset(of:required.union(["clientRequestId","constraints","signingRoles"])))
  let proposal=try map(request["proposal"]),p=try map(proposal["payload"]),evidence=try map(p["evidence"])
  try need(Set(proposal.keys)==["payload","proposalHash"] && Set(p.keys)==["version","engineProfile","createdAt","expiresAt","intentHash","transactions","evidence","estimatedTotalFee"])
  try need(p["version"] as? String=="1.0" && p["engineProfile"] as? String=="tbc-engine-plan-v1" && proposal["proposalHash"] as? String==hash(p) && p["intentHash"] as? String==hash(request["intent"]))
  try need(date(p["createdAt"])<=date(p["expiresAt"]) && now<date(p["expiresAt"]) && equal(evidence["observedAt"],p["createdAt"]))
  return p
 }
 private struct Reader {
  let bytes:[UInt8];var offset=0
  init(_ raw:Any?)throws{
   guard let raw=raw as? String,raw.count%2==0,!raw.isEmpty,raw.allSatisfy({"0123456789abcdef".contains($0)})else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}
   let text=Array(raw.utf8);bytes=stride(from:0,to:text.count,by:2).map{UInt8(String(bytes:text[$0..<$0+2],encoding:.utf8)!,radix:16)!}
  }
  mutating func take(_ n:Int)throws->[UInt8]{try need(n>=0 && n<=bytes.count-offset);defer{offset+=n};return Array(bytes[offset..<offset+n])}
  mutating func uint(_ n:Int)throws->Int{try take(n).reversed().reduce(0){$0*256+Int($1)}}
  mutating func compact()throws->Int{
   let first=try uint(1);if first<253{return first};try need(first != 255)
   let v=try uint(first==253 ? 2:4);try need(v >= (first==253 ? 253:65536));return v
  }
  mutating func script()throws{let n=try compact();try need(n<=10000);_ = try take(n)}
 }
 // Bounded input-only inspection for native maintenance consent. Engine still
 // verifies the whole transaction; this adds no HTTP or normal-path parsing.
 static func inputOutpoints(_ raw:Any?)throws->[String]{
  var r=try Reader(raw);try need(r.uint(4)==10);let count=try r.compact();try need((1...1024).contains(count));var result=[String]()
  for _ in 0..<count{let tx=try r.take(32).reversed().map{String(format:"%02x",$0)}.joined(),vout=try r.uint(4);try r.script();_ = try r.take(4);result.append("\(tx):\(vout)")};return result
 }
 private static func transactions(_ value:Any?)throws->[[String:Any]]{
  guard let txs=value as? [[String:Any]],(1...32).contains(txs.count)else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}
  var known=Set<String>(),result=[[String:Any]]()
  for tx in txs{
   guard let id=tx["id"] as? String,let parents=tx["dependsOn"] as? [String]else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}
   try need(Set(parents).count==parents.count && parents.allSatisfy{known.contains($0)})
   var reader=try Reader(tx["unsignedTransaction"]);try need(reader.uint(4)==10)
   let count=try reader.compact();try need((1...10000).contains(count));var zeros=[[String:Any]]()
   for i in 0..<count{
    let previous=try reader.take(32),vout=try reader.uint(4);try reader.script();_ = try reader.take(4)
    if previous.allSatisfy({$0==0}){zeros.append(["inputIndex":i,"sourceOutputIndex":vout])}
   }
   let countOut=try reader.compact();try need((1...10000).contains(countOut))
   for _ in 0..<countOut{_ = try reader.take(8);try reader.script()};_ = try reader.take(4);try need(reader.offset==reader.bytes.count)
   let explicit=tx["deferredInputs"] as? [[String:Any]]
   try need(tx["deferredInputs"]==nil || explicit != nil)
   try need(explicit==nil ? zeros.count==parents.count:(!explicit!.isEmpty && explicit!.count==zeros.count))
   var edges=[[String:Any]](),used=Set<String>(),outputs=Set<String>()
   for (i,zero) in zeros.enumerated(){
    let edge=explicit?[i] ?? zero.merging(["sourceTransactionId":parents[i]]){_,new in new}
    guard let parent=edge["sourceTransactionId"] as? String else{throw NativeCustodyFailure(code:"NATIVE_PREPARED_BINDING")}
    try need(equal(edge["inputIndex"],zero["inputIndex"]) && equal(edge["sourceOutputIndex"],zero["sourceOutputIndex"]) && parents.contains(parent))
    try need(outputs.insert(parent+":"+(try PermissionJSON.canonical(edge["sourceOutputIndex"]))).inserted)
    used.insert(parent);edges.append(edge)
   }
   try need(used.count==parents.count && known.insert(id).inserted)
   var entry=["id":id,"role":tx["role"] as Any,"dependsOn":parents,"fee":tx["fee"] as Any] as [String:Any]
   if edges.isEmpty{entry["kind"]="fixed";entry["unsignedTransaction"]=tx["unsignedTransaction"]}
   else{entry["kind"]="deferred";entry["unsignedTransactionTemplate"]=tx["unsignedTransaction"];entry["deferredInputs"]=edges}
   result.append(entry)
  }
  return result
 }
 static func bind(_ proposal:[String:Any],plan:[String:Any],expiry:Date)throws{
  try need(expiry<=date(proposal["expiresAt"]) && Date()<date(proposal["expiresAt"]))
  try need(equal(proposal["transactions"],transactions(plan["transactions"])) && equal(proposal["estimatedTotalFee"],map(plan["preview"])["totalFee"]))
 }
}
