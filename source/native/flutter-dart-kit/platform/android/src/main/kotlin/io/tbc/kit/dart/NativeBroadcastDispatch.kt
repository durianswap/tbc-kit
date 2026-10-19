package io.tbc.kit.dart

// Native adapter for the shared Dart broadcast port/REST codec. No node codec
// duplication, auto retry, page raw sender or serialized admission capability.
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import org.json.JSONObject

typealias NativeBroadcastSender=(NativeBroadcastHTTPRequest,()->Unit,(Result<NativeBroadcastHTTPResponse>)->Unit)->(()->Unit)

class NativeBroadcastDispatch(private val store:SystemBroadcastStore,private val apiOrigin:String,chainId:String,
 call:Map<String,Any?>,selection:Map<String,Any?>,private val requireCurrent:()->Unit,private val send:NativeBroadcastSender){
 private val executor=Thread.currentThread()
 private val callHash=hash(call)
 private val transactions:List<Map<String,Any?>>
 private val batch:Boolean
 private val expiresAt:Instant
 val identities:List<NativeBroadcastIdentity>
 private var ticket:NativeBroadcastAdmission?=null
 private val active=mutableMapOf<String,()->Unit>()
 private val observed=mutableSetOf<String>()
 private var created=false;private var closed=false;private var started=false
 private fun need(b:Boolean){check(b){"BROADCAST_DISPATCH_SCOPE"}}
 private fun map(v:Any?):Map<String,Any?>{val m=v as? Map<*,*>?:error("BROADCAST_DISPATCH_SCOPE");need(m.keys.all{it is String});return m.entries.associate{it.key as String to it.value}}
 companion object {
  private fun sha(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
  private fun hash(value:Any?)=sha(PermissionJson.canonical(value).toByteArray(Charsets.UTF_8))
 }
 init{
  requireCurrent()
  // Copy once. Hot fences use the native immutable authorization ID, not raw
  // serialization or another transaction/material read.
  val selected=map(PermissionJson.decode(JSONObject(PermissionJson.canonical(selection))))
  transactions=(selected["transactions"] as? List<*>)?.map{map(it)}?:error("BROADCAST_DISPATCH_SCOPE")
  val method=selected["method"] as? String?:error("BROADCAST_DISPATCH_SCOPE")
  batch=method in setOf("tbc_sendWorkflow","tbc_sendPreparedWorkflow")
  expiresAt=Instant.parse(selected["expiresAt"] as String)
  val p=map(call["params"]);val key=p["idempotencyKey"] as? String?:error("BROADCAST_DISPATCH_SCOPE")
  val callId=call["callId"] as? String?:error("BROADCAST_DISPATCH_SCOPE")
  val execution=map(call["execution"])
  need(call.keys==setOf("callId","operation","params","execution")&&callId.isNotEmpty()&&callId.toByteArray().size<=256&&execution["type"] in setOf("session-only","durable"))
  need(selected["sourceIdentity"]==store.sourceIdentity&&selected["accountScopeHash"]==store.accountScopeHash)
  need(NativePrepared.sends(method)&&transactions.size in 1..32&&(batch||transactions.size==1))
  val operation=if(batch)"broadcast.submitBatch" else "broadcast.submit"
  need(call["operation"]==operation&&p.keys==setOf("version","chainId",if(batch)"transactions" else "transaction","idempotencyKey")&&p["version"]=="1.0"&&p["chainId"]==chainId&&chainId in setOf("tbc:mainnet","tbc:testnet")&&key.isNotEmpty()&&key.toByteArray().size<=256)
  need(PermissionJson.canonical(p[if(batch)"transactions" else "transaction"])==PermissionJson.canonical(if(batch)transactions else transactions[0]))
  val prefix="tbcnet-${store.sourceIdentity.take(24)}-"
  identities=transactions.mapIndexed{i,tx->
   val raw=tx["rawTransaction"] as? String?:error("BROADCAST_DISPATCH_SCOPE");val txid=tx["txid"] as? String?:error("BROADCAST_DISPATCH_SCOPE")
   need(raw.length<=4*1024*1024&&Regex("^(?:[0-9a-f]{2})+$").matches(raw))
   val bytes=ByteArray(raw.length/2){raw.substring(it*2,it*2+2).toInt(16).toByte()}
   // Native completedBundle verified the TBC header-derived ID already. Only
   // compute the journal raw-hash, not a second transaction verification.
   val base=if(batch)"$key:$i" else key
   val context=mutableMapOf<String,Any?>("version" to "1.0","callId" to callId,"operation" to operation,"params" to p);if(batch)context["index"]=i
   NativeBroadcastIdentity(if(base.startsWith(prefix))base else prefix+hash(mapOf("idempotencyKey" to base)),sha(bytes),txid,hash(context),store.accountScopeHash)
  }
  identities.forEach{it.validate(store.sourceIdentity,store.accountScopeHash)}
  need(identities.map{it.txid}.toSet().size==transactions.size)
  NativeBroadcastHTTPRequest.validated(store.sourceIdentity,apiOrigin,"POST",if(batch)"/api/tbc/broadcasttxs" else "/api/tbc/broadcasttx","{}",expiresAt)
  fence()
 }
 private fun fence(){need(Thread.currentThread()===executor&&!closed&&Instant.now().isBefore(expiresAt));requireCurrent()}
 fun guardCall(call:Map<String,Any?>){fence();need(hash(call)==callHash)}
 private fun owned(ids:List<NativeBroadcastIdentity>){need(ids==identities)}
 fun begin(ids:List<NativeBroadcastIdentity>):NativeBroadcastReservation{fence();owned(ids);return store.begin(identities,::fence).also{created=created||it.created}}
 fun read(key:String):NativeBroadcastRecord?{fence();need(identities.any{it.idempotencyKey==key});return store.read(key)}
 fun readByTxids(txids:List<String>):List<NativeBroadcastRecord>{
  fence();need(txids.isNotEmpty()&&txids.all{tx->identities.any{it.txid==tx}})
  return store.readByTxids(txids).also{rows->need(rows.all{it.identity in identities})}
 }
 fun admit(ids:List<NativeBroadcastIdentity>){fence();owned(ids);need(created&&ticket==null&&!started);ticket=store.admitDispatch(identities,::fence)}
 fun abortPreflight(id:NativeBroadcastIdentity,code:String){
  fence();need(created&&id in identities&&ticket==null&&!started&&code in setOf("INVALID_INPUT","NODE_RESPONSE_INVALID"));store.abortPrepared(listOf(id),code,::fence)
 }
 // Private package codec classifies only a response returned by this adapter.
 fun complete(id:NativeBroadcastIdentity,status:String){fence();need(id in identities&&id.txid in observed);store.complete(id,status,::fence)}
 // Only native journal identities can attest a settled result. An uncertain
 // row proves actual dispatch (possibly an earlier attempt), never a retry.
 fun deliveryState():List<Map<String,String>>{
  fence();need(ticket==null&&active.isEmpty())
  return identities.map{id->
   val row=store.read(id.idempotencyKey)?:error("BROADCAST_DISPATCH_SCOPE")
   need(row.identity==id&&row.state in setOf("uncertain","completed"))
   val status=if(row.state=="uncertain")"unknown" else row.resultStatus?:""
   need(status in setOf("accepted","known","rejected","unknown"))
   mapOf("txid" to id.txid,"status" to status)
  }
 }
 fun wire(method:String,url:String,body:String?,deadline:Instant?=null,complete:(Result<NativeBroadcastHTTPResponse>)->Unit){
  fence();need(deadline==null||deadline.isAfter(Instant.now()));val path:String;val ids:List<String>
  if(method=="POST"){
   path=if(batch)"/api/tbc/broadcasttxs" else "/api/tbc/broadcasttx";ids=identities.map{it.txid}
   val expected=if(batch)transactions.map{mapOf("txraw" to it["rawTransaction"])} else mapOf("txraw" to transactions[0]["rawTransaction"])
   need(ticket!=null&&!started&&body==PermissionJson.canonical(expected))
  }else{
   need(method=="GET"&&body==null)
   val id=identities.firstOrNull{url==apiOrigin+"/api/tbc/decode/txid/"+it.txid}?:error("BROADCAST_DISPATCH_SCOPE")
   val row=store.read(id.idempotencyKey)?:error("BROADCAST_DISPATCH_SCOPE")
   need(row.identity==id&&row.state in setOf("uncertain","completed"));path="/api/tbc/decode/txid/"+id.txid;ids=listOf(id.txid)
  }
  need(url==apiOrigin+path&&active.size<32)
  val end=minOf(expiresAt,deadline?:Instant.now().plusSeconds(15),Instant.now().plusSeconds(15))
  val request=NativeBroadcastHTTPRequest.validated(store.sourceIdentity,apiOrigin,method,path,body,end)
  val token=UUID.randomUUID().toString()
  val callback:(Result<NativeBroadcastHTTPResponse>)->Unit={response->
   active.remove(token)
   val current=runCatching{fence()}
   if(current.isFailure)complete(Result.failure(NativeBroadcastHTTPFailure("NODE_REQUEST_FAILED")))
   else {if(response.isSuccess)observed.addAll(ids);complete(response)}
  }
  if(method=="POST"){
   val admission=ticket!!;ticket=null
   active[token]=store.startAdmission(admission,::fence){started=true;send(request,::fence,callback)}
  }else active[token]=send(request,::fence,callback)
 }
 fun close(){
  check(Thread.currentThread()===executor){"BROADCAST_EXECUTOR"};if(closed)return;closed=true
  ticket?.let{ticket=null;runCatching{store.cancelAdmission(it)}}
  if(created&&!started)identities.forEach{id->runCatching{if(store.read(id.idempotencyKey)?.state=="prepared")store.abortPrepared(listOf(id),"CANCELLED",{})}}
  val cancels=active.values.toList();active.clear();cancels.forEach{it()}
 }
}

fun NativeCustody.makeBroadcastDispatch(owner:String,scope:Map<String,String>,id:String,receipt:Map<String,Any?>,index:Int?,
 store:SystemBroadcastStore,apiOrigin:String,chainId:String,call:Map<String,Any?>,onClose:()->Unit={},send:NativeBroadcastSender):NativeBroadcastDispatch{
 val selected=broadcastSelection(owner,scope,id,receipt,index);val authorization=selected["authorizationId"] as String
 val adapter=NativeBroadcastDispatch(store,apiOrigin,chainId,call,selected,{broadcastCurrent(owner,scope,id,receipt,authorization)},send)
 ownBroadcast(owner,scope,id,index?.let{"single:$it"}?:"batch",adapter::deliveryState,{adapter.close();onClose()},adapter.identities.firstOrNull()?.idempotencyKey)
 return adapter
}
