import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_wallet_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';
import 'native_wallet_binding_test.dart' show NativeChannel;
import 'support/signing_replay.dart' as replay;

void main() {
  setUpAll(replay.loadReplay);

  test('Standard private calls preserve the existing envelope', () async {
    final h = NativeChannel();
    final control = await h.open();
    await control.beforeDelivery('tbc_accounts', 1, '{}');
    await control.cancel('pending');
    expect(h.arguments.every((a) => !a.containsKey('walletProtocol')), isTrue);
  });

  test(
    'Legacy selector is fixed at registration on every custody call',
    () async {
      final h =
          NativeChannel()..grants.addAll(['tbc_accounts', 'tbc_signMessage']);
      final binding = TbcNativeWalletBindings(
        network: h.material.network,
        invoke: h.invoke,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      final control = await binding.open('owner', h.navigation);
      final operation = await binding.begin(h.scope());
      await operation.requireCurrent();
      await control.beforeDelivery('tbc_signMessage', 'sign', '{}');
      await operation.close();
      await control.cancel('pending');
      control.invalidate();
      await Future<void>.delayed(Duration.zero);
      expect(
        h.calls,
        containsAll([
          'snapshot',
          'signing.begin',
          'signing.check',
          'delivery.prepare',
          'operation.cancel',
          'document.invalidate',
        ]),
      );
      expect(
        h.arguments.every(
          (a) => a['walletProtocol'] == 'legacy-window-turing/v1',
        ),
        isTrue,
      );
    },
  );

  test(
    'same-owner authority events cannot install grants across protocols',
    () async {
      final standard = NativeChannel();
      // Deliberately identical native owner/document, not two generated clocks.
      final legacy = standard;
      final lb = TbcNativeWalletBindings(
        network: legacy.material.network,
        invoke: legacy.invoke,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      final s = await standard.open(),
          l = await lb.open('owner', legacy.navigation);
      standard.grants.add('tbc_accounts');
      standard.revision++;
      final snapshot = standard.snapshot(),
          scope = standard.navigation.toWire();
      lb.authorityChanged('owner', scope, snapshot);
      standard.bindings.authorityChanged(
        'owner',
        scope,
        snapshot,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      expect(s.permits('tbc_accounts'), isFalse);
      expect(l.permits('tbc_accounts'), isFalse);
      standard.bindings.authorityChanged('owner', scope, snapshot);
      expect(s.permits('tbc_accounts'), isTrue);
      expect(l.permits('tbc_accounts'), isFalse);
      lb.authorityChanged(
        'owner',
        scope,
        snapshot,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      expect(l.permits('tbc_accounts'), isTrue);
      l.invalidate();
      expect(s.permits('tbc_accounts'), isTrue);
    },
  );

  test(
    'unregistered Legacy fails instead of falling back to Standard',
    () async {
      final h = NativeChannel()..failure = 'NATIVE_DENIED';
      final binding = TbcNativeWalletBindings(
        network: h.material.network,
        invoke: h.invoke,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      await expectLater(binding.open('owner', h.navigation), throwsA(anything));
      expect(
        h.arguments.every(
          (a) => a['walletProtocol'] == 'legacy-window-turing/v1',
        ),
        isTrue,
      );
      expect(h.calls.where((c) => c == 'snapshot').length, 1);
    },
  );
}
