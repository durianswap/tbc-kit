package io.tbc.kit.dart

import org.json.JSONObject
import java.security.MessageDigest

/** Private Flutter channel owner, never a page handler. All calls and callbacks
 * use NativeCustody's executor. It owns no key, HTTP client or business builder.
 * Wire this same instance to verified navigation and actual WebView delivery.
 */
class NativeWalletHost(private val custody:NativeCustody,
 private val authorityChanged:(String,Map<String,String>,NativeWalletSnapshot)->Unit) {
 val walletProtocol get()=custody.walletProtocol
 private data class Stamp(val scope:Map<String,String>,val revision:Int,val accountRevision:Long,
  val account:NativeAccount,val unlocked:Boolean)
 private data class Committed(val stamp:Stamp,val method:String,val resultHash:String,val eventsHash:String?=null,val current:(()->Unit)?=null)
 private data class Frame(val stamp:Stamp,val method:String,val operation:String,
  val resultHash:String,val error:Boolean)
 private val committed=mutableMapOf<String,MutableMap<String,Committed>>()
 private val frames=mutableMapOf<String,MutableMap<String,Frame>>()
 private val documents=mutableMapOf<String,Map<String,String>>()
 private var broadcastHandler:((String,Map<String,Any?>,(Map<String,Any?>)->Unit)->Unit)?=null
 private var networkEvents:((String,Map<String,String>)->List<Map<String,Any?>>)?=null
 fun installNetworkEvents(read:(String,Map<String,String>)->List<Map<String,Any?>>){need(networkEvents==null);networkEvents=read}
 // Native-only registration; private dispatch cannot inject a result/check.
 // This cannot certify a signature, crypto result or submitted transaction.
 fun rememberNetworkResult(owner:String,scope:Map<String,String>,operation:String,method:String,result:Any?,events:List<Map<String,Any?>>,current:()->Unit){
  need(method in setOf("tbc_switchChain","wallet_getPermissions","tbc_getCapabilities","tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect"))
  current();val s=custody.snapshot(owner,scope);control(owner,scope,operation,method,result,s)
  committed.getValue(owner)[operation]=Committed(stamp(scope,s),method,hash(result),hash(events),current)
 }
 fun networkCapabilities(owner:String,scope:Map<String,String>):Map<String,Any?>{
  val result=capabilities(custody.snapshot(owner,scope));val methods=map(result["methods"])
  return result+mapOf("methods" to (methods+mapOf("tbc_switchChain" to "1.0")))
 }
 fun installBroadcast(handler:(String,Map<String,Any?>,(Map<String,Any?>)->Unit)->Unit){need(broadcastHandler==null);custody.registerBroadcast();broadcastHandler=handler}
 fun navigation(owner:String,scope:Map<String,String>){custody.navigation(owner,scope);forget(owner);documents[owner]=scope.toMap()}
 fun invalidate(owner:String){custody.invalidate(owner);forget(owner);documents.remove(owner)}
 fun fenceDocument(owner:String){custody.fenceDocument(owner);forget(owner)}
 fun accountChanged(){custody.accountChanged();committed.clear();frames.clear();notifyChanges(null)}
 private fun forget(owner:String){committed.remove(owner);frames.remove(owner)}
 private fun notifyChanges(origin:String?,exceptOwner:String?=null){
  for((owner,scope)in documents.toMap())if(owner!=exceptOwner&&(origin==null||scope["origin"]==origin)){
   // Callback failure is not authorization; native fences have already run.
   runCatching{authorityChanged(owner,scope,custody.snapshot(owner,scope))}
  }
 }
 private fun need(value:Boolean){if(!value)throw NativeCustodyFailure("NATIVE_DENIED")}
 private fun map(value:Any?):Map<String,Any?>{
  val m=value as? Map<*,*>?:throw NativeCustodyFailure("NATIVE_DENIED");need(m.keys.all{it is String})
  return m.entries.associate{it.key as String to it.value}
 }
 private fun scope(value:Any?):Map<String,String>{val m=map(value);need(m.values.all{it is String});return m.mapValues{it.value as String}}
 private fun stamp(scope:Map<String,String>,s:NativeWalletSnapshot)=Stamp(scope.toMap(),s.revision,s.accountRevision,s.account,s.unlocked)
 private fun same(a:Stamp,scope:Map<String,String>,s:NativeWalletSnapshot)=a==stamp(scope,s)
 fun snapshotWire(s:NativeWalletSnapshot)=mapOf("account" to s.account.identity(),"revision" to s.revision,
  "accountRevision" to s.accountRevision,"unlocked" to s.unlocked,"permissions" to s.permissions,"connectedAccounts" to s.connectedAccounts.map{it.identity()},"optionalMethods" to s.optionalMethods)
 private fun has(s:NativeWalletSnapshot,name:String)=s.unlocked&&s.permissions.any{it["parentCapability"]==name}
 private fun addresses(s:NativeWalletSnapshot)=if(has(s,"tbc_accounts"))s.connectedAccounts.map{it.address}else emptyList<String>()
 private fun publicPermissions(s:NativeWalletSnapshot)=if(s.unlocked)s.permissions else emptyList()
 private fun events(s:NativeWalletSnapshot)=listOf(mapOf("name" to "permissionsChanged","payload" to publicPermissions(s)),mapOf("name" to "accountsChanged","payload" to addresses(s)))
 private fun canonical(value:Any?)=PermissionJson.canonical(value)
 private fun hash(value:Any?)=textHash(canonical(value))
 private fun textHash(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
 private fun operation(scope:Map<String,String>,requestId:Any?):String{
  need(requestId is String||requestId is Int||requestId is Long)
  if(requestId is Long)need(requestId in -9007199254740991L..9007199254740991L)
  return PermissionJson.id("P4/rpc",scope.getValue("sessionId"),canonical(requestId))
 }
 private fun capabilities(s:NativeWalletSnapshot)=mapOf("standard" to "1.0.0","provider" to "1.0.0","chainId" to s.account.chainId,
  "methods" to (listOf("tbc_chainId","tbc_accounts","tbc_requestAccounts","tbc_getAccount","tbc_getCapabilities","wallet_getPermissions","wallet_requestPermissions","tbc_disconnect","tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_signPreparedTransaction","tbc_signWorkflow","tbc_signPreparedWorkflow")+(if(custody.supportsReviewed)listOf(NativeReviewed.method)else emptyList())+s.optionalMethods).associateWith{"1.0"},
  "intents" to mapOf("tbc-lop-create" to listOf("1.0"),"tbc-lop-cancel" to listOf("1.0"),"tbc-lop-match" to listOf("1.0"),"tbc-htlc-lock" to listOf("1.0"),"tbc-htlc-claim" to listOf("1.0"),"tbc-htlc-refund" to listOf("1.0"),"tbc-timelock-lock" to listOf("1.0"),"tbc-timelock-unlock" to listOf("1.0"),"amm.swap" to listOf("1.0"),"amm.addLiquidity" to listOf("1.0"),"amm.removeLiquidity" to listOf("1.0"),"amm.mergeToken" to listOf("1.0"),"tbc20Lp.transfer" to listOf("1.0"),"tbc20Lp.lock" to listOf("1.0"),"tbc20Lp.unlock" to listOf("1.0"),"tbc20Lp.merge" to listOf("1.0"),"tbc20Lp.burn" to listOf("1.0"),"tbc20.transfer" to listOf("1.0"),"tbc20.merge" to listOf("1.0"),"tbc20-standard-create" to listOf("1.0"),"tbc721-standard-create-collection" to listOf("1.0"),"tbc721-standard-mint" to listOf("1.0"),"tbc721-standard-batch-mint" to listOf("1.0"),"tbc-amm-create" to listOf("1.0"),"tbc-amm-add-liquidity" to listOf("1.0"),"tbc-amm-remove-liquidity" to listOf("1.0"),"tbc-amm-swap" to listOf("1.0"),"tbc20-lp-transfer" to listOf("1.0"),"tbc20-lp-merge" to listOf("1.0"),"tbc20-lp-lock" to listOf("1.0"),"tbc20-lp-unlock" to listOf("1.0"),"tbc.pool.swap.exactTbcForToken" to listOf("1.0"),"tbc.pool.swap.exactTokenForTbc" to listOf("1.0"),"tbc.pool.liquidity.add" to listOf("1.0"),"tbc.pool.liquidity.remove" to listOf("1.0"),"tbc.pool.ft.merge" to listOf("1.0"),"tbc.pool.ftlp.merge" to listOf("1.0"),"tbc.pool.ftlp.burn" to listOf("1.0"),"tbc721.transfer" to listOf("1.0"),"tbc20Stablecoin.transfer" to listOf("1.0"),"tbc20Stablecoin.merge" to listOf("1.0"),"tbc.transfer" to listOf("1.0"),"tbc.maintenance.merge" to listOf("1.0")),"limits" to mapOf("workflowSteps" to 5,"transactionBundleSize" to 32),"profiles" to listOf("transport:webview"))
 private fun readResult(method:String,s:NativeWalletSnapshot):Any?=when(method){
  "tbc_chainId"->s.account.chainId
  "tbc_accounts"->addresses(s)
  "wallet_getPermissions"->publicPermissions(s)
  "tbc_getAccount"->{need(has(s,"tbc_accounts")&&has(s,"tbc_accountMetadata"));s.account.identity()+mapOf("features" to listOf("tbc:provider"))}
  "tbc_getCapabilities"->capabilities(s)
  else->throw NativeCustodyFailure("NATIVE_DENIED")
 }
 private fun control(owner:String,scope:Map<String,String>,id:String,method:String,value:Any?,s:NativeWalletSnapshot){
  val book=committed.getOrPut(owner){mutableMapOf()};need(book.size<128||id in book)
  book[id]=Committed(stamp(scope,s),method,hash(value))
 }
 // Informational trusted-API result, never signing/approval/spendability proof.
 // Canonical value is bound to this native account and fenced again at release.
 private fun validateBalance(value:Any?,s:NativeWalletSnapshot){
  val r=map(value);val atomic=r["balanceAtomic"] as? String?:throw NativeCustodyFailure("NATIVE_DENIED")
  need(walletProtocol==NativeWalletProtocol.LEGACY&&has(s,"tbc_accounts")&&
   r.keys==setOf("chainId","address","balanceAtomic","decimals")&&
   r["chainId"]==s.account.chainId&&r["address"]==s.account.address&&
   s.account.address in addresses(s)&&canonical(r["decimals"])=="6"&&
   Regex("^(0|[1-9][0-9]{0,15})$").matches(atomic))
  need((atomic.toLongOrNull()?:throw NativeCustodyFailure("NATIVE_DENIED"))<=9007199254740991L)
 }
 private fun validResult(owner:String,scope:Map<String,String>,f:Frame,s:NativeWalletSnapshot):Boolean{
  if(f.error)return true // Scope is always checked; errors grant no authority.
  if(!same(f.stamp,scope,s))return false
  val projected=committed[owner]?.get(f.operation)
  if(projected?.current!=null){projected.current.invoke();return projected.method==f.method&&projected.resultHash==f.resultHash&&same(projected.stamp,scope,s)}
  return when(f.method){
   "wallet_mergeMaintenance","wallet_runMultiRoundMerge"->custody.mayDeliverMaintenanceResult(owner,scope,f.operation,f.resultHash)
   "wallet_readBalance"->walletProtocol==NativeWalletProtocol.LEGACY&&has(s,"tbc_accounts")&&s.account.address in addresses(s)
   "tbc_getAccount"->has(s,"tbc_accounts")&&has(s,"tbc_accountMetadata")&&s.connectedAccounts.any{a->
    val granted=s.permissions.any{p->p["parentCapability"]=="tbc_accountMetadata"&&(p["caveats"] as List<*>).any{val c=it as Map<*,*>;c["type"]=="restrictAccounts"&&a.accountId in (c["value"] as List<*>)}}
    granted&&hash(a.identity()+mapOf("features" to listOf("tbc:provider")))==f.resultHash
   }
   "tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_signPreparedTransaction","tbc_signReviewedTransaction"->custody.mayDeliverSignature(owner,scope,f.operation)
   "tbc_encrypt","tbc_decrypt"->custody.mayDeliverCryptoResult(owner,scope,f.operation,f.method,f.resultHash)
   "tbc_signWorkflow","tbc_signPreparedWorkflow"->custody.mayDeliverWorkflowResult(owner,scope,f.operation,f.method,f.resultHash)
   "tbc_sendTransaction","tbc_sendPreparedTransaction","tbc_sendWorkflow","tbc_sendPreparedWorkflow"->custody.mayDeliverSendResult(owner,scope,f.operation,f.method,f.resultHash)
   "tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect"->{
    val c=committed[owner]?.get(f.operation)
    c!=null&&c.method==f.method&&c.resultHash==f.resultHash&&same(c.stamp,scope,s)
   }
   else->hash(readResult(f.method,s))==f.resultHash
  }
 }
 private fun prepareDelivery(owner:String,scope:Map<String,String>,method:String,id:Any?,text:String){
  val s=custody.snapshot(owner,scope);need(text.toByteArray(Charsets.UTF_8).size<=4*1024*1024)
  val m=map(PermissionJson.decode(JSONObject(text)));need(canonical(m)==text)
  need(m.keys==setOf("channel","type","sessionId","navigationId","messageId","deliveryId","response","events"))
  need(m["channel"]==walletProtocol.wireChannel&&m["type"]=="delivery"&&m["sessionId"]==scope["sessionId"]&&m["navigationId"]==scope["navigationId"])
  need(m["deliveryId"]==hash(mapOf("response" to m["response"],"events" to m["events"])))
  val response=map(m["response"]);val error=response.containsKey("error")
  need(response.keys==setOf("jsonrpc","id",if(error)"error" else "result")&&response["jsonrpc"]=="2.0"&&canonical(response["id"])==canonical(id))
  val emitted=m["events"] as? List<*>?:throw NativeCustodyFailure("NATIVE_DENIED")
  if(error){
   val e=map(response["error"]);need(e.keys==setOf("code","message")&&emitted.isEmpty())
    val expected=mapOf(4001 to setOf("Request rejected"),4100 to setOf("Unauthorized","Authorization changed"),4200 to setOf("Unsupported method or profile"),4901 to setOf("Unsupported chain"),-32602 to setOf("Invalid parameters"),-32603 to setOf("Wallet operation unavailable"))
   need(e["code"] is Int&&e["message"] in (expected[e["code"] as Int]?:emptySet()))
  }else if(committed[owner]?.get(operation(scope,id))?.eventsHash!=null){
   val projected=committed.getValue(owner).getValue(operation(scope,id))
   need(projected.method==method&&hash(emitted)==projected.eventsHash)
  }else if(emitted.isNotEmpty()){
   need(method in setOf("tbc_requestAccounts","wallet_requestPermissions","tbc_disconnect")&&canonical(emitted)==canonical(events(s)))
  }
  if(!error&&method=="wallet_readBalance")validateBalance(response["result"],s)
  val resultHash=if(error)"" else if(method=="wallet_runMultiRoundMerge")custody.maintenanceProjectionHash(owner,scope,operation(scope,id),response["result"]) else hash(response["result"])
  val frame=Frame(stamp(scope,s),method,operation(scope,id),resultHash,error)
  need(validResult(owner,scope,frame,s))
  val book=frames.getOrPut(owner){mutableMapOf()};val digest=textHash(text)
  need(book.size<256||digest in book);book[digest]=frame
 }
 // Call immediately before the native evaluateJavaScript / WebMessage release,
 // on this executor with no intervening await. Not merely in a Dart callback.
 fun allowDelivery(owner:String,scope:Map<String,String>,text:String):Boolean=try{
  val s=custody.snapshot(owner,scope);need(text.toByteArray(Charsets.UTF_8).size<=4*1024*1024)
  val frame=frames[owner]?.get(textHash(text))
  if(frame!=null){need(frame.stamp.scope==scope);validResult(owner,scope,frame,s)}else{
   val m=map(PermissionJson.decode(JSONObject(text)))
   need(canonical(m)==text&&m["channel"]==walletProtocol.wireChannel&&m["sessionId"]==scope["sessionId"]&&m["navigationId"]==scope["navigationId"])
   if(m["type"]=="event"){
    need(m.keys==setOf("channel","type","sessionId","navigationId","messageId","event"))
    (networkEvents?.invoke(owner,scope)?:events(s)).any{canonical(it)==canonical(m["event"])}
   }else{
    need(m.keys==setOf("channel","type","sessionId","navigationId","messageId","origin","chainId"))
    m["type"]=="initialize"&&m["origin"]==scope["origin"]&&m["chainId"]==s.account.chainId
   }
  }
 }catch(_:Exception){false}

 /** One fixed private result envelope. No native exception text/details escape.
  * The Flutter shim only transports this; it implements no wallet business logic.
  */
 fun dispatch(method:String,input:Any?,reply:(Map<String,Any?>)->Unit){
  var done=false
  fun send(value:Any?,snapshot:NativeWalletSnapshot?=null){if(!done){done=true;reply(mapOf("ok" to true,"value" to value)+if(snapshot==null)emptyMap()else mapOf("snapshot" to snapshotWire(snapshot)))}}
  fun fail(error:Throwable){if(!done){done=true
   val code=if(method=="signing.sign"&&error is NativeWorkflowStepUnavailable) "NATIVE_WORKFLOW_STEP_UNAVAILABLE" else if(method=="signing.crypto"&&error is NativeWorkflowCryptoUnavailable) "NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE" else if((error as? NativeCustodyFailure)?.code=="USER_REJECTED") "USER_REJECTED" else "NATIVE_DENIED"
   reply(mapOf("ok" to false,"code" to code))
  }}
  try{
   val a=map(input);val owner=a["ownerId"] as String;val scope=scope(a["scope"])
   fun keys(vararg fields:String){need(a.keys==setOf("ownerId","scope",*fields))}
   fun id()=a["operation"] as String
   when(method){
    "snapshot"->{keys();send(snapshotWire(custody.snapshot(owner,scope)))}
    "permissions.request"->{
     keys("operation","permissions","providerMethod")
     val provider=a["providerMethod"] as String;need(provider in setOf("tbc_requestAccounts","wallet_requestPermissions"))
     custody.requestPermissions(owner,scope,id(),map(a["permissions"])){r->try{
      val granted=r.getOrThrow();val s=custody.snapshot(owner,scope)
      control(owner,scope,id(),provider,if(provider=="tbc_requestAccounts")addresses(s)else granted,s)
      notifyChanges(scope["origin"],owner);send(granted,s)
     }catch(e:Exception){fail(e)}}
    }
    "permissions.disconnect"->{keys("operation");custody.disconnect(owner,scope,id());val s=custody.snapshot(owner,scope);control(owner,scope,id(),"tbc_disconnect",null,s);notifyChanges(scope["origin"],owner);send(null,s)}
    "signing.begin"->{
     keys("operation","method","revision","account");val account=map(a["account"])
     val selected=NativeAccount(account["address"] as String,account["publicKey"] as String,account["chainId"] as String)
     need(account==selected.identity()&&(a["revision"] is Int||a["revision"] is Long));val revision=(a["revision"] as Number).toLong();need(revision in 0..Int.MAX_VALUE.toLong())
     send(snapshotWire(custody.begin(owner,scope,id(),a["method"] as String,revision.toInt(),selected)))
    }
    "signing.check"->{keys("operation");custody.check(owner,scope,id());send(true)}
    "maintenance.begin","maintenance.noop"->{
     if(method=="maintenance.noop")keys("operation","revision","account","consent","result")else keys("operation","revision","account","consent");val account=map(a["account"])
     val selected=NativeAccount(account["address"] as String,account["publicKey"] as String,account["chainId"] as String)
     val revision=canonical(a["revision"]).toIntOrNull();need(account==selected.identity()&&revision!=null&&revision>=0)
     custody.beginMaintenance(owner,scope,id(),revision!!,selected,map(a["consent"]),if(method=="maintenance.noop")map(a["result"])else null){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}
    }
    "maintenance.step"->{keys("operation","parent","step","request","selectedInputs");send(snapshotWire(custody.beginMaintenanceStep(owner,scope,a["parent"] as String,id(),map(a["step"]),map(a["request"]),(a["selectedInputs"] as List<*>).map{it as String})))}
    "maintenance.finish"->{keys("operation","result");custody.finishMaintenance(owner,scope,id(),map(a["result"]));send(true)}
    "maintenance.close"->{keys("operation");custody.closeMaintenance(owner,scope,id());send(true)}
    "signing.roles"->{keys("operation","request","context");send(custody.resolveSigningAccounts(owner,scope,id(),map(a["request"]),map(a["context"])))}
    "signing.consent"->{
     if(a.containsKey("review"))keys("operation","method","request","context","review")else keys("operation","method","request","context")
     custody.consentReviewed(owner,scope,id(),a["method"] as String,map(a["request"]),map(a["context"]),a["review"]?.let{map(it)}){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}
    }
    "signing.bind"->{
     if(map(map(a["binding"])["payload"])["method"] in NativeWorkflow.methods){
      keys("operation","binding","preview","plan","envelope");need(a["envelope"]==null)
      custody.bindWorkflow(owner,scope,id(),map(a["binding"]),map(a["preview"]),map(a["plan"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}
     }else if(a.containsKey("reviewed")){
      keys("operation","binding","preview","plan","envelope","reviewed");need(a["envelope"]==null)
      custody.bindReviewed(owner,scope,id(),map(a["binding"]),map(a["preview"]),map(a["plan"]),map(a["reviewed"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}
     }else{keys("operation","binding","preview","plan","envelope");send(custody.bind(owner,scope,id(),map(a["binding"]),map(a["preview"]),a["plan"]?.let{map(it)},a["envelope"]?.let{map(it)}))}
    }
    "signing.workflow.enter"->{keys("operation","receipt","entry");custody.enterWorkflowStep(owner,scope,id(),map(a["receipt"]),map(a["entry"]));send(true)}
    "signing.workflow.finish"->{keys("operation","receipt","outcome");custody.finishWorkflowStep(owner,scope,id(),map(a["receipt"]),map(a["outcome"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}}
    "signing.advance"->{
     keys("operation","receipt","pending")
     if(map(a["pending"])["kind"]=="reviewed")custody.advanceReviewed(owner,scope,id(),map(a["receipt"]),map(a["pending"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}
     else{custody.advance(owner,scope,id(),map(a["receipt"]),map(a["pending"]));send(true)}
    }
    "signing.sign"->{keys("operation","receipt","task");custody.sign(owner,scope,id(),map(a["receipt"]),map(a["task"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}}
    "signing.crypto"->{keys("operation","receipt","task");custody.executeCrypto(owner,scope,id(),map(a["receipt"]),map(a["task"])){r->try{send(r.getOrThrow())}catch(e:Exception){fail(e)}}}
    "signing.broadcast.authorize"->{keys("operation","receipt","bundle","workflow");custody.authorizeBroadcast(owner,scope,id(),map(a["receipt"]),map(a["bundle"]),a["workflow"]?.let{map(it)});send(true)}
    "signing.broadcast.finish"->{keys("operation","receipt","result");custody.finishBroadcast(owner,scope,id(),map(a["receipt"]),map(a["result"]));send(true)}
    "signing.broadcast.open","signing.broadcast.guard","signing.broadcast.journal","signing.broadcast.wire"->{
     val handler=broadcastHandler?:throw NativeCustodyFailure("NATIVE_DENIED")
     handler(method,a){value->if(!done){done=true;reply(value)}}
    }
    "signing.close"->{keys("operation");custody.close(owner,scope,id());send(null)}
    "operation.cancel"->{keys("operation");custody.cancel(owner,scope,id());send(null)}
    "document.invalidate"->{keys();custody.snapshot(owner,scope);invalidate(owner);send(null)}
    "delivery.prepare"->{keys("method","requestId","serialized");prepareDelivery(owner,scope,a["method"] as String,a["requestId"],a["serialized"] as String);send(true)}
    "delivery.acknowledge"->{
     keys("requestId");custody.snapshot(owner,scope);val op=operation(scope,a["requestId"])
     need(frames[owner]?.values?.any{it.operation==op&&it.stamp.scope==scope}==true)
     custody.forgetResult(owner,scope,op);committed[owner]?.remove(op)
     frames[owner]?.entries?.removeAll{it.value.operation==op};send(true)
    }
    else->throw NativeCustodyFailure("NATIVE_DENIED")
   }
  }catch(e:Exception){fail(e)}
 }
}
