// Frozen Kit/WASM oracle; public synthetic keys only. No HTTP or broadcasting.
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
import 'package:tbc_kit_flutter_dart/src/internal/stablecoin_material.dart';
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
      File('test/fixtures/stablecoin-signing.json').readAsStringSync(),
    );
    library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    // Candidate compute, not the immutable oracle library. Frozen transactions
    // and signatures below remain the expected result of the changed material.
    library = trustedIndexCandidateLibrary();
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  Map<String, dynamic> sample(String name) {
    final s = copied((fixture['cases'] as List).singleWhere((s) => s['name'] == name));
    final historical = name.startsWith('historical');
    final snapshot = s['audit']['material']['snapshot'], p = snapshot['payload'], record = p['contracts'][0], id = record['contractId'];
    // Older capture omitted fields which the real API/SDK already returns.
    // Complete only the API fixture from its independently frozen mint bytes.
    final mintRecord = historical
        ? (p['parents'] as List).singleWhere((r) => r['txid'] == record['creationTxid'])
        : (fixture['cases'][0]['audit']['material']['snapshot']['payload']['parents'] as List)
            .singleWhere((r) => r['txid'] == fixture['cases'][0]['audit']['material']['snapshot']['payload']['contracts'][0]['currentOutpoint']['txid']);
    final mint = inspectTransaction(mintRecord['rawTransaction']);
    final code = mint['outputs'][3]['scriptPubKey'], tape = mint['outputs'][4]['scriptPubKey'];
    final bytes = unhex(tape);
    var supply = BigInt.zero;
    for (var at = 3; at < 51; at += 8) {
      for (var n = 0; n < 8; n++) supply += BigInt.from(bytes[at + n]) << (8 * n);
    }
    final infoPath = '/api/tbc/stablecoin/info/stablecoinid/$id';
    final info = s['replies'][infoPath] ??= {'stablecoin_id': id, 'utxo': {'txid': mint['txid'], 'vout': 0}};
    info.addAll({'code_script': code, 'tape_script': tape, 'supply': '$supply'});
    record['creationTxid'] = id;
    record['indexedFungible'] = {'codeScript': code, 'tapeScript': tape, 'totalSupply': '$supply'};
    final keep = <String>{};
    for (final u in p['utxos']) {
      if (u['classification'] != 'stablecoin') continue;
      final parent = inspectTransaction((p['parents'] as List).singleWhere((r) => r['txid'] == u['txid'])['rawTransaction']);
      keep.add(u['txid']);
      keep.addAll((historical ? legacyFtReferences : tbc20References)(parent, u['vout']));
    }
    (p['parents'] as List).removeWhere((r) => !keep.contains(r['txid']));
    snapshot['snapshotHash'] = hashJson(p);
    if (s['minConfirmations'] == '0') s['audit']['material']['snapshot'] = withoutObservedTip(snapshot);
    for (final trace in ['coldTrace', 'warmTrace']) {
      (s[trace] as List).removeWhere((path) => (path as String).contains('/txraw/') && !keep.contains(path.split('/').last));
      if (!(s[trace] as List).contains(infoPath)) (s[trace] as List).add(infoPath);
      if (s['minConfirmations'] == '0') (s[trace] as List).remove('/api/tbc/nodeinfo');
    }
    return s;
  }
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  StablecoinMaterialReader reader(
    Map s,
    List<Map> trace, {
    Future<void> Function(String)? beforeRead,
  }) {
    Future<Map<String, dynamic>> read(String path) async {
      trace.add({'method': 'GET', 'path': path});
      await beforeRead?.call(path);
      return copied(s['replies'][path]);
    }

    Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
        copied(jsonDecode(engine.call('keyless', method, jsonEncode(input))));
    final shared = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return StablecoinMaterialReader(
      network: network,
      read: read,
      readHistory: shared.parent,
      keyless: keyless,
    );
  }

  Future<Map<String, dynamic>> resolve(StablecoinMaterialReader r, Map s) =>
      r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
  test('historical holder never downloads issuance history or its funding', () async {
    final s = sample('historical-stablecoin-transfer'), trace = <Map>[];
    final allowed = Set<String>.from(s['coldTrace']);
    final snapshot = await resolve(reader(s, trace, beforeRead: (p) async {
      expect(allowed.contains(p), true, reason: 'unnecessary request: $p');
    }), s);
    expect(canonical(snapshot), canonical(s['audit']['material']['snapshot']));
    expect(trace.map((p) => p['path']).toSet().length, trace.length);
  });
  for (final name in [
    'current-coin-transfer',
    'current-coin-receivers',
    'current-coin-payment',
    'current-coin-merge',
    'current-coin-unknown-zero',
    'current-coin-positive-floor',
    'historical-stablecoin-transfer',
    'historical-stablecoin-payment',
    'historical-stablecoin-merge',
  ]) {
    test(
      '$name exact material, policy, cold/warm reads and Native/WASM bytes',
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
            trace.map((p) => canonical(p['path'])),
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
          // A confirmation floor is wallet-owned configuration, never page input.
          policy['payload']['minConfirmations'] = s['minConfirmations'];
          policy['policyHash'] = hashJson(policy['payload']);
          expect(
            canonical(policy),
            canonical(s['audit']['material']['policy']),
          );
          expect(policy['payload']['dustThreshold'], '24');
          final op = FixtureOperation(s), stages = <String>[];
          final executor = TbcSigningExecutor(
            engine: engine,
            signer: op,
            authority: TbcOperationAuthority(
              context: s['context'],
              account: account(s),
              requireAuthorized: (m) => expect(m, s['method']),
              isUnlocked: () => true,
              clock: () => now,
            ),
            prepareMaterial:
                (_, __) async => {'snapshot': snapshot, 'policy': policy},
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
    'current-coin-payment',
    'current-coin-merge',
    'historical-stablecoin-transfer',
    'historical-stablecoin-merge',
  ]) {
    test(
      '$name single worker consent overlaps necessary independent initial reads',
      () async {
        final s = sample(name),
            op = FixtureOperation(s),
            trace = <Map>[],
            release = Completer<void>();
        op.duringConsent = () async {
          for (var i = 0; trace.length < 3 && i < 100; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(trace.length, 3);
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
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'stable-$name',
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
          trace.map((p) => canonical(p['path'])),
          unorderedEquals((s['coldTrace'] as List).map(canonical)),
        );
        expect(
          [op.consents, op.binds, op.signs],
          [1, 1, (s['audit']['signatures'] as List).length],
        );
      },
    );
  }
  for (final mutation in [
    'wrong-contract',
    'bad-parent',
    'duplicate-input',
    'inflated-native-value',
    'admin-method',
  ]) {
    test('stablecoin rejects $mutation before signing', () async {
      final s = sample('current-coin-transfer'), trace = <Map>[];
      final row =
          (s['replies'] as Map).entries
              .singleWhere(
                (e) => (e.key as String).contains('/stablecoin/utxo/'),
              )
              .value['utxos'][0];
      switch (mutation) {
        case 'wrong-contract':
          s['request']['intent']['contractId'] = 'ff' * 32;
        case 'bad-parent':
          s['replies']['/api/tbc/txraw/txid/${row['txid']}']['txraw'] = '00';
        case 'duplicate-input':
          (s['replies'] as Map).entries
              .singleWhere(
                (e) => (e.key as String).contains('/stablecoin/utxo/'),
              )
              .value['utxos']
              .add(copied(row));
        case 'inflated-native-value':
          row['tbc_value'] = '501';
        case 'admin-method':
          s['request']['intent']['type'] = 'tbc20Stablecoin.mint';
      }
      await expectLater(
        resolve(reader(s, trace), s),
        throwsA(anyOf(isA<StateError>(), isA<TypeError>())),
      );
    });
  }
  for (final mutation in ['state-id', 'state-outpoint', 'explicit']) {
    test(
      'historical stablecoin rejects $mutation without latest-state guessing',
      () async {
        final s = sample('historical-stablecoin-transfer'), trace = <Map>[];
        final info =
            s['replies']['/api/tbc/stablecoin/info/stablecoinid/${s['request']['intent']['contractId']}'];
        switch (mutation) {
          case 'state-id':
            info['stablecoin_id'] = 'ff' * 32;
          case 'state-outpoint':
            info['utxo']['vout'] = 1;
          case 'explicit':
            s['request']['constraints']['inputOutpoints'] = [
              {'txid': '22' * 32, 'vout': 0},
            ];
        }
        await expectLater(resolve(reader(s, trace), s), throwsStateError);
      },
    );
  }
  test(
    'current coin fresh positive confirmations cannot be hidden by raw-parent cache',
    () async {
      final s = sample('current-coin-positive-floor'),
          trace = <Map>[],
          r = reader(s, trace);
      await resolve(r, s);
      final path =
          trace.singleWhere(
            (e) => (e['path'] as String).contains('/decode/'),
          )['path'];
      final decode = s['replies'][path];
      decode['confirmations'] = 0;
      await expectLater(resolve(r, s), throwsStateError);
      decode['confirmations'] = 11;
      decode['vout'][0]['scriptPubKey']['hex'] = '00';
      await expectLater(resolve(r, s), throwsStateError);
    },
  );
  test(
    'Coin lock read selection uses height/MTP, not wall clock or ordinary-holder override',
    () async {
      // Deliberate parsed-read doubles exercise discovery, not valid transaction
      // proofs. The real cache/hash and Engine checks are exercised above.
      for (final config in [
        (1001, false, false, true),
        (1000, false, false, false),
        (1800000000, false, false, true),
        (1799999999, false, false, false),
        (1799999999, true, false, true),
        (1001, false, true, true),
      ]) {
        final s = sample('current-coin-transfer');
        final contract = s['request']['intent']['contractId'];
        final row =
            (s['replies'] as Map).entries
                .singleWhere(
                  (e) => (e.key as String).contains('/stablecoin/utxo/'),
                )
                .value['utxos'][0];
        if (config.$2) s['replies']['/api/tbc/nodeinfo'].remove('mediantime');
        if (config.$3)
          s['request']['constraints']['inputOutpoints'] = [
            {'txid': '22' * 32, 'vout': 0},
            {'txid': row['txid'], 'vout': row['index']},
          ];
        final r = StablecoinMaterialReader(
          network: network,
          read: (p) async => copied(s['replies'][p]),
          keyless: (_, input) => input['phase'] == 'identifyPairs'
              ? {'identities': [{'family': 'tbc20Stablecoin', 'generation': 'current'}]}
              : {'codes': [{'standardId': 'tbc20-stablecoin', 'adminPubkeyHash': 'ff' * 20}]},
          readHistory: (id) async {
            final p = inspectTransaction(
              s['replies']['/api/tbc/txraw/txid/$id']['txraw'],
              id,
            );
            if (id == contract)
              p['outputs'][1]['scriptPubKey'] = '76a914${'ff' * 20}88ac6a';
            if (id == row['txid']) {
              final tape = unhex(
                p['outputs'][row['index'] + 1]['scriptPubKey'],
              );
              for (var i = 0; i < 4; i++)
                tape[tape.length - 14 + i] = (config.$1 >> (8 * i)) & 255;
              p['outputs'][row['index'] + 1]['scriptPubKey'] = hex(tape);
              expect(coinTapeLockTime(hex(tape)), config.$1);
            }
            return p;
          },
        );
        if (config.$4)
          await expectLater(resolve(r, s), throwsStateError);
        else
          expect((await resolve(r, s))['payload']['utxos'], hasLength(2));
      }
    },
  );
}
