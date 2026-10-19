// Actual worker + pinned Engine; public signature replays and a synthetic
// native-shaped submit/index adapter. No key use, HTTP or real broadcast.
import 'dart:async';
import 'package:web3dart/crypto.dart' as testCrypto;
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/maintenance_backend.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_broadcast_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'merge_material_test.dart' as fixtures;
import 'native_signing_test.dart' show FixtureOperation;
import 'native_broadcast_binding_test.dart' show Channel;
import 'support/signing_replay.dart' as replay;

import 'support/trusted_index_candidate.dart';

String point(Map r) => '${r['txid']}:${r['vout'] ?? r['index']}';

final class Harness implements TbcWalletSigningBackend, TbcMaintenanceBackend {
  Harness(String file, int index, this.kind)
    : sample = fixtures.sample(file, index);
  final Map<String, dynamic> sample;
  final String kind;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  late final account = TbcAccount(
    network: network.network,
    address: sample['account']['address'],
    publicKey: sample['account']['publicKey'],
  );
  late final navigation = TbcWebViewNavigation(
    webViewInstanceId: 'merge-worker',
    sessionId: 'merge-session',
    navigationId: 'document',
    origin: 'https://partner.example',
    committedUrl: 'https://partner.example/dapp',
    createdAt: tbcProtocolTimestamp(DateTime.now()),
  );
  late TbcSigningRequestScope scope = TbcSigningRequestScope(
    operationId: 'maintenance',
    method: 'tbc_sendTransaction',
    navigation: navigation,
    account: account,
    revision: 0,
  );
  late final asset = <String, dynamic>{
    'kind': kind,
    if (sample['request']['intent']['contractId'] != null)
      'contractId': sample['request']['intent']['contractId'],
    if (sample['request']['intent']['poolContractId'] != null)
      'poolContractId': sample['request']['intent']['poolContractId'],
  };
  late final limits = <String, dynamic>{
    'targetUtxoCount': 1,
    'maxTransactions': 2,
    'maxTotalFee': sample['request']['constraints']['maxFee'],
    'expiresAt': tbcProtocolTimestamp(
      DateTime.now().add(const Duration(minutes: 2)),
    ),
    'maxIndexRefreshes': 0,
    'indexRefreshDelayMs': 0,
  };
  final paths = <String>[];
  int? readsBeforeSubmit;
  final operations = <Child>[];
  bool live = true, unlocked = true, reject = false, unknown = false;
  bool failSigning = false, refuseFinish = false, stallIndex = false;
  bool refuseAggregate = false;
  bool dynamicFixtureSigning = false, nativeCommands = false, missingTx = false;
  int approvals = 0, ordinaryBegins = 0;
  Owner? owner;
  Map<String, dynamic>? noopResult;
  void checkScope(TbcSigningRequestScope s) {
    expect(s.operationId, scope.operationId);
    expect(s.method, scope.method);
    expect(s.revision, scope.revision);
    expect(s.account.toKitAccount(), scope.account.toKitAccount());
    expect(s.navigation.matches(scope.navigation.toWire()), true);
  }

  @override
  Future<void> finishMaintenanceNoop(
    TbcSigningRequestScope s,
    Map<String, dynamic> consent,
    Map<String, dynamic> result,
  ) async {
    need(live && unlocked && !refuseAggregate, 'REVOKED');
    checkScope(s);
    expect(result['scopeHash'], hashJson(consent));
    expect(result['reason'], 'already-below-target');
    expect(operations.every((o) => o.closes == 1), true);
    noopResult = copied(result);
  }

  Completer<void>? approvalEntered, holdApproval, childEntered, holdChild;
  Completer<void>? postEntered, holdPost;
  late TbcSigningWorker worker;

  Future<void> start({
    MessageSigningProfile profile = MessageSigningProfile.standard,
  }) async {
    worker = await TbcSigningWorker.start(
      library: TbcPinnedComputeLibrary(
        path: trustedIndexCandidateLibrary()['path'],
        sha256: trustedIndexCandidateLibrary()['sha256'],
      ),
      network: network,
      backend: this,
      read: read,
      messageProfile: profile,
    );
  }

