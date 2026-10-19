import Flutter
import UIKit
import tbc_kit_flutter_dart

/// Call only after your wallet has supplied its own selected public account,
/// trusted approval presenter, and Vault adapter. This template has no key.
@MainActor final class PartnerTbcIntegration {
 private var host:TbcPartnerWalletHost?
 func start(controller:FlutterViewController,profile:String,accounts:NativeAccountSource,
            approval:NativeApprovalPresenter,signer:NativeDigestSigner,crypto:NativeBie1Executor?=nil)throws{
  precondition(host==nil)
  let network=try TbcPartnerNetwork(network:"testnet",accounts:accounts,approval:approval,signer:signer,crypto:crypto)
  host=try TbcPartnerWalletHost(messenger:controller.binaryMessenger,root:controller.view,profile:profile,network:network)
 }
 // Call before further key use after lock/unlock/account selection changes.
 func walletStateChanged(){host?.walletStateChanged()}
 func applicationWillResignActive(){host?.suspendViews()}
 func detach(){host?.dispose();host=nil}
}
