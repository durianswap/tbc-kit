import 'dart:async';
import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';
import 'support/signing_replay.dart' as replay;

// Offline native-shaped owner. It has no key, persistent store, UI or default
// grant. It is deliberately not exported/shipped as a production backend.
final class Control
    implements
        TbcProviderControl,
        TbcProviderAccountCatalog,
        TbcProviderProtocolControl {
  Control(this.h, {this.walletProtocol = TbcNativeWalletProtocol.standard}) {
    h.backend.granted = false;
  }
  final replay.Harness h;
  @override
  final TbcNativeWalletProtocol walletProtocol;
  final Map<Object, String> deliveredMethods = {};
  final Set<String> grants = {};
  final List<TbcAccount> roleAccounts = [];
  final Set<String> roleMetadata = {};
  @override
  List<TbcAccount> get connectedAccounts =>
      permits('tbc_accounts') ? [selectedAccount, ...roleAccounts] : [];
  @override
  bool permitsAccount(String capability, TbcAccount account) =>
      permits(capability) &&
      (account.accountId == selectedAccount.accountId ||
          roleAccounts.any((a) => a.accountId == account.accountId) &&
              (capability != 'tbc_accountMetadata' ||
                  roleMetadata.contains(account.accountId)));
  final List<String> cancelled = [];
  bool current = true;
  int reviews = 0, writes = 0, deliveryChecks = 0;
  @override
  int revision = 0;
  @override
  bool isUnlocked = true;
  @override
  TbcNetworkConfiguration get network => h.network;
  @override
  late final TbcWebViewNavigation navigation = h.navigation();
  @override
  TbcAccount get selectedAccount => TbcAccount(
    network: TbcNetwork.testnet,
    address: replay.material['account']['address'],
    publicKey: replay.material['account']['publicKey'],
  );
  @override
  void requireCurrent() {
    need(current, 'TEST_NATIVE_SCOPE');
  }

  @override
  bool permits(String name) => isUnlocked && grants.contains(name);
  @override
  List<Map<String, dynamic>> currentPermissions() =>
      !isUnlocked
          ? []
          : [
            for (final name in grants)
              {
                'id': 'test-$name',
                'parentCapability': name,
                'invoker': navigation.origin,
                'date': 1,
                'caveats': [
                  {
                    'type': 'restrictChains',
                    'value': [network.chainId],
                  },
                  {
                    'type': 'restrictAccounts',
                    'value': [selectedAccount.accountId],
                  },
                  {
                    'type': 'restrictMethods',
                    'value': [name],
                  },
                ],
              },
          ];
  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest request,
  ) async {
    requireCurrent();
    reviews++;
    expect(request.navigation.matches(navigation.toWire()), isTrue);
    expect(request.account.accountId, selectedAccount.accountId);
    expect(request.revision, revision);
    if (!request.permissions.containsKey('tbc_accounts') &&
        !permits('tbc_accounts'))
      throw TbcWireFailure.unauthorized;
    h.backend.revokePending(navigation);
    grants.addAll(request.permissions.keys);
    writes++;
    revision++;
    h.backend.granted = permits('tbc_accounts');
    return currentPermissions()
        .where((p) => request.permissions.containsKey(p['parentCapability']))
        .toList();
  }

  @override
  Future<void> disconnect(String operationId) async {
    requireCurrent();
    h.backend.revokePending(navigation);
    grants.clear();
    h.backend.granted = false;
    revision++;
    writes++;
  }

  @override
  Future<void> beforeDelivery(
    String method,
    Object requestId,
    String text,
  ) async {
    requireCurrent();
    deliveryChecks++;
    deliveredMethods[requestId] = method;
    final response = (jsonDecode(text) as Map)['response'] as Map;
    if (response.containsKey('result') &&
        method.startsWith('tbc_sign') &&
        !permits(
          method == 'tbc_signPreparedTransaction' ||
                  method == 'tbc_signReviewedTransaction'
              ? 'tbc_signTransaction'
              : method,
        ))
      throw StateError('TEST_DELIVERY_GRANT');
  }

  @override
  void invalidate() {
    current = false;
    h.backend.revokePending(navigation);
  }

  @override
  Future<void> cancel(String operationId) async {
    cancelled.add(operationId);
  }
}

