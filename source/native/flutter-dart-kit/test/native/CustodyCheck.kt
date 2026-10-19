package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import java.time.Instant
import org.json.JSONObject

// Keyless native replay. The signer supplies recorded public-fixture bytes only
// for an exact frozen digest. This is neither new signing nor chain acceptance.
private class CustodyAccounts(override var current:NativeAccount):NativeAccountSource {
 override var revision=0L;override var unlocked=true
 var additional=emptyList<NativeAccount>();override val signingAccounts get()=listOf(current)+additional
}
private class CustodyStore(override val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):NativePermissionBackend {
 var records=mutableMapOf<String,PermissionSnapshot>();var loads=0;var writes=0
 override fun loadAll():Map<String,PermissionSnapshot>{loads++;return records.toMap()}
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();check((this.records[origin]?.revision?:0)==expected);val next=PermissionSnapshot(expected+1,records)
  fence();this.records[origin]=next;writes++;return PermissionCommitResult(next.revision,next)
 }
}
private class CustodyUi:NativeApprovalPresenter {
 val pending=mutableMapOf<String,(Boolean)->Unit>();var shown=0;var dismissed=0
 val reviews=mutableMapOf<String,NativeReview>()
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{
  shown++;check(pending.put(review.operationId,complete)==null);reviews[review.operationId]=review
  return {pending.remove(review.operationId);dismissed++}
 }
 fun choose(id:String,yes:Boolean=true){pending.remove(id)!!(yes)}
}
private class ReplaySigner(val samples:Map<String,ByteArray>):NativeDigestSigner {
 var calls=0;var used=0;var hold=false;var wrongLength=false
 var identities=emptyMap<String,NativeAccount>()
 var release:(()->Unit)?=null
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  calls++
  val perform={
   complete(runCatching{
    requireCurrent();val value=samples[hex(digest)]?:error("UNRECORDED_DIGEST")
    check(identities[hex(digest)]==account){"WRONG_SIGNING_ACCOUNT"}
    check(value.size==if(encoding=="compact64")64 else 65);used++
    if(wrongLength)byteArrayOf(1)else value.copyOf()
   });Unit
  }
  if(hold)release=perform else perform()
 }
}
private fun hex(b:ByteArray)=b.joinToString(""){"%02x".format(it)}
private fun unhex(s:String)=s.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
private fun hash(value:Any?)=hex(MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(value).toByteArray(Charsets.UTF_8)))
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun copy(v:Map<String,Any?>)=PermissionJson.records("[${PermissionJson.canonical(v)}]").single()
private var custodyChecks=0
private fun yes(v:Boolean){check(v){"custody check ${custodyChecks+1}"};custodyChecks++}
private fun rejects(f:()->Unit){var failed=false;try{f()}catch(_:Exception){failed=true};yes(failed)}

private fun freshPreparedRequest(request:Map<String,Any?>,method:String):Map<String,Any?>{
 if(method!="tbc_signPreparedTransaction")return request
 val proposal=map(request["proposal"]);val p=map(proposal["payload"]);val now=Instant.now()
 val fresh=p+mapOf("createdAt" to now.toString(),"expiresAt" to now.plusSeconds(240).toString(),"evidence" to (map(p["evidence"])+mapOf("observedAt" to now.toString())))
 return request+mapOf("proposal" to mapOf("payload" to fresh,"proposalHash" to hash(fresh)))
}
private class CustodyHarness(val sample:Map<String,Any?>,val walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD){
 val account=map(sample["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 val accounts=CustodyAccounts(account);val store=CustodyStore(walletProtocol);val ui=CustodyUi()
 val context=map(sample["context"]);val audit=map(sample["audit"]);val method=sample["method"] as String
 val request=freshPreparedRequest(map(sample["request"]),method)
 val tasks:List<Map<String,Any?>> = if(NativePrepared.transaction(method)){
  (map(map(audit["plan"])["payload"])["signingTasks"] as List<*>).map{map(it)}
 }else if(audit["tasks"] is List<*>)(audit["tasks"] as List<*>).map{map(it)} else listOf(mapOf("taskId" to "sign-message","purpose" to "message","algorithm" to "secp256k1-recoverable-ecdsa-sha256d","digest" to map(audit["preview"])["digest"],"signatureEncoding" to "compact65-recoverable","origin" to context["origin"],"accountId" to account.accountId,"publicKey" to account.publicKey))
 val signatures=(audit["signatures"] as List<*>).map{map(it)}
 val allTasks=(audit["stages"] as? List<*>)?.flatMap{(map(it)["tasks"] as List<*>).map{map(it)}}?:tasks
 val signer=ReplaySigner(allTasks.associate{t->t["digest"] as String to unhex(signatures.single{it["taskId"]==t["taskId"]}["signature"] as String)})
 val current=mutableMapOf<String,Map<String,String>>()
 val custody=NativeCustody(accounts,account.chainId,store,ui,signer,walletProtocol=walletProtocol){owner,scope->current[owner]==scope}
 fun reviewId(id:String)=if(walletProtocol==NativeWalletProtocol.LEGACY)PermissionJson.id(walletProtocol.namespace,"review",id)else id
 val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "native-check","committedUrl" to "${context["origin"]}/dapp")
 init{
  accounts.additional=((sample["additionalAccounts"] ?: if(method=="tbc_signPreparedTransaction")map(map(map(audit["material"])["snapshot"])["payload"])["signingAccounts"] else null) as? List<*>)?.map{map(it).let{a->NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)}}?:emptyList()
  signer.identities=allTasks.associate{t->t["digest"] as String to accounts.signingAccounts.single{it.accountId==t["accountId"]&&it.publicKey==t["publicKey"]}}
  current["view"]=scope;custody.navigation("view",scope)
 }
 fun grant(){
  var value:Result<List<Map<String,Any?>>>?=null
  custody.requestPermissions("view",scope,"grant",mapOf("tbc_accounts" to mapOf("chains" to listOf(account.chainId),"maxAccounts" to accounts.signingAccounts.size),NativePrepared.permission(method) to mapOf("chains" to listOf(account.chainId)))){value=it}
  yes(value==null&&store.writes==0);ui.choose(reviewId("grant"));yes(value!!.isSuccess&&store.writes==1)
 }
 fun begin(id:String="op",owner:String="view",scope:Map<String,String> = this.scope){
  custody.begin(owner,scope,id,method,custody.snapshot(owner,scope).revision,account)
  if(owner=="view"&&request["signingRoles"]!=null)custody.resolveSigningAccounts(owner,scope,id,request,context)
 }
 fun consent(id:String="op",owner:String="view",scope:Map<String,String> = this.scope,callback:(Result<Boolean>)->Unit={it.getOrThrow()}){
  custody.consent(owner,scope,id,method,request,context,callback)
  val intent=request["intent"]?.let{map(it)}
  if(intent!=null&&intent["type"] in setOf("tbc20.transfer","tbc20Stablecoin.transfer")){
   val description=ui.reviews.getValue(id).description
   val receivers=(intent["receivers"] as? List<*>)?.map{map(it)}?:listOf(intent)
   for(row in receivers)check(description.contains("Send ${row["amount"]} token atomic to ${row["to"]}."))
   intent["payment"]?.let{map(it)}?.let{check(description.contains("Also send ${it["amount"]} TBC atomic to ${it["to"]}."))}
  }
  if((intent?.get("type") as? String)?.startsWith("tbc20Stablecoin.")==true){
   check(ui.reviews.getValue(id).description.contains("Stablecoin ${intent!!["contractId"]}"))
  }
  if(intent?.get("type")=="tbc721.transfer"){
   val description=ui.reviews.getValue(id).description
   check(description.contains("Send NFT ${intent["contractId"]} to ${intent["to"]}."))
   intent["payment"]?.let{map(it)}?.let{check(description.contains("Also send ${it["amount"]} TBC atomic to ${it["to"]}."))}
  }
 }
 fun material(id:String="op",badBinding:Boolean=false):Map<String,Any?>{
  // Only the expiring approval envelope changes, never task digests/plan/raw.
  val b=copy(map(audit["binding"])).toMutableMap();val p=map(b["payload"]).toMutableMap()
  p["expiresAt"]=Instant.now().plusSeconds(120).toString();if(badBinding)p["requestHash"]="00".repeat(32)
  b["payload"]=p;b["bindingHash"]=hash(p)
  return custody.bind("view",scope,id,b,map(audit["preview"]),audit["plan"]?.let{map(it)},
   if(method=="tbc_signMessage")mapOf("type" to "tbc.message","version" to "1.0","message" to request["message"])else audit["envelope"]?.let{map(it)})
 }
 fun ready():Map<String,Any?>{grant();begin();consent();ui.choose(reviewId("op"));return material()}
 fun pending(receipt:Map<String,Any?>,stage:Int=0):Map<String,Any?>{
  val p=copy(map(map((audit["stages"] as List<*>)[stage])["result"]))
  return p+mapOf("continuation" to (map(p["continuation"])+mapOf("bindingHash" to receipt["bindingHash"],"approvalId" to receipt["approvalId"])))
 }
 fun signFirst(receipt:Map<String,Any?>){for(task in tasks){var result:Result<Map<String,Any?>>?=null;custody.sign("view",scope,"op",receipt,task){result=it};result!!.getOrThrow()}}
}

