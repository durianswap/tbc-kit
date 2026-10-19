package io.tbc.kit.dart

import java.io.File

@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun json(v:Any?)=PermissionJson.canonical(v)
private fun unhex(s:String)=s.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
private fun hex(b:ByteArray)=b.joinToString(""){"%02x".format(it)}
private var checks=0
private fun yes(v:Boolean){check(v){"reviewed custody ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var bad=false;try{f()}catch(_:Exception){bad=true};yes(bad)}
private class Accounts(override val current:NativeAccount):NativeAccountSource{override var revision=0L;override var unlocked=true}
private class Store:NativePermissionBackend{
 val value=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=value.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{fence();check((value[origin]?.revision?:0)==expected);val v=PermissionSnapshot(expected+1,records);value[origin]=v;writes++;return PermissionCommitResult(v.revision,v)}
}
private class UI:NativeApprovalPresenter{
 var pending:((Boolean)->Unit)?=null;var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;pending=complete;return {pending=null}}
 fun choose(yes:Boolean=true){val f=pending!!;pending=null;f(yes)}
}
private class Replay(val stages:List<Map<String,Any?>>):NativeDigestSigner,NativeReviewedComputer{
 var calls=0;var signs=0;var hold=false;var changed=false;var release:(()->Unit)?=null
 override fun call(method:String,input:String,complete:(Result<String>)->Unit){
  calls++
  val work={complete(runCatching{
   val a=PermissionJson.records("[$input]").single()
   val row=stages.firstOrNull{row->
    (method=="prepareReviewedStage"&&json(a)==json(row["prepare"]))||(method=="finalizeReviewedStage"&&json(a)==json(mapOf("stage" to row["stage"],"signatures" to row["signatures"],"signatureEncoding" to "compact64")))
   }?:throw NativeCustodyFailure("UNKNOWN_COMPUTE_INPUT")
   if(method=="prepareReviewedStage")json(map(row["stage"])+(if(changed)mapOf("publicKey" to ("03"+"00".repeat(32)))else emptyMap()))else json(row["finalized"])
  });Unit}
  if(hold)release=work else work()
 }
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){complete(runCatching{
  requireCurrent()
  val row=stages.firstOrNull{(it["tasks"] as List<*>).any{map(it)["digest"]==hex(digest)}}?:throw NativeCustodyFailure("UNKNOWN_DIGEST")
  val tasks=(row["tasks"] as List<*>).map{map(it)};val i=tasks.indexOfFirst{it["digest"]==hex(digest)};check(tasks[i]["accountId"]==account.accountId&&encoding=="compact64");signs++;unhex((row["signatures"] as List<*>)[i] as String)
 })}
}
private class Harness(val s:Map<String,Any?>){
 val a=map(s["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 val accounts=Accounts(a);val store=Store();val ui=UI();val replay=Replay((s["stages"] as List<*>).map{map(it)})
 val context=map(s["context"]);val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "native-reviewed","committedUrl" to "${context["origin"]}/dapp")
 val c=NativeCustody(accounts,a.chainId,store,ui,replay,replay){owner,value->owner=="v"&&value==scope}
 val packet get()=map(s["packet"]);val audit get()=map(s["audit"])
 init{c.navigation("v",scope)}
 fun consent(approve:Boolean=true){
  var grant:Result<List<Map<String,Any?>>>?=null
  c.requestPermissions("v",scope,"grant",mapOf("tbc_accounts" to mapOf("chains" to listOf(a.chainId)),"tbc_signTransaction" to mapOf("chains" to listOf(a.chainId)))){grant=it};ui.choose();grant!!.getOrThrow()
  c.begin("v",scope,"op",NativeReviewed.method,c.snapshot("v",scope).revision,a)
  var answer:Result<Boolean>?=null
  c.consentReviewed("v",scope,"op",NativeReviewed.method,map(s["request"]),context,map(packet["review"])){answer=it};ui.choose(approve);yes(answer!!.getOrThrow()==approve)
 }
 fun bind(done:(Result<Map<String,Any?>>)->Unit){c.bindReviewed("v",scope,"op",map(audit["binding"]),map(audit["preview"]),map(audit["plan"]),packet,done)}
 fun ready():Map<String,Any?>{consent();var receipt:Result<Map<String,Any?>>?=null;bind{receipt=it};return receipt!!.getOrThrow()}
 fun pending(index:Int):Map<String,Any?>{val rows=(s["stages"] as List<*>).map{map(it)};return mapOf("kind" to "reviewed","planHash" to map(audit["plan"])["planHash"],"stageIndex" to index,"previousTransactions" to rows.take(index).map{map(it["finalized"])["txraw"]},"stage" to rows[index]["stage"],"signingRequests" to rows[index]["tasks"])}
 fun sign(index:Int,receipt:Map<String,Any?>){
  val row=map((s["stages"] as List<*>)[index])
  for((i,task) in (row["tasks"] as List<*>).map{map(it)}.withIndex()){var signed:Result<Map<String,Any?>>?=null;c.sign("v",scope,"op",receipt,task){signed=it};yes(signed!!.getOrThrow()["signature"]==(row["signatures"] as List<*>)[i])}
 }
}
fun main(args:Array<String>){
 val d=PermissionJson.records("[${File(args[0]).readText()}]").single();val samples=(d["cases"] as List<*>).map{map(it)}
 for(s in samples){
  val h=Harness(s);val receipt=h.ready();val rows=s["stages"] as List<*>
  for(i in rows.indices){if(i>0){var result:Result<Boolean>?=null;h.c.advanceReviewed("v",h.scope,"op",receipt,h.pending(i)){result=it};yes(result!!.getOrThrow())};h.sign(i,receipt)}
  yes(h.ui.shown==2&&h.store.writes==1&&h.replay.calls==rows.size*2-1);rejects{h.sign(0,receipt)}
  h.c.close("v",h.scope,"op");yes(h.c.mayDeliverSignature("v",h.scope,"op"));h.accounts.unlocked=false;yes(!h.c.mayDeliverSignature("v",h.scope,"op"))
 }
 val sample=samples[0]
 run{val h=Harness(sample);h.consent(false);rejects{h.bind{}};yes(h.replay.calls==0&&h.replay.signs==0)}
 run{val h=Harness(sample);h.consent();h.replay.hold=true;var answer:Result<Map<String,Any?>>?=null;h.bind{answer=it};yes(answer==null);h.c.cancel("v",h.scope,"op");yes(answer!=null);rejects{answer!!.getOrThrow()};h.replay.release!!();yes(h.replay.signs==0&&!h.c.mayDeliverSignature("v",h.scope,"op"))}
 run{val h=Harness(sample);h.consent();h.replay.hold=true;var answer:Result<Map<String,Any?>>?=null;h.bind{answer=it};h.accounts.unlocked=false;h.replay.release!!();rejects{answer!!.getOrThrow()};yes(h.replay.signs==0)}
 run{val h=Harness(sample);h.consent();h.replay.changed=true;var answer:Result<Map<String,Any?>>?=null;h.bind{answer=it};rejects{answer!!.getOrThrow()};yes(h.replay.signs==0)}
 val multiple=samples.first{(it["stages"] as List<*>).size>1}
 run{val h=Harness(multiple);val r=h.ready();rejects{h.c.advanceReviewed("v",h.scope,"op",r,h.pending(1)){}};h.sign(0,r);val p=h.pending(1)+mapOf("previousTransactions" to listOf("00"));var result:Result<Boolean>?=null;h.c.advanceReviewed("v",h.scope,"op",r,p){result=it};rejects{result!!.getOrThrow()};yes(h.replay.calls==2)}
 println("{\"status\":\"PASS\",\"checks\":$checks,\"cases\":${samples.size},\"scope\":\"native-custody-replay\"}")
}
