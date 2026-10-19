package io.tbc.kit.dart

import android.os.Looper
import android.os.Handler
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

// Wallet-only typed source/custody configuration. Source configuration alone
// does not enable send methods; submission also requires its private journal.
data class NativeWalletNetwork(
 val source:NativeBroadcastConfiguration,val accounts:NativeAccountSource,val backend:NativePermissionBackend,
 val approval:NativeApprovalPresenter,val signer:NativeDigestSigner,val crypto:NativeBie1Executor?=null,
 val broadcastDirectory:File?=null,val broadcastProfile:String?=null,
 val legacyBackend:NativePermissionBackend?=null,
)

/** Wallet-owned registration, once per Flutter engine. Required custody/UI
 * callbacks cannot come from a page or a Dart permission boolean.
 * Call walletStateChanged on native lock/unlock/selection before further key
 * work; call suspendViews on activity suspension and dispose on engine detach.
 */
class TbcDartWalletHost(
 messenger:BinaryMessenger,resolvePlatformView:(Int)->View?,
 pageBytes:ByteArray,expectedPageSHA256:String,
 private val accounts:NativeAccountSource,private val chain:String,
 backend:NativePermissionBackend,approval:NativeApprovalPresenter,signer:NativeDigestSigner,
 allowInsecureLoopback:Boolean=false,resolveLegacyClient:((WebView)->WebViewClient?)?=null,crypto:NativeBie1Executor?=null,
 broadcast:NativeBroadcastConfiguration?=null,broadcastDirectory:File?=null,broadcastProfile:String?=null,
 networkSource:NativeBroadcastConfiguration?=null,additionalNetworks:List<NativeWalletNetwork> = emptyList(),
 legacyBackend:NativePermissionBackend?=null,
) {
 private val channel=MethodChannel(messenger,"io.tbc.kit.dart/private-wallet")
 private lateinit var webview:TbcFlutterWebViewHost
 private var closed=false
 private val localOrigin="https://native.wallet.tbc.invalid"
 private val localScopes=mutableMapOf<String,Map<String,String>>()
 private fun current(id:String,scope:Map<String,String>) = !closed &&
  (localScopes[id]?.let{it==scope} ?: (scope["origin"]!=localOrigin&&::webview.isInitialized&&webview.isCurrent(id,scope)))
 private val protocols:NativeProtocolWalletRouter
 private val broadcastRouters=mutableListOf<NativeBroadcastRouter>()
 private val networkRouters=mutableMapOf<NativeWalletProtocol,NativeNetworkWalletRouter>()
 private val accountSources=mutableMapOf<String,NativeAccountSource>()
 init{
  check(Looper.myLooper()===Looper.getMainLooper())
  val owner=Handler(Looper.getMainLooper())
  val compute=NativeReviewedRust{reply->owner.post{reply()}}
  check(if(broadcast==null)broadcastDirectory==null&&broadcastProfile==null else broadcast.chainId==chain&&broadcastDirectory!=null&&broadcastProfile!=null){"NATIVE_BROADCAST_CONFIGURATION"}
  val primarySource=networkSource?:broadcast?:NativeBroadcastConfiguration(chain.removePrefix("tbc:"))
  check(primarySource.chainId==chain&&(broadcast==null||broadcast.sourceIdentity==primarySource.sourceIdentity)){"NATIVE_NETWORK_SOURCE"}
  fun notify(protocol:NativeWalletProtocol,id:String,scope:Map<String,String>,snapshot:Any?){
   val event=mutableMapOf<String,Any?>("ownerId" to id,"scope" to scope,"snapshot" to snapshot)
   if(protocol!=NativeWalletProtocol.STANDARD)event["walletProtocol"]=protocol.namespace
   channel.invokeMethod("authorityChanged",event)
  }
  fun makeLane(n:NativeWalletNetwork,protocol:NativeWalletProtocol):NativeNetworkLane{
   check((n.broadcastDirectory==null)==(n.broadcastProfile==null)){"NATIVE_BROADCAST_CONFIGURATION"}
   val sending=n.broadcastDirectory!=null
   val selectedBackend=if(protocol==NativeWalletProtocol.STANDARD)n.backend else n.legacyBackend!!
   val custody=NativeCustody(n.accounts,n.source.chainId,selectedBackend,n.approval,n.signer,compute,n.crypto,if(sending)n.source.sourceIdentity else null,protocol){id,scope->
    current(id,scope)
   }
   lateinit var host:NativeWalletHost
   host=NativeWalletHost(custody){id,scope,snapshot->
    if(!closed){val router=networkRouters[protocol]
     if(router!=null)router.nativeAuthorityChanged(id,scope)
     else notify(protocol,id,scope,host.snapshotWire(snapshot))
    }
   }
   if(sending){
    val http=NativeBroadcastHTTP(n.source.sourceIdentity){callback->owner.post{callback()}}
    val router=NativeBroadcastRouter(custody,n.source,n.broadcastDirectory!!,n.broadcastProfile!!){request,fence,reply->http.start(request,fence,reply)}
    host.installBroadcast(router::dispatch);broadcastRouters+=router
   }
   return NativeNetworkLane(n.source.sourceIdentity,custody,host)
  }
  val configurations=listOf(NativeWalletNetwork(primarySource,accounts,backend,approval,signer,crypto,broadcastDirectory,broadcastProfile,legacyBackend))+additionalNetworks
  check(configurations.size<=2&&configurations.map{it.source.chainId}.toSet().size==configurations.size){"NATIVE_NETWORK_CATALOG"}
  check(configurations.all{it.backend.walletProtocol==NativeWalletProtocol.STANDARD&&(it.legacyBackend!=null)==(legacyBackend!=null)&&(it.legacyBackend==null||it.legacyBackend.walletProtocol==NativeWalletProtocol.LEGACY)}){"PERMISSION_PROTOCOL"}
  fun makeProtocol(protocol:NativeWalletProtocol):NativeProtocolLane{
   val lanes=configurations.associate{n->accountSources[n.source.chainId]=n.accounts;n.source.chainId to makeLane(n,protocol)}
   if(additionalNetworks.isEmpty())return NativeProtocolLane(lanes.getValue(chain).wallet)
   val router=NativeNetworkWalletRouter(lanes,chain,approval){id,scope->current(id,scope)}
   router.installAuthorityChanged{id,scope,snapshot->if(!closed)notify(protocol,id,scope,snapshot)}
   networkRouters[protocol]=router
   return NativeProtocolLane(lanes.getValue(chain).wallet,router)
  }
  protocols=NativeProtocolWalletRouter(makeProtocol(NativeWalletProtocol.STANDARD),if(legacyBackend==null)null else makeProtocol(NativeWalletProtocol.LEGACY))
  webview=TbcFlutterWebViewHost(messenger,resolvePlatformView,pageBytes,expectedPageSHA256,
   allowInsecureLoopback,{id,_->invalidate(id)},resolveLegacyClient,
   {id,scope->check(scope["origin"]!=localOrigin){"NATIVE_DENIED"};protocols.navigation(id,scope)},
   {id,scope,text->protocols.allowDelivery(id,scope,text)},
   {id,scope,text->protocols.allowDelivery(id,scope,text,NativeWalletProtocol.LEGACY)})
  channel.setMethodCallHandler{call,result->
   if(closed)result.success(mapOf("ok" to false,"code" to "NATIVE_DENIED"))
   else if(call.method.startsWith("local.")) localCall(call.method,call.arguments,result)
   else if((call.arguments as? Map<*,*>)?.let{localScopes.containsKey(it["ownerId"])&&it.containsKey("walletProtocol")}==true)result.success(mapOf("ok" to false,"code" to "NATIVE_DENIED"))
   else protocols.dispatch(call.method,call.arguments){result.success(it)}
  }
 }
 private fun localCall(method:String,input:Any?,reply:MethodChannel.Result){
  try{
   val args=input as? Map<*,*>?:error("NATIVE_DENIED")
   if(method=="local.open"){
    check(args.isEmpty()&&localScopes.isEmpty()){"NATIVE_DENIED"}
    val id="local_"+java.util.UUID.randomUUID()
    val session=java.util.UUID.randomUUID().toString()
    val scope=mapOf("webViewInstanceId" to id,"sessionId" to session,"navigationId" to java.util.UUID.randomUUID().toString(),"committedUrl" to "$localOrigin/","origin" to localOrigin,"topOrigin" to localOrigin,"frame" to "top","createdAt" to java.time.Instant.ofEpochMilli(System.currentTimeMillis()).toString())
    localScopes[id]=scope
    try{protocols.navigation(id,scope)}catch(e:Exception){localScopes.remove(id);throw e}
    reply.success(mapOf("ok" to true,"value" to mapOf("ownerId" to id,"scope" to scope)));return
   }
   val id=args["ownerId"] as? String?:error("NATIVE_DENIED")
   val scope=localScopes[id]?:error("NATIVE_DENIED");check(args["scope"]==scope)
   if(method=="local.close"){
    check(args.keys==setOf("ownerId","scope"));localScopes.remove(id);protocols.invalidate(id)
    reply.success(mapOf("ok" to true,"value" to null));return
   }
   check(method=="local.deliver"&&args.keys==setOf("ownerId","scope","text"))
   reply.success(mapOf("ok" to true,"value" to protocols.allowDelivery(id,scope,args["text"] as String)))
  }catch(e:Exception){reply.success(mapOf("ok" to false,"code" to "NATIVE_DENIED"))}
 }
 private fun invalidateLocal(){
  val previous=localScopes.toMap();localScopes.clear()
  previous.forEach{(id,scope)->protocols.invalidate(id);channel.invokeMethod("authorityChanged",mapOf("ownerId" to id,"scope" to scope,"snapshot" to null))}
 }
 private fun invalidate(owner:String){protocols.invalidate(owner)}
 fun walletStateChanged(){
  check(Looper.myLooper()===Looper.getMainLooper());if(closed)return
  if(accountSources.any{(id,source)->source.current.chainId!=id}){webview.invalidateAll();invalidateLocal()}
  else protocols.accountChanged()
 }
 fun suspendViews(){check(Looper.myLooper()===Looper.getMainLooper());if(!closed){webview.invalidateAll();invalidateLocal()}}
 fun dispose(){
  check(Looper.myLooper()===Looper.getMainLooper());if(closed)return
  invalidateLocal();closed=true;webview.dispose();protocols.close();broadcastRouters.forEach{it.close()};channel.setMethodCallHandler(null)
 }
}