private fun preparedCheck(samples:List<Map<String,Any?>>){
 for(sample in samples){
  val h=CustodyHarness(sample);val receipt=h.ready();val stages=(h.audit["stages"] as List<*>).map{map(it)}
  yes(h.ui.shown==2&&h.ui.reviews.getValue("op").description.contains("no broadcast"))
  for((index,stage) in stages.withIndex()){
   if(index>0)h.custody.advance("view",h.scope,"op",receipt,h.pending(receipt,index-1))
   for(task in (stage["tasks"] as List<*>).map{map(it)}){
    var result:Result<Map<String,Any?>>?=null;h.custody.sign("view",h.scope,"op",receipt,task){result=it}
    yes(PermissionJson.canonical(result!!.getOrThrow())==PermissionJson.canonical(h.signatures.single{it["taskId"]==task["taskId"]}))
   }
  }
  rejects{h.signFirst(receipt)};h.custody.close("view",h.scope,"op")
  yes(h.custody.mayDeliverSignature("view",h.scope,"op")&&h.signer.used==h.signatures.size&&h.store.writes==1)
  h.accounts.unlocked=false;yes(!h.custody.mayDeliverSignature("view",h.scope,"op"))
 }
 for(mutation in listOf("hash","profile","intent","expired","observation")){
  val h=CustodyHarness(samples[0]);h.grant();h.begin()
  val r=h.request.toMutableMap();val proposal=map(r["proposal"]).toMutableMap();val p=map(proposal["payload"]).toMutableMap()
  when(mutation){
   "profile"->p["engineProfile"]="arbitrary-engine"
   "intent"->p["intentHash"]="00".repeat(32)
   "expired"->p["expiresAt"]="2020-01-01T00:00:00Z"
   "observation"->p["evidence"]=map(p["evidence"])+mapOf("observedAt" to "2020-01-01T00:00:00Z")
  }
  proposal["payload"]=p;proposal["proposalHash"]=if(mutation=="hash")"00".repeat(32)else hash(p);r["proposal"]=proposal
  rejects{h.custody.consent("view",h.scope,"op",h.method,r,h.context){error("UNREACHABLE")}}
  yes(h.ui.shown==1&&h.signer.used==0)
 }
 for(mutation in listOf("fee","raw","role","edge","full-request-hash","method","deadline")){
  val h=CustodyHarness(samples.single{it["name"]=="create-tbc20-fragmented"});h.grant();h.begin()
  val r=h.request.toMutableMap();val proposal=map(r["proposal"]).toMutableMap();val p=map(proposal["payload"]).toMutableMap()
  if(mutation in listOf("fee","raw","role","edge")){
   val txs=(p["transactions"] as List<*>).map{map(it).toMutableMap()}
   when(mutation){
    "fee"->p["estimatedTotalFee"]="1"
    "raw"->txs[0]["unsignedTransaction"]="00000000"
    "role"->txs[0]["role"]="primary"
    else->{val edges=(txs[1]["deferredInputs"] as List<*>).map{map(it).toMutableMap()};edges[0]["sourceOutputIndex"]=99;txs[1]["deferredInputs"]=edges}
   }
   p["transactions"]=txs;proposal["payload"]=p;proposal["proposalHash"]=hash(p);r["proposal"]=proposal
  }
  h.custody.consent("view",h.scope,"op",h.method,r,h.context){it.getOrThrow()};h.ui.choose("op")
  val b=map(h.audit["binding"]).toMutableMap();val payload=map(b["payload"]).toMutableMap()
  payload["expiresAt"]=Instant.now().plusSeconds(if(mutation=="deadline")290 else 120).toString()
  if(mutation=="full-request-hash")payload["requestHash"]=hash(r)
  if(mutation=="method")payload["method"]="tbc_signTransaction"
  b["payload"]=payload;b["bindingHash"]=hash(payload)
  rejects{h.custody.bind("view",h.scope,"op",b,map(h.audit["preview"]),map(h.audit["plan"]),null)}
  yes(h.signer.used==0&&h.ui.shown==2&&h.store.writes==1)
 }
 run{
  val h=CustodyHarness(samples[0]);rejects{h.begin()};h.grant();h.begin();var result:Result<Boolean>?=null
  h.consent{result=it};h.ui.choose("op",false);yes(result!!.getOrThrow()==false);rejects{h.material()};yes(h.signer.used==0)
 }
 run{
  val h=CustodyHarness(samples[0]);val r=h.ready();h.signer.hold=true;var result:Result<Map<String,Any?>>?=null
  h.custody.sign("view",h.scope,"op",r,h.tasks[0]){result=it};h.accounts.unlocked=false;h.signer.release!!();yes(result!!.isFailure);yes(h.signer.used==0)
 }
}

