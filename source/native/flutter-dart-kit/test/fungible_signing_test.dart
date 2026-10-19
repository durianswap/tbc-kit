// Frozen Kit/WASM oracle vs actual pinned Native Engine; no live requests/keys.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
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
      File('test/fixtures/fungible-signing.json').readAsStringSync(),
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
    final s = copied((fixture['cases'] as List).singleWhere((c) => c['name'] == name));
    final snapshot = s['audit']['material']['snapshot'], p = snapshot['payload'], record = p['contracts'][0], id = record['contractId'];
    final origin = inspectTransaction((p['parents'] as List).singleWhere((r) => r['txid'] == id)['rawTransaction']);
    final code = origin['outputs'][0]['scriptPubKey'], tape = origin['outputs'][1]['scriptPubKey'], bytes = unhex(tape);
    var supply = BigInt.zero;
    for (var at = 3; at < 51; at += 8) {
      for (var n = 0; n < 8; n++) supply += BigInt.from(bytes[at + n]) << (8 * n);
    }
    final infoPath = '/api/tbc/ft/info/contract/$id';
    s['replies'][infoPath] = {'code_script': code, 'tape_script': tape, 'amount': '$supply'};
    record['indexedFungible'] = {'codeScript': code, 'tapeScript': tape, 'totalSupply': '$supply'};
    final keep = <String>{};
    for (final u in p['utxos']) {
      if (u['classification'] != 'ft') continue;
      final parent = inspectTransaction((p['parents'] as List).singleWhere((r) => r['txid'] == u['txid'])['rawTransaction']);
      keep.add(u['txid']);
      keep.addAll((name.startsWith('current') ? tbc20References : legacyFtReferences)(parent, u['vout']));
    }
    (p['parents'] as List).removeWhere((r) => !keep.contains(r['txid']));
    s['audit']['material']['snapshot'] = withoutObservedTip(snapshot);
    for (final trace in ['coldTrace', 'warmTrace']) {
      (s[trace] as List).removeWhere((path) => path == '/api/tbc/nodeinfo' ||
          (path as String).contains('/txraw/') && !keep.contains(path.split('/').last));
      (s[trace] as List).add(infoPath);
    }
    return s;
  }
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  Tbc20MaterialReader reader(
    Map s,
    List<String> paths, {
    KeylessCall? identify,
  }) => Tbc20MaterialReader(
    network: network,
    read: (path) async {
      paths.add(path);
      return copied(s['replies'][path]);
    },
    keyless:
        identify ??
        (method, input) => copied(
          jsonDecode(engine.call('keyless', method, jsonEncode(input))),
        ),
  );

  for (final name in [
    'current-transfer-multiple-inputs',
    'current-transfer-receivers',
    'current-merge',
    'current-merge-token-only',
    'historical-transfer',
    'historical-transfer-payment',
    'historical-merge',
  ]) {
    test(
      '$name identical cold/warm material, policy and Native/WASM signed bytes',
      () async {
        final s = sample(name),
            paths = <String>[],
            r = reader(s, paths),
            now = protocolTime(s['now']);
        for (var i = 0; i < 2; i++) {
          paths.clear();
          final snapshot = await r.resolve(
            request: s['request'],
            account: s['account'],
            now: now,
            snapshotId: s['snapshotId'],
          );
          expect(
            canonical(snapshot),
            canonical(s['audit']['material']['snapshot']),
          );
          // Concurrent completion order is not material; membership/count is.
          expect(paths, unorderedEquals(s[i == 0 ? 'coldTrace' : 'warmTrace']));
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
          expect(
            [op.consents, op.binds, op.signs, op.closes],
            [1, 1, (s['audit']['signatures'] as List).length, 1],
          );
          for (final stage in [
            'validate:plan',
            'validate:pre-sign',
            'validate:finalized',
          ]) {
            expect(stages.where((s) => s == stage), hasLength(1));
          }
        }
      },
    );
  }
  for (final name in [
    'current-merge',
    'historical-transfer-payment',
    'historical-merge',
  ]) {
    test(
      '$name shared worker resolves policy after reads and overlaps consent',
      () async {
        final s = sample(name),
            op = FixtureOperation(s),
            paths = <String>[],
            release = Completer<void>();
        op.duringConsent = () async {
          for (var i = 0; paths.length < 3 && i < 100; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(paths.length, 3);
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
            paths.add(path);
            await release.future;
            return copied(s['replies'][path]);
          },
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'fungible-$name',
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
        expect(paths, unorderedEquals(s['coldTrace']));
        expect(
          [op.consents, op.binds, op.signs],
          [1, 1, (s['audit']['signatures'] as List).length],
        );
      },
    );
  }
  test(
    'unrecognized asset family never poisons verified origin cache',
    () async {
      final s = sample('current-merge'), paths = <String>[];
      var invalid = true;
      final r = reader(
        s,
        paths,
        identify: (method, input) {
          final hint = copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input))),
          );
          if (invalid) hint['identities'][0]['family'] = 'stablecoin';
          return hint;
        },
      );
      Future<Map<String, dynamic>> resolve() => r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
      );
      await expectLater(resolve(), throwsA(isA<StateError>()));
      invalid = false;
      expect(
        canonical(await resolve()),
        canonical(s['audit']['material']['snapshot']),
      );
    },
  );
  test(
    'unbound, changed or cross-asset material cannot choose default policy',
    () {
      final s = sample('historical-transfer');
      for (final snapshot in <Map<String, dynamic>?>[
        null,
        {'payload': {}, 'snapshotHash': 'bad'},
        copied(sample('current-merge')['audit']['material']['snapshot']),
      ]) {
        expect(
          () => defaultTransactionPolicy(
            network: network,
            request: s['request'],
            now: protocolTime(s['now']),
            snapshot: snapshot,
          ),
          throwsA(isA<StateError>()),
        );
      }
    },
  );
}
