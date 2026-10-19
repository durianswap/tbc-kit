// Real frozen Engine and prior WASM signing vectors, synthetic read responses.
// No network, private key, native approval UI or broadcast occurs here.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/merge_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/multi_round_merge.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'native_signing_test.dart' show FixtureOperation;
import 'support/indexed_fixture.dart';
import 'support/trusted_index_candidate.dart';

Map<String, dynamic> load(String file, int index) => copied(
  (jsonDecode(File('test/fixtures/$file.json').readAsStringSync())['cases']
      as List)[index],
);
Map<String, dynamic> sample(String file, int index) {
  final s = load(file, index);
  if (file == 'native-signing') {
    final m = load('native-transfers', index);
    s['replies'] = m['replies'];
    s['snapshotId'] = m['snapshotId'];
    s['coldTrace'] = m['trace'];
    rebindExpectedSnapshot(
      s,
      withoutObservedTip(s['audit']['material']['snapshot']),
    );
    (s['coldTrace'] as List).remove('/api/tbc/nodeinfo');
  } else {
    final all =
        (jsonDecode(
                  File('test/fixtures/$file.json').readAsStringSync(),
                )['cases']
                as List)
            .cast<Map>();
    final indexed = IndexedFixture(all);
    if (file == 'unified-pool-signing') {
      final records =
          s['audit']['material']['snapshot']['payload']['contracts'] as List;
      if (records.length > 1)
        indexed.projectPool2(s);
      else
        indexed.projectLp(s);
    } else {
      indexed.projectHolder(s);
    }
  }
  return s;
}

late ComputeProbe engine;
Map<String, dynamic> keyless(String name, Map<String, dynamic> value) =>
    copied(jsonDecode(engine.call('keyless', name, canonical(value))));
Map<String, dynamic> engineCall(String name, Map value) {
  final reply = jsonDecode(engine.call('engine', name, canonical(value)));
  expect(reply['ok'], true, reason: reply['error']?.toString());
  return copied(reply['result']);
}

final class Harness {
  Harness(this.s, String kind, {ApiRead? source}) {
    network = TbcNetworkConfiguration.official(
      s['network'] == 'mainnet' ? TbcNetwork.mainnet : TbcNetwork.testnet,
    );
    authority = {
      'chainId': network.chainId,
      'accountId': s['account']['accountId'],
      'origin': s['context']['origin'],
      'sessionId': s['context']['sessionId'],
    };
    asset = {
      'kind': kind,
      if (s['request']['intent']['contractId'] != null)
        'contractId': s['request']['intent']['contractId'],
      if (s['request']['intent']['poolContractId'] != null)
        'poolContractId': s['request']['intent']['poolContractId'],
    };
    history = Tbc20MaterialReader(
      network: network,
      keyless: keyless,
      read: (path) async {
        paths.add(path);
        if (source != null) return source(path);
        need(s['replies'][path] != null, 'FIXTURE_UNEXPECTED_PATH');
        return copied(s['replies'][path]);
      },
    );
    session = MergeMaterialSession(
      history: history,
      account: s['account'],
      authority: authority,
      asset: asset,
      requireCurrent: () async {
        checks++;
        need(live, 'REVOKED');
      },
      clock: () => protocolTime(s['now']),
    );
  }
  final Map<String, dynamic> s;
  late final TbcNetworkConfiguration network;
  late final Map<String, dynamic> authority, asset;
  late final Tbc20MaterialReader history;
  late final MergeMaterialSession session;
  final paths = <String>[];
  bool live = true;
  int checks = 0;
  Map<String, dynamic> prepare(
    Map state, {
    int index = 1,
    List<String> accepted = const [],
  }) {
    final scope = {
      'version': '1.0',
      'operationKind': 'multi-round-merge',
      'authority': authority,
      'asset': asset,
      'impact': {
        'maxAssetInputsPerTransaction':
            asset['kind'] == 'tbc'
                ? 100
                : asset['kind'] == 'pool-ft'
                ? 4
                : 5,
      },
      'limits': {
        'expiresAt':
            protocolTime(
              s['now'],
            ).add(const Duration(minutes: 5)).toIso8601String(),
      },
      'initialStateHash': state['stateHash'],
      'initialUtxoCount': state['utxoCount'],
    };
    return session.prepareStep({
      'scope': scope,
      'scopeHash': hashJson(scope),
      'state': state,
      'stepIndex': index,
      'remainingFee': s['request']['constraints']['maxFee'],
      'acceptedTxids': accepted,
      'approval': {
        'status': 'approved',
        'scopeHash': hashJson(scope),
        'approvalId': 'native-consent-fixture',
        'expiresAt': scope['limits']!['expiresAt'],
      },
    });
  }

  Future<Map<String, dynamic>> resolve(MergeMaterialStep step) => step.resolve(
    request: step.request,
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
  );
}

