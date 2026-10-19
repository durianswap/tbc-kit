// Strategy of TbcSigningExecutor, not a second wallet/Legacy execution entry.
// One receipt covers a generic graph; all transaction stages use the same
// post-approval runner as ordinary and Prepared single requests.
import '../signing_backend.dart';
import 'crypto_action.dart';
import 'operation_authority.dart';
import 'protocol_codec.dart';
import 'signature_verification.dart';
import 'signing_stages.dart';
import 'transaction_profiles.dart';
import 'transaction_read.dart';
import 'transaction_signing_roles.dart';
import 'workflow_request.dart';
import 'workflow_plan.dart';
import 'workflow_json.dart';
import 'tbc20_material.dart' show KeylessCall;
import 'send_lifecycle.dart';

Future<Map<String, dynamic>> executeWorkflow({
  required String method,
  required Map input,
  required TbcOperationAuthority authority,
  required TbcSigningOperation signer,
  required WorkflowEngine engine,
  required KeylessCall keyless,
  required WorkflowMaterial prepareMaterial,
  WorkflowReview? prepareReviewed,
  void Function(String, int)? timing,
  MessageSigningProfile messageProfile = MessageSigningProfile.standard,
}) async {
  need(workflowMethods.contains(method), 'WORKFLOW_METHOD');
  final sending = sendMethods.contains(method);
  need(
    !sending || signer is TbcBroadcastSigningOperation,
    'BROADCAST_CUSTODY_REQUIRED',
  );
  need(signer is TbcWorkflowSigningOperation, 'WORKFLOW_CUSTODY_REQUIRED');
  final custody = signer as TbcWorkflowSigningOperation,
      clock = Stopwatch()..start();
  void measure(String s, int n) {
    try {
      timing?.call(s, n);
    } catch (_) {}
  }

  final context = authority.context,
      account = authority.account,
      identity = authority.identity,
      startedAt = authority.now;
  final request = checkedWorkflowRequest(
    method: method,
    input: input,
    origin: context['origin'],
    now: startedAt,
  );
  final steps = (request['steps'] as List).cast<Map<String, dynamic>>();
  need(
    !steps.any((s) => s['kind'] == 'encrypt' || s['kind'] == 'decrypt') ||
        signer is TbcCryptoSigningOperation,
    'WORKFLOW_CRYPTO_NOT_INSTALLED',
  );
  for (final step in steps.where(workflowTransaction)) {
    need(
      transactionTaskLimits.containsKey(step['intent']['type']),
      'TRANSACTION_PROFILE_UNSUPPORTED',
    );
  }
  var expires = startedAt.add(const Duration(minutes: 5));
  void fresh() {
    authority.check(method);
    for (final permission in workflowRequiredPermissions(
      request,
      method: method,
    )) {
      if (permission != method) authority.check(permission);
    }
    need(
      authority.identity == identity && !authority.now.isBefore(startedAt),
      'WORKFLOW_AUTHORITY_CHANGED',
    );
    need(
      context['frame'] == 'top' &&
          context['origin'] == context['topOrigin'] &&
          Uri.parse(context['origin']).origin == context['origin'],
      'ORIGIN_INVALID',
    );
    inspectAccount(account, expectedChainId: authority.chainId);
    need(
      request['from'] == account['address'] &&
          request['chainId'] == account['chainId'],
      'ACCOUNT_MISMATCH',
    );
    need(
      authority.isUnlocked() && authority.now.isBefore(expires),
      'WORKFLOW_REVOKED_OR_EXPIRED',
    );
  }

  if (request['expiresAt'] != null) {
    final t = protocolTime(request['expiresAt']);
    if (t.isBefore(expires)) expires = t;
  }
  // The worker's unlock mirror starts false until this first native snapshot.
  // Check local authority before the callback, then require the actual native
  // snapshot before preparation/consent, as the single-operation path does.
  authority.check(method);
  await signer.requireCurrent();
  fresh();
  var extra = <Map<String, dynamic>>[];
  if (steps.any((s) => s.containsKey('signingRoles'))) {
    need(signer is TbcTransactionSigningRoles, 'ROLE_ADAPTER_REQUIRED');
    final selected = await (signer as TbcTransactionSigningRoles)
        .resolveSigningAccounts(
          TbcBoundedSigningIntent(
            method: method,
            request: request,
            context: context,
          ),
        );
    await signer.requireCurrent();
    fresh();
    extra = selected.map((a) => a.toKitAccount()).toList(growable: false);
  }
  final pending = prepareWorkflow(
    messageProfile: messageProfile,
    method: method,
    input: request,
    context: context,
    account: account,
    additionalAccounts: extra,
    expiresAt: expires.toIso8601String(),
    now: () => authority.now,
    requireCurrent: fresh,
    engine: engine,
    keyless: keyless,
    prepareMaterial: prepareMaterial,
    prepareReviewed: prepareReviewed,
  );
  pending.ignore();
  WorkflowPreparation? prepared;
  final hasReviewed = steps.any((s) => s['kind'] == 'reviewedTransaction');
  // Reviewed bytes need authenticated effects; an unbounded fee request needs
  // its plan first. Bounded high-level business intent may consent during reads.
  if (hasReviewed ||
      (steps.any(workflowTransaction) && request['maxTotalFee'] == null)) {
    prepared = await pending;
    await signer.requireCurrent();
    fresh();
  }
  final intent = TbcBoundedSigningIntent(
    method: method,
    request: request,
    context: context,
    review:
        prepared != null
            ? {
              'kind': 'workflow',
              'prepared': {
                'workflowPlanHash': prepared.plan['workflowPlanHash'],
                'totalFee': prepared.plan['payload']['totalFee'],
              },
              'steps': [
                for (final step in steps.where(
                  (s) => s['kind'] == 'reviewedTransaction',
                ))
                  {
                    'stepId': step['id'],
                    'review': prepared.reviewedPrograms[step['id']]!.review,
                  },
              ],
            }
            : null,
  );
  if (!await signer.requestConsent(intent)) throw const TbcSigningRejected();
  final consentAt = clock.elapsedMicroseconds;
  await signer.requireCurrent();
  fresh();
  prepared ??= await pending;
  await signer.requireCurrent();
  fresh();
  final p = prepared,
      plan = p.plan,
      payload = plan['payload'],
      binding = p.binding;
  expires = protocolTime(payload['expiresAt']);
  fresh();
  measure('preparationCompleteUs', clock.elapsedMicroseconds);
  // Explicitly preserve the same business preview expansion checks as singles.
  for (final entry in payload['transactionPlans']) {
    final m = p.materials[entry['stepId']]!,
        child = entry['plan']['payload'],
        preview = child['preview'];
    need(
      preview['operationKind'] == 'transaction' &&
          preview['transactionCount'] is int &&
          preview['transactionCount'] >= 1 &&
          preview['transactionCount'] <= maxTransactionBundleSize &&
          coveredTransactionWarnings(m['request'], child),
      'CONSENT_SCOPE_EXPANDED',
    );
  }
  final issued = await signer.bind(
    TbcSigningMaterial(
      binding: binding,
      preview: payload['preview'],
      plan: plan,
    ),
  );
  await signer.requireCurrent();
  final receipt = issued.wire, approvedAt = clock.elapsedMicroseconds;
  void receiptCheck() {
    fresh();
    need(
      receipt['status'] == 'approved' &&
          receipt['approvalId'] is String &&
          receipt['approvalId'].isNotEmpty &&
          receipt['approvalToken'] is String &&
          receipt['approvalToken'].isNotEmpty &&
          receipt['bindingHash'] == binding['bindingHash'],
      'RECEIPT_BINDING',
    );
    final approved = protocolTime(receipt['approvedAt']),
        expiry = protocolTime(receipt['expiresAt']);
    need(
      !approved.isAfter(authority.now) &&
          !approved.isAfter(expiry) &&
          !expiry.isAfter(expires) &&
          authority.now.isBefore(expiry),
      'RECEIPT_TIME',
    );
  }

  receiptCheck();
  for (final entry in payload['transactionPlans']) {
    need(
      engine('validate', {
            ...p.materials[entry['stepId']]!,
            'phase': 'pre-sign',
            'plan': entry['plan'],
            'binding': binding,
            'approval': receipt,
          })['valid'] ==
          true,
      'PRE_SIGN_INVALID',
    );
  }
  final completed = <String, Map<String, dynamic>>{},
      rows = <Map<String, dynamic>>[],
      unavailable = <String>{},
      consumed = <String>{};
  var lastSignedAt = clock.elapsedMicroseconds;
  // Only this closure sees completed bundles. Entries are installed AFTER
  // shared Engine/Reviewed verification AND native completion validation.
  Map<String, dynamic> deferredTask(Map d) {
    final source = completed[d['source']['stepId']];
    need(source != null, 'WORKFLOW_SOURCE_NOT_COMPLETED');
    final output = d['source']['output'] as String,
        txs = source!['transactions'] as List;
    Object? value;
    if (output == 'transactionIds')
      value = txs.map((t) => hash32(t['txid'])).toList();
    else if (output == 'primaryTransactionId') {
      final primary = txs.where((t) => t['role'] == 'primary').toList();
      need(primary.length == 1, 'WORKFLOW_PRIMARY_ID');
      value = hash32(primary.single['txid']);
    } else if (output.startsWith('artifacts.'))
      value = hash32(source['artifacts']?[output.substring(10)]);
    need(value != null, 'WORKFLOW_SOURCE_VALUE');
    final envelope = copied(d['envelopeTemplate']),
        field = (d['target'] as String).substring(9);
    if (d['purpose'] == 'message') {
      need(
        value is List && envelope['message']['encoding'] == 'utf8',
        'WORKFLOW_JSON_VALUE',
      );
      envelope['message']['data'] = bindWorkflowJsonMessage(
        envelope['message']['data'],
        field,
        (value as List).cast<String>(),
      );
    } else {
      need(
        canonical(envelope['message'][field]) ==
            canonical({r'$tbcBinding': 'unresolved'}),
        'WORKFLOW_PLACEHOLDER_CHANGED',
      );
      envelope['message'][field] = value;
    }
    final task = workflowRecoverableTask(
      messageProfile: messageProfile,
      taskId: d['taskId'],
      envelope: envelope,
      account: account,
      origin: context['origin'],
      purpose: d['purpose'],
    );
    return copied({
      'planTaskId': d['taskId'],
      'source': d['source'],
      'sourceValue': value,
      'targetStepId': d['targetStepId'],
      'target': d['target'],
      'targetType': d['targetType'],
      'purpose': d['purpose'],
      'resolvedEnvelope': envelope,
      'canonical': canonical(envelope),
      'digest': task['digest'],
      'concreteTask': task,
    });
  }

  for (final step in steps) {
    receiptCheck();
    await signer.requireCurrent();
    receiptCheck();
    final id = step['id'] as String, kind = step['kind'] as String;
    if ((step['dependsOn'] as List).any(unavailable.contains)) {
      unavailable.add(id);
      rows.add({
        'id': id,
        'kind': kind,
        'status': 'skipped',
        'error': {
          'code': 'DEPENDENCY_FAILED',
          'message': 'Workflow dependency failed',
        },
      });
      continue;
    }
    Map<String, dynamic>? childPlan, envelope, resolved;
    List tasks;
    final review = p.reviewedPrograms[id];
    TransactionSigningAccounts? roles;
    if (workflowTransaction(step)) {
      childPlan = copied(
        (payload['transactionPlans'] as List).singleWhere(
          (v) => v['stepId'] == id,
        )['plan'],
      );
      final m = p.materials[id]!,
          roleIds =
              ((step['signingRoles'] ?? []) as List)
                  .map((r) => r['accountId'])
                  .toSet();
      roles = TransactionSigningAccounts.resolve(
        request: m['request'],
        primary: account,
        additional:
            extra.where((a) => roleIds.contains(a['accountId'])).toList(),
      );
      tasks = childPlan['payload']['signingTasks'];
    } else if (review != null) {
      tasks = review.tasks;
    } else if (kind == 'encrypt' || kind == 'decrypt') {
      tasks =
          (payload['cryptoTasks'] as List)
              .where((t) => t['taskId'] == 'crypto-$id')
              .toList();
      need(tasks.length == 1, 'WORKFLOW_CRYPTO_TASK');
    } else {
      final found =
          (payload['immediateSigningTasks'] as List)
              .where((t) => t['stepId'] == id)
              .toList();
      if (found.isNotEmpty) {
        need(found.length == 1, 'WORKFLOW_MESSAGE_TASK');
        tasks = [found.single['task']];
        envelope = copied(found.single['envelope']);
      } else {
        final d = (payload['deferredSigningTasks'] as List).singleWhere(
          (d) => d['targetStepId'] == id,
        );
        resolved = deferredTask(d);
        tasks = [resolved['concreteTask']];
        envelope = copied(resolved['resolvedEnvelope']);
      }
    }
    await custody.enterWorkflowStep(
      issued,
      TbcSigningContinuation({
        'kind': 'workflow-step',
        'stepId': id,
        'workflowPlanHash': plan['workflowPlanHash'],
        'tasks': tasks,
        // Native already owns the approved request/plan/tasks. Engine pre-sign
        // validation above remains in this worker; do not resend chain data.
        if (review != null) 'reviewed': review.initialMaterial,
        if (resolved != null) 'resolvedDeferredSigningTask': resolved,
      }),
    );
    await signer.requireCurrent();
    receiptCheck();
    Future<List<Map<String, dynamic>>> sign(List stageTasks) async {
      final captured = frozen(stageTasks) as List,
          signatures = <Map<String, dynamic>>[];
      roles?.requireTasks(captured);
      for (final task in captured) {
        receiptCheck();
        need(
          roles != null ||
              (task['accountId'] == account['accountId'] &&
                  task['publicKey'] == account['publicKey']),
          'TASK_ACCOUNT',
        );
        need(consumed.add('$id\u0000${task['taskId']}'), 'SIGNER_TASK_REPLAY');
        final watch = Stopwatch()..start();
        final result =
            (await signer.sign(issued, TbcSigningTask(task))).toWire();
        await signer.requireCurrent();
        receiptCheck();
        measure('nativeSignerRoundTrip', watch.elapsedMicroseconds);
        need(
          result['taskId'] == task['taskId'] &&
              result['signatureEncoding'] == task['signatureEncoding'],
          'SIGNER_RESULT_BINDING',
        );
        if (task['purpose'] == 'message' || task['purpose'] == 'typedData')
          verifyRecoverable(task, result);
        signatures.add(result);
      }
      lastSignedAt = clock.elapsedMicroseconds;
      return signatures;
    }

    Future<void> advance(Map<String, dynamic> continuation) async {
      receiptCheck();
      await signer.advance(issued, TbcSigningContinuation(continuation));
      await signer.requireCurrent();
      receiptCheck();
    }

    late Map<String, dynamic> result;
    try {
      if (childPlan != null) {
        result = await signTransactionStages(
          material: p.materials[id]!,
          plan: childPlan,
          binding: binding,
          receipt: receipt,
          account: account,
          engine: engine,
          sign: sign,
          advance: advance,
          receiptCheck: receiptCheck,
          forBroadcast: sending,
        );
      } else if (review != null) {
        result = await signReviewedStages(
          program: review,
          approvalId: receipt['approvalId'],
          sign: sign,
          advance: advance,
          receiptCheck: receiptCheck,
        );
        // Workflow results use the inner reviewed request hash, as frozen Core.
        result['requestHash'] = hashJson(step['request']);
      } else if (kind == 'encrypt' || kind == 'decrypt') {
        final task = tasks.single as Map;
        need(
          task['accountId'] == account['accountId'] &&
              task['publicKey'] == account['publicKey'] &&
              task['origin'] == context['origin'],
          'TASK_ACCOUNT',
        );
        need(consumed.add('$id\u0000${task['taskId']}'), 'SIGNER_TASK_REPLAY');
        final watch = Stopwatch()..start();
        final output = await (signer as TbcCryptoSigningOperation)
            .executeCrypto(issued, TbcCryptoTask(task));
        await signer.requireCurrent();
        receiptCheck();
        checkCryptoResult(task, output.wire);
        measure('nativeCryptoRoundTrip', watch.elapsedMicroseconds);
        lastSignedAt = clock.elapsedMicroseconds;
        // Workflow rows use the exact task result, not the standalone envelope.
        result = copied(output.wire);
      } else {
        final signatures = await sign(tasks);
        result = signedEnvelopeResult(
          messageProfile: messageProfile,
          envelope: envelope!,
          task: tasks.single,
          signature: signatures.single,
          account: account,
        );
      }
    } on TbcWorkflowStepUnavailable catch (failure) {
      await signer.requireCurrent();
      receiptCheck();
      if (payload['failureMode'] != 'continue-independent') rethrow;
      need(
        failure.operation ==
            ((kind == 'encrypt' || kind == 'decrypt')
                ? 'crypto.execute'
                : 'signer.sign'),
        'WORKFLOW_FAILURE_PROVENANCE',
      );
      final row = {
        'id': id,
        'kind': kind,
        'status': 'failed',
        'error': {
          'code': 'HOST_UNAVAILABLE',
          'message': 'Workflow step failed: ${failure.operation}',
        },
      };
      await custody.finishWorkflowStep(
        issued,
        TbcSigningContinuation({
          'kind': 'workflow-step-outcome',
          'stepId': id,
          'workflowPlanHash': plan['workflowPlanHash'],
          'status': 'failed',
          'error': row['error'],
        }),
      );
      await signer.requireCurrent();
      receiptCheck();
      unavailable.add(id);
      rows.add(row);
      continue;
    }
    receiptCheck();
    final fixed = frozen(copied(result)) as Map<String, dynamic>;
    await custody.finishWorkflowStep(
      issued,
      TbcSigningContinuation({
        'kind': 'workflow-step-outcome',
        'stepId': id,
        'workflowPlanHash': plan['workflowPlanHash'],
        'status': 'completed',
        'result': fixed,
      }),
    );
    await signer.requireCurrent();
    receiptCheck();
    completed[id] = fixed;
    rows.add({'id': id, 'kind': kind, 'result': fixed});
  }
  receiptCheck();
  await signer.requireCurrent();
  receiptCheck();
  measure('earlyConsentToSignUs', lastSignedAt - consentAt);
  measure('formalReceiptToSignUs', lastSignedAt - approvedAt);
  Map<String, dynamic> result = {
    'version': '1.0',
    'chainId': request['chainId'],
    'from': request['from'],
    'requestHash': payload['requestHash'],
    'workflowPlanHash': plan['workflowPlanHash'],
    'approvalId': receipt['approvalId'],
    'failureMode': payload['failureMode'],
    'steps': rows,
    'totalFee': payload['totalFee'],
  };
  if (sending) {
    result = await TbcSendLifecycle(
      custody: signer as TbcBroadcastSigningOperation,
      receipt: issued,
      receiptCheck: receiptCheck,
    ).workflow(result, (payload['stepOrder'] as List).cast<String>());
  }
  measure('formalReceiptToReturnUs', clock.elapsedMicroseconds - approvedAt);
  measure('earlyConsentToReturnUs', clock.elapsedMicroseconds - consentAt);
  measure('totalUs', clock.elapsedMicroseconds);
  return result;
}
