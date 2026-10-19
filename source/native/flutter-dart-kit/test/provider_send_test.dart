// Public Provider -> actual non-UI worker -> frozen Engine -> public-signature
// replay and broadcast double. Native SQLite/HTTP and device proof are separate.
import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/send_lifecycle.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_request.dart';
import 'provider_session_test.dart' show Delivery;
import 'send_worker_test.dart' as send;
import 'support/signing_replay.dart' as replay;

final class Control implements TbcProviderControl, TbcProviderOptionalMethods {
  Control(this.h);
  final send.Harness h;
  final grants = <String>{};
  @override
  final optionalMethods = <String>{...sendMethods};
  @override
  int revision = 0;
  @override
  bool isUnlocked = true;
  bool documentActive = true;
  @override
  TbcNetworkConfiguration get network => h.network;
  @override
  TbcWebViewNavigation get navigation => h.nav;
  @override
  TbcAccount get selectedAccount => h.account;
  @override
  void requireCurrent() => need(documentActive, 'TEST_CURRENT');
  @override
  bool permits(String name) => isUnlocked && grants.contains(name);
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
    revision++;
    return currentPermissions();
  }

  @override
  Future<void> disconnect(String operation) async {
    grants.clear();
    revision++;
  }

  @override
  Future<void> beforeDelivery(
    String method,
    Object id,
    String serialized,
  ) async {
    requireCurrent();
  }

  @override
  Future<void> cancel(String operation) async {}
  @override
  void invalidate() {
    documentActive = false;
    h.active = false;
  }
}

final class Session {
  Session(String method) : signing = send.Harness(method);
  final send.Harness signing;
  late final control = Control(signing);
  final delivery = Delivery();
  late TbcProviderSession session;
  int sequence = 0, policyCalls = 0;
  Future<void> start({bool enabled = true}) async {
    if (!enabled) control.optionalMethods.clear();
    await signing.start();
    session = await TbcProviderSession.open(
      configuration: TbcWalletConfiguration(
        productId: 'partner.wallet',
        name: 'Partner',
        profile: 'send-test',
        network: signing.network,
      ),
      control: control,
      delivery: delivery,
      worker: signing.worker,
      policy: (_) {
        policyCalls++;
        return copied(signing.policy);
      },
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
  Future<void> request(Object id, String method, [Object? params]) =>
      session.accept(
        frame('request', {
          'request': {
            'jsonrpc': '2.0',
            'id': id,
            'method': method,
            if (params != null) 'params': params,
          },
        }),
        source,
      );
  Set<String> get required => {
    'tbc_accounts',
    if (signing.workflow)
      ...workflowRequiredPermissions(signing.request, method: signing.method)
    else
      'tbc_sendTransaction',
  };
  Future<void> grant() => request('grant', 'wallet_requestPermissions', [
    {
      for (final name in required)
        name: {
          'chains': [signing.network.chainId],
        },
    },
  ]);
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
  setUpAll(replay.loadReplay);
  Future<Session> setup(String method, {bool enabled = true}) async {
    final h = Session(method);
    await h.start(enabled: enabled);
    addTearDown(h.close);
    return h;
  }

  for (final method in sendMethods) {
    test(
      'public send reuses one approval, shared material and exact result: $method',
      () async {
        final h = await setup(method);
        await h.request('capabilities', 'tbc_getCapabilities', {});
        expect(
          (h.response('capabilities')['result']['methods'] as Map).keys,
          containsAll(sendMethods),
        );
        await h.grant();
        expect(h.response('grant').containsKey('error'), false);
        await h.request('send', method, h.signing.request);
        expect(h.response('send').containsKey('error'), false);
        expect(
          canonical(h.response('send')['result']),
          canonical(h.signing.operation.finished),
        );
        expect(h.signing.operation.consents, 1);
        expect(h.signing.operation.posts, 1);
        expect(h.signing.operation.gets, 0);
        expect(h.signing.operation.closes, 1);
        expect(h.signing.paths, ['/api/tbc/utxo/address/${h.signing.account.address}']);
        expect(h.policyCalls, 1);
        // Replayed page request must not sign or submit twice.
        await h.request('send', method, h.signing.request);
        expect(h.signing.operation.posts, 1);
        expect(h.signing.operation.consents, 1);
      },
    );
    test('public send disabled without native sender: $method', () async {
      final h = await setup(method, enabled: false);
      await h.request('capabilities', 'tbc_getCapabilities', {});
      expect(
        (h.response('capabilities')['result']['methods'] as Map).keys.any(
          sendMethods.contains,
        ),
        false,
      );
      await h.grant();
      expect(h.response('grant')['error']['code'], 4200);
      h.control.grants.addAll(
        h.required,
      ); // A stale grant cannot add capability.
      await h.request('send', method, h.signing.request);
      expect(h.response('send')['error']['code'], 4200);
      expect(h.signing.paths, isEmpty);
      expect(h.signing.operation.consents, 0);
      expect(h.signing.operation.posts, 0);
    });
  }
  test(
    'public workflow signing grant does not authorize broadcasting',
    () async {
      final h = await setup('tbc_sendWorkflow');
      h.control.grants.addAll(h.required..remove('tbc_sendTransaction'));
      await h.request('send', h.signing.method, h.signing.request);
      expect(h.response('send')['error']['code'], 4100);
      expect(h.signing.paths, isEmpty);
      expect(h.signing.operation.consents, 0);
      expect(h.signing.operation.posts, 0);
    },
  );
  test(
    'public send final attestation failure cannot emit success or retry',
    () async {
      final h = await setup('tbc_sendPreparedTransaction');
      await h.grant();
      h.signing.operation.refuseFinish = true;
      await h.request('send', h.signing.method, h.signing.request);
      expect(h.response('send').containsKey('error'), true);
      expect(h.response('send').containsKey('result'), false);
      expect(h.signing.operation.consents, 1);
      expect(h.signing.operation.posts, 1);
      expect(h.signing.operation.gets, 0);
    },
  );
  test(
    'public send is sensitive to revocation while submission is pending',
    () async {
      final h = await setup('tbc_sendTransaction');
      await h.grant();
      h.signing.entered = Completer<void>();
      h.signing.released = Completer<void>();
      final pending = h.request('send', h.signing.method, h.signing.request);
      await h.signing.entered!.future;
      h.control.grants.remove('tbc_sendTransaction');
      h.control.revision++;
      await h.session.authorityChanged();
      h.signing.released!.complete();
      await pending;
      expect(h.response('send').containsKey('result'), false);
      expect(h.response('send')['error']['code'], 4100);
      expect(h.signing.operation.posts, 1);
      expect(h.signing.operation.consents, 1);
    },
  );
}