private fun typedNegativeCheck(sample:Map<String,Any?>,invalid:List<Map<String,Any?>>){
 for(bad in invalid){
  val h=CustodyHarness(sample+mapOf("request" to bad["request"]));h.grant();h.begin()
  rejects{h.consent()};yes(h.ui.shown==1&&h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample)
  h.custody.requestPermissions("view",h.scope,"message-only",mapOf("tbc_accounts" to mapOf("chains" to listOf(h.account.chainId)),"tbc_signMessage" to mapOf("chains" to listOf(h.account.chainId)))){it.getOrThrow()}
  h.ui.choose("message-only");rejects{h.begin()};yes(h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);h.grant()
  rejects{h.custody.begin("view",h.scope,"ordinary","tbc_signMessage",h.custody.snapshot("view",h.scope).revision,h.account)}
  yes(h.signer.calls==0)
 }
 for(mutation in 0 until 7){
  val h=CustodyHarness(sample);h.grant();h.begin();h.consent();h.ui.choose("op")
  val b=map(h.audit["binding"]).toMutableMap();val p=map(b["payload"]).toMutableMap()
  val review=map(h.audit["preview"]).toMutableMap();val envelope=map(h.audit["envelope"]).toMutableMap()
  p["expiresAt"]=Instant.now().plusSeconds(120).toString()
  when(mutation){
   0->{p["operationHash"]="00".repeat(32);review["digest"]=p["operationHash"]}
   1->envelope["message"]=mapOf("amount" to "999")
   2->review["domain"]=mapOf("name" to "Unapproved","chainId" to h.account.chainId)
   3->envelope["types"]=mapOf("Transfer" to listOf(mapOf("name" to "to","type" to "different")))
   4->p["operationKind"]="message"
   5->review["message"]=mapOf("amount" to "999")
   else->review["primaryType"]="Changed"
  }
  b["payload"]=p;b["bindingHash"]=hash(p)
  rejects{h.custody.bind("view",h.scope,"op",b,review,null,envelope)}
  yes(h.signer.calls==0&&h.ui.shown==2)
 }
}

private fun controllerNegativeCheck(sample:Map<String,Any?>){
 run{
  val h=CustodyHarness(sample);val roles=h.accounts.additional;h.accounts.additional=emptyList();h.grant();h.accounts.additional=roles
  rejects{h.begin()};yes(h.ui.shown==1&&h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);h.grant()
  h.custody.begin("view",h.scope,"op",h.method,h.custody.snapshot("view",h.scope).revision,h.account)
  rejects{h.consent()};yes(h.ui.shown==1&&h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);h.grant();h.begin()
  rejects{h.custody.resolveSigningAccounts("view",h.scope,"op",h.request,h.context)}
  val changed=h.request+mapOf("constraints" to mapOf("maxFee" to "99999"))
  rejects{h.custody.consent("view",h.scope,"op",h.method,changed,h.context){error("UNREACHABLE")}}
  yes(h.ui.shown==1&&h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);h.grant();h.begin();var result:Result<Boolean>?=null
  h.consent{result=it};h.accounts.additional=emptyList();h.ui.choose("op")
  yes(result?.isFailure==true);yes(h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);val receipt=h.ready();h.signer.hold=true;var result:Result<Map<String,Any?>>?=null
  val task=h.tasks.first{it["accountId"]!=h.account.accountId}
  h.custody.sign("view",h.scope,"op",receipt,task){result=it}
  h.accounts.additional=listOf(h.accounts.additional.single().copy(publicKey=h.account.publicKey))
  h.signer.release!!();yes(result?.isFailure==true);yes(h.signer.used==0)
 }
 run{
  val h=CustodyHarness(sample);val receipt=h.ready();h.signFirst(receipt)
  h.custody.close("view",h.scope,"op");yes(h.custody.mayDeliverSignature("view",h.scope,"op"))
  h.accounts.additional=emptyList();yes(!h.custody.mayDeliverSignature("view",h.scope,"op"))
 }
 run{
  val h=CustodyHarness(sample);h.grant();h.begin();h.consent();h.ui.choose("op")
  val review=map(h.audit["preview"])-"signingRoles"
  rejects{h.custody.bind("view",h.scope,"op",map(h.audit["binding"]),review,map(h.audit["plan"]),null)}
  yes(h.signer.calls==0)
 }
}

