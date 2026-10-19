package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun json(v:Any?)=PermissionJson.canonical(v)
private fun parse(s:String)=PermissionJson.records("[$s]").single()
private var checks=0
private fun yes(v:Boolean){check(v){"reviewed actual compute ${checks+1}"};checks++}
private val callbacks=LinkedBlockingQueue<()->Unit>()
private fun <T> wait(action:((Result<T>)->Unit)->Unit):T{
 var result:Result<T>?=null;action{check(result==null);result=it}
 while(result==null)(callbacks.poll(30,TimeUnit.SECONDS)?:error("COMPUTE_TIMEOUT"))()
 return result!!.getOrThrow()
}
private class Accounts(override val current:NativeAccount):NativeAccountSource{override var revision=0L;override var unlocked=true}
private class Store:NativePermissionBackend{
 val all=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=all.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{fence();check((all[origin]?.revision?:0)==expected);val s=PermissionSnapshot(expected+1,records);all[origin]=s;writes++;return PermissionCommitResult(s.revision,s)}
}
private class UI:NativeApprovalPresenter{
 var pending:((Boolean)->Unit)?=null;var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;pending=complete;return {pending=null}}
 fun choose(){val f=pending!!;pending=null;f(true)}
}
private class Signer(val rows:List<Map<String,Any?>>):NativeDigestSigner{
 var calls=0
 var unavailable=mutableSetOf<String>()
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){complete(runCatching{
  requireCurrent();val h=digest.joinToString(""){"%02x".format(it)}
  // One failed attempt; another independent step may reuse the same digest.
  if(unavailable.remove(h))throw NativeSignerUnavailable()
  val row=rows.first{(it["tasks"] as List<*>).any{map(it)["digest"]==h}};val tasks=(row["tasks"] as List<*>).map{map(it)};val i=tasks.indexOfFirst{it["digest"]==h}
  check(encoding==tasks[i]["signatureEncoding"]&&tasks[i]["accountId"]==account.accountId&&tasks[i]["publicKey"]==account.publicKey)
  calls++
  ((row["signatures"] as List<*>)[i] as String).chunked(2).map{it.toInt(16).toByte()}.toByteArray()
 })}
}
private class CountedCompute(val inner:NativeReviewedComputer):NativeReviewedComputer{
 var calls=0
 override fun call(method:String,input:String,complete:(Result<String>)->Unit){calls++;inner.call(method,input,complete)}
}
fun main(args:Array<String>){
 val d=parse(File(args[0]).readText());val cases=(d["cases"] as List<*>).map{map(it)}
 val computer=NativeReviewedRust{callbacks.add(it)};var stages=0
 for(s in cases){
  val rows=(s["stages"] as List<*>).map{map(it)}
  for(row in rows){
   val actual=wait<String>{computer.call("prepareReviewedStage",json(row["prepare"]),it)};yes(json(parse(actual))==json(row["stage"]))
   val final=wait<String>{computer.call("finalizeReviewedStage",json(mapOf("stage" to parse(actual),"signatures" to row["signatures"],"signatureEncoding" to "compact64")),it)};yes(json(parse(final))==json(row["finalized"]));stages++
  }
  val a=map(s["account"]);val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)
  val accounts=Accounts(account);val store=Store();val ui=UI();val signer=Signer(rows)
  val context=map(s["context"]);val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "actual-reviewed","committedUrl" to "${context["origin"]}/dapp")
  val audit=map(s["audit"]);val packet=map(s["packet"])
  val custody=NativeCustody(accounts,account.chainId,store,ui,signer,computer){owner,v->owner=="v"&&v==scope};val host=NativeWalletHost(custody){_,_,_->};host.navigation("v",scope)
  val op=PermissionJson.id("P4/rpc",scope.getValue("sessionId"),json("reviewed"))
  var grant:Result<List<Map<String,Any?>>>?=null
  custody.requestPermissions("v",scope,"grant",mapOf("tbc_accounts" to mapOf("chains" to listOf(account.chainId)),"tbc_signTransaction" to mapOf("chains" to listOf(account.chainId)))){grant=it};ui.choose();grant!!.getOrThrow()
  custody.begin("v",scope,op,NativeReviewed.method,custody.snapshot("v",scope).revision,account)
  var consent:Result<Boolean>?=null
  custody.consentReviewed("v",scope,op,NativeReviewed.method,map(s["request"]),context,map(packet["review"])){consent=it};ui.choose();yes(consent!!.getOrThrow())
  val receipt=wait<Map<String,Any?>>{custody.bindReviewed("v",scope,op,map(audit["binding"]),map(audit["preview"]),map(audit["plan"]),packet,it)}
  for(i in rows.indices){
   if(i>0){val pending=mapOf("kind" to "reviewed","planHash" to map(audit["plan"])["planHash"],"stageIndex" to i,"previousTransactions" to rows.take(i).map{map(it["finalized"])["txraw"]},"stage" to rows[i]["stage"],"signingRequests" to rows[i]["tasks"]);yes(wait<Boolean>{custody.advanceReviewed("v",scope,op,receipt,pending,it)})}
   for((j,t) in (rows[i]["tasks"] as List<*>).map{map(it)}.withIndex()){val signed=wait<Map<String,Any?>>{custody.sign("v",scope,op,receipt,t,it)};yes(signed["signature"]==(rows[i]["signatures"] as List<*>)[j])}
  }
  custody.close("v",scope,op);yes(custody.mayDeliverSignature("v",scope,op));yes(ui.shown==2&&store.writes==1)
  val response=mapOf("jsonrpc" to "2.0","id" to "reviewed","result" to s["result"]);val events=emptyList<Any>()
  val digest=MessageDigest.getInstance("SHA-256").digest(json(mapOf("response" to response,"events" to events)).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
  val text=json(mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to scope["sessionId"],"navigationId" to scope["navigationId"],"messageId" to "reviewed-result","deliveryId" to digest,"response" to response,"events" to events))
  var delivery=emptyMap<String,Any?>();host.dispatch("delivery.prepare",mapOf("ownerId" to "v","scope" to scope,"method" to NativeReviewed.method,"requestId" to "reviewed","serialized" to text)){delivery=it}
  yes(delivery["ok"]==true);yes(host.allowDelivery("v",scope,text));accounts.unlocked=false;yes(!custody.mayDeliverSignature("v",scope,op));yes(!host.allowDelivery("v",scope,text))
 }
 val w=map(d["workflow"]);val a=map(w["account"]);val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String);val context=map(w["context"])
 val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "actual-workflow","committedUrl" to "${context["origin"]}/dapp")
 for(interrupt in listOf(false,true)){
  val accounts=Accounts(account);val store=Store();val ui=UI();val signer=Signer(emptyList());val counted=CountedCompute(computer)
  val custody=NativeCustody(accounts,account.chainId,store,ui,signer,counted){owner,v->owner=="v"&&v==scope};val host=NativeWalletHost(custody){_,_,_->};host.navigation("v",scope)
  var grant:Result<List<Map<String,Any?>>>?=null
  val permissions=listOf("tbc_accounts","tbc_signWorkflow","tbc_signTransaction","tbc_signMessage").associateWith{mapOf("chains" to listOf(account.chainId))}
  custody.requestPermissions("v",scope,"grant",permissions){grant=it};ui.choose();grant!!.getOrThrow()
  custody.begin("v",scope,"batch",w["method"] as String,custody.snapshot("v",scope).revision,account)
  val plan=map(w["plan"]);val p=map(plan["payload"])
  val review=mapOf("kind" to "workflow","steps" to map(w["reviews"]).map{mapOf("stepId" to it.key,"review" to it.value)},"prepared" to mapOf("workflowPlanHash" to plan["workflowPlanHash"],"totalFee" to p["totalFee"]))
  var approved:Result<Boolean>?=null
  custody.consentReviewed("v",scope,"batch",w["method"] as String,map(w["request"]),context,review){approved=it};ui.choose();yes(approved!!.getOrThrow())
  val reply=wait<Map<String,Any?>>{done->
   host.dispatch("signing.bind",mapOf("ownerId" to "v","scope" to scope,"operation" to "batch","binding" to w["binding"],"preview" to w["preview"],"plan" to plan,"envelope" to null)){done(Result.success(it))}
   if(interrupt)accounts.unlocked=false
  }
  yes(reply["ok"]==!interrupt);yes(counted.calls==1&&signer.calls==0&&ui.shown==2&&store.writes==1)
  if(!interrupt){val receipt=map(reply["value"]);yes(receipt["bindingHash"]==map(w["binding"])["bindingHash"]);custody.close("v",scope,"batch")}
  yes(!custody.mayDeliverSignature("v",scope,"batch"))
 }
 val traces=(d["workflowTraces"] as List<*>).map{map(it)};var workflowSteps=0;var workflowAdvances=0;var workflowSignatures=0;var workflowFailures=0
 for(sample in traces){
  val a=map(sample["account"]);val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String);val context=map(sample["context"]);val events=(sample["trace"] as List<*>).map{map(it)};val method=sample["method"] as String
  val rows=events.filter{it["call"]=="sign"}.map{mapOf("tasks" to listOf(map(it["task"])),"signatures" to listOf(map(it["result"])["signature"]))}
  val accounts=Accounts(account);val store=Store();val ui=UI();val signer=Signer(rows);val counted=CountedCompute(computer)
  signer.unavailable=events.filter{it["call"]=="signUnavailable"}.map{map(it["task"])["digest"] as String}.toMutableSet()
  val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "workflow-trace","committedUrl" to "${context["origin"]}/dapp")
  val custody=NativeCustody(accounts,account.chainId,store,ui,signer,counted){owner,v->owner=="v"&&v==scope};val host=NativeWalletHost(custody){_,_,_->};host.navigation("v",scope)
  val requestId="trace-${sample["name"]}";val op=PermissionJson.id("P4/rpc",scope.getValue("sessionId"),json(requestId))
  val permissions=listOf("tbc_accounts","tbc_signWorkflow","tbc_signTransaction","tbc_signMessage","tbc_signTypedData").associateWith{mapOf("chains" to listOf(account.chainId))}
  var grant:Result<List<Map<String,Any?>>>?=null;custody.requestPermissions("v",scope,"grant",permissions){grant=it};ui.choose();grant!!.getOrThrow()
  custody.begin("v",scope,op,method,custody.snapshot("v",scope).revision,account)
  var receipt=emptyMap<String,Any?>()
  for(event in events){when(event["call"]){
   "consent"->{var consent:Result<Boolean>?=null;custody.consentReviewed("v",scope,op,method,map(event["request"]),context,event["review"]?.let{map(it)}){consent=it};ui.choose();yes(consent!!.getOrThrow())}
   "bind"->receipt=wait<Map<String,Any?>>{custody.bindWorkflow("v",scope,op,map(event["binding"]),map(event["preview"]),map(event["plan"]),it)}
   "enter"->{custody.enterWorkflowStep("v",scope,op,receipt,map(event["entry"]));workflowSteps++}
   "advance"->{
    val pending=map(event["pending"]).toMutableMap()
    if(pending["kind"]=="reviewed")yes(wait<Boolean>{custody.advanceReviewed("v",scope,op,receipt,pending,it)})
    else{pending["continuation"]=map(pending["continuation"])+mapOf("approvalId" to receipt["approvalId"]);custody.advance("v",scope,op,receipt,pending);yes(true)}
    workflowAdvances++
   }
   "sign"->{val reply=wait<Map<String,Any?>>{custody.sign("v",scope,op,receipt,map(event["task"]),it)};yes(json(reply)==json(event["result"]))}
   "signUnavailable"->{
    var reply=emptyMap<String,Any?>();host.dispatch("signing.sign",mapOf("ownerId" to "v","scope" to scope,"operation" to op,"receipt" to receipt,"task" to event["task"])){reply=it}
    yes(reply["ok"]==false&&reply["code"]=="NATIVE_WORKFLOW_STEP_UNAVAILABLE");workflowFailures++
   }
   "finish"->{
    val outcome=map(event["outcome"]).toMutableMap()
    if(outcome.containsKey("result")){val result=map(outcome["result"]).toMutableMap();if(result.containsKey("approvalId"))result["approvalId"]=receipt["approvalId"];outcome["result"]=result}
    yes(wait<Boolean>{custody.finishWorkflowStep("v",scope,op,receipt,outcome,it)})
   }
   else->error("Unknown offline trace operation")
  }}
  custody.close("v",scope,op);yes(!custody.mayDeliverSignature("v",scope,op));yes(ui.shown==2&&store.writes==1)
  val resultRows=(map(sample["result"])["steps"] as List<*>).map{value->val row=map(value);val r=row["result"]?.let{map(it)};if(r?.containsKey("approvalId")==true)row+("result" to (r+("approvalId" to receipt["approvalId"])))else row}
  val result=map(sample["result"])+mapOf("approvalId" to receipt["approvalId"],"steps" to resultRows)
  val response=mapOf("jsonrpc" to "2.0","id" to requestId,"result" to result);val emitted=emptyList<Any>()
  val digest=MessageDigest.getInstance("SHA-256").digest(json(mapOf("response" to response,"events" to emitted)).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
  val text=json(mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to scope["sessionId"],"navigationId" to scope["navigationId"],"messageId" to "trace-result","deliveryId" to digest,"response" to response,"events" to emitted))
  var reply=emptyMap<String,Any?>();host.dispatch("delivery.prepare",mapOf("ownerId" to "v","scope" to scope,"method" to method,"requestId" to requestId,"serialized" to text)){reply=it}
  yes(reply["ok"]==true&&host.allowDelivery("v",scope,text));accounts.unlocked=false;yes(!host.allowDelivery("v",scope,text))
  yes(counted.calls==if(sample["name"]=="reviewed-then-message")6 else 0);workflowSignatures+=signer.calls
 }
 var rejected=false;try{wait<String>{computer.call("sign","{}",it)}}catch(_:Exception){rejected=true};yes(rejected)
 val malformed=wait<String>{computer.call("prepareReviewedStage","{}",it)};yes(parse(malformed)["error"] is String)
 println("{\"status\":\"PASS\",\"checks\":$checks,\"cases\":${cases.size},\"stages\":$stages,\"workflowReceiptCases\":1,\"workflowInterruptedCases\":1,\"workflowTraceCases\":${traces.size},\"workflowSteps\":$workflowSteps,\"workflowAdvances\":$workflowAdvances,\"workflowReplayedSignatures\":$workflowSignatures,\"workflowRecoverableFailures\":$workflowFailures,\"scope\":\"actual-rust-jni-and-workflow-native-trace\"}")
}
