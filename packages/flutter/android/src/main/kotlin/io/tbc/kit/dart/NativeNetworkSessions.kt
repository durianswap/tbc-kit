package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder

class NativeNetworkFailure(val code:String):Exception(code)
data class NativeNetworkAuthority(val epoch:String,val unlocked:Boolean,val switchAccountIds:List<String>,val visibleAddresses:List<String>)
data class NativeNetworkState(val chainId:String,val revision:Int)
// Native-owned identity handles; a copied/forged payload is never a commit token.
class NativeNetworkProposal internal constructor(
 val owner:String,val operation:String,internal val scope:Map<String,String>,val from:NativeNetworkState,val toChainId:String,
 internal val expiresAtMillis:Long,internal val fromAuthority:NativeNetworkAuthority,internal val toAuthority:NativeNetworkAuthority,
 internal val fromVisibleAddresses:List<String>,
 val proposalJSON:String,val bindingJSON:String,val previewJSON:String,
)
class NativeNetworkCommit internal constructor(
 val owner:String,val operation:String,internal val scope:Map<String,String>,val state:NativeNetworkState,
 internal val authority:NativeNetworkAuthority,val eventsJSON:String,
)

/** Native per-document CAS. Calls and callbacks run synchronously on the custody
 * executor. Authorities come from each configured chain's existing native owner;
 * this layer does no HTTP, storage, key access or global network mutation. */
