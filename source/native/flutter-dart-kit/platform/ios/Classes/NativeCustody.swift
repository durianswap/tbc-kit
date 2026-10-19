import Foundation
import CoreFoundation
import CryptoKit

struct NativeCustodyFailure:Error {let code:String}
// Wallet signer may return this data-free error only when this task produced
// no signature result. It is not a retry request or a lock/cancel substitute.
struct NativeSignerUnavailable:Error {}
// Only custody converts a signer failure after current-scope checks and records
// its provenance. The private bridge must not classify exception strings.
struct NativeWorkflowStepUnavailable:Error {fileprivate init(){}}
struct NativeWorkflowCryptoUnavailable:Error {fileprivate init(){}}
public struct NativeReview {
 public let operationId:String,origin:String,chainId:String,accountAddress:String,title:String,description:String
}
extension NativeWalletProtocol {
 func approvalReview(_ review:NativeReview)->NativeReview{
  guard self == .legacy else{return review}
  return NativeReview(operationId:PermissionJSON.id(rawValue,"review",review.operationId),origin:review.origin,
   chainId:review.chainId,accountAddress:review.accountAddress,title:"Legacy · "+review.title,description:review.description)
 }
}
@MainActor public protocol NativeApprovalPresenter:AnyObject {
 // Trusted UI only. No default approval. Return an idempotent dismissal handle.
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void
}
@MainActor public protocol NativeDigestSigner:AnyObject {
 // Keys stay in the wallet. Recheck immediately at actual key use, including
 // after an asynchronous unlock. No retry of a consumed task. Reply on MainActor.
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,
  requireCurrent:@escaping @MainActor ()throws->Void,
  complete:@escaping @MainActor (Result<[UInt8],Error>)->Void)
}
@MainActor protocol NativeReviewedComputer:AnyObject {
 // Pinned keyless Rust only, off the UI executor. Return once on this owner.
 // No Vault, HTTP, logging of arguments, library path or page registration.
 func call(method:String,input:String,complete:@escaping @MainActor (Result<String,Error>)->Void)
}
struct NativeWalletSnapshot {
 let account:NativeAccount,revision:Int,accountRevision:Int64,unlocked:Bool,permissions:[[String:Any]],connectedAccounts:[NativeAccount]
 let optionalMethods:[String]
}
struct NativeCustodyNetworkAuthority {
 let epoch:String,unlocked:Bool,switchAccountIds:[String],visibleAddresses:[String]
}

