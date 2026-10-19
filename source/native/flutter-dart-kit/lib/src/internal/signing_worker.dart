import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:crypto/crypto.dart';
import '../configuration.dart';
import '../signing_backend.dart';
import '../webview_scope.dart';
import 'native_compute.dart';
import 'native_material.dart';
import 'amm_material.dart';
import 'amm_business_material.dart';
import 'lp_material.dart';
import 'pool2_material.dart';
import 'unified_pool_material.dart';
import 'timelock_material.dart';
import 'htlc_material.dart';
import 'htlc_token_material.dart';
import 'lop_material.dart';
import 'collection_material.dart';
import 'nft_material.dart';
import 'operation_authority.dart';
import 'read_api.dart';
import 'chain_read_reply.dart';
import 'txo_status_reply.dart';
import 'protocol_codec.dart';
import 'prepared_proposal.dart';
import 'reviewed_reviewer.dart';
import 'signing_executor.dart';
import 'typed_signing.dart';
import 'crypto_action.dart';
import 'stablecoin_material.dart';
import 'tbc20_material.dart';
import 'transaction_policy.dart';
import 'workflow_request.dart';
import 'send_lifecycle.dart';
import 'native_broadcast_binding.dart';
import 'broadcast_port.dart';
import 'asset_metadata.dart';
import 'legacy_business.dart';
import 'legacy_signing_call.dart';
import 'balance_read.dart';
import 'maintenance_backend.dart';
import 'merge_material.dart';
import 'multi_round_merge.dart';

/// A wallet/platform-supplied artifact, never a URL or path from a page.
/// Hashing and loading happen in the non-UI isolate before any native callback.
final class TbcPinnedComputeLibrary {
  TbcPinnedComputeLibrary({required this.path, required this.sha256}) {
    if (!File(path).isAbsolute || !RegExp(r'^[0-9a-f]{64}$').hasMatch(sha256)) {
      throw const FormatException('Invalid pinned compute artifact');
    }
  }
  final String path, sha256;
}

/// One long-lived compute/material worker for one immutable network/source.
/// This is private package plumbing, not a DApp RPC endpoint. Native custody
/// stays in the wallet executor. No private key is sent into this isolate.
/// Provider replay handling and committed-grant evaluation remain upstream.
final class TbcSigningWorker {
  TbcSigningWorker._(
    this.network,
    this._backend,
    this._read,
    this._txoStatus,
    this._messageProfile,
  );
  final TbcNetworkConfiguration network;
  final TbcWalletSigningBackend _backend;
  final ApiRead? _read;
  final ApiTxoStatus? _txoStatus;
  final MessageSigningProfile _messageProfile;
  bool get usesLegacyMessageProfile =>
      _messageProfile == MessageSigningProfile.legacyBitcoin;
  bool get supportsMaintenance => _backend is TbcMaintenanceBackend;
  final ReceivePort _events = ReceivePort();
  final ReceivePort _exit = ReceivePort();
  final ReceivePort _errors = ReceivePort();
  final Completer<void> _ready = Completer<void>();
  final Completer<void> _stopped = Completer<void>();
  final Map<String, _ParentJob> _jobs = {};
  SendPort? _commands;
  Isolate? _isolate;
  bool _closed = false;
  int _sequence = 0;

  static Future<TbcSigningWorker> start({
    required TbcPinnedComputeLibrary library,
    required TbcNetworkConfiguration network,
    required TbcWalletSigningBackend backend,
    // Optional wallet-owned custom transport. The default performs and parses
    // HTTP in the worker, bound to network.apiOrigin; page input cannot set it.
    ApiRead? read,
    ApiTxoStatus? txoStatus,
    MessageSigningProfile messageProfile = MessageSigningProfile.standard,
  }) async {
    if (txoStatus != null && read == null) {
      throw ArgumentError('TXO status must use the same custom read source');
    }
    final worker = TbcSigningWorker._(
      network,
      backend,
      read,
      txoStatus,
      messageProfile,
    );
    worker._events.listen(worker._event);
    worker._exit.listen((_) => worker._lost());
    worker._errors.listen((_) => worker._lost());
    try {
      worker._isolate = await Isolate.spawn(
        _entry,
        {
          'events': worker._events.sendPort,
          'library': library.path,
          'sha256': library.sha256,
          'network': network,
          'externalRead': read != null,
          'messageProfile': messageProfile,
        },
        onExit: worker._exit.sendPort,
        onError: worker._errors.sendPort,
        errorsAreFatal: true,
        debugName: 'tbc-signing-compute',
      );
      await worker._ready.future.timeout(const Duration(seconds: 30));
      return worker;
    } catch (_) {
      await worker.close();
      throw StateError('Pinned signing worker could not start');
    }
  }

  bool get isClosed => _closed;
  int get pendingCount => _jobs.length;

  /// Internal shared maintenance entry. The caller supplies a committed
  /// accounts+send grant fence; neither a Legacy page nor this worker grants
  /// approval. Native custody owns the bounded parent and all its children.
  Future<Map<String, dynamic>> executeMaintenance({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> asset,
    required Map<String, dynamic> limits,
    required void Function() requireAuthorized,
    required bool Function() isUnlocked,
    TbcExecutionTiming? timing,
    bool includeProgress = false,
  }) async {
    need(
      !_closed &&
          _commands != null &&
          _jobs.length < 16 &&
          _backend is TbcMaintenanceBackend,
      'MAINTENANCE_BACKEND_REQUIRED',
    );
    requireAuthorized();
    need(
      scope.method == 'tbc_sendTransaction' &&
          scope.account.network == network.network,
      'MAINTENANCE_SCOPE',
    );
    final capturedAsset = copied(asset);
    final capturedLimits = normalizeMultiRoundMergeLimits(
      capturedAsset,
      limits,
      DateTime.now().millisecondsSinceEpoch,
    );
    need(
      !_jobs.values.any(
        (j) =>
            (j.maintenance || j.scope.operationId == scope.operationId) &&
            j.scope.navigation.matches(scope.navigation.toWire()),
      ),
      'MAINTENANCE_ALREADY_ACTIVE',
    );
    final id = 'job-${++_sequence}';
    final job = _ParentJob(
      scope,
      requireAuthorized,
      isUnlocked,
      timing,
      maintenance: true,
    );
    _jobs[id] = job;
    job.result.future.ignore();
    try {
      _commands!.send({
        'type': 'maintenance',
        'id': id,
        'scope': scope,
        'asset': capturedAsset,
        'limits': capturedLimits,
        'timing': timing != null,
        'includeProgress': includeProgress,
      });
      // Scope expiry also bounds UI/read waits. Cancellation never resubmits;
      // native journal records survive closing this ephemeral owner.
      final remaining = protocolTime(
        capturedLimits['expiresAt'],
      ).difference(DateTime.now().toUtc());
      final result = await job.result.future.timeout(
        remaining.isNegative ? Duration.zero : remaining,
        onTimeout: () {
          cancelOperation(scope.operationId, scope.navigation);
          throw StateError('Maintenance operation expired');
        },
      );
      job.check();
      return result;
    } finally {
      _jobs.remove(id);
      job.active = false;
      _commands?.send({'type': 'cancel', 'id': id});
      await job.dispose();
    }
  }

  /// Shared read-only work in the existing network isolate. This deliberately
  /// does not begin a custody operation, request consent, sign or persist.
  Future<Map<String, dynamic>> readBalance({
    required TbcSigningRequestScope scope,
    required void Function() requireAuthorized,
  }) async {
    need(
      !_closed && _commands != null && _jobs.length < 16,
      'READ_WORKER_UNAVAILABLE',
    );
    requireAuthorized();
    need(
      scope.method == balanceReadMethod &&
          scope.account.network.chainId == network.chainId,
      'BALANCE_SCOPE',
    );
    balanceReadPath(scope.account.address);
    need(
      !_jobs.values.any(
        (j) =>
            j.scope.operationId == scope.operationId &&
            j.scope.navigation.sessionId == scope.navigation.sessionId,
      ),
      'READ_ALREADY_ACTIVE',
    );
    final id = 'job-${++_sequence}';
    final job = _ParentJob(
      scope,
      requireAuthorized,
      () => false,
      null,
      readOnly: true,
    );
    _jobs[id] = job;
    job.result.future.ignore();
    try {
      _commands!.send({'type': 'balance', 'id': id, 'scope': scope});
      final result = await job.result.future.timeout(
        const Duration(seconds: 30),
      );
      job.check();
      return result;
    } finally {
      _jobs.remove(id);
      job.active = false;
      _commands?.send({'type': 'cancel', 'id': id});
    }
  }

