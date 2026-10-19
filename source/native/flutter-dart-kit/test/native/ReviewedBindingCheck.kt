package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import java.time.Instant

// Paired host strategy proof; no Vault, key use, network or device claim.
private var checks=0
private fun yes(v:Boolean){check(v){"reviewed check ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var failed=false;try{f()}catch(_:Exception){failed=true};yes(failed)}
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun json(v:Any?)=PermissionJson.canonical(v)
private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(json(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}

fun main(args:Array<String>){
 val document=PermissionJson.records("[${File(args[0]).readText()}]").single();val samples=(document["cases"] as List<*>).map{map(it)}
 for(s in samples){
  val request=map(s["request"]);val context=map(s["context"]);val a=map(s["account"]);val audit=map(s["audit"]);val plan=map(audit["plan"]);val packet=map(s["packet"]);val review=map(packet["review"]);val preview=map(audit["preview"])
  val now=Instant.parse(s["now"] as String);val expiry=Instant.parse(map(plan["payload"])["expiresAt"] as String)
  val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)
  fun bind(r:Map<String,Any?> = request,c:Map<String,Any?> = context,p:Map<String,Any?> = plan,v:Map<String,Any?> = preview,m:Map<String,Any?> = packet,x:Instant=expiry)=NativeReviewed.bind(r,c,account,review,p,v,m,x,now)
  yes(json(NativeReviewed.normalize(map(request["request"])))==json(packet["material"]))
  yes(json(NativeReviewed.consent(request,review,now))==json(review))
  val description=NativeReviewed.description(review);yes(description.contains("no broadcast")&&!description.contains("unlockingScriptTemplate")&&!description.contains("sourceTransaction"))
  val b=bind();val stages=(s["stages"] as List<*>).map{map(it)}
  yes(b.transactionCount==stages.size);yes(b.totalTasks==stages.sumOf{(it["tasks"] as List<*>).size})
  for((index,item) in stages.withIndex()){
   val expected=map(item["prepare"]);val stage=map(item["stage"])
   yes(json(b.prepare(index,(expected["previousTransactions"] as List<*>).map{it as String}))==json(expected))
   yes(json(b.tasks(stage,stage,index))==json(item["tasks"]))
   val changed=stage+mapOf("publicKey" to ("03"+"00".repeat(32)))
   rejects{b.tasks(stage,changed,index)};rejects{b.tasks(changed,changed,index)};rejects{b.prepare(stages.size,emptyList())}
  }
  rejects{bind(c=context+mapOf("sessionId" to "other-document"))}
  rejects{bind(r=request+mapOf("maxFee" to "0"))}
  rejects{bind(r=request+mapOf("chainId" to "tbc:mainnet"))}
  rejects{bind(r=request+mapOf("signingRoles" to emptyList<Any>()))}
  rejects{bind(m=packet+mapOf("policyMaterial" to mapOf("resolvedOutputs" to emptyList<Any>())))}
  rejects{bind(m=packet+mapOf("material" to mapOf("format" to "raw","request" to emptyMap<String,Any>())))}
  rejects{bind(v=preview+mapOf("totalFee" to "0"))}
  val payload=map(plan["payload"])+mapOf("task" to (map(map(plan["payload"])["task"])+mapOf("requestHash" to "00".repeat(32))))
  rejects{bind(p=mapOf("payload" to payload,"planHash" to hash(payload)))}
  rejects{bind(x=expiry.plusSeconds(1))};rejects{NativeReviewed.consent(request,review,expiry)}
  rejects{NativeReviewed.normalize(map(request["request"])+mapOf("privateKey" to "test-only-invalid"))}
 }
 for(entry in (document["normalizationCases"] as List<*>).map{map(it)})yes(json(NativeReviewed.normalize(map(entry["request"])))==json(entry["material"]))
 println("{\"status\":\"PASS\",\"checks\":$checks,\"cases\":${samples.size},\"scope\":\"native-binding-strategy-only\"}")
}
