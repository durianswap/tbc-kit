package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

// Public-signature replay, actual custody owner; no HTTP or test key default.
@Suppress("UNCHECKED_CAST") private fun map(x:Any?)=x as Map<String,Any?>
private fun rows(x:Any?)=(x as List<*>).map{map(it)}
private fun hash(x:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(x).toByteArray()).joinToString(""){"%02x".format(it)}
private fun raw(s:String)=s.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
private var checks=0
private fun yes(v:Boolean){check(v){"send custody check ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var failed=false;try{f()}catch(e:Exception){failed=true};yes(failed)}
private class Accounts(a:List<Map<String,Any?>>):NativeAccountSource{
 override val signingAccounts=a.map{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 override var current=signingAccounts[0];override var revision=0L;override var unlocked=true
}
private class Store:NativePermissionBackend{
 val values=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=values.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{fence();check((values[origin]?.revision?:0L)==expected);val v=PermissionSnapshot(expected+1,records);values[origin]=v;writes++;return PermissionCommitResult(v.revision,v)}
}
private class UI:NativeApprovalPresenter{
 val reviews=mutableMapOf<String,NativeReview>();val pending=mutableMapOf<String,(Boolean)->Unit>();var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;reviews[review.operationId]=review;pending[review.operationId]=complete;return {pending.remove(review.operationId);Unit}}
 fun choose(id:String,approved:Boolean=true){pending.remove(id)!!.invoke(approved)}
}
private class Signer(val signed:List<Map<String,Any?>>):NativeDigestSigner{
 var calls=0
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  calls++;complete(runCatching{requireCurrent();val d=digest.joinToString(""){"%02x".format(it)}
   val s=signed.firstOrNull{val t=map(it["task"]);t["digest"]==d&&t["signatureEncoding"]==encoding&&t["accountId"]==account.accountId&&t["publicKey"]==account.publicKey}?:error("TEST_UNRECORDED_TASK")
   raw(map(s["result"])["signature"] as String)
  })
 }
}
private class Harness(val sample:Map<String,Any?>,enabled:Boolean=true,source:String="a".repeat(64),val id:String="op",navigate:Boolean=true){
 val accounts=Accounts(rows(sample["accounts"]));val store=Store();val ui=UI();val signer=Signer(rows(sample["signed"]))
 val scope=map(sample["context"]).filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "send-check","committedUrl" to (map(sample["context"])["origin"] as String)+"/dapp")
 val c=NativeCustody(accounts,accounts.current.chainId,store,ui,signer,sendSourceIdentity=if(enabled)source else null){owner,value->owner=="view"&&value==scope}
 var receipt=emptyMap<String,Any?>()
 val host=NativeWalletHost(c){_,_,_->}
 val method get()=sample["method"] as String
 val workflow get()=sample["workflow"] as Boolean
 init{if(navigate)c.navigation("view",scope)}
 fun grant(omitting:String?=null){
  val request=mutableMapOf<String,Any?>();for(p in sample["permissions"] as List<*>)if(p!=omitting)request[p as String]=mapOf("chains" to listOf(accounts.current.chainId))
  request["tbc_accounts"]=mapOf("chains" to listOf(accounts.current.chainId),"maxAccounts" to accounts.signingAccounts.size)
  var r:Result<List<Map<String,Any?>>>?=null;c.requestPermissions("view",scope,"grant",request){r=it};ui.choose("grant");r!!.getOrThrow()
 }
 fun begin(){c.begin("view",scope,id,method,c.snapshot("view",scope).revision,accounts.current)}
 fun ready(approve:Boolean=true){
  grant();begin();val request=map(sample["request"]);val context=map(sample["context"])
  if(request["signingRoles"]!=null)c.resolveSigningAccounts("view",scope,id,request,context)
  var r:Result<Boolean>?=null;c.consent("view",scope,id,method,request,context){r=it}
  yes(ui.shown==2&&r==null);yes(ui.reviews.getValue(id).description.contains(if(NativePrepared.sends(method))"wallet will submit" else "no broadcast",ignoreCase=true));ui.choose(id,approve);yes(r!!.getOrThrow()==approve)
  if(!approve)return
  receipt=if(workflow){var b:Result<Map<String,Any?>>?=null;c.bindWorkflow("view",scope,id,map(sample["binding"]),map(sample["preview"]),map(sample["plan"])){b=it};b!!.getOrThrow()}
  else c.bind("view",scope,id,map(sample["binding"]),map(sample["preview"]),map(sample["plan"]),null)
 }
 fun approved(value:Any?):Any?=when(value){
  is List<*>->value.map{approved(it)}
  is Map<*,*>->map(value).mapValues{(k,v)->when(k){"approvalId"->receipt["approvalId"];"bindingHash"->receipt["bindingHash"];else->approved(v)}}
  else->value
 }
 fun authorize(bundle:Map<String,Any?>?=null,claimedWorkflow:Map<String,Any?>?=null){
  val input=mapOf("ownerId" to "view","scope" to scope,"operation" to id,"receipt" to receipt,"bundle" to (bundle?:map(approved(sample["bundle"]))),"workflow" to (claimedWorkflow?:sample["result"]?.let{map(approved(it))}))
  var r:Map<String,Any?>?=null;var replies=0;host.dispatch("signing.broadcast.authorize",input){r=it;replies++};yes(replies==1)
  if(r?.get("ok")!=true){yes(r==mapOf("ok" to false,"code" to "NATIVE_DENIED"));throw NativeCustodyFailure("TEST_CHANNEL_DENIED")};yes(r?.get("value")==true)
 }
 fun selection(index:Int?)=c.broadcastSelection("view",scope,id,receipt,index)
 fun finishSignatures(){
  for(step in rows(sample["steps"])){if(workflow)c.enterWorkflowStep("view",scope,id,receipt,map(step["entry"]))
   for(stage in rows(step["stages"])){stage["pending"]?.let{c.advance("view",scope,id,receipt,map(approved(it)))}
    for(task in rows(stage["tasks"])){var r:Result<Map<String,Any?>>?=null;c.sign("view",scope,id,receipt,task){r=it};r!!.getOrThrow()}
   }
   if(workflow){var r:Result<Boolean>?=null;c.finishWorkflowStep("view",scope,id,receipt,map(approved(step["outcome"]))){r=it};yes(r!!.getOrThrow())}
  }
 }
 fun publicResult(statuses:List<String>?=null):Map<String,Any?>{
  val bundle=map(approved(sample["bundle"]));val txs=rows(bundle["transactions"])
  if(!workflow)return bundle+mapOf("transactions" to txs.map{tx->mapOf("id" to tx["id"],"txid" to tx["txid"],"status" to "submitted","role" to tx["role"],"dependsOn" to tx["dependsOn"])})
  val states=statuses?:txs.map{"accepted"};val set=states.toSet()
  val status=when{set.all{it in setOf("accepted","known")}->"complete";set==setOf("unknown")->"unknown";set==setOf("rejected")->"rejected";else->"partial"}
  return mapOf("version" to "1.0","status" to status,"workflow" to approved(sample["result"]),"transactions" to txs.zip(states).map{(tx,s)->mapOf("txid" to tx["txid"],"status" to s)})
 }
 fun finish(result:Map<String,Any?>){c.finishBroadcast("view",scope,id,receipt,result)}
}
fun main(args:Array<String>){
 val root=map(PermissionJson.decode(JSONObject(File(args[0]).readText())));val cases=rows(root["cases"]);var signatures=0
 for(row in rows(root["sources"])){
  val options=map(row["options"]);val endpoint=options["endpoint"]?.let{map(it)}
  val configuration=NativeBroadcastConfiguration(options["network"] as String,endpoint?.get("apiOrigin") as? String,endpoint?.get("trustId") as? String,endpoint?.get("rpcOrigin") as? String)
  yes(configuration.sourceIdentity==row["sourceIdentity"])
 }
 for(sample in cases){
  val h=Harness(sample);yes(h.c.snapshot("view",h.scope).optionalMethods.isEmpty());rejects{h.host.installBroadcast{_,_,_->}};h.ready();rejects{h.authorize()};rejects{h.selection(if(h.workflow)null else 0)};h.finishSignatures();signatures+=h.signer.calls
  val original=map(h.approved(sample["bundle"]))
  rejects{h.authorize(original+mapOf("from" to "foreign-account"))};rejects{h.authorize(original+mapOf("totalFee" to "0"))}
  val txs=rows(original["transactions"]).toMutableList();txs[0]=txs[0]+mapOf("txid" to "0".repeat(64));rejects{h.authorize(original+mapOf("transactions" to txs))}
  if(h.workflow)rejects{h.authorize(null,map(h.approved(sample["result"]))+mapOf("steps" to emptyList<Any>()))}
  rejects{h.c.authorizeBroadcast("view",h.scope,"op",h.receipt+mapOf("approvalId" to "foreign"),original)}
  h.authorize();rejects{h.authorize()};val selection=h.selection(if(h.workflow)null else 0)
  yes(selection["sourceIdentity"]=="a".repeat(64));yes(selection["accountScopeHash"]==hash(h.accounts.current.identity()));yes((selection["authorizationId"] as String).length==64)
  val expected=rows(original["transactions"]);yes(PermissionJson.canonical(selection["transactions"])==PermissionJson.canonical(if(h.workflow)expected else listOf(expected[0])))
  @Suppress("UNCHECKED_CAST") val changed=(selection["transactions"] as List<*>)[0] as MutableMap<String,Any?>
  val before=PermissionJson.canonical(selection["transactions"]);changed["rawTransaction"]="00"
  yes(PermissionJson.canonical(h.selection(if(h.workflow)null else 0)["transactions"])==before)
  var denied:Map<String,Any?>?=null;h.host.dispatch("signing.broadcast.authorize",mapOf("ownerId" to "view","scope" to h.scope,"operation" to "op","receipt" to h.receipt,"bundle" to emptyMap<String,Any?>(),"workflow" to null,"endpoint" to "https://untrusted.invalid")){denied=it}
  yes(denied==mapOf("ok" to false,"code" to "NATIVE_DENIED"))
  rejects{h.selection(if(h.workflow)0 else null)};rejects{h.selection(-1)};rejects{h.selection(99)}
  h.accounts.unlocked=false;rejects{h.selection(if(h.workflow)null else 0)};h.accounts.unlocked=true
  yes(h.ui.shown==2&&h.store.writes==1);h.c.close("view",h.scope,"op");yes(!h.c.mayDeliverSignature("view",h.scope,"op"));yes(!h.c.mayDeliverWorkflowResult("view",h.scope,"op",h.method,"none"));rejects{h.selection(if(h.workflow)null else 0)}
 }
 for(sample in cases){val h=Harness(sample);h.grant("tbc_sendTransaction");rejects{h.begin()};yes(h.signer.calls==0&&h.ui.shown==1);val disabled=Harness(sample,false);rejects{disabled.grant()};yes(disabled.ui.shown==0)}
 val single=cases.first{it["workflow"]==false}
 run{val h=Harness(single);h.ready(false);rejects{h.authorize()};yes(h.signer.calls==0)}
 run{val h=Harness(single);h.ready();h.finishSignatures();h.authorize();h.c.cancel("view",h.scope,"op");rejects{h.selection(0)}}
 run{val h=Harness(single);h.ready();h.finishSignatures();h.authorize();h.c.invalidate("view");rejects{h.selection(0)}}
 run{val h=Harness(single);h.ready();h.finishSignatures();h.authorize();h.accounts.revision++;rejects{h.selection(0)}}
 run{val h=Harness(single);h.ready();h.finishSignatures();h.authorize();h.c.disconnect("view",h.scope,"revoke");rejects{h.selection(0)}}
 for(sample in rows(root["signOnly"])){val h=Harness(sample);h.ready();h.finishSignatures();rejects{h.authorize()};h.c.close("view",h.scope,"op")
  if(h.workflow)yes(h.c.mayDeliverWorkflowResult("view",h.scope,"op",h.method,hash(h.approved(sample["result"]))))else yes(h.c.mayDeliverSignature("view",h.scope,"op"))
 }
 val before=checks;if(args.size==3)dispatchCases(cases,args[1],args[2]);val dispatchChecks=checks-before
 val routed=checks;if(args.size==3)routerCases(cases,args[1],args[2]);val routerChecks=checks-routed
 println(JSONObject(mapOf("status" to "PASS","checks" to checks,"dispatchChecks" to dispatchChecks,"routerChecks" to routerChecks,"cases" to cases.size,"signatureReplays" to signatures,"broadcasts" to 0)))
}
private fun routerCases(cases:List<Map<String,Any?>>,origin:String,directory:String){
 val configuration=NativeBroadcastConfiguration("testnet");val source=configuration.sourceIdentity
 val replies=LinkedBlockingQueue<()->Unit>();val http=NativeBroadcastHTTP(source){replies.add(it)}
 rejects{NativeBroadcastConfiguration("mainnet","https://api.tbcdev.org","wrong")}
 rejects{NativeBroadcastConfiguration("testnet","https://custom.invalid")}
 rejects{NativeBroadcastConfiguration("testnet","https://custom.invalid:443","bad")}
 for(sample in cases){
  val id=PermissionJson.id("P4/rpc",map(sample["context"])["sessionId"] as String,PermissionJson.canonical("send-request"))
  val h=Harness(sample,source=source,id=id,navigate=false)
  val router=NativeBroadcastRouter(h.c,configuration,File(directory),"router-"+(sample["name"] as String)){request,fence,reply->
   val loop=NativeBroadcastHTTPRequest(request.sourceIdentity,request.method,URL(origin+request.url.path),request.body,request.deadline)
   http.start(loop,fence,reply)
  }
  h.host.installBroadcast(router::dispatch);rejects{h.host.installBroadcast{_,_,_->}}
  h.c.navigation("view",h.scope);yes(h.c.snapshot("view",h.scope).optionalMethods==NativePrepared.sendMethods)
  h.ready();h.finishSignatures();h.authorize()
  val selected=h.selection(if(h.workflow)null else 0);val txs=rows(selected["transactions"]);val index=if(h.workflow)null else 0
  val params=mapOf("version" to "1.0","chainId" to "tbc:testnet","idempotencyKey" to "route",(if(h.workflow)"transactions" else "transaction") to if(h.workflow)txs else txs[0])
  val call=mapOf("callId" to "route","operation" to if(h.workflow)"broadcast.submitBatch" else "broadcast.submit","execution" to mapOf("type" to "session-only"),"params" to params)
  val base=mapOf("ownerId" to "view","scope" to h.scope,"operation" to h.id,"receipt" to h.receipt,"index" to index)
  fun command(method:String,fields:Map<String,Any?>,inputBase:Map<String,Any?> = base):Map<String,Any?>{
   var result:Map<String,Any?>?=null;h.host.dispatch(method,inputBase+fields){result=it}
   val stop=System.nanoTime()+TimeUnit.SECONDS.toNanos(20)
   while(result==null&&System.nanoTime()<stop)replies.poll(100,TimeUnit.MILLISECONDS)?.invoke()
   return result?:error("router response timeout")
  }
  fun success(method:String,fields:Map<String,Any?>,inputBase:Map<String,Any?> = base):Map<String,Any?>{val r=command(method,fields,inputBase);yes(r["ok"]==true);return r}
  val opened=success("signing.broadcast.open",mapOf("call" to call));yes(map(opened["value"])["sourceIdentity"]==source)
  yes(command("signing.broadcast.open",mapOf("call" to call))["ok"]==false)
  yes(command("signing.broadcast.guard",mapOf("call" to call,"endpoint" to "https://foreign.invalid"))["ok"]==false)
  yes(command("signing.broadcast.guard",mapOf("call" to call),base+mapOf("receipt" to mapOf("approvalId" to "foreign")))["ok"]==false)
  success("signing.broadcast.guard",mapOf("call" to call))
  val identities=txs.mapIndexed{i,tx->
   val key=if(h.workflow)"route:$i" else "route"
   val context=mutableMapOf<String,Any?>("version" to "1.0","callId" to "route","operation" to call["operation"],"params" to params);if(h.workflow)context["index"]=i
   mapOf("idempotencyKey" to "tbcnet-${source.take(24)}-"+hash(mapOf("idempotencyKey" to key)),"rawHash" to MessageDigest.getInstance("SHA-256").digest(raw(tx["rawTransaction"] as String)).joinToString(""){"%02x".format(it)},"txid" to tx["txid"],"submitContextHash" to hash(context),"accountScopeHash" to hash(h.accounts.current.identity()))
  }
  success("signing.broadcast.journal",mapOf("action" to "begin","arguments" to mapOf("identities" to identities)))
  success("signing.broadcast.journal",mapOf("action" to "admit","arguments" to mapOf("identities" to identities)))
  val body=PermissionJson.canonical(if(h.workflow)txs.map{mapOf("txraw" to it["rawTransaction"])}else mapOf("txraw" to txs[0]["rawTransaction"]))
  val wire=mutableMapOf<String,Any?>("method" to "POST","url" to configuration.apiOrigin+(if(h.workflow)"/api/tbc/broadcasttxs" else "/api/tbc/broadcasttx"),"body" to body,"deadline" to "2000-01-01T00:00:00Z")
  yes(command("signing.broadcast.wire",wire)["ok"]==false);wire["deadline"]=java.time.Instant.now().plusSeconds(15).toString()
  val response=success("signing.broadcast.wire",wire);yes(map(response["value"])["statusCode"]==200);yes(java.util.Base64.getDecoder().decode(map(response["value"])["body"] as String).isNotEmpty())
  for(id in identities)success("signing.broadcast.journal",mapOf("action" to "complete","arguments" to mapOf("identity" to id,"status" to "accepted")))
  yes(command("signing.broadcast.wire",wire)["ok"]==false)
  val result=h.publicResult()
  fun finish(r:Map<String,Any?>)=command("signing.broadcast.finish",mapOf("result" to r),base.filterKeys{it!="index"})["ok"]==true
  val writes=h.store.writes;val approvals=h.ui.shown
  if(!h.workflow){
   val count=rows(map(sample["bundle"])["transactions"]).size
   for(index in 1 until count){
    yes(!finish(result)) // A successful prefix is not the complete send.
    val tx=rows(h.selection(index)["transactions"])[0];val key="route-$index"
    val params=mapOf("version" to "1.0","chainId" to "tbc:testnet","idempotencyKey" to key,"transaction" to tx)
    val call=mapOf("callId" to key,"operation" to "broadcast.submit","execution" to mapOf("type" to "session-only"),"params" to params)
    val stage=base+mapOf("index" to index)
    success("signing.broadcast.open",mapOf("call" to call),stage)
    val identity=mapOf("idempotencyKey" to "tbcnet-${source.take(24)}-"+hash(mapOf("idempotencyKey" to key)),"rawHash" to MessageDigest.getInstance("SHA-256").digest(raw(tx["rawTransaction"] as String)).joinToString(""){"%02x".format(it)},"txid" to tx["txid"],"submitContextHash" to hash(mapOf("version" to "1.0","callId" to key,"operation" to "broadcast.submit","params" to params)),"accountScopeHash" to hash(h.accounts.current.identity()))
    success("signing.broadcast.journal",mapOf("action" to "begin","arguments" to mapOf("identities" to listOf(identity))),stage)
    success("signing.broadcast.journal",mapOf("action" to "admit","arguments" to mapOf("identities" to listOf(identity))),stage)
    val wire=mapOf("method" to "POST","url" to configuration.apiOrigin+"/api/tbc/broadcasttx","body" to PermissionJson.canonical(mapOf("txraw" to tx["rawTransaction"])),"deadline" to java.time.Instant.now().plusSeconds(15).toString())
    val response=success("signing.broadcast.wire",wire,stage);yes(map(response["value"])["statusCode"]==200)
    success("signing.broadcast.journal",mapOf("action" to "complete","arguments" to mapOf("identity" to identity,"status" to "accepted")),stage)
    yes(command("signing.broadcast.wire",wire,stage)["ok"]==false)
   }
  }
  val canFinish=true
  run{
   yes(!finish(result+mapOf("extra" to "not-authorized")))
   var changed=rows(result["transactions"]).toMutableList();changed[0]=changed[0]+mapOf("txid" to "0".repeat(64));yes(!finish(result+mapOf("transactions" to changed)))
   changed=rows(result["transactions"]).toMutableList();changed[0]=changed[0]+mapOf("status" to "unknown");yes(!finish(result+mapOf("transactions" to changed)))
   yes(finish(result));yes(!finish(result))
  }
  yes(h.ui.shown==approvals&&h.store.writes==writes)
  yes(command("signing.broadcast.wire",wire)["ok"]==false)
  h.c.close("view",h.scope,h.id);yes(!h.c.mayDeliverSignature("view",h.scope,h.id))
  fun delivery(value:Map<String,Any?>):String{
   val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to "send-request","result" to value),"events" to emptyList<Any>())
   return PermissionJson.canonical(mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to h.scope["sessionId"],"navigationId" to h.scope["navigationId"],"messageId" to "send-host","deliveryId" to hash(payload))+payload)
  }
  fun prepare(text:String,method:String=h.method)=command("delivery.prepare",mapOf("method" to method,"requestId" to "send-request","serialized" to text),mapOf("ownerId" to "view","scope" to h.scope))["ok"]==true
  val text=delivery(result);yes(!h.host.allowDelivery("view",h.scope,text));yes(prepare(text)==canFinish);yes(h.host.allowDelivery("view",h.scope,text)==canFinish)
  val bad=delivery(result+mapOf("totalFee" to "0"));yes(!prepare(bad)&&!h.host.allowDelivery("view",h.scope,bad));yes(!prepare(text,"tbc_signTransaction"))
  h.accounts.unlocked=false;yes(!h.host.allowDelivery("view",h.scope,text));h.accounts.unlocked=true
  if(canFinish){yes(h.host.allowDelivery("view",h.scope,text));h.c.disconnect("view",h.scope,"revoke");yes(!h.host.allowDelivery("view",h.scope,text))}
  yes(command("signing.broadcast.guard",mapOf("call" to call))["ok"]==false);router.close()
 }
}
private fun dispatchCases(cases:List<Map<String,Any?>>,origin:String,directory:String){
 val api="https://api.tbcdev.org";val source="a".repeat(64);val replies=LinkedBlockingQueue<()->Unit>()
 val http=NativeBroadcastHTTP(source){replies.add(it)}
 data class Fixture(val h:Harness,val store:SystemBroadcastStore,val adapter:NativeBroadcastDispatch,val call:Map<String,Any?>,val body:String)
 fun setup(sample:Map<String,Any?>,suffix:String,route:String?=null):Fixture{
  val h=Harness(sample);h.ready();h.finishSignatures();h.authorize()
  val chosen=h.selection(if(h.workflow)null else 0);val txs=rows(chosen["transactions"]);val key=(sample["name"] as String)+suffix
  val params=mapOf("version" to "1.0","chainId" to h.accounts.current.chainId,"idempotencyKey" to key,(if(h.workflow)"transactions" else "transaction") to if(h.workflow)txs else txs[0])
  val call=mapOf("callId" to key,"operation" to if(h.workflow)"broadcast.submitBatch" else "broadcast.submit","execution" to mapOf("type" to "session-only"),"params" to params)
  val store=SystemBroadcastStore(File(directory),key,source,chosen["accountScopeHash"] as String)
  val adapter=h.c.makeBroadcastDispatch("view",h.scope,"op",h.receipt,if(h.workflow)null else 0,store,api,h.accounts.current.chainId,call){request,fence,reply->
   val loop=NativeBroadcastHTTPRequest(request.sourceIdentity,request.method,URL(origin+(if(request.method=="POST")route?:request.url.path else request.url.path)),request.body,request.deadline)
   http.start(loop,fence,reply)
  }
  val body=PermissionJson.canonical(if(h.workflow)txs.map{mapOf("txraw" to it["rawTransaction"])} else mapOf("txraw" to txs[0]["rawTransaction"]))
  return Fixture(h,store,adapter,call,body)
 }
 fun wire(a:NativeBroadcastDispatch,method:String,path:String,body:String?):Result<NativeBroadcastHTTPResponse>{
  var result:Result<NativeBroadcastHTTPResponse>?=null
  try{a.wire(method,api+path,body){result=it};rejects{a.deliveryState()}}catch(e:Exception){result=Result.failure(e)}
  val stop=System.nanoTime()+TimeUnit.SECONDS.toNanos(20)
  while(result==null&&System.nanoTime()<stop)replies.poll(100,TimeUnit.MILLISECONDS)?.invoke()
  return result?:error("test response deadline")
 }
 for(sample in cases){
  val (h,store,a,call,body)=setup(sample,"-ok")
  a.guardCall(call);rejects{a.guardCall(call+mapOf("callId" to "foreign"))}
  yes(a.begin(a.identities).created);yes(!a.begin(a.identities).created)
  rejects{a.deliveryState()};rejects{h.finish(h.publicResult())}
  val id=a.identities[0];rejects{a.complete(id,"accepted")};rejects{a.read("foreign")}
  rejects{a.admit(a.identities.reversed()+id)};a.admit(a.identities);rejects{a.admit(a.identities)}
  rejects{a.deliveryState()}
  val path=if(h.workflow)"/api/tbc/broadcasttxs" else "/api/tbc/broadcasttx"
  rejects{a.wire("POST","https://foreign.invalid"+path,body){error("foreign dispatch")}}
  rejects{a.wire("POST",api+path,"{\"txraw\":\"00\"}"){error("replacement dispatch")}}
  yes(wire(a,"POST",path,body).getOrThrow().status==200)
  yes(a.deliveryState().all{it["status"]=="unknown"});rejects{h.finish(h.publicResult())}
  a.identities.forEach{a.complete(it,"accepted");yes(a.read(it.idempotencyKey)?.state=="completed")}
  rejects{a.wire("POST",api+path,body){error("replay")}}
  yes(a.readByTxids(a.identities.map{it.txid}).size==a.identities.size)
  if(h.workflow||rows(map(sample["bundle"])["transactions"]).size==1){h.finish(h.publicResult());rejects{h.finish(h.publicResult())};rejects{a.complete(id,"accepted")}}
  else rejects{h.finish(h.publicResult())}
  h.c.close("view",h.scope,"op");rejects{a.guardCall(call)};store.close()
 }
 val batch=cases.first{it["workflow"]==true&&rows(map(it["bundle"])["transactions"]).size==2}
 for(mode in listOf("unknown","rejected","partial")){
  val (h,store,a,_,body)=setup(batch,"-result-$mode","/result/$mode")
  a.begin(a.identities);a.admit(a.identities)
  val response=wire(a,"POST","/api/tbc/broadcasttxs",body)
  if(mode=="unknown")yes(response.isFailure)
  else{yes(response.getOrThrow().status==200);a.identities.forEachIndexed{i,id->a.complete(id,if(mode=="partial"&&i>0)"known" else "rejected")}}
  val statuses=when(mode){"unknown"->listOf("unknown","unknown");"rejected"->listOf("rejected","rejected");else->listOf("rejected","unknown")}
  val result=h.publicResult(statuses);rejects{h.finish(h.publicResult())}
  if(mode=="partial")rejects{h.finish(h.publicResult(listOf("rejected","known")))}
  val rs=rows(result["transactions"]).toMutableList();rs[0]=rs[0]+mapOf("reason" to "x".repeat(513));rejects{h.finish(result+mapOf("transactions" to rs))}
  h.finish(result);h.c.close("view",h.scope,h.id)
  yes(h.c.mayDeliverSendResult("view",h.scope,h.id,h.method,hash(result)))
  h.accounts.revision++;yes(!h.c.mayDeliverSendResult("view",h.scope,h.id,h.method,hash(result)));store.close()
 }
 val single=cases.first{it["workflow"]==false}
 for(mode in listOf("prepared","admitted","fence","dropped","reconciled","cancel-started")){
  val (h,store,a,call,body)=setup(single,"-$mode",if(mode in setOf("dropped","reconciled"))"/drop" else if(mode=="cancel-started")"/slow" else null)
  a.begin(a.identities);if(mode!="prepared")a.admit(a.identities)
  if(mode=="fence"){h.accounts.revision++;rejects{a.wire("POST",api+"/api/tbc/broadcasttx",body){error("stale dispatch")}}}
  if(mode in setOf("dropped","reconciled")){
   yes(wire(a,"POST","/api/tbc/broadcasttx",body).isFailure);yes(store.read(a.identities[0].idempotencyKey)?.state=="uncertain")
   rejects{a.abortPreflight(a.identities[0],"INVALID_INPUT")}
  }
  if(mode=="reconciled"){
   rejects{a.wire("GET",api+"/api/tbc/decode/txid/"+"0".repeat(64),null){error("foreign status")}}
   yes(wire(a,"GET","/api/tbc/decode/txid/"+a.identities[0].txid,null).getOrThrow().status==200)
   a.complete(a.identities[0],"known");yes(store.read(a.identities[0].idempotencyKey)?.resultStatus=="known")
  }
  if(mode=="cancel-started"){
   Thread{Thread.sleep(30);replies.add{h.c.cancel("view",h.scope,"op")}}.apply{isDaemon=true}.start()
   yes(wire(a,"POST","/api/tbc/broadcasttx",body).isFailure);rejects{a.complete(a.identities[0],"accepted")}
  }
  h.c.cancel("view",h.scope,"op");a.close()
  val state=if(mode=="reconciled")"completed" else if(mode in setOf("dropped","cancel-started"))"uncertain" else "not-submitted"
  yes(store.read(a.identities[0].idempotencyKey)?.state==state);rejects{a.guardCall(call)};store.close()
 }
}