  /// [requireAuthorized] is a local live grant/document/account-generation
  /// fence, not an HTTP call. [policy] comes from the shared wallet policy
  /// module, never from page input. Signing-only does not write a journal.
  Future<Map<String, dynamic>> execute({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> request,
    Map<String, dynamic>? policy,
    // Wallet-owned child policies, keyed by the shared single-call projection.
    // Null retains existing default policy derivation without extra work.
    Map<String, dynamic>? policiesByRequestHash,
    required void Function() requireAuthorized,
    // Workflows require live child grants too, not merely the batch grant.
    // This wallet-owned mirror stays local; native custody repeats at key use.
    void Function(String method)? requireAuthorizedMethod,
    required bool Function() isUnlocked,
    TbcExecutionTiming? timing,
  }) => _dispatch(
    scope: scope,
    request: request,
    policy: policy,
    policiesByRequestHash: policiesByRequestHash,
    requireAuthorized: requireAuthorized,
    requireAuthorizedMethod: requireAuthorizedMethod,
    isUnlocked: isUnlocked,
    timing: timing,
  );

  /// Package-private Legacy ingress into the SAME worker and custody lifecycle.
  /// The returned value is still the standard result; the edge maps its shape.
  /// Only an immutable native Legacy lane may construct this worker profile.
  Future<Map<String, dynamic>> executeLegacy({
    required TbcSigningRequestScope scope,
    required LegacySigningCall call,
    required void Function() requireAuthorized,
    void Function(String method)? requireAuthorizedMethod,
    required bool Function() isUnlocked,
    TbcExecutionTiming? timing,
  }) => _dispatch(
    scope: scope,
    request: call.account.common,
    legacyCall: call,
    requireAuthorized: requireAuthorized,
    requireAuthorizedMethod: requireAuthorizedMethod,
    isUnlocked: isUnlocked,
    timing: timing,
  );

  Future<Map<String, dynamic>> _dispatch({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> request,
    LegacySigningCall? legacyCall,
    Map<String, dynamic>? policy,
    Map<String, dynamic>? policiesByRequestHash,
    required void Function() requireAuthorized,
    void Function(String method)? requireAuthorizedMethod,
    required bool Function() isUnlocked,
    TbcExecutionTiming? timing,
  }) async {
    if (_closed || _commands == null || _jobs.length >= 16) {
      throw StateError('Signing worker unavailable');
    }
    requireAuthorized();
    if (legacyCall != null) {
      need(
        _messageProfile == MessageSigningProfile.legacyBitcoin &&
            legacyCall.standardMethod == scope.method &&
            legacyCall.account.chainId == network.chainId &&
            legacyCall.account.address == scope.account.address,
        'LEGACY_WORKER_SCOPE',
      );
    }
    if (scope.account.network != network.network ||
        request['chainId'] != network.chainId ||
        request['from'] != scope.account.address ||
        !{
          'tbc_signMessage',
          'tbc_signTypedData',
          'tbc_signTransaction',
          'tbc_signPreparedTransaction',
          'tbc_signReviewedTransaction',
          'tbc_signWorkflow',
          'tbc_signPreparedWorkflow',
          ...sendMethods,
          ...cryptoMethods,
        }.contains(scope.method)) {
      throw StateError('Signing worker scope mismatch');
    }
    final workflow = workflowMethods.contains(scope.method);
    final captured =
        workflow && legacyCall == null
            ? checkedWorkflowRequest(
              method: scope.method,
              input: request,
              origin: scope.navigation.origin,
              now: DateTime.now().toUtc(),
            )
            : copied(request);
    final methods = {
      scope.method,
      if (workflow && legacyCall != null) ...legacyCall.requiredPermissions,
      if (workflow && legacyCall == null)
        ...workflowRequiredPermissions(captured, method: scope.method),
    };
    Map<String, dynamic>? capturedPolicies;
    if (policiesByRequestHash != null) {
      need(workflow && policy == null, 'WORKFLOW_POLICY_SCOPE');
      final keys = <String>{
        for (final step in captured['steps'])
          if (workflowTransaction(step))
            hashJson(workflowTransactionRequest(captured, step)),
      };
      capturedPolicies = copied(policiesByRequestHash);
      need(
        capturedPolicies.length == keys.length &&
            capturedPolicies.keys.every(keys.contains) &&
            capturedPolicies.values.every((p) => p is Map),
        'WORKFLOW_POLICY_COVERAGE',
      );
    }
    if (workflow && requireAuthorizedMethod == null) {
      throw StateError('Workflow child permission evaluator required');
    }
    void current() {
      requireAuthorized();
      if (workflow)
        for (final method in methods) requireAuthorizedMethod!(method);
    }

    current();
    if (_jobs.values.any(
      (job) =>
          job.scope.operationId == scope.operationId &&
          job.scope.navigation.sessionId == scope.navigation.sessionId,
    )) {
      throw StateError('Signing operation already active');
    }
    final id = 'job-${++_sequence}';
    final job = _ParentJob(scope, current, isUnlocked, timing);
    _jobs[id] = job;
    // Observe rejection immediately, including invalidation while begin awaits.
    job.result.future.ignore();
    try {
      final opening = _backend.begin(scope).then<void>((operation) async {
        job.operation = operation;
        if (workflow && operation is! TbcWorkflowSigningOperation) {
          await job.dispose();
          throw StateError('Native workflow custody required');
        }
        if (sendMethods.contains(scope.method) &&
            operation is! TbcBroadcastSigningOperation) {
          await job.dispose();
          throw StateError('Native broadcast custody required');
        }
        if ((cryptoMethods.contains(scope.method) ||
                (workflow &&
                    (legacyCall?.usesCrypto ??
                        (captured['steps'] as List).any(
                          (s) =>
                              s['kind'] == 'encrypt' || s['kind'] == 'decrypt',
                        )))) &&
            operation is! TbcCryptoSigningOperation) {
          await job.dispose();
          throw StateError('Native crypto custody required');
        }
        if (!job.active || _closed) {
          await job.dispose();
          throw StateError(
            'Native signing operation opened after cancellation',
          );
        }
        job.check();
      });
      // A navigation cancellation must not wait for a delayed platform-channel
      // reply. The opening continuation still disposes any late native handle.
      await Future.any<void>([
        opening,
        job.result.future.then<void>((_) {}),
      ]).timeout(
        const Duration(seconds: 30),
        onTimeout: () {
          invalidate(scope.navigation);
          throw StateError('Native signing operation did not open');
        },
      );
      job.check();
      if (_closed || !_jobs.containsKey(id))
        throw StateError('Signing worker closed');
      _commands!.send({
        'type': 'execute',
        'id': id,
        'scope': scope,
        'request': captured,
        if (legacyCall != null) 'legacyCall': legacyCall,
        'methods': methods.toList(growable: false),
        'policy': policy == null ? null : copied(policy),
        'policiesByRequestHash': capturedPolicies,
        'timing': timing != null,
        'nativeBroadcastCommands':
            sendMethods.contains(scope.method) &&
            job.operation is NativeBroadcastCommands,
      });
      final result = await job.result.future.timeout(
        const Duration(minutes: 5),
        onTimeout: () {
          invalidate(scope.navigation);
          throw StateError('Signing operation expired');
        },
      );
      job.check();
      return result;
    } finally {
      _jobs.remove(id);
      await job.dispose();
    }
  }

