// Actual frozen multi-stage Pool plans with public synthetic inputs only.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_profiles.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  late IndexedFixture indexed;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/amm-dependent-signing.json').readAsStringSync(),
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
    indexed.projectAmm(s);
    return s;
  }
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  AmmBusinessMaterialReader reader(ApiRead read) {
    Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
        copied(jsonDecode(engine.call('keyless', op, canonical(input))));
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return AmmBusinessMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
      keyless: keyless,
    );
  }

  TbcSigningExecutor executor(
    Map s,
    FixtureOperation op, {
    Future<Map<String, dynamic>> Function(
      Map<String, dynamic>,
      Map<String, dynamic>,
    )?
    prepare,
    TbcExecutionTiming? timing,
  }) => TbcSigningExecutor(
    engine: engine,
    signer: op,
    authority: TbcOperationAuthority(
      context: s['context'],
      account: account(s),
      requireAuthorized: (_) {},
      isUnlocked: () => true,
      clock: () => protocolTime(s['now']),
    ),
    prepareMaterial: prepare ?? (_, __) async => copied(s['audit']['material']),
    timing: timing,
  );

  for (var i = 0; i < 7; i++) {
    test(
      'dependent Pool $i exact cold/warm material and complete shared lifecycle',
      () async {
        final s = sample(i), paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        });
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = FixtureOperation(s), phases = <String>[];
          var preparations = 0;
          final result = await executor(
            s,
            op,
            prepare: (request, account) async {
              preparations++;
              final snapshot = await r.resolve(
                request: request,
                account: account,
                now: protocolTime(s['now']),
                snapshotId: s['snapshotId'],
              );
              expect(
                canonical(snapshot),
                canonical(s['audit']['material']['snapshot']),
              );
              final policy = defaultTransactionPolicy(
                network: network,
                request: request,
                snapshot: snapshot,
                now: protocolTime(s['now']),
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
          expect(
            [
              preparations,
              op.consents,
              op.binds,
              op.advances,
              op.signs,
              op.closes,
            ],
            [
              1,
              1,
              1,
              s['audit']['stages'].length - 1,
              s['audit']['signatures'].length,
              1,
            ],
          );
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(paths.length, paths.toSet().length);
          expect(
            phases.where((p) => p == 'validate:finalized'),
            hasLength(s['audit']['stages'].length),
          );
          expect(phases.where((p) => p == 'validate:pre-sign'), hasLength(1));
        }
      },
    );
    test(
      'dependent Pool $i worker one consent, parallel prefetch, no stage refetch',
      () async {
        final s = sample(i),
            op = FixtureOperation(s),
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
            operationId: 'dependent-$i',
            method: s['method'],
            navigation: TbcWebViewNavigation(
              webViewInstanceId: 'wv',
              sessionId: s['context']['sessionId'],
              navigationId: s['context']['navigationId'],
              committedUrl: s['context']['origin'],
              origin: s['context']['origin'],
              createdAt: tbcProtocolTimestamp(DateTime.now()),
            ),
            account: account(s),
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
          [op.consents, op.binds, op.advances, op.signs],
          [
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
    'unknown-warning',
    'missing-warning',
    'extra-primary',
    'wrong-funding-id',
    'unrelated-profile',
  ]) {
    test('dependent Pool cannot expand native consolidation consent: $bad', () {
      final s = sample(0),
          request = s['request'] as Map,
          payload = copied(s['audit']['plan']['payload']);
      switch (bad) {
        case 'unknown-warning':
          payload['preview']['warnings'].add('UNSUPPORTED_WARNING');
        case 'missing-warning':
          payload['preview']['warnings'].removeLast();
        case 'extra-primary':
          payload['transactions'][0]['role'] = 'primary';
        case 'wrong-funding-id':
          payload['transactions'][0]['id'] = 'unrelated';
        case 'unrelated-profile':
          request['intent']['type'] = 'tbc20.transfer';
      }
      expect(coveredTransactionWarnings(request, payload), false);
    });
  }
  for (final bad in [
    'reject',
    'cancel-after-parent',
    'changed-parent-signature',
    'fee-cap',
  ]) {
    test('dependent Pool $bad cannot sign or deliver the next stage', () async {
      final s = sample(5), op = FixtureOperation(s);
      switch (bad) {
        case 'reject':
          op.approve = false;
        case 'cancel-after-parent':
          op.duringAdvance = () async {
            op.active = false;
          };
        case 'changed-parent-signature':
          op.alterSignature = (sig) => sig['signature'] = '00' * 64;
        case 'fee-cap':
          s['request']['constraints']['maxFee'] = '1';
      }
      await expectLater(
        executor(s, op).execute(s['method'], s['request']),
        throwsA(anyOf(isA<StateError>(), isA<TbcSigningRejected>())),
      );
      expect(op.signs <= s['audit']['stages'][0]['tasks'].length, true);
      expect(op.closes, 1);
      if (bad == 'reject' || bad == 'fee-cap') expect(op.signs, 0);
    });
  }
}
