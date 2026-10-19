// MethodChannel-envelope integration, no key/HTTP/device claim. The real
// Swift/Kotlin private dispatch and emission are exercised by NetworkRouterCheck.
import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_wallet_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';

final class Channel {
  final networks = {
    'tbc:testnet': TbcNetworkConfiguration.trustedCustom(
      network: TbcNetwork.testnet,
      apiOrigin: 'https://devapi.tbcdev.org',
      trustId: 'native-binding-test',
    ),
    'tbc:mainnet': TbcNetworkConfiguration.official(TbcNetwork.mainnet),
  };
  final navigation = TbcWebViewNavigation(
    webViewInstanceId: 'view',
    sessionId: 'session',
    navigationId: 'navigation',
    committedUrl: 'https://sample.tbcdev.org/',
    origin: 'https://sample.tbcdev.org',
    createdAt: '2026-10-14T00:00:00Z',
  );
  final grants = {
    for (final c in ['tbc:testnet', 'tbc:mainnet'])
      c: <String>{'tbc_accounts', 'tbc_switchChain', 'tbc_signMessage'},
  };
  final revisions = {'tbc:testnet': 0, 'tbc:mainnet': 0};
  final calls = <Map<String, dynamic>>[];
  final extras = <String, List<TbcAccount>>{};
  String chain = 'tbc:testnet';
  int generation = 0;
  bool rejectSwitch = false;
  bool rejectGrant = false;
  String? heldMethod;
  Completer<void>? hold, entered;
  void Function(Map<String, dynamic>)? mutateEnvelope;
  void Function()? switchNotification;
  late final bindings = TbcNativeWalletBindings(
    network: networks['tbc:testnet']!,
    additionalNetworks: [networks['tbc:mainnet']!],
    invoke: invoke,
  );
  TbcAccount account(String c) => TbcAccount(
    network: networks[c]!.network,
    address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    publicKey:
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  );
  Map<String, dynamic> grant(String c, String method, {List<String>? ids}) => {
    'id': '$c-$method',
    'date': 1,
    'parentCapability': method,
    'invoker': navigation.origin,
    'caveats': [
      {
        'type': 'restrictChains',
        'value': [c],
      },
      {
        'type': 'restrictAccounts',
        'value':
            ids ??
            [
              account(c).accountId,
              for (final a in extras[c] ?? <TbcAccount>[]) a.accountId,
            ],
      },
      {
        'type': 'restrictMethods',
        'value': [method],
      },
    ],
  };
  Map<String, dynamic> lane(String c) => {
    'account': account(c).toKitAccount(),
    'revision': revisions[c],
    'accountRevision': 0,
    'unlocked': true,
    'optionalMethods': <String>[],
    'connectedAccounts':
        grants[c]!.contains('tbc_accounts')
            ? [
              for (final a in [...?extras[c], account(c)]) a.toKitAccount(),
            ]
            : [],
    'permissions': [for (final method in grants[c]!) grant(c, method)],
  };
  Map<String, dynamic> snapshot() {
    final s = <String, dynamic>{
      'network': {'chainId': chain, 'revision': generation},
      'sources': {
        for (final e in networks.entries)
          e.key: broadcastSourceIdentity(e.value),
      },
      'lanes': {for (final c in networks.keys) c: lane(c)},
      'permissions': [
        for (final c in networks.keys)
          for (final m in grants[c]!) grant(c, m),
      ],
    };
    mutateEnvelope?.call(s);
    return copied(s);
  }

  void switchNative(String target) {
    if (target == chain) return;
    chain = target;
    generation++;
    for (final c in revisions.keys) {
      revisions[c] = revisions[c]! + 1;
    }
  }

  void notify() =>
      bindings.authorityChanged('owner', navigation.toWire(), snapshot());
  Future<Object?> invoke(String method, Map<String, Object?> args) async {
    calls.add({'method': method, 'arguments': copied(args)});
    expect(args['ownerId'], 'owner');
    expect(args['scope'], navigation.toWire());
    if (method == 'network.snapshot') {
      expect(args.keys.toSet(), {'ownerId', 'scope'});
      return {'ok': true, 'value': snapshot()};
    }
    if (canonical(args['network']) !=
        canonical({'chainId': chain, 'revision': generation}))
      return {'ok': false, 'code': 'NATIVE_DENIED'};
    if (method == 'network.switch') {
      if (rejectSwitch) return {'ok': false, 'code': 'USER_REJECTED'};
      final before = chain;
      switchNative(args['chainId'] as String);
      switchNotification?.call();
      return {
        'ok': true,
        'snapshot': snapshot(),
        'value': [
          if (before != chain) {'name': 'chainChanged', 'payload': chain},
        ],
      };
    }
    if (method == 'permissions.request') {
      if (rejectGrant) return {'ok': false, 'code': 'USER_REJECTED'};
      final records = <Map>[];
      for (final entry in (args['permissions'] as Map).entries) {
        for (final c in entry.value['chains']) {
          grants[c]!.add(entry.key);
          revisions[c] = revisions[c]! + 1;
          records.add(grant(c, entry.key));
        }
      }
      return {'ok': true, 'value': records, 'snapshot': snapshot()};
    }
    if (method == 'permissions.disconnect') {
      for (final c in networks.keys) {
        grants[c]!.clear();
        revisions[c] = revisions[c]! + 1;
      }
      return {'ok': true, 'value': null, 'snapshot': snapshot()};
    }
    final value = switch (method) {
      'signing.begin' => lane(chain),
      'signing.check' || 'signing.consent' || 'delivery.prepare' => true,
      'network.capabilities' => <String, dynamic>{'chainId': args['chainId']},
      _ => null,
    };
    if (method == heldMethod) {
      entered!.complete();
      await hold!.future;
      // Deliberately return the stale native-shaped payload: the Dart mirror
      // must not install or reroute it even before native emission checks.
    }
    return {'ok': true, 'value': value};
  }