private fun creationCheck(sample:Map<String,Any?>){
 val h=CustodyHarness(sample);val receipt=h.ready();val stages=(h.audit["stages"] as List<*>).map{map(it)};val intent=map(h.request["intent"])
 val description=h.ui.reviews.getValue("op").description
 val mint=intent["type"] in setOf("tbc721-standard-mint","tbc721-standard-batch-mint")
 val amm=intent["type"]=="tbc-amm-create"
 val pool=intent["type"] in setOf("tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap")
 if(pool)yes(description.contains(intent["poolContractId"] as String)&&description.contains("authenticated Pool fees"))
 else if(amm){
  yes(description.contains(intent["ftContractId"] as String)&&description.contains("adding liquidity is separate"))
  yes(description.contains("LP timelock: ${intent["lpTimelock"]}."))
  for(c in (intent["controllers"] as? List<*>)?:listOf("Public (no controller)"))yes(description.contains(c as String))
 }else if(mint){
  yes(description.contains(intent["collectionId"] as String))
  val items=if(intent["type"]=="tbc721-standard-mint")listOf(intent)else (intent["items"] as List<*>).map{map(it)}
  for(item in items)yes(description.contains("Slot ${item["slot"]}:")&&description.contains(item["name"] as String)&&description.contains(PermissionJson.canonical(item["attributes"]))&&description.contains(item["to"] as? String ?: h.account.address))
 }else yes(description.contains(intent["name"] as String)&&description.contains(intent["to"] as? String ?: h.account.address))
 yes(description.contains("no broadcast")&&description.contains("input consolidation"))
 if(intent["type"]=="tbc20-standard-create"){
  yes(description.contains(intent["symbol"] as String)&&description.contains(intent["initialSupply"] as String)&&description.contains("dependent funding/source/genesis"))
 }else if(!mint&&!amm&&!pool)yes(description.contains(hash(intent["media"]))&&description.contains(intent["supply"] as String))
 for((index,stage)in stages.withIndex()){
  if(index>0){val p=h.pending(receipt,index-1)
   if(mint||amm||pool){val wrong=p+mapOf("continuation" to (map(p["continuation"])+mapOf("family" to "ft")));rejects{h.custody.advance("view",h.scope,"op",receipt,wrong)}}
   if(pool)for(mutation in listOf("planHash","stage","taskDigest")){
    val wrong=copy(p).toMutableMap();val c=map(wrong["continuation"]).toMutableMap()
    when(mutation){"planHash"->c[mutation]="wrong";"stage"->c[mutation]=index+1;else->{val tasks=(wrong["signingRequests"] as List<*>).map{map(it)}.toMutableList();tasks[0]=tasks[0]+mapOf("digest" to "00".repeat(32));wrong["signingRequests"]=tasks}}
    wrong["continuation"]=c;rejects{h.custody.advance("view",h.scope,"op",receipt,wrong)}
   }
   h.custody.advance("view",h.scope,"op",receipt,p);rejects{h.custody.advance("view",h.scope,"op",receipt,p)}}
  for(task in (stage["tasks"] as List<*>).map{map(it)}){
   var result:Result<Map<String,Any?>>?=null
   h.custody.sign("view",h.scope,"op",receipt,task){result=it}
   yes(PermissionJson.canonical(result!!.getOrThrow())==PermissionJson.canonical(h.signatures.single{it["taskId"]==task["taskId"]}))
  }
 }
 h.custody.close("view",h.scope,"op")
 yes(h.custody.mayDeliverSignature("view",h.scope,"op")&&h.ui.shown==2&&h.signer.used==h.allTasks.size&&h.store.writes==1)
 if((mint||amm||pool)&&stages.size>1){val x=CustodyHarness(sample);val r=x.ready();x.signFirst(r);x.custody.close("view",x.scope,"op")
  yes(!x.custody.mayDeliverSignature("view",x.scope,"op"));rejects{x.custody.advance("view",x.scope,"op",r,x.pending(r))}}
 if((stages.size==3&&!pool)||(pool&&(map(h.audit["preview"])["warnings"] as List<*>).isNotEmpty()))for(mutation in listOf("warning","role")){
  val a=map(sample["audit"]);val plan=map(a["plan"]);val p=map(plan["payload"]);val preview=map(a["preview"])
  val changedPreview=if(mutation=="warning")preview+mapOf("warnings" to listOf("MULTI_TRANSACTION","UNKNOWN")) else preview
  val changedPayload=if(mutation=="role")p+mapOf("transactions" to (p["transactions"] as List<*>).mapIndexed{i,t->if(i==0)map(t)+mapOf("role" to "primary")else t})else p
  val payload=changedPayload+mapOf("preview" to changedPreview);val changedPlan=plan+mapOf("payload" to payload,"planHash" to hash(payload))
  val binding=map(a["binding"]);val b=map(binding["payload"])+mapOf("operationHash" to changedPlan["planHash"])
  val bad=sample+mapOf("audit" to (a+mapOf("preview" to changedPreview,"plan" to changedPlan,"binding" to (binding+mapOf("payload" to b,"bindingHash" to hash(b))))))
  val x=CustodyHarness(bad);x.grant();x.begin();x.consent();x.ui.choose("op");rejects{x.material()};yes(x.signer.used==0)
 }
}

private fun stagedCheck(sample:Map<String,Any?>){
 val h=CustodyHarness(sample);val receipt=h.ready();val pending=h.pending(receipt)
 rejects{h.custody.advance("view",h.scope,"op",receipt,pending)}
 h.signFirst(receipt)
 for(mutation in listOf("planHash","approvalId","stage","session","taskDigest","taskId","family")){
  val p=copy(pending).toMutableMap();val c=map(p["continuation"]).toMutableMap()
  when(mutation){
   "planHash","approvalId"->c[mutation]="wrong"
   "stage"->c["stage"]=2
   "session"->c["sessionId"]="00".repeat(32)
   "family"->c["family"]="unknown"
   else->{val t=(p["signingRequests"] as List<*>).map{map(it)}.toMutableList();t[0]=t[0]+mapOf((if(mutation=="taskDigest")"digest" else "taskId") to "00".repeat(32));p["signingRequests"]=t}
  };p["continuation"]=c
  rejects{h.custody.advance("view",h.scope,"op",receipt,p)}
 }
 h.custody.advance("view",h.scope,"op",receipt,pending)
 rejects{h.custody.advance("view",h.scope,"op",receipt,pending)}
 for(task in (pending["signingRequests"] as List<*>).map{map(it)}){
  var result:Result<Map<String,Any?>>?=null
  h.custody.sign("view",h.scope,"op",receipt,task){result=it}
  yes(PermissionJson.canonical(result!!.getOrThrow())==PermissionJson.canonical(h.signatures.single{it["taskId"]==task["taskId"]}))
  rejects{h.custody.sign("view",h.scope,"op",receipt,task){error("REPLAY")}}
 }
 rejects{h.custody.advance("view",h.scope,"op",receipt,pending)}
 val stages=h.audit["stages"] as List<*>
 for(index in 2 until stages.size){
  val next=h.pending(receipt,index-1)
  h.custody.advance("view",h.scope,"op",receipt,next)
  for(task in (next["signingRequests"] as List<*>).map{map(it)}){
   var result:Result<Map<String,Any?>>?=null
   h.custody.sign("view",h.scope,"op",receipt,task){result=it}
   yes(PermissionJson.canonical(result!!.getOrThrow())==PermissionJson.canonical(h.signatures.single{it["taskId"]==task["taskId"]}))
   rejects{h.custody.sign("view",h.scope,"op",receipt,task){error("REPLAY")}}
  }
  rejects{h.custody.advance("view",h.scope,"op",receipt,next)}
 }
 h.custody.close("view",h.scope,"op")
 yes(h.custody.mayDeliverSignature("view",h.scope,"op")&&h.ui.shown==2&&h.signer.used==h.signatures.size&&h.store.writes==1)
 for(cancelled in listOf(false,true)){
  val x=CustodyHarness(sample);val r=x.ready();x.signFirst(r)
  if(cancelled)x.custody.cancel("view",x.scope,"op") else x.custody.close("view",x.scope,"op")
  yes(!x.custody.mayDeliverSignature("view",x.scope,"op"))
  rejects{x.custody.advance("view",x.scope,"op",r,x.pending(r))};yes(x.signer.used==x.tasks.size)
 }
}

