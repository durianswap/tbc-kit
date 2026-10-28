package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

// Private native integration surface. None of these callbacks is registered on
// a WebView. Construct and use the owner on the wallet's custody executor.
class NativeCustodyFailure(val code:String):Exception(code)
// Data-free wallet signal: this task returned no signature. Never use for
// lock/revocation/cancellation or as permission to retry the consumed task.
class NativeSignerUnavailable:Exception()
// Custody records provenance and repeats scope checks before producing this
// private result. The bridge never classifies arbitrary exception strings.
class NativeWorkflowStepUnavailable internal constructor():Exception()
class NativeWorkflowCryptoUnavailable internal constructor():Exception()
data class NativeReview(
 val operationId:String,val origin:String,val chainId:String,val accountAddress:String,
 val title:String,val description:String,val phase:String="intent-bounded",val steps:List<NativeApprovalStep> = emptyList()
)
/** Display-only atomic integer strings; null is unknown, never zero. */
data class NativeApprovalAsset(val asset:String,val assetId:String?,val amountAtomic:String?,val amountRule:String,val recipient:String?,val direction:String){
 val text:String get()="$asset${assetId?.let{" [$it]"}?:""}: ${amountAtomic?:"unknown"} atomic ($amountRule); $direction; recipient: ${recipient?:if(direction=="fee")"network fee (no recipient output)" else "unknown / contract script"}."
}
data class NativeApprovalStep(val id:String,val kind:String,val description:String,val assets:List<NativeApprovalAsset>,val warnings:List<String>,val actualFeeAtomic:String?=null,
 val transactions:List<NativeApprovalTransaction> = emptyList(),val transactionsStatus:String="not-bound")
/** Verified plan metadata; templateHash is not a broadcast txid. */
data class NativeApprovalTransaction(val id:String,val role:String?,val dependsOn:List<String>,val templateHash:String?,val feeAtomic:String?,val assets:List<NativeApprovalAsset>,val assetsStatus:String,val warnings:List<String>,val outputs:List<NativeApprovalOutput> = emptyList(),val outputsStatus:String="not-available"){
 val text:String get()="Transaction $id [${role?:"unknown"}]; depends on: ${if(dependsOn.isEmpty())"none" else dependsOn.joinToString(", ")}; network fee: ${feeAtomic?:"unknown"} atomic.\nTemplate commitment (not txid): ${templateHash?:"unknown"}\n"+(if(outputsStatus!="not-available")"Output balances (include self/change/intermediate/pool outputs; not net user payment):\n"+outputs.joinToString("\n"){it.text}else if(assetsStatus=="available")assets.joinToString("\n"){it.text}else "Per-transaction assets are unavailable; see the step summary, not a per-transaction allocation.")
}
data class NativeApprovalOutput(val outputIndices:List<Int>,val kind:String,val assetIdentity:String?,val amountAtomic:String?,val recipient:String?,val nativeValueAtomic:String,val lockTime:Long?,val warnings:List<String>){
 val text:String get()="Output ${outputIndices.joinToString(",")}: $kind${assetIdentity?.let{" [$it]"}?:""}; amount ${amountAtomic?:"unknown"} atomic; destination ${recipient?:"unknown"}; native value $nativeValueAtomic atomic."+(lockTime?.let{" Lock: $it."}?:"")+(if(warnings.isEmpty())"" else " "+warnings.joinToString(", "))
}
// Pure package projection. No HTTP, metadata, witnesses, Vault, planning or receipt.
internal object NativeApprovalDisplay {
 fun warnings(request:Map<String,Any?>):List<String>{
  val type=(request["intent"] as? Map<*,*>)?.get("type") as? String?:""
  val out=mutableListOf<String>()
  if(type.endsWith(".burn")||type.endsWith("-burn"))out+="ASSET_DESTRUCTION_NO_WITHDRAWAL: Tokens are destroyed; no pool reserves are returned."
  if(type.endsWith(".lock")||type.endsWith("-lock"))out+="ASSET_LOCKED_UNTIL_CONDITIONS_MET: Spending is restricted until the contract conditions are met."
  if(type=="tbc-htlc-claim")out+="HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE: Signed claim bytes disclose the preimage to the requester, even before broadcast. The preimage is never shown here."
  return out.toList()
 }
 fun intent(r:Map<String,Any?>,owner:String):List<NativeApprovalAsset>{
  val i=r["intent"] as? Map<*,*>?:return emptyList();val type=i["type"] as? String?:return emptyList()
  val pool=i["poolContractId"] as? String;val id=(i["contractId"] as? String)?:pool?.let{"pool:$it"}
  val to=(i["to"] as? String)?:(i["receiver"] as? String)?:owner
  fun row(asset:String,value:Any?,rule:String="exact-intent",recipient:String?=null,direction:String="send")=
   NativeApprovalAsset(asset,if(asset=="TBC")null else id,value as? String,rule,if(recipient!=null&&recipient==pool)"pool:$recipient" else recipient?:to,direction)
  val result=when(type){
   "tbc.transfer"->listOf(row("TBC",i["amount"]))
   "tbc20.transfer","tbc20Stablecoin.transfer"->{
    val family=if(type=="tbc20.transfer")"FT" else "Stablecoin"
    ((i["receivers"] as? List<*>)?:listOf(mapOf("to" to to,"amount" to i["amount"]))).map{val r=it as Map<*,*>;row(family,r["amount"],"exact-intent",r["to"] as? String)}
   }
   "tbc721.transfer"->listOf(row("NFT","1"))
   "tbc721.batchTransfer"->((i["transfers"] as? List<*>)?:emptyList<Any>()).flatMap{value->
    val item=value as Map<*,*>
    listOf(row("NFT","1","exact-intent",item["to"] as? String).copy(assetId=item["contractId"] as? String))+
     ((item["payment"] as? Map<*,*>)?.let{listOf(row("TBC",it["amount"],"exact-intent",it["to"] as? String))}?:emptyList())
   }
   "tbc20-standard-create"->listOf(row("FT",i["initialSupply"],"exact-intent",to,"mint"))
   "tbc721-standard-create-collection"->listOf(row("NFT collection",i["supply"],"collection-capacity",to,"create"))
   "tbc721-standard-mint","tbc721-standard-batch-mint"->(if(type=="tbc721-standard-mint")listOf(i)else (i["items"] as? List<*>)?:emptyList<Any>()).map{val item=it as Map<*,*>;row("NFT","1","exact-intent",item["to"] as? String?:owner,"mint").copy(assetId=i["collectionId"] as? String)}
   "tbc.pool.ft.merge","amm.mergeToken"->listOf(row("FT",null,"selected-balance",pool,"pool-self"))
   "tbc20-lp-transfer","tbc20Lp.transfer","tbc20-lp-lock","tbc20Lp.lock"->listOf(row("LP",i["amount"],"exact-intent",if(type.endsWith("lock"))owner else to))
   "tbc20-lp-unlock","tbc20Lp.unlock","tbc20-lp-merge","tbc20Lp.merge","tbc.pool.ftlp.merge"->listOf(row("LP",null,"selected-balance",owner,"self"))
   "tbc.pool.ftlp.burn","tbc20Lp.burn"->listOf(row("LP",null,"selected-balance","burn (no recipient)","burn"))
   "tbc20.merge","tbc20Stablecoin.merge","tbc.maintenance.merge"->listOf(row(if(type=="tbc20.merge")"FT" else if(type=="tbc20Stablecoin.merge")"Stablecoin" else "TBC",null,"selected-balance",owner,"self"))
   "tbc-htlc-lock","tbc-timelock-lock"->listOf(row((i["assetStandard"] as? String)?:"TBC",i["amount"],"exact-intent",to,"lock"))
   "tbc-htlc-claim","tbc-htlc-refund","tbc-timelock-unlock"->listOf(row((i["assetStandard"] as? String)?:"TBC",null,"selected-balance",owner,"receive"))
   "tbc-amm-swap","amm.swap"->{val buying=i["direction"]=="tbc-to-ft";listOf(row(if(buying)"TBC" else "FT",i["amount"],"exact-intent",pool),row(if(buying)"FT" else "TBC",i["minimumOutput"],"minimum",to,"receive"))}
   "tbc.pool.swap.exactTbcForToken"->listOf(row("TBC",i["tbcAmount"],"exact-intent",pool),row("FT",i["minimumFtAmount"],"minimum",to,"receive"))
   "tbc.pool.swap.exactTokenForTbc"->listOf(row("FT",i["ftAmount"],"exact-intent",pool),row("TBC",i["minimumTbcAmount"],"minimum",to,"receive"))
   "tbc-amm-add-liquidity","amm.addLiquidity","tbc.pool.liquidity.add"->{
    val native=(i["budgetAsset"]?:"tbc")=="tbc"
    listOf(row(if(native)"TBC" else "FT",i["amount"]?:i["tbcAmount"],"budget",pool),row(if(native)"FT" else "TBC",i[if(native)"maximumFtAmount" else "maximumTbcAmount"],"maximum-or-unknown",pool),row("LP",i["minimumLpAmount"],"minimum",to,"receive"))
   }
   "tbc-amm-remove-liquidity","amm.removeLiquidity","tbc.pool.liquidity.remove"->listOf(row("LP",i["lpAmount"],"exact-intent",pool),row("TBC",i["minimumTbcAmount"],"minimum",to,"receive"),row("FT",i["minimumFtAmount"],"minimum",to,"receive"))
   else->emptyList() // Specialized descriptions remain; never infer a quantity.
  }
  val payment=(i["payment"] as? Map<*,*>)?.let{listOf(row("TBC",it["amount"],"exact-intent",it["to"] as? String))}?:emptyList()
  return java.util.Collections.unmodifiableList(result+payment)
 }
 private val poolTypes=setOf("tbc-amm-add-liquidity","amm.addLiquidity","tbc-amm-remove-liquidity","amm.removeLiquidity","tbc-amm-swap","amm.swap","tbc.pool.swap.exactTbcForToken","tbc.pool.swap.exactTokenForTbc","tbc.pool.liquidity.add","tbc.pool.liquidity.remove","tbc.pool.ft.merge","amm.mergeToken")
 fun bound(preview:Map<String,Any?>,request:Map<String,Any?>?=null):List<NativeApprovalAsset>{
  val intent=request?.get("intent") as? Map<*,*>;val pool=intent?.get("poolContractId") as? String
  val poolReference=if(intent?.get("type") in poolTypes&&pool?.matches(Regex("^[0-9a-f]{64}$"))==true)"pool:$pool" else null
  return java.util.Collections.unmodifiableList(((preview["assetFlows"] as? List<*>)?:emptyList<Any>()).map{
   val f=it as Map<*,*>;NativeApprovalAsset(f["kind"] as? String?:"unknown",f["contractId"] as? String,f["amount"] as? String,"bound-plan",(f["to"] as? String)?:if(f["direction"]=="send")poolReference else null,f["direction"] as? String?:"unknown")
  })
 }
 fun transactions(payload:Map<*,*>?,assets:List<NativeApprovalAsset>,warnings:List<String>):List<NativeApprovalTransaction>{
  val rows=payload?.get("transactions") as? List<*>?:return emptyList()
  return java.util.Collections.unmodifiableList(rows.map{value->val t=value as Map<*,*>
   val outputs=(t["outputReview"] as? List<*>)?.map{v->val o=v as Map<*,*>;NativeApprovalOutput(java.util.Collections.unmodifiableList((o["outputIndices"] as? List<*>)?.map{(it as Number).toInt()}?:emptyList()),o["kind"] as? String?:"unrecognized",o["assetIdentity"] as? String,o["amountAtomic"] as? String,o["recipient"] as? String,o["nativeValueAtomic"] as? String?:"unknown",(o["lockTime"] as? Number)?.toLong(),java.util.Collections.unmodifiableList((o["warnings"] as? List<*>)?.map{it as String}?:emptyList()))}
   NativeApprovalTransaction(t["id"] as? String?:"unknown",t["role"] as? String,java.util.Collections.unmodifiableList((t["dependsOn"] as? List<*>)?.map{it as String}?:emptyList()),t["templateHash"] as? String,t["fee"] as? String,if(rows.size==1)assets else emptyList(),if(rows.size==1)"available" else "step-summary-only",if(rows.size==1)warnings else if(outputs==null)listOf("PER_TRANSACTION_ASSET_DETAILS_UNAVAILABLE") else emptyList(),java.util.Collections.unmodifiableList(outputs?:emptyList()),if(outputs==null)"not-available" else if(outputs.any{it.kind=="unrecognized"})"partial" else "available")})
 }
 fun text(steps:List<NativeApprovalStep>)=steps.joinToString("\n\n"){s->"Step ${s.id} [${s.kind}]\n"+s.assets.joinToString("\n"){it.text}+(s.actualFeeAtomic?.let{"\nActual network fee: $it native atomic."}?:"")+(if(s.warnings.isEmpty())"" else "\n"+s.warnings.joinToString("\n"))+"\nChain transaction details: ${s.transactionsStatus}"+(if(s.transactions.isEmpty())"" else "\n"+s.transactions.joinToString("\n"){it.text})}
}
fun NativeWalletProtocol.approvalReview(review:NativeReview):NativeReview =
 if(this==NativeWalletProtocol.STANDARD)review else review.copy(
  operationId=PermissionJson.id(namespace,"review",review.operationId),title="Legacy · ${review.title}")
interface NativeApprovalPresenter {
 // Must show the package projection in trusted wallet UI. No default approval.
 // Return an idempotent dismissal handle; callbacks run on the owner thread.
 fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit
 // Informational update of this operation, never a second decision or prompt.
 fun update(review:NativeReview) {}
}
interface NativeDigestSigner {
 // The wallet keeps its keys. Invoke requireCurrent immediately before actual
 // key use on this executor, including after password/biometric/asynchronous UI.
 // Callback once on the same executor; do not retry a failed/consumed task.
 fun sign(account:NativeAccount,digest:ByteArray,encoding:String,
          requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit)
}
interface NativeReviewedComputer {
 // Pinned keyless Rust off UI; reply once on custody executor. No Vault,
 // HTTP, argument logging, dynamic library path or page registration.
 fun call(method:String,input:String,complete:(Result<String>)->Unit)
}
data class NativeWalletSnapshot(val account:NativeAccount,val revision:Int,
 val accountRevision:Long,val unlocked:Boolean,val permissions:List<Map<String,Any?>>,val connectedAccounts:List<NativeAccount>,val optionalMethods:List<String>)
data class NativeCustodyNetworkAuthority(val epoch:String,val unlocked:Boolean,val switchAccountIds:List<String>,val visibleAddresses:List<String>)

/** Shared native permission + consent + task owner, adapted from sealed P5.
 * Only explicitly enabled message/transaction profiles are implemented here.
 * Rust planning/validation remains in the shared worker. This class independently
 * checks consent/binding/account/task identity before asking the wallet signer.
 * No account selection, test key loading, automatic approval, network or journal.
 */
