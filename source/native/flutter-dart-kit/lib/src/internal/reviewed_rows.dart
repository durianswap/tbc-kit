// Exact shared binding between a parsed review plan and authenticated inputs.
import 'protocol_codec.dart';
import 'reviewed_material.dart';
import 'reviewed_status.dart';

List<Map<String, dynamic>> boundReviewedRows({
  required ReviewedRawPlan plan,
  required ReviewedStatusReader status,
  required List<List<Map<String, dynamic>>> verifiedInputs,
  required List<int> transactionIndexes,
}) {
  need(
    identical(status.plan, plan) &&
        verifiedInputs.length == plan.transactions.length &&
        transactionIndexes.isNotEmpty &&
        transactionIndexes.length <= 32 &&
        transactionIndexes.toSet().length == transactionIndexes.length &&
        transactionIndexes.every((i) => i >= 0 && i < plan.transactions.length),
    'REVIEWED_HOLDER_ROWS',
  );
  final rows = <Map<String, dynamic>>[];
  for (final index in List<int>.of(transactionIndexes)) {
    final tx = plan.transactions[index], inputs = verifiedInputs[index];
    need(
      inputs.length == (tx['inputs'] as List).length,
      'REVIEWED_HOLDER_INPUTS',
    );
    for (var i = 0; i < inputs.length; i++) {
      final p = tx['inputs'][i], u = inputs[i];
      need(
        u['spent'] == false &&
            p['txid'] == u['txid'] &&
            p['vout'] == u['vout'] &&
            u['satoshis'] == plan.rawRequest['utxos_satoshis'][index][i] &&
            u['scriptPubKey'] == plan.rawRequest['script_pubkeys'][index][i],
        'REVIEWED_HOLDER_INPUT_BINDING',
      );
    }
    rows.add({'index': index, 'transaction': tx, 'inputs': inputs});
  }
  return rows;
}