  Future<Map<String, dynamic>> read(String path) async {
    need(live, 'REVOKED');
    paths.add(path);
    need(sample['replies'][path] != null, 'UNEXPECTED_FIXTURE_READ');
    return copied(sample['replies'][path]);
  }

  Future<Map<String, dynamic>> run() => worker.executeMaintenance(
    scope: scope,
    asset: asset,
    limits: limits,
    requireAuthorized: () => need(live, 'REVOKED'),
    isUnlocked: () => unlocked,
  );
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope s) async {
    ordinaryBegins++;
    throw StateError('Maintenance must use its native-owned child');
  }

  @override
  Future<TbcMaintenanceOwner> beginMaintenance(
    TbcSigningRequestScope s,
    Map<String, dynamic> consent,
  ) async {
    need(live && unlocked, 'REVOKED');
    checkScope(s);
    expect(consent['authority']['accountId'], account.accountId);
    approvals++;
    approvalEntered?.complete();
    await holdApproval?.future;
    if (reject) throw const TbcSigningRejected();
    return owner = Owner(this, consent);
  }

  @override
  void revokePending(TbcWebViewNavigation n) {
    live = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope s) {
    live = false;
  }

  // Publish only after the mock native finish, not merely after a POST callback.
  void publish(Child op) {
    if (stallIndex) return;
    final row = op.bundle!['transactions'][0];
    final txid = row['txid'], raw = row['rawTransaction'];
    final entries = (sample['replies'] as Map).entries.where(
      (e) =>
          e.value is Map &&
          e.value['utxos'] is List &&
          (e.value['utxos'] as List).any((r) => op.selected.contains(point(r))),
    );
    expect(entries.length, 1);
    final rows = entries.single.value['utxos'] as List;
    final first = copied(
      rows.firstWhere((r) => op.selected.contains(point(r))),
    );
    rows.removeWhere((r) => op.selected.contains(point(r)));
    rows.add({
      ...first,
      'txid': txid,
      'height': -1,
      if (kind == 'tbc')
        'value': inspectTransaction(raw)['outputs'][0]['satoshis'],
    });
    sample['replies']['/api/tbc/txraw/txid/$txid'] = {'txraw': raw};
    if (kind == 'pool-ft') {
      sample['replies']['/api/tbc/pool/poolinfo/poolid/${asset['poolContractId']}']['txid'] =
          txid;
    }
  }
}

final class Owner implements TbcMaintenanceOwner {
  Owner(this.h, this.consent);
  final Harness h;
  final Map<String, dynamic> consent;
  int closes = 0;
  Map<String, dynamic>? result;
  @override
  Future<void> finish(Map<String, dynamic> value) async {
    need(h.live && closes == 0 && result == null, 'REVOKED');
    need(!h.refuseAggregate, 'AGGREGATE_REFUSED');
    expect(h.operations.every((o) => o.closes == 1), true);
    expect(value['scopeHash'], hashJson(consent));
    result = copied(value);
  }

  @override
  late final Map<String, dynamic> approval = {
    'status': 'approved',
    'approvalId': 'fixture-bounded-consent',
    'scopeHash': hashJson(consent),
    'approvedAt': tbcProtocolTimestamp(DateTime.now()),
    'expiresAt': consent['limits']['expiresAt'],
  };
  @override
  Future<TbcSigningOperation> beginStep({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> step,
    required Map<String, dynamic> request,
    required List<String> selectedInputs,
  }) async {
    need(h.live && closes == 0, 'REVOKED');
    expect(scope.operationId, isNot(h.scope.operationId));
    expect(step.containsKey('prepared'), false);
    expect(step['materialHash'], hashJson(request));
    expect(step['inputCount'], selectedInputs.length);
    final op =
        h.nativeCommands
            ? CommandChild(h, step, request, selectedInputs)
            : Child(h, step, request, selectedInputs);
    h.childEntered?.complete();
    await h.holdChild?.future;
    h.operations.add(op);
    return op;
  }

