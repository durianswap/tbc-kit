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
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/unified_pool_material.dart';
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  late IndexedFixture indexed;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/unified-pool-signing.json').readAsStringSync(),
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
    final pool = (s['audit']['material']['snapshot']['payload']['contracts']
            as List)
        .singleWhere((r) => r['family'] == 'pool');
    if (pool['protocolVersion'] == '2.0')
      indexed.projectPool2(s);
    else if ((s['request']['intent']['type'] as String).startsWith('tbc20Lp.'))
      indexed.projectLp(s);
    else
      indexed.projectAmm(s);
    return s;
  }

  for (final i in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 18, 20]) {
    test(
      'Unified worker $i uses one consent and parallel shared material',
      () async {
        final s = sample(i), paths = <String>[], released = Completer<void>();
        s['request']['constraints']['expiresAt'] = tbcProtocolTimestamp(
          DateTime.now().add(const Duration(minutes: 2)),
        );
        final operation = FixtureOperation(s);
        const initial = 2;
        operation.duringConsent = () async {
          try {
            for (var n = 0; paths.length < initial && n < 300; n++) {
              await Future<void>.delayed(const Duration(milliseconds: 1));
            }
            expect(paths.length, initial);
            expect(operation.binds, 0);
          } finally {
            released.complete();
          }
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
            operationId: 'unified-worker-$i',
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
        expect(paths.length, paths.toSet().length);
      },
    );
  }
  test(
    'Unified worker cannot replace authenticated historical Pool fee policy',
    () async {
      final s = sample(0), operation = FixtureOperation(sample(0));
      s['request']['constraints']['expiresAt'] = tbcProtocolTimestamp(
        DateTime.now().add(const Duration(minutes: 2)),
      );
      final policy = copied(s['audit']['material']['policy']);
      policy['payload']['expiresAt'] = tbcProtocolTimestamp(
        DateTime.now().add(const Duration(minutes: 5)),
      );
      policy['payload']['pool']['serviceFeeRate'] = 36;
      policy['policyHash'] = hashJson(policy['payload']);
      final worker = await TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: library['path'],
          sha256: library['sha256'],
        ),
        network: network,
        backend: FixtureBackend(operation),
        read: (p) async => copied(s['replies'][p]),
      );
      addTearDown(worker.close);
      await expectLater(
        worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'unified-policy-override',
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
          policy: policy,
          requireAuthorized: () {},
          isUnlocked: () => true,
        ),
        throwsStateError,
      );
      expect([operation.binds, operation.signs], [0, 0]);
    },
  );
  Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', op, canonical(input))));
  Map<String, dynamic> call(String op, Map value) {
    final result = jsonDecode(engine.call('engine', op, canonical(value)));
    expect(result['ok'], true, reason: result['error']?.toString());
    return copied(result['result']);
  }

  UnifiedPoolMaterialReader reader(ApiRead read, {KeylessCall? codec}) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return UnifiedPoolMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      keyless: codec ?? keyless,
    );
  }

  Future<UnifiedPoolPreparedMaterial> resolve(
    UnifiedPoolMaterialReader r,
    Map s,
  ) => r.resolve(
    request: s['request'],
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
    minConfirmations: s['minConfirmations'],
  );

  for (var i = 0; i < 24; i++) {
    test(
      'Unified Pool $i preserves original request, frozen material/plan/fee/signatures and reads',
      () async {
        final s = sample(i),
            paths = <String>[],
            requestBefore = canonical(s['request']);
        var identifications = 0;
        final r = reader(
          (p) async {
            paths.add(p);
            expect(s['replies'].containsKey(p), true, reason: p);
            return copied(s['replies'][p]);
          },
          codec: (op, input) {
            if (input['phase'] == 'identifyPoolState') identifications++;
            return keyless(op, input);
          },
        );
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final prepared = await resolve(r, s), snapshot = prepared.snapshot;
          expect(canonical(s['request']), requestBefore);
          expect(
            canonical(snapshot),
            canonical(s['audit']['material']['snapshot']),
          );
          final policy = prepared.policy(
            request: s['request'],
            network: network,
            minConfirmations: s['minConfirmations'],
          );
          expect(policy, s['audit']['material']['policy']);
          final expected = List<String>.from(
            s[warm == 0 ? 'coldTrace' : 'warmTrace'],
          );
          if (warm == 1 && s['generation'] == 'historical') {
            expected.remove(
              '/api/tbc/txraw/txid/${snapshot['payload']['utxos'][0]['txid']}',
            );
          }
          expect(paths, unorderedEquals(expected));
          expect(paths.length, paths.toSet().length);
          expect(identifications, 1);
          // Use the original generic request, NOT the private projection, in
          // every independent Engine phase and in the frozen approval binding.
          final material = {
            ...copied(s['audit']['material']),
            'snapshot': snapshot,
            'policy': policy,
          };
          expect(material['request'], s['request']);
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
  test(
    'Historical Pool2 explicit inputs are rejected by frozen Native Engine itself',
    () {
      expect((fixture['unsupportedExplicit'] as List).length, 7);
      for (final s in fixture['unsupportedExplicit']) {
        final result = jsonDecode(
          engine.call(
            'engine',
            'normalizeRequest',
            canonical({'version': '1.0', 'request': s['request']}),
          ),
        );
        expect(result['ok'], false);
        expect(result['error'], s['error']);
      }
    },
  );
  for (final spec in [
    (7, 'tbc20Lp.burn'),
    (7, 'amm.mergeToken'),
    (0, 'tbc20Lp.transfer'),
    (0, 'tbc20Lp.lock'),
    (0, 'tbc20Lp.unlock'),
  ]) {
    test(
      'Unified Pool template does not offer unsupported ${spec.$1}/${spec.$2}',
      () async {
        final s = sample(spec.$1), old = s['request']['intent'];
        s['request']['intent'] = {
          'version': '1.0',
          'type': spec.$2,
          'poolContractId': old['poolContractId'],
        };
        final paths = <String>[];
        await expectLater(
          resolve(
            reader((p) async {
              paths.add(p);
              return copied(s['replies'][p]);
            }),
            s,
          ),
          throwsStateError,
        );
        expect(
          paths.length,
          3,
        ); // Mandatory tip, funding, immutable origin only.
        expect(
          paths.any((p) => p.contains('/lputxo/') || p.contains('/ft/utxo/')),
          false,
        );
      },
    );
  }
  for (final problem in [
    'explicit-input',
    'state-commitment',
    'ft-budget',
    'initial-ft',
    'maximum-ft',
    'signing-role',
  ]) {
    test(
      'Historical generic Pool rejects unsupported $problem without substituting semantics',
      () async {
        final s = sample(2), i = s['request']['intent'];
        switch (problem) {
          case 'explicit-input':
            s['request']['constraints']['inputOutpoints'] = [
              {'txid': 'aa' * 32, 'vout': 0},
            ];
          case 'state-commitment':
            i['poolStateHash'] = 'aa' * 32;
          case 'ft-budget':
            i['budgetAsset'] = 'ft';
          case 'initial-ft':
            i['initialFtAmount'] = '1';
          case 'maximum-ft':
            i['maximumFtAmount'] = '1';
          case 'signing-role':
            s['request']['signingRoles'] = [
              {
                'role': 'pool-controller',
                'accountId': s['account']['accountId'],
              },
            ];
        }
        final paths = <String>[];
        await expectLater(
          resolve(
            reader((p) async {
              paths.add(p);
              return copied(s['replies'][p]);
            }),
            s,
          ),
          throwsStateError,
        );
        // A generic role request may target a supported current AMM. The same
        // mandatory funding/index/current-state reads identify the template;
        // only then can this valid primary-role selection be rejected as Pool2.
        expect(paths.length, 3);
        expect(paths.length, paths.toSet().length);
      },
    );
  }
  test(
    'Unified Pool read projection owns caller data and policy stays bound to original request',
    () async {
      final s = sample(0),
          original = copied(s['request']),
          gate = Completer<void>(),
          paths = <String>[];
      final r = reader((p) async {
        paths.add(p);
        await gate.future;
        return copied(s['replies'][p]);
      });
      final pending = resolve(r, s);
      expect(paths.length, 2); // Funding and current-state index overlap.
      s['request']['intent']['amount'] = '999';
      s['request']['intent']['poolContractId'] = 'ff' * 32;
      gate.complete();
      final prepared = await pending;
      expect(prepared.snapshot, s['audit']['material']['snapshot']);
      expect(
        prepared.policy(request: original, network: network),
        s['audit']['material']['policy'],
      );
      expect(
        () => prepared.policy(request: s['request'], network: network),
        throwsStateError,
      );
      expect(
        () => prepared.policy(
          request: original,
          network: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
        ),
        throwsStateError,
      );
      expect(
        () => prepared.policy(
          request: original,
          network: network,
          minConfirmations: '1',
        ),
        throwsStateError,
      );
      prepared.snapshot['payload']['utxos'].clear();
      prepared.policy(request: original, network: network)['payload'].clear();
      expect(prepared.snapshot['payload']['utxos'], isNotEmpty);
      expect(
        prepared.policy(request: original, network: network)['payload'],
        isNotEmpty,
      );
    },
  );
  test(
    'A failed origin hint drains already-started reads and performs no fallback',
    () async {
      final s = sample(0), gate = Completer<void>(), paths = <String>[];
      var completed = false;
      final r = reader(
        (p) async {
          paths.add(p);
          if (p.contains('/utxo/address/')) await gate.future;
          return copied(s['replies'][p]);
        },
        codec:
            (op, input) =>
                input['phase'] == 'identifyPoolState'
                    ? {
                      'family': 'amm',
                      'generation': 'unknown',
                      'verification': 'state-template',
                      'assetIdentityVerified': false,
                    }
                    : keyless(op, input),
      );
      final pending = resolve(r, s).whenComplete(() => completed = true);
      pending.ignore();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(completed, false);
      expect(paths.length, 3);
      gate.complete();
      await expectLater(pending, throwsStateError);
      expect(paths.length, 3);
    },
  );
  test(
    'Index generation labels cannot redirect authenticated current Pool to historical builder',
    () async {
      final s = sample(7);
      final p = (s['replies'] as Map).keys.firstWhere(
        (p) => p.toString().contains('/poolinfo/'),
      );
      s['replies'][p]['version'] = 2;
      s['replies'][p]['generation'] = 'historical';
      final material = await resolve(
        reader((p) async => copied(s['replies'][p])),
        s,
      );
      expect(material.snapshot, s['audit']['material']['snapshot']);
      expect(
        material.policy(request: s['request'], network: network),
        s['audit']['material']['policy'],
      );
    },
  );
}
