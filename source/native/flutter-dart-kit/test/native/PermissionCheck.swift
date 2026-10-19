import Foundation

@MainActor private final class Accounts:NativeAccountSource {
 var current:NativeAccount;var revision:Int64=0;var unlocked=true
 var additional=[NativeAccount]();var signingAccounts:[NativeAccount]{[current]+additional}
 init(_ account:NativeAccount){current=account}
}
@MainActor private final class MemoryBackend:NativePermissionBackend {
 var values=[String:PermissionSnapshot](),commits=[String:(String,Int64)]()
 var reads=0,writes=0,fail=false
 func loadAll()throws->[String:PermissionSnapshot]{reads+=1;return values}
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try fence();try permissionNeed(!fail,"TEST_IO")
  let current=values[origin] ?? PermissionSnapshot(revision:0,records:[])
  if let previous=commits[callId]{try permissionNeed(previous.0==meaning,"TEST_CAS");try fence();return PermissionCommitResult(acknowledgedRevision:previous.1,current:current)}
  try permissionNeed(current.revision==expected,"TEST_CAS");try fence()
  let next=PermissionSnapshot(revision:expected+1,records:try PermissionJSON.records(PermissionJSON.canonical(records)))
  values[origin]=next;commits[callId]=(meaning,next.revision);writes+=1
  return PermissionCommitResult(acknowledgedRevision:next.revision,current:next)
 }
}
@main private struct PermissionCheck {
 @MainActor static var checks=0
 @MainActor static func yes(_ value:Bool){if !value{FileHandle.standardError.write(Data("check \(checks+1) failed\n".utf8));exit(1)};checks+=1}
 @MainActor static func rejects(_ f:()throws->Void){var rejected=false;do{try f()}catch{rejected=true};yes(rejected)}
 @MainActor static func main()throws{
  let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  let origin=fixture["origin"] as! String,account=fixture["account"] as! [String:String]
  func accounts(_ chain:String="tbc:testnet")->Accounts{Accounts(NativeAccount(address:account["address"]!,publicKey:account["publicKey"]!,chainId:chain))}
  func request(_ chain:String="tbc:testnet",sign:Bool=false)->[String:Any]{var r:[String:Any]=["tbc_accounts":["chains":[chain],"maxAccounts":16]];if sign{r["tbc_signMessage"]=["chains":[chain]]};return r}
  for chain in ["tbc:mainnet","tbc:testnet"]{
   let a=accounts(chain),store=MemoryBackend();var events=[String?]()
   let p=try NativePermissions(accounts:a,chain:chain,backend:store){events.append($0)}
   yes(try p.records(origin).isEmpty);let proposal=try p.proposal(origin:origin,request:request(chain),operationId:"connect-\(chain)")
   yes(store.writes==0 && events.isEmpty);_ = try p.approve(proposal){}
   yes(try p.permits(origin,"tbc_accounts") && !p.permits(origin,"tbc_signMessage"));yes(try !p.permits("https://other.example","tbc_accounts"))
   for _ in 0..<20{_ = try p.permits(origin,"tbc_accounts")};yes(store.reads==1 && store.writes==1)
   let sign=try p.proposal(origin:origin,request:["tbc_signMessage":["chains":[chain]]],operationId:"sign-\(chain)");_ = try p.approve(sign){}
   try p.require(origin,"tbc_signMessage");yes(store.writes==2)
   a.unlocked=false;yes(try p.records(origin).isEmpty);rejects{try p.require(origin,"tbc_signMessage")};a.unlocked=true
   a.current=NativeAccount(address:"different-selected-account",publicKey:a.current.publicKey,chainId:chain);a.revision+=1;yes(try p.records(origin).isEmpty)
   a.current=accounts(chain).current;a.revision+=1;yes(try p.permits(origin,"tbc_signMessage"))
   try p.revoke(origin,callId:"revoke-\(chain)"){};yes(try p.records(origin).isEmpty)
   let replay=NativeGrantProposal(origin:sign.origin,expected:sign.expected,accountRevision:a.revision,accountId:sign.accountId,callId:sign.callId,capabilities:sign.capabilities,records:sign.records,meaning:sign.meaning,accounts:sign.accounts,selection:sign.selection)
   yes(try p.approve(replay){}.isEmpty);yes(store.writes==3)
   a.current=accounts(chain=="tbc:mainnet" ? "tbc:testnet":"tbc:mainnet").current;rejects{_ = try p.records(origin)}
  }
  do{
   let a=accounts(),store=MemoryBackend(),p=try NativePermissions(accounts:a,chain:"tbc:testnet",backend:store){_ in}
   let controller=NativeAccount(address:"1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",publicKey:"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",chainId:"tbc:testnet")
   a.additional=[controller]
   let single=try p.proposal(origin:origin,request:["tbc_accounts":["chains":["tbc:testnet"]],"tbc_signTransaction":["chains":["tbc:testnet"]]],operationId:"single")
   yes(single.accounts==[a.current]);_ = try p.approve(single){}
   rejects{try p.require(origin,"tbc_signTransaction",account:controller)}
   let two=try p.proposal(origin:origin,request:request(),operationId:"two");yes(two.accounts==[a.current,controller]);_ = try p.approve(two){}
   yes(try p.permits(origin,"tbc_accounts",account:controller));rejects{try p.require(origin,"tbc_signTransaction",account:controller)}
   let sign=try p.proposal(origin:origin,request:["tbc_signTransaction":["chains":["tbc:testnet"]]],operationId:"two-sign");yes(sign.accounts==[a.current,controller]);_ = try p.approve(sign){}
   try p.require(origin,"tbc_signTransaction",account:controller);yes(store.writes==3)
   for _ in 0..<20{try p.require(origin,"tbc_signTransaction",account:controller)};yes(store.reads==1 && store.writes==3)
   rejects{try p.require("https://other.example","tbc_signTransaction",account:controller)}
   let stale=try p.proposal(origin:origin,request:request(),operationId:"selection-stale")
   a.additional=[];rejects{_ = try p.approve(stale){}};rejects{try p.require(origin,"tbc_signTransaction",account:controller)};yes(store.writes==3)
   a.additional=[controller];a.revision+=1
   let stable=try p.proposal(origin:origin,request:request(),operationId:"key-stale")
   a.additional=[NativeAccount(address:controller.address,publicKey:a.current.publicKey,chainId:controller.chainId)]
   rejects{_ = try p.approve(stable){}};rejects{_ = try p.selectedAccounts()}
   a.additional=[controller,controller];rejects{_ = try p.selectedAccounts()}
   a.additional=[NativeAccount(address:controller.address,publicKey:controller.publicKey,chainId:"tbc:mainnet")];rejects{_ = try p.selectedAccounts()}
   a.additional=[controller];try p.revoke(origin,callId:"two-revoke"){};rejects{try p.require(origin,"tbc_signTransaction",account:controller)}
  }
  for raw in fixture["invalidRequests"] as! [[String:Any]]{
   let p=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:MemoryBackend()){_ in}
   rejects{_ = try p.proposal(origin:origin,request:raw,operationId:"invalid")}
  }
  do{
   let a=accounts(),store=MemoryBackend(),p=try NativePermissions(accounts:a,chain:"tbc:testnet",backend:store){_ in}
   yes(try !p.permits(origin,"tbc_switchChain"))
   let grant=try p.proposal(origin:origin,request:["tbc_accounts":["chains":["tbc:testnet"]],"tbc_switchChain":["chains":["tbc:testnet"]]],operationId:"switch-grant")
   _ = try p.approve(grant){};try p.require(origin,"tbc_switchChain")
   yes(store.reads==1 && store.writes==1);rejects{try p.require(origin,"tbc_signTransaction")}
   rejects{_ = try p.proposal(origin:origin,request:["tbc_switchChain":["chains":["tbc:mainnet"]]],operationId:"foreign-switch")}
   try p.revoke(origin,callId:"revoke-switch"){};rejects{try p.require(origin,"tbc_switchChain")}
  }
  do{
   let a=accounts(),store=MemoryBackend(),p=try NativePermissions(accounts:a,chain:"tbc:testnet",backend:store){_ in}
   let proposal=try p.proposal(origin:origin,request:request(),operationId:"stale");a.revision+=1;rejects{_ = try p.approve(proposal){}};yes(store.writes==0)
   let fresh=try p.proposal(origin:origin,request:request(),operationId:"cancelled");rejects{_ = try p.approve(fresh){throw PermissionFailure(code:"CANCELLED")}};yes(store.writes==0)
  }
  do{
   let store=MemoryBackend();var events=[String?]();let p=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:store){events.append($0)}
   let proposal=try p.proposal(origin:origin,request:request(),operationId:"io-fail");store.fail=true;rejects{_ = try p.approve(proposal){}}
   yes(store.writes==0 && events.count==1 && events[0]==nil);rejects{_ = try p.records(origin)}
  }
  let maker=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:MemoryBackend()){_ in}
  let base=try maker.proposal(origin:origin,request:request(sign:true),operationId:"corruption-base").records
  for kind in fixture["corruptions"] as! [String]{
   var records=try PermissionJSON.records(PermissionJSON.canonical(base)),p=records[0],cs=p["caveats"] as! [[String:Any]]
   switch kind{
   case "duplicate-caveat":cs.append(cs[0])
   case "unknown-caveat":cs.append(["type":"unknown","value":true])
   case "expiry-number":cs.append(["type":"expiresAt","value":12])
   case "expiry-null":cs.append(["type":"expiresAt","value":NSNull()])
   case "expiry-invalid":cs.append(["type":"expiresAt","value":"invalid"])
   case "account-non-string":cs[cs.firstIndex{$0["type"] as? String=="restrictAccounts"}!] ["value"]=[accounts().current.accountId,7] as [Any]
   case "wrong-origin":p["invoker"]="https://other.example"
   case "wrong-chain":cs[cs.firstIndex{$0["type"] as? String=="restrictChains"}!] ["value"]=["tbc:mainnet"]
   default:preconditionFailure("UNKNOWN_TEST")
   };p["caveats"]=cs;records[0]=p
   let store=MemoryBackend();store.values[origin]=PermissionSnapshot(revision:1,records:records)
   let permission=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:store){_ in}
   rejects{_ = try permission.records(origin)}
  }
  // System SQLite proof on the desktop host only, inside a caller-owned temp dir.
  let directory=URL(fileURLWithPath:CommandLine.arguments[2]);let store=try SystemPermissionBackend(profile:"profile-a",chain:"tbc:testnet",directory:directory)
  let p=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:store){_ in}
  let proposal=try p.proposal(origin:origin,request:request(),operationId:"sqlite-grant");_ = try p.approve(proposal){};store.close()
  let reopened=try SystemPermissionBackend(profile:"profile-a",chain:"tbc:testnet",directory:directory)
  let read=try NativePermissions(accounts:accounts(),chain:"tbc:testnet",backend:reopened){_ in};yes(try read.permits(origin,"tbc_accounts"))
  try read.revoke(origin,callId:"sqlite-revoke"){};yes(try read.approve(proposal){}.isEmpty)
  for (profile,chain) in [("profile-b","tbc:testnet"),("profile-a","tbc:mainnet")]{let isolated=try SystemPermissionBackend(profile:profile,chain:chain,directory:directory);yes(try isolated.loadAll().isEmpty);isolated.close()}
  let before=try reopened.loadAll()[origin]!.revision;var fences=0
  rejects{_ = try reopened.commit(origin:origin,expected:before,records:proposal.records,callId:"rollback",meaning:"rollback"){fences+=1;if fences==3{throw PermissionFailure(code:"CANCELLED")}}}
  yes(try reopened.loadAll()[origin]!.revision==before);reopened.close()
  print("{\"platform\":\"swift-macos\",\"checks\":\(checks),\"status\":\"PASS\",\"systemSQLiteExercised\":true,\"iosDeviceExercised\":false}")
 }
}
