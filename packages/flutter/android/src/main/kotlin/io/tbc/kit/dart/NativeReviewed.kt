package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant

// Private data/binding strategy, not a signer or second operation owner. The
// custody owner runs returned keyless requests against pinned Rust off the UI
// executor and repeats its authority fence before installing derived tasks.
internal object NativeReviewed {
 const val method="tbc_signReviewedTransaction"
 private fun need(ok:Boolean){if(!ok)throw NativeCustodyFailure("NATIVE_REVIEWED_BINDING")}
 @Suppress("UNCHECKED_CAST") private fun map(v:Any?):Map<String,Any?>{need(v is Map<*,*>&&v.keys.all{it is String});return v as Map<String,Any?>}
 private fun rows(v:Any?,min:Int,max:Int):List<*>{need(v is List<*>&&v.size in min..max);return v as List<*>}
 private fun shape(v:Map<String,Any?>,required:Set<String>,optional:Set<String> = emptySet()){need(v.keys.containsAll(required)&&(required+optional).containsAll(v.keys))}
 private fun canonical(v:Any?)=PermissionJson.canonical(v)
 private fun equal(a:Any?,b:Any?)=canonical(a)==canonical(b)
 private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(canonical(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
 private fun owned(v:Map<String,Any?>)=PermissionJson.records("[${canonical(v)}]").single()
 private fun text(v:Any?,pattern:String):String{need(v is String&&Regex(pattern).matches(v));return v as String}
 private fun integer(v:Any?,max:Long=1000):Long{need(v is Number&&v.toDouble().isFinite()&&v.toDouble()>=0&&v.toDouble()<=max.toDouble()&&v.toDouble()==v.toLong().toDouble());return (v as Number).toLong()}
 private fun amount(v:Any?):Long{val s=text(v,"^(0|[1-9][0-9]*)$");val n=s.toLongOrNull()?:throw NativeCustodyFailure("NATIVE_REVIEWED_BINDING");need(n<=9007199254740991);return n}
 private fun bytes(v:Any?):String{val s=text(v,"^(?:[0-9a-f]{2})+$");need(s.length<=2097152);return s}
 private fun date(v:Any?):Instant=Instant.parse(text(v,"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$"))
 private fun input(value:Any?):Map<String,Any?>{
  val r=map(value)
  shape(r,setOf("outputIndex","signingProfile"),setOf("txid","satoshis","scriptPubKey","previousTransaction","ancestorTransactions","previousOutputContext","contractTransaction","contractVersion","unlockingScriptTemplate"))
  val profiles=mapOf("p2pkh" to "p2pkh","ft" to "tbc20","ft-contract" to "tbc20_contract","contract-template" to "other","tbc-lop-match" to "tbc_lop_match","tbc20-standard" to "tbc20-standard","tbc20-stablecoin" to "tbc20-stablecoin")
  val profile=profiles[r["signingProfile"]]?:throw NativeCustodyFailure("NATIVE_REVIEWED_BINDING")
  val out=mutableMapOf<String,Any?>("outputIndex" to integer(r["outputIndex"],4294967295),"scriptSigType" to profile)
  if(profile in setOf("tbc20-standard","tbc20-stablecoin")){
   need(listOf("previousOutputContext","contractTransaction","contractVersion","unlockingScriptTemplate").none{r.containsKey(it)})
   if(r.containsKey("txid"))need(listOf("satoshis","scriptPubKey","previousTransaction","ancestorTransactions").all{r.containsKey(it)})
   else need(!r.containsKey("previousTransaction"))
  }else need(!r.containsKey("ancestorTransactions"))
  if(r.containsKey("txid"))out["txId"]=text(r["txid"],"^[0-9a-f]{64}$")
  if(r.containsKey("satoshis"))out["satoshis"]=amount(r["satoshis"])
  if(r.containsKey("scriptPubKey"))out["script"]=bytes(r["scriptPubKey"])
  if(r.containsKey("ancestorTransactions")){val a=rows(r["ancestorTransactions"],0,6).map{bytes(it)};need(a.toSet().size==a.size);out["ancestorTransactions"]=a}
  for((key,target) in mapOf("previousTransaction" to "preTx","previousOutputContext" to "prePreTxData","contractTransaction" to "contractTx","unlockingScriptTemplate" to "unfinishedScriptSig"))if(r.containsKey(key))out[target]=bytes(r[key])
  if(r.containsKey("contractVersion")){val n=integer(r["contractVersion"],3);need(n>=1);out["ftVersion"]=n}
  return out
 }
 // Wire field projection only; Rust checks input/raw matrices. Asset recognition
 // and chain material review remain shared worker responsibilities.
 fun normalize(value:Map<String,Any?>):Map<String,Any?>{
  need(canonical(value).toByteArray(Charsets.UTF_8).size<=4*1024*1024);shape(value,setOf("payload"))
  val p=map(value["payload"])
  if(p["format"]=="raw"){
   shape(p,setOf("format","transactions"))
   val txs=mutableListOf<String>();val amounts=mutableListOf<List<Long>>();val scripts=mutableListOf<List<String>>()
   for(value in rows(p["transactions"],1,32)){
    val tx=map(value);shape(tx,setOf("rawTransaction","inputs"));val money=mutableListOf<Long>();val locks=mutableListOf<String>()
    for(value in rows(tx["inputs"],1,1000)){val r=map(value);shape(r,setOf("satoshis","scriptPubKey"));money.add(amount(r["satoshis"]));locks.add(bytes(r["scriptPubKey"]))}
    txs.add(bytes(tx["rawTransaction"]));amounts.add(money);scripts.add(locks)
   }
   return mapOf("format" to "raw","request" to mapOf("txraws" to txs,"utxos_satoshis" to amounts,"script_pubkeys" to scripts))
  }
  need(p["format"]=="associated");shape(p,setOf("format","sourceTransaction","sourceInputs","children"))
  val inputs=mutableListOf<List<Map<String,Any?>>>();val outputs=mutableListOf<List<Map<String,Any?>>>()
  for(value in rows(p["children"],0,31)){
   val c=map(value);shape(c,setOf("inputs","outputs"));inputs.add(rows(c["inputs"],1,1000).map{input(it)})
   outputs.add(rows(c["outputs"],0,1000).map{val r=map(it);shape(r,setOf("satoshis","scriptPubKey"));mapOf("satoshis" to amount(r["satoshis"]),"script" to bytes(r["scriptPubKey"]))})
  }
  return mapOf("format" to "associated","request" to mapOf("sourceTxraw" to bytes(p["sourceTransaction"]),"sourceUtxos" to rows(p["sourceInputs"],0,1000).map{input(it)},"inputs" to inputs,"outputs" to outputs))
 }
 fun consent(request:Map<String,Any?>,review:Map<String,Any?>,now:Instant=Instant.now()):Map<String,Any?>{
  shape(request,setOf("version","chainId","from","request"),setOf("clientRequestId","maxFee","expiresAt"))
  need(request["version"]=="1.0");shape(review,setOf("payload","reviewHash"))
  val p=map(review["payload"]);shape(p,setOf("expiresAt","policyMaterial","preview","totalFee"));val preview=map(p["preview"])
  need(review["reviewHash"]==hash(p)&&now<date(p["expiresAt"]))
  need(preview["operationKind"]=="transaction"&&equal(preview["totalFee"],p["totalFee"]));amount(p["totalFee"])
  if(request.containsKey("maxFee"))need(amount(p["totalFee"])<=amount(request["maxFee"]))
  if(request.containsKey("expiresAt"))need(now<date(request["expiresAt"]))
  return owned(review)
 }
 // Never display raw request/material/policy/unlocking templates or preimages.
 fun description(consent:Map<String,Any?>)="Reviewed transactions. Sign only; no broadcast.\n"+canonical(map(map(consent["payload"])["preview"]))
 class Bound internal constructor(val material:Map<String,Any?>,val policy:Map<String,Any?>,val claimedStage:Map<String,Any?>,val account:NativeAccount,val planHash:String,val transactionCount:Int,val totalTasks:Int){
  val associated get()=material["format"]=="associated"
  fun prepare(index:Int,parents:List<String>):Map<String,Any?>{
   need(index in 0 until transactionCount&&parents.size==if(associated)index else 0)
   return mapOf("format" to material["format"],"request" to material["request"],"publicKey" to account.publicKey,"transactionIndex" to index,"previousTransactions" to parents.toList(),"resolvedOutputs" to policy["resolvedOutputs"])
  }
  fun tasks(actual:Map<String,Any?>,claimed:Map<String,Any?>,index:Int):List<Map<String,Any?>>{
   need(equal(actual,claimed)&&actual["format"]==material["format"]&&integer(actual["transactionIndex"],31)==index.toLong()&&actual["publicKey"]==account.publicKey)
   val inputs=rows(actual["inputs"],1,1000);val indexes=rows(actual["signingInputIndexes"],0,1000).map{integer(it,999).toInt()};val digests=rows(actual["digests"],0,1000)
   val selected=indexes.toSet();need(indexes.size==digests.size&&selected.size==indexes.size&&indexes.all{it<inputs.size})
   for((i,value) in inputs.withIndex()){val r=map(value);need(r["signingPublicKey"]==null&&r["signingRole"]==null);need((i in selected)!=(associated&&r["scriptSigType"]=="tbc_lop_match"))}
   return indexes.zip(digests).map{(vin,digest)->mapOf("taskId" to "review-single-tx-$index-input-$vin","purpose" to "transaction","algorithm" to "secp256k1-ecdsa-sha256d","digest" to text(digest,"^[0-9a-f]{64}$"),"signatureEncoding" to "compact64","sighashType" to 65,"transactionTemplateId" to "review-tx-$index","inputIndex" to vin,"accountId" to account.accountId,"publicKey" to account.publicKey)}
  }
 }
 // Project workflow consent into the unchanged single-review verifier.
 // Actual first-stage computation remains the custody-owned pinned Rust call.
 data class WorkflowPlan(val plan:Map<String,Any?>,val preview:Map<String,Any?>,val packet:Map<String,Any?>)
 fun workflowPlan(request:Map<String,Any?>,context:Map<String,Any?>,account:NativeAccount,consent:Map<String,Any?>,expiresAt:String):WorkflowPlan{
  val rp=map(consent["payload"]);val policy=map(rp["policyMaterial"]);val preview=map(rp["preview"])
  val task=mapOf("taskId" to "review-single","purpose" to "reviewedTransaction","contextHash" to hash(context),"requestHash" to hash(request["request"]),"reviewHash" to consent["reviewHash"],"policyMaterial" to policy,"chainId" to account.chainId,"accountId" to account.accountId,"publicKey" to account.publicKey,"request" to request["request"])
  val payload=mapOf("requestHash" to hash(request),"contextHash" to hash(context),"chainId" to account.chainId,"accountId" to account.accountId,"expiresAt" to expiresAt,"task" to task,"preview" to preview,"review" to consent)
  return WorkflowPlan(mapOf("payload" to payload,"planHash" to hash(payload)),preview,mapOf("kind" to "reviewed","material" to normalize(map(request["request"])),"policyMaterial" to policy,"review" to consent,"stage" to emptyMap<String,Any?>()))
 }
 fun bind(request:Map<String,Any?>,context:Map<String,Any?>,account:NativeAccount,consent:Map<String,Any?>,plan:Map<String,Any?>,preview:Map<String,Any?>,packet:Map<String,Any?>,expiry:Instant,now:Instant=Instant.now()):Bound{
  consent(request,consent,now)
  val material=normalize(map(request["request"]));val r=map(material["request"]);val rp=map(consent["payload"]);val policy=map(rp["policyMaterial"])
  need(request["chainId"]==account.chainId&&request["from"]==account.address&&expiry>now&&expiry<=date(rp["expiresAt"]))
  if(request.containsKey("expiresAt"))need(expiry<=date(request["expiresAt"]))
  shape(plan,setOf("payload","planHash"));val p=map(plan["payload"]);shape(packet,setOf("kind","material","policyMaterial","review","stage"))
  need(packet["kind"]=="reviewed"&&equal(packet["material"],material)&&equal(packet["policyMaterial"],policy)&&equal(packet["review"],consent))
  val task=mapOf("taskId" to "review-single","purpose" to "reviewedTransaction","contextHash" to hash(context),"requestHash" to hash(request["request"]),"reviewHash" to consent["reviewHash"],"policyMaterial" to policy,"chainId" to account.chainId,"accountId" to account.accountId,"publicKey" to account.publicKey,"request" to request["request"])
  val expected=mapOf("requestHash" to hash(request),"contextHash" to hash(context),"chainId" to account.chainId,"accountId" to account.accountId,"expiresAt" to p["expiresAt"],"task" to task,"preview" to rp["preview"],"review" to consent)
  need(equal(p,expected)&&plan["planHash"]==hash(p)&&equal(preview,rp["preview"])&&date(p["expiresAt"])==expiry)
  val matrix=if(material["format"]=="raw")rows(r["utxos_satoshis"],1,32)else listOf(r["sourceUtxos"])+rows(r["inputs"],0,31)
  val count=matrix.sumOf{row->rows(row,0,1000).count{material["format"]=="raw"||map(it)["scriptSigType"]!="tbc_lop_match"}}
  need(count in 1..32000&&integer(preview["transactionCount"],32)==matrix.size.toLong());rows(policy["resolvedOutputs"],0,32000)
  return Bound(material,owned(policy),owned(map(packet["stage"])),account,hash(p),matrix.size,count)
 }
}