  /// Cancel the native scope before asynchronous cleanup, then suppress all
  /// pending worker results. No automatic retry or transaction POST occurs.
  void invalidate(TbcWebViewNavigation navigation) {
    final matches =
        _jobs.entries
            .where(
              (entry) =>
                  entry.value.scope.navigation.webViewInstanceId ==
                      navigation.webViewInstanceId &&
                  entry.value.scope.navigation.sessionId ==
                      navigation.sessionId &&
                  entry.value.scope.navigation.navigationId ==
                      navigation.navigationId,
            )
            .toList();
    for (final entry in matches) entry.value.active = false;
    Object? failure;
    try {
      _backend.revokePending(navigation);
    } catch (_) {
      failure = StateError('Native signing revocation unavailable');
    } finally {
      for (final entry in matches) {
        _commands?.send({'type': 'cancel', 'id': entry.key});
        entry.value.fail('Signing operation invalidated');
        unawaited(entry.value.dispose().catchError((_) {}));
      }
    }
    if (failure != null) throw failure;
  }

  /// A Provider request cancellation, distinct from whole-document teardown.
  void cancelOperation(String operationId, TbcWebViewNavigation navigation) {
    final matches =
        _jobs.entries
            .where(
              (e) =>
                  e.value.scope.operationId == operationId &&
                  e.value.scope.navigation.matches(navigation.toWire()),
            )
            .toList();
    Object? failure;
    for (final entry in matches) {
      entry.value.active = false;
      try {
        if (!entry.value.readOnly) _backend.revokeOperation(entry.value.scope);
      } catch (_) {
        failure = StateError('Native operation revocation unavailable');
        // If targeted revocation failed, fail closed at the document boundary.
        invalidate(navigation);
      } finally {
        _commands?.send({'type': 'cancel', 'id': entry.key});
        entry.value.fail('Signing operation cancelled');
        unawaited(entry.value.dispose().catchError((_) {}));
      }
    }
    if (failure != null) throw failure;
  }

  void _event(dynamic event) {
    if (event is! Map) return;
    if (event['type'] == 'stopped') {
      if (!_stopped.isCompleted) _stopped.complete();
      return;
    }
    if (_closed) return;
    switch (event['type']) {
      case 'ready':
        _commands = event['commands'] as SendPort;
        if (!_ready.isCompleted) _ready.complete();
      case 'startupError':
        if (!_ready.isCompleted)
          _ready.completeError(StateError('Compute artifact unavailable'));
      case 'rpc':
        unawaited(_rpc(event));
      case 'result':
        final job = _jobs[event['id']];
        if (job == null || job.result.isCompleted) return;
        try {
          job.check();
          if (event['ok'] != true && event['rejected'] == true) {
            job.active = false;
            job.result.completeError(const TbcSigningRejected());
            return;
          }
          if (event['ok'] != true &&
              event['invalidTypedData'] == true &&
              job.scope.method == 'tbc_signTypedData') {
            job.active = false;
            job.result.completeError(TbcInvalidTypedData());
            return;
          }
          if (event['ok'] != true &&
              event['invalidCrypto'] == true &&
              cryptoMethods.contains(job.scope.method)) {
            job.active = false;
            job.result.completeError(TbcInvalidCryptoRequest());
            return;
          }
          if (event['ok'] != true &&
              {
                'tbc_signPreparedTransaction',
                'tbc_sendPreparedTransaction',
              }.contains(job.scope.method) &&
              PreparedRefusal.values.any(
                (v) => v.name == event['preparedRefusal'],
              )) {
            job.active = false;
            job.result.completeError(
              TbcPreparedRefused(
                PreparedRefusal.values.singleWhere(
                  (v) => v.name == event['preparedRefusal'],
                ),
              ),
            );
            return;
          }
          if (event['ok'] != true)
            throw StateError('Signing execution did not complete');
          job.result.complete(copied(event['value'] as Map));
        } catch (_) {
          job.fail('Signing execution did not complete');
        }
      case 'timing':
        final job = _jobs[event['id']];
        if (job == null || !job.active) return;
        try {
          job.timing?.call(event['stage'] as String, event['us'] as int);
        } catch (_) {}
    }
  }

