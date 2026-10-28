// Wallet-local orchestration of the existing mint executor. No Provider RPC,
// transaction builder, key custody, retry loop or persistent UTXO manager.
import 'dart:convert';
import 'protocol_codec.dart';
import 'transaction_read.dart';

typedef NftJobMap = Map<String, dynamic>;

// Dart clocks may contain microseconds. Truncate (never extend) the expiry at
// this local API boundary; the signed protocol remains millisecond UTC.
String nftMintJobTime(String value) {
  final time = value.replaceFirstMapped(
    RegExp(r'\.(\d{3})\d{1,3}Z$'),
    (m) => '.${m[1]}Z',
  );
  protocolTime(time);
  return time;
}

NftJobMap nftMintJobRequest(
  NftJobMap scope,
  int offset,
  int count,
  String remainingFee,
  String expiresAt,
) => copied({
  'version': '1.0',
  'chainId': scope['authority']['chainId'],
  'from': scope['authority']['address'],
  'intent': {
    'version': '1.0',
    'type': 'tbc721-standard-batch-mint',
    'collectionId': scope['collectionId'],
    'items': (scope['items'] as List).skip(offset).take(count).toList(),
  },
  'constraints': {'maxFee': remainingFee, 'expiresAt': expiresAt},
});

/// Ownership is taken before any await. Engine normalize validates the same
/// existing item schema before approval; there is no weaker job-specific schema.
NftJobMap nftMintJobScope({
  required NftJobMap authority,
  required String collectionId,
  required List<Map<String, dynamic>> items,
  required NftJobMap limits,
  required void Function(NftJobMap) validateRequest,
}) {
  need(items.isNotEmpty && items.length <= 2000, 'NFT_JOB_ITEM_BOUND');
  final input = copied({
    'authority': authority,
    'collectionId': collectionId,
    'items': items,
    'limits': limits,
  });
  need(
    utf8.encode(canonical(input)).length <= 8 * 1024 * 1024,
    'NFT_JOB_BYTES',
  );
  hash32(collectionId);
  need(
    authority['accountId'] ==
            '${authority['chainId']}:${authority['address']}' &&
        authority['sessionId'] is String &&
        (authority['sessionId'] as String).isNotEmpty,
    'NFT_JOB_AUTHORITY',
  );
  need(
    limits.keys.every(
      {
        'maxTotalFee',
        'expiresAt',
        'maxItemsPerBatch',
        'maxPlanBytes',
        'maxTotalPlanBytes',
      }.contains,
    ),
    'NFT_JOB_LIMIT_FIELDS',
  );
  final normalized = <String, dynamic>{
    'maxItemsPerBatch': 100,
    'maxPlanBytes': 4 * 1024 * 1024,
    'maxTotalPlanBytes': 32 * 1024 * 1024,
    ...input['limits'] as Map<String, dynamic>,
  };
  final maximum = normalized['maxItemsPerBatch'],
      bytes = normalized['maxPlanBytes'],
      total = normalized['maxTotalPlanBytes'];
  need(
    maximum is int &&
        maximum >= 1 &&
        maximum <= 100 &&
        bytes is int &&
        bytes >= 1 &&
        bytes <= 4 * 1024 * 1024 &&
        total is int &&
        total >= bytes &&
        total <= 32 * 1024 * 1024,
    'NFT_JOB_LIMITS',
  );
  need(normalized['maxTotalFee'] is String, 'NFT_JOB_FEE');
  final fee = BigInt.parse(uintString(normalized['maxTotalFee']));
  need(fee <= BigInt.from(2100000000000000), 'NFT_JOB_FEE');
  normalized['expiresAt'] = nftMintJobTime(normalized['expiresAt']);
  final ownedItems = [
    for (final item in input['items'] as List)
      {
        ...item as Map<String, dynamic>,
        'to': item['to'] ?? authority['address'],
      },
  ];
  need(
    ownedItems.map((i) => i['slot']).toSet().length == ownedItems.length,
    'NFT_JOB_DUPLICATE_SLOT',
  );
  final scope =
      frozen({
            'operationKind': 'tbc721.batchMint',
            'authority': input['authority'],
            'collectionId': collectionId,
            'items': ownedItems,
            'limits': normalized,
          })
          as NftJobMap;
  for (var offset = 0; offset < ownedItems.length; offset += 100) {
    validateRequest(
      nftMintJobRequest(
        scope,
        offset,
        100,
        fee.toString(),
        normalized['expiresAt'],
      ),
    );
  }
  return scope;
}

