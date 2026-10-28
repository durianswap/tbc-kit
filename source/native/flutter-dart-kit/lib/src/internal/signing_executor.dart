// Shared candidate lifecycle extracted from P5. Enabled profiles are bounded
// by transaction_profiles; remaining goal families are not claimed.
import 'dart:async';
import 'dart:convert';
import 'native_compute.dart';
import 'protocol_codec.dart';
import 'signature_verification.dart';
import 'operation_authority.dart';
import '../signing_backend.dart';
import 'transaction_read.dart';
import 'transaction_profiles.dart';
import 'transaction_signing_roles.dart';
import 'typed_signing.dart';
import 'prepared_proposal.dart';
import 'reviewed_reviewer.dart';
import 'reviewed_signing.dart';
import 'signing_stages.dart';
import 'workflow_executor.dart';
import 'workflow_request.dart';
import 'crypto_action.dart';
import 'send_lifecycle.dart';

/// Optional local timing only: never receives request, preimage, plan, receipt
/// or signature bytes. There is no default retained diagnostic/audit history.
typedef TbcExecutionTiming = void Function(String stage, int microseconds);

final class TbcSigningExecutor {
  TbcSigningExecutor({
    required this.prepareMaterial,
    required this.authority,
    required this.engine,
    required this.signer,
    this.prepareRoleMaterial,
    this.prepareReviewed,
    this.validateTransactionPlan,
    this.timing,
    this.messageProfile = MessageSigningProfile.standard,
  });
  final Future<Map<String, dynamic>> Function(
    Map<String, dynamic> request,
    Map<String, dynamic> account,
  )
  prepareMaterial;
  final Future<Map<String, dynamic>> Function(
    Map<String, dynamic> request,
    Map<String, dynamic> account,
    List<Map<String, dynamic>> signingAccounts,
  )?
  prepareRoleMaterial;
  final Future<ReviewedTransactionResult> Function(
    Map<String, dynamic> request,
    Map<String, dynamic> account,
    void Function() requireCurrent,
  )?
  prepareReviewed;
  final TbcOperationAuthority authority;
  final ComputeProbe engine;
  final TbcSigningOperation signer;
  final TbcExecutionTiming? timing;
  final MessageSigningProfile messageProfile;
  // Private wallet-owned constraint for a shared bounded maintenance child.
  // It cannot replace Engine validation or native custody authorization.
  final void Function(Map<String, dynamic> material, Map<String, dynamic> plan)?
  validateTransactionPlan;
  bool _used = false;
  void _time(String stage, int elapsed) {
    try {
      timing?.call(stage, elapsed);
    } catch (_) {
      // Optional, data-free metrics cannot control signing or result delivery.
    }
  }

  Map<String, dynamic> _engine(String operation, Map input) {
    final watch = timing == null ? null : (Stopwatch()..start());
    final reply =
        jsonDecode(engine.call('engine', operation, jsonEncode(input))) as Map;
    final timingKey =
        operation == 'validate' ? 'validate:${input['phase']}' : operation;
    if (watch != null) _time(timingKey, watch.elapsedMicroseconds);
    need(reply['ok'] == true, 'ENGINE_$operation:${reply['error']?['code']}');
    return copied(reply['result']);
  }

  Future<Map<String, dynamic>> execute(String method, Map input) async {
    need(!_used, 'OPERATION_ALREADY_CONSUMED');
    _used = true;
    final clock = Stopwatch()..start();
    try {
      return await _execute(method, input, clock);
    } finally {
      await signer.close();
    }
  }

