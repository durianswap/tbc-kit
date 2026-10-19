// Whole Provider wire -> real isolate/Engine -> replay custody -> delivery.
// Public synthetic fixtures only; not installed WebView or private-key proof.
import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_request.dart';
import 'provider_session_test.dart' show Delivery;
import 'workflow_worker_test.dart' as replay;
import 'support/trusted_index_candidate.dart';

final class Control implements TbcProviderControl, TbcProviderOptionalMethods {
  Control(this.h);
  final replay.Harness h;
  final grants = <String>{};
  bool crypto = false;
  @override
  Set<String> get optionalMethods =>
      crypto ? {'tbc_encrypt', 'tbc_decrypt'} : {};
  int permissionWrites = 0, deliveryChecks = 0;
  @override
  int revision = 0;
  @override
  bool get isUnlocked => h.unlocked;
  @override
  TbcNetworkConfiguration get network => h.network;
  @override
  TbcWebViewNavigation get navigation => h.nav;
  @override
  TbcAccount get selectedAccount => h.account;
  @override
  void requireCurrent() => need(h.active, 'TEST_NATIVE_SCOPE');
  @override
  bool permits(String capability) => h.unlocked && grants.contains(capability);
  @override
  List<Map<String, dynamic>> currentPermissions() => [
    for (final name in grants) {'parentCapability': name},
  ];
  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest r,
  ) async {
    requireCurrent();
    grants.addAll(r.permissions.keys);
    permissionWrites++;
    revision++;
    return currentPermissions();
  }

  @override
  Future<void> disconnect(String id) async {
    grants.clear();
    revision++;
  }

  @override
  Future<void> cancel(String id) async {}
  @override
  void invalidate() {
    h.active = false;
  }

  @override
  Future<void> beforeDelivery(String method, Object id, String text) async {
    requireCurrent();
    deliveryChecks++;
  }
}

final class Harness {
  Harness(String name) : signing = replay.Harness(name);
  final replay.Harness signing;
  final delivery = Delivery();
  late final control = Control(signing);
  late TbcProviderSession session;
  int sequence = 0;
  final policies = <Map<String, dynamic>>[];
  Completer<void>? policyEntered, releasePolicy;
  bool invalidPolicy = false;
  Future<void> start({bool customPolicy = true}) async {
    // Refresh public proposal deadlines only; frozen txs/fees remain unchanged.
    for (final step in signing.request['steps']) {
      final proposal = step['proposal'];
      if (proposal == null) continue;
      proposal['payload']['createdAt'] = tbcProtocolTimestamp(DateTime.now());
      proposal['payload']['expiresAt'] = signing.request['expiresAt'];
      proposal['payload']['evidence']['observedAt'] =
          proposal['payload']['createdAt'];
      proposal['proposalHash'] = hashJson(proposal['payload']);
    }
    await signing.start();
    session = await TbcProviderSession.open(
      configuration: TbcWalletConfiguration(
        productId: 'workflow.test',
        name: 'Test',
        profile: 'partner',
        network: signing.network,
      ),
      control: control,
      delivery: delivery,
      worker: signing.worker,
      policy:
          customPolicy
              ? (request) async {
                policies.add(copied(request));
                if (!(policyEntered?.isCompleted ?? true))
                  policyEntered!.complete();
                await releasePolicy?.future;
                final p = copied(
                  (signing.source['materials'] as Map).values.first['policy'],
                );
                p['payload']['expiresAt'] = signing.request['expiresAt'];
                p['policyHash'] = hashJson(p['payload']);
                if (invalidPolicy) p['policyHash'] = '0' * 64;
                return p;
              }
              : null,
    );
    await session.accept(frame('ready'), source);
  }

  TbcWebViewMessageSource get source => TbcWebViewMessageSource(
    webViewInstanceId: signing.nav.webViewInstanceId,
    sessionId: signing.nav.sessionId,
    navigationId: signing.nav.navigationId,
    origin: signing.nav.origin,
    topOrigin: signing.nav.origin,
    isMainFrame: true,
  );
  String frame(String type, [Map extra = const {}]) => canonical({
    'channel': 'tws-webview/1',
    'type': type,
    'sessionId': signing.nav.sessionId,
    'navigationId': signing.nav.navigationId,
    'messageId': 'page-${++sequence}',
    ...extra,
  });
  Future<void> request(Object id, String method, Object params) =>
      session.accept(
        frame('request', {
          'request': {
            'jsonrpc': '2.0',
            'id': id,
            'method': method,
            'params': params,
          },
        }),
        source,
      );
  Future<void> grant() => request('grant', 'wallet_requestPermissions', [
    {
      for (final method in TbcProviderSession.permissionNames)
        method: {
          'chains': [signing.network.chainId],
        },
    },
  ]);
  Future<void> run([Object id = 1]) =>
      request(id, signing.source['method'], signing.request);
  Map response(Object id) =>
      delivery.frames.lastWhere(
        (f) => f['type'] == 'delivery' && f['response']['id'] == id,
      )['response'];
  Future<void> close() async {
    await session.close();
    await signing.worker.close();
  }
}

