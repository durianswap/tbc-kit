// Actual non-UI isolate + pinned Engine, replay custody only. Public synthetic
// fixtures; never a native wallet, private Vault or chain-acceptance claim.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';

import 'support/trusted_index_candidate.dart';

late Map planning, signing, library;
Map readFixture(String file) =>
    jsonDecode(File('test/fixtures/$file.json').readAsStringSync());

final class Harness implements TbcWalletSigningBackend {
  Harness(String name) {
    source = copied(
      (planning['cases'] as List).singleWhere((c) => c['name'] == name),
    );
    expected = copied(
      (signing['cases'] as List).singleWhere((c) => c['name'] == name),
    );
    request = copied(source['request']);
    request['expiresAt'] = tbcProtocolTimestamp(
      DateTime.now().add(const Duration(minutes: 2)),
    );
  }
  late Map<String, dynamic> source, expected, request;
  final paths = <String>[];
  final checked = <String>{};
  final operations = <ReplayOperation>[];
  bool active = true, supported = true, approve = true, unlocked = true;
  String? revokedGrant, unavailableAt;
  bool arbitraryFailure = false, revokeAtEnter = false;
  int sequence = 0;
  Completer<void>? consentEntered, releaseConsent;
  late TbcSigningWorker worker;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  late final nav = TbcWebViewNavigation(
    webViewInstanceId: 'workflow-worker',
    sessionId: 'session',
    navigationId: 'nav',
    committedUrl: 'https://partner.example/dapp',
    origin: 'https://partner.example',
    createdAt: tbcProtocolTimestamp(DateTime.now()),
  );
  TbcAccount get account => TbcAccount(
    network: TbcNetwork.testnet,
    address: source['account']['address'],
    publicKey: source['account']['publicKey'],
  );
  Future<void> start() async {
    worker = await TbcSigningWorker.start(
      library: TbcPinnedComputeLibrary(
        path: library['path'],
        sha256: library['sha256'],
      ),
      network: network,
      backend: this,
      read: read,
    );
  }

  Future<Map<String, dynamic>> read(String path) async {
    paths.add(path);
    final m = (source['materials'] as Map).values.first['snapshot']['payload'];
    if (path == '/api/tbc/nodeinfo')
      return {
        'blocks': int.parse(m['block']['height']),
        'bestblockhash': m['block']['hash'],
      };
    if (path == '/api/tbc/utxo/address/${account.address}')
      return {
        'utxos': [
          for (final u in m['utxos'])
            {
              'txid': u['txid'],
              'index': '${u['vout']}',
              'value': u['satoshis'],
              'height':
                  '${int.parse(m['block']['height']) - int.parse(u['confirmations']) + 1}',
            },
        ],
      };
    throw StateError('Unexpected read');
  }

  Future<Map<String, dynamic>> run({bool grants = true}) {
    Map<String, dynamic>? policy;
    if ((source['materials'] as Map).isNotEmpty) {
      policy = copied(source['materials']['payment']['policy']);
      policy['payload']['expiresAt'] = request['expiresAt'];
      policy['policyHash'] = hashJson(policy['payload']);
    }
    return worker.execute(
      scope: TbcSigningRequestScope(
        operationId: 'workflow-${++sequence}',
        method: source['method'],
        navigation: nav,
        account: account,
        revision: 0,
      ),
      request: request,
      policy: policy,
      requireAuthorized: () => need(active, 'SCOPE_REVOKED'),
      isUnlocked: () => unlocked,
      requireAuthorizedMethod:
          grants
              ? (method) {
                checked.add(method);
                need(method != revokedGrant, 'CHILD_REVOKED');
              }
              : null,
    );
  }

  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async {
    final op = ReplayOperation(this);
    operations.add(op);
    return supported ? op : SingleOnly(op);
  }

  @override
  void revokePending(TbcWebViewNavigation navigation) {
    active = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope scope) {
    active = false;
  }
}

