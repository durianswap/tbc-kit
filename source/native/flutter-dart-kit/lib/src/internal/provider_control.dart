import '../configuration.dart';
import '../webview_scope.dart';
import 'protocol_codec.dart';
import 'wallet_protocol.dart';

/// Typed native registration identity; no page option selects this profile.
abstract interface class TbcProviderProtocolControl {
  TbcNativeWalletProtocol get walletProtocol;
}

/// ACK retires native delivery attestations, never execution replay tombstones.
abstract interface class TbcProviderDeliveryControl {
  Future<void> acknowledgeDelivery(Object requestId);
}

// Mirrors the native custody grant mapping. Prepared changes the material
// producer, not the permission a wallet must grant to this origin/account.
String signingPermissionForMethod(String method) => switch (method) {
  'tbc_signPreparedTransaction' ||
  'tbc_signReviewedTransaction' => 'tbc_signTransaction',
  'tbc_signPreparedWorkflow' ||
  'tbc_sendWorkflow' ||
  'tbc_sendPreparedWorkflow' => 'tbc_signWorkflow',
  'tbc_sendPreparedTransaction' => 'tbc_sendTransaction',
  'tbc_encrypt' || 'tbc_decrypt' => 'tbc_crypto',
  _ => method,
};

/// Package/platform-owned control plane; not a page-facing generic dispatcher.
/// Implementations share the exact committed grant store/account owner used by
/// the native signer. A Dart mirror may make local checks cheap, but cannot
/// substitute for native checks at grant commit, signature and result emission.
/// No chain API lookup belongs in any of these callbacks.
abstract interface class TbcProviderControl {
  TbcNetworkConfiguration get network;
  TbcWebViewNavigation get navigation;
  TbcAccount get selectedAccount;
  int get revision;
  bool get isUnlocked;
  void requireCurrent();
  bool permits(String capability);
  List<Map<String, dynamic>> currentPermissions();

  /// Native UI approval and atomic commit. Return the committed requested
  /// records only; rejected/failed/uncertain persistence must never install an
  /// in-memory grant. Bind exact origin, chain, account, request and revision.
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest request,
  );

  /// Revoke native pending permits before committing grant removal. Unknown
  /// persistence fails closed. No response/event claims success before commit.
  Future<void> disconnect(String operationId);

  /// Recheck the result's native operation/grant epoch. The document transport
  /// must repeat this fence at the actual native emission (same owner/executor),
  /// not just before awaiting a Flutter channel reply. Error-only delivery does
  /// not require a still-valid signing grant, but still requires this document.
  Future<void> beforeDelivery(
    String method,
    Object requestId,
    String serialized,
  );

  /// Synchronous local invalidation and ordered native cancellation. Native
  /// navigation/lock hooks must fence key use before notifying this Dart mirror;
  /// a MethodChannel call is not a synchronous cross-executor fence.
  /// This owner is not restored on document reopen.
  void invalidate();

  /// Cancel pending permission/control dialogs for this operation. The signing
  /// worker independently revokes its matching native signing operation.
  Future<void> cancel(String operationId);
}

/// Optional native-authorized account catalog. Extra connected identities may
/// serve transaction roles; they never implicitly replace the wallet-selected
/// primary signing account. The native emission owner must check the same list.
abstract interface class TbcProviderAccountCatalog {
  List<TbcAccount> get connectedAccounts;
  bool permitsAccount(String capability, TbcAccount account);
}

/// Native execution capabilities, not grants or page preferences. Discovery
/// never implies authorization to use a key.
abstract interface class TbcProviderOptionalMethods {
  Set<String> get optionalMethods;
}

/// Native-backed network control. The catalog is wallet configuration, not an
/// endpoint supplied by a page. Commit must fence old native permits before
/// replacing the current snapshot, and bind the response/events to that commit.
abstract interface class TbcProviderNetworkControl {
  /// Immutable wallet catalog. Target-chain reads never activate that chain.
  Map<String, TbcNetworkConfiguration> get supportedNetworks;
  int get networkRevision;
  Set<String> optionalMethodsForChain(String chainId);
  bool permitsAddressOnChain(String chainId, String address);
  Future<List<Object?>> switchChain({
    required String operationId,
    required String chainId,
    required int expectedRevision,
  });
}

/// Private native result attestation for a configured, possibly inactive lane.
/// Address-qualified queries use that lane's real grant, not a Dart boolean.
abstract interface class TbcProviderNativeCapabilities {
  Future<Map<String, dynamic>> nativeCapabilities({
    required String operationId,
    required String chainId,
    String? address,
  });
}

final class TbcPermissionRequest {
  TbcPermissionRequest({
    required this.providerMethod,
    required this.operationId,
    required this.account,
    required this.navigation,
    required this.revision,
    required Map permissions,
  }) : permissions = frozen(copied(permissions)) as Map<String, dynamic>;
  final String operationId, providerMethod;
  final TbcAccount account;
  final TbcWebViewNavigation navigation;
  final int revision;
  final Map<String, dynamic> permissions;
  @override
  String toString() => 'TbcPermissionRequest(redacted)';
}
