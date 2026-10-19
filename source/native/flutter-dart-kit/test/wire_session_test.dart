import 'dart:async';
import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/webview_scope.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';

final class Delivery implements TbcDocumentDelivery {
  final List<Map> frames = [], descriptors = [];
  int closes = 0;
  @override
  Future<bool> deliver(String text, TbcWebViewNavigation expected) async {
    frames.add(jsonDecode(text) as Map);
    return true;
  }

  @override
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  ) async {
    descriptors.add(value);
    return true;
  }

  @override
  Future<void> close(TbcWebViewNavigation expected) async {
    closes++;
  }
}

final class Harness {
  Harness({
    TbcNetwork network = TbcNetwork.testnet,
    TbcNativeWalletProtocol walletProtocol = TbcNativeWalletProtocol.standard,
  }) {
    wire = TbcWireSession(
      platform: delivery,
      walletProtocol: walletProtocol,
      navigation: navigation,
      configuration: TbcWalletConfiguration(
        productId: 'partner.wallet',
        name: 'Partner Wallet',
        profile: 'partner',
        network: TbcNetworkConfiguration.official(network),
      ),
      execute: (method, params, operation, id) async {
        calls++;
        return handler(method, params, operation, id);
      },
      cancel: (id) async {
        cancelled.add(id);
        await holdCancellation?.future;
      },
      invalidateNative: () {
        invalidations++;
        current = false;
      },
      requireCurrent: () {
        need(current, 'NATIVE_STALE');
      },
      beforeDelivery: (method, id, text) async {
        deliveryChecks++;
        need(current && grantCurrent, 'DELIVERY_STALE');
        await holdDelivery?.future;
        need(current && grantCurrent, 'DELIVERY_STALE');
      },
      sensitiveMethods: const {'tbc_signMessage', 'tbc_signTransaction'},
    );
  }
  final delivery = Delivery();
  late TbcWireSession wire;
  bool current = true, grantCurrent = true;
  int calls = 0, invalidations = 0, deliveryChecks = 0, sequence = 0;
  final List<String> cancelled = [];
  Completer<void>? holdDelivery;
  Completer<void>? holdCancellation;
  TbcWireExecute handler = (m, p, o, id) async => TbcWireOutcome({'id': id});
  final navigation = TbcWebViewNavigation(
    webViewInstanceId: 'view',
    sessionId: 'session',
    navigationId: 'document',
    committedUrl: 'https://example.test/app',
    origin: 'https://example.test',
    createdAt: '2026-10-12T00:00:00.000Z',
  );
  TbcWebViewMessageSource source({bool mainFrame = true}) =>
      TbcWebViewMessageSource(
        webViewInstanceId: navigation.webViewInstanceId,
        sessionId: navigation.sessionId,
        navigationId: navigation.navigationId,
        origin: navigation.origin,
        topOrigin: navigation.origin,
        isMainFrame: mainFrame,
      );
  String frame(String type, [Map<String, Object?> extra = const {}]) =>
      canonical({
        'channel': wire.walletProtocol.wireChannel,
        'type': type,
        'sessionId': navigation.sessionId,
        'navigationId': navigation.navigationId,
        'messageId': 'page-${++sequence}',
        ...extra,
      });
  Future<void> start() async {
    await wire.start();
    await wire.accept(frame('ready'), source());
  }

  Future<void> request(
    Object id, {
    String method = 'tbc_chainId',
    Object? params,
  }) => wire.accept(
    frame('request', {
      'request': {
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        if (params != null) 'params': params,
      },
    }),
    source(),
  );
  List<Map> get results =>
      delivery.frames.where((f) => f['type'] == 'delivery').toList();
}

