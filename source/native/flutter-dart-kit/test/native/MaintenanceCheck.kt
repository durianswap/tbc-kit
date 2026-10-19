package io.tbc.kit.dart

import java.io.File
import java.security.MessageDigest
import java.time.Instant

// Frozen public signatures, synthetic native journal facts. No HTTP/key use.
@Suppress("UNCHECKED_CAST") private fun map(x:Any?)=x as Map<String,Any?>
private fun rows(x:Any?)=(x as List<*>).map{map(it)}
private fun hash(x:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(x).toByteArray()).joinToString(""){"%02x".format(it)}
private fun stamp(s:Long)=Instant.now().plusSeconds(s).toString()
private var checks=0
private fun yes(v:Boolean){check(v){"maintenance check ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var denied=false;try{f()}catch(_:Exception){denied=true};yes(denied)}
private class Accounts(override var current:NativeAccount):NativeAccountSource{override var revision=0L;override var unlocked=true}
private class Store:NativePermissionBackend{
 val records=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=records.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{fence();check((this.records[origin]?.revision?:0)==expected);val s=PermissionSnapshot(expected+1,records);this.records[origin]=s;writes++;return PermissionCommitResult(s.revision,s)}
}
private class UI:NativeApprovalPresenter{
 val pending=mutableMapOf<String,(Boolean)->Unit>();var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;pending[review.operationId]=complete;return {pending.remove(review.operationId);Unit}}
 fun choose(id:String,approved:Boolean=true){pending.remove(id)!!(approved)}
}
private class Signer(val sample:Map<String,Any?>):NativeDigestSigner{
 var calls=0
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){complete(runCatching{
  requireCurrent();val audit=map(sample["audit"]);val tasks=rows(map(map(audit["plan"])["payload"])["signingTasks"]);val d=digest.joinToString(""){"%02x".format(it)}
  val t=tasks.single{it["digest"]==d&&it["accountId"]==account.accountId&&it["publicKey"]==account.publicKey&&it["signatureEncoding"]==encoding}
  val s=rows(audit["signatures"]).single{it["taskId"]==t["taskId"]};calls++;(s["signature"] as String).chunked(2).map{it.toInt(16).toByte()}.toByteArray()
 })}
}
private class Harness(val sample:Map<String,Any?>,register:Boolean=true){
 val account=map(sample["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 val accounts=Accounts(account);val store=Store();val ui=UI();val signer=Signer(sample)
 val context=map(sample["context"])
 val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "merge-test","committedUrl" to "${context["origin"]}/dapp")
 var consent=map(sample["consent"])+mapOf("limits" to (map(map(sample["consent"])["limits"])+mapOf("expiresAt" to stamp(240))))
 var approval=emptyMap<String,Any?>();var request=emptyMap<String,Any?>();var step=emptyMap<String,Any?>();var receipt=emptyMap<String,Any?>()
 var id="child";var inputs=(sample["selectedInputs"] as List<*>).map{it as String};var status="accepted"
 var parent="merge"
 val c=NativeCustody(accounts,account.chainId,store,ui,signer,sendSourceIdentity="a".repeat(64)){owner,value->owner=="view"&&value==scope}
 val host=NativeWalletHost(c){_,_,_->}
 init{if(register)c.registerBroadcast();c.navigation("view",scope)}
 fun grant(send:Boolean=true){
  val req=mutableMapOf<String,Any?>("tbc_accounts" to mapOf("chains" to listOf(account.chainId)));if(send)req["tbc_sendTransaction"]=mapOf("chains" to listOf(account.chainId))
  var r:Result<List<Map<String,Any?>>>?=null;c.requestPermissions("view",scope,"grant",req){r=it};ui.choose("grant");r!!.getOrThrow()
 }
 fun approve(choice:Boolean=true){
  var reply:Map<String,Any?>?=null;host.dispatch("maintenance.begin",mapOf("ownerId" to "view","scope" to scope,"operation" to parent,"revision" to c.snapshot("view",scope).revision,"account" to account.identity(),"consent" to consent)){reply=it}
  if(reply==null){yes(parent in ui.pending);ui.choose(parent,choice)}
  if(reply?.get("ok")!=true)throw NativeCustodyFailure("TEST_DENIED");approval=map(reply!!["value"])
 }
 fun prepare(index:Int=1,fee:String="100000"){
  val expiry=map(consent["limits"])["expiresAt"];val identity=hash(mapOf("domain" to "tbc-kit/multi-round-step/1","scopeHash" to hash(consent),"approvalId" to approval["approvalId"],"stepIndex" to index))
  request=map(sample["request"])+mapOf("clientRequestId" to "kit-multi-round-$identity","constraints" to mapOf("maxFee" to fee,"feePreference" to "standard","expiresAt" to expiry))
  step=mapOf("version" to "1.0","stepId" to "merge-$index","stepIndex" to index,"authority" to consent["authority"],"asset" to consent["asset"],"stateHash" to consent["initialStateHash"],"materialHash" to hash(request),"inputCount" to inputs.size,"outputCount" to 1,"feeKind" to "maximum","fee" to fee,"expiresAt" to expiry,"dependsOn" to emptyList<String>())
 }
 fun begin(){var reply:Map<String,Any?>?=null;host.dispatch("maintenance.step",mapOf("ownerId" to "view","scope" to scope,"parent" to parent,"operation" to id,"step" to step,"request" to request,"selectedInputs" to inputs)){reply=it};if(reply?.get("ok")!=true)throw NativeCustodyFailure("TEST_DENIED")}
 fun consentChild(){var r:Result<Boolean>?=null;c.consent("view",scope,id,"tbc_sendTransaction",request,context){r=it};yes(r!!.getOrThrow());yes(ui.shown==2)}
 fun bind(mutation:String?=null){
  val audit=map(sample["audit"]);var preview=map(audit["preview"])
  if(mutation=="recipient"){val f=rows(preview["assetFlows"]).toMutableList();f[0]=f[0]+mapOf("to" to "other");preview=preview+mapOf("assetFlows" to f)}
  if(mutation=="fee")preview=preview+mapOf("totalFee" to "100001")
  val p=map(map(audit["plan"])["payload"])+mapOf("requestHash" to hash(request),"expiresAt" to map(request["constraints"])["expiresAt"],"preview" to preview)
  val plan=mapOf("payload" to p,"planHash" to hash(p));val b=map(map(audit["binding"])["payload"])+mapOf("requestHash" to hash(request),"operationHash" to plan["planHash"],"method" to "tbc_sendTransaction","expiresAt" to stamp(120))
  receipt=c.bind("view",scope,id,mapOf("payload" to b,"bindingHash" to hash(b)),preview,plan,null)
 }
 fun signAndOwn():Map<String,Any?>{
  val tasks=rows(map(map(map(sample["audit"])["plan"])["payload"])["signingTasks"])
  for(t in tasks){var r:Result<Map<String,Any?>>?=null;c.sign("view",scope,id,receipt,t){r=it};r!!.getOrThrow()}
  val bundle=map(sample["result"])+mapOf("approvalId" to receipt["approvalId"],"requestHash" to hash(request));c.authorizeBroadcast("view",scope,id,receipt,bundle)
  val txs=rows(bundle["transactions"]);c.ownBroadcast("view",scope,id,"single:0",{listOf(mapOf("txid" to (txs[0]["txid"] as String),"status" to status))},{},"native-journal-fixture")
  return bundle+mapOf("transactions" to txs.map{mapOf("id" to it["id"],"txid" to it["txid"],"role" to it["role"],"dependsOn" to it["dependsOn"],"status" to "submitted")})
 }
 fun ready(){grant();approve();prepare();begin();consentChild()}
 fun summary(sent:Map<String,Any?>?,terminal:String?=null):Map<String,Any?>{
  val row=mutableMapOf<String,Any?>("stepId" to step["stepId"],"status" to (terminal?:status),"fee" to (sent?.get("totalFee")?:"0"),"inputCount" to inputs.size,"outputCount" to 1,"dependsOn" to step["dependsOn"])
  if(terminal==null)row["txid"]=rows(sent!!["transactions"])[0]["txid"]
  if(terminal=="uncertain"){row["fee"]=step["fee"];row["recoveryId"]="native-journal-fixture"}
  val initial=(consent["initialUtxoCount"] as Number).toInt();val final=if(terminal==null)initial-inputs.size+1 else initial;val complete=terminal==null&&final<=1
  return mapOf("version" to "1.0","scopeHash" to hash(consent),"approvalId" to approval["approvalId"],"initialUtxoCount" to initial,"finalUtxoCount" to final,"totalFee" to row["fee"],"steps" to listOf(row),"status" to (if(terminal=="uncertain")"uncertain" else if(terminal!=null)"stopped" else if(complete)"complete" else "partial"),"reason" to (if(terminal=="uncertain")"broadcast-uncertain" else if(terminal!=null)"step-failed" else if(complete)"target-reached" else "index-stalled"))
 }
 fun finish(value:Map<String,Any?>){var reply:Map<String,Any?>?=null;host.dispatch("maintenance.finish",mapOf("ownerId" to "view","scope" to scope,"operation" to parent,"result" to value)){reply=it};if(reply?.get("ok")!=true)throw NativeCustodyFailure("TEST_DENIED")}
 fun noopResult()=mapOf("version" to "1.0","status" to "complete","reason" to "already-below-target","scopeHash" to hash(consent),"initialUtxoCount" to consent["initialUtxoCount"],"finalUtxoCount" to consent["initialUtxoCount"],"totalFee" to "0","steps" to emptyList<Any>())
 fun noop(value:Map<String,Any?>){
  var reply:Map<String,Any?>?=null;host.dispatch("maintenance.noop",mapOf("ownerId" to "view","scope" to scope,"operation" to parent,"revision" to c.snapshot("view",scope).revision,"account" to account.identity(),"consent" to consent,"result" to value)){reply=it}
  if(reply?.get("ok")!=true)throw NativeCustodyFailure("TEST_DENIED");yes(map(reply!!["value"])==mapOf("status" to "not-required"))
 }
 fun delivery(result:Map<String,Any?>,method:String="wallet_mergeMaintenance"):String{
  val response=mapOf("jsonrpc" to "2.0","id" to "rpc-merge","result" to result)
  val envelope=mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to scope["sessionId"],"navigationId" to scope["navigationId"],"messageId" to "delivery","deliveryId" to hash(mapOf("response" to response,"events" to emptyList<Any>())),"response" to response,"events" to emptyList<Any>())
  val text=PermissionJson.canonical(envelope);var reply:Map<String,Any?>?=null
  host.dispatch("delivery.prepare",mapOf("ownerId" to "view","scope" to scope,"method" to method,"requestId" to "rpc-merge","serialized" to text)){reply=it}
  if(reply?.get("ok")!=true)throw NativeCustodyFailure("TEST_DENIED");return text
 }
 fun projected(core:Map<String,Any?>):Map<String,Any?>{
  fun row(phase:String,index:Int,count:Int,utxos:Any?,fee:Any?)=mapOf("phase" to phase,"stepIndex" to index,"transactionCount" to count,"utxoCount" to utxos,"totalFee" to fee,"targetUtxoCount" to map(consent["limits"])["targetUtxoCount"])
  val count=rows(core["steps"]).size;val progress=mutableListOf<Map<String,Any?>>()
  if(core["approvalId"]!=null)progress+=row("approval",0,0,core["initialUtxoCount"],"0")
  progress+=row(if(core["status"]=="complete")"complete" else "executing",count,count,core["finalUtxoCount"],core["totalFee"])
  return core+mapOf("atomic" to false,"progress" to progress)
 }
}
fun main(args:Array<String>){
 val cases=rows(PermissionJson.records("["+File(args[0]).readText()+"]").single()["cases"]);var signatures=0
 for(sample in cases){
  val h=Harness(sample);h.ready();h.bind();val result=h.signAndOwn();signatures+=h.signer.calls
  h.c.finishBroadcast("view",h.scope,h.id,h.receipt,result);rejects{h.c.finishBroadcast("view",h.scope,h.id,h.receipt,result)}
  h.c.close("view",h.scope,h.id);yes(h.c.mayDeliverSendResult("view",h.scope,h.id,"tbc_sendTransaction",hash(result)));yes(h.ui.shown==2&&h.store.writes==1)
  val summary=h.summary(result)
  for(key in listOf("totalFee","approvalId","scopeHash","steps","status","finalUtxoCount")){
   val bad=summary+mapOf(key to when(key){"steps"->emptyList<Any>();"finalUtxoCount"->-1;"status"->"complete";else->"tampered"});rejects{h.finish(bad)}
  }
  for(key in listOf("txid","fee","status","inputCount","dependsOn")){
   val altered=rows(summary["steps"])[0]+mapOf(key to when(key){"inputCount"->0;"dependsOn"->listOf("foreign");else->"tampered"})
   rejects{h.finish(summary+mapOf("steps" to listOf(altered)))}
  }
  h.finish(summary);yes(h.c.mayDeliverMaintenanceResult("view",h.scope,"merge",hash(summary)));yes(!h.c.mayDeliverSignature("view",h.scope,"merge"));yes(!h.c.mayDeliverSendResult("view",h.scope,"merge","tbc_sendTransaction",hash(summary)));rejects{h.finish(summary)}
  val projected=h.projected(summary);yes(h.c.maintenanceProjectionHash("view",h.scope,h.parent,projected)==hash(summary))
  for(key in listOf("atomic","totalFee","progress","extra")){
   val bad=projected+mapOf(key to if(key=="atomic")true else if(key=="progress")emptyList<Any>()else "tampered")
   rejects{h.c.maintenanceProjectionHash("view",h.scope,h.parent,bad)}
  }
  for(key in listOf("phase","stepIndex","targetUtxoCount","transactionCount","utxoCount","totalFee","extra")){
   val progress=rows(projected["progress"]).toMutableList()
   progress[0]=progress[0]+mapOf(key to if(key=="phase")"complete" else if(key=="totalFee")"999999999" else if(key=="extra")"secret" else -1)
   rejects{h.c.maintenanceProjectionHash("view",h.scope,h.parent,projected+mapOf("progress" to progress))}
  }
  yes(!h.c.mayDeliverSendResult("view",h.scope,h.id,"tbc_sendTransaction",hash(result)))
  h.id="next";h.prepare(2,(100000-(result["totalFee"] as String).toInt()).toString());rejects{h.begin()};h.c.closeMaintenance("view",h.scope,"merge");rejects{h.begin()}
 }
 val sample=cases[0]
 for(count in listOf(0,1)){
  val h=Harness(sample);h.grant();h.consent=h.consent+mapOf("initialUtxoCount" to count);h.parent=PermissionJson.id("P4/rpc",h.scope["sessionId"]!!,"\"rpc-merge\"")
  val result=h.noopResult();h.noop(result);yes(h.ui.shown==1&&h.signer.calls==0&&h.store.writes==1)
  val text=h.delivery(result);yes(h.host.allowDelivery("view",h.scope,text));rejects{h.delivery(result,"tbc_sendTransaction")};rejects{h.delivery(result+mapOf("totalFee" to "1"))}
  val wrapped=h.delivery(h.projected(result),"wallet_runMultiRoundMerge");yes(h.host.allowDelivery("view",h.scope,wrapped))
  rejects{h.delivery(result,"wallet_runMultiRoundMerge")};rejects{h.delivery(h.projected(result))}
  rejects{h.noop(result)};h.accounts.unlocked=false;yes(!h.host.allowDelivery("view",h.scope,text));yes(!h.host.allowDelivery("view",h.scope,wrapped))
 }
 for(change in listOf("above-target","negative","result","send-grant","account-grant","locked")){
  val h=Harness(sample);if(change!="account-grant")h.grant(change!="send-grant");h.consent=h.consent+mapOf("initialUtxoCount" to when(change){"above-target"->2;"negative"->-1;else->1})
  if(change=="locked")h.accounts.unlocked=false
  val result=h.noopResult()+if(change=="result")mapOf("approvalId" to "forged")else emptyMap()
  val shown=h.ui.shown;rejects{h.noop(result)};yes(h.ui.shown==shown&&h.signer.calls==0)
 }
 run{
  val h=Harness(sample);h.parent=PermissionJson.id("P4/rpc",h.scope["sessionId"]!!,"\"rpc-merge\"");h.ready();h.bind();val sent=h.signAndOwn()
  h.c.finishBroadcast("view",h.scope,h.id,h.receipt,sent);h.c.close("view",h.scope,h.id);val result=h.summary(sent);h.finish(result)
  val text=h.delivery(result);yes(h.host.allowDelivery("view",h.scope,text));h.c.disconnect("view",h.scope,"disconnect");yes(!h.host.allowDelivery("view",h.scope,text))
 }
 for(terminal in listOf("failed","uncertain")){
  val h=Harness(sample);h.ready();h.bind();if(terminal=="uncertain"){h.signAndOwn();h.status="unknown"};h.c.close("view",h.scope,h.id)
  val result=h.summary(null,terminal);rejects{h.finish(result+mapOf("status" to "complete","reason" to "target-reached"))}
  if(terminal=="uncertain")rejects{h.finish(result+mapOf("steps" to listOf(rows(result["steps"])[0]+mapOf("recoveryId" to "foreign"))))}
  h.finish(result);yes(h.c.mayDeliverMaintenanceResult("view",h.scope,"merge",hash(result)));h.accounts.revision++;yes(!h.c.mayDeliverMaintenanceResult("view",h.scope,"merge",hash(result)))
 }
 run{
  val h=Harness(sample);h.consent=h.consent+mapOf("initialUtxoCount" to h.inputs.size);h.ready();h.bind();val sent=h.signAndOwn();h.c.finishBroadcast("view",h.scope,h.id,h.receipt,sent)
  val result=h.summary(sent);rejects{h.finish(result)};h.c.close("view",h.scope,h.id);h.finish(result);yes(result["status"]=="complete");h.c.disconnect("view",h.scope,"disconnect");yes(!h.c.mayDeliverMaintenanceResult("view",h.scope,"merge",hash(result)))
 }
 for(maximum in listOf(1,3)){
  val h=Harness(sample);h.consent=h.consent+mapOf("limits" to (map(h.consent["limits"])+mapOf("maxTransactions" to maximum)))
  h.ready();h.bind();val result=h.signAndOwn();h.c.finishBroadcast("view",h.scope,h.id,h.receipt,result);h.c.close("view",h.scope,h.id)
  val txid=rows(result["transactions"])[0]["txid"] as String;h.id="next";h.inputs=listOf("$txid:0","c".repeat(64)+":0")
  h.prepare(2);h.step=h.step+mapOf("dependsOn" to listOf(txid));rejects{h.begin()}
  h.prepare(2,(100000-(result["totalFee"] as String).toInt()).toString());h.step=h.step+mapOf("dependsOn" to listOf(txid))
  if(maximum==1)rejects{h.begin()}else{h.begin();h.consentChild();rejects{h.bind()}}
  yes(h.ui.shown==2);h.c.closeMaintenance("view",h.scope,"merge")
 }
 for(change in listOf("recipient","fee")){val h=Harness(sample);h.ready();rejects{h.bind(change)};yes(h.signer.calls==0)}
 for(change in listOf("account","lock","navigation","revoke","parent-cancel","child-close")){
  val h=Harness(sample);h.ready();h.bind()
  when(change){"account"->h.accounts.revision++;"lock"->h.accounts.unlocked=false;"navigation"->h.c.invalidate("view");"revoke"->h.c.disconnect("view",h.scope,"disconnect");"parent-cancel"->h.c.cancel("view",h.scope,"merge");else->h.c.close("view",h.scope,h.id)}
  rejects{h.signAndOwn()};yes(h.signer.calls==0)
 }
 run{val h=Harness(sample);h.ready();h.bind();val result=h.signAndOwn();h.status="unknown";rejects{h.c.finishBroadcast("view",h.scope,h.id,h.receipt,result)};h.c.close("view",h.scope,h.id);h.id="next";h.prepare(2);rejects{h.begin()}}
 for(change in listOf("scope","expiry","transactions","fee","impact","field")){
  val h=Harness(sample);h.grant()
  h.consent=when(change){"scope"->h.consent+mapOf("authority" to (map(h.consent["authority"])+mapOf("origin" to "https://evil.invalid")))
   "impact"->h.consent+mapOf("impact" to mapOf("custody" to "other"));"field"->h.consent+mapOf("approved" to true)
   else->h.consent+mapOf("limits" to (map(h.consent["limits"])+when(change){"expiry"->mapOf("expiresAt" to stamp(-10));"transactions"->mapOf("maxTransactions" to 65);else->mapOf("maxTotalFee" to "2100000000000001")}))}
  rejects{h.approve()};yes(h.ui.shown==1)
 }
 for(change in listOf("intent","index","fee","dependency","inputs","field")){
  val h=Harness(sample);h.grant();h.approve();h.prepare()
  when(change){"intent"->{h.request=h.request+mapOf("intent" to mapOf("version" to "1.0","type" to "tbc.transfer","to" to h.account.address,"amount" to "1"));h.step=h.step+mapOf("materialHash" to hash(h.request))}
   "index"->h.prepare(2);"fee"->h.prepare(fee="100001");"dependency"->h.step=h.step+mapOf("dependsOn" to listOf("a".repeat(64)))
   "field"->{h.request=h.request+mapOf("approved" to true);h.step=h.step+mapOf("materialHash" to hash(h.request))};else->h.inputs=listOf(h.inputs[0],h.inputs[0])}
  rejects{h.begin()};yes(h.signer.calls==0&&h.ui.shown==2)
 }
 run{val h=Harness(sample,false);h.grant();rejects{h.approve()};yes(h.ui.shown==1)}
 run{val h=Harness(sample);h.grant(false);rejects{h.approve()};yes(h.ui.shown==1)}
 run{val h=Harness(sample);h.grant();rejects{h.approve(false)};yes(h.ui.shown==2)}
 println(PermissionJson.canonical(mapOf("status" to "NATIVE_MAINTENANCE_PASS","checks" to checks,"cases" to cases.size,"signatureReplays" to signatures,"broadcasts" to 0)))
}
