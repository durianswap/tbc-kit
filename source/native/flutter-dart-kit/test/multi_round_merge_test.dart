// Real frozen scheduler oracle, controlled read/custody/broadcast callbacks.
// This is not an Engine signature, native one-consent or chain proof.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/multi_round_merge.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

const time = '2026-10-14T00:00:00Z', expiry = '2026-10-14T00:05:00Z';
final fixture =
    jsonDecode(
          File('test/fixtures/multi-round-frozen-kit.json').readAsStringSync(),
        )
        as Map;

final class Replay extends MultiRoundMergeAdapter {
  Replay(Map row)
    : config = copied(row['config']),
      authority = copied(row['authority']),
      asset = copied(row['asset']),
      limits = copied(row['limits']) {
    current = state(config['initial'] ?? 205);
  }
  final MergeRecord config, authority, asset, limits;
  final calls = <String>[],
      scopes = <MergeRecord>[],
      prepared = <MergeRecord>[];
  final pool = <String, dynamic>{
    'poolContractId': 'b' * 64,
    'ftContractId': 'a' * 64,
    'currentPoolTxid': 'c' * 64,
  };
  int clock = DateTime.parse(time).millisecondsSinceEpoch, executions = 0;
  bool cancelled = false;
  Completer<void>? holdRead, readEntered;
  late MergeRecord current;
  MergeRecord state(int count, [List<String> ids = const []]) {
    final p = <String, dynamic>{
      'version': '1.0',
      'authority': authority,
      'asset': asset,
      'observedAt': time,
      'revision': 'r-$count-${ids.join('-')}',
      'utxoCount': count,
      'observedTransactionIds': ids,
      if (['pool-ft', 'ftlp'].contains(asset['kind']))
        'poolIdentity': copied(pool),
    };
    return {...p, 'stateHash': hashMultiRoundMergeState(p)};
  }

  void advance(Map step, String txid) {
    if (asset['kind'] == 'pool-ft' || config['moveLpPool'] == true)
      pool['currentPoolTxid'] = txid;
    if (config['changePool'] == true) pool['ftContractId'] = 'd' * 64;
    current = state(
      current['utxoCount'] -
          step['inputCount'] +
          1 -
          (config['wrongReduction'] == true ? 1 : 0),
      config['unrelatedIndex'] == true ? [] : [txid],
    );
  }

  @override
  Future<MergeRecord> readState(MergeRecord a, MergeRecord b) async {
    calls.add('read');
    expect(a, authority);
    expect(b, asset);
    if (readEntered?.isCompleted == false) readEntered!.complete();
    await holdRead?.future;
    if (config['readFail'] == true && executions > 0) throw StateError('index');
    return config['badState'] == true
        ? {...current, 'stateHash': 'f' * 64}
        : current;
  }

  @override
  Future<MergeRecord> approve(MergeRecord input) async {
    calls.add('approve');
    scopes.add(input);
    if (config['reject'] == true)
      return {'status': 'rejected', 'scopeHash': input['scopeHash']};
    return {
      'status': 'approved',
      'scopeHash':
          config['wrongApproval'] == true ? 'f' * 64 : input['scopeHash'],
      'approvalId': 'consent',
      'approvedAt': time,
      'expiresAt': expiry,
    };
  }

  @override
  Future<MergeRecord> prepareStep(MergeRecord input) async {
    final index = input['stepIndex'];
    calls.add('prepare:$index');
    if (index == config['prepareFail']) throw StateError('prepare');
    final max = input['scope']['impact']['maxAssetInputsPerTransaction'] as int,
        remaining = input['state']['utxoCount'] - limits['targetUtxoCount'] + 1;
    final step = <String, dynamic>{
      'version': '1.0',
      'stepId': 'merge-$index',
      'stepIndex': index,
      'authority': authority,
      'asset': asset,
      'stateHash': input['state']['stateHash'],
      'materialHash': hashJson({
        'step': index,
        'state': input['state']['stateHash'],
      }),
      'inputCount': max < remaining ? max : remaining,
      'outputCount': 1,
      'fee': config['fee'] ?? '10',
      if (config['feeKind'] != null) 'feeKind': config['feeKind'],
      'expiresAt':
          config['stepExpired'] == true ? '2026-10-13T23:59:59Z' : expiry,
      'dependsOn':
          config['badDependency'] == true
              ? ['e' * 64]
              : [
                if ((input['acceptedTxids'] as List).isNotEmpty)
                  (input['acceptedTxids'] as List).last,
              ],
      'prepared': {'fixture': true},
    };
    prepared.add(step);
    clock += (config['advancePrepare'] ?? 0) as int;
    return step;
  }