final class Delivery implements TbcDocumentDelivery {
  final List<Map> frames = [];
  @override
  Future<bool> deliver(String text, TbcWebViewNavigation expected) async {
    frames.add(jsonDecode(text) as Map);
    return true;
  }

  @override
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  ) async => true;
  @override
  Future<void> close(TbcWebViewNavigation expected) async {}
}

final class SessionHarness {
  SessionHarness({this.walletProtocol = TbcNativeWalletProtocol.standard});
  final TbcNativeWalletProtocol walletProtocol;
  final signing = replay.Harness(), delivery = Delivery();
  late final control = Control(signing, walletProtocol: walletProtocol);
  late TbcProviderSession session;
  int sequence = 0;
  Completer<void>? holdPolicy, policyEntered;
  Future<void> start({bool defaultPolicy = false}) async {
    // Open the authority before the worker to keep the test initially ungranted.
    control.requireCurrent();
    await signing.start(
      messageProfile:
          walletProtocol == TbcNativeWalletProtocol.legacy
              ? MessageSigningProfile.legacyBitcoin
              : MessageSigningProfile.standard,
    );
    session = await TbcProviderSession.open(
      configuration: TbcWalletConfiguration(
        productId: 'partner.wallet',
        name: 'Partner',
        profile: 'partner',
        network: signing.network,
      ),
      control: control,
      delivery: delivery,
      worker: signing.worker,
      walletProtocol: walletProtocol,
      policy:
          defaultPolicy
              ? null
              : (request) async {
                policyEntered?.complete();
                await holdPolicy?.future;
                final p = copied(
                  replay.transaction['audit']['material']['policy'],
                );
                p['payload']['expiresAt'] = tbcProtocolTimestamp(
                  DateTime.now().add(const Duration(minutes: 5)),
                );
                p['policyHash'] = hashJson(p['payload']);
                return p;
              },
    );
    await session.accept(frame('ready'), source);
  }