  Future<void> _rpc(Map event) async {
    final job = _jobs[event['id']];
    final reply = <String, dynamic>{
      'type': 'reply',
      'rpc': event['rpc'],
      'ok': false,
    };
    try {
      if (job == null ||
          (!job.readOnly && !job.maintenance && job.operation == null))
        throw StateError('Unknown signing operation');
      final args = event['args'];
      dynamic value;
      if (job.readOnly) {
        // A read job cannot invoke even one custody/crypto/broadcast callback.
        need(
          event['method'] == 'read' &&
              _read != null &&
              args == balanceReadPath(job.scope.account.address),
          'READ_CALLBACK',
        );
        job.check();
        value = await _read!(args as String);
        job.check();
      } else if (event['method'] == 'close') {
        if (job.maintenance) {
          await job.closeChild();
        } else {
          await job.dispose();
        }
        value = null;
      } else if (job.maintenance &&
          {
            'maintenanceCurrent',
            'maintenanceApprove',
            'maintenanceStep',
            'maintenanceFinish',
            'maintenanceNoop',
            'read',
            'txoStatus',
          }.contains(event['method'])) {
        job.check();
        switch (event['method']) {
          case 'maintenanceNoop':
            need(
              job.maintenanceOwner == null &&
                  job.operation == null &&
                  !job.openingMaintenance &&
                  !job.openingChild,
              'MAINTENANCE_CHILD_ACTIVE',
            );
            await (_backend as TbcMaintenanceBackend).finishMaintenanceNoop(
              job.scope,
              copied(args['scope']),
              copied(args['result']),
            );
            value = null;
          case 'maintenanceFinish':
            need(
              job.maintenanceOwner != null &&
                  job.operation == null &&
                  !job.openingChild,
              'MAINTENANCE_CHILD_ACTIVE',
            );
            await job.maintenanceOwner!.finish(copied(args as Map));
            value = null;
          case 'maintenanceCurrent':
            // Read-only preparation uses the committed local mirror. Native
            // repeats authority/grants at approval, child bind and key use.
            need(job.isUnlocked(), 'MAINTENANCE_LOCKED');
            value = null;
          case 'maintenanceApprove':
            need(
              job.maintenanceOwner == null && !job.openingMaintenance,
              'MAINTENANCE_ALREADY_APPROVED',
            );
            job.openingMaintenance = true;
            try {
              final owner = await (_backend as TbcMaintenanceBackend)
                  .beginMaintenance(job.scope, copied(args as Map));
              job.maintenanceOwner = owner;
              try {
                job.check();
              } catch (_) {
                await job.dispose();
                rethrow;
              }
              value = copied(owner.approval);
            } finally {
              job.openingMaintenance = false;
            }
          case 'maintenanceStep':
            need(
              job.maintenanceOwner != null &&
                  job.operation == null &&
                  !job.openingChild,
              'MAINTENANCE_CHILD_ACTIVE',
            );
            job.openingChild = true;
            try {
              final step = copied(args['step'] as Map);
              final child = TbcSigningRequestScope(
                operationId:
                    'merge-${hashJson({'parent': job.scope.operationId, 'approval': job.maintenanceOwner!.approval['approvalId'], 'index': step['stepIndex']})}',
                method: job.scope.method,
                navigation: job.scope.navigation,
                account: job.scope.account,
                revision: job.scope.revision,
              );
              job.operation = await job.maintenanceOwner!.beginStep(
                scope: child,
                step: step,
                request: copied(args['request']),
                selectedInputs: (args['selectedInputs'] as List).cast<String>(),
              );
              try {
                job.check();
                need(
                  job.operation is TbcBroadcastSigningOperation,
                  'MAINTENANCE_BROADCAST_REQUIRED',
                );
              } catch (_) {
                await job.dispose();
                rethrow;
              }
              value = {
                'scope': child,
                'nativeBroadcastCommands':
                    job.operation is NativeBroadcastCommands,
              };
            } finally {
              job.openingChild = false;
            }
          case 'read':
            need(_read != null, 'MAINTENANCE_READ_SOURCE');
            value = await _read!(args as String);
          case 'txoStatus':
            need(_txoStatus != null, 'MAINTENANCE_STATUS_SOURCE');
            value = await _txoStatus!([
              for (final point in args as List) copied(point as Map),
            ]);
        }
        job.check();
      } else {
        final op = job.operation;
        need(op != null, 'SIGNING_CHILD_REQUIRED');
        job.check();
        switch (event['method']) {
          case 'current':
            await op!.requireCurrent();
            value = {'unlocked': job.isUnlocked()};
          case 'roles':
            if (op is! TbcTransactionSigningRoles)
              throw StateError('Role adapter required');
            value = (await (op as TbcTransactionSigningRoles)
                .resolveSigningAccounts(
                  TbcBoundedSigningIntent(
                    method: job.scope.method,
                    request: args['request'] as Map,
                    context: args['context'] as Map,
                  ),
                )).map((a) => a.toKitAccount()).toList(growable: false);
          case 'consent':
            value = await op!.requestConsent(
              TbcBoundedSigningIntent(
                method: job.scope.method,
                request: args['request'] as Map,
                context: args['context'] as Map,
                review: args['review'] as Map?,
              ),
            );
          case 'bind':
            value =
                (await op!.bind(
                  TbcSigningMaterial(
                    binding: args['binding'] as Map,
                    preview: args['preview'] as Map,
                    plan: args['plan'] as Map?,
                    envelope: args['envelope'] as Map?,
                    reviewed: args['reviewed'] as Map?,
                  ),
                )).wire;
          case 'advance':
            await op!.advance(
              TbcSigningReceipt(args['receipt'] as Map),
              TbcSigningContinuation(args['pending'] as Map),
            );
            value = null;
          case 'workflowEnter':
          case 'workflowFinish':
            if (!workflowMethods.contains(job.scope.method) ||
                op is! TbcWorkflowSigningOperation) {
              throw StateError('Workflow custody required');
            }
            final custody = op;
            final receipt = TbcSigningReceipt(args['receipt'] as Map);
            final step = TbcSigningContinuation(args['step'] as Map);
            if (event['method'] == 'workflowEnter') {
              await custody.enterWorkflowStep(receipt, step);
            } else {
              await custody.finishWorkflowStep(receipt, step);
            }
            value = null;
          case 'sign':
            if (cryptoMethods.contains(job.scope.method))
              throw StateError('Crypto cannot use digest signing');
            value =
                (await op!.sign(
                  TbcSigningReceipt(args['receipt'] as Map),
                  TbcSigningTask(args['task'] as Map),
                )).toWire();
          case 'crypto':
            if ((!cryptoMethods.contains(job.scope.method) &&
                    !workflowMethods.contains(job.scope.method)) ||
                op is! TbcCryptoSigningOperation) {
              throw StateError('Native crypto custody required');
            }
            value =
                (await op.executeCrypto(
                  TbcSigningReceipt(args['receipt'] as Map),
                  TbcCryptoTask(args['task'] as Map),
                )).wire;
          case 'broadcastAuthorize':
          case 'broadcastSubmit':
          case 'broadcastBatch':
          case 'broadcastReconcile':
          case 'broadcastFinish':
            if (!sendMethods.contains(job.scope.method) ||
                op is! TbcBroadcastSigningOperation) {
              throw StateError('Native broadcast custody required');
            }
            final receipt = TbcSigningReceipt(args['receipt'] as Map);
            switch (event['method']) {
              case 'broadcastAuthorize':
                await op.authorizeBroadcast(
                  receipt,
                  TbcBroadcastMaterial(
                    bundle: args['bundle'] as Map,
                    workflow: args['workflow'] as Map?,
                  ),
                );
                value = null;
              case 'broadcastSubmit':
                value =
                    (await op.submitTransaction(
                      receipt,
                      args['index'] as int,
                    )).wire;
              case 'broadcastBatch':
                value = (await op.submitBatch(receipt)).wire;
              case 'broadcastReconcile':
                value =
                    (await op.reconcileSubmitted(
                      receipt,
                      (args['txids'] as List).cast<String>(),
                    )).wire;
              case 'broadcastFinish':
                await op.finishBroadcast(
                  receipt,
                  TbcBroadcastResult(args['result'] as Map),
                );
                value = null;
            }
          case 'broadcastCommand':
            if (!sendMethods.contains(job.scope.method) ||
                op is! NativeBroadcastCommands ||
                !nativeBroadcastCommands.contains(args['command'])) {
              throw StateError('Native broadcast channel required');
            }
            value = await (op as NativeBroadcastCommands).invokeBroadcast(
              args['command'] as String,
              Map<String, Object?>.from(args['fields'] as Map),
            );
          case 'read':
            if (_read == null)
              throw StateError('External read adapter not configured');
            value = await _read(args as String);
          case 'txoStatus':
            if (_txoStatus == null) {
              throw StateError('Custom TXO status adapter not configured');
            }
            value = await _txoStatus([
              for (final point in args as List) copied(point as Map),
            ]);
          default:
            throw UnsupportedError('Unknown private worker callback');
        }
        job.check();
      }
      reply['ok'] = true;
      reply['value'] = value;
    } catch (error) {
      // Never send native errors, stack traces, URLs or private material back.
      if (error is TbcSigningRejected) reply['rejected'] = true;
      if (error is BroadcastNodeFailure &&
          event['method'] == 'broadcastCommand' &&
          event['args']?['command'] == 'signing.broadcast.wire' &&
          {
            'NODE_REQUEST_FAILED',
            'NODE_RESPONSE_INVALID',
          }.contains(error.code)) {
        reply['broadcastFailure'] = error.code;
      }
      if (error is TbcWorkflowStepUnavailable &&
          event['method'] == 'sign' &&
          error.operation == 'signer.sign' &&
          job != null &&
          workflowMethods.contains(job.scope.method)) {
        // Fixed flag only. An arbitrary native/transport failure cannot become
        // an authorization to continue another step or retry this signature.
        reply['workflowStepUnavailable'] = true;
      }
      if (error is TbcWorkflowStepUnavailable &&
          event['method'] == 'crypto' &&
          error.operation == 'crypto.execute' &&
          job != null &&
          workflowMethods.contains(job.scope.method)) {
        reply['workflowCryptoUnavailable'] = true;
      }
    }
    _commands?.send(reply);
  }

  void _lost() {
    if (_closed) return;
    if (!_ready.isCompleted)
      _ready.completeError(StateError('Compute worker exited'));
    for (final job in _jobs.values.toList()) {
      try {
        invalidate(job.scope.navigation);
      } catch (_) {}
    }
    unawaited(close().catchError((_) {}));
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    final jobs = _jobs.values.toList();
    for (final job in jobs) {
      try {
        invalidate(job.scope.navigation);
      } catch (_) {}
    }
    if (_commands != null) {
      _commands!.send({'type': 'shutdown'});
      await _stopped.future.timeout(
        const Duration(seconds: 1),
        onTimeout: () {},
      );
    }
    _isolate?.kill(priority: Isolate.immediate);
    _commands = null;
    _events.close();
    _exit.close();
    _errors.close();
    await Future.wait(
      jobs.map((job) => job.dispose().timeout(const Duration(seconds: 5))),
    );
  }
}

