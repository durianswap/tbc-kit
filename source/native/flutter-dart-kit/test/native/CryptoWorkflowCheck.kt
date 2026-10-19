package io.tbc.kit.dart
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONObject

@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray()).joinToString(""){"%02x".format(it.toInt()and 255)}
private var checks=0
private fun yes(value:Boolean){check(value){"crypto workflow check ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var bad=false;try{f()}catch(_:Exception){bad=true};yes(bad)}
private class Accounts(override val current:NativeAccount):NativeAccountSource{override var revision=0L;override var unlocked=true}
private class Store:NativePermissionBackend{
 val rows=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=rows.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();check((rows[origin]?.revision?:0)==expected);val s=PermissionSnapshot(expected+1,records);rows[origin]=s;writes++;return PermissionCommitResult(s.revision,s)
 }
}
private class UI:NativeApprovalPresenter{
 var shown=0;var pending:((Boolean)->Unit)?=null
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;pending=complete;return {pending=null}}
 fun choose(value:Boolean=true){val f=pending!!;pending=null;f(value)}
}
private class Key(val sample:Map<String,Any?>):NativeDigestSigner,NativeBie1Executor{
 var calls=0;var hold=false;var failure:String?=null;var afterUse:(()->Unit)?=null;var release:(()->Unit)?=null
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){error("crypto used digest signer")}
 override fun execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:ByteArray,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  val row=map((sample["crypto"] as List<*>)[calls++])
  val f={complete(runCatching{
   requireCurrent();val task=map(row["task"])
   check(account.accountId==task["accountId"]&&account.publicKey==task["publicKey"]&&input.contentEquals(NativeCrypto.input(task)))
   if(failure=="forged")throw NativeCustodyFailure("NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE")
   if(failure=="opaque")throw NativeCustodyFailure("SECRET_BACKEND_DETAIL")
   if(row["unavailable"]==true)throw NativeCryptoUnavailable()
   val result=map(row["result"]);afterUse?.invoke();Base64.getDecoder().decode((result["ciphertext"]?:map(result["message"])["data"]) as String)
  });Unit};if(hold)release=f else f()
 }
}
private class Harness(val sample:Map<String,Any?>,enabled:Boolean=true){
 val account=map(sample["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 val accounts=Accounts(account);val store=Store();val ui=UI();val key=Key(sample);val context=map(sample["context"])
 val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "crypto-workflow","committedUrl" to "${context["origin"]}/dapp")
 var document:Map<String,String>?=scope
 val id=PermissionJson.id("P4/rpc",scope.getValue("sessionId"),PermissionJson.canonical("crypto-workflow"))
 val method=sample["method"] as String
 val c=NativeCustody(accounts,account.chainId,store,ui,key,crypto=if(enabled)key else null){_,s->document==s}
 val host=NativeWalletHost(c){_,_,_->}
 init{host.navigation("view",scope)}
 fun grant(crypto:Boolean=true){
  val request=(listOf("tbc_accounts","tbc_signWorkflow")+if(crypto)listOf("tbc_crypto")else emptyList()).associateWith{mapOf("chains" to listOf(account.chainId))}
  var result:Result<List<Map<String,Any?>>>?=null;c.requestPermissions("view",scope,"grant",request){result=it};ui.choose();result!!.getOrThrow()
 }
 fun begin(){c.begin("view",scope,id,method,c.snapshot("view",scope).revision,account)}
 fun consent(){var r:Result<Boolean>?=null;c.consentReviewed("view",scope,id,method,map(sample["request"]),context,null){r=it};ui.choose();yes(r!!.getOrThrow())}
 fun ready():Map<String,Any?>{grant();begin();consent();var r:Result<Map<String,Any?>>?=null;c.bindWorkflow("view",scope,id,map(sample["binding"]),map(sample["preview"]),map(sample["plan"])){r=it};return r!!.getOrThrow()}
 fun entry(row:Map<String,Any?>)=mapOf("kind" to "workflow-step","stepId" to row["stepId"],"workflowPlanHash" to map(sample["plan"])["workflowPlanHash"],"tasks" to listOf(row["task"]))
 fun enter(r:Map<String,Any?>,row:Map<String,Any?>){c.enterWorkflowStep("view",scope,id,r,entry(row))}
 fun crypto(r:Map<String,Any?>,t:Map<String,Any?>):Map<String,Any?>{var reply:Map<String,Any?>?=null;host.dispatch("signing.crypto",mapOf("ownerId" to "view","scope" to scope,"operation" to id,"receipt" to r,"task" to t)){reply=it};return reply!!}
 fun finish(r:Map<String,Any?>,row:Map<String,Any?>,result:Map<String,Any?>?){
  val outcome=mapOf("kind" to "workflow-step-outcome","stepId" to row["stepId"],"workflowPlanHash" to map(sample["plan"])["workflowPlanHash"],"status" to if(result==null) "failed" else "completed")+
   if(result==null)mapOf("error" to mapOf("code" to "HOST_UNAVAILABLE","message" to "Workflow step failed: crypto.execute"))else mapOf("result" to result)
  var answer:Result<Boolean>?=null;c.finishWorkflowStep("view",scope,id,r,outcome){answer=it};yes(answer!!.getOrThrow())
 }
}
fun main(args:Array<String>){
 val root=map(PermissionJson.decode(JSONObject(File(args[0]).readText())));val original=(root["original"] as List<*>).map{map(it)};val cases=(root["fresh"] as List<*>).map{map(it)}
 for(s in original){
  val a=map(s["account"]);val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)
  val result=NativeWorkflow.bind(s["method"] as String,map(s["request"]),map(s["context"]),account,emptyList(),map(s["plan"]),map(s["preview"]),map(s["binding"]),emptyMap(),NativeCrypto.time(s["now"]))
  yes("tbc_crypto" in result.requiredPermissions)
  val bad=map(s["plan"]).toMutableMap();val p=map(bad["payload"]).toMutableMap();val tasks=(p["cryptoTasks"] as List<*>).map{map(it)}.toMutableList();tasks[0]=tasks[0]+mapOf("publicKey" to "other");p["cryptoTasks"]=tasks;bad["payload"]=p;bad["workflowPlanHash"]=hash(p)
  rejects{NativeWorkflow.bind(s["method"] as String,map(s["request"]),map(s["context"]),account,emptyList(),bad,map(s["preview"]),map(s["binding"]),emptyMap(),NativeCrypto.time(s["now"]))}
 }
 for(s in cases){
  val h=Harness(s);val r=h.ready();val rows=(s["crypto"] as List<*>).map{map(it)}
  yes(h.ui.shown==2&&h.store.writes==1);yes(h.crypto(r,map(rows[0]["task"]))["ok"]==false)
  for(row in rows){
   h.enter(r,row);rejects{h.c.sign("view",h.scope,h.id,r,map(row["task"])) {}}
   val reply=h.crypto(r,map(row["task"]))
   if(row["unavailable"]==true){yes(reply["code"]=="NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE");h.finish(r,row,null)}
   else{yes(PermissionJson.canonical(reply["value"])==PermissionJson.canonical(row["result"]));val altered=map(row["result"])+mapOf("taskId" to "other");rejects{h.finish(r,row,altered)};h.finish(r,row,map(reply["value"]))}
   yes(h.crypto(r,map(row["task"]))["ok"]==false)
  }
  h.c.close("view",h.scope,h.id);val expected=map(s["result"])+mapOf("approvalId" to r["approvalId"])
  yes(h.c.mayDeliverWorkflowResult("view",h.scope,h.id,h.method,hash(expected)));yes(h.key.calls==2&&h.ui.shown==2&&h.store.writes==1)
  h.accounts.unlocked=false;yes(!h.c.mayDeliverWorkflowResult("view",h.scope,h.id,h.method,hash(expected)))
 }
 val s=cases[0]
 run{val h=Harness(s,false);h.grant(false);h.begin();rejects{h.consent()};yes(h.ui.shown==1&&h.key.calls==0)}
 for(mode in listOf("lock-before","lock-after","navigation","opaque","forged")){
  val h=Harness(s);val r=h.ready();val row=map((s["crypto"] as List<*>)[0]);h.enter(r,row)
  h.key.hold=true;var reply:Result<Map<String,Any?>>?=null;h.c.executeCrypto("view",h.scope,h.id,r,map(row["task"])) {reply=it}
  if(mode=="lock-before")h.accounts.unlocked=false;if(mode=="lock-after")h.key.afterUse={h.accounts.unlocked=false}
  if(mode=="navigation"){h.document=null;h.c.invalidate("view")};if(mode=="opaque"||mode=="forged")h.key.failure=mode
  h.key.release!!();rejects{reply!!.getOrThrow()};rejects{h.finish(r,row,map(row["result"]))}
  yes(!h.c.mayDeliverWorkflowResult("view",h.scope,h.id,h.method,hash(s["result"])))
 }
 println("{\"status\":\"PASS\",\"bindingCases\":${original.size},\"executionCases\":${cases.size},\"checks\":$checks,\"proof\":\"native-host-public-replay\",\"broadcasts\":0}")
}