// Shared native permission/consent/task owner adapted from sealed P5. Currently
// enabled message/transaction profiles only; no default keys, auto approval, HTTP,
// transaction journal or contract algorithm. The worker still validates Engine
// plans and finalized transactions; this owner independently checks the binding.
@MainActor final class NativeCustody {
 private final class Session {
  let owner:String,scope:[String:String];var revision=0
  var activeAccountIds:Set<String>?
  var used=Set<String>(),cancelled=Set<String>(),operations=[String:Operation]()
  var pending=[String:@MainActor ()->Void](),results=[String:DeliveryPermit]()
  var maintenance:Maintenance?
  init(owner:String,scope:[String:String]){self.owner=owner;self.scope=scope}
 }
 private final class Operation {
  let session:Session,id:String,method:String,revision:Int,accountRevision:Int64,account:NativeAccount,epoch:String
  var request:[String:Any]?,receipt:[String:Any]?,approved=false
  var tasks=[String:[String:Any]](),consumed=Set<String>(),completed=Set<String>()
  var expectedTasks=0,stage=0,transactionCount=1,exactTaskCount=true
  var planHash:String?,stageSession:String?,transactionIds=Set<String>()
  var controller:NativeAccount?,roleRequestHash:String?
  var typedEnvelope:[String:Any]?,preparedProposal:[String:Any]?
  var reviewedConsent:[String:Any]?,reviewedBound:NativeReviewed.Bound?,reviewedStage:[String:Any]?
  var reviewedTasks=[[String:Any]](),reviewedParents=[String](),reviewedSignatures=[String:String]()
  var reviewedDetached=[Int:Any]()
  var requestHash:String?
  var workflow:Workflow?,consentFeeCap:String?
  weak var workflowParent:Operation?
  var workflowEnvelope:[String:Any]?,signedResults=[String:[String:Any]]()
  var signerUnavailable=false
  var cryptoUnavailable=false
  var cryptoResultHash:String?
  // Send-only metadata; signing-only operations allocate no broadcast state.
  var sendPlan:[String:Any]?,sendMaterial:[String:Any]?
  var sendResultHash:String?
  var maintenance:Maintenance?,maintenanceStep:[String:Any]?,maintenanceRequestHash:String?
  var maintenanceRecoveryId:String?
  var maintenanceInputs=Set<String>(),maintenanceBoundInputs=Set<String>(),maintenanceFee:UInt64?
  var broadcastClosers=[String:()->Void]()
  var broadcastStates=[String:()throws->[[String:String]]]()
  init(session:Session,id:String,method:String,revision:Int,accountRevision:Int64,account:NativeAccount,epoch:String){
   self.session=session;self.id=id;self.method=method;self.revision=revision;self.accountRevision=accountRevision;self.account=account;self.epoch=epoch
  }
 }
 private final class Workflow {
  let request:[String:Any],requestHash:String,steps:[[String:Any]],requests:[[String:Any]],children:[Operation],expiresAt:Date
  var consentPlanHash:String?,consentFeeCap:String?
  var bindingStarted=false,bound:NativeWorkflow.Binding?
  var nextIndex=0,activeIndex:Int?,completedResults=[String:[String:Any]]()
  var unavailableResults=[String:[String:Any]]()
  init(request:[String:Any],requestHash:String,steps:[[String:Any]],requests:[[String:Any]],children:[Operation],expiresAt:Date){self.request=request;self.requestHash=requestHash;self.steps=steps;self.requests=requests;self.children=children;self.expiresAt=expiresAt}
 }
 // One native-owned, ephemeral consent; no page flag, signing journal or
 // replacement transaction executor. Child operations retain all usual gates.
 private final class Maintenance {
  let session:Session,id:String,revision:Int,accountRevision:Int64,account:NativeAccount,epoch:String
  let scope:[String:Any],scopeHash:String,approvalId:String,expiresAt:Date,maxFee:UInt64,maxTransactions:Int,inputLimit:Int
  var approved=false,stopped=false,nextIndex=1,spent:UInt64=0,activeChild:String?
  var accepted=Set<String>(),consumedInputs=Set<String>()
  var childIds=Set<String>()
  var completedRows=[[String:Any]](),failedStep:[String:Any]?,failureMayHaveSubmitted=false
  var failureRecoveryId:String?
  init(session:Session,id:String,account:NativeAccount,accountRevision:Int64,epoch:String,scope:[String:Any],scopeHash:String,expiresAt:Date,maxFee:UInt64,maxTransactions:Int,inputLimit:Int){
   self.session=session;self.id=id;self.account=account;self.accountRevision=accountRevision;self.revision=session.revision;self.epoch=epoch
   self.scope=scope;self.scopeHash=scopeHash;self.expiresAt=expiresAt;self.maxFee=maxFee;self.maxTransactions=maxTransactions;self.inputLimit=inputLimit;approvalId=UUID().uuidString
  }
 }
 private struct DeliveryPermit {
  let revision:Int,accountRevision:Int64,account:NativeAccount,epoch:String,capability:String,controller:NativeAccount?
  var workflowMethod:String?=nil,workflowResultHash:String?=nil
  var cryptoMethod:String?=nil,cryptoResultHash:String?=nil
  var sendMethod:String?=nil,sendResultHash:String?=nil
  var maintenanceResultHash:String?=nil
  var maintenanceTarget:Int?=nil
 }
 private let accounts:NativeAccountSource,chain:String,approval:NativeApprovalPresenter,signer:NativeDigestSigner
 private let nativeCurrent:(String,[String:String])->Bool
 private let reviewedComputer:NativeReviewedComputer?
 private let crypto:NativeBie1Executor?
 // Native wallet configuration only. Absence keeps sends/permission disabled.
 // This source binding alone does not install HTTP or advertise Provider sends.
 private let sendSourceIdentity:String?
 let walletProtocol:NativeWalletProtocol
 private var broadcastRegistered=false
 // Called only by the native Host installing its owned Router, before any
 // document exists. Configuration alone never advertises a working sender.
 func registerBroadcast()throws{
  try need(sendSourceIdentity != nil && !broadcastRegistered && sessions.isEmpty,"NATIVE_BROADCAST_CONFIGURATION")
  broadcastRegistered=true
 }
 var supportsCrypto:Bool{crypto != nil}
 var supportsReviewed:Bool{reviewedComputer != nil}
 private var sessions=[String:Session](),permissions:NativePermissions!
 init(accounts:NativeAccountSource,chain:String,backend:NativePermissionBackend,
  approval:NativeApprovalPresenter,signer:NativeDigestSigner,reviewedComputer:NativeReviewedComputer?=nil,crypto:NativeBie1Executor?=nil,sendSourceIdentity:String?=nil,walletProtocol:NativeWalletProtocol = .standard,
  nativeCurrent:@escaping(String,[String:String])->Bool)throws{
  if let source=sendSourceIdentity,source.range(of:"^[0-9a-f]{64}$",options:.regularExpression)==nil{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_SOURCE")}
  self.walletProtocol=walletProtocol;self.accounts=accounts;self.chain=chain;self.approval=approval;self.signer=signer;self.nativeCurrent=nativeCurrent;self.reviewedComputer=reviewedComputer;self.crypto=crypto;self.sendSourceIdentity=sendSourceIdentity
  permissions=try NativePermissions(accounts:accounts,chain:chain,backend:backend,walletProtocol:walletProtocol){[weak self] origin in
   guard let self else{return}
   for s in Array(self.sessions.values) where origin==nil || s.scope["origin"]==origin{self.fence(s)}
  }
 }
 private func need(_ ok:Bool,_ code:String="NATIVE_DENIED")throws{if !ok{throw NativeCustodyFailure(code:code)}}
 private func session(_ owner:String,_ scope:[String:String])throws->Session{
  guard let s=sessions[owner]else{throw NativeCustodyFailure(code:"NATIVE_SCOPE_CHANGED")}
  try need(s.scope==scope && nativeCurrent(owner,s.scope),"NATIVE_SCOPE_CHANGED")
  try need(accounts.current.chainId==chain,"NATIVE_CHAIN_CHANGED");return s
 }
 private func fence(_ s:Session){
  s.revision+=1;s.results.removeAll()
  s.maintenance?.stopped=true;s.maintenance=nil
  let operations=Array(s.operations.values);s.operations.removeAll()
  for o in operations{closeBroadcasts(o)}
  let cancel=Array(s.pending.values);s.pending.removeAll();for f in cancel{f()}
 }
 // Only the native WebView adapter supplies a verified committed document.
 // Navigation affects this document, not the account lock or another document.
 func navigation(owner:String,scope:[String:String])throws{
  try need(Set(scope.keys)==["webViewInstanceId","sessionId","navigationId","committedUrl","origin","topOrigin","frame","createdAt"])
  try need(scope["frame"]=="top" && scope["origin"]==scope["topOrigin"] && nativeCurrent(owner,scope),"NATIVE_SCOPE_CHANGED")
  invalidate(owner:owner);sessions[owner]=Session(owner:owner,scope:scope)
 }
 func invalidate(owner:String){if let s=sessions.removeValue(forKey:owner){fence(s)}}
 // Network selection changes revoke this document's permits without replacing
 // its replay ledger, grants or any other WebView's session.
 func fenceDocument(owner:String){if let s=sessions[owner]{fence(s)}}
 // Called only by the native network commit, not a private/page command. The
 // scope survives selection changes; no global Vault/account mutation occurs.
 func activateAccounts(owner:String,scope:[String:String],accountIds:[String])throws{
  let s=try session(owner,scope),selected=try permissions.selectedAccounts()
  try need(!accountIds.isEmpty && Set(accountIds).count==accountIds.count && accountIds.allSatisfy{id in selected.contains{$0.accountId==id}},"NATIVE_ACCOUNT_SELECTION")
  for account in selected where accountIds.contains(account.accountId){try permissions.require(scope["origin"]!,"tbc_switchChain",account:account)}
  fence(s);s.activeAccountIds=Set(accountIds)
 }
 private func selectedAccount(_ s:Session)throws->NativeAccount{
  guard let ids=s.activeAccountIds,!ids.contains(accounts.current.accountId) else{return accounts.current}
  // A no-longer-selected identity is never made signable by this private
  // fallback; requireActive and permission checks deny it before key use.
  return try permissions.selectedAccounts().filter{ids.contains($0.accountId)}.sorted{$0.accountId<$1.accountId}.first ?? accounts.current
 }
 private func requireActive(_ s:Session,_ account:NativeAccount)throws{try need(s.activeAccountIds?.contains(account.accountId) != false,"NATIVE_ACCOUNT_SELECTION")}
 private func permissionAccount(_ account:NativeAccount)->NativeAccount?{account==accounts.current ? nil:account}
 func validateNetworkLane(chainId:String,sourceIdentity:String)throws{
  try need(chainId==chain && accounts.current.chainId==chain &&
   (sendSourceIdentity==nil || sendSourceIdentity==sourceIdentity),"NATIVE_CHAIN_CHANGED")
 }
 func networkAuthority(origin:String)throws->NativeCustodyNetworkAuthority{
  try need(accounts.current.chainId==chain,"NATIVE_CHAIN_CHANGED")
  let selected=try permissions.selectedAccounts()
  let visible=try selected.filter{try accounts.unlocked && permissions.permits(origin,"tbc_accounts",account:$0)}
  let switchable=try visible.filter{try permissions.permits(origin,"tbc_switchChain",account:$0)}
  // Never include document revision: switching itself increments that revision.
  // Account selection and grant changes must still invalidate pending switches.
  return NativeCustodyNetworkAuthority(epoch:permissions.epoch(origin),unlocked:accounts.unlocked,
   switchAccountIds:switchable.map{$0.accountId},visibleAddresses:visible.map{$0.address})
 }
 func networkPermissions(origin:String)throws->[[String:Any]]{
  var found=[String:[String:Any]]()
  for account in try permissions.selectedAccounts(){for row in try permissions.records(origin,account:account){found[row["id"] as! String]=row}}
  return found.keys.sorted().map{found[$0]!}
 }
 func accountChanged(){for s in Array(sessions.values){fence(s)}}
 func snapshot(owner:String,scope:[String:String])throws->NativeWalletSnapshot{
  let s=try session(owner,scope),account=try selectedAccount(s)
  let connected=accounts.unlocked ? try permissions.selectedAccounts().filter{try s.activeAccountIds?.contains($0.accountId) != false && permissions.permits(s.scope["origin"]!,"tbc_accounts",account:$0)}:[]
  return NativeWalletSnapshot(account:account,revision:s.revision,accountRevision:accounts.revision,
   unlocked:accounts.unlocked,permissions:try permissions.records(s.scope["origin"]!,account:permissionAccount(account)),
   connectedAccounts:s.activeAccountIds==nil ? connected:connected.sorted{$0.accountId<$1.accountId},optionalMethods:(supportsCrypto ? NativeCrypto.methods.sorted():[])+(broadcastRegistered ? NativePrepared.sendMethods:[]))
 }
 private func reserve(_ s:Session,_ id:String)throws{
  // Active work is bounded independently of non-evictable document replay IDs.
  try need(id.range(of:"^[A-Za-z0-9._:-]{1,256}$",options:.regularExpression) != nil && s.used.count<100000 && s.operations.count+s.pending.count<128,"NATIVE_OPERATION_LIMIT")
  try need(!s.cancelled.contains(id) && s.used.insert(id).inserted,"NATIVE_REPLAY")
 }
 func cancel(owner:String,scope:[String:String],id:String)throws{
  let s=try session(owner,scope);try need(s.cancelled.count<100000 || s.cancelled.contains(id),"NATIVE_OPERATION_LIMIT")
  if let m=s.maintenance,m.id==id || m.activeChild==id{stopMaintenance(m)}
  s.cancelled.insert(id);s.results.removeValue(forKey:id)
  if let o=s.operations.removeValue(forKey:id){closeBroadcasts(o)}
  s.pending.removeValue(forKey:id)?()
 }
 private func current(_ s:Session,_ revision:Int,_ account:NativeAccount,_ accountRevision:Int64,_ id:String,grant:Bool=false)throws{
  try need(session(s.owner,s.scope)===s && s.revision==revision && !s.cancelled.contains(id),"NATIVE_REVISION_CHANGED")
  let selected=grant ? accounts.current:try selectedAccount(s)
  try need(accounts.unlocked && accounts.revision==accountRevision && selected==account,"NATIVE_REVISION_CHANGED")
  if !grant{try requireActive(s,account)}
 }
 private func current(_ o:Operation)throws{
  if let parent=o.workflowParent{
   try current(parent)
   guard let w=parent.workflow,let i=w.activeIndex else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_INACTIVE")}
   try need(w.children[i]===o && parent.receipt != nil && canonical(parent.receipt)==canonical(o.receipt),"NATIVE_WORKFLOW_INACTIVE")
   return
  }
  try current(o.session,o.revision,o.account,o.accountRevision,o.id)
  try need(o.session.operations[o.id]===o,"NATIVE_OPERATION_GONE")
  try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(o.method),account:permissionAccount(o.account))
  if NativePrepared.sends(o.method){try need(sendSourceIdentity != nil,"NATIVE_BROADCAST_UNAVAILABLE");try permissions.require(o.session.scope["origin"]!,"tbc_sendTransaction",account:permissionAccount(o.account))}
  if let controller=o.controller{try requireActive(o.session,controller);try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(o.method),account:controller)}
  if let workflow=o.workflow{
   try need(Date()<workflow.expiresAt,"NATIVE_EXPIRED")
   for child in workflow.children{
    try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(child.method),account:permissionAccount(child.account))
    if let controller=child.controller{try requireActive(o.session,controller);try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(child.method),account:controller)}
   }
  }
  try need(permissions.epoch(o.session.scope["origin"]!)==o.epoch,"NATIVE_REVISION_CHANGED")
  if let m=o.maintenance{try currentMaintenance(m);try need(m.approved && m.activeChild==o.id,"NATIVE_MERGE_INACTIVE")}
 }
 private func currentMaintenance(_ m:Maintenance)throws{
  try maintenanceAuthority(m)
  try need(!m.stopped && Date()<m.expiresAt,"NATIVE_MERGE_INACTIVE")
 }
 private func maintenanceAuthority(_ m:Maintenance)throws{
  try current(m.session,m.revision,m.account,m.accountRevision,m.id)
  try need(m.session.maintenance===m,"NATIVE_MERGE_INACTIVE")
  try need(broadcastRegistered && sendSourceIdentity != nil && permissions.epoch(m.session.scope["origin"]!)==m.epoch,"NATIVE_REVISION_CHANGED")
  for method in ["tbc_accounts","tbc_sendTransaction"]{try permissions.require(m.session.scope["origin"]!,method,account:permissionAccount(m.account))}
 }
 private func stopMaintenance(_ m:Maintenance){
  m.stopped=true;if m.session.maintenance===m{m.session.maintenance=nil}
  for id in m.childIds{m.session.results.removeValue(forKey:id)}
  if let child=m.activeChild{if let o=m.session.operations.removeValue(forKey:child){closeBroadcasts(o)};m.session.pending.removeValue(forKey:child)?()}
  m.session.pending.removeValue(forKey:m.id)?()
 }
 // Native private host only. Initial index count is informational; each child
 // must still prove its actual inputs through the shared Engine/material path.
 func beginMaintenance(owner:String,scope:[String:String],id:String,expectedRevision:Int,expectedAccount:NativeAccount,consent:[String:Any],noopResult:[String:Any]?=nil,complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  let s=try session(owner,scope),account=try selectedAccount(s),r=try immutable(consent)
  try need(s.maintenance==nil && s.revision==expectedRevision && account==expectedAccount,"NATIVE_MERGE_ACTIVE")
  try current(s,s.revision,account,accounts.revision,id)
  try need(broadcastRegistered && sendSourceIdentity != nil,"NATIVE_BROADCAST_UNAVAILABLE")
  for method in ["tbc_accounts","tbc_sendTransaction"]{try permissions.require(s.scope["origin"]!,method,account:permissionAccount(account))}
  try need(Set(r.keys)==["version","operationKind","authority","asset","impact","limits","initialStateHash","initialUtxoCount"] && r["version"] as? String=="1.0" && r["operationKind"] as? String=="multi-round-merge","NATIVE_MERGE_SCOPE")
  let authority:[String:Any]=["chainId":chain,"accountId":account.accountId,"origin":s.scope["origin"]!,"sessionId":s.scope["sessionId"]!]
  try need(canonical(r["authority"])==canonical(authority),"NATIVE_MERGE_SCOPE")
  let asset=try map(r["asset"]),kind=try string(asset["kind"]),pool=["pool-ft","ftlp"].contains(kind)
  try need(["tbc","ft","stablecoin","pool-ft","ftlp"].contains(kind) && Set(asset.keys)==(kind=="tbc" ? ["kind"]:pool ? ["kind","poolContractId"]:["kind","contractId"]),"NATIVE_MERGE_ASSET")
  if kind != "tbc"{_ = try digest(asset[pool ? "poolContractId":"contractId"])}
  let impact=try map(r["impact"]),limit=kind=="tbc" ? 100:kind=="pool-ft" ? 4:5,custody=kind=="pool-ft" ? "pool-contract":"active-account"
  var expected:[String:Any]=["custody":custody,"resultOwner":custody,"maxAssetInputsPerTransaction":limit]
  if pool{let p=try map(impact["poolIdentity"]);try need(Set(p.keys)==["poolContractId","ftContractId","currentPoolTxid"] && p["poolContractId"] as? String==asset["poolContractId"] as? String,"NATIVE_MERGE_POOL");_ = try digest(p["ftContractId"]);_ = try digest(p["currentPoolTxid"]);expected["poolIdentity"]=p}
  try need(canonical(impact)==canonical(expected),"NATIVE_MERGE_IMPACT")
  let limits=try map(r["limits"]),count=try integer(r["initialUtxoCount"]),target=try integer(limits["targetUtxoCount"]),maximum=try integer(limits["maxTransactions"]),fee=try amount(limits["maxTotalFee"]),expiry=try date(limits["expiresAt"])
  try need(Set(limits.keys)==["targetUtxoCount","maxTransactions","maxTotalFee","expiresAt","maxIndexRefreshes","indexRefreshDelayMs"] && (1...1000000).contains(target) && count>=0 && (noopResult==nil ? count>target:count<=target) && count<=9007199254740991 && (1...64).contains(maximum) && fee<=2100000000000000 && expiry>Date(),"NATIVE_MERGE_LIMITS")
  try need((0...32).contains(integer(limits["maxIndexRefreshes"])) && (0...60000).contains(integer(limits["indexRefreshDelayMs"])),"NATIVE_MERGE_LIMITS");_ = try digest(r["initialStateHash"])
  try reserve(s,id)
  let m=try Maintenance(session:s,id:id,account:account,accountRevision:accounts.revision,epoch:permissions.epoch(s.scope["origin"]!),scope:r,scopeHash:hash(r),expiresAt:expiry,maxFee:fee,maxTransactions:maximum,inputLimit:limit);s.maintenance=m
  if let result=noopResult{
   defer{stopMaintenance(m)}
   let expected:[String:Any]=["version":"1.0","status":"complete","reason":"already-below-target","scopeHash":m.scopeHash,"initialUtxoCount":count,"finalUtxoCount":count,"totalFee":"0","steps":[Any]()]
   try need(canonical(result)==canonical(expected),"NATIVE_MERGE_RESULT")
   // Observed count, not chain confirmation proof; no approval or child exists.
   s.results[id]=DeliveryPermit(revision:m.revision,accountRevision:m.accountRevision,account:m.account,epoch:m.epoch,capability:"tbc_accounts",controller:nil,maintenanceResultHash:try hash(expected),maintenanceTarget:target)
   complete(.success(["status":"not-required"]));return
  }
  let assetId=asset[pool ? "poolContractId":"contractId"] as? String ?? "TBC"
  let description="Merge \(kind) inputs: \(assetId). Result owner: \(custody) (\(kind=="pool-ft" ? assetId:account.address)).\nObserved inputs: \(count); target: \(target); at most \(maximum) transactions and \(fee) native atomic total fees.\nExpires: \(try string(limits["expiresAt"])). Each transaction remains validated and signed separately. Unknown submissions stop this run; no automatic retry."
  decision(s,id,NativeReview(operationId:id,origin:s.scope["origin"]!,chainId:chain,accountAddress:account.address,title:"Approve bounded maintenance",description:description),finish:{yes in
   try self.currentMaintenance(m);if !yes{m.stopped=true;s.maintenance=nil;throw NativeCustodyFailure(code:"USER_REJECTED")};m.approved=true
   return ["status":"approved","scopeHash":m.scopeHash,"approvalId":m.approvalId,"approvedAt":self.wireNow(),"expiresAt":limits["expiresAt"]!]
  },complete:complete)
 }
 func beginMaintenanceStep(owner:String,scope:[String:String],parent:String,id:String,step:[String:Any],request:[String:Any],selectedInputs:[String])throws->NativeWalletSnapshot{
  let s=try session(owner,scope);guard let m=s.maintenance,m.id==parent else{throw NativeCustodyFailure(code:"NATIVE_MERGE_INACTIVE")};try currentMaintenance(m)
  try need(m.approved && m.activeChild==nil && m.nextIndex<=m.maxTransactions,"NATIVE_MERGE_STEP")
  let r=try immutable(request),t=try immutable(step),asset=try map(m.scope["asset"]),kind=try string(asset["kind"]),remaining=m.maxFee-m.spent
  let identity=try hash(["domain":"tbc-kit/multi-round-step/1","scopeHash":m.scopeHash,"approvalId":m.approvalId,"stepIndex":m.nextIndex])
  var intent:[String:Any]=["version":"1.0","type":["tbc":"tbc.maintenance.merge","ft":"tbc20.merge","stablecoin":"tbc20Stablecoin.merge","pool-ft":"amm.mergeToken","ftlp":"tbc20Lp.merge"][kind]!]
  for k in ["contractId","poolContractId"]{if let v=asset[k]{intent[k]=v}}
  let constraints=try map(r["constraints"]),expiry=try date(constraints["expiresAt"])
  try need(Set(r.keys)==["version","chainId","from","clientRequestId","intent","constraints"] && r["version"] as? String=="1.0" && r["chainId"] as? String==chain && r["from"] as? String==m.account.address && r["clientRequestId"] as? String=="kit-multi-round-"+identity && canonical(r["intent"])==canonical(intent),"NATIVE_MERGE_REQUEST")
  try need(Set(constraints.keys)==["expiresAt","maxFee","feePreference"] && constraints["feePreference"] as? String=="standard" && amount(constraints["maxFee"])==remaining && expiry>Date() && expiry<=m.expiresAt,"NATIVE_MERGE_FEE")
  try need(Set(t.keys)==["version","stepId","stepIndex","authority","asset","stateHash","materialHash","inputCount","outputCount","feeKind","fee","expiresAt","dependsOn"] && t["version"] as? String=="1.0" && integer(t["stepIndex"])==m.nextIndex && t["stepId"] as? String=="merge-\(m.nextIndex)" && canonical(t["authority"])==canonical(m.scope["authority"]) && canonical(t["asset"])==canonical(asset) && t["materialHash"] as? String==hash(r) && t["feeKind"] as? String=="maximum" && amount(t["fee"])==remaining && date(t["expiresAt"])==expiry && integer(t["outputCount"])==1,"NATIVE_MERGE_STEP")
  _ = try digest(t["stateHash"])
  if m.nextIndex==1{try need(t["stateHash"] as? String==m.scope["initialStateHash"] as? String,"NATIVE_MERGE_STATE")}
  let inputs=Set(selectedInputs),count=try integer(t["inputCount"])
  try need((2...m.inputLimit).contains(count) && count==inputs.count && count==selectedInputs.count && inputs.allSatisfy{$0.range(of:"^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$",options:.regularExpression) != nil},"NATIVE_MERGE_INPUTS")
  try need(inputs.isDisjoint(with:m.consumedInputs),"NATIVE_MERGE_SPENT_INPUT")
  guard let deps=t["dependsOn"] as? [String]else{throw NativeCustodyFailure(code:"NATIVE_MERGE_DEPENDENCY")}
  try need(Set(deps).count==deps.count && deps.allSatisfy{m.accepted.contains($0)},"NATIVE_MERGE_DEPENDENCY")
  try need(Set(deps)==Set(inputs.compactMap{point->String? in let tx=String(point.prefix(64));return m.accepted.contains(tx) ? tx:nil}),"NATIVE_MERGE_DEPENDENCY")
  let snapshot=try begin(owner:owner,scope:scope,id:id,method:"tbc_sendTransaction",expectedRevision:m.revision,expectedAccount:m.account)
  let o=s.operations[id]!;o.maintenance=m;o.maintenanceStep=t;o.maintenanceInputs=inputs;o.maintenanceRequestHash=try hash(r);m.activeChild=id;m.childIds.insert(id);return snapshot
 }
 private func bindMaintenance(_ o:Operation,_ payload:[String:Any],_ review:[String:Any],_ expiry:Date)throws{
  guard let m=o.maintenance else{return};try currentMaintenance(m)
  let txs=payload["transactions"] as? [[String:Any]] ?? [],fee=try amount(review["totalFee"])
  let requestedExpiry=try date(map(o.request!["constraints"])["expiresAt"])
  try need(txs.count==1 && integer(review["transactionCount"])==1 && expiry<=requestedExpiry && date(payload["expiresAt"])<=requestedExpiry && fee<=m.maxFee-m.spent,"NATIVE_MERGE_BOUND")
  let inputs=try NativePrepared.inputOutpoints(txs[0]["unsignedTransaction"])
  try need(Set(inputs).count==inputs.count && o.maintenanceInputs.isSubset(of:Set(inputs)) && (txs[0]["dependsOn"] as? [String])==[] && amount(txs[0]["fee"])==fee,"NATIVE_MERGE_INPUTS")
  try need(Set(inputs).isDisjoint(with:m.consumedInputs),"NATIVE_MERGE_SPENT_INPUT")
  let kind=try string(map(m.scope["asset"])["kind"])
  if kind=="tbc"{try need(Set(inputs)==o.maintenanceInputs,"NATIVE_MERGE_INPUTS")}
  guard let flows=review["assetFlows"] as? [[String:Any]],flows.count==2,let merged=flows.first(where:{$0["direction"] as? String=="merge"}),let cost=flows.first(where:{$0["direction"] as? String=="fee"})else{throw NativeCustodyFailure(code:"NATIVE_MERGE_EFFECT")}
  let flowKind=["tbc":"native","ft":"ft","stablecoin":"stablecoin","pool-ft":"ft","ftlp":"lp"][kind]!
  try need(merged["kind"] as? String==flowKind && merged["from"] as? String==o.account.address && merged["to"] as? String==o.account.address && cost["kind"] as? String=="native" && cost["from"] as? String==o.account.address && cost["to"]==nil && amount(cost["amount"])==fee,"NATIVE_MERGE_EFFECT")
  if let contract=merged["contractId"]{let asset=try map(m.scope["asset"]),expected=try kind=="pool-ft" ? map(map(m.scope["impact"])["poolIdentity"])["ftContractId"]:asset[kind=="ftlp" ? "poolContractId":"contractId"];try need(canonical(contract)==canonical(expected),"NATIVE_MERGE_EFFECT")}
  // Historical Pool FT preview names the initiator, not the Pool custody.
  // Immutable poolId + shared Engine validation prove that contract effect.
  o.maintenanceFee=fee;o.maintenanceBoundInputs=Set(inputs)
 }
 func closeMaintenance(owner:String,scope:[String:String],id:String)throws{
  let s=try session(owner,scope);if let m=s.maintenance,m.id==id{stopMaintenance(m)}
 }
 // Attest only native-owned submission facts. Index counts remain an observed
 // progress report, not proof of confirmations. No HTTP or extra durable write.
 func finishMaintenance(owner:String,scope:[String:String],id:String,result:[String:Any])throws{
  let s=try session(owner,scope);guard let m=s.maintenance,m.id==id else{throw NativeCustodyFailure(code:"NATIVE_MERGE_INACTIVE")}
  try maintenanceAuthority(m)
  let r=try immutable(result),limits=try map(m.scope["limits"])
  try need(m.approved && m.activeChild==nil && Set(r.keys)==["version","status","reason","scopeHash","approvalId","initialUtxoCount","finalUtxoCount","totalFee","steps"] && r["version"] as? String=="1.0" && r["scopeHash"] as? String==m.scopeHash && r["approvalId"] as? String==m.approvalId && canonical(r["initialUtxoCount"])==canonical(m.scope["initialUtxoCount"]),"NATIVE_MERGE_RESULT")
  guard let rows=r["steps"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"NATIVE_MERGE_RESULT")}
  let extra=m.failedStep==nil ? 0:1
  try need(rows.count==m.completedRows.count+extra && rows.count<=m.maxTransactions && canonical(Array(rows.prefix(m.completedRows.count)))==canonical(m.completedRows),"NATIVE_MERGE_RESULT")
  var total=m.spent
  if let step=m.failedStep{
   let row=rows.last!,status=try string(row["status"])
   var expected:[String:Any]=["stepId":step["stepId"]!,"status":status,"fee":"0","inputCount":step["inputCount"]!,"outputCount":1,"dependsOn":step["dependsOn"]!]
   if m.failureMayHaveSubmitted{
    try need(status=="uncertain","NATIVE_MERGE_RESULT");total+=try amount(step["fee"]);expected["fee"]=step["fee"]
    if let key=row["recoveryId"] as? String{try need(key==m.failureRecoveryId,"NATIVE_MERGE_RESULT");expected["recoveryId"]=key}
   }else{try need(["failed","rejected"].contains(status),"NATIVE_MERGE_RESULT")}
   try need(canonical(row)==canonical(expected),"NATIVE_MERGE_RESULT")
  }
  let final=try integer(r["finalUtxoCount"]),target=try integer(limits["targetUtxoCount"]),reason=try string(r["reason"]),status=try string(r["status"])
  try need((0...9007199254740991).contains(final) && amount(r["totalFee"])==total && total<=m.maxFee,"NATIVE_MERGE_RESULT")
  if m.failureMayHaveSubmitted{try need(status=="uncertain" && reason=="broadcast-uncertain","NATIVE_MERGE_RESULT")}
  else if status=="complete"{
   let reduction=try m.completedRows.reduce(0){try $0+integer($1["inputCount"])-1}
   try need(m.failedStep==nil && !m.completedRows.isEmpty && reason=="target-reached" && final==integer(m.scope["initialUtxoCount"])-reduction && final<=target,"NATIVE_MERGE_RESULT")
  }else{
   try need(status==(m.completedRows.isEmpty ? "stopped":"partial") && ["cancelled","expired","facts-changed","step-failed","fee-budget-exhausted","step-rejected","index-stalled","transaction-budget-exhausted"].contains(reason),"NATIVE_MERGE_RESULT")
   if reason=="transaction-budget-exhausted"{try need(rows.count==m.maxTransactions && m.failedStep==nil,"NATIVE_MERGE_RESULT")}
   if m.failedStep != nil{try need(reason==(rows.last!["status"] as? String=="rejected" ? "step-rejected":"step-failed"),"NATIVE_MERGE_RESULT")}
  }
  let digest=try hash(r)
  s.results[id]=DeliveryPermit(revision:m.revision,accountRevision:m.accountRevision,account:m.account,epoch:m.epoch,capability:"tbc_accounts",controller:nil,maintenanceResultHash:digest,maintenanceTarget:target)
  stopMaintenance(m)
 }
 private func decision<T>(_ s:Session,_ id:String,_ review:NativeReview,
  finish:@escaping @MainActor (Bool)throws->T,complete:@escaping @MainActor (Result<T,Error>)->Void){
  var done=false;var dismiss:(@MainActor ()->Void)?
  func result(_ value:Result<T,Error>){guard !done else{return};done=true;s.pending.removeValue(forKey:id);complete(value);dismiss?()}
  s.pending[id]={result(.failure(NativeCustodyFailure(code:"NATIVE_CANCELLED")))}
  dismiss=approval.present(walletProtocol.approvalReview(review)){yes in if !done{result(Result{try finish(yes)})}}
  if done{dismiss?()}
 }
 private func grantProposal(owner:String,scope:[String:String],id:String,request:[String:Any])throws->(Session,NativeGrantProposal){
  try need(crypto != nil || !request.keys.contains("tbc_crypto"),"UNSUPPORTED_PERMISSION")
  try need(sendSourceIdentity != nil || !request.keys.contains("tbc_sendTransaction"),"UNSUPPORTED_PERMISSION")
  let s=try session(owner,scope);try reserve(s,id)
  let proposal=try permissions.proposal(origin:s.scope["origin"]!,request:immutable(request),operationId:id)
  return(s,proposal)
 }
 // Native-only group handle. No page/MethodChannel input can provide the
 // proposal, store owner, lifecycle fence or commit acknowledgement.
 func prepareNetworkGrant(owner:String,scope:[String:String],id:String,request:[String:Any],cancel:@escaping @MainActor ()->Void)throws->NativePermissionGrant{
  let(s,proposal)=try grantProposal(owner:owner,scope:scope,id:id,request:request)
  let revision=s.revision,account=accounts.current,accountRevision=accounts.revision
  s.pending[id]=cancel
  return NativePermissionGrant(permissions:permissions,proposal:proposal,check:{
   try self.current(s,revision,account,accountRevision,id,grant:true)
  },detach:{s.pending.removeValue(forKey:id)})
 }
 func requestPermissions(owner:String,scope:[String:String],id:String,request:[String:Any],
  complete:@escaping @MainActor (Result<[[String:Any]],Error>)->Void)throws{
  let(s,proposal)=try grantProposal(owner:owner,scope:scope,id:id,request:request)
  let revision=s.revision,account=accounts.current,accountRevision=accounts.revision
  let review=NativeReview(operationId:id,origin:proposal.origin,chainId:chain,accountAddress:account.address,title:"Connect wallet",
   description:proposal.capabilities.joined(separator:", ")+".\nAccounts:\n"+proposal.accounts.map{$0.address}.joined(separator:"\n")+"\nEach signature still requires approval.")
  decision(s,id,review,finish:{yes in
   try self.current(s,revision,account,accountRevision,id,grant:true);try self.need(yes,"USER_REJECTED")
   s.pending.removeValue(forKey:id)
   return try self.permissions.approve(proposal){try self.current(s,revision,account,accountRevision,id,grant:true)}
  },complete:complete)
 }
 func disconnect(owner:String,scope:[String:String],id:String)throws{
  let s=try session(owner,scope);try reserve(s,id)
  try permissions.revoke(s.scope["origin"]!,callId:id){try self.need(self.session(owner,scope)===s,"NATIVE_SCOPE_CHANGED")}
 }
 func begin(owner:String,scope:[String:String],id:String,method:String,
  expectedRevision:Int,expectedAccount:NativeAccount)throws->NativeWalletSnapshot{
  let s=try session(owner,scope);try need(["tbc_signMessage","tbc_signTypedData"].contains(method) || NativePrepared.transaction(method) || NativeWorkflow.methods.contains(method) || (method==NativeReviewed.method && reviewedComputer != nil) || (NativeCrypto.methods.contains(method) && crypto != nil),"UNSUPPORTED_METHOD")
  let account=try selectedAccount(s);try requireActive(s,account)
  if NativePrepared.sends(method){try need(sendSourceIdentity != nil,"NATIVE_BROADCAST_UNAVAILABLE");try permissions.require(s.scope["origin"]!,"tbc_sendTransaction",account:permissionAccount(account))}
  try need(s.revision==expectedRevision && account==expectedAccount,"NATIVE_REVISION_CHANGED")
  try permissions.require(s.scope["origin"]!,NativePrepared.permission(method),account:permissionAccount(account));try reserve(s,id)
  s.operations[id]=Operation(session:s,id:id,method:method,revision:s.revision,accountRevision:accounts.revision,
   account:account,epoch:permissions.epoch(s.scope["origin"]!))
  return try snapshot(owner:owner,scope:scope)
 }
 private func operation(_ owner:String,_ scope:[String:String],_ id:String)throws->Operation{
  guard let o=try session(owner,scope).operations[id]else{throw NativeCustodyFailure(code:"NATIVE_OPERATION_GONE")}
  try current(o);return o
 }
 func check(owner:String,scope:[String:String],id:String)throws{_ = try operation(owner,scope,id)}
 private func signingOperation(_ owner:String,_ scope:[String:String],_ id:String)throws->Operation{
  let o=try operation(owner,scope,id)
  guard let w=o.workflow else{return o}
  guard let i=w.activeIndex else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_INACTIVE")}
  let child=w.children[i];try current(child);return child
 }
 // Private read-only role resolution. A page role ID selects only among the
 // wallet's already selected AND explicitly authorized identities; never a key.
 func resolveSigningAccounts(owner:String,scope:[String:String],id:String,request:[String:Any],context:[String:Any])throws->[[String:Any]]{
  let o=try operation(owner,scope,id),r=try immutable(request)
  if NativeWorkflow.methods.contains(o.method){
   try need(o.request==nil && o.workflow==nil,"NATIVE_ROLE_STATE")
   let workflow=try prepareWorkflow(o,request:r,context:context)
   var result=[NativeAccount]();for child in workflow.children{if let a=child.controller,a != o.account,!result.contains(a){result.append(a)}}
   return result.map{$0.identity}
  }
  try need(NativePrepared.transaction(o.method) && o.request==nil && o.roleRequestHash==nil,"NATIVE_ROLE_STATE")
  try need(canonical(context)==canonical(self.context(o.session)),"CONTEXT_CHANGED")
  return try selectController(o,r)
 }
 private func selectController(_ o:Operation,_ r:[String:Any])throws->[[String:Any]]{
  try need(r["version"] as? String=="1.0" && r["chainId"] as? String==chain && r["from"] as? String==o.account.address && poolContinuation((r["intent"] as? [String:Any])?["type"] as? String),"NATIVE_ROLE_PROFILE")
  guard let roles=r["signingRoles"] as? [[String:Any]],roles.count==1 else{throw NativeCustodyFailure(code:"NATIVE_ROLE_SELECTION")}
  let role=roles[0];try need(Set(role.keys)==["role","accountId"] && role["role"] as? String=="pool-controller","NATIVE_ROLE_SELECTION")
  let id=try string(role["accountId"]),matched=try permissions.selectedAccounts().filter{$0.accountId==id}
  try need(matched.count==1,"NATIVE_ROLE_ACCOUNT");let controller=matched[0];try requireActive(o.session,controller)
  try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(o.method),account:controller)
  o.controller=controller;o.roleRequestHash=try hash(r)
  return controller==o.account ? []:[controller.identity]
 }
 private func taskAccount(_ o:Operation,_ task:[String:Any])throws->NativeAccount{
  if task["accountId"] as? String==o.account.accountId && task["publicKey"] as? String==o.account.publicKey{return o.account}
  if let controller=o.controller,task["accountId"] as? String==controller.accountId && task["publicKey"] as? String==controller.publicKey{return controller}
  throw NativeCustodyFailure(code:"NATIVE_TASK_ACCOUNT")
 }
 private func context(_ s:Session)->[String:Any]{["sessionId":s.scope["sessionId"]!,"transport":"webview",
  "origin":s.scope["origin"]!,"topOrigin":s.scope["topOrigin"]!,"frame":"top",
  "navigationId":s.scope["navigationId"]!,"createdAt":s.scope["createdAt"]!]}
 private func prepareWorkflow(_ o:Operation,request:[String:Any],context:[String:Any])throws->Workflow{
  try need(NativeWorkflow.methods.contains(o.method) && o.request==nil,"NATIVE_WORKFLOW_STATE")
  let r=try immutable(request),requestHash=try hash(r)
  try need(canonical(context)==canonical(self.context(o.session)),"CONTEXT_CHANGED")
  try need(r["from"] as? String==o.account.address && r["chainId"] as? String==chain,"NATIVE_WORKFLOW_ACCOUNT")
  if let previous=o.workflow{try need(previous.requestHash==requestHash,"NATIVE_ROLE_REQUEST");return previous}
  let projected=try NativeWorkflow.children(method:o.method,request:r),steps=r["steps"] as! [[String:Any]]
  var children=[Operation]();let now=Date(),expiry=try r["expiresAt"].map{min(try date($0),now.addingTimeInterval(300))} ?? now.addingTimeInterval(300)
  try need(expiry>now,"NATIVE_EXPIRED")
  for row in projected{
   let method=try string(row["method"]),child=Operation(session:o.session,id:o.id,method:method,revision:o.revision,accountRevision:o.accountRevision,account:o.account,epoch:o.epoch)
   try need(method != NativeReviewed.method || reviewedComputer != nil,"NATIVE_COMPUTE_REQUIRED")
   try need(!NativeCrypto.methods.contains(method) || crypto != nil,"NATIVE_CRYPTO_UNAVAILABLE")
   try permissions.require(o.session.scope["origin"]!,NativePrepared.permission(method),account:permissionAccount(o.account))
   let request=try map(row["request"]);if request["signingRoles"] != nil{_ = try selectController(child,request)}
   child.workflowParent=o;children.append(child)
  }
  let state=Workflow(request:r,requestHash:requestHash,steps:steps,requests:try projected.map{try map($0["request"])},children:children,expiresAt:expiry);o.workflow=state;return state
 }
 private func describeWorkflow(_ o:Operation,method:String,request:[String:Any],context:[String:Any],review:[String:Any]?)throws->String{
  try need(method==o.method && o.request==nil,"REPEATED_APPROVAL")
  let workflow=try prepareWorkflow(o,request:request,context:context),r=workflow.request
  var reviews=[String:[String:Any]](),prepared:[String:Any]?
  if let review{
   try need(Set(review.keys).isSubset(of:["kind","steps","prepared"]) && review["kind"] as? String=="workflow","NATIVE_REVIEW_PROFILE")
   guard let rows=review["steps"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
   for row in rows{let id=try string(row["stepId"]);try need(Set(row.keys)==["stepId","review"] && reviews[id]==nil,"NATIVE_REVIEW_PROFILE");reviews[id]=try map(row["review"])}
   if let value=review["prepared"]{let p=try map(value);try need(Set(p.keys)==["workflowPlanHash","totalFee"],"NATIVE_REVIEW_PROFILE");_ = try digest(p["workflowPlanHash"]);_ = try amount(p["totalFee"]);prepared=p}
  }
  let reviewIds=Set(workflow.steps.filter{$0["kind"] as? String=="reviewedTransaction"}.map{$0["id"] as! String})
  try need(Set(reviews.keys)==reviewIds,"NATIVE_REVIEW_REQUIRED")
  let transactions=workflow.children.contains{NativePrepared.transaction($0.method)}
  try need((!transactions && reviewIds.isEmpty) || r["maxTotalFee"] != nil || prepared != nil,"NATIVE_WORKFLOW_FEE_REVIEW_REQUIRED")
  let cap=try amount(r["maxTotalFee"] ?? prepared?["totalFee"] ?? "0")
  if let prepared{try need(amount(prepared["totalFee"])<=cap,"NATIVE_FEE_CAP");workflow.consentPlanHash=try string(prepared["workflowPlanHash"])}
  workflow.consentFeeCap=String(cap)
  var descriptions=[String]()
  for (index,child) in workflow.children.enumerated(){
   let step=workflow.steps[index],id=try string(step["id"]),depends=step["dependsOn"] as! [String]
   let description=try describeConsent(child,method:child.method,request:workflow.requests[index],context:context,review:reviews[id],feeCap:String(cap))
   var links=[String]();if let bindings=step["bindings"] as? [[String:Any]]{
    try need(bindings.count<=1,"NATIVE_WORKFLOW_BINDING")
    for binding in bindings{let source=try map(binding["source"]),parent=try string(source["stepId"]);try need(depends.contains(parent),"NATIVE_WORKFLOW_SOURCE");links.append("After verified completion of \(parent), copy \(try string(source["output"])) to \(try string(binding["target"])).")}
   }
   descriptions.append("Step \(index+1): \(id). Depends on: \(depends.isEmpty ? "none":depends.joined(separator:", ")).\n"+description+(links.isEmpty ? "":"\n"+links.joined(separator:"\n")))
  }
  let mode=try string(r["failureMode"] ?? "atomic");try need(["atomic","continue-independent"].contains(mode),"NATIVE_WORKFLOW_MODE")
  o.request=r;o.requestHash=workflow.requestHash
  let execution=NativePrepared.sends(method) ? "The wallet will submit the completed transaction steps as one batch. Unknown submissions are not retried.":"No broadcast; abort cannot undo signatures already returned to this operation."
  return "Approve one bounded batch of \(workflow.children.count) steps. Total fee at most \(cap) native atomic. Failure mode: \(mode).\n"+execution+"\n\n"+descriptions.joined(separator:"\n\n")
 }
 // Reusable family validation/projection, without presenting or approving.
 // A workflow can reuse this with privately owned child state; only the outer
 // custody operation may present UI and own its single approval receipt.
 private func describeConsent(_ o:Operation,method:String,request:[String:Any],context:[String:Any],review:[String:Any]?,feeCap:String?=nil)throws->String{
  try need(o.request==nil,"REPEATED_APPROVAL")
  try need(method==NativeReviewed.method || review==nil,"NATIVE_REVIEW_PROFILE")
  let r=try immutable(request);try need(method==o.method && r["version"] as? String=="1.0" && r["chainId"] as? String==chain && r["from"] as? String==o.account.address)
  try need(canonical(context)==canonical(self.context(o.session)),"CONTEXT_CHANGED")
  if r["signingRoles"] != nil{try need(o.controller != nil && o.roleRequestHash==hash(r),"NATIVE_ROLE_REQUEST")}
  else{try need(o.controller==nil && o.roleRequestHash==nil,"NATIVE_ROLE_REQUEST")}
  if NativePrepared.prepared(method){o.preparedProposal=try NativePrepared.consent(r)}
  o.requestHash=try hash(NativePrepared.request(r,method))
  let description:String
  if method==NativeReviewed.method{
   guard let review else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
   o.reviewedConsent=try NativeReviewed.consent(request:r,review:review)
   description=try NativeReviewed.description(o.reviewedConsent!)
  }else if NativePrepared.transaction(method){
   let intent=try map(r["intent"]),cap=try amount((r["constraints"] as? [String:Any])?["maxFee"] ?? feeCap)
   try need(cap<=2100000000000000,"NATIVE_FEE_CAP")
   o.consentFeeCap=String(cap)
   let detail:String
   switch intent["type"] as? String{
   case "tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match":detail=try lopDescription(intent,o.account.address)
   case "tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund":detail=try htlcDescription(intent,r,o.account.address)
   case "tbc-timelock-lock", "tbc-timelock-unlock":detail=try timelockDescription(intent,r,o.account.address)
   case "tbc-amm-create":detail=try ammCreationDescription(intent)
   case "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc", "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove", "tbc.pool.ft.merge", "amm.mergeToken", "tbc.pool.ftlp.merge", "tbc.pool.ftlp.burn", "tbc20Lp.burn":
    detail=try pool2Description(intent,r)
   case "tbc20-lp-transfer", "tbc20Lp.transfer", "tbc20-lp-merge", "tbc20Lp.merge", "tbc20-lp-lock", "tbc20Lp.lock", "tbc20-lp-unlock", "tbc20Lp.unlock":detail=try lpDescription(intent,o.account.address)
   case "tbc-amm-add-liquidity", "amm.addLiquidity", "tbc-amm-remove-liquidity", "amm.removeLiquidity", "tbc-amm-swap", "amm.swap":
    detail=try ammBusinessDescription(intent,o.account.address)
   case "tbc721-standard-mint", "tbc721-standard-batch-mint":detail=try mintDescription(intent,o.account.address)
   case "tbc20-standard-create":
    detail="Create TBC20 \(try string(intent["name"])) (\(try string(intent["symbol"]))).\nInitial supply: \(try string(intent["initialSupply"])) atomic; decimals: \(try integer(intent["decimals"])).\nOwner: \(try string(intent["to"] ?? o.account.address)).\nApprove the dependent funding/source/genesis steps as one bounded request."
   case "tbc721-standard-create-collection":
    let media=try map(intent["media"])
    detail="Create NFT collection: \(try string(intent["name"])).\nSupply: \(try string(intent["supply"])); owner: \(try string(intent["to"] ?? o.account.address)).\n\(try string(intent["description"]))\nMedia SHA256: \(try hash(media)).\n\(media["uri"] as? String ?? "Embedded media bound to this request.")"
   case "tbc20.transfer", "tbc20Stablecoin.transfer":
    let receivers=(intent["receivers"] as? [[String:Any]]) ?? [["to":intent["to"] as Any,"amount":intent["amount"] as Any]]
    try need(!receivers.isEmpty && receivers.count<=8,"RECIPIENT_LIMIT")
    let sends=try receivers.map{"Send \(try string($0["amount"])) token atomic to \(try string($0["to"]))."}.joined(separator:"\n")
    let payment=try (intent["payment"] as? [String:Any]).map{"\nAlso send \(try amount($0["amount"])) TBC atomic to \(try string($0["to"]))."} ?? ""
    let label=intent["type"] as? String=="tbc20Stablecoin.transfer" ? "Stablecoin":"FT"
    detail="\(label) \(try string(intent["contractId"]))\n"+sends+payment
   case "tbc20.merge":detail="FT \(try string(intent["contractId"]))\nMerge token inputs into the same account: \(o.account.address)."
   case "tbc20Stablecoin.merge":detail="Stablecoin \(try string(intent["contractId"]))\nMerge token inputs into the same account: \(o.account.address)."
   case "tbc721.transfer":
    let payment=try (intent["payment"] as? [String:Any]).map{"\nAlso send \(try amount($0["amount"])) TBC atomic to \(try string($0["to"]))."} ?? ""
    detail="Send NFT \(try string(intent["contractId"])) to \(try string(intent["to"]))."+payment
   case "tbc.transfer":detail="Send \(try amount(intent["amount"])) TBC atomic to \(try string(intent["to"]))."
   case "tbc.maintenance.merge":detail="Merge up to 100 TBC inputs into the same account: \(o.account.address)."
   default:throw NativeCustodyFailure(code:"UNSUPPORTED_INTENT")
   }
   let roleDetail=o.controller.map{"\nAsset/fee account: \(o.account.address).\nPool controller: \($0.address) (pool-controller)."} ?? ""
   let execution=NativePrepared.sends(method) ? "The wallet will submit these transactions in order. Unknown submissions are not retried.":(o.workflowParent.map{NativePrepared.sends($0.method)}==true ? "Signed transactions are included in the approved batch submission.":"Returns signed transactions; no broadcast.")
   description=detail+roleDetail+"\nFee at most \(cap) native atomic, including any required input consolidation. "+execution
  }else if NativeCrypto.methods.contains(method){
   try need(crypto != nil,"NATIVE_CRYPTO_UNAVAILABLE")
   description=try NativeCrypto.description(r,method:method,account:o.account)
  }else if method=="tbc_signTypedData"{
   let envelope=try typedEnvelope(r,o.session.scope["origin"]!)
   o.typedEnvelope=envelope
   description="TBC structured data signature. No transaction is broadcast here; the application may use this signature to authorize actions.\nDomain, type definitions and all signed values:\n"+(try canonical(envelope))
  }else{
   let message=try map(r["message"])
   _ = try NativeSigningEnvelope.workflow(["kind":"message","message":message],chain:chain,from:o.account.address,origin:o.session.scope["origin"]!)
   description="Ordinary TBC message (\(try string(message["encoding"]))):\n\(try string(message["data"]))"
  }
  o.request=r
  return description
 }
 func consent(owner:String,scope:[String:String],id:String,method:String,request:[String:Any],context:[String:Any],review:[String:Any]?=nil,
  complete:@escaping @MainActor (Result<Bool,Error>)->Void)throws{
  let o=try operation(owner,scope,id)
  if o.maintenance != nil{try need(hash(request)==o.maintenanceRequestHash,"NATIVE_MERGE_REQUEST")}
  let description=try NativeWorkflow.methods.contains(method) ? describeWorkflow(o,method:method,request:request,context:context,review:review):describeConsent(o,method:method,request:request,context:context,review:review)
  if o.maintenance != nil{try current(o);o.approved=true;complete(.success(true));return}
  decision(o.session,id,NativeReview(operationId:id,origin:o.session.scope["origin"]!,chainId:chain,accountAddress:o.account.address,title:"Approve request",description:description),finish:{yes in
   try self.current(o);o.approved=yes;return yes
  },complete:complete)
 }
 // Shared family checks install only the validated task set. No receipt,
 // permission or UI is created here, including when reused by a batch child.
 private func installBoundTasks(_ o:Operation,binding:[String:Any],preview:[String:Any],plan:[String:Any]?,envelope:[String:Any]?)throws->[String:Any]{
  try need(o.approved && o.receipt==nil,"NOT_APPROVED_OR_REBOUND")
  let b=try immutable(binding),p=try map(b["payload"]),review=try immutable(preview)
  let expectedRoles:Any?=o.controller.map{[["role":"pool-controller","account":$0.identity] as [String:Any]]}
  try need(canonical(review["signingRoles"])==canonical(expectedRoles),"NATIVE_ROLE_REVIEW")
  try need(b["bindingHash"] as? String==hash(p) && p["contextHash"] as? String==hash(context(o.session)) && p["requestHash"] as? String==o.requestHash,"NATIVE_BINDING_HASH")
  try need(p["method"] as? String==o.method && p["origin"] as? String==o.session.scope["origin"] && p["sessionId"] as? String==o.session.scope["sessionId"] && p["chainId"] as? String==chain && p["accountId"] as? String==o.account.accountId,"NATIVE_BINDING_IDENTITY")
  let expiry=try date(p["expiresAt"]),now=Date();try need(expiry>now && expiry<now.addingTimeInterval(301),"NATIVE_EXPIRY")
  if NativeCrypto.methods.contains(o.method){
   guard let request=o.request,let plan else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_BINDING")}
   try need(crypto != nil && envelope==nil,"NATIVE_CRYPTO_BINDING")
   let task=try NativeCrypto.bound(request:request,method:o.method,context:context(o.session),account:o.account,binding:b,plan:plan,preview:review)
   o.tasks=[try string(task["taskId"]):task];o.expectedTasks=1;return b
  }
  let tasks:[[String:Any]]
  if o.method==NativeReviewed.method{
   guard let bound=o.reviewedBound,let consent=o.reviewedConsent,let plan else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
   try need(p["operationKind"] as? String=="transaction" && p["operationHash"] as? String==bound.planHash && plan["planHash"] as? String==bound.planHash && canonical(review)==canonical(map(consent["payload"])["preview"]) && envelope==nil,"NATIVE_REVIEWED_BINDING")
   tasks=o.reviewedTasks;o.transactionCount=bound.transactionCount;o.planHash=bound.planHash
  }else if NativePrepared.transaction(o.method){
   guard let plan else{throw NativeCustodyFailure(code:"PLAN_REQUIRED")}
   let signedPlan=try immutable(plan),payload=try map(signedPlan["payload"])
   try need(signedPlan["planHash"] as? String==hash(payload) && p["operationHash"] as? String==signedPlan["planHash"] as? String && payload["requestHash"] as? String==o.requestHash && payload["accountId"] as? String==o.account.accountId && payload["chainId"] as? String==chain,"NATIVE_PLAN_BINDING")
   if let proposal=o.preparedProposal{try NativePrepared.bind(proposal,plan:payload,expiry:expiry)}
   let count=try integer(review["transactionCount"])
   try need(canonical(review)==canonical(payload["preview"]) && (1...32).contains(count) && review["operationKind"] as? String=="transaction" && coveredWarnings(o.request!,payload),"NATIVE_REVIEW")
   try need(amount(review["totalFee"])<=amount(o.consentFeeCap),"NATIVE_FEE_CAP")
   guard let value=payload["signingTasks"] as? [[String:Any]]else{throw NativeCustodyFailure(code:"NATIVE_TASKS")};tasks=value
   let transactions=payload["transactions"] as? [[String:Any]] ?? []
   let ids=try transactions.map{try string($0["id"])}
   try need(ids.count==count && Set(ids).count==count,"NATIVE_PLAN_TRANSACTIONS")
   try bindMaintenance(o,payload,review,expiry)
   o.transactionCount=count;o.transactionIds=Set(ids);o.planHash=try string(signedPlan["planHash"])
   if NativePrepared.sends(o.method){o.sendPlan=["totalFee":review["totalFee"]!,"transactions":transactions.map{$0.filter{["id","role","dependsOn"].contains($0.key)}}]}
  }else if o.method=="tbc_signTypedData"{
   guard let expected=o.typedEnvelope else{throw NativeCustodyFailure(code:"NATIVE_TYPED_CONSENT")}
   let expectedDigest=try typedDigest(expected)
   let expectedReview:[String:Any]=["operationKind":"typedData","scheme":"tbc-typed-data","domain":expected["domain"]!,"types":expected["types"]!,"primaryType":expected["primaryType"]!,"message":expected["message"]!,"digest":expectedDigest,"warnings":[String]()]
   try need(plan==nil && p["operationKind"] as? String=="typedData" && p["operationHash"] as? String==expectedDigest && canonical(envelope)==canonical(expected) && canonical(review)==canonical(expectedReview),"NATIVE_TYPED_BINDING")
   tasks=[["taskId":"sign-typed-data","purpose":"typedData","algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":expectedDigest,"signatureEncoding":"compact65-recoverable","origin":p["origin"]!,"accountId":o.account.accountId,"publicKey":o.account.publicKey]]
  }else{
   let expected:[String:Any]=["type":"tbc.message","version":"1.0","message":o.request!["message"]!]
   let expectedDigest=try NativeSigningEnvelope.digest(expected,purpose:"message",walletProtocol:walletProtocol)
   try need(plan==nil && p["operationKind"] as? String=="message" && p["operationHash"] as? String==expectedDigest,"NATIVE_MESSAGE_DIGEST")
   try need(review["scheme"] as? String=="tbc-message" && review["digest"] as? String==p["operationHash"] as? String && canonical(review["message"])==canonical(o.request!["message"]),"NATIVE_REVIEW")
   try need(canonical(envelope)==canonical(["type":"tbc.message","version":"1.0","message":o.request!["message"]!]),"NATIVE_MESSAGE")
   tasks=[["taskId":walletProtocol == .legacy ? "legacy-sign-message":"sign-message","purpose":"message","algorithm":"secp256k1-recoverable-ecdsa-sha256d","digest":p["operationHash"]!,"signatureEncoding":"compact65-recoverable","origin":p["origin"]!,"accountId":o.account.accountId,"publicKey":o.account.publicKey]]
  }
  let profile=(o.request?["intent"] as? [String:Any])?["type"] as? String
  let limit = !NativePrepared.transaction(o.method) ? 1:(["tbc-lop-create":128,"tbc-lop-cancel":3,"tbc-lop-match":3,"tbc-htlc-lock":128,"tbc-htlc-claim":128,"tbc-htlc-refund":128,"tbc-timelock-lock":128,"tbc-timelock-unlock":128,"amm.swap":128,"amm.addLiquidity":128,"amm.removeLiquidity":128,"amm.mergeToken":6,"tbc20Lp.transfer":128,"tbc20Lp.lock":128,"tbc20Lp.unlock":128,"tbc20Lp.merge":128,"tbc20Lp.burn":6,"tbc20.transfer":32,"tbc20.merge":32,"tbc20-standard-create":128,"tbc721-standard-create-collection":128,"tbc721-standard-mint":128,"tbc721-standard-batch-mint":128,"tbc-amm-create":128,"tbc-amm-add-liquidity":128,"tbc-amm-remove-liquidity":128,"tbc-amm-swap":128,"tbc20-lp-transfer":128,"tbc20-lp-merge":128,"tbc20-lp-lock":128,"tbc20-lp-unlock":128,"tbc.pool.swap.exactTbcForToken":128,"tbc.pool.swap.exactTokenForTbc":128,"tbc.pool.liquidity.add":128,"tbc.pool.liquidity.remove":128,"tbc.pool.ft.merge":6,"tbc.pool.ftlp.merge":6,"tbc.pool.ftlp.burn":6,"tbc721.transfer":128,"tbc20Stablecoin.transfer":128,"tbc20Stablecoin.merge":128,"tbc.transfer":128,"tbc.maintenance.merge":100][profile ?? ""] ?? 0)
  let reviewed=o.method==NativeReviewed.method
  try need(reviewed ? tasks.count<=1000:(!tasks.isEmpty && tasks.count<=limit),"NATIVE_TASKS");var validated=[String:[String:Any]]()
  o.exactTaskCount = !(poolContinuation(profile) && o.transactionCount>1 && review["signingTaskCount"]==nil)
  let total=try reviewed ? o.reviewedBound!.totalTasks:integer(review["signingTaskCount"] ?? (o.exactTaskCount ? tasks.count:min(1024,limit*o.transactionCount)))
  try need(total>=tasks.count && total<=(reviewed ? 32000:1024) && (o.transactionCount>1 || total==tasks.count),"NATIVE_TOTAL_TASKS")
  for task in tasks{
   _ = try taskAccount(o,task)
   _ = try digest(task["digest"]);let taskId=try string(task["taskId"]),encoding=try string(task["signatureEncoding"])
   try need(["compact64","compact65-recoverable"].contains(encoding) && task["algorithm"] as? String==(encoding=="compact64" ? "secp256k1-ecdsa-sha256d":"secp256k1-recoverable-ecdsa-sha256d"),"NATIVE_TASK_ENCODING")
   try need(!taskId.isEmpty && validated[taskId]==nil,"NATIVE_TASK_DUPLICATE");validated[taskId]=try immutable(task)
  }
  o.expectedTasks=total;o.tasks=validated;return b
 }
 func bind(owner:String,scope:[String:String],id:String,binding:[String:Any],preview:[String:Any],
  plan:[String:Any]?,envelope:[String:Any]?)throws->[String:Any]{
  let o=try operation(owner,scope,id)
  try need(!NativeWorkflow.methods.contains(o.method),"NATIVE_WORKFLOW_EXECUTION_NOT_INSTALLED")
  let b=try installBoundTasks(o,binding:binding,preview:preview,plan:plan,envelope:envelope),p=try map(b["payload"])
  let receipt=try immutable(["status":"approved","approvalId":UUID().uuidString,"approvalToken":UUID().uuidString,"bindingHash":b["bindingHash"]!,"approvedAt":wireNow(),"expiresAt":p["expiresAt"]!])
  o.receipt=receipt;return try immutable(receipt)
 }
 private func childBinding(_ child:Operation,parent:[String:Any],kind:String,operationHash:String)throws->[String:Any]{
  var p=try map(parent["payload"]);p["method"]=child.method;p["operationKind"]=kind;p["operationHash"]=operationHash;p["requestHash"]=child.requestHash
  return ["payload":p,"bindingHash":try hash(p)]
 }
 // One parent receipt, after whole-batch and existing family validation. No
 // second UI or signer is introduced. Reviewed first-stage compute reuses the
 // async native owner and is retained for entry, never recomputed on entry.
 func bindWorkflow(owner:String,scope:[String:String],id:String,binding:[String:Any],preview:[String:Any],plan:[String:Any],complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  let o=try operation(owner,scope,id)
  guard let workflow=o.workflow else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_STATE")}
  try need(o.approved && o.receipt==nil && !workflow.bindingStarted && o.request != nil,"NOT_APPROVED_OR_REBOUND")
  workflow.bindingStarted=true
  var extra=[NativeAccount](),reviews=[String:[String:Any]]()
  for (i,child) in workflow.children.enumerated(){
   if let controller=child.controller,controller != o.account,!extra.contains(controller){extra.append(controller)}
   if let review=child.reviewedConsent{reviews[try string(workflow.steps[i]["id"])]=review}
  }
  let bound=try NativeWorkflow.bind(method:o.method,request:workflow.request,context:context(o.session),account:o.account,accounts:extra,plan:plan,preview:preview,binding:binding,reviews:reviews,walletProtocol:walletProtocol)
  let p=try map(bound.plan["payload"]),b=bound.binding,expiry=try date(p["expiresAt"])
  try need(expiry<=workflow.expiresAt && (workflow.consentPlanHash==nil || workflow.consentPlanHash==bound.plan["workflowPlanHash"] as? String),"NATIVE_WORKFLOW_CONSENT_CHANGED")
  try need(amount(p["totalFee"])<=amount(workflow.consentFeeCap),"NATIVE_FEE_CAP")
  var reviewed=[(Operation,[String:Any],[String:Any],NativeReviewed.Bound)]()
  for (index,child) in workflow.children.enumerated(){
   let stepId=try string(workflow.steps[index]["id"]);child.approved=true
   if NativePrepared.transaction(child.method){
    guard let entry=(p["transactionPlans"] as? [[String:Any]])?.first(where:{$0["stepId"] as? String==stepId}) else{throw NativeCustodyFailure(code:"PLAN_REQUIRED")}
    let childPlan=try map(entry["plan"]),body=try map(childPlan["payload"]),childBind=try childBinding(child,parent:b,kind:"transaction",operationHash:string(childPlan["planHash"]))
    _ = try installBoundTasks(child,binding:childBind,preview:map(body["preview"]),plan:childPlan,envelope:nil)
   }else if child.method==NativeReviewed.method{
    guard let request=child.request,let consent=child.reviewedConsent else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
    let material=try NativeReviewed.workflowPlan(request:request,context:context(o.session),account:o.account,consent:consent,expiresAt:string(p["expiresAt"]))
    let reviewedBound=try NativeReviewed.bind(request:request,context:context(o.session),account:o.account,consent:consent,plan:material.plan,preview:material.preview,packet:material.packet,expiry:expiry)
    reviewed.append((child,material.plan,material.preview,reviewedBound))
   }else if NativeCrypto.methods.contains(child.method){
    guard crypto != nil,let task=(p["cryptoTasks"] as? [[String:Any]])?.first(where:{$0["taskId"] as? String=="crypto-"+stepId})else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_UNAVAILABLE")}
    child.tasks=[try string(task["taskId"]):try immutable(task)];child.expectedTasks=1
   }else if let entry=(p["immediateSigningTasks"] as? [[String:Any]])?.first(where:{$0["stepId"] as? String==stepId}){
    let task=try map(entry["task"]),envelope=try map(entry["envelope"]),kind=try string(task["purpose"]),digest=try string(task["digest"])
    var review:[String:Any]=["operationKind":kind,"scheme":kind=="message" ? "tbc-message":"tbc-typed-data","digest":digest,"warnings":[String]()]
    if kind=="message"{review["message"]=envelope["message"]}else{for key in ["domain","types","primaryType","message"]{review[key]=envelope[key]}}
    _ = try installBoundTasks(child,binding:childBinding(child,parent:b,kind:kind,operationHash:digest),preview:review,plan:nil,envelope:envelope)
    try need(child.tasks.count==1,"NATIVE_TASKS");var single=child.tasks.values.first!;single["taskId"]="sign-\(stepId)"
    try need(canonical(single)==canonical(task),"NATIVE_WORKFLOW_MESSAGE_TASK");child.tasks=[try string(single["taskId"]):single]
    child.workflowEnvelope=try immutable(envelope)
   }
   // Deferred tasks have no signable digest until a verified source completes.
  }
  var done=false
  func result(_ r:Result<[String:Any],Error>){guard !done else{return};done=true;complete(r)}
  func ready(_ index:Int){
   do{
    try self.current(o)
    if index<reviewed.count{
     let (child,childPlan,review,r)=reviewed[index]
     try self.reviewedCompute(o,"prepareReviewedStage",r.prepare(index:0,parents:[]),finish:{actual in
      child.reviewedTasks=try r.tasks(actual:actual,claimed:actual,index:0);child.reviewedStage=try self.immutable(actual);child.reviewedBound=r
      _ = try self.installBoundTasks(child,binding:self.childBinding(child,parent:b,kind:"transaction",operationHash:r.planHash),preview:review,plan:childPlan,envelope:nil)
      return true
     },complete:{reply in do{_ = try reply.get();ready(index+1)}catch{result(.failure(error))}})
    }else{
     try self.need(Date()<expiry,"NATIVE_EXPIRED")
     let receipt=try self.immutable(["status":"approved","approvalId":UUID().uuidString,"approvalToken":UUID().uuidString,"bindingHash":b["bindingHash"]!,"approvedAt":self.wireNow(),"expiresAt":p["expiresAt"]!])
     workflow.bound=bound;o.receipt=receipt;for child in workflow.children{child.receipt=receipt};result(.success(try self.immutable(receipt)))
    }
   }catch{result(.failure(error))}
  }
  ready(0)
 }
 // Private worker boundary after its shared Engine pre-sign validation. The
 // approved child plan/tasks already live here; do not resend chain material.
 func enterWorkflowStep(owner:String,scope:[String:String],id:String,receipt:[String:Any],entry:[String:Any])throws{
  let o=try operation(owner,scope,id);try self.receipt(o)
  guard let w=o.workflow,let bound=w.bound else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_STATE")}
  try need(w.activeIndex==nil && w.nextIndex<w.children.count && o.session.pending[id]==nil && canonical(receipt)==canonical(o.receipt),"NATIVE_WORKFLOW_STEP_STATE")
  let e=try immutable(entry),index=w.nextIndex,step=w.steps[index],child=w.children[index]
  var keys:Set<String>=["kind","stepId","workflowPlanHash","tasks"]
  if child.method==NativeReviewed.method{keys.insert("reviewed")}
  let deferred=(try map(bound.plan["payload"])["deferredSigningTasks"] as! [[String:Any]]).first{$0["targetStepId"] as? String==step["id"] as? String}
  if deferred != nil{keys.insert("resolvedDeferredSigningTask")}
  try need(Set(e.keys)==keys && e["kind"] as? String=="workflow-step" && e["stepId"] as? String==step["id"] as? String && e["workflowPlanHash"] as? String==bound.plan["workflowPlanHash"] as? String,"NATIVE_WORKFLOW_STEP_BINDING")
  try need((step["dependsOn"] as! [String]).allSatisfy{w.completedResults[$0] != nil},"NATIVE_WORKFLOW_DEPENDENCY")
  let resolved=try deferred.map{try NativeWorkflow.resolve($0,claimed:map(e["resolvedDeferredSigningTask"]),completed:w.completedResults,account:child.account,origin:o.session.scope["origin"]!,walletProtocol:walletProtocol)}
  let expectedTasks=try resolved.map{[try string($0.task["taskId"]):$0.task]} ?? child.tasks
  try need(!expectedTasks.isEmpty,"NATIVE_TASKS")
  guard let tasks=e["tasks"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"NATIVE_TASKS")}
  try need(tasks.count==expectedTasks.count && Set(try tasks.map{try string($0["taskId"])}).count==tasks.count,"NATIVE_TASKS")
  for task in tasks{try need(canonical(task)==canonical(expectedTasks[try string(task["taskId"])]),"NATIVE_TASK_CHANGED_OR_REPLAY")}
  if let reviewed=child.reviewedBound{
   let expected:[String:Any]=["kind":"reviewed","material":reviewed.material,"policyMaterial":reviewed.policy,"review":child.reviewedConsent!,"stage":child.reviewedStage!]
   try need(canonical(e["reviewed"])==canonical(expected),"NATIVE_REVIEWED_STAGE_CHANGED")
  }
  if let resolved{child.tasks=expectedTasks;child.workflowEnvelope=resolved.envelope;child.expectedTasks=1}
  w.activeIndex=index
 }
 private func fullySigned(_ o:Operation)->Bool{
  !o.tasks.isEmpty && (o.exactTaskCount ? o.completed.count==o.expectedTasks:(o.stage==o.transactionCount-1 && o.completed.count<=o.expectedTasks)) && o.completed==Set(o.tasks.keys) && o.session.pending[o.id]==nil && (o.method != NativeReviewed.method || o.stage==o.transactionCount-1)
 }
 // A topologically ordered graph has at most five children. Only native-owned
 // failed/skipped records can skip descendants; no worker-supplied skip flag.
 private func nextWorkflowStep(_ w:Workflow,after index:Int){
  w.activeIndex=nil;w.nextIndex=index+1
  while w.nextIndex<w.steps.count{
   let step=w.steps[w.nextIndex]
   guard (step["dependsOn"] as! [String]).contains(where:{w.unavailableResults[$0] != nil})else{break}
   w.unavailableResults[step["id"] as! String]=["id":step["id"]!,"kind":step["kind"]!,"status":"skipped","error":["code":"DEPENDENCY_FAILED","message":"Workflow dependency failed"]]
   w.nextIndex+=1
  }
 }
 // Results arrive only from the private shared worker after Rust finalization
 // and validation. Custody binds them to consumed tasks and the approved child;
 // no page can mark an arbitrary result complete or advance the graph itself.
 func finishWorkflowStep(owner:String,scope:[String:String],id:String,receipt:[String:Any],outcome:[String:Any],complete:@escaping @MainActor (Result<Bool,Error>)->Void)throws{
  let parent=try operation(owner,scope,id),child=try signingOperation(owner,scope,id);try self.receipt(child)
  guard let w=parent.workflow,let index=w.activeIndex,let bound=w.bound else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_STATE")}
  let e=try immutable(outcome),step=w.steps[index]
  if e["status"] as? String=="failed"{
   let cryptoFailure=NativeCrypto.methods.contains(child.method)
   let expectedError=["code":"HOST_UNAVAILABLE","message":"Workflow step failed: "+(cryptoFailure ? "crypto.execute":"signer.sign")]
   try need(Set(e.keys)==["kind","stepId","workflowPlanHash","status","error"] && e["kind"] as? String=="workflow-step-outcome" && e["stepId"] as? String==step["id"] as? String && e["workflowPlanHash"] as? String==bound.plan["workflowPlanHash"] as? String && canonical(receipt)==canonical(parent.receipt),"NATIVE_WORKFLOW_RESULT_BINDING")
   try need((cryptoFailure ? child.cryptoUnavailable:child.signerUnavailable) && map(bound.plan["payload"])["failureMode"] as? String=="continue-independent" && parent.session.pending[id]==nil && canonical(e["error"])==canonical(expectedError),"NATIVE_WORKFLOW_FAILURE_PROVENANCE")
   w.unavailableResults[try string(step["id"])]=["id":step["id"]!,"kind":step["kind"]!,"status":"failed","error":expectedError]
   nextWorkflowStep(w,after:index);complete(.success(true));return
  }
  try need(Set(e.keys)==["kind","stepId","workflowPlanHash","status","result"] && e["kind"] as? String=="workflow-step-outcome" && e["status"] as? String=="completed" && e["stepId"] as? String==step["id"] as? String && e["workflowPlanHash"] as? String==bound.plan["workflowPlanHash"] as? String && canonical(receipt)==canonical(parent.receipt),"NATIVE_WORKFLOW_RESULT_BINDING")
  try need(fullySigned(child),"NATIVE_STAGE_INCOMPLETE")
  let result=try map(e["result"]),p=try map(bound.plan["payload"])
  if NativePrepared.transaction(child.method) || child.method==NativeReviewed.method{
   let reviewed=child.method==NativeReviewed.method
   let plan=try reviewed ? nil:(p["transactionPlans"] as! [[String:Any]]).first{$0["stepId"] as? String==step["id"] as? String}.map{try map(map($0["plan"])["payload"])}
   let fee=try reviewed ? map(child.reviewedConsent!["payload"])["totalFee"]:map(plan!["preview"])["totalFee"]
   let requestHash=try reviewed ? hash(child.request!["request"]):child.requestHash!
   let txs=try NativeWorkflow.completedBundle(result,account:child.account,requestHash:requestHash,approvalId:string(receipt["approvalId"]),fee:string(fee),transactions:plan?["transactions"] as? [[String:Any]],reviewed:child.reviewedBound)
   func finish()throws->Bool{
    try self.receipt(child);w.completedResults[try self.string(step["id"])]=result;self.nextWorkflowStep(w,after:index);return true
   }
   if let stage=child.reviewedStage{
    let signatures=try child.reviewedTasks.map{task in guard let s=child.reviewedSignatures[try string(task["taskId"])]else{throw NativeCustodyFailure(code:"NATIVE_STAGE_INCOMPLETE")};return s}
    try reviewedCompute(child,"finalizeReviewedStage",["stage":stage,"signatures":signatures,"signatureEncoding":"compact64"],finish:{last in
     let expected=child.reviewedParents+[try self.string(last["txraw"])]
     try self.need(self.canonical(txs.map{$0["rawTransaction"]!})==self.canonical(expected),"NATIVE_WORKFLOW_REVIEWED_RESULT")
     if child.reviewedBound?.associated==false{try self.need(self.canonical(result["detachedSignatures"])==self.canonical((0..<child.stage).map{child.reviewedDetached[$0]!}+[last["sigs"]!]),"NATIVE_WORKFLOW_REVIEWED_SIGNATURES")}
     return try finish()
    },complete:complete)
   }else{complete(Result{try finish()})}
  }else if NativeCrypto.methods.contains(child.method){
   try need(child.cryptoResultHash != nil && hash(result)==child.cryptoResultHash,"NATIVE_WORKFLOW_CRYPTO_RESULT")
   w.completedResults[try string(step["id"])]=result;nextWorkflowStep(w,after:index);complete(.success(true))
  }else{
   guard let envelope=child.workflowEnvelope,let task=child.tasks.values.first,let signature=child.signedResults[try string(task["taskId"])] else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_RESULT_BINDING")}
   let expected=try NativeSigningEnvelope.result(envelope,task:task,signature:signature,account:child.account,walletProtocol:walletProtocol)
   try need(canonical(result)==canonical(expected),"NATIVE_WORKFLOW_MESSAGE_RESULT")
   w.completedResults[try string(step["id"])]=result;nextWorkflowStep(w,after:index);complete(.success(true))
  }
 }
 private func reviewedCompute<T>(_ o:Operation,_ method:String,_ args:[String:Any],
  finish:@escaping @MainActor ([String:Any])throws->T,complete:@escaping @MainActor (Result<T,Error>)->Void)throws{
  try current(o);guard let computer=reviewedComputer else{throw NativeCustodyFailure(code:"NATIVE_COMPUTE_REQUIRED")}
  try need(o.session.pending[o.id]==nil,"NATIVE_COMPUTE_PENDING")
  let input=try canonical(args);try need(input.utf8.count<=16*1024*1024,"NATIVE_COMPUTE_BOUND")
  var done=false
  func result(_ value:Result<T,Error>){guard !done else{return};done=true;o.session.pending.removeValue(forKey:o.id);complete(value)}
  o.session.pending[o.id]={result(.failure(NativeCustodyFailure(code:"NATIVE_CANCELLED")))}
  computer.call(method:method,input:input){reply in
   if !done{result(Result{
    try self.current(o);if o.receipt != nil{try self.receipt(o)}
    let text=try reply.get();try self.need(text.utf8.count<=32*1024*1024,"NATIVE_COMPUTE_BOUND")
    return try finish(self.map(JSONSerialization.jsonObject(with:Data(text.utf8))))
   })}
  }
 }
 // The async wrapper derives the first task set independently. Existing bind
 // remains the sole receipt issuer and sign remains the sole key-use entry.
 func bindReviewed(owner:String,scope:[String:String],id:String,binding:[String:Any],preview:[String:Any],plan:[String:Any],packet:[String:Any],
  complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  let o=try operation(owner,scope,id);try need(o.method==NativeReviewed.method && o.approved && o.receipt==nil && o.reviewedBound==nil,"NATIVE_REVIEWED_STATE")
  guard let request=o.request,let consent=o.reviewedConsent else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
  let b=try immutable(binding),v=try immutable(preview),p=try immutable(plan)
  let bound=try NativeReviewed.bind(request:request,context:context(o.session),account:o.account,consent:consent,plan:p,preview:v,packet:packet,expiry:date(map(b["payload"])["expiresAt"]))
  try reviewedCompute(o,"prepareReviewedStage",bound.prepare(index:0,parents:[]),finish:{actual in
   o.reviewedTasks=try bound.tasks(actual:actual,claimed:bound.claimedStage,index:0)
   o.reviewedStage=try self.immutable(actual);o.reviewedBound=bound
   do{return try self.bind(owner:owner,scope:scope,id:id,binding:b,preview:v,plan:p,envelope:nil)}
   catch{o.reviewedBound=nil;o.reviewedStage=nil;o.reviewedTasks=[];throw error}
  },complete:complete)
 }
 func advanceReviewed(owner:String,scope:[String:String],id:String,receipt:[String:Any],pending:[String:Any],
  complete:@escaping @MainActor (Result<Bool,Error>)->Void)throws{
  let o=try signingOperation(owner,scope,id);try self.receipt(o)
  guard let bound=o.reviewedBound,let previousStage=o.reviewedStage else{throw NativeCustodyFailure(code:"NATIVE_REVIEW_REQUIRED")}
  try need(o.method==NativeReviewed.method && canonical(receipt)==canonical(o.receipt) && o.completed==Set(o.tasks.keys) && o.stage+1<o.transactionCount,"NATIVE_STAGE_INCOMPLETE")
  let p=try immutable(pending),index=o.stage+1
  try need(Set(p.keys)==["kind","planHash","stageIndex","previousTransactions","stage","signingRequests"] && p["kind"] as? String=="reviewed" && p["planHash"] as? String==bound.planHash && integer(p["stageIndex"])==index,"NATIVE_STAGE_BINDING")
  let signatures=try o.reviewedTasks.map{task in guard let s=o.reviewedSignatures[try string(task["taskId"])]else{throw NativeCustodyFailure(code:"NATIVE_STAGE_INCOMPLETE")};return s}
  try reviewedCompute(o,"finalizeReviewedStage",["stage":previousStage,"signatures":signatures,"signatureEncoding":"compact64"],finish:{finalized in
   if o.reviewedBound?.associated==false{o.reviewedDetached[o.stage]=finalized["sigs"]!}
   return o.reviewedParents+[try self.string(finalized["txraw"])]
  },complete:{result in
   do{
    let parents=try result.get();try self.need(self.canonical(p["previousTransactions"])==self.canonical(parents),"NATIVE_PARENT_CHANGED")
    try self.reviewedCompute(o,"prepareReviewedStage",bound.prepare(index:index,parents:bound.associated ? parents:[]),finish:{actual in
     let tasks=try bound.tasks(actual:actual,claimed:self.map(p["stage"]),index:index)
     try self.need(self.canonical(tasks)==self.canonical(p["signingRequests"]) && o.tasks.count+tasks.count<=o.expectedTasks,"NATIVE_STAGE_TASKS")
     for task in tasks{let key=try self.string(task["taskId"]);try self.need(o.tasks[key]==nil,"NATIVE_TASK_DUPLICATE");o.tasks[key]=task}
     o.stage=index;o.reviewedStage=try self.immutable(actual);o.reviewedTasks=tasks;o.reviewedParents=parents;o.reviewedSignatures.removeAll();return true
    },complete:complete)
   }catch{complete(.failure(error))}
  })
 }
 // Called only by the private trusted worker after Engine validate(finalized,
 // pending). The Engine proves parent bytes/digests; custody independently
 // preserves one receipt and rejects skipped/replayed or expanded task stages.
 func advance(owner:String,scope:[String:String],id:String,receipt:[String:Any],pending:[String:Any])throws{
  let o=try signingOperation(owner,scope,id);try self.receipt(o)
  try need(NativePrepared.transaction(o.method) && canonical(receipt)==canonical(o.receipt),"NATIVE_RECEIPT_CHANGED")
  try need(o.session.pending[id]==nil && o.completed==Set(o.tasks.keys) && o.completed.count<o.expectedTasks,"NATIVE_STAGE_INCOMPLETE")
  let p=try immutable(pending),c=try map(p["continuation"]),s=try map(c["signingStage"]),inner=try map(s["continuation"])
  let stage=try integer(c["stage"]),session=try string(c["sessionId"]),commitment=try string(c["stageCommitment"])
  _ = try digest(session);_ = try digest(commitment)
  let profile=(o.request?["intent"] as? [String:Any])?["type"] as? String
  // Match the pinned Engine's outer-request family, not the resolved asset:
  // direct AMM/LP is pool; unified amm.*/tbc20Lp.* aliases retain ft.
  let poolFamily=profile=="tbc-amm-create" || (poolContinuation(profile) && profile?.hasPrefix("tbc-amm-")==true) || (lpContinuation(profile) && profile?.hasPrefix("tbc20-lp-")==true)
  let family=profile=="tbc721-standard-batch-mint" ? "nft":poolFamily ? "pool":"ft"
  try need(p["status"] as? String=="pending" && c["version"] as? String=="1.0" && c["method"] as? String=="finalize" && c["family"] as? String==family,"NATIVE_STAGE_KIND")
  try need(c["requestHash"] as? String==o.requestHash && c["planHash"] as? String==o.planHash && c["bindingHash"] as? String==o.receipt!["bindingHash"] as? String && c["approvalId"] as? String==o.receipt!["approvalId"] as? String,"NATIVE_STAGE_BINDING")
  try need(stage==o.stage+1 && stage<o.transactionCount && (o.stageSession==nil || o.stageSession==session) && s["sessionId"] as? String==session && integer(s["stage"])==stage && s["stageCommitment"] as? String==commitment && inner["sessionId"] as? String==session && inner["planCommitment"] as? String==session && integer(inner["nextStage"])==stage,"NATIVE_STAGE_ORDER")
  guard let tasks=p["signingRequests"] as? [[String:Any]],let requests=s["signingRequests"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"NATIVE_TASKS")}
  let limit=(poolContinuation(profile) || lpContinuation(profile)) ? 128:(["tbc20.transfer":32,"tbc20.merge":32,"tbc20-standard-create":128,"tbc721-standard-batch-mint":128,"tbc-amm-create":128][profile ?? ""] ?? 0)
  try need(!tasks.isEmpty && tasks.count<=limit && tasks.count==requests.count && o.tasks.count+tasks.count<=o.expectedTasks,"NATIVE_TASKS")
  var validated=[String:[String:Any]]()
  for (t,r) in zip(tasks,requests){
   let tx=try string(t["transactionTemplateId"]),index=try integer(t["inputIndex"]),taskId=try string(t["taskId"])
   try need(index>=0 && index<128 && o.transactionIds.contains(tx) && taskId=="sign-\(tx)-input-\(index)" && o.tasks[taskId]==nil && validated[taskId]==nil,"NATIVE_TASK_DUPLICATE")
   let account=try taskAccount(o,t)
   try need(t["purpose"] as? String=="transaction" && t["signatureEncoding"] as? String=="compact64" && t["algorithm"] as? String=="secp256k1-ecdsa-sha256d" && integer(t["sighashType"])==65,"NATIVE_TASK_ACCOUNT")
   _ = try digest(t["digest"])
   try need(r["transactionId"] as? String==tx && integer(r["inputIndex"])==index && r["digest"] as? String==t["digest"] as? String && r["publicKey"] as? String==account.publicKey && r["algorithm"] as? String=="secp256k1-ecdsa" && integer(r["sighashType"])==65 && integer(r["stage"])==stage && r["sessionId"] as? String==session && r["stageCommitment"] as? String==commitment,"NATIVE_STAGE_TASK_BINDING")
   validated[taskId]=t
  }
  o.tasks.merge(validated){a,_ in a};o.stage=stage;o.stageSession=session
 }
 private func receipt(_ o:Operation)throws{
  try current(o);try need(o.approved && o.receipt != nil,"NO_RECEIPT")
  try need(Date()<date(o.receipt!["expiresAt"]),"NATIVE_EXPIRED")
 }
 func sign(owner:String,scope:[String:String],id:String,receipt:[String:Any],task:[String:Any],
  complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  let o=try signingOperation(owner,scope,id);try self.receipt(o)
  try need(!NativeCrypto.methods.contains(o.method),"NATIVE_CRYPTO_NOT_DIGEST")
  try need(canonical(receipt)==canonical(o.receipt),"NATIVE_RECEIPT_CHANGED")
  let t=try immutable(task),taskId=try string(t["taskId"])
  try need(!o.signerUnavailable && canonical(t)==canonical(o.tasks[taskId]) && o.session.pending[id]==nil && o.consumed.insert(taskId).inserted,"NATIVE_TASK_CHANGED_OR_REPLAY")
  let encoding=try string(t["signatureEncoding"]);var done=false
  func result(_ value:Result<[String:Any],Error>){guard !done else{return};done=true;o.session.pending.removeValue(forKey:id);complete(value)}
  o.session.pending[id]={result(.failure(NativeCustodyFailure(code:"NATIVE_CANCELLED")))}
  signer.sign(account:try taskAccount(o,t),digest:try digest(t["digest"]),encoding:encoding,requireCurrent:{try self.receipt(o)}){signed in
   if !done{result(Result{
    try self.receipt(o)
    if case .failure(let error)=signed,error is NativeSignerUnavailable,let w=o.workflowParent?.workflow,let bound=w.bound,try self.map(bound.plan["payload"])["failureMode"] as? String=="continue-independent"{
     o.signerUnavailable=true;throw NativeWorkflowStepUnavailable()
    }
    let signature=try signed.get();try self.need(signature.count==(encoding=="compact64" ? 64:65),"NATIVE_SIGNATURE_ENCODING")
    o.completed.insert(taskId);if o.method==NativeReviewed.method{o.reviewedSignatures[taskId]=self.hex(signature)}
    let value:[String:Any]=["taskId":taskId,"signatureEncoding":encoding,"signature":self.hex(signature)]
    if o.workflowParent != nil{o.signedResults[taskId]=value};return value
   })}
  }
 }
 // Same one-use operation/receipt owner; no second approval or digest signing.
 func executeCrypto(owner:String,scope:[String:String],id:String,receipt:[String:Any],task:[String:Any],complete:@escaping @MainActor (Result<[String:Any],Error>)->Void)throws{
  let o=try signingOperation(owner,scope,id);try self.receipt(o)
  guard let crypto,NativeCrypto.methods.contains(o.method) else{throw NativeCustodyFailure(code:"NATIVE_CRYPTO_UNAVAILABLE")}
  let t=try immutable(task),taskId=try string(t["taskId"])
  try need(canonical(receipt)==canonical(o.receipt) && canonical(t)==canonical(o.tasks[taskId]) && o.session.pending[id]==nil && o.consumed.insert(taskId).inserted,"NATIVE_TASK_CHANGED_OR_REPLAY")
  var input=try NativeCrypto.input(t),done=false
  func result(_ value:Result<[String:Any],Error>){guard !done else{return};done=true;o.session.pending.removeValue(forKey:id);complete(value)}
  o.session.pending[id]={result(.failure(NativeCustodyFailure(code:"NATIVE_CANCELLED")))}
  crypto.execute(account:o.account,purpose:o.method=="tbc_encrypt" ? .encrypt:.decrypt,input:input,requireCurrent:{try self.receipt(o)}){reply in
   var output=(try? reply.get()) ?? []
   defer{_ = input.withUnsafeMutableBytes{$0.initializeMemory(as:UInt8.self,repeating:0)};_ = output.withUnsafeMutableBytes{$0.initializeMemory(as:UInt8.self,repeating:0)}}
   guard !done else{return}
   result(Result{
    try self.receipt(o)
    if case .failure(let error)=reply,error is NativeCryptoUnavailable,let bound=o.workflowParent?.workflow?.bound,try self.map(bound.plan["payload"])["failureMode"] as? String=="continue-independent"{
     o.cryptoUnavailable=true;throw NativeWorkflowCryptoUnavailable()
    }
    _ = try reply.get()
    let value=try NativeCrypto.result(t,output:output)
    o.cryptoResultHash=try self.hash(o.workflowParent==nil ? NativeCrypto.publicResult(value,account:o.account):value);o.completed.insert(taskId)
    return value
   })
  }
 }
 // Reconstruct from native-owned completed children, not a worker completion
 // flag. Sign-workflow delivery and send-workflow authorization share this.
 private func completedWorkflow(_ o:Operation)throws->[String:Any]{
  try receipt(o)
  guard let w=o.workflow,let bound=w.bound else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_INCOMPLETE")}
  try need(w.activeIndex==nil && w.nextIndex==w.children.count && w.completedResults.count+w.unavailableResults.count==w.children.count && o.session.pending[o.id]==nil,"NATIVE_WORKFLOW_INCOMPLETE")
  let p=try map(bound.plan["payload"]),rows=try w.steps.map{step->[String:Any] in
   if let unavailable=w.unavailableResults[try string(step["id"])]{return unavailable}
   guard let result=w.completedResults[try string(step["id"])]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_INCOMPLETE")}
   return ["id":step["id"]!,"kind":step["kind"]!,"result":result]
  }
  return ["version":"1.0","chainId":o.account.chainId,"from":o.account.address,"requestHash":p["requestHash"]!,"workflowPlanHash":bound.plan["workflowPlanHash"]!,"approvalId":o.receipt!["approvalId"]!,"failureMode":p["failureMode"]!,"steps":rows,"totalFee":p["totalFee"]!]
 }
 // Private worker only, after shared Engine final/pre-broadcast verification.
 // This does not replace that verification or grant arbitrary raw-send access.
 // Own one immutable exact result; later transport calls may only select it.
 func authorizeBroadcast(owner:String,scope:[String:String],id:String,receipt:[String:Any],bundle:[String:Any],workflow:[String:Any]?=nil)throws{
  let o=try operation(owner,scope,id);try self.receipt(o)
  guard let source=sendSourceIdentity else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_UNAVAILABLE")}
  try need(NativePrepared.sends(o.method) && o.sendMaterial==nil && canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
  let value=try immutable(bundle),transactions:[[String:Any]]
  if let w=o.workflow{
   let expected=try completedWorkflow(o);try need(canonical(workflow)==canonical(expected),"NATIVE_BROADCAST_WORKFLOW")
   guard let bound=w.bound,let order=try map(bound.plan["payload"])["stepOrder"] as? [String]else{throw NativeCustodyFailure(code:"NATIVE_WORKFLOW_INCOMPLETE")}
   let rows=expected["steps"] as! [[String:Any]];var txs=[[String:Any]]()
   for stepId in order{
    guard let row=rows.first(where:{$0["id"] as? String==stepId})else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_WORKFLOW")}
    if ["transaction","preparedTransaction","reviewedTransaction"].contains(row["kind"] as? String ?? ""),let result=row["result"] as? [String:Any]{
     guard let child=result["transactions"] as? [[String:Any]]else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_WORKFLOW")};txs+=child
    }
   }
   let projected:[String:Any]=["version":"1.0","chainId":expected["chainId"]!,"from":expected["from"]!,"requestHash":expected["requestHash"]!,"approvalId":expected["approvalId"]!,"transactions":txs,"totalFee":expected["totalFee"]!]
   try need(canonical(value)==canonical(projected),"NATIVE_BROADCAST_WORKFLOW");transactions=txs
  }else{
   guard let plan=o.sendPlan else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_PLAN")}
   try need(workflow==nil && fullySigned(o),"NATIVE_STAGE_INCOMPLETE")
   transactions=try NativeWorkflow.completedBundle(value,account:o.account,requestHash:o.requestHash!,approvalId:string(receipt["approvalId"]),fee:string(plan["totalFee"]),transactions:plan["transactions"] as? [[String:Any]],reviewed:nil)
  }
  let ids=try transactions.map{try string($0["txid"])}
  try need((1...32).contains(ids.count) && Set(ids).count==ids.count && transactions.allSatisfy{($0["rawTransaction"] as? String)?.utf8.count ?? Int.max <= 4*1024*1024},"NATIVE_BROADCAST_BOUNDS")
  let accountHash=try hash(o.account.identity),authorization=try hash(["method":o.method,"sourceIdentity":source,"accountScopeHash":accountHash,"contextHash":hash(context(o.session)),"operationId":id,"approvalId":receipt["approvalId"]!,"bindingHash":receipt["bindingHash"]!,"bundleHash":hash(value)])
  o.sendMaterial=["bundle":value,"sourceIdentity":source,"accountScopeHash":accountHash,"authorizationId":authorization,"expiresAt":receipt["expiresAt"]!]
 }
 // Native adapter selects already authorized bytes, never replacement bytes.
 // SQLite admission and actual HTTP must repeat this fence immediately before
 // dispatch. Selection is read-only; it is not a dispatch/retry permit.
 func broadcastSelection(owner:String,scope:[String:String],id:String,receipt:[String:Any],index:Int?)throws->[String:Any]{
  let o=try operation(owner,scope,id);try self.receipt(o)
  guard let material=o.sendMaterial else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_NOT_AUTHORIZED")}
  try need(NativePrepared.sends(o.method) && o.sendResultHash==nil && canonical(receipt)==canonical(o.receipt) && material["sourceIdentity"] as? String==sendSourceIdentity,"NATIVE_BROADCAST_AUTHORITY")
  let all=try map(material["bundle"])["transactions"] as! [[String:Any]],selected:[[String:Any]]
  if let index{try need(o.workflow==nil && all.indices.contains(index),"NATIVE_BROADCAST_SELECTION");selected=[all[index]]}
  else{try need(o.workflow != nil,"NATIVE_BROADCAST_SELECTION");selected=all}
  return try immutable(material.filter{$0.key != "bundle"}.merging(["method":o.method,"transactions":selected]){_,b in b})
 }
 // Hot dispatch fence reuses immutable authorization: no raw copying/hashing.
 func broadcastCurrent(owner:String,scope:[String:String],id:String,receipt:[String:Any],authorizationId:String)throws{
  let o=try operation(owner,scope,id);try self.receipt(o)
  try need(o.sendResultHash==nil && o.sendMaterial?["authorizationId"] as? String==authorizationId && canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
 }
 func broadcastAuthorization(owner:String,scope:[String:String],id:String,receipt:[String:Any])throws->String{
  let o=try operation(owner,scope,id);try self.receipt(o)
  try need(o.sendResultHash==nil && canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
  guard let authorization=o.sendMaterial?["authorizationId"] as? String else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_NOT_AUTHORIZED")};return authorization
 }
 // Native adapter lifetime, not a serialized callback/permit. Run even when the
 // authority has already changed: it may cancel only its own unstarted ticket.
 func ownBroadcast(owner:String,scope:[String:String],id:String,key:String,state:@escaping ()throws->[[String:String]],close:@escaping ()->Void,recoveryId:String?=nil)throws{
  let o=try operation(owner,scope,id);try receipt(o)
  try need(o.sendMaterial != nil && o.broadcastClosers[key]==nil && o.broadcastClosers.count<32,"NATIVE_BROADCAST_OWNER")
  o.broadcastClosers[key]=close;o.broadcastStates[key]=state
  if o.maintenance != nil && key=="single:0"{o.maintenanceRecoveryId=recoveryId}
 }
 private func closeBroadcasts(_ o:Operation){let callbacks=Array(o.broadcastClosers.values);o.broadcastClosers.removeAll();o.broadcastStates.removeAll();for close in callbacks{close()}}
 // Commit only the exact public projection of this operation's native-owned
 // signed material and actual journal outcomes. No HTTP, second approval or
 // new durable result record; only an ephemeral digest survives close.
 func finishBroadcast(owner:String,scope:[String:String],id:String,receipt:[String:Any],result:[String:Any])throws{
  let o=try operation(owner,scope,id);try self.receipt(o)
  try need(NativePrepared.sends(o.method) && o.sendResultHash==nil && canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_RESULT")
  guard let material=o.sendMaterial else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_NOT_AUTHORIZED")}
  let bundle=try map(material["bundle"]),txs=try map(material["bundle"])["transactions"] as! [[String:Any]]
  let keys=o.workflow==nil ? txs.indices.map{"single:\($0)"}:["batch"]
  try need(Set(o.broadcastStates.keys)==Set(keys),"NATIVE_BROADCAST_RESULT")
  let states=try keys.flatMap{try o.broadcastStates[$0]!()}
  try need(states.count==txs.count && zip(states,txs).allSatisfy{$0["txid"]==$1["txid"] as? String},"NATIVE_BROADCAST_RESULT")
  if o.workflow==nil{
   try need(states.allSatisfy{["accepted","known"].contains($0["status"] ?? "")},"NATIVE_BROADCAST_RESULT")
   var expected=bundle
   expected["transactions"]=txs.map{tx in ["id":tx["id"]!,"txid":tx["txid"]!,"status":"submitted","role":tx["role"]!,"dependsOn":tx["dependsOn"]!]}
   try need(canonical(result)==canonical(expected),"NATIVE_BROADCAST_RESULT")
  }else{
   guard let rows=result["transactions"] as? [[String:Any]],rows.count==txs.count else{throw NativeCustodyFailure(code:"NATIVE_BROADCAST_RESULT")}
   var byId=[String:String](),statuses=Set<String>()
   for (i,tx) in txs.enumerated(){
    let row=rows[i];var status=states[i]["status"]!
    let blocked=(tx["dependsOn"] as! [String]).contains{["rejected","unknown"].contains(byId[$0] ?? "")}
    if blocked && ["accepted","known"].contains(status){status="unknown"}
    try need(Set(row.keys).isSubset(of:["txid","status","reason"]) && row["txid"] as? String==tx["txid"] as? String && row["status"] as? String==status,"NATIVE_BROADCAST_RESULT")
    if let reason=row["reason"]{try need((reason as? String).map{$0.utf16.count<=512} ?? false,"NATIVE_BROADCAST_RESULT")}
    byId[tx["id"] as! String]=status;statuses.insert(status)
   }
   let status=statuses.isSubset(of:["accepted","known"]) ? "complete":statuses==["rejected"] ? "rejected":statuses==["unknown"] ? "unknown":"partial"
   let expected:[String:Any]=["version":"1.0","status":status,"workflow":try completedWorkflow(o),"transactions":rows]
   try need(canonical(result)==canonical(expected),"NATIVE_BROADCAST_RESULT")
  }
  let resultHash=try hash(result)
  if let m=o.maintenance{
   guard let fee=o.maintenanceFee,txs.count==1,let txid=txs[0]["txid"] as? String else{throw NativeCustodyFailure(code:"NATIVE_MERGE_RESULT")}
   try need(fee<=m.maxFee-m.spent && !m.accepted.contains(txid),"NATIVE_MERGE_RESULT")
   m.spent+=fee;m.accepted.insert(txid);m.consumedInputs.formUnion(o.maintenanceBoundInputs);m.nextIndex+=1
   let step=o.maintenanceStep!
   m.completedRows.append(["stepId":step["stepId"]!,"txid":txid,"status":states[0]["status"]!,"fee":String(fee),"inputCount":step["inputCount"]!,"outputCount":1,"dependsOn":step["dependsOn"]!])
  }
  o.sendResultHash=resultHash
 }
 // A completed operation retains only an epoch permit for result emission, not
 // its receipt/tasks/request or further signing authority.
 func close(owner:String,scope:[String:String],id:String)throws{
  let s=try session(owner,scope);guard let o=s.operations[id]else{return}
  var deliverable=false,workflowHash:String?
  do{
   try current(o)
   // A completed signature or prepared dispatch is not a completed send.
   // Only finishBroadcast can attest the send, never signature completion.
   if NativePrepared.sends(o.method){try receipt(o);deliverable=o.sendResultHash != nil}
   else if o.workflow != nil{
    workflowHash=try hash(completedWorkflow(o));deliverable=true
   }else if NativeCrypto.methods.contains(o.method){try receipt(o);deliverable = fullySigned(o) && o.cryptoResultHash != nil}
   else{deliverable = fullySigned(o)}
  }catch{}
  if o.method==NativeReviewed.method && o.stage != o.transactionCount-1{deliverable=false}
  if deliverable{s.results[id]=DeliveryPermit(revision:o.revision,accountRevision:o.accountRevision,account:o.account,epoch:o.epoch,capability:NativePrepared.permission(o.method),controller:o.controller,workflowMethod:workflowHash==nil ? nil:o.method,workflowResultHash:workflowHash,cryptoMethod:o.cryptoResultHash==nil ? nil:o.method,cryptoResultHash:o.cryptoResultHash,sendMethod:o.sendResultHash==nil ? nil:o.method,sendResultHash:o.sendResultHash)}
  if let m=o.maintenance{
   if !deliverable && o.sendResultHash==nil{
    m.failedStep=o.maintenanceStep
    // No owned dispatch means no native network entry. Otherwise retain a
    // conservative unknown result; never accept a worker's assertion of POST=0.
    m.failureMayHaveSubmitted = !o.broadcastStates.isEmpty
    m.failureRecoveryId=o.maintenanceRecoveryId
   }
   m.activeChild=nil;if !deliverable{m.stopped=true}
  }
  s.operations.removeValue(forKey:id);closeBroadcasts(o);s.pending.removeValue(forKey:id)?()
 }
 // Repeat on the native WebView executor at actual signature result emission.
 private func verifiedDelivery(owner:String,scope:[String:String],id:String)throws->DeliveryPermit{
   let s=try session(owner,scope);guard let p=s.results[id]else{throw NativeCustodyFailure(code:"NO_DELIVERY_PERMIT")}
   try current(s,p.revision,p.account,p.accountRevision,id);try permissions.require(s.scope["origin"]!,p.capability,account:permissionAccount(p.account))
   if let controller=p.controller{try requireActive(s,controller);try permissions.require(s.scope["origin"]!,p.capability,account:controller)}
   if p.sendResultHash != nil || p.maintenanceResultHash != nil{try permissions.require(s.scope["origin"]!,"tbc_sendTransaction",account:permissionAccount(p.account))}
   try need(permissions.epoch(s.scope["origin"]!)==p.epoch);return p
 }
 func mayDeliverSignature(owner:String,scope:[String:String],id:String)->Bool{
  guard let p=try? verifiedDelivery(owner:owner,scope:scope,id:id)else{return false};return p.workflowResultHash==nil && p.cryptoResultHash==nil && p.sendResultHash==nil && p.maintenanceResultHash==nil
 }
 func mayDeliverMaintenanceResult(owner:String,scope:[String:String],id:String,resultHash:String)->Bool{
  guard let p=try? verifiedDelivery(owner:owner,scope:scope,id:id)else{return false};return p.maintenanceResultHash==resultHash
 }
 // The frozen wallet helper adds bounded informational progress, not another
 // result authority. Only the native-attested core may claim submission facts.
 func maintenanceProjectionHash(owner:String,scope:[String:String],id:String,result:Any?)throws->String{
  let permit=try verifiedDelivery(owner:owner,scope:scope,id:id)
  var core=try map(result)
  try need(canonical(core.removeValue(forKey:"atomic"))=="false","NATIVE_MERGE_PROGRESS")
  guard let progress=core.removeValue(forKey:"progress") as? [[String:Any]],let target=permit.maintenanceTarget else{throw NativeCustodyFailure(code:"NATIVE_MERGE_PROGRESS")}
  let digest=try hash(core)
  try need(digest==permit.maintenanceResultHash && (1...4096).contains(progress.count),"NATIVE_MERGE_PROGRESS")
  guard let steps=core["steps"] as? [Any]else{throw NativeCustodyFailure(code:"NATIVE_MERGE_PROGRESS")}
  let total=try amount(core["totalFee"]),initial=try integer(core["initialUtxoCount"]),final=try integer(core["finalUtxoCount"])
  var previousIndex=0,previousCount=0
  var previousFee=try amount("0")
  for (position,row) in progress.enumerated(){
   try need(Set(row.keys)==["phase","stepIndex","utxoCount","targetUtxoCount","transactionCount","totalFee"],"NATIVE_MERGE_PROGRESS")
   let phase=try string(row["phase"]),index=try integer(row["stepIndex"]),count=try integer(row["transactionCount"]),utxos=try integer(row["utxoCount"]),fee=try amount(row["totalFee"])
   try need(["approval","preparing","executing","reconciling","indexing","complete"].contains(phase) && integer(row["targetUtxoCount"])==target && (previousIndex...64).contains(index) && (previousCount...steps.count).contains(count) && (0...9007199254740991).contains(utxos) && fee>=previousFee && fee<=total,"NATIVE_MERGE_PROGRESS")
   if phase=="approval"{try need(position==0 && index==0 && count==0 && fee==amount("0") && utxos==initial,"NATIVE_MERGE_PROGRESS")}
   if phase=="complete"{try need(position==progress.count-1 && core["status"] as? String=="complete" && count==steps.count && utxos==final && fee==total,"NATIVE_MERGE_PROGRESS")}
   previousIndex=index;previousCount=count;previousFee=fee
  }
  try need(progress.first?["phase"] as? String==(core["approvalId"]==nil ? "complete":"approval") && (core["status"] as? String != "complete" || progress.last?["phase"] as? String=="complete"),"NATIVE_MERGE_PROGRESS")
  return digest
 }
 func mayDeliverSendResult(owner:String,scope:[String:String],id:String,method:String,resultHash:String)->Bool{
  guard NativePrepared.sends(method),let p=try? verifiedDelivery(owner:owner,scope:scope,id:id)else{return false}
  return p.sendMethod==method && p.sendResultHash==resultHash
 }
 func mayDeliverCryptoResult(owner:String,scope:[String:String],id:String,method:String,resultHash:String)->Bool{
  guard NativeCrypto.methods.contains(method),let p=try? verifiedDelivery(owner:owner,scope:scope,id:id)else{return false}
  return p.cryptoMethod==method && p.cryptoResultHash==resultHash
 }
 func mayDeliverWorkflowResult(owner:String,scope:[String:String],id:String,method:String,resultHash:String)->Bool{
  guard NativeWorkflow.methods.contains(method),let p=try? verifiedDelivery(owner:owner,scope:scope,id:id)else{return false}
  return p.workflowMethod==method && p.workflowResultHash==resultHash
 }
 func forgetResult(owner:String,scope:[String:String],id:String)throws{try session(owner,scope).results.removeValue(forKey:id)}
 private func map(_ v:Any?)throws->[String:Any]{guard let m=v as? [String:Any]else{throw NativeCustodyFailure(code:"INVALID_OBJECT")};return m}
 // Shared framing is also used by whole-batch commitments.
 private func typedEnvelope(_ r:[String:Any],_ origin:String)throws->[String:Any]{try NativeSigningEnvelope.typed(r,chain:chain,origin:origin)}
 private func typedDigest(_ e:[String:Any])throws->String{try NativeSigningEnvelope.digest(e,purpose:"typedData")}
 private func lopDescription(_ i:[String:Any],_ owner:String)throws->String{
  if i["type"] as? String=="tbc-lop-create"{
   let o=try map(i["order"]),side=try string(o["side"]),market=try string(o["market"])
   try need(["buy","sell"].contains(side) && ["native-token","token-token"].contains(market) && (market=="token-token")==((o["assetB"] as? [String:Any]) != nil),"LOP_ORDER")
   func asset(_ v:Any?)throws->String{let a=try map(v),standard=try string(a["standard"]),id=try string(a["contractId"]);_ = try digest(id);try need(["tbc20-standard","tbc20-stablecoin"].contains(standard),"LOP_ASSET");return "\(standard) \(id)"}
   let a=try asset(o["assetA"]),b=try (o["assetB"] as? [String:Any]).map{try asset($0)}
   let base=market=="native-token" ? "TBC":a,quote=b ?? a
   let volume=try amount(o["saleVolume"]),price=try amount(o["unitPrice"]),rate=try amount(o["feeRate"])
   try need(volume>0 && price>0 && [volume,price,rate].allSatisfy{$0<=9223372036854775807},"LOP_AMOUNT")
   let escrow=side=="sell" ? "\(volume) base atomic":"floor(\(volume) * \(price) / 1000000) quote atomic"
   let deposits=(side=="sell" && market=="native-token") ? "":"\nToken escrow also uses native contract deposits (300 order atomic and 500 per token holding), separate from network fees."
   return "Create LOP \(side) order (\(market)).\nOwner: \(owner).\nBase: \(base).\nQuote: \(quote).\nVolume: \(volume) base atomic; unit price: \(price) / 1000000 quote atomic per base atomic.\nEscrow: \(escrow).\nSettlement fee rate: \(rate) / 1000000; fee recipient: \(try string(o["feeRecipient"])).\nOrder terms are committed on chain; a later match may partially fill this order. Only the owner can cancel remaining escrow."+deposits
  }
  let cancel=i["type"] as? String=="tbc-lop-cancel"
  guard let points=i["targetOutpoints"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"LOP_SELECTION")}
  try need(points.count==(cancel ? 1:2),"LOP_SELECTION")
  let labels=try points.map{p in let id=try string(p["txid"]),vout=try integer(p["vout"]);_ = try digest(id);try need(vout>=0 && vout<=4294967295,"LOP_SELECTION");return "\(id):\(vout)"}
  try need(Set(labels).count==labels.count,"LOP_SELECTION")
  let detail=cancel ? "Cancel only this exact order and return remaining escrow to the same owner: \(owner).":"Match only these exact orders in buy/sell order. Matcher and network fee payer: \(owner). Committed order owners, assets, price, settlement fees and any remaining order are validated; they cannot be overridden. The matcher must differ from both order owners."
  return "LOP\n\(detail)\n\(labels.joined(separator:"\n"))\nFresh order and paired asset availability are checked before signing. No other orders are swept."
 }
 private func htlcDescription(_ i:[String:Any],_ r:[String:Any],_ owner:String)throws->String{
  let standard=i["assetStandard"] as? String,token=standard != nil
  try need(!token || ["tbc20-standard","tbc20-stablecoin"].contains(standard!),"HTLC_TOKEN_STANDARD")
  var asset="TBC"
  if token{let id=try string(i["contractId"]);_ = try digest(id);asset="\(standard!) token \(id)"}
  if i["type"] as? String=="tbc-htlc-lock"{
   let lock=try amount(i["lockTime"]);try need(lock>0 && lock<=2147483647,"HTLC_LOCK_DOMAIN")
   let hashlock=try string(i["hashlock"]);_ = try digest(hashlock)
   return "Lock \(try amount(i["amount"])) \(asset) atomic.\nReceiver: \(try string(i["to"])). Sender/refund owner: \(owner).\nHashlock: \(hashlock).\nRefund threshold: \(lock) \(lock<500000000 ? "block height (inclusive)":"chain median time (strictly greater, not local time)"). Claim by the receiver with the proof remains possible after this threshold."
  }
  let selection=token ? i["targetOutpoints"] : try map(r["constraints"])["inputOutpoints"]
  guard let points=selection as? [[String:Any]] else{throw NativeCustodyFailure(code:"HTLC_SELECTION")}
  try need(!points.isEmpty && points.count<=(token ? 1:128),"HTLC_SELECTION")
  let labels=try points.map{p in let id=try string(p["txid"]),vout=try integer(p["vout"]);_ = try digest(id);try need(vout>=0 && vout<=4294967295 && (!token || vout==1),"HTLC_SELECTION");return "\(id):\(vout)"}
  try need(Set(labels).count==labels.count,"HTLC_SELECTION")
  let claim=i["type"] as? String=="tbc-htlc-claim"
  let disclosure=claim ? "WARNING: Returning signed claim transactions reveals the preimage to the requesting DApp and anyone it shares them with, before broadcast. The preimage is not displayed here.":"Refund requires the sender role and mature chain height or median time; local time is not authority."
  let detail=token ? "Full balance of selected \(asset) holding and its paired native escrow; both are validated and spent together.":"Selected native HTLC deposits."
  return "\(claim ? "Claim":"Refund") only these \(labels.count) deposits to \(owner).\n\(detail)\n\(labels.joined(separator:"\n"))\n\(disclosure)\nNo other deposits are swept."
 }
 private func timelockDescription(_ i:[String:Any],_ r:[String:Any],_ owner:String)throws->String{
  if i["type"] as? String=="tbc-timelock-lock"{
   let height=try amount(i["lockTime"]);try need(height>0 && height<500000000,"TIMELOCK_HEIGHT_DOMAIN")
   return "Lock \(try amount(i["amount"])) TBC atomic to the same owner: \(owner).\nUnlock no earlier than block height \(height), not a timestamp. The bound chain tip and lock conditions are checked before signing."
  }
  guard let points=try map(r["constraints"])["inputOutpoints"] as? [[String:Any]] else{throw NativeCustodyFailure(code:"TIMELOCK_SELECTION")}
  try need(!points.isEmpty && points.count<=128,"TIMELOCK_SELECTION")
  let labels=try points.map{p in
   let txid=try string(p["txid"]),vout=try integer(p["vout"]);_ = try digest(txid)
   try need(vout>=0 && vout<=4294967295,"TIMELOCK_SELECTION");return "\(txid):\(vout)"
  }
  try need(Set(labels).count==labels.count,"TIMELOCK_SELECTION")
  return "Unlock only these \(labels.count) selected TimeLock deposits to the same owner: \(owner).\n\(labels.joined(separator:"\n"))\nDeposit ownership and block-height maturity are checked against authenticated material before signing. No other deposits are swept."
 }
 private func lpDescription(_ i:[String:Any],_ owner:String)throws->String{
  let pool=try string(i["poolContractId"]),detail:String
  switch i["type"] as? String{
  case "tbc20-lp-transfer", "tbc20Lp.transfer":detail="Transfer \(try string(i["amount"])) LP atomic to \(try string(i["to"]))."
  case "tbc20-lp-lock", "tbc20Lp.lock":
   let lock=try amount(i["lockTime"]);try need(lock<=4294967295,"LP_LOCK_RANGE")
   detail="Lock \(try string(i["amount"])) LP atomic in \(owner) until \(lock) \(lock<500000000 ? "block height":"Unix time (chain median-time-past)")."
  case "tbc20-lp-merge", "tbc20Lp.merge":detail="Merge mature LP inputs into the same account: \(owner)."
  case "tbc20-lp-unlock", "tbc20Lp.unlock":detail="Unlock mature LP inputs into the same account: \(owner)."
  default:throw NativeCustodyFailure(code:"UNSUPPORTED_INTENT")
  }
  return "LP Pool \(pool).\n\(detail)\nActual contract ownership and maturity are validated before signing."
 }
 private func pool2Description(_ i:[String:Any],_ request:[String:Any])throws->String{
  let pool=try string(i["poolContractId"]);_ = try digest(pool)
  let detail:String
  switch i["type"] as? String{
  case "tbc.pool.swap.exactTbcForToken":detail="Buy FT: input \(try amount(i["tbcAmount"])) TBC atomic; minimum FT \(try amount(i["minimumFtAmount"])) atomic."
  case "tbc.pool.swap.exactTokenForTbc":detail="Sell FT: input \(try amount(i["ftAmount"])) FT atomic; minimum TBC \(try amount(i["minimumTbcAmount"])) atomic."
  case "tbc.pool.liquidity.add":detail="Add liquidity: \(try amount(i["tbcAmount"])) TBC atomic plus proportional pooled FT from this account; minimum LP \(try amount(i["minimumLpAmount"])) atomic."
  case "tbc.pool.liquidity.remove":detail="Remove liquidity: \(try amount(i["lpAmount"])) LP atomic; minimum TBC \(try amount(i["minimumTbcAmount"])) atomic; minimum FT \(try amount(i["minimumFtAmount"])) atomic."
  case "tbc.pool.ft.merge", "amm.mergeToken":detail="Merge up to four Pool-held FT inputs; tokens stay in this pool."
  case "tbc.pool.ftlp.merge":detail="Merge up to five mature LP inputs into the same account: \(try string(request["from"]))."
  case "tbc.pool.ftlp.burn", "tbc20Lp.burn":detail="Permanently destroy the full balance of up to five selected unlocked LP inputs from \(try string(request["from"])). This is not a liquidity withdrawal: no TBC or FT reserves are returned."
  default:throw NativeCustodyFailure(code:"UNSUPPORTED_INTENT")
  }
  let limits=try map(request["constraints"])
  let expiry=try limits["expiresAt"].map{"\nRequest expires: \(try string($0))."} ?? ""
  let receiver=try i["receiver"].map{"\nReceiver: \(try string($0))."} ?? ""
  let label=(i["type"] as? String ?? "").hasPrefix("tbc.pool.") ? "Existing Pool2":"Pool"
  return "\(label) \(pool).\n\(detail)"+receiver+expiry+"\nUse authenticated Pool fees and fresh reserves; actual asset amounts, minimum outputs and required bounds are validated before signing."
 }
 private func ammBusinessDescription(_ i:[String:Any],_ owner:String)throws->String{
  let pool=try string(i["poolContractId"]);_ = try digest(pool)
  let detail:String
  switch i["type"] as? String{
  case "tbc-amm-swap", "amm.swap":
   let direction=try string(i["direction"]);try need(["tbc-to-ft","ft-to-tbc"].contains(direction),"AMM_DIRECTION")
   detail="Swap \(direction): input \(try amount(i["amount"])) atomic; minimum output \(try amount(i["minimumOutput"])) atomic."
  case "tbc-amm-add-liquidity", "amm.addLiquidity":
   let asset=try string(i["budgetAsset"]);try need(["tbc","ft"].contains(asset),"AMM_BUDGET")
   detail="Add liquidity: budget \(try amount(i["amount"])) \(asset) atomic; minimum LP \(try amount(i["minimumLpAmount"])) atomic."
  case "tbc-amm-remove-liquidity", "amm.removeLiquidity":
   detail="Remove liquidity: \(try amount(i["lpAmount"])) LP atomic; minimum TBC \(try amount(i["minimumTbcAmount"])) atomic; minimum FT \(try amount(i["minimumFtAmount"])) atomic."
  default:throw NativeCustodyFailure(code:"UNSUPPORTED_INTENT")
  }
  var extra=""
  for (field,label) in [("initialFtAmount","Initial FT atomic"),("maximumFtAmount","Maximum FT atomic"),("maximumTbcAmount","Maximum TBC atomic"),("lockTime","LP lock time")]{
   if let value=i[field]{extra += "\n\(label): \(try amount(value))."}
  }
  if let value=i["poolStateHash"]{_ = try digest(value);extra += "\nRequired Pool state: \(try string(value))."}
  return "AMM Pool \(pool).\n\(detail)\nReceiver: \(try string(i["receiver"] ?? owner))."+extra+"\nUse authenticated Pool fees; fresh reserves and all requested bounds are validated before signing."
 }
 // Display-only bound configuration. Engine verifies canonical address,
 // contract encoding and the full plan before custody can sign; no fee table.
 private func ammCreationDescription(_ intent:[String:Any])throws->String{
  try need(intent["lpPlan"]==nil && intent["serviceFeeRate"]==nil,"AMM_FEE_FIELDS")
  guard let fees=intent["feePolicy"] as? [String:Any] else{throw NativeCustodyFailure(code:"AMM_FEE_FIELDS")}
  let fields=["lpFeeRate","taxFeeRate","serviceProviderFeeRate","protocolFeeRate"]
  try need(Set(fees.keys)==Set(fields+["feeAddress"]),"AMM_FEE_FIELDS")
  let rates=try fields.map{try integer(fees[$0])}
  try need(rates.allSatisfy{(0...9999).contains($0)},"AMM_FEE_RATE")
  let total=rates.reduce(0,+);try need(total<10000,"AMM_TOTAL_FEE")
  let lp=rates[0],tax=rates[1],service=rates[2],protocolRate=rates[3]
  let address=try string(fees["feeAddress"])
  try need(address.range(of:"^1[1-9A-HJ-NP-Za-km-z]{25,34}$",options:.regularExpression) != nil,"AMM_FEE_ADDRESS")
  let token=try string(intent["ftContractId"]);_ = try digest(token)
  guard let locked=intent["lpTimelock"] as? Bool else{throw NativeCustodyFailure(code:"AMM_LP_LOCK")}
  let controllers:String
  if let value=intent["controllers"]{
   guard let list=value as? [String] else{throw NativeCustodyFailure(code:"AMM_CONTROLLERS")}
   try need((1...5).contains(list.count) && Set(list).count==list.count && list==list.sorted() && list.allSatisfy{$0.range(of:"^[0-9a-f]{40}$",options:.regularExpression) != nil},"AMM_CONTROLLERS")
   controllers=list.joined(separator:", ")
  }else{controllers="Public (no controller)"}
  return "Create empty AMM for FT \(token).\nTotal \(total) bps; LP \(lp) bps; tax \(tax) bps; service provider \(service) bps; protocol \(protocolRate) bps (1 bps = 0.01%).\nCombined non-LP \(total-lp) bps to fee address: \(address).\nLP timelock: \(locked).\nControllers: \(controllers).\nApprove dependent funding/source/pool steps as one bounded request; adding liquidity is separate."
 }
 private func mintDescription(_ intent:[String:Any],_ owner:String)throws->String{
  let items=intent["type"] as? String=="tbc721-standard-mint" ? [intent]:(intent["items"] as? [[String:Any]] ?? [])
  try need((1...32).contains(items.count),"NATIVE_MINT_BOUND")
  let slots=try items.map{try integer($0["slot"])}
  try need(slots.allSatisfy{$0>0 && $0<=0xffffffff} && Set(slots).count==slots.count,"NATIVE_MINT_SLOTS")
  let details=try items.map{item in
   let media=try (item["media"] as? [String:Any]).map{"\nMedia SHA256: \(try hash($0)); \($0["uri"] as? String ?? "embedded")"} ?? ""
   return "Slot \(try integer(item["slot"])): \(try string(item["name"])) (\(try string(item["symbol"]))).\nTo: \(try string(item["to"] ?? owner)).\n\(try string(item["description"]))\nAttributes: \(try canonical(item["attributes"]))."+media
  }.joined(separator:"\n")
  return "Mint \(items.count) NFT(s) from collection \(try string(intent["collectionId"])).\n\(details)\nApprove the ordered mint steps as one bounded request."
 }
 private func poolContinuation(_ profile:String?)->Bool{["tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap","amm.addLiquidity","amm.removeLiquidity","amm.swap"].contains(profile ?? "")}
 // LP uses the Engine's pool continuation family, but not AMM controller authority.
 private func lpContinuation(_ profile:String?)->Bool{["tbc20-lp-transfer","tbc20-lp-merge","tbc20-lp-lock","tbc20-lp-unlock","tbc20Lp.transfer","tbc20Lp.merge","tbc20Lp.lock","tbc20Lp.unlock"].contains(profile ?? "")}
 // Only known maintenance warnings covered by the bounded early consent.
 // Trusted Engine validation still proves the complete plan before binding.
 private func coveredWarnings(_ request:[String:Any],_ payload:[String:Any])->Bool{
  guard let preview=payload["preview"] as? [String:Any],let warnings=preview["warnings"] as? [String] else{return false}
  if (request["intent"] as? [String:Any])?["type"] as? String=="tbc-htlc-claim"{
   return warnings==["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE"] && (payload["transactions"] as? [[String:Any]])?.count==1 && preview["transactionCount"] as? Int==1
  }
  if warnings.isEmpty{return true}
  if poolContinuation((request["intent"] as? [String:Any])?["type"] as? String){
   guard warnings.count==2,Set(warnings)==["MULTI_TRANSACTION","MAINTENANCE_TRANSACTION"],
     let txs=payload["transactions"] as? [[String:Any]],(2...32).contains(txs.count),preview["transactionCount"] as? Int==txs.count else{return false}
   return txs[0]["id"] as? String=="native-funding-1" && txs.dropLast().allSatisfy{$0["role"] as? String=="maintenance"} && txs.last?["role"] as? String=="primary"
  }
  guard (request["intent"] as? [String:Any])?["type"] as? String=="tbc20-standard-create",
    warnings.count==2,Set(warnings)==["MULTI_TRANSACTION","MAINTENANCE_TRANSACTION"],
    let txs=payload["transactions"] as? [[String:Any]],txs.count==3,preview["transactionCount"] as? Int==3 else{return false}
  return txs[0]["role"] as? String=="maintenance" && txs[1]["role"] as? String=="prerequisite" && txs[2]["role"] as? String=="primary"
 }
 private func integer(_ v:Any?)throws->Int{let wire=try canonical(v);guard let n=Int(wire)else{throw NativeCustodyFailure(code:"INVALID_INTEGER")};return n}
 private func string(_ v:Any?)throws->String{guard let s=v as? String else{throw NativeCustodyFailure(code:"INVALID_STRING")};return s}
 private func immutable(_ v:[String:Any])throws->[String:Any]{try PermissionJSON.records("["+canonical(v)+"]")[0]}
 private func canonical(_ v:Any?)throws->String{try PermissionJSON.canonical(v)}
 private func hex(_ bytes:[UInt8])->String{bytes.map{String(format:"%02x",$0)}.joined()}
 private func hash(_ v:Any?)throws->String{hex(Array(SHA256.hash(data:Data(try canonical(v).utf8))))}
 private func digest(_ value:Any?)throws->[UInt8]{
  let s=try string(value);try need(s.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,"NATIVE_DIGEST")
  let bytes=Array(s.utf8);return stride(from:0,to:64,by:2).map{UInt8(String(bytes:bytes[$0..<$0+2],encoding:.utf8)!,radix:16)!}
 }
 private func amount(_ v:Any?)throws->UInt64{
  let s=try string(v);guard s.range(of:"^(0|[1-9][0-9]*)$",options:.regularExpression) != nil,let n=UInt64(s)else{throw NativeCustodyFailure(code:"NATIVE_AMOUNT")};return n
 }
 private let dateFormat:ISO8601DateFormatter={let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f}()
 private func date(_ value:Any?)throws->Date{
  let s=try string(value);if let d=dateFormat.date(from:s){return d}
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime]
  guard let d=f.date(from:s)else{throw NativeCustodyFailure(code:"NATIVE_EXPIRY")};return d
 }
 private func wireNow()->String{dateFormat.string(from:Date(timeIntervalSince1970:floor(Date().timeIntervalSince1970*1000)/1000))}
}

// Shared native framing/normalization. Singles and workflow commitments use
// these same rules. No keys, permission, receipt, network or UI ownership.
enum NativeSigningEnvelope {
 private static func need(_ ok:Bool,_ code:String="NATIVE_DENIED")throws{if !ok{throw NativeCustodyFailure(code:code)}}
 private static func map(_ v:Any?)throws->[String:Any]{guard let m=v as? [String:Any]else{throw NativeCustodyFailure(code:"INVALID_OBJECT")};return m}
 private static func string(_ v:Any?)throws->String{guard let s=v as? String else{throw NativeCustodyFailure(code:"INVALID_STRING")};return s}
 private static func canonical(_ v:Any?)throws->String{try PermissionJSON.canonical(v)}
 private static func immutable(_ v:[String:Any])throws->[String:Any]{try PermissionJSON.records("["+canonical(v)+"]")[0]}
 private static func digestBytes(_ value:Any?)throws->[UInt8]{let s=try string(value);try need(s.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,"NATIVE_DIGEST");let a=Array(s.utf8);return stride(from:0,to:64,by:2).map{UInt8(String(bytes:a[$0..<$0+2],encoding:.utf8)!,radix:16)!}}
 private static func shape(_ m:[String:Any],_ keys:Set<String>)throws{try need(Set(m.keys)==keys,"NATIVE_MESSAGE")}
 static func workflow(_ step:[String:Any],chain:String,from:String,origin:String)throws->[String:Any]{
  if step["kind"] as? String=="message"{let message=try map(step["message"]),e:[String:Any]=["type":"tbc.message","version":"1.0","message":message];_ = try messageBytes(message);return try immutable(e)}
  try need(step["kind"] as? String=="typedData","NATIVE_MESSAGE")
  return try typed(["version":"1.0","chainId":chain,"from":from,"data":map(step["data"])],chain:chain,origin:origin)
 }
 static func typed(_ r:[String:Any],chain:String,origin:String)throws->[String:Any]{
  func shape(_ m:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])throws{
   try need(required.isSubset(of:Set(m.keys)) && Set(m.keys).isSubset(of:required.union(optional)),"NATIVE_TYPED_SHAPE")
  }
  func matches(_ v:Any?,_ pattern:String)throws{let s=try string(v);try need(s.range(of:pattern,options:.regularExpression) != nil,"NATIVE_TYPED_FIELD")}
  func text(_ v:Any?,_ min:Int,_ max:Int)throws{let s=try string(v);try need((min...max).contains(s.unicodeScalars.count),"NATIVE_TYPED_STRING")}
  try shape(r,["version","chainId","from","data"],["clientRequestId"])
  if let v=r["clientRequestId"]{try text(v,1,128)}
  let d=try map(r["data"]);try shape(d,["domain","types","primaryType","message"])
  let domain=try map(d["domain"]);try shape(domain,["name","chainId"],["version","origin","verifyingContract","salt"])
  try text(domain["name"],1,64);try need(domain["chainId"] as? String==chain,"NATIVE_TYPED_CHAIN")
  if let v=domain["origin"]{try text(v,1,2048);try need(v as? String==origin,"NATIVE_TYPED_ORIGIN")}
  if let v=domain["version"]{try matches(v,"^[!-~]{1,32}$")}
  for key in ["verifyingContract","salt"]{if let v=domain[key]{_ = try digestBytes(v)}}
  let identifier="^[A-Za-z][A-Za-z0-9_]{0,63}$"
  try matches(d["primaryType"],identifier)
  let types=try map(d["types"]);try need((1...32).contains(types.count),"NATIVE_TYPED_TYPES")
  var normalized=[String:Any]()
  for (name,value) in types{
   try matches(name,identifier)
   guard let fields=value as? [[String:Any]],(1...64).contains(fields.count)else{throw NativeCustodyFailure(code:"NATIVE_TYPED_FIELDS")}
   for f in fields{try shape(f,["name","type"]);try matches(f["name"],identifier);try matches(f["type"],"^[A-Za-z][A-Za-z0-9_]*(?:\\[(?:[1-9][0-9]{0,2})?\\])?$")}
   normalized[name]=fields.enumerated().sorted{a,b in
    let order=typedFieldOrder(a.element["name"] as! String,b.element["name"] as! String)
    return order==0 ? a.offset<b.offset:order<0
   }.map{$0.element}
  }
  let message=try map(d["message"]);var pending:[Any]=[message]
  while let v=pending.popLast(){
   if v is String{continue}
   if let n=v as? NSNumber{try need(CFGetTypeID(n)==CFBooleanGetTypeID(),"NATIVE_TYPED_VALUE");continue}
   if let a=v as? [Any]{try need(a.count<=256,"NATIVE_TYPED_ARRAY");pending.append(contentsOf:a);continue}
   if let m=v as? [String:Any]{try need(m.count<=64,"NATIVE_TYPED_OBJECT");pending.append(contentsOf:m.values);continue}
   throw NativeCustodyFailure(code:"NATIVE_TYPED_VALUE")
  }
  let e:[String:Any]=["type":"tbc.typedData","version":"1.0","domain":domain,"types":normalized,"primaryType":d["primaryType"]!,"message":message]
  try need(canonical(e).unicodeScalars.count<=65536,"NATIVE_TYPED_SIZE");return try immutable(e)
 }
 private static func typedFieldOrder(_ a:String,_ b:String)->Int{
  let l=Array(a.lowercased().utf8),r=Array(b.lowercased().utf8)
  for i in 0..<min(l.count,r.count){let x=l[i]==95 ? 0:Int(l[i]),y=r[i]==95 ? 0:Int(r[i]);if x != y{return x-y}}
  if l.count != r.count{return l.count-r.count}
  let ac=Array(a.utf8),bc=Array(b.utf8)
  for i in ac.indices{if ac[i] != bc[i]{return Int(bc[i])-Int(ac[i])}};return 0
 }
 static func digest(_ e:[String:Any],purpose:String,walletProtocol:NativeWalletProtocol = .standard)throws->String{
  let data=try payload(e,purpose:purpose,walletProtocol:walletProtocol)
  return SHA256.hash(data:Data(SHA256.hash(data:data))).map{String(format:"%02x",$0)}.joined()
 }
 private static func payload(_ e:[String:Any],purpose:String,walletProtocol:NativeWalletProtocol = .standard)throws->Data{
  func size(_ n:Int)->[UInt8]{if n<253{return [UInt8(n)]};if n<=65535{return [253,UInt8(n&255),UInt8((n>>8)&255)]};return [254,UInt8(n&255),UInt8((n>>8)&255),UInt8((n>>16)&255),UInt8((n>>24)&255)]}
  let typed=purpose=="typedData",magic=Array((typed ? "TBC Signed Typed Data:\n":(walletProtocol == .legacy ? "Bitcoin Signed Message:\n":"TBC Signed Message:\n")).utf8)
  let body=try typed ? Array(PermissionJSON.canonical(e).utf8):messageBytes(map(e["message"]))
  return Data(size(magic.count)+magic+size(body.count)+body)
 }
 static func result(_ e:[String:Any],task:[String:Any],signature:[String:Any],account:NativeAccount,walletProtocol:NativeWalletProtocol = .standard)throws->[String:Any]{
  let purpose=try string(task["purpose"]),raw=try string(signature["signature"]),bytes=Array(raw.utf8)
  try need(["message","typedData"].contains(purpose) && bytes.count==130 && bytes.allSatisfy{(48...57).contains($0)||(97...102).contains($0)},"NATIVE_SIGNATURE_ENCODING")
  let sig=Data(stride(from:0,to:bytes.count,by:2).map{UInt8(String(bytes:bytes[$0..<$0+2],encoding:.utf8)!,radix:16)!})
  var result:[String:Any]=["version":"1.0","scheme":purpose=="typedData" ? "tbc-typed-data":"tbc-message","algorithm":task["algorithm"]!,"address":account.address,"accountId":account.accountId,"publicKey":account.publicKey,"envelope":e,"canonical":try canonical(e),"signingPayload":try payload(e,purpose:purpose,walletProtocol:walletProtocol).base64EncodedString(),"digest":task["digest"]!,"signature":sig.base64EncodedString()]
  if purpose=="message" && walletProtocol == .legacy{result["scheme"]="legacy-bitcoin-message";result.removeValue(forKey:"signingPayload")}
  return result
 }
 private static func messageBytes(_ m:[String:Any])throws->[UInt8]{
   let s=try string(m["data"]);try shape(m,["data","encoding"]);let body:[UInt8]
   switch m["encoding"] as? String{
   case "utf8":body=Array(s.utf8)
   case "hex":try need(!s.isEmpty && s.range(of:"^(?:[0-9a-f]{2})+$",options:.regularExpression) != nil);let a=Array(s.utf8);body=stride(from:0,to:a.count,by:2).map{UInt8(String(bytes:a[$0..<$0+2],encoding:.utf8)!,radix:16)!}
   case "base64":guard let bytes=Data(base64Encoded:s),bytes.base64EncodedString()==s else{throw NativeCustodyFailure(code:"NATIVE_MESSAGE")};body=Array(bytes)
   default:throw NativeCustodyFailure(code:"NATIVE_MESSAGE")
   }
   try need(body.count<=65536);return body
 }
}
