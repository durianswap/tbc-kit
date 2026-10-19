// Data-only bridge to the frozen Rust Reviewed codec. This cannot sign or
// approve. Native custody must independently reconstruct the bound stage;
// the shared executor (not a page or Legacy adapter) supplies signatures.
import 'protocol_codec.dart';
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show KeylessCall;

/// Own the complete operation snapshot once, not once per dependent stage.
/// The policy supplied here must come from the trusted review, never the page.
final class ReviewedKeylessMaterial {
  ReviewedKeylessMaterial(Map material, Map policyMaterial)
    : material = frozen(copied(material)) as Map<String, dynamic>,
      policyMaterial = normalizeReviewedPolicy(policyMaterial);
  final Map<String, dynamic> material, policyMaterial;
}

/// Match the frozen current-associated review preflight. These unsigned-stage
/// digests are discarded, not authorized for signing. Execution reconstructs
/// each stage using actual finalized parents under the same bound material.
/// Shared review calls this once after collecting authenticated policy inputs.
void verifyReviewedAssociatedPreview({
  required ReviewedRawPlan plan,
  required ReviewedKeylessMaterial material,
  required String publicKey,
  required KeylessCall keyless,
}) {
  if (material.material['format'] != 'associated') return;
  final request = material.material['request'] as Map;
  final rows = [request['sourceUtxos'], ...request['inputs']];
  final current = rows.any(
    (row) => (row as List).any(
      (input) =>
          input['scriptSigType'] == 'tbc20-standard' ||
          input['scriptSigType'] == 'tbc20-stablecoin',
    ),
  );
  if (!current) return;
  final raws = (plan.rawRequest['txraws'] as List).cast<String>();
  need(raws.length == rows.length, 'REVIEWED_PREFLIGHT_COUNT');
  for (var index = 0; index < raws.length; index++) {
    final stage = ReviewedKeylessStage.prepare(
      keyless: keyless,
      material: material,
      publicKey: publicKey,
      transactionIndex: index,
      previousTransactions: raws.sublist(0, index),
    );
    need(stage.value['txraw'] == raws[index], 'REVIEWED_PREFLIGHT_PREVIEW');
  }
}

final class ReviewedKeylessStage {
  ReviewedKeylessStage._(this.value, this.material, this.index);
  final Map<String, dynamic> value, material;
  final int index;

