// Shared bounded maintenance coordinator, ported from the frozen Kit. Not a
// builder, key holder, Legacy loop or Provider endpoint. The production adapter
// must use the existing material/Engine/native approval/signer/broadcast path.
import 'protocol_codec.dart';

typedef MergeRecord = Map<String, dynamic>;

abstract class MultiRoundMergeAdapter {
  // Permission/account/source gated before the first index read. Read-only
  // index progress is not spend authorization; each step still validates raw
  // material and binds the formal native receipt before signing.
  Future<MergeRecord> readState(MergeRecord authority, MergeRecord asset);
  Future<MergeRecord> approve(MergeRecord request);
  Future<MergeRecord> prepareStep(MergeRecord input);
  Future<void> assertAuthority(MergeRecord input);
  Future<MergeRecord> executePreparedStep(MergeRecord input);
  Future<MergeRecord> reconcile(MergeRecord input);
  // Production composition attests native outcomes here, including the no-op
  // path. The pure coordinator/oracle adapters need no platform implementation.
  Future<MergeRecord> finishResult(
    MergeRecord scope,
    MergeRecord result,
  ) async => result;
  Future<void> waitForIndex(MergeRecord input) =>
      Future<void>.delayed(Duration(milliseconds: input['delayMs'] as int));
}

/// Only wallet-owned adapters may supply this durable reference. No raw native
/// exception text or private transaction/HTLC material enters the result.
final class MultiRoundMergeExecutionUnknown implements Exception {
  MultiRoundMergeExecutionUnknown(this.recoveryId);
  final String recoveryId;
}

MergeRecord _immutable(Map value) => frozen(copied(value)) as MergeRecord;
bool _hash(Object? v) => v is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(v);
bool _same(Object? a, Object? b) => canonical(a) == canonical(b);
int _integer(Object? v, int lo, int hi) {
  need(v is int && v >= lo && v <= hi, 'MERGE_INTEGER');
  return v as int;
}

BigInt _atomic(Object? v) {
  need(v is String && RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(v), 'MERGE_ATOMIC');
  return BigInt.parse(v as String);
}

int _time(Object? v) {
  need(v is String, 'MERGE_TIME');
  return protocolTime(v as String).millisecondsSinceEpoch;
}

void _authority(Map v) {
  need(
    v['chainId'] is String &&
        RegExp(r'^tbc:[a-z0-9_-]{1,32}$').hasMatch(v['chainId']) &&
        v['accountId'] is String &&
        RegExp(
          r'^tbc:[a-z0-9_-]{1,32}:[1-9A-HJ-NP-Za-km-z]{20,64}$',
        ).hasMatch(v['accountId']) &&
        (v['accountId'] as String).startsWith('${v['chainId']}:') &&
        v['origin'] is String &&
        RegExp(r'^[a-z][a-z0-9+.-]*://[^/?#]+$').hasMatch(v['origin']) &&
        v['sessionId'] is String &&
        (v['sessionId'] as String).isNotEmpty &&
        (v['sessionId'] as String).length <= 256,
    'MERGE_AUTHORITY',
  );
}

void _asset(Map v) {
  final kind = v['kind'];
  need(
    (kind == 'tbc' && v.length == 1) ||
        (['ft', 'stablecoin'].contains(kind) &&
            v.length == 2 &&
            _hash(v['contractId'])) ||
        (['pool-ft', 'ftlp'].contains(kind) &&
            v.length == 2 &&
            _hash(v['poolContractId'])),
    'MERGE_ASSET',
  );
}

/// Call before permission prompts or private index I/O. Millisecond UTC and
/// integer-second UTC use the shared protocol-time parser, never local time.
MergeRecord normalizeMultiRoundMergeLimits(Map asset, Map limits, int nowMs) {
  _asset(asset);
  need(
    limits.keys.every(
      const {
        'targetUtxoCount',
        'maxTransactions',
        'maxTotalFee',
        'expiresAt',
        'maxIndexRefreshes',
        'indexRefreshDelayMs',
      }.contains,
    ),
    'MERGE_LIMIT_FIELDS',
  );
  final result = <String, dynamic>{
    'targetUtxoCount': _integer(limits['targetUtxoCount'], 1, 1000000),
    'maxTransactions': _integer(limits['maxTransactions'], 1, 64),
    'maxTotalFee': _atomic(limits['maxTotalFee']).toString(),
    'expiresAt': limits['expiresAt'],
    'maxIndexRefreshes': _integer(limits['maxIndexRefreshes'] ?? 6, 0, 32),
    'indexRefreshDelayMs': _integer(
      limits['indexRefreshDelayMs'] ?? 1000,
      0,
      60000,
    ),
  };
  need(_time(result['expiresAt']) > nowMs, 'MERGE_EXPIRED');
  return _immutable(result);
}

