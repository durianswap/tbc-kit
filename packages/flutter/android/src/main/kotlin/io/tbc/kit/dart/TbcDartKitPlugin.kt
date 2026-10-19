package io.tbc.kit.dart

import android.content.Context
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import org.json.JSONObject

/** Registration never installs a key, approval, account or sender. */
class TbcDartKitPlugin:FlutterPlugin {
 private var channel:MethodChannel?=null
 override fun onAttachedToEngine(binding:FlutterPlugin.FlutterPluginBinding) {
  val app=binding.applicationContext
  channel=MethodChannel(binding.binaryMessenger,"io.tbc.kit.dart/package").also{it.setMethodCallHandler{call,result->
   if(call.method!="computeArtifact"||call.arguments!=null)result.notImplemented()
   else try{
    val manifest=JSONObject(app.assets.open("tbc-kit/distribution.json").bufferedReader().use{r->r.readText()})
    result.success(mapOf("path" to File(app.applicationInfo.nativeLibraryDir,"libtbc_compute_native.so").absolutePath,
     "sha256" to manifest.getString("androidEngineSha256")))
   }catch(_:Exception){result.error("PACKAGE_PINS","TBC native package unavailable",null)}
  }}
 }
 override fun onDetachedFromEngine(binding:FlutterPlugin.FlutterPluginBinding) {channel?.setMethodCallHandler(null);channel=null}
}

data class TbcPartnerNetwork(
 val source:NativeBroadcastConfiguration,val accounts:NativeAccountSource,
 val approval:NativeApprovalPresenter,val signer:NativeDigestSigner,
 val crypto:NativeBie1Executor?=null,val enableBroadcast:Boolean=true,
)

/** Thin registration over the existing shared host, not another executor. */
class TbcPartnerWalletHost(
 context:Context,messenger:BinaryMessenger,resolvePlatformView:(Int)->View?,
 profile:String,network:TbcPartnerNetwork,additionalNetworks:List<TbcPartnerNetwork> = emptyList(),
 legacy:Boolean=true,resolveLegacyClient:((WebView)->WebViewClient?)?=null,
) {
 private val stores=mutableListOf<SystemPermissionBackend>()
 private val host:TbcDartWalletHost
 private var disposed=false
 init {
  val app=context.applicationContext
  val manifest=JSONObject(app.assets.open("tbc-kit/distribution.json").bufferedReader().use{it.readText()})
  fun lane(n:TbcPartnerNetwork):NativeWalletNetwork {
   val standard=SystemPermissionBackend(app,profile,n.source.chainId).also{stores+=it}
   val old=if(legacy)SystemPermissionBackend(app,profile,n.source.chainId,NativeWalletProtocol.LEGACY).also{stores+=it} else null
   return NativeWalletNetwork(n.source,n.accounts,standard,n.approval,n.signer,n.crypto,
    if(n.enableBroadcast)File(app.filesDir,"tbc-kit") else null,if(n.enableBroadcast)profile else null,old)
  }
  val primary=lane(network)
  host=TbcDartWalletHost(messenger,resolvePlatformView,
   app.assets.open("tbc-kit/tbc-webview-page.js").use{it.readBytes()},manifest.getString("pageSha256"),
   primary.accounts,primary.source.chainId,primary.backend,primary.approval,primary.signer,
   resolveLegacyClient=resolveLegacyClient,crypto=primary.crypto,
   broadcast=if(primary.broadcastDirectory==null)null else primary.source,
   broadcastDirectory=primary.broadcastDirectory,broadcastProfile=primary.broadcastProfile,
   networkSource=primary.source,additionalNetworks=additionalNetworks.map(::lane),legacyBackend=primary.legacyBackend)
 }
 fun walletStateChanged()=host.walletStateChanged()
 fun suspendViews()=host.suspendViews()
 fun dispose(){if(disposed)return;disposed=true;host.dispose();stores.forEach{it.close()}}
}