final class _ParentJob {
  _ParentJob(
    this.scope,
    this.authorized,
    this.isUnlocked,
    this.timing, {
    this.readOnly = false,
    this.maintenance = false,
  });
  final bool readOnly;
  final bool maintenance;
  final TbcSigningRequestScope scope;
  final void Function() authorized;
  final bool Function() isUnlocked;
  final TbcExecutionTiming? timing;
  final Completer<Map<String, dynamic>> result = Completer();
  TbcSigningOperation? operation;
  TbcMaintenanceOwner? maintenanceOwner;
  bool openingMaintenance = false, openingChild = false;
  Future<void>? _closingMaintenance;
  bool active = true;
  Future<void>? _closing;
  void check() {
    if (!active) throw StateError('Inactive signing operation');
    authorized();
    if (!active) throw StateError('Signing operation invalidated');
  }

  void fail(String message) {
    active = false;
    if (!result.isCompleted) result.completeError(StateError(message));
  }

  Future<void> dispose() {
    if (maintenance) return _disposeMaintenance();
    final op = operation;
    // A late native begin still needs close; do not memoize an absent operation.
    return op == null ? Future.value() : (_closing ??= op.close());
  }

  Future<void> closeChild() async {
    final op = operation;
    if (op == null) return;
    await (_closing ??= op.close());
    if (identical(operation, op)) {
      operation = null;
      _closing = null;
    }
  }

  Future<void> _disposeMaintenance() async {
    final owner = maintenanceOwner;
    try {
      if (owner != null) await (_closingMaintenance ??= owner.close());
    } finally {
      await closeChild();
    }
  }
}

final Object _readOwner = Object();