String hashMultiRoundMergeState(Map state) => hashJson({
  'version': state['version'],
  'authority': state['authority'],
  'asset': state['asset'],
  'revision': state['revision'],
  'utxoCount': state['utxoCount'],
  if (state.containsKey('poolIdentity')) 'poolIdentity': state['poolIdentity'],
  'observedTransactionIds': state['observedTransactionIds'],
});

MergeRecord _impact(Map asset, Object? poolValue) {
  final kind = asset['kind'];
  if (['tbc', 'ft', 'stablecoin'].contains(kind))
    return {
      'custody': 'active-account',
      'resultOwner': 'active-account',
      'maxAssetInputsPerTransaction': kind == 'tbc' ? 100 : 5,
    };
  need(poolValue is Map, 'MERGE_POOL_IDENTITY');
  final pool = poolValue as Map;
  need(
    pool['poolContractId'] == asset['poolContractId'] &&
        _hash(pool['ftContractId']) &&
        _hash(pool['currentPoolTxid']),
    'MERGE_POOL_IDENTITY',
  );
  return {
    'custody': kind == 'pool-ft' ? 'pool-contract' : 'active-account',
    'resultOwner': kind == 'pool-ft' ? 'pool-contract' : 'active-account',
    'maxAssetInputsPerTransaction': kind == 'pool-ft' ? 4 : 5,
    'poolIdentity': pool,
  };
}

MergeRecord _state(Map value, Map authority, Map asset) {
  final state = _immutable(value), ids = state['observedTransactionIds'];
  need(
    state['version'] == '1.0' &&
        _same(state['authority'], authority) &&
        _same(state['asset'], asset) &&
        _hash(state['stateHash']) &&
        state['stateHash'] == hashMultiRoundMergeState(state) &&
        state['revision'] is String &&
        (state['revision'] as String).isNotEmpty &&
        ids is List &&
        ids.toSet().length == ids.length &&
        ids.every(_hash),
    'MERGE_STATE_BINDING',
  );
  _integer(state['utxoCount'], 0, 9007199254740991);
  _time(state['observedAt']);
  _impact(asset, state['poolIdentity']);
  return state;
}

BigInt _prepared(
  Map step,
  Map scope,
  Map state,
  int index,
  List<String> accepted,
) {
  final fee = _atomic(step['fee']), dependencies = step['dependsOn'];
  need(
    step['version'] == '1.0' &&
        step['stepIndex'] == index &&
        step['stepId'] == 'merge-$index' &&
        _same(step['authority'], scope['authority']) &&
        _same(step['asset'], scope['asset']) &&
        step['stateHash'] == state['stateHash'] &&
        _hash(step['materialHash']) &&
        step['inputCount'] is int &&
        step['inputCount'] >= 2 &&
        step['inputCount'] <= scope['impact']['maxAssetInputsPerTransaction'] &&
        step['inputCount'] <= state['utxoCount'] &&
        step['outputCount'] == 1 &&
        _time(step['expiresAt']) <= _time(scope['limits']['expiresAt']) &&
        dependencies is List &&
        dependencies.toSet().length == dependencies.length &&
        dependencies.every(accepted.contains) &&
        (!step.containsKey('feeKind') ||
            ['exact', 'maximum'].contains(step['feeKind'])),
    'MERGE_PREPARED_BINDING',
  );
  return fee;
}

