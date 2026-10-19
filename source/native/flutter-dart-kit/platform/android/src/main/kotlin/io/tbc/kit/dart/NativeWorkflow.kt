package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant
import java.math.BigInteger

// Binding data for the existing custody owner, not a second signer. Family
// validation, native task consumption, completion and delivery are still needed.
// No receipt, key, permission, approval, HTTP or journal is created here.
internal object NativeWorkflow {
 val methods=setOf("tbc_signWorkflow","tbc_signPreparedWorkflow","tbc_sendWorkflow","tbc_sendPreparedWorkflow")
 data class Binding(val request:Map<String,Any?>,val plan:Map<String,Any?>,val binding:Map<String,Any?>,
  val children:List<Map<String,Any?>>,val requiredPermissions:Set<String>)
 private fun need(v:Boolean){if(!v)throw NativeCustodyFailure("NATIVE_WORKFLOW_BINDING")}
 @Suppress("UNCHECKED_CAST") private fun map(v:Any?):Map<String,Any?>{need(v is Map<*,*> && v.keys.all{it is String});return v as Map<String,Any?>}
 private fun rows(v:Any?):List<Map<String,Any?>>{need(v is List<*>);return (v as List<*>).map{map(it)}}
 private fun strings(v:Any?):List<String>{need(v is List<*> && v.all{it is String});return (v as List<*>).map{it as String}}
 private fun text(v:Any?):String{need(v is String);return v as String}
 private fun equal(a:Any?,b:Any?)=PermissionJson.canonical(a)==PermissionJson.canonical(b)
 private fun hash(v:Any?)=hex(MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray(Charsets.UTF_8)))
 private fun hex(v:ByteArray)=v.joinToString(""){"%02x".format(it)}
 private fun owned(v:Map<String,Any?>)=PermissionJson.records("[${PermissionJson.canonical(v)}]").single()
 private fun shape(v:Map<String,Any?>,required:Set<String>,optional:Set<String> = emptySet()){
  need(v.keys.containsAll(required)&&(required+optional).containsAll(v.keys)&&v.values.none{it==null})
 }
 private fun amount(v:Any?):BigInteger{val s=text(v);need(s.matches(Regex("^(0|[1-9][0-9]*)$")));return BigInteger(s)}
 private fun transaction(s:Map<String,Any?>)=s["kind"] in setOf("transaction","preparedTransaction")
 // Exact wire serialization remains in the shared worker. Native proves the
 // owned source and unchanged message semantics, then hashes the actual bytes.
 fun resolve(d:Map<String,Any?>,claimed:Map<String,Any?>,completed:Map<String,Map<String,Any?>>,account:NativeAccount,origin:String,walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):Pair<Map<String,Any?>,Map<String,Any?>>{
  val source=map(d["source"]);val result=completed[text(source["stepId"])]?:throw NativeCustodyFailure("NATIVE_WORKFLOW_DEPENDENCY");val output=text(source["output"]);val txs=rows(result["transactions"])
  val value:Any=when(output){
   "transactionIds"->txs.map{text(it["txid"])}
   "primaryTransactionId"->{val primary=txs.filter{it["role"]=="primary"};need(primary.size==1);text(primary.single()["txid"])}
   else->{need(output in setOf("artifacts.collectionId","artifacts.contractId","artifacts.poolContractId"));text(map(result["artifacts"])[output.drop(10)])}
  }
  for(id in if(value is List<*>)value.map{text(it)}else listOf(text(value)))need(id.matches(Regex("^[0-9a-f]{64}$")))
  val template=map(d["envelopeTemplate"]);val envelope=map(claimed["resolvedEnvelope"]);val purpose=text(d["purpose"]);val target=text(d["target"])
  need(target.startsWith("/message/")&&purpose in setOf("message","typedData"));val field=target.drop(9);val message=map(template["message"]).toMutableMap()
  if(purpose=="message"){
   val actual=map(envelope["message"]);shape(actual,setOf("data","encoding"));need(actual["encoding"]=="utf8"&&message["encoding"]=="utf8"&&value is List<*>)
   NativeWorkflowJSON.verify(text(message["data"]),field,(value as List<*>).map{text(it)},text(actual["data"]));message["data"]=actual["data"]
  }else{need(equal(message[field],mapOf("\$tbcBinding" to "unresolved")));message[field]=value}
  need(equal(envelope,template+("message" to message)));val digest=NativeSigningEnvelope.digest(envelope,purpose,walletProtocol)
  val task=mapOf("taskId" to d["taskId"],"purpose" to purpose,"algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to digest,"signatureEncoding" to "compact65-recoverable","origin" to origin,"accountId" to account.accountId,"publicKey" to account.publicKey)
  val resolved=mapOf("planTaskId" to d["taskId"],"source" to source,"sourceValue" to value,"targetStepId" to d["targetStepId"],"target" to target,"targetType" to d["targetType"],"purpose" to purpose,"resolvedEnvelope" to envelope,"canonical" to PermissionJson.canonical(envelope),"digest" to digest,"concreteTask" to task)
  need(equal(claimed,resolved));return Pair(owned(envelope),owned(task))
 }
 // Pinned Rust Transaction::tbc_txid / Dart reader header commitment. This is
 // deliberately not the Bitcoin SHA256d(serialized transaction) convention.
 private fun transactionId(bytes:ByteArray):String{
  var offset=0
  fun take(n:Int):ByteArray{need(n>=0&&n<=bytes.size-offset);val out=bytes.copyOfRange(offset,offset+n);offset+=n;return out}
  fun uint(n:Int):ULong{var v=0uL;for((i,b)in take(n).withIndex())v=v or ((b.toInt() and 255).toULong() shl (i*8));return v}
  fun size():Int{val tag=uint(1);if(tag<253uL)return tag.toInt();val n=if(tag==253uL)2 else if(tag==254uL)4 else 8;val v=uint(n);val minimum=if(n==2)253uL else if(n==4)65536uL else 4294967296uL;need(v>=minimum&&v<=bytes.size.toULong());return v.toInt()}
  fun script():ByteArray{val n=size();need(n<=10000);return take(n)}
  fun sha(v:ByteArray)=MessageDigest.getInstance("SHA-256").digest(v)
  fun little(v:Int)=ByteArray(4){(v ushr (it*8)).toByte()}
  val version=take(4);need(version.contentEquals(byteArrayOf(10,0,0,0)))
  val ni=size();need(ni in 1..10000);val input=java.io.ByteArrayOutputStream();val unlocks=java.io.ByteArrayOutputStream();val output=java.io.ByteArrayOutputStream()
  repeat(ni){input.write(take(36));unlocks.write(sha(script()));input.write(take(4))}
  val no=size();need(no in 1..10000);repeat(no){output.write(take(8));output.write(sha(script()))}
  val lock=take(4);need(offset==bytes.size)
  val header=version+lock+little(ni)+little(no)+sha(input.toByteArray())+sha(unlocks.toByteArray())+sha(output.toByteArray())
  return hex(sha(sha(header)).reversedArray())
 }
 // Shared worker already ran Rust final validation; bind its result to the
 // consumed native child and raw-derived IDs before exposing a later source.
 fun completedBundle(result:Map<String,Any?>,account:NativeAccount,requestHash:String,approvalId:String,fee:String,transactions:List<Map<String,Any?>>?,reviewed:NativeReviewed.Bound?):List<Map<String,Any?>>{
  shape(result,setOf("version","chainId","from","requestHash","approvalId","totalFee","transactions"),setOf("artifacts","detachedSignatures"))
  need(result["version"]=="1.0"&&result["chainId"]==account.chainId&&result["from"]==account.address&&result["requestHash"]==requestHash&&result["approvalId"]==approvalId&&result["totalFee"]==fee)
  val values=rows(result["transactions"]);val count=reviewed?.transactionCount?:transactions?.size?:0;need(count in 1..32&&values.size==count)
  val seen=mutableSetOf<String>()
  for((i,t) in values.withIndex()){
   shape(t,setOf("id","role","dependsOn","rawTransaction","txid"))
   val expected=if(reviewed!=null)mapOf("id" to "tx-${i+1}","role" to if(reviewed.associated&&i<count-1) "prerequisite" else "primary","dependsOn" to if(reviewed.associated&&i>0)listOf("tx-$i")else emptyList<String>())else transactions!![i]
   for(key in listOf("id","role","dependsOn"))need(equal(t[key],expected[key]))
   val raw=text(t["rawTransaction"]);val id=text(t["txid"])
   need(raw.isNotEmpty()&&raw.length<=8*1024*1024&&raw.length%2==0&&raw.all{it in '0'..'9'||it in 'a'..'f'})
   val data=ByteArray(raw.length/2){raw.substring(it*2,it*2+2).toInt(16).toByte()};val computed=transactionId(data)
   need(id==computed&&seen.add(id))
  }
  if(reviewed==null||reviewed.associated)need(!result.containsKey("detachedSignatures"))
  if(reviewed!=null&&!reviewed.associated)need((result["detachedSignatures"] as? List<*>)?.size==count)
  return values
 }
 // Render existing family descriptions, never a whole request that can hold
 // an HTLC witness or associated unlocking template.
 fun children(method:String,request:Map<String,Any?>):List<Map<String,Any?>>{
  need(method in methods);shape(request,setOf("version","chainId","from","steps"),setOf("clientRequestId","expiresAt","maxTotalFee","failureMode"))
  need(request["version"]=="1.0"&&request["chainId"] in setOf("tbc:mainnet","tbc:testnet"))
  val steps=rows(request["steps"]);need(steps.size in 1..5);val seen=mutableSetOf<String>()
  return steps.map{s->
   val id=text(s["id"]);val kind=text(s["kind"]);val depends=strings(s["dependsOn"])
   need(id.matches(Regex("^[A-Za-z][A-Za-z0-9._-]{0,63}$"))&&id !in seen&&depends.toSet().size==depends.size&&depends.all{it in seen})
   val r=mutableMapOf<String,Any?>("version" to "1.0","chainId" to request["chainId"],"from" to request["from"]);val childMethod:String
   when {
    transaction(s)->{
     val prepared=method in setOf("tbc_signPreparedWorkflow","tbc_sendPreparedWorkflow");need(kind==if(prepared)"preparedTransaction" else "transaction")
     shape(s,setOf("id","kind","dependsOn","intent")+(if(prepared)setOf("proposal") else emptySet()),setOf("constraints","signingRoles"))
     r["intent"]=map(s["intent"]);for(k in listOf("constraints","signingRoles","proposal"))if(s.containsKey(k))r[k]=s[k]
     childMethod=if(prepared)"tbc_signPreparedTransaction" else "tbc_signTransaction"
    }
    kind=="reviewedTransaction"->{shape(s,setOf("id","kind","dependsOn","request"));r["request"]=map(s["request"]);childMethod=NativeReviewed.method}
    kind=="message"->{shape(s,setOf("id","kind","dependsOn","message"),setOf("bindings"));r["message"]=map(s["message"]);childMethod="tbc_signMessage"}
    kind=="typedData"->{shape(s,setOf("id","kind","dependsOn","data","bindings"));r["data"]=map(s["data"]);childMethod="tbc_signTypedData"}
    kind=="encrypt"||kind=="decrypt"->{val field=if(kind=="encrypt") "message" else "ciphertext";shape(s,setOf("id","kind","dependsOn","algorithm",field));r["algorithm"]=s["algorithm"];r[field]=s[field];childMethod="tbc_$kind"}
    else->throw NativeCustodyFailure("NATIVE_WORKFLOW_PROFILE_NOT_INSTALLED")
   }
   seen+=id;owned(mapOf("id" to id,"kind" to kind,"dependsOn" to depends,"method" to childMethod,"request" to r))
  }
 }
 // Envelopes use the same native normalizer as single calls, never an injected digest.
 // reviews are previously verified native consent records, never page previews.
 fun bind(method:String,request:Map<String,Any?>,context:Map<String,Any?>,account:NativeAccount,
  accounts:List<NativeAccount>,plan:Map<String,Any?>,preview:Map<String,Any?>,binding:Map<String,Any?>,
  reviews:Map<String,Map<String,Any?>>,now:Instant=Instant.now(),walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):Binding{
  val children=children(method,request);val steps=rows(request["steps"])
  need(request["chainId"]==account.chainId&&request["from"]==account.address)
  val origin=text(context["origin"]);val session=text(context["sessionId"])
  need(origin.isNotEmpty()&&session.isNotEmpty()&&context["frame"]=="top"&&equal(context["origin"],context["topOrigin"]))
  val selected=listOf(account)+accounts
  need(selected.map{it.accountId}.toSet().size==selected.size&&selected.map{it.publicKey.drop(2)}.toSet().size==selected.size)
  val identities=selected.associate{it.accountId to it.identity()}
  shape(plan,setOf("payload","workflowPlanHash"));shape(binding,setOf("payload","bindingHash"))
  val p=map(plan["payload"]);val expiry=Instant.parse(text(p["expiresAt"]))
  need(expiry.isAfter(now)&&!expiry.isAfter(now.plusSeconds(301)))
  request["expiresAt"]?.let{need(!expiry.isAfter(Instant.parse(text(it))))}
  val mode=text(request["failureMode"]?:"atomic");need(mode in setOf("atomic","continue-independent"))
  val transactionPlans=rows(p["transactionPlans"]);val reviewTasks=rows(p["reviewedTransactionTasks"])
  val immediate=mutableListOf<Map<String,Any?>>();val deferred=mutableListOf<Map<String,Any?>>();val expectedReviews=mutableListOf<Map<String,Any?>>()
  val cryptoTasks=mutableListOf<Map<String,Any?>>()
  val flows=mutableMapOf<String,Any?>();val roles=mutableListOf<Map<String,Any?>>()
  val planWarnings=mutableListOf<String>();val reviewWarnings=mutableListOf<String>()
  var fee=BigInteger.ZERO;var transactionIndex=0;var reviewIndex=0;val permissions=mutableSetOf("tbc_signWorkflow")
  if(NativePrepared.sends(method))permissions.add("tbc_sendTransaction")
  for((index,s)in steps.withIndex()){
   val id=text(s["id"]);val child=children[index];val childRequest=map(child["request"]);val kind=text(s["kind"])
   permissions+=NativePrepared.permission(text(child["method"]))
   if(kind=="encrypt"||kind=="decrypt"){
    cryptoTasks+=NativeCrypto.task(childRequest,text(child["method"]),context,account,"crypto-$id")
   }else if(transaction(s)){
    need(transactionIndex<transactionPlans.size);val entry=transactionPlans[transactionIndex++]
    shape(entry,setOf("stepId","plan"));need(entry["stepId"]==id)
    val single=map(entry["plan"]);val body=map(single["payload"]);val review=map(body["preview"]);shape(single,setOf("payload","planHash"))
    need(single["planHash"]==hash(body)&&body["requestHash"]==hash(NativePrepared.request(childRequest,text(child["method"])))&&body["accountId"]==account.accountId&&body["chainId"]==account.chainId&&!expiry.isAfter(Instant.parse(text(body["expiresAt"]))))
    if(kind=="preparedTransaction")NativePrepared.consent(childRequest,now)
    val stepFee=rows(body["transactions"]).fold(BigInteger.ZERO){sum,tx->sum+amount(tx["fee"])}
    need(equal(review["totalFee"],stepFee.toString()));fee+=stepFee
    (childRequest["constraints"] as? Map<*,*>)?.get("maxFee")?.let{need(stepFee<=amount(it))}
    val expectedRoles=rows(s["signingRoles"]?:emptyList<Any>()).map{r->
     shape(r,setOf("role","accountId"));need(r["role"]=="pool-controller")
     val a=identities[text(r["accountId"])]?:throw NativeCustodyFailure("NATIVE_WORKFLOW_ACCOUNT")
     mapOf("role" to "pool-controller","account" to a)
    }
    need(expectedRoles.size<=1&&equal(review["signingRoles"]?:emptyList<Any>(),expectedRoles))
    roles+=expectedRoles.map{it+mapOf("stepId" to id)}
    val allowed=listOf(account.identity())+expectedRoles.map{map(it["account"])}
    immediate+=rows(body["signingTasks"]).map{t->need(allowed.any{it["accountId"]==t["accountId"]&&it["publicKey"]==t["publicKey"]});mapOf("stepId" to id,"task" to t)}
    flows[id]=review["assetFlows"];planWarnings+=strings(review["warnings"])
   }else if(kind=="reviewedTransaction"){
    need(reviewIndex<reviewTasks.size);reviewIndex++
    val review=reviews[id]?:throw NativeCustodyFailure("NATIVE_WORKFLOW_REVIEW_REQUIRED")
    val consent=NativeReviewed.consent(childRequest,review,now);val rp=map(consent["payload"])
    need(!expiry.isAfter(Instant.parse(text(rp["expiresAt"]))))
    expectedReviews+=mapOf("taskId" to "review-$id","purpose" to "reviewedTransaction","contextHash" to hash(context),"requestHash" to hash(s["request"]),"reviewHash" to consent["reviewHash"],"policyMaterial" to rp["policyMaterial"],"chainId" to account.chainId,"accountId" to account.accountId,"publicKey" to account.publicKey,"request" to s["request"])
    fee+=amount(rp["totalFee"]);flows[id]=rp["preview"];reviewWarnings+=strings(map(rp["preview"])["warnings"])
   }
  }
  need(transactionIndex==transactionPlans.size&&reviewIndex==reviewTasks.size&&reviews.keys==steps.filter{it["kind"]=="reviewedTransaction"}.map{text(it["id"])}.toSet())
  for(kind in listOf("message","typedData"))for(s in steps.filter{it["kind"]==kind}){
   val id=text(s["id"]);val e=NativeSigningEnvelope.workflow(s,account.chainId,account.address,origin);val bindings=rows(s["bindings"]?:emptyList<Any>())
   need(e["version"]=="1.0"&&e["type"]==(if(kind=="message")"tbc.message" else "tbc.typedData"))
   if(kind=="message")need(equal(e["message"],s["message"]))else{val d=map(s["data"]);for(k in listOf("domain","message","primaryType"))need(equal(e[k],d[k]))}
   need(bindings.size<=1)
   if(bindings.isEmpty()){
    immediate+=mapOf("stepId" to id,"envelope" to e,"task" to mapOf("taskId" to "sign-$id","purpose" to kind,"algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to NativeSigningEnvelope.digest(e,kind,walletProtocol),"signatureEncoding" to "compact65-recoverable","origin" to origin,"accountId" to account.accountId,"publicKey" to account.publicKey))
   }else{
    val b=bindings.single();val source=map(b["source"]);val target=text(b["target"])
    shape(b,setOf("source","target"));shape(source,setOf("stepId","output"))
    val parent=steps.find{it["id"]==source["stepId"]}?:throw NativeCustodyFailure("NATIVE_WORKFLOW_SOURCE")
    need(text(source["stepId"]) in strings(s["dependsOn"])&&(transaction(parent)||(kind=="message"&&parent["kind"]=="reviewedTransaction")))
    val output=text(source["output"]);val field=if(kind=="message")target else target.drop(9);val targetType:String
    need(field.matches(Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$"))&&field !in setOf("__proto__","constructor","prototype"))
    if(kind=="message"){
     val message=map(e["message"]);need(output=="transactionIds"&&message["encoding"]=="utf8")
     NativeWorkflowJSON.template(text(message["data"]),field);targetType="json-string-array"
    }else{
     need(target.startsWith("/message/")&&output in setOf("transactionIds","primaryTransactionId","artifacts.collectionId","artifacts.contractId","artifacts.poolContractId"))
     val matches=rows(map(e["types"])[text(e["primaryType"])]).filter{it["name"]==field};need(matches.size==1)
     targetType=text(matches.single()["type"])
     need(targetType==(if(output=="transactionIds")"bytes32[]" else "bytes32")&&equal(map(e["message"])[field],mapOf("\$tbcBinding" to "unresolved")))
    }
    deferred+=mapOf("taskId" to "sign-$id","source" to source,"targetStepId" to id,"target" to (if(kind=="message")"/message/$field" else target),"targetType" to targetType,"purpose" to kind,"publicKey" to account.publicKey,"envelopeTemplate" to e)
   }
  }
  val warnings=(planWarnings+reviewWarnings+(if(deferred.isNotEmpty())listOf("DYNAMIC_BINDING")else emptyList())).distinct()
  val cap=amount(request["maxTotalFee"]?:fee.toString());need(fee<=cap)
  val previewSteps=steps.map{s->
   val id=text(s["id"]);val kind=text(s["kind"])
   mapOf("id" to id,"kind" to kind,"dependsOn" to s["dependsOn"])+when{
    transaction(s)->mapOf("assetFlows" to flows[id])
    kind=="reviewedTransaction"->mapOf("reviewedTransactionPreview" to flows[id])
    kind=="message"->mapOf("message" to s["message"])
    kind=="encrypt"||kind=="decrypt"->mapOf("algorithm" to s["algorithm"],(if(kind=="encrypt") "message" else "ciphertext") to s[if(kind=="encrypt") "message" else "ciphertext"])
    else->mapOf("typedData" to s["data"])
   }
  }
  val previewBindings=deferred.map{d->val s=map(d["source"]);mapOf("sourceStepId" to s["stepId"],"sourceOutput" to s["output"],"target" to d["target"],"targetType" to d["targetType"])}
  val expectedPreview=mutableMapOf<String,Any?>("operationKind" to "workflow","failureMode" to mode,"steps" to previewSteps,"bindings" to previewBindings,"totalFee" to fee.toString(),"warnings" to warnings)
  if(roles.isNotEmpty())expectedPreview["signingRoles"]=roles
  val expected=mapOf("version" to "1.0","requestHash" to hash(request),"chainId" to account.chainId,"accountId" to account.accountId,"expiresAt" to p["expiresAt"],"failureMode" to mode,"stepOrder" to steps.map{it["id"]},"transactionPlans" to transactionPlans,"immediateSigningTasks" to immediate,"deferredSigningTasks" to deferred,"legacyBitcoinMessageStepIds" to if(walletProtocol==NativeWalletProtocol.LEGACY)steps.filter{it["kind"]=="message"}.map{it["id"]} else emptyList<Any>(),"cryptoTasks" to cryptoTasks,"reviewedTransactionTasks" to expectedReviews,"maxTotalFee" to cap.toString(),"totalFee" to fee.toString(),"preview" to expectedPreview)
  need(equal(p,expected)&&plan["workflowPlanHash"]==hash(expected)&&equal(preview,expectedPreview))
  val expectedBinding=mapOf("version" to "1.0","method" to method,"operationKind" to "workflow","contextHash" to hash(context),"origin" to origin,"sessionId" to session,"chainId" to account.chainId,"accountId" to account.accountId,"requestHash" to hash(request),"operationHash" to plan["workflowPlanHash"],"expiresAt" to p["expiresAt"])
  need(equal(binding["payload"],expectedBinding)&&binding["bindingHash"]==hash(expectedBinding))
  return Binding(owned(request),owned(plan),owned(binding),children,permissions)
 }
}

// Semantic verifier only; wire-byte generation remains in Dart's shared
// JSON.parse/stringify-compatible formatter. Preserve UTF-16 escapes and JS
// binary64 semantics instead of org.json's integer-only protocol-map parser.
internal object NativeWorkflowJSON {
 private sealed interface Value
 private object Null:Value
 private data class Bool(val value:Boolean):Value
 private data class Number(val value:Double):Value
 private data class Text(val value:String):Value
 private data class Array(val value:List<Value>):Value
 private data class Object(val value:Map<String,Value>):Value
 private fun need(v:Boolean){if(!v)throw NativeCustodyFailure("NATIVE_WORKFLOW_JSON")}
 private class Parser(val s:String){
  var i=0;var nodes=0
  init{need(s.toByteArray(Charsets.UTF_8).size<=65536)}
  fun ws(){while(i<s.length&&s[i] in "\t\n\r ")i++}
  fun take(c:Char):Boolean{if(i<s.length&&s[i]==c){i++;return true};return false}
  fun text():String{
   need(take('"'));val out=StringBuilder()
   while(i<s.length){val c=s[i++];if(c=='"')return out.toString();need(c.code>=32)
    if(c!='\\'){out.append(c);continue};need(i<s.length);val e=s[i++]
    if(e=='u'){need(i+4<=s.length);val n=s.substring(i,i+4);need(n.all{it in '0'..'9'||it in 'a'..'f'||it in 'A'..'F'});out.append(n.toInt(16).toChar());i+=4}
    else out.append(when(e){'"'->'"';'\\'->'\\';'/'->'/';'b'->'\b';'f'->'\u000c';'n'->'\n';'r'->'\r';'t'->'\t';else->throw NativeCustodyFailure("NATIVE_WORKFLOW_JSON")})
   };throw NativeCustodyFailure("NATIVE_WORKFLOW_JSON")
  }
  fun value(depth:Int=0):Value{
   ws();nodes++;need(depth<=128&&nodes<=65536&&i<s.length)
   if(s[i]=='"')return Text(text())
   if(take('{')){val out=linkedMapOf<String,Value>();ws();if(take('}'))return Object(out)
    while(true){ws();val key=text();ws();need(take(':'));out[key]=value(depth+1);ws();if(take('}'))return Object(out);need(take(','))}}
   if(take('[')){val out=mutableListOf<Value>();ws();if(take(']'))return Array(out)
    while(true){out+=value(depth+1);ws();if(take(']'))return Array(out);need(take(','))}}
   for((word,v)in listOf("null" to Null,"true" to Bool(true),"false" to Bool(false)))if(s.startsWith(word,i)){i+=word.length;return v}
   val start=i;take('-');if(!take('0')){need(i<s.length&&s[i] in '1'..'9');while(i<s.length&&s[i] in '0'..'9')i++}
   if(take('.')){val before=i;while(i<s.length&&s[i] in '0'..'9')i++;need(i>before)}
   if(take('e')||take('E')){if(!take('+'))take('-');val before=i;while(i<s.length&&s[i] in '0'..'9')i++;need(i>before)}
   val v=s.substring(start,i).toDoubleOrNull()?:throw NativeCustodyFailure("NATIVE_WORKFLOW_JSON");return if(v.isFinite())Number(if(v==0.0)0.0 else v)else Null
  }
  fun root():Map<String,Value>{val v=value();ws();need(i==s.length&&v is Object);return (v as Object).value}
 }
 private fun objectValue(text:String,field:String):Map<String,Value>{
  need(field.matches(Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$")));val denied=setOf("__proto__","constructor","prototype");val value=Parser(text).root()
  need(field !in denied&&value.keys.none{it in denied});need(!value.containsKey(field)||value[field] is Array);return value
 }
 fun template(text:String,field:String){objectValue(text,field)}
 fun verify(template:String,field:String,ids:List<String>,resolved:String){val expected=objectValue(template,field)+(field to Array(ids.map{Text(it)}));need(objectValue(resolved,field)==expected)}
}