  @override
  Future<void> assertAuthority(MergeRecord input) async {
    calls.add('authority');
    if (config['authorityLost'] == true) throw StateError('authority');
  }

  @override
  Future<MergeRecord> executePreparedStep(MergeRecord input) async {
    final step = input['step'] as Map;
    calls.add('execute:${step['stepIndex']}');
    executions++;
    if (config['cancelExecute'] == true) cancelled = true;
    clock += (config['advanceExecute'] ?? 0) as int;
    if (executions == config['executeThrow'])
      throw MultiRoundMergeExecutionUnknown('native-$executions');
    final status = config['status'] ?? 'accepted',
        txid = hashJson({
          'tx': executions,
          'materialHash': step['materialHash'],
        });
    if (['failed', 'rejected', 'pending'].contains(status))
      return {
        'status': status,
        'stepId': step['stepId'],
        'materialHash': step['materialHash'],
        'error': 'controlled failure',
        if (status == 'pending') 'recoveryId': 'native-$executions',
      };
    if (config['stall'] != true && status != 'uncertain') advance(step, txid);
    return {
      'status': status,
      'stepId': step['stepId'],
      'materialHash': step['materialHash'],
      'txid': txid,
      'fee': config['executionFee'] ?? step['fee'],
      'inputsConsumed': step['inputCount'],
      'outputsCreated': 1,
    };
  }

  @override
  Future<MergeRecord> reconcile(MergeRecord input) async {
    calls.add('reconcile');
    if (config['reconcileThrow'] == true) throw StateError('reconcile');
    final status = config['reconcile'] ?? 'known',
        txid = input['txid'] as String;
    if (status == 'known' && config['stall'] != true)
      advance(input['step'], txid);
    return {'txid': txid, 'status': status};
  }

  @override
  Future<void> waitForIndex(MergeRecord input) async {
    calls.add('wait');
    clock += (config['advanceWait'] ?? 0) as int;
  }

  late final coordinator = MultiRoundMerge(this, nowMs: () => clock);
  Future<MergeRecord> run({void Function(MergeRecord)? onProgress}) =>
      coordinator.run(
        authority: authority,
        asset: asset,
        limits: limits,
        isCancelled: () => cancelled,
        onProgress: onProgress,
      );
}

