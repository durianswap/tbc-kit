import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/host_scope.dart';
import 'package:tbc_kit_flutter_dart/src/private_host_channel.dart';

const origin = 'https://partner.example';
const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const publicKey =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const now = '2026-10-07T00:00:00.123Z';
TbcAccount account(TbcNetwork network) =>
    TbcAccount(network: network, address: address, publicKey: publicKey);

// This test backend deliberately stores no keys and is not a production store.
final class Store implements TbcPermissionStoreBackend {
  int reads = 0, writes = 0;
  Completer<void>? hold;
  Completer<void>? entered;
  @override
  Future<TbcPermissionSnapshot> load(
    TbcPermissionStoreAccess access,
    TbcPermissionScope scope,
  ) async {
    access.requireActive();
    reads++;
    return TbcPermissionSnapshot.empty();
  }

  @override
  Future<Map<String, Object?>> commit(TbcPermissionCommit request) async {
    entered?.complete();
    await hold?.future;
    request.access.requireActive();
    writes++;
    return request.acknowledgment;
  }
}

final class Harness {
  final store = Store();
  final replies = <String, Map<String, Object>>{};
  int revision = 0,
      reads = 0,
      revokes = 0,
      cancels = 0,
      reviews = 0,
      issues = 0,
      receiptRevokes = 0;
  int seq = 0;
  bool nativeCurrent = true;
  Future<List<TbcAccount>> Function(TbcNetwork)? onRead;
  Future<TbcApprovalDecision> Function(TbcFormalApproval)? onReview;
  Future<TbcIssuedApproval> Function(TbcApprovalAuthorization)? onIssue;
  late TbcWalletHostScope scope;
  late TbcPrivateHostDispatcher dispatcher;
  late final environment = TbcHostEnvironment(
    network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
    additionalNetworks: [TbcNetworkConfiguration.official(TbcNetwork.mainnet)],
    readAccounts: (network) async {
      reads++;
      return onRead == null ? [account(network)] : onRead!(network);
    },
    clock: () => DateTime.parse(now),
  );

  Future<void> open() async {
    scope = await TbcWalletHostScope.open(
      runtimeId: 'native-A',
      configuration: TbcWalletConfiguration(
        productId: 'example.wallet',
        name: 'Partner',
        profile: 'wallet-a',
        network: environment.network,
      ),
      environment: environment,
      navigation: TbcWebViewNavigation(
        webViewInstanceId: 'view-1',
        sessionId: 'native-1',
        navigationId: 'nav-1',
        committedUrl: '$origin/app',
        origin: origin,
        createdAt: now,
      ),
      preparationUi: TbcApprovalPreparationUi(
        onBegin: (_) {},
        onFinish: (_) {},
        onReview: (_) async => const TbcEarlyConsent.reject(),
      ),
      permissionStore: store,
      review: (review) async {
        reviews++;
        return onReview == null
            ? TbcApprovalDecision.approve
            : onReview!(review);
      },
      issue: (authorization) async {
        issues++;
        return onIssue == null
            ? receipt(authorization)
            : onIssue!(authorization);
      },
      readWalletRevision: () => revision,
      isNativeCurrent: () => nativeCurrent,
      revokeNativePermits: () {
        revokes++;
      },
      cancelDependentIo: () {
        cancels++;
      },
    );
    dispatcher = TbcPrivateHostDispatcher(
      runtimeId: 'native-A',
      handle: scope.dispatch,
      reply: (result) {
        replies[result['callId'] as String] = result;
      },
    );
  }

  TbcIssuedApproval receipt(TbcApprovalAuthorization a) => TbcIssuedApproval(
    approvalId: 'test-only',
    approvalToken: 'test-only-receipt',
    bindingHash: a.review.bindingHash,
    approvedAt: now,
    expiresAt: '2026-10-07T00:01:00Z',
    revoke: () {
      receiptRevokes++;
    },
  );

  Future<Map<String, Object>> call(String method, [Object? input]) async {
    final id = 'native-A:${++seq}';
    await dispatcher.receive({
      'runtimeId': 'native-A',
      'callId': id,
      'method': method,
      'input': jsonEncode(input),
    });
    return replies[id]!;
  }