void main() {
  setUpAll(() {
    replay.planning = replay.readFixture('workflow-planning');
    replay.signing = replay.readFixture('workflow-signing');
    replay.library = trustedIndexCandidateLibrary();
  });
  Future<Harness> setup(String name, {bool customPolicy = true}) async {
    final h = Harness(name);
    await h.start(customPolicy: customPolicy);
    addTearDown(h.close);
    await h.grant();
    expect(h.response('grant')['error'], isNull);
    return h;
  }

  for (final name in [
    'messages-no-chain',
    'native-message',
    'prepared-typed',
  ]) {
    test(
      'Provider $name returns frozen results through one batch consent',
      () async {
        final h = await setup(name);
        await h.run();
        final r = h.response(1);
        expect(r['error'], isNull, reason: '$r');
        final rows = r['result']['steps'] as List;
        for (var i = 0; i < rows.length; i++) {
          final actual = copied(rows[i]),
              expected = copied(h.signing.expected['result']['steps'][i]);
          // Plan hashes include refreshed deadlines, not transaction semantics.
          actual['result']?.remove('planHash');
          expected['result']?.remove('planHash');
          if (actual['result']?.containsKey('approvalId') == true) {
            expect(actual['result']['approvalId'], 'worker-offline');
            expected['result']['approvalId'] = 'worker-offline';
          }
          expect(canonical(actual), canonical(expected));
        }
        final op = h.signing.operations.single;
        expect([op.consents, op.binds, op.closes], [1, 1, 1]);
        expect(h.signing.paths, name == 'messages-no-chain' ? isEmpty : ['/api/tbc/utxo/address/${h.signing.account.address}']);
        expect(h.policies.length, name == 'messages-no-chain' ? 0 : 1);
        if (h.policies.isNotEmpty) {
          expect(
            canonical(h.policies.single),
            canonical(
              workflowTransactionRequest(
                h.signing.request,
                h.signing.request['steps'][0],
              ),
            ),
          );
          expect(h.policies.single.containsKey('proposal'), false);
        }
        expect(h.control.permissionWrites, 1);
      },
    );
  }
  test('Provider defaults add no policy callbacks or reads', () async {
    final h = await setup('native-message', customPolicy: false);
    await h.run();
    expect(h.response(1)['error'], isNull);
    expect(h.policies, isEmpty);
    expect(h.signing.paths, ['/api/tbc/utxo/address/${h.signing.account.address}']);
    expect(h.signing.operations.single.consents, 1);
  });
  test(
    'same child projection reuses policy and reads but rejects shared inputs',
    () async {
      final h = await setup('native-message');
      final first = h.signing.request['steps'][0];
      h.signing.request['steps'] = [
        first,
        {...copied(first), 'id': 'second'},
      ];
      await h.run();
      expect(h.response(1)['error'], isNotNull);
      expect(h.policies.length, 1);
      expect(h.signing.paths, ['/api/tbc/utxo/address/${h.signing.account.address}']);
      expect(h.signing.operations.single.binds, 0);
      expect(h.signing.operations.single.signs, 0);
    },
  );
  test(
    'missing child grant denies before custom policy, material and native begin',
    () async {
      final h = await setup('native-message');
      h.control.grants.remove('tbc_signTransaction');
      await h.run();
      expect(h.response(1)['error']['code'], 4100);
      expect(h.policies, isEmpty);
      expect(h.signing.paths, isEmpty);
      expect(h.signing.operations, isEmpty);
    },
  );
  test(
    'grant revoked while custom policy waits denies before native begin',
    () async {
      final h = await setup('native-message');
      h.policyEntered = Completer();
      h.releasePolicy = Completer();
      final pending = h.run();
      await h.policyEntered!.future;
      h.control.grants.remove('tbc_signTransaction');
      h.releasePolicy!.complete();
      await pending;
      expect(h.response(1)['error']['code'], 4100);
      expect(h.signing.paths, isEmpty);
      expect(h.signing.operations, isEmpty);
    },
  );
  test('custom policy cannot be ignored by workflow preparation', () async {
    final h = await setup('native-message');
    h.invalidPolicy = true;
    await h.run();
    expect(h.response(1)['error']['code'], -32603);
    expect(h.signing.paths, isEmpty);
    expect(h.signing.operations.single.signs, 0);
  });
  test(
    'child grant revoked during batch consent prevents binding and signing',
    () async {
      final h = await setup('messages-no-chain');
      h.signing.consentEntered = Completer();
      h.signing.releaseConsent = Completer();
      final pending = h.run();
      await h.signing.consentEntered!.future;
      h.control.grants.remove('tbc_signTypedData');
      h.signing.releaseConsent!.complete();
      await pending;
      expect(h.response(1)['error'], isNotNull);
      expect(h.signing.operations.single.binds, 0);
      expect(h.signing.operations.single.signs, 0);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'malformed topology is rejected before policy or native begin',
    () async {
      final h = await setup('native-message');
      h.signing.request['steps'][0]['dependsOn'] = ['receipt'];
      await h.run();
      expect(h.response(1)['error']['code'], -32602);
      expect(h.policies, isEmpty);
      expect(h.signing.operations, isEmpty);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'one recoverable failure returns failed, skipped and independent success',
    () async {
      final h = await setup('independent-failure-mode');
      h.signing.unavailableAt = 'one';
      await h.run();
      expect(h.response(1)['error'], isNull);
      final steps = h.response(1)['result']['steps'];
      expect(steps.map((s) => s['status']).toList(), [
        'failed',
        'skipped',
        null,
      ]);
      expect(steps[2]['result'], isNotNull);
      expect(h.signing.operations.single.consents, 1);
      expect(h.signing.paths, isEmpty);
    },
  );
  test('uninstalled crypto is unsupported before reads or consent', () async {
    final h = await setup('messages-no-chain');
    h.signing.request = copied(
      (replay.planning['cases'] as List).singleWhere(
        (c) => c['name'] == 'five-mixed-kinds',
      )['request'],
    );
    h.signing.request['expiresAt'] = tbcProtocolTimestamp(
      DateTime.now().add(const Duration(minutes: 2)),
    );
    await h.run();
    expect(h.response(1)['error']['code'], 4200);
    expect(h.policies, isEmpty);
    expect(h.signing.paths, isEmpty);
    expect(h.signing.operations, isEmpty);
  });
}
