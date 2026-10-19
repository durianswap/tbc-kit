// Recheck the bound raw projection against frozen Rust's issuance policy.
// It consumes only an authenticated review snapshot: no fetch, signer or log.
import 'dart:convert';
import 'protocol_codec.dart';
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'tbc20_material.dart' show KeylessCall;

void checkReviewedIssuancePolicy({
  required ReviewedRawPlan plan,
  required Map policyMaterial,
  required KeylessCall keyless,
}) {
  final policy = normalizeReviewedPolicy(policyMaterial);
  final points = <String, Map<String, dynamic>>{};
  void put(Map<String, dynamic> row) {
    final key = '${row['txid']}:${row['vout']}', old = points[key];
    need(
      old == null || canonical(old) == canonical(row),
      'REVIEWED_POLICY_CONFLICT',
    );
    points[key] = row;
  }

  need(
    plan.transactionIds.toSet().length == plan.transactionIds.length,
    'REVIEWED_POLICY_DUPLICATE_TRANSACTION',
  );
  final local = <String, Map<String, dynamic>>{};
  var rawBytes = 0;
  for (var t = 0; t < plan.transactions.length; t++) {
    final tx = plan.transactions[t];
    rawBytes += (plan.rawRequest['txraws'][t] as String).length;
    need(rawBytes <= 8388608, 'REVIEWED_POLICY_RAW_BOUND');
    final inputs = tx['inputs'] as List, outputs = tx['outputs'] as List;
    for (var i = 0; i < inputs.length; i++) {
      put({
        'txid': inputs[i]['txid'],
        'vout': inputs[i]['vout'],
        'satoshis': '${plan.rawRequest['utxos_satoshis'][t][i]}',
        'scriptPubKey': plan.rawRequest['script_pubkeys'][t][i],
      });
    }
    for (var v = 0; v < outputs.length; v++) {
      local['${tx['txid']}:$v'] = {
        'txid': tx['txid'],
        'vout': v,
        ...copied(outputs[v]),
      };
    }
  }
  for (final output in policy['resolvedOutputs'] as List) {
    need(
      BigInt.parse(output['satoshis']) <= BigInt.from(9007199254740991),
      'REVIEWED_POLICY_UNSAFE_AMOUNT',
    );
    put(Map<String, dynamic>.from(output));
  }
  final batch = plan.transactionIds.toSet();
  for (final row in points.values.where((v) => batch.contains(v['txid']))) {
    need(
      canonical(local['${row['txid']}:${row['vout']}']) == canonical(row),
      'REVIEWED_POLICY_LOCAL_SHADOW',
    );
  }
  final request = <String, dynamic>{
    'phase': 'checkHistoricalIssuance',
    'transactions': [
      for (final raw in plan.rawRequest['txraws']) {'rawTransaction': raw},
    ],
    'resolvedOutputs':
        points.values.where((v) => !batch.contains(v['txid'])).toList(),
  };
  need(
    (request['resolvedOutputs'] as List).length <= 10000 &&
        utf8.encode(canonical(request)).length <= 8388608,
    'REVIEWED_POLICY_BOUND',
  );
  Map<String, dynamic> result;
  try {
    result = keyless('inspectTokenMaterial', request);
  } catch (_) {
    // Native exceptions may embed a raw witness; never surface their content.
    throw StateError('REVIEWED_ISSUANCE_POLICY_REJECTED');
  }
  need(
    result.length == 3 &&
        result['verification'] == 'historical-issuance-policy' &&
        result['assetIdentityVerified'] == false &&
        canonical(result['transactionIds']) == canonical(plan.transactionIds),
    'REVIEWED_POLICY_RESULT',
  );
}