  Future<dynamic> value(String method, [Object? input]) async {
    final result = await call(method, input);
    expect(result['status'], 'ok');
    return jsonDecode(result['value'] as String);
  }
}

Map<String, dynamic> approval([String method = 'tbc_signMessage']) =>
    Map<String, dynamic>.from(
      (jsonDecode(
                File(
                  'test/fixtures/formal-approval/fixtures.json',
                ).readAsStringSync(),
              )
              as Map)['results'][method]['envelope']
          as Map,
    );

Map<String, Object?> revokePermissions() {
  final params = {
    'version': '1.0',
    'changes': [
      {
        'scope': {'origin': origin, 'chainId': 'tbc:testnet'},
        'expectedRevision': '0',
        'permissions': [],
      },
    ],
  };
  return {
    'params': params,
    'port': {
      'version': '1.0',
      'operation': 'permissionStore.commit',
      'callId': 'permission-commit-1',
      'params': params,
    },
  };
}

// Trusted executor fixture only. Session adapter tests do not claim that this
// synthetic commit authenticates a Core mutation or proves native atomicity.
Map<String, Object?> commit(Map expected, String chain) {
  final old = expected['currentSession']['state'] as Map;
  final id = 'A' * 43;
  return {
    'operationId': 'test-switch',
    'commitId': id,
    'expected': expected,
    'mutation': {
      'commitId': id,
      'payload': {
        'version': '1.0',
        'scope': expected['currentSession']['scope'],
        'expectedRevision': old['revision'],
        'target': {
          ...old,
          'revision': (BigInt.parse(old['revision']) + BigInt.one).toString(),
          'activeChainId': chain,
          'activeAccountIds': ['$chain:$address'],
        },
        'events': [
          {'type': 'fixture-committed'},
        ],
      },
    },
  };
}