  Future<TbcNativeDocumentControl> open() => bindings.open('owner', navigation);
  TbcSigningRequestScope scope(
    TbcNativeDocumentControl c, [
    String id = 'operation',
  ]) => TbcSigningRequestScope(
    operationId: id,
    method: 'tbc_signMessage',
    navigation: navigation,
    account: c.selectedAccount,
    revision: c.revision,
  );
}

Future<void> change(
  TbcNativeDocumentControl c,
  String chain, [
  String id = 'switch',
]) async {
  final n = c as TbcProviderNetworkControl;
  await n.switchChain(
    operationId: id,
    chainId: chain,
    expectedRevision: n.networkRevision,
  );
}

void main() {
  test(
    'catalog source identities and inactive grants are mirrored without switching',
    () async {
      final h = Channel(), c = await hOpen(h);
      final n = c as TbcProviderNetworkControl;
      expect(n.supportedNetworks.keys.toSet(), h.networks.keys.toSet());
      expect(c.currentPermissions().length, 6);
      expect(
        n.permitsAddressOnChain(
          'tbc:mainnet',
          h.account('tbc:mainnet').address,
        ),
        true,
      );
      await (c as TbcProviderNativeCapabilities).nativeCapabilities(
        operationId: 'caps',
        chainId: 'tbc:mainnet',
        address: h.account('tbc:mainnet').address,
      );
      expect(c.network.chainId, 'tbc:testnet');
      expect(h.calls.last['arguments']['network'], {
        'chainId': 'tbc:testnet',
        'revision': 0,
      });
      expect(h.calls.map((v) => v['method']), [
        'network.snapshot',
        'network.capabilities',
      ]);
    },
  );
  test(
    'grant target network, switch, and origin-wide disconnect use one control path',
    () async {
      final h = Channel()..grants['tbc:mainnet']!.clear();
      final c = await h.open();
      await c.requestPermissions(
        TbcPermissionRequest(
          providerMethod: 'wallet_requestPermissions',
          operationId: 'grant',
          account: c.selectedAccount,
          navigation: c.navigation,
          revision: c.revision,
          permissions: {
            for (final m in ['tbc_accounts', 'tbc_switchChain'])
              m: {
                'chains': ['tbc:mainnet'],
                if (m == 'tbc_accounts') 'maxAccounts': 1,
              },
          },
        ),
      );
      expect(c.network.chainId, 'tbc:testnet');
      expect(c.currentPermissions().length, 5);
      await change(c, 'tbc:mainnet');
      expect(c.network, same(h.networks['tbc:mainnet']));
      expect(c.selectedAccount.accountId, h.account('tbc:mainnet').accountId);
      await c.disconnect('disconnect');
      expect(c.currentPermissions(), isEmpty);
      expect(c.connectedAccounts, isEmpty);
    },
  );
  test(
    'one grouped request installs both committed lanes without switching',
    () async {
      final h = Channel();
      for (final grants in h.grants.values) grants.clear();
      final c = await h.open();
      TbcPermissionRequest request(String id) => TbcPermissionRequest(
        providerMethod: 'wallet_requestPermissions',
        operationId: id,
        account: c.selectedAccount,
        navigation: c.navigation,
        revision: c.revision,
        permissions: {
          for (final m in ['tbc_accounts', 'tbc_switchChain'])
            m: {
              'chains': ['tbc:mainnet', 'tbc:testnet'],
              if (m == 'tbc_accounts') 'maxAccounts': 1,
            },
        },
      );
      h.rejectGrant = true;
      await expectLater(
        c.requestPermissions(request('rejected-group')),
        throwsA(TbcWireFailure.rejected),
      );
      expect(c.currentPermissions(), isEmpty);
      h.rejectGrant = false;
      final beforeCalls = h.calls.length;
      await c.requestPermissions(request('approved-group'));
      expect(h.calls.length, beforeCalls + 1);
      expect(h.calls.last['method'], 'permissions.request');
      expect(c.currentPermissions().length, 4);
      expect(c.network.chainId, 'tbc:testnet');
      expect((c as TbcProviderNetworkControl).networkRevision, 0);
      await change(c, 'tbc:mainnet');
      expect(
        c.connectedAccounts.single.accountId,
        h.account('tbc:mainnet').accountId,
      );
    },
  );
  test(
    'same-chain no-op and rejected switch preserve generation and signing',
    () async {
      final h = Channel(), c = await hOpen(h);
      final op = await h.bindings.begin(h.scope(c));
      await change(c, 'tbc:testnet');
      expect((c as TbcProviderNetworkControl).networkRevision, 0);
      h.rejectSwitch = true;
      await expectLater(
        change(c, 'tbc:mainnet'),
        throwsA(isA<TbcSigningRejected>()),
      );
      await op.requireCurrent();
      await op.close();
    },
  );
  test(
    'original network is held across a round trip including signing close',
    () async {
      final h = Channel(), c = await hOpen(h);
      final op = await h.bindings.begin(h.scope(c));
      await change(c, 'tbc:mainnet');
      await change(c, 'tbc:testnet', 'back');
      final count = h.calls.length;
      await expectLater(
        op.requireCurrent(),
        throwsA(TbcWireFailure.unauthorized),
      );
      expect(h.calls.length, count);
      await expectLater(op.close(), throwsA(TbcWireFailure.unauthorized));
      expect(h.calls.last['method'], 'signing.close');
      expect(h.calls.last['arguments']['network'], {
        'chainId': 'tbc:testnet',
        'revision': 0,
      });
    },
  );
  for (final method in ['signing.begin', 'signing.check']) {
    test(
      'late $method cannot install the old lane or return through the new one',
      () async {
        final h = Channel(), c = await hOpen(h);
        final scope = h.scope(c);
        final op =
            method == 'signing.check' ? await h.bindings.begin(scope) : null;
        h.heldMethod = method;
        h.hold = Completer();
        h.entered = Completer();
        final pending =
            method == 'signing.begin'
                ? h.bindings.begin(scope)
                : op!.requireCurrent();
        final rejected = expectLater(
          pending,
          throwsA(TbcWireFailure.unauthorized),
        );
        await h.entered!.future;
        await change(c, 'tbc:mainnet');
        h.hold!.complete();
        await rejected;
        expect(c.selectedAccount.network, TbcNetwork.mainnet);
      },
    );
  }
  test('native committed notification may precede switch response', () async {
    final h = Channel(), c = await hOpen(h);
    h.switchNotification = h.notify;
    await change(c, 'tbc:mainnet');
    expect((c as TbcProviderNetworkControl).networkRevision, 1);
  });
  test(
    'stale snapshot ignored; same generation cannot change network',
    () async {
      final h = Channel(), c = await hOpen(h), old = h.snapshot();
      await change(c, 'tbc:mainnet');
      h.bindings.authorityChanged('owner', h.navigation.toWire(), old);
      expect(c.network.chainId, 'tbc:mainnet');
      final bad = h.snapshot();
      bad['network']['chainId'] = 'tbc:testnet';
      h.bindings.authorityChanged('owner', h.navigation.toWire(), bad);
      expect(c.requireCurrent, throwsA(TbcWireFailure.unauthorized));
    },
  );
  test(
    'multi-account order need not put primary first, but membership is required',
    () async {
      final h = Channel();
      h.extras['tbc:mainnet'] = [
        TbcAccount(
          network: TbcNetwork.mainnet,
          address: '1other',
          publicKey: '02${'11' * 32}',
        ),
      ];
      final c = await h.open();
      await change(c, 'tbc:mainnet');
      expect(c.connectedAccounts.length, 2);
      expect(c.connectedAccounts.first.address, '1other');
      expect(c.selectedAccount.address, h.account('tbc:mainnet').address);
      final s = h.snapshot();
      s['lanes']['tbc:mainnet']['connectedAccounts'].removeLast();
      s['lanes']['tbc:mainnet']['revision']++;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), s);
      expect(c.requireCurrent, throwsA(TbcWireFailure.unauthorized));
    },
  );
  for (final defect in ['source', 'lane', 'revision', 'scope', 'extra']) {
    test('malformed native network envelope rejects $defect', () async {
      final h = Channel();
      h.mutateEnvelope = (s) {
        switch (defect) {
          case 'source':
            s['sources']['tbc:mainnet'] = '0' * 64;
          case 'lane':
            s['lanes'].remove('tbc:mainnet');
          case 'revision':
            s['network']['revision'] = true;
          case 'scope':
            s['permissions'][0]['invoker'] = 'https://attacker.invalid';
          case 'extra':
            s['endpoint'] = 'https://attacker.invalid';
        }
      };
      await expectLater(h.open(), throwsFormatException);
    });
  }
}

Future<TbcNativeDocumentControl> hOpen(Channel h) => h.open();
