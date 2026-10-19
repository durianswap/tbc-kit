import Foundation

// Host-only binding strategy with the real shared native normalizer.
// Still not proof of native approval, Vault execution, delivery or devices.
private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func date(_ v:Any?)->Date{let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f.date(from:v as! String)!}
@main struct WorkflowBindingCheck {
 static func run(_ s:[String:Any])throws->NativeWorkflow.Binding{
  let a=map(s["account"]),account=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String)
  let extra=(s["accounts"] as! [[String:Any]]).dropFirst().map{NativeAccount(address:$0["address"] as! String,publicKey:$0["publicKey"] as! String,chainId:$0["chainId"] as! String)}
  return try NativeWorkflow.bind(method:s["method"] as! String,request:map(s["request"]),context:map(s["context"]),account:account,accounts:extra,plan:map(s["plan"]),preview:map(s["preview"]),binding:map(s["binding"]),reviews:s["reviews"] as! [String:[String:Any]],now:date(s["now"]))
 }
 static func main()throws{
  let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),good=root["valid"] as! [[String:Any]],bad=root["invalid"] as! [[String:Any]]
  var checks=0
  for s in good{
   let b=try run(s)
   let same=try PermissionJSON.canonical(b.plan)==PermissionJSON.canonical(s["plan"]);precondition(same);checks+=1
   precondition(b.children.count==(map(s["request"])["steps"] as! [Any]).count);checks+=1
   precondition(b.requiredPermissions==Set(s["permissions"] as! [String]));checks+=1
  }
  for entry in bad{
   var rejected=false;do{_ = try run(map(entry["sample"]))}catch{rejected=true}
   precondition(rejected,"accepted invalid \(entry["label"]!)");checks+=1
  }
  print("{\"status\":\"PASS\",\"cases\":\(good.count),\"negativeCases\":\(bad.count),\"checks\":\(checks),\"proof\":\"host-binding-strategy-only\"}")
 }
}
