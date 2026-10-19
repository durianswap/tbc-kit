import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';
import 'business_intents.dart';

/// Use one already-open actions session. Request only the permissions needed
/// by the feature being enabled; never request them again for each transaction.
Future<Object?> enableTransfers(TbcWalletActions actions) =>
    actions.requestPermissions({
      'tbc_accounts': {
        'chains': [actions.network.chainId],
        'maxAccounts': 1,
      },
      'tbc_signTransaction': {
        'chains': [actions.network.chainId],
      },
      'tbc_sendTransaction': {
        'chains': [actions.network.chainId],
      },
    });

/// This is the only transaction execution call in the recipe. The Kit handles
/// reads, prefetch, validation, approval, signing and submission. No retry here.
Future<Object?> sendIntent(
  TbcWalletActions actions, {
  required TbcFields intent,
  required String maxFeeAtomic,
  List<TbcFields>? inputOutpoints,
  String? expiresAt,
}) => actions.sendTransaction(
  actions.transactionRequest(
    intent: intent,
    constraints: {
      'maxFee': maxFeeAtomic,
      if (inputOutpoints != null) 'inputOutpoints': inputOutpoints,
      if (expiresAt != null) 'expiresAt': expiresAt,
    },
  ),
);

Future<Object?> sendTokenFromDisplay(
  TbcWalletActions actions, {
  required String contractId,
  required String recipient,
  required String displayAmount,
  required int tokenDecimals,
  required String maxFeeAtomic,
  bool stablecoin = false,
}) => sendIntent(
  actions,
  intent: transferToken(
    contractId: contractId,
    to: recipient,
    amount: parseTbcDisplayAmount(displayAmount, tokenDecimals),
    stablecoin: stablecoin,
  ),
  maxFeeAtomic: maxFeeAtomic,
);

// A sign-only result contains raw transactions. Do not call sendTransaction
// afterwards on the same intent: that would create a different operation.
Future<Object?> signIntent(
  TbcWalletActions actions, {
  required TbcFields intent,
  required String maxFeeAtomic,
}) => actions.signTransaction(
  actions.transactionRequest(
    intent: intent,
    constraints: {'maxFee': maxFeeAtomic},
  ),
);

// proposal is the complete, unchanged Prepared DTO from the DApp/Kit builder,
// not just raw hex. Its evidence and expiry are checked by the wallet.
Future<Object?> sendPrepared(
  TbcWalletActions actions, {
  required TbcFields intent,
  required TbcFields proposal,
  required String maxFeeAtomic,
}) => actions.sendPreparedTransaction({
  ...actions.transactionRequest(
    intent: intent,
    constraints: {'maxFee': maxFeeAtomic},
  ),
  'proposal': proposal,
});

Future<Object?> enableTransferReceipt(TbcWalletActions actions) =>
    actions.requestPermissions({
      'tbc_accounts': {
        'chains': [actions.network.chainId],
        'maxAccounts': 1,
      },
      'tbc_signTransaction': {
        'chains': [actions.network.chainId],
      },
      'tbc_sendTransaction': {
        'chains': [actions.network.chainId],
      },
      'tbc_signWorkflow': {
        'chains': [actions.network.chainId],
      },
      'tbc_signTypedData': {
        'chains': [actions.network.chainId],
      },
    });

Future<Object?> sendWithReceipt(
  TbcWalletActions actions, {
  required TbcFields intent,
  required String maxFeeAtomic,
  required String expiresAt,
}) => actions.sendWorkflow(
  transferAndReceipt(
    chainId: actions.network.chainId,
    from: actions.account.address,
    intent: intent,
    maxFee: maxFeeAtomic,
    expiresAt: expiresAt,
  ),
);

Future<Object?> signText(TbcWalletActions actions, String text) =>
    actions.signMessage({
      'version': '1.0',
      'chainId': actions.network.chainId,
      'from': actions.account.address,
      'message': {'encoding': 'utf8', 'data': text},
    });

Future<Object?> sendPreparedBatch(
  TbcWalletActions actions, {
  required List<TbcFields> steps,
  required String maxTotalFeeAtomic,
  required String expiresAt,
}) => actions.sendPreparedWorkflow(
  preparedBatch(
    chainId: actions.network.chainId,
    from: actions.account.address,
    steps: steps,
    maxTotalFee: maxTotalFeeAtomic,
    expiresAt: expiresAt,
  ),
);

Future<Object?> signTyped(TbcWalletActions actions, TbcFields data) =>
    actions.signTypedData({
      'version': '1.0',
      'chainId': actions.network.chainId,
      'from': actions.account.address,
      'data': data,
    });

Future<Object?> encryptText(TbcWalletActions actions, String text) =>
    actions.request('tbc_encrypt', {
      'version': '1.0',
      'chainId': actions.network.chainId,
      'from': actions.account.address,
      'algorithm': 'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1',
      'message': {'encoding': 'utf8', 'data': text},
    });

Future<Object?> decryptText(TbcWalletActions actions, String ciphertext) =>
    actions.request('tbc_decrypt', {
      'version': '1.0',
      'chainId': actions.network.chainId,
      'from': actions.account.address,
      'algorithm': 'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1',
      'ciphertext': ciphertext,
    });