BigInt? _execution(Map value, Map step) {
  need(
    value['stepId'] == step['stepId'] &&
        value['materialHash'] == step['materialHash'],
    'MERGE_EXECUTION_BINDING',
  );
  if (value.containsKey('error')) {
    need(
      ['pending', 'failed', 'rejected'].contains(value['status']) &&
          value['error'] is String &&
          (value['error'] as String).isNotEmpty,
      'MERGE_EXECUTION_FAILURE',
    );
    if (value['status'] == 'pending')
      need(
        value['recoveryId'] is String &&
            (value['recoveryId'] as String).isNotEmpty,
        'MERGE_PENDING_IDENTITY',
      );
    return null;
  }
  final fee = _atomic(value['fee']);
  need(
    ['accepted', 'known', 'uncertain'].contains(value['status']) &&
        _hash(value['txid']) &&
        (step['feeKind'] == 'maximum'
            ? fee <= _atomic(step['fee'])
            : value['fee'] == step['fee']) &&
        value['inputsConsumed'] == step['inputCount'] &&
        value['outputsCreated'] == step['outputCount'],
    'MERGE_EXECUTION_RESULT',
  );
  return fee;
}

/// One consent, sequential dependent submissions, bounded read-only index
/// refresh. No transaction is retried here. Mutable state is never cached
/// between runs, and accepted-parent progress cannot be faked by count alone.
final class MultiRoundMerge {
  MultiRoundMerge(this.adapter, {int Function()? nowMs})
    : nowMs = nowMs ?? (() => DateTime.now().toUtc().millisecondsSinceEpoch);
  final MultiRoundMergeAdapter adapter;
  final int Function() nowMs;
  bool _active = false;

  Future<MergeRecord> run({
    required Map authority,
    required Map asset,
    required Map limits,
    bool Function()? isCancelled,
    void Function(MergeRecord progress)? onProgress,
  }) async {
    need(!_active, 'MERGE_ALREADY_ACTIVE');
    _active = true;
    try {
      return await _run(
        _immutable(authority),
        _immutable(asset),
        limits,
        isCancelled ?? () => false,
        onProgress,
      );
    } finally {
      _active = false;
    }
  }

