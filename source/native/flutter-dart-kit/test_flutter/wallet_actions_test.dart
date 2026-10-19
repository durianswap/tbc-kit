import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tbc_kit_flutter_dart/flutter_wallet.dart';
import '../test/native_wallet_binding_test.dart' show NativeChannel;
import '../test/support/signing_replay.dart' as replay;

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('io.tbc.kit.dart/private-wallet');
  setUpAll(replay.loadReplay);
  tearDown(() => binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
  test('local calls reuse native grants and delivery without WebView or extra reads', () async {
    final native = NativeChannel()..replies['delivery.acknowledge'] = true;
    var opened = false, closed = 0, deliveries = 0, reads = 0;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'local.open') { expect(opened, false); opened = true; return {'ok': true, 'value': {'ownerId': 'owner', 'scope': native.navigation.toWire()}}; }
      if (call.method == 'local.close') { opened = false; closed++; return {'ok': true}; }
      if (call.method == 'local.deliver') { deliveries++; final frame = jsonDecode(call.arguments['text']); expect(frame['sessionId'], native.navigation.sessionId); return {'ok': true, 'value': true}; }
      return native.invoke(call.method, Map<String, Object?>.from(call.arguments as Map));
    });
    final wallet = await TbcFlutterWallet.open(
      configuration: TbcWalletConfiguration(productId: 'test.actions', name: 'Native wallet', profile: 'native', network: native.material.network, legacy: false),
      compute: TbcPinnedComputeLibrary(path: replay.replay['library']['path'], sha256: replay.replay['library']['sha256']),
      chainDataRead: (_) async { reads++; throw StateError('Unexpected read'); },
    );
    addTearDown(wallet.dispose);
    final actions = await wallet.openActions();
    await expectLater(wallet.openActions(), throwsStateError);
    expect(await actions.getAccounts(), isEmpty);
    await actions.requestPermissions({'tbc_accounts': {'chains': ['tbc:testnet'], 'maxAccounts': 1}});
    expect(await actions.getAccounts(), [native.account.address]);
    expect(native.calls.where((x) => x == 'permissions.request').length, 1);
    final request = actions.transactionRequest(intent: {'version': '1.0', 'type': 'tbc.transfer', 'to': native.account.address, 'amount': '1'}, constraints: {'maxFee': '1'});
    expect(request['from'], native.account.address);
    expect(request['chainId'], 'tbc:testnet');
    await expectLater(actions.request('not_a_method'), throwsA(isA<TbcWalletException>().having((e) => e.code, 'code', 4200)));
    expect(reads, 0); expect(deliveries, greaterThan(3));
    await actions.dispose(); expect(closed, 1);
    await expectLater(actions.getAccounts(), throwsA(isA<TbcWalletException>()));
  });
}
