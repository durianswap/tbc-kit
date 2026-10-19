import Foundation
import CryptoKit

struct NativeNetworkFailure:Error {let code:String}
struct NativeNetworkAuthority:Equatable {
 let epoch:String,unlocked:Bool,switchAccountIds:[String],visibleAddresses:[String]
}
struct NativeNetworkState:Equatable {let chainId:String,revision:Int}
// These are native-owned handles, not receipts a page/Dart caller may construct.
final class NativeNetworkProposal {
 let owner:String,operation:String,scope:[String:String],from:NativeNetworkState,toChainId:String
 let expiresAtMillis:Int64,fromAuthority:NativeNetworkAuthority,toAuthority:NativeNetworkAuthority
 let fromVisibleAddresses:[String]
 let proposalJSON:String,bindingJSON:String,previewJSON:String
 fileprivate init(owner:String,operation:String,scope:[String:String],from:NativeNetworkState,to:String,end:Int64,
                  source:NativeNetworkAuthority,target:NativeNetworkAuthority,visible:[String],proposal:String,binding:String,preview:String){
  self.owner=owner;self.operation=operation;self.scope=scope;self.from=from;toChainId=to;expiresAtMillis=end
  fromAuthority=source;toAuthority=target;proposalJSON=proposal;bindingJSON=binding;previewJSON=preview
  fromVisibleAddresses=visible
 }
}
final class NativeNetworkCommit {
 let owner:String,operation:String,scope:[String:String],state:NativeNetworkState,eventsJSON:String
 fileprivate let authority:NativeNetworkAuthority
 fileprivate init(_ p:NativeNetworkProposal,_ state:NativeNetworkState,_ authority:NativeNetworkAuthority,_ events:String){
  owner=p.owner;operation=p.operation;scope=p.scope;self.state=state;self.authority=authority;eventsJSON=events
 }
}