// Simulates transport acceptance/index publication, never broadcasts. Actual
// selection and unsigned transaction validation use the real pinned Engine.
final class MaterialReplay extends MultiRoundMergeAdapter {
  MaterialReplay(this.h);
  final Harness h;
  int approvals = 0, executions = 0;
  @override
  Future<MergeRecord> readState(MergeRecord authority, MergeRecord asset) {
    expect(authority, h.authority);
    expect(asset, h.asset);
    return h.session.readState();
  }

  @override
  Future<MergeRecord> approve(MergeRecord input) async {
    approvals++;
    return {
      'status': 'approved',
      'approvalId': 'native-consent-fixture',
      'scopeHash': input['scopeHash'],
      'approvedAt': h.s['now'],
      'expiresAt': input['scope']['limits']['expiresAt'],
    };
  }

  @override
  Future<MergeRecord> prepareStep(MergeRecord input) async =>
      h.session.prepareStep(input);
  @override
  Future<void> assertAuthority(MergeRecord input) async =>
      need(h.live, 'REVOKED');
  @override
  Future<MergeRecord> executePreparedStep(MergeRecord input) async {
    final metadata = input['step'] as Map,
        step = metadata['prepared'] as MergeMaterialStep;
    final material = await h.resolve(step);
    final normalized = engineCall('normalizeRequest', {
      'version': '1.0',
      'request': step.request,
    });
    final args = {'version': '1.0', ...normalized, ...material};
    final plan = engineCall('plan', args)['plan'];
    expect(
      engineCall('validate', {...args, 'phase': 'plan', 'plan': plan})['valid'],
      true,
    );
    step.validatePlan(args, plan);
    final raw = inspectTransaction(
      plan['payload']['transactions'][0]['unsignedTransaction'],
    );
    final spent =
        (raw['inputs'] as List).map((r) => '${r['txid']}:${r['vout']}').toSet();
    final rows =
        h.s['replies']['/api/tbc/utxo/address/${h.s['account']['address']}']['utxos']
            as List;
    rows.removeWhere((r) => spent.contains('${r['txid']}:${r['index']}'));
    final id = hashJson({
      'syntheticAcceptedRound': ++executions,
      'materialHash': metadata['materialHash'],
    });
    rows.add({
      'txid': id,
      'index': 0,
      'value': raw['outputs'][0]['satoshis'],
      'height': -1,
    });
    h.session.accepted(id);
    return {
      'status': 'accepted',
      'stepId': metadata['stepId'],
      'materialHash': metadata['materialHash'],
      'txid': id,
      'fee': plan['payload']['preview']['totalFee'],
      'inputsConsumed': metadata['inputCount'],
      'outputsCreated': 1,
    };
  }

  @override
  Future<MergeRecord> reconcile(MergeRecord input) async =>
      throw StateError('UNEXPECTED_RECONCILE');
  @override
  Future<void> waitForIndex(MergeRecord input) async {}
}

