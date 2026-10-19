import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/pool2_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  late IndexedFixture indexed;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/pool2-signing.json').readAsStringSync(),
    );
    fixture['cases'].addAll(
      jsonDecode(
        File('test/fixtures/pool2-positive-floor.json').readAsStringSync(),
      )['cases'],
    );
    fixture['cases'].addAll(
      jsonDecode(
        File('test/fixtures/pool2-maintenance.json').readAsStringSync(),
      )['cases'],
    );
    fixture['cases'].addAll(
      jsonDecode(
        File(
          'test/fixtures/pool2-maintenance-positive-floor.json',
        ).readAsStringSync(),
      )['cases'],
    );
    library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    library = trustedIndexCandidateLibrary();
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
    indexed = IndexedFixture((fixture['cases'] as List).cast<Map>());
  });
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    indexed.projectPool2(s);
    return s;
  }

  for (final i in [0, 1, 2, 3, 8, 9, 10]) {
    test('Pool2 worker $i one consent overlaps both initial reads', () async {
      final s = sample(i), paths = <String>[], released = Completer<void>();
      s['request']['constraints']['expiresAt'] = tbcProtocolTimestamp(
        DateTime.now().add(const Duration(minutes: 2)),
      );
      final operation = FixtureOperation(s);
      operation.duringConsent = () async {
        for (var n = 0; paths.length < 2 && n < 200; n++) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
        expect(paths.length, 2);
        expect(operation.binds, 0);
        released.complete();
      };
      final worker = await TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: library['path'],
          sha256: library['sha256'],
        ),
        network: network,
        backend: FixtureBackend(operation),
        read: (p) async {
          paths.add(p);
          await released.future;
          return copied(s['replies'][p]);
        },
      );
      addTearDown(worker.close);
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'pool2-worker-$i',
          method: s['method'],
          account: TbcAccount(
            network: TbcNetwork.testnet,
            address: s['account']['address'],
            publicKey: s['account']['publicKey'],
          ),
          revision: 0,
          navigation: TbcWebViewNavigation(
            webViewInstanceId: 'view',
            sessionId: 'session',
            navigationId: 'nav',
            committedUrl: 'https://partner.example/dapp',
            origin: 'https://partner.example',
            createdAt: tbcProtocolTimestamp(DateTime.now()),
          ),
        ),
        request: s['request'],
        requireAuthorized: () {},
        isUnlocked: () => true,
      );
      expect(result['transactions'], s['result']['transactions']);
      expect(result['totalFee'], s['result']['totalFee']);
      expect(
        [
          operation.consents,
          operation.binds,
          operation.advances,
          operation.signs,
        ],
        [1, 1, 0, s['audit']['signatures'].length],
      );
      expect(paths, unorderedEquals(s['coldTrace']));
    });
  }
  Map<String, dynamic> call(String op, Map value) {
    final result = jsonDecode(engine.call('engine', op, canonical(value)));
    expect(result['ok'], true, reason: result['error']?.toString());
    return copied(result['result']);
  }

  for (final scenario in ['policy-override', 'expired-request']) {
    test(
      'Pool2 worker rejects $scenario before binding or signatures',
      () async {
        final s = sample(0), paths = <String>[];
        s['request']['constraints']['expiresAt'] = tbcProtocolTimestamp(
          DateTime.now().add(
            scenario == 'expired-request'
                ? const Duration(minutes: -1)
                : const Duration(minutes: 2),
          ),
        );
        final policy = copied(s['audit']['material']['policy']);
        policy['payload']['expiresAt'] = tbcProtocolTimestamp(
          DateTime.now().add(const Duration(minutes: 5)),
        );
        policy['payload']['pool']['serviceFeeRate'] = 36;
        policy['policyHash'] = hashJson(policy['payload']);
        final operation = FixtureOperation(s);
        final worker = await TbcSigningWorker.start(
          library: TbcPinnedComputeLibrary(
            path: library['path'],
            sha256: library['sha256'],
          ),
          network: network,
          backend: FixtureBackend(operation),
          read: (p) async {
            paths.add(p);
            return copied(s['replies'][p]);
          },
        );
        addTearDown(worker.close);
        await expectLater(
          worker.execute(
            scope: TbcSigningRequestScope(
              operationId: scenario,
              method: s['method'],
              account: TbcAccount(
                network: TbcNetwork.testnet,
                address: s['account']['address'],
                publicKey: s['account']['publicKey'],
              ),
              revision: 0,
              navigation: TbcWebViewNavigation(
                webViewInstanceId: 'view',
                sessionId: 'session',
                navigationId: 'nav',
                committedUrl: 'https://partner.example/dapp',
                origin: 'https://partner.example',
                createdAt: tbcProtocolTimestamp(DateTime.now()),
              ),
            ),
            request: s['request'],
            policy: scenario == 'policy-override' ? policy : null,
            requireAuthorized: () {},
            isUnlocked: () => true,
          ),
          throwsStateError,
        );
        expect([operation.binds, operation.signs], [0, 0]);
        if (scenario == 'expired-request') {
          expect(paths, isEmpty);
          expect(operation.consents, 0);
        }
      },
    );
  }

  Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', op, canonical(input))));
  Pool2MaterialReader reader(ApiRead read) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return Pool2MaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
      keyless: keyless,
    );
  }

  Future<Pool2PreparedMaterial> resolve(Pool2MaterialReader r, Map s) =>
      r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
  for (final spec in [
    (8, 'one'),
    (9, 'one'),
    (10, 'empty'),
    (8, 'duplicate'),
    (9, 'wrong-value'),
  ]) {
    test(
      'Pool2 maintenance ${spec.$1} rejects ${spec.$2} input index',
      () async {
        final s = sample(spec.$1);
        final path = (s['replies'] as Map).keys.singleWhere(
          (p) => (p as String).contains(
            spec.$1 == 8 ? '/ft/utxo/' : '/pool/lputxo/',
          ),
        );
        final rows = s['replies'][path]['utxos'] as List;
        if (spec.$2 == 'one') rows.removeLast();
        if (spec.$2 == 'empty') s['replies'][path]['utxos'] = null;
        if (spec.$2 == 'duplicate') rows.add(copied(rows.first));
        if (spec.$2 == 'wrong-value') rows.first['tbc_balance'] = '501';
        await expectLater(
          resolve(reader((p) async => copied(s['replies'][p])), s),
          throwsStateError,
        );
      },
    );
  }
  for (var i = 0; i < 14; i++) {
    test(
      'Pool2 $i frozen material/policy/signatures and bounded cold/warm reads',
      () async {
        final s = sample(i), paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        });
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final prepared = await resolve(r, s), snapshot = prepared.snapshot;
          expect(
            canonical(snapshot),
            canonical(s['audit']['material']['snapshot']),
          );
          final expectedPaths = List<String>.from(
            s[warm == 0 ? 'coldTrace' : 'warmTrace'],
          );
          if (warm == 1) {
            // Unlike the old private funding reader, the shared txid-verified
            // immutable cache safely reuses bytes. Fresh funding still queried.
            final fee = snapshot['payload']['utxos'][0]['txid'];
            expectedPaths.remove('/api/tbc/txraw/txid/$fee');
          }
          if (i == 4 || i == 5) {
            // Frozen positive-floor swaps use an older unscoped reader which
            // repeats native/index/raw reads. Shared request/history caches may
            // remove those reads, but not either fresh state/source decode.
            expect(paths.every(expectedPaths.contains), true);
            expect(paths.length, warm == 0 ? (i == 4 ? 9 : 10) : 6);
            expect(paths.where((p) => p.contains('/decode/')).length, 1);
          } else {
            expect(paths, unorderedEquals(expectedPaths));
          }
          expect(paths.length, paths.toSet().length);
          final policy = prepared.policy(
            request: s['request'],
            network: network,
            now: protocolTime(s['now']),
            minConfirmations: s['minConfirmations'],
          );
          expect(policy, s['audit']['material']['policy']);
          final material = {
            ...copied(s['audit']['material']),
            'snapshot': snapshot,
            'policy': policy,
          };
          final plan = call('plan', material)['plan'];
          expect(plan, s['audit']['plan']);
          expect(
            call('validate', {
              ...material,
              'plan': plan,
              'phase': 'plan',
            })['valid'],
            true,
          );
          final signing = {
            ...material,
            'plan': plan,
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {...signing, 'phase': 'pre-sign'})['valid'],
            true,
          );
          final args = {...signing, 'signatures': s['audit']['signatures']};
          final result = call('finalize', args);
          expect(result['bundle'], s['result']);
          expect(
            call('validate', {
              ...args,
              'phase': 'finalized',
              'bundle': result['bundle'],
            })['valid'],
            true,
          );
        }
      },
    );
  }
  for (final problem in [
    'wrong-pool-value',
    'wrong-pool-script',
    'wrong-ft-id',
    'wrong-fee-parent',
    'duplicate-ft',
    'wrong-ft-value',
    'unknown-parent',
    'future-height',
    'wrong-version',
    'invalid-tag',
    'historical-create',
    'explicit-input',
  ]) {
    test(
      'Pool2 rejects $problem without material/signing or network retry',
      () async {
        final s = sample(problem == 'future-height' ? 5 : 1),
            replies = s['replies'] as Map;
        final infoPath = replies.keys.firstWhere(
          (p) => p.toString().contains('/poolinfo/'),
        );
        final ftPath = replies.keys.firstWhere(
          (p) => p.toString().contains('/ft/utxo/'),
        );
        switch (problem) {
          case 'wrong-pool-value':
            replies[infoPath]['value'] = '11001';
          case 'wrong-pool-script':
            replies[infoPath]['pool_code_script'] = '51';
          case 'wrong-ft-id':
            replies[infoPath]['ft_contract_id'] = 'ff' * 32;
          case 'wrong-fee-parent':
            final p = replies.keys.firstWhere(
              (p) => p.toString().contains('/utxo/address/'),
            );
            replies[p]['utxos'][0]['value'] = '4999999';
          case 'duplicate-ft':
            replies[ftPath]['utxos'].add(copied(replies[ftPath]['utxos'][0]));
          case 'wrong-ft-value':
            replies[ftPath]['utxos'][0]['tbc_value'] = 501;
          case 'unknown-parent':
            replies[ftPath]['utxos'][0]['txid'] = 'ff' * 32;
          case 'future-height':
            replies[ftPath]['utxos'][0]['height'] = 1001;
          case 'wrong-version':
            replies[infoPath]['version'] = 3;
          case 'invalid-tag':
            replies[infoPath]['service_provider'] = 'bad\nservice';
          case 'historical-create':
            s['request']['intent']['type'] = 'tbc.pool.create';
          case 'explicit-input':
            s['request']['constraints']['inputOutpoints'] = [
              {'txid': 'ff' * 32, 'vout': 0},
            ];
        }
        final paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          if (!replies.containsKey(p))
            throw StateError('Unrecognized fixture path');
          return copied(replies[p]);
        });
        await expectLater(resolve(r, s), throwsA(isA<StateError>()));
        expect(paths.length, paths.toSet().length);
      },
    );
  }
  test(
    'Pool2 policy is request/network bound and snapshots are detached',
    () async {
      final s = sample(0), r = reader((p) async => copied(s['replies'][p]));
      final prepared = await resolve(r, s), mutated = copied(s['request']);
      prepared.snapshot['payload']['utxos'].clear();
      expect(prepared.snapshot['payload']['utxos'], isNotEmpty);
      mutated['intent']['tbcAmount'] = '1001';
      expect(
        () => prepared.policy(
          request: mutated,
          network: network,
          now: protocolTime(s['now']),
        ),
        throwsStateError,
      );
      expect(
        () => prepared.policy(
          request: s['request'],
          network: network,
          now: protocolTime(s['now']),
          minConfirmations: '1',
        ),
        throwsStateError,
      );
      expect(
        () => prepared.policy(
          request: s['request'],
          network: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
          now: protocolTime(s['now']),
        ),
        throwsStateError,
      );
    },
  );
  test(
    'Pool2 slow tip does not serialize zero-floor selected-parent reads',
    () async {
      final s = sample(1),
          gate = Completer<void>(),
          parentStarted = Completer<void>();
      final selected =
          s['nativeCalls'].firstWhere(
            (c) =>
                c['method'] == 'preparePoolNft' &&
                c['input']['phase'] == 'select',
          )['result']['ownerFtCandidates'][0]['txid'];
      final paths = <String>[];
      final r = reader((p) async {
        paths.add(p);
        if (p == '/api/tbc/nodeinfo') await gate.future;
        if (p == '/api/tbc/txraw/txid/$selected' && !parentStarted.isCompleted)
          parentStarted.complete();
        return copied(s['replies'][p]);
      });
      final pending = resolve(r, s);
      pending.ignore();
      try {
        await parentStarted.future.timeout(const Duration(seconds: 2));
      } finally {
        gate.complete();
      }
      final result = await pending;
      expect(paths.length, (s['coldTrace'] as List).length);
      final asset = (result.snapshot['payload']['utxos'] as List).firstWhere(
        (u) => u['classification'] == 'ft',
      );
      expect(asset.containsKey('confirmations'), false);
      final input = {
        ...copied(s['audit']['material']),
        'snapshot': result.snapshot,
      };
      final plan = call('plan', input)['plan'];
      expect(
        call('validate', {...input, 'plan': plan, 'phase': 'plan'})['valid'],
        true,
      );
    },
  );
}