  @override
  Future<void> close() async {
    closes++;
  }
}

class Child extends FixtureOperation implements TbcBroadcastSigningOperation {
  Child(this.h, this.metadata, this.request, this.selected) : super(h.sample);
  final Harness h;
  final Map<String, dynamic> metadata, request;
  final List<String> selected;
  Map<String, dynamic>? bundle;
  int submits = 0, reconciles = 0, finishes = 0;
  TbcSigningMaterial? actualMaterial;
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    if (!h.dynamicFixtureSigning) return super.bind(m);
    await requireCurrent();
    binds++;
    expect(m.binding['bindingHash'], hashJson(m.binding['payload']));
    expect(m.binding['payload']['requestHash'], hashJson(request));
    actualMaterial = m;
    return receipt = TbcSigningReceipt({
      'status': 'approved',
      'approvalId': 'public-fixture-child',
      'approvalToken': 'public-fixture-only',
      'bindingHash': m.binding['bindingHash'],
      'approvedAt': tbcProtocolTimestamp(DateTime.now()),
      'expiresAt': m.binding['payload']['expiresAt'],
    });
  }

  @override
  Future<void> requireCurrent() async {
    await super.requireCurrent();
    need(h.live && h.unlocked, 'REVOKED');
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async {
    expect(intent.method, 'tbc_sendTransaction');
    expect(intent.request, request);
    return super.requestConsent(intent); // native child check, not another UI
  }

  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) async {
    need(!h.failSigning, 'FIXTURE_SIGN_FAILURE');
    if (h.dynamicFixtureSigning) {
      await requireCurrent();
      expect(t.wire, actualMaterial!.plan!['payload']['signingTasks'][signs++]);
      expect(t.wire['publicKey'], h.account.publicKey);
      expect(t.wire['signatureEncoding'], 'compact64');
      // Public scalar ONE, test file only. The candidate has no default key.
      final sig = testCrypto.sign(
        unhex(t.wire['digest']),
        unhex('1'.padLeft(64, '0')),
      );
      return TbcTaskSignature(
        taskId: t.taskId,
        signatureEncoding: 'compact64',
        signature:
            sig.r.toRadixString(16).padLeft(64, '0') +
            sig.s.toRadixString(16).padLeft(64, '0'),
      );
    }
    return super.sign(r, t);
  }

  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastMaterial m,
  ) async {
    if (!h.dynamicFixtureSigning || h.operations.length == 1) {
      expect(m.bundle['transactions'], h.sample['result']['transactions']);
      expect(m.bundle['totalFee'], h.sample['result']['totalFee']);
      expect(signs, h.sample['audit']['signatures'].length);
    }
    bundle = m.bundle;
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int index,
  ) async {
    expect(index, 0);
    expect(submits++, 0);
    h.readsBeforeSubmit ??= h.paths.length;
    h.postEntered?.complete();
    await h.holdPost?.future;
    if (h.unknown)
      return TbcBroadcastResult({
        'portError': {
          'name': 'UNAVAILABLE',
          'retryable': true,
          'message': 'test-only transport unknown',
        },
      });
    return TbcBroadcastResult({
      'txid': bundle!['transactions'][0]['txid'],
      'status': 'accepted',
    });
  }

  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt r) async =>
      throw StateError('Not a batch submit');
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> ids,
  ) async {
    expect(reconciles++, 0);
    return TbcBroadcastResult({
      'transactions': [
        {'txid': ids.single, 'status': 'unknown'},
      ],
    });
  }

  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastResult result,
  ) async {
    need(!h.refuseFinish, 'FINISH_REFUSED');
    expect(
      result.wire['transactions'][0]['txid'],
      bundle!['transactions'][0]['txid'],
    );
    finishes++;
    h.publish(this);
  }
}

