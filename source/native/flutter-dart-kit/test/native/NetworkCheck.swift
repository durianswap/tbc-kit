import Foundation

@MainActor private final class Fixture {
 let scope:[String:String],now:Int64
 var time:Int64,active=true,epochs=["tbc:mainnet":"0","tbc:testnet":"0"],locked=Set<String>(),ungranted=Set<String>()
 var fences=0,failFence=false,changedInFence=false
 var networks:NativeNetworkSessions!
 init(_ data:[String:Any])throws{
  scope=data["scope"] as! [String:String];now=(data["nowMillis"] as! NSNumber).int64Value;time=now
  networks=try NativeNetworkSessions(sources:["tbc:mainnet":String(repeating:"1",count:64),"tbc:testnet":String(repeating:"2",count:64)],nativeCurrent:{[unowned self] _,s in self.active && s==self.scope},authority:{[unowned self] chain,_ in
   let address=chain=="tbc:mainnet" ? "main-address":"test-address"
   return NativeNetworkAuthority(epoch:self.epochs[chain]!,unlocked:!self.locked.contains(chain),switchAccountIds:self.ungranted.contains(chain) ? []:[chain+":"+address],visibleAddresses:[address])
  },fence:{[unowned self] _,_ in self.fences+=1;if self.failFence{throw NativeNetworkFailure(code:"FIXTURE_FENCE")};if self.changedInFence{self.epochs["tbc:mainnet"]="changed"}},clock:{[unowned self] in self.time})
  try networks.navigation(owner:"view",scope:scope,initialChain:"tbc:testnet")
 }
 func proposal(_ id:String="operation",_ target:String="tbc:mainnet",_ revision:Int=0)throws->NativeNetworkProposal{try networks.prepare(owner:"view",scope:scope,operation:id,target:target,expectedRevision:revision)}
 func state()throws->NativeNetworkState{try networks.state(owner:"view",scope:scope)}
}
@main private struct NetworkCheck {
 @MainActor static var checks=0
 @MainActor static func yes(_ value:Bool){precondition(value,"check \(checks+1)");checks+=1}
 @MainActor static func rejects(_ code:String?=nil,_ body:()throws->Void){do{try body();fatalError("Expected rejection")}catch{if let code{yes((error as? NativeNetworkFailure)?.code==code)}else{checks+=1}}}
 @MainActor static func main()throws{
  let data=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  do{
   let f=try Fixture(data),p=try f.proposal()
   for (value,key) in [(p.proposalJSON,"proposal"),(p.bindingJSON,"binding"),(p.previewJSON,"preview")]{yes(try value==PermissionJSON.canonical(data[key]))}
   yes(try f.state()==NativeNetworkState(chainId:"tbc:testnet",revision:0));yes(f.fences==0)
   let result=try f.networks.commit(p,approved:true);yes(result.state==NativeNetworkState(chainId:"tbc:mainnet",revision:1));yes(f.fences==1)
   yes(try result.eventsJSON==PermissionJSON.canonical(data["expectedEvents"]));try f.networks.requireDelivery(result)
   rejects{_ = try f.networks.requireState(owner:"view",scope:f.scope,expected:p.from)}
   yes(try f.networks.requireState(owner:"view",scope:f.scope,expected:result.state)==String(repeating:"1",count:64))
   rejects{_ = try f.networks.commit(p,approved:true)};rejects{_ = try f.proposal("operation","tbc:testnet",1)}
   f.epochs["tbc:mainnet"]="1";rejects{try f.networks.requireDelivery(result)}
  }
  do{let f=try Fixture(data),p=try f.proposal("noop","tbc:testnet");let c=try f.networks.commit(p,approved:false);yes(c.state.revision==0 && c.eventsJSON=="[]" && f.fences==0)}
  do{let f=try Fixture(data),p=try f.proposal();rejects("NETWORK_REJECTED"){_ = try f.networks.commit(p,approved:false)};yes(try f.state().chainId=="tbc:testnet" && f.fences==0)}
  for kind in ["lock-source","lock-target","revoke-target","epoch-source","epoch-target","expiry","navigation","cancel","fence-fail","fence-change"]{
   let f=try Fixture(data),p=try f.proposal()
   switch kind{
   case "lock-source":f.locked.insert("tbc:testnet")
   case "lock-target":f.locked.insert("tbc:mainnet")
   case "revoke-target":f.ungranted.insert("tbc:mainnet")
   case "epoch-source":f.epochs["tbc:testnet"]="1"
   case "epoch-target":f.epochs["tbc:mainnet"]="1"
   case "expiry":f.time+=120000
   case "navigation":f.active=false
   case "cancel":try f.networks.cancel(owner:"view",scope:f.scope,operation:p.operation)
   case "fence-fail":f.failFence=true
   case "fence-change":f.changedInFence=true
   default:break
   }
   rejects{_ = try f.networks.commit(p,approved:true)}
   f.active=true;yes(try f.state().chainId=="tbc:testnet")
  }
  do{let f=try Fixture(data);f.ungranted.insert("tbc:mainnet");rejects("NETWORK_UNAUTHORIZED"){_ = try f.proposal()};rejects("NETWORK_UNSUPPORTED"){_ = try f.proposal("bad","tbc:other")}}
  do{let f=try Fixture(data),a=try f.proposal("a"),b=try f.proposal("b");let c=try f.networks.commit(a,approved:true);rejects{_ = try f.networks.commit(b,approved:true)};try f.networks.requireDelivery(c);yes(f.fences==1)}
  do{let f=try Fixture(data);try f.networks.navigation(owner:"other",scope:f.scope,initialChain:"tbc:testnet");_ = try f.networks.commit(f.proposal(),approved:true);yes(try f.networks.state(owner:"other",scope:f.scope).chainId=="tbc:testnet")}
  do{let f=try Fixture(data),p=try f.proposal();try f.networks.invalidate(owner:"view");rejects{_ = try f.networks.commit(p,approved:true)};yes(f.fences==1)}
  do{let f=try Fixture(data),p=try f.proposal();try f.networks.navigation(owner:"view",scope:f.scope,initialChain:"tbc:testnet");rejects{_ = try f.networks.commit(p,approved:true)}}
  print("{\"status\":\"NETWORK_SESSION_CAS_PASS\",\"checks\":\(checks),\"broadcasts\":0}")
 }
}
