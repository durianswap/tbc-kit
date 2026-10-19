// New source/candidate parity, separate from immutable accepted fixtures.
// Public synthetic scalars only; every read is mocked and no broadcast occurs.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/prepared_proposal.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'native_signing_test.dart' show FixtureBackend;
import 'amm_controller_signing_test.dart' show RoleFixtureOperation, account;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  final report = jsonDecode(
    File('../contract173-upgrade/high-level173.json').readAsStringSync(),
  );
  final extra = jsonDecode(
    File('../contract173-upgrade/high-level173-extra.json').readAsStringSync(),
  );
  final cases =
      [
        ...report['cases'] as List,
        ...extra['cases'] as List,
      ].map((v) => copied(v)).toList();
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  late ComputeProbe engine;
  late Map library;
  setUpAll(() {
    final build = jsonDecode(
      File(
        Platform.environment['TBC173_BUILD_REPORT'] ??
            '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json',
      ).readAsStringSync(),
    );
    library = (build['builds'] as List).singleWhere(
      (v) => v['target'] == 'aarch64-apple-darwin',
    );
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    for (final lane in ['engine', 'keyless']) {
      final wasm = (build['wasm'] as List).singleWhere(
        (v) => v['lane'] == lane,
      );
      expect(
        wasm['sha256'],
        report[lane == 'engine' ? 'engineWasmSha256' : 'keylessWasmSha256'],
      );
    }
    library = trustedIndexCandidateLibrary();
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
    final indexed = IndexedFixture(cases);
    for (final s in cases) indexed.projectAmm(s);
  });

  test(
    'Prepared explicit templates match Core and reject substituted identity',
    () {
      for (final row in extra['prepared'] as List) {
        final now = protocolTime(row['now']);
        expect(
          hashJson(checkedPreparedRequest(row['request'], now)),
          hashJson(row['normalizedRequest']),
        );
        for (final field in [
          'templateRevision',
          'family',
          'protocolVersion',
          'genesisOutpoint',
        ]) {
          final bad = copied(row['request']), p = bad['proposal']['payload'];
          p['evidence']['contracts'][0][field] = switch (field) {
            'templateRevision' => List.filled(32, 'ff').join(),
            'family' => 'stablecoin',
            'protocolVersion' => 'coin',
            _ => {
              'txid': p['evidence']['contracts'][0]['contractId'],
              'vout': 1,
            },
          };
          bad['proposal']['proposalHash'] = hashJson(p);
          expect(
            () => checkedPreparedRequest(bad, now),
            throwsA(isA<TbcPreparedRefused>()),
          );
        }
      }
    },
  );

  Future<Map<String, dynamic>> Function() resolver(Map s, ApiRead read) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (m, i) => copied(jsonDecode(engine.call('keyless', m, canonical(i)))),
    );
    final funding = NativeMaterialReader(network: network, read: read);
    final creation = AmmMaterialReader(
      network: network,
      funding: funding,
      readHistory: history.parent,
    );
    final business = AmmBusinessMaterialReader(
      network: network,
      read: read,
      funding: funding,
      readHistory: history.parent,
      keyless:
          (m, i) => copied(jsonDecode(engine.call('keyless', m, canonical(i)))),
    );
    return () =>
        s['kind'] == 'create'
            ? creation.resolve(
              request: s['request'],
              account: s['account'],
              now: protocolTime(s['now']),
              snapshotId: s['snapshotId'],
            )
            : business.resolve(
              request: s['request'],
              account: s['account'],
              now: protocolTime(s['now']),
              snapshotId: s['snapshotId'],
              signingAccounts:
                  (s['signingAccounts'] as List).map((v) => copied(v)).toList(),
            );
  }

  for (final sample in cases) {
    test(
      '${sample['name']} paired material, policy, one consent, signed bytes',
      () async {
        final s = copied(sample);
        s['additionalAccounts'] = s['signingAccounts'];
        final paths = <String>[];
        final resolve = resolver(s, (p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        });
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = RoleFixtureOperation(s), phases = <String>[];
          Future<Map<String, dynamic>> prepare() async {
            final snapshot = await resolve();
            final policy = defaultTransactionPolicy(
              network: network,
              request: s['request'],
              snapshot: snapshot,
              now: protocolTime(s['now']),
            );
            // Hashes avoid dumping full transaction fixtures if an assertion fails.
            expect(
              hashJson(snapshot),
              hashJson(s['audit']['material']['snapshot']),
              reason: 'snapshot',
            );
            expect(
              hashJson(policy),
              hashJson(s['audit']['material']['policy']),
              reason: 'policy',
            );
            return {'snapshot': snapshot, 'policy': policy};
          }

          final executor = TbcSigningExecutor(
            engine: engine,
            signer: op,
            authority: TbcOperationAuthority(
              context: s['context'],
              account: account(s['account']),
              requireAuthorized: (m) => expect(m, s['method']),
              isUnlocked: () => true,
              clock: () => protocolTime(s['now']),
            ),
            prepareMaterial: (_, __) => prepare(),
            prepareRoleMaterial: (_, __, additional) {
              expect(hashJson(additional), hashJson(s['signingAccounts']));
              return prepare();
            },
            timing: (stage, _) => phases.add(stage),
          );
          final result = await executor.execute(s['method'], s['request']);
          expect(hashJson(result), hashJson(s['result']));
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(paths.length, paths.toSet().length);
          expect(
            [op.consents, op.binds, op.signs, op.closes, op.advances],
            [
              1,
              1,
              (s['audit']['signatures'] as List).length,
              1,
              (s['audit']['stages'] as List).length - 1,
            ],
          );
          for (final p in [
            'validate:plan',
            'validate:pre-sign',
            'validate:finalized',
          ]) {
            expect(phases.contains(p), true, reason: p);
          }
        }
      },
    );
  }

  // Exercise the production shared worker boundary, not just direct FFI.
  for (final kind in ['create', 'add', 'buy', 'sell', 'remove']) {
    test(
      '$kind new native worker preserves parallel reads and single consent',
      () async {
        final s = copied(cases.firstWhere((v) => v['kind'] == kind));
        s['additionalAccounts'] = s['signingAccounts'];
        final op = RoleFixtureOperation(s),
            paths = <String>[],
            release = Completer<void>();
        op.duringConsent = () async {
          const expected = 2;
          for (var n = 0; paths.length < expected && n < 200; n++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(paths.length, expected);
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
            expect(s['replies'].containsKey(p), true, reason: p);
            return copied(s['replies'][p]);
          },
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'contract173-$kind',
            method: s['method'],
            account: account(s['account']),
            revision: 0,
            navigation: TbcWebViewNavigation(
              webViewInstanceId: 'fixture',
              sessionId: 'fixture',
              navigationId: 'fixture',
              committedUrl: 'https://partner.example/dapp',
              origin: 'https://partner.example',
              createdAt: tbcProtocolTimestamp(DateTime.now()),
            ),
          ),
          request: s['request'],
          requireAuthorized: () {},
          isUnlocked: () => true,
        );
        expect(
          hashJson(result['transactions']),
          hashJson(s['result']['transactions']),
        );
        expect(result['totalFee'], s['result']['totalFee']);
        expect(
          [op.consents, op.binds, op.signs, op.closes],
          [1, 1, (s['audit']['signatures'] as List).length, 1],
        );
        expect(paths, unorderedEquals(s['coldTrace']));
      },
    );
  }
}
