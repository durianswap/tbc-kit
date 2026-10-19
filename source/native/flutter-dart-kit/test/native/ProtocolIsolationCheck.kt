package io.tbc.kit.dart

// Actual native custody on JVM with a typed memory store. Android system SQLite
// and Flutter delivery require separate installed-device proof.
private class ProtocolAccounts(chain:String="tbc:testnet"):NativeAccountSource{
 override val current=NativeAccount("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH","0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",chain)
 override var revision=0L;override var unlocked=true
}
private class ProtocolStore(override val walletProtocol:NativeWalletProtocol):NativePermissionGroupBackend{
 val data=mutableMapOf<String,PermissionSnapshot>();val commits=mutableMapOf<String,Pair<String,Long>>()
 override fun loadAll()=data.toMap()
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();val before=data[origin]?:PermissionSnapshot(0,emptyList())
  commits[callId]?.let{check(it.first==meaning);fence();return PermissionCommitResult(it.second,before)}
  check(before.revision==expected);fence();val next=PermissionSnapshot(expected+1,records)
  data[origin]=next;commits[callId]=meaning to next.revision;return PermissionCommitResult(next.revision,next)
 }
 // A permissive custom adapter must not defeat Kit's protocol group boundary.
 override fun acceptsGroup(backends:List<NativePermissionBackend>)=true
 override fun commitGroup(mutations:List<NativePermissionMutation>,fence:()->Unit):Map<String,PermissionCommitResult> = error("MUST_NOT_COMMIT_MIXED_GROUP")
}
private class ProtocolUi:NativeApprovalPresenter{
 val pending=mutableMapOf<String,(Boolean)->Unit>();val reviews=mutableMapOf<String,NativeReview>();var shown=0
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit{
  check(pending.put(review.operationId,complete)==null);reviews[review.operationId]=review;shown++
  return{pending.remove(review.operationId);Unit}
 }
 fun choose(id:String,yes:Boolean=true){pending.remove(id)!!(yes)}
}
private class NoProtocolSigner:NativeDigestSigner{
 var calls=0
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){calls++;complete(Result.failure(Exception("UNEXPECTED_SIGN")))}
}
private var protocolChecks=0
private fun yes(v:Boolean){check(v){"protocol check ${protocolChecks+1}"};protocolChecks++}
private fun rejects(f:()->Unit){var rejected=false;try{f()}catch(_:Exception){rejected=true};yes(rejected)}
fun main(){
 val chain="tbc:testnet";val origin="https://protocol.example";val a=ProtocolAccounts();val ui=ProtocolUi();val signer=NoProtocolSigner()
 val standard=ProtocolStore(NativeWalletProtocol.STANDARD);val legacy=ProtocolStore(NativeWalletProtocol.LEGACY)
 rejects{NativeCustody(a,chain,standard,ui,signer,walletProtocol=NativeWalletProtocol.LEGACY){_,_->true}}
 rejects{NativeCustody(a,chain,legacy,ui,signer){_,_->true}}
 val scope=mapOf("webViewInstanceId" to "same-view","sessionId" to "same-session","navigationId" to "same-navigation","committedUrl" to "$origin/dapp","origin" to origin,"topOrigin" to origin,"frame" to "top","createdAt" to "2026-10-14T00:00:00.000Z")
 val s=NativeCustody(a,chain,standard,ui,signer){owner,value->owner=="view"&&value==scope}
 val l=NativeCustody(a,chain,legacy,ui,signer,walletProtocol=NativeWalletProtocol.LEGACY){owner,value->owner=="view"&&value==scope}
 s.navigation("view",scope);l.navigation("view",scope)
 val request=mapOf("tbc_accounts" to mapOf("chains" to listOf(chain)),"tbc_signMessage" to mapOf("chains" to listOf(chain)))
 var sr:Result<List<Map<String,Any?>>>?=null;var lr:Result<List<Map<String,Any?>>>?=null
 s.requestPermissions("view",scope,"same-connect",request){sr=it};l.requestPermissions("view",scope,"same-connect",request){lr=it}
 val legacyId=PermissionJson.id(NativeWalletProtocol.LEGACY.namespace,"review","same-connect")
 yes(ui.pending.size==2&&ui.shown==2&&sr==null&&lr==null)
 yes(ui.reviews.getValue(legacyId).title=="Legacy · Connect wallet"&&ui.reviews.getValue("same-connect").title=="Connect wallet")
 ui.choose("same-connect");val sg=sr!!.getOrThrow();yes(sg.size==2&&lr==null&&ui.pending.size==1)
 yes(l.snapshot("view",scope).permissions.isEmpty())
 rejects{l.begin("view",scope,"unauthorized","tbc_signMessage",0,a.current)}
 ui.choose(legacyId);val lg=lr!!.getOrThrow();yes(lg.size==2&&ui.pending.isEmpty())
 yes(sg.map{it["id"]}.intersect(lg.map{it["id"]}.toSet()).isEmpty())
 listOf(s,l).forEach{it.begin("view",scope,"same-operation","tbc_signMessage",it.snapshot("view",scope).revision,a.current)}
 l.disconnect("view",scope,"disconnect");rejects{l.check("view",scope,"same-operation")};s.check("view",scope,"same-operation")
 yes(s.snapshot("view",scope).permissions.size==2&&l.snapshot("view",scope).permissions.isEmpty())
 yes(standard.data.getValue(origin).revision==1L&&legacy.data.getValue(origin).revision==2L)
 val sp=NativePermissions(a,chain,standard){};val lp=NativePermissions(a,chain,legacy,NativeWalletProtocol.LEGACY){}
 val p=sp.proposal(origin,request,"cross-proposal");rejects{lp.approve(p){}};yes(legacy.data.getValue(origin).revision==2L)
 val main=ProtocolAccounts("tbc:mainnet");val lmStore=ProtocolStore(NativeWalletProtocol.LEGACY)
 val lm=NativeCustody(main,"tbc:mainnet",lmStore,ui,signer,walletProtocol=NativeWalletProtocol.LEGACY){_,_->true}
 rejects{NativeNetworkWalletRouter(mapOf(chain to NativeNetworkLane("a".repeat(64),s,NativeWalletHost(s){_,_,_->}),"tbc:mainnet" to NativeNetworkLane("b".repeat(64),lm,NativeWalletHost(lm){_,_,_->})),chain,ui){_,_->true}}
 val lmp=NativePermissions(main,"tbc:mainnet",lmStore,NativeWalletProtocol.LEGACY){}
 val lmg=lmp.proposal(origin,mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:mainnet"))),"cross-proposal")
 rejects{NativePermissions.groupBackend(listOf(NativePermissionGrant(sp,p,{},{}),NativePermissionGrant(lmp,lmg,{},{})))}
 val replay=legacy.commit(origin,0,lg,"same-connect",PermissionJson.canonical(mapOf("origin" to origin,"chainId" to chain,"expected" to 0,"records" to lg))){}
 yes(replay.acknowledgedRevision==1L&&replay.current.revision==2L&&replay.current.records.isEmpty())
 s.disconnect("view",scope,"disconnect");yes(standard.data.getValue(origin).revision==2L&&legacy.data.getValue(origin).revision==2L)
 var stale:Result<List<Map<String,Any?>>>?=null
 l.requestPermissions("view",scope,"stale",request){stale=it};a.revision++;ui.choose(PermissionJson.id(NativeWalletProtocol.LEGACY.namespace,"review","stale"))
 rejects{stale!!.getOrThrow()};yes(legacy.data.getValue(origin).revision==2L)
 yes(NativePermissions(a,chain,standard){}.records(origin).isEmpty())
 yes(NativePermissions(a,chain,legacy,NativeWalletProtocol.LEGACY){}.records(origin).isEmpty())
 yes(signer.calls==0)
 // Actual shared private-channel router, not a channel-envelope mock.
 val sh=NativeWalletHost(s){_,_,_->};val lh=NativeWalletHost(l){_,_,_->}
 val router=NativeProtocolWalletRouter(NativeProtocolLane(sh),NativeProtocolLane(lh))
 rejects{NativeProtocolWalletRouter(NativeProtocolLane(lh))}
 rejects{NativeProtocolWalletRouter(NativeProtocolLane(sh),NativeProtocolLane(sh))}
 router.navigation("view",scope)
 fun call(method:String,fields:Map<String,Any?> = emptyMap(),isLegacy:Boolean=false):Map<String,Any?>?{
  val input=mapOf("ownerId" to "view","scope" to scope)+fields+(if(isLegacy)mapOf("walletProtocol" to NativeWalletProtocol.LEGACY.namespace)else emptyMap())
  var result:Map<String,Any?>?=null;router.dispatch(method,input){result=it};return result
 }
 yes(call("snapshot")?.get("ok")==true);yes(call("snapshot",isLegacy=true)?.get("ok")==true)
 listOf("unknown",null,false,1).forEach{yes(call("snapshot",mapOf("walletProtocol" to it))?.get("ok")==false)}
 val standardOnly=NativeProtocolWalletRouter(NativeProtocolLane(sh));var disabled:Map<String,Any?>?=null
 standardOnly.dispatch("snapshot",mapOf("ownerId" to "view","scope" to scope,"walletProtocol" to NativeWalletProtocol.LEGACY.namespace)){disabled=it}
 yes(disabled?.get("ok")==false)
 val connect=mapOf("operation" to "router-connect","permissions" to request,"providerMethod" to "tbc_requestAccounts")
 yes(call("permissions.request",connect)==null);yes(call("permissions.request",connect,true)==null)
 ui.choose("router-connect");yes(s.snapshot("view",scope).permissions.size==2&&l.snapshot("view",scope).permissions.isEmpty())
 ui.choose(PermissionJson.id(NativeWalletProtocol.LEGACY.namespace,"review","router-connect"));yes(l.snapshot("view",scope).permissions.size==2)
 for(isLegacy in listOf(false,true)){
  val custody=if(isLegacy)l else s
  yes(call("signing.begin",mapOf("operation" to "router-sign","method" to "tbc_signMessage","revision" to custody.snapshot("view",scope).revision,"account" to a.current.identity()),isLegacy)?.get("ok")==true)
 }
 yes(call("operation.cancel",mapOf("operation" to "router-sign"),true)?.get("ok")==true)
 yes(call("signing.check",mapOf("operation" to "router-sign"),true)?.get("ok")==false)
 yes(call("signing.check",mapOf("operation" to "router-sign"))?.get("ok")==true)
 fun frame(protocol:NativeWalletProtocol,value:Any):String{
  val payload=mapOf("response" to mapOf("jsonrpc" to "2.0","id" to "read","result" to value),"events" to emptyList<Any>())
  val hash=java.security.MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(payload).toByteArray()).joinToString(""){"%02x".format(it)}
  return PermissionJson.canonical(payload+mapOf("channel" to protocol.wireChannel,"type" to "delivery","sessionId" to scope.getValue("sessionId"),"navigationId" to scope.getValue("navigationId"),"messageId" to "result","deliveryId" to hash))
 }
 fun prepare(text:String,isLegacy:Boolean=false)=call("delivery.prepare",mapOf("method" to "tbc_accounts","requestId" to "read","serialized" to text),isLegacy)?.get("ok")==true
 val sf=frame(NativeWalletProtocol.STANDARD,listOf(a.current.address));val lf=frame(NativeWalletProtocol.LEGACY,listOf(a.current.address))
 yes(prepare(sf));yes(prepare(lf,true))
 yes(router.allowDelivery("view",scope,sf));yes(router.allowDelivery("view",scope,lf,NativeWalletProtocol.LEGACY))
 yes(!prepare(sf,true));yes(!prepare(lf))
 yes(!router.allowDelivery("view",scope,sf,NativeWalletProtocol.LEGACY));yes(!router.allowDelivery("view",scope,lf))
 yes(!prepare(frame(NativeWalletProtocol.LEGACY,mapOf("tbcAddress" to a.current.address)),true))
 yes(!standardOnly.allowDelivery("view",scope,lf,NativeWalletProtocol.LEGACY))
 val balance=mapOf("chainId" to chain,"address" to a.current.address,"balanceAtomic" to "1000001","decimals" to 6)
 val bf=frame(NativeWalletProtocol.LEGACY,balance);val shown=ui.shown
 fun balancePrepare(text:String,isLegacy:Boolean=true)=call("delivery.prepare",mapOf("method" to "wallet_readBalance","requestId" to "read","serialized" to text),isLegacy)?.get("ok")==true
 yes(balancePrepare(bf));yes(router.allowDelivery("view",scope,bf,NativeWalletProtocol.LEGACY))
 yes(!balancePrepare(frame(NativeWalletProtocol.STANDARD,balance),false))
 for(value in listOf("0","9007199254740991"))yes(balancePrepare(frame(NativeWalletProtocol.LEGACY,balance+mapOf("balanceAtomic" to value))))
 for(patch in listOf(mapOf("chainId" to "tbc:mainnet"),mapOf("address" to "other"),mapOf("balanceAtomic" to "9007199254740992"),mapOf("balanceAtomic" to "01"),mapOf("balanceAtomic" to 1),mapOf("balanceAtomic" to "-1"),mapOf("decimals" to 5),mapOf("extra" to true)))
  yes(!balancePrepare(frame(NativeWalletProtocol.LEGACY,balance+patch)))
 yes(!prepare(bf,true));yes(ui.shown==shown&&signer.calls==0)
 yes(call("permissions.disconnect",mapOf("operation" to "router-disconnect"),true)?.get("ok")==true)
 yes(!router.allowDelivery("view",scope,bf,NativeWalletProtocol.LEGACY));yes(!balancePrepare(bf))
 yes(s.snapshot("view",scope).permissions.size==2&&l.snapshot("view",scope).permissions.isEmpty())
 yes(!router.allowDelivery("view",scope,lf,NativeWalletProtocol.LEGACY));yes(router.allowDelivery("view",scope,sf))
 val initialize=mapOf("channel" to "tws-webview/1","type" to "initialize","sessionId" to scope.getValue("sessionId"),"navigationId" to scope.getValue("navigationId"),"messageId" to "native-1","origin" to origin,"chainId" to chain)
 yes(router.allowDelivery("view",scope,PermissionJson.canonical(initialize)))
 yes(router.allowDelivery("view",scope,PermissionJson.canonical(initialize+mapOf("channel" to NativeWalletProtocol.LEGACY.wireChannel)),NativeWalletProtocol.LEGACY))
 yes(!router.allowDelivery("view",scope,PermissionJson.canonical(initialize),NativeWalletProtocol.LEGACY))
 yes(!router.allowDelivery("view",scope,PermissionJson.canonical(initialize+mapOf("channel" to "legacy-window-turing-webview/1"))))
 yes(call("document.invalidate",isLegacy=true)?.get("ok")==true)
 yes(call("snapshot",isLegacy=true)?.get("ok")==false);yes(call("snapshot")?.get("ok")==true)
 router.invalidate("view");yes(call("snapshot")?.get("ok")==false)
 router.navigation("view",scope);router.close();yes(call("snapshot")?.get("ok")==false);rejects{router.navigation("view",scope)}
 yes(signer.calls==0)
 println("""{"status":"NATIVE_PROTOCOL_ISOLATION_PASS","checks":$protocolChecks,"systemSQLite":false,"mobileDevice":false,"signatures":0,"broadcasts":0}""")
}
