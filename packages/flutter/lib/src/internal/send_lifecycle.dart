// Post-signing strategy of the shared executor, not a page-facing raw sender.
// Engine/Reviewed validation happens in the common stage runner. Native custody
// independently authorizes the final bundle and fences actual network dispatch.
import '../signing_backend.dart';
import 'protocol_codec.dart';

const sendMethods = {
  'tbc_sendTransaction',
  'tbc_sendPreparedTransaction',
  'tbc_sendWorkflow',
  'tbc_sendPreparedWorkflow',
};

final class TbcSendLifecycle {
  TbcSendLifecycle({
    required this.custody,
    required this.receipt,
    required this.receiptCheck,
  });
  final TbcBroadcastSigningOperation custody;
  final TbcSigningReceipt receipt;
  final void Function() receiptCheck;

  Future<void> _fresh() async {
    receiptCheck();
    await custody.requireCurrent();
    receiptCheck();
  }

  Future<T> _call<T>(Future<T> Function() call) async {
    await _fresh();
    final result = await call();
    await _fresh();
    return result;
  }

  bool _ambiguous(Map result) =>
      result['portError'] is Map &&
      result['portError']['retryable'] == true &&
      {'UNAVAILABLE', 'INTERNAL_ERROR'}.contains(result['portError']['name']);

  List<Map<String, dynamic>> _transactions(Map bundle) {
    need(bundle['transactions'] is List, 'BROADCAST_BUNDLE');
    final txs = (bundle['transactions'] as List).cast<Map<String, dynamic>>();
    need(
      txs.isNotEmpty &&
          txs.length <= 32 &&
          txs.map((t) => t['txid']).toSet().length == txs.length,
      'BROADCAST_BATCH_BOUNDS',
    );
    return txs;
  }

  void _result(Map result, String txid, Set<String> statuses) {
    need(
      result['txid'] == txid &&
          statuses.contains(result['status']) &&
          result.keys.every({'txid', 'status', 'reason'}.contains) &&
          (!result.containsKey('reason') || result['reason'] is String),
      'BROADCAST_RESULT_IDENTITY',
    );
  }

  Future<Map<String, dynamic>> single(Map signed) async {
    final material = TbcBroadcastMaterial(bundle: signed),
        txs = _transactions(material.bundle);
    await _call(() => custody.authorizeBroadcast(receipt, material));
    var reconciled = false;
    for (var index = 0; index < txs.length; index++) {
      final result =
          (await _call(() => custody.submitTransaction(receipt, index))).wire;
      if (result.containsKey('portError')) {
        need(_ambiguous(result), 'BROADCAST_FAILED');
        need(!reconciled, 'BROADCAST_RECONCILIATION_LIMIT');
        reconciled = true;
        final prefix = List<String>.unmodifiable(
          txs.take(index + 1).map((t) => t['txid'] as String),
        );
        final status =
            (await _call(
              () => custody.reconcileSubmitted(receipt, prefix),
            )).wire;
        need(
          status.keys.length == 1 && status['transactions'] is List,
          'BROADCAST_RECONCILIATION_RESULT',
        );
        final items = status['transactions'] as List;
        need(items.length == prefix.length, 'BROADCAST_RECONCILIATION_RESULT');
        for (var i = 0; i < items.length; i++) {
          final item = items[i];
          need(
            item is Map &&
                item['txid'] == prefix[i] &&
                {
                  'unknown',
                  'rejected',
                  'mempool',
                  'confirmed',
                }.contains(item['status']),
            'BROADCAST_RECONCILIATION_RESULT',
          );
          need(
            {'mempool', 'confirmed'}.contains(item['status']),
            'BROADCAST_UNCONFIRMED',
          );
        }
        if (index + 1 < txs.length) {
          final submittedIds = txs.take(index + 1).map((t) => t['id']).toSet();
          need(
            (txs[index + 1]['dependsOn'] as List).every(submittedIds.contains),
            'BROADCAST_DEPENDENCY',
          );
        }
        continue;
      }
      _result(result, txs[index]['txid'], {'accepted', 'known', 'rejected'});
      need(result['status'] != 'rejected', 'BROADCAST_REJECTED');
    }
    final result = <String, dynamic>{
      ...material.bundle,
      'transactions': [
        for (final tx in txs)
          {
            'id': tx['id'],
            'txid': tx['txid'],
            'status': 'submitted',
            'role': tx['role'],
            'dependsOn': tx['dependsOn'],
          },
      ],
    };
    await _call(
      () => custody.finishBroadcast(receipt, TbcBroadcastResult(result)),
    );
    return result;
  }