  Future<Map<String, dynamic>> _execute(
    String method,
    Map input,
    Stopwatch clock,
  ) async {
    final sending = sendMethods.contains(method);
    need(
      !sending || signer is TbcBroadcastSigningOperation,
      'BROADCAST_CUSTODY_REQUIRED',
    );
    if (workflowMethods.contains(method)) {
      return executeWorkflow(
        messageProfile: messageProfile,
        method: method,
        input: input,
        authority: authority,
        signer: signer,
        engine: _engine,
        timing: _time,
        keyless:
            (m, p) =>
                copied(jsonDecode(engine.call('keyless', m, canonical(p)))),
        prepareMaterial: (id, r, roles) async {
          if (r.containsKey('signingRoles')) {
            need(prepareRoleMaterial != null, 'ROLE_ADAPTER_REQUIRED');
            return prepareRoleMaterial!(r, roles.primary, roles.additional);
          }
          return prepareMaterial(r, roles.primary);
        },
        prepareReviewed:
            prepareReviewed == null
                ? null
                : (id, r, a, f) => prepareReviewed!(r, a, f),
      );
    }
    need(
      method == 'tbc_signMessage' ||
          method == 'tbc_signTypedData' ||
          method == 'tbc_signPreparedTransaction' ||
          method == 'tbc_sendPreparedTransaction' ||
          method == 'tbc_sendTransaction' ||
          method == 'tbc_signReviewedTransaction' ||
          cryptoMethods.contains(method) ||
          method == 'tbc_signTransaction',
      'UNSUPPORTED_SIGNING_METHOD',
    );
    final request = frozen(copied(input)) as Map<String, dynamic>;
    final context = frozen(copied(authority.context)) as Map<String, dynamic>;
    final account = frozen(copied(authority.account)) as Map<String, dynamic>;
    final identity = authority.identity;
    final createdAt = authority.now;
    void authorityCheck() {
      authority.check(method);
      need(authority.identity == identity, 'AUTHORITY_CHANGED');
      need(authority.now.compareTo(createdAt) >= 0, 'CLOCK_ROLLBACK');
      need(
        context['frame'] == 'top' &&
            context['origin'] == context['topOrigin'] &&
            Uri.parse(context['origin']).origin == context['origin'],
        'ORIGIN_INVALID',
      );
      inspectAccount(account, expectedChainId: authority.chainId);
      need(
        account['accountId'] == '${account['chainId']}:${account['address']}' &&
            request['chainId'] == account['chainId'] &&
            request['from'] == account['address'],
        'ACCOUNT_MISMATCH',
      );
    }

    authorityCheck();
    await signer.requireCurrent();
    final crypto = cryptoMethods.contains(method);
    if (crypto) {
      checkCryptoRequest(method, request);
      need(signer is TbcCryptoSigningOperation, 'CRYPTO_ADAPTER_REQUIRED');
    }
    final preparedTransaction =
        method == 'tbc_signPreparedTransaction' ||
        method == 'tbc_sendPreparedTransaction';
    final transaction =
        method == 'tbc_signTransaction' ||
        method == 'tbc_sendTransaction' ||
        preparedTransaction;
    final reviewedTransaction = method == 'tbc_signReviewedTransaction';
    if (reviewedTransaction)
      need(prepareReviewed != null, 'REVIEWED_ADAPTER_REQUIRED');
    final engineRequest =
        preparedTransaction
            ? checkedPreparedRequest(request, authority.now)
            : request;
    final typed = method == 'tbc_signTypedData';
    final checkedTypedEnvelope =
        typed ? typedDataEnvelope(request, context['origin']) : null;
    need(request['version'] == '1.0', 'REQUEST_VERSION');
    final required =
        crypto
            ? {
              'version',
              'chainId',
              'from',
              'algorithm',
              method == 'tbc_encrypt' ? 'message' : 'ciphertext',
            }
            : reviewedTransaction
            ? {'version', 'chainId', 'from', 'request'}
            : transaction
            ? {'version', 'chainId', 'from', 'intent'}
            : {'version', 'chainId', 'from', typed ? 'data' : 'message'};
    final allowed = {
      ...required,
      'clientRequestId',
      if (!typed && !reviewedTransaction && !crypto) 'constraints',
      if (crypto) 'expiresAt',
      if (reviewedTransaction) ...{'maxFee', 'expiresAt'},
      if (transaction) 'signingRoles',
      if (preparedTransaction) 'proposal',
    };
    need(
      required.every(request.containsKey) &&
          request.keys.every(allowed.contains),
      'REQUEST_SHAPE',
    );
    var requestHash = hashJson(request);
    late Map<String, dynamic> normalized;
    if (transaction) {
      need(
        request['intent'] is Map &&
            transactionTaskLimits.containsKey(request['intent']['type']),
        'TRANSACTION_PROFILE_UNSUPPORTED',
      );
      normalized = _engine('normalizeRequest', {
        'version': '1.0',
        'request': engineRequest,
      });
      need(
        hashJson(normalized['request']) == normalized['requestHash'],
        'NORMALIZATION_HASH',
      );
      // Bounded intent consent may not authorize a different normalized request.
      need(
        canonical(normalized['request']) == canonical(engineRequest),
        'CANONICAL_REQUEST_REQUIRED',
      );
      requestHash = normalized['requestHash'];
    }
    TransactionSigningAccounts? roleAccounts;
    if (request.containsKey('signingRoles')) {
      need(
        signer is TbcTransactionSigningRoles && prepareRoleMaterial != null,
        'ROLE_ADAPTER_REQUIRED',
      );
      final selected = await (signer as TbcTransactionSigningRoles)
          .resolveSigningAccounts(
            TbcBoundedSigningIntent(
              method: method,
              request: request,
              context: context,
            ),
          );
      authorityCheck();
      await signer.requireCurrent();
      roleAccounts = TransactionSigningAccounts.resolve(
        request: request,
        primary: account,
        additional: selected
            .map((a) => a.toKitAccount())
            .toList(growable: false),
      );
    }
    final constraints =
        (reviewedTransaction || crypto
                ? {
                  if (request['maxFee'] != null) 'maxFee': request['maxFee'],
                  if (request['expiresAt'] != null)
                    'expiresAt': request['expiresAt'],
                }
                : request['constraints'] ?? {})
            as Map;
    var expires = createdAt.add(const Duration(minutes: 5));
    var expiryWire = expires.toIso8601String();
    void shorten(String value) {
      final t = protocolTime(value);
      if (t.isBefore(expires)) {
        expires = t;
        expiryWire = value;
      }
    }

    if (constraints['expiresAt'] != null) {
      shorten(constraints['expiresAt']);
    }
    if (preparedTransaction)
      shorten(request['proposal']['payload']['expiresAt']);
    void fresh() {
      authorityCheck();
      if (crypto) need(authority.isUnlocked(), 'CRYPTO_VAULT_LOCKED');
      need(authority.now.isBefore(expires), 'APPROVAL_EXPIRED');
    }

    fresh();
    final contextHash = hashJson(context);
    Map<String, dynamic>? material, plan;
    late final Map<String, dynamic> preview;
    late final String operationHash;
    Map<String, dynamic>? envelope;
    ReviewedSigningProgram? reviewedProgram;
    CryptoActionProgram? cryptoProgram;
    Future<dynamic>? preparation;
    if (reviewedTransaction) {
      if (constraints['maxFee'] != null)
        need(
          constraints['maxFee'] is String &&
              RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(constraints['maxFee']),
          'REVIEWED_FEE_CAP',
        );
      // Share the review's parallel read lifecycle. Raw bytes are not a bounded
      // business intent: one approval must show authenticated effects, never
      // authorize arbitrary bytes from a fee cap or caller-written preview.
      final reviewed = await prepareReviewed!(
        copied(request['request']),
        account,
        fresh,
      );
      await signer.requireCurrent();
      fresh();
      shorten(reviewed.artifact['payload']['expiresAt']);
      fresh();
      reviewedProgram = ReviewedSigningProgram(
        request: request,
        context: context,
        account: account,
        reviewed: reviewed,
        expiresAt: expiryWire,
        keyless:
            (method, args) => copied(
              jsonDecode(engine.call('keyless', method, canonical(args))),
            ),
      );
      plan = reviewedProgram.plan;
      preview = copied(plan['payload']['preview']);
      operationHash = plan['planHash'];
      _time('reviewedPreparationCompleteUs', clock.elapsedMicroseconds);
    } else if (transaction) {
      need(
        constraints['maxFee'] is String &&
            RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(constraints['maxFee']),
        'BOUNDED_FEE_REQUIRED',
      );
      // Native, token index and Genesis start independently before consent.
      // Multiple consumers below share only this operation's pending results.
      final preparedMaterial =
          roleAccounts == null
              ? prepareMaterial(engineRequest, account)
              : prepareRoleMaterial!(
                engineRequest,
                account,
                roleAccounts.additional,
              );
      preparation = preparedMaterial.then((prepared) {
        fresh();
        final s = copied(prepared['snapshot']),
            policy = copied(prepared['policy']);
        need(hashJson(s['payload']) == s['snapshotHash'], 'SNAPSHOT_HASH');
        need(
          canonical(s['payload']['account']) == canonical(account),
          'SNAPSHOT_ACCOUNT',
        );
        if (roleAccounts != null) {
          roleAccounts.requireSnapshot(s['payload']);
        } else {
          need(
            s['payload']['signingAccounts'] == null,
            'ROLE_UNREQUESTED_ACCOUNT',
          );
        }
        need(
          hashJson(policy['payload']) == policy['policyHash'],
          'POLICY_HASH',
        );
        need(
          s['payload']['chainId'] == account['chainId'] &&
              policy['payload']['chainId'] == account['chainId'],
          'MATERIAL_CHAIN',
        );
        for (final deadline in [
          s['payload']['expiresAt'],
          policy['payload']['expiresAt'],
        ]) {
          shorten(deadline);
        }
        need(
          protocolTime(s['payload']['capturedAt']).compareTo(authority.now) <=
              0,
          'SNAPSHOT_FUTURE',
        );
        fresh();
        return {
          'version': '1.0',
          'request': normalized['request'],
          'requestHash': requestHash,
          'snapshot': s,
          'policy': policy,
        };
      });
      // Observe a fast prefetch failure while native approval is still pending;
      // awaiting the same Future below still propagates the failure.
      preparation.ignore();
    } else if (crypto) {
      cryptoProgram = CryptoActionProgram(
        method: method,
        request: request,
        context: context,
        account: account,
        expiresAt: expiryWire,
      );
      plan = cryptoProgram.plan;
      preview = copied(plan['payload']['preview']);
      operationHash = plan['planHash'];
    } else if (typed) {
      envelope = checkedTypedEnvelope!;
      operationHash = typedDataDigest(envelope);
      preview = {
        'operationKind': 'typedData',
        'scheme': 'tbc-typed-data',
        'domain': envelope['domain'],
        'types': envelope['types'],
        'primaryType': envelope['primaryType'],
        'message': envelope['message'],
        'digest': operationHash,
        'warnings': [],
      };
    } else {
      need(request['message'] is Map, 'MESSAGE_SHAPE');
      final msg = request['message'] as Map;
      need(
        msg.length == 2 &&
            msg.containsKey('encoding') &&
            msg.containsKey('data'),
        'MESSAGE_SHAPE',
      );
      // Sign-In requires additional context parsing not in this limited pilot.
      // Never silently sign it through an ordinary-message fallback.
      final bytes = messageBytes(msg);
      need(
        !utf8
            .decode(bytes, allowMalformed: true)
            .contains('wants you to sign in'),
        'SIGN_IN_PROFILE_NOT_INSTALLED',
      );
      need(
        !(request['clientRequestId'] as String? ?? '').startsWith(
          'legacy-bitcoin:',
        ),
        'LEGACY_PROFILE_NOT_INSTALLED',
      );
      envelope = {'type': 'tbc.message', 'version': '1.0', 'message': msg};
      operationHash = messageDigest(envelope, profile: messageProfile);
      preview = {
        'operationKind': 'message',
        'scheme': 'tbc-message',
        'message': msg,
        'digest': operationHash,
        'warnings': [],
      };
    }
    // Early consent is NOT an approval receipt or a signing permit.
    final consent = {
      'requestHash': requestHash,
      'contextHash': contextHash,
      'identity': identity,
      'feeCap':
          transaction
              ? constraints['maxFee']
              : reviewedProgram?.review['payload']['totalFee'],
      'approved': true,
    };
    final expectedConsent = canonical(consent);
    // Native owns the actual decision and records a bounded intent, not a digest permit.
    consent['approved'] = await signer.requestConsent(
      TbcBoundedSigningIntent(
        method: method,
        request: request,
        context: context,
        review: reviewedProgram?.review,
      ),
    );
    if (consent['approved'] != true) throw const TbcSigningRejected();
    await signer.requireCurrent();
    final consentAt = clock.elapsedMicroseconds;
    final prepared =
        await preparation; // null for messages; no hidden chain reads.
    await signer.requireCurrent();
    fresh();
    _time('preparationCompleteUs', clock.elapsedMicroseconds);
    need(
      canonical({...consent, 'approved': true}) == expectedConsent,
      'CONSENT_CHANGED',
    );
    if (transaction) {
      material = prepared as Map<String, dynamic>;
      fresh();
      fresh();
      plan = _engine('plan', material)['plan'];
      if (plan == null) throw StateError('PLAN_MISSING');
      final p = plan['payload'];
      need(
        hashJson(p) == plan['planHash'] &&
            p['requestHash'] == requestHash &&
            p['snapshotHash'] == material['snapshot']['snapshotHash'] &&
            p['policyHash'] == material['policy']['policyHash'] &&
            p['chainId'] == account['chainId'] &&
            p['accountId'] == account['accountId'],
        'PLAN_BINDING',
      );
      shorten(p['expiresAt']);
      if (preparedTransaction) {
        assertPreparedProposalForPlan(request, material['snapshot'], plan);
      }
      final valid = _engine('validate', {
        ...material,
        'phase': 'plan',
        'plan': plan,
      });
      need(valid['valid'] == true, 'PLAN_INVALID');
      if (validateTransactionPlan != null) {
        validateTransactionPlan!(
          frozen(material) as Map<String, dynamic>,
          frozen(plan) as Map<String, dynamic>,
        );
      }
      preview = copied(p['preview']);
      need(
        canonical(preview['signingRoles']) == canonical(roleAccounts?.roles),
        'ROLE_PREVIEW_BINDING',
      );
      operationHash = plan['planHash'];
      need(
        preview['operationKind'] == 'transaction' &&
            preview['transactionCount'] is int &&
            preview['transactionCount'] >= 1 &&
            preview['transactionCount'] <= transactionBundleLimit(request) &&
            coveredTransactionWarnings(request, p),
        'CONSENT_SCOPE_EXPANDED',
      );
      need(
        BigInt.parse(preview['totalFee']) <=
            BigInt.parse(consent['feeCap'] as String),
        'FEE_CAP_EXCEEDED',
      );
      // Native plan validation binds outputs/amounts. No separate transaction
      // algorithm is reimplemented in Dart.
    }
    fresh();
    final payload = {
      'version': '1.0',
      'method': method,
      'operationKind':
          transaction || reviewedTransaction
              ? 'transaction'
              : crypto
              ? 'crypto'
              : typed
              ? 'typedData'
              : 'message',
      'contextHash': contextHash,
      'origin': context['origin'],
      'sessionId': context['sessionId'],
      'chainId': account['chainId'],
      'accountId': account['accountId'],
      'requestHash': requestHash,
      'operationHash': operationHash,
      'expiresAt': expiryWire,
    };
    final binding = {'payload': payload, 'bindingHash': hashJson(payload)};
    final expectedBinding = canonical(binding);
    final expectedPreview = canonical(preview);
    need(
      canonical(binding) == expectedBinding &&
          canonical(preview) == expectedPreview,
      'APPROVAL_MATERIAL_CHANGED',
    );
    // The caller owns the trusted clock; never rewind it to a captured fixture.
    fresh();
    final issued = await signer.bind(
      TbcSigningMaterial(
        binding: binding,
        preview: preview,
        plan: plan,
        envelope: envelope,
        reviewed: reviewedProgram?.initialMaterial,
      ),
    );
    final receipt = issued.wire;
    await signer.requireCurrent();
    final approvedAt = clock.elapsedMicroseconds;
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
      final approved = protocolTime(receipt['approvedAt'] as String),
          expiry = protocolTime(receipt['expiresAt'] as String);
      need(
        !approved.isAfter(authority.now) &&
            !approved.isAfter(expiry) &&
            !expiry.isAfter(expires) &&
            authority.now.isBefore(expiry),
        'RECEIPT_TIME',
      );
    }

