// Immutable Kit/WASM expectations and actual Native computation; no live keys.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';

void main() {
  late Map<String, dynamic> fixture, library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/nft-signing.json').readAsStringSync(),
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
  });
  Map<String, dynamic> sample(String name) {
    final s = copied((fixture['cases'] as List).singleWhere((s) => s['name'] == name));
    final snapshot = s['audit']['material']['snapshot'], p = snapshot['payload'], record = p['contracts'][0];
    final parent = inspectTransaction((p['parents'] as List).singleWhere((r) => r['txid'] == record['currentOutpoint']['txid'])['rawTransaction']);
    final keep = {record['contractId'], parent['txid'], parent['inputs'][0]['txid']};
    (p['parents'] as List).removeWhere((r) => !keep.contains(r['txid']));
    snapshot['snapshotHash'] = hashJson(p);
    if (s['minConfirmations'] == '0') s['audit']['material']['snapshot'] = withoutObservedTip(snapshot);
    for (final trace in ['coldTrace', 'warmTrace']) {
      (s[trace] as List).removeWhere((row) => row['path'] == '/api/tbc/txo/status' ||
          s['minConfirmations'] == '0' && row['path'] == '/api/tbc/nodeinfo' ||
          (row['path'] as String).contains('/txraw/') && !keep.contains((row['path'] as String).split('/').last));
    }
    return s;
  }
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  NftMaterialReader reader(Map s, List<Map> trace) {
    Future<Map<String, dynamic>> read(String path) async {
      trace.add({'method': 'GET', 'path': path});
      return copied(s['replies'][path]);
    }

    Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
        copied(jsonDecode(engine.call('keyless', method, jsonEncode(input))));
    final shared = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return NftMaterialReader(
      network: network,
      read: read,
      readHistory: shared.parent,
      keyless: keyless,
      status: (txos) async {
        trace.add({'method': 'POST', 'path': '/api/tbc/txo/status'});
        expect(canonical({'txos': txos}), canonical(s['statusBody']));
        return copied(s['statusReply']);
      },
    );
  }

  Future<Map<String, dynamic>> resolve(
    NftMaterialReader r,
    Map s, {
    String? floor,
  }) => r.resolve(
    request: s['request'],
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
    minConfirmations: floor ?? s['minConfirmations'],
  );
  for (final name in [
    'current-nft-mint-output',
    'current-nft-descendant',
    'current-nft-payment',
    'current-nft-unknown-zero',
    'historical-nft-v2',
    'historical-nft-v2-descendant',
    'historical-nft-v0',
    'historical-nft-v0-descendant',
    'historical-nft-v1',
    'historical-nft-v1-descendant',
  ]) {
    test(
      '$name frozen material/policy/cold-warm reads and Native/WASM parity',
      () async {
        final s = sample(name),
            trace = <Map>[],
            r = reader(s, trace),
            now = protocolTime(s['now']);
        for (var pass = 0; pass < 2; pass++) {
          trace.clear();
          final snapshot = await resolve(r, s);
          expect(
            canonical(snapshot),
            canonical(s['audit']['material']['snapshot']),
          );
          expect(
            trace.map(canonical),
            unorderedEquals(
              (s[pass == 0 ? 'coldTrace' : 'warmTrace'] as List).map(canonical),
            ),
          );
          final policy = defaultTransactionPolicy(
            network: network,
            request: s['request'],
            now: now,
            snapshot: snapshot,
          );
          expect(
            canonical(policy),
            canonical(s['audit']['material']['policy']),
          );
          final op = FixtureOperation(s), stages = <String>[];
          final executor = TbcSigningExecutor(
            engine: engine,
            signer: op,
            authority: TbcOperationAuthority(
              context: s['context'],
              account: account(s),
              requireAuthorized: (method) => expect(method, s['method']),
              isUnlocked: () => true,
              clock: () => now,
            ),
            prepareMaterial:
                (request, account) async => {
                  'snapshot': snapshot,
                  'policy': policy,
                },
            timing: (stage, _) => stages.add(stage),
          );
          expect(
            canonical(await executor.execute(s['method'], s['request'])),
            canonical(s['result']),
          );
          expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 3, 1]);
          for (final stage in [
            'validate:plan',
            'validate:pre-sign',
            'validate:finalized',
          ])
            expect(stages.where((s) => s == stage), hasLength(1));
        }
      },
    );
  }
  for (final name in ['current-nft-payment', 'historical-nft-v1-descendant']) {
    test('$name same worker one consent overlaps first three reads', () async {
      final s = sample(name),
          op = FixtureOperation(s),
          trace = <Map>[],
          release = Completer<void>();
      op.duringConsent = () async {
        for (var i = 0; trace.length < 2 && i < 100; i++)
          await Future<void>.delayed(const Duration(milliseconds: 1));
        expect(trace.length, 2);
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
        read: (path) async {
          trace.add({'method': 'GET', 'path': path});
          await release.future;
          return copied(s['replies'][path]);
        },
        txoStatus: (txos) async {
          trace.add({'method': 'POST', 'path': '/api/tbc/txo/status'});
          expect(canonical({'txos': txos}), canonical(s['statusBody']));
          return copied(s['statusReply']);
        },
      );
      addTearDown(worker.close);
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'nft-$name',
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
        trace.map(canonical),
        unorderedEquals((s['coldTrace'] as List).map(canonical)),
      );
      expect([op.consents, op.binds, op.signs], [1, 1, 3]);
    });
  }
  for (final mutation in [
    'wrong-collection',
    'alias-conflict',
    'script-alias-conflict',
    'absent-current-index',
    'bad-parent',
  ]) {
    test('NFT rejects $mutation before signing', () async {
      final s = sample('current-nft-descendant'), trace = <Map>[];
      final row =
          (s['replies'] as Map).entries
              .singleWhere((e) => (e.key as String).contains('/nft/utxo/'))
              .value['utxos'][0];
      switch (mutation) {
        case 'wrong-collection':
          row['collection_id'] = 'ff' * 32;
        case 'alias-conflict':
          row['nft_id'] = 'ff' * 32;
        case 'script-alias-conflict':
          row['scriptPubKey'] = '00';
        case 'absent-current-index':
          (s['replies'] as Map).entries.singleWhere((e) => (e.key as String).contains('/nft/utxo/')).value['utxos'] = [];
        case 'bad-parent':
          s['replies']['/api/tbc/txraw/txid/${row['txid']}']['txraw'] = '00';
      }
      await expectLater(
        resolve(reader(s, trace), s),
        throwsA(isA<StateError>()),
      );
    });
  }
  test(
    'NFT total 128-input bound includes the two NFT outputs; explicit selection may reduce index candidates',
    () async {
      final s = sample('current-nft-mint-output'), trace = <Map>[];
      final native =
          s['replies']['/api/tbc/utxo/address/${s['account']['address']}'];
      List<Map<String, dynamic>> points(int count) => List.generate(
        count,
        (i) => {
          'txid': i.toRadixString(16).padLeft(64, '0'),
          'index': 0,
          'value': '10000000',
          'height': 990,
        },
      );
      native['utxos'] = points(126);
      final r = reader(s, trace);
      expect((await resolve(r, s))['payload']['utxos'], hasLength(128));
      native['utxos'] = points(127);
      await expectLater(resolve(r, s), throwsStateError);
      native['utxos'] = points(129);
      s['request']['constraints']['inputOutpoints'] = [
        {'txid': native['utxos'][128]['txid'], 'vout': 0},
      ];
      expect((await resolve(r, s))['payload']['utxos'], hasLength(3));
    },
  );
  test(
    'unknown height zero floor has no decode; positive floor needs a fresh proof',
    () async {
      final s = sample('current-nft-unknown-zero'),
          trace = <Map>[],
          r = reader(s, trace);
      await resolve(r, s);
      expect(
        trace.where((p) => (p['path'] as String).contains('/decode/')),
        isEmpty,
      );
      trace.clear();
      final good = await resolve(r, s, floor: '1');
      expect((good['payload']['utxos'] as List).last['confirmations'], '11');
      expect(
        trace.where((p) => (p['path'] as String).contains('/decode/')),
        hasLength(1),
      );
      final decoded =
          (s['replies'] as Map).entries
              .singleWhere((e) => (e.key as String).contains('/decode/'))
              .value;
      decoded.remove('confirmations');
      await expectLater(resolve(r, s, floor: '1'), throwsA(isA<StateError>()));
    },
  );
  test(
    'trusted NFT index needs no redundant status HTTP; signed result stays identical',
    () async {
      final s = sample('current-nft-mint-output'), op = FixtureOperation(s);
      final worker = await TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: library['path'],
          sha256: library['sha256'],
        ),
        network: network,
        backend: FixtureBackend(op),
        read: (path) async => copied(s['replies'][path]),
      );
      addTearDown(worker.close);
      final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'missing-status',
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
      expect(canonical(result['transactions']), canonical(s['result']['transactions']));
      expect(op.signs, 3);
      expect(op.binds, 1);
    },
  );
}