class NativeNetworkSessions(
 sources:Map<String,String>,private val nativeCurrent:(String,Map<String,String>)->Boolean,
 private val authority:(String,String)->NativeNetworkAuthority,
 private val fence:(String,Map<String,String>)->Unit,
 private val clock:()->Long=System::currentTimeMillis,
 private val activate:(String,Map<String,String>,String,List<String>)->Unit={_,_,_,_->},
) {
 private val sources=sources.toMap()
 private class Session(val scope:Map<String,String>,chain:String){
  var state=NativeNetworkState(chain,0);val used=mutableSetOf<String>()
  val pending=mutableMapOf<String,NativeNetworkProposal>();val commits=mutableMapOf<String,NativeNetworkCommit>();var committing=false
  var activeAccountIds:Set<String>?=null
 }
 private val sessions=mutableMapOf<String,Session>()
 init{need(this.sources.isNotEmpty()&&this.sources.size<=2&&this.sources.keys.all{it in setOf("tbc:mainnet","tbc:testnet")}&&this.sources.values.all{Regex("[0-9a-f]{64}").matches(it)},"NETWORK_CATALOG")}
 private fun need(v:Boolean,code:String="NETWORK_STALE"){if(!v)throw NativeNetworkFailure(code)}
 private fun session(owner:String,scope:Map<String,String>):Session{
  val s=sessions[owner]?:throw NativeNetworkFailure("NETWORK_STALE")
  need(s.scope==scope&&nativeCurrent(owner,scope)&&!s.committing);return s
 }
 fun navigation(owner:String,scope:Map<String,String>,initialChain:String){
  need(initialChain in sources,"NETWORK_UNSUPPORTED")
  need(owner.isNotEmpty()&&owner.toByteArray(Charsets.UTF_8).size<=128&&(owner in sessions||sessions.size<8),"NETWORK_SCOPE")
  need(scope.keys==setOf("webViewInstanceId","sessionId","navigationId","committedUrl","origin","topOrigin","frame","createdAt")&&scope["frame"]=="top"&&scope["origin"]==scope["topOrigin"]&&nativeCurrent(owner,scope),"NETWORK_SCOPE")
  sessions[owner]?.let{fence(owner,it.scope)};sessions[owner]=Session(scope.toMap(),initialChain)
 }
 fun invalidate(owner:String){sessions.remove(owner)?.let{fence(owner,it.scope)}}
 fun state(owner:String,scope:Map<String,String>)=session(owner,scope).state
 // A queued call from an old worker must not be redirected to the new chain.
 fun requireState(owner:String,scope:Map<String,String>,expected:NativeNetworkState):String{
  val s=session(owner,scope);need(s.state==expected);return sources.getValue(s.state.chainId)
 }
 private fun read(chain:String,origin:String):NativeNetworkAuthority{
  val a=authority(chain,origin)
  need(a.epoch.isNotEmpty()&&a.epoch.toByteArray(Charsets.UTF_8).size<=512&&a.switchAccountIds.size<=16&&a.visibleAddresses.size<=16&&
   a.switchAccountIds.toSet().size==a.switchAccountIds.size&&a.visibleAddresses.toSet().size==a.visibleAddresses.size&&
   a.switchAccountIds.all{it.startsWith("$chain:")&&it.length>chain.length+1&&it.length<=256}&&
   a.visibleAddresses.all{it.isNotEmpty()&&it.toByteArray(Charsets.UTF_8).size<=128},"NETWORK_AUTHORITY")
  return a.copy(switchAccountIds=a.switchAccountIds.sorted(),visibleAddresses=a.visibleAddresses.sorted())
 }
 private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it.toInt()and 255)}
 fun prepare(owner:String,scope:Map<String,String>,operation:String,target:String,expectedRevision:Int):NativeNetworkProposal{
  val s=session(owner,scope);need(target in sources,"NETWORK_UNSUPPORTED")
  need(s.state.revision==expectedRevision&&operation !in s.used&&s.used.size<128&&operation.isNotEmpty()&&operation.toByteArray(Charsets.UTF_8).size<=128)
  val origin=scope.getValue("origin");val a=read(s.state.chainId,origin);val b=read(target,origin)
  // Target-chain authorization also precedes a same-chain no-op, as in Core.
  need(a.unlocked&&b.unlocked&&b.switchAccountIds.isNotEmpty(),"NETWORK_UNAUTHORIZED")
  val now=clock();need(now>=0&&now<253402300679999L,"NETWORK_CLOCK");val end=now+120000
  val expiry=DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.ofEpochMilli(end))
  val payload=mapOf("version" to "1.0","fromChainId" to s.state.chainId,"toChainId" to target,"expectedSessionRevision" to s.state.revision.toString(),"expiresAt" to expiry)
  val context=mapOf("sessionId" to scope.getValue("sessionId"),"transport" to "webview","origin" to origin,"topOrigin" to scope.getValue("topOrigin"),"frame" to "top","navigationId" to scope.getValue("navigationId"),"createdAt" to scope.getValue("createdAt"))
  val binding=mapOf("version" to "1.0","method" to "tbc_switchChain","operationKind" to "switchChain","contextHash" to hash(context),"origin" to origin,"sessionId" to scope.getValue("sessionId"),"chainId" to target,"requestHash" to hash(mapOf("chainId" to target)),"operationHash" to hash(payload),"expiresAt" to expiry)
  val preview=mapOf("operationKind" to "switchChain","fromChainId" to s.state.chainId,"toChainId" to target,"network" to mapOf("name" to if(target=="tbc:mainnet")"TBC Mainnet" else "TBC Testnet","nativeCurrencySymbol" to "TBC"),"warnings" to listOf("CHAIN_SWITCH"))
  val visible=a.visibleAddresses.filter{s.activeAccountIds?.contains("${s.state.chainId}:$it")!=false}
  val p=NativeNetworkProposal(owner,operation,scope.toMap(),s.state,target,end,a,b,visible,
   PermissionJson.canonical(mapOf("payload" to payload,"chainSwitchProposalHash" to hash(payload))),PermissionJson.canonical(mapOf("payload" to binding,"bindingHash" to hash(binding))),PermissionJson.canonical(preview))
  s.used+=operation;s.pending[operation]=p;return p
 }
 fun cancel(owner:String,scope:Map<String,String>,operation:String){val s=session(owner,scope);s.pending.remove(operation);s.commits.remove(operation)}
 fun commit(p:NativeNetworkProposal,approved:Boolean):NativeNetworkCommit{
  val s=session(p.owner,p.scope);need(s.pending[p.operation]===p);s.pending.remove(p.operation)
  fun current(){
   need(sessions[p.owner]===s&&s.scope==p.scope&&nativeCurrent(p.owner,p.scope)&&s.state==p.from&&clock()<p.expiresAtMillis)
   need(read(p.from.chainId,p.scope.getValue("origin"))==p.fromAuthority&&read(p.toChainId,p.scope.getValue("origin"))==p.toAuthority,"NETWORK_AUTHORITY_CHANGED")
  }
  current();val changed=p.from.chainId!=p.toChainId;if(changed)need(approved,"NETWORK_REJECTED")
  val events=mutableListOf<Map<String,Any?>>()
  if(changed){
   need(s.state.revision<Int.MAX_VALUE,"NETWORK_REVISION_LIMIT");s.committing=true
   try{
    // Revoke old permits/cache consumption before publishing, without awaiting.
    fence(p.owner,p.scope);current();activate(p.owner,p.scope,p.toChainId,p.toAuthority.switchAccountIds);current()
    s.state=NativeNetworkState(p.toChainId,s.state.revision+1);s.activeAccountIds=p.toAuthority.switchAccountIds.toSet()
    s.pending.clear();s.commits.clear();events+=mapOf("name" to "chainChanged","payload" to p.toChainId)
    val targetAddresses=p.toAuthority.visibleAddresses.filter{"${p.toChainId}:$it" in p.toAuthority.switchAccountIds}
    if(targetAddresses!=p.fromVisibleAddresses)events+=mapOf("name" to "accountsChanged","payload" to targetAddresses)
   }finally{s.committing=false}
  }
  val c=NativeNetworkCommit(p.owner,p.operation,p.scope,s.state,p.toAuthority,PermissionJson.canonical(events));s.commits[p.operation]=c;return c
 }
 fun requireDelivery(c:NativeNetworkCommit){
  val s=session(c.owner,c.scope)
  need(s.commits[c.operation]===c&&s.state==c.state&&read(c.state.chainId,c.scope.getValue("origin"))==c.authority)
 }
}
