package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import java.time.Instant
import org.json.JSONObject

private class RouterAccounts(override var current:NativeAccount):NativeAccountSource {
 override var revision=0L;override var unlocked=true
 var additional=emptyList<NativeAccount>();override val signingAccounts get()=listOf(current)+additional
}
private class RouterStore:NativePermissionGroupBackend {
 val data=mutableMapOf<String,PermissionSnapshot>();var writes=0;var fail=false
 var grouped=false;var wrongAck=false;var groupCommits=0
 override fun acceptsGroup(backends:List<NativePermissionBackend>)=grouped&&backends.size==2&&backends.all{(it as? RouterStore)?.grouped==true}
 override fun commitGroup(mutations:List<NativePermissionMutation>,fence:()->Unit):Map<String,PermissionCommitResult>{
  check(acceptsGroup(mutations.map{it.backend}));fence();val staged=mutableMapOf<String,PermissionCommitResult>()
  for(m in mutations){val store=m.backend as RouterStore
   if(store.fail)throw NativeCustodyFailure("FIXTURE_STORE")
   check((store.data[m.origin]?.revision?:0)==m.expected){"PERMISSION_CONFLICT"}
   val next=PermissionSnapshot(m.expected+1,m.records)
   staged[m.chainId]=PermissionCommitResult(if(store.wrongAck)next.revision+1 else next.revision,next)
  }
  fence();for(m in mutations){val store=m.backend as RouterStore;store.data[m.origin]=staged.getValue(m.chainId).current;store.writes++}
  groupCommits++;return staged.toMap()
 }
 override fun loadAll()=data.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();if(fail)throw NativeCustodyFailure("FIXTURE_STORE");check((data[origin]?.revision?:0)==expected)
  val next=PermissionSnapshot(expected+1,records);data[origin]=next;writes++;return PermissionCommitResult(next.revision,next)
 }
}
private class RouterUi:NativeApprovalPresenter {
 val pending=mutableMapOf<String,(Boolean)->Unit>();var shown=0;val reviews=mutableListOf<NativeReview>()
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{
  check(review.operationId !in pending);shown++;reviews+=review;pending[review.operationId]=complete
  return{pending.remove(review.operationId);Unit}
 }
 fun choose(id:String,approve:Boolean=true){pending.remove(id)!!(approve)}
}
private class RouterHeldSigner:NativeDigestSigner {
 var release:(()->Unit)?=null;var keyUses=0
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  release={complete(runCatching{requireCurrent();keyUses++;ByteArray(65)})}
 }
}
@Suppress("UNCHECKED_CAST") private fun routerMap(v:Any?)=v as Map<String,Any?>
private class RouterHarness(val sample:Map<String,Any?>,mainSubset:Boolean=false,grouped:Boolean=false){
 val scope:Map<String,String>;val ui=RouterUi();val signer=RouterHeldSigner()
 val accounts=mutableMapOf<String,RouterAccounts>();val stores=mutableMapOf<String,RouterStore>()
 val lanes=mutableMapOf<String,NativeNetworkLane>();val documents=mutableMapOf<String,Map<String,String>>()
 val router:NativeNetworkWalletRouter
 init{
  val a=routerMap(sample["account"]);val context=routerMap(sample["context"])
  scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "network-host","committedUrl" to "${context["origin"]}/dapp")
  for((chain,n)in listOf("tbc:mainnet" to "1","tbc:testnet" to "2")){
   val account=RouterAccounts(NativeAccount(a["address"] as String,a["publicKey"] as String,chain));val store=RouterStore();store.grouped=grouped;accounts[chain]=account;stores[chain]=store
   if(mainSubset&&chain=="tbc:mainnet"){
    val other=NativeAccount("1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP","02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",chain);account.additional=listOf(other)
    val rows=listOf("tbc_accounts","tbc_switchChain","tbc_signMessage").map{name->
     mapOf("id" to "fixture-$name","parentCapability" to name,"invoker" to scope.getValue("origin"),"date" to 1,"caveats" to listOf(mapOf("type" to "restrictChains","value" to listOf(chain)),mapOf("type" to "restrictAccounts","value" to if(name=="tbc_switchChain")listOf(other.accountId)else listOf(account.current.accountId,other.accountId)),mapOf("type" to "restrictMethods","value" to listOf(name))))
    };store.data[scope.getValue("origin")]=PermissionSnapshot(1,rows)
   }
   val custody=NativeCustody(account,chain,store,ui,signer){owner,s->documents[owner]==s}
   lanes[chain]=NativeNetworkLane(n.repeat(64),custody,NativeWalletHost(custody){_,_,_->})
  }
  router=NativeNetworkWalletRouter(lanes,"tbc:testnet",ui){owner,s->documents[owner]==s}
  navigate("view");navigate("other")
 }
 fun navigate(owner:String){documents[owner]=scope;router.navigation(owner,scope)}
 fun grant(chain:String){
  var result:Result<List<Map<String,Any?>>>?=null;val id="grant-$chain"
  lanes.getValue(chain).custody.requestPermissions("view",scope,id,listOf("tbc_accounts","tbc_switchChain","tbc_signMessage").associateWith{mapOf("chains" to listOf(chain))}){result=it}
  ui.choose(id);result!!.getOrThrow()
 }
 fun current()=router.state("view",scope)
 fun dispatch(method:String,expected:NativeNetworkState,fields:Map<String,Any?> = emptyMap(),cb:(Map<String,Any?>)->Unit){router.dispatch("view",scope,expected,method,fields,cb)}
 fun readyHeldSignature(){
  val c=lanes.getValue("tbc:testnet").custody;val a=accounts.getValue("tbc:testnet").current
  val audit=routerMap(sample["audit"]);val request=routerMap(sample["request"]);val context=routerMap(sample["context"])
  c.begin("view",scope,"held","tbc_signMessage",c.snapshot("view",scope).revision,a)
  var consent:Result<Boolean>?=null
  c.consent("view",scope,"held","tbc_signMessage",request,context){consent=it};ui.choose("held");consent!!.getOrThrow()
  val original=routerMap(audit["binding"]);val payload=routerMap(original["payload"])+mapOf("expiresAt" to Instant.now().plusSeconds(120).toString())
  val hash=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(payload).toByteArray()).joinToString(""){"%02x".format(it.toInt()and 255)}
  val binding=original+mapOf("payload" to payload,"bindingHash" to hash);val preview=routerMap(audit["preview"])
  val receipt=c.bind("view",scope,"held",binding,preview,null,mapOf("type" to "tbc.message","version" to "1.0","message" to request["message"]))
  val task=mapOf("taskId" to "sign-message","purpose" to "message","algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to preview["digest"],"signatureEncoding" to "compact65-recoverable","origin" to scope.getValue("origin"),"accountId" to a.accountId,"publicKey" to a.publicKey)
  c.sign("view",scope,"held",receipt,task){check(it.isFailure){"Stale signer must fail before key use"}}
 }
}
private var routerChecks=0
private fun routerYes(value:Boolean){check(value){"router check ${routerChecks+1}"};routerChecks++}
private fun routerReject(action:()->Unit){var failed=false;try{action()}catch(e:Exception){failed=true};routerYes(failed)}
private fun notifications(sample:Map<String,Any?>){
 val h=RouterHarness(sample);h.grant("tbc:testnet");val events=mutableListOf<Pair<String,Map<String,Any?>?>>()
 h.router.installAuthorityChanged{owner,scope,snapshot->check(scope==h.scope);events+=owner to snapshot}
 var granted:Result<List<Map<String,Any?>>>?=null
 h.router.requestPermissions("view",h.scope,"notify-grant","tbc:mainnet",h.current(),mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:mainnet")),"tbc_switchChain" to mapOf("chains" to listOf("tbc:mainnet")))){granted=it}
 routerYes(events.isEmpty());h.ui.choose("notify-grant");granted!!.getOrThrow()
 routerYes(events.size==1&&events[0].first=="other")
 routerYes(routerMap(events[0].second!!["network"])["chainId"]=="tbc:testnet")
 routerYes((events[0].second!!["permissions"] as List<*>).size==5)
 events.clear();h.accounts.getValue("tbc:mainnet").unlocked=false;h.router.accountChanged()
 routerYes(events.size==2&&events.map{it.first}.toSet()==setOf("view","other"))
 routerYes(events.all{(it.second!!["permissions"] as List<*>).size==3})
 h.accounts.getValue("tbc:mainnet").unlocked=true;h.router.accountChanged();events.clear()
 h.router.disconnect("view",h.scope,"notify-disconnect",h.current())
 routerYes(events.size==1&&events[0].first=="other")
 routerYes((events[0].second!!["permissions"] as List<*>).isEmpty())
}
fun main(args:Array<String>){
 val data=routerMap(PermissionJson.decode(JSONObject(File(args[0]).readText())))
 val sample=(data["cases"] as List<*>).map(::routerMap).first{it["method"]=="tbc_signMessage"}
 routerPrivateChannel(sample)
 notifications(sample)
 groupPermissions(sample)
 run{
  val h=RouterHarness(sample);h.grant("tbc:testnet");h.grant("tbc:mainnet");val old=h.current()
  h.readyHeldSignature();routerYes(h.signer.release!=null)
  val other=h.lanes.getValue("tbc:testnet").custody;val a=h.accounts.getValue("tbc:testnet").current
  other.begin("other",h.scope,"other-op","tbc_signMessage",other.snapshot("other",h.scope).revision,a)
  val writes=h.stores.values.sumOf{it.writes};var result:Result<NativeNetworkCommit>?=null
  h.router.switchChain("view",h.scope,"switch","tbc:mainnet",old){result=it}
  routerYes(result==null&&h.current()==old);routerYes(h.ui.reviews.last().chainId=="tbc:mainnet")
  h.ui.choose("switch");val committed=result!!.getOrThrow();h.router.requireDelivery(committed)
  routerYes(h.current()==NativeNetworkState("tbc:mainnet",1));routerYes(h.stores.values.sumOf{it.writes}==writes)
  h.signer.release!!();routerYes(h.signer.keyUses==0);other.check("other",h.scope,"other-op");routerYes(h.router.state("other",h.scope)==old)
  h.dispatch("snapshot",old){routerYes(it["ok"]==false)}
  h.dispatch("snapshot",committed.state){r->routerYes(r["ok"]==true);routerYes(routerMap(routerMap(r["value"])["account"])["chainId"]=="tbc:mainnet")}
  routerReject{other.begin("view",h.scope,"held","tbc_signMessage",other.snapshot("view",h.scope).revision,a)}
  val count=h.ui.shown;var noop:Result<NativeNetworkCommit>?=null
  h.router.switchChain("view",h.scope,"noop","tbc:mainnet",committed.state){noop=it}
  routerYes(noop!!.getOrThrow().eventsJSON=="[]");routerYes(h.ui.shown==count)
  h.router.disconnect("view",h.scope,"disconnect",committed.state)
  h.lanes.values.forEach{routerYes(it.custody.networkAuthority(h.scope.getValue("origin")).switchAccountIds.isEmpty())}
  routerReject{h.router.requireDelivery(committed)}
 }
 for(mode in listOf("reject","cancel","lock","revoke","navigate","close","two-switches")){
  val h=RouterHarness(sample);h.grant("tbc:testnet");h.grant("tbc:mainnet");val before=h.current();var result:Result<NativeNetworkCommit>?=null
  h.router.switchChain("view",h.scope,"switch","tbc:mainnet",before){result=it};val late=h.ui.pending.getValue("switch")
  when(mode){
   "reject"->h.ui.choose("switch",false)
   "cancel"->{h.router.cancelSwitch("view",h.scope,"switch");late(true)}
   "lock"->{h.accounts.getValue("tbc:mainnet").unlocked=false;h.router.accountChanged();late(true)}
   "revoke"->{h.lanes.getValue("tbc:mainnet").custody.disconnect("view",h.scope,"revoke");h.ui.choose("switch")}
   "navigate"->{h.router.invalidate("view");late(true)}
   "close"->{h.router.close();late(true);routerReject{h.lanes.getValue("tbc:testnet").custody.snapshot("other",h.scope)}}
   else->{var second:Result<NativeNetworkCommit>?=null;h.router.switchChain("view",h.scope,"winner","tbc:mainnet",before){second=it};h.ui.choose("winner");second!!.getOrThrow();late(true)}
  }
  routerYes(result!=null);routerYes(result!!.isFailure);routerYes(h.signer.keyUses==0)
  if(mode !in listOf("navigate","close","two-switches"))routerYes(h.current()==before)
 }
 run{val h=RouterHarness(sample);h.grant("tbc:testnet");routerReject{h.router.switchChain("view",h.scope,"ungranted","tbc:mainnet",h.current()){}};routerYes(h.ui.shown==1)}
 run{
  val h=RouterHarness(sample)
  routerReject{NativeNetworkWalletRouter(mapOf("tbc:mainnet" to h.lanes.getValue("tbc:testnet")),"tbc:mainnet",h.ui){_,_->true}}
  routerReject{NativeNetworkWalletRouter(mapOf("tbc:mainnet" to h.lanes.getValue("tbc:testnet"),"tbc:testnet" to h.lanes.getValue("tbc:testnet")),"tbc:testnet",h.ui){_,_->true}}
  val c=NativeCustody(h.accounts.getValue("tbc:testnet"),"tbc:testnet",RouterStore(),h.ui,h.signer,sendSourceIdentity="2".repeat(64)){_,_->true}
  routerReject{c.validateNetworkLane("tbc:testnet","1".repeat(64))}
 }
 run{
  val h=RouterHarness(sample,mainSubset=true);h.grant("tbc:testnet")
  val before=h.current();val c=h.lanes.getValue("tbc:mainnet").custody;val a=h.accounts.getValue("tbc:mainnet");val b=a.additional[0]
  var switched:Result<NativeNetworkCommit>?=null
  h.router.switchChain("view",h.scope,"subset","tbc:mainnet",before){switched=it}
  routerYes(h.ui.reviews.last().accountAddress==b.address);h.ui.choose("subset");val commit=switched!!.getOrThrow()
  val snapshot=h.router.snapshot("view",h.scope,commit.state)
  routerYes(snapshot.account==b);routerYes(snapshot.connectedAccounts==listOf(b));routerYes(a.current!=b)
  routerYes(commit.eventsJSON==PermissionJson.canonical(listOf(mapOf("name" to "chainChanged","payload" to "tbc:mainnet"),mapOf("name" to "accountsChanged","payload" to listOf(b.address)))))
  c.begin("view",h.scope,"secondary","tbc_signMessage",snapshot.revision,b);c.check("view",h.scope,"secondary");routerChecks++
  routerReject{c.begin("view",h.scope,"primary","tbc_signMessage",snapshot.revision,a.current)}
  routerYes(c.snapshot("other",h.scope).connectedAccounts.size==2)
  var back:Result<NativeNetworkCommit>?=null
  h.router.switchChain("view",h.scope,"back","tbc:testnet",commit.state){back=it};h.ui.choose("back")
  routerYes(back!!.getOrThrow().eventsJSON==PermissionJson.canonical(listOf(mapOf("name" to "chainChanged","payload" to "tbc:testnet"),mapOf("name" to "accountsChanged","payload" to listOf(h.accounts.getValue("tbc:testnet").current.address)))))
  routerReject{c.check("view",h.scope,"secondary")}
 }
 run{
  val h=RouterHarness(sample);h.grant("tbc:testnet");val before=h.current();var granted:Result<List<Map<String,Any?>>>?=null
  h.router.requestPermissions("view",h.scope,"target-grant","tbc:mainnet",before,mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:mainnet")),"tbc_switchChain" to mapOf("chains" to listOf("tbc:mainnet")))){granted=it}
  routerYes(granted==null);h.ui.choose("target-grant");routerYes(granted!!.getOrThrow().size==2);routerYes(h.current()==before)
  routerYes(h.router.permissions("view",h.scope).size==5)
 }
 run{
  val h=RouterHarness(sample);h.grant("tbc:testnet");h.grant("tbc:mainnet");h.stores.getValue("tbc:mainnet").fail=true
  routerReject{h.router.disconnect("view",h.scope,"disconnect",h.current())}
  routerYes(h.lanes.getValue("tbc:testnet").custody.networkAuthority(h.scope.getValue("origin")).switchAccountIds.isEmpty())
  routerReject{h.lanes.getValue("tbc:mainnet").custody.networkAuthority(h.scope.getValue("origin"))}
 }
 println("{\"status\":\"NATIVE_NETWORK_CUSTODY_ROUTER_PASS\",\"checks\":$routerChecks,\"keyUsesAfterSwitch\":0,\"broadcasts\":0}")
}

private fun groupPermissions(sample:Map<String,Any?>){
 val chains=listOf("tbc:mainnet","tbc:testnet")
 fun start(h:RouterHarness,id:String,reply:(Map<String,Any?>)->Unit){
  val state=h.current()
  h.router.dispatch("permissions.request",mapOf("ownerId" to "view","scope" to h.scope,"network" to mapOf("chainId" to state.chainId,"revision" to state.revision),"operation" to id,"providerMethod" to "wallet_requestPermissions",
   "permissions" to mapOf("tbc_accounts" to mapOf("chains" to chains),"tbc_switchChain" to mapOf("chains" to chains),"tbc_signMessage" to mapOf("chains" to listOf("tbc:testnet")))) ,reply)
 }
 run{
  val h=RouterHarness(sample,grouped=true);val before=h.current();var result:Map<String,Any?>?=null;val events=mutableListOf<String>();val observed=mutableListOf<Int>()
  h.router.installAuthorityChanged{owner,_,snapshot->events+=owner;observed+=(snapshot?.get("permissions") as? List<*>)?.size?:-1}
  start(h,"group-ok"){result=it}
  routerYes(result==null&&h.ui.shown==1&&h.stores.values.all{it.writes==0})
  routerYes(h.ui.reviews.last().description.contains("tbc:mainnet")&&h.ui.reviews.last().description.contains("tbc:testnet"))
  h.ui.choose("group-ok");routerYes(result?.get("ok")==true)
  routerYes((result?.get("value") as? List<*>)?.size==5)
  routerYes(h.stores.values.all{it.writes==1}&&h.stores.values.sumOf{it.groupCommits}==1)
  routerYes(h.current()==before&&h.signer.keyUses==0)
  routerYes(events==listOf("other")&&observed==listOf(5))
  for(chain in chains){val p=NativePermissions(h.accounts.getValue(chain),chain,h.stores.getValue(chain)){}
   routerYes(p.permits(h.scope.getValue("origin"),"tbc_accounts")&&p.permits(h.scope.getValue("origin"),"tbc_switchChain"))
   routerYes(p.permits(h.scope.getValue("origin"),"tbc_signMessage")==("tbc:testnet"==chain))
  }
 }
 run{
  val h=RouterHarness(sample,grouped=true);var first:Map<String,Any?>?=null;var duplicate:Map<String,Any?>?=null
  start(h,"duplicate"){first=it};start(h,"duplicate"){duplicate=it}
  routerYes(first==null&&duplicate?.get("ok")==false&&h.ui.shown==1)
  h.router.cancelSwitch("view",h.scope,"duplicate")
  routerYes(first?.get("ok")==false&&h.ui.pending.isEmpty()&&h.stores.values.all{it.writes==0})
 }
 for(mode in listOf("reject","cancel","lock","navigate","close","stale-grant","switch","store-fail","bad-ack")){
  val h=RouterHarness(sample,grouped=true)
  if(mode=="switch"){h.grant("tbc:mainnet");h.grant("tbc:testnet")}
  val beforeWrites=h.stores.values.sumOf{it.writes};var result:Map<String,Any?>?=null;var replies=0
  start(h,"group-$mode"){result=it;replies++};val late=h.ui.pending.getValue("group-$mode")
  when(mode){
   "reject"->h.ui.choose("group-$mode",false)
   "cancel"->{h.router.cancelSwitch("view",h.scope,"group-$mode");late(true)}
   "lock"->{h.accounts.getValue("tbc:mainnet").unlocked=false;h.router.accountChanged();late(true)}
   "navigate"->{h.router.invalidate("view");late(true)}
   "close"->{h.router.close();late(true)}
   "stale-grant"->{h.lanes.getValue("tbc:mainnet").custody.disconnect("view",h.scope,"revoke-group");late(true)}
   "switch"->{h.router.switchChain("view",h.scope,"switch-group","tbc:mainnet",h.current()){};h.ui.choose("switch-group");late(true)}
   "store-fail"->{h.stores.getValue("tbc:testnet").fail=true;h.ui.choose("group-$mode")}
   else->{h.stores.getValue("tbc:testnet").wrongAck=true;h.ui.choose("group-$mode")}
  }
  routerYes(result?.get("ok")==false&&replies==1)
  routerYes(h.signer.keyUses==0&&h.ui.pending.isEmpty())
  routerYes(h.stores.values.sumOf{it.writes}==beforeWrites+when(mode){"stale-grant"->1;"bad-ack"->2;else->0})
  if(mode in listOf("store-fail","bad-ack"))for(chain in chains)routerReject{h.lanes.getValue(chain).custody.networkAuthority(h.scope.getValue("origin"))}
 }
}

private fun routerPrivateChannel(sample:Map<String,Any?>){
 val h=RouterHarness(sample);h.grant("tbc:testnet")
 fun operation(id:String)=PermissionJson.id("P4/rpc",h.scope.getValue("sessionId"),PermissionJson.canonical(id))
 fun call(method:String,fields:Map<String,Any?> = emptyMap(),expected:NativeNetworkState?=null):Map<String,Any?>{
  val base=mapOf("ownerId" to "view","scope" to h.scope)
  val input=if(method=="network.snapshot")base else {val s=expected?:h.current();base+mapOf("network" to mapOf("chainId" to s.chainId,"revision" to s.revision))}
  var result:Map<String,Any?>?=null;h.router.dispatch(method,input+fields){result=it};return result!!
 }
 fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray()).joinToString(""){"%02x".format(it)}
 fun frame(id:String,value:Any?,events:Any):String{
  val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to id,"result" to value),"events" to events)
  return PermissionJson.canonical(payload+mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to h.scope["sessionId"],"navigationId" to h.scope["navigationId"],"messageId" to "network-check","deliveryId" to hash(payload)))
 }
 fun prepare(method:String,id:String,text:String)=call("delivery.prepare",mapOf("method" to method,"requestId" to id,"serialized" to text))["ok"]==true
 fun allow(text:String)=h.router.allowDelivery("view",h.scope,text)
 val boot=routerMap(call("network.snapshot")["value"]);routerYes(routerMap(boot["sources"]).size==2&&routerMap(boot["lanes"]).size==2)
 val caps=call("network.capabilities",mapOf("operation" to operation("caps"),"chainId" to "tbc:mainnet","address" to null));routerYes(caps["ok"]==true)
 val capFrame=frame("caps",caps["value"],emptyList<Any>());routerYes(prepare("tbc_getCapabilities","caps",capFrame)&&allow(capFrame))
 routerYes(call("network.capabilities",mapOf("operation" to operation("private-cap"),"chainId" to "tbc:mainnet","address" to h.accounts.getValue("tbc:mainnet").current.address))["ok"]==false)
 routerYes(call("network.switch",mapOf("operation" to "unknown","chainId" to "tbc:unknown"))["code"]=="UNSUPPORTED_CHAIN")
 val writes=h.stores.values.sumOf{it.writes}
 routerYes(call("permissions.request",mapOf("operation" to "multi","providerMethod" to "wallet_requestPermissions","permissions" to mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:testnet","tbc:mainnet")))))["ok"]==false)
 routerYes(h.stores.values.sumOf{it.writes}==writes)
 val before=h.current();val grantId=operation("grant-target");var granted:Map<String,Any?>?=null
 h.router.dispatch("permissions.request",mapOf("ownerId" to "view","scope" to h.scope,"network" to mapOf("chainId" to before.chainId,"revision" to before.revision),"operation" to grantId,"providerMethod" to "wallet_requestPermissions","permissions" to mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:mainnet")),"tbc_switchChain" to mapOf("chains" to listOf("tbc:mainnet"))))){granted=it}
 routerYes(granted==null);h.ui.choose(grantId);routerYes(granted?.get("ok")==true);routerYes(h.current()==before)
 val rows=h.router.permissions("view",h.scope);val all=frame("perms",rows,emptyList<Any>());routerYes(prepare("wallet_getPermissions","perms",all)&&allow(all))
 val partial=frame("partial",rows.take(1),emptyList<Any>());routerYes(!prepare("wallet_getPermissions","partial",partial)&&!allow(partial))
 val switchId=operation("switch-channel");var switched:Map<String,Any?>?=null
 h.router.dispatch("network.switch",mapOf("ownerId" to "view","scope" to h.scope,"network" to mapOf("chainId" to before.chainId,"revision" to before.revision),"operation" to switchId,"chainId" to "tbc:mainnet")){switched=it}
 routerYes(switched==null);h.ui.choose(switchId);routerYes(switched?.get("ok")==true)
 val events=switched!!.getValue("value")!!;val ok=frame("switch-channel",null,events);routerYes(prepare("tbc_switchChain","switch-channel",ok)&&allow(ok))
 val missing=frame("switch-channel",null,emptyList<Any>());routerYes(!prepare("tbc_switchChain","switch-channel",missing)&&!allow(missing))
 val forged=frame("switch-channel",mapOf("not" to "null"),events);routerYes(!prepare("tbc_switchChain","switch-channel",forged)&&!allow(forged))
 routerYes(call("snapshot",expected=before)["ok"]==false)
 routerYes(call("snapshot",mapOf("network" to mapOf("chainId" to "tbc:mainnet","revision" to true)))["ok"]==false)
 routerYes(!allow(all));val shown=h.ui.shown
 val noop=call("network.switch",mapOf("operation" to operation("noop-channel"),"chainId" to "tbc:mainnet"));routerYes(noop["ok"]==true&&PermissionJson.canonical(noop["value"])=="[]"&&h.ui.shown==shown)
 val noopFrame=frame("noop-channel",null,emptyList<Any>());routerYes(prepare("tbc_switchChain","noop-channel",noopFrame)&&allow(noopFrame))
 val dis=call("permissions.disconnect",mapOf("operation" to operation("disconnect-channel")));routerYes(dis["ok"]==true)
 val revoked=frame("disconnect-channel",null,listOf(mapOf("name" to "permissionsChanged","payload" to emptyList<Any>()),mapOf("name" to "accountsChanged","payload" to emptyList<Any>())))
 routerYes(prepare("tbc_disconnect","disconnect-channel",revoked)&&allow(revoked));routerYes(!allow(ok));routerYes(h.signer.keyUses==0)
}
