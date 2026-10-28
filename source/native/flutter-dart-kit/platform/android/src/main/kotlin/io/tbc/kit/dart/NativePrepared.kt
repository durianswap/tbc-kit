package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant

// Custody checks the original consent's proposal against the wallet's Rust
// plan. Fresh evidence and Engine verification remain in the private worker.
internal object NativePrepared {
 val sendMethods=listOf("tbc_sendTransaction","tbc_sendPreparedTransaction","tbc_sendWorkflow","tbc_sendPreparedWorkflow")
 fun sends(method:String)=method in sendMethods
 fun prepared(method:String)=method in setOf("tbc_signPreparedTransaction","tbc_sendPreparedTransaction")
 fun transaction(method:String)=method in setOf("tbc_signTransaction","tbc_sendTransaction")||prepared(method)
 fun permission(method:String)=when{
  method in NativeCrypto.methods->"tbc_crypto"
  method in NativeWorkflow.methods->"tbc_signWorkflow"
  method=="tbc_sendPreparedTransaction"->"tbc_sendTransaction"
  method in setOf("tbc_signPreparedTransaction","tbc_signReviewedTransaction")->"tbc_signTransaction"
  else->method
 }
 fun request(request:Map<String,Any?>,method:String)=if(prepared(method))request.filterKeys{it!="proposal"}else request
 private fun need(ok:Boolean){if(!ok)throw NativeCustodyFailure("NATIVE_PREPARED_BINDING")}
 @Suppress("UNCHECKED_CAST") private fun map(value:Any?):Map<String,Any?>{
  need(value is Map<*,*> && value.keys.all{it is String});return value as Map<String,Any?>
 }
 private fun hash(value:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(value).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
 private fun equal(a:Any?,b:Any?)=PermissionJson.canonical(a)==PermissionJson.canonical(b)
 fun consent(request:Map<String,Any?>,now:Instant=Instant.now()):Map<String,Any?>{
  val required=setOf("version","chainId","from","intent","proposal")
  need(request.keys.containsAll(required)&&(required+setOf("clientRequestId","constraints","signingRoles")).containsAll(request.keys))
  val proposal=map(request["proposal"]);val p=map(proposal["payload"]);val evidence=map(p["evidence"])
  need(proposal.keys==setOf("payload","proposalHash")&&p.keys==setOf("version","engineProfile","createdAt","expiresAt","intentHash","transactions","evidence","estimatedTotalFee"))
  need(p["version"]=="1.0"&&p["engineProfile"]=="tbc-engine-plan-v1"&&proposal["proposalHash"]==hash(p)&&p["intentHash"]==hash(request["intent"]))
  val created=Instant.parse(p["createdAt"] as String);val expires=Instant.parse(p["expiresAt"] as String)
  need(!created.isAfter(expires)&&now.isBefore(expires)&&equal(evidence["observedAt"],p["createdAt"]))
  return p
 }
 private class Reader(raw:Any?){
  val bytes:ByteArray;var offset=0
  init{need(raw is String && raw.isNotEmpty() && raw.length%2==0 && raw.all{it in "0123456789abcdef"});bytes=(raw as String).chunked(2).map{it.toInt(16).toByte()}.toByteArray()}
  fun take(n:Int):ByteArray{need(n>=0&&n<=bytes.size-offset);return bytes.copyOfRange(offset,offset+n).also{offset+=n}}
  fun uint(n:Int)=take(n).reversed().fold(0L){v,b->v*256+(b.toInt() and 255)}
  fun compact():Int{
   val first=uint(1).toInt();if(first<253)return first;need(first!=255)
   val v=uint(if(first==253)2 else 4);need(v>=(if(first==253)253 else 65536)&&v<=Int.MAX_VALUE);return v.toInt()
  }
  fun script(){val n=compact();need(n<=10000);take(n)}
 }
 // Input-only bounded inspection; whole-transaction Engine validation remains.
 fun inputOutpoints(raw:Any?):List<String>{
  val r=Reader(raw);need(r.uint(4)==10L);val count=r.compact();need(count in 1..1024)
  return (0 until count).map{val tx=r.take(32).reversed().joinToString(""){"%02x".format(it)};val vout=r.uint(4);r.script();r.take(4);"$tx:$vout"}
 }
 private fun transactions(value:Any?,limit:Int):List<Map<String,Any?>>{
  need(value is List<*> && value.size in 1..limit);val known=mutableSetOf<String>()
  return (value as List<*>).map{v->
   val tx=map(v);val id=tx["id"] as String;val parents=(tx["dependsOn"] as List<*>).map{it as String}
   need(parents.toSet().size==parents.size&&parents.all{it in known})
   val reader=Reader(tx["unsignedTransaction"]);need(reader.uint(4)==10L)
   val count=reader.compact();need(count in 1..10000);val zeros=mutableListOf<Map<String,Any?>>()
   for(i in 0 until count){
    val previous=reader.take(32);val vout=reader.uint(4);reader.script();reader.take(4)
    if(previous.all{it==0.toByte()})zeros+=mapOf("inputIndex" to i,"sourceOutputIndex" to vout)
   }
   val countOut=reader.compact();need(countOut in 1..10000)
   repeat(countOut){reader.take(8);reader.script()};reader.take(4);need(reader.offset==reader.bytes.size)
   val explicit=(tx["deferredInputs"] as? List<*>)?.map{map(it)}
   need(tx["deferredInputs"]==null||explicit!=null)
   need(if(explicit==null)zeros.size==parents.size else explicit.isNotEmpty()&&explicit.size==zeros.size)
   val used=mutableSetOf<String>();val outputs=mutableSetOf<String>()
   val edges=zeros.mapIndexed{i,zero->
    val edge=explicit?.get(i)?:zero+mapOf("sourceTransactionId" to parents[i]);val parent=edge["sourceTransactionId"] as String
    need(equal(edge["inputIndex"],zero["inputIndex"])&&equal(edge["sourceOutputIndex"],zero["sourceOutputIndex"])&&parent in parents)
    need(outputs.add(parent+":"+PermissionJson.canonical(edge["sourceOutputIndex"])));used.add(parent);edge
   }
   need(used.size==parents.size&&known.add(id))
   mapOf("id" to id,"role" to tx["role"],"dependsOn" to parents,"fee" to tx["fee"])+
    if(edges.isEmpty())mapOf("kind" to "fixed","unsignedTransaction" to tx["unsignedTransaction"])
    else mapOf("kind" to "deferred","unsignedTransactionTemplate" to tx["unsignedTransaction"],"deferredInputs" to edges)
  }
 }
 fun bind(proposal:Map<String,Any?>,plan:Map<String,Any?>,expiry:Instant,limit:Int=32){
  val expires=Instant.parse(proposal["expiresAt"] as String);need(!expiry.isAfter(expires)&&Instant.now().isBefore(expires))
  need(equal(proposal["transactions"],transactions(plan["transactions"],limit))&&equal(proposal["estimatedTotalFee"],map(plan["preview"])["totalFee"]))
 }
}