Future<void> _entry(Map<String, dynamic> initial) async {
  final events = initial['events'] as SendPort, inbox = ReceivePort();
  try {
    final file = File(initial['library'] as String);
    need(
      sha256.convert(await file.readAsBytes()).toString() == initial['sha256'],
      'ENGINE_ARTIFACT_HASH',
    );
    final engine = ComputeProbe(DynamicLibrary.open(file.path));
    final network = initial['network'] as TbcNetworkConfiguration;
    final api = initial['externalRead'] == true ? null : TbcReadApi(network);
    final rpc = _WorkerRpc(events);
    final jobs = <String, _WorkerJob>{};
    Future<Map<String, dynamic>> read(String path) async {
      final owner = Zone.current[_readOwner] as _WorkerJob;
      return owner.preparationRead('get:$path', () async {
        if (api != null) return api.get(path);
        return copyChainReadReply(await owner.call('read', path) as Map);
      });
    }

    Future<Map<String, dynamic>> txoStatus(
      List<Map<String, dynamic>> txos,
    ) async {
      final owner = Zone.current[_readOwner] as _WorkerJob;
      return owner.preparationRead('txos:${canonical(txos)}', () async {
        if (api != null) return api.txoStatus(txos);
        return normalizeTxoStatusReply(
          await owner.call('txoStatus', txos) as Map,
        );
      });
    }

    final nativeReader = NativeMaterialReader(network: network, read: read);
    final reader = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final nftReader = NftMaterialReader(
      network: network,
      read: read,
      status: txoStatus,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final metadata = LegacySharedMetadata(AssetMetadataReader(history: reader));
    final timelockReader = TimelockMaterialReader(
      network: network,
      read: read,
      readHistory: reader.parent,
      funding: nativeReader,
    );
    final htlcReader = HtlcMaterialReader(
      network: network,
      read: read,
      status: txoStatus,
      readHistory: reader.parent,
      funding: nativeReader,
    );
    final ammReader = AmmMaterialReader(
      network: network,
      funding: nativeReader,
      readHistory: reader.parent,
    );
    final ammBusinessReader = AmmBusinessMaterialReader(
      network: network,
      read: read,
      funding: nativeReader,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final lpReader = LpMaterialReader(
      network: network,
      read: read,
      funding: nativeReader,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final pool2Reader = Pool2MaterialReader(
      network: network,
      read: read,
      funding: nativeReader,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final unifiedPoolReader = UnifiedPoolMaterialReader(
      network: network,
      read: read,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final collectionReader = CollectionMaterialReader(
      network: network,
      read: read,
      status: txoStatus,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      funding: nativeReader,
    );
    final stableReader = StablecoinMaterialReader(
      network: network,
      read: read,
      readHistory: reader.parent,
      rememberParent: reader.rememberParent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final lopReader = LopMaterialReader(
      network: network,
      read: read,
      status: txoStatus,
      history: reader,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
    );
    final htlcTokenReader = HtlcTokenMaterialReader(
      network: network,
      read: read,
      status: txoStatus,
      funding: nativeReader,
      tokens: reader,
      stablecoins: stableReader,
    );
    final reviewedReader = ReviewedTransactionReviewer(
      chainId: network.chainId,
      read: read,
      status: txoStatus,
      readHistory: reader.parent,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input)))
                as Map,
          ),
      now: () => DateTime.now().toUtc(),
    );
    inbox.listen((dynamic event) {
      if (event is! Map) return;
      switch (event['type']) {
        case 'shutdown':
          api?.close();
          for (final job in jobs.values) {
            job.cancel();
          }
          events.send({'type': 'stopped'});
          inbox.close();
        case 'reply':
          rpc.reply(event);
        case 'cancel':
          jobs[event['id']]?.cancel();
        case 'balance':
          final job = _WorkerJob(event['id'] as String, rpc, workflow: false);
          jobs[job.id] = job;
          unawaited(
            runZoned(() async {
              try {
                final scope = event['scope'] as TbcSigningRequestScope;
                need(
                  scope.method == balanceReadMethod &&
                      scope.account.network.chainId == network.chainId,
                  'BALANCE_SCOPE',
                );
                final value = await readTbcBalance(
                  network: network,
                  address: scope.account.address,
                  read: read,
                );
                job.check();
                events.send({
                  'type': 'result',
                  'id': job.id,
                  'ok': true,
                  'value': value,
                });
              } catch (_) {
                events.send({'type': 'result', 'id': job.id, 'ok': false});
              } finally {
                jobs.remove(job.id);
                job.cancel();
              }
            }, zoneValues: {_readOwner: job}),
          );
        case 'maintenance':
          final job = _WorkerJob(event['id'] as String, rpc, workflow: false);
          jobs[job.id] = job;
          unawaited(
            runZoned(() async {
              MergeMaterialSession? material;
              try {
                final scope = event['scope'] as TbcSigningRequestScope;
                need(
                  scope.method == 'tbc_sendTransaction' &&
                      scope.account.network == network.network,
                  'MAINTENANCE_SCOPE',
                );
                final authority = <String, dynamic>{
                  'chainId': network.chainId,
                  'accountId': scope.account.accountId,
                  'origin': scope.navigation.origin,
                  'sessionId': scope.navigation.sessionId,
                };
                final asset = copied(event['asset'] as Map);
                material = MergeMaterialSession(
                  history: reader,
                  account: scope.account.toKitAccount(),
                  authority: authority,
                  asset: asset,
                  requireCurrent: () async {
                    await job.call('maintenanceCurrent', null);
                  },
                  clock: DateTime.now,
                );
                final adapter = _WorkerMergeAdapter(
                  job,
                  scope,
                  material,
                  engine,
                  network,
                  event['timing'] == true,
                  event['includeProgress'] == true,
                );
                final result = await MultiRoundMerge(adapter).run(
                  authority: authority,
                  asset: asset,
                  limits: copied(event['limits'] as Map),
                  isCancelled: () => !job.active,
                  onProgress: adapter.recordProgress,
                );
                job.check();
                events.send({
                  'type': 'result',
                  'id': job.id,
                  'ok': true,
                  'value': result,
                });
              } catch (error) {
                events.send({
                  'type': 'result',
                  'id': job.id,
                  'ok': false,
                  if (error is TbcSigningRejected) 'rejected': true,
                });
              } finally {
                material?.close();
                jobs.remove(job.id);
                job.cancel();
              }
            }, zoneValues: {_readOwner: job}),
          );
        case 'execute':
          final job = _WorkerJob(
            event['id'] as String,
            rpc,
            cachePreparation: true,
            workflow: workflowMethods.contains(
              (event['scope'] as TbcSigningRequestScope).method,
            ),
          );
          jobs[job.id] = job;
          unawaited(
            runZoned(() async {
              try {
                final scope = event['scope'] as TbcSigningRequestScope;
                final basePolicy =
                    event['policy'] == null
                        ? null
                        : copied(event['policy'] as Map);
                final childPolicies = event['policiesByRequestHash'] as Map?;
                final custody = _WorkerCustody(
                  job,
                  broadcast:
                      event['nativeBroadcastCommands'] == true
                          ? NativeBroadcastBinding(
                            network: network,
                            scope: scope,
                            invoke:
                                (command, fields) => job.call(
                                  'broadcastCommand',
                                  {'command': command, 'fields': fields},
                                ),
                          )
                          : null,
                );
                final authority = TbcOperationAuthority(
                  context: {
                    'sessionId': scope.navigation.sessionId,
                    'navigationId': scope.navigation.navigationId,
                    'origin': scope.navigation.origin,
                    'topOrigin': scope.navigation.origin,
                    'transport': 'webview',
                    'frame': 'top',
                    'createdAt': scope.navigation.createdAt,
                  },
                  account: scope.account,
                  requireAuthorized: (method) {
                    job.check();
                    need(
                      (event['methods'] as List).contains(method),
                      'WORKER_METHOD',
                    );
                  },
                  isUnlocked: () => custody.unlocked,
                  clock: DateTime.now,
                );
                Future<Map<String, dynamic>> prepare(
                  Map<String, dynamic> request,
                  Map<String, dynamic> account, [
                  List<Map<String, dynamic>> signingAccounts = const [],
                ]) async {
                  job.check();
                  final policy =
                      childPolicies == null
                          ? basePolicy
                          : copied(childPolicies[hashJson(request)] as Map);
                  need(
                    policy == null ||
                        (policy['payload']?['chainId'] == network.chainId &&
                            hashJson(policy['payload']) ==
                                policy['policyHash']),
                    'WORKER_POLICY',
                  );
                  if (unifiedPoolProfiles.contains(request['intent']['type'])) {
                    final floor =
                        policy?['payload']['minConfirmations'] as String? ??
                        '0';
                    final prepared = await unifiedPoolReader.resolve(
                      request: request,
                      account: account,
                      now: authority.now,
                      snapshotId: scope.operationId,
                      minConfirmations: floor,
                      signingAccounts: signingAccounts,
                    );
                    job.check();
                    final derived = prepared.policy(
                      request: request,
                      network: network,
                      minConfirmations: floor,
                    );
                    // An explicit wallet fee policy cannot replace immutable
                    // historical Pool rules recovered by the shared reader.
                    need(
                      policy == null ||
                          canonical(policy['payload']['pool']) ==
                              canonical(derived['payload']['pool']),
                      'POOL_POLICY_OVERRIDE',
                    );
                    return {
                      'snapshot': prepared.snapshot,
                      'policy': policy ?? derived,
                    };
                  }
                  if (pool2Profiles.containsKey(request['intent']['type'])) {
                    final floor =
                        policy?['payload']['minConfirmations'] as String? ??
                        '0';
                    final prepared = await pool2Reader.resolve(
                      request: request,
                      account: account,
                      now: authority.now,
                      snapshotId: scope.operationId,
                      minConfirmations: floor,
                    );
                    job.check();
                    final derivedPolicy = prepared.policy(
                      request: request,
                      network: network,
                      now: authority.now,
                      minConfirmations: floor,
                    );
                    // A wallet may supply fee/confirmation limits, but not
                    // replace the authenticated immutable Pool fee rules.
                    need(
                      policy == null ||
                          canonical(policy['payload']['pool']) ==
                              canonical(derivedPolicy['payload']['pool']),
                      'POOL2_POLICY_OVERRIDE',
                    );
                    return {
                      'snapshot': prepared.snapshot,
                      'policy': policy ?? derivedPolicy,
                    };
                  }
                  if (request['signingRoles'] != null) {
                    need(
                      ammBusinessProfiles.contains(request['intent']['type']),
                      'ROLE_PROFILE',
                    );
                    final snapshot = await ammBusinessReader.resolve(
                      request: request,
                      account: account,
                      signingAccounts: signingAccounts,
                      now: authority.now,
                      snapshotId: scope.operationId,
                      minConfirmations:
                          policy?['payload']['minConfirmations'] as String? ??
                          '0',
                    );
                    job.check();
                    return {
                      'snapshot': snapshot,
                      'policy':
                          policy ??
                          defaultTransactionPolicy(
                            network: network,
                            request: request,
                            now: authority.now,
                            snapshot: snapshot,
                          ),
                    };
                  }
                  final resolve =
                      lopProfiles.contains(request['intent']['type'])
                          ? lopReader.resolve
                          : htlcProfiles.contains(request['intent']['type'])
                          ? (request['intent']['assetStandard'] != null
                              ? htlcTokenReader.resolve
                              : htlcReader.resolve)
                          : timelockProfiles.contains(request['intent']['type'])
                          ? timelockReader.resolve
                          : request['intent']['type'] == 'tbc-amm-create'
                          ? ammReader.resolve
                          : ammBusinessProfiles.contains(
                            request['intent']['type'],
                          )
                          ? ammBusinessReader.resolve
                          : lpProfiles.contains(request['intent']['type'])
                          ? lpReader.resolve
                          : [
                            'tbc721-standard-mint',
                            'tbc721-standard-batch-mint',
                          ].contains(request['intent']['type'])
                          ? collectionReader.resolve
                          : request['intent']['type'] == 'tbc721.transfer'
                          ? nftReader.resolve
                          : [
                            'tbc20Stablecoin.transfer',
                            'tbc20Stablecoin.merge',
                          ].contains(request['intent']['type'])
                          ? stableReader.resolve
                          : [
                            'tbc20.transfer',
                            'tbc20.merge',
                          ].contains(request['intent']['type'])
                          ? reader.resolve
                          : nativeReader.resolve;
                  final snapshot = await resolve(
                    request:
                        htlcProfiles.contains(request['intent']['type'])
                            ? htlcMaterialRequest(request)
                            : request,
                    account: account,
                    now: authority.now,
                    snapshotId: scope.operationId,
                    minConfirmations:
                        policy?['payload']['minConfirmations'] as String? ??
                        '0',
                  );
                  job.check();
                  return {
                    'snapshot': snapshot,
                    'policy':
                        policy ??
                        defaultTransactionPolicy(
                          network: network,
                          request: request,
                          now: authority.now,
                          snapshot: snapshot,
                        ),
                  };
                }

                final executor = TbcSigningExecutor(
                  messageProfile:
                      initial['messageProfile'] as MessageSigningProfile,
                  authority: authority,
                  engine: engine,
                  signer: custody,
                  prepareMaterial:
                      (request, account) => prepare(request, account),
                  prepareRoleMaterial: prepare,
                  prepareReviewed:
                      (request, account, current) => reviewedReader.review(
                        request: request,
                        account: account,
                        requireCurrent: current,
                      ),
                  timing:
                      event['timing'] == true
                          ? (stage, us) => events.send({
                            'type': 'timing',
                            'id': job.id,
                            'stage': stage,
                            'us': us,
                          })
                          : null,
                );
                Map request = event['request'] as Map;
                if (event['legacyCall'] case final LegacySigningCall call) {
                  need(
                    initial['messageProfile'] ==
                            MessageSigningProfile.legacyBitcoin &&
                        call.standardMethod == scope.method &&
                        call.account.chainId == scope.account.network.chainId &&
                        call.account.address == scope.account.address,
                    'LEGACY_WORKER_SCOPE',
                  );
                  if (call.needsMetadata) await custody.requireCurrent();
                  request = await call.prepare(
                    LegacyBusinessResolver(
                      account: call.account,
                      network: network,
                      metadata: metadata,
                      requireCurrent: () {
                        job.check();
                        authority.check(scope.method);
                      },
                    ),
                    job.check,
                  );
                  // The shared executor's first step rechecks native authority
                  // before preparation/consent. Do not duplicate that channel
                  // round-trip here or add checks to purely local translation.
                  job.check();
                }
                final result = await executor.execute(scope.method, request);
                job.check();
                events.send({
                  'type': 'result',
                  'id': job.id,
                  'ok': true,
                  'value': result,
                });
              } catch (error) {
                events.send({
                  'type': 'result',
                  'id': job.id,
                  'ok': false,
                  if (error is TbcSigningRejected) 'rejected': true,
                  if (error is TbcInvalidTypedData) 'invalidTypedData': true,
                  if (error is TbcInvalidCryptoRequest) 'invalidCrypto': true,
                  if (error is TbcPreparedRefused)
                    'preparedRefusal': error.reason.name,
                });
              } finally {
                jobs.remove(job.id);
                job.cancel();
              }
            }, zoneValues: {_readOwner: job}),
          );
      }
    });
    events.send({'type': 'ready', 'commands': inbox.sendPort});
  } catch (_) {
    events.send({'type': 'startupError'});
    inbox.close();
  }
}

final class _WorkerRpc {
  _WorkerRpc(this.events);
  final SendPort events;
  final Map<int, (String, Completer<dynamic>)> pending = {};
  int sequence = 0;
  Future<dynamic> call(String job, String method, Object? args) {
    final id = ++sequence, result = Completer<dynamic>();
    pending[id] = (job, result);
    events.send({
      'type': 'rpc',
      'id': job,
      'rpc': id,
      'method': method,
      'args': args,
    });
    return result.future;
  }

  void reply(Map event) {
    final p = pending.remove(event['rpc']);
    if (p == null) return;
    if (event['ok'] == true) {
      p.$2.complete(event['value']);
    } else {
      p.$2.completeError(
        event['rejected'] == true
            ? const TbcSigningRejected()
            : event['workflowStepUnavailable'] == true
            ? const TbcWorkflowStepUnavailable()
            : event['workflowCryptoUnavailable'] == true
            ? const TbcWorkflowStepUnavailable.crypto()
            : {
              'NODE_REQUEST_FAILED',
              'NODE_RESPONSE_INVALID',
            }.contains(event['broadcastFailure'])
            ? BroadcastNodeFailure(event['broadcastFailure'] as String)
            : StateError('Wallet callback rejected'),
      );
    }
  }

  void cancel(String job) {
    for (final entry
        in pending.entries.where((e) => e.value.$1 == job).toList()) {
      pending.remove(entry.key);
      entry.value.$2.completeError(StateError('Worker operation cancelled'));
    }
  }
}

final class _WorkerJob {
  _WorkerJob(
    this.id,
    this.rpc, {
    required this.workflow,
    this.cachePreparation = false,
  });
  final String id;
  final _WorkerRpc rpc;
  final bool workflow;
  final bool cachePreparation;
  // One planning window only. Independent steps share in-flight and completed
  // read-only replies; another request always gets fresh mutable chain data.
  // Existing reader-owned immutable history caches remain unchanged.
  final Map<String, Future<Map<String, dynamic>>> _reads = {};
  bool _preparing = true;
  bool active = true;
  void check() {
    need(active, 'WORKER_OPERATION_CANCELLED');
  }

  Future<dynamic> call(String method, Object? args) async {
    check();
    final result = await rpc.call(id, method, args);
    check();
    return result;
  }

  Future<Map<String, dynamic>> preparationRead(
    String key,
    Future<Map<String, dynamic>> Function() load,
  ) async {
    check();
    // Maintenance jobs contain multiple independent rounds. Their own scoped
    // reader refreshes after each submission; never memoize across those rounds.
    if (!cachePreparation) return load();
    if (!_preparing) {
      need(!workflow, 'WORKFLOW_READ_AFTER_BINDING');
      return load();
    }
    final result =
        await (_reads[key] ??= Future.sync(
          load,
        ).then((v) => frozen(copyChainReadReply(v)) as Map<String, dynamic>));
    check();
    return copyChainReadReply(result);
  }

  void bindingStarted() {
    check();
    _preparing = false;
    _reads.clear();
  }

  void cancel() {
    active = false;
    _reads.clear();
    rpc.cancel(id);
  }
}

final class _WorkerCustody
    implements
        TbcWorkflowSigningOperation,
        TbcTransactionSigningRoles,
        TbcCryptoSigningOperation,
        TbcBroadcastSigningOperation {
  _WorkerCustody(this.job, {this.broadcast});
  final _WorkerJob job;
  final NativeBroadcastBinding? broadcast;
  bool unlocked = false;
  @override
  Future<void> requireCurrent() async {
    final value = await job.call('current', null) as Map;
    need(value['unlocked'] is bool, 'UNLOCK_STATE');
    unlocked = value['unlocked'] as bool;
  }

  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent intent,
  ) async {
    final value = await job.call('roles', {
      'request': intent.request,
      'context': intent.context,
    });
    need(
      value is List &&
          value.length <= (workflowMethods.contains(intent.method) ? 5 : 1),
      'ROLE_NATIVE_REPLY',
    );
    return List.unmodifiable(
      (value as List).map((raw) {
        need(
          raw is Map &&
              raw.length == 4 &&
              raw['chainId'] == intent.request['chainId'],
          'ROLE_NATIVE_REPLY',
        );
        final account = TbcAccount(
          network: TbcNetwork.values.singleWhere(
            (n) => n.chainId == raw['chainId'],
          ),
          address: raw['address'],
          publicKey: raw['publicKey'],
        );
        need(
          canonical(account.toKitAccount()) == canonical(raw),
          'ROLE_NATIVE_REPLY',
        );
        return account;
      }),
    );
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async =>
      await job.call('consent', {
        'request': intent.request,
        'context': intent.context,
        if (intent.review != null) 'review': intent.review,
      }) ==
      true;
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) async {
    job.bindingStarted();
    return TbcSigningReceipt(
      await job.call('bind', {
            'binding': material.binding,
            'preview': material.preview,
            'plan': material.plan,
            'envelope': material.envelope,
            if (material.reviewed != null) 'reviewed': material.reviewed,
          })
          as Map,
    );
  }

  @override
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    await job.call('advance', {
      'receipt': receipt.wire,
      'pending': continuation.wire,
    });
  }

  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation step,
  ) async {
    await job.call('workflowEnter', {
      'receipt': receipt.wire,
      'step': step.wire,
    });
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation step,
  ) async {
    await job.call('workflowFinish', {
      'receipt': receipt.wire,
      'step': step.wire,
    });
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt receipt,
    TbcSigningTask task,
  ) async {
    final value =
        await job.call('sign', {'receipt': receipt.wire, 'task': task.wire})
            as Map;
    return TbcTaskSignature(
      taskId: value['taskId'],
      signatureEncoding: value['signatureEncoding'],
      signature: value['signature'],
    );
  }

  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  ) async => TbcCryptoResult(
    await job.call('crypto', {'receipt': receipt.wire, 'task': task.wire})
        as Map,
  );

  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastMaterial material,
  ) async {
    if (broadcast != null) return broadcast!.authorize(receipt, material);
    await job.call('broadcastAuthorize', {
      'receipt': receipt.wire,
      'bundle': material.bundle,
      'workflow': material.workflow,
    });
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt receipt,
    int index,
  ) async =>
      broadcast != null
          ? broadcast!.submit(receipt, index)
          : TbcBroadcastResult(
            await job.call('broadcastSubmit', {
                  'receipt': receipt.wire,
                  'index': index,
                })
                as Map,
          );

  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt receipt) async =>
      broadcast != null
          ? broadcast!.submit(receipt, null)
          : TbcBroadcastResult(
            await job.call('broadcastBatch', {'receipt': receipt.wire}) as Map,
          );

  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt receipt,
    List<String> txids,
  ) async =>
      broadcast != null
          ? broadcast!.reconcile(receipt, txids)
          : TbcBroadcastResult(
            await job.call('broadcastReconcile', {
                  'receipt': receipt.wire,
                  'txids': txids,
                })
                as Map,
          );

  @override
  Future<void> close() async {
    broadcast?.close();
    // Close remains permitted after cancellation; the parent also closes late
    // native operations independently if this RPC cannot be delivered.
    await job.rpc.call(job.id, 'close', null);
  }

  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastResult result,
  ) async {
    if (broadcast != null) return broadcast!.finish(receipt, result);
    await job.call('broadcastFinish', {
      'receipt': receipt.wire,
      'result': result.wire,
    });
  }
}