void main() {
  setUpAll(() {
    const path =
        '/private/tmp/tbc-contract173-compute-20261014-a/target/aarch64-apple-darwin/release/libtbc_compute_native.dylib';
    expect(
      sha256.convert(File(path).readAsBytesSync()).toString(),
      '413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db',
    );
    engine = ComputeProbe(
      DynamicLibrary.open(trustedIndexCandidateLibrary()['path']),
    );
  });
  for (final config in [
    ('native-signing', 3, 'tbc'),
    ('native-signing', 4, 'tbc'),
    ('fungible-signing', 2, 'ft'),
    ('fungible-signing', 3, 'ft'),
    ('fungible-signing', 6, 'ft'),
    ('stablecoin-signing', 3, 'stablecoin'),
    ('stablecoin-signing', 8, 'stablecoin'),
    ('unified-pool-signing', 4, 'pool-ft'),
    ('unified-pool-signing', 5, 'ftlp'),
    ('unified-pool-signing', 16, 'ftlp'),
    ('unified-pool-signing', 19, 'ftlp'),
  ]) {
    test(
      '${config.$1}:${config.$2} shared merge exact signed bytes and no duplicated reads',
      () async {
        final s = sample(config.$1, config.$2), h = Harness(s, config.$3);
        final state = await h.session.readState(), prepared = h.prepare(state);
        h.session.prefetch(state);
        final step = prepared['prepared'] as MergeMaterialStep;
        final op = FixtureOperation(s);
        final executor = TbcSigningExecutor(
          engine: engine,
          signer: op,
          authority: TbcOperationAuthority(
            context: s['context'],
            account: TbcAccount(
              network: h.network.network,
              address: s['account']['address'],
              publicKey: s['account']['publicKey'],
            ),
            requireAuthorized: (_) {},
            isUnlocked: () => true,
            clock: () => protocolTime(s['now']),
          ),
          prepareMaterial:
              (request, account) => step.resolve(
                request: request,
                account: account,
                now: protocolTime(s['now']),
                snapshotId: s['snapshotId'],
              ),
          validateTransactionPlan: step.validatePlan,
        );
        final result = await executor.execute(s['method'], step.request);
        expect(result['transactions'], s['result']['transactions']);
        expect(result['totalFee'], s['result']['totalFee']);
        expect(
          [op.consents, op.binds, op.signs],
          [1, 1, s['audit']['signatures'].length],
        );
        final expectedReads = List<String>.from(s['coldTrace']);
        // Historical LP maintenance identifies its maintenance script before
        // choosing merge rows. That preflight still consumes the FT creation
        // parent; it is shared if the later spend ancestry also requires it.
        if (config.$1 == 'unified-pool-signing' && config.$2 < 16) {
          final ft = (s['audit']['material']['snapshot']['payload']['contracts']
                  as List)
              .singleWhere((c) => c['family'] == 'ft');
          final parent = '/api/tbc/txraw/txid/${ft['contractId']}';
          if (!expectedReads.contains(parent)) expectedReads.add(parent);
        }
        expect(h.paths, unorderedEquals(expectedReads));
        expect(h.paths.length, h.paths.toSet().length);
        expect(h.checks, greaterThan(0));
        if (config.$3 == 'ftlp' && config.$2 >= 16)
          expect(h.paths.where((p) => p.contains('poolinfo')).length, 1);
      },
    );
  }
  test(
    'two native rounds discard mutable index, observe exact parent and preserve limits',
    () async {
      final s = sample('native-signing', 4), replies = copied(s['replies']);
      final path = '/api/tbc/utxo/address/${s['account']['address']}';
      final h = Harness(s, 'tbc', source: (p) async => copied(replies[p]));
      final first = await h.session.readState(),
          p = h.prepare(first),
          step = p['prepared'] as MergeMaterialStep;
      expect(p['inputCount'], 100);
      final material = await h.resolve(step);
      final normalized = engineCall('normalizeRequest', {
        'version': '1.0',
        'request': step.request,
      });
      final input = {'version': '1.0', ...normalized, ...material};
      final plan = engineCall('plan', input)['plan'];
      expect(
        engineCall('validate', {
          ...input,
          'phase': 'plan',
          'plan': plan,
        })['valid'],
        true,
      );
      step.validatePlan(input, plan);
      final spent =
          plannedInputOutpoints(
            plan['payload']['transactions'][0]['unsignedTransaction'],
          ).toSet();
      final rows = replies[path]['utxos'] as List;
      rows.removeWhere((r) => spent.contains('${r['txid']}:${r['index']}'));
      final id = 'b' * 64;
      rows.add({'txid': id, 'index': 0, 'value': '100000', 'height': -1});
      h.session.accepted(id);
      expect(() => step.validatePlan(input, plan), throwsStateError);
      final second = await h.session.readState();
      expect(second['utxoCount'], first['utxoCount'] - 99);
      expect(second['observedTransactionIds'], [id]);
      final next = h.prepare(second, index: 2, accepted: [id]);
      expect(next['inputCount'], second['utxoCount']);
      expect(next['dependsOn'], [id]);
      await h.resolve(next['prepared']);
      expect(h.paths.where((p) => p == path).length, 2);
      expect(h.paths.where((p) => p == '/api/tbc/nodeinfo').length, 0);
      expect(h.paths.length, 2);
    },
  );
  test(
    'coordinator drives real material/Engine over two rounds with one synthetic approval',
    () async {
      final h = Harness(sample('native-signing', 4), 'tbc'),
          adapter = MaterialReplay(h);
      final result = await MultiRoundMerge(
        adapter,
        nowMs: () => protocolTime(h.s['now']).millisecondsSinceEpoch,
      ).run(
        authority: h.authority,
        asset: h.asset,
        limits: {
          'targetUtxoCount': 1,
          'maxTransactions': 3,
          'maxTotalFee': '100000',
          'expiresAt':
              protocolTime(
                h.s['now'],
              ).add(const Duration(minutes: 5)).toIso8601String(),
          'indexRefreshDelayMs': 0,
        },
      );
      expect(result['status'], 'complete');
      expect(result['finalUtxoCount'], 1);
      expect([adapter.approvals, adapter.executions], [1, 2]);
      expect((result['steps'] as List).map((r) => r['status']), [
        'accepted',
        'accepted',
      ]);
      expect(
        h.paths
            .where((p) => p.endsWith('/${h.s['account']['address']}'))
            .length,
        3,
      );
      expect(h.paths.where((p) => p == '/api/tbc/nodeinfo').length, 0);
      expect(h.paths.length, 3);
    },
  );
  test(
    'maintenance check runs after Engine validation and rejects before binding/signing',
    () async {
      final s = sample('native-signing', 3), h = Harness(s, 'tbc');
      final state = await h.session.readState(),
          step = h.prepare(state)['prepared'] as MergeMaterialStep;
      expect(() => h.prepare(state), throwsStateError);
      final op = FixtureOperation(s), phases = <String>[];
      final executor = TbcSigningExecutor(
        engine: engine,
        signer: op,
        authority: TbcOperationAuthority(
          context: s['context'],
          account: TbcAccount(
            network: h.network.network,
            address: s['account']['address'],
            publicKey: s['account']['publicKey'],
          ),
          requireAuthorized: (_) {},
          isUnlocked: () => true,
          clock: () => protocolTime(s['now']),
        ),
        prepareMaterial:
            (r, a) => step.resolve(
              request: r,
              account: a,
              now: protocolTime(s['now']),
              snapshotId: s['snapshotId'],
            ),
        timing: (stage, _) => phases.add(stage),
        validateTransactionPlan: (material, plan) {
          expect(phases, contains('validate:plan'));
          expect(
            () => plan['payload']['preview']['transactionCount'] = 2,
            throwsUnsupportedError,
          );
          final bad = copied(plan);
          bad['payload']['preview']['transactionCount'] = 2;
          expect(() => step.validatePlan(material, bad), throwsStateError);
          final missing = copied(plan);
          final other = sample('native-signing', 0);
          missing['payload']['transactions'] =
              other['audit']['plan']['payload']['transactions'];
          expect(() => step.validatePlan(material, missing), throwsStateError);
          h.session.close();
          step.validatePlan(material, plan);
        },
      );
      await expectLater(
        executor.execute(s['method'], step.request),
        throwsStateError,
      );
      expect([op.consents, op.binds, op.signs, op.closes], [1, 0, 0, 1]);
    },
  );
  test(
    'bounded-consent prefetch overlaps required reads and shares each result once',
    () async {
      final s = sample('fungible-signing', 2),
          hold = Completer<void>(),
          entered = Completer<void>();
      var count = 0;
      final h = Harness(
        s,
        'ft',
        source: (path) async {
          if (path.startsWith('/api/tbc/utxo/address/')) {
            if (++count == 1) entered.complete();
            await hold.future;
          }
          return copied(s['replies'][path]);
        },
      );
      final state = await h.session.readState();
      h.session.prefetch(state);
      h.session.prefetch(state);
      await entered.future;
      expect(count, 1);
      final prepared = h.prepare(state);
      final resolving = h.resolve(prepared['prepared']);
      hold.complete();
      await resolving;
      expect(count, 1);
      expect(h.paths, unorderedEquals(s['coldTrace']));
      h.session.close();
      expect(() => h.session.prefetch(state), throwsStateError);
    },
  );
  test('revoked authority prevents all index reads and origin reads', () async {
    final h = Harness(sample('fungible-signing', 2), 'ft')..live = false;
    await expectLater(h.session.readState(), throwsStateError);
    expect(h.paths, isEmpty);
  });
  test('cancel during a read suppresses state and material reuse', () async {
    final s = sample('native-signing', 3),
        hold = Completer<void>(),
        entered = Completer<void>();
    final h = Harness(
      s,
      'tbc',
      source: (p) async {
        if (!entered.isCompleted) entered.complete();
        await hold.future;
        return copied(s['replies'][p]);
      },
    );
    final pending = h.session.readState();
    final failure = expectLater(pending, throwsStateError);
    await entered.future;
    h.session.close();
    hold.complete();
    await failure;
    expect(() => h.prepare({}), throwsA(isA<StateError>()));
  });
  test(
    'pool FT on current AMM is unsupported before consent/material signing',
    () async {
      final h = Harness(sample('unified-pool-signing', 16), 'pool-ft');
      await expectLater(h.session.readState(), throwsStateError);
      expect(h.paths.any((p) => p.contains('utxo')), false);
    },
  );
  test(
    'read-only pagination seeds selected rows once, not every subsequent reader',
    () async {
      final s = sample('native-signing', 3),
          path = '/api/tbc/utxo/address/${s['account']['address']}';
      final rows = s['replies'][path]['utxos'] as List;
      final h = Harness(
        s,
        'tbc',
        source: (p) async {
          if (p == path)
            return {
              'utxos': [rows[0]],
              'next_cursor': 'next',
            };
          if (p == '$path?after=next')
            return {
              'utxos': [rows[1]],
              'next_cursor': '',
            };
          return copied(s['replies'][p]);
        },
      );
      final prepared = h.prepare(await h.session.readState());
      await h.resolve(prepared['prepared']);
      expect(h.paths, [path, '$path?after=next']);
    },
  );
}
