// Frozen current NFT issuance; public, fabricated funds, no broadcast.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/collection_material.dart';
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

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/nft-mint-signing.json').readAsStringSync(),
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
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    if (s['minConfirmations'] == '0') {
      rebindExpectedSnapshot(s, withoutObservedTip(s['audit']['material']['snapshot']));
      for (final key in ['coldTrace', 'warmTrace']) {
        (s[key] as List).removeWhere((row) => row['path'] == '/api/tbc/nodeinfo');
      }
    }
    return s;
  }
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  CollectionMaterialReader reader(Map s, List<Map> trace) {
    Future<Map<String, dynamic>> read(String path) async {
      trace.add({'method': 'GET', 'path': path});
      return copied(s['replies'][path]);
    }

    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, jsonEncode(input))),
          ),
    );
    return CollectionMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
      status: (points) async {
        trace.add({'method': 'POST', 'path': '/api/tbc/txo/status'});
        expect(canonical({'txos': points}), canonical(s['statusBody']));
        return copied(s['statusReply']);
      },
    );
  }

  TbcSigningExecutor executor(
    Map s,
    FixtureOperation op,
    CollectionMaterialReader r,
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
    prepareMaterial: (request, account) async {
      final snapshot = await r.resolve(
        request: request,
        account: account,
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
      final policy = defaultTransactionPolicy(
        network: network,
        request: request,
        now: protocolTime(s['now']),
        snapshot: snapshot,
      );
      // An explicit host floor is part of policy, not DApp input.
      policy['payload']['minConfirmations'] = s['minConfirmations'];
      policy['policyHash'] = hashJson(policy['payload']);
      expect(
        canonical(snapshot),
        canonical(s['audit']['material']['snapshot']),
      );
      expect(canonical(policy), canonical(s['audit']['material']['policy']));
      return {'snapshot': snapshot, 'policy': policy};
    },
  );
  for (var i = 0; i < 7; i++) {
    test(
      'NFT mint $i exact frozen cold/warm material, policy, fee and signed stages',
      () async {
        final s = sample(i), trace = <Map>[], r = reader(s, trace);
        for (var warm = 0; warm < 2; warm++) {
          trace.clear();
          final op = FixtureOperation(s);
          final result = await executor(
            s,
            op,
            r,
          ).execute(s['method'], s['request']);
          expect(canonical(result), canonical(s['result']));
          final expectedTrace = List<Map>.from(
            s[warm == 0 ? 'coldTrace' : 'warmTrace'],
          );
          if (i == 6 && warm == 0) {
            // The fresh decode already supplies hash-checked raw bytes.
            final decode =
                expectedTrace.singleWhere(
                      (entry) =>
                          (entry['path'] as String).contains('/decode/txid/'),
                    )['path']
                    as String;
            expectedTrace.removeWhere(
              (entry) =>
                  entry['path'] == decode.replaceFirst('/decode/', '/txraw/'),
            );
            expect(expectedTrace.length, (s['coldTrace'] as List).length - 1);
          }
          expect(
            trace.map(canonical),
            unorderedEquals(expectedTrace.map(canonical)),
          );
          expect(
            [op.consents, op.binds, op.advances, op.signs, op.closes],
            [
              1,
              1,
              (s['audit']['stages'] as List).length - 1,
              (s['audit']['signatures'] as List).length,
              1,
            ],
          );
        }
      },
    );
  }
  for (final i in [1, 4]) {
    test(
      'NFT batch $i shares prefetch and one consent with no between-stage reads',
      () async {
        final s = sample(i), op = FixtureOperation(sample(i)), trace = <Map>[];
        final release = Completer<void>();
        op.duringConsent = () async {
          for (var n = 0; trace.length < 3 && n < 200; n++) {
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
          txoStatus: (points) async {
            trace.add({'method': 'POST', 'path': '/api/tbc/txo/status'});
            expect(canonical({'txos': points}), canonical(s['statusBody']));
            return copied(s['statusReply']);
          },
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'mint-$i',
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
        expect([op.consents, op.binds, op.advances, op.signs], [1, 1, 1, 4]);
        expect(
          trace.map(canonical),
          unorderedEquals((s['coldTrace'] as List).map(canonical)),
        );
      },
    );
  }
  for (final bad in [
    'spent',
    'wrong-id',
    'wrong-script',
    'unexpected-slot',
    'missing-status',
    'index-amount',
    'duplicate-index',
  ]) {
    test('NFT selected slot $bad cannot reach signing', () async {
      final s = sample(4), op = FixtureOperation(sample(4)), trace = <Map>[];
      final row = s['statusReply']['results'][0];
      final path = (s['replies'] as Map).keys.singleWhere(
        (p) => (p as String).contains('/utxo/scriptpubkeyhash/'),
      );
      switch (bad) {
        case 'spent':
          row['status']['spent'] = true;
        case 'wrong-id':
          row['txid'] = '00' * 32;
        case 'wrong-script':
          row['scriptpubkey'] = '00';
        case 'unexpected-slot':
          row['index'] = 2;
        case 'missing-status':
          s['statusReply']['results'] = [];
        case 'index-amount':
          s['replies'][path]['utxos'][0]['value'] = 99;
        case 'duplicate-index':
          (s['replies'][path]['utxos'] as List).add(
            copied(s['replies'][path]['utxos'][0]),
          );
      }
      await expectLater(
        executor(s, op, reader(s, trace)).execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect([op.binds, op.signs, op.closes], [0, 0, 1]);
    });
  }
  for (final bad in ['duplicate-slot', 'zero-slot', 'old-mint']) {
    test('invalid mint $bad rejected before reads/approval', () async {
      final s = sample(1), op = FixtureOperation(sample(1)), trace = <Map>[];
      switch (bad) {
        case 'duplicate-slot':
          s['request']['intent']['items'][1]['slot'] = 1;
        case 'zero-slot':
          s['request']['intent']['items'][0]['slot'] = 0;
        case 'old-mint':
          s['request']['intent']['type'] = 'tbc.nft.mint';
      }
      await expectLater(
        executor(s, op, reader(s, trace)).execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect([op.consents, op.signs], [0, 0]);
      expect(trace, isEmpty);
    });
  }
  test('cancel batch before next stage never signs the second NFT', () async {
    final s = sample(1), op = FixtureOperation(sample(1)), trace = <Map>[];
    op.duringAdvance = () async {
      op.active = false;
    };
    await expectLater(
      executor(s, op, reader(s, trace)).execute(s['method'], s['request']),
      throwsA(isA<StateError>()),
    );
    expect([op.consents, op.advances, op.signs, op.closes], [1, 1, 2, 1]);
  });
}
