import Foundation
import CryptoKit

public enum NativeCryptoPurpose { case encrypt, decrypt }
// Explicit no-output availability failure, not a MAC error, lock or retry.
struct NativeCryptoUnavailable:Error {}
@MainActor public protocol NativeBie1Executor:AnyObject {
 // Wallet-private BIE1, not digest signing. Keys stay with the native Vault.
 // Recheck immediately at key use after any unlock; callback once on MainActor.
 // Input is borrowed until callback. Erase owned key/plaintext scratch on all
 // outcomes. No logs, retries, page registration or key-returning callback.
 func execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:[UInt8],
  requireCurrent:@escaping @MainActor ()throws->Void,
  complete:@escaping @MainActor (Result<[UInt8],Error>)->Void)
}

// Protocol projection only. Rust remains the BIE1/MAC/padding implementation.
enum NativeCrypto {
 static let methods:Set<String>=["tbc_encrypt","tbc_decrypt"]
 static let algorithm="tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1"
 private static func need(_ ok:Bool)throws{if !ok{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")}}
 private static func map(_ v:Any?)throws->[String:Any]{guard let m=v as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")};return m}
 private static func string(_ v:Any?)throws->String{guard let s=v as? String else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")};return s}
 private static func shape(_ r:[String:Any],_ keys:Set<String>,_ optional:Set<String>=[])throws{try need(keys.isSubset(of:Set(r.keys)) && Set(r.keys).isSubset(of:keys.union(optional)))}
 private static func equal(_ a:Any?,_ b:Any?)throws->Bool{try PermissionJSON.canonical(a)==PermissionJSON.canonical(b)}
 private static func hash(_ v:Any?)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
 static func time(_ v:Any?)throws->Date{
  let s=try string(v)
  try need(s.range(of:"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$",options:.regularExpression) != nil)
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  let expected=s.count==20 ? String(s.prefix(19))+".000Z":String(s.prefix(20))+String(s.dropFirst(20).dropLast()).padding(toLength:3,withPad:"0",startingAt:0)+"Z"
  guard let d=f.date(from:expected)else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")}
  try need(f.string(from:d)==expected);return d
 }
 private static func b64(_ v:Any?,min:Int,max:Int)throws->Data{
  let s=try string(v);try need((min...max).contains(s.utf8.count))
  try need(s.range(of:"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",options:.regularExpression) != nil)
  guard let d=Data(base64Encoded:s)else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")};return d
 }
 private static func message(_ v:Any?)throws->[UInt8]{
  let m=try map(v);try shape(m,["encoding","data"]);let s=try string(m["data"])
  switch m["encoding"] as? String{
  case "utf8":try need(s.utf8.count<=65536);return Array(s.utf8)
  case "hex":
   try need(!s.isEmpty && s.utf8.count<=131072 && s.range(of:"^(?:[0-9a-f]{2})+$",options:.regularExpression) != nil)
   let a=Array(s.utf8);return stride(from:0,to:a.count,by:2).map{UInt8(String(bytes:a[$0..<$0+2],encoding:.utf8)!,radix:16)!}
  case "base64":
   var data=try b64(s,min:0,max:87384)
   guard data.count<=65536 else{data.resetBytes(in:0..<data.count);throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")}
   return Array(data)
  default:throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")
  }
 }
 static func check(_ r:[String:Any],method:String,account:NativeAccount)throws{
  try need(methods.contains(method));let encrypt=method=="tbc_encrypt"
  try shape(r,["version","chainId","from","algorithm",encrypt ? "message":"ciphertext"],["clientRequestId","expiresAt"])
  try need(r["version"] as? String=="1.0" && r["algorithm"] as? String==algorithm && r["chainId"] as? String==account.chainId && r["from"] as? String==account.address)
  if let client=r["clientRequestId"]{try need((1...128).contains(string(client).unicodeScalars.count))}
  if let expiry=r["expiresAt"]{_ = try time(expiry)}
  // Discard this short-lived validation copy. The bounded native task is decoded
  // again only when consumed, never retained by a global cache.
  var bytes=try encrypt ? message(r["message"]):Array(b64(r["ciphertext"],min:116,max:174848))
  _ = bytes.withUnsafeMutableBytes{$0.initializeMemory(as:UInt8.self,repeating:0)}
 }
 static func description(_ r:[String:Any],method:String,account:NativeAccount)throws->String{
  try check(r,method:method,account:account)
  if let expiry=r["expiresAt"]{try need(time(expiry)>Date())}
  if method=="tbc_encrypt"{return "Encrypt with this account using existing BIE1. Return ciphertext to the requesting origin.\nMessage:\n"+(try PermissionJSON.canonical(r["message"]))}
  return "Decrypt BIE1 with this account. Return plaintext to the requesting origin.\nCiphertext commitment: "+(try hash(r["ciphertext"]))
 }
 static func task(_ r:[String:Any],method:String,context:[String:Any],account:NativeAccount,id:String)throws->[String:Any]{
  try check(r,method:method,account:account)
  let encrypt=method=="tbc_encrypt",field=encrypt ? "message":"ciphertext"
  return ["taskId":id,"purpose":encrypt ? "encrypt":"decrypt","algorithm":algorithm,"origin":context["origin"]!,"accountId":account.accountId,"publicKey":account.publicKey,field:r[field]!]
 }
 static func plan(_ r:[String:Any],method:String,context:[String:Any],account:NativeAccount,expiresAt:String)throws->[String:Any]{
  try check(r,method:method,account:account);_ = try time(expiresAt)
  if let expiry=r["expiresAt"]{try need(time(expiresAt)<=time(expiry))}
  let encrypt=method=="tbc_encrypt",purpose=encrypt ? "encrypt":"decrypt",field=encrypt ? "message":"ciphertext"
  let task=try self.task(r,method:method,context:context,account:account,id:"crypto-single")
  let preview:[String:Any]=["operationKind":"crypto","purpose":purpose,"algorithm":algorithm,field:r[field]!,"warnings":[String]()]
  let payload:[String:Any]=["requestHash":try hash(r),"contextHash":try hash(context),"chainId":account.chainId,"accountId":account.accountId,"expiresAt":expiresAt,"task":task,"preview":preview]
  return ["payload":payload,"planHash":try hash(payload)]
 }
 static func bound(request:[String:Any],method:String,context:[String:Any],account:NativeAccount,binding:[String:Any],plan supplied:[String:Any],preview:[String:Any])throws->[String:Any]{
  let p=try map(binding["payload"]),plan=try self.plan(request,method:method,context:context,account:account,expiresAt:string(p["expiresAt"])),body=try map(plan["payload"])
  let expected:[String:Any]=["version":"1.0","method":method,"operationKind":"crypto","contextHash":try hash(context),"origin":context["origin"]!,"sessionId":context["sessionId"]!,"chainId":account.chainId,"accountId":account.accountId,"requestHash":try hash(request),"operationHash":plan["planHash"]!,"expiresAt":p["expiresAt"]!]
  try need(equal(supplied,plan) && equal(preview,body["preview"]) && equal(binding,["payload":expected,"bindingHash":try hash(expected)]))
  return try map(body["task"])
 }
 static func input(_ task:[String:Any])throws->[UInt8]{
  try need(task["algorithm"] as? String==algorithm)
  if task["purpose"] as? String=="encrypt"{return try message(task["message"])}
  try need(task["purpose"] as? String=="decrypt");return Array(try b64(task["ciphertext"],min:116,max:174848))
 }
 static func result(_ task:[String:Any],output:[UInt8])throws->[String:Any]{
  let encrypt=task["purpose"] as? String=="encrypt",encoded=Data(output).base64EncodedString()
  if !encrypt && encoded.utf8.count>87384 {
   // Old UTF-8 requests were bounded by characters. Preserve their valid
   // plaintext through the existing UTF-8 result variant, never lossy decoding.
   try need(output.count<=131136)
   guard let text=String(bytes:output,encoding:.utf8) else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")}
   try need(text.unicodeScalars.count<=65536)
   return ["taskId":task["taskId"]!,"algorithm":algorithm,"message":["encoding":"utf8","data":text]]
  }
  try need((encrypt ? 116...174848:0...87384).contains(encoded.utf8.count))
  return ["taskId":task["taskId"]!,"algorithm":algorithm,encrypt ? "ciphertext":"message":encrypt ? encoded:["encoding":"base64","data":encoded] as Any]
 }
 static func publicResult(_ value:[String:Any],account:NativeAccount)->[String:Any]{
  var result:[String:Any]=["version":"1.0","chainId":account.chainId,"from":account.address,"algorithm":algorithm]
  if let c=value["ciphertext"]{result["ciphertext"]=c}else{result["message"]=value["message"]}
  return result
 }
}