/// Composition only: the existing coordinator selects rounds; the existing
/// executor builds, validates, signs and submits each native-owned child.
final class _WorkerMergeAdapter extends MultiRoundMergeAdapter {
  _WorkerMergeAdapter(
    this.job,
    this.scope,
    this.material,
    this.engine,
    this.network,
    this.timing,
    this.includeProgress,
  );
  final _WorkerJob job;
  final TbcSigningRequestScope scope;
  final MergeMaterialSession material;
  final ComputeProbe engine;
  final TbcNetworkConfiguration network;
  final bool timing;
  final bool includeProgress;
  final _progress = <MergeRecord>[];
  void recordProgress(MergeRecord value) {
    if (includeProgress) _progress.add(value);
  }

  MergeRecord? _state;

  @override
  Future<MergeRecord> finishResult(
    MergeRecord consent,
    MergeRecord result,
  ) async {
    if (result.containsKey('approvalId')) {
      await job.call('maintenanceFinish', result);
    } else {
      need(result['reason'] == 'already-below-target', 'MAINTENANCE_NOOP');
      await job.call('maintenanceNoop', {'scope': consent, 'result': result});
    }
    job.check();
    return includeProgress
        ? {
          ...result,
          'atomic': false,
          'progress': List<MergeRecord>.unmodifiable(_progress),
        }
        : result;
  }