void main() {
  for (final row in fixture['cases']) {
    if (row['config']['safetyDelta'] != null) continue;
    test('frozen coordinator parity: ${row['config']['name']}', () async {
      final h = Replay(row);
      expect(h.current, row['initialState']);
      if (row['error'] != null)
        await expectLater(h.run(), throwsStateError);
      else
        expect(await h.run(), row['result']);
      expect(h.calls, row['calls']);
      expect(h.scopes, row['scopes']);
      expect(h.prepared, row['prepared']);
      expect(h.calls.where((c) => c == 'approve').length, lessThanOrEqualTo(1));
    });
  }
  for (final name in ['throw-after-cancel', 'throw-after-expiry']) {
    test('retain POST uncertainty despite $name, no re-execution', () async {
      final row = (fixture['cases'] as List).singleWhere(
            (r) => r['config']['name'] == name,
          ),
          h = Replay(row);
      expect(
        row['result']['steps'],
        isEmpty,
      ); // Preserve the frozen diagnostic.
      final result = await h.run();
      expect(result['status'], 'uncertain');
      expect(result['reason'], 'broadcast-uncertain');
      expect(result['totalFee'], '10');
      expect(result['steps'], hasLength(1));
      expect(result['steps'][0]['recoveryId'], 'native-1');
      expect(h.executions, 1);
      expect(h.calls.where((c) => c == 'read'), hasLength(1));
    });
  }
  test(
    'deadline stops read-only index polling after an accepted transaction',
    () async {
      final row = (fixture['cases'] as List).singleWhere(
            (r) => r['config']['name'] == 'expired-index-wait',
          ),
          h = Replay(row);
      final result = await h.run();
      expect(result['status'], 'partial');
      expect(result['reason'], 'expired');
      expect(result['steps'][0]['status'], 'accepted');
      expect(result['totalFee'], '10');
      expect(h.calls.where((c) => c == 'wait'), hasLength(1));
      expect(h.calls.where((c) => c == 'read'), hasLength(2));
      expect(h.executions, 1);
    },
  );
  test(
    'invalid page-visible limits reject before all index/approval callbacks',
    () async {
      for (final patch in [
        {'maxTransactions': 0},
        {'maxTransactions': 65},
        {'maxTransactions': 1.5},
        {'maxTotalFee': '-1'},
        {'maxTotalFee': '01'},
        {'targetUtxoCount': 0},
        {'maxIndexRefreshes': 33},
        {'indexRefreshDelayMs': 60001},
        {'unknown': true},
        {'expiresAt': '2026-10-13T00:00:00Z'},
      ]) {
        final h = Replay(fixture['cases'][0]);
        h.limits.addAll(patch);
        await expectLater(h.run(), throwsStateError);
        expect(h.calls, isEmpty);
      }
    },
  );
  test(
    'overlapping runs reject; initial caller mutation cannot change captured authority',
    () async {
      final h = Replay(fixture['cases'][0]),
          held = Completer<void>(),
          entered = Completer<void>();
      h.holdRead = held;
      h.readEntered = entered;
      final callerAuthority = copied(h.authority);
      final pending = h.coordinator.run(
        authority: callerAuthority,
        asset: h.asset,
        limits: h.limits,
        isCancelled: () => h.cancelled,
      );
      await entered.future;
      await expectLater(h.run(), throwsStateError);
      callerAuthority['origin'] = 'https://forged.example';
      held.complete();
      expect((await pending)['status'], 'complete');
      expect(h.executions, 3);
      expect(
        h.scopes.single['scope']['authority']['origin'],
        'https://merge.example',
      );
    },
  );
  test(
    'progress exceptions and attempted mutation do not alter approvals or results',
    () async {
      final row = fixture['cases'][0], h = Replay(row);
      var callbacks = 0;
      final result = await h.run(
        onProgress: (p) {
          callbacks++;
          p['totalFee'] = '0';
        },
      );
      expect(callbacks, greaterThan(0));
      expect(result, row['result']);
      expect(
        () => h.scopes[0]['scope']['limits']['maxTotalFee'] = '99999',
        throwsUnsupportedError,
      );
    },
  );
  test('observation time is not index identity, but index membership is', () {
    final h = Replay(fixture['cases'][0]), s = h.current;
    expect(
      hashMultiRoundMergeState({
        ...s,
        'observedAt': '2026-10-14T00:00:01.123Z',
      }),
      s['stateHash'],
    );
    expect(
      hashMultiRoundMergeState({
        ...s,
        'observedTransactionIds': ['a' * 64],
      }),
      isNot(s['stateHash']),
    );
  });
  test(
    'malformed post-execution evidence retains exposure, never advances or retries',
    () async {
      for (final patch in [
        {'status': 'not-a-status'},
        {
          'executionFee': '11',
        }, // Exact fee must remain bound to prepared material.
      ]) {
        final h = Replay(fixture['cases'][0]);
        h.config.addAll(patch);
        final result = await h.run();
        expect(result['status'], 'uncertain');
        expect(result['totalFee'], '10');
        expect(result['steps'][0].containsKey('txid'), false);
        expect(h.executions, 1);
        expect(h.calls.where((c) => c == 'read'), hasLength(1));
      }
    },
  );
}
