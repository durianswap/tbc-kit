// Actual Legacy preparation -> same production worker -> pinned current Rust.
// Recorded public signatures only. Not the installed document/Vault channel.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_mapping.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_business.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_signing_call.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation;
import 'legacy_business_test.dart' show Metadata;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

Map<String, dynamic> sample(String file, String name) {
  final value = copied(
    (jsonDecode(File('test/fixtures/$file.json').readAsStringSync())['cases']
            as List)
        .singleWhere((row) => row['name'] == name),
  );
  if (file == 'native-signing') {
    final read = sample('native-transfers', name);
    value['replies'] = read['replies'];
    value['coldTrace'] = read['trace'];
    rebindExpectedSnapshot(
      value,
      withoutObservedTip(value['audit']['material']['snapshot']),
    );
    (value['coldTrace'] as List).remove('/api/tbc/nodeinfo');
  } else if (value['audit']?['material'] != null) {
    final all =
        (jsonDecode(
                  File('test/fixtures/$file.json').readAsStringSync(),
                )['cases']
                as List)
            .cast<Map>();
    final indexed = IndexedFixture(all);
    if (file == 'unified-pool-signing')
      indexed.projectPool2(value);
    else
      indexed.projectHolder(value);
    // Historical captures omitted API display fields. These test vectors use
    // six display decimals, except the current Coin vector, which uses zero.
    for (final e in (value['replies'] as Map).entries) {
      if (e.key.toString().contains('/info/')) {
        e.value['decimal'] = name == 'current-coin-transfer' ? 0 : 6;
        e.value['name'] = 'Public fixture token';
        e.value['symbol'] = 'FIX';
      }
    }
  }
  return value;
}

String display(String atomic, int decimals) {
  if (decimals == 0) return atomic;
  final value = atomic.padLeft(decimals + 1, '0');
  return '${value.substring(0, value.length - decimals)}.${value.substring(value.length - decimals)}';
}

final class Backend implements TbcWalletSigningBackend {
  Backend(this.operation);
  final FixtureOperation operation;
  int begins = 0, revoked = 0;
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async {
    begins++;
    return operation;
  }

  @override
  void revokePending(TbcWebViewNavigation n) {
    revoked++;
    operation.active = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope s) {
    revoked++;
    operation.active = false;
  }
}

final class CountedOperation extends FixtureOperation {
  CountedOperation(super.sample);
  int currentChecks = 0;
  @override
  Future<void> requireCurrent() async {
    currentChecks++;
    await super.requireCurrent();
  }
}

// Test custody replays public recorded signatures, matched by digest and key.
// Production native binding/custody is separately tested, not mocked proof here.
final class MessageBatchOperation extends FixtureOperation
    implements TbcWorkflowSigningOperation {
  MessageBatchOperation(super.sample, this.signed);
  final List signed;
  final completed = <String>[];
  String? activeStep;
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial value) async {
    await requireCurrent();
    binds++;
    expect(consents, 1);
    expect(value.binding['payload']['requestHash'], hashJson(consent!.request));
    expect(value.binding['payload']['contextHash'], hashJson(consent!.context));
    expect(value.binding['bindingHash'], hashJson(value.binding['payload']));
    receipt = TbcSigningReceipt({
      'status': 'approved',
      'approvalId': 'public-fixture',
      'approvalToken': 'public-fixture-only',
      'bindingHash': value.binding['bindingHash'],
      'approvedAt': tbcProtocolTimestamp(DateTime.now()),
      'expiresAt': value.binding['payload']['expiresAt'],
    });
    return receipt!;
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt r,
    TbcSigningTask task,
  ) async {
    await requireCurrent();
    expect(r.wire, receipt!.wire);
    final expected = signed[signs++];
    for (final key in ['digest', 'publicKey', 'signatureEncoding']) {
      expect(task.wire[key], expected['task'][key], reason: key);
    }
    return TbcTaskSignature(
      taskId: task.taskId,
      signatureEncoding: expected['result']['signatureEncoding'],
      signature: expected['result']['signature'],
    );
  }

  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation step,
  ) async {
    await requireCurrent();
    expect(r.wire, receipt!.wire);
    expect(activeStep, isNull);
    activeStep = step.wire['stepId'];
    expect(activeStep, 'legacy-${completed.length + 1}');
    if (activeStep == 'legacy-2') expect(completed, ['legacy-1']);
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation step,
  ) async {
    await requireCurrent();
    expect(r.wire, receipt!.wire);
    expect(step.wire['stepId'], activeStep);
    completed.add(activeStep!);
    activeStep = null;
  }
}