final class CommandChild extends Child implements NativeBroadcastCommands {
  CommandChild(super.h, super.metadata, super.request, super.selected);
  final channel = Channel();
  @override
  Future<Object?> invokeBroadcast(
    String command,
    Map<String, Object?> fields,
  ) async {
    await requireCurrent();
    if (command == 'signing.broadcast.authorize') {
      await super.authorizeBroadcast(
        TbcSigningReceipt(fields['receipt'] as Map),
        TbcBroadcastMaterial(bundle: fields['bundle'] as Map),
      );
    }
    if (command == 'signing.broadcast.wire' &&
        fields['method'] == 'GET' &&
        h.missingTx) {
      channel.gets++;
      return {'statusCode': 404, 'body': ''};
    }
    channel.unknownPost = h.unknown;
    final r =
        await channel.invoke(command, {
              'ownerId': 'owner',
              'scope': channel.navigation.toWire(),
              ...fields,
            })
            as Map;
    if (r['ok'] != true) throw BroadcastNodeFailure(r['code']);
    if (command == 'signing.broadcast.finish' && r['value'] == true) {
      finishes++;
      h.publish(this);
    }
    return r['value'];
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int i,
  ) async => throw StateError('Submit must run in worker port');
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> ids,
  ) async => throw StateError('Reconciliation must run in worker port');
}

