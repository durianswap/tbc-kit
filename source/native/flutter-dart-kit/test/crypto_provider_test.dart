// Provider wire + real isolate + replay custody. Native/device proof is separate.
import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'provider_session_test.dart' show Delivery;
import 'crypto_worker_test.dart' as worker;
import 'crypto_action_test.dart' as replay;

final class Control implements TbcProviderControl, TbcProviderOptionalMethods {
  Control(this.h);
  final worker.Harness h;
  final grants = <String>{};
  int permissionWrites = 0, deliveryChecks = 0;
  bool cryptoEnabled = true;
  @override
  Set<String> get optionalMethods =>
      cryptoEnabled ? {'tbc_encrypt', 'tbc_decrypt'} : {};
  @override
  int revision = 0;
  @override
  bool get isUnlocked => h.source.unlocked;
  @override
  TbcNetworkConfiguration get network => h.worker.network;
  @override
  TbcWebViewNavigation get navigation => h.navigation;
  @override
  TbcAccount get selectedAccount => TbcAccount(
    network: network.network,
    address: h.source.sample['account']['address'],
    publicKey: h.source.sample['account']['publicKey'],
  );
  @override
  void requireCurrent() => need(h.source.authorized, 'TEST_NATIVE_SCOPE');
  @override
  bool permits(String capability) => isUnlocked && grants.contains(capability);
  @override
  List<Map<String, dynamic>> currentPermissions() => [
    for (final name in grants) {'parentCapability': name},
  ];
  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest request,
  ) async {
    requireCurrent();
    grants.addAll(request.permissions.keys);
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
    h.source.authorized = false;
  }

  @override
  Future<void> beforeDelivery(String method, Object id, String text) async {
    requireCurrent();
    deliveryChecks++;
    if ((method == 'tbc_encrypt' || method == 'tbc_decrypt') &&
        (jsonDecode(text)['response'] as Map).containsKey('result')) {
      need(permits('tbc_crypto'), 'CRYPTO_GRANT_LOST');
    }
  }
}

final class Harness {
  Harness([int index = 0]) : signing = worker.Harness(index);
  final worker.Harness signing;
  final delivery = Delivery();
  late final control = Control(signing);
  late TbcProviderSession session;
  int sequence = 0;
  Future<void> start() async {
    await signing.start();
    session = await TbcProviderSession.open(
      configuration: TbcWalletConfiguration(
        productId: 'crypto.test',
        name: 'Test',
        profile: 'partner',
        network: signing.worker.network,
      ),
      control: control,
      delivery: delivery,
      worker: signing.worker,
    );
    await session.accept(frame('ready'), source);
  }

  TbcWebViewMessageSource get source => TbcWebViewMessageSource(
    webViewInstanceId: signing.navigation.webViewInstanceId,
    sessionId: signing.navigation.sessionId,
    navigationId: signing.navigation.navigationId,
    origin: signing.navigation.origin,
    topOrigin: signing.navigation.origin,
    isMainFrame: true,
  );
  String frame(String type, [Map extra = const {}]) => canonical({
    'channel': 'tws-webview/1',
    'type': type,
    'sessionId': signing.navigation.sessionId,
    'navigationId': signing.navigation.navigationId,
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
  Future<void> grant({bool crypto = true}) =>
      request('grant', 'wallet_requestPermissions', [
        {
          for (final name in ['tbc_accounts', if (crypto) 'tbc_crypto'])
            name: {
              'chains': [control.network.chainId],
            },
        },
      ]);
  Future<void> run() => request(
    'operation',
    signing.source.sample['method'],
    signing.source.sample['request'],
  );
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
  for (var i = 0; i < (replay.fixture['cases'] as List).length; i++) {
    test(
      'public BIE1 ${replay.fixture['cases'][i]['name']} one approval and exact result',
      () async {
        final h = Harness(i);
        await h.start();
        addTearDown(h.close);
        await h.grant();
        await h.request('capabilities', 'tbc_getCapabilities', {});
        expect(
          (h.response('capabilities')['result']['methods'] as Map).keys,
          containsAll(['tbc_encrypt', 'tbc_decrypt']),
        );
        final writes = h.control.permissionWrites;
        await h.run();
        expect(
          canonical(h.response('operation')['result']),
          canonical(h.signing.source.sample['result']),
        );
        expect(
          [
            h.signing.operation.consents,
            h.signing.operation.binds,
            h.signing.operation.cryptos,
            h.signing.operation.closes,
          ],
          [1, 1, 1, 1],
        );
        expect(h.signing.reads, 0);
        expect(h.control.permissionWrites, writes);
        // Same request ID is replayed by transport, never by the Vault.
        await h.run();
        expect(h.signing.operation.cryptos, 1);
      },
    );
  }
  test(
    'missing native crypto is not advertised, granted or executed',
    () async {
      final h = Harness()..control.cryptoEnabled = false;
      await h.start();
      addTearDown(h.close);
      await h.request('capabilities', 'tbc_getCapabilities', {});
      expect(
        (h.response('capabilities')['result']['methods'] as Map).keys,
        isNot(contains('tbc_encrypt')),
      );
      await h.grant();
      expect(h.response('grant')['error']['code'], 4200);
      expect(h.control.permissionWrites, 0);
      await h.run();
      expect(h.response('operation')['error']['code'], 4200);
      expect(h.signing.operation.consents, 0);
    },
  );
  test('discovery and accounts grant do not authorize crypto', () async {
    final h = Harness();
    await h.start();
    addTearDown(h.close);
    await h.grant(crypto: false);
    await h.run();
    expect(h.response('operation')['error']['code'], 4100);
    expect(h.signing.operation.consents, 0);
  });
  test(
    'invalid crypto gets fixed invalid-params, not private details',
    () async {
      final h = Harness();
      h.signing.source.sample['request']['algorithm'] = 'private-invalid-text';
      await h.start();
      addTearDown(h.close);
      await h.grant();
      await h.run();
      expect(h.response('operation')['error'], {
        'code': -32602,
        'message': 'Invalid parameters',
      });
      expect(h.signing.operation.consents, 0);
      expect(h.signing.reads, 0);
    },
  );
  test('native rejection uses common one-approval refusal', () async {
    final h = Harness()..signing.operation.approved = false;
    await h.start();
    addTearDown(h.close);
    await h.grant();
    await h.run();
    expect(h.response('operation')['error']['code'], 4001);
    expect(h.signing.operation.cryptos, 0);
  });
}
