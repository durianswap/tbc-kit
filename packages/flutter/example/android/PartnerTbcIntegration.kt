package example.tbc

import android.content.Context
import io.flutter.embedding.engine.FlutterEngine
import io.tbc.kit.dart.*
import com.pichillilorenzo.flutter_inappwebview_android.webview.in_app_webview.InAppWebView

/** Wallet supplies its own public account, trusted UI and Vault. No test key. */
class PartnerTbcIntegration {
 private var host:TbcPartnerWalletHost?=null
 fun start(context:Context,engine:FlutterEngine,profile:String,accounts:NativeAccountSource,
           approval:NativeApprovalPresenter,signer:NativeDigestSigner,crypto:NativeBie1Executor?=null){
  check(host==null)
  val network=TbcPartnerNetwork(NativeBroadcastConfiguration("testnet"),accounts,approval,signer,crypto)
  host=TbcPartnerWalletHost(context,engine.dartExecutor.binaryMessenger,
   {id->engine.platformViewsController.getPlatformViewById(id)},profile,network,
   resolveLegacyClient={web->(web as? InAppWebView)?.let{it.inAppWebViewClient?:it.inAppWebViewClientCompat}})
 }
 fun walletStateChanged(){host?.walletStateChanged()}
 fun onPause(){host?.suspendViews()}
 fun detach(){host?.dispose();host=null}
}