  static ReviewedKeylessStage prepare({
    required KeylessCall keyless,
    required ReviewedKeylessMaterial material,
    required String publicKey,
    required int transactionIndex,
    required List<String> previousTransactions,
  }) {
    final owned = material.material;
    final request = owned['request'], format = owned['format'];
    need(format == 'raw' || format == 'associated', 'REVIEWED_FORMAT');
    final count =
        format == 'raw'
            ? (request['txraws'] as List).length
            : 1 + (request['inputs'] as List).length;
    need(
      count >= 1 &&
          count <= 32 &&
          transactionIndex >= 0 &&
          transactionIndex < count,
      'REVIEWED_STAGE_INDEX',
    );
    need(
      previousTransactions.length == (format == 'raw' ? 0 : transactionIndex),
      'REVIEWED_PARENT_COUNT',
    );
    need(
      RegExp(r'^(02|03)[0-9a-f]{64}$').hasMatch(publicKey),
      'REVIEWED_PUBLIC_KEY',
    );
    // Rust reconstructs and checks finalized parents. Do not parse all prior
    // raws a second time at every stage; each result is checked at finalization.
    final policy = material.policyMaterial;
    Map<String, dynamic> stage;
    try {
      stage = keyless('prepareReviewedStage', {
        'format': format,
        'request': request,
        'publicKey': publicKey,
        'transactionIndex': transactionIndex,
        'previousTransactions': List<String>.of(previousTransactions),
        'resolvedOutputs': policy['resolvedOutputs'],
      });
    } catch (_) {
      throw StateError('REVIEWED_KEYLESS_PREPARE_FAILED');
    }
    need(
      stage['format'] == format &&
          stage['transactionIndex'] == transactionIndex &&
          stage['publicKey'] == publicKey &&
          stage['txraw'] is String &&
          stage['inputs'] is List &&
          stage['signingInputIndexes'] is List &&
          stage['digests'] is List,
      'REVIEWED_STAGE_IDENTITY',
    );
    final parsed = inspectTransaction(stage['txraw']),
        inputs = stage['inputs'] as List,
        indexes = stage['signingInputIndexes'] as List,
        digests = stage['digests'] as List;
    final signingIndexes = indexes.toSet();
    need(
      inputs.length == (parsed['inputs'] as List).length &&
          indexes.length == digests.length &&
          signingIndexes.length == indexes.length &&
          indexes.every((i) => i is int && i >= 0 && i < inputs.length),
      'REVIEWED_STAGE_MATRIX',
    );
    if (format == 'raw')
      need(
        stage['txraw'] == request['txraws'][transactionIndex],
        'REVIEWED_RAW_REPLACED',
      );
    for (var i = 0; i < inputs.length; i++) {
      final input = inputs[i], point = parsed['inputs'][i];
      need(
        input is Map &&
            input['txId'] == point['txid'] &&
            input['outputIndex'] == point['vout'] &&
            input['script'] is String &&
            input['satoshis'] is int &&
            input['satoshis'] >= 0 &&
            input['satoshis'] <= 9007199254740991 &&
            input['signingPublicKey'] == null &&
            input['signingRole'] == null,
        'REVIEWED_INPUT_IDENTITY',
      );
      // LOP match is covenant execution, not an owner signing task. All other
      // inputs must be represented exactly once; raw returns one per input.
      need(
        signingIndexes.contains(i) ==
            !(format == 'associated' &&
                input['scriptSigType'] == 'tbc_lop_match'),
        'REVIEWED_SIGNING_INPUT_COVERAGE',
      );
    }
    for (final digest in digests) hash32(digest);
    final tasks = stage['signingTasks'];
    if (tasks != null) {
      need(
        tasks is List && tasks.length == indexes.length,
        'REVIEWED_TASK_COUNT',
      );
      for (var i = 0; i < indexes.length; i++)
        need(
          canonical(tasks[i]) ==
              canonical({
                'inputIndex': indexes[i],
                'digest': digests[i],
                'publicKey': publicKey,
                'algorithm': 'secp256k1-ecdsa',
              }),
          'REVIEWED_TASK_IDENTITY',
        );
    }
    return ReviewedKeylessStage._(
      frozen(copied(stage)) as Map<String, dynamic>,
      owned,
      transactionIndex,
    );
  }

  Map<String, dynamic> finalize(KeylessCall keyless, List<String> signatures) {
    need(
      signatures.length == (value['digests'] as List).length &&
          signatures.every((s) => RegExp(r'^[0-9a-f]{128}$').hasMatch(s)),
      'REVIEWED_SIGNATURE_SHAPE',
    );
    Map<String, dynamic> result;
    try {
      result = keyless('finalizeReviewedStage', {
        'stage': value,
        'signatures': List<String>.of(signatures),
        'signatureEncoding': 'compact64',
      });
    } catch (_) {
      throw StateError('REVIEWED_KEYLESS_FINALIZE_FAILED');
    }
    need(
      result['txraw'] is String &&
          result['txid'] is String &&
          result['sigs'] is List,
      'REVIEWED_FINALIZED_SHAPE',
    );
    final parsed = inspectTransaction(result['txraw'], result['txid']),
        unsigned = inspectTransaction(value['txraw']);
    final sigs = result['sigs'] as List;
    need(
      sigs.length == (value['signingInputIndexes'] as List).length &&
          sigs.every(
            (s) =>
                s is String &&
                s.isNotEmpty &&
                s.length <= 1024 &&
                RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(s),
          ),
      'REVIEWED_DETACHED_SHAPE',
    );
    need(
      canonical(parsed['outputs']) == canonical(unsigned['outputs']) &&
          parsed['locktime'] == unsigned['locktime'] &&
          (parsed['inputs'] as List).length ==
              (unsigned['inputs'] as List).length,
      'REVIEWED_FINALIZED_BODY',
    );
    for (var i = 0; i < (parsed['inputs'] as List).length; i++) {
      final a = parsed['inputs'][i], b = unsigned['inputs'][i];
      need(
        a['txid'] == b['txid'] &&
            a['vout'] == b['vout'] &&
            a['sequence'] == b['sequence'],
        'REVIEWED_FINALIZED_INPUT',
      );
    }
    if (material['format'] == 'raw')
      need(result['txraw'] == value['txraw'], 'REVIEWED_DETACHED_RAW_REPLACED');
    return frozen(copied(result)) as Map<String, dynamic>;
  }
}