void main() {
  late TbcPinnedComputeLibrary library;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    final b = jsonDecode(
      File(
        Platform.environment['TBC173_BUILD_REPORT'] ??
            '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json',
      ).readAsStringSync(),
    );
    final row = (b['builds'] as List).singleWhere(
      (r) => r['target'] == 'aarch64-apple-darwin',
    );
    expect(
      row['sha256'],
      '413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db',
    );
    expect(
      sha256.convert(File(row['path']).readAsBytesSync()).toString(),
      row['sha256'],
    );
    final current = trustedIndexCandidateLibrary();
    library = TbcPinnedComputeLibrary(
      path: current['path'],
      sha256: current['sha256'],
    );
  });
  LegacyMappingAccount identity(Map s) => LegacyMappingAccount(
    chainId: 'tbc:testnet',
    address: s['account']['address'],
    accountId: s['account']['accountId'],
  );
  TbcSigningRequestScope scope(Map s, String method) => TbcSigningRequestScope(
    operationId: 'legacy-ingress',
    method: method,
    revision: 0,
    account: TbcAccount(
      network: TbcNetwork.testnet,
      address: s['account']['address'],
      publicKey: s['account']['publicKey'],
    ),
    navigation: TbcWebViewNavigation(
      webViewInstanceId: 'view',
      sessionId: 'session',
      navigationId: 'nav',
      committedUrl: 'https://partner.example/dapp',
      origin: 'https://partner.example',
      createdAt: tbcProtocolTimestamp(DateTime.now()),
    ),
  );
  Map<String, dynamic> params(Map s, int decimals) {
    final i = s['request']['intent'] as Map, type = i['type'];
    if (type == 'tbc.transfer')
      return {
        'flag': 'P2PKH',
        'address': i['to'],
        'satoshis': i['amount'],
        'broadcastEnabled': false,
      };
    if (type == 'tbc20.transfer' || type == 'tbc20Stablecoin.transfer') {
      return {
        'flag':
            type == 'tbc20.transfer' ? 'FT_TRANSFER' : 'STABLECOIN_TRANSFER',
        'ft_contract_address': i['contractId'],
        'address': i['to'],
        'ft_amount': display(i['amount'], decimals),
        if (i['payment'] != null)
          'tbc_amount': display(i['payment']['amount'], 6),
        'broadcastEnabled': false,
      };
    }
    final flag =
        type == 'amm.swap'
            ? (i['direction'] == 'ft-to-tbc'
                ? 'POOLNFT_SWAP_TO_TBC'
                : 'POOLNFT_SWAP_TO_TOKEN')
            : type == 'amm.addLiquidity'
            ? 'POOLNFT_LP_INCREASE'
            : 'POOLNFT_LP_CONSUME';
    return {
      'flag': flag,
      'nft_contract_address': i['poolContractId'],
      'address': i['receiver'],
      'poolNFT_version': 2,
      'broadcastEnabled': false,
      if (flag == 'POOLNFT_SWAP_TO_TBC' || flag == 'POOLNFT_LP_CONSUME')
        'ft_amount': display(
          i[type == 'amm.removeLiquidity' ? 'lpAmount' : 'amount'],
          decimals,
        )
      else
        'tbc_amount': display(i['amount'], 6),
    };
  }

  for (final row in [
    ('native-signing', 'transfer-single', 6),
    ('fungible-signing', 'historical-transfer', 6),
    ('fungible-signing', 'historical-transfer-payment', 6),
    ('stablecoin-signing', 'current-coin-transfer', 0),
    ('stablecoin-signing', 'historical-stablecoin-transfer', 6),
    ('unified-pool-signing', 'unified-pool2-buy', 6),
    ('unified-pool-signing', 'unified-pool2-sell', 6),
    ('unified-pool-signing', 'unified-pool2-add', 6),
    ('unified-pool-signing', 'unified-pool2-remove', 6),
  ]) {
    test(
      '${row.$2} translates inside shared worker with unchanged reads/bytes and one consent',
      () async {
        final s = sample(row.$1, row.$2),
            p = params(s, row.$3),
            call = LegacySigningCall.capture('sendTransaction', p, identity(s));
        expect(call.standardMethod, 'tbc_signTransaction');
        final operation = FixtureOperation(s),
            paths = <String>[],
            released = Completer<void>();
        final backend = Backend(operation);
        operation.duringConsent = () async {
          try {
            // Immutable precision may precede intent consent, as in the frozen
            // JS resolver. Fresh material preparation still overlaps that consent.
            for (
              var n = 0;
              paths.where((p) => p.contains('/utxo/')).length <
                      (row.$1 == 'native-signing' ? 1 : 2) &&
                  n < 300;
              n++
            ) {
              await Future<void>.delayed(const Duration(milliseconds: 1));
            }
            expect(
              paths.where((p) => p.contains('/utxo/')).length,
              greaterThanOrEqualTo(row.$1 == 'native-signing' ? 1 : 2),
            );
            expect(operation.binds, 0);
            expect(
              operation.consent!.request['intent'],
              s['request']['intent'],
            );
          } finally {
            released.complete();
          }
        };
        final worker = await TbcSigningWorker.start(
          library: library,
          network: network,
          backend: backend,
          messageProfile: MessageSigningProfile.legacyBitcoin,
          read: (path) async {
            paths.add(path);
            if (path.contains('/utxo/') || path.contains('/lputxo/'))
              await released.future;
            expect(s['replies'].containsKey(path), true, reason: path);
            return copied(s['replies'][path]);
          },
        );
        addTearDown(worker.close);
        // Changes made by a page after ingress cannot replace the captured intent.
        p['address'] = 'changed';
        p['ft_amount'] = '999';
        final result = await worker.executeLegacy(
          scope: scope(s, call.standardMethod),
          call: call,
          requireAuthorized: () {},
          isUnlocked: () => true,
        );
        expect(result['transactions'], s['result']['transactions']);
        expect(result['totalFee'], s['result']['totalFee']);
        expect(paths, unorderedEquals(s['coldTrace']));
        expect(
          [
            backend.begins,
            operation.consents,
            operation.binds,
            operation.closes,
          ],
          [1, 1, 1, 1],
        );
        expect(paths.length, paths.toSet().length);
      },
    );
  }
  test('Standard worker cannot select Legacy preparation or framing', () async {
    final s = sample('fungible-signing', 'historical-transfer'),
        backend = Backend(FixtureOperation(s));
    final worker = await TbcSigningWorker.start(
      library: library,
      network: network,
      backend: backend,
      read: (_) async => throw StateError('No read allowed'),
    );
    addTearDown(worker.close);
    final call = LegacySigningCall.capture(
      'sendTransaction',
      params(s, 6),
      identity(s),
    );
    await expectLater(
      worker.executeLegacy(
        scope: scope(s, call.standardMethod),
        call: call,
        requireAuthorized: () {},
        isUnlocked: () => true,
      ),
      throwsStateError,
    );
    expect(backend.begins, 0);
  });
  test(
    'pure Legacy translation adds no native authority round trips',
    () async {
      final s = sample('native-signing', 'transfer-single'), counts = <int>[];
      for (final legacy in [false, true]) {
        final op = CountedOperation(s);
        final worker = await TbcSigningWorker.start(
          library: library,
          network: network,
          backend: Backend(op),
          messageProfile:
              legacy
                  ? MessageSigningProfile.legacyBitcoin
                  : MessageSigningProfile.standard,
          read: (path) async => copied(s['replies'][path]),
        );
        try {
          final call = LegacySigningCall.capture(
            'sendTransaction',
            params(s, 6),
            identity(s),
          );
          expect(call.needsMetadata, false);
          if (legacy) {
            await worker.executeLegacy(
              scope: scope(s, call.standardMethod),
              call: call,
              requireAuthorized: () {},
              isUnlocked: () => true,
            );
          } else {
            await worker.execute(
              scope: scope(s, 'tbc_signTransaction'),
              request: s['request'],
              requireAuthorized: () {},
              isUnlocked: () => true,
            );
          }
          counts.add(op.currentChecks);
        } finally {
          await worker.close();
        }
      }
      expect(counts.last, counts.first);
    },
  );
  test(
    'missing batch child grant fails before native begin or metadata reads',
    () async {
      final s = sample('fungible-signing', 'historical-transfer'),
          backend = Backend(FixtureOperation(s));
      final worker = await TbcSigningWorker.start(
        library: library,
        network: network,
        backend: backend,
        messageProfile: MessageSigningProfile.legacyBitcoin,
        read: (_) async => throw StateError('No read allowed'),
      );
      addTearDown(worker.close);
      final call = LegacySigningCall.capture('sendBatchRequest', [
        {'method': 'sendTransaction', 'params': params(s, 6)},
        {
          'method': 'signMessage',
          'params': {'encoding': 'utf8', 'message': 'hello'},
        },
      ], identity(s));
      await expectLater(
        worker.executeLegacy(
          scope: scope(s, call.standardMethod),
          call: call,
          requireAuthorized: () {},
          requireAuthorizedMethod:
              (m) => need(m != 'tbc_signMessage', 'MISSING_CHILD_GRANT'),
          isUnlocked: () => true,
        ),
        throwsStateError,
      );
      expect(backend.begins, 0);
    },
  );
  final messages = jsonDecode(
    File('test/fixtures/legacy-message-signing.json').readAsStringSync(),
  );
  for (final value in messages['singles']) {
    test(
      '${value['name']} Legacy message reaches shared worker with no chain reads',
      () async {
        final s = copied(value),
            tasks = s['audit']['tasks'] as List,
            signatures = s['audit']['signatures'] as List;
        final operation = MessageBatchOperation(s, [
          for (var i = 0; i < tasks.length; i++)
            {'task': tasks[i], 'result': signatures[i]},
        ]);
        final worker = await TbcSigningWorker.start(
          library: library,
          network: network,
          backend: Backend(operation),
          messageProfile: MessageSigningProfile.legacyBitcoin,
          read: (_) async => throw StateError('Message must not query chain'),
        );
        addTearDown(worker.close);
        final call = LegacySigningCall.capture('signMessage', {
          'encoding': s['request']['message']['encoding'],
          'message': s['request']['message']['data'],
        }, identity(s));
        final result = await worker.executeLegacy(
          scope: scope(s, call.standardMethod),
          call: call,
          requireAuthorized: () {},
          isUnlocked: () => true,
        );
        expect(result, s['result']);
        expect(
          [operation.consents, operation.binds, operation.signs],
          [1, 1, 1],
        );
      },
    );
  }
  test(
    'Legacy transaction and dependent message share one workflow consent and exact signatures',
    () async {
      final s = copied(
        (messages['workflows'] as List).singleWhere(
          (s) => s['name'] == 'native-message',
        ),
      );
      final reads = sample('native-transfers', 'transfer-single'),
          source = sample('native-signing', 'transfer-single');
      final rows = [
        {'method': 'sendTransaction', 'params': params(source, 6)},
        {
          'method': 'signMessage',
          'params': {
            'encoding': 'utf8',
            'message': '{"purpose":"settlement","txids":[]}',
          },
          'dependsOn': 'txids',
        },
      ];
      final call = LegacySigningCall.capture(
        'sendBatchRequest',
        rows,
        identity(s),
      );
      final operation = MessageBatchOperation(s, s['expected']['signed']),
          paths = <String>[],
          released = Completer<void>();
      operation.duringConsent = () async {
        try {
          for (var n = 0; paths.length < 1 && n < 300; n++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(paths.length, 1);
          expect(operation.binds, 0);
          expect(operation.consent!.request['maxTotalFee'], '1000');
        } finally {
          released.complete();
        }
      };
      final worker = await TbcSigningWorker.start(
        library: library,
        network: network,
        backend: Backend(operation),
        messageProfile: MessageSigningProfile.legacyBitcoin,
        read: (p) async {
          paths.add(p);
          await released.future;
          return copied(reads['replies'][p]);
        },
      );
      addTearDown(worker.close);
      final grants = <String>[];
      final result = await worker.executeLegacy(
        scope: scope(s, call.standardMethod),
        call: call,
        requireAuthorized: () {},
        requireAuthorizedMethod: grants.add,
        isUnlocked: () => true,
      );
      final legacy = mapLegacyWorkflowResult(rows, result) as List;
      expect(legacy[0], {
        'txraw': source['result']['transactions'][0]['rawTransaction'],
      });
      expect(
        legacy[1]['sig'],
        s['expected']['result']['steps'][1]['result']['signature'],
      );
      expect(jsonDecode(legacy[1]['message'])['txids'], [
        source['result']['transactions'][0]['txid'],
      ]);
      expect(operation.completed, ['legacy-1', 'legacy-2']);
      expect([operation.consents, operation.binds, operation.signs], [1, 1, 2]);
      expect(
        paths,
        unorderedEquals(
          (reads['trace'] as List).where((p) => p != '/api/tbc/nodeinfo'),
        ),
      );
      expect(grants.toSet(), call.requiredPermissions);
    },
  );
  test(
    'unified FT plus receipt retains the frozen bounded batch fee cap',
    () async {
      final s = sample('fungible-signing', 'historical-transfer'),
          a = identity(s);
      final call = LegacySigningCall.capture('sendBatchRequest', [
        {'method': 'sendTransaction', 'params': params(s, 6)},
        {
          'method': 'signMessage',
          'params': {'encoding': 'utf8', 'message': '{"txids":[]}'},
          'dependsOn': 'txids',
        },
      ], a);
      final request = await call.prepare(
        LegacyBusinessResolver(
          account: a,
          network: network,
          metadata: Metadata(),
          requireCurrent: () {},
        ),
        () {},
      );
      expect(request['steps'][0]['intent']['type'], 'tbc20.transfer');
      expect(request['maxTotalFee'], '10000');
    },
  );
  for (final mode in ['native', 'document']) {
    test(
      '$mode revoked during metadata prevents approval/signing and further reads',
      () async {
        final s = sample('fungible-signing', 'historical-transfer'),
            operation = FixtureOperation(s),
            backend = Backend(operation);
        final entered = Completer<void>(),
            release = Completer<void>(),
            paths = <String>[];
        var current = true;
        final worker = await TbcSigningWorker.start(
          library: library,
          network: network,
          backend: backend,
          messageProfile: MessageSigningProfile.legacyBitcoin,
          read: (path) async {
            paths.add(path);
            entered.complete();
            await release.future;
            return copied(s['replies'][path]);
          },
        );
        addTearDown(worker.close);
        final call = LegacySigningCall.capture(
          'sendTransaction',
          params(s, 6),
          identity(s),
        );
        final pending = worker.executeLegacy(
          scope: scope(s, call.standardMethod),
          call: call,
          requireAuthorized: () => need(current, 'REVOKED'),
          isUnlocked: () => true,
        );
        final failed = expectLater(pending, throwsStateError);
        await entered.future;
        if (mode == 'native')
          operation.active = false;
        else
          current = false;
        release.complete();
        await failed;
        expect(paths.length, 1);
        expect(
          [operation.consents, operation.binds, operation.signs],
          [0, 0, 0],
        );
      },
    );
  }
  test(
    'batch child permissions and unsupported flags are fixed before any native work',
    () {
      final s = sample('native-signing', 'transfer-single'),
          a = identity(s),
          p = params(s, 6);
      final batch = LegacySigningCall.capture('sendBatchRequest', [
        {'method': 'sendTransaction', 'params': p},
        {
          'method': 'signMessage',
          'params': {'encoding': 'utf8', 'message': '{"txids":[]}'},
          'dependsOn': 'txids',
        },
      ], a);
      expect(batch.requiredPermissions, {
        'tbc_signWorkflow',
        'tbc_signTransaction',
        'tbc_signMessage',
      });
      for (final flag in [
        'FT_MINT',
        'POOLNFT_MINT',
        'STABLECOIN_MINT',
        'UNKNOWN',
      ]) {
        expect(
          () => LegacySigningCall.capture('sendTransaction', {'flag': flag}, a),
          throwsStateError,
        );
      }
      expect(
        () => LegacySigningCall.capture('sendBatchRequest', [
          {
            'method': 'sendTransaction',
            'params': {...p, 'broadcastEnabled': true},
          },
        ], a),
        throwsStateError,
      );
    },
  );
}