  Future<Map<String, dynamic>> workflow(
    Map signed,
    List<String> stepOrder,
  ) async {
    final rows = (signed['steps'] as List).cast<Map>(),
        txs = <Map<String, dynamic>>[];
    need(
      stepOrder.length == rows.length &&
          stepOrder.toSet().length == rows.length,
      'BROADCAST_WORKFLOW_ORDER',
    );
    for (final id in stepOrder) {
      final row = rows.singleWhere((r) => r['id'] == id);
      if (!{
            'transaction',
            'preparedTransaction',
            'reviewedTransaction',
          }.contains(row['kind']) ||
          !row.containsKey('result'))
        continue;
      txs.addAll(
        (row['result']['transactions'] as List).cast<Map<String, dynamic>>(),
      );
    }
    final material = TbcBroadcastMaterial(
      bundle: {
        'version': '1.0',
        'chainId': signed['chainId'],
        'from': signed['from'],
        'requestHash': signed['requestHash'],
        'approvalId': signed['approvalId'],
        'transactions': txs,
        'totalFee': signed['totalFee'],
      },
      workflow: signed,
    );
    final ordered = _transactions(material.bundle);
    await _call(() => custody.authorizeBroadcast(receipt, material));
    final response = (await _call(() => custody.submitBatch(receipt))).wire;
    List results;
    if (response.containsKey('portError')) {
      need(_ambiguous(response), 'BROADCAST_BATCH_FAILED');
      results = [
        for (final tx in ordered)
          {
            'txid': tx['txid'],
            'status': 'unknown',
            'reason':
                'Submission outcome is unknown; query status without resending',
          },
      ];
    } else {
      need(
        response.keys.length == 1 && response['transactions'] is List,
        'BROADCAST_BATCH_RESULT',
      );
      results = response['transactions'];
    }
    need(results.length == ordered.length, 'BROADCAST_BATCH_RESULT');
    final byId = <String, String>{}, safe = <Map<String, dynamic>>[];
    for (var i = 0; i < ordered.length; i++) {
      need(results[i] is Map, 'BROADCAST_BATCH_RESULT');
      final item = results[i] as Map, tx = ordered[i];
      _result(item, tx['txid'], {'accepted', 'known', 'rejected', 'unknown'});
      final blocked = (tx['dependsOn'] as List).any(
        (d) => {'rejected', 'unknown'}.contains(byId[d]),
      );
      final normalized =
          blocked && {'accepted', 'known'}.contains(item['status'])
              ? <String, dynamic>{
                'txid': item['txid'],
                'status': 'unknown',
                'reason': 'A prerequisite transaction was not accepted',
              }
              : copied(item);
      byId[tx['id']] = normalized['status'];
      safe.add(normalized);
    }
    final statuses = safe.map((r) => r['status']).toSet();
    final result = <String, dynamic>{
      'version': '1.0',
      'status':
          statuses.every({'accepted', 'known'}.contains)
              ? 'complete'
              : statuses.length == 1 && statuses.contains('rejected')
              ? 'rejected'
              : statuses.length == 1 && statuses.contains('unknown')
              ? 'unknown'
              : 'partial',
      'workflow': material.workflow,
      'transactions': safe,
    };
    await _call(
      () => custody.finishBroadcast(receipt, TbcBroadcastResult(result)),
    );
    return result;
  }
}
