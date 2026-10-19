package io.tbc.dartkitf1

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.tbc.kit.dart.*
import com.pichillilorenzo.flutter_inappwebview_android.webview.in_app_webview.InAppWebView
import org.json.JSONObject
import java.io.File

class MainActivity:FlutterActivity(){
 private var host:TbcDartWalletHost?=null
 override fun configureFlutterEngine(engine:FlutterEngine){
  super.configureFlutterEngine(engine)
  val wallet=PrivateTestnetWallet(this)
  val directory=File(filesDir,"contract173-private-testnet");check(directory.isDirectory||directory.mkdirs())
  host=TbcDartWalletHost(engine.dartExecutor.binaryMessenger,
   {id->engine.platformViewsController.getPlatformViewById(id)},
   assets.open("tbc-kit/tbc-webview-page.js").use{it.readBytes()},
   "9efa0a281e4de99f455fd2983e90db38836e8e9217e1dcf8aaee6c8a1d8f6a72",
   wallet,wallet.current.chainId,SystemPermissionBackend(this,"contract173-live",wallet.current.chainId),wallet,wallet,
   allowInsecureLoopback=true,resolveLegacyClient={web->(web as? InAppWebView)?.let{it.inAppWebViewClient?:it.inAppWebViewClientCompat}},
   broadcast=NativeBroadcastConfiguration("testnet","https://devapi.tbcdev.org","contract173-live"),
   broadcastDirectory=directory,broadcastProfile="contract173-live")
  MethodChannel(engine.dartExecutor.binaryMessenger,"io.tbc.dartkit/live-harness").setMethodCallHandler{call,result->
   try {
    when(call.method){
     "paths"->result.success(mapOf("engine" to "${applicationInfo.nativeLibraryDir}/libtbc_compute_native.so"))
     "stats"->result.success(wallet.stats())
     "unlock"->{wallet.unlock();host?.walletStateChanged();result.success(wallet.current.identity())}
     "admitRun"->{
      val id=call.arguments as? String?:"";check(id.matches(Regex("^[a-z0-9-]{1,100}$")))
      // Never replay an admitted run after an error/crash.
      val started=File(directory,id+".started.json");check(started.createNewFile());started.writeText(id);result.success(true)
     }
     "record"->{
      val report=JSONObject(call.arguments as Map<*,*>);report.put("native",JSONObject(wallet.stats()));report.put("pid",android.os.Process.myPid())
      File(filesDir,"live-report.json").writeText(report.toString());result.success(null)
     }
     else->result.notImplemented()
    }
   }catch(e:Exception){result.error("LIVE_HARNESS_DENIED",null,null)}
  }
 }
 override fun onPause(){host?.suspendViews();super.onPause()}
 override fun onDestroy(){host?.dispose();host=null;super.onDestroy()}
}