    receiptCheck();
    late final List<dynamic> tasks;
    if (crypto) {
      tasks = const [];
    } else if (transaction) {
      need(
        _engine('validate', {
              ...material!,
              'phase': 'pre-sign',
              'plan': plan,
              'binding': binding,
              'approval': receipt,
            })['valid'] ==
            true,
        'PRE_SIGN_INVALID',
      );
      tasks = plan!['payload']['signingTasks'];
    } else if (reviewedProgram != null) {
      tasks = reviewedProgram.tasks;
    } else {
      tasks = [
        {
          'taskId':
              typed
                  ? 'sign-typed-data'
                  : messageProfile == MessageSigningProfile.legacyBitcoin
                  ? 'legacy-sign-message'
                  : 'sign-message',
          'purpose': typed ? 'typedData' : 'message',
          'algorithm': 'secp256k1-recoverable-ecdsa-sha256d',
          'digest': operationHash,
          'signatureEncoding': 'compact65-recoverable',
          'origin': context['origin'],
          'accountId': account['accountId'],
          'publicKey': account['publicKey'],
        },
      ];
    }
    final taskLimit =
        transaction
            ? transactionTaskLimits[request['intent']['type']]!
            : reviewedTransaction
            ? 1000
            : 1;
    final stagedPoolWithoutCount =
        transaction &&
        poolContinuationProfiles.contains(request['intent']['type']) &&
        preview['transactionCount'] > 1 &&
        preview['signingTaskCount'] == null;
    final totalTasks =
        reviewedProgram != null
            ? reviewedProgram.totalTasks
            : stagedPoolWithoutCount
            ? (taskLimit * (preview['transactionCount'] as int)).clamp(1, 1024)
            : transaction
            ? (preview['signingTaskCount'] ?? tasks.length)
            : 1;
    need(
      totalTasks is int &&
          totalTasks >= tasks.length &&
          totalTasks <= (reviewedTransaction ? 32000 : 1024),
      'TOTAL_TASK_COUNT',
    );
    final consumed = <String>{};
    var lastSignedAt = clock.elapsedMicroseconds;
    Future<List<Map<String, dynamic>>> signTasks(List stageTasks) async {
      need(
        (stageTasks.isNotEmpty || reviewedTransaction) &&
            stageTasks.length <= taskLimit &&
            consumed.length + stageTasks.length <= totalTasks,
        'TASK_COUNT',
      );
      final authorizedTasks = canonical(stageTasks);
      roleAccounts?.requireTasks(stageTasks);
      final signatures = <Map<String, dynamic>>[];
      for (final task in stageTasks) {
        receiptCheck();
        need(
          canonical(stageTasks) == authorizedTasks &&
              (roleAccounts != null ||
                  (task['accountId'] == account['accountId'] &&
                      task['publicKey'] == account['publicKey'])),
          'TASK_BINDING',
        );
        need(
          authority.isUnlocked() && consumed.add(task['taskId']),
          'SIGNER_LOCKED_OR_REPLAY',
        );
        // Native UI executor checks current scope, consumes the permit and invokes
        // unchanged Rust synchronously; an async Dart check alone is insufficient.
        final watch = Stopwatch()..start();
        final sig = (await signer.sign(issued, TbcSigningTask(task))).toWire();
        await signer.requireCurrent();
        _time('nativeSignerRoundTrip', watch.elapsedMicroseconds);
        receiptCheck();
        need(
          sig['taskId'] == task['taskId'] &&
              sig['signatureEncoding'] == task['signatureEncoding'],
          'SIGNER_RESULT_BINDING',
        );
        if (!transaction && !reviewedTransaction) {
          final verify = Stopwatch()..start();
          verifyRecoverable(task, sig);
          _time('messageVerify', verify.elapsedMicroseconds);
        }
        signatures.add(sig);
      }
      lastSignedAt = clock.elapsedMicroseconds;
      return signatures;
    }