class NativeCustody(
 private val accounts:NativeAccountSource,private val chain:String,
 backend:NativePermissionBackend,private val approval:NativeApprovalPresenter,
 private val signer:NativeDigestSigner,private val reviewedComputer:NativeReviewedComputer?=null,private val crypto:NativeBie1Executor?=null,
 private val sendSourceIdentity:String?=null,
 val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD,
 private val nativeCurrent:(String,Map<String,String>)->Boolean
) {
 init{require(sendSourceIdentity==null||Regex("[0-9a-f]{64}").matches(sendSourceIdentity)){"NATIVE_BROADCAST_SOURCE"}}
 private val executor=Thread.currentThread()
 val supportsReviewed:Boolean get()=reviewedComputer!=null
 val supportsCrypto:Boolean get()=crypto!=null
 private var broadcastRegistered=false
 // Only the native Host installing its owned Router, before navigation.
 // A source configuration alone does not advertise a working sender.
 fun registerBroadcast(){onExecutor();need(sendSourceIdentity!=null&&!broadcastRegistered&&sessions.isEmpty(),"NATIVE_BROADCAST_CONFIGURATION");broadcastRegistered=true}
 private class Session(val owner:String,val scope:Map<String,String>){
  var revision=0
  var activeAccountIds:Set<String>?=null
  val used=mutableSetOf<String>()
  val cancelled=mutableSetOf<String>()
  val operations=mutableMapOf<String,Operation>()
  val pending=mutableMapOf<String,()->Unit>()
  val results=mutableMapOf<String,DeliveryPermit>()
  var maintenance:Maintenance?=null
  var mintJob:MintJob?=null
 }
 private class Operation(val session:Session,val id:String,val method:String,
  val revision:Int,val accountRevision:Long,val account:NativeAccount,val epoch:String){
  var request:Map<String,Any?>?=null
  var approved=false
  var receipt:Map<String,Any?>?=null
  val tasks=mutableMapOf<String,Map<String,Any?>>()
  val consumed=mutableSetOf<String>()
  val completed=mutableSetOf<String>()
  var expectedTasks=0;var stage=0;var transactionCount=1;var exactTaskCount=true
  var planHash:String?=null;var stageSession:String?=null
  var transactionIds=setOf<String>()
  var controller:NativeAccount?=null;var roleRequestHash:String?=null
  var typedEnvelope:Map<String,Any?>?=null
  var preparedProposal:Map<String,Any?>?=null;var requestHash:String?=null
  var workflow:Workflow?=null;var consentFeeCap:String?=null
  var workflowParent:Operation?=null;var workflowEnvelope:Map<String,Any?>?=null
  val signedResults=mutableMapOf<String,Map<String,Any?>>()
  var signerUnavailable=false
  var displayReview:NativeReview?=null;var displayAssets:List<NativeApprovalAsset>?=null;var displayWarnings=emptyList<String>();var displayFee:String?=null;var displayDescription=""
  var displayTransactions=emptyList<NativeApprovalTransaction>();var displayTransactionsStatus="not-applicable"
  var cryptoResultHash:String?=null
  var cryptoUnavailable=false
  // Allocated for send-only commitments, never for the sign-only hot path.
  var sendPlan:Map<String,Any?>?=null;var sendMaterial:Map<String,Any?>?=null
  var sendResultHash:String?=null
  var maintenance:Maintenance?=null;var maintenanceStep:Map<String,Any?>?=null;var maintenanceRequestHash:String?=null
  var maintenanceRecoveryId:String?=null
  var maintenanceInputs=emptySet<String>();var maintenanceBoundInputs=emptySet<String>();var maintenanceFee:java.math.BigInteger?=null
  var mintJob:MintJob?=null;var mintOffset=0;var mintFees=emptyList<java.math.BigInteger>();val mintRecovery=mutableMapOf<String,String>()
  var mintOutcomes:List<Map<String,String>>?=null
  val broadcastClosers=mutableMapOf<String,()->Unit>()
  val broadcastStates=mutableMapOf<String,()->List<Map<String,String>>>()
  var reviewedConsent:Map<String,Any?>?=null;var reviewedBound:NativeReviewed.Bound?=null;var reviewedStage:Map<String,Any?>?=null
  var reviewedTasks=emptyList<Map<String,Any?>>();var reviewedParents=emptyList<String>();val reviewedSignatures=mutableMapOf<String,String>()
  val reviewedDetached=mutableMapOf<Int,Any?>()
 }
 private class Workflow(val request:Map<String,Any?>,val requestHash:String,val steps:List<Map<String,Any?>>,val requests:List<Map<String,Any?>>,
  val children:List<Operation>,val expiresAt:Instant){var consentPlanHash:String?=null;var consentFeeCap:String?=null;var bindingStarted=false;var bound:NativeWorkflow.Binding?=null
  var nextIndex=0;var activeIndex:Int?=null;val completedResults=mutableMapOf<String,Map<String,Any?>>()
  val unavailableResults=mutableMapOf<String,Map<String,Any?>>()}
 // Native-owned ephemeral consent. Children retain the ordinary executor and
 // binding/signing/dispatch checks; no approval flag comes from the page.
 private class Maintenance(val session:Session,val id:String,val account:NativeAccount,val accountRevision:Long,val epoch:String,
  val scope:Map<String,Any?>,val scopeHash:String,val expiresAt:Instant,val maxFee:java.math.BigInteger,val maxTransactions:Int,val inputLimit:Int){
  val revision=session.revision;val approvalId=UUID.randomUUID().toString()
  var approved=false;var stopped=false;var nextIndex=1;var spent=java.math.BigInteger.ZERO;var activeChild:String?=null
  val accepted=mutableSetOf<String>()
  val consumedInputs=mutableSetOf<String>()
  val childIds=mutableSetOf<String>()
  val completedRows=mutableListOf<Map<String,Any?>>()
  var failedStep:Map<String,Any?>?=null;var failureMayHaveSubmitted=false;var failureRecoveryId:String?=null
 }
 private class MintJob(val session:Session,val id:String,val account:NativeAccount,val accountRevision:Long,val epoch:String,
  val scope:Map<String,Any?>,val scopeHash:String,val expiresAt:Instant,val maxFee:java.math.BigInteger){
  val revision=session.revision;var approved=false;var stopped=false;var activeChild:String?=null
  var offset=0;var spent=java.math.BigInteger.ZERO;var planBytes=0;val batches=mutableListOf<Map<String,Any?>>()
 }
 private data class DeliveryPermit(val revision:Int,val accountRevision:Long,
  val account:NativeAccount,val epoch:String,val capability:String,val controller:NativeAccount?,val workflowMethod:String?=null,val workflowResultHash:String?=null,val cryptoMethod:String?=null,val cryptoResultHash:String?=null,val sendMethod:String?=null,val sendResultHash:String?=null,val maintenanceResultHash:String?=null,val maintenanceTarget:Int?=null)
 private val sessions=mutableMapOf<String,Session>()
 private val permissions=NativePermissions(accounts,chain,backend,walletProtocol){origin->
  sessions.values.filter{origin==null||it.scope["origin"]==origin}.toList().forEach{fence(it)}
 }
 private fun onExecutor(){check(Thread.currentThread()===executor){"NATIVE_EXECUTOR"}}
 private fun need(ok:Boolean,code:String="NATIVE_DENIED"){if(!ok)throw NativeCustodyFailure(code)}
 private fun session(owner:String,scope:Map<String,String>):Session{
  onExecutor();val s=sessions[owner]?:throw NativeCustodyFailure("NATIVE_SCOPE_CHANGED")
  need(s.scope==scope&&nativeCurrent(owner,s.scope),"NATIVE_SCOPE_CHANGED")
  need(accounts.current.chainId==chain,"NATIVE_CHAIN_CHANGED");return s
 }
 private fun fence(s:Session){
  onExecutor();s.revision++;s.results.clear()
  s.maintenance?.stopped=true;s.maintenance=null
  s.mintJob?.stopped=true;s.mintJob=null
  val operations=s.operations.values.toList();s.operations.clear();operations.forEach{closeBroadcasts(it)}
  val cancel=s.pending.values.toList();s.pending.clear();cancel.forEach{runCatching{it()}}
 }
 // Call only with the native WebView adapter's verified committed document.
 // Navigating one page must not lock the account or invalidate another page.
 fun navigation(owner:String,scope:Map<String,String>){
  onExecutor();need(scope.keys==setOf("webViewInstanceId","sessionId","navigationId","committedUrl","origin","topOrigin","frame","createdAt"))
  need(scope["frame"]=="top"&&scope["origin"]==scope["topOrigin"]&&nativeCurrent(owner,scope),"NATIVE_SCOPE_CHANGED")
  invalidate(owner);sessions[owner]=Session(owner,scope.toMap())
 }
 fun invalidate(owner:String){onExecutor();sessions.remove(owner)?.let{fence(it)}}
 // Preserve replay history and grants; revoke only this document's permits.
 fun fenceDocument(owner:String){onExecutor();sessions[owner]?.let{fence(it)}}
 // Native network commit only; never accept this selection as a page command.
 fun activateAccounts(owner:String,scope:Map<String,String>,accountIds:List<String>){
  val s=session(owner,scope);val selected=permissions.selectedAccounts()
  need(accountIds.isNotEmpty()&&accountIds.toSet().size==accountIds.size&&accountIds.all{id->selected.any{it.accountId==id}},"NATIVE_ACCOUNT_SELECTION")
  selected.filter{it.accountId in accountIds}.forEach{permissions.require(scope.getValue("origin"),"tbc_switchChain",it)}
  fence(s);s.activeAccountIds=accountIds.toSet()
 }
 private fun selectedAccount(s:Session):NativeAccount{
  val ids=s.activeAccountIds?:return accounts.current;if(accounts.current.accountId in ids)return accounts.current
  // This private fallback cannot sign: requireActive + permissions still apply.
  return permissions.selectedAccounts().filter{it.accountId in ids}.sortedBy{it.accountId}.firstOrNull()?:accounts.current
 }
 private fun requireActive(s:Session,account:NativeAccount){need(s.activeAccountIds?.contains(account.accountId)!=false,"NATIVE_ACCOUNT_SELECTION")}
 private fun permissionAccount(account:NativeAccount)=if(account==accounts.current)null else account
 fun validateNetworkLane(chainId:String,sourceIdentity:String){
  onExecutor();need(chainId==chain&&accounts.current.chainId==chain&&(sendSourceIdentity==null||sendSourceIdentity==sourceIdentity),"NATIVE_CHAIN_CHANGED")
 }
 fun networkAuthority(origin:String):NativeCustodyNetworkAuthority{
  onExecutor();need(accounts.current.chainId==chain,"NATIVE_CHAIN_CHANGED")
  val visible=permissions.selectedAccounts().filter{accounts.unlocked&&permissions.permits(origin,"tbc_accounts",it)}
  val switchable=visible.filter{permissions.permits(origin,"tbc_switchChain",it)}
  // Document revision is deliberately excluded: switching fences that revision.
  return NativeCustodyNetworkAuthority(permissions.epoch(origin),accounts.unlocked,switchable.map{it.accountId},visible.map{it.address})
 }
 fun networkPermissions(origin:String):List<Map<String,Any?>>{
  onExecutor();return permissions.selectedAccounts().flatMap{permissions.records(origin,it)}.associateBy{it["id"] as String}.toSortedMap().values.toList()
 }
 // Wallet lock/unlock/selection hooks. Revisions also get checked directly at
 // use, so a late callback cannot inherit an old account's approval.
 fun accountChanged(){onExecutor();sessions.values.toList().forEach{fence(it)}}
 fun snapshot(owner:String,scope:Map<String,String>):NativeWalletSnapshot{
  val s=session(owner,scope);val account=selectedAccount(s)
  val connected=if(accounts.unlocked)permissions.selectedAccounts().filter{s.activeAccountIds?.contains(it.accountId)!=false&&permissions.permits(s.scope.getValue("origin"),"tbc_accounts",it)}else emptyList()
  return NativeWalletSnapshot(account,s.revision,accounts.revision,accounts.unlocked,permissions.records(s.scope.getValue("origin"),permissionAccount(account)),
   if(s.activeAccountIds==null)connected else connected.sortedBy{it.accountId},(if(supportsCrypto)NativeCrypto.methods.sorted()else emptyList())+(if(broadcastRegistered)NativePrepared.sendMethods else emptyList()))
 }
 private fun reserve(s:Session,id:String){
  // Separate active work from compact, non-evictable document replay IDs.
  need(Regex("[A-Za-z0-9._:-]{1,256}").matches(id)&&s.used.size<100000&&s.operations.size+s.pending.size<128,"NATIVE_OPERATION_LIMIT")
  need(id !in s.cancelled&&s.used.add(id),"NATIVE_REPLAY")
 }
 fun cancel(owner:String,scope:Map<String,String>,id:String){
  val s=session(owner,scope);need(s.cancelled.size<100000||id in s.cancelled,"NATIVE_OPERATION_LIMIT")
  s.maintenance?.let{if(it.id==id||it.activeChild==id)stopMaintenance(it)}
  s.cancelled.add(id);s.results.remove(id);s.operations.remove(id)?.let{closeBroadcasts(it)};s.pending.remove(id)?.invoke()
 }
 private fun current(s:Session,revision:Int,account:NativeAccount,accountRevision:Long,id:String,grant:Boolean=false){
  need(session(s.owner,s.scope)===s&&s.revision==revision&&id !in s.cancelled,"NATIVE_REVISION_CHANGED")
  need(accounts.unlocked&&accounts.revision==accountRevision&&(if(grant)accounts.current else selectedAccount(s))==account,"NATIVE_REVISION_CHANGED")
  if(!grant)requireActive(s,account)
 }
 private fun current(o:Operation){
  o.workflowParent?.let{parent->
   current(parent);val w=parent.workflow?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INACTIVE");val i=w.activeIndex?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INACTIVE")
   need(w.children[i]===o&&parent.receipt!=null&&canonical(parent.receipt)==canonical(o.receipt),"NATIVE_WORKFLOW_INACTIVE");return
  }
  current(o.session,o.revision,o.account,o.accountRevision,o.id)
  need(o.session.operations[o.id]===o,"NATIVE_OPERATION_GONE")
  permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(o.method),permissionAccount(o.account))
  if(NativePrepared.sends(o.method)){need(sendSourceIdentity!=null,"NATIVE_BROADCAST_UNAVAILABLE");permissions.require(o.session.scope.getValue("origin"),"tbc_sendTransaction",permissionAccount(o.account))}
  o.controller?.let{requireActive(o.session,it);permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(o.method),it)}
  o.workflow?.let{workflow->
   need(Instant.now().isBefore(workflow.expiresAt),"NATIVE_EXPIRED")
   for(child in workflow.children){
    permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(child.method),permissionAccount(child.account))
    child.controller?.let{requireActive(o.session,it);permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(child.method),it)}
   }
  }
  need(permissions.epoch(o.session.scope.getValue("origin"))==o.epoch,"NATIVE_REVISION_CHANGED")
  o.maintenance?.let{currentMaintenance(it);need(it.approved&&it.activeChild==o.id,"NATIVE_MERGE_INACTIVE")}
  o.mintJob?.let{currentMintJob(it);need(it.approved&&it.activeChild==o.id,"NATIVE_NFT_JOB_INACTIVE")}
 }
 private fun currentMintJob(m:MintJob,active:Boolean=true){
  current(m.session,m.revision,m.account,m.accountRevision,m.id)
  need(m.session.mintJob===m&&broadcastRegistered&&sendSourceIdentity!=null&&permissions.epoch(m.session.scope.getValue("origin"))==m.epoch,"NATIVE_NFT_JOB_AUTHORITY")
  for(method in listOf("tbc_accounts","tbc_sendTransaction"))permissions.require(m.session.scope.getValue("origin"),method,permissionAccount(m.account))
  if(active)need(!m.stopped&&Instant.now().isBefore(m.expiresAt),"NATIVE_NFT_JOB_EXPIRED")
 }
 fun beginMintJob(owner:String,scope:Map<String,String>,id:String,expectedRevision:Int,expectedAccount:NativeAccount,consent:Map<String,Any?>,complete:(Result<Map<String,Any?>>)->Unit){
  val s=session(owner,scope);val account=selectedAccount(s);val r=immutable(consent)
  need(s.mintJob==null&&s.revision==expectedRevision&&account==expectedAccount&&walletProtocol==NativeWalletProtocol.STANDARD,"NATIVE_NFT_JOB_ACTIVE")
  current(s,s.revision,account,accounts.revision,id)
  need(r.keys==setOf("operationKind","authority","collectionId","items","limits")&&r["operationKind"]=="tbc721.batchMint"&&canonical(r).toByteArray(Charsets.UTF_8).size<=8*1024*1024,"NATIVE_NFT_JOB_SCOPE")
  val authority=mapOf("chainId" to chain,"accountId" to account.accountId,"address" to account.address,"origin" to s.scope.getValue("origin"),"sessionId" to s.scope.getValue("sessionId"))
  need(canonical(r["authority"])==canonical(authority),"NATIVE_NFT_JOB_SCOPE");digest(r["collectionId"] as String)
  val items=(r["items"] as? List<*>)?.map{map(it)}?:throw NativeCustodyFailure("NATIVE_NFT_JOB_ITEMS")
  need(items.size in 1..2000,"NATIVE_NFT_JOB_ITEMS");val seen=mutableSetOf<Int>()
  val steps=items.mapIndexed{index,item->
   need(seen.add(integer(item["slot"]))&&item["to"] is String,"NATIVE_NFT_JOB_ITEMS")
   val intent=mapOf("version" to "1.0","type" to "tbc721-standard-batch-mint","collectionId" to r["collectionId"],"items" to listOf(item))
   NativeApprovalStep((index+1).toString(),"NFT mint",mintDescription(intent,account.address),NativeApprovalDisplay.intent(mapOf("intent" to intent),account.address),emptyList())
  }
  val limits=map(r["limits"]);val fee=amount(limits["maxTotalFee"]);val expiry=Instant.parse(limits["expiresAt"] as String)
  val per=integer(limits["maxItemsPerBatch"]);val bytes=integer(limits["maxPlanBytes"]);val total=integer(limits["maxTotalPlanBytes"])
  need(limits.keys==setOf("maxTotalFee","expiresAt","maxItemsPerBatch","maxPlanBytes","maxTotalPlanBytes")&&per in 1..100&&bytes in 1..4*1024*1024&&total>=bytes&&total<=32*1024*1024&&fee<=java.math.BigInteger("2100000000000000")&&expiry.isAfter(Instant.now()),"NATIVE_NFT_JOB_LIMITS")
  reserve(s,id);val m=MintJob(s,id,account,accounts.revision,permissions.epoch(s.scope.getValue("origin")),r,hash(r),expiry,fee);s.mintJob=m
  try{currentMintJob(m)}catch(e:Exception){s.mintJob=null;throw e}
  val description="Mint ${items.size} NFTs in ordered sub-batches. Total network fee limit: $fee atomic, shared by the entire job. Collection: ${r["collectionId"]}. Expiry: ${limits["expiresAt"]}. A partial result is not permission to resend successful transactions.\n"+steps.joinToString("\n"){it.description}
  decision(s,id,NativeReview(id,s.scope.getValue("origin"),chain,account.address,"Approve NFT mint job",description,steps=steps),{yes->
   currentMintJob(m);if(!yes){m.stopped=true;s.mintJob=null;throw NativeCustodyFailure("USER_REJECTED")};m.approved=true
   mapOf("status" to "approved","scopeHash" to m.scopeHash)
  },complete)
 }
 fun beginMintBatch(owner:String,scope:Map<String,String>,parent:String,id:String,offset:Int,request:Map<String,Any?>):NativeWalletSnapshot{
  val s=session(owner,scope);val m=s.mintJob?:throw NativeCustodyFailure("NATIVE_NFT_JOB_INACTIVE");need(m.id==parent,"NATIVE_NFT_JOB_INACTIVE");currentMintJob(m)
  val r=immutable(request);val intent=map(r["intent"]);val c=map(r["constraints"]);val limits=map(m.scope["limits"]);val items=m.scope["items"] as List<*>
  val child=intent["items"] as? List<*>?:throw NativeCustodyFailure("NATIVE_NFT_JOB_ITEMS")
  need(m.approved&&m.activeChild==null&&offset==m.offset&&child.isNotEmpty()&&child.size<=integer(limits["maxItemsPerBatch"])&&offset+child.size<=items.size,"NATIVE_NFT_JOB_SLICE")
  val expected=mapOf("version" to "1.0","type" to "tbc721-standard-batch-mint","collectionId" to m.scope["collectionId"],"items" to items.subList(offset,offset+child.size))
  need(r.keys==setOf("version","chainId","from","intent","constraints")&&r["version"]=="1.0"&&r["chainId"]==chain&&r["from"]==m.account.address&&canonical(intent)==canonical(expected)&&c.keys==setOf("maxFee","expiresAt")&&amount(c["maxFee"])==m.maxFee-m.spent&&!Instant.parse(c["expiresAt"] as String).isAfter(m.expiresAt),"NATIVE_NFT_JOB_REQUEST")
  val snapshot=begin(owner,scope,id,"tbc_sendTransaction",m.revision,m.account)
  val o=s.operations.getValue(id);o.mintJob=m;o.mintOffset=offset;o.maintenanceRequestHash=hash(r);m.activeChild=id;return snapshot
 }
 private fun bindMintJob(o:Operation,plan:Map<String,Any?>,payload:Map<String,Any?>,review:Map<String,Any?>,expiry:Instant){
  val m=o.mintJob?:return;currentMintJob(m)
  val limits=map(m.scope["limits"]);val items=map(o.request!!["intent"])["items"] as List<*>;val txs=(payload["transactions"] as? List<*>)?.map{map(it)}?:emptyList()
  val bytes=canonical(plan).toByteArray(Charsets.UTF_8).size;val fee=amount(review["totalFee"])
  need(!expiry.isAfter(m.expiresAt)&&txs.size==items.size&&fee<=m.maxFee-m.spent&&bytes<=integer(limits["maxPlanBytes"])&&m.planBytes+bytes<=integer(limits["maxTotalPlanBytes"]),"NATIVE_NFT_JOB_BUDGET")
  val fees=txs.map{amount(it["fee"])};need(fees.fold(java.math.BigInteger.ZERO){a,b->a+b}==fee,"NATIVE_NFT_JOB_FEE");o.mintFees=fees;m.planBytes+=bytes
 }
 private fun captureMintBatch(o:Operation){
  val m=o.mintJob?:return;if(m.activeChild!=o.id)return
  val count=((o.request?.get("intent") as? Map<*,*>)?.get("items") as? List<*>)?.size?:0
  val txs=((o.sendMaterial?.get("bundle") as? Map<*,*>)?.get("transactions") as? List<*>)?.map{map(it)}?:emptyList()
  var accepted=0;var uncertain=false;var interrupted=false
  val rows=txs.mapIndexed{i,t->
   val key="single:$i";val row=o.mintOutcomes?.getOrNull(i)?:runCatching{o.broadcastStates[key]?.invoke()?.firstOrNull()}.getOrNull()
   var status=if(key in o.broadcastStates)"uncertain" else "not-submitted"
   if(row?.get("txid")==t["txid"]&&row?.get("status") in listOf("accepted","known","rejected"))status=row!!.getValue("status")
   if(status in listOf("accepted","known")&&interrupted)status="uncertain"
   if(status in listOf("accepted","known")&&i<o.mintFees.size&&o.mintFees[i]<=m.maxFee-m.spent){accepted++;m.spent+=o.mintFees[i]}else interrupted=true
   uncertain=uncertain||status=="uncertain"
   mutableMapOf<String,Any?>("txid" to t["txid"],"fee" to (o.mintFees.getOrNull(i)?:java.math.BigInteger.ZERO).toString(),"status" to status).also{r->o.mintRecovery[key]?.let{r["recoveryId"]=it}}
  }
  val complete=o.sendResultHash!=null&&accepted==count&&count>0
  m.batches.add(mapOf("offset" to o.mintOffset,"count" to count,"planHash" to o.planHash,"status" to if(complete)"complete" else if(uncertain)"uncertain" else if(accepted>0)"partial" else "failed","transactions" to rows))
  m.offset+=accepted;m.activeChild=null;if(!complete)m.stopped=true
 }
 fun mintBatchResult(owner:String,scope:Map<String,String>,id:String):Map<String,Any?>{
  val s=session(owner,scope);val m=s.mintJob?:throw NativeCustodyFailure("NATIVE_NFT_JOB_RESULT");need(m.id==id&&m.activeChild==null&&m.batches.isNotEmpty(),"NATIVE_NFT_JOB_RESULT");currentMintJob(m,false);return m.batches.last()
 }
 fun finishMintJob(owner:String,scope:Map<String,String>,id:String,reason:String):Map<String,Any?>{
  val s=session(owner,scope);val m=s.mintJob?:throw NativeCustodyFailure("NATIVE_NFT_JOB_RESULT");need(m.id==id&&m.approved&&m.activeChild==null,"NATIVE_NFT_JOB_RESULT");currentMintJob(m,false)
  need(reason in listOf("complete","preparation-failed","execution-failed","expired","submission-uncertain"),"NATIVE_NFT_JOB_REASON")
  val requested=(m.scope["items"] as List<*>).size;val uncertain=m.batches.any{it["status"]=="uncertain"};val complete=m.offset==requested&&!m.stopped
  val result=mapOf("status" to if(complete)"complete" else if(uncertain)"uncertain" else if(m.offset>0)"partial" else "stopped","reason" to if(complete)"complete" else if(uncertain)"submission-uncertain" else if(reason=="complete")"execution-failed" else reason,"scopeHash" to m.scopeHash,"requested" to requested,"minted" to m.offset,"confirmedSubmissionFee" to m.spent.toString(),"batches" to m.batches.toList())
  m.stopped=true;s.mintJob=null;return result
 }
 fun closeMintJob(owner:String,scope:Map<String,String>,id:String){
  val s=session(owner,scope);val m=s.mintJob?:return;if(m.id!=id)return
  m.activeChild?.let{close(owner,scope,it)};m.stopped=true;s.mintJob=null;s.pending.remove(id)?.invoke()
 }
 private fun currentMaintenance(m:Maintenance){
  maintenanceAuthority(m)
  need(!m.stopped&&Instant.now().isBefore(m.expiresAt),"NATIVE_MERGE_INACTIVE")
 }
 private fun maintenanceAuthority(m:Maintenance){
  current(m.session,m.revision,m.account,m.accountRevision,m.id)
  need(m.session.maintenance===m,"NATIVE_MERGE_INACTIVE")
  need(broadcastRegistered&&sendSourceIdentity!=null&&permissions.epoch(m.session.scope.getValue("origin"))==m.epoch,"NATIVE_REVISION_CHANGED")
  for(method in listOf("tbc_accounts","tbc_sendTransaction"))permissions.require(m.session.scope.getValue("origin"),method,permissionAccount(m.account))
 }
 private fun stopMaintenance(m:Maintenance){
  m.stopped=true;if(m.session.maintenance===m)m.session.maintenance=null
  m.childIds.forEach{m.session.results.remove(it)}
  m.activeChild?.let{child->m.session.operations.remove(child)?.let{closeBroadcasts(it)};m.session.pending.remove(child)?.invoke()}
  m.session.pending.remove(m.id)?.invoke()
 }
 fun beginMaintenance(owner:String,scope:Map<String,String>,id:String,expectedRevision:Int,expectedAccount:NativeAccount,consent:Map<String,Any?>,noopResult:Map<String,Any?>?=null,complete:(Result<Map<String,Any?>>)->Unit){
  val s=session(owner,scope);val account=selectedAccount(s);val r=immutable(consent)
  need(s.maintenance==null&&s.revision==expectedRevision&&account==expectedAccount,"NATIVE_MERGE_ACTIVE")
  current(s,s.revision,account,accounts.revision,id);need(broadcastRegistered&&sendSourceIdentity!=null,"NATIVE_BROADCAST_UNAVAILABLE")
  for(method in listOf("tbc_accounts","tbc_sendTransaction"))permissions.require(s.scope.getValue("origin"),method,permissionAccount(account))
  need(r.keys==setOf("version","operationKind","authority","asset","impact","limits","initialStateHash","initialUtxoCount")&&r["version"]=="1.0"&&r["operationKind"]=="multi-round-merge","NATIVE_MERGE_SCOPE")
  val authority=mapOf("chainId" to chain,"accountId" to account.accountId,"origin" to s.scope["origin"],"sessionId" to s.scope["sessionId"])
  need(canonical(r["authority"])==canonical(authority),"NATIVE_MERGE_SCOPE")
  val asset=map(r["asset"]);val kind=asset["kind"] as String;val pool=kind in setOf("pool-ft","ftlp")
  need(kind in setOf("tbc","ft","stablecoin","pool-ft","ftlp")&&asset.keys==(if(kind=="tbc")setOf("kind")else if(pool)setOf("kind","poolContractId")else setOf("kind","contractId")),"NATIVE_MERGE_ASSET")
  if(kind!="tbc")digest(asset[if(pool)"poolContractId" else "contractId"] as String)
  val impact=map(r["impact"]);val limit=if(kind=="tbc")100 else if(kind=="pool-ft")4 else 5;val custody=if(kind=="pool-ft")"pool-contract" else "active-account"
  val expected=mutableMapOf<String,Any?>("custody" to custody,"resultOwner" to custody,"maxAssetInputsPerTransaction" to limit)
  if(pool){val p=map(impact["poolIdentity"]);need(p.keys==setOf("poolContractId","ftContractId","currentPoolTxid")&&p["poolContractId"]==asset["poolContractId"],"NATIVE_MERGE_POOL");digest(p["ftContractId"] as String);digest(p["currentPoolTxid"] as String);expected["poolIdentity"]=p}
  need(canonical(impact)==canonical(expected),"NATIVE_MERGE_IMPACT")
  val limits=map(r["limits"]);val count=canonical(r["initialUtxoCount"]).toLongOrNull()?:throw NativeCustodyFailure("NATIVE_MERGE_LIMITS")
  val target=integer(limits["targetUtxoCount"]);val maximum=integer(limits["maxTransactions"]);val fee=amount(limits["maxTotalFee"]);val expiry=Instant.parse(limits["expiresAt"] as String)
  need(limits.keys==setOf("targetUtxoCount","maxTransactions","maxTotalFee","expiresAt","maxIndexRefreshes","indexRefreshDelayMs")&&target in 1..1000000&&count>=0&&(if(noopResult==null)count>target else count<=target)&&count<=9007199254740991L&&maximum in 1..64&&fee<=java.math.BigInteger("2100000000000000")&&expiry.isAfter(Instant.now()),"NATIVE_MERGE_LIMITS")
  need(integer(limits["maxIndexRefreshes"]) in 0..32&&integer(limits["indexRefreshDelayMs"]) in 0..60000,"NATIVE_MERGE_LIMITS");digest(r["initialStateHash"] as String)
  reserve(s,id);val m=Maintenance(s,id,account,accounts.revision,permissions.epoch(s.scope.getValue("origin")),r,hash(r),expiry,fee,maximum,limit);s.maintenance=m
  if(noopResult!=null){
   try{
    val expected=mapOf("version" to "1.0","status" to "complete","reason" to "already-below-target","scopeHash" to m.scopeHash,"initialUtxoCount" to count,"finalUtxoCount" to count,"totalFee" to "0","steps" to emptyList<Any>())
    need(canonical(noopResult)==canonical(expected),"NATIVE_MERGE_RESULT")
    s.results[id]=DeliveryPermit(m.revision,m.accountRevision,m.account,m.epoch,"tbc_accounts",null,maintenanceResultHash=hash(expected),maintenanceTarget=target)
    complete(Result.success(mapOf("status" to "not-required")))
   }finally{stopMaintenance(m)}
   return
  }
  val assetId=asset[if(pool)"poolContractId" else "contractId"] as? String?:"TBC"
  val description="Merge $kind inputs: $assetId. Result owner: $custody (${if(kind=="pool-ft")assetId else account.address}).\nObserved inputs: $count; target: $target; at most $maximum transactions and $fee native atomic total fees.\nExpires: ${limits["expiresAt"]}. Each transaction remains validated and signed separately. Unknown submissions stop this run; no automatic retry."
  decision(s,id,NativeReview(id,s.scope.getValue("origin"),chain,account.address,"Approve bounded maintenance",description),{yes->
   currentMaintenance(m);if(!yes){m.stopped=true;s.maintenance=null;throw NativeCustodyFailure("USER_REJECTED")};m.approved=true
   mapOf("status" to "approved","scopeHash" to m.scopeHash,"approvalId" to m.approvalId,"approvedAt" to Instant.ofEpochMilli(System.currentTimeMillis()).toString(),"expiresAt" to limits["expiresAt"])
  },complete)
 }
 fun beginMaintenanceStep(owner:String,scope:Map<String,String>,parent:String,id:String,step:Map<String,Any?>,request:Map<String,Any?>,selectedInputs:List<String>):NativeWalletSnapshot{
  val s=session(owner,scope);val m=s.maintenance?:throw NativeCustodyFailure("NATIVE_MERGE_INACTIVE");need(m.id==parent,"NATIVE_MERGE_INACTIVE");currentMaintenance(m)
  need(m.approved&&m.activeChild==null&&m.nextIndex<=m.maxTransactions,"NATIVE_MERGE_STEP")
  val r=immutable(request);val t=immutable(step);val asset=map(m.scope["asset"]);val kind=asset["kind"] as String;val remaining=m.maxFee-m.spent
  val identity=hash(mapOf("domain" to "tbc-kit/multi-round-step/1","scopeHash" to m.scopeHash,"approvalId" to m.approvalId,"stepIndex" to m.nextIndex))
  val intent=mutableMapOf<String,Any?>("version" to "1.0","type" to mapOf("tbc" to "tbc.maintenance.merge","ft" to "tbc20.merge","stablecoin" to "tbc20Stablecoin.merge","pool-ft" to "amm.mergeToken","ftlp" to "tbc20Lp.merge").getValue(kind))
  for(k in listOf("contractId","poolContractId"))if(k in asset)intent[k]=asset[k]
  val constraints=map(r["constraints"]);val expiry=Instant.parse(constraints["expiresAt"] as String)
  need(r.keys==setOf("version","chainId","from","clientRequestId","intent","constraints")&&r["version"]=="1.0"&&r["chainId"]==chain&&r["from"]==m.account.address&&r["clientRequestId"]=="kit-multi-round-$identity"&&canonical(r["intent"])==canonical(intent),"NATIVE_MERGE_REQUEST")
  need(constraints.keys==setOf("expiresAt","maxFee","feePreference")&&constraints["feePreference"]=="standard"&&amount(constraints["maxFee"])==remaining&&expiry.isAfter(Instant.now())&&!expiry.isAfter(m.expiresAt),"NATIVE_MERGE_FEE")
  need(t.keys==setOf("version","stepId","stepIndex","authority","asset","stateHash","materialHash","inputCount","outputCount","feeKind","fee","expiresAt","dependsOn")&&t["version"]=="1.0"&&integer(t["stepIndex"])==m.nextIndex&&t["stepId"]=="merge-${m.nextIndex}"&&canonical(t["authority"])==canonical(m.scope["authority"])&&canonical(t["asset"])==canonical(asset)&&t["materialHash"]==hash(r)&&t["feeKind"]=="maximum"&&amount(t["fee"])==remaining&&Instant.parse(t["expiresAt"] as String)==expiry&&integer(t["outputCount"])==1,"NATIVE_MERGE_STEP")
  digest(t["stateHash"] as String);if(m.nextIndex==1)need(t["stateHash"]==m.scope["initialStateHash"],"NATIVE_MERGE_STATE")
  val inputs=selectedInputs.toSet();val count=integer(t["inputCount"])
  need(count in 2..m.inputLimit&&count==inputs.size&&count==selectedInputs.size&&inputs.all{Regex("[0-9a-f]{64}:(0|[1-9][0-9]{0,9})").matches(it)},"NATIVE_MERGE_INPUTS")
  need(inputs.none{it in m.consumedInputs},"NATIVE_MERGE_SPENT_INPUT")
  val deps=(t["dependsOn"] as? List<*>)?.map{it as String}?:throw NativeCustodyFailure("NATIVE_MERGE_DEPENDENCY")
  need(deps.toSet().size==deps.size&&deps.all{it in m.accepted}&&deps.toSet()==inputs.map{it.take(64)}.filter{it in m.accepted}.toSet(),"NATIVE_MERGE_DEPENDENCY")
  val snapshot=begin(owner,scope,id,"tbc_sendTransaction",m.revision,m.account);val o=s.operations.getValue(id)
  o.maintenance=m;o.maintenanceStep=t;o.maintenanceInputs=inputs;o.maintenanceRequestHash=hash(r);m.activeChild=id;m.childIds+=id;return snapshot
 }
 private fun bindMaintenance(o:Operation,payload:Map<String,Any?>,review:Map<String,Any?>,expiry:Instant){
  val m=o.maintenance?:return;currentMaintenance(m)
  val txs=(payload["transactions"] as List<*>).map{map(it)};val fee=amount(review["totalFee"])
  val requestedExpiry=Instant.parse(map(o.request!!["constraints"])["expiresAt"] as String)
  need(txs.size==1&&integer(review["transactionCount"])==1&&!expiry.isAfter(requestedExpiry)&&!Instant.parse(payload["expiresAt"] as String).isAfter(requestedExpiry)&&fee<=m.maxFee-m.spent,"NATIVE_MERGE_BOUND")
  val inputs=NativePrepared.inputOutpoints(txs[0]["unsignedTransaction"])
  need(inputs.toSet().size==inputs.size&&inputs.toSet().containsAll(o.maintenanceInputs)&&txs[0]["dependsOn"]==emptyList<String>()&&amount(txs[0]["fee"])==fee,"NATIVE_MERGE_INPUTS")
  need(inputs.none{it in m.consumedInputs},"NATIVE_MERGE_SPENT_INPUT")
  val kind=map(m.scope["asset"])["kind"] as String;if(kind=="tbc")need(inputs.toSet()==o.maintenanceInputs,"NATIVE_MERGE_INPUTS")
  val flows=(review["assetFlows"] as? List<*>)?.map{map(it)}?:throw NativeCustodyFailure("NATIVE_MERGE_EFFECT")
  val merged=flows.firstOrNull{it["direction"]=="merge"}?:throw NativeCustodyFailure("NATIVE_MERGE_EFFECT")
  val cost=flows.firstOrNull{it["direction"]=="fee"}?:throw NativeCustodyFailure("NATIVE_MERGE_EFFECT")
  val flowKind=mapOf("tbc" to "native","ft" to "ft","stablecoin" to "stablecoin","pool-ft" to "ft","ftlp" to "lp").getValue(kind)
  need(flows.size==2&&merged["kind"]==flowKind&&merged["from"]==o.account.address&&merged["to"]==o.account.address&&cost["kind"]=="native"&&cost["from"]==o.account.address&&cost["to"]==null&&amount(cost["amount"])==fee,"NATIVE_MERGE_EFFECT")
  merged["contractId"]?.let{contract->val asset=map(m.scope["asset"]);val expected=if(kind=="pool-ft")map(map(m.scope["impact"])["poolIdentity"])["ftContractId"]else asset[if(kind=="ftlp")"poolContractId" else "contractId"];need(canonical(contract)==canonical(expected),"NATIVE_MERGE_EFFECT")}
  // Historical Pool FT preview names the initiator; immutable pool identity
  // and shared Engine validation still prove the actual contract custody.
  o.maintenanceFee=fee;o.maintenanceBoundInputs=inputs.toSet()
 }
 fun closeMaintenance(owner:String,scope:Map<String,String>,id:String){val s=session(owner,scope);s.maintenance?.let{if(it.id==id)stopMaintenance(it)}}
 // Native-owned submission facts only; counts are observed index progress,
 // not confirmation proof. No HTTP or additional durable result write.
 fun finishMaintenance(owner:String,scope:Map<String,String>,id:String,result:Map<String,Any?>){
  val s=session(owner,scope);val m=s.maintenance?:throw NativeCustodyFailure("NATIVE_MERGE_INACTIVE");need(m.id==id,"NATIVE_MERGE_INACTIVE");maintenanceAuthority(m)
  val r=immutable(result);val limits=map(m.scope["limits"])
  need(m.approved&&m.activeChild==null&&r.keys==setOf("version","status","reason","scopeHash","approvalId","initialUtxoCount","finalUtxoCount","totalFee","steps")&&r["version"]=="1.0"&&r["scopeHash"]==m.scopeHash&&r["approvalId"]==m.approvalId&&canonical(r["initialUtxoCount"])==canonical(m.scope["initialUtxoCount"]),"NATIVE_MERGE_RESULT")
  val rows=(r["steps"] as? List<*>)?.map{map(it)}?:throw NativeCustodyFailure("NATIVE_MERGE_RESULT")
  val extra=if(m.failedStep==null)0 else 1
  need(rows.size==m.completedRows.size+extra&&rows.size<=m.maxTransactions&&canonical(rows.take(m.completedRows.size))==canonical(m.completedRows),"NATIVE_MERGE_RESULT")
  var total=m.spent
  m.failedStep?.let{step->
   val row=rows.last();val status=row["status"] as? String?:throw NativeCustodyFailure("NATIVE_MERGE_RESULT")
   val expected=mutableMapOf<String,Any?>("stepId" to step["stepId"],"status" to status,"fee" to "0","inputCount" to step["inputCount"],"outputCount" to 1,"dependsOn" to step["dependsOn"])
   if(m.failureMayHaveSubmitted){
    need(status=="uncertain","NATIVE_MERGE_RESULT");total+=amount(step["fee"]);expected["fee"]=step["fee"]
    if("recoveryId" in row){need(row["recoveryId"] is String&&row["recoveryId"]==m.failureRecoveryId,"NATIVE_MERGE_RESULT");expected["recoveryId"]=row["recoveryId"]}
   }else need(status in setOf("failed","rejected"),"NATIVE_MERGE_RESULT")
   need(canonical(row)==canonical(expected),"NATIVE_MERGE_RESULT")
  }
  val final=canonical(r["finalUtxoCount"]).toLongOrNull()?:throw NativeCustodyFailure("NATIVE_MERGE_RESULT")
  val initial=canonical(m.scope["initialUtxoCount"]).toLong();val target=integer(limits["targetUtxoCount"]);val reason=r["reason"] as? String;val status=r["status"] as? String
  need(final in 0..9007199254740991L&&amount(r["totalFee"])==total&&total<=m.maxFee,"NATIVE_MERGE_RESULT")
  if(m.failureMayHaveSubmitted)need(status=="uncertain"&&reason=="broadcast-uncertain","NATIVE_MERGE_RESULT")
  else if(status=="complete"){
   val reduction=m.completedRows.sumOf{integer(it["inputCount"])-1}
   need(m.failedStep==null&&m.completedRows.isNotEmpty()&&reason=="target-reached"&&final==initial-reduction&&final<=target,"NATIVE_MERGE_RESULT")
  }else{
   need(status==(if(m.completedRows.isEmpty())"stopped" else "partial")&&reason in setOf("cancelled","expired","facts-changed","step-failed","fee-budget-exhausted","step-rejected","index-stalled","transaction-budget-exhausted"),"NATIVE_MERGE_RESULT")
   if(reason=="transaction-budget-exhausted")need(rows.size==m.maxTransactions&&m.failedStep==null,"NATIVE_MERGE_RESULT")
   if(m.failedStep!=null)need(reason==(if(rows.last()["status"]=="rejected")"step-rejected" else "step-failed"),"NATIVE_MERGE_RESULT")
  }
  s.results[id]=DeliveryPermit(m.revision,m.accountRevision,m.account,m.epoch,"tbc_accounts",null,maintenanceResultHash=hash(r),maintenanceTarget=target)
  stopMaintenance(m)
 }
 private fun <T> decision(s:Session,id:String,review:NativeReview,
  finish:(Boolean)->T,complete:(Result<T>)->Unit){
  var done=false;var dismiss:(()->Unit)?=null
  fun result(value:Result<T>){
   onExecutor();if(done)return;done=true;s.pending.remove(id)
   // Result/UI sinks cannot undo authority cancellation or strand other work.
   runCatching{complete(value)};runCatching{dismiss?.invoke()}
  }
  s.pending[id]={
   // Complete first; a UI cancellation callback cannot win this race as approval.
   result(Result.failure(NativeCustodyFailure("NATIVE_CANCELLED")))
  }
  try{
   dismiss=approval.present(walletProtocol.approvalReview(review)){yes->
    onExecutor();if(!done)result(runCatching{finish(yes)})
   }
   if(done)runCatching{dismiss?.invoke()}
  }catch(e:Exception){result(Result.failure(e))}
 }
 private fun grantProposal(owner:String,scope:Map<String,String>,id:String,request:Map<String,Any?>):Pair<Session,NativeGrantProposal>{
  need(crypto!=null||!request.containsKey("tbc_crypto"),"UNSUPPORTED_PERMISSION")
  need(sendSourceIdentity!=null||!request.containsKey("tbc_sendTransaction"),"UNSUPPORTED_PERMISSION")
  val s=session(owner,scope);reserve(s,id)
  val proposal=permissions.proposal(s.scope.getValue("origin"),immutable(request),id)
  return s to proposal
 }
 fun prepareNetworkGrant(owner:String,scope:Map<String,String>,id:String,request:Map<String,Any?>,cancel:()->Unit):NativePermissionGrant{
  val(s,proposal)=grantProposal(owner,scope,id,request)
  val revision=s.revision;val account=accounts.current;val accountRevision=accounts.revision
  s.pending[id]=cancel
  return NativePermissionGrant(permissions,proposal,{current(s,revision,account,accountRevision,id,grant=true)},{s.pending.remove(id);Unit})
 }
 fun requestPermissions(owner:String,scope:Map<String,String>,id:String,
  request:Map<String,Any?>,complete:(Result<List<Map<String,Any?>>>)->Unit){
  val(s,proposal)=grantProposal(owner,scope,id,request)
  val revision=s.revision;val account=accounts.current;val accountRevision=accounts.revision
  val review=NativeReview(id,proposal.origin,chain,account.address,"Connect wallet",
   proposal.capabilities.joinToString()+".\nAccounts:\n"+proposal.accounts.joinToString("\n"){it.address}+"\nEach signature still requires approval.")
  decision(s,id,review,{yes->
   current(s,revision,account,accountRevision,id,grant=true);need(yes,"USER_REJECTED")
   // Remove this finishing dialog before a committed grant fences old work.
   s.pending.remove(id)
   permissions.approve(proposal){current(s,revision,account,accountRevision,id,grant=true)}
  },complete)
 }
 fun disconnect(owner:String,scope:Map<String,String>,id:String){
  val s=session(owner,scope);reserve(s,id)
  permissions.revoke(s.scope.getValue("origin"),id){need(session(owner,scope)===s,"NATIVE_SCOPE_CHANGED")}
 }
 fun begin(owner:String,scope:Map<String,String>,id:String,method:String,
  expectedRevision:Int,expectedAccount:NativeAccount):NativeWalletSnapshot{
  val s=session(owner,scope);need(method in setOf("tbc_signMessage","tbc_signTypedData")||NativePrepared.transaction(method)||method in NativeWorkflow.methods||(method==NativeReviewed.method&&reviewedComputer!=null)||(method in NativeCrypto.methods&&crypto!=null),"UNSUPPORTED_METHOD")
  val account=selectedAccount(s);requireActive(s,account)
  if(NativePrepared.sends(method)){need(sendSourceIdentity!=null,"NATIVE_BROADCAST_UNAVAILABLE");permissions.require(s.scope.getValue("origin"),"tbc_sendTransaction",permissionAccount(account))}
  need(s.revision==expectedRevision&&account==expectedAccount,"NATIVE_REVISION_CHANGED")
  permissions.require(s.scope.getValue("origin"),NativePrepared.permission(method),permissionAccount(account));reserve(s,id)
  s.operations[id]=Operation(s,id,method,s.revision,accounts.revision,account,
   permissions.epoch(s.scope.getValue("origin")))
  return snapshot(owner,scope)
 }
 private fun operation(owner:String,scope:Map<String,String>,id:String):Operation{
  val o=session(owner,scope).operations[id]?:throw NativeCustodyFailure("NATIVE_OPERATION_GONE")
  current(o);return o
 }
 fun check(owner:String,scope:Map<String,String>,id:String){operation(owner,scope,id)}
 private fun signingOperation(owner:String,scope:Map<String,String>,id:String):Operation{
  val o=operation(owner,scope,id);val w=o.workflow?:return o
  val i=w.activeIndex?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INACTIVE");val child=w.children[i];current(child);return child
 }
 // Read-only wallet role resolution, not a grant or a page-selected key.
 fun resolveSigningAccounts(owner:String,scope:Map<String,String>,id:String,request:Map<String,Any?>,context:Map<String,Any?>):List<Map<String,Any?>>{
  val o=operation(owner,scope,id);val r=immutable(request)
  if(o.method in NativeWorkflow.methods){
   need(o.request==null&&o.workflow==null,"NATIVE_ROLE_STATE")
   return prepareWorkflow(o,r,context).children.mapNotNull{it.controller}.filter{it!=o.account}.distinct().map{it.identity()}
  }
  need(NativePrepared.transaction(o.method)&&o.request==null&&o.roleRequestHash==null,"NATIVE_ROLE_STATE")
  need(canonical(context)==canonical(context(o.session)),"CONTEXT_CHANGED")
  return selectController(o,r)
 }
 private fun selectController(o:Operation,r:Map<String,Any?>):List<Map<String,Any?>>{
  need(r["version"]=="1.0"&&r["chainId"]==chain&&r["from"]==o.account.address&&poolContinuation((r["intent"] as? Map<*,*>)?.get("type")),"NATIVE_ROLE_PROFILE")
  val roles=r["signingRoles"] as? List<*>?:throw NativeCustodyFailure("NATIVE_ROLE_SELECTION")
  need(roles.size==1,"NATIVE_ROLE_SELECTION");val role=map(roles.single())
  need(role.keys==setOf("role","accountId")&&role["role"]=="pool-controller","NATIVE_ROLE_SELECTION")
  val matched=permissions.selectedAccounts().filter{it.accountId==role["accountId"]}
  need(matched.size==1,"NATIVE_ROLE_ACCOUNT");val controller=matched.single()
  requireActive(o.session,controller);permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(o.method),controller)
  o.controller=controller;o.roleRequestHash=hash(r)
  return if(controller==o.account)emptyList() else listOf(controller.identity())
 }
 private fun taskAccount(o:Operation,task:Map<String,Any?>):NativeAccount{
  if(task["accountId"]==o.account.accountId&&task["publicKey"]==o.account.publicKey)return o.account
  o.controller?.let{if(task["accountId"]==it.accountId&&task["publicKey"]==it.publicKey)return it}
  throw NativeCustodyFailure("NATIVE_TASK_ACCOUNT")
 }
 private fun context(s:Session)=mapOf("sessionId" to s.scope["sessionId"],"transport" to "webview",
  "origin" to s.scope["origin"],"topOrigin" to s.scope["topOrigin"],"frame" to "top",
  "navigationId" to s.scope["navigationId"],"createdAt" to s.scope["createdAt"])
 private fun prepareWorkflow(o:Operation,request:Map<String,Any?>,context:Map<String,Any?>):Workflow{
  need(o.method in NativeWorkflow.methods&&o.request==null,"NATIVE_WORKFLOW_STATE")
  val r=immutable(request);val requestHash=hash(r)
  need(canonical(context)==canonical(context(o.session)),"CONTEXT_CHANGED")
  need(r["from"]==o.account.address&&r["chainId"]==chain,"NATIVE_WORKFLOW_ACCOUNT")
  o.workflow?.let{need(it.requestHash==requestHash,"NATIVE_ROLE_REQUEST");return it}
  val projected=NativeWorkflow.children(o.method,r);val steps=(r["steps"] as List<*>).map{map(it)}
  val now=Instant.now();val expiry=minOf(r["expiresAt"]?.let{Instant.parse(it as String)}?:now.plusSeconds(300),now.plusSeconds(300))
  need(expiry.isAfter(now),"NATIVE_EXPIRED")
  val children=projected.map{row->
   val method=row["method"] as String;val child=Operation(o.session,o.id,method,o.revision,o.accountRevision,o.account,o.epoch)
   need(method!=NativeReviewed.method||reviewedComputer!=null,"NATIVE_COMPUTE_REQUIRED")
   permissions.require(o.session.scope.getValue("origin"),NativePrepared.permission(method),permissionAccount(o.account))
   val request=map(row["request"]);if(request["signingRoles"]!=null)selectController(child,request)
   need(method !in NativeCrypto.methods||crypto!=null,"NATIVE_CRYPTO_UNAVAILABLE")
   child.workflowParent=o;child
  }
  return Workflow(r,requestHash,steps,projected.map{map(it["request"])},children,expiry).also{o.workflow=it}
 }
 private fun describeWorkflow(o:Operation,method:String,request:Map<String,Any?>,context:Map<String,Any?>,review:Map<String,Any?>?):String{
  need(method==o.method&&o.request==null,"REPEATED_APPROVAL")
  val workflow=prepareWorkflow(o,request,context);val r=workflow.request
  val reviews=mutableMapOf<String,Map<String,Any?>>();var prepared:Map<String,Any?>?=null
  if(review!=null){
   need(setOf("kind","steps","prepared").containsAll(review.keys)&&review["kind"]=="workflow","NATIVE_REVIEW_PROFILE")
   val rows=review["steps"] as? List<*>?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
   for(value in rows){val row=map(value);val id=row["stepId"] as String;need(row.keys==setOf("stepId","review")&&id !in reviews,"NATIVE_REVIEW_PROFILE");reviews[id]=map(row["review"])}
   review["prepared"]?.let{val p=map(it);need(p.keys==setOf("workflowPlanHash","totalFee"),"NATIVE_REVIEW_PROFILE");digest(p["workflowPlanHash"] as String);amount(p["totalFee"]);prepared=p}
  }
  val reviewIds=workflow.steps.filter{it["kind"]=="reviewedTransaction"}.map{it["id"] as String}.toSet()
  need(reviews.keys==reviewIds,"NATIVE_REVIEW_REQUIRED")
  val transactions=workflow.children.any{NativePrepared.transaction(it.method)}
  need((!transactions&&reviewIds.isEmpty())||r["maxTotalFee"]!=null||prepared!=null,"NATIVE_WORKFLOW_FEE_REVIEW_REQUIRED")
  val cap=amount(r["maxTotalFee"]?:prepared?.get("totalFee")?:"0")
  prepared?.let{need(amount(it["totalFee"])<=cap,"NATIVE_FEE_CAP");workflow.consentPlanHash=it["workflowPlanHash"] as String}
  workflow.consentFeeCap=cap.toString()
  val descriptions=workflow.children.mapIndexed{index,child->
   val step=workflow.steps[index];val id=step["id"] as String;val depends=(step["dependsOn"] as List<*>).map{it as String}
   val description=describeConsent(child,child.method,workflow.requests[index],context,reviews[id],cap.toString())
   val links=mutableListOf<String>();(step["bindings"] as? List<*>)?.let{bindings->
    need(bindings.size<=1,"NATIVE_WORKFLOW_BINDING")
    for(value in bindings){val binding=map(value);val source=map(binding["source"]);val parent=source["stepId"] as String;need(parent in depends,"NATIVE_WORKFLOW_SOURCE");links+="After verified completion of $parent, copy ${source["output"] as String} to ${binding["target"] as String}."}
   }
   child.displayDescription="Depends on: ${if(depends.isEmpty())"none" else depends.joinToString(", ")}.\n"+description+(if(links.isEmpty())"" else "\n"+links.joinToString("\n"))
   "Step ${index+1}: $id. "+child.displayDescription
  }
  val mode=r["failureMode"]?:"atomic";need(mode in setOf("atomic","continue-independent"),"NATIVE_WORKFLOW_MODE")
  o.request=r;o.requestHash=workflow.requestHash
  val execution=if(NativePrepared.sends(method))"The wallet will submit the completed transaction steps as one batch. Unknown submissions are not retried." else "No broadcast; abort cannot undo signatures already returned to this operation."
  return "Approve one bounded batch of ${workflow.children.size} steps. Total fee at most $cap native atomic. Failure mode: $mode.\nOne approval does not guarantee all-or-nothing on-chain execution.\n$execution\n\n"+descriptions.joinToString("\n\n")
 }
 fun consent(owner:String,scope:Map<String,String>,id:String,method:String,
  request:Map<String,Any?>,context:Map<String,Any?>,complete:(Result<Boolean>)->Unit){
  consentReviewed(owner,scope,id,method,request,context,null,complete)
 }
 // Reusable family projection without UI or approval. Batch children will
 // share these checks; the outer operation alone owns the consent/receipt.
 private fun describeConsent(o:Operation,method:String,request:Map<String,Any?>,context:Map<String,Any?>,review:Map<String,Any?>?,feeCap:String?=null):String{
  need(o.request==null,"REPEATED_APPROVAL")
  need(method==NativeReviewed.method||review==null,"NATIVE_REVIEW_PROFILE")
  val r=immutable(request);need(method==o.method&&r["version"]=="1.0"&&r["chainId"]==chain&&r["from"]==o.account.address)
  need(canonical(context)==canonical(context(o.session)),"CONTEXT_CHANGED")
  if(r["signingRoles"]!=null)need(o.controller!=null&&o.roleRequestHash==hash(r),"NATIVE_ROLE_REQUEST")
  else need(o.controller==null&&o.roleRequestHash==null,"NATIVE_ROLE_REQUEST")
  if(NativePrepared.prepared(method))o.preparedProposal=NativePrepared.consent(r)
  o.requestHash=hash(NativePrepared.request(r,method))
  val description=if(method==NativeReviewed.method){
   val value=review?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
   o.reviewedConsent=NativeReviewed.consent(r,value);NativeReviewed.description(o.reviewedConsent!!)
  }else if(NativePrepared.transaction(method)){
   val intent=map(r["intent"]);val cap=amount((r["constraints"] as? Map<*,*>)?.get("maxFee")?:feeCap)
   need(cap<=java.math.BigInteger("2100000000000000"),"NATIVE_FEE_CAP")
   o.consentFeeCap=cap.toString()
   val detail=when(intent["type"]){
    "tbc-lop-create","tbc-lop-cancel","tbc-lop-match"->lopDescription(intent,o.account.address)
    "tbc-htlc-lock","tbc-htlc-claim","tbc-htlc-refund"->htlcDescription(intent,r,o.account.address)
    "tbc-timelock-lock","tbc-timelock-unlock"->timelockDescription(intent,r,o.account.address)
    "tbc-amm-create"->ammCreationDescription(intent)
    "tbc.pool.swap.exactTbcForToken","tbc.pool.swap.exactTokenForTbc","tbc.pool.liquidity.add","tbc.pool.liquidity.remove","tbc.pool.ft.merge","amm.mergeToken","tbc.pool.ftlp.merge","tbc.pool.ftlp.burn","tbc20Lp.burn"->pool2Description(intent,r)
    "tbc20-lp-transfer","tbc20Lp.transfer","tbc20-lp-merge","tbc20Lp.merge","tbc20-lp-lock","tbc20Lp.lock","tbc20-lp-unlock","tbc20Lp.unlock"->lpDescription(intent,o.account.address)
    "tbc-amm-add-liquidity","amm.addLiquidity","tbc-amm-remove-liquidity","amm.removeLiquidity","tbc-amm-swap","amm.swap"->{
     ammBusinessDescription(intent,o.account.address)
    }
    "tbc721-standard-mint","tbc721-standard-batch-mint"->mintDescription(intent,o.account.address)
    "tbc20-standard-create"->"Create TBC20 ${intent["name"] as String} (${intent["symbol"] as String}).\nInitial supply: ${intent["initialSupply"] as String} atomic; decimals: ${integer(intent["decimals"])}.\nOwner: ${intent["to"] as? String ?: o.account.address}.\nApprove the dependent funding/source/genesis steps as one bounded request."
    "tbc721-standard-create-collection"->{
     val media=map(intent["media"])
     "Create NFT collection: ${intent["name"] as String}.\nSupply: ${intent["supply"] as String}; owner: ${intent["to"] as? String ?: o.account.address}.\n${intent["description"] as String}\nMedia SHA256: ${hash(media)}.\n${media["uri"] as? String ?: "Embedded media bound to this request."}"
    }
    "tbc20.transfer","tbc20Stablecoin.transfer"->{
     val receivers=(intent["receivers"] as? List<*>)?.map{map(it)}?:listOf(mapOf("to" to intent["to"],"amount" to intent["amount"]))
     need(receivers.isNotEmpty()&&receivers.size<=8,"RECIPIENT_LIMIT")
     val sends=receivers.joinToString("\n"){"Send ${it["amount"] as String} token atomic to ${it["to"] as String}."}
     val payment=intent["payment"]?.let{map(it)}?.let{"\nAlso send ${amount(it["amount"])} TBC atomic to ${it["to"] as String}."}?:""
     val label=if(intent["type"]=="tbc20Stablecoin.transfer")"Stablecoin" else "FT"
     "$label ${intent["contractId"] as String}\n$sends$payment"
    }
    "tbc20.merge"->"FT ${intent["contractId"] as String}\nMerge token inputs into the same account: ${o.account.address}."
    "tbc20Stablecoin.merge"->"Stablecoin ${intent["contractId"] as String}\nMerge token inputs into the same account: ${o.account.address}."
    "tbc721.batchTransfer"->{
     val transfers=(intent["transfers"] as? List<*>)?.map{map(it)}?:emptyList()
     need(transfers.size in 1..100,"NATIVE_NFT_BATCH")
     transfers.mapIndexed{index,item->
      val payment=item["payment"]?.let{map(it)}?.let{" Also send ${amount(it["amount"])} TBC atomic to ${it["to"] as String}."}?:""
      "${index+1}. Send NFT ${item["contractId"] as String} to ${item["to"] as String}.$payment"
     }.joinToString("\n")
    }
    "tbc721.transfer"->{
     val payment=intent["payment"]?.let{map(it)}?.let{"\nAlso send ${amount(it["amount"])} TBC atomic to ${it["to"] as String}."}?:""
     "Send NFT ${intent["contractId"] as String} to ${intent["to"] as String}.$payment"
    }
    "tbc.transfer"->"Send ${amount(intent["amount"])} TBC atomic to ${intent["to"] as String}."
    "tbc.maintenance.merge"->"Merge up to 100 TBC inputs into the same account: ${o.account.address}."
    else->throw NativeCustodyFailure("UNSUPPORTED_INTENT")
   }
   val roleDetail=o.controller?.let{"\nAsset/fee account: ${o.account.address}.\nPool controller: ${it.address} (pool-controller)."}?:""
   val execution=if(NativePrepared.sends(method))"The wallet will submit these transactions in order. Unknown submissions are not retried." else if(o.workflowParent?.let{NativePrepared.sends(it.method)}==true)"Signed transactions are included in the approved batch submission." else "Returns signed transactions; no broadcast."
   "$detail$roleDetail\nFee at most $cap native atomic, including any required input consolidation. $execution"
  }else if(method in NativeCrypto.methods){
   need(crypto!=null,"NATIVE_CRYPTO_UNAVAILABLE");NativeCrypto.description(r,method,o.account)
  }else if(method=="tbc_signTypedData"){
   val envelope=typedEnvelope(r,o.session.scope.getValue("origin"));o.typedEnvelope=envelope
   "TBC structured data signature. No transaction is broadcast here; the application may use this signature to authorize actions.\nDomain, type definitions and all signed values:\n"+canonical(envelope)
  }else{
   val message=map(r["message"]);NativeSigningEnvelope.workflow(mapOf("kind" to "message","message" to message),chain,o.account.address,o.session.scope.getValue("origin"))
   "Ordinary TBC message (${message["encoding"]}):\n${message["data"]}"
  }
  o.request=r;o.displayDescription=description
  return description
 }
 fun consentReviewed(owner:String,scope:Map<String,String>,id:String,method:String,
  request:Map<String,Any?>,context:Map<String,Any?>,review:Map<String,Any?>?,complete:(Result<Boolean>)->Unit){
  val o=operation(owner,scope,id)
  if(o.maintenance!=null)need(hash(request)==o.maintenanceRequestHash,"NATIVE_MERGE_REQUEST")
  if(o.mintJob!=null)need(hash(request)==o.maintenanceRequestHash,"NATIVE_NFT_JOB_REQUEST")
  val description=if(method in NativeWorkflow.methods)describeWorkflow(o,method,request,context,review)else describeConsent(o,method,request,context,review)
  if(o.maintenance!=null||o.mintJob!=null){current(o);o.approved=true;complete(Result.success(true));return}
  val children=o.workflow?.children?:listOf(o)
  val steps=children.mapIndexed{index,child->
   val request=child.request?:emptyMap();val kind=child.method
   val warnings=NativeApprovalDisplay.warnings(request)+(if(kind in setOf("tbc_signMessage","tbc_signTypedData"))listOf("SIGNATURE_MAY_AUTHORIZE_ACTIONS: A signature may authorize actions even without a wallet broadcast.")else emptyList())+(if(kind==NativeReviewed.method)listOf("REVIEW_ALL_TRANSACTION_OUTPUTS: Review every output, including scripts without a known address.")else emptyList())
   val reviewed=(child.reviewedConsent?.get("payload") as? Map<*,*>)?.get("preview") as? Map<String,Any?>
   NativeApprovalStep(o.workflow?.steps?.get(index)?.get("id") as? String?:"1",kind,child.displayDescription,reviewed?.let{NativeApprovalDisplay.bound(it)}?:NativeApprovalDisplay.intent(request,child.account.address),java.util.Collections.unmodifiableList(warnings+((reviewed?.get("warnings") as? List<*>)?.map{it as String}?:emptyList())),reviewed?.get("totalFee") as? String,transactionsStatus=if(NativePrepared.transaction(kind)||kind==NativeReviewed.method)"not-bound" else "not-applicable")
  }
  val display=NativeReview(id,o.session.scope.getValue("origin"),chain,o.account.address,"Approve request",description+"\n\n"+NativeApprovalDisplay.text(steps)+"\nUnknown amounts are not zero. Bounded intent is checked against the completed plan before signing.",steps=java.util.Collections.unmodifiableList(steps))
  o.displayReview=display
  decision(o.session,id,display,{yes->
   current(o);o.approved=yes;yes
  },complete)
 }
 // Install validated family tasks only; no permission, UI or receipt here.
 private fun installBoundTasks(o:Operation,binding:Map<String,Any?>,preview:Map<String,Any?>,plan:Map<String,Any?>?,envelope:Map<String,Any?>?):Map<String,Any?>{
  need(o.approved&&o.receipt==null,"NOT_APPROVED_OR_REBOUND")
  val b=immutable(binding);val p=map(b["payload"]);val review=immutable(preview)
  val expectedRoles=o.controller?.let{listOf(mapOf("role" to "pool-controller","account" to it.identity()))}
  need(canonical(review["signingRoles"])==canonical(expectedRoles),"NATIVE_ROLE_REVIEW")
  need(b["bindingHash"]==hash(p)&&p["contextHash"]==hash(context(o.session))&&p["requestHash"]==o.requestHash,"NATIVE_BINDING_HASH")
  need(p["method"]==o.method&&p["origin"]==o.session.scope["origin"]&&p["sessionId"]==o.session.scope["sessionId"]&&p["chainId"]==chain&&p["accountId"]==o.account.accountId,"NATIVE_BINDING_IDENTITY")
  val expiry=Instant.parse(p["expiresAt"] as String);val now=Instant.now()
  need(expiry.isAfter(now)&&expiry.isBefore(now.plusSeconds(301)),"NATIVE_EXPIRY")
  if(o.method in NativeCrypto.methods){
   need(crypto!=null&&envelope==null,"NATIVE_CRYPTO_BINDING")
   val task=NativeCrypto.bound(o.request?:throw NativeCustodyFailure("NATIVE_CRYPTO_BINDING"),o.method,context(o.session),o.account,b,plan?:throw NativeCustodyFailure("NATIVE_CRYPTO_BINDING"),review)
   o.tasks[task["taskId"] as String]=task;o.expectedTasks=1;return b
  }
  val tasks=if(o.method==NativeReviewed.method){
   val bound=o.reviewedBound?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
   val consent=o.reviewedConsent?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
   need(p["operationKind"]=="transaction"&&p["operationHash"]==bound.planHash&&plan?.get("planHash")==bound.planHash&&canonical(review)==canonical(map(consent["payload"])["preview"])&&envelope==null,"NATIVE_REVIEWED_BINDING")
   o.transactionCount=bound.transactionCount;o.planHash=bound.planHash;o.reviewedTasks
  }else if(NativePrepared.transaction(o.method)){
   val signedPlan=immutable(plan?:throw NativeCustodyFailure("PLAN_REQUIRED"));val payload=map(signedPlan["payload"])
   need(signedPlan["planHash"]==hash(payload)&&p["operationHash"]==signedPlan["planHash"]&&payload["requestHash"]==o.requestHash&&payload["accountId"]==o.account.accountId&&payload["chainId"]==chain,"NATIVE_PLAN_BINDING")
   o.preparedProposal?.let{NativePrepared.bind(it,payload,expiry,bundleLimit(o.request))}
   val count=integer(review["transactionCount"])
   need(canonical(review)==canonical(payload["preview"])&&count in 1..bundleLimit(o.request)&&review["operationKind"]=="transaction"&&coveredWarnings(o.request!!,payload),"NATIVE_REVIEW")
   need(amount(review["totalFee"])<=amount(o.consentFeeCap),"NATIVE_FEE_CAP")
   val ids=(payload["transactions"] as List<*>).map{map(it)["id"] as String}
   need(ids.size==count&&ids.toSet().size==count,"NATIVE_PLAN_TRANSACTIONS")
   bindMaintenance(o,payload,review,expiry)
   bindMintJob(o,signedPlan,payload,review,expiry)
   o.transactionCount=count;o.transactionIds=ids.toSet();o.planHash=signedPlan["planHash"] as String
   if(NativePrepared.sends(o.method))o.sendPlan=mapOf("totalFee" to review["totalFee"],"transactions" to (payload["transactions"] as List<*>).map{map(it).filterKeys{key->key in setOf("id","role","dependsOn")}})
   (payload["signingTasks"] as List<*>).map{map(it)}
  }else if(o.method=="tbc_signTypedData"){
   val expected=o.typedEnvelope?:throw NativeCustodyFailure("NATIVE_TYPED_CONSENT")
   val expectedDigest=typedDigest(expected)
   val expectedReview=mapOf("operationKind" to "typedData","scheme" to "tbc-typed-data","domain" to expected["domain"],"types" to expected["types"],"primaryType" to expected["primaryType"],"message" to expected["message"],"digest" to expectedDigest,"warnings" to emptyList<String>())
   need(plan==null&&p["operationKind"]=="typedData"&&p["operationHash"]==expectedDigest&&canonical(envelope)==canonical(expected)&&canonical(review)==canonical(expectedReview),"NATIVE_TYPED_BINDING")
   listOf(mapOf("taskId" to "sign-typed-data","purpose" to "typedData","algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to expectedDigest,"signatureEncoding" to "compact65-recoverable","origin" to p["origin"],"accountId" to o.account.accountId,"publicKey" to o.account.publicKey))
  }else{
   val expected=mapOf("type" to "tbc.message","version" to "1.0","message" to o.request!!["message"])
   val expectedDigest=NativeSigningEnvelope.digest(expected,"message",walletProtocol)
   need(plan==null&&p["operationKind"]=="message"&&p["operationHash"]==expectedDigest,"NATIVE_MESSAGE_DIGEST")
   need(review["scheme"]=="tbc-message"&&review["digest"]==p["operationHash"]&&canonical(review["message"])==canonical(o.request!!["message"]),"NATIVE_REVIEW")
   need(canonical(envelope)==canonical(mapOf("type" to "tbc.message","version" to "1.0","message" to o.request!!["message"])),"NATIVE_MESSAGE")
   listOf(mapOf("taskId" to (if(walletProtocol==NativeWalletProtocol.LEGACY)"legacy-sign-message" else "sign-message"),"purpose" to "message","algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to p["operationHash"],"signatureEncoding" to "compact65-recoverable","origin" to p["origin"],"accountId" to o.account.accountId,"publicKey" to o.account.publicKey))
  }
  val profile=(o.request?.get("intent") as? Map<*,*>)?.get("type")
  val limit=if(!NativePrepared.transaction(o.method))1 else mapOf("tbc-lop-create" to 128,"tbc-lop-cancel" to 3,"tbc-lop-match" to 3,"tbc-htlc-lock" to 128,"tbc-htlc-claim" to 128,"tbc-htlc-refund" to 128,"tbc-timelock-lock" to 128,"tbc-timelock-unlock" to 128,"amm.swap" to 128,"amm.addLiquidity" to 128,"amm.removeLiquidity" to 128,"amm.mergeToken" to 6,"tbc20Lp.transfer" to 128,"tbc20Lp.lock" to 128,"tbc20Lp.unlock" to 128,"tbc20Lp.merge" to 128,"tbc20Lp.burn" to 6,"tbc20.transfer" to 32,"tbc20.merge" to 32,"tbc20-standard-create" to 128,"tbc721-standard-create-collection" to 128,"tbc721-standard-mint" to 128,"tbc721-standard-batch-mint" to 128,"tbc-amm-create" to 128,"tbc-amm-add-liquidity" to 128,"tbc-amm-remove-liquidity" to 128,"tbc-amm-swap" to 128,"tbc20-lp-transfer" to 128,"tbc20-lp-merge" to 128,"tbc20-lp-lock" to 128,"tbc20-lp-unlock" to 128,"tbc.pool.swap.exactTbcForToken" to 128,"tbc.pool.swap.exactTokenForTbc" to 128,"tbc.pool.liquidity.add" to 128,"tbc.pool.liquidity.remove" to 128,"tbc.pool.ft.merge" to 6,"tbc.pool.ftlp.merge" to 6,"tbc.pool.ftlp.burn" to 6,"tbc721.transfer" to 128,"tbc721.batchTransfer" to 128,"tbc20Stablecoin.transfer" to 128,"tbc20Stablecoin.merge" to 128,"tbc.transfer" to 128,"tbc.maintenance.merge" to 100)[profile]?:0
  val reviewed=o.method==NativeReviewed.method
  need(if(reviewed)tasks.size<=1000 else tasks.isNotEmpty()&&tasks.size<=limit,"NATIVE_TASKS")
  val validated=mutableMapOf<String,Map<String,Any?>>()
  o.exactTaskCount=!(poolContinuation(profile)&&o.transactionCount>1&&review["signingTaskCount"]==null)
  val total=if(reviewed)o.reviewedBound!!.totalTasks else integer(review["signingTaskCount"]?:if(o.exactTaskCount)tasks.size else minOf(1024,limit*o.transactionCount))
  need(total>=tasks.size&&total<=(if(reviewed)32000 else 1024)&&(o.transactionCount>1||total==tasks.size),"NATIVE_TOTAL_TASKS")
  for(task in tasks){
   taskAccount(o,task)
   digest(task["digest"] as String);val taskId=task["taskId"] as String
   val encoding=task["signatureEncoding"] as String
   need(encoding in setOf("compact64","compact65-recoverable")&&task["algorithm"]==if(encoding=="compact64")"secp256k1-ecdsa-sha256d" else "secp256k1-recoverable-ecdsa-sha256d","NATIVE_TASK_ENCODING")
   need(taskId.isNotEmpty()&&validated.put(taskId,immutable(task))==null,"NATIVE_TASK_DUPLICATE")
  }
  o.displayAssets=NativeApprovalDisplay.bound(review,o.request);o.displayWarnings=(review["warnings"] as? List<*>)?.map{it as String}?:emptyList();o.displayFee=review["totalFee"] as? String
  val displayPayload=plan?.get("payload") as? Map<*,*>
  o.displayTransactions=NativeApprovalDisplay.transactions(displayPayload,o.displayAssets?:emptyList(),o.displayWarnings)
  o.displayTransactionsStatus=if(displayPayload?.get("transactions") is List<*>)"available" else if(NativePrepared.transaction(o.method)||o.method==NativeReviewed.method)"not-available" else "not-applicable"
  o.expectedTasks=total;o.tasks.putAll(validated);return b
 }
 private fun publishBoundReview(o:Operation){
  val display=o.displayReview?:return;val children=o.workflow?.children?:listOf(o)
  val steps=display.steps.mapIndexed{index,step->val child=children[index];step.copy(
   assets=child.displayAssets?.takeIf{it.isNotEmpty()}?:step.assets,warnings=java.util.Collections.unmodifiableList((step.warnings+child.displayWarnings).distinct().sorted()),actualFeeAtomic=child.displayFee?:step.actualFeeAtomic,transactions=child.displayTransactions,transactionsStatus=child.displayTransactionsStatus)}
  approval.update(walletProtocol.approvalReview(display.copy(phase="binding-verified",steps=java.util.Collections.unmodifiableList(steps),
   description=display.description+"\n\nVerified plan details (not a second approval):\n"+NativeApprovalDisplay.text(steps))))
 }
 fun bind(owner:String,scope:Map<String,String>,id:String,binding:Map<String,Any?>,
  preview:Map<String,Any?>,plan:Map<String,Any?>?,envelope:Map<String,Any?>?):Map<String,Any?>{
  val o=operation(owner,scope,id)
  need(o.method !in NativeWorkflow.methods,"NATIVE_WORKFLOW_EXECUTION_NOT_INSTALLED")
  val b=installBoundTasks(o,binding,preview,plan,envelope);val p=map(b["payload"])
  val receipt=immutable(mapOf("status" to "approved","approvalId" to UUID.randomUUID().toString(),"approvalToken" to UUID.randomUUID().toString(),"bindingHash" to b["bindingHash"],"approvedAt" to Instant.ofEpochMilli(System.currentTimeMillis()).toString(),"expiresAt" to p["expiresAt"]))
  o.receipt=receipt;publishBoundReview(o);current(o);return immutable(receipt)
 }
 private fun childBinding(child:Operation,parent:Map<String,Any?>,kind:String,operationHash:String):Map<String,Any?>{
  val p=map(parent["payload"])+mapOf("method" to child.method,"operationKind" to kind,"operationHash" to operationHash,"requestHash" to child.requestHash)
  return mapOf("payload" to p,"bindingHash" to hash(p))
 }
 private data class WorkflowReview(val child:Operation,val plan:Map<String,Any?>,val preview:Map<String,Any?>,val bound:NativeReviewed.Bound)
 // Same owner, family checks and asynchronous Rust port, with one parent receipt.
 // Retain the computed first stage; entry must not repeat this computation.
 fun bindWorkflow(owner:String,scope:Map<String,String>,id:String,binding:Map<String,Any?>,preview:Map<String,Any?>,plan:Map<String,Any?>,complete:(Result<Map<String,Any?>>)->Unit){
  val o=operation(owner,scope,id);val workflow=o.workflow?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE")
  need(o.approved&&o.receipt==null&&!workflow.bindingStarted&&o.request!=null,"NOT_APPROVED_OR_REBOUND");workflow.bindingStarted=true
  val extra=workflow.children.mapNotNull{it.controller}.filter{it!=o.account}.distinct()
  val reviews=workflow.children.mapIndexedNotNull{i,child->child.reviewedConsent?.let{(workflow.steps[i]["id"] as String) to it}}.toMap()
  val bound=NativeWorkflow.bind(o.method,workflow.request,context(o.session),o.account,extra,plan,preview,binding,reviews,walletProtocol=walletProtocol)
  val p=map(bound.plan["payload"]);val b=bound.binding;val expiry=Instant.parse(p["expiresAt"] as String)
  need(expiry<=workflow.expiresAt&&(workflow.consentPlanHash==null||workflow.consentPlanHash==bound.plan["workflowPlanHash"]),"NATIVE_WORKFLOW_CONSENT_CHANGED")
  need(amount(p["totalFee"])<=amount(workflow.consentFeeCap),"NATIVE_FEE_CAP")
  val reviewed=mutableListOf<WorkflowReview>()
  for((index,child)in workflow.children.withIndex()){
   val stepId=workflow.steps[index]["id"] as String;child.approved=true
   if(NativePrepared.transaction(child.method)){
    val entry=(p["transactionPlans"] as List<*>).map{map(it)}.single{it["stepId"]==stepId};val childPlan=map(entry["plan"]);val body=map(childPlan["payload"])
    installBoundTasks(child,childBinding(child,b,"transaction",childPlan["planHash"] as String),map(body["preview"]),childPlan,null)
   }else if(child.method==NativeReviewed.method){
    val request=child.request?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED");val consent=child.reviewedConsent?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
    val m=NativeReviewed.workflowPlan(request,context(o.session),o.account,consent,p["expiresAt"] as String)
    val r=NativeReviewed.bind(request,context(o.session),o.account,consent,m.plan,m.preview,m.packet,expiry)
    reviewed+=WorkflowReview(child,m.plan,m.preview,r)
   }else if(child.method in NativeCrypto.methods){
    need(crypto!=null,"NATIVE_CRYPTO_UNAVAILABLE")
    val task=(p["cryptoTasks"] as List<*>).map{map(it)}.single{it["taskId"]=="crypto-$stepId"}
    child.tasks[task["taskId"] as String]=immutable(task);child.expectedTasks=1
   }else{
    val entry=(p["immediateSigningTasks"] as List<*>).map{map(it)}.firstOrNull{it["stepId"]==stepId}
    if(entry!=null){
     val task=map(entry["task"]);val envelope=map(entry["envelope"]);val kind=task["purpose"] as String;val digest=task["digest"] as String
     val review=mutableMapOf<String,Any?>("operationKind" to kind,"scheme" to if(kind=="message")"tbc-message" else "tbc-typed-data","digest" to digest,"warnings" to emptyList<String>())
     if(kind=="message")review["message"]=envelope["message"]else for(key in listOf("domain","types","primaryType","message"))review[key]=envelope[key]
     installBoundTasks(child,childBinding(child,b,kind,digest),review,null,envelope)
     need(child.tasks.size==1,"NATIVE_TASKS");val single=child.tasks.values.single()+mapOf("taskId" to "sign-$stepId")
     need(canonical(single)==canonical(task),"NATIVE_WORKFLOW_MESSAGE_TASK");child.tasks.clear();child.tasks[single["taskId"] as String]=single
     child.workflowEnvelope=immutable(envelope)
    }
   }
   // Deferred children have no task until their verified source completes.
  }
  var done=false
  fun result(r:Result<Map<String,Any?>>){if(done)return;done=true;complete(r)}
  fun ready(index:Int){
   try{
    current(o)
    if(index<reviewed.size){
     val row=reviewed[index];val child=row.child;val r=row.bound
     reviewedCompute(o,"prepareReviewedStage",r.prepare(0,emptyList()),{actual->
      child.reviewedTasks=r.tasks(actual,actual,0);child.reviewedStage=immutable(actual);child.reviewedBound=r
      installBoundTasks(child,childBinding(child,b,"transaction",r.planHash),row.preview,row.plan,null);true
     }){reply->try{reply.getOrThrow();ready(index+1)}catch(e:Exception){result(Result.failure(e))}}
    }else{
     need(Instant.now().isBefore(expiry),"NATIVE_EXPIRED")
     val receipt=immutable(mapOf("status" to "approved","approvalId" to UUID.randomUUID().toString(),"approvalToken" to UUID.randomUUID().toString(),"bindingHash" to b["bindingHash"],"approvedAt" to Instant.ofEpochMilli(System.currentTimeMillis()).toString(),"expiresAt" to p["expiresAt"]))
     workflow.bound=bound;o.receipt=receipt;workflow.children.forEach{it.receipt=receipt};publishBoundReview(o);current(o);result(Result.success(immutable(receipt)))
    }
   }catch(e:Exception){result(Result.failure(e))}
  }
  ready(0)
 }
 // The private worker already validated Engine pre-sign. Plans and tasks are
 // owned here; avoid retransmitting chain material across the platform bridge.
 fun enterWorkflowStep(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,entry:Map<String,Any?>){
  val o=operation(owner,scope,id);receipt(o);val w=o.workflow?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE");val bound=w.bound?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE")
  need(w.activeIndex==null&&w.nextIndex<w.children.size&&id !in o.session.pending&&canonical(receipt)==canonical(o.receipt),"NATIVE_WORKFLOW_STEP_STATE")
  val e=immutable(entry);val index=w.nextIndex;val step=w.steps[index];val child=w.children[index]
  val deferred=(map(bound.plan["payload"])["deferredSigningTasks"] as List<*>).map{map(it)}.singleOrNull{it["targetStepId"]==step["id"]}
  val keys=setOf("kind","stepId","workflowPlanHash","tasks")+(if(child.method==NativeReviewed.method)setOf("reviewed")else emptySet())+(if(deferred!=null)setOf("resolvedDeferredSigningTask")else emptySet())
  need(e.keys==keys&&e["kind"]=="workflow-step"&&e["stepId"]==step["id"]&&e["workflowPlanHash"]==bound.plan["workflowPlanHash"],"NATIVE_WORKFLOW_STEP_BINDING")
  need((step["dependsOn"] as List<*>).all{w.completedResults.containsKey(it)},"NATIVE_WORKFLOW_DEPENDENCY")
  val resolved=deferred?.let{NativeWorkflow.resolve(it,map(e["resolvedDeferredSigningTask"]),w.completedResults,child.account,o.session.scope.getValue("origin"),walletProtocol)}
  val expectedTasks=resolved?.let{mapOf((it.second["taskId"] as String) to it.second)}?:child.tasks
  need(expectedTasks.isNotEmpty(),"NATIVE_TASKS")
  val tasks=(e["tasks"] as List<*>).map{map(it)}
  need(tasks.size==expectedTasks.size&&tasks.map{it["taskId"]}.toSet().size==tasks.size,"NATIVE_TASKS")
  for(task in tasks)need(canonical(task)==canonical(expectedTasks[task["taskId"] as String]),"NATIVE_TASK_CHANGED_OR_REPLAY")
  child.reviewedBound?.let{r->
   val expected=mapOf("kind" to "reviewed","material" to r.material,"policyMaterial" to r.policy,"review" to child.reviewedConsent,"stage" to child.reviewedStage)
   need(canonical(e["reviewed"])==canonical(expected),"NATIVE_REVIEWED_STAGE_CHANGED")
  }
  if(resolved!=null){child.tasks.putAll(expectedTasks);child.workflowEnvelope=resolved.first;child.expectedTasks=1}
  w.activeIndex=index
 }
 private fun fullySigned(o:Operation)=o.tasks.isNotEmpty()&&(if(o.exactTaskCount)o.completed.size==o.expectedTasks else o.stage==o.transactionCount-1&&o.completed.size<=o.expectedTasks)&&o.completed==o.tasks.keys&&o.id !in o.session.pending&&(o.method!=NativeReviewed.method||o.stage==o.transactionCount-1)
 // Only the shared private worker may supply its Engine-validated outcome.
 // Only native failed/skipped history advances over dependent descendants.
 // The approved graph is topologically ordered and bounded to five children.
 private fun nextWorkflowStep(w:Workflow,index:Int){
  w.activeIndex=null;w.nextIndex=index+1
  while(w.nextIndex<w.steps.size){
   val step=w.steps[w.nextIndex]
   if(!(step["dependsOn"] as List<*>).any{it in w.unavailableResults})break
   w.unavailableResults[step["id"] as String]=mapOf("id" to step["id"],"kind" to step["kind"],"status" to "skipped","error" to mapOf("code" to "DEPENDENCY_FAILED","message" to "Workflow dependency failed"));w.nextIndex++
  }
 }
 // Native consumed-task state and bound child metadata must also agree.
 fun finishWorkflowStep(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,outcome:Map<String,Any?>,complete:(Result<Boolean>)->Unit){
  val parent=operation(owner,scope,id);val child=signingOperation(owner,scope,id);receipt(child)
  val w=parent.workflow?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE");val index=w.activeIndex?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE");val bound=w.bound?:throw NativeCustodyFailure("NATIVE_WORKFLOW_STATE")
  val e=immutable(outcome);val step=w.steps[index]
  if(e["status"]=="failed"){
   val cryptoFailure=child.method in NativeCrypto.methods
   val expectedError=mapOf("code" to "HOST_UNAVAILABLE","message" to "Workflow step failed: "+if(cryptoFailure) "crypto.execute" else "signer.sign")
   need(e.keys==setOf("kind","stepId","workflowPlanHash","status","error")&&e["kind"]=="workflow-step-outcome"&&e["stepId"]==step["id"]&&e["workflowPlanHash"]==bound.plan["workflowPlanHash"]&&canonical(receipt)==canonical(parent.receipt),"NATIVE_WORKFLOW_RESULT_BINDING")
   need((if(cryptoFailure)child.cryptoUnavailable else child.signerUnavailable)&&map(bound.plan["payload"])["failureMode"]=="continue-independent"&&id !in parent.session.pending&&canonical(e["error"])==canonical(expectedError),"NATIVE_WORKFLOW_FAILURE_PROVENANCE")
   w.unavailableResults[step["id"] as String]=mapOf("id" to step["id"],"kind" to step["kind"],"status" to "failed","error" to expectedError)
   nextWorkflowStep(w,index);complete(Result.success(true));return
  }
  need(e.keys==setOf("kind","stepId","workflowPlanHash","status","result")&&e["kind"]=="workflow-step-outcome"&&e["status"]=="completed"&&e["stepId"]==step["id"]&&e["workflowPlanHash"]==bound.plan["workflowPlanHash"]&&canonical(receipt)==canonical(parent.receipt),"NATIVE_WORKFLOW_RESULT_BINDING")
  need(fullySigned(child),"NATIVE_STAGE_INCOMPLETE");val result=map(e["result"]);val p=map(bound.plan["payload"])
  if(NativePrepared.transaction(child.method)||child.method==NativeReviewed.method){
   val reviewed=child.method==NativeReviewed.method
   val plan=if(reviewed)null else map(map((p["transactionPlans"] as List<*>).map{map(it)}.single{it["stepId"]==step["id"]}["plan"])["payload"])
   val fee=if(reviewed)map(child.reviewedConsent!!["payload"])["totalFee"]else map(plan!!["preview"])["totalFee"]
   val requestHash=if(reviewed)hash(child.request!!["request"])else child.requestHash!!
   val txs=NativeWorkflow.completedBundle(result,child.account,requestHash,receipt["approvalId"] as String,fee as String,(plan?.get("transactions") as? List<*>)?.map{map(it)},child.reviewedBound)
   fun finish():Boolean{receipt(child);w.completedResults[step["id"] as String]=result;nextWorkflowStep(w,index);return true}
   val stage=child.reviewedStage
   if(stage!=null){
    val signatures=child.reviewedTasks.map{child.reviewedSignatures[it["taskId"] as String]?:throw NativeCustodyFailure("NATIVE_STAGE_INCOMPLETE")}
    reviewedCompute(child,"finalizeReviewedStage",mapOf("stage" to stage,"signatures" to signatures,"signatureEncoding" to "compact64"),{last->
     val expected=child.reviewedParents+(last["txraw"] as String)
     need(canonical(txs.map{it["rawTransaction"]})==canonical(expected),"NATIVE_WORKFLOW_REVIEWED_RESULT")
     if(child.reviewedBound?.associated==false)need(canonical(result["detachedSignatures"])==canonical((0 until child.stage).map{child.reviewedDetached[it]}+listOf(last["sigs"])),"NATIVE_WORKFLOW_REVIEWED_SIGNATURES")
     finish()
    },complete)
   }else complete(runCatching{finish()})
  }else if(child.method in NativeCrypto.methods){
   need(child.cryptoResultHash!=null&&hash(result)==child.cryptoResultHash,"NATIVE_WORKFLOW_CRYPTO_RESULT")
   w.completedResults[step["id"] as String]=result;nextWorkflowStep(w,index);complete(Result.success(true))
  }else{
   val envelope=child.workflowEnvelope?:throw NativeCustodyFailure("NATIVE_WORKFLOW_RESULT_BINDING");val task=child.tasks.values.single();val signature=child.signedResults[task["taskId"] as String]?:throw NativeCustodyFailure("NATIVE_WORKFLOW_RESULT_BINDING")
   need(canonical(result)==canonical(NativeSigningEnvelope.result(envelope,task,signature,child.account,walletProtocol)),"NATIVE_WORKFLOW_MESSAGE_RESULT")
   w.completedResults[step["id"] as String]=result;nextWorkflowStep(w,index);complete(Result.success(true))
  }
 }
 private fun <T> reviewedCompute(o:Operation,method:String,args:Map<String,Any?>,finish:(Map<String,Any?>)->T,complete:(Result<T>)->Unit){
  current(o);val computer=reviewedComputer?:throw NativeCustodyFailure("NATIVE_COMPUTE_REQUIRED")
  need(o.id !in o.session.pending,"NATIVE_COMPUTE_PENDING")
  val input=canonical(args);need(input.toByteArray(Charsets.UTF_8).size<=16*1024*1024,"NATIVE_COMPUTE_BOUND")
  var done=false
  fun result(value:Result<T>){if(done)return;done=true;o.session.pending.remove(o.id);complete(value)}
  o.session.pending[o.id]={result(Result.failure(NativeCustodyFailure("NATIVE_CANCELLED")))}
  try{computer.call(method,input){reply->
   onExecutor();if(!done)result(runCatching{
    current(o);if(o.receipt!=null)receipt(o)
    val text=reply.getOrThrow();need(text.toByteArray(Charsets.UTF_8).size<=32*1024*1024,"NATIVE_COMPUTE_BOUND")
    finish(PermissionJson.records("[$text]").single())
   })
  }}catch(e:Exception){result(Result.failure(e))}
 }
 fun bindReviewed(owner:String,scope:Map<String,String>,id:String,binding:Map<String,Any?>,preview:Map<String,Any?>,plan:Map<String,Any?>,packet:Map<String,Any?>,complete:(Result<Map<String,Any?>>)->Unit){
  val o=operation(owner,scope,id);need(o.method==NativeReviewed.method&&o.approved&&o.receipt==null&&o.reviewedBound==null,"NATIVE_REVIEWED_STATE")
  val request=o.request?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED");val consent=o.reviewedConsent?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
  val b=immutable(binding);val v=immutable(preview);val p=immutable(plan)
  val bound=NativeReviewed.bind(request,context(o.session),o.account,consent,p,v,packet,Instant.parse(map(b["payload"])["expiresAt"] as String))
  reviewedCompute(o,"prepareReviewedStage",bound.prepare(0,emptyList()),{actual->
   o.reviewedTasks=bound.tasks(actual,bound.claimedStage,0);o.reviewedStage=immutable(actual);o.reviewedBound=bound
   try{bind(owner,scope,id,b,v,p,null)}catch(e:Exception){o.reviewedBound=null;o.reviewedStage=null;o.reviewedTasks=emptyList();throw e}
  },complete)
 }
 fun advanceReviewed(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,pending:Map<String,Any?>,complete:(Result<Boolean>)->Unit){
  val o=signingOperation(owner,scope,id);receipt(o)
  val bound=o.reviewedBound?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED");val previousStage=o.reviewedStage?:throw NativeCustodyFailure("NATIVE_REVIEW_REQUIRED")
  need(o.method==NativeReviewed.method&&canonical(receipt)==canonical(o.receipt)&&o.completed==o.tasks.keys&&o.stage+1<o.transactionCount,"NATIVE_STAGE_INCOMPLETE")
  val p=immutable(pending);val index=o.stage+1
  need(p.keys==setOf("kind","planHash","stageIndex","previousTransactions","stage","signingRequests")&&p["kind"]=="reviewed"&&p["planHash"]==bound.planHash&&integer(p["stageIndex"])==index,"NATIVE_STAGE_BINDING")
  val signatures=o.reviewedTasks.map{o.reviewedSignatures[it["taskId"]]?:throw NativeCustodyFailure("NATIVE_STAGE_INCOMPLETE")}
  reviewedCompute(o,"finalizeReviewedStage",mapOf("stage" to previousStage,"signatures" to signatures,"signatureEncoding" to "compact64"),{finalized->
   if(!bound.associated)o.reviewedDetached[o.stage]=finalized["sigs"]
   o.reviewedParents+listOf(finalized["txraw"] as? String?:throw NativeCustodyFailure("NATIVE_PARENT_CHANGED"))
  }){result->
   try{
    val parents=result.getOrThrow();need(canonical(p["previousTransactions"])==canonical(parents),"NATIVE_PARENT_CHANGED")
    reviewedCompute(o,"prepareReviewedStage",bound.prepare(index,if(bound.associated)parents else emptyList()),{actual->
     val tasks=bound.tasks(actual,map(p["stage"]),index)
     need(canonical(tasks)==canonical(p["signingRequests"])&&o.tasks.size+tasks.size<=o.expectedTasks,"NATIVE_STAGE_TASKS")
     for(task in tasks){val key=task["taskId"] as String;need(key !in o.tasks,"NATIVE_TASK_DUPLICATE");o.tasks[key]=task}
     o.stage=index;o.reviewedStage=immutable(actual);o.reviewedTasks=tasks;o.reviewedParents=parents;o.reviewedSignatures.clear();true
    },complete)
   }catch(e:Exception){complete(Result.failure(e))}
  }
 }
 // Private trusted-worker call only, after Engine validate(finalized,pending).
 // Engine verifies signed parents/digests; custody independently fences the
 // original receipt, plan, stage order and one-use tasks. No second approval.
 fun advance(owner:String,scope:Map<String,String>,id:String,
  receipt:Map<String,Any?>,pending:Map<String,Any?>){
  val o=signingOperation(owner,scope,id);receipt(o)
  need(NativePrepared.transaction(o.method)&&canonical(receipt)==canonical(o.receipt),"NATIVE_RECEIPT_CHANGED")
  need(id !in o.session.pending&&o.completed==o.tasks.keys&&o.completed.size<o.expectedTasks,"NATIVE_STAGE_INCOMPLETE")
  val p=immutable(pending);val c=map(p["continuation"]);val s=map(c["signingStage"]);val inner=map(s["continuation"])
  val stage=integer(c["stage"]);val session=c["sessionId"] as String;val commitment=c["stageCommitment"] as String
  digest(session);digest(commitment)
  val profile=map(o.request!!["intent"])["type"]
  // Match the pinned Engine's outer-request family, not the resolved asset:
  // direct AMM/LP is pool; unified amm.*/tbc20Lp.* aliases retain ft.
  val poolFamily=profile=="tbc-amm-create"||(poolContinuation(profile)&&(profile as? String)?.startsWith("tbc-amm-")==true)||(lpContinuation(profile)&&(profile as? String)?.startsWith("tbc20-lp-")==true)
  val family=when{profile=="tbc721-standard-batch-mint"->"nft";poolFamily->"pool";else->"ft"}
  need(p["status"]=="pending"&&c["version"]=="1.0"&&c["method"]=="finalize"&&c["family"]==family,"NATIVE_STAGE_KIND")
  need(c["requestHash"]==o.requestHash&&c["planHash"]==o.planHash&&c["bindingHash"]==o.receipt!!["bindingHash"]&&c["approvalId"]==o.receipt!!["approvalId"],"NATIVE_STAGE_BINDING")
  need(stage==o.stage+1&&stage<o.transactionCount&&(o.stageSession==null||o.stageSession==session)&&s["sessionId"]==session&&integer(s["stage"])==stage&&s["stageCommitment"]==commitment&&inner["sessionId"]==session&&inner["planCommitment"]==session&&integer(inner["nextStage"])==stage,"NATIVE_STAGE_ORDER")
  val tasks=(p["signingRequests"] as List<*>).map{map(it)};val requests=(s["signingRequests"] as List<*>).map{map(it)}
  val limit=if(poolContinuation(profile)||lpContinuation(profile))128 else mapOf("tbc20.transfer" to 32,"tbc20.merge" to 32,"tbc20-standard-create" to 128,"tbc721.batchTransfer" to 128,"tbc721-standard-batch-mint" to 128,"tbc-amm-create" to 128)[profile]?:0
  need(tasks.isNotEmpty()&&tasks.size<=limit&&tasks.size==requests.size&&o.tasks.size+tasks.size<=o.expectedTasks,"NATIVE_TASKS")
  val validated=mutableMapOf<String,Map<String,Any?>>()
  for((t,r) in tasks.zip(requests)){
   val tx=t["transactionTemplateId"] as String;val index=integer(t["inputIndex"]);val taskId=t["taskId"] as String
   need(index in 0..127&&tx in o.transactionIds&&taskId=="sign-$tx-input-$index"&&taskId !in o.tasks&&taskId !in validated,"NATIVE_TASK_DUPLICATE")
   val account=taskAccount(o,t)
   need(t["purpose"]=="transaction"&&t["signatureEncoding"]=="compact64"&&t["algorithm"]=="secp256k1-ecdsa-sha256d"&&integer(t["sighashType"])==65,"NATIVE_TASK_ACCOUNT")
   digest(t["digest"] as String)
   need(r["transactionId"]==tx&&integer(r["inputIndex"])==index&&r["digest"]==t["digest"]&&r["publicKey"]==account.publicKey&&r["algorithm"]=="secp256k1-ecdsa"&&integer(r["sighashType"])==65&&integer(r["stage"])==stage&&r["sessionId"]==session&&r["stageCommitment"]==commitment,"NATIVE_STAGE_TASK_BINDING")
   validated[taskId]=t
  }
  o.tasks.putAll(validated);o.stage=stage;o.stageSession=session
 }
 private fun receipt(o:Operation){
  current(o);need(o.approved&&o.receipt!=null,"NO_RECEIPT")
  need(Instant.now().isBefore(Instant.parse(o.receipt!!["expiresAt"] as String)),"NATIVE_EXPIRED")
 }
 fun sign(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,
  task:Map<String,Any?>,complete:(Result<Map<String,Any?>>)->Unit){
  val o=signingOperation(owner,scope,id);receipt(o)
  need(o.method !in NativeCrypto.methods,"NATIVE_CRYPTO_NOT_DIGEST")
  need(canonical(receipt)==canonical(o.receipt),"NATIVE_RECEIPT_CHANGED")
  val t=immutable(task);val taskId=t["taskId"] as String
  need(!o.signerUnavailable&&canonical(t)==canonical(o.tasks[taskId])&&id !in o.session.pending&&o.consumed.add(taskId),"NATIVE_TASK_CHANGED_OR_REPLAY")
  val encoding=t["signatureEncoding"] as String;var done=false
  fun result(value:Result<Map<String,Any?>>){onExecutor();if(done)return;done=true;o.session.pending.remove(id);runCatching{complete(value)}}
  o.session.pending[id]={result(Result.failure(NativeCustodyFailure("NATIVE_CANCELLED")))}
  try{
   signer.sign(taskAccount(o,t),digest(t["digest"] as String),encoding,{receipt(o)}){signed->
    onExecutor();if(!done)result(runCatching{
     receipt(o)
     val bound=o.workflowParent?.workflow?.bound
     if(signed.exceptionOrNull() is NativeSignerUnavailable&&bound!=null&&map(bound.plan["payload"])["failureMode"]=="continue-independent"){
      o.signerUnavailable=true;throw NativeWorkflowStepUnavailable()
     }
     val signature=signed.getOrThrow();need(signature.size==if(encoding=="compact64")64 else 65,"NATIVE_SIGNATURE_ENCODING")
     o.completed.add(taskId);if(o.method==NativeReviewed.method)o.reviewedSignatures[taskId]=hex(signature)
     val value=mapOf("taskId" to taskId,"signatureEncoding" to encoding,"signature" to hex(signature))
     if(o.workflowParent!=null)o.signedResults[taskId]=value;value
    })
   }
  }catch(e:Exception){result(Result.failure(e))}
 }
 // Existing approval owner, but a separate Vault primitive, never a digest.
 fun executeCrypto(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,task:Map<String,Any?>,complete:(Result<Map<String,Any?>>)->Unit){
  val o=signingOperation(owner,scope,id);receipt(o)
  val executor=crypto?:throw NativeCustodyFailure("NATIVE_CRYPTO_UNAVAILABLE")
  need(o.method in NativeCrypto.methods,"NATIVE_CRYPTO_UNAVAILABLE")
  val t=immutable(task);val taskId=t["taskId"] as String
  need(canonical(receipt)==canonical(o.receipt)&&canonical(t)==canonical(o.tasks[taskId])&&id !in o.session.pending&&o.consumed.add(taskId),"NATIVE_TASK_CHANGED_OR_REPLAY")
  val input=NativeCrypto.input(t);var done=false
  fun result(value:Result<Map<String,Any?>>){onExecutor();if(done)return;done=true;o.session.pending.remove(id);runCatching{complete(value)}}
  o.session.pending[id]={result(Result.failure(NativeCustodyFailure("NATIVE_CANCELLED")))}
  try{executor.execute(o.account,if(o.method=="tbc_encrypt")NativeCryptoPurpose.ENCRYPT else NativeCryptoPurpose.DECRYPT,input,{receipt(o)}){reply->
   onExecutor();val output=reply.getOrNull()
   try{if(!done)result(runCatching{
    receipt(o)
    val bound=o.workflowParent?.workflow?.bound
    if(reply.exceptionOrNull() is NativeCryptoUnavailable&&bound!=null&&map(bound.plan["payload"])["failureMode"]=="continue-independent"){
     o.cryptoUnavailable=true;throw NativeWorkflowCryptoUnavailable()
    }
    reply.getOrThrow();val value=NativeCrypto.result(t,output!!)
    o.cryptoResultHash=hash(if(o.workflowParent==null)NativeCrypto.publicResult(value,o.account)else value);o.completed.add(taskId);value
   })}finally{input.fill(0);output?.fill(0)}
  }}catch(e:Exception){input.fill(0);result(Result.failure(e))}
 }
 // Native-owned reconstruction shared by sign delivery and send authorization.
 private fun completedWorkflow(o:Operation):Map<String,Any?>{
  receipt(o);val w=o.workflow?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INCOMPLETE");val bound=w.bound?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INCOMPLETE")
  need(w.activeIndex==null&&w.nextIndex==w.children.size&&w.completedResults.size+w.unavailableResults.size==w.children.size&&o.id !in o.session.pending,"NATIVE_WORKFLOW_INCOMPLETE")
  val p=map(bound.plan["payload"]);val rows=w.steps.map{step->w.unavailableResults[step["id"] as String]?:run{val result=w.completedResults[step["id"] as String]?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INCOMPLETE");mapOf("id" to step["id"],"kind" to step["kind"],"result" to result)}}
  return mapOf("version" to "1.0","chainId" to o.account.chainId,"from" to o.account.address,"requestHash" to p["requestHash"],"workflowPlanHash" to bound.plan["workflowPlanHash"],"approvalId" to o.receipt!!["approvalId"],"failureMode" to p["failureMode"],"steps" to rows,"totalFee" to p["totalFee"])
 }
 // Trusted worker only, after common Engine final/pre-broadcast verification.
 // Retain exact completed material once; never expose a page raw-send bypass.
 fun authorizeBroadcast(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,bundle:Map<String,Any?>,workflow:Map<String,Any?>?=null){
  val o=operation(owner,scope,id);receipt(o)
  val source=sendSourceIdentity?:throw NativeCustodyFailure("NATIVE_BROADCAST_UNAVAILABLE")
  need(NativePrepared.sends(o.method)&&o.sendMaterial==null&&canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
  val value=immutable(bundle);val w=o.workflow
  val transactions=if(w!=null){
   val expected=completedWorkflow(o);need(canonical(workflow)==canonical(expected),"NATIVE_BROADCAST_WORKFLOW")
   val bound=w.bound?:throw NativeCustodyFailure("NATIVE_WORKFLOW_INCOMPLETE")
   val order=(map(bound.plan["payload"])["stepOrder"] as List<*>).map{it as String};val rows=(expected["steps"] as List<*>).map{map(it)}
   val txs=order.flatMap{stepId->
    val row=rows.singleOrNull{it["id"]==stepId}?:throw NativeCustodyFailure("NATIVE_BROADCAST_WORKFLOW")
    if(row["kind"] in setOf("transaction","preparedTransaction","reviewedTransaction")&&row["result"]!=null)(map(row["result"])["transactions"] as List<*>).map{map(it)}else emptyList()
   }
   val projected=mapOf("version" to "1.0","chainId" to expected["chainId"],"from" to expected["from"],"requestHash" to expected["requestHash"],"approvalId" to expected["approvalId"],"transactions" to txs,"totalFee" to expected["totalFee"])
   need(canonical(value)==canonical(projected),"NATIVE_BROADCAST_WORKFLOW");txs
  }else{
   val plan=o.sendPlan?:throw NativeCustodyFailure("NATIVE_BROADCAST_PLAN")
   need(workflow==null&&fullySigned(o),"NATIVE_STAGE_INCOMPLETE")
   NativeWorkflow.completedBundle(value,o.account,o.requestHash!!,receipt["approvalId"] as String,plan["totalFee"] as String,(plan["transactions"] as List<*>).map{map(it)},null,bundleLimit(o.request))
  }
  val ids=transactions.map{it["txid"] as String}
  need(ids.size in 1..(if(o.workflow==null)bundleLimit(o.request)else 32)&&ids.toSet().size==ids.size&&transactions.all{(it["rawTransaction"] as String).length<=4*1024*1024},"NATIVE_BROADCAST_BOUNDS")
  val accountHash=hash(o.account.identity());val authorization=hash(mapOf("method" to o.method,"sourceIdentity" to source,"accountScopeHash" to accountHash,"contextHash" to hash(context(o.session)),"operationId" to id,"approvalId" to receipt["approvalId"],"bindingHash" to receipt["bindingHash"],"bundleHash" to hash(value)))
  o.sendMaterial=mapOf("bundle" to value,"sourceIdentity" to source,"accountScopeHash" to accountHash,"authorizationId" to authorization,"expiresAt" to receipt["expiresAt"])
 }
 // Read-only native selection, not a dispatch permit. Actual HTTP admission
 // must fence again on this executor; callers cannot replace retained bytes.
 fun broadcastSelection(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,index:Int?):Map<String,Any?>{
  val o=operation(owner,scope,id);receipt(o);val material=o.sendMaterial?:throw NativeCustodyFailure("NATIVE_BROADCAST_NOT_AUTHORIZED")
  need(NativePrepared.sends(o.method)&&o.sendResultHash==null&&canonical(receipt)==canonical(o.receipt)&&material["sourceIdentity"]==sendSourceIdentity,"NATIVE_BROADCAST_AUTHORITY")
  val all=(map(material["bundle"])["transactions"] as List<*>).map{map(it)}
  val selected=if(index!=null){need(o.workflow==null&&index in all.indices,"NATIVE_BROADCAST_SELECTION");listOf(all[index])}else{need(o.workflow!=null,"NATIVE_BROADCAST_SELECTION");all}
  return immutable(material.filterKeys{it!="bundle"}+mapOf("method" to o.method,"transactions" to selected))
 }
 // Close revokes signing authority. A fully signed result keeps only an epoch
 // permit for native emission; the tasks, receipt and request are discarded.
 fun broadcastCurrent(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,authorizationId:String){
  val o=operation(owner,scope,id);receipt(o)
  need(o.sendResultHash==null&&o.sendMaterial?.get("authorizationId")==authorizationId&&canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
 }
 fun broadcastAuthorization(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>):String{
  val o=operation(owner,scope,id);receipt(o);need(o.sendResultHash==null&&canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_AUTHORITY")
  return o.sendMaterial?.get("authorizationId") as? String?:throw NativeCustodyFailure("NATIVE_BROADCAST_NOT_AUTHORIZED")
 }
 // Native-only cleanup; never accept a caller assertion of POST=0.
 fun ownBroadcast(owner:String,scope:Map<String,String>,id:String,key:String,state:()->List<Map<String,String>>,close:()->Unit,recoveryId:String?=null){
  val o=operation(owner,scope,id);receipt(o)
  need(o.sendMaterial!=null&&key !in o.broadcastClosers&&o.broadcastClosers.size<(if(o.workflow==null)bundleLimit(o.request)else 32),"NATIVE_BROADCAST_OWNER")
  o.broadcastClosers[key]=close;o.broadcastStates[key]=state
  if(o.maintenance!=null&&key=="single:0")o.maintenanceRecoveryId=recoveryId
  if(o.mintJob!=null&&recoveryId!=null)o.mintRecovery[key]=recoveryId
 }
 private fun closeBroadcasts(o:Operation){val callbacks=o.broadcastClosers.values.toList();o.broadcastClosers.clear();o.broadcastStates.clear();callbacks.forEach{runCatching{it()}}}
 // Native signed material + actual journal outcome -> immutable public result.
 // No network, new approval, or additional durable result record is created.
 fun finishBroadcast(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,result:Map<String,Any?>){
  val o=operation(owner,scope,id);receipt(o)
  need(NativePrepared.sends(o.method)&&o.sendResultHash==null&&canonical(receipt)==canonical(o.receipt),"NATIVE_BROADCAST_RESULT")
  val material=o.sendMaterial?:throw NativeCustodyFailure("NATIVE_BROADCAST_NOT_AUTHORIZED")
  val bundle=map(material["bundle"]);val txs=(bundle["transactions"] as List<*>).map{map(it)}
  val keys=if(o.workflow==null)txs.indices.map{"single:$it"}else listOf("batch")
  need(o.broadcastStates.keys==keys.toSet(),"NATIVE_BROADCAST_RESULT")
  val states=keys.flatMap{o.broadcastStates.getValue(it)()}
  need(states.size==txs.size&&states.zip(txs).all{(state,tx)->state["txid"]==tx["txid"]},"NATIVE_BROADCAST_RESULT")
  if(o.workflow==null){
   need(states.all{it["status"] in setOf("accepted","known")},"NATIVE_BROADCAST_RESULT")
   val expected=bundle+mapOf("transactions" to txs.map{tx->mapOf("id" to tx["id"],"txid" to tx["txid"],"status" to "submitted","role" to tx["role"],"dependsOn" to tx["dependsOn"])})
   need(canonical(result)==canonical(expected),"NATIVE_BROADCAST_RESULT")
  }else{
   val rows=(result["transactions"] as? List<*>)?.map{map(it)}?:throw NativeCustodyFailure("NATIVE_BROADCAST_RESULT")
   need(rows.size==txs.size,"NATIVE_BROADCAST_RESULT")
   val byId=mutableMapOf<String,String>();val statuses=mutableSetOf<String>()
   txs.forEachIndexed{i,tx->
    val row=rows[i];var status=states[i].getValue("status")
    val blocked=(tx["dependsOn"] as List<*>).any{byId[it] in setOf("rejected","unknown")}
    if(blocked&&status in setOf("accepted","known"))status="unknown"
    need(row.keys.all{it in setOf("txid","status","reason")}&&row["txid"]==tx["txid"]&&row["status"]==status,"NATIVE_BROADCAST_RESULT")
    if("reason" in row)need((row["reason"] as? String)?.let{it.length<=512}==true,"NATIVE_BROADCAST_RESULT")
    byId[tx["id"] as String]=status;statuses+=status
   }
   val status=when{statuses.all{it in setOf("accepted","known")}->"complete";statuses==setOf("rejected")->"rejected";statuses==setOf("unknown")->"unknown";else->"partial"}
   val expected=mapOf("version" to "1.0","status" to status,"workflow" to completedWorkflow(o),"transactions" to rows)
   need(canonical(result)==canonical(expected),"NATIVE_BROADCAST_RESULT")
  }
  val resultHash=hash(result)
  o.maintenance?.let{m->
   val fee=o.maintenanceFee?:throw NativeCustodyFailure("NATIVE_MERGE_RESULT");need(txs.size==1,"NATIVE_MERGE_RESULT");val txid=txs[0]["txid"] as String
   need(fee<=m.maxFee-m.spent&&txid !in m.accepted,"NATIVE_MERGE_RESULT");m.spent+=fee;m.accepted+=txid;m.consumedInputs+=o.maintenanceBoundInputs;m.nextIndex++
   val step=o.maintenanceStep!!
   m.completedRows+=mapOf("stepId" to step["stepId"],"txid" to txid,"status" to states[0]["status"],"fee" to fee.toString(),"inputCount" to step["inputCount"],"outputCount" to 1,"dependsOn" to step["dependsOn"])
  }
  // Native-verified outcomes survive normal dispatch-authority closure.
  if(o.mintJob!=null)o.mintOutcomes=states
  o.sendResultHash=resultHash
 }
 fun close(owner:String,scope:Map<String,String>,id:String){
  val s=session(owner,scope);val o=s.operations[id]?:return
  var workflowHash:String?=null
  val deliverable=runCatching{
   current(o)
   // Signature completion alone never grants a send-result delivery permit.
   if(NativePrepared.sends(o.method)){receipt(o);o.sendResultHash!=null}
   else if(o.workflow!=null){
    workflowHash=hash(completedWorkflow(o));true
   }else if(o.method in NativeCrypto.methods){receipt(o);fullySigned(o)&&o.cryptoResultHash!=null}else fullySigned(o)
  }.getOrDefault(false)
  if(deliverable&&(o.method!=NativeReviewed.method||o.stage==o.transactionCount-1))s.results[id]=DeliveryPermit(o.revision,o.accountRevision,o.account,o.epoch,NativePrepared.permission(o.method),o.controller,if(workflowHash!=null)o.method else null,workflowHash,if(o.cryptoResultHash!=null)o.method else null,o.cryptoResultHash,if(o.sendResultHash!=null)o.method else null,o.sendResultHash)
  o.maintenance?.let{m->
   if(!deliverable&&o.sendResultHash==null){
    m.failedStep=o.maintenanceStep
    // Only absence of a native dispatch owner proves pre-submit failure.
    m.failureMayHaveSubmitted=o.broadcastStates.isNotEmpty()
    m.failureRecoveryId=o.maintenanceRecoveryId
   }
   m.activeChild=null;if(!deliverable)m.stopped=true
  }
  captureMintBatch(o)
  if(o.mintJob!=null)s.results.remove(id)
  s.operations.remove(id);closeBroadcasts(o);s.pending.remove(id)?.invoke()
 }
 // Native WebView emission must call this immediately before releasing a
 // successful signing result. ACK/disposal releases it via forgetResult.
 private fun verifiedDelivery(owner:String,scope:Map<String,String>,id:String):DeliveryPermit{
  val s=session(owner,scope);val p=s.results[id]?:throw NativeCustodyFailure("NO_DELIVERY_PERMIT")
  current(s,p.revision,p.account,p.accountRevision,id)
  permissions.require(s.scope.getValue("origin"),p.capability,permissionAccount(p.account))
  p.controller?.let{requireActive(s,it);permissions.require(s.scope.getValue("origin"),p.capability,it)}
  if(p.sendResultHash!=null||p.maintenanceResultHash!=null)permissions.require(s.scope.getValue("origin"),"tbc_sendTransaction",permissionAccount(p.account))
  need(permissions.epoch(s.scope.getValue("origin"))==p.epoch);return p
 }
 fun mayDeliverSignature(owner:String,scope:Map<String,String>,id:String):Boolean=runCatching{val p=verifiedDelivery(owner,scope,id);p.workflowResultHash==null&&p.cryptoResultHash==null&&p.sendResultHash==null&&p.maintenanceResultHash==null}.getOrDefault(false)
 fun mayDeliverMaintenanceResult(owner:String,scope:Map<String,String>,id:String,resultHash:String):Boolean=runCatching{verifiedDelivery(owner,scope,id).maintenanceResultHash==resultHash}.getOrDefault(false)
 // Informational progress cannot replace the native-attested submission core.
 fun maintenanceProjectionHash(owner:String,scope:Map<String,String>,id:String,result:Any?):String{
  val permit=verifiedDelivery(owner,scope,id);val core=map(result).toMutableMap()
  need(core.remove("atomic")==false,"NATIVE_MERGE_PROGRESS")
  val progress=core.remove("progress") as? List<*>?:throw NativeCustodyFailure("NATIVE_MERGE_PROGRESS")
  val target=permit.maintenanceTarget?:throw NativeCustodyFailure("NATIVE_MERGE_PROGRESS")
  val digest=hash(core);need(digest==permit.maintenanceResultHash&&progress.size in 1..4096,"NATIVE_MERGE_PROGRESS")
  val steps=core["steps"] as List<*>;val total=amount(core["totalFee"])
  val initial=canonical(core["initialUtxoCount"]).toLong();val final=canonical(core["finalUtxoCount"]).toLong()
  var previousIndex=0;var previousCount=0;var previousFee=java.math.BigInteger.ZERO
  progress.forEachIndexed{position,value->
   val row=map(value);need(row.keys==setOf("phase","stepIndex","utxoCount","targetUtxoCount","transactionCount","totalFee"),"NATIVE_MERGE_PROGRESS")
   val phase=row["phase"];val index=integer(row["stepIndex"]);val count=integer(row["transactionCount"])
   val utxos=canonical(row["utxoCount"]).toLongOrNull()?:throw NativeCustodyFailure("NATIVE_MERGE_PROGRESS");val fee=amount(row["totalFee"])
   need(phase in setOf("approval","preparing","executing","reconciling","indexing","complete")&&integer(row["targetUtxoCount"])==target&&index in previousIndex..64&&count in previousCount..steps.size&&utxos in 0..9007199254740991L&&fee>=previousFee&&fee<=total,"NATIVE_MERGE_PROGRESS")
   if(phase=="approval")need(position==0&&index==0&&count==0&&fee==java.math.BigInteger.ZERO&&utxos==initial,"NATIVE_MERGE_PROGRESS")
   if(phase=="complete")need(position==progress.size-1&&core["status"]=="complete"&&count==steps.size&&utxos==final&&fee==total,"NATIVE_MERGE_PROGRESS")
   previousIndex=index;previousCount=count;previousFee=fee
  }
  need(map(progress.first())["phase"]==(if(core["approvalId"]==null)"complete" else "approval")&&(core["status"]!="complete"||map(progress.last())["phase"]=="complete"),"NATIVE_MERGE_PROGRESS")
  return digest
 }
 fun mayDeliverSendResult(owner:String,scope:Map<String,String>,id:String,method:String,resultHash:String):Boolean=runCatching{
  need(NativePrepared.sends(method));val p=verifiedDelivery(owner,scope,id);p.sendMethod==method&&p.sendResultHash==resultHash
 }.getOrDefault(false)
 fun mayDeliverCryptoResult(owner:String,scope:Map<String,String>,id:String,method:String,resultHash:String):Boolean=runCatching{
  need(method in NativeCrypto.methods);val p=verifiedDelivery(owner,scope,id);p.cryptoMethod==method&&p.cryptoResultHash==resultHash
 }.getOrDefault(false)
 fun mayDeliverWorkflowResult(owner:String,scope:Map<String,String>,id:String,method:String,resultHash:String):Boolean=runCatching{
  need(method in NativeWorkflow.methods);val p=verifiedDelivery(owner,scope,id);p.workflowMethod==method&&p.workflowResultHash==resultHash
 }.getOrDefault(false)
 fun forgetResult(owner:String,scope:Map<String,String>,id:String){session(owner,scope).results.remove(id)}
 private fun pool2Description(i:Map<String,Any?>,request:Map<String,Any?>):String{
  val pool=i["poolContractId"] as String;digest(pool)
  val detail=when(i["type"]){
   "tbc.pool.swap.exactTbcForToken"->"Buy FT: input ${amount(i["tbcAmount"])} TBC atomic; minimum FT ${amount(i["minimumFtAmount"])} atomic."
   "tbc.pool.swap.exactTokenForTbc"->"Sell FT: input ${amount(i["ftAmount"])} FT atomic; minimum TBC ${amount(i["minimumTbcAmount"])} atomic."
   "tbc.pool.liquidity.add"->"Add liquidity: ${amount(i["tbcAmount"])} TBC atomic plus proportional pooled FT from this account; minimum LP ${amount(i["minimumLpAmount"])} atomic."
   "tbc.pool.liquidity.remove"->"Remove liquidity: ${amount(i["lpAmount"])} LP atomic; minimum TBC ${amount(i["minimumTbcAmount"])} atomic; minimum FT ${amount(i["minimumFtAmount"])} atomic."
   "tbc.pool.ft.merge","amm.mergeToken"->"Merge up to four Pool-held FT inputs; tokens stay in this pool."
   "tbc.pool.ftlp.merge"->"Merge up to five mature LP inputs into the same account: ${request["from"] as String}."
   "tbc.pool.ftlp.burn","tbc20Lp.burn"->"Permanently destroy the full balance of up to five selected unlocked LP inputs from ${request["from"] as String}. This is not a liquidity withdrawal: no TBC or FT reserves are returned."
   else->throw NativeCustodyFailure("UNSUPPORTED_INTENT")
  }
  val expiry=map(request["constraints"])["expiresAt"]?.let{"\nRequest expires: ${it as String}."}?:""
  val receiver=i["receiver"]?.let{"\nReceiver: ${it as String}."}?:""
  val label=if((i["type"] as String).startsWith("tbc.pool."))"Existing Pool2" else "Pool"
  return "$label $pool.\n$detail"+receiver+expiry+"\nUse authenticated Pool fees and fresh reserves; actual asset amounts, minimum outputs and required bounds are validated before signing."
 }
 private fun lopDescription(i:Map<String,Any?>,owner:String):String{
  if(i["type"]=="tbc-lop-create"){
   val o=map(i["order"]);val side=o["side"] as String;val market=o["market"] as String
   need(side in setOf("buy","sell")&&market in setOf("native-token","token-token")&&(market=="token-token")== (o["assetB"] is Map<*,*>),"LOP_ORDER")
   fun asset(v:Any?):String{val a=map(v);val standard=a["standard"] as String;val id=a["contractId"] as String;digest(id);need(standard in setOf("tbc20-standard","tbc20-stablecoin"),"LOP_ASSET");return "$standard $id"}
   val a=asset(o["assetA"]);val b=o["assetB"]?.let{asset(it)}
   val base=if(market=="native-token")"TBC" else a;val quote=b?:a
   val volume=amount(o["saleVolume"]);val price=amount(o["unitPrice"]);val rate=amount(o["feeRate"])
   need(volume>java.math.BigInteger.ZERO&&price>java.math.BigInteger.ZERO&&listOf(volume,price,rate).all{it<=java.math.BigInteger("9223372036854775807")},"LOP_AMOUNT")
   val escrow=if(side=="sell")"$volume base atomic" else "floor($volume * $price / 1000000) quote atomic"
   val deposits=if(side=="sell"&&market=="native-token")"" else "\nToken orders also use native contract deposits (300 order atomic and 500 per token holding), separate from network fees."
   return "Create LOP $side order ($market).\nOwner: $owner.\nBase: $base.\nQuote: $quote.\nVolume: $volume base atomic; unit price: $price / 1000000 quote atomic per base atomic.\nOrder amount: $escrow.\nSettlement fee rate: $rate / 1000000; fee recipient: ${o["feeRecipient"] as String}.\nOnly the owner can cancel the remaining order.$deposits"
  }
  val cancel=i["type"]=="tbc-lop-cancel"
  val points=i["targetOutpoints"] as? List<*>?:throw NativeCustodyFailure("LOP_SELECTION")
  need(points.size==if(cancel)1 else 2,"LOP_SELECTION")
  val labels=points.map{v->val p=map(v);val id=p["txid"] as String;digest(id);val index=amount(p["vout"]?.toString());need(index<=java.math.BigInteger("4294967295"),"LOP_SELECTION");"$id:$index"}
  need(labels.toSet().size==labels.size,"LOP_SELECTION")
  val detail=if(cancel)"Cancel only this exact order and return its remaining assets to the same owner: $owner." else "Match only these exact orders in buy/sell order. Matcher and network fee payer: $owner. Committed order owners, assets, price, settlement fees and any remaining order are validated; they cannot be overridden. The matcher must differ from both order owners."
  return "LOP\n$detail\n${labels.joinToString("\n")}\nFresh order and paired asset availability are checked before signing. No other orders are swept."
 }
 private fun htlcDescription(i:Map<String,Any?>,r:Map<String,Any?>,owner:String):String{
  val standard=i["assetStandard"] as? String;val token=standard!=null
  need(!token||standard in setOf("tbc20-standard","tbc20-stablecoin"),"HTLC_TOKEN_STANDARD")
  val asset=if(token){val id=i["contractId"] as String;digest(id);"$standard token $id"}else "TBC"
  if(i["type"]=="tbc-htlc-lock"){
   val lock=amount(i["lockTime"]);need(lock>java.math.BigInteger.ZERO&&lock<=java.math.BigInteger("2147483647"),"HTLC_LOCK_DOMAIN")
   val hashlock=i["hashlock"] as String;digest(hashlock)
   return "Lock ${amount(i["amount"])} $asset atomic.\nReceiver: ${i["to"] as String}. Sender/refund owner: $owner.\nHashlock: $hashlock.\nRefund threshold: $lock ${if(lock<java.math.BigInteger("500000000"))"block height (inclusive)" else "chain median time (strictly greater, not local time)"}. Claim by the receiver with the proof remains possible after this threshold."
  }
  val points=(if(token)i["targetOutpoints"] else map(r["constraints"])["inputOutpoints"]) as? List<*>?:throw NativeCustodyFailure("HTLC_SELECTION")
  need(points.isNotEmpty()&&points.size<=if(token)1 else 128,"HTLC_SELECTION")
  val labels=points.map{value->val p=map(value);val id=p["txid"] as String;digest(id);val vout=amount(p["vout"]?.toString());need(vout<=java.math.BigInteger("4294967295")&&(!token||vout==java.math.BigInteger.ONE),"HTLC_SELECTION");"$id:$vout"}
  need(labels.toSet().size==labels.size,"HTLC_SELECTION")
  val claim=i["type"]=="tbc-htlc-claim"
  val disclosure=if(claim)"WARNING: Returning signed claim transactions reveals the preimage to the requesting DApp and anyone it shares them with, before broadcast. The preimage is not displayed here." else "Refund requires the sender role and mature chain height or median time; local time is not authority."
  val detail=if(token)"Full balance of selected $asset holding and its paired native escrow; both are validated and spent together." else "Selected native HTLC deposits."
  return "${if(claim)"Claim" else "Refund"} only these ${labels.size} deposits to $owner.\n$detail\n${labels.joinToString("\n")}\n$disclosure\nNo other deposits are swept."
 }
 private fun timelockDescription(i:Map<String,Any?>,r:Map<String,Any?>,owner:String):String{
  if(i["type"]=="tbc-timelock-lock"){
   val height=amount(i["lockTime"]);need(height>java.math.BigInteger.ZERO && height<java.math.BigInteger("500000000"),"TIMELOCK_HEIGHT_DOMAIN")
   return "Lock ${amount(i["amount"])} TBC atomic to the same owner: $owner.\nUnlock no earlier than block height $height, not a timestamp. The bound chain tip and lock conditions are checked before signing."
  }
  val points=map(r["constraints"])["inputOutpoints"] as? List<*>?:throw NativeCustodyFailure("TIMELOCK_SELECTION")
  need(points.isNotEmpty()&&points.size<=128,"TIMELOCK_SELECTION")
  val labels=points.map{value->val p=map(value);val id=p["txid"] as String;digest(id)
   val vout=amount(p["vout"]?.toString());need(vout<=java.math.BigInteger("4294967295"),"TIMELOCK_SELECTION");"$id:$vout"}
  need(labels.toSet().size==labels.size,"TIMELOCK_SELECTION")
  return "Unlock only these ${labels.size} selected TimeLock deposits to the same owner: $owner.\n${labels.joinToString("\n")}\nDeposit ownership and block-height maturity are checked against authenticated material before signing. No other deposits are swept."
 }
 private fun lpDescription(i:Map<String,Any?>,owner:String):String{
  val pool=i["poolContractId"] as String
  val detail=when(i["type"]){
   "tbc20-lp-transfer","tbc20Lp.transfer"->"Transfer ${i["amount"] as String} LP atomic to ${i["to"] as String}."
   "tbc20-lp-lock","tbc20Lp.lock"->{val lock=amount(i["lockTime"]);need(lock<=java.math.BigInteger("4294967295"),"LP_LOCK_RANGE")
    "Lock ${i["amount"] as String} LP atomic in $owner until $lock ${if(lock<java.math.BigInteger("500000000"))"block height" else "Unix time (chain median-time-past)"}."}
   "tbc20-lp-merge","tbc20Lp.merge"->"Merge mature LP inputs into the same account: $owner."
   "tbc20-lp-unlock","tbc20Lp.unlock"->"Unlock mature LP inputs into the same account: $owner."
   else->throw NativeCustodyFailure("UNSUPPORTED_INTENT")
  }
  return "LP Pool $pool.\n$detail\nActual contract ownership and maturity are validated before signing."
 }
 private fun ammBusinessDescription(i:Map<String,Any?>,owner:String):String{
  val pool=i["poolContractId"] as String;digest(pool)
  val detail=when(i["type"]){
   "tbc-amm-swap","amm.swap"->{val direction=i["direction"] as String;need(direction in setOf("tbc-to-ft","ft-to-tbc"),"AMM_DIRECTION")
    "Swap $direction: input ${amount(i["amount"])} atomic; minimum output ${amount(i["minimumOutput"])} atomic."}
   "tbc-amm-add-liquidity","amm.addLiquidity"->{val asset=i["budgetAsset"] as String;need(asset in setOf("tbc","ft"),"AMM_BUDGET")
    "Add liquidity: budget ${amount(i["amount"])} $asset atomic; minimum LP ${amount(i["minimumLpAmount"])} atomic."}
   "tbc-amm-remove-liquidity","amm.removeLiquidity"->"Remove liquidity: ${amount(i["lpAmount"])} LP atomic; minimum TBC ${amount(i["minimumTbcAmount"])} atomic; minimum FT ${amount(i["minimumFtAmount"])} atomic."
   else->throw NativeCustodyFailure("UNSUPPORTED_INTENT")
  }
  var extra=""
  for((field,label) in listOf("initialFtAmount" to "Initial FT atomic","maximumFtAmount" to "Maximum FT atomic","maximumTbcAmount" to "Maximum TBC atomic","lockTime" to "LP lock time")){
   i[field]?.let{extra+="\n$label: ${amount(it)}."}
  }
  i["poolStateHash"]?.let{digest(it as String);extra+="\nRequired Pool state: $it."}
  return "AMM Pool $pool.\n$detail\nReceiver: ${i["receiver"] as? String ?: owner}."+extra+"\nUse authenticated Pool fees; fresh reserves and all requested bounds are validated before signing."
 }
 // Display-only bound configuration. Engine verifies canonical address,
 // contract encoding and the full plan before custody can sign; no fee table.
 private fun ammCreationDescription(intent:Map<String,Any?>):String{
  need(!intent.containsKey("lpPlan")&&!intent.containsKey("serviceFeeRate"),"AMM_FEE_FIELDS")
  val fees=map(intent["feePolicy"])
  val fields=listOf("lpFeeRate","taxFeeRate","serviceProviderFeeRate","protocolFeeRate")
  need(fees.keys==(fields+"feeAddress").toSet(),"AMM_FEE_FIELDS")
  val rates=fields.map{integer(fees[it])};need(rates.all{it in 0..9999},"AMM_FEE_RATE")
  val total=rates.sum();need(total<10000,"AMM_TOTAL_FEE")
  val (lp,tax,service,protocol)=rates
  val address=fees["feeAddress"] as? String?:throw NativeCustodyFailure("AMM_FEE_ADDRESS")
  need(address.matches(Regex("^1[1-9A-HJ-NP-Za-km-z]{25,34}$")),"AMM_FEE_ADDRESS")
  val token=intent["ftContractId"] as String;digest(token)
  val locked=intent["lpTimelock"] as? Boolean?:throw NativeCustodyFailure("AMM_LP_LOCK")
  val controllers=if(intent.containsKey("controllers")){
   val list=(intent["controllers"] as List<*>).map{it as String}
   need(list.size in 1..5&&list.toSet().size==list.size&&list==list.sorted()&&list.all{it.matches(Regex("^[0-9a-f]{40}$"))},"AMM_CONTROLLERS");list.joinToString(", ")
  }else "Public (no controller)"
  return "Create empty AMM for FT $token.\nTotal $total bps; LP $lp bps; tax $tax bps; service provider $service bps; protocol $protocol bps (1 bps = 0.01%).\nCombined non-LP ${total-lp} bps to fee address: $address.\nLP timelock: $locked.\nControllers: $controllers.\nApprove dependent funding/source/pool steps as one bounded request; adding liquidity is separate."
 }
 private fun mintDescription(intent:Map<String,Any?>,owner:String):String{
  val items=if(intent["type"]=="tbc721-standard-mint")listOf(intent)else (intent["items"] as? List<*>)?.map{map(it)}?:emptyList()
  need(items.size in 1..100,"NATIVE_MINT_BOUND")
  val slots=items.map{integer(it["slot"])};need(slots.all{it>0}&&slots.toSet().size==slots.size,"NATIVE_MINT_SLOTS")
  val details=items.joinToString("\n"){item->
   val media=item["media"]?.let{map(it)}?.let{"\nMedia SHA256: ${hash(it)}; ${it["uri"] as? String ?: "embedded"}"}?:""
   "Slot ${integer(item["slot"])}: ${item["name"] as String} (${item["symbol"] as String}).\nTo: ${item["to"] as? String ?: owner}.\n${item["description"] as String}\nAttributes: ${canonical(item["attributes"])}.$media"
  }
  return "Mint ${items.size} NFT(s) from collection ${intent["collectionId"] as String}.\n$details\nApprove the ordered mint steps as one bounded request."
 }
 private fun poolContinuation(profile:Any?):Boolean=profile in setOf("tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap","amm.addLiquidity","amm.removeLiquidity","amm.swap")
 private fun bundleLimit(request:Map<String,Any?>?):Int=if((request?.get("intent") as? Map<*,*>)?.get("type") in setOf("tbc721.batchTransfer","tbc721-standard-batch-mint"))100 else 32
 // LP uses the Engine's pool continuation family, but not AMM controller authority.
 private fun lpContinuation(profile:Any?):Boolean=profile in setOf("tbc20-lp-transfer","tbc20-lp-merge","tbc20-lp-lock","tbc20-lp-unlock","tbc20Lp.transfer","tbc20Lp.merge","tbc20Lp.lock","tbc20Lp.unlock")
 private fun coveredWarnings(request:Map<String,Any?>,payload:Map<String,Any?>):Boolean{
  val preview=payload["preview"] as? Map<*,*> ?: return false
  val warnings=preview["warnings"] as? List<*> ?: return false
  if((request["intent"] as? Map<*,*>)?.get("type")=="tbc-htlc-claim")return warnings==listOf("HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE") && (payload["transactions"] as? List<*>)?.size==1 && preview["transactionCount"]==1
  if(warnings.isEmpty())return true
  val txs=payload["transactions"] as? List<*> ?: return false
  if((request["intent"] as? Map<*,*>)?.get("type")=="tbc721.batchTransfer"){
   val items=(request["intent"] as? Map<*,*>)?.get("transfers") as? List<*>?:return false
   return warnings==listOf("MULTI_TRANSACTION") && txs.size in 2..bundleLimit(request) && preview["transactionCount"]==txs.size &&
    txs.count{(it as? Map<*,*>)?.get("role")=="primary"}==items.size && txs.all{(it as? Map<*,*>)?.get("role") in setOf("primary","maintenance")}
  }
  if(poolContinuation((request["intent"] as? Map<*,*>)?.get("type")))return warnings.size==2 && warnings.toSet()==setOf("MULTI_TRANSACTION","MAINTENANCE_TRANSACTION") && txs.size in 2..32 && preview["transactionCount"]==txs.size && (txs.first() as? Map<*,*>)?.get("id")=="native-funding-1" && txs.dropLast(1).all{(it as? Map<*,*>)?.get("role")=="maintenance"} && (txs.last() as? Map<*,*>)?.get("role")=="primary"
  return (request["intent"] as? Map<*,*>)?.get("type")=="tbc20-standard-create" &&
   warnings.size==2 && warnings.toSet()==setOf("MULTI_TRANSACTION","MAINTENANCE_TRANSACTION") &&
   txs.size==3 && preview["transactionCount"]==3 &&
   (txs[0] as? Map<*,*>)?.get("role")=="maintenance" &&
   (txs[1] as? Map<*,*>)?.get("role")=="prerequisite" && (txs[2] as? Map<*,*>)?.get("role")=="primary"
 }
 private fun map(v:Any?):Map<String,Any?>{
  val m=v as? Map<*,*>?:throw NativeCustodyFailure("INVALID_OBJECT");need(m.keys.all{it is String})
  return m.entries.associate{it.key as String to it.value}
 }
 // Shared framing is also used by whole-batch commitments.
 private fun typedEnvelope(r:Map<String,Any?>,origin:String)=NativeSigningEnvelope.typed(r,chain,origin)
 private fun typedDigest(e:Map<String,Any?>)=NativeSigningEnvelope.digest(e,"typedData")
 private fun immutable(v:Map<String,Any?>)=PermissionJson.records("[${canonical(v)}]").single()
 private fun integer(v:Any?):Int=canonical(v).toIntOrNull()?:throw NativeCustodyFailure("INVALID_INTEGER")
 private fun canonical(v:Any?):String{
  if(v is Number)need(v is Int||v is Long)
  if(v is Long)need(v in -9007199254740991L..9007199254740991L)
  return when(v){
   is List<*>->v.joinToString(",","[","]"){canonical(it)}
   is Map<*,*>->{need(v.keys.all{it is String});v.keys.map{it as String}.sorted().joinToString(",","{","}"){canonical(it)+":"+canonical(v[it])}}
   else->PermissionJson.canonical(v)
  }
 }
 private fun hash(v:Any?)=hex(MessageDigest.getInstance("SHA-256").digest(canonical(v).toByteArray(Charsets.UTF_8)))
 private fun digest(s:String):ByteArray{need(Regex("[0-9a-f]{64}").matches(s),"NATIVE_DIGEST");return s.chunked(2).map{it.toInt(16).toByte()}.toByteArray()}
 private fun amount(v:Any?):java.math.BigInteger{need(v is String&&Regex("0|[1-9][0-9]*").matches(v),"NATIVE_AMOUNT");return java.math.BigInteger(v as String)}
 private fun hex(b:ByteArray)=b.joinToString(""){"%02x".format(it)}
}

// Shared native framing/normalization; no keys, permission, network or UI.
internal object NativeSigningEnvelope {
 private fun need(ok:Boolean,code:String="NATIVE_DENIED"){if(!ok)throw NativeCustodyFailure(code)}
 @Suppress("UNCHECKED_CAST") private fun map(v:Any?):Map<String,Any?>{need(v is Map<*,*>&&v.keys.all{it is String},"INVALID_OBJECT");return v as Map<String,Any?>}
 private fun text(v:Any?):String{need(v is String,"INVALID_STRING");return v as String}
 private fun canonical(v:Any?)=PermissionJson.canonical(v)
 private fun immutable(v:Map<String,Any?>)=PermissionJson.records("["+canonical(v)+"]").single()
 private fun hex(v:ByteArray)=v.joinToString(""){"%02x".format(it)}
 private fun shape(m:Map<String,Any?>,keys:Set<String>){need(m.keys==keys,"NATIVE_MESSAGE")}
 fun workflow(step:Map<String,Any?>,chain:String,from:String,origin:String):Map<String,Any?>{
  if(step["kind"]=="message"){val message=map(step["message"]);val e=mapOf("type" to "tbc.message","version" to "1.0","message" to message);messageBytes(message);return immutable(e)}
  need(step["kind"]=="typedData","NATIVE_MESSAGE")
  return typed(mapOf("version" to "1.0","chainId" to chain,"from" to from,"data" to map(step["data"])),chain,origin)
 }
 fun typed(r:Map<String,Any?>,chain:String,origin:String):Map<String,Any?>{
  fun shape(m:Map<String,Any?>,required:Set<String>,optional:Set<String> = emptySet()){
   need(m.keys.containsAll(required)&&(required+optional).containsAll(m.keys),"NATIVE_TYPED_SHAPE")
  }
  fun matches(v:Any?,pattern:String){need(v is String&&Regex(pattern).matches(v),"NATIVE_TYPED_FIELD")}
  fun text(v:Any?,min:Int,max:Int){need(v is String,"NATIVE_TYPED_STRING");val s=v as String;need(s.codePointCount(0,s.length) in min..max,"NATIVE_TYPED_STRING")}
  shape(r,setOf("version","chainId","from","data"),setOf("clientRequestId"))
  if(r.containsKey("clientRequestId"))text(r["clientRequestId"],1,128)
  val d=map(r["data"]);shape(d,setOf("domain","types","primaryType","message"))
  val domain=map(d["domain"]);shape(domain,setOf("name","chainId"),setOf("version","origin","verifyingContract","salt"))
  text(domain["name"],1,64);need(domain["chainId"]==chain,"NATIVE_TYPED_CHAIN")
  if(domain.containsKey("origin")){text(domain["origin"],1,2048);need(domain["origin"]==origin,"NATIVE_TYPED_ORIGIN")}
  if(domain.containsKey("version"))matches(domain["version"],"[!-~]{1,32}")
  for(key in listOf("verifyingContract","salt"))if(domain.containsKey(key))matches(domain[key],"[0-9a-f]{64}")
  val identifier="[A-Za-z][A-Za-z0-9_]{0,63}"
  matches(d["primaryType"],identifier)
  val types=map(d["types"]);need(types.size in 1..32,"NATIVE_TYPED_TYPES")
  val normalized=types.mapValues{(name,value)->
   matches(name,identifier);val fields=(value as? List<*>)?.map{map(it)}?:throw NativeCustodyFailure("NATIVE_TYPED_FIELDS")
   need(fields.size in 1..64,"NATIVE_TYPED_FIELDS")
   for(f in fields){shape(f,setOf("name","type"));matches(f["name"],identifier);matches(f["type"],"[A-Za-z][A-Za-z0-9_]*(?:\\[(?:[1-9][0-9]{0,2})?\\])?")}
   fields.withIndex().sortedWith{a,b->val order=typedFieldOrder(a.value["name"] as String,b.value["name"] as String);if(order==0)a.index.compareTo(b.index)else order}.map{it.value}
  }
  val message=map(d["message"]);val pending=mutableListOf<Any?>(message)
  while(pending.isNotEmpty())when(val v=pending.removeAt(pending.lastIndex)){
   is String,is Boolean->Unit
   is List<*>->{need(v.size<=256,"NATIVE_TYPED_ARRAY");pending.addAll(v)}
   is Map<*,*>->{need(v.size<=64&&v.keys.all{it is String},"NATIVE_TYPED_OBJECT");pending.addAll(v.values)}
   else->throw NativeCustodyFailure("NATIVE_TYPED_VALUE")
  }
  val e=mapOf("type" to "tbc.typedData","version" to "1.0","domain" to domain,"types" to normalized,"primaryType" to d["primaryType"],"message" to message)
  val c=canonical(e);need(c.codePointCount(0,c.length)<=65536,"NATIVE_TYPED_SIZE");return immutable(e)
 }
 private fun typedFieldOrder(a:String,b:String):Int{
  val l=a.lowercase(java.util.Locale.ROOT);val r=b.lowercase(java.util.Locale.ROOT)
  for(i in 0 until minOf(l.length,r.length)){val x=if(l[i]=='_')0 else l[i].code;val y=if(r[i]=='_')0 else r[i].code;if(x!=y)return x-y}
  if(l.length!=r.length)return l.length-r.length
  for(i in a.indices)if(a[i]!=b[i])return b[i].code-a[i].code
  return 0
 }
 fun digest(e:Map<String,Any?>,purpose:String,walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):String{
  val h=MessageDigest.getInstance("SHA-256");return hex(h.digest(h.digest(payload(e,purpose,walletProtocol))))
 }
 private fun payload(e:Map<String,Any?>,purpose:String,walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):ByteArray{
  fun size(n:Int):ByteArray=when{n<253->byteArrayOf(n.toByte());n<=65535->byteArrayOf(253.toByte(),n.toByte(),(n shr 8).toByte());else->byteArrayOf(254.toByte(),n.toByte(),(n shr 8).toByte(),(n shr 16).toByte(),(n shr 24).toByte())}
  val typed=purpose=="typedData";val magic=(if(typed)"TBC Signed Typed Data:\n" else if(walletProtocol==NativeWalletProtocol.LEGACY)"Bitcoin Signed Message:\n" else "TBC Signed Message:\n").toByteArray(Charsets.UTF_8)
  val body=if(typed)PermissionJson.canonical(e).toByteArray(Charsets.UTF_8)else messageBytes(map(e["message"]))
  return size(magic.size)+magic+size(body.size)+body
 }
 fun result(e:Map<String,Any?>,task:Map<String,Any?>,signature:Map<String,Any?>,account:NativeAccount,walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):Map<String,Any?>{
  val purpose=text(task["purpose"]);val raw=text(signature["signature"])
  need(purpose in setOf("message","typedData")&&raw.length==130&&raw.all{it in '0'..'9'||it in 'a'..'f'},"NATIVE_SIGNATURE_ENCODING")
  val sig=raw.chunked(2).map{it.toInt(16).toByte()}.toByteArray();val base64=java.util.Base64.getEncoder()
  val result=mutableMapOf<String,Any?>("version" to "1.0","scheme" to if(purpose=="typedData") "tbc-typed-data" else "tbc-message","algorithm" to task["algorithm"],"address" to account.address,"accountId" to account.accountId,"publicKey" to account.publicKey,"envelope" to e,"canonical" to PermissionJson.canonical(e),"signingPayload" to base64.encodeToString(payload(e,purpose,walletProtocol)),"digest" to task["digest"],"signature" to base64.encodeToString(sig))
  if(purpose=="message"&&walletProtocol==NativeWalletProtocol.LEGACY){result["scheme"]="legacy-bitcoin-message";result.remove("signingPayload")}
  return result.toMap()
 }
 private fun messageBytes(m:Map<String,Any?>):ByteArray{
   val s=text(m["data"]);shape(m,setOf("data","encoding"))
   val b=when(m["encoding"]){
    "utf8"->s.toByteArray(Charsets.UTF_8)
    "hex"->{need(s.isNotEmpty()&&s.matches(Regex("^(?:[0-9a-f]{2})+$")));s.chunked(2).map{it.toInt(16).toByte()}.toByteArray()}
    "base64"->{val b=java.util.Base64.getDecoder().decode(s);need(java.util.Base64.getEncoder().encodeToString(b)==s);b}
    else->throw NativeCustodyFailure("NATIVE_MESSAGE")
   };need(b.size<=65536);return b
 }
}
