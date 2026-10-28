package io.tbc.kit.dart

import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

// Native wallet configuration only, not page/Flutter-deserialized authority.
class NativeBroadcastConfiguration(network:String,apiOrigin:String?=null,trustId:String?=null,rpcOrigin:String?=null){
 val chainId="tbc:$network"
 val apiOrigin:String
 val sourceIdentity:String
 init{
  val official=mapOf("mainnet" to "https://api.turingbitchain.io","testnet" to "https://api.tbcdev.org")
  val base=official[network]?:error("NATIVE_BROADCAST_SOURCE");this.apiOrigin=apiOrigin?:base
  if(apiOrigin==null)check(trustId==null&&rpcOrigin==null){"NATIVE_BROADCAST_SOURCE"}
  else check(trustId!=null&&Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$").matches(trustId)){"NATIVE_BROADCAST_SOURCE"}
  for(origin in listOfNotNull(this.apiOrigin,rpcOrigin)){
   NativeBroadcastHTTPRequest.validated("0".repeat(64),origin,"POST","/api/tbc/broadcasttx","{}",Instant.now())
   check(origin==origin.lowercase()&&URI(origin).port!=443&&origin!=official[if(network=="mainnet")"testnet" else "mainnet"]){"NATIVE_BROADCAST_SOURCE"}
  }
  val endpoint=mutableMapOf<String,Any?>("kind" to if(trustId==null)"official" else "trusted-custom","apiOrigin" to this.apiOrigin,"trustId" to (trustId?:"official:$network"))
  if(rpcOrigin!=null)endpoint["rpcOrigin"]=rpcOrigin
  val value=mapOf("version" to "1.0","network" to network,"chainId" to chainId,"endpoint" to endpoint)
  sourceIdentity=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(value).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
 }
}

// Exact private-channel envelope; the shared Dart port and REST codec remain
// authoritative package logic, not duplicated platform business code.
class NativeBroadcastRouter(private val custody:NativeCustody,private val configuration:NativeBroadcastConfiguration,
 private val directory:File,private val profile:String,private val send:NativeBroadcastSender){
 private val executor=Thread.currentThread()
 private val stores=mutableMapOf<String,SystemBroadcastStore>()
 private val entries=mutableMapOf<String,NativeBroadcastDispatch>()
 private var closed=false
 private fun need(b:Boolean){if(!b)throw NativeCustodyFailure("NATIVE_DENIED")}
 private fun map(v:Any?):Map<String,Any?>{val m=v as? Map<*,*>?:throw NativeCustodyFailure("NATIVE_DENIED");need(m.keys.all{it is String});return m.entries.associate{it.key as String to it.value}}
 private fun string(v:Any?)=v as? String?:throw NativeCustodyFailure("NATIVE_DENIED")
 private fun identity(value:Any?):NativeBroadcastIdentity{
  val m=map(value);need(m.keys==setOf("idempotencyKey","rawHash","txid","submitContextHash","accountScopeHash"))
  return NativeBroadcastIdentity(string(m["idempotencyKey"]),string(m["rawHash"]),string(m["txid"]),string(m["submitContextHash"]),string(m["accountScopeHash"]))
 }
 private fun ids(value:Any?):List<NativeBroadcastIdentity>{val list=value as? List<*>?:throw NativeCustodyFailure("NATIVE_DENIED");need(list.size in 1..32);return list.map{identity(it)}}
 private fun record(r:NativeBroadcastRecord?):Map<String,Any?>?{
  if(r==null)return null;val id=r.identity
  return mapOf("idempotencyKey" to id.idempotencyKey,"rawHash" to id.rawHash,"txid" to id.txid,"submitContextHash" to id.submitContextHash,"accountScopeHash" to id.accountScopeHash,"state" to r.state,"createdAt" to r.createdAt)+if(r.result==null)emptyMap()else mapOf("result" to r.result)
 }
 fun dispatch(method:String,input:Map<String,Any?>,reply:(Map<String,Any?>)->Unit){
  var replied=false
  fun answer(value:Any?){if(!replied){replied=true;reply(mapOf("ok" to true,"value" to value))}}
  fun fail(code:String="NATIVE_DENIED"){if(!replied){replied=true;reply(mapOf("ok" to false,"code" to code))}}
  try{
   need(Thread.currentThread()===executor&&!closed)
   val owner=string(input["ownerId"]);val operation=string(input["operation"]);val receipt=map(input["receipt"])
   val scope=map(input["scope"]).mapValues{string(it.value)}
   val index=when(val raw=input["index"]){null->{need(input.containsKey("index"));null};is Int->{need(raw in 0..99);raw};is Long->{need(raw in 0..99);raw.toInt()};else->throw NativeCustodyFailure("NATIVE_DENIED")}
   fun keys(vararg names:String){need(input.keys==setOf("ownerId","scope","operation","receipt","index")+names)}
   fun current(){custody.broadcastAuthorization(owner,scope,operation,receipt)}
   val key=PermissionJson.id("broadcast",owner,PermissionJson.canonical(scope),operation,index?.toString()?:"batch")
   when(method){
    "signing.broadcast.open"->{
     keys("call");need(key !in entries&&entries.size<128)
     val selected=custody.broadcastSelection(owner,scope,operation,receipt,index)
     need(selected["sourceIdentity"]==configuration.sourceIdentity)
     val account=string(selected["accountScopeHash"])
     val store=stores[account]?:run{need(stores.size<16);SystemBroadcastStore(directory,profile,configuration.sourceIdentity,account).also{stores[account]=it}}
     val adapter=custody.makeBroadcastDispatch(owner,scope,operation,receipt,index,store,configuration.apiOrigin,configuration.chainId,map(input["call"]),{entries.remove(key)},send)
     entries[key]=adapter;answer(mapOf("sourceIdentity" to configuration.sourceIdentity,"accountScopeHash" to account))
    }
    "signing.broadcast.guard"->{keys("call");val a=entries[key]?:throw NativeCustodyFailure("NATIVE_DENIED");current();a.guardCall(map(input["call"]));answer(true)}
    "signing.broadcast.journal"->{
     keys("action","arguments");val a=entries[key]?:throw NativeCustodyFailure("NATIVE_DENIED");current()
     val args=map(input["arguments"])
     fun shape(vararg fields:String){need(args.keys==fields.toSet())}
     when(string(input["action"])){
      "begin"->{shape("identities");val r=a.begin(ids(args["identities"]));answer(mapOf("created" to r.created,"records" to r.records.map{record(it)}))}
      "read"->{shape("key");answer(record(a.read(string(args["key"]))))}
      "readByTxids"->{shape("txids");val txids=(args["txids"] as? List<*>)?.map{string(it)}?:throw NativeCustodyFailure("NATIVE_DENIED");answer(a.readByTxids(txids).map{record(it)})}
      "admit"->{shape("identities");a.admit(ids(args["identities"]));answer(true)}
      "complete"->{shape("identity","status");a.complete(identity(args["identity"]),string(args["status"]));answer(true)}
      "abortPreflight"->{shape("identity","code");a.abortPreflight(identity(args["identity"]),string(args["code"]));answer(true)}
      else->throw NativeCustodyFailure("NATIVE_DENIED")
     }
    }
    "signing.broadcast.wire"->{
     keys("method","url","body","deadline");val a=entries[key]?:throw NativeCustodyFailure("NATIVE_DENIED");current()
     val deadline=Instant.parse(string(input["deadline"]))
     val body=input["body"]?.let{string(it)}
     a.wire(string(input["method"]),string(input["url"]),body,deadline){r->
      if(r.isSuccess){val v=r.getOrThrow();answer(mapOf("statusCode" to v.status,"body" to Base64.getEncoder().encodeToString(v.body)))}
      else {val code=(r.exceptionOrNull() as? NativeBroadcastHTTPFailure)?.code;fail(if(code in setOf("NODE_REQUEST_FAILED","NODE_RESPONSE_INVALID"))code!! else "NODE_REQUEST_FAILED")}
     }
    }
    else->throw NativeCustodyFailure("NATIVE_DENIED")
   }
  }catch(_:Exception){fail()}
 }
 fun close(){check(Thread.currentThread()===executor);if(closed)return;closed=true;val active=entries.values.toList();entries.clear();active.forEach{it.close()};stores.values.forEach{it.close()};stores.clear()}
}