void main() {
  test(
    'signing authority captures verified document/account and explicit permission',
    () async {
      final h = Harness();
      await h.open();
      var granted = false;
      void permission(String method) {
        expect(method, 'tbc_signTransaction');
        if (!granted) throw StateError('No grant');
      }

      capture() => h.scope.operationAuthority(
        method: 'tbc_signTransaction',
        account: account(TbcNetwork.testnet),
        requirePermission: permission,
        isUnlocked: () => true,
        clock: () => DateTime.parse(now),
      );
      expect(capture, throwsStateError);
      granted = true;
      final a = capture();
      a.check('tbc_signTransaction');
      expect(a.context['origin'], origin);
      expect(a.context['sessionId'], 'native-1');
      expect(h.reads, 1);
      await h.value('permissions.commit', revokePermissions());
      expect(() => a.check('tbc_signTransaction'), throwsStateError);
    },
  );

  test(
    'initial account inventory is reused once; reads do not grant or persist',
    () async {
      final h = Harness();
      await h.open();
      expect(h.reads, 1);
      expect(
        (await h.value('accounts.current') as List).single['accountId'],
        'tbc:testnet:$address',
      );
      expect(h.reads, 1);
      await h.value('accounts.current');
      expect(h.reads, 2);
      expect(await h.value('clock.now'), now);
      expect(
        [h.store.reads, h.store.writes, h.reviews, h.issues],
        [0, 0, 0, 0],
      );
    },
  );

  test(
    'chain switch cancels old I/O and selects configured target inventory',
    () async {
      final h = Harness();
      await h.open();
      final before = await h.value('authority.read') as Map;
      await h.value('authority.commit', commit(before, 'tbc:mainnet'));
      expect([h.revokes, h.cancels], [1, 1]);
      expect(h.scope.state.network, TbcNetwork.mainnet);
      final values = await h.value('accounts.current') as List;
      expect(values.single['chainId'], 'tbc:mainnet');
      expect(values.single['accountId'], 'tbc:mainnet:$address');
      expect(h.store.writes, 0);
    },
  );

  test(
    'an account result pending across chain switch is rejected, not relabeled',
    () async {
      final h = Harness();
      await h.open();
      await h.value('accounts.current'); // consume the startup snapshot
      final entered = Completer<void>(),
          release = Completer<List<TbcAccount>>();
      h.onRead = (network) {
        if (network == TbcNetwork.testnet) {
          entered.complete();
          return release.future;
        }
        return Future.value([account(network)]);
      };
      final pending = h.call('accounts.current');
      await entered.future;
      final before = await h.value('authority.read') as Map;
      await h.value('authority.commit', commit(before, 'tbc:mainnet'));
      release.complete([account(TbcNetwork.testnet)]);
      expect((await pending)['status'], 'error');
      expect(h.scope.isClosed, false);
    },
  );

  test(
    'wallet revision change closes scope before delivering async inventory',
    () async {
      final h = Harness();
      await h.open();
      await h.value('accounts.current');
      final entered = Completer<void>(),
          release = Completer<List<TbcAccount>>();
      h.onRead = (_) {
        entered.complete();
        return release.future;
      };
      final pending = h.call('accounts.current');
      await entered.future;
      h.revision++;
      release.complete([account(TbcNetwork.testnet)]);
      expect((await pending)['status'], 'error');
      expect(h.scope.isClosed, true);
      expect([h.revokes, h.cancels], [1, 1]);
      h.scope.close();
      expect([h.revokes, h.cancels], [1, 1]);
    },
  );

  test(
    'permission write revokes immediately and blocks fresh approvals until commit',
    () async {
      final h = Harness();
      await h.open();
      h.store.hold = Completer<void>();
      h.store.entered = Completer<void>();
      final writing = h.call('permissions.commit', revokePermissions());
      await h.store.entered!.future;
      expect(h.revokes, 1);
      expect(h.store.writes, 0);
      expect((await h.call('approval.request', approval()))['status'], 'error');
      expect([h.reviews, h.issues], [0, 0]);
      h.store.hold!.complete();
      expect((await writing)['status'], 'ok');
      expect(h.store.writes, 1);
    },
  );

  test(
    'revocation during approval wait cannot issue a stale native permit',
    () async {
      final h = Harness();
      await h.open();
      final entered = Completer<void>(),
          release = Completer<TbcApprovalDecision>();
      h.onReview = (_) {
        entered.complete();
        return release.future;
      };
      final waiting = h.call('approval.request', approval());
      await entered.future;
      await h.value('permissions.commit', revokePermissions());
      release.complete(TbcApprovalDecision.approve);
      expect((await waiting)['status'], 'error');
      expect(h.issues, 0);
    },
  );

  test('late native issuance after close is explicitly revoked', () async {
    final h = Harness();
    await h.open();
    final entered = Completer<void>(), release = Completer<void>();
    h.onIssue = (a) async {
      entered.complete();
      await release.future;
      return h.receipt(a);
    };
    final waiting = h.call('approval.request', approval());
    await entered.future;
    h.scope.close();
    release.complete();
    expect((await waiting)['status'], 'error');
    expect(h.receiptRevokes, 1);
  });

  test(
    'bound early decision avoids second UI, while permission approval never signs',
    () async {
      final h = Harness();
      await h.open();
      final f = approval(), payload = f['params']['binding']['payload'];
      f['port']['approvalPreparation'] = {
        'state': 'ready',
        'method': payload['method'],
        'operationKind': payload['operationKind'],
        'requestHash': payload['requestHash'],
        'earlyConsent': {'status': 'approved'},
      };
      expect((await h.value('approval.request', f))['status'], 'approved');
      expect([h.reviews, h.issues], [0, 1]);
      expect(
        (await h.value(
          'approval.request',
          approval('tbc_requestAccounts'),
        ))['status'],
        'approved',
      );
      expect([h.reviews, h.issues], [1, 1]);
      expect(
        h.store.writes,
        0,
      ); // permission consent alone does not commit a grant
    },
  );

  test(
    'navigation failure or unsupported execution never installs a fallback',
    () async {
      final h = Harness();
      await h.open();
      for (final method in [
        'signer.sign',
        'crypto.execute',
        'http.request',
        'sqlite.execute',
      ]) {
        expect((await h.call(method, {}))['status'], 'error');
      }
      expect([h.reviews, h.issues, h.store.writes], [0, 0, 0]);
      h.nativeCurrent = false;
      expect((await h.call('accounts.current'))['status'], 'error');
      expect(h.scope.isClosed, true);
    },
  );
}
