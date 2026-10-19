// Synthetic public funds, frozen immutable Kit/WASM comparator; no broadcast.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    // Pre-1.7 lpPlan creation is retired, not a current positive oracle.
    // Keep that file intact; use the independently frozen explicit-fee vectors.
    final current = jsonDecode(
      File('../contract173-upgrade/high-level173.json').readAsStringSync(),
    );
    final cases =
        (current['cases'] as List)
            .where(
              (s) =>
                  s['kind'] == 'create' &&
                  s['request']['intent']['controllers'] == null,
            )
            .map((s) => copied(s))
            .toList();
    final indexed = IndexedFixture(cases);
    for (final s in cases) indexed.projectAmm(s);
    fixture = {'cases': cases};
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
  });
  Map<String, dynamic> sample(int i) => copied(fixture['cases'][i]);
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  AmmMaterialReader reader(ApiRead read) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (m, i) =>
              copied(jsonDecode(engine.call('keyless', m, jsonEncode(i)))),
    );
    return AmmMaterialReader(
      network: network,
      funding: NativeMaterialReader(network: network, read: read),
      readHistory: history.parent,
    );
  }

  TbcSigningExecutor executor(
    Map s,
    FixtureOperation op,
    Future<Map<String, dynamic>> Function(
      Map<String, dynamic>,
      Map<String, dynamic>,
    )
    prepare,
  ) => TbcSigningExecutor(
    engine: engine,
    signer: op,
    authority: TbcOperationAuthority(
      context: s['context'],
      account: account(s),
      requireAuthorized: (_) {},
      isUnlocked: () => true,
      clock: () => protocolTime(s['now']),
    ),
    prepareMaterial: prepare,
  );
  Future<Map<String, dynamic>> material(
    AmmMaterialReader r,
    Map s,
    Map<String, dynamic> request,
    Map<String, dynamic> a,
  ) async {
    final snapshot = await r.resolve(
      request: request,
      account: a,
      now: protocolTime(s['now']),
      snapshotId: s['snapshotId'],
    );
    final policy = defaultTransactionPolicy(
      network: network,
      request: request,
      now: protocolTime(s['now']),
      snapshot: snapshot,
    );
    return {'snapshot': snapshot, 'policy': policy};
  }

  for (var i = 0; i < 4; i++) {
    test(
      'AMM creation $i matches frozen reads, material, fee and stages',
      () async {
        final s = sample(i), paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          return copied(s['replies'][p]);
        });
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = FixtureOperation(s);
          final result = await executor(s, op, (request, a) async {
            final m = await material(r, s, request, a);
            expect(
              canonical(m['snapshot']),
              canonical(s['audit']['material']['snapshot']),
            );
            expect(
              canonical(m['policy']),
              canonical(s['audit']['material']['policy']),
            );
            return m;
          }).execute(s['method'], s['request']);
          expect(canonical(result), canonical(s['result']));
          expect(
            [op.consents, op.binds, op.advances, op.signs, op.closes],
            [1, 1, 1, 2, 1],
          );
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(paths.length, 2);
        }
      },
    );
  }
  test(
    'AMM worker overlaps funding/identity with one consent, no stage reads',
    () async {
      final s = sample(0), op = FixtureOperation(sample(0)), paths = <String>[];
      final released = Completer<void>();
      op.duringConsent = () async {
        for (var n = 0; paths.length < 2 && n < 200; n++) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
        expect(paths.length, 2);
        expect(op.binds, 0);
        released.complete();
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
          await released.future;
          return copied(s['replies'][p]);
        },
      );
      addTearDown(worker.close);
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'amm-create',
          method: s['method'],
          account: account(s),
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
      expect(
        canonical(result['transactions']),
        canonical(s['result']['transactions']),
      );
      expect(result['totalFee'], s['result']['totalFee']);
      expect(
        [op.consents, op.binds, op.advances, op.signs, paths.length],
        [1, 1, 1, 2, 2],
      );
    },
  );
  for (final bad in [
    'old-pool',
    'plan',
    'rate',
    'controllers',
    'missing-lock',
  ]) {
    test(
      'AMM invalid request $bad has no consent, reads or signatures',
      () async {
        final s = sample(0), op = FixtureOperation(sample(0));
        switch (bad) {
          case 'old-pool':
            s['request']['intent']['type'] = 'tbc.pool.create';
          case 'plan':
            s['request']['intent']['lpPlan'] = 7;
          case 'rate':
            s['request']['intent']['serviceFeeRate'] = 36;
          case 'controllers':
            s['request']['intent']['controllers'] = ['00' * 20, '00' * 20];
          case 'missing-lock':
            s['request']['intent'].remove('lpTimelock');
        }
        var prepares = 0;
        await expectLater(
          executor(s, op, (_, __) async {
            prepares++;
            return copied(s['audit']['material']);
          }).execute(s['method'], s['request']),
          throwsA(isA<StateError>()),
        );
        expect([prepares, op.consents, op.binds, op.signs], [0, 0, 0, 0]);
      },
    );
  }
  for (final bad in [
    'indexed-code',
    'indexed-tape',
    'funds',
    'selected-missing',
  ]) {
    test('AMM malformed material $bad never signs', () async {
      final s = sample(bad == 'selected-missing' ? 3 : 0),
          op = FixtureOperation(sample(0));
      final id = s['request']['intent']['ftContractId'];
      if (bad == 'indexed-code')
        s['replies']['/api/tbc/ft/info/contract/$id']['code_script'] = '00';
      if (bad == 'indexed-tape')
        s['replies']['/api/tbc/ft/info/contract/$id']['tape_script'] = '00';
      final native =
          s['replies']['/api/tbc/utxo/address/${s['account']['address']}']['utxos']
              as List;
      if (bad == 'funds') {
        for (final u in native) {
          u['value'] = '20';
        }
      }
      if (bad == 'selected-missing') {
        s['request']['constraints']['inputOutpoints'] = [
          {'txid': native[0]['txid'], 'vout': native[0]['index']},
        ];
        native.removeWhere(
          (u) =>
              u['txid'] ==
              s['request']['constraints']['inputOutpoints'][0]['txid'],
        );
      }
      final r = reader((p) async => copied(s['replies'][p]));
      await expectLater(
        executor(
          s,
          op,
          (req, a) => material(r, s, req, a),
        ).execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect([op.binds, op.signs], [0, 0]);
    });
  }
}
