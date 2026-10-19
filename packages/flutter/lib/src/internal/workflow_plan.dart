// Generic planning strategy for the shared lifecycle. Produces no signatures,
// approvals, broadcasts or persistence; public capability remains disabled
// until the native whole-batch execution/delivery boundary is integrated.
import 'dart:async';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'transaction_signing_roles.dart';
import 'prepared_proposal.dart';
import 'typed_signing.dart';
import 'reviewed_reviewer.dart';
import 'reviewed_signing.dart';
import 'tbc20_material.dart' show KeylessCall;
import 'workflow_request.dart';

typedef WorkflowEngine =
    Map<String, dynamic> Function(String, Map<String, dynamic>);
typedef WorkflowMaterial =
    Future<Map<String, dynamic>> Function(
      String stepId,
      Map<String, dynamic> request,
      TransactionSigningAccounts accounts,
    );
typedef WorkflowReview =
    Future<ReviewedTransactionResult> Function(
      String stepId,
      Map<String, dynamic> request,
      Map<String, dynamic> account,
      void Function() requireCurrent,
    );

final class WorkflowPreparation {
  WorkflowPreparation._(
    this.request,
    this.plan,
    this.binding,
    this.materials,
    this.reviewedPrograms,
  );
  final Map<String, dynamic> request, plan, binding;
  final Map<String, Map<String, dynamic>> materials;
  // Private mutable stage machines are deliberately separate from immutable
  // approved data; only the future shared executor may advance them.
  final Map<String, ReviewedSigningProgram> reviewedPrograms;
}

Map<String, dynamic> workflowRecoverableTask({
  required String taskId,
  required Map envelope,
  required Map account,
  required String origin,
  required String purpose,
  MessageSigningProfile messageProfile = MessageSigningProfile.standard,
}) => {
  'taskId': taskId,
  'purpose': purpose,
  'algorithm': 'secp256k1-recoverable-ecdsa-sha256d',
  'digest':
      purpose == 'message'
          ? messageDigest(envelope, profile: messageProfile)
          : typedDataDigest(envelope),
  'signatureEncoding': 'compact65-recoverable',
  'origin': origin,
  'accountId': account['accountId'],
  'publicKey': account['publicKey'],
};