void main() {
  for (final protocol in TbcNativeWalletProtocol.values) {
    test('$protocol settled cancellation releases slots without replay', () async {
      final h = Harness(walletProtocol: protocol);
      await h.start();
      addTearDown(h.wire.close);
      for (var i = 0; i < 150; i++) {
        final entered = Completer<void>(), hold = Completer<void>();
        h.handler = (m, p, o, id) async {
          entered.complete();
          await hold.future;
          return TbcWireOutcome('late');
        };
        final pending = h.request(i, method: 'tbc_signMessage');
        await entered.future;
        await h.wire.accept(h.frame('cancel', {
          'requestId': i, 'reason': 'REQUEST_ABORTED',
        }), h.source());
        hold.complete();
        await pending;
        expect(h.wire.isActive, isTrue);
      }
      expect(h.results, isEmpty);
      await h.request(0, method: 'tbc_signMessage');
      expect(h.calls, 150);
      h.handler = (m, p, o, id) async => TbcWireOutcome('ok');
      await h.request(150);
      expect(h.calls, 151);
      expect(h.results.single['response']['result'], 'ok');
      await h.request(0, method: 'tbc_signMessage', params: {'changed': true});
      expect(h.wire.isActive, isFalse);
    });
  }
  test('cancelled executors still running retain the concurrency bound', () async {
    final h = Harness(), hold = Completer<void>();
    await h.start();
    final pending = <Future<void>>[];
    h.handler = (m, p, o, id) async { await hold.future; return TbcWireOutcome(null); };
    for (var i = 0; i < 128; i++) {
      pending.add(h.request(i));
      await h.wire.accept(h.frame('cancel', {'requestId': i, 'reason': 'REQUEST_ABORTED'}), h.source());
    }
    await h.request(128);
    expect(h.calls, 128);
    expect(h.wire.isActive, isFalse);
    hold.complete();
    await Future.wait(pending);
  });
  test('completed cancellation accepts late ACK and cannot replay', () async {
    final h = Harness();
    await h.start();
    addTearDown(h.wire.close);
    for (var i = 0; i < 150; i++) {
      await h.request(i);
      final deliveryId = h.results.last['deliveryId'];
      await h.wire.accept(h.frame('cancel', {'requestId': i, 'reason': 'REQUEST_ABORTED'}), h.source());
      await h.wire.accept(h.frame('ack', {'deliveryId': deliveryId}), h.source());
      expect(h.wire.isActive, isTrue);
    }
    await h.request(0);
    expect(h.calls, 150);
  });
  test('ack releases in-flight slots while old requests cannot replay', () async {
    final h = Harness();
    await h.start();
    addTearDown(h.wire.close);
    String? firstDelivery;
    for (var i = 0; i < 1100; i++) {
      await h.request(i, method: 'tbc_signMessage');
      final id = h.results.last['deliveryId'] as String;
      firstDelivery ??= id;
      await h.wire.accept(h.frame('ack', {'deliveryId': id}), h.source());
    }
    expect(h.calls, 1100);
    expect(h.wire.isActive, isTrue);
    await h.request(0, method: 'tbc_signMessage');
    await h.wire.accept(
      h.frame('ack', {'deliveryId': firstDelivery}), h.source());
    expect(h.calls, 1100);
    expect(h.wire.isActive, isTrue);
    await h.request(0, method: 'tbc_signMessage', params: {'changed': true});
    expect(h.calls, 1100);
    expect(h.wire.isActive, isFalse);
  });

  test('unacknowledged requests retain the 128 in-flight bound', () async {
    final h = Harness();
    await h.start();
    addTearDown(h.wire.close);
    for (var i = 0; i < 129; i++) { await h.request(i); }
    expect(h.calls, 128);
    expect(h.wire.isActive, isFalse);
  });

  test(
    'Legacy transport reuses replay/cancel without a second discovery wallet',
    () async {
      final h = Harness(walletProtocol: TbcNativeWalletProtocol.legacy);
      await h.start();
      addTearDown(h.wire.close);
      expect(
        h.delivery.frames.single['channel'],
        'legacy-window-turing-shared/1',
      );
      expect(h.delivery.descriptors, isEmpty);
      await h.request(1, method: 'getNetwork');
      await h.request(1, method: 'getNetwork');
      expect(h.calls, 1);
      expect(h.results.length, 2);
      expect(h.deliveryChecks, 2);
      final held = Completer<void>(), entered = Completer<void>();
      h.handler = (m, p, o, id) async {
        entered.complete();
        await held.future;
        return TbcWireOutcome('late');
      };
      final pending = h.request(2, method: 'signMessage');
      await entered.future;
      await h.wire.accept(
        h.frame('cancel', {'requestId': 2, 'reason': 'REQUEST_ABORTED'}),
        h.source(),
      );
      held.complete();
      await pending;
      expect(h.cancelled.length, 1);
      expect(h.results.length, 2);
    },
  );
  test(
    'protocol channels are not interchangeable in either direction',
    () async {
      for (final profile in TbcNativeWalletProtocol.values) {
        final h = Harness(walletProtocol: profile);
        await h.start();
        final foreign = TbcNativeWalletProtocol.values.singleWhere(
          (p) => p != profile,
        );
        await h.wire.accept(
          h.frame('request', {
            'channel': foreign.wireChannel,
            'request': {'jsonrpc': '2.0', 'id': 1, 'method': 'getNetwork'},
          }),
          h.source(),
        );
        expect(h.calls, 0);
        expect(h.wire.isActive, false);
      }
    },
  );
  test('wallet identity and main/test chain come from configuration', () async {
    for (final network in TbcNetwork.values) {
      final h = Harness(network: network);
      await h.start();
      addTearDown(h.wire.close);
      expect(h.delivery.frames.single['chainId'], network.chainId);
      expect(h.delivery.descriptors.single['name'], 'Partner Wallet');
      expect(h.delivery.descriptors.single['productId'], 'partner.wallet');
      expect(h.delivery.descriptors.single['chains'], [network.chainId]);
    }
  });

  test(
    'concurrent requests run independently; replay never executes twice',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      final hold = Completer<void>(), entered = Completer<void>();
      h.handler = (m, p, o, id) async {
        if (id == 1) {
          entered.complete();
          await hold.future;
        }
        return TbcWireOutcome(id);
      };
      final first = h.request(1);
      await entered.future;
      await h.request(1); // same request while first remains pending
      await h.request(2);
      expect(h.results.single['response']['id'], 2);
      expect(h.calls, 2);
      hold.complete();
      await first;
      await h.request(1);
      expect(h.calls, 2);
      expect(h.results.length, 3);
      expect(h.deliveryChecks, 3);
    },
  );

  test('ACK drops cached result but retains execution tombstone', () async {
    final h = Harness();
    await h.start();
    addTearDown(h.wire.close);
    await h.request('a');
    final id = h.results.single['deliveryId'];
    await h.wire.accept(h.frame('ack', {'deliveryId': id}), h.source());
    await h.request('a');
    expect(h.calls, 1);
    expect(h.results.length, 1);
  });

  test(
    'cached result replay still checks current delivery authority',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      await h.request(1);
      h.grantCurrent = false;
      await h.request(1);
      expect(h.calls, 1);
      expect(h.results.length, 1);
      expect(h.deliveryChecks, 2);
      expect(h.invalidations, 1);
      expect(h.wire.isActive, isFalse);
    },
  );

  test(
    'forged native frame and same-id changed input close before execution',
    () async {
      final h = Harness();
      await h.start();
      await h.wire.accept(
        h.frame('request', {
          'request': {'jsonrpc': '2.0', 'id': 1, 'method': 'tbc_chainId'},
        }),
        h.source(mainFrame: false),
      );
      expect(h.calls, 0);
      expect(h.invalidations, 1);
      final other = Harness();
      await other.start();
      await other.request(1);
      await other.request(1, method: 'tbc_signMessage');
      expect(other.calls, 1);
      expect(other.wire.isActive, isFalse);
    },
  );

  test(
    'cancel suppresses a late result without cancelling unrelated requests',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      final hold = Completer<void>(), entered = Completer<void>();
      h.handler = (m, p, o, id) async {
        if (id == 1) {
          entered.complete();
          await hold.future;
        }
        return TbcWireOutcome(id);
      };
      final first = h.request(1, method: 'tbc_signMessage');
      await entered.future;
      await h.wire.accept(
        h.frame('cancel', {'requestId': 1, 'reason': 'REQUEST_ABORTED'}),
        h.source(),
      );
      await h.request(2);
      hold.complete();
      await first;
      expect(h.cancelled, [rpcOperationId('session', 1)]);
      expect(h.results.single['response']['id'], 2);
      expect(h.wire.isActive, isTrue);
    },
  );

  test(
    'grant mutation rejects pending sensitive result and emits committed events',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      final hold = Completer<void>(), entered = Completer<void>();
      h.handler = (m, p, o, id) async {
        if (id == 1) {
          entered.complete();
          await hold.future;
          return TbcWireOutcome('late');
        }
        return TbcWireOutcome(
          null,
          authorizationChanged: true,
          events: [
            {'name': 'accountsChanged', 'payload': <Object?>[]},
          ],
        );
      };
      final first = h.request(1, method: 'tbc_signMessage');
      await entered.future;
      await h.request(2, method: 'tbc_disconnect');
      hold.complete();
      await first;
      expect(h.results.length, 2);
      expect(h.results.first['response']['error']['code'], 4100);
      expect(h.results.last['events'], [
        {'name': 'accountsChanged', 'payload': []},
      ]);
      expect(h.cancelled, [rpcOperationId('session', 1)]);
    },
  );

  test(
    'native-originated change cancels pending signing and emits current events',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      final hold = Completer<void>(), entered = Completer<void>();
      h.handler = (m, p, o, id) async {
        entered.complete();
        await hold.future;
        return TbcWireOutcome('stale signature');
      };
      final pending = h.request(1, method: 'tbc_signMessage');
      await entered.future;
      await h.wire.authorityChanged([
        {'name': 'permissionsChanged', 'payload': []},
        {'name': 'accountsChanged', 'payload': []},
      ]);
      hold.complete();
      await pending;
      expect(h.results.single['response']['error']['code'], 4100);
      expect(h.cancelled, [rpcOperationId('session', 1)]);
      expect(h.delivery.frames.where((f) => f['type'] == 'event').length, 2);
      expect(canonical(h.delivery.frames), isNot(contains('stale signature')));
    },
  );

  test(
    'native error details are not delivered and navigation fences async delivery',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.wire.close);
      h.handler =
          (m, p, o, id) async => throw StateError('private-native-diagnostic');
      await h.request(1);
      expect(canonical(h.results.single), isNot(contains('private-native')));
      expect(h.results.single['response']['error']['code'], -32603);
      h.holdDelivery = Completer<void>();
      final pending = h.request(2);
      while (h.deliveryChecks < 2) {
        await Future<void>.delayed(Duration.zero);
      }
      h.wire.invalidate();
      h.holdDelivery!.complete();
      await pending;
      expect(h.results.length, 1);
      expect(h.invalidations, 1);
    },
  );
}
