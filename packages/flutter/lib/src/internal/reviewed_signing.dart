// Private codec/plan strategy for the shared signing lifecycle. This class has
// no approval, signer, network, persistence or public route of its own.
import 'protocol_codec.dart';
import 'reviewed_keyless.dart';
import 'reviewed_material.dart';
import 'reviewed_preview.dart';
import 'reviewed_reviewer.dart';
import 'tbc20_material.dart' show KeylessCall;

final class ReviewedSigningProgram {
  ReviewedSigningProgram({
    required Map request,
    required Map context,
    required Map account,
    required ReviewedTransactionResult reviewed,
    required String expiresAt,
    required this.keyless,
  }) : account = frozen(copied(account)) as Map<String, dynamic>,
       requestHash = hashJson(request),
       material = ReviewedKeylessMaterial(
         reviewed.material,
         reviewed.policyMaterial,
       ),
       review = frozen(copied(reviewed.artifact)) as Map<String, dynamic> {
    need(
      canonical(normalizeReviewedMaterial(request['request'])) ==
          canonical(material.material),
      'REVIEWED_REQUEST_BINDING',
    );
    final payload = review['payload'];
    need(
      hashJson(payload) == review['reviewHash'] &&
          canonical(payload['policyMaterial']) ==
              canonical(material.policyMaterial) &&
          canonical(payload['preview']) ==
              canonical(
                projectReviewedPreview(reviewed.plan, reviewed.preview),
              ) &&
          payload['totalFee'] == reviewed.plan.totalFee &&
          protocolTime(
                expiresAt,
              ).compareTo(protocolTime(payload['expiresAt'])) <=
              0,
      'REVIEWED_ARTIFACT_BINDING',
    );
    if (request['maxFee'] != null)
      need(
        BigInt.parse(payload['totalFee']) <= BigInt.parse(request['maxFee']),
        'FEE_CAP_EXCEEDED',
      );
    final contextHash = hashJson(context);
    final body = {
      'requestHash': requestHash,
      'contextHash': contextHash,
      'chainId': account['chainId'],
      'accountId': account['accountId'],
      'expiresAt': expiresAt,
      'task': {
        'taskId': 'review-single',
        'purpose': 'reviewedTransaction',
        'contextHash': contextHash,
        'requestHash': hashJson(request['request']),
        'reviewHash': review['reviewHash'],
        'policyMaterial': material.policyMaterial,
        'chainId': account['chainId'],
        'accountId': account['accountId'],
        'publicKey': account['publicKey'],
        'request': request['request'],
      },
      'preview': payload['preview'],
      'review': review,
    };
    plan =
        frozen({'payload': copied(body), 'planHash': hashJson(body)})
            as Map<String, dynamic>;
    transactionCount = reviewed.plan.transactions.length;
    final normalized = material.material['request'] as Map;
    totalTasks =
        associated
            ? [normalized['sourceUtxos'], ...normalized['inputs']].fold<int>(
              0,
              (sum, row) =>
                  sum +
                  (row as List)
                      .where((i) => i['scriptSigType'] != 'tbc_lop_match')
                      .length,
            )
            : (normalized['utxos_satoshis'] as List).fold<int>(
              0,
              (sum, row) => sum + (row as List).length,
            );
    need(
      transactionCount >= 1 &&
          transactionCount <= 32 &&
          totalTasks >= 1 &&
          totalTasks <= 32000,
      'REVIEWED_EXECUTION_BOUND',
    );
    _stage = _prepare();
  }
  final Map<String, dynamic> account, review;
  final String requestHash;
  final ReviewedKeylessMaterial material;
  final KeylessCall keyless;
  late final Map<String, dynamic> plan;
  late final int transactionCount, totalTasks;
  late ReviewedKeylessStage _stage;
  final _results = <Map<String, dynamic>>[];
  bool get associated => material.material['format'] == 'associated';
  int get stageIndex => _results.length;
  bool get complete => stageIndex == transactionCount;
  ReviewedKeylessStage _prepare() => ReviewedKeylessStage.prepare(
    keyless: keyless,
    material: material,
    publicKey: account['publicKey'],
    transactionIndex: stageIndex,
    previousTransactions:
        associated ? _results.map((r) => r['txraw'] as String).toList() : [],
  );