  @override
  Future<MergeRecord> readState(
    MergeRecord authority,
    MergeRecord asset,
  ) async {
    need(
      canonical(authority) == canonical(material.authority) &&
          canonical(asset) == canonical(material.asset),
      'MAINTENANCE_STATE_SCOPE',
    );
    return _state = await material.readState();
  }

  @override
  Future<MergeRecord> approve(MergeRecord request) async {
    // Required tip/funding only, reused by this same round after approval.
    material.prefetch(_state!);
    return copied(
      await job.call('maintenanceApprove', request['scope']) as Map,
    );
  }

  @override
  Future<MergeRecord> prepareStep(MergeRecord input) async =>
      material.prepareStep(input);

  @override
  Future<void> assertAuthority(MergeRecord input) async {
    await job.call('maintenanceCurrent', null);
  }

  @override
  Future<MergeRecord> executePreparedStep(MergeRecord input) async {
    final metadata = input['step'] as Map;
    final step = metadata['prepared'] as MergeMaterialStep;
    _MaintenanceCustody? custody;
    try {
      final opened =
          await job.call('maintenanceStep', {
                'step': {...metadata}..remove('prepared'),
                'request': step.request,
                'selectedInputs': step.selectedInputs,
              })
              as Map;
      final child = opened['scope'] as TbcSigningRequestScope;
      need(
        child.method == scope.method &&
            child.revision == scope.revision &&
            canonical(child.account.toKitAccount()) ==
                canonical(scope.account.toKitAccount()) &&
            child.navigation.matches(scope.navigation.toWire()),
        'MAINTENANCE_CHILD_SCOPE',
      );
      final delegate = _WorkerCustody(
        job,
        broadcast:
            opened['nativeBroadcastCommands'] == true
                ? NativeBroadcastBinding(
                  network: network,
                  scope: child,
                  invoke:
                      (command, fields) => job.call('broadcastCommand', {
                        'command': command,
                        'fields': fields,
                      }),
                )
                : null,
      );
      custody = _MaintenanceCustody(delegate);
      final authority = TbcOperationAuthority(
        context: {
          'sessionId': child.navigation.sessionId,
          'navigationId': child.navigation.navigationId,
          'origin': child.navigation.origin,
          'topOrigin': child.navigation.origin,
          'transport': 'webview',
          'frame': 'top',
          'createdAt': child.navigation.createdAt,
        },
        account: child.account,
        requireAuthorized: (method) {
          job.check();
          need(method == 'tbc_sendTransaction', 'MAINTENANCE_CHILD_METHOD');
        },
        isUnlocked: () => delegate.unlocked,
        clock: DateTime.now,
      );
      final result = await TbcSigningExecutor(
        authority: authority,
        engine: engine,
        signer: custody,
        prepareMaterial:
            (request, account) => step.resolve(
              request: request,
              account: account,
              now: authority.now,
              snapshotId: child.operationId,
            ),
        validateTransactionPlan: step.validatePlan,
        timing:
            !timing
                ? null
                : (stage, us) => job.rpc.events.send({
                  'type': 'timing',
                  'id': job.id,
                  'stage': stage,
                  'us': us,
                }),
      ).execute('tbc_sendTransaction', step.request);
      final rows = result['transactions'] as List;
      need(
        custody.finished &&
            rows.length == 1 &&
            rows.single['status'] == 'submitted',
        'MAINTENANCE_NATIVE_FINISH',
      );
      final txid = rows.single['txid'] as String;
      // Only native finish (journal accepted/known) permits the next index.
      material.accepted(txid);
      return {
        'stepId': metadata['stepId'],
        'materialHash': metadata['materialHash'],
        'status': custody.known ? 'known' : 'accepted',
        'txid': txid,
        'fee': result['totalFee'],
        'inputsConsumed': metadata['inputCount'],
        'outputsCreated': 1,
      };
    } catch (error) {
      if (custody?.attempted == true) {
        // single-send already performs its one bounded read-only reconcile.
        // Never run a second reconciliation loop or replay a POST here.
        final id = custody!.recoveryId;
        if (id != null) throw MultiRoundMergeExecutionUnknown(id);
        throw StateError('MAINTENANCE_SUBMISSION_UNKNOWN');
      }
      return {
        'stepId': metadata['stepId'],
        'materialHash': metadata['materialHash'],
        'status': error is TbcSigningRejected ? 'rejected' : 'failed',
        'error': 'MAINTENANCE_STEP_NOT_SUBMITTED',
      };
    }
  }

  @override
  Future<MergeRecord> reconcile(MergeRecord input) async => {
    'txid': input['txid'],
    'status': 'unknown',
  };
}

/// Records only submission phase, not a second journal. It distinguishes a
/// proven pre-submit failure from an unknown result after dispatch may start.
final class _MaintenanceCustody implements TbcBroadcastSigningOperation {
  _MaintenanceCustody(this.delegate);
  final _WorkerCustody delegate;
  bool attempted = false, finished = false, known = false;
  String? recoveryId;
  @override
  Future<void> requireCurrent() => delegate.requireCurrent();
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) =>
      delegate.requestConsent(intent);
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) =>
      delegate.bind(material);
  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) =>
      delegate.advance(r, c);
  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) =>
      delegate.sign(r, t);
  @override
  Future<void> close() => delegate.close();
  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastMaterial m,
  ) => delegate.authorizeBroadcast(r, m);
  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int index,
  ) async {
    need(index == 0 && !attempted, 'MAINTENANCE_SINGLE_SUBMIT');
    attempted = true;
    try {
      final result = await delegate.submitTransaction(r, index);
      known = result.wire['status'] == 'known';
      return result;
    } finally {
      recoveryId = await delegate.broadcast?.recoveryId(index);
    }
  }

  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt r) async =>
      throw StateError('MAINTENANCE_SINGLE_SUBMIT');
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> ids,
  ) async {
    final result = await delegate.reconcileSubmitted(r, ids);
    known = true;
    return result;
  }

  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastResult result,
  ) async {
    await delegate.finishBroadcast(r, result);
    finished = true;
  }
}
