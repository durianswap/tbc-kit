// Shared keyless review boundary. Native custody/executor must bind this result
// before signing; neither a page preview nor this helper authorizes keys.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;
import 'nft_material.dart' show ApiTxoStatus;
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'reviewed_token.dart';
import 'reviewed_historical_token.dart';
import 'reviewed_current_holder.dart';
import 'reviewed_nft.dart';
import 'reviewed_native.dart';
import 'reviewed_lop.dart';
import 'reviewed_lop_terms.dart';
import 'reviewed_htlc_token.dart';
import 'reviewed_keyless.dart';
import 'reviewed_policy.dart';
import 'reviewed_preview.dart';

final _hold = RegExp(r'^76a914[0-9a-f]{40}88ac6a0d56302043757272204e486f6c64$');

final class ReviewedTransactionResult {
  ReviewedTransactionResult({
    required this.material,
    required this.plan,
    required this.policyMaterial,
    required this.preview,
    required this.artifact,
  });
  final Map<String, dynamic> material, policyMaterial, preview, artifact;
  final ReviewedRawPlan plan;
}

/// One configured network/source. Recreate on source switches. Only authenticated
/// NFT mint identities persist between calls, as with the shared parent reader.
final class ReviewedTransactionReviewer {
  ReviewedTransactionReviewer({
    required this.chainId,
    required this.read,
    required this.status,
    required this.readHistory,
    required this.keyless,
    required this.now,
  }) {
    need({'tbc:mainnet', 'tbc:testnet'}.contains(chainId), 'REVIEWED_CHAIN');
    _nftAssets = ReviewedNftAssets(
      read: read,
      readHistory: readHistory,
      keyless: keyless,
    );
  }
  final String chainId;
  final ApiRead read;
  final ApiTxoStatus status;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final KeylessCall keyless;
  final DateTime Function() now;
  late final ReviewedNftAssets _nftAssets;

