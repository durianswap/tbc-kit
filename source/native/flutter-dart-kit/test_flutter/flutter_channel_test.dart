import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tbc_kit_flutter_dart/flutter_wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';
import 'package:tbc_kit_flutter_dart/src/webview_scope.dart';
import '../test/native_wallet_binding_test.dart' show NativeChannel;
import '../test/support/signing_replay.dart' as replay;

class ProtocolNative extends NativeChannel {
  ProtocolNative(this.navigation);
  @override
  final TbcWebViewNavigation navigation;
  @override
  Future<Object?> invoke(String method, Map<String, Object?> args) async {
    if (method == 'permissions.disconnect') {
      calls.add(method);
      arguments.add(args);
      grants.clear();
      revision++;
      return {'ok': true, 'value': null, 'snapshot': snapshot()};
    }
    return super.invoke(method, args);
  }
}

// Host-only Flutter channels + production package composition/worker; mocked native
// endpoints. Actual native SDK compilation and custody have separate evidence.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const walletChannel = MethodChannel('io.tbc.kit.dart/private-wallet');
  const viewChannel = MethodChannel('io.tbc.kit.dart/private-webview');
  const codec = StandardMethodCodec();
  setUpAll(replay.loadReplay);
  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      walletChannel,
      null,
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(viewChannel, null);
  });
  Future<void> event(
    String channel,
    String method,
    Map<String, Object?> value,
  ) async {
    final done = Completer<void>();
    binding.channelBuffers.push(
      channel,
      codec.encodeMethodCall(MethodCall(method, value)),
      (_) => done.complete(),
    );
    await done.future;
  }

  Future<TbcFlutterWallet> open(NativeChannel native, {bool legacy = false}) =>
      TbcFlutterWallet.open(
        configuration: TbcWalletConfiguration(
          productId: 'partner.example',
          name: 'Partner',
          profile: 'candidate',
          network: native.material.network,
          legacy: legacy,
        ),
        compute: TbcPinnedComputeLibrary(
          path: replay.replay['library']['path'],
          sha256: replay.replay['library']['sha256'],
        ),
      );
  Map<String, Object?> owner(NativeChannel h) => {
    'ownerId': 'owner',
    'webViewInstanceId': h.navigation.webViewInstanceId,
    'markerSource': '/* tbc-native-view:${h.navigation.webViewInstanceId} */',
    'legacyPageSupported': false,
  };

  test(
    'dual Flutter composition routes identical IDs and isolated grants without a fallback',
    () async {
      final standard = NativeChannel(),
          legacy = ProtocolNative(standard.navigation);
      final frames = <Map>[], pending = <String, Completer<Map>>{};
      final initialized = Completer<void>();
      int boots = 0, descriptions = 0, sequence = 0;
      binding.defaultBinaryMessenger.setMockMethodCallHandler(walletChannel, (
        call,
      ) {
        final a = Map<String, Object?>.from(call.arguments as Map);
        final selected =
            a['walletProtocol'] == TbcNativeWalletProtocol.legacy.namespace
                ? legacy
                : standard;
        return selected.invoke(call.method, a);
      });
      binding.defaultBinaryMessenger.setMockMethodCallHandler(viewChannel, (
        call,
      ) async {
        if (call.method == 'create')
          return {...owner(standard), 'legacyPageSupported': true};
        if (call.method == 'describe') descriptions++;
        if (call.method == 'deliver' || call.method == 'deliverLegacy') {
          final frame = jsonDecode(call.arguments['serialized']) as Map;
          frames.add(frame);
          expect(
            frame['channel'],
            call.method == 'deliver'
                ? 'tws-webview/1'
                : 'legacy-window-turing-shared/1',
          );
          if (frame['type'] == 'initialize' && ++boots == 2)
            initialized.complete();
          if (frame['type'] == 'delivery')
            pending
                .remove('${frame['channel']}/${frame['response']['id']}')
                ?.complete(frame['response'] as Map);
        }
        return true;
      });
      final wallet = await open(standard, legacy: true);
      addTearDown(wallet.dispose);
      final view = await wallet.createWebView();
      await view.attach(platformViewId: 7);
      final nav = standard.navigation;
      Future<void> page(
        String type,
        TbcNativeWalletProtocol protocol, [
        Map<String, Object?> fields = const {},
      ]) => event(viewChannel.name, 'event', {
        'ownerId': 'owner',
        'type': 'message',
        'body': {
          'source': {
            'webViewInstanceId': nav.webViewInstanceId,
            'sessionId': nav.sessionId,
            'navigationId': nav.navigationId,
            'origin': nav.origin,
            'topOrigin': nav.origin,
            'isMainFrame': true,
          },
          'serialized': canonical({
            'channel': protocol.wireChannel,
            'type': type,
            'sessionId': nav.sessionId,
            'navigationId': nav.navigationId,
            'messageId': 'page-${++sequence}',
            ...fields,
          }),
        },
      });
      Future<Map> request(
        TbcNativeWalletProtocol protocol,
        Object id,
        String method,
        Object? params,
      ) async {
        final result = Completer<Map>();
        pending['${protocol.wireChannel}/$id'] = result;
        await page('request', protocol, {
          'request': {
            'jsonrpc': '2.0',
            'id': id,
            'method': method,
            'params': params,
          },
        });
        return result.future.timeout(const Duration(seconds: 5));
      }

      await event(viewChannel.name, 'event', {
        'ownerId': 'owner',
        'type': 'navigation',
        'body': nav.toWire(),
      });
      await initialized.future.timeout(const Duration(seconds: 5));
      for (final p in TbcNativeWalletProtocol.values) await page('ready', p);
      final connected = await request(
        TbcNativeWalletProtocol.legacy,
        1,
        'connect',
        {'legacyJson': 'null'},
      );
      expect(connected.containsKey('result'), true);
      expect(legacy.grants, contains('tbc_signMessage'));
      expect(standard.grants, isEmpty);
      final s = await request(
        TbcNativeWalletProtocol.standard,
        1,
        'tbc_accounts',
        [],
      );
      expect(s['result'], isEmpty);
      expect(descriptions, 1);
      final l = await request(TbcNativeWalletProtocol.legacy, 2, 'getAddress', {
        'legacyJson': 'null',
      });
      expect(l['result'], [legacy.account.address]);
      await request(TbcNativeWalletProtocol.legacy, 3, 'disconnect', {
        'legacyJson': 'null',
      });
      expect(legacy.grants, isEmpty);
      expect(
        standard.calls.where((c) => c == 'permissions.disconnect'),
        isEmpty,
      );
      expect(
        legacy.arguments.every(
          (a) =>
              a['walletProtocol'] == TbcNativeWalletProtocol.legacy.namespace,
        ),
        true,
      );
      expect(
        standard.arguments.every((a) => !a.containsKey('walletProtocol')),
        true,
      );
      expect(frames.where((f) => f['type'] == 'initialize').length, 2);
    },
  );

  test(
    'Legacy refuses an old page resource instead of pretending to connect',
    () async {
      final native = NativeChannel();
      int disposed = 0;
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        walletChannel,
        (call) => native.invoke(
          call.method,
          Map<String, Object?>.from(call.arguments as Map),
        ),
      );
      binding.defaultBinaryMessenger.setMockMethodCallHandler(viewChannel, (
        call,
      ) async {
        if (call.method == 'create') return owner(native);
        if (call.method == 'dispose') disposed++;
        return true;
      });
      final wallet = await open(native, legacy: true);
      addTearDown(wallet.dispose);
      await expectLater(wallet.createWebView(), throwsStateError);
      expect(disposed, 1);
      expect(native.calls, isEmpty);
    },
  );

  test(
    'Flutter composition opens verified page and commits connect through native channel',
    () async {
      final native = NativeChannel(), frames = <Map>[];
      final connected = Completer<Map>();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        walletChannel,
        (call) => native.invoke(
          call.method,
          Map<String, Object?>.from(call.arguments as Map),
        ),
      );
      binding.defaultBinaryMessenger.setMockMethodCallHandler(viewChannel, (
        call,
      ) async {
        if (call.method == 'create') return owner(native);
        if (call.method == 'deliver') {
          final frame = jsonDecode(call.arguments['serialized']) as Map;
          frames.add(frame);
          if (frame['type'] == 'delivery' && !connected.isCompleted)
            connected.complete(frame);
        }
        return true;
      });
      final wallet = await open(native);
      addTearDown(wallet.dispose);
      final view = await wallet.createWebView();
      expect(view.markerSource, owner(native)['markerSource']);
      expect(await view.attach(platformViewId: 7), isTrue);
      final nav = native.navigation;
      Future<void> page(
        String type, [
        Map<String, Object?> fields = const {},
      ]) => event(viewChannel.name, 'event', {
        'ownerId': 'owner',
        'type': 'message',
        'body': {
          'source': {
            'webViewInstanceId': nav.webViewInstanceId,
            'sessionId': nav.sessionId,
            'navigationId': nav.navigationId,
            'origin': nav.origin,
            'topOrigin': nav.origin,
            'isMainFrame': true,
          },
          'serialized': canonical({
            'channel': 'tws-webview/1',
            'type': type,
            'sessionId': nav.sessionId,
            'navigationId': nav.navigationId,
            'messageId': 'page-$type',
            ...fields,
          }),
        },
      });
      await event(viewChannel.name, 'event', {
        'ownerId': 'owner',
        'type': 'navigation',
        'body': nav.toWire(),
      });
      await page('ready');
      await page('request', {
        'request': {
          'jsonrpc': '2.0',
          'id': 'connect',
          'method': 'tbc_requestAccounts',
        },
      });
      final reply = await connected.future.timeout(const Duration(seconds: 10));
      expect(reply['response']['result'], [native.account.address]);
      expect(native.calls, [
        'snapshot',
        'permissions.request',
        'delivery.prepare',
      ]);
      expect(frames.first['type'], 'initialize');
      expect(reply['events'].length, 2);
      await wallet.dispose();
      expect(native.calls, contains('document.invalidate'));
    },
  );

  test(
    'disposing while native view creation awaits cleans late owner without a usable session',
    () async {
      final native = NativeChannel(),
          creating = Completer<void>(),
          hold = Completer<void>();
      var disposals = 0;
      binding.defaultBinaryMessenger.setMockMethodCallHandler(viewChannel, (
        call,
      ) async {
        if (call.method == 'create') {
          creating.complete();
          await hold.future;
          return owner(native);
        }
        if (call.method == 'dispose') {
          disposals++;
          return null;
        }
        return true;
      });
      final wallet = await open(native);
      final pending = wallet.createWebView();
      final failed = expectLater(pending, throwsStateError);
      await creating.future;
      await wallet.dispose();
      hold.complete();
      await failed;
      expect(disposals, 1);
      expect(native.calls, isEmpty);
    },
  );
}
