// Recorded public-fixture signatures; actual Native Engine, no live broadcast.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/unified_pool_material.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

final class RoleFixtureOperation extends FixtureOperation
    implements TbcTransactionSigningRoles {
  RoleFixtureOperation(super.sample);
  int resolutions = 0;
  Future<void> Function()? duringResolution;
  List<Map<String, dynamic>>? selected;
  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent intent,
  ) async {
    await requireCurrent();
    resolutions++;
    expect(intent.method, sample['method']);
    expect(canonical(intent.request), canonical(sample['request']));
    await duringResolution?.call();
    return (selected ??
            (sample['additionalAccounts'] as List).map((a) => copied(a)))
        .map(account)
        .toList();
  }
}

TbcAccount account(Map s) => TbcAccount(
  network: TbcNetwork.testnet,
  address: s['address'],
  publicKey: s['publicKey'],
);

void main() {
  late List<Map<String, dynamic>> fixtures;
  late Map library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixtures = [
      for (final file in ['amm-controller-signing', 'amm-controller-extended'])
        ...(jsonDecode(
                  File('test/fixtures/$file.json').readAsStringSync(),
                )['cases']
                as List)
            .map((a) => copied(a)),
    ];
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
    final indexed = IndexedFixture(fixtures);
    for (final s in fixtures) indexed.projectAmm(s);
  });
  TbcSigningExecutor executor(
    Map s,
    RoleFixtureOperation op, {
    Future<Map<String, dynamic>> Function(
      Map<String, dynamic>,
      Map<String, dynamic>,
      List<Map<String, dynamic>>,
    )?
    prepare,
    TbcExecutionTiming? timing,
  }) => TbcSigningExecutor(
    engine: engine,
    signer: op,
    authority: TbcOperationAuthority(
      context: s['context'],
      account: account(s['account']),
      requireAuthorized: (_) {},
      isUnlocked: () => true,
      clock: () => protocolTime(s['now']),
    ),
    prepareMaterial: (_, __) async => throw StateError('ROLE_PATH_REQUIRED'),
    prepareRoleMaterial:
        prepare ?? (_, __, ___) async => copied(s['audit']['material']),
    timing: timing,
  );

  for (var i = 0; i < 20; i++) {
    test(
      'controller $i exact shared cold/warm lifecycle and signed bytes',
      () async {
        final s = copied(fixtures[i]), paths = <String>[];
        Future<Map<String, dynamic>> read(String p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        }

        Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
            copied(jsonDecode(engine.call('keyless', op, canonical(input))));
        final history = Tbc20MaterialReader(
          network: network,
          read: read,
          keyless: keyless,
        );
        final concrete = AmmBusinessMaterialReader(
          network: network,
          read: read,
          readHistory: history.parent,
          funding: NativeMaterialReader(network: network, read: read),
          keyless: keyless,
        );
        final generic = UnifiedPoolMaterialReader(
          network: network,
          read: read,
          readHistory: history.parent,
          keyless: keyless,
        );
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = RoleFixtureOperation(s), phases = <String>[];
          var preparations = 0;
          final result = await executor(
            s,
            op,
            prepare: (request, owner, additional) async {
              preparations++;
              expect(canonical(additional), canonical(s['additionalAccounts']));
              late Map<String, dynamic> snapshot, policy;
              if ((request['intent']['type'] as String).startsWith('amm.')) {
                final prepared = await generic.resolve(
                  request: request,
                  account: owner,
                  now: protocolTime(s['now']),
                  snapshotId: s['snapshotId'],
                  signingAccounts: additional,
                );
                snapshot = prepared.snapshot;
                policy = prepared.policy(request: request, network: network);
              } else {
                snapshot = await concrete.resolve(
                  request: request,
                  account: owner,
                  now: protocolTime(s['now']),
                  snapshotId: s['snapshotId'],
                  signingAccounts: additional,
                );
                policy = defaultTransactionPolicy(
                  network: network,
                  request: request,
                  snapshot: snapshot,
                  now: protocolTime(s['now']),
                );
              }
              expect(
                canonical(snapshot),
                canonical(s['audit']['material']['snapshot']),
              );
              expect(
                canonical(policy),
                canonical(s['audit']['material']['policy']),
              );
              return {'snapshot': snapshot, 'policy': policy};
            },
            timing: (stage, _) => phases.add(stage),
          ).execute(s['method'], s['request']);
          expect(canonical(result), canonical(s['result']));
          final stages = (s['audit']['stages'] as List).length;
          expect(
            [
              op.resolutions,
              preparations,
              op.consents,
              op.binds,
              op.advances,
              op.signs,
              op.closes,
            ],
            [1, 1, 1, 1, stages - 1, s['audit']['signatures'].length, 1],
          );
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(paths.length, paths.toSet().length);
          expect(
            phases.where((p) => p == 'validate:finalized'),
            hasLength(stages),
          );
          expect(phases.where((p) => p == 'validate:pre-sign'), hasLength(1));
        }
      },
    );
    test(
      'controller $i worker one consent, two initial reads, no stage refetch',
      () async {
        final s = copied(fixtures[i]),
            op = RoleFixtureOperation(s),
            paths = <String>[],
            release = Completer<void>();
        op.duringConsent = () async {
          for (var n = 0; paths.length < 2 && n < 200; n++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(paths.length, 2);
          expect(op.binds, 0);
          release.complete();
        };
        final worker = await TbcSigningWorker.start(
          library: TbcPinnedComputeLibrary(
            path: library['path'],
            sha256: library['sha256'],
          ),
          network: network,
          backend: FixtureBackend(op),
          read: (p) async {
            paths.add(p);
            await release.future;
            return copied(s['replies'][p]);
          },
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'controller-$i',
            method: s['method'],
            navigation: TbcWebViewNavigation(
              webViewInstanceId: 'wv',
              sessionId: s['context']['sessionId'],
              navigationId: s['context']['navigationId'],
              committedUrl: s['context']['origin'],
              origin: s['context']['origin'],
              createdAt: tbcProtocolTimestamp(DateTime.now()),
            ),
            account: account(s['account']),
            revision: 0,
          ),
          request: copied(s['request']),
          requireAuthorized: () {},
          isUnlocked: () => true,
        );
        expect(
          canonical(result['transactions']),
          canonical(s['result']['transactions']),
        );
        expect(result['totalFee'], s['result']['totalFee']);
        expect(
          [op.resolutions, op.consents, op.binds, op.advances, op.signs],
          [
            1,
            1,
            1,
            s['audit']['stages'].length - 1,
            s['audit']['signatures'].length,
          ],
        );
        expect(paths, unorderedEquals(s['coldTrace']));
        expect(paths.toSet().length, paths.length);
      },
    );
  }
  for (final bad in [
    'missing',
    'duplicate',
    'wrong-account',
    'revoked-during-resolution',
  ]) {
    test('controller $bad fails before preparation or consent', () async {
      final s = copied(fixtures[0]), op = RoleFixtureOperation(s);
      switch (bad) {
        case 'missing':
          op.selected = [];
        case 'duplicate':
          op.selected = [
            copied(s['additionalAccounts'][0]),
            copied(s['additionalAccounts'][0]),
          ];
        case 'wrong-account':
          op.selected = [copied(s['account'])];
        case 'revoked-during-resolution':
          op.duringResolution = () async {
            op.active = false;
          };
      }
      var preparations = 0;
      await expectLater(
        executor(
          s,
          op,
          prepare: (_, __, ___) async {
            preparations++;
            return copied(s['audit']['material']);
          },
        ).execute(s['method'], s['request']),
        throwsStateError,
      );
      expect(
        [preparations, op.consents, op.binds, op.signs, op.closes],
        [0, 0, 0, 0, 1],
      );
    });
  }
  for (final bad in ['reject', 'changed-snapshot', 'revoked-after-parent']) {
    test('controller $bad cannot sign the business stage', () async {
      final s = copied(fixtures[16]), op = RoleFixtureOperation(s);
      switch (bad) {
        case 'reject':
          op.approve = false;
        case 'changed-snapshot':
          final snapshot = s['audit']['material']['snapshot'];
          snapshot['payload']['signingAccounts'] = [s['account']];
          snapshot['snapshotHash'] = hashJson(snapshot['payload']);
        case 'revoked-after-parent':
          op.duringAdvance = () async {
            op.active = false;
          };
      }
      await expectLater(
        executor(s, op).execute(s['method'], s['request']),
        throwsA(anyOf(isA<StateError>(), isA<TbcSigningRejected>())),
      );
      expect(op.signs <= s['audit']['stages'][0]['tasks'].length, true);
      expect(op.closes, 1);
      if (bad != 'revoked-after-parent') expect(op.signs, 0);
    });
  }
}
