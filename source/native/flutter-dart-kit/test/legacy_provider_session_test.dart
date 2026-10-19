// Private canonical ingress only. Native attestation is tested separately;
// these fixture controls are not a partner Vault or installed WebView proof.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_wire_params.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';
import 'provider_session_test.dart' show SessionHarness, Control, Delivery;
import 'support/signing_replay.dart' as replay;

Map<String, String> params(Object? value) => {'legacyJson': jsonEncode(value)};

void main() {
  setUpAll(replay.loadReplay);
  Future<SessionHarness> start() async {
    final h = SessionHarness(walletProtocol: TbcNativeWalletProtocol.legacy);
    await h.start(defaultPolicy: true);
    addTearDown(h.close);
    return h;
  }

  test(
    'Legacy baseline returns canonical committed data for page-only projection',
    () async {
      final h = await start();
      await h.request(1, 'isConnected', params(null));
      expect(h.response(1)['result'], isEmpty);
      await h.request(2, 'connect', params({'domain': 'forged.example'}));
      final grants = h.response(2)['result'] as List;
      expect(
        grants.map((g) => g['parentCapability']),
        unorderedEquals([
          'tbc_accounts',
          'tbc_accountMetadata',
          'tbc_signTransaction',
          'tbc_signWorkflow',
          'tbc_signMessage',
        ]),
      );
      expect(
        grants.every((g) => g['invoker'] == h.control.navigation.origin),
        true,
      );
      expect(h.control.reviews, 1);
      expect(h.control.deliveredMethods[2], 'wallet_requestPermissions');
      for (final row in [(3, 'getAddress'), (4, 'isConnected')]) {
        await h.request(row.$1, row.$2, params(null));
        expect(h.response(row.$1)['result'], [
          h.control.selectedAccount.address,
        ]);
        expect(h.control.deliveredMethods[row.$1], 'tbc_accounts');
      }
      await h.request(5, 'getPubKey', params(null));
      expect(
        h.response(5)['result']['publicKey'],
        h.control.selectedAccount.publicKey,
      );
      for (final row in [(6, 'getNetwork'), (7, 'getInfo')]) {
        await h.request(row.$1, row.$2, params(null));
        expect(h.response(row.$1)['result'], h.control.network.chainId);
      }
      expect(h.signing.paths, isEmpty);
      expect(h.signing.backend.begins, 0);
      await h.request(8, 'disconnect', params(null));
      expect(h.response(8).containsKey('result'), true);
      await h.request(9, 'isConnected', params(null));
      expect(h.response(9)['result'], isEmpty);
      await h.request(10, 'getPubKey', params(null));
      expect(h.response(10)['error']['code'], 4100);
    },
  );

  test(
    'same Legacy request ID commits once; Standard names are not a fallback',
    () async {
      final h = await start();
      await h.request('connect', 'connect', params(null));
      await h.request('connect', 'connect', params(null));
      expect(h.control.reviews, 1);
      expect(h.control.writes, 1);
      await h.request(
        'native',
        'tbc_signMessage',
        params({'message': 'no bypass'}),
      );
      expect(h.response('native')['error']['code'], 4200);
      expect(h.signing.backend.begins, 0);
    },
  );

  test(
    'balance reuses the worker without custody, approval, cache or extra reads',
    () async {
      final h = await start();
      await h.request('denied', 'getBalance', params(null));
      expect(h.response('denied')['error']['code'], 4100);
      expect(h.signing.paths, isEmpty);
      await h.request('connect', 'connect', params(null));
      var balance = 1000001;
      h.signing.customRead = (_) async => {'balance': balance++};
      for (final row in [(1, null), (2, []), (3, {})]) {
        await h.request(row.$1, 'getBalance', params(row.$2));
        expect(h.response(row.$1)['result'], {
          'chainId': 'tbc:testnet',
          'address': h.control.selectedAccount.address,
          'balanceAtomic': '${1000000 + row.$1}',
          'decimals': 6,
        });
        expect(h.control.deliveredMethods[row.$1], 'wallet_readBalance');
      }
      await h.request(
        3,
        'getBalance',
        params({}),
      ); // Same request, not a new GET.
      expect(
        h.signing.paths,
        List.filled(
          3,
          '/api/tbc/balance/address/${h.control.selectedAccount.address}',
        ),
      );
      expect(h.signing.backend.begins, 0);
      expect([h.control.reviews, h.control.writes], [1, 1]);
      await h.request('invalid', 'getBalance', params({'address': 'other'}));
      expect(h.response('invalid')['error']['code'], -32602);
      await h.request('private', 'wallet_readBalance', params(null));
      expect(h.response('private')['error']['code'], 4200);
      expect(h.signing.paths.length, 3);
    },
  );

  test(
    'balance revocation during a read suppresses value and never opens custody',
    () async {
      final h = await start();
      await h.request('connect', 'connect', params(null));
      final entered = Completer<void>(), release = Completer<void>();
      h.signing.customRead = (_) async {
        entered.complete();
        await release.future;
        return {'balance': 1000001};
      };
      final pending = h.request('balance', 'getBalance', params(null));
      await entered.future;
      h.control.grants.clear();
      h.control.revision++;
      release.complete();
      await pending;
      expect(h.response('balance').containsKey('result'), false);
      expect(h.signing.backend.begins, 0);
      expect(h.signing.worker.pendingCount, 0);
      expect(h.signing.paths.length, 1);
    },
  );

  test(
    'cancelling a held balance returns promptly and suppresses a late response',
    () async {
      final h = await start();
      await h.request('connect', 'connect', params(null));
      final entered = Completer<void>(), release = Completer<void>();
      h.signing.customRead = (_) async {
        entered.complete();
        await release.future;
        return {'balance': 1};
      };
      final pending = h.request('balance', 'getBalance', params(null));
      await entered.future;
      await h.session.accept(
        h.frame('cancel', {
          'requestId': 'balance',
          'reason': 'REQUEST_ABORTED',
        }),
        h.source,
      );
      await pending.timeout(const Duration(seconds: 1));
      release.complete();
      await h.signing.worker.close();
      expect(
        h.delivery.frames.where((f) => f['response']?['id'] == 'balance'),
        isEmpty,
      );
      expect(h.signing.backend.begins, 0);
    },
  );

  test(
    'Legacy message reaches shared custody once and retains canonical signature result',
    () async {
      final h = await start();
      await h.request('connect', 'connect', params(null));
      final rows =
          jsonDecode(
                File(
                  'test/fixtures/legacy-message-signing.json',
                ).readAsStringSync(),
              )['singles']
              as List;
      for (final value in rows) {
        final sample = copied(value);
        h.signing.backend.messageSample = sample;
        final id = sample['name'] as String;
        await h.request(
          id,
          'signMessage',
          params({
            'encoding': sample['request']['message']['encoding'],
            'message': sample['request']['message']['data'],
          }),
        );
        expect(h.response(id)['result'], sample['result']);
        expect(h.control.deliveredMethods[id], 'tbc_signMessage');
        await h.request(
          id,
          'signMessage',
          params({
            'encoding': sample['request']['message']['encoding'],
            'message': sample['request']['message']['data'],
          }),
        );
      }
      expect(h.signing.backend.begins, rows.length);
      for (final op in h.signing.backend.operations) {
        expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 1, 1]);
      }
      expect(h.signing.paths, isEmpty);
    },
  );

  test(
    'missing child grant rejects the entire batch before native begin',
    () async {
      final h = await start();
      await h.request(1, 'connect', params(null));
      h.control.grants.remove('tbc_signMessage');
      await h.request(
        2,
        'sendBatchRequest',
        params([
          {
            'method': 'signMessage',
            'params': {'encoding': 'utf8', 'message': 'first'},
          },
          {
            'method': 'signMessage',
            'params': {'encoding': 'utf8', 'message': 'second'},
          },
        ]),
      );
      expect(h.response(2)['error']['code'], 4100);
      expect(h.control.deliveredMethods[2], 'tbc_signWorkflow');
      expect(h.signing.backend.begins, 0);
      expect(h.signing.paths, isEmpty);
    },
  );

  test(
    'old creation and malformed decimal wrappers do not reach custody',
    () async {
      final h = await start();
      await h.request(1, 'connect', params(null));
      for (final flag in ['FT_MINT', 'POOLNFT_MINT', 'COLLECTION_MINT']) {
        await h.request(flag, 'sendTransaction', params({'flag': flag}));
        expect(h.response(flag).containsKey('error'), true);
      }
      await h.request('raw', 'signMessage', {'message': 'not wrapped'});
      expect(h.response('raw')['error']['code'], -32602);
      expect(h.signing.backend.begins, 0);
      expect(h.signing.paths, isEmpty);
    },
  );

  test(
    'cancellation while shared worker opens native operation suppresses late work',
    () async {
      final h = await start();
      await h.request(1, 'connect', params(null));
      final held = Completer<void>(), entered = Completer<void>();
      h.signing.backend.holdBegin = held;
      h.signing.backend.beginEntered = entered;
      final pending = h.request(
        2,
        'signMessage',
        params({'encoding': 'utf8', 'message': 'cancel me'}),
      );
      await entered.future;
      await h.session.accept(
        h.frame('cancel', {'requestId': 2, 'reason': 'REQUEST_ABORTED'}),
        h.source,
      );
      held.complete();
      await pending;
      // The worker resolves cancellation before a held native begin returns.
      // Await its ordered cleanup rather than racing that late handle.
      await h.signing.worker.close();
      expect(h.signing.backend.operations.single.consents, 0);
      expect(h.signing.backend.operations.single.signs, 0);
      expect(
        h.delivery.frames.where((f) => f['response']?['id'] == 2),
        isEmpty,
      );
      expect(h.signing.paths, isEmpty);
    },
  );

  test(
    'native Standard registration cannot be re-labelled Legacy by Dart',
    () async {
      final h = replay.Harness();
      final control = Control(h);
      await h.start();
      addTearDown(h.worker.close);
      await expectLater(
        TbcProviderSession.open(
          configuration: TbcWalletConfiguration(
            productId: 'partner.wallet',
            name: 'Partner',
            profile: 'partner',
            network: h.network,
          ),
          control: control,
          delivery: Delivery(),
          worker: h.worker,
          walletProtocol: TbcNativeWalletProtocol.legacy,
        ),
        throwsStateError,
      );
      expect(h.backend.begins, 0);
    },
  );

  test(
    'Legacy control requires a Legacy worker and no custom policy bypass',
    () async {
      final h = replay.Harness(), delivery = Delivery();
      final control = Control(
        h,
        walletProtocol: TbcNativeWalletProtocol.legacy,
      );
      final configuration = TbcWalletConfiguration(
        productId: 'partner.wallet',
        name: 'Partner',
        profile: 'partner',
        network: h.network,
      );
      await h.start();
      await expectLater(
        TbcProviderSession.open(
          configuration: configuration,
          control: control,
          delivery: delivery,
          worker: h.worker,
          walletProtocol: TbcNativeWalletProtocol.legacy,
        ),
        throwsStateError,
      );
      await h.worker.close();
      await h.start(messageProfile: MessageSigningProfile.legacyBitcoin);
      addTearDown(h.worker.close);
      await expectLater(
        TbcProviderSession.open(
          configuration: configuration,
          control: control,
          delivery: delivery,
          worker: h.worker,
          walletProtocol: TbcNativeWalletProtocol.legacy,
          policy: (_) => {},
        ),
        throwsStateError,
      );
      expect(h.backend.begins, 0);
      expect(delivery.frames, isEmpty);
    },
  );

  test(
    'Legacy finite JSON decimals stay outside the Standard integer codec',
    () {
      expect(decodeLegacyWireParams(params({'tbc_amount': 0.001})), {
        'tbc_amount': 0.001,
      });
      expect(decodeLegacyWireParams(params(null)), null);
      for (final input in [
        null,
        [],
        {},
        {'legacyJson': 'null', 'extra': true},
        {'legacyJson': '{"__proto__":{}}'},
        {'legacyJson': '{"constructor":1}'},
        {'legacyJson': '{"amount":1e999}'},
        {'legacyJson': '{'},
        {'legacyJson': '${'[' * 33}0${']' * 33}'},
      ]) {
        expect(() => decodeLegacyWireParams(input), throwsA(anything));
      }
    },
  );
}
