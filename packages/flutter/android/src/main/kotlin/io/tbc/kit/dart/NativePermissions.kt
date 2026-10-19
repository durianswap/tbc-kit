package io.tbc.kit.dart

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

// All interfaces run on the native custody executor. Implementations must not
// await between their final lifecycle/CAS check and durable commit. A partner
// can inject its own store and account source; neither is a page-facing API.
data class PermissionSnapshot(val revision:Long,val records:List<Map<String,Any?>>)
data class PermissionCommitResult(val acknowledgedRevision:Long,val current:PermissionSnapshot)
// Native registration only; never selected by a page parameter. Standard keeps
// its accepted storage/ID format, while Legacy is independently revocable.
enum class NativeWalletProtocol(val namespace:String,val scopesTable:String,val commitsTable:String,val permissionDomain:String){
 STANDARD("tws/1.0","scopes","commits","TWS/1.0/permission"),
 LEGACY("legacy-window-turing/v1","legacy_scopes","legacy_commits","legacy-window-turing/v1/permission");
 val wireChannel get()=if(this==STANDARD)"tws-webview/1" else "legacy-window-turing-shared/1"
}
interface NativePermissionBackend {
 // Custom Legacy stores must isolate grants AND idempotency records.
 val walletProtocol:NativeWalletProtocol get()=NativeWalletProtocol.STANDARD
 fun loadAll():Map<String,PermissionSnapshot>
 fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult
}
data class NativePermissionMutation(val backend:NativePermissionBackend,val chainId:String,val origin:String,val expected:Long,
 val records:List<Map<String,Any?>>,val callId:String,val meaning:String)