  Future<MergeRecord> _run(
    MergeRecord authority,
    MergeRecord asset,
    Map requestedLimits,
    bool Function() cancelled,
    void Function(MergeRecord)? onProgress,
  ) async {
    _authority(authority);
    final limits = normalizeMultiRoundMergeLimits(
      asset,
      requestedLimits,
      nowMs(),
    );
    final target = limits['targetUtxoCount'] as int,
        maximum = limits['maxTransactions'] as int,
        refreshes = limits['maxIndexRefreshes'] as int,
        maxFee = _atomic(limits['maxTotalFee']),
        expires = _time(limits['expiresAt']);
    var state = _state(
      await adapter.readState(authority, asset),
      authority,
      asset,
    );
    final initial = state['utxoCount'] as int;
    final scope = _immutable({
      'version': '1.0',
      'operationKind': 'multi-round-merge',
      'authority': authority,
      'asset': asset,
      'impact': _impact(asset, state['poolIdentity']),
      'limits': limits,
      'initialStateHash': state['stateHash'],
      'initialUtxoCount': initial,
    });
    final scopeHash = hashJson(scope),
        steps = <MergeRecord>[],
        accepted = <String>[];
    var total = BigInt.zero;
    String? approvalId;
    String partial() =>
        steps.any((s) => ['accepted', 'known'].contains(s['status']))
            ? 'partial'
            : 'stopped';
    Future<MergeRecord> finish(String status, String reason) =>
        adapter.finishResult(
          scope,
          _immutable({
            'version': '1.0',
            'status': status,
            'reason': reason,
            'scopeHash': scopeHash,
            if (approvalId != null) 'approvalId': approvalId,
            'initialUtxoCount': initial,
            'finalUtxoCount': state['utxoCount'],
            'totalFee': total.toString(),
            'steps': steps,
          }),
        );
    void progress(String phase, int index) {
      try {
        onProgress?.call(
          _immutable({
            'phase': phase,
            'stepIndex': index,
            'utxoCount': state['utxoCount'],
            'targetUtxoCount': target,
            'transactionCount': steps.length,
            'totalFee': total.toString(),
          }),
        );
      } catch (_) {
        /* observers cannot affect execution */
      }
    }

    MergeRecord row(
      Map step,
      String status,
      String fee, {
      String? txid,
      String? recoveryId,
    }) => {
      'stepId': step['stepId'],
      if (txid != null) 'txid': txid,
      if (recoveryId != null) 'recoveryId': recoveryId,
      'status': status,
      'fee': fee,
      'inputCount': step['inputCount'],
      'outputCount': 1,
      'dependsOn': step['dependsOn'],
    };
    if (initial <= target) {
      progress('complete', 0);
      return finish('complete', 'already-below-target');
    }
    progress('approval', 0);
    final approval = _immutable(
      await adapter.approve(
        _immutable({'scope': scope, 'scopeHash': scopeHash}),
      ),
    );
    need(approval['scopeHash'] == scopeHash, 'MERGE_APPROVAL_SCOPE');
    if (approval['status'] == 'rejected')
      return finish('stopped', 'approval-rejected');
    final approvalExpiry = _time(approval['expiresAt']);
    need(
      approval['status'] == 'approved' &&
          approval['approvalId'] is String &&
          (approval['approvalId'] as String).isNotEmpty &&
          _time(approval['approvedAt']) <= nowMs() &&
          approvalExpiry <= expires &&
          approvalExpiry > nowMs(),
      'MERGE_APPROVAL_BINDING',
    );
    approvalId = approval['approvalId'] as String;
    final context = _immutable({
      'scope': scope,
      'scopeHash': scopeHash,
      'approval': approval,
    });
    for (var index = 1; index <= maximum; index++) {
      if (cancelled()) return finish(partial(), 'cancelled');
      if (nowMs() >= expires || nowMs() >= approvalExpiry)
        return finish(partial(), 'expired');
      if (state['utxoCount'] <= target) {
        progress('complete', index);
        return finish('complete', 'target-reached');
      }
      if (state['utxoCount'] > initial)
        return finish(partial(), 'facts-changed');
      progress('preparing', index);
      late final MergeRecord step;
      try {
        final prepared = await adapter.prepareStep(
          _immutable({
            ...context,
            'state': state,
            'stepIndex': index,
            'remainingFee': (maxFee - total).toString(),
            'acceptedTxids': accepted,
          }),
        );
        // Opaque prepared material is owned and consumed once by the shared
        // adapter; freeze all scope/fee/dependency metadata separately.
        step = Map.unmodifiable({
          ..._immutable({...prepared}..remove('prepared')),
          'prepared': prepared['prepared'],
        });
      } catch (_) {
        return finish(partial(), 'step-failed');
      }
      final stepFee = _prepared(step, scope, state, index, accepted);
      if (total + stepFee > maxFee)
        return finish(partial(), 'fee-budget-exhausted');
      if (cancelled()) return finish(partial(), 'cancelled');
      final expiry = [
        expires,
        approvalExpiry,
        _time(step['expiresAt']),
      ].reduce((a, b) => a < b ? a : b);
      if (nowMs() >= expiry) return finish(partial(), 'expired');
      final executionInput = Map<String, dynamic>.unmodifiable({
        ...context,
        'step': step,
      });
      try {
        await adapter.assertAuthority(executionInput);
      } catch (_) {
        return finish(partial(), 'facts-changed');
      }
      if (cancelled()) return finish(partial(), 'cancelled');
      if (nowMs() >= expiry) return finish(partial(), 'expired');
      progress('executing', index);
      late final MergeRecord execution;
      BigInt? executionFee;
      try {
        execution = _immutable(
          await adapter.executePreparedStep(executionInput),
        );
        executionFee = _execution(execution, step);
      } catch (error) {
        // Once execute starts, cancellation/expiry cannot prove POST=0. Keep
        // exposure even if the callback throws or returns malformed evidence.
        // This intentionally fixes the frozen coordinator's early-cancel hole.
        total += stepFee;
        final recoveryId =
            error is MultiRoundMergeExecutionUnknown &&
                    error.recoveryId.isNotEmpty
                ? error.recoveryId
                : null;
        steps.add(
          row(step, 'uncertain', stepFee.toString(), recoveryId: recoveryId),
        );
        return finish('uncertain', 'broadcast-uncertain');
      }
      if (execution.containsKey('error')) {
        if (execution['status'] == 'pending') {
          steps.add(
            row(
              step,
              'pending',
              '0',
              recoveryId: execution['recoveryId'] as String,
            ),
          );
          return finish('uncertain', 'operation-pending');
        }
        if (cancelled()) return finish(partial(), 'cancelled');
        if (nowMs() >= expiry) return finish(partial(), 'expired');
        steps.add(row(step, execution['status'] as String, '0'));
        return finish(
          partial(),
          execution['status'] == 'rejected' ? 'step-rejected' : 'step-failed',
        );
      }
      final txid = execution['txid'] as String;
      var status = execution['status'] == 'known' ? 'known' : 'accepted';
      if (execution['status'] == 'uncertain') {
        progress('reconciling', index);
        MergeRecord? reconciled;
        try {
          reconciled = _immutable(
            await adapter.reconcile(
              Map.unmodifiable({...executionInput, 'txid': txid}),
            ),
          );
          need(
            reconciled['txid'] == txid &&
                ['known', 'rejected', 'unknown'].contains(reconciled['status']),
            'MERGE_RECONCILE_IDENTITY',
          );
        } catch (_) {
          reconciled = null;
        }
        if (reconciled == null || reconciled['status'] == 'unknown') {
          total += executionFee!;
          steps.add(row(step, 'uncertain', execution['fee'], txid: txid));
          return finish('uncertain', 'broadcast-uncertain');
        }
        if (reconciled['status'] == 'rejected') {
          steps.add(row(step, 'rejected', '0', txid: txid));
          return finish(partial(), 'step-rejected');
        }
        status = 'known';
      }
      total += executionFee!;
      accepted.add(txid);
      steps.add(row(step, status, execution['fee'], txid: txid));
      final previous = state;
      var indexed = false;
      for (var attempt = 0; attempt <= refreshes; attempt++) {
        if (cancelled()) return finish('partial', 'cancelled');
        // Indexing is part of the same bounded run. No polling after expiry.
        if (nowMs() >= expires || nowMs() >= approvalExpiry)
          return finish('partial', 'expired');
        if (attempt > 0) {
          progress('indexing', index);
          await adapter.waitForIndex(
            _immutable({
              'attempt': attempt,
              'delayMs': limits['indexRefreshDelayMs'],
              'txid': txid,
            }),
          );
          if (cancelled()) return finish('partial', 'cancelled');
          if (nowMs() >= expires || nowMs() >= approvalExpiry)
            return finish('partial', 'expired');
        }
        late final MergeRecord next;
        try {
          next = _state(
            await adapter.readState(authority, asset),
            authority,
            asset,
          );
        } catch (_) {
          return finish('partial', 'index-stalled');
        }
        final approvedPool = scope['impact']['poolIdentity'];
        if (approvedPool != null &&
            (next['poolIdentity'] == null ||
                next['poolIdentity']['poolContractId'] !=
                    approvedPool['poolContractId'] ||
                next['poolIdentity']['ftContractId'] !=
                    approvedPool['ftContractId'])) {
          state = next;
          return finish('partial', 'facts-changed');
        }
        if (next['utxoCount'] > initial) {
          state = next;
          return finish('partial', 'facts-changed');
        }
        if (next['utxoCount'] < previous['utxoCount']) {
          need(
            (next['observedTransactionIds'] as List).contains(txid),
            'MERGE_INDEX_PARENT',
          );
          if (previous['utxoCount'] - next['utxoCount'] !=
                  step['inputCount'] - step['outputCount'] ||
              (asset['kind'] == 'pool-ft' &&
                  next['poolIdentity']['currentPoolTxid'] != txid) ||
              (asset['kind'] == 'ftlp' &&
                  next['poolIdentity']['currentPoolTxid'] !=
                      previous['poolIdentity']['currentPoolTxid'])) {
            state = next;
            return finish('partial', 'facts-changed');
          }
          state = next;
          indexed = true;
          break;
        }
        if (next['utxoCount'] != previous['utxoCount'] ||
            next['stateHash'] != previous['stateHash']) {
          state = next;
          return finish('partial', 'facts-changed');
        }
        state = next;
      }
      if (!indexed) return finish('partial', 'index-stalled');
      if (state['utxoCount'] <= target) {
        progress('complete', index);
        return finish('complete', 'target-reached');
      }
    }
    return finish('partial', 'transaction-budget-exhausted');
  }
}