final class ReplayOperation
    implements TbcWorkflowSigningOperation, TbcCryptoSigningOperation {
  ReplayOperation(this.h);
  final Harness h;
  int consents = 0, binds = 0, signs = 0, closes = 0;
  int cryptos = 0;
  bool tamperCrypto = false;
  void Function()? afterCrypto;
  String? step;
  TbcSigningReceipt? receipt;
  final entered = <String>[], finished = <String>[];
  @override
  Future<void> requireCurrent() async => need(h.active, 'NATIVE_REVOKED');
  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt r,
    TbcCryptoTask t,
  ) async {
    cryptos++;
    expect(identical(r, receipt), false); // Receipt crosses the private worker.
    expect(canonical(r.wire), canonical(receipt!.wire));
    final ref = (h.expected['crypto'] as List).singleWhere(
      (c) => c['stepId'] == step,
    );
    expect(canonical(t.wire), canonical(ref['task']));
    if (step == h.unavailableAt) {
      if (h.arbitraryFailure)
        throw StateError('Do not expose crypto backend detail');
      throw const TbcWorkflowStepUnavailable.crypto();
    }
    final result = copied(ref['result']);
    if (tamperCrypto) result['taskId'] = 'wrong-task';
    afterCrypto?.call();
    return TbcCryptoResult(result);
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async {
    consents++;
    expect(canonical(intent.request), canonical(h.request));
    h.consentEntered?.complete();
    await h.releaseConsent?.future;
    return h.approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    binds++;
    expect(consents, 1);
    expect(m.binding['bindingHash'], hashJson(m.binding['payload']));
    expect(m.binding['payload']['requestHash'], hashJson(h.request));
    receipt = TbcSigningReceipt({
      'status': 'approved',
      'approvalId': 'worker-offline',
      'approvalToken': 'offline-only',
      'bindingHash': m.binding['bindingHash'],
      'approvedAt': tbcProtocolTimestamp(DateTime.now()),
      'expiresAt': m.binding['payload']['expiresAt'],
    });
    return receipt!;
  }

  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation s,
  ) async {
    expect(canonical(r.wire), canonical(receipt!.wire));
    expect(step, isNull);
    step = s.wire['stepId'];
    entered.add(step!);
    if (h.revokeAtEnter) h.active = false;
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation s,
  ) async {
    expect(s.wire['stepId'], step);
    finished.add(step!);
    step = null;
  }

  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) async {
    signs++;
    if (step == h.unavailableAt) {
      if (h.arbitraryFailure)
        throw StateError('secret native diagnostic must not escape');
      throw const TbcWorkflowStepUnavailable();
    }
    final row = (h.expected['signed'] as List).singleWhere(
      (v) => v['stepId'] == step && v['task']['taskId'] == t.wire['taskId'],
    );
    expect(canonical(t.wire), canonical(row['task']));
    return TbcTaskSignature(
      taskId: row['result']['taskId'],
      signatureEncoding: row['result']['signatureEncoding'],
      signature: row['result']['signature'],
    );
  }

  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation p) async =>
      throw StateError('Not a staged fixture');
  @override
  Future<void> close() async {
    closes++;
  }
}

// Demonstrates that a legacy single-operation backend cannot quietly acquire
// a workflow capability just because the worker proxy has callback methods.
final class SingleOnly implements TbcSigningOperation {
  SingleOnly(this.inner);
  final ReplayOperation inner;
  @override
  Future<void> requireCurrent() => inner.requireCurrent();
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) =>
      inner.requestConsent(i);
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) => inner.bind(m);
  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) =>
      inner.advance(r, c);
  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) =>
      inner.sign(r, t);
  @override
  Future<void> close() => inner.close();
}

