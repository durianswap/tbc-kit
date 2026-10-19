package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest

// Real native consent/receipt owner only; no signer or workflow delivery claim.
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private var checks=0
private fun yes(v:Boolean){check(v){"workflow consent check ${checks+1}"};checks++}
private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
private fun rejects(f:()->Unit){var bad=false;try{f()}catch(_:Exception){bad=true};yes(bad)}
private class Accounts(values:List<Map<String,Any?>>):NativeAccountSource{
 override val signingAccounts=values.map{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 override val current=signingAccounts.first();override var revision=0L;override var unlocked=true
}
private class Store:NativePermissionBackend{
 val values=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=values.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{fence();check((values[origin]?.revision?:0)==expected);val v=PermissionSnapshot(expected+1,records);values[origin]=v;writes++;return PermissionCommitResult(v.revision,v)}
}
private class UI:NativeApprovalPresenter{
 var shown=0;val reviews=mutableMapOf<String,NativeReview>();val pending=mutableMapOf<String,(Boolean)->Unit>()
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;reviews[review.operationId]=review;pending[review.operationId]=complete;return {pending.remove(review.operationId);Unit}}
 fun choose(id:String,yes:Boolean=true){pending.remove(id)!!(yes)}
}
private class NoKey:NativeDigestSigner,NativeReviewedComputer{
 var signs=0;var computes=0
 var recorded=emptyList<Map<String,Any?>>();var held:(()->Unit)?=null;var hold=false
 var failure:String?=null
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  signs++;val finish={complete(runCatching{
   // Deliberately omit the adapter fence for a late unavailable callback:
   // the custody owner must still prioritize lock/cancel over recovery.
   if(!(failure=="unavailable"&&hold))requireCurrent()
   if(failure=="unavailable")throw NativeSignerUnavailable()
   if(failure=="forged")throw NativeCustodyFailure("NATIVE_WORKFLOW_STEP_UNAVAILABLE")
   if(failure=="opaque")throw NativeCustodyFailure("TEST_PRIVATE_ERROR")
   val digestHex=digest.joinToString(""){"%02x".format(it)}
   val row=recorded.firstOrNull{val t=map(it["task"]);t["digest"]==digestHex&&t["signatureEncoding"]==encoding&&t["publicKey"]==account.publicKey&&t["accountId"]==account.accountId}?:throw NativeCustodyFailure("TEST_NO_KEY")
   val raw=map(row["result"])["signature"] as String;ByteArray(raw.length/2){raw.substring(it*2,it*2+2).toInt(16).toByte()}
  })}
  if(hold)held=finish else finish()
 }
 override fun call(method:String,input:String,complete:(Result<String>)->Unit){computes++;complete(Result.failure(NativeCustodyFailure("TEST_NO_COMPUTE")))}
}
private class Harness(val sample:Map<String,Any?>){
 val accounts=Accounts((sample["accounts"] as List<*>).map{map(it)});val store=Store();val ui=UI();val key=NoKey()
 val context=map(sample["context"]);val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "workflow-consent","committedUrl" to "${context["origin"]}/dapp")
 val c=NativeCustody(accounts,accounts.current.chainId,store,ui,key,key){owner,value->owner=="v"&&value==scope}
 val request=map(sample["request"]).toMutableMap();var answer:Result<Boolean>?=null
 val method get()=sample["method"] as String
 init{c.navigation("v",scope)}
 fun grant(omitting:String?=null,maxAccounts:Int?=null){
  val chain=accounts.current.chainId;val r=mutableMapOf<String,Any?>("tbc_accounts" to mapOf("chains" to listOf(chain),"maxAccounts" to (maxAccounts?:accounts.signingAccounts.size)))
  for(method in listOf("tbc_signWorkflow","tbc_signTransaction","tbc_signMessage","tbc_signTypedData"))if(method!=omitting)r[method]=mapOf("chains" to listOf(chain))
  var result:Result<List<Map<String,Any?>>>?=null;c.requestPermissions("v",scope,"grant",r){result=it};ui.choose("grant");result!!.getOrThrow()
 }
 fun begin(){c.begin("v",scope,"op",method,c.snapshot("v",scope).revision,accounts.current)}
 fun consent(review:Map<String,Any?>?=null){c.consentReviewed("v",scope,"op",method,request,context,review?:sample["consentReview"]?.let{map(it)}){answer=it}}
 fun bind():Map<String,Any?>{var reply:Result<Map<String,Any?>>?=null;c.bindWorkflow("v",scope,"op",map(sample["binding"]),map(sample["preview"]),map(sample["plan"])){reply=it};return reply!!.getOrThrow()}
 fun noAuthority(){
  rejects{c.bind("v",scope,"op",emptyMap(),emptyMap(),null,null)}
  rejects{c.sign("v",scope,"op",emptyMap(),emptyMap()){}}
  c.close("v",scope,"op");yes(!c.mayDeliverSignature("v",scope,"op"));yes(key.signs==0&&key.computes==0&&store.writes==1)
 }
 fun enter(receipt:Map<String,Any?>,entry:Map<String,Any?>){c.enterWorkflowStep("v",scope,"op",receipt,entry)}
 fun sign(receipt:Map<String,Any?>,task:Map<String,Any?>):Map<String,Any?>{var result:Result<Map<String,Any?>>?=null;c.sign("v",scope,"op",receipt,task){result=it};return result!!.getOrThrow()}
 fun finish(receipt:Map<String,Any?>,outcome:Map<String,Any?>){var result:Result<Boolean>?=null;c.finishWorkflowStep("v",scope,"op",receipt,outcome){result=it};yes(result!!.getOrThrow())}
}
fun main(args:Array<String>){
 val root=PermissionJson.records("[${File(args[0]).readText()}]").single();val cases=(root["cases"] as List<*>).map{map(it)}
 for(sample in cases){
  val h=Harness(sample);h.grant();h.begin()
  if(h.accounts.signingAccounts.size>1){val resolved=h.c.resolveSigningAccounts("v",h.scope,"op",h.request,h.context);yes(resolved.size==h.accounts.signingAccounts.size-1)}
  h.consent();yes(h.ui.shown==2&&h.answer==null&&h.store.writes==1)
  val text=h.ui.reviews.getValue("op").description
  for(value in h.request["steps"] as List<*>){val step=map(value);yes(text.contains(step["id"] as String));((step["intent"] as? Map<*,*>)?.get("preimage") as? String)?.let{yes(!text.contains(it))}}
  (sample["mustNotRender"] as? String)?.let{yes(!text.contains(it))}
  h.ui.choose("op");yes(h.answer!!.getOrThrow());rejects{h.consent()};h.noAuthority()
 }
 val sample=cases.first{it["name"]=="native-message"}
 run{val h=Harness(sample);h.grant("tbc_signMessage");h.begin();rejects{h.consent()};yes(h.ui.shown==1&&h.key.signs==0)}
 run{val h=Harness(sample);h.grant("tbc_signWorkflow");rejects{h.begin()};yes(h.ui.shown==1)}
 run{val h=Harness(sample);h.grant();h.begin();h.consent();h.ui.choose("op",false);yes(!h.answer!!.getOrThrow());h.noAuthority()}
 run{val h=Harness(sample);h.grant();h.begin();h.consent();h.accounts.unlocked=false;h.ui.choose("op");rejects{h.answer!!.getOrThrow()};yes(h.key.signs==0)}
 run{val h=Harness(sample);h.grant();h.begin();h.consent();h.c.invalidate("v");rejects{h.answer!!.getOrThrow()};yes(h.ui.pending.isEmpty()&&h.key.signs==0)}
 run{val h=Harness(sample);h.grant();h.begin();h.request["expiresAt"]="2020-01-01T00:00:00Z";rejects{h.consent()};yes(h.ui.shown==1)}
 run{val h=Harness(sample);h.grant();h.begin();h.request.remove("maxTotalFee");rejects{h.consent()};yes(h.ui.shown==1)}
 run{val h=Harness(sample);h.grant();h.begin();h.request.remove("maxTotalFee");h.consent(mapOf("kind" to "workflow","steps" to emptyList<Any>(),"prepared" to mapOf("workflowPlanHash" to "0".repeat(64),"totalFee" to "100000")));yes(h.ui.reviews.getValue("op").description.contains("Total fee at most 100000"));h.ui.choose("op");yes(h.answer!!.getOrThrow());h.noAuthority()}
 val roles=cases.first{it["name"]=="controller-message"}
 run{val h=Harness(roles);h.grant(maxAccounts=1);h.begin();rejects{h.consent()};yes(h.ui.shown==1)}
 run{val h=Harness(roles);h.grant();h.begin();h.c.resolveSigningAccounts("v",h.scope,"op",h.request,h.context);h.request["maxTotalFee"]="99";rejects{h.consent()};yes(h.ui.shown==1)}
 var receipts=0
 for(sample in cases.filter{it["plan"]!=null}){
  val h=Harness(sample);h.grant();h.begin();h.consent();h.ui.choose("op");yes(h.answer!!.getOrThrow())
  if(map(sample["reviews"]).isNotEmpty()){
   rejects{h.bind()};yes(h.key.computes==1&&h.key.signs==0);h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverSignature("v",h.scope,"op"));continue
  }
  val receipt=h.bind();receipts++
  yes(receipt["status"]=="approved"&&receipt["bindingHash"]==map(sample["binding"])["bindingHash"])
  yes(h.ui.shown==2&&h.key.signs==0&&h.key.computes==0&&h.store.writes==1)
  rejects{h.bind()}
  val first=map((map(map(sample["plan"])["payload"])["immediateSigningTasks"] as List<*>).first())
  rejects{h.c.sign("v",h.scope,"op",receipt,map(first["task"])) {}}
  h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverSignature("v",h.scope,"op"));yes(h.key.signs==0)
 }
 for(change in listOf("plan","fee","reject","locked")){
  val h=Harness(sample);h.grant();h.begin();val plan=map(sample["plan"]);val p=map(plan["payload"])
  h.consent(mapOf("kind" to "workflow","steps" to emptyList<Any>(),"prepared" to mapOf("workflowPlanHash" to if(change=="plan") "0".repeat(64) else plan["workflowPlanHash"],"totalFee" to if(change=="fee") "0" else p["totalFee"])))
  h.ui.choose("op",change!="reject");if(change=="locked")h.accounts.unlocked=false
  if(change=="fee")h.bind()else rejects{h.bind()}
  yes(h.key.signs==0&&h.ui.shown==2)
 }
 val variants=(root["receiptVariants"] as List<*>).map{map(it)}
 for(row in variants){
  val h=Harness(map(row["sample"]));h.grant();h.begin();h.consent();h.ui.choose("op");yes(h.answer!!.getOrThrow())
  if(row["accept"] as Boolean)h.bind()else rejects{h.bind()}
  yes(h.key.signs==0&&h.key.computes==0&&h.ui.shown==2&&h.store.writes==1)
  h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverSignature("v",h.scope,"op"))
 }
 // Public Engine-verified signatures are replayed, never generated or sent.
 val execution=(root["stepCases"] as List<*>).map{map(it)};var stepCount=0;var replays=0
 for(row in execution){
  val h=Harness(map(row["sample"]));h.key.recorded=(row["signed"] as List<*>).map{map(it)}
  h.grant();h.begin();h.consent();h.ui.choose("op");val receipt=h.bind();val plan=map(h.sample["plan"]);val payload=map(plan["payload"])
  for(source in (row["steps"] as List<*>).map{map(it)}){
   val id=source["id"] as String;val resolved=(row["deferred"] as List<*>).map{map(it)}.firstOrNull{it["stepId"]==id}?.let{map(it["resolved"])}
   val tasks=resolved?.let{listOf(map(it["concreteTask"]))}?:(payload["immediateSigningTasks"] as List<*>).map{map(it)}.filter{it["stepId"]==id}.map{map(it["task"])}
   val entry=mapOf("kind" to "workflow-step","stepId" to id,"workflowPlanHash" to plan["workflowPlanHash"],"tasks" to tasks)+(if(resolved!=null)mapOf("resolvedDeferredSigningTask" to resolved)else emptyMap())
   if(resolved!=null)rejects{h.enter(receipt,entry+("resolvedDeferredSigningTask" to (resolved+("sourceValue" to listOf("0".repeat(64))))))}
   rejects{h.sign(receipt,tasks[0])};rejects{h.enter(receipt,entry+("stepId" to "not-the-active-child"))}
   rejects{h.enter(receipt,entry+("tasks" to (listOf(tasks[0]+("digest" to "0".repeat(64)))+tasks.drop(1))))}
   rejects{h.enter(receipt+("approvalId" to "other-approval"),entry)};h.enter(receipt,entry);rejects{h.enter(receipt,entry)}
   val result=map(source["result"]).toMutableMap();if(result.containsKey("approvalId"))result["approvalId"]=receipt["approvalId"]
   val outcome=mapOf("kind" to "workflow-step-outcome","stepId" to id,"workflowPlanHash" to plan["workflowPlanHash"],"status" to "completed","result" to result)
   rejects{h.finish(receipt,outcome)}
   for(task in tasks){h.sign(receipt,task);rejects{h.sign(receipt,task)}}
   val badResult=if(result.containsKey("transactions")){val txs=(result["transactions"] as List<*>).map{map(it)};result+("transactions" to (listOf(txs[0]+("txid" to "0".repeat(64)))+txs.drop(1)))}else result+("digest" to "0".repeat(64))
   rejects{h.finish(receipt,outcome+("result" to badResult))};h.finish(receipt,outcome);rejects{h.finish(receipt,outcome)};stepCount++
  }
  yes(h.ui.shown==2&&h.store.writes==1&&h.key.computes==0);replays+=h.key.signs
  h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverSignature("v",h.scope,"op"))
  val delivered=map(row["result"]).toMutableMap();delivered["requestHash"]=payload["requestHash"];delivered["workflowPlanHash"]=plan["workflowPlanHash"];delivered["approvalId"]=receipt["approvalId"]
  delivered["steps"]=(delivered["steps"] as List<*>).map{val r=map(it);val result=map(r["result"]);r+("result" to (if(result.containsKey("approvalId"))result+("approvalId" to receipt["approvalId"])else result))}
  val resultHash=hash(delivered);yes(h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,resultHash))
  yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,"0".repeat(64)))
  yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",if(h.method=="tbc_signWorkflow") "tbc_signPreparedWorkflow" else "tbc_signWorkflow",resultHash))
  h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,resultHash));h.accounts.unlocked=true
  h.c.forgetResult("v",h.scope,"op");yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,resultHash))
 }
 val failureModes=listOf("continue","atomic","lock","cancel","opaque","forged")
 for(mode in failureModes){
  val row=execution.single{map(it["sample"])["name"]==if(mode=="atomic") "messages-no-chain" else "independent-failure-mode"};val h=Harness(map(row["sample"]))
  h.key.recorded=(row["signed"] as List<*>).map{map(it)};h.grant();h.begin();h.consent();h.ui.choose("op");val receipt=h.bind();val plan=map(h.sample["plan"]);val p=map(plan["payload"]);val steps=(h.request["steps"] as List<*>).map{map(it)};val first=steps[0]
  fun entry(step:Map<String,Any?>):Map<String,Any?> = mapOf("kind" to "workflow-step","stepId" to step["id"],"workflowPlanHash" to plan["workflowPlanHash"],"tasks" to (p["immediateSigningTasks"] as List<*>).map{map(it)}.filter{it["stepId"]==step["id"]}.map{map(it["task"])})
  val firstEntry=entry(first);val task=map((firstEntry["tasks"] as List<*>)[0]);h.enter(receipt,firstEntry)
  val failure=mapOf("kind" to "workflow-step-outcome","stepId" to first["id"],"workflowPlanHash" to plan["workflowPlanHash"],"status" to "failed","error" to mapOf("code" to "HOST_UNAVAILABLE","message" to "Workflow step failed: signer.sign"))
  rejects{h.finish(receipt,failure)}
  h.key.failure=if(mode in listOf("opaque","forged"))mode else "unavailable";h.key.hold=mode in listOf("lock","cancel")
  val host=NativeWalletHost(h.c){_,_,_->};var reply=emptyMap<String,Any?>()
  host.dispatch("signing.sign",mapOf("ownerId" to "v","scope" to h.scope,"operation" to "op","receipt" to receipt,"task" to task)){reply=it}
  if(h.key.hold){yes(reply.isEmpty());if(mode=="lock")h.accounts.unlocked=false else h.c.cancel("v",h.scope,"op");h.key.held!!()}
  yes(reply["ok"]==false&&reply["code"]==if(mode=="continue") "NATIVE_WORKFLOW_STEP_UNAVAILABLE" else "NATIVE_DENIED")
  rejects{h.sign(receipt,task)};yes(h.key.signs==1)
  if(mode=="continue"){
   rejects{h.finish(receipt,failure+("error" to mapOf("code" to "HOST_UNAVAILABLE","message" to "untrusted detail")))}
   h.finish(receipt,failure);rejects{h.finish(receipt,failure)};rejects{h.enter(receipt,entry(steps[1]))}
   h.key.failure=null;val third=steps[2];val thirdEntry=entry(third);h.enter(receipt,thirdEntry)
   for(t in thirdEntry["tasks"] as List<*>)h.sign(receipt,map(t))
   val finalStep=(row["steps"] as List<*>).map{map(it)}.single{it["id"]==third["id"]}
   h.finish(receipt,mapOf("kind" to "workflow-step-outcome","stepId" to third["id"],"workflowPlanHash" to plan["workflowPlanHash"],"status" to "completed","result" to finalStep["result"]))
   val result=map(row["result"]).toMutableMap();result["requestHash"]=p["requestHash"];result["workflowPlanHash"]=plan["workflowPlanHash"];result["approvalId"]=receipt["approvalId"]
   result["steps"]=listOf(mapOf("id" to first["id"],"kind" to first["kind"],"status" to "failed","error" to failure["error"]),mapOf("id" to steps[1]["id"],"kind" to steps[1]["kind"],"status" to "skipped","error" to mapOf("code" to "DEPENDENCY_FAILED","message" to "Workflow dependency failed")),finalStep)
   h.c.close("v",h.scope,"op");val digest=hash(result)
   yes(h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,digest));yes(!h.c.mayDeliverSignature("v",h.scope,"op"));yes(h.key.signs==2)
   result["steps"]=listOf(finalStep);yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,hash(result)))
   h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,digest))
  }else{rejects{h.finish(receipt,failure)};h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverWorkflowResult("v",h.scope,"op",h.method,"0".repeat(64)))}
  yes(h.ui.shown==2&&h.store.writes==1&&h.key.computes==0)
 }
 for(fence in listOf("lock","cancel")){
  val row=execution.first();val h=Harness(map(row["sample"]));h.key.recorded=(row["signed"] as List<*>).map{map(it)}
  h.grant();h.begin();h.consent();h.ui.choose("op");val receipt=h.bind();val plan=map(h.sample["plan"]);val p=map(plan["payload"]);val source=map((row["steps"] as List<*>)[0])
  val tasks=(p["immediateSigningTasks"] as List<*>).map{map(it)}.filter{it["stepId"]==source["id"]}.map{map(it["task"])}
  h.enter(receipt,mapOf("kind" to "workflow-step","stepId" to source["id"],"workflowPlanHash" to plan["workflowPlanHash"],"tasks" to tasks));h.key.hold=true
  var result:Result<Map<String,Any?>>?=null;h.c.sign("v",h.scope,"op",receipt,tasks[0]){result=it};yes(result==null)
  if(fence=="lock")h.accounts.unlocked=false else h.c.cancel("v",h.scope,"op")
  h.key.held!!();rejects{result!!.getOrThrow()};yes(h.key.signs==1);h.c.close("v",h.scope,"op");yes(!h.c.mayDeliverSignature("v",h.scope,"op"))
 }
 val jsonCases=(root["jsonCases"] as List<*>).map{map(it)}
 for(j in jsonCases){val input=j["input"] as String;val field=j["field"] as String;val ids=(j["txids"] as List<*>).map{it as String};val output=j["expected"] as String
  NativeWorkflowJSON.template(input,field);NativeWorkflowJSON.verify(input,field,ids,output);yes(true)
  rejects{NativeWorkflowJSON.verify(input,field,listOf("0".repeat(64)),output)}
  rejects{NativeWorkflowJSON.verify(input,field,ids,"{\"injected\":true,"+output.drop(1))}
 }
 for(input in listOf("[]","{\"txids\":1}","{\"__proto__\":{},\"txids\":[]}","{\"x\":01}","{\"x\":1.}","{\"x\":1e}","{\"x\":NaN}","{\"x\":\"\\q\"}","{\"x\":true,}","{\"x\":[1,]}","{}trailing"))rejects{NativeWorkflowJSON.template(input,"txids")}
 println("{\"status\":\"PASS\",\"cases\":${cases.size},\"receiptCases\":$receipts,\"receiptVariants\":${variants.size},\"stepCases\":${execution.size},\"completedSteps\":$stepCount,\"replayedSignatures\":$replays,\"jsonCases\":${jsonCases.size},\"failureCases\":${failureModes.size},\"checks\":$checks,\"signatures\":0,\"proof\":\"native-dependent-child-execution-and-result-permits\"}")
}
