import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

/// Every amount is an integer string in the asset's smallest unit.
/// Use either sign or send once; do not sign and then submit a new send request.
Future<Object?> transferNfts({
  required TbcWalletActions actions,
  required List<Map<String, Object?>> transfers,
  required String maxFeeAtomic,
  bool broadcast = true,
}) {
  final request = actions.transactionRequest(
    intent: {
      'version': '1.0',
      'type': 'tbc721.batchTransfer',
      'transfers': transfers,
    },
    constraints: {'maxFee': maxFeeAtomic},
  );
  return broadcast
      ? actions.sendTransaction(request)
      : actions.signTransaction(request);
}

/// Reuse this reader while the page is open, then close it when leaving.
/// Status is a fresh observation, not a reservation or permission to sign.
Future<Tbc721Reader> openNftStatusReader(TbcWalletActions actions) =>
    openTbcPackagedNftReader(network: actions.network);

/// One manifest, one native approval and one shared total fee budget.
/// Inspect partial/uncertain results; do not submit the entire list again.
Future<Map<String, dynamic>> mintNfts({
  required TbcWalletActions actions,
  required String collectionId,
  required List<Map<String, dynamic>> items,
  required String maxTotalFeeAtomic,
}) => actions.mintNftJob(
  collectionId: collectionId,
  items: items,
  limits: {
    'maxTotalFee': maxTotalFeeAtomic,
    'expiresAt': DateTime.now().toUtc()
        .add(const Duration(minutes: 5)).toIso8601String(),
    'maxItemsPerBatch': 100,
  },
);