  Future<ReviewedTransactionResult> review({
    required Map request,
    required Map account,
    required void Function() requireCurrent,
  }) async {
    requireCurrent();
    account = copied(account);
    inspectAccount(account, expectedChainId: chainId);
    final material = normalizeReviewedMaterial(request),
        plan = ReviewedRawPlan.fromMaterial(material),
        reader = ReviewedStatusReader(
          plan: plan,
          status: status,
          requireCurrent: requireCurrent,
        ),
        inputs = await reader.readInputs();
    requireCurrent();
    final scripts =
            <String>{
              for (final tx in plan.transactions)
                for (final o in tx['outputs']) o['scriptPubKey'],
              for (final row in inputs)
                for (final u in row) u['scriptPubKey'],
            }.toList(),
        codec = ReviewedTokenCodec(keyless),
        values = codec.codes(scripts),
        codes = {
          for (var i = 0; i < scripts.length; i++) scripts[i]: values[i],
        },
        orders = inspectReviewedLopCodes(keyless, scripts),
        groups = <String, List<int>>{};
    for (var i = 0; i < plan.transactions.length; i++) {
      final tx = plan.transactions[i],
          sides = <Map>[...inputs[i], ...(tx['outputs'] as List).cast<Map>()],
          hasToken = sides.any((u) => codes[u['scriptPubKey']] != null),
          hasHistorical = sides.any(
            (u) => reviewedHistoricalCandidate(
              u['scriptPubKey'],
              u['satoshis'] is int
                  ? BigInt.from(u['satoshis'])
                  : BigInt.parse(u['satoshis']),
            ),
          ),
          hasHtlc = sides.any(
            (u) => (u['scriptPubKey'] as String).length == 274,
          ),
          hasOrder = sides.any((u) => orders[u['scriptPubKey']] != null),
          hasNft = inputs[i].any((u) => _hold.hasMatch(u['scriptPubKey']));
      // Hints only dispatch to exact validators. Mixed unsupported scripts fail
      // there; no catch-and-fall-through signing path exists.
      final kind =
          hasOrder
              ? 'lop'
              : hasHtlc
              ? (hasToken ? 'tokenHtlc' : 'native')
              : hasToken || hasHistorical
              ? 'fungible'
              : hasNft
              ? 'nft'
              : 'native';
      groups.putIfAbsent(kind, () => []).add(i);
    }
    final pendingReads = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> sharedRead(String path) =>
        pendingReads.putIfAbsent(path, () async {
          requireCurrent();
          final result = await read(path);
          requireCurrent();
          return frozen(copied(result)) as Map<String, dynamic>;
        });
    Future<Map<int, Map<String, dynamic>>> dispatch(
      String kind,
      List<int> indexes,
    ) async {
      switch (kind) {
        case 'native':
          return reviewNativeTransactions(
            plan: plan,
            status: reader,
            verifiedInputs: inputs,
            material: material,
            account: account,
            chainId: chainId,
            transactionIndexes: indexes,
          );
        case 'nft':
          return reviewNftHolderTransactions(
            plan: plan,
            status: reader,
            verifiedInputs: inputs,
            material: material,
            account: account,
            chainId: chainId,
            transactionIndexes: indexes,
            assets: _nftAssets,
            requireCurrent: requireCurrent,
          );
        case 'fungible':
          return reviewFungibleHolderTransactions(
            plan: plan,
            status: reader,
            verifiedInputs: inputs,
            material: material,
            account: account,
            chainId: chainId,
            transactionIndexes: indexes,
            codec: codec,
            read: sharedRead,
            requireCurrent: requireCurrent,
          );
        case 'lop':
          return reviewLopTransactions(
            plan: plan,
            status: reader,
            verifiedInputs: inputs,
            material: material,
            account: account,
            chainId: chainId,
            transactionIndexes: indexes,
            codec: codec,
            keyless: keyless,
            read: sharedRead,
            requireCurrent: requireCurrent,
          );
        case 'tokenHtlc':
          return reviewHtlcTokenTransactions(
            plan: plan,
            status: reader,
            verifiedInputs: inputs,
            material: material,
            account: account,
            chainId: chainId,
            transactionIndexes: indexes,
            codec: codec,
            read: sharedRead,
            requireCurrent: requireCurrent,
          );
        default:
          throw StateError('REVIEWED_FAMILY');
      }
    }

    // Same-tick Tape requests coalesce and independent identity reads overlap.
    // Future.wait drains failed branches; no late signature/broadcast callbacks.
    final results = await Future.wait(
      groups.entries.map((e) => dispatch(e.key, e.value)),
    );
    requireCurrent();
    final byIndex = <int, Map<String, dynamic>>{};
    for (final result in results)
      for (final e in result.entries) {
        need(!byIndex.containsKey(e.key), 'REVIEWED_DUPLICATE_ROW');
        byIndex[e.key] = e.value;
      }
    need(
      byIndex.length == plan.transactions.length,
      'REVIEWED_INCOMPLETE_ROWS',
    );
    final preview =
            frozen({
                  'transactions': [
                    for (var i = 0; i < plan.transactions.length; i++)
                      byIndex[i]!,
                  ],
                })
                as Map<String, dynamic>,
        policy = reader.policyMaterial(),
        keylessMaterial = ReviewedKeylessMaterial(material, policy);
    checkReviewedIssuancePolicy(
      plan: plan,
      policyMaterial: policy,
      keyless: keyless,
    );
    verifyReviewedAssociatedPreview(
      plan: plan,
      material: keylessMaterial,
      publicKey: account['publicKey'],
      keyless: keyless,
    );
    requireCurrent();
    final artifact = bindReviewedArtifact(
      plan: plan,
      structuredPreview: preview,
      policyMaterial: policy,
      now: now(),
    );
    return ReviewedTransactionResult(
      material: material,
      plan: plan,
      policyMaterial: policy,
      preview: preview,
      artifact: artifact,
    );
  }
}
