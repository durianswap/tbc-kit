import Foundation
import CoreFoundation
import CryptoKit

// Private data/binding strategy for NativeCustody, not another signing owner.
// No key, permission, approval, network, retry, journal or default compute hook.
// The owner must run the returned keyless request against pinned Rust off the UI
// executor, then repeat native authority checks before installing these tasks.
enum NativeReviewed {
 static let method="tbc_signReviewedTransaction"
 private static func need(_ ok:Bool)throws{if !ok{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")}}
 private static func map(_ value:Any?)throws->[String:Any]{guard let v=value as? [String:Any]else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return v}
 private static func rows(_ value:Any?,_ min:Int,_ max:Int)throws->[Any]{guard let v=value as? [Any],(min...max).contains(v.count)else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return v}
 private static func shape(_ value:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])throws{try need(required.isSubset(of:Set(value.keys)) && Set(value.keys).isSubset(of:required.union(optional)))}
 private static func canonical(_ value:Any?)throws->String{try PermissionJSON.canonical(value)}
 private static func equal(_ a:Any?,_ b:Any?)throws->Bool{try canonical(a)==canonical(b)}
 private static func hash(_ value:Any?)throws->String{SHA256.hash(data:Data(try canonical(value).utf8)).map{String(format:"%02x",$0)}.joined()}
 private static func owned(_ value:[String:Any])throws->[String:Any]{try map(JSONSerialization.jsonObject(with:Data(canonical(value).utf8)))}
 private static func text(_ value:Any?,_ pattern:String)throws->String{guard let s=value as? String,s.range(of:pattern,options:.regularExpression) != nil else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return s}
 private static func integer(_ value:Any?,_ max:Int=1000)throws->Int{
  guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=Double(max),n.doubleValue.rounded()==n.doubleValue else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return n.intValue
 }
 private static func amount(_ value:Any?)throws->Int{let s=try text(value,"^(0|[1-9][0-9]*)$");guard let n=Int(s),n<=9007199254740991 else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return n}
 private static func bytes(_ value:Any?)throws->String{let s=try text(value,"^(?:[0-9a-f]{2})+$");try need(s.count<=2097152);return s}
 private static func date(_ value:Any?)throws->Date{
  let s=try text(value,"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$")
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  if let d=f.date(from:s){return d};f.formatOptions=[.withInternetDateTime]
  guard let d=f.date(from:s)else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")};return d
 }
 private static func input(_ value:Any)throws->[String:Any]{
  let r=try map(value)
  try shape(r,["outputIndex","signingProfile"],["txid","satoshis","scriptPubKey","previousTransaction","ancestorTransactions","previousOutputContext","contractTransaction","contractVersion","unlockingScriptTemplate"])
  let profiles=["p2pkh":"p2pkh","ft":"tbc20","ft-contract":"tbc20_contract","contract-template":"other","tbc-lop-match":"tbc_lop_match","tbc20-standard":"tbc20-standard","tbc20-stablecoin":"tbc20-stablecoin"]
  guard let name=r["signingProfile"] as? String,let profile=profiles[name]else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_BINDING")}
  var out:[String:Any]=["outputIndex":try integer(r["outputIndex"],4294967295),"scriptSigType":profile]
  let current=["tbc20-standard","tbc20-stablecoin"].contains(profile)
  if current{
   try need(["previousOutputContext","contractTransaction","contractVersion","unlockingScriptTemplate"].allSatisfy{r[$0]==nil})
   if r["txid"] != nil{try need(["satoshis","scriptPubKey","previousTransaction","ancestorTransactions"].allSatisfy{r[$0] != nil})}
   else{try need(r["previousTransaction"]==nil)}
  }else{try need(r["ancestorTransactions"]==nil)}
  if let v=r["txid"]{out["txId"]=try text(v,"^[0-9a-f]{64}$")}
  if let v=r["satoshis"]{out["satoshis"]=try amount(v)}
  if let v=r["scriptPubKey"]{out["script"]=try bytes(v)}
  if let v=r["ancestorTransactions"]{let a=try rows(v,0,6).map{try bytes($0)};try need(Set(a).count==a.count);out["ancestorTransactions"]=a}
  for (key,target) in ["previousTransaction":"preTx","previousOutputContext":"prePreTxData","contractTransaction":"contractTx","unlockingScriptTemplate":"unfinishedScriptSig"]{if let v=r[key]{out[target]=try bytes(v)}}
  if let v=r["contractVersion"]{let n=try integer(v,3);try need(n>=1);out["ftVersion"]=n}
  return out
 }
 // Wire-to-Rust field projection only; chain recognition and full material
 // review stay in the shared worker. Rust checks actual input/raw matrices.
 static func normalize(_ value:[String:Any])throws->[String:Any]{
  try need(canonical(value).utf8.count<=4*1024*1024);try shape(value,["payload"])
  let p=try map(value["payload"])
  if p["format"] as? String=="raw"{
   try shape(p,["format","transactions"])
   var txs=[String](),amounts=[[Int]](),scripts=[[String]]()
   for value in try rows(p["transactions"],1,32){
    let tx=try map(value);try shape(tx,["rawTransaction","inputs"])
    var money=[Int](),locks=[String]()
    for value in try rows(tx["inputs"],1,1000){let r=try map(value);try shape(r,["satoshis","scriptPubKey"]);money.append(try amount(r["satoshis"]));locks.append(try bytes(r["scriptPubKey"]))}
    txs.append(try bytes(tx["rawTransaction"]));amounts.append(money);scripts.append(locks)
   }
   return ["format":"raw","request":["txraws":txs,"utxos_satoshis":amounts,"script_pubkeys":scripts]]
  }
  try need(p["format"] as? String=="associated");try shape(p,["format","sourceTransaction","sourceInputs","children"])
  var inputs=[[[String:Any]]](),outputs=[[[String:Any]]]()
  for value in try rows(p["children"],0,31){
   let c=try map(value);try shape(c,["inputs","outputs"])
   inputs.append(try rows(c["inputs"],1,1000).map{try input($0)})
   outputs.append(try rows(c["outputs"],0,1000).map{value in let r=try map(value);try shape(r,["satoshis","scriptPubKey"]);return ["satoshis":try amount(r["satoshis"]),"script":try bytes(r["scriptPubKey"])]})
  }
  return ["format":"associated","request":["sourceTxraw":try bytes(p["sourceTransaction"]),"sourceUtxos":try rows(p["sourceInputs"],0,1000).map{try input($0)},"inputs":inputs,"outputs":outputs]]
 }
 // Public review only: never render the request, normalized material, policy
 // proof or unlocking templates. The latter may include a private preimage.
 static func consent(request:[String:Any],review:[String:Any],now:Date=Date())throws->[String:Any]{
  try shape(request,["version","chainId","from","request"],["clientRequestId","maxFee","expiresAt"])
  try need(request["version"] as? String=="1.0");try shape(review,["payload","reviewHash"])
  let p=try map(review["payload"]);try shape(p,["expiresAt","policyMaterial","preview","totalFee"])
  let preview=try map(p["preview"])
  try need(review["reviewHash"] as? String==hash(p) && now<date(p["expiresAt"]))
  try need(preview["operationKind"] as? String=="transaction" && equal(preview["totalFee"],p["totalFee"]))
  _ = try amount(p["totalFee"])
  if let cap=request["maxFee"]{try need(amount(p["totalFee"])<=amount(cap))}
  if let expiry=request["expiresAt"]{try need(now<date(expiry))}
  return try owned(review)
 }
 static func description(_ consent:[String:Any])throws->String{
  let preview=try map(map(consent["payload"])["preview"])
  return "Reviewed transactions. Sign only; no broadcast.\n"+(try canonical(preview))
 }
 struct Bound {
  let material:[String:Any],policy:[String:Any],claimedStage:[String:Any],account:NativeAccount,planHash:String
  let transactionCount:Int,totalTasks:Int
  var associated:Bool{material["format"] as? String=="associated"}
  func prepare(index:Int,parents:[String])throws->[String:Any]{
   try need((0..<transactionCount).contains(index) && parents.count==(associated ? index:0))
   return ["format":material["format"]!,"request":material["request"]!,"publicKey":account.publicKey,"transactionIndex":index,"previousTransactions":parents,"resolvedOutputs":policy["resolvedOutputs"]!]
  }
  func tasks(actual:[String:Any],claimed:[String:Any],index:Int)throws->[[String:Any]]{
   try need(equal(actual,claimed) && actual["format"] as? String==material["format"] as? String && integer(actual["transactionIndex"],31)==index && actual["publicKey"] as? String==account.publicKey)
   let inputs=try rows(actual["inputs"],1,1000),indexes=try rows(actual["signingInputIndexes"],0,1000).map{try integer($0,999)},digests=try rows(actual["digests"],0,1000)
   try need(indexes.count==digests.count && Set(indexes).count==indexes.count && indexes.allSatisfy{$0<inputs.count})
   let selected=Set(indexes)
   for (i,value) in inputs.enumerated(){let r=try map(value);try need((r["signingPublicKey"]==nil || r["signingPublicKey"] is NSNull) && (r["signingRole"]==nil || r["signingRole"] is NSNull));try need(selected.contains(i) != (associated && r["scriptSigType"] as? String=="tbc_lop_match"))}
   return try zip(indexes,digests).map{vin,digest in
    ["taskId":"review-single-tx-\(index)-input-\(vin)","purpose":"transaction","algorithm":"secp256k1-ecdsa-sha256d","digest":try text(digest,"^[0-9a-f]{64}$"),"signatureEncoding":"compact64","sighashType":65,"transactionTemplateId":"review-tx-\(index)","inputIndex":vin,"accountId":account.accountId,"publicKey":account.publicKey]
   }
  }
 }
 // A workflow uses the same single-review schema and bind verifier. This is
 // only projection from already-owned consent, never another material reader.
 static func workflowPlan(request:[String:Any],context:[String:Any],account:NativeAccount,consent:[String:Any],expiresAt:String)throws->(plan:[String:Any],preview:[String:Any],packet:[String:Any]){
  let rp=try map(consent["payload"]),policy=try map(rp["policyMaterial"]),preview=try map(rp["preview"])
  let task:[String:Any]=["taskId":"review-single","purpose":"reviewedTransaction","contextHash":try hash(context),"requestHash":try hash(request["request"]),"reviewHash":consent["reviewHash"]!,"policyMaterial":policy,"chainId":account.chainId,"accountId":account.accountId,"publicKey":account.publicKey,"request":request["request"]!]
  let payload:[String:Any]=["requestHash":try hash(request),"contextHash":try hash(context),"chainId":account.chainId,"accountId":account.accountId,"expiresAt":expiresAt,"task":task,"preview":preview,"review":consent]
  // No caller stage is accepted here. NativeCustody computes it using pinned
  // Rust once, before issuing the parent receipt, then keeps the actual result.
  return (["payload":payload,"planHash":try hash(payload)],preview,["kind":"reviewed","material":try normalize(map(request["request"])),"policyMaterial":policy,"review":consent,"stage":[String:Any]()])
 }
 static func bind(request:[String:Any],context:[String:Any],account:NativeAccount,consent:[String:Any],plan:[String:Any],preview:[String:Any],packet:[String:Any],expiry:Date,now:Date=Date())throws->Bound{
  _ = try self.consent(request:request,review:consent,now:now)
  let material=try normalize(map(request["request"])),r=try map(material["request"]),rp=try map(consent["payload"]),policy=try map(rp["policyMaterial"])
  try need(request["chainId"] as? String==account.chainId && request["from"] as? String==account.address)
  try need(expiry>now && expiry<=date(rp["expiresAt"]))
  if let limit=request["expiresAt"]{try need(expiry<=date(limit))}
  try shape(plan,["payload","planHash"]);let p=try map(plan["payload"])
  try shape(packet,["kind","material","policyMaterial","review","stage"])
  try need(packet["kind"] as? String=="reviewed" && equal(packet["material"],material) && equal(packet["policyMaterial"],policy) && equal(packet["review"],consent))
  let task:[String:Any]=["taskId":"review-single","purpose":"reviewedTransaction","contextHash":try hash(context),"requestHash":try hash(request["request"]),"reviewHash":consent["reviewHash"]!,"policyMaterial":policy,"chainId":account.chainId,"accountId":account.accountId,"publicKey":account.publicKey,"request":request["request"]!]
  let expected:[String:Any]=["requestHash":try hash(request),"contextHash":try hash(context),"chainId":account.chainId,"accountId":account.accountId,"expiresAt":p["expiresAt"] as Any,"task":task,"preview":rp["preview"]!,"review":consent]
  try need(equal(p,expected) && plan["planHash"] as? String==hash(p) && equal(preview,rp["preview"]) && date(p["expiresAt"])==expiry)
  let matrix=material["format"] as? String=="raw" ? try rows(r["utxos_satoshis"],1,32):[r["sourceUtxos"]!]+(try rows(r["inputs"],0,31))
  var count=0
  for row in matrix{for input in try rows(row,0,1000){if try material["format"] as? String=="raw" || map(input)["scriptSigType"] as? String != "tbc_lop_match"{count+=1}}}
  try need((1...32000).contains(count) && integer(preview["transactionCount"],32)==matrix.count)
  _ = try rows(policy["resolvedOutputs"],0,32000)
  return Bound(material:material,policy:try owned(policy),claimedStage:try owned(map(packet["stage"])),account:account,planHash:try hash(p),transactionCount:matrix.count,totalTasks:count)
 }
}
