import Foundation
import CryptoKit

@MainActor private final class Accounts:NativeAccountSource {
 var current:NativeAccount;var revision:Int64=0;var unlocked=true
 var additional=[NativeAccount]();var signingAccounts:[NativeAccount]{[current]+additional}
 init(_ account:NativeAccount){current=account}
}
@MainActor private final class Store:NativePermissionGroupBackend {
 var data=[String:PermissionSnapshot]();var writes=0;var fail=false
 var grouped=false,wrongAck=false;var groupCommits=0
 func acceptsGroup(_ stores:[NativePermissionBackend])->Bool{grouped && stores.count==2 && stores.allSatisfy{($0 as? Store)?.grouped==true}}
 func commitGroup(_ mutations:[NativePermissionMutation],fence:()throws->Void)throws->[String:PermissionCommitResult]{
  precondition(acceptsGroup(mutations.map{$0.backend}));try fence()
  var staged=[String:PermissionCommitResult]()
  for m in mutations{let store=m.backend as! Store
   if store.fail{throw NativeCustodyFailure(code:"FIXTURE_STORE")}
   try permissionNeed((store.data[m.origin]?.revision ?? 0)==m.expected,"PERMISSION_CONFLICT")
   let next=PermissionSnapshot(revision:m.expected+1,records:m.records)
   staged[m.chainId]=PermissionCommitResult(acknowledgedRevision:store.wrongAck ? next.revision+1:next.revision,current:next)
  }
  try fence()
  for m in mutations{let store=m.backend as! Store;store.data[m.origin]=staged[m.chainId]!.current;store.writes+=1}
  groupCommits+=1;return staged
 }
 func loadAll()throws->[String:PermissionSnapshot]{data}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();if fail{throw NativeCustodyFailure(code:"FIXTURE_STORE")}
  precondition((data[origin]?.revision ?? 0)==expected)
  let next=PermissionSnapshot(revision:expected+1,records:records);data[origin]=next;writes+=1
  return PermissionCommitResult(acknowledgedRevision:next.revision,current:next)
 }
}
@MainActor private final class Ui:NativeApprovalPresenter {
 var pending=[String:@MainActor (Bool)->Void]();var shown=0;var reviews=[NativeReview]()
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{
  precondition(pending[review.operationId]==nil);shown+=1;reviews.append(review);pending[review.operationId]=complete
  return{self.pending.removeValue(forKey:review.operationId)}
 }
 func choose(_ id:String,_ approve:Bool=true){pending.removeValue(forKey:id)!(approve)}
}
@MainActor private final class HeldSigner:NativeDigestSigner {
 var release:(@MainActor ()->Void)?;var keyUses=0
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  release={complete(Result{try requireCurrent();self.keyUses+=1;return [UInt8](repeating:0,count:65)})}
 }
}
@MainActor private final class Harness {
 let scope:[String:String],sample:[String:Any],ui=Ui(),signer=HeldSigner()
 var accounts=[String:Accounts](),stores=[String:Store](),lanes=[String:NativeNetworkLane](),documents=[String:[String:String]]()
 var router:NativeNetworkWalletRouter!
 init(_ sample:[String:Any],mainSubset:Bool=false,grouped:Bool=false)throws{
  self.sample=sample;let a=sample["account"] as! [String:String],context=sample["context"] as! [String:String]
  var s=context.filter{$0.key != "transport"};s["webViewInstanceId"]="network-host";s["committedUrl"]=s["origin"]!+"/dapp";scope=s
  for(chain,n)in [("tbc:mainnet","1"),("tbc:testnet","2")]{
   let account=Accounts(NativeAccount(address:a["address"]!,publicKey:a["publicKey"]!,chainId:chain)),store=Store();store.grouped=grouped;accounts[chain]=account;stores[chain]=store
   if mainSubset && chain=="tbc:mainnet"{
    let other=NativeAccount(address:"1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",publicKey:"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",chainId:chain);account.additional=[other]
    // Existing valid durable grants can cover a subset after wallet selection
    // changes. No grant or key is fabricated by production routing.
    let rows:[[String:Any]]=["tbc_accounts","tbc_switchChain","tbc_signMessage"].map{name in
     ["id":"fixture-"+name,"parentCapability":name,"invoker":s["origin"]!,"date":1,"caveats":[["type":"restrictChains","value":[chain]],["type":"restrictAccounts","value":name=="tbc_switchChain" ? [other.accountId]:[account.current.accountId,other.accountId]],["type":"restrictMethods","value":[name]]]]
    }
    store.data[s["origin"]!]=PermissionSnapshot(revision:1,records:rows)
   }
   let custody=try NativeCustody(accounts:account,chain:chain,backend:store,approval:ui,signer:signer){[unowned self] owner,scope in self.documents[owner]==scope}
   lanes[chain]=NativeNetworkLane(sourceIdentity:String(repeating:n,count:64),custody:custody,wallet:NativeWalletHost(custody:custody){_,_,_ in})
  }
  router=try NativeNetworkWalletRouter(lanes:lanes,initialChain:"tbc:testnet",approval:ui){[unowned self] owner,scope in self.documents[owner]==scope}
  try navigate("view");try navigate("other")
 }
 func navigate(_ owner:String)throws{documents[owner]=scope;try router.navigation(owner:owner,scope:scope)}
 func grant(_ chain:String)throws{
  var result:Result<[[String:Any]],Error>?
  let id="grant-"+chain
  try lanes[chain]!.custody.requestPermissions(owner:"view",scope:scope,id:id,request:Dictionary(uniqueKeysWithValues:["tbc_accounts","tbc_switchChain","tbc_signMessage"].map{($0,["chains":[chain]])})){result=$0}
  ui.choose(id);_ = try result!.get()
 }
 func current()throws->NativeNetworkState{try router.state(owner:"view",scope:scope)}
 func dispatch(_ method:String,_ expected:NativeNetworkState,_ fields:[String:Any]=[:],_ cb:@escaping @MainActor ([String:Any])->Void){router.dispatch(owner:"view",scope:scope,expected:expected,method:method,fields:fields,reply:cb)}
 func readyHeldSignature()throws{
  let c=lanes["tbc:testnet"]!.custody,a=accounts["tbc:testnet"]!.current,audit=sample["audit"] as! [String:Any],request=sample["request"] as! [String:Any],context=sample["context"] as! [String:Any]
  _ = try c.begin(owner:"view",scope:scope,id:"held",method:"tbc_signMessage",expectedRevision:c.snapshot(owner:"view",scope:scope).revision,expectedAccount:a)
  var consent:Result<Bool,Error>?
  try c.consent(owner:"view",scope:scope,id:"held",method:"tbc_signMessage",request:request,context:context){consent=$0};ui.choose("held");_ = try consent!.get()
  var binding=audit["binding"] as! [String:Any],payload=binding["payload"] as! [String:Any]
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];payload["expiresAt"]=f.string(from:Date().addingTimeInterval(120))
  binding["payload"]=payload;binding["bindingHash"]=SHA256.hash(data:Data(try PermissionJSON.canonical(payload).utf8)).map{String(format:"%02x",$0)}.joined()
  let preview=audit["preview"] as! [String:Any]
  let receipt=try c.bind(owner:"view",scope:scope,id:"held",binding:binding,preview:preview,plan:nil,envelope:["type":"tbc.message","version":"1.0","message":request["message"]!])
  let task:[String:Any]=["taskId":"sign-message","purpose":"message","algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":preview["digest"]!,"signatureEncoding":"compact65-recoverable","origin":scope["origin"]!,"accountId":a.accountId,"publicKey":a.publicKey]
  try c.sign(owner:"view",scope:scope,id:"held",receipt:receipt,task:task){result in
   precondition((try? result.get())==nil,"Stale signer must fail before key use")
  }
 }
}
@main private struct NetworkRouterCheck {
 @MainActor static var checks=0
 @MainActor static func yes(_ value:Bool){precondition(value,"router check \(checks+1)");checks+=1}
 @MainActor static func rejects(_ action:()throws->Void){do{try action();fatalError("Expected rejection")}catch{checks+=1}}
 @MainActor static func main()throws{
  let data=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  let sample=(data["cases"] as! [[String:Any]]).first{$0["method"] as? String=="tbc_signMessage"}!
  try privateChannel(sample)
  try notifications(sample)
  try groupPermissions(sample)
  do{
   let h=try Harness(sample);try h.grant("tbc:testnet");try h.grant("tbc:mainnet");let old=try h.current()
   try h.readyHeldSignature();yes(h.signer.release != nil)
   let other=h.lanes["tbc:testnet"]!.custody,a=h.accounts["tbc:testnet"]!.current
   _ = try other.begin(owner:"other",scope:h.scope,id:"other-op",method:"tbc_signMessage",expectedRevision:other.snapshot(owner:"other",scope:h.scope).revision,expectedAccount:a)
   let writes=h.stores.values.reduce(0){$0+$1.writes};var result:Result<NativeNetworkCommit,Error>?
   try h.router.switchChain(owner:"view",scope:h.scope,operation:"switch",target:"tbc:mainnet",expected:old){result=$0}
   yes(try result==nil && h.current()==old);yes(h.ui.reviews.last!.chainId=="tbc:mainnet")
   h.ui.choose("switch");let committed=try result!.get();try h.router.requireDelivery(committed)
   yes(try h.current()==NativeNetworkState(chainId:"tbc:mainnet",revision:1))
   yes(h.stores.values.reduce(0){$0+$1.writes}==writes)
   h.signer.release!();yes(h.signer.keyUses==0)
   try other.check(owner:"other",scope:h.scope,id:"other-op");yes(try h.router.state(owner:"other",scope:h.scope)==old)
   h.dispatch("snapshot",old){yes($0["ok"] as? Bool==false)}
   h.dispatch("snapshot",committed.state){r in yes(r["ok"] as? Bool==true);yes(((r["value"] as! [String:Any])["account"] as! [String:Any])["chainId"] as? String=="tbc:mainnet")}
   rejects{_ = try other.begin(owner:"view",scope:h.scope,id:"held",method:"tbc_signMessage",expectedRevision:other.snapshot(owner:"view",scope:h.scope).revision,expectedAccount:a)}
   let count=h.ui.shown;var noop:Result<NativeNetworkCommit,Error>?
   try h.router.switchChain(owner:"view",scope:h.scope,operation:"noop",target:"tbc:mainnet",expected:committed.state){noop=$0}
   yes(try noop!.get().eventsJSON=="[]");yes(h.ui.shown==count)
   try h.router.disconnect(owner:"view",scope:h.scope,operation:"disconnect",expected:committed.state)
   for lane in h.lanes.values{yes(try lane.custody.networkAuthority(origin:h.scope["origin"]!).switchAccountIds.isEmpty)}
   rejects{try h.router.requireDelivery(committed)}
  }
  for mode in ["reject","cancel","lock","revoke","navigate","close","two-switches"]{
   let h=try Harness(sample);try h.grant("tbc:testnet");try h.grant("tbc:mainnet");let before=try h.current();var result:Result<NativeNetworkCommit,Error>?
   try h.router.switchChain(owner:"view",scope:h.scope,operation:"switch",target:"tbc:mainnet",expected:before){result=$0}
   let late=h.ui.pending["switch"]!
   switch mode{
   case "reject":h.ui.choose("switch",false)
   case "cancel":try h.router.cancelSwitch(owner:"view",scope:h.scope,operation:"switch");late(true)
   case "lock":h.accounts["tbc:mainnet"]!.unlocked=false;h.router.accountChanged();late(true)
   case "revoke":try h.lanes["tbc:mainnet"]!.custody.disconnect(owner:"view",scope:h.scope,id:"revoke");h.ui.choose("switch")
   case "navigate":h.router.invalidate(owner:"view");late(true)
   case "close":h.router.close();late(true);rejects{_ = try h.lanes["tbc:testnet"]!.custody.snapshot(owner:"other",scope:h.scope)}
   default:
    var second:Result<NativeNetworkCommit,Error>?
    try h.router.switchChain(owner:"view",scope:h.scope,operation:"winner",target:"tbc:mainnet",expected:before){second=$0}
    h.ui.choose("winner");_ = try second!.get();late(true)
   }
   yes(result != nil);yes((try? result!.get())==nil);yes(h.signer.keyUses==0)
   if !["navigate","close","two-switches"].contains(mode){yes(try h.current()==before)}
  }
  do{let h=try Harness(sample);try h.grant("tbc:testnet");rejects{try h.router.switchChain(owner:"view",scope:h.scope,operation:"ungranted",target:"tbc:mainnet",expected:h.current()){_ in}};yes(h.ui.shown==1)}
  do{
   let h=try Harness(sample)
   rejects{_ = try NativeNetworkWalletRouter(lanes:["tbc:mainnet":h.lanes["tbc:testnet"]!],initialChain:"tbc:mainnet",approval:h.ui){_,_ in true}}
   rejects{_ = try NativeNetworkWalletRouter(lanes:["tbc:mainnet":h.lanes["tbc:testnet"]!,"tbc:testnet":h.lanes["tbc:testnet"]!],initialChain:"tbc:testnet",approval:h.ui){_,_ in true}}
   let c=try NativeCustody(accounts:h.accounts["tbc:testnet"]!,chain:"tbc:testnet",backend:Store(),approval:h.ui,signer:h.signer,sendSourceIdentity:String(repeating:"2",count:64)){_,_ in true}
   rejects{try c.validateNetworkLane(chainId:"tbc:testnet",sourceIdentity:String(repeating:"1",count:64))}
  }
  do{
   let h=try Harness(sample,mainSubset:true);try h.grant("tbc:testnet")
   let before=try h.current(),c=h.lanes["tbc:mainnet"]!.custody,a=h.accounts["tbc:mainnet"]!,b=a.additional[0]
   var switched:Result<NativeNetworkCommit,Error>?
   try h.router.switchChain(owner:"view",scope:h.scope,operation:"subset",target:"tbc:mainnet",expected:before){switched=$0}
   yes(h.ui.reviews.last!.accountAddress==b.address);h.ui.choose("subset");let commit=try switched!.get()
   let snapshot=try h.router.snapshot(owner:"view",scope:h.scope,expected:commit.state)
   yes(snapshot.account==b);yes(snapshot.connectedAccounts==[b]);yes(a.current != b)
   yes(try commit.eventsJSON==PermissionJSON.canonical([["name":"chainChanged","payload":"tbc:mainnet"],["name":"accountsChanged","payload":[b.address]]]))
   _ = try c.begin(owner:"view",scope:h.scope,id:"secondary",method:"tbc_signMessage",expectedRevision:snapshot.revision,expectedAccount:b)
   try c.check(owner:"view",scope:h.scope,id:"secondary");checks+=1
   rejects{_ = try c.begin(owner:"view",scope:h.scope,id:"primary",method:"tbc_signMessage",expectedRevision:snapshot.revision,expectedAccount:a.current)}
   yes(try c.snapshot(owner:"other",scope:h.scope).connectedAccounts.count==2)
   var back:Result<NativeNetworkCommit,Error>?
   try h.router.switchChain(owner:"view",scope:h.scope,operation:"back",target:"tbc:testnet",expected:commit.state){back=$0};h.ui.choose("back")
   yes(try back!.get().eventsJSON==PermissionJSON.canonical([["name":"chainChanged","payload":"tbc:testnet"],["name":"accountsChanged","payload":[h.accounts["tbc:testnet"]!.current.address]]]))
   rejects{try c.check(owner:"view",scope:h.scope,id:"secondary")}
  }
  do{
   let h=try Harness(sample);try h.grant("tbc:testnet");let before=try h.current();var granted:Result<[[String:Any]],Error>?
   try h.router.requestPermissions(owner:"view",scope:h.scope,operation:"target-grant",target:"tbc:mainnet",expected:before,request:["tbc_accounts":["chains":["tbc:mainnet"]],"tbc_switchChain":["chains":["tbc:mainnet"]]]){granted=$0}
   yes(granted==nil);h.ui.choose("target-grant");yes(try granted!.get().count==2);yes(try h.current()==before)
   yes(try h.router.permissions(owner:"view",scope:h.scope).count==5)
  }
  do{
   let h=try Harness(sample);try h.grant("tbc:testnet");try h.grant("tbc:mainnet");h.stores["tbc:mainnet"]!.fail=true
   rejects{try h.router.disconnect(owner:"view",scope:h.scope,operation:"disconnect",expected:h.current())}
   yes(try h.lanes["tbc:testnet"]!.custody.networkAuthority(origin:h.scope["origin"]!).switchAccountIds.isEmpty)
   rejects{_ = try h.lanes["tbc:mainnet"]!.custody.networkAuthority(origin:h.scope["origin"]!)}
  }
  print("{\"status\":\"NATIVE_NETWORK_CUSTODY_ROUTER_PASS\",\"checks\":\(checks),\"keyUsesAfterSwitch\":0,\"broadcasts\":0}")
 }
 @MainActor static func groupPermissions(_ sample:[String:Any])throws{
  let chains=["tbc:mainnet","tbc:testnet"]
  func start(_ h:Harness,_ id:String,_ reply:@escaping @MainActor ([String:Any])->Void)throws{
   let state=try h.current()
   h.router.dispatch(method:"permissions.request",input:["ownerId":"view","scope":h.scope,"network":["chainId":state.chainId,"revision":state.revision],"operation":id,"providerMethod":"wallet_requestPermissions",
    "permissions":["tbc_accounts":["chains":chains],"tbc_switchChain":["chains":chains],"tbc_signMessage":["chains":["tbc:testnet"]]]],reply:reply)
  }
  do{
   let h=try Harness(sample,grouped:true),before=try h.current();var result:[String:Any]?,events=[String](),observed=[Int]()
   try h.router.installAuthorityChanged{owner,_,snapshot in events.append(owner);observed.append((snapshot?["permissions"] as? [Any])?.count ?? -1)}
   try start(h,"group-ok"){result=$0}
   yes(result==nil && h.ui.shown==1 && h.stores.values.allSatisfy{$0.writes==0})
   yes(h.ui.reviews.last!.description.contains("tbc:mainnet") && h.ui.reviews.last!.description.contains("tbc:testnet"))
   h.ui.choose("group-ok");yes(result?["ok"] as? Bool==true)
   yes((result?["value"] as? [Any])?.count==5)
   yes(h.stores.values.allSatisfy{$0.writes==1} && h.stores.values.reduce(0){$0+$1.groupCommits}==1)
   yes(try h.current()==before && h.signer.keyUses==0)
   yes(events==["other"] && observed==[5])
   for chain in chains{
    let p=try NativePermissions(accounts:h.accounts[chain]!,chain:chain,backend:h.stores[chain]!){_ in}
    yes(try p.permits(h.scope["origin"]!,"tbc_accounts") && p.permits(h.scope["origin"]!,"tbc_switchChain"))
    yes(try p.permits(h.scope["origin"]!,"tbc_signMessage")==("tbc:testnet"==chain))
   }
  }
  do{
   let h=try Harness(sample,grouped:true);var first:[String:Any]?,duplicate:[String:Any]?
   try start(h,"duplicate"){first=$0};try start(h,"duplicate"){duplicate=$0}
   yes(first==nil && duplicate?["ok"] as? Bool==false && h.ui.shown==1)
   // A rejected duplicate must not remove the original pending cancellation.
   try h.router.cancelSwitch(owner:"view",scope:h.scope,operation:"duplicate")
   yes(first?["ok"] as? Bool==false && h.ui.pending.isEmpty && h.stores.values.allSatisfy{$0.writes==0})
  }
  for mode in ["reject","cancel","lock","navigate","close","stale-grant","switch","store-fail","bad-ack"]{
   let h=try Harness(sample,grouped:true)
   if mode=="switch"{try h.grant("tbc:mainnet");try h.grant("tbc:testnet")}
   let beforeWrites=h.stores.values.reduce(0){$0+$1.writes};var result:[String:Any]?,replies=0
   try start(h,"group-"+mode){result=$0;replies+=1};let late=h.ui.pending["group-"+mode]!
   switch mode{
   case "reject":h.ui.choose("group-"+mode,false)
   case "cancel":try h.router.cancelSwitch(owner:"view",scope:h.scope,operation:"group-"+mode);late(true)
   case "lock":h.accounts["tbc:mainnet"]!.unlocked=false;h.router.accountChanged();late(true)
   case "navigate":h.router.invalidate(owner:"view");late(true)
   case "close":h.router.close();late(true)
   case "stale-grant":try h.lanes["tbc:mainnet"]!.custody.disconnect(owner:"view",scope:h.scope,id:"revoke-group");late(true)
   case "switch":try h.router.switchChain(owner:"view",scope:h.scope,operation:"switch-group",target:"tbc:mainnet",expected:h.current()){_ in};h.ui.choose("switch-group");late(true)
   case "store-fail":h.stores["tbc:testnet"]!.fail=true;h.ui.choose("group-"+mode)
   default:h.stores["tbc:testnet"]!.wrongAck=true;h.ui.choose("group-"+mode)
   }
   yes(result?["ok"] as? Bool==false && replies==1)
   yes(h.signer.keyUses==0 && h.ui.pending.isEmpty)
   yes(h.stores.values.reduce(0){$0+$1.writes}==beforeWrites+(mode=="stale-grant" ? 1:mode=="bad-ack" ? 2:0))
   if ["store-fail","bad-ack"].contains(mode){for chain in chains{rejects{_ = try h.lanes[chain]!.custody.networkAuthority(origin:h.scope["origin"]!)}}}
  }
 }
 @MainActor static func notifications(_ sample:[String:Any])throws{
  let h=try Harness(sample);try h.grant("tbc:testnet")
  var events=[(String,[String:Any]?)]()
  try h.router.installAuthorityChanged{owner,scope,snapshot in precondition(scope==h.scope);events.append((owner,snapshot))}
  var granted:Result<[[String:Any]],Error>?
  try h.router.requestPermissions(owner:"view",scope:h.scope,operation:"notify-grant",target:"tbc:mainnet",expected:h.current(),request:["tbc_accounts":["chains":["tbc:mainnet"]],"tbc_switchChain":["chains":["tbc:mainnet"]]]){granted=$0}
  yes(events.isEmpty);h.ui.choose("notify-grant");_ = try granted!.get()
  yes(events.count==1 && events[0].0=="other")
  yes((events[0].1!["network"] as! [String:Any])["chainId"] as? String=="tbc:testnet")
  yes((events[0].1!["permissions"] as! [Any]).count==5)
  events.removeAll();h.accounts["tbc:mainnet"]!.unlocked=false;h.router.accountChanged()
  yes(events.count==2 && Set(events.map{$0.0})==["view","other"])
  yes(events.allSatisfy{($0.1!["permissions"] as! [Any]).count==3})
  h.accounts["tbc:mainnet"]!.unlocked=true;h.router.accountChanged();events.removeAll()
  try h.router.disconnect(owner:"view",scope:h.scope,operation:"notify-disconnect",expected:h.current())
  yes(events.count==1 && events[0].0=="other")
  yes((events[0].1!["permissions"] as! [Any]).isEmpty)
 }
 @MainActor static func privateChannel(_ sample:[String:Any])throws{
  let h=try Harness(sample);try h.grant("tbc:testnet")
  func operation(_ id:String)throws->String{try PermissionJSON.id("P4/rpc",h.scope["sessionId"]!,PermissionJSON.canonical(id))}
  func call(_ method:String,_ fields:[String:Any]=[:],expected:NativeNetworkState?=nil)throws->[String:Any]{
   var input:[String:Any]=["ownerId":"view","scope":h.scope]
   if method != "network.snapshot"{let state=try expected ?? h.current();input["network"]=["chainId":state.chainId,"revision":state.revision]}
   var result:[String:Any]?;h.router.dispatch(method:method,input:input.merging(fields){_,b in b}){result=$0};return result!
  }
  func hash(_ v:Any)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
  func frame(_ id:String,_ value:Any?,_ events:Any)throws->String{
   let payload:[String:Any]=["response":["jsonrpc":"2.0","id":id,"result":value ?? NSNull()],"events":events]
   return try PermissionJSON.canonical(payload.merging(["channel":"tws-webview/1","type":"delivery","sessionId":h.scope["sessionId"]!,"navigationId":h.scope["navigationId"]!,"messageId":"network-check","deliveryId":hash(payload)]){_,b in b})
  }
  func prepare(_ method:String,_ id:String,_ text:String)throws->Bool{try call("delivery.prepare",["method":method,"requestId":id,"serialized":text])["ok"] as? Bool==true}
  func allow(_ text:String)->Bool{h.router.allowDelivery(owner:"view",scope:h.scope,text:text)}
  let boot=try call("network.snapshot")["value"] as! [String:Any]
  yes((boot["sources"] as! [String:String]).count==2 && (boot["lanes"] as! [String:Any]).count==2)
  let caps=try call("network.capabilities",["operation":operation("caps"),"chainId":"tbc:mainnet","address":NSNull()])
  yes(caps["ok"] as? Bool==true)
  let capFrame=try frame("caps",caps["value"],[] as [Any]);yes(try prepare("tbc_getCapabilities","caps",capFrame) && allow(capFrame))
  yes(try call("network.capabilities",["operation":operation("private-cap"),"chainId":"tbc:mainnet","address":h.accounts["tbc:mainnet"]!.current.address])["ok"] as? Bool==false)
  yes(try call("network.switch",["operation":"unknown","chainId":"tbc:unknown"])["code"] as? String=="UNSUPPORTED_CHAIN")
  let writes=h.stores.values.reduce(0){$0+$1.writes}
  yes(try call("permissions.request",["operation":"multi","providerMethod":"wallet_requestPermissions","permissions":["tbc_accounts":["chains":["tbc:testnet","tbc:mainnet"]]]])["ok"] as? Bool==false)
  yes(h.stores.values.reduce(0){$0+$1.writes}==writes) // pending group support must not partially commit
  let before=try h.current(),grantId=try operation("grant-target");var granted:[String:Any]?
  h.router.dispatch(method:"permissions.request",input:["ownerId":"view","scope":h.scope,"network":["chainId":before.chainId,"revision":before.revision],"operation":grantId,"providerMethod":"wallet_requestPermissions","permissions":["tbc_accounts":["chains":["tbc:mainnet"]],"tbc_switchChain":["chains":["tbc:mainnet"]]]]){granted=$0}
  yes(granted==nil);h.ui.choose(grantId);yes(granted?["ok"] as? Bool==true);yes(try h.current()==before)
  let rows=try h.router.permissions(owner:"view",scope:h.scope)
  let all=try frame("perms",rows,[] as [Any]);yes(try prepare("wallet_getPermissions","perms",all) && allow(all))
  let partial=try frame("partial",Array(rows.prefix(1)),[] as [Any]);yes(try !prepare("wallet_getPermissions","partial",partial) && !allow(partial))
  let switchId=try operation("switch-channel");var switched:[String:Any]?
  h.router.dispatch(method:"network.switch",input:["ownerId":"view","scope":h.scope,"network":["chainId":before.chainId,"revision":before.revision],"operation":switchId,"chainId":"tbc:mainnet"]){switched=$0}
  yes(switched==nil);h.ui.choose(switchId);yes(switched?["ok"] as? Bool==true)
  let events=switched!["value"]!,ok=try frame("switch-channel",nil,events)
  yes(try prepare("tbc_switchChain","switch-channel",ok) && allow(ok))
  let missing=try frame("switch-channel",nil,[] as [Any]);yes(try !prepare("tbc_switchChain","switch-channel",missing) && !allow(missing))
  let forged=try frame("switch-channel",["not":"null"],events);yes(try !prepare("tbc_switchChain","switch-channel",forged) && !allow(forged))
  yes(try call("snapshot",expected:before)["ok"] as? Bool==false)
  yes(try call("snapshot",["network":["chainId":"tbc:mainnet","revision":true]])["ok"] as? Bool==false)
  yes(!allow(all));let shown=h.ui.shown
  let noop=try call("network.switch",["operation":operation("noop-channel"),"chainId":"tbc:mainnet"])
  yes(try noop["ok"] as? Bool==true && PermissionJSON.canonical(noop["value"])=="[]" && h.ui.shown==shown)
  let noopFrame=try frame("noop-channel",nil,[] as [Any]);yes(try prepare("tbc_switchChain","noop-channel",noopFrame) && allow(noopFrame))
  let dis=try call("permissions.disconnect",["operation":operation("disconnect-channel")]);yes(dis["ok"] as? Bool==true)
  let revoked=try frame("disconnect-channel",nil,[["name":"permissionsChanged","payload":[Any]()],["name":"accountsChanged","payload":[Any]()]])
  yes(try prepare("tbc_disconnect","disconnect-channel",revoked) && allow(revoked));yes(!allow(ok));yes(h.signer.keyUses==0)
 }
}
