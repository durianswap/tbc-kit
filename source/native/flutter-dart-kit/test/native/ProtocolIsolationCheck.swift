import Foundation
import CryptoKit

// Real native custody and system SQLite on macOS. No Flutter installation,
// private key, digest signing, network request or chain acceptance is implied.
@MainActor private final class Accounts:NativeAccountSource {
 let current:NativeAccount;var revision:Int64=0;var unlocked=true
 init(_ chain:String="tbc:testnet"){
  current=NativeAccount(address:"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",publicKey:"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",chainId:chain)
 }
}
@MainActor private final class Ui:NativeApprovalPresenter {
 var pending=[String:@MainActor (Bool)->Void](),reviews=[String:NativeReview](),shown=0
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{
  precondition(pending[review.operationId]==nil);shown+=1
  pending[review.operationId]=complete;reviews[review.operationId]=review
  return{self.pending.removeValue(forKey:review.operationId)}
 }
 func choose(_ id:String,_ yes:Bool=true){pending.removeValue(forKey:id)!(yes)}
}
@MainActor private final class NoSigner:NativeDigestSigner {
 var calls=0
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){calls+=1;complete(.failure(NativeCustodyFailure(code:"UNEXPECTED_SIGN")))}
}
@main private struct ProtocolIsolationCheck {
 @MainActor static var checks=0
 @MainActor static func yes(_ value:Bool){precondition(value,"protocol check \(checks+1)");checks+=1}
 @MainActor static func rejects(_ action:()throws->Void){var rejected=false;do{try action()}catch{rejected=true};yes(rejected)}
 @MainActor static func main()throws{
  let dir=URL(fileURLWithPath:CommandLine.arguments[1]),origin="https://protocol.example",chain="tbc:testnet"
  let accounts=Accounts(),ui=Ui(),signer=NoSigner()
  let standard=try SystemPermissionBackend(profile:"same-wallet",chain:chain,directory:dir)
  let legacy=try SystemPermissionBackend(profile:"same-wallet",chain:chain,directory:dir,walletProtocol:.legacy)
  let legacyMain=try SystemPermissionBackend(profile:"same-wallet",chain:"tbc:mainnet",directory:dir,walletProtocol:.legacy)
  defer{standard.close();legacy.close();legacyMain.close()}
  yes(try standard.loadAll().isEmpty && legacy.loadAll().isEmpty)
  yes(!standard.acceptsGroup([standard,legacyMain]));yes(legacy.acceptsGroup([legacy,legacyMain]))
  rejects{_ = try NativeCustody(accounts:accounts,chain:chain,backend:standard,approval:ui,signer:signer,walletProtocol:.legacy){_,_ in true}}
  rejects{_ = try NativeCustody(accounts:accounts,chain:chain,backend:legacy,approval:ui,signer:signer){_,_ in true}}
  let scope=["webViewInstanceId":"same-view","sessionId":"same-session","navigationId":"same-navigation","committedUrl":origin+"/dapp","origin":origin,"topOrigin":origin,"frame":"top","createdAt":"2026-10-14T00:00:00.000Z"]
  let s=try NativeCustody(accounts:accounts,chain:chain,backend:standard,approval:ui,signer:signer){owner,value in owner=="view" && value==scope}
  let l=try NativeCustody(accounts:accounts,chain:chain,backend:legacy,approval:ui,signer:signer,walletProtocol:.legacy){owner,value in owner=="view" && value==scope}
  try s.navigation(owner:"view",scope:scope);try l.navigation(owner:"view",scope:scope)
  let request:[String:Any]=["tbc_accounts":["chains":[chain]],"tbc_signMessage":["chains":[chain]]]
  var sr:Result<[[String:Any]],Error>?,lr:Result<[[String:Any]],Error>?
  try s.requestPermissions(owner:"view",scope:scope,id:"same-connect",request:request){sr=$0}
  try l.requestPermissions(owner:"view",scope:scope,id:"same-connect",request:request){lr=$0}
  let legacyId=PermissionJSON.id(NativeWalletProtocol.legacy.rawValue,"review","same-connect")
  yes(ui.pending.count==2 && ui.shown==2 && sr==nil && lr==nil)
  yes(ui.reviews[legacyId]!.title=="Legacy · Connect wallet" && ui.reviews["same-connect"]!.title=="Connect wallet")
  ui.choose("same-connect");let sGranted=try sr!.get()
  yes(sGranted.count==2 && lr==nil && ui.pending.count==1)
  yes(try l.snapshot(owner:"view",scope:scope).permissions.isEmpty)
  rejects{_ = try l.begin(owner:"view",scope:scope,id:"unauthorized",method:"tbc_signMessage",expectedRevision:0,expectedAccount:accounts.current)}
  ui.choose(legacyId);let lGranted=try lr!.get()
  yes(lGranted.count==2 && ui.pending.isEmpty)
  yes(Set(sGranted.map{$0["id"] as! String}).isDisjoint(with:Set(lGranted.map{$0["id"] as! String})))
  for custody in [s,l]{_ = try custody.begin(owner:"view",scope:scope,id:"same-operation",method:"tbc_signMessage",expectedRevision:custody.snapshot(owner:"view",scope:scope).revision,expectedAccount:accounts.current)}
  try l.disconnect(owner:"view",scope:scope,id:"disconnect")
  rejects{try l.check(owner:"view",scope:scope,id:"same-operation")}
  try s.check(owner:"view",scope:scope,id:"same-operation")
  yes(try s.snapshot(owner:"view",scope:scope).permissions.count==2 && l.snapshot(owner:"view",scope:scope).permissions.isEmpty)
  yes(try standard.loadAll()[origin]!.revision==1 && legacy.loadAll()[origin]!.revision==2)
  // An approved proposal cannot be handed to the other protocol's store owner.
  let sp=try NativePermissions(accounts:accounts,chain:chain,backend:standard){_ in}
  let lp=try NativePermissions(accounts:accounts,chain:chain,backend:legacy,walletProtocol:.legacy){_ in}
  let p=try sp.proposal(origin:origin,request:request,operationId:"cross-proposal")
  rejects{_ = try lp.approve(p){}}
  yes(try legacy.loadAll()[origin]!.revision==2)
  // A network router must not join Standard Testnet to Legacy Mainnet.
  let lm=try NativeCustody(accounts:Accounts("tbc:mainnet"),chain:"tbc:mainnet",backend:legacyMain,approval:ui,signer:signer,walletProtocol:.legacy){_,_ in true}
  rejects{_ = try NativeNetworkWalletRouter(lanes:[chain:NativeNetworkLane(sourceIdentity:String(repeating:"a",count:64),custody:s,wallet:NativeWalletHost(custody:s){_,_,_ in}),"tbc:mainnet":NativeNetworkLane(sourceIdentity:String(repeating:"b",count:64),custody:lm,wallet:NativeWalletHost(custody:lm){_,_,_ in})],initialChain:chain,approval:ui){_,_ in true}}
  // Replay the original Legacy commit after revoke: current records stay empty.
  let replay=try legacy.commit(origin:origin,expected:0,records:lGranted,callId:"same-connect",meaning:PermissionJSON.canonical(["origin":origin,"chainId":chain,"expected":Int64(0),"records":lGranted])){}
  yes(replay.acknowledgedRevision==1 && replay.current.revision==2 && replay.current.records.isEmpty)
  // Same call ID in the other protocol is still independent.
  try s.disconnect(owner:"view",scope:scope,id:"disconnect")
  yes(try standard.loadAll()[origin]!.revision==2 && legacy.loadAll()[origin]!.revision==2)
  var stale:Result<[[String:Any]],Error>?
  try l.requestPermissions(owner:"view",scope:scope,id:"stale",request:request){stale=$0}
  accounts.revision+=1;ui.choose(PermissionJSON.id(NativeWalletProtocol.legacy.rawValue,"review","stale"))
  rejects{_ = try stale!.get()};yes(try legacy.loadAll()[origin]!.revision==2)
  for protocolId in [NativeWalletProtocol.standard,.legacy]{
   let reopened=try SystemPermissionBackend(profile:"same-wallet",chain:chain,directory:dir,walletProtocol:protocolId)
   yes(try reopened.loadAll()[origin]!.revision==2 && reopened.loadAll()[origin]!.records.isEmpty);reopened.close()
  }
  yes(signer.calls==0)
  // The same private router used by Flutter owns both actual custody lanes.
  let sh=NativeWalletHost(custody:s){_,_,_ in},lh=NativeWalletHost(custody:l){_,_,_ in}
  let router=try NativeProtocolWalletRouter(standard:NativeProtocolLane(wallet:sh),legacy:NativeProtocolLane(wallet:lh))
  rejects{_ = try NativeProtocolWalletRouter(standard:NativeProtocolLane(wallet:lh))}
  rejects{_ = try NativeProtocolWalletRouter(standard:NativeProtocolLane(wallet:sh),legacy:NativeProtocolLane(wallet:sh))}
  try router.navigation(owner:"view",scope:scope)
  func call(_ method:String,_ fields:[String:Any]=[:],legacy:Bool=false)->[String:Any]?{
   var input:[String:Any]=["ownerId":"view","scope":scope]
   input.merge(fields){_,b in b};if legacy{input["walletProtocol"]=NativeWalletProtocol.legacy.rawValue}
   var result:[String:Any]?;router.dispatch(method:method,input:input){result=$0};return result
  }
  yes(call("snapshot")?["ok"] as? Bool==true);yes(call("snapshot",legacy:true)?["ok"] as? Bool==true)
  for selector:Any in ["unknown",NSNull(),false,1]{yes(call("snapshot",["walletProtocol":selector])?["ok"] as? Bool==false)}
  let standardOnly=try NativeProtocolWalletRouter(standard:NativeProtocolLane(wallet:sh))
  var disabled:[String:Any]?
  standardOnly.dispatch(method:"snapshot",input:["ownerId":"view","scope":scope,"walletProtocol":NativeWalletProtocol.legacy.rawValue]){disabled=$0}
  yes(disabled?["ok"] as? Bool==false)
  // Same request ID is independently approved and committed to each store.
  let connect:[String:Any]=["operation":"router-connect","permissions":request,"providerMethod":"tbc_requestAccounts"]
  yes(call("permissions.request",connect)==nil);yes(call("permissions.request",connect,legacy:true)==nil)
  ui.choose("router-connect");yes(try s.snapshot(owner:"view",scope:scope).permissions.count==2 && l.snapshot(owner:"view",scope:scope).permissions.isEmpty)
  ui.choose(PermissionJSON.id(NativeWalletProtocol.legacy.rawValue,"review","router-connect"))
  yes(try l.snapshot(owner:"view",scope:scope).permissions.count==2)
  for isLegacy in [false,true]{
   let custody=isLegacy ? l:s
   let begin:[String:Any]=["operation":"router-sign","method":"tbc_signMessage","revision":try custody.snapshot(owner:"view",scope:scope).revision,"account":accounts.current.identity]
   yes(call("signing.begin",begin,legacy:isLegacy)?["ok"] as? Bool==true)
  }
  yes(call("operation.cancel",["operation":"router-sign"],legacy:true)?["ok"] as? Bool==true)
  yes(call("signing.check",["operation":"router-sign"],legacy:true)?["ok"] as? Bool==false)
  yes(call("signing.check",["operation":"router-sign"])?["ok"] as? Bool==true)
  // Canonical execution/read results cross the existing native attestation.
  // Historical aliases are page-only; neither protocol borrows the other's frame.
  func frame(_ protocolId:NativeWalletProtocol,_ value:Any)throws->String{
   let payload:[String:Any]=["response":["jsonrpc":"2.0","id":"read","result":value],"events":[] as [Any]]
   let hash=SHA256.hash(data:Data(try PermissionJSON.canonical(payload).utf8)).map{String(format:"%02x",$0)}.joined()
   return try PermissionJSON.canonical(payload.merging(["channel":protocolId.wireChannel,"type":"delivery","sessionId":scope["sessionId"]!,"navigationId":scope["navigationId"]!,"messageId":"result","deliveryId":hash]){_,b in b})
  }
  func prepare(_ text:String,_ legacy:Bool=false)->Bool{
   call("delivery.prepare",["method":"tbc_accounts","requestId":"read","serialized":text],legacy:legacy)?["ok"] as? Bool==true
  }
  let sf=try frame(.standard,[accounts.current.address]),lf=try frame(.legacy,[accounts.current.address])
  yes(prepare(sf));yes(prepare(lf,true))
  yes(router.allowDelivery(owner:"view",scope:scope,text:sf))
  yes(router.allowDelivery(owner:"view",scope:scope,text:lf,walletProtocol:.legacy))
  yes(!prepare(sf,true));yes(!prepare(lf))
  yes(!router.allowDelivery(owner:"view",scope:scope,text:sf,walletProtocol:.legacy))
  yes(!router.allowDelivery(owner:"view",scope:scope,text:lf))
  yes(!prepare(try frame(.legacy,["tbcAddress":accounts.current.address]),true))
  yes(!standardOnly.allowDelivery(owner:"view",scope:scope,text:lf,walletProtocol:.legacy))
  // Balance is a typed informational read, not an arbitrary result escape.
  let balance:[String:Any]=["chainId":chain,"address":accounts.current.address,"balanceAtomic":"1000001","decimals":6]
  let bf=try frame(.legacy,balance),shown=ui.shown
  func balancePrepare(_ text:String,_ legacy:Bool=true)->Bool{
   call("delivery.prepare",["method":"wallet_readBalance","requestId":"read","serialized":text],legacy:legacy)?["ok"] as? Bool==true
  }
  yes(balancePrepare(bf));yes(router.allowDelivery(owner:"view",scope:scope,text:bf,walletProtocol:.legacy))
  yes(!balancePrepare(try frame(.standard,balance),false))
  for value in ["0","9007199254740991"]{yes(balancePrepare(try frame(.legacy,balance.merging(["balanceAtomic":value]){_,b in b})))}
  for patch:[String:Any] in [["chainId":"tbc:mainnet"],["address":"other"],["balanceAtomic":"9007199254740992"],["balanceAtomic":"01"],["balanceAtomic":1],["balanceAtomic":"-1"],["decimals":5],["extra":true]]{
   yes(!balancePrepare(try frame(.legacy,balance.merging(patch){_,b in b})))
  }
  yes(!prepare(bf,true));yes(ui.shown==shown && signer.calls==0)
  yes(call("permissions.disconnect",["operation":"router-disconnect"],legacy:true)?["ok"] as? Bool==true)
  yes(!router.allowDelivery(owner:"view",scope:scope,text:bf,walletProtocol:.legacy));yes(!balancePrepare(bf))
  yes(try s.snapshot(owner:"view",scope:scope).permissions.count==2 && l.snapshot(owner:"view",scope:scope).permissions.isEmpty)
  yes(!router.allowDelivery(owner:"view",scope:scope,text:lf,walletProtocol:.legacy))
  yes(router.allowDelivery(owner:"view",scope:scope,text:sf))
  let initialize:[String:Any]=["channel":"tws-webview/1","type":"initialize","sessionId":scope["sessionId"]!,"navigationId":scope["navigationId"]!,"messageId":"native-1","origin":origin,"chainId":chain]
  yes(router.allowDelivery(owner:"view",scope:scope,text:try PermissionJSON.canonical(initialize)))
  var legacyInitialize=initialize;legacyInitialize["channel"]=NativeWalletProtocol.legacy.wireChannel
  yes(router.allowDelivery(owner:"view",scope:scope,text:try PermissionJSON.canonical(legacyInitialize),walletProtocol:.legacy))
  yes(!router.allowDelivery(owner:"view",scope:scope,text:try PermissionJSON.canonical(initialize),walletProtocol:.legacy))
  var crossed=initialize;crossed["channel"]="legacy-window-turing-webview/1"
  yes(!router.allowDelivery(owner:"view",scope:scope,text:try PermissionJSON.canonical(crossed)))
  yes(call("document.invalidate",legacy:true)?["ok"] as? Bool==true)
  yes(call("snapshot",legacy:true)?["ok"] as? Bool==false);yes(call("snapshot")?["ok"] as? Bool==true)
  router.invalidate(owner:"view");yes(call("snapshot")?["ok"] as? Bool==false)
  try router.navigation(owner:"view",scope:scope);router.close()
  yes(call("snapshot")?["ok"] as? Bool==false);rejects{try router.navigation(owner:"view",scope:scope)}
  yes(signer.calls==0)
  print("{\"status\":\"NATIVE_PROTOCOL_ISOLATION_PASS\",\"checks\":\(checks),\"systemSQLite\":true,\"mobileDevice\":false,\"signatures\":0,\"broadcasts\":0}")
 }
}