  List<Map<String, dynamic>> get tasks {
    need(!complete, 'REVIEWED_EXECUTION_COMPLETE');
    final indexes = _stage.value['signingInputIndexes'] as List,
        digests = _stage.value['digests'] as List;
    return List.unmodifiable([
      for (var i = 0; i < indexes.length; i++)
        Map<String, dynamic>.unmodifiable({
          'taskId': 'review-single-tx-$stageIndex-input-${indexes[i]}',
          'purpose': 'transaction',
          'algorithm': 'secp256k1-ecdsa-sha256d',
          'digest': digests[i],
          'signatureEncoding': 'compact64',
          'sighashType': 65,
          'transactionTemplateId': 'review-tx-$stageIndex',
          'inputIndex': indexes[i],
          'accountId': account['accountId'],
          'publicKey': account['publicKey'],
        }),
    ]);
  }

  /// Private native owner receives the exact initial request/policy and stage.
  /// It must reconstruct the stage itself, not accept Dart-provided digests.
  Map<String, dynamic> get initialMaterial {
    need(stageIndex == 0, 'REVIEWED_INITIAL_STAGE');
    return frozen({
          'kind': 'reviewed',
          'material': material.material,
          'policyMaterial': material.policyMaterial,
          'review': review,
          'stage': _stage.value,
        })
        as Map<String, dynamic>;
  }

  /// Actual signature verification and witness/child assembly stay in Rust.
  /// Do not refill, rebuild intent or fetch chain data between dependent stages.
  void finalize(List<Map<String, dynamic>> signatures) {
    need(!complete, 'REVIEWED_EXECUTION_COMPLETE');
    final expected = tasks;
    need(signatures.length == expected.length, 'REVIEWED_TASK_SIGNATURE_COUNT');
    for (var i = 0; i < expected.length; i++)
      need(
        signatures[i]['taskId'] == expected[i]['taskId'] &&
            signatures[i]['signatureEncoding'] == 'compact64',
        'REVIEWED_TASK_SIGNATURE_BINDING',
      );
    _results.add(
      _stage.finalize(
        keyless,
        signatures.map((s) => s['signature'] as String).toList(),
      ),
    );
    if (!complete) _stage = _prepare();
  }

  Map<String, dynamic> get continuation {
    need(stageIndex > 0 && !complete, 'REVIEWED_CONTINUATION_STAGE');
    return frozen({
          'kind': 'reviewed',
          'planHash': plan['planHash'],
          'stageIndex': stageIndex,
          'previousTransactions': _results.map((r) => r['txraw']).toList(),
          'stage': _stage.value,
          'signingRequests': tasks,
        })
        as Map<String, dynamic>;
  }

  Map<String, dynamic> bundle(String approvalId) {
    need(complete && approvalId.isNotEmpty, 'REVIEWED_EXECUTION_INCOMPLETE');
    return frozen({
          'version': '1.0',
          'chainId': account['chainId'],
          'from': account['address'],
          // Core changes the inner execution request hash back to the public outer request hash.
          'requestHash': requestHash, 'approvalId': approvalId,
          'transactions': [
            for (var i = 0; i < _results.length; i++)
              {
                'id': 'tx-${i + 1}',
                'txid': _results[i]['txid'],
                'rawTransaction': _results[i]['txraw'],
                'role':
                    associated && i < _results.length - 1
                        ? 'prerequisite'
                        : 'primary',
                'dependsOn': associated && i > 0 ? ['tx-$i'] : <String>[],
              },
          ],
          'totalFee': review['payload']['totalFee'],
          if (!associated)
            'detachedSignatures': _results.map((r) => r['sigs']).toList(),
        })
        as Map<String, dynamic>;
  }
}