// Custom wallet stores opt in only when one transaction covers all members.
interface NativePermissionGroupBackend:NativePermissionBackend {
 fun acceptsGroup(backends:List<NativePermissionBackend>):Boolean
 fun commitGroup(mutations:List<NativePermissionMutation>,fence:()->Unit):Map<String,PermissionCommitResult>
}
data class NativeAccount(val address:String,val publicKey:String,val chainId:String) {
 val accountId get()="$chainId:$address"
 fun identity()=mapOf("address" to address,"publicKey" to publicKey,"chainId" to chainId,"accountId" to accountId)
}
interface NativeAccountSource {
 val current:NativeAccount
 val revision:Long
 val unlocked:Boolean
 // Wallet-selected identities, not the whole Vault. Primary first. Selection,
 // key availability and lock changes must increment revision and notify custody.
 val signingAccounts:List<NativeAccount> get()=listOf(current)
}
object PermissionJson {
 fun decode(v:Any?):Any?=when(v){null,JSONObject.NULL->null;is JSONObject->v.keys().asSequence().associateWith{decode(v.get(it))};is JSONArray->(0 until v.length()).map{decode(v.get(it))};else->v}
 @Suppress("UNCHECKED_CAST") fun records(raw:String)=decode(JSONArray(raw)) as List<Map<String,Any?>>
 fun canonical(v:Any?):String=when(v){null->"null";is String->JSONObject.quote(v).replace("\\/","/");is Boolean->v.toString();is Int,is Long->v.toString();is List<*>->v.joinToString(",","[","]"){canonical(it)};is Map<*,*>->v.keys.map{it as String}.sorted().joinToString(",","{","}"){canonical(it)+":"+canonical(v[it])};else->error("PERMISSION_JSON")}
 fun id(vararg parts:String):String=Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(parts.joinToString("\u0000").toByteArray(Charsets.UTF_8)))
}
// Wallet-private system SQLite, FULL synchronous durability. No
// transaction journal, key, approval token, raw transaction or permit is stored.
class SystemPermissionBackend(context:Context,private val profile:String,private val chain:String,
 override val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):NativePermissionGroupBackend {
 private val db:SQLiteDatabase
 init {
  check(profile.isNotEmpty()&&chain in setOf("tbc:mainnet","tbc:testnet"))
  db=context.openOrCreateDatabase("tbc-kit-permissions.sqlite",Context.MODE_PRIVATE,null)
  db.rawQuery("PRAGMA journal_mode=DELETE",null).use{check(it.moveToFirst()&&it.getString(0).lowercase()=="delete")}
  db.execSQL("PRAGMA synchronous=FULL")
  db.execSQL("CREATE TABLE IF NOT EXISTS ${walletProtocol.scopesTable}(profile TEXT, chain TEXT, origin TEXT, revision INTEGER NOT NULL, records TEXT NOT NULL, PRIMARY KEY(profile,chain,origin))")
  db.execSQL("CREATE TABLE IF NOT EXISTS ${walletProtocol.commitsTable}(profile TEXT, chain TEXT, call_id TEXT, meaning TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(profile,chain,call_id))")
 }
 fun close(){db.close()}
 override fun loadAll():Map<String,PermissionSnapshot>{val result=mutableMapOf<String,PermissionSnapshot>();db.rawQuery("SELECT origin,revision,records FROM ${walletProtocol.scopesTable} WHERE profile=? AND chain=?",arrayOf(profile,chain)).use{c->while(c.moveToNext()){result[c.getString(0)]=PermissionSnapshot(c.getLong(1),PermissionJson.records(c.getString(2)))}};return result.toMap()}
 private fun load(origin:String,chain:String):PermissionSnapshot {db.rawQuery("SELECT revision,records FROM ${walletProtocol.scopesTable} WHERE profile=? AND chain=? AND origin=?",arrayOf(profile,chain,origin)).use{c->return if(c.moveToFirst())PermissionSnapshot(c.getLong(0),PermissionJson.records(c.getString(1)))else PermissionSnapshot(0,emptyList())}}
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult {
  return commitGroup(listOf(NativePermissionMutation(this,chain,origin,expected,records,callId,meaning)),fence).getValue(chain)
 }
 override fun acceptsGroup(backends:List<NativePermissionBackend>):Boolean{
  val stores=backends.filterIsInstance<SystemPermissionBackend>()
  return db.isOpen&&backends.size in 1..2&&stores.size==backends.size&&stores.map{it.chain}.toSet().size==stores.size&&stores.all{it.db.isOpen&&java.io.File(it.db.path).canonicalPath==java.io.File(db.path).canonicalPath&&it.profile==profile&&it.walletProtocol==walletProtocol}
 }
 override fun commitGroup(mutations:List<NativePermissionMutation>,fence:()->Unit):Map<String,PermissionCommitResult>{
  check(acceptsGroup(mutations.map{it.backend})&&mutations.map{it.origin}.toSet().size==1&&mutations.map{it.callId}.toSet().size==1&&mutations.all{(it.backend as? SystemPermissionBackend)?.chain==it.chainId}){"PERMISSION_GROUP_SCOPE"}
  fence();db.beginTransaction()
  try {
   fence()
   val previous=mutableMapOf<String,Long>();val current=mutableMapOf<String,PermissionSnapshot>();val results=mutableMapOf<String,PermissionCommitResult>()
   for(m in mutations){
    db.rawQuery("SELECT meaning,revision FROM ${walletProtocol.commitsTable} WHERE profile=? AND chain=? AND call_id=?",arrayOf(profile,m.chainId,m.callId)).use{c->if(c.moveToFirst()){check(c.getString(0)==m.meaning){"PERMISSION_CONFLICT"};previous[m.chainId]=c.getLong(1)}}
    current[m.chainId]=load(m.origin,m.chainId)
   }
   check(previous.isEmpty()||previous.size==mutations.size){"PERMISSION_GROUP_PARTIAL"}
   for(m in mutations){
    val before=current.getValue(m.chainId);val prior=previous[m.chainId]
    if(prior!=null){results[m.chainId]=PermissionCommitResult(prior,before);continue}
    check(m.expected>=0&&m.expected<Long.MAX_VALUE&&before.revision==m.expected){"PERMISSION_CONFLICT"}
    val next=m.expected+1;val serialized=PermissionJson.canonical(m.records)
    db.execSQL("INSERT OR REPLACE INTO ${walletProtocol.scopesTable} VALUES(?,?,?,?,?)",arrayOf<Any>(profile,m.chainId,m.origin,next,serialized))
    db.execSQL("INSERT INTO ${walletProtocol.commitsTable} VALUES(?,?,?,?,?)",arrayOf<Any>(profile,m.chainId,m.callId,m.meaning,next))
    results[m.chainId]=PermissionCommitResult(next,PermissionSnapshot(next,PermissionJson.records(serialized)))
   }
   fence();db.setTransactionSuccessful()
   // finally performs the actual commit before the caller receives this result.
   return results.toMap()
  }finally{db.endTransaction()}
 }
}
data class NativeGrantProposal(val origin:String,val expected:Long,val accountRevision:Long,val accountId:String,val callId:String,val capabilities:List<String>,val records:List<Map<String,Any?>>,val meaning:String,val accounts:List<NativeAccount>,val selection:List<NativeAccount>,val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD)
class NativePermissionGrant(val permissions:NativePermissions,val proposal:NativeGrantProposal,val check:()->Unit,val detach:()->Unit)
class NativePermissions(val accounts:NativeAccountSource,private val chain:String,private val backend:NativePermissionBackend,
 val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD,private val changed:(String?)->Unit) {
 init { check(chain in setOf("tbc:mainnet","tbc:testnet"));check(backend.walletProtocol==walletProtocol){"PERMISSION_PROTOCOL"} }
 private val snapshots=backend.loadAll().toMutableMap()
 private var available=true
 private val allowed=setOf("tbc_accounts","tbc_accountMetadata","tbc_switchChain","tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_sendTransaction","tbc_signWorkflow","tbc_crypto")
 private fun snapshot(origin:String)=snapshots[origin]?:PermissionSnapshot(0,emptyList())
 private fun caveat(p:Map<String,Any?>,name:String):Any? {
  val cs=p["caveats"] as? List<*>?:error("PERMISSION_CORRUPT")
  check(cs.size in 3..4 && cs.all{it is Map<*,*> && it.keys==setOf("type","value") && it["type"] in setOf("restrictChains","restrictAccounts","restrictMethods","expiresAt")}){"PERMISSION_CORRUPT"}
  check(cs.map{(it as Map<*,*>)["type"]}.toSet().size==cs.size){"PERMISSION_CORRUPT"}
  val found=cs.map{it as? Map<*,*>?:error("PERMISSION_CORRUPT")}.filter{it["type"]==name}
  check(found.size<=1){"PERMISSION_CORRUPT"};return found.firstOrNull()?.get("value")
 }
 fun selectedAccounts():List<NativeAccount>{
  val selected=accounts.signingAccounts.toList()
  check(selected.size in 1..16 && selected.first()==accounts.current && selected.all{it.chainId==chain} && selected.map{it.accountId}.toSet().size==selected.size && selected.map{it.publicKey.drop(2)}.toSet().size==selected.size){"NATIVE_ACCOUNT_SELECTION"}
  return selected
 }
 fun records(origin:String,account:NativeAccount?=null):List<Map<String,Any?>> {
  check(available){"PERMISSION_STORE_UNAVAILABLE"}
  check(accounts.current.chainId==chain){"PERMISSION_CHAIN_CHANGED"}
  if(!accounts.unlocked)return emptyList()
  val target=account?:accounts.current
  if(account!=null)check(target in selectedAccounts()){"NATIVE_ACCOUNT_SELECTION"}
  return snapshot(origin).records.filter{p->
   check(p.keys==setOf("id","parentCapability","invoker","date","caveats")){"PERMISSION_CORRUPT"}
   val method=p["parentCapability"] as? String?:error("PERMISSION_CORRUPT")
   check(p["invoker"]==origin&&method in allowed&&caveat(p,"restrictChains")==listOf(accounts.current.chainId)&&caveat(p,"restrictMethods")==listOf(method)){"PERMISSION_CORRUPT"}
   val ids=caveat(p,"restrictAccounts") as? List<*>?:error("PERMISSION_CORRUPT");check(ids.size in 1..16 && ids.toSet().size==ids.size && ids.all{it is String && it.startsWith("$chain:") && it.length>chain.length+1}){"PERMISSION_CORRUPT"}
   val expiryValue=caveat(p,"expiresAt");val hasExpiry=(p["caveats"] as List<*>).any{(it as Map<*,*>)["type"]=="expiresAt"}
   check(!hasExpiry||expiryValue is String){"PERMISSION_CORRUPT"};val expiry=expiryValue as? String
   target.accountId in ids&&(expiry==null||Instant.parse(expiry).isAfter(Instant.now()))
  }
 }
 fun permits(origin:String,capability:String,account:NativeAccount?=null)=records(origin,account).any{it["parentCapability"]==capability}
 fun require(origin:String,capability:String,account:NativeAccount?=null){check(accounts.unlocked){"NATIVE_LOCKED"};check(permits(origin,"tbc_accounts",account)&&permits(origin,capability,account)){"NATIVE_PERMISSION"}}
 fun epoch(origin:String)="${accounts.revision}:${snapshot(origin).revision}:$available"
 fun proposal(origin:String,request:Map<String,Any?>,operationId:String):NativeGrantProposal {
  check(available&&accounts.unlocked){"NATIVE_LOCKED"};check(accounts.current.chainId==chain){"PERMISSION_CHAIN_CHANGED"};check(request.isNotEmpty()&&request.keys.all{it in allowed}){"UNSUPPORTED_PERMISSION"}
  val capabilities=request.keys.sorted()
  for((capability,value)in request){val v=value as? Map<*,*>?:error("INVALID_PARAMS");val allowedFields=if(capability=="tbc_accounts")setOf("chains","maxAccounts")else setOf("chains");val maximum=v["maxAccounts"];check(v.keys.all{it in allowedFields}&&v["chains"]==listOf(chain)&&(!v.containsKey("maxAccounts")||((maximum is Int||maximum is Long)&&(maximum as Number).toLong() in 1L..16L))){"INVALID_PARAMS"}}
  check("tbc_accounts" in capabilities||permits(origin,"tbc_accounts")){"NATIVE_PERMISSION"}
  val before=snapshot(origin);val account=accounts.current;val now=System.currentTimeMillis()
  val selection=selectedAccounts()
  val granted=if("tbc_accounts" in request){val requested=request["tbc_accounts"] as Map<*,*>;selection.take((requested["maxAccounts"] as? Number)?.toInt()?:1)}else selection.filter{permits(origin,"tbc_accounts",it)}
  check(account in granted){"NATIVE_PERMISSION"}
  val keep=before.records.filter{it["parentCapability"] !in capabilities}
  val fresh=capabilities.mapIndexed{index,name->mapOf("id" to PermissionJson.id(walletProtocol.permissionDomain,operationId,account.chainId,name,index.toString()),"parentCapability" to name,"invoker" to origin,"date" to now,
   "caveats" to listOf(mapOf("type" to "restrictChains","value" to listOf(account.chainId)),mapOf("type" to "restrictAccounts","value" to granted.map{it.accountId}),mapOf("type" to "restrictMethods","value" to listOf(name))))}
  val records=PermissionJson.records(PermissionJson.canonical((keep+fresh).sortedBy{it["parentCapability"] as String}))
  val meaning=PermissionJson.canonical(mapOf("origin" to origin,"chainId" to account.chainId,"expected" to before.revision,"records" to records))
  return NativeGrantProposal(origin,before.revision,accounts.revision,account.accountId,operationId,capabilities,records,meaning,granted,selection,walletProtocol)
 }
 fun approve(proposal:NativeGrantProposal,fence:()->Unit):List<Map<String,Any?>> {
  fun current(){fence();check(proposal.walletProtocol==walletProtocol){"PERMISSION_PROTOCOL"};check(available&&accounts.unlocked&&accounts.revision==proposal.accountRevision&&accounts.current.accountId==proposal.accountId&&selectedAccounts()==proposal.selection){"NATIVE_REVISION_CHANGED"}}
  current()
  try {val r=backend.commit(proposal.origin,proposal.expected,proposal.records,proposal.callId,proposal.meaning,::current);snapshots[proposal.origin]=r.current;changed(proposal.origin);return records(proposal.origin).filter{it["parentCapability"] in proposal.capabilities}}
  catch(e:Exception){available=false;changed(null);throw e}
 }
 private fun checkProposal(p:NativeGrantProposal){
  check(p.walletProtocol==walletProtocol){"PERMISSION_PROTOCOL"}
  check(available&&accounts.unlocked&&accounts.revision==p.accountRevision&&accounts.current.accountId==p.accountId&&selectedAccounts()==p.selection&&snapshot(p.origin).revision==p.expected&&p.expected>=0&&p.expected<Long.MAX_VALUE){"NATIVE_REVISION_CHANGED"}
 }
 companion object {
  fun groupBackend(grants:List<NativePermissionGrant>):NativePermissionGroupBackend{
   check(grants.size==2&&grants.map{it.permissions.chain}.toSet().size==grants.size&&grants.map{it.permissions.walletProtocol}.toSet().size==1){"PERMISSION_GROUP_SCOPE"}
   val group=grants.first().permissions.backend as? NativePermissionGroupBackend?:error("PERMISSION_GROUP_UNAVAILABLE")
   check(group.acceptsGroup(grants.map{it.permissions.backend})){"PERMISSION_GROUP_UNAVAILABLE"};return group
  }
  fun approveGroup(grants:List<NativePermissionGrant>,fence:()->Unit):List<Map<String,Any?>>{
   val backend=groupBackend(grants)
   fun current(){fence();grants.forEach{it.check();it.permissions.checkProposal(it.proposal)}}
   current()
   val meaning=PermissionJson.canonical(mapOf("kind" to "TWS/permission-group","members" to grants.map{mapOf("chainId" to it.permissions.chain,"meaning" to it.proposal.meaning)}))
   val mutations=grants.map{g->val p=g.proposal;NativePermissionMutation(g.permissions.backend,g.permissions.chain,p.origin,p.expected,p.records,p.callId,meaning)}
   grants.forEach{it.detach()}
   try{
    val results=backend.commitGroup(mutations,::current)
    current()
    check(results.keys==mutations.map{it.chainId}.toSet()){"PERMISSION_GROUP_RESULT"}
    grants.forEach{g->val p=g.proposal;val r=results.getValue(g.permissions.chain)
     check(r.acknowledgedRevision==p.expected+1&&r.current.revision==p.expected+1&&PermissionJson.canonical(r.current.records)==PermissionJson.canonical(p.records)){"PERMISSION_GROUP_RESULT"}
    }
    grants.forEach{g->g.permissions.snapshots[g.proposal.origin]=results.getValue(g.permissions.chain).current}
    grants.forEach{g->g.permissions.changed(g.proposal.origin)}
    return grants.flatMap{g->g.permissions.records(g.proposal.origin).filter{it["parentCapability"] in g.proposal.capabilities}}
   }catch(e:Exception){grants.forEach{it.permissions.available=false};grants.forEach{it.permissions.changed(null)};throw e}
  }
 }
 fun revoke(origin:String,callId:String,fence:()->Unit) {
  // Fence pending use immediately. Do not publish a durable success if I/O fails.
  changed(origin);val before=snapshot(origin)
  try{val r=backend.commit(origin,before.revision,emptyList(),callId,PermissionJson.canonical(mapOf("origin" to origin,"revision" to before.revision,"revoke" to true)),fence);snapshots[origin]=r.current}
  catch(e:Exception){available=false;changed(null);throw e}
 }
}