void main() {
  setUpAll(replay.loadReplay);
  for (final c in [
    ('native-signing', 3, 'tbc'),
    ('native-signing', 4, 'tbc'),
    ('fungible-signing', 2, 'ft'),
    ('fungible-signing', 3, 'ft'),
    ('fungible-signing', 6, 'ft'),
    ('stablecoin-signing', 3, 'stablecoin'),
    ('stablecoin-signing', 8, 'stablecoin'),
    ('unified-pool-signing', 4, 'pool-ft'),
    ('unified-pool-signing', 5, 'ftlp'),
    ('unified-pool-signing', 16, 'ftlp'),
    ('unified-pool-signing', 19, 'ftlp'),
  ]) {
    test(
      '${c.$1}:${c.$2} shared worker exact bytes/fee, one native parent',
      () async {
        final h = Harness(c.$1, c.$2, c.$3);
        // The 100-input cap leaves one remaining fragment in this vector.
        if (c.$1 == 'native-signing' && c.$2 == 4)
          h.limits['targetUtxoCount'] = 2;
        await h.start();
        addTearDown(h.worker.close);
        final result = await h.run();
        expect(result['status'], 'complete', reason: '$result');
        expect(h.owner!.result, result);
        expect(result['steps'].length, 1);
        expect(result['steps'][0]['status'], 'accepted');
        expect(result['totalFee'], h.sample['result']['totalFee']);
        expect([h.approvals, h.ordinaryBegins, h.owner!.closes], [1, 0, 1]);
        final op = h.operations.single;
        expect(
          [op.consents, op.binds, op.submits, op.finishes, op.closes],
          [1, 1, 1, 1, 1],
        );
        expect(op.signs, h.sample['audit']['signatures'].length);
        expect(h.worker.pendingCount, 0);
        final cold = (h.sample['coldTrace'] as List).cast<String>();
        // Capture the actual submit boundary, not the obsolete oracle count.
        // Post-submit UTXO refreshes stay fresh across maintenance rounds.
        final firstSubmitReads = h.paths.take(h.readsBeforeSubmit!).toList();
        expect(firstSubmitReads.length, lessThanOrEqualTo(cold.length + 1));
        expect(firstSubmitReads.length, firstSubmitReads.toSet().length);
        expect(h.paths.length, greaterThan(firstSubmitReads.length));
      },
    );
  }
  test('already below target performs no approval, signer or submit', () async {
    final h = Harness('native-signing', 3, 'tbc')
      ..limits['targetUtxoCount'] = 100;
    await h.start();
    addTearDown(h.worker.close);
    final r = await h.run();
    expect(r['reason'], 'already-below-target');
    expect(h.noopResult, r);
    expect(h.approvals, 0);
    expect(h.operations, isEmpty);
    expect(h.paths.length, 1);
  });
  test(
    'native aggregate refusal never releases an unattested success',
    () async {
      final h = Harness('native-signing', 3, 'tbc')..refuseAggregate = true;
      await h.start();
      addTearDown(h.worker.close);
      await expectLater(h.run(), throwsStateError);
      expect(h.operations.single.submits, 1);
      expect(h.operations.single.finishes, 1);
      expect(h.owner!.result, isNull);
      expect(h.owner!.closes, 1);
    },
  );
  test('invalid limits rejected before index or native consent', () async {
    final h = Harness('native-signing', 3, 'tbc')
      ..limits['maxTransactions'] = 65;
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsStateError);
    expect(h.paths, isEmpty);
    expect(h.approvals, 0);
  });
  test(
    'required read prefetch overlaps consent and is consumed once',
    () async {
      final h =
          Harness('native-signing', 3, 'tbc')
            ..approvalEntered = Completer()
            ..holdApproval = Completer();
      await h.start();
      addTearDown(h.worker.close);
      final run = h.run();
      await h.approvalEntered!.future;
      final indexPath = '/api/tbc/utxo/address/${h.account.address}';
      for (var i = 0; i < 30 && !h.paths.contains(indexPath); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(h.paths, contains(indexPath));
      expect(h.operations, isEmpty);
      h.holdApproval!.complete();
      await run;
      expect(h.paths.where((p) => p == '/api/tbc/nodeinfo').length, 0);
      expect(
        h.paths.where((p) => p == indexPath).length,
        2,
      ); // Prepare, then post-submit refresh.
    },
  );
  test('rejection signs nothing', () async {
    final h = Harness('native-signing', 3, 'tbc')..reject = true;
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsA(isA<TbcSigningRejected>()));
    expect(h.operations, isEmpty);
  });
  test(
    'different request IDs cannot start concurrent maintenance in one document',
    () async {
      final h =
          Harness('native-signing', 3, 'tbc')
            ..approvalEntered = Completer()
            ..holdApproval = Completer();
      await h.start();
      addTearDown(h.worker.close);
      final first = h.run();
      await h.approvalEntered!.future;
      await expectLater(
        h.worker.executeMaintenance(
          scope: TbcSigningRequestScope(
            operationId: 'second',
            method: h.scope.method,
            navigation: h.navigation,
            account: h.account,
            revision: h.scope.revision,
          ),
          asset: h.asset,
          limits: h.limits,
          requireAuthorized: () => need(h.live, 'REVOKED'),
          isUnlocked: () => h.unlocked,
        ),
        throwsStateError,
      );
      expect(h.approvals, 1);
      expect(h.operations, isEmpty);
      h.holdApproval!.complete();
      expect((await first)['status'], 'complete');
      expect(h.operations.length, 1);
    },
  );
  test('pre-submit signing failure is not broadcast uncertainty', () async {
    final h = Harness('native-signing', 3, 'tbc')..failSigning = true;
    await h.start();
    addTearDown(h.worker.close);
    final r = await h.run();
    expect(
      [r['status'], r['reason'], r['totalFee']],
      ['stopped', 'step-failed', '0'],
    );
    expect(h.operations.single.submits, 0);
    expect(h.operations.single.closes, 1);
  });
  test('unknown submit reconciles once, never resends or advances', () async {
    final h = Harness('native-signing', 3, 'tbc')..unknown = true;
    await h.start();
    addTearDown(h.worker.close);
    final r = await h.run();
    expect([r['status'], r['reason']], ['uncertain', 'broadcast-uncertain']);
    final op = h.operations.single;
    expect([op.submits, op.reconciles, op.finishes, op.closes], [1, 1, 0, 1]);
    expect(h.paths.length, 1);
  });
  test(
    'native finish refusal does not publish success or read next index',
    () async {
      final h = Harness('native-signing', 3, 'tbc')..refuseFinish = true;
      await h.start();
      addTearDown(h.worker.close);
      final r = await h.run();
      expect(r['status'], 'uncertain');
      expect(h.paths.length, 1);
      expect(h.operations.single.finishes, 0);
    },
  );
  test('accepted but unindexed stops partial, no repeat submit', () async {
    final h = Harness('native-signing', 3, 'tbc')..stallIndex = true;
    await h.start();
    addTearDown(h.worker.close);
    final r = await h.run();
    expect([r['status'], r['reason']], ['partial', 'index-stalled']);
    expect(h.operations.single.submits, 1);
  });
  for (final atChild in [false, true]) {
    test(
      'cancellation during ${atChild ? 'child' : 'approval'} closes late handles',
      () async {
        final h = Harness('native-signing', 3, 'tbc');
        final entered = Completer<void>(), hold = Completer<void>();
        if (atChild) {
          h.childEntered = entered;
          h.holdChild = hold;
        } else {
          h.approvalEntered = entered;
          h.holdApproval = hold;
        }
        await h.start();
        addTearDown(h.worker.close);
        final r = h.run(), rejected = expectLater(r, throwsStateError);
        await entered.future;
        h.worker.cancelOperation(h.scope.operationId, h.navigation);
        await rejected.timeout(const Duration(seconds: 1));
        hold.complete();
        for (
          var i = 0;
          i < 30 && (atChild ? h.operations.isEmpty : h.owner == null);
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }
        expect(h.owner!.closes, 1);
        if (atChild)
          expect(
            [h.operations.single.signs, h.operations.single.closes],
            [0, 1],
          );
        expect(h.worker.pendingCount, 0);
      },
    );
  }
  test(
    'two signed Engine rounds retain one consent, parent dependency and fresh index',
    () async {
      final h = Harness('native-signing', 4, 'tbc')
        ..dynamicFixtureSigning = true;
      await h.start();
      addTearDown(h.worker.close);
      final r = await h.run();
      expect(r['status'], 'complete', reason: '$r');
      expect(h.approvals, 1);
      expect(h.operations.length, 2);
      expect(r['steps'][1]['dependsOn'], [r['steps'][0]['txid']]);
      expect(h.operations[1].selected, contains('${r['steps'][0]['txid']}:0'));
      expect(
        h.operations[1].request['constraints']['maxFee'],
        (BigInt.parse(h.limits['maxTotalFee']) -
                BigInt.parse(r['steps'][0]['fee']))
            .toString(),
      );
      expect(h.operations.map((op) => [op.submits, op.finishes, op.closes]), [
        [1, 1, 1],
        [1, 1, 1],
      ]);
      expect(h.paths.where((p) => p.contains('/utxo/address/')).length, 3);
      expect(h.paths.where((p) => p == '/api/tbc/nodeinfo').length, 0);
      expect(h.paths.length, 3);
    },
  );
  for (final state in ['accepted', 'reconciled', 'unknown']) {
    test(
      'native command port $state keeps actual journal identity and one POST',
      () async {
        final h =
            Harness('native-signing', 3, 'tbc')
              ..nativeCommands = true
              ..unknown = state != 'accepted'
              ..missingTx = state == 'unknown';
        await h.start();
        addTearDown(h.worker.close);
        final r = await h.run();
        final op = h.operations.single as CommandChild;
        expect(op.channel.posts, 1);
        expect(op.channel.gets, state == 'accepted' ? 0 : 1);
        expect(op.closes, 1);
        expect(h.approvals, 1);
        if (state == 'unknown') {
          expect(r['status'], 'uncertain');
          expect(
            r['steps'][0]['recoveryId'],
            op.channel.journal.rows.keys.single,
          );
          expect(op.finishes, 0);
          expect(h.paths.length, 1);
        } else {
          expect(r['status'], 'complete', reason: '$r');
          expect(
            r['steps'][0]['status'],
            state == 'accepted' ? 'accepted' : 'known',
          );
          expect(op.finishes, 1);
        }
      },
    );
  }
}