/// Trusted callbacks are operation-scoped. They may reuse the existing shared
/// read scope; this planner neither creates another fetch layer nor caches
/// mutable UTXOs across operations. All branches are drained on failure.
Future<WorkflowPreparation> prepareWorkflow({
  required String method,
  required Map input,
  required Map context,
  required Map account,
  List<Map<String, dynamic>> additionalAccounts = const [],
  required String expiresAt,
  required DateTime Function() now,
  required void Function() requireCurrent,
  required WorkflowEngine engine,
  required WorkflowMaterial prepareMaterial,
  WorkflowReview? prepareReviewed,
  KeylessCall? keyless,
  MessageSigningProfile messageProfile = MessageSigningProfile.standard,
}) async {
  final request = checkedWorkflowRequest(
    method: method,
    input: input,
    origin: context['origin'],
    now: now(),
  );
  final trustedContext = frozen(copied(context)) as Map<String, dynamic>;
  final owner = frozen(copied(account)) as Map<String, dynamic>;
  inspectAccount(owner, expectedChainId: request['chainId']);
  need(request['from'] == owner['address'], 'WORKFLOW_ACCOUNT');
  final steps = (request['steps'] as List).cast<Map<String, dynamic>>();
  var deadline = expiresAt;
  void shorten(String candidate) {
    if (protocolTime(candidate).isBefore(protocolTime(deadline)))
      deadline = candidate;
  }

  if (request['expiresAt'] != null) shorten(request['expiresAt']);
  // Same expiry intersection as single Prepared calls and JS Core. Fresh
  // wallet material cannot extend the lifetime of an external child proposal.
  for (final step in steps) {
    if (step['kind'] == 'preparedTransaction') {
      shorten(step['proposal']['payload']['expiresAt']);
    }
  }
  void fresh() {
    requireCurrent();
    need(now().isBefore(protocolTime(deadline)), 'WORKFLOW_EXPIRED');
  }

  fresh();
  final selected = <String, TransactionSigningAccounts>{};
  final normalized = <String, Map<String, dynamic>>{};
  final extra = additionalAccounts.map(copied).toList(growable: false);
  need(
    extra.map((a) => a['accountId']).toSet().length == extra.length,
    'WORKFLOW_DUPLICATE_ACCOUNT',
  );
  for (final a in extra) inspectAccount(a, expectedChainId: request['chainId']);
  need(
    [
          owner,
          ...extra,
        ].map((a) => (a['publicKey'] as String).substring(2)).toSet().length ==
        extra.length + 1,
    'WORKFLOW_AMBIGUOUS_ACCOUNT',
  );
  final usedAccounts = <String>{};
  // Normalize all requests before starting I/O. No partly invalid graph can
  // request consent or start a signing operation through this compiler.
  for (final step in steps.where(workflowTransaction)) {
    final r = workflowTransactionRequest(request, step),
        id = step['id'] as String;
    final roleIds =
        ((step['signingRoles'] ?? []) as List)
            .map((r) => r['accountId'])
            .toSet();
    final roles = TransactionSigningAccounts.resolve(
      request: r,
      primary: owner,
      additional: extra.where((a) => roleIds.contains(a['accountId'])).toList(),
    );
    usedAccounts.addAll(roles.additional.map((a) => a['accountId'] as String));
    selected[id] = roles;
    fresh();
    final n = engine('normalizeRequest', {'version': '1.0', 'request': r});
    need(
      canonical(n['request']) == canonical(r) &&
          n['requestHash'] == hashJson(r),
      'WORKFLOW_NORMALIZATION',
    );
    normalized[id] = frozen(copied(n)) as Map<String, dynamic>;
  }
  need(
    extra.every((a) => usedAccounts.contains(a['accountId'])),
    'WORKFLOW_UNREQUESTED_ACCOUNT',
  );
  final materials = <String, Map<String, dynamic>>{};
  final reviews = <String, ReviewedTransactionResult>{};
  Future<void> load(Map<String, dynamic> step) async {
    final id = step['id'] as String;
    fresh();
    if (workflowTransaction(step)) {
      final raw = await prepareMaterial(
        id,
        normalized[id]!['request'],
        selected[id]!,
      );
      fresh();
      final snapshot = copied(raw['snapshot']), policy = copied(raw['policy']);
      need(
        hashJson(snapshot['payload']) == snapshot['snapshotHash'],
        'SNAPSHOT_HASH',
      );
      need(hashJson(policy['payload']) == policy['policyHash'], 'POLICY_HASH');
      selected[id]!.requireSnapshot(snapshot['payload']);
      need(
        snapshot['payload']['chainId'] == request['chainId'] &&
            policy['payload']['chainId'] == request['chainId'],
        'MATERIAL_CHAIN',
      );
      need(
        !protocolTime(snapshot['payload']['capturedAt']).isAfter(now()),
        'SNAPSHOT_FUTURE',
      );
      shorten(snapshot['payload']['expiresAt']);
      shorten(policy['payload']['expiresAt']);
      fresh();
      materials[id] =
          frozen({
                'version': '1.0',
                ...normalized[id]!,
                'snapshot': snapshot,
                'policy': policy,
              })
              as Map<String, dynamic>;
    } else if (step['kind'] == 'reviewedTransaction') {
      need(
        prepareReviewed != null && keyless != null,
        'WORKFLOW_REVIEW_UNAVAILABLE',
      );
      final review = await prepareReviewed!(id, step['request'], owner, fresh);
      fresh();
      shorten(review.artifact['payload']['expiresAt']);
      fresh();
      reviews[id] = review;
    }
  }

  await Future.wait(steps.map(load));
  fresh();
  final planned = <Map<String, dynamic>>[], usedInputs = <String>{};
  for (final step in steps.where(workflowTransaction)) {
    final id = step['id'] as String, material = materials[id]!;
    fresh();
    final plan = copied(engine('plan', material)['plan']),
        payload = plan['payload'];
    need(
      hashJson(payload) == plan['planHash'] &&
          payload['requestHash'] == material['requestHash'] &&
          payload['snapshotHash'] == material['snapshot']['snapshotHash'] &&
          payload['policyHash'] == material['policy']['policyHash'] &&
          payload['chainId'] == request['chainId'] &&
          payload['accountId'] == owner['accountId'],
      'WORKFLOW_PLAN_BINDING',
    );
    final roles = selected[id]!;
    roles.requireTasks(payload['signingTasks']);
    need(
      canonical(payload['preview']['signingRoles'] ?? []) ==
          canonical(roles.roles),
      'WORKFLOW_PLAN_ROLES',
    );
    if (step['kind'] == 'preparedTransaction') {
      assertPreparedProposalForPlan(
        {'intent': step['intent'], 'proposal': step['proposal']},
        material['snapshot'],
        plan,
      );
    }
    need(
      engine('validate', {
            ...material,
            'phase': 'plan',
            'plan': plan,
          })['valid'] ==
          true,
      'WORKFLOW_PLAN_INVALID',
    );
    for (final tx in payload['transactions']) {
      for (final point in plannedInputOutpoints(tx['unsignedTransaction'])) {
        need(usedInputs.add(point), 'WORKFLOW_DUPLICATE_INPUT');
      }
    }
    shorten(payload['expiresAt']);
    fresh();
    planned.add({'stepId': id, 'plan': plan});
  }
  final reviewPrograms = <String, ReviewedSigningProgram>{},
      reviewTasks = <Map>[];
  for (final step in steps.where((s) => s['kind'] == 'reviewedTransaction')) {
    final id = step['id'] as String;
    // Reuse authenticated in-memory inputs. Reviewed associated local parents
    // are internal edges; all other inputs share the same batch reservation as
    // Engine-built transactions, including across two Reviewed steps.
    final reviewed = reviews[id]!;
    for (final tx in reviewed.plan.transactions) {
      for (final input in tx['inputs']) {
        final point = '${input['txid']}:${input['vout']}';
        if (reviewed.plan.localPrevouts.containsKey(point)) continue;
        need(usedInputs.add(point), 'WORKFLOW_DUPLICATE_INPUT');
      }
    }
    final program = ReviewedSigningProgram(
      // Use the same child request as the native custody owner and the single
      // Reviewed lifecycle. The public workflow task/result still bind the
      // inner request; continuation plan hashes must also bind account/chain.
      request: {
        'version': request['version'],
        'chainId': request['chainId'],
        'from': request['from'],
        'request': step['request'],
      },
      context: trustedContext,
      account: owner,
      reviewed: reviewed,
      expiresAt: deadline,
      keyless: keyless!,
    );
    reviewPrograms[id] = program;
    reviewTasks.add({
      ...program.plan['payload']['task'],
      'taskId': 'review-$id',
    });
  }
  final total =
      planned.fold<BigInt>(
        BigInt.zero,
        (sum, entry) =>
            sum +
            (entry['plan']['payload']['transactions'] as List).fold<BigInt>(
              BigInt.zero,
              (sum, tx) => sum + BigInt.parse(tx['fee']),
            ),
      ) +
      reviews.values.fold<BigInt>(
        BigInt.zero,
        (sum, r) => sum + BigInt.parse(r.artifact['payload']['totalFee']),
      );
  final maximum = request['maxTotalFee'] ?? '$total';
  need(total <= BigInt.parse(maximum), 'WORKFLOW_FEE_CAP');
  final immediate = <Map<String, dynamic>>[
        for (final entry in planned)
          for (final task in entry['plan']['payload']['signingTasks'])
            {'stepId': entry['stepId'], 'task': task},
      ],
      deferred = <Map<String, dynamic>>[];
  for (final kind in ['message', 'typedData']) {
    for (final step in steps.where((s) => s['kind'] == kind)) {
      final envelope =
          kind == 'message'
              ? workflowMessageEnvelope(step)
              : workflowTypedEnvelope(request, step, trustedContext['origin']);
      final bindings = workflowBindings(step), id = step['id'];
      if (bindings.isEmpty) {
        immediate.add({
          'stepId': id,
          'envelope': envelope,
          'task': workflowRecoverableTask(
            messageProfile: messageProfile,
            taskId: 'sign-$id',
            envelope: envelope,
            account: owner,
            origin: trustedContext['origin'],
            purpose: kind,
          ),
        });
      } else {
        final b = bindings.single;
        deferred.add({
          'taskId': 'sign-$id',
          'source': b['source'],
          'targetStepId': id,
          'target': kind == 'message' ? '/message/${b['target']}' : b['target'],
          'targetType': workflowTargetType(step, b),
          'purpose': kind,
          'publicKey': owner['publicKey'],
          'envelopeTemplate': envelope,
        });
      }
    }
  }
  final crypto = <Map<String, dynamic>>[
    for (final step in steps.where(
      (s) => s['kind'] == 'encrypt' || s['kind'] == 'decrypt',
    ))
      {
        'taskId': 'crypto-${step['id']}',
        'purpose': step['kind'],
        'algorithm': step['algorithm'],
        'origin': trustedContext['origin'],
        'accountId': owner['accountId'],
        'publicKey': owner['publicKey'],
        if (step['kind'] == 'encrypt')
          'message': step['message']
        else
          'ciphertext': step['ciphertext'],
      },
  ];
  final taskIds = [
    for (final e in immediate) '${e['stepId']}\u0000${e['task']['taskId']}',
    for (final e in deferred) '${e['targetStepId']}\u0000${e['taskId']}',
    for (final s in steps.where(
      (s) => s['kind'] == 'encrypt' || s['kind'] == 'decrypt',
    ))
      '${s['id']}\u0000crypto-${s['id']}',
    for (final e in reviewTasks) '${e['taskId']}\u0000${e['taskId']}',
  ];
  need(taskIds.toSet().length == taskIds.length, 'WORKFLOW_TASK_ID');
  final byStep = {for (final p in planned) p['stepId']: p['plan']};
  final roles = [
    for (final step in steps.where(workflowTransaction))
      for (final r in selected[step['id']]!.roles) {'stepId': step['id'], ...r},
  ];
  final previewBindings = [
    for (final d in deferred)
      {
        'sourceStepId': d['source']['stepId'],
        'sourceOutput': d['source']['output'],
        'target': d['target'],
        'targetType': d['targetType'],
      },
  ];
  final warnings = <String>{
    for (final p in planned)
      ...(p['plan']['payload']['preview']['warnings'] as List).cast<String>(),
    for (final step in steps.where((s) => s['kind'] == 'reviewedTransaction'))
      ...(reviews[step['id']]!.artifact['payload']['preview']['warnings']
              as List)
          .cast<String>(),
    if (deferred.isNotEmpty) 'DYNAMIC_BINDING',
  };
  final mode = request['failureMode'] ?? 'atomic';
  final preview = {
    'operationKind': 'workflow',
    if (roles.isNotEmpty) 'signingRoles': roles,
    'failureMode': mode,
    'steps': [
      for (final step in steps)
        {
          'id': step['id'],
          'kind': step['kind'],
          'dependsOn': step['dependsOn'],
          if (workflowTransaction(step))
            'assetFlows': byStep[step['id']]['payload']['preview']['assetFlows']
          else if (step['kind'] == 'reviewedTransaction')
            'reviewedTransactionPreview':
                reviews[step['id']]!.artifact['payload']['preview']
          else if (step['kind'] == 'typedData')
            'typedData': step['data']
          else if (step['kind'] == 'message')
            'message': step['message']
          else ...{
            'algorithm': step['algorithm'],
            if (step['kind'] == 'encrypt')
              'message': step['message']
            else
              'ciphertext': step['ciphertext'],
          },
        },
    ],
    'bindings': previewBindings,
    'totalFee': '$total',
    'warnings': warnings.toList(),
  };
  final payload = {
    'version': '1.0',
    'requestHash': hashJson(request),
    'chainId': request['chainId'],
    'accountId': owner['accountId'],
    'expiresAt': deadline,
    'failureMode': mode,
    'stepOrder': steps.map((s) => s['id']).toList(),
    'transactionPlans': planned,
    'immediateSigningTasks': immediate,
    'deferredSigningTasks': deferred,
    'legacyBitcoinMessageStepIds': [
      if (messageProfile == MessageSigningProfile.legacyBitcoin)
        for (final s in steps.where((s) => s['kind'] == 'message')) s['id'],
    ],
    'cryptoTasks': crypto,
    'reviewedTransactionTasks': reviewTasks,
    'maxTotalFee': maximum,
    'totalFee': '$total',
    'preview': preview,
  };
  final plan = {'payload': payload, 'workflowPlanHash': hashJson(payload)};
  final bindingPayload = {
    'version': '1.0',
    'method': method,
    'operationKind': 'workflow',
    'contextHash': hashJson(trustedContext),
    'origin': trustedContext['origin'],
    'sessionId': trustedContext['sessionId'],
    'chainId': owner['chainId'],
    'accountId': owner['accountId'],
    'requestHash': hashJson(request),
    'operationHash': plan['workflowPlanHash'],
    'expiresAt': deadline,
  };
  fresh();
  return WorkflowPreparation._(
    request,
    frozen(plan) as Map<String, dynamic>,
    frozen({'payload': bindingPayload, 'bindingHash': hashJson(bindingPayload)})
        as Map<String, dynamic>,
    Map.unmodifiable(materials),
    Map.unmodifiable(reviewPrograms),
  );
}
