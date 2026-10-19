// Dependent transaction oracle: fabricated public fixture, never broadcast.
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
      File('test/fixtures/staged-signing.json').readAsStringSync(),
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
  Map<String, dynamic> sample([int index = 0]) {
    final s = copied(fixture['cases'][index]);
    indexed.projectHolder(s);
    return s;
  }
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
    DateTime Function()? now,
    TbcExecutionTiming? timing,
  }) => TbcSigningExecutor(
    engine: engine,
    signer: op,
    authority: TbcOperationAuthority(
      context: s['context'],
      account: account(s),
      requireAuthorized: (_) {},
      isUnlocked: () => true,
      clock: now ?? () => protocolTime(s['now']),
    ),
    prepareMaterial: prepare ?? (_, __) async => copied(s['audit']['material']),
    timing: timing,
  );

  for (var index = 0; index < 2; index++) {
    test(
      'staged FT $index exact material/fee/bytes, one approval, no stage reads',
      () async {
        final s = sample(index), paths = <String>[];
        final reader = Tbc20MaterialReader(
          network: network,
          read: (path) async {
            paths.add(path);
            return copied(s['replies'][path]);
          },
          keyless:
              (method, input) => copied(
                jsonDecode(engine.call('keyless', method, jsonEncode(input))),
              ),
        );
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          final op = FixtureOperation(s), phases = <String>[];
          var prepares = 0;
          final result = await executor(
            s,
            op,
            prepare: (request, account) async {
              prepares++;
              final snapshot = await reader.resolve(
                request: request,
                account: account,
                now: protocolTime(s['now']),
                snapshotId: s['snapshotId'],
              );
              final policy = defaultTransactionPolicy(
                network: network,
                request: request,
                now: protocolTime(s['now']),
                snapshot: snapshot,
              );
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
            timing: (name, _) => phases.add(name),
          ).execute(s['method'], s['request']);
          expect(canonical(result), canonical(s['result']));
          expect(
            [prepares, op.consents, op.binds, op.advances, op.signs, op.closes],
            [1, 1, 1, 1, 10, 1],
          );
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(phases.where((p) => p == 'validate:finalized'), hasLength(2));
          expect(phases.where((p) => p == 'validate:pre-sign'), hasLength(1));
        }
      },
    );
    test(
      'staged FT $index private worker advances without additional consent/read',
      () async {
        final s = sample(index),
            op = FixtureOperation(s),
            paths = <String>[],
            release = Completer<void>();
        op.duringConsent = () async {
          for (var i = 0; paths.length < 3 && i < 200; i++) {
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
            operationId: 'staged-$index',
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
        expect([op.consents, op.binds, op.advances, op.signs], [1, 1, 1, 10]);
        expect(paths, unorderedEquals(s['coldTrace']));
      },
    );
  }
  for (final failure in ['cancel', 'expiry']) {
    test('between-stage $failure signs no child and closes once', () async {
      final s = sample(), op = FixtureOperation(s);
      var now = protocolTime(s['now']);
      op.duringAdvance = () async {
        if (failure == 'cancel') {
          op.active = false;
        } else {
          now = now.add(const Duration(hours: 1));
        }
      };
      await expectLater(
        executor(s, op, now: () => now).execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 6, 1]);
    });
  }
  test('invalid parent signature never authorizes child stage', () async {
    final s = sample(), op = FixtureOperation(s);
    op.alterSignature = (sig) => sig['signature'] = '00' * 64;
    await expectLater(
      executor(s, op).execute(s['method'], s['request']),
      throwsA(isA<StateError>()),
    );
    expect([op.advances, op.signs, op.closes], [0, 6, 1]);
  });
  for (final mutation in [
    'digest',
    'parent',
    'stage',
    'plan',
    'approval',
    'replay',
  ]) {
    test('actual Engine rejects altered pending $mutation', () {
      final s = sample(),
          a = s['audit'],
          pending = copied(a['stages'][0]['result']);
      final args = <String, dynamic>{
        ...copied(a['material']),
        'plan': a['plan'],
        'binding': a['binding'],
        'approval': a['approval'],
        'signatures': a['stages'][0]['signatures'],
      };
      final c = pending['continuation'];
      switch (mutation) {
        case 'digest':
          pending['signingRequests'][0]['digest'] = '00' * 32;
        case 'parent':
          c['signingStage']['continuation']['finalizedTransactions'][0]['rawTransaction'] =
              '00';
        case 'stage':
          c['stage'] = 2;
        case 'plan':
          c['planHash'] = '00' * 32;
        case 'approval':
          c['approvalId'] = 'other';
        case 'replay':
          args['continuation'] = a['stages'][1]['continuation'];
          args['signatures'] = a['stages'][1]['signatures'];
      }
      final reply = jsonDecode(
        engine.call(
          'engine',
          'validate',
          jsonEncode({...args, 'phase': 'finalized', 'pending': pending}),
        ),
      );
      expect(reply['ok'] != true || reply['result']?['valid'] != true, true);
    });
  }
}