/// Native per-document selection/CAS. No HTTP, database, key access or global
/// wallet chain mutation. The registration layer supplies committed authorities
/// from each configured chain's existing custody/permission owner. All methods
/// and callbacks run synchronously on the native custody executor.
@MainActor final class NativeNetworkSessions {
 private final class Session {
  let scope:[String:String];var state:NativeNetworkState
  var used=Set<String>(),pending=[String:NativeNetworkProposal](),commits=[String:NativeNetworkCommit]()
  var committing=false
  var activeAccountIds:Set<String>?
  init(_ scope:[String:String],_ chain:String){self.scope=scope;state=NativeNetworkState(chainId:chain,revision:0)}
 }
 private let sources:[String:String],nativeCurrent:(String,[String:String])->Bool
 private let authority:(String,String)throws->NativeNetworkAuthority
 private let fence:(String,[String:String])throws->Void,clock:()->Int64
 private let activate:(String,[String:String],String,[String])throws->Void
 private var sessions=[String:Session]()
 init(sources:[String:String],nativeCurrent:@escaping(String,[String:String])->Bool,
      authority:@escaping(String,String)throws->NativeNetworkAuthority,
      fence:@escaping(String,[String:String])throws->Void,
      clock:@escaping()->Int64={Int64(Date().timeIntervalSince1970*1000)},
      activate:@escaping(String,[String:String],String,[String])throws->Void={_,_,_,_ in})throws{
  try Self.need(!sources.isEmpty && sources.count<=2 && sources.keys.allSatisfy{["tbc:mainnet","tbc:testnet"].contains($0)} && sources.values.allSatisfy{$0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil},"NETWORK_CATALOG")
  self.sources=sources;self.nativeCurrent=nativeCurrent;self.authority=authority;self.fence=fence;self.clock=clock;self.activate=activate
 }
 private static func need(_ value:Bool,_ code:String="NETWORK_STALE")throws{if !value{throw NativeNetworkFailure(code:code)}}
 private func session(_ owner:String,_ scope:[String:String])throws->Session{
  guard let s=sessions[owner],s.scope==scope,nativeCurrent(owner,scope),!s.committing else{throw NativeNetworkFailure(code:"NETWORK_STALE")};return s
 }
 func navigation(owner:String,scope:[String:String],initialChain:String)throws{
  try Self.need(sources[initialChain] != nil,"NETWORK_UNSUPPORTED")
  try Self.need(!owner.isEmpty && owner.utf8.count<=128 && (sessions[owner] != nil || sessions.count<8),"NETWORK_SCOPE")
  try Self.need(Set(scope.keys)==["webViewInstanceId","sessionId","navigationId","committedUrl","origin","topOrigin","frame","createdAt"] && scope["frame"]=="top" && scope["origin"]==scope["topOrigin"] && nativeCurrent(owner,scope),"NETWORK_SCOPE")
  if let old=sessions[owner]{try fence(owner,old.scope)}
  sessions[owner]=Session(scope,initialChain)
 }
 func invalidate(owner:String)throws{
  guard let s=sessions.removeValue(forKey:owner)else{return};try fence(owner,s.scope)
 }
 func state(owner:String,scope:[String:String])throws->NativeNetworkState{try session(owner,scope).state}
 // Route only a request carrying the current native session revision. An old
 // worker cannot silently have its queued request executed on the new chain.
 func requireState(owner:String,scope:[String:String],expected:NativeNetworkState)throws->String{
  let s=try session(owner,scope);try Self.need(s.state==expected);return sources[s.state.chainId]!
 }
 private func read(_ chain:String,_ origin:String)throws->NativeNetworkAuthority{
  let a=try authority(chain,origin)
  try Self.need(!a.epoch.isEmpty && a.epoch.utf8.count<=512 && a.switchAccountIds.count<=16 && a.visibleAddresses.count<=16 &&
   Set(a.switchAccountIds).count==a.switchAccountIds.count && Set(a.visibleAddresses).count==a.visibleAddresses.count &&
   a.switchAccountIds.allSatisfy{$0.hasPrefix(chain+":") && $0.count>chain.count+1 && $0.count<=256} &&
   a.visibleAddresses.allSatisfy{!$0.isEmpty && $0.utf8.count<=128},"NETWORK_AUTHORITY")
  return NativeNetworkAuthority(epoch:a.epoch,unlocked:a.unlocked,switchAccountIds:a.switchAccountIds.sorted(),visibleAddresses:a.visibleAddresses.sorted())
 }
 private func hash(_ v:Any)throws->String{SHA256.hash(data:Data(try PermissionJSON.canonical(v).utf8)).map{String(format:"%02x",$0)}.joined()}
 func prepare(owner:String,scope:[String:String],operation:String,target:String,expectedRevision:Int)throws->NativeNetworkProposal{
  let s=try session(owner,scope)
  try Self.need(sources[target] != nil,"NETWORK_UNSUPPORTED")
  try Self.need(s.state.revision==expectedRevision && !s.used.contains(operation) && s.used.count<128 && !operation.isEmpty && operation.utf8.count<=128)
  let origin=scope["origin"]!,a=try read(s.state.chainId,origin),b=try read(target,origin)
  // Match Core authorization, including same-chain no-op: a target-chain
  // switch grant is required before deciding whether an approval is needed.
  try Self.need(a.unlocked && b.unlocked && !b.switchAccountIds.isEmpty,"NETWORK_UNAUTHORIZED")
  let now=clock();try Self.need(now>=0 && now<253402300679999,"NETWORK_CLOCK")
  let end=now+120000,f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  let expiry=f.string(from:Date(timeIntervalSince1970:Double(end)/1000))
  let payload:[String:Any]=["version":"1.0","fromChainId":s.state.chainId,"toChainId":target,"expectedSessionRevision":String(s.state.revision),"expiresAt":expiry]
  let context:[String:Any]=["sessionId":scope["sessionId"]!,"transport":"webview","origin":origin,"topOrigin":scope["topOrigin"]!,"frame":"top","navigationId":scope["navigationId"]!,"createdAt":scope["createdAt"]!]
  let binding:[String:Any]=["version":"1.0","method":"tbc_switchChain","operationKind":"switchChain","contextHash":try hash(context),"origin":origin,"sessionId":scope["sessionId"]!,"chainId":target,"requestHash":try hash(["chainId":target]),"operationHash":try hash(payload),"expiresAt":expiry]
  let preview:[String:Any]=["operationKind":"switchChain","fromChainId":s.state.chainId,"toChainId":target,"network":["name":target=="tbc:mainnet" ? "TBC Mainnet":"TBC Testnet","nativeCurrencySymbol":"TBC"],"warnings":["CHAIN_SWITCH"]]
  let visible=a.visibleAddresses.filter{s.activeAccountIds?.contains(s.state.chainId+":"+$0) != false}
  let p=try NativeNetworkProposal(owner:owner,operation:operation,scope:scope,from:s.state,to:target,end:end,source:a,target:b,visible:visible,
   proposal:PermissionJSON.canonical(["payload":payload,"chainSwitchProposalHash":hash(payload)]),binding:PermissionJSON.canonical(["payload":binding,"bindingHash":hash(binding)]),preview:PermissionJSON.canonical(preview))
  s.used.insert(operation);s.pending[operation]=p;return p
 }
 func cancel(owner:String,scope:[String:String],operation:String)throws{let s=try session(owner,scope);s.pending.removeValue(forKey:operation);s.commits.removeValue(forKey:operation)}
 func commit(_ p:NativeNetworkProposal,approved:Bool)throws->NativeNetworkCommit{
  let s=try session(p.owner,p.scope)
  try Self.need(s.pending[p.operation]===p);s.pending.removeValue(forKey:p.operation)
  func current()throws{
   try Self.need(sessions[p.owner]===s && s.scope==p.scope && nativeCurrent(p.owner,p.scope) && s.state==p.from && clock()<p.expiresAtMillis)
   try Self.need(read(p.from.chainId,p.scope["origin"]!)==p.fromAuthority && read(p.toChainId,p.scope["origin"]!)==p.toAuthority,"NETWORK_AUTHORITY_CHANGED")
  }
  try current();let changed=p.from.chainId != p.toChainId
  if changed{try Self.need(approved,"NETWORK_REJECTED")}
  var events=[[String:Any]]()
  if changed{
   try Self.need(s.state.revision<Int32.max,"NETWORK_REVISION_LIMIT")
   s.committing=true;defer{s.committing=false}
   // Fence old permits/cache consumption before publishing the new selection.
   // Callback must not await or switch a global wallet/network configuration.
   try fence(p.owner,p.scope);try current()
   try activate(p.owner,p.scope,p.toChainId,p.toAuthority.switchAccountIds);try current()
   s.state=NativeNetworkState(chainId:p.toChainId,revision:s.state.revision+1)
   s.activeAccountIds=Set(p.toAuthority.switchAccountIds)
   s.pending.removeAll();s.commits.removeAll()
   events.append(["name":"chainChanged","payload":p.toChainId])
   let targetAddresses=p.toAuthority.visibleAddresses.filter{p.toAuthority.switchAccountIds.contains(p.toChainId+":"+$0)}
   if targetAddresses != p.fromVisibleAddresses{events.append(["name":"accountsChanged","payload":targetAddresses])}
  }
  let c=try NativeNetworkCommit(p,s.state,p.toAuthority,PermissionJSON.canonical(events));s.commits[p.operation]=c;return c
 }
 func requireDelivery(_ c:NativeNetworkCommit)throws{
  let s=try session(c.owner,c.scope)
  try Self.need(s.commits[c.operation]===c && s.state==c.state && read(c.state.chainId,c.scope["origin"]!)==c.authority)
 }
}
