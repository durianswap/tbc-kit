package io.tbc.kit.dart
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONObject
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray()).joinToString(""){"%02x".format(it.toInt()and 255)}
private var checks=0
private fun yes(v:Boolean){check(v){"crypto check ${checks+1}"};checks++}
private fun rejects(f:()->Unit){var rejected=false;try{f()}catch(_:Exception){rejected=true};yes(rejected)}
private class Accounts(override var current:NativeAccount):NativeAccountSource{override var revision=0L;override var unlocked=true}
private class Store:NativePermissionBackend{
 val rows=mutableMapOf<String,PermissionSnapshot>();var writes=0
 override fun loadAll()=rows.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();check((rows[origin]?.revision?:0)==expected);val s=PermissionSnapshot(expected+1,records);rows[origin]=s;writes++;return PermissionCommitResult(s.revision,s)
 }
}
private class UI:NativeApprovalPresenter{
 var pending:((Boolean)->Unit)?=null;var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{shown++;pending=complete;return {pending=null}}
 fun choose(value:Boolean=true){val f=pending!!;pending=null;f(value)}
}
private class Digest:NativeDigestSigner{override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){error("crypto used digest signer")}}
private class Vault(sample:Map<String,Any?>,val account:NativeAccount):NativeBie1Executor{
 val audit=map(sample["audit"]);val expected=NativeCrypto.input(map(audit["task"]));val value=map(audit["cryptoResult"])
 val output=Base64.getDecoder().decode((value["ciphertext"]?:map(value["message"])["data"]) as String)
 var calls=0;var used=0;var hold=false;var fail=false;var release:(()->Unit)?=null;var afterUse:(()->Unit)?=null
 override fun execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:ByteArray,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  calls++;val work={complete(runCatching{requireCurrent();check(account==this.account&&input.contentEquals(expected));if(fail)error("OPAQUE_CRYPTO_FAILURE");used++;afterUse?.invoke();output.copyOf()});Unit}
  if(hold)release=work else work()
 }
}
private class Harness(val sample:Map<String,Any?>,enabled:Boolean=true){
 val account=map(sample["account"]).let{NativeAccount(it["address"] as String,it["publicKey"] as String,it["chainId"] as String)}
 val accounts=Accounts(account);val store=Store();val ui=UI();val vault=Vault(sample,account)
 val context=map(sample["context"]);val request=map(sample["request"]);val audit=map(sample["audit"]);val method=sample["method"] as String
 val scope=context.filterKeys{it!="transport"}.mapValues{it.value as String}+mapOf("webViewInstanceId" to "crypto-test","committedUrl" to "${context["origin"]}/dapp")
 var document:Map<String,String>?=scope
 val id=PermissionJson.id("P4/rpc",scope.getValue("sessionId"),PermissionJson.canonical("crypto-request"))
 val custody=NativeCustody(accounts,account.chainId,store,ui,Digest(),crypto=if(enabled)vault else null){_,s->document==s}
 init{custody.navigation("view",scope)}
 fun grant(crypto:Boolean=true){
  var result:Result<List<Map<String,Any?>>>?=null
  val request=mutableMapOf<String,Any?>("tbc_accounts" to mapOf("chains" to listOf(account.chainId)))
  if(crypto)request["tbc_crypto"]=mapOf("chains" to listOf(account.chainId))
  custody.requestPermissions("view",scope,"grant",request){result=it};ui.choose();result!!.getOrThrow()
 }
 fun begin(){custody.begin("view",scope,id,method,custody.snapshot("view",scope).revision,account)}
 fun consent(approve:Boolean=true){var result:Result<Boolean>?=null;custody.consentReviewed("view",scope,id,method,request,context,null){result=it};ui.choose(approve);yes(result!!.getOrThrow()==approve)}
 fun bind(plan:Map<String,Any?> = map(audit["plan"]))=custody.bind("view",scope,id,map(audit["binding"]),map(audit["preview"]),plan,null)
 fun ready():Map<String,Any?>{grant();begin();consent();return bind()}
 fun run(receipt:Map<String,Any?>,task:Map<String,Any?> = map(audit["task"]),complete:(Result<Map<String,Any?>>)->Unit){custody.executeCrypto("view",scope,id,receipt,task,complete)}
}
private fun hostCheck(sample:Map<String,Any?>,fail:Boolean=false){
 val h=Harness(sample);val host=NativeWalletHost(h.custody){_,_,_->};host.navigation("view",h.scope)
 val receipt=h.ready()
 fun call(method:String,fields:Map<String,Any?>):Map<String,Any?>{
  var reply:Map<String,Any?>?=null;host.dispatch(method,mapOf("ownerId" to "view","scope" to h.scope)+fields){reply=it};return reply!!
 }
 fun delivery(result:Any?):String{
  val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to "crypto-request","result" to result),"events" to emptyList<Any>())
  return PermissionJson.canonical(mapOf("channel" to "tws-webview/1","type" to "delivery","sessionId" to h.scope["sessionId"],"navigationId" to h.scope["navigationId"],"messageId" to "crypto-host","deliveryId" to hash(payload))+payload)
 }
 fun prepare(text:String,method:String=h.method)=call("delivery.prepare",mapOf("method" to method,"requestId" to "crypto-request","serialized" to text))["ok"]==true
 fun allow(text:String)=host.allowDelivery("view",h.scope,text)
 val text=delivery(sample["result"]);yes(!prepare(text)&&!allow(text));h.vault.fail=fail
 val reply=call("signing.crypto",mapOf("operation" to h.id,"receipt" to receipt,"task" to h.audit["task"]))
 if(fail){yes(reply==mapOf("ok" to false,"code" to "NATIVE_DENIED"));yes(!prepare(text)&&!allow(text));return}
 yes(reply["ok"]==true&&PermissionJson.canonical(reply["value"])==PermissionJson.canonical(h.audit["cryptoResult"]))
 yes(call("signing.close",mapOf("operation" to h.id))["ok"]==true)
 yes(!allow(text));yes(prepare(text)&&allow(text))
 val altered=delivery(map(sample["result"])+mapOf("from" to "other-account"));yes(!prepare(altered)&&!allow(altered))
 yes(!prepare(text,if(h.method=="tbc_encrypt")"tbc_decrypt" else "tbc_encrypt"))
 h.accounts.unlocked=false;yes(!allow(text))
}
fun main(args:Array<String>){
 val root=map(PermissionJson.decode(JSONObject(File(args[0]).readText())));val original=(root["original"] as List<*>).map{map(it)};val cases=(root["fresh"] as List<*>).map{map(it)}
 for(s in original){
  val h=Harness(s);val p=NativeCrypto.plan(h.request,h.method,h.context,h.account,map(map(h.audit["plan"])["payload"])["expiresAt"] as String)
  yes(PermissionJson.canonical(p)==PermissionJson.canonical(h.audit["plan"]))
  yes(PermissionJson.canonical(NativeCrypto.bound(h.request,h.method,h.context,h.account,map(h.audit["binding"]),p,map(h.audit["preview"])))==PermissionJson.canonical(h.audit["task"]))
 }
 for(s in cases){
  val h=Harness(s);val r=h.ready();var result:Result<Map<String,Any?>>?=null
  h.run(r){result=it};val value=result!!.getOrThrow()
  yes(PermissionJson.canonical(value)==PermissionJson.canonical(h.audit["cryptoResult"]));yes(h.ui.shown==2&&h.vault.used==1&&h.store.writes==1)
  rejects{h.run(r){}};h.custody.close("view",h.scope,h.id);val digest=hash(s["result"])
  yes(h.custody.mayDeliverCryptoResult("view",h.scope,h.id,h.method,digest))
  yes(!h.custody.mayDeliverCryptoResult("view",h.scope,h.id,h.method,"0".repeat(64)))
  yes(!h.custody.mayDeliverSignature("view",h.scope,h.id))
  h.accounts.unlocked=false;yes(!h.custody.mayDeliverCryptoResult("view",h.scope,h.id,h.method,digest))
 }
 hostCheck(cases[0]);hostCheck(cases[1]);hostCheck(cases[1],true)
 val sample=cases[0]
 run {
  val h=Harness(sample);val task=map(h.audit["task"])
  for((text,allowed) in listOf(("中".repeat(21845)+"a") to true,"😀".repeat(16384) to true,"中".repeat(21846) to false,"😀".repeat(16385) to false)){
   val t=task+mapOf("message" to mapOf("encoding" to "utf8","data" to text))
   if(allowed)yes(NativeCrypto.input(t).size==65536)else rejects{NativeCrypto.input(t)}
  }
  for((encoding,data) in listOf("hex" to "01".repeat(65536),"base64" to java.util.Base64.getEncoder().encodeToString(ByteArray(65536){1}))) {
   yes(NativeCrypto.input(task+mapOf("message" to mapOf("encoding" to encoding,"data" to data))).size==65536)
  }
  val t=task+mapOf("purpose" to "decrypt");val old="中".repeat(24000)
  val value=NativeCrypto.result(t,old.toByteArray(Charsets.UTF_8))
  yes(map(value["message"])==mapOf("encoding" to "utf8","data" to old))
  rejects{NativeCrypto.result(t,ByteArray(72000){255.toByte()})}
  rejects{NativeCrypto.result(t,ByteArray(65539){97})}
  yes(map(NativeCrypto.result(t,"中".toByteArray(Charsets.UTF_8))["message"])["encoding"]=="base64")
 }
 run{val h=Harness(sample,false);yes(h.custody.snapshot("view",h.scope).optionalMethods.isEmpty());rejects{h.grant()};h.grant(false);rejects{h.begin()};yes(h.vault.calls==0)}
 run{val h=Harness(sample);yes(h.custody.snapshot("view",h.scope).optionalMethods.toSet()==NativeCrypto.methods)}
 run{val h=Harness(sample);h.grant(false);rejects{h.begin()};yes(h.vault.calls==0)}
 run{val h=Harness(sample);h.grant();h.begin();h.consent(false);rejects{h.bind()};yes(h.vault.calls==0)}
 run{val h=Harness(sample);val r=h.ready();val t=map(h.audit["task"])+mapOf("origin" to "https://other.example");rejects{h.run(r,t){}};yes(h.vault.calls==0)}
 run{val h=Harness(sample);h.grant();h.begin();h.consent();val p=map(h.audit["plan"]);val body=map(p["payload"]);val changed=body+mapOf("task" to (map(body["task"])+mapOf("publicKey" to "other")));rejects{h.bind(mapOf("payload" to changed,"planHash" to hash(changed)))};yes(h.vault.calls==0)}
 for(mode in listOf("lock-before","lock-after","navigation","failure")){
  val h=Harness(sample);val r=h.ready();var result:Result<Map<String,Any?>>?=null;var count=0
  h.vault.hold=true;h.run(r){result=it;count++};yes(result==null)
  if(mode=="lock-before")h.accounts.unlocked=false
  if(mode=="lock-after")h.vault.afterUse={h.accounts.unlocked=false}
  if(mode=="navigation"){h.document=null;h.custody.invalidate("view")}
  if(mode=="failure")h.vault.fail=true
  h.vault.release!!();yes(result!=null);rejects{result!!.getOrThrow()};yes(count==1&&h.vault.used==if(mode=="lock-after")1 else 0)
  yes(!h.custody.mayDeliverCryptoResult("view",h.scope,h.id,h.method,hash(sample["result"])))
 }
 println("{\"status\":\"PASS\",\"cases\":${cases.size},\"checks\":$checks,\"proof\":\"native-custody-public-replay\",\"broadcasts\":0}")
}
