import Foundation

private func map(_ v:Any?)->[String:Any]{v as! [String:Any]}
private func json(_ v:Any?)throws->String{try PermissionJSON.canonical(v)}
private func unhex(_ s:String)->[UInt8]{let b=Array(s.utf8);return stride(from:0,to:b.count,by:2).map{UInt8(String(bytes:b[$0..<$0+2],encoding:.utf8)!,radix:16)!}}
private func hex(_ b:[UInt8])->String{b.map{String(format:"%02x",$0)}.joined()}
@MainActor private var checks=0
@MainActor private func yes(_ b:Bool){precondition(b,"reviewed custody \(checks+1)");checks+=1}
@MainActor private func rejects(_ f:()throws->Void){var bad=false;do{try f()}catch{bad=true};yes(bad)}
@MainActor private final class Accounts:NativeAccountSource{
 let current:NativeAccount;var revision:Int64=0;var unlocked=true
 init(_ a:NativeAccount){current=a}
}
@MainActor private final class Store:NativePermissionBackend{
 var value=[String:PermissionSnapshot](),writes=0
 func loadAll()throws->[String:PermissionSnapshot]{value}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();precondition((value[origin]?.revision ?? 0)==expected);let v=PermissionSnapshot(revision:expected+1,records:records);value[origin]=v;writes+=1;return PermissionCommitResult(acknowledgedRevision:v.revision,current:v)
 }
}
@MainActor private final class UI:NativeApprovalPresenter{
 var pending:(@MainActor (Bool)->Void)?,shown=0
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{shown+=1;pending=complete;return {self.pending=nil}}
 func choose(_ yes:Bool=true){let f=pending!;pending=nil;f(yes)}
}
@MainActor private final class Replay:NativeDigestSigner,NativeReviewedComputer{
 let stages:[[String:Any]];var calls=0,signs=0,hold=false,changed=false
 var release:(@MainActor ()->Void)?
 init(_ stages:[[String:Any]]){self.stages=stages}
 func call(method:String,input:String,complete:@escaping @MainActor (Result<String,Error>)->Void){
  calls+=1
  let work:@MainActor ()->Void={complete(Result{
   let a=map(try JSONSerialization.jsonObject(with:Data(input.utf8)))
   for row in self.stages{
    if try method=="prepareReviewedStage" && json(a) == json(row["prepare"]){
     var stage=map(row["stage"]);if self.changed{stage["publicKey"]="03"+String(repeating:"00",count:32)};return try json(stage)
    }
    if try method=="finalizeReviewedStage" && json(a) == json(["stage":row["stage"]!,"signatures":row["signatures"]!,"signatureEncoding":"compact64"]) {return try json(row["finalized"])}
   };throw NativeCustodyFailure(code:"UNKNOWN_COMPUTE_INPUT")
  })}
  if hold{release=work}else{work()}
 }
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){complete(Result{
  try requireCurrent();for row in stages{let tasks=row["tasks"] as! [[String:Any]];if let index=tasks.firstIndex(where:{$0["digest"] as? String==hex(digest)}){
   let task=tasks[index];precondition(task["accountId"] as? String==account.accountId && encoding=="compact64");signs+=1;return unhex((row["signatures"] as! [String])[index])
  }};throw NativeCustodyFailure(code:"UNKNOWN_DIGEST")
 })}
}
@MainActor private final class Harness{
 let s:[String:Any],a:NativeAccount,accounts:Accounts,store=Store(),ui=UI(),replay:Replay,c:NativeCustody,context:[String:Any],scope:[String:String]
 var packet:[String:Any]{map(s["packet"])};var audit:[String:Any]{map(s["audit"])}
 init(_ s:[String:Any])throws{
  self.s=s;let a=map(s["account"]);self.a=NativeAccount(address:a["address"] as! String,publicKey:a["publicKey"] as! String,chainId:a["chainId"] as! String);accounts=Accounts(self.a)
  replay=Replay(s["stages"] as! [[String:Any]]);context=map(s["context"])
  var scope=context.filter{$0.key != "transport"}.mapValues{$0 as! String};scope["webViewInstanceId"]="native-reviewed";scope["committedUrl"]=(context["origin"] as! String)+"/dapp";self.scope=scope
  c=try NativeCustody(accounts:accounts,chain:self.a.chainId,backend:store,approval:ui,signer:replay,reviewedComputer:replay){owner,value in owner=="v" && value==scope}
  try c.navigation(owner:"v",scope:scope)
 }
 func consent(_ approve:Bool=true)throws{
  var grant:Result<[[String:Any]],Error>?
  try c.requestPermissions(owner:"v",scope:scope,id:"grant",request:["tbc_accounts":["chains":[a.chainId]],"tbc_signTransaction":["chains":[a.chainId]]]){grant=$0};ui.choose();_ = try grant!.get()
  _ = try c.begin(owner:"v",scope:scope,id:"op",method:NativeReviewed.method,expectedRevision:c.snapshot(owner:"v",scope:scope).revision,expectedAccount:a)
  var answer:Result<Bool,Error>?
  try c.consent(owner:"v",scope:scope,id:"op",method:NativeReviewed.method,request:map(s["request"]),context:context,review:map(packet["review"])){answer=$0};ui.choose(approve);yes(try answer!.get()==approve)
 }
 func bind(_ done:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  try c.bindReviewed(owner:"v",scope:scope,id:"op",binding:map(audit["binding"]),preview:map(audit["preview"]),plan:map(audit["plan"]),packet:packet,complete:done)
 }
 func ready()throws->[String:Any]{try consent();var receipt:Result<[String:Any],Error>?;try bind{receipt=$0};return try receipt!.get()}
 func pending(_ index:Int)->[String:Any]{let rows=s["stages"] as! [[String:Any]];return ["kind":"reviewed","planHash":map(audit["plan"])["planHash"]!,"stageIndex":index,"previousTransactions":rows.prefix(index).map{map($0["finalized"])["txraw"]!},"stage":rows[index]["stage"]!,"signingRequests":rows[index]["tasks"]!]}
 func sign(_ index:Int,_ receipt:[String:Any])throws{
  let row=(s["stages"] as! [[String:Any]])[index]
  for (i,task) in (row["tasks"] as! [[String:Any]]).enumerated(){var signed:Result<[String:Any],Error>?;try c.sign(owner:"v",scope:scope,id:"op",receipt:receipt,task:task){signed=$0};yes(try signed!.get()["signature"] as? String==(row["signatures"] as! [String])[i])}
 }
}
@main @MainActor struct ReviewedCustodyCheck{
 static func main()throws{
  let d=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))),samples=d["cases"] as! [[String:Any]]
  for s in samples{
   let h=try Harness(s),receipt=try h.ready(),rows=s["stages"] as! [[String:Any]]
   for i in rows.indices{if i>0{var result:Result<Bool,Error>?;try h.c.advanceReviewed(owner:"v",scope:h.scope,id:"op",receipt:receipt,pending:h.pending(i)){result=$0};yes(try result!.get())};try h.sign(i,receipt)}
   yes(h.ui.shown==2 && h.store.writes==1 && h.replay.calls==rows.count*2-1)
   rejects{try h.sign(0,receipt)}
   try h.c.close(owner:"v",scope:h.scope,id:"op");yes(h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"));h.accounts.unlocked=false;yes(!h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"))
  }
  let sample=samples[0]
  do{let h=try Harness(sample);try h.consent(false);rejects{try h.bind{_ in}};yes(h.replay.calls==0 && h.replay.signs==0)}
  do{let h=try Harness(sample);try h.consent();h.replay.hold=true;var answer:Result<[String:Any],Error>?;try h.bind{answer=$0};yes(answer==nil);try h.c.cancel(owner:"v",scope:h.scope,id:"op");yes(answer != nil);rejects{_ = try answer!.get()};h.replay.release!();yes(h.replay.signs==0 && !h.c.mayDeliverSignature(owner:"v",scope:h.scope,id:"op"))}
  do{let h=try Harness(sample);try h.consent();h.replay.hold=true;var answer:Result<[String:Any],Error>?;try h.bind{answer=$0};h.accounts.unlocked=false;h.replay.release!();rejects{_ = try answer!.get()};yes(h.replay.signs==0)}
  do{let h=try Harness(sample);try h.consent();h.replay.changed=true;var answer:Result<[String:Any],Error>?;try h.bind{answer=$0};rejects{_ = try answer!.get()};yes(h.replay.signs==0)}
  let multiple=samples.first{($0["stages"] as! [Any]).count>1}!
  do{let h=try Harness(multiple),r=try h.ready();rejects{try h.c.advanceReviewed(owner:"v",scope:h.scope,id:"op",receipt:r,pending:h.pending(1)){_ in}};try h.sign(0,r);var p=h.pending(1);p["previousTransactions"]=["00"];var result:Result<Bool,Error>?;try h.c.advanceReviewed(owner:"v",scope:h.scope,id:"op",receipt:r,pending:p){result=$0};rejects{_ = try result!.get()};yes(h.replay.calls==2)}
  print("{\"status\":\"PASS\",\"checks\":\(checks),\"cases\":\(samples.count),\"scope\":\"native-custody-replay\"}")
 }
}
