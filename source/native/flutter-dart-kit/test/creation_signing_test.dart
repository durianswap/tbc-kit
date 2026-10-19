// Current creation only. Fabricated public funding is never broadcast.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_profiles.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/creation-signing.json').readAsStringSync(),
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
  Map<String, dynamic> sample(int i) => copied(fixture['cases'][i]);
  test(
    'Dart and native capability projections advertise the same enabled subset',
    () {
      for (final spec in [
        (
          'platform/ios/Classes/NativeWalletHost.swift',
          RegExp(r'"([^"]+)":\["1.0"\]'),
          '"transactionBundleSize":32',
        ),
        (
          'platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt',
          RegExp(r'"([^"]+)" to listOf\("1.0"\)'),
          '"transactionBundleSize" to 32',
        ),
      ]) {
        final source = File(spec.$1).readAsStringSync();
        final line = source
            .split('\n')
            .singleWhere((s) => s.contains('"intents"'));
        expect(
          spec.$2.allMatches(line).map((m) => m.group(1)).toSet(),
          transactionTaskLimits.keys.toSet(),
        );
        expect(line, contains(spec.$3));
      }
      expect(maxTransactionBundleSize, 32);
    },
  );
  TbcAccount account(Map s) => TbcAccount(
    network: TbcNetwork.testnet,
    address: s['account']['address'],
    publicKey: s['account']['publicKey'],
  );
  TbcSigningExecutor executor(
    Map s,
    FixtureOperation op, {
    Future<Map<String, dynamic>> Function(
      Map<String, dynamic>,
      Map<String, dynamic>,
    )?
    prepare,
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
  );

  for (var i = 0; i < 6; i++) {
    test(
      'creation $i matches frozen material, policy, fee and all signed bytes',
      () async {
        final s = sample(i), paths = <String>[];
        final reader = NativeMaterialReader(
          network: network,
          read: (path) async {
            paths.add(path);
            return copied(s['replies'][path]);
          },
        );
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = FixtureOperation(s);
          var prepares = 0;
          final result = await executor(
            s,
            op,
            prepare: (r, a) async {
              prepares++;
              final snapshot = await reader.resolve(
                request: r,
                account: a,
                now: protocolTime(s['now']),
                snapshotId: s['snapshotId'],
              );
              final policy = defaultTransactionPolicy(
                network: network,
                request: r,
                now: protocolTime(s['now']),
                snapshot: snapshot,
              );
              expect(
                canonical(snapshot),
                canonical(withoutObservedTip(s['audit']['material']['snapshot'])),
              );
              expect(
                canonical(policy),
                canonical(s['audit']['material']['policy']),
              );
              return {'snapshot': snapshot, 'policy': policy};
            },
          ).execute(s['method'], s['request']);
          expect(canonical(result), canonical(s['result']));
          expect(
            [prepares, op.consents, op.binds, op.advances, op.signs, op.closes],
            [
              1,
              1,
              1,
              (s['audit']['stages'] as List).length - 1,
              (s['audit']['signatures'] as List).length,
              1,
            ],
          );
          expect(
            paths,
            unorderedEquals((s[warm == 0 ? 'coldTrace' : 'warmTrace'] as List).where((p) => p != '/api/tbc/nodeinfo')),
          );
          expect(
            paths.length,
            1,
          ); // No parent GET, second preparation or per-stage read.
        }
      },
    );
  }
  for (final i in [1, 4]) {
    test(
      'creation $i worker starts the UTXO read before one consent',
      () async {
        final s = sample(i),
            op = FixtureOperation(sample(i)),
            paths = <String>[];
        final release = Completer<void>();
        op.duringConsent = () async {
          for (var n = 0; paths.isEmpty && n < 200; n++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(paths.length, 1);
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
            operationId: 'create-$i',
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
        expect([op.consents, op.binds, paths.length], [1, 1, 1]);
      },
    );
  }
  for (final kind in [
    'negative-decimals',
    'fractional-decimals',
    'empty-name',
    'negative-supply',
    'old-ft',
    'old-collection',
  ]) {
    test(
      'invalid/old creation $kind rejected before consent and reads',
      () async {
        final s = sample(0), op = FixtureOperation(sample(0));
        switch (kind) {
          case 'negative-decimals':
            s['request']['intent']['decimals'] = -1;
          case 'fractional-decimals':
            s['request']['intent']['decimals'] = 1.5;
          case 'empty-name':
            s['request']['intent']['name'] = '';
          case 'negative-supply':
            s['request']['intent']['initialSupply'] = '-1';
          case 'old-ft':
            s['request']['intent']['type'] = 'tbc.ft.create';
          case 'old-collection':
            s['request']['intent']['type'] = 'tbc.collection.create';
        }
        var prepares = 0;
        await expectLater(
          executor(
            s,
            op,
            prepare: (_, __) async {
              prepares++;
              return copied(s['audit']['material']);
            },
          ).execute(s['method'], s['request']),
          throwsA(isA<StateError>()),
        );
        expect([prepares, op.consents, op.signs, op.closes], [0, 0, 0, 1]);
      },
    );
  }
  test('three-stage creation cancellation never signs descendant', () async {
    final s = sample(1), op = FixtureOperation(sample(1));
    op.duringAdvance = () async {
      if (op.advances == 2) op.active = false;
    };
    await expectLater(
      executor(s, op).execute(s['method'], s['request']),
      throwsA(isA<StateError>()),
    );
    expect([op.consents, op.advances, op.signs, op.closes], [1, 2, 3, 1]);
  });
  test(
    'creation warning exception cannot authorize unknown or unrelated warnings',
    () {
      final s = sample(1),
          request = s['request'],
          p = copied(s['audit']['plan']['payload']);
      expect(coveredTransactionWarnings(request, p), true);
      for (final warnings in [
        null,
        ['MULTI_TRANSACTION'],
        ['OTHER', 'MAINTENANCE_TRANSACTION'],
        ['MULTI_TRANSACTION', 'MAINTENANCE_TRANSACTION', 'OTHER'],
      ]) {
        final altered = copied(p);
        altered['preview']['warnings'] = warnings;
        expect(coveredTransactionWarnings(request, altered), false);
      }
      final altered = copied(p);
      altered['transactions'][0]['role'] = 'primary';
      expect(coveredTransactionWarnings(request, altered), false);
      final other = copied(request);
      other['intent']['type'] = 'tbc20.transfer';
      expect(coveredTransactionWarnings(other, p), false);
    },
  );
  test(
    'missing explicit creation funding does not fall back to another input',
    () async {
      final s = sample(2), paths = <String>[];
      s['request']['constraints']['inputOutpoints'][0]['txid'] = 'aa' * 32;
      final reader = NativeMaterialReader(
        network: network,
        read: (p) async {
          paths.add(p);
          return copied(s['replies'][p]);
        },
      );
      await expectLater(
        reader.resolve(
          request: s['request'],
          account: s['account'],
          now: protocolTime(s['now']),
          snapshotId: s['snapshotId'],
        ),
        throwsA(isA<StateError>()),
      );
      expect(paths.length, 1);
    },
  );
}