  TbcWebViewMessageSource get source => TbcWebViewMessageSource(
    webViewInstanceId: control.navigation.webViewInstanceId,
    sessionId: control.navigation.sessionId,
    navigationId: control.navigation.navigationId,
    origin: control.navigation.origin,
    topOrigin: control.navigation.origin,
    isMainFrame: true,
  );
  String frame(String type, [Map extra = const {}]) => canonical({
    'channel': walletProtocol.wireChannel,
    'type': type,
    'sessionId': control.navigation.sessionId,
    'navigationId': control.navigation.navigationId,
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
  Future<void> grant() async {
    await request('grant', 'wallet_requestPermissions', [
      {
        for (final name in TbcProviderSession.permissionNames)
          name: {
            'chains': [control.network.chainId],
          },
      },
    ]);
  }

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
  test(
    'connected controller discovery keeps metadata grants separate and primary unchanged',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      final role = TbcAccount(
        network: TbcNetwork.testnet,
        address: '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
        publicKey:
            '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      );
      h.control.roleAccounts.add(role);
      await h.request(1, 'tbc_accounts');
      expect(h.response(1)['result'], [
        h.control.selectedAccount.address,
        role.address,
      ]);
      await h.request(2, 'tbc_getAccount', {'address': role.address});
      expect(h.response(2)['error']['code'], 4100);
      h.control.roleMetadata.add(role.accountId);
      await h.request(3, 'tbc_getAccount', {'address': role.address});
      expect(h.response(3)['result'], {
        ...role.toKitAccount(),
        'features': ['tbc:provider'],
      });
      await h.request(4, 'tbc_getAccount', {});
      expect(
        h.response(4)['result']['address'],
        h.control.selectedAccount.address,
      );
      h.control.roleAccounts.clear();
      await h.request(5, 'tbc_getAccount', {'address': role.address});
      expect(h.response(5)['error']['code'], 4100);
      expect(h.signing.paths, isEmpty);
      expect(h.signing.backend.begins, 0);
    },
  );
  test(
    'read methods expose only the selected granted account without network access',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.request(1, 'tbc_chainId');
      expect(h.response(1)['result'], h.control.network.chainId);
      await h.request(2, 'wallet_getPermissions');
      expect(h.response(2)['result'], []);
      await h.request(3, 'tbc_getAccount', {});
      expect(h.response(3)['error']['code'], 4100);
      await h.grant();
      await h.request(4, 'tbc_getAccount', {});
      expect(h.response(4)['result'], {
        ...h.control.selectedAccount.toKitAccount(),
        'features': ['tbc:provider'],
      });
      await h.request(5, 'wallet_getPermissions');
      expect(
        (h.response(5)['result'] as List)
            .map((p) => p['parentCapability'])
            .toSet(),
        TbcProviderSession.permissionNames,
      );
      expect(h.signing.paths, isEmpty);
      expect(h.signing.backend.begins, 0);
    },
  );
  test(
    'user rejection retains Provider 4001 and never binds or signs',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      h.signing.backend.approve = false;
      await h.request(1, 'tbc_signMessage', replay.message['request']);
      expect(h.response(1)['error'], {
        'code': 4001,
        'message': 'Request rejected',
      });
      final op = h.signing.backend.operations.single;
      expect([op.consents, op.binds, op.signs, op.closes], [1, 0, 0, 1]);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'account connection alone does not grant signing; scopes fail before native begin',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.request(1, 'tbc_accounts');
      expect(h.response(1)['result'], []);
      await h.request(2, 'tbc_requestAccounts');
      expect(h.response(2)['result'], [h.control.selectedAccount.address]);
      await h.request(3, 'tbc_signMessage', replay.message['request']);
      expect(h.response(3)['error']['code'], 4100);
      expect(h.signing.backend.begins, 0);
      await h.request(4, 'wallet_requestPermissions', [
        {
          'tbc_signMessage': {
            'chains': ['tbc:mainnet'],
          },
        },
      ]);
      expect(h.response(4)['error']['code'], 4200);
      expect(h.control.reviews, 1);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'Provider to worker to actual Engine preserves cold/warm transfer and one approval',
    () async {
      final h = SessionHarness();
      await h.start(defaultPolicy: true);
      addTearDown(h.close);
      await h.grant();
      final writes = h.control.writes;
      for (var i = 1; i <= 2; i++) {
        final before = h.signing.paths.length;
        await h.request(
          i,
          'tbc_signTransaction',
          replay.transaction['request'],
        );
        expect(
          canonical(h.response(i)['result']['transactions']),
          canonical(replay.transaction['result']['transactions']),
        );
        expect(h.response(i)['result']['totalFee'], '539');
        expect(h.signing.paths.length - before, i == 1 ? 5 : 3);
        final op = h.signing.backend.operations.last;
        expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 2, 1]);
      }
      expect(
        h.control.writes,
        writes,
      ); // sign-only never persists a journal/grant
    },
  );
  test(
    'ordinary message is exact with no chain reads; capabilities do not overclaim',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      await h.request(1, 'tbc_signMessage', replay.message['request']);
      expect(
        canonical(h.response(1)['result']),
        canonical(replay.message['result']),
      );
      await h.request(2, 'tbc_getCapabilities', {});
      expect(
        (h.response(2)['result']['methods'] as Map).keys.toSet(),
        TbcProviderSession.methods.toSet(),
      );
      expect(h.response(2)['result']['intents'], {
        'tbc-lop-create': ['1.0'],
        'tbc-lop-cancel': ['1.0'],
        'tbc-lop-match': ['1.0'],
        'tbc-htlc-lock': ['1.0'],
        'tbc-htlc-claim': ['1.0'],
        'tbc-htlc-refund': ['1.0'],
        'tbc-timelock-lock': ['1.0'],
        'tbc-timelock-unlock': ['1.0'],
        'tbc20.transfer': ['1.0'],
        'tbc20.merge': ['1.0'],
        'tbc20-standard-create': ['1.0'],
        'tbc721-standard-create-collection': ['1.0'],
        'tbc721-standard-mint': ['1.0'],
        'tbc721-standard-batch-mint': ['1.0'],
        'tbc-amm-create': ['1.0'],
        'tbc-amm-add-liquidity': ['1.0'],
        'tbc-amm-remove-liquidity': ['1.0'],
        'tbc-amm-swap': ['1.0'],
        'tbc20-lp-transfer': ['1.0'],
        'tbc20-lp-merge': ['1.0'],
        'tbc20-lp-lock': ['1.0'],
        'tbc20-lp-unlock': ['1.0'],
        'tbc.pool.swap.exactTbcForToken': ['1.0'],
        'tbc.pool.swap.exactTokenForTbc': ['1.0'],
        'tbc.pool.liquidity.add': ['1.0'],
        'tbc.pool.liquidity.remove': ['1.0'],
        'tbc.pool.ft.merge': ['1.0'],
        'tbc.pool.ftlp.merge': ['1.0'],
        'tbc.pool.ftlp.burn': ['1.0'],
        'amm.swap': ['1.0'],
        'amm.addLiquidity': ['1.0'],
        'amm.removeLiquidity': ['1.0'],
        'amm.mergeToken': ['1.0'],
        'tbc20Lp.transfer': ['1.0'],
        'tbc20Lp.lock': ['1.0'],
        'tbc20Lp.unlock': ['1.0'],
        'tbc20Lp.merge': ['1.0'],
        'tbc20Lp.burn': ['1.0'],
        'tbc721.transfer': ['1.0'],
        'tbc20Stablecoin.transfer': ['1.0'],
        'tbc20Stablecoin.merge': ['1.0'],
        'tbc.transfer': ['1.0'],
        'tbc.maintenance.merge': ['1.0'],
      });
      expect(h.response(2)['result']['limits'], {
        'workflowSteps': 5,
        'transactionBundleSize': 32,
      });
      await h.request(3, 'tbc_sendWorkflow', {});
      expect(h.response(3)['error']['code'], 4200);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'cancel one pending approval, keep another request in same document usable',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      h.signing.backend.holdConsent = Completer<void>();
      h.signing.backend.consentEntered = Completer<void>();
      final first = h.request(
        1,
        'tbc_signTransaction',
        replay.transaction['request'],
      );
      await h.signing.backend.consentEntered!.future;
      await h.session.accept(
        h.frame('cancel', {'requestId': 1, 'reason': 'REQUEST_ABORTED'}),
        h.source,
      );
      await h.request(2, 'tbc_signMessage', replay.message['request']);
      h.signing.backend.holdConsent!.complete();
      await first;
      expect(
        h.response(2)['result']['digest'],
        replay.message['result']['digest'],
      );
      expect(h.signing.backend.operations.first.signs, 0);
      expect(h.session.wire.isActive, isTrue);
    },
  );
  test(
    'disconnect revokes pending signature and returns committed permission events',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      h.signing.backend.holdConsent = Completer<void>();
      h.signing.backend.consentEntered = Completer<void>();
      final first = h.request(
        1,
        'tbc_signTransaction',
        replay.transaction['request'],
      );
      await h.signing.backend.consentEntered!.future;
      await h.request(2, 'tbc_disconnect');
      h.signing.backend.holdConsent!.complete();
      await first;
      expect(h.response(1)['error']['code'], 4100);
      expect(h.response(2)['result'], isNull);
      expect(h.signing.backend.operations.single.signs, 0);
      expect(h.control.grants, isEmpty);
      final event =
          h.delivery.frames.lastWhere(
            (f) => f['type'] == 'delivery' && f['response']['id'] == 2,
          )['events'];
      expect(event, [
        {'name': 'permissionsChanged', 'payload': []},
        {'name': 'accountsChanged', 'payload': []},
      ]);
    },
  );
  test(
    'cancel while policy awaits cannot start a late native signing operation',
    () async {
      final h = SessionHarness();
      await h.start();
      addTearDown(h.close);
      await h.grant();
      h.holdPolicy = Completer<void>();
      h.policyEntered = Completer<void>();
      final pending = h.request(
        1,
        'tbc_signTransaction',
        replay.transaction['request'],
      );
      await h.policyEntered!.future;
      await h.session.accept(
        h.frame('cancel', {'requestId': 1, 'reason': 'REQUEST_ABORTED'}),
        h.source,
      );
      h.holdPolicy!.complete();
      await pending;
      expect(h.signing.backend.begins, 0);
      expect(h.signing.paths, isEmpty);
      expect(
        h.delivery.frames.where(
          (f) => f['type'] == 'delivery' && f['response']['id'] == 1,
        ),
        isEmpty,
      );
    },
  );
}