abstract class NftMintJobAdapter {
  Future<void> requireCurrent();
  Future<void> prepare(NftJobMap scope);
  Future<void> approve(NftJobMap scope);

  /// One ordinary executor invocation. Native custody owns the exact slice,
  /// remaining budget and actual journal outcomes; it returns no raw witnesses.
  Future<NftJobMap> execute(NftJobMap request, int offset);
  Future<NftJobMap> finish(String reason);
}

final class NftMintJob {
  NftMintJob(
    this.adapter, {
    this.executionBatchSize = 10,
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now {
    need(
      executionBatchSize >= 1 && executionBatchSize <= 100,
      'NFT_JOB_BATCH_BOUND',
    );
  }
  final NftMintJobAdapter adapter;
  final int executionBatchSize;
  final DateTime Function() clock;
  bool _running = false;
  Future<NftJobMap> run(NftJobMap scope) async {
    need(!_running, 'NFT_JOB_ACTIVE');
    _running = true;
    try {
      await adapter.requireCurrent();
      need(
        clock().isBefore(protocolTime(scope['limits']['expiresAt'])),
        'NFT_JOB_EXPIRED',
      );
      // Own the read error immediately while consent is still on screen.
      final preparing = adapter
          .prepare(scope)
          .then<Object?>(
            (_) => null,
            onError: (Object _, StackTrace __) => false,
          );
      await adapter.approve(scope);
      if (await preparing == false) return adapter.finish('preparation-failed');
      final items = scope['items'] as List, limits = scope['limits'] as Map;
      final countLimit =
          (limits['maxItemsPerBatch'] as int) < executionBatchSize
              ? limits['maxItemsPerBatch'] as int
              : executionBatchSize;
      var offset = 0;
      var paid = BigInt.zero;
      while (offset < items.length) {
        await adapter.requireCurrent();
        if (!clock().isBefore(protocolTime(limits['expiresAt'])))
          return adapter.finish('expired');
        final count =
            (items.length - offset) < countLimit
                ? items.length - offset
                : countLimit;
        final remaining = BigInt.parse(limits['maxTotalFee']) - paid;
        final expiry = protocolTime(limits['expiresAt']);
        final childExpiry = clock().toUtc().add(const Duration(seconds: 120));
        final request = nftMintJobRequest(
          scope,
          offset,
          count,
          remaining.toString(),
          nftMintJobTime(
            (childExpiry.isBefore(expiry) ? childExpiry : expiry)
                .toIso8601String(),
          ),
        );
        NftJobMap result;
        try {
          result = await adapter.execute(request, offset);
        } catch (_) {
          return adapter.finish('execution-failed');
        }
        // This is the native aggregate, not the Dart executor's assertion.
        if (result['status'] != 'complete')
          return adapter.finish(
            result['status'] == 'uncertain'
                ? 'submission-uncertain'
                : 'execution-failed',
          );
        need(
          result['offset'] == offset && result['count'] == count,
          'NFT_JOB_RESULT_SCOPE',
        );
        final rows = result['transactions'] as List;
        need(
          rows.length == count &&
              rows.every((r) => ['accepted', 'known'].contains(r['status'])),
          'NFT_JOB_RESULT_STATUS',
        );
        paid += rows.fold<BigInt>(
          BigInt.zero,
          (s, r) => s + BigInt.parse(uintString(r['fee'])),
        );
        need(paid <= BigInt.parse(limits['maxTotalFee']), 'NFT_JOB_RESULT_FEE');
        offset += count;
      }
      return adapter.finish('complete');
    } finally {
      _running = false;
    }
  }
}