void main() {
  setUpAll(() {
    planning = readFixture('workflow-planning');
    signing = readFixture('workflow-signing');
    library = trustedIndexCandidateLibrary();
  });
  Future<Harness> setup(String name) async {
    final h = Harness(name);
    await h.start();
    addTearDown(h.worker.close);
    return h;
  }

  test(
    'messages and typed workflow reuse the worker with one consent and no reads',
    () async {
      final h = await setup('messages-no-chain');
      final r = await h.run();
      expect(canonical(r['steps']), canonical(h.expected['result']['steps']));
      final o = h.operations.single;
      expect([o.consents, o.binds, o.signs, o.closes], [1, 1, 3, 1]);
      expect(h.paths, isEmpty);
      expect(
        h.checked,
        containsAll([
          'tbc_signWorkflow',
          'tbc_signMessage',
          'tbc_signTypedData',
        ]),
      );
    },
  );
  test(
    'native transaction then bound message uses existing material and fresh mutable reads on each request',
    () async {
      final h = await setup('native-message');
      for (var i = 0; i < 2; i++) {
        final r = await h.run();
        final rows = r['steps'] as List;
        expect(
          canonical(rows[0]['result']['transactions']),
          canonical(h.expected['result']['steps'][0]['result']['transactions']),
        );
        expect(
          canonical(rows[1]['result']),
          canonical(h.expected['result']['steps'][1]['result']),
        );
        final o = h.operations.last;
        expect([o.consents, o.binds, o.signs, o.closes], [1, 1, 2, 1]);
        expect(h.paths.length, i + 1); // Fresh UTXOs; no unused tip query.
      }
    },
  );
  test(
    'parallel batch preparation shares identical read replies without accepting colliding inputs',
    () async {
      final h = await setup('native-message');
      final second = copied(h.request['steps'][0]);
      second['id'] = 'second';
      h.request['steps'] = [h.request['steps'][0], second];
      await expectLater(h.run(), throwsStateError);
      expect(h.paths.length, 1);
      expect(h.paths.toSet().length, 1);
      expect(h.operations.single.signs, 0);
      expect(h.operations.single.binds, 0);
    },
  );
  test(
    'workflow requires a child grant evaluator before native begin',
    () async {
      final h = await setup('messages-no-chain');
      await expectLater(h.run(grants: false), throwsStateError);
      expect(h.operations, isEmpty);
    },
  );
  test(
    'per-child wallet policy rejects incomplete or foreign coverage before begin',
    () async {
      final h = await setup('native-message');
      for (final policies in [
        <String, dynamic>{},
        <String, dynamic>{'0' * 64: {}},
      ]) {
        await expectLater(
          h.worker.execute(
            scope: TbcSigningRequestScope(
              operationId: 'policy-scope',
              method: h.source['method'],
              navigation: h.nav,
              account: h.account,
              revision: 0,
            ),
            request: h.request,
            policiesByRequestHash: policies,
            requireAuthorized: () {},
            requireAuthorizedMethod: (_) {},
            isUnlocked: () => true,
          ),
          throwsStateError,
        );
      }
      expect(h.operations, isEmpty);
      expect(h.paths, isEmpty);
    },
  );
  test('missing child grant rejects before native begin', () async {
    final h = await setup('messages-no-chain');
    h.revokedGrant = 'tbc_signTypedData';
    await expectLater(h.run(), throwsStateError);
    expect(h.operations, isEmpty);
  });
  test(
    'single-only backend rejects and closes before material or consent',
    () async {
      final h = await setup('native-message');
      h.supported = false;
      await expectLater(h.run(), throwsStateError);
      final o = h.operations.single;
      expect([o.consents, o.binds, o.signs, o.closes], [0, 0, 0, 1]);
      expect(h.paths, isEmpty);
    },
  );
  test(
    'child grant revoked during consent does not issue receipt or signature',
    () async {
      final h = await setup('messages-no-chain');
      h.consentEntered = Completer();
      h.releaseConsent = Completer();
      final failed = expectLater(h.run(), throwsStateError);
      await h.consentEntered!.future;
      h.revokedGrant = 'tbc_signMessage';
      h.releaseConsent!.complete();
      await failed;
      expect(h.operations.single.signs, 0);
      expect(h.operations.single.binds, 0);
    },
  );
  test(
    'native-step revocation suppresses signatures and worker result',
    () async {
      final h = await setup('messages-no-chain');
      h.revokeAtEnter = true;
      await expectLater(h.run(), throwsStateError);
      expect(h.operations.single.signs, 0);
    },
  );
  test(
    'fixed unavailable code permits only independent continuation without retry',
    () async {
      final h = await setup('independent-failure-mode');
      h.unavailableAt = 'one';
      final r = await h.run();
      expect(r['steps'][0]['status'], 'failed');
      expect(r['steps'][1]['status'], 'skipped');
      expect(r['steps'][2]['result'], isNotNull);
      expect(h.operations.single.entered, ['one', 'three']);
      expect(h.operations.single.signs, 2);
      expect(h.paths, isEmpty);
    },
  );
  test(
    'arbitrary native error never becomes a recoverable step flag or leaks',
    () async {
      final h = await setup('independent-failure-mode');
      h.unavailableAt = 'one';
      h.arbitraryFailure = true;
      await expectLater(
        h.run(),
        throwsA(
          isA<StateError>().having(
            (e) => e.toString(),
            'sanitized',
            isNot(contains('secret')),
          ),
        ),
      );
      expect(h.operations.single.entered, ['one']);
      expect(h.operations.single.signs, 1);
    },
  );
  test('locked native snapshot stops before consent or reads', () async {
    final h = await setup('native-message');
    h.unlocked = false;
    await expectLater(h.run(), throwsStateError);
    expect(h.operations.single.consents, 0);
    expect(h.paths, isEmpty);
  });
}
