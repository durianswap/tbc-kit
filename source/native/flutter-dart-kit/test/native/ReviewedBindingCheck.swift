import Foundation
import CryptoKit

// Paired host proof only; frozen public stages are the independent oracle.
// No native Vault/key use, network, UI, or new Rust-compute adapter is claimed.
@MainActor private var checks=0
@MainActor private func yes(_ value:Bool){precondition(value,"reviewed check \(checks+1)");checks+=1}
@MainActor private func rejects(_ body:()throws->Void){var failed=false;do{try body()}catch{failed=true};yes(failed)}
private func map(_ value:Any?)->[String:Any]{value as! [String:Any]}
private func json(_ value:Any?)throws->String{try PermissionJSON.canonical(value)}
private func date(_ value:Any?)->Date{let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f.date(from:value as! String)!}
private func hash(_ value:Any?)throws->String{SHA256.hash(data:Data(try json(value).utf8)).map{String(format:"%02x",$0)}.joined()}

@main @MainActor struct ReviewedBindingCheck {
 static func main()throws{
  let document=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))))
  let samples=document["cases"] as! [[String:Any]]
  for s in samples{
   let request=map(s["request"]),context=map(s["context"]),a=map(s["account"]),audit=map(s["audit"]),plan=map(audit["plan"]),packet=map(s["packet"]),review=map(packet["review"]),preview=map(audit["preview"]),now=date(s["now"]),expiry=date(map(plan["payload"])["expiresAt"])
   let account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
   func bind(_ r:[String:Any]=request,_ c:[String:Any]=context,_ p:[String:Any]=plan,_ v:[String:Any]=preview,_ m:[String:Any]=packet,_ x:Date=expiry)throws->NativeReviewed.Bound{
    try NativeReviewed.bind(request:r,context:c,account:account,consent:review,plan:p,preview:v,packet:m,expiry:x,now:now)
   }
   yes(try json(NativeReviewed.normalize(map(request["request"])))==json(packet["material"]))
   yes(try json(NativeReviewed.consent(request:request,review:review,now:now))==json(review))
   let description=try NativeReviewed.description(review)
   yes(description.contains("no broadcast") && !description.contains("unlockingScriptTemplate") && !description.contains("sourceTransaction"))
   let b=try bind(),stages=s["stages"] as! [[String:Any]]
   yes(b.transactionCount==stages.count)
   yes(b.totalTasks==stages.reduce(0){$0+($1["tasks"] as! [Any]).count})
   for (index,item) in stages.enumerated(){
    let expected=map(item["prepare"]),stage=map(item["stage"])
    yes(try json(b.prepare(index:index,parents:expected["previousTransactions"] as! [String]))==json(expected))
    yes(try json(b.tasks(actual:stage,claimed:stage,index:index))==json(item["tasks"]))
    var changed=stage;changed["publicKey"]="03"+String(repeating:"00",count:32)
    rejects{_ = try b.tasks(actual:stage,claimed:changed,index:index)}
    rejects{_ = try b.tasks(actual:changed,claimed:changed,index:index)}
    rejects{_ = try b.prepare(index:stages.count,parents:[])}
   }
   var wrongContext=context;wrongContext["sessionId"]="other-document"
   rejects{_ = try bind(request,wrongContext)}
   var wrongRequest=request;wrongRequest["maxFee"]="0"
   rejects{_ = try bind(wrongRequest)}
   wrongRequest=request;wrongRequest["chainId"]="tbc:mainnet"
   rejects{_ = try bind(wrongRequest)}
   wrongRequest=request;wrongRequest["signingRoles"]=[]
   rejects{_ = try bind(wrongRequest)}
   var wrongPacket=packet;wrongPacket["policyMaterial"]=["resolvedOutputs":[]]
   rejects{_ = try bind(request,context,plan,preview,wrongPacket)}
   wrongPacket=packet;wrongPacket["material"]=["format":"raw","request":[:]]
   rejects{_ = try bind(request,context,plan,preview,wrongPacket)}
   var wrongPreview=preview;wrongPreview["totalFee"]="0"
   rejects{_ = try bind(request,context,plan,wrongPreview)}
   var wrongPlan=plan,payload=map(plan["payload"]),task=map(payload["task"]);task["requestHash"]=String(repeating:"00",count:32);payload["task"]=task;wrongPlan["payload"]=payload;wrongPlan["planHash"]=try hash(payload)
   rejects{_ = try bind(request,context,wrongPlan)}
   rejects{_ = try bind(request,context,plan,preview,packet,expiry.addingTimeInterval(1))}
   rejects{_ = try NativeReviewed.consent(request:request,review:review,now:expiry)}
   var inner=map(request["request"]);inner["privateKey"]="test-only-invalid"
   rejects{_ = try NativeReviewed.normalize(inner)}
  }
  for entry in document["normalizationCases"] as! [[String:Any]]{yes(try json(NativeReviewed.normalize(map(entry["request"])))==json(entry["material"]))}
  print("{\"status\":\"PASS\",\"checks\":\(checks),\"cases\":\(samples.count),\"scope\":\"native-binding-strategy-only\"}")
 }
}