private fun ammFeeReview(sample:Map<String,Any?>,rows:List<Map<String,Any?>>){
 for(row in rows){
  val request=map(sample["request"]);val intent=map(request["intent"])+mapOf("lpPlan" to row["lpPlan"],"serviceFeeRate" to row["totalFeeBps"])
  val h=CustodyHarness(sample+mapOf("request" to (request+mapOf("intent" to intent))));h.grant();h.begin();h.consent()
  val text=h.ui.reviews.getValue("op").description;val total=(row["totalFeeBps"] as Number).toInt();val lp=(row["lpFeeBps"] as Number).toInt()
  yes(text.contains("total $total bps; LP $lp bps; service ${total-lp} bps"))
  yes(text.contains(row["serviceFeeAddress"] as String)&&h.signer.used==0)
  h.custody.cancel("view",h.scope,"op");yes(h.ui.pending.isEmpty())
 }
}
private fun explicitAmmFeeReview(sample:Map<String,Any?>){
 val intent=map(map(sample["request"])["intent"]);val fees=map(intent["feePolicy"])
 val h=CustodyHarness(sample);h.grant();h.begin();h.consent();val text=h.ui.reviews.getValue("op").description
 val fields=listOf("lpFeeRate","taxFeeRate","serviceProviderFeeRate","protocolFeeRate");val labels=listOf("LP","tax","service provider","protocol")
 val rates=fields.map{(fees[it] as Number).toInt()};val total=rates.sum()
 labels.forEachIndexed{index,label->yes(text.contains("$label ${rates[index]} bps"))}
 yes(text.contains("Total $total bps")&&text.contains("Combined non-LP ${total-rates[0]} bps")&&text.contains(fees["feeAddress"] as String))
 yes(h.signer.used==0);h.custody.cancel("view",h.scope,"op")
 for(mutation in listOf("negative","fraction","total","address","missing","lpPlan")){
  val i=intent.toMutableMap();val f=fees.toMutableMap()
  when(mutation){
   "negative"->f["lpFeeRate"] = -1
   "fraction"->f["lpFeeRate"]=0.5
   "total"->{f["lpFeeRate"]=9999;f["taxFeeRate"]=1}
   "address"->f["feeAddress"]="invalid"
   "missing"->f.remove("protocolFeeRate")
   else->i["lpPlan"]=6
  }
  i["feePolicy"]=f
  val x=CustodyHarness(sample+mapOf("request" to (map(sample["request"])+mapOf("intent" to i))))
  x.grant();x.begin();rejects{x.consent()};yes(x.signer.used==0&&x.ui.pending.isEmpty())
 }
}
private fun hostCheck(sample:Map<String,Any?>){
 val h=CustodyHarness(sample);val changed=mutableListOf<String>()
 val host=NativeWalletHost(h.custody){owner,_,_->changed.add(owner)}
 host.navigation("view",h.scope)
 val other=h.scope+mapOf("webViewInstanceId" to "other","sessionId" to "other-session","navigationId" to "other-nav")
 h.current["other"]=other;host.navigation("other",other)
 fun base()=mapOf("ownerId" to "view","scope" to h.scope)
 fun call(method:String,fields:Map<String,Any?> = emptyMap()):Map<String,Any?>{
  var reply:Map<String,Any?>?=null;host.dispatch(method,base()+fields){reply=it};return reply?:error("UNEXPECTED_ASYNC")
 }
 fun frame(type:String,extra:Map<String,Any?>)=PermissionJson.canonical(mapOf("channel" to "tws-webview/1","type" to type,"sessionId" to h.scope["sessionId"],"navigationId" to h.scope["navigationId"],"messageId" to "native-check")+extra)
 fun delivery(id:String,value:Any?):String{
  val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to id,"result" to value),"events" to emptyList<Any>())
  return frame("delivery",payload+mapOf("deliveryId" to hash(payload)))
 }
 fun prepare(method:String,id:String,text:String)=call("delivery.prepare",mapOf("method" to method,"requestId" to id,"serialized" to text))
 fun allow(text:String)=host.allowDelivery("view",h.scope,text)
 fun op(id:String)=PermissionJson.id("P4/rpc",h.scope.getValue("sessionId"),PermissionJson.canonical(id))
 yes(call("delivery.acknowledge",mapOf("requestId" to "never-prepared"))["ok"]==false)
 for(i in 0..300){
  val id="ack-read-$i";val text=delivery(id,h.account.chainId)
  yes(prepare("tbc_chainId",id,text)["ok"]==true&&allow(text))
  yes(call("delivery.acknowledge",mapOf("requestId" to id))["ok"]==true)
  yes(!allow(text))
 }
 val initial=frame("initialize",mapOf("origin" to h.scope["origin"],"chainId" to h.account.chainId));yes(allow(initial))
 yes(!allow(frame("initialize",mapOf("origin" to "https://forged.invalid","chainId" to h.account.chainId))))
 val empty=delivery("empty",emptyList<String>());yes(prepare("tbc_accounts","empty",empty)["ok"]==true&&allow(empty))
 for((id,message,events) in listOf(Triple("chain-error","Unsupported chain",emptyList<Any>()),Triple("bad-chain-error","internal detail",emptyList<Any>()),Triple("chain-error-event","Unsupported chain",listOf(mapOf("name" to "chainChanged","payload" to "tbc:mainnet"))))){
  val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to id,"error" to mapOf("code" to 4901,"message" to message)),"events" to events)
  val text=frame("delivery",payload+mapOf("deliveryId" to hash(payload)));val accepted=id=="chain-error"
  yes((prepare("tbc_switchChain",id,text)["ok"]==true)==accepted&&allow(text)==accepted)
 }
 val forged=delivery("forged",listOf(h.account.address));yes(prepare("tbc_accounts","forged",forged)["ok"]==false&&!allow(forged))
 val unknown=call("signing.unknown");yes(unknown==mapOf("ok" to false,"code" to "NATIVE_DENIED")&&h.store.writes==0)
 var grant:Map<String,Any?>?=null;val grantOp=op("grant")
 host.dispatch("permissions.request",base()+mapOf("operation" to grantOp,"providerMethod" to "tbc_requestAccounts","permissions" to mapOf("tbc_accounts" to mapOf("chains" to listOf(h.account.chainId),"maxAccounts" to h.accounts.signingAccounts.size),NativePrepared.permission(h.method) to mapOf("chains" to listOf(h.account.chainId))))){grant=it}
 yes(grant==null);h.ui.choose(grantOp);yes(grant!!["ok"]==true&&changed==listOf("other"))
 val connected=delivery("grant",h.accounts.signingAccounts.map{it.address});yes(prepare("tbc_requestAccounts","grant",connected)["ok"]==true&&allow(connected))
 yes(!allow(empty));val badGrant=delivery("invented",listOf(h.account.address));yes(prepare("tbc_requestAccounts","invented",badGrant)["ok"]==false)
 val metadata=delivery("metadata",h.account.identity()+mapOf("features" to listOf("tbc:provider")))
 yes(prepare("tbc_getAccount","metadata",metadata)["ok"]==false)
 val event=frame("event",mapOf("event" to mapOf("name" to "accountsChanged","payload" to h.accounts.signingAccounts.map{it.address})))
 yes(allow(event));yes(!allow(frame("event",mapOf("event" to mapOf("name" to "accountsChanged","payload" to listOf("forged"))))))
 val signed=delivery("signed",sample["result"]);yes(prepare(h.method,"signed",signed)["ok"]==false)
 val operation=op("signed");val before=h.store.writes
 yes(call("signing.begin",mapOf("operation" to operation,"method" to h.method,"revision" to h.custody.snapshot("view",h.scope).revision,"account" to h.account.identity()))["ok"]==true)
 if(h.request["signingRoles"]!=null){
  yes(call("signing.roles",mapOf("operation" to operation,"request" to h.request,"context" to h.context,"account" to h.account.identity()))["ok"]==false)
  val resolved=call("signing.roles",mapOf("operation" to operation,"request" to h.request,"context" to h.context))
  yes(resolved["ok"]==true&&PermissionJson.canonical(resolved["value"])==PermissionJson.canonical(h.accounts.additional.map{it.identity()}))
 }
 var consent:Map<String,Any?>?=null
 host.dispatch("signing.consent",base()+mapOf("operation" to operation,"method" to h.method,"request" to h.request,"context" to h.context)){consent=it}
 yes(consent==null);h.ui.choose(operation);yes(consent!!["value"]==true)
 val receipt=h.material(operation)
 for(task in h.tasks)yes(call("signing.sign",mapOf("operation" to operation,"receipt" to receipt,"task" to task))["ok"]==true)
 for(index in 0 until (((h.audit["stages"] as? List<*>)?.size?:1)-1)){
  val pending=h.pending(receipt,index)
  yes(call("signing.advance",mapOf("operation" to operation,"receipt" to receipt,"pending" to pending))["value"]==true)
  for(task in (pending["signingRequests"] as List<*>).map{map(it)})yes(call("signing.sign",mapOf("operation" to operation,"receipt" to receipt,"task" to task))["ok"]==true)
 }
 yes(call("signing.close",mapOf("operation" to operation))["ok"]==true)
 yes(prepare(h.method,"signed",signed)["ok"]==true&&allow(signed))
 yes(h.store.writes==before&&h.ui.shown==2)
 yes(call("operation.cancel",mapOf("operation" to operation))["ok"]==true&&!allow(signed))
 if(h.accounts.additional.isNotEmpty()){
  val role=h.accounts.additional.single()
  val roleMetadata=delivery("role-metadata",role.identity()+mapOf("features" to listOf("tbc:provider")))
  yes(prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"]==false)
  val metadataOp=op("metadata-grant");var metadataGrant:Map<String,Any?>?=null
  host.dispatch("permissions.request",base()+mapOf("operation" to metadataOp,"providerMethod" to "wallet_requestPermissions","permissions" to mapOf("tbc_accountMetadata" to mapOf("chains" to listOf(h.account.chainId))))){metadataGrant=it}
  yes(metadataGrant==null);h.ui.choose(metadataOp);yes(metadataGrant!!["ok"]==true)
  yes(prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"]==true&&allow(roleMetadata))
  val wrong=delivery("wrong-key",role.identity()+mapOf("publicKey" to h.account.publicKey,"features" to listOf("tbc:provider")))
  yes(prepare("tbc_getAccount","wrong-key",wrong)["ok"]==false&&!allow(wrong))
  yes((map(call("snapshot")["value"])["connectedAccounts"] as List<*>).size==2)
  h.accounts.additional=emptyList();h.accounts.revision++;host.accountChanged()
  yes(!allow(roleMetadata)&&prepare("tbc_getAccount","role-metadata",roleMetadata)["ok"]==false)
 }
 h.accounts.unlocked=false;host.accountChanged();yes(!allow(connected)&&!allow(event))
 val locked=delivery("locked",emptyList<Any>());yes(prepare("wallet_getPermissions","locked",locked)["ok"]==true&&allow(locked))
 yes(allow(frame("event",mapOf("event" to mapOf("name" to "accountsChanged","payload" to emptyList<Any>())))))
 host.invalidate("view");yes(!allow(initial)&&!allow(locked))
}

@Suppress("UNCHECKED_CAST")
fun main(args:Array<String>){
 val replay=PermissionJson.decode(JSONObject(File(args[0]).readText())) as Map<String,Any?>
 if(args.getOrNull(1)=="legacy-message"){
  for(sample in (replay["singles"] as List<*>).map{map(it)}){
   val h=CustodyHarness(sample,NativeWalletProtocol.LEGACY);val receipt=h.ready();h.signFirst(receipt)
   yes(h.ui.shown==2&&h.signer.used==1&&h.store.writes==1)
   yes(PermissionJson.canonical(NativeSigningEnvelope.result(map(h.audit["envelope"]),h.tasks.single(),h.signatures.single(),h.account,NativeWalletProtocol.LEGACY))==PermissionJson.canonical(sample["result"]))
   rejects{h.signFirst(receipt)};h.custody.close("view",h.scope,"op");yes(h.custody.mayDeliverSignature("view",h.scope,"op"))
   val wrong=CustodyHarness(sample);rejects{wrong.ready()};yes(wrong.signer.calls==0)
   // Rehashed worker material cannot substitute a different digest or framing.
   val changed=copy(sample).toMutableMap();val audit=map(changed["audit"]).toMutableMap();val binding=map(audit["binding"]).toMutableMap();val payload=map(binding["payload"])+mapOf("operationHash" to "00".repeat(32));binding["payload"]=payload;binding["bindingHash"]=hash(payload)
   audit["binding"]=binding;audit["preview"]=map(audit["preview"])+mapOf("digest" to "00".repeat(32));changed["audit"]=audit
   val forged=CustodyHarness(changed,NativeWalletProtocol.LEGACY);rejects{forged.ready()};yes(forged.signer.calls==0)
  }
  for(s in (replay["workflows"] as List<*>).map{map(it)}){
   val a=map(s["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
   fun bind(protocol:NativeWalletProtocol)=NativeWorkflow.bind(s["method"] as String,map(s["request"]),map(s["context"]),a,emptyList(),map(s["plan"]),map(s["preview"]),map(s["binding"]),emptyMap(),Instant.parse(s["now"] as String),protocol)
   yes(PermissionJson.canonical(bind(NativeWalletProtocol.LEGACY).plan)==PermissionJson.canonical(s["plan"]))
   rejects{bind(NativeWalletProtocol.STANDARD)}
   for(d in (map(s["expected"])["deferred"] as List<*>).map{map(it)}){
    val resolved=map(d["resolved"]);val sourceId=map(resolved["source"])["stepId"] as String
    val descriptor=(map(map(s["plan"])["payload"])["deferredSigningTasks"] as List<*>).map{map(it)}.single{it["targetStepId"]==d["stepId"]}
    val completed=mapOf(sourceId to map(d["sourceBundle"]))
    val pair=NativeWorkflow.resolve(descriptor,resolved,completed,a,map(s["context"])["origin"] as String,NativeWalletProtocol.LEGACY)
    yes(PermissionJson.canonical(pair.second)==PermissionJson.canonical(resolved["concreteTask"]))
    rejects{NativeWorkflow.resolve(descriptor,resolved,completed,a,map(s["context"])["origin"] as String)}
    rejects{NativeWorkflow.resolve(descriptor,resolved,emptyMap(),a,map(s["context"])["origin"] as String,NativeWalletProtocol.LEGACY)}
   }
  }
  println("{\"platform\":\"kotlin-jvm\",\"status\":\"PASS\",\"checks\":$custodyChecks,\"legacyMessages\":4,\"legacyWorkflows\":2,\"deviceAcceptance\":false}");return
 }
 if(args.getOrNull(1)=="contract173"){
  val samples=(replay["cases"] as List<*>).map{map(it).let{s->s+mapOf("additionalAccounts" to s["signingAccounts"])}}
  samples.forEach{creationCheck(it);if(it["kind"]=="create")explicitAmmFeeReview(it)}
  println("{\"platform\":\"kotlin-jvm\",\"checks\":$custodyChecks,\"cases\":${samples.size},\"status\":\"PASS\",\"deviceAcceptance\":false}");return
 }
 if(args.getOrNull(1)=="prepared"){
  val samples=(replay["cases"] as List<*>).map{map(it)};preparedCheck(samples)
  val before=custodyChecks;hostCheck(samples[0]);hostCheck(samples.single{it["name"]=="amm-controller-plain-add"});val hostChecks=custodyChecks-before
  println("{\"platform\":\"kotlin-jvm\",\"checks\":$custodyChecks,\"hostChecks\":$hostChecks,\"status\":\"PASS\",\"deviceAcceptance\":false}");return
 }
 if(args.getOrNull(1) in setOf("creation","mint","amm","pool-dependent")){
  val samples=(replay["cases"] as List<*>).map{map(it)};samples.forEach{creationCheck(it)}
  if(args[1]=="amm"){val fees=map(PermissionJson.decode(JSONObject(File(args[2]).readText())));ammFeeReview(samples[0],(fees["presets"] as List<*>).map{map(it)})}
  val before=custodyChecks;hostCheck(samples[1]);hostCheck(samples[if(args[1]=="creation")4 else 0]);val hostChecks=custodyChecks-before
  println("{\"platform\":\"kotlin-jvm\",\"checks\":$custodyChecks,\"hostChecks\":$hostChecks,\"status\":\"PASS\",\"deviceAcceptance\":false}");return
 }
 if(args.getOrNull(1)=="staged"){
  val samples=(replay["cases"] as List<*>).map{map(it)};samples.forEach{stagedCheck(it)}
  val before=custodyChecks;hostCheck(samples[0]);val hostChecks=custodyChecks-before
  println("{\"platform\":\"kotlin-jvm\",\"checks\":$custodyChecks,\"hostChecks\":$hostChecks,\"status\":\"PASS\",\"deviceAcceptance\":false}");return
 }
 val controllerMode=args.getOrNull(1) in setOf("controller","controller-extended")
 val nativeMode=args.getOrNull(1) in setOf("native","controller","controller-extended","typed")
 val samples=(replay["cases"] as List<*>).map{map(it)}.filter{nativeMode||(it["name"] as String).startsWith("android-")}
 if(controllerMode)controllerNegativeCheck(samples[0])
 if(args.getOrNull(1)=="typed")typedNegativeCheck(samples[0],(replay["invalid"] as List<*>).map{map(it)})
 for(sample in samples){
  if(controllerMode&&(map(sample["audit"])["stages"] as List<*>).size>1){creationCheck(sample);continue}
  val h=CustodyHarness(sample);h.grant();h.begin();h.consent();h.ui.choose("op")
  if(controllerMode){
   val controller=h.accounts.additional.single();val description=h.ui.reviews.getValue("op").description
   yes(h.ui.reviews.getValue("grant").description.contains(controller.address))
   yes(description.contains("Asset/fee account: ${h.account.address}")&&description.contains("Pool controller: ${controller.address} (pool-controller)"))
  }
  val intent=h.request["intent"]?.let{map(it)}?:emptyMap()
  val profile=intent["type"] as? String ?: ""
  if(profile.startsWith("tbc-lop-")){
   val text=h.ui.reviews.getValue("op").description
   yes(text.contains(h.account.address)&&text.contains("no broadcast"))
   if(profile=="tbc-lop-create"){
    val o=map(intent["order"])
    for(f in listOf("side","market","saleVolume","unitPrice","feeRate","feeRecipient"))yes(text.contains(o[f] as String))
    for(a in listOfNotNull(map(o["assetA"]),o["assetB"]?.let{map(it)}))yes(text.contains(a["contractId"] as String)&&text.contains(a["standard"] as String))
    yes(text.contains("1000000")&&text.contains("partially fill")&&text.contains("Only the owner"))
    if(o["side"]!="sell"||o["market"]!="native-token")yes(text.contains("300 order atomic")&&text.contains("500 per token holding"))
   }else{
    for(v in intent["targetOutpoints"] as List<*>){val p=map(v);yes(text.contains("${p["txid"]}:${p["vout"]}"))}
    yes(text.contains("No other orders are swept")&&text.contains("paired asset availability"))
    yes(text.contains(if(profile=="tbc-lop-cancel")"same owner" else "cannot be overridden"))
   }
  }
  if(profile in setOf("tbc-htlc-lock","tbc-htlc-claim","tbc-htlc-refund")){
   val text=h.ui.reviews.getValue("op").description
   yes(text.contains(h.account.address)&&text.contains("no broadcast"))
   (intent["assetStandard"] as? String)?.let{yes(text.contains(it)&&text.contains(intent["contractId"] as String))}
   if(profile=="tbc-htlc-lock"){
    for(field in listOf("amount","to","hashlock","lockTime"))yes(text.contains(intent[field] as String))
    val height=(intent["lockTime"] as String).toLong()<500000000
    yes(text.contains(if(height)"block height (inclusive)" else "chain median time (strictly greater, not local time)"))
    yes(text.contains("remains possible after this threshold"))
   }else{
    val points=(if(intent["assetStandard"]!=null)intent["targetOutpoints"] else map(h.request["constraints"])["inputOutpoints"]) as List<*>
    for(value in points){val p=map(value);yes(text.contains("${p["txid"]}:${p["vout"]}"))}
    if(intent["assetStandard"]!=null)yes(text.contains("paired native escrow")&&text.contains("Full balance"))
    yes(text.contains("No other deposits are swept"))
    if(profile=="tbc-htlc-claim")yes(text.contains("before broadcast")&&text.contains("reveals the preimage")&&!text.contains(intent["preimage"] as String))
    else yes(text.contains("sender role")&&text.contains("local time is not authority"))
   }
  }
  if(profile in setOf("tbc-timelock-lock","tbc-timelock-unlock")){
   val text=h.ui.reviews.getValue("op").description
   yes(text.contains(h.account.address)&&text.contains("no broadcast"))
   if(profile=="tbc-timelock-lock")yes(text.contains(intent["amount"] as String)&&text.contains(intent["lockTime"] as String)&&text.contains("not a timestamp"))
   else{
    for(value in map(h.request["constraints"])["inputOutpoints"] as List<*>){val p=map(value);yes(text.contains("${p["txid"]}:${p["vout"]}"))}
    yes(text.contains("No other deposits are swept")&&text.contains("maturity"))
   }
  }
  if(profile.startsWith("amm.")||profile.startsWith("tbc20Lp.")){
   val description=h.ui.reviews.getValue("op").description
   yes(description.contains(intent["poolContractId"] as String)&&description.contains("no broadcast"))
   for(field in listOf("amount","lpAmount","minimumOutput","minimumLpAmount","minimumTbcAmount","minimumFtAmount","initialFtAmount","maximumFtAmount","maximumTbcAmount","lockTime","to","receiver")){
    (intent[field] as? String)?.let{yes(description.contains(it))}
   }
   if(profile=="amm.mergeToken")yes(description.contains("up to four")&&description.contains("tokens stay in this pool"))
   if(profile=="tbc20Lp.burn")yes(description.contains("Permanently destroy")&&description.contains("no TBC or FT reserves are returned")&&description.contains(h.account.address))
   if(profile in setOf("tbc20Lp.merge","tbc20Lp.lock","tbc20Lp.unlock"))yes(description.contains("maturity")&&description.contains(h.account.address))
  }
  if((intent["type"] as? String)?.startsWith("tbc.pool.")==true){
   val description=h.ui.reviews.getValue("op").description
   yes(description.contains("Existing Pool2")&&description.contains(intent["poolContractId"] as String))
   for(field in listOf("tbcAmount","ftAmount","lpAmount","minimumFtAmount","minimumTbcAmount","minimumLpAmount","receiver")){
    (intent[field] as? String)?.let{yes(description.contains(it))}
   }
   yes(description.contains(map(h.request["constraints"])["expiresAt"] as String))
   yes(description.contains("authenticated Pool fees")&&description.contains("no broadcast"))
   if(intent["type"]=="tbc.pool.liquidity.add")yes(description.contains("proportional pooled FT"))
   if(intent["type"]=="tbc.pool.ft.merge")yes(description.contains("up to four")&&description.contains("tokens stay in this pool"))
   if(intent["type"]=="tbc.pool.ftlp.merge")yes(description.contains("up to five mature")&&description.contains(h.account.address))
   if(intent["type"]=="tbc.pool.ftlp.burn")yes(description.contains("Permanently destroy")&&description.contains("no TBC or FT reserves are returned")&&description.contains(h.account.address))
  }
  if(intent["type"] in setOf("tbc20-lp-transfer","tbc20-lp-merge","tbc20-lp-lock","tbc20-lp-unlock")){
   val description=h.ui.reviews.getValue("op").description
   yes(description.contains(intent["poolContractId"] as String)&&description.contains("maturity")&&description.contains("no broadcast"))
   for(field in listOf("amount","to","lockTime")){(intent[field] as? String)?.let{yes(description.contains(it))}}
   if(intent["type"]!="tbc20-lp-transfer")yes(description.contains(h.account.address))
   if(intent["type"]=="tbc20-lp-lock")yes(description.contains("block height"))
  }
  if(intent["type"] in setOf("tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap")){
   val description=h.ui.reviews.getValue("op").description
   yes(description.contains(intent["poolContractId"] as String)&&description.contains(h.account.address))
   for(field in listOf("amount","lpAmount","minimumOutput","minimumLpAmount","minimumTbcAmount","minimumFtAmount","initialFtAmount","maximumFtAmount","maximumTbcAmount","lockTime")){
    (intent[field] as? String)?.let{yes(description.contains(it))}
   }
   yes(description.contains("authenticated Pool fees")&&description.contains("no broadcast"))
  }
  rejects{h.material(badBinding=true)};val receipt=h.material();val before=h.store.writes
  yes(h.ui.shown==2) // One connect grant, one operation approval (not two approvals).
  rejects{h.consent()}
  for(t in h.tasks){
   val altered=t+mapOf("digest" to "00".repeat(32));rejects{h.custody.sign("view",h.scope,"op",receipt,altered){error("UNREACHABLE")}}
   var signature:Map<String,Any?>?=null
   h.custody.sign("view",h.scope,"op",receipt,t){signature=it.getOrThrow()}
   yes(PermissionJson.canonical(signature)==PermissionJson.canonical(h.signatures.single{it["taskId"]==t["taskId"]}))
   rejects{h.custody.sign("view",h.scope,"op",receipt,t){error("UNREACHABLE")}}
  }
  h.custody.close("view",h.scope,"op");yes(h.custody.mayDeliverSignature("view",h.scope,"op"))
  rejects{h.custody.check("view",h.scope,"op")};yes(h.store.loads==1&&h.store.writes==before&&h.signer.used==h.tasks.size)
  h.custody.disconnect("view",h.scope,"disconnect");yes(!h.custody.mayDeliverSignature("view",h.scope,"op"))
 }
 val sample=samples.last()
 run{
  val h=CustodyHarness(sample);h.grant();h.custody.cancel("view",h.scope,"late-begin");rejects{h.begin("late-begin")}
  h.begin();var consent:Result<Boolean>?=null;h.consent{consent=it};val late=h.ui.pending["op"]!!
  h.custody.cancel("view",h.scope,"op");yes(consent?.isFailure==true&&h.ui.pending.isEmpty());late(true)
  rejects{h.material()};yes(h.signer.calls==0)
 }
 run{
  val h=CustodyHarness(sample);val receipt=h.ready();h.signer.hold=true;var value:Result<Map<String,Any?>>?=null
  h.custody.sign("view",h.scope,"op",receipt,h.tasks[0]){value=it};yes(value==null)
  h.accounts.revision++;h.custody.accountChanged();yes(value?.isFailure==true)
  h.signer.release!!();yes(h.signer.used==0&&!h.custody.mayDeliverSignature("view",h.scope,"op"))
 }
 run{
  val h=CustodyHarness(sample);val receipt=h.ready();h.signer.wrongLength=true;var value:Result<Map<String,Any?>>?=null
  h.custody.sign("view",h.scope,"op",receipt,h.tasks[0]){value=it};yes(value?.isFailure==true)
  h.custody.close("view",h.scope,"op");yes(!h.custody.mayDeliverSignature("view",h.scope,"op"))
 }
 run{
  val h=CustodyHarness(sample);h.grant();h.begin();var cancelled:Result<Boolean>?=null;h.consent{cancelled=it}
  val other=h.scope+mapOf("webViewInstanceId" to "other","sessionId" to "other-session","navigationId" to "other-nav")
  h.current["other"]=other;h.custody.navigation("other",other);h.begin("other-op","other",other)
  h.custody.invalidate("view");h.custody.check("other",other,"other-op")
  yes(h.accounts.unlocked&&h.signer.calls==0&&cancelled?.isFailure==true);rejects{h.custody.check("view",h.scope,"op")}
 }
 val beforeHost=custodyChecks;hostCheck(sample)
 if(args.getOrNull(1)=="controller-extended")hostCheck(samples.last())
 val hostChecks=custodyChecks-beforeHost
 println("{\"platform\":\"kotlin-jvm\",\"checks\":$custodyChecks,\"hostChecks\":$hostChecks,\"status\":\"PASS\",\"recordedSignatureReplay\":true,\"newSignatures\":0,\"deviceAcceptance\":false}")
}