    Future<void> advance(Map<String, dynamic> value) async {
      await signer.advance(issued, TbcSigningContinuation(value));
      await signer.requireCurrent();
      receiptCheck();
    }

    late Map<String, dynamic> result;
    if (cryptoProgram != null) {
      receiptCheck();
      final watch = Stopwatch()..start();
      final output = await (signer as TbcCryptoSigningOperation).executeCrypto(
        issued,
        TbcCryptoTask(cryptoProgram.task),
      );
      await signer.requireCurrent();
      receiptCheck();
      result = cryptoProgram.result(output.wire);
      _time('nativeCryptoRoundTrip', watch.elapsedMicroseconds);
      lastSignedAt = clock.elapsedMicroseconds;
    } else if (reviewedProgram != null) {
      result = await signReviewedStages(
        program: reviewedProgram,
        approvalId: receipt['approvalId'],
        sign: signTasks,
        advance: advance,
        receiptCheck: receiptCheck,
      );
    } else if (transaction) {
      result = await signTransactionStages(
        material: material!,
        plan: plan!,
        binding: binding,
        receipt: receipt,
        account: account,
        engine: _engine,
        sign: signTasks,
        advance: advance,
        receiptCheck: receiptCheck,
        forBroadcast: sending,
      );
    } else {
      final signatures = await signTasks(tasks);
      result = signedEnvelopeResult(
        messageProfile: messageProfile,
        envelope: envelope!,
        task: tasks.single,
        signature: signatures.single,
        account: account,
      );
    }
    _time(
      crypto ? 'earlyConsentToCryptoUs' : 'earlyConsentToSignUs',
      lastSignedAt - consentAt,
    );
    _time(
      crypto ? 'formalReceiptToCryptoUs' : 'formalReceiptToSignUs',
      lastSignedAt - approvedAt,
    );
    await signer.requireCurrent();
    receiptCheck();
    if (sending) {
      result = await TbcSendLifecycle(
        maxTransactions: transactionBundleLimit(request),
        custody: signer as TbcBroadcastSigningOperation,
        receipt: issued,
        receiptCheck: receiptCheck,
      ).single(result);
    }
    _time('formalReceiptToReturnUs', clock.elapsedMicroseconds - approvedAt);
    _time('earlyConsentToReturnUs', clock.elapsedMicroseconds - consentAt);
    _time('totalUs', clock.elapsedMicroseconds);
    return result;
  }
}
