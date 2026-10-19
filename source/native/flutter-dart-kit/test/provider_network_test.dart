// Offline Provider/worker integration only. Native custody/router conformance
// is tested separately in NetworkRouterCheck; this owner has no key or HTTP.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';
import 'support/signing_replay.dart' as replay;

late TbcPinnedComputeLibrary currentLibrary;

final class NetworkControl
    implements
        TbcProviderControl,
        TbcProviderAccountCatalog,
        TbcProviderNetworkControl {
  NetworkControl(this.lanes)
    : supportedNetworks = Map.unmodifiable({
        for (final lane in lanes.values) lane.network.chainId: lane.network,
      });
  final Map<String, replay.Harness> lanes;
  @override
  final Map<String, TbcNetworkConfiguration> supportedNetworks;
  @override
  late final navigation = lanes['tbc:testnet']!.navigation();
  String chain = 'tbc:testnet';
  bool active = true, approve = true;
  @override
  bool isUnlocked = true;
  @override
  int networkRevision = 0;
  int approvals = 0;
  final grants = <String, Set<String>>{};
  final cancelled = <String>{};
  Completer<void>? holdSwitch, switchEntered, holdGrant, grantEntered;
  @override
  TbcNetworkConfiguration get network => supportedNetworks[chain]!;
  // Deliberately equal per-lane revisions: the network generation must fence
  // round trips even if address/key and permission revision are identical.
  @override
  int get revision => 1;
  TbcAccount account(String chain) => TbcAccount(
    network: supportedNetworks[chain]!.network,
    address: replay.material['account']['address'],
    publicKey: replay.material['account']['publicKey'],
  );
  @override
  TbcAccount get selectedAccount => account(chain);
  @override
  List<TbcAccount> get connectedAccounts =>
      permits('tbc_accounts') ? [selectedAccount] : [];
  @override
  bool permitsAccount(String capability, TbcAccount value) =>
      value.accountId == selectedAccount.accountId && permits(capability);
  @override
  bool permits(String name) =>
      isUnlocked && grants[chain]?.contains(name) == true;
  @override
  bool permitsAddressOnChain(String chain, String address) =>
      isUnlocked &&
      grants[chain]?.contains('tbc_accounts') == true &&
      account(chain).address == address;
  @override
  Set<String> optionalMethodsForChain(String chain) =>
      chain == 'tbc:testnet' ? {'tbc_encrypt', 'tbc_decrypt'} : {};
  @override
  void requireCurrent() {
    if (!active) throw TbcWireFailure.unauthorized;
  }

  Map<String, dynamic> record(String chain, String name) => {
    'id': '$chain-$name',
    'parentCapability': name,
    'invoker': navigation.origin,
    'date': 1,
    'caveats': [
      {
        'type': 'restrictChains',
        'value': [chain],
      },
      {
        'type': 'restrictAccounts',
        'value': [account(chain).accountId],
      },
      {
        'type': 'restrictMethods',
        'value': [name],
      },
    ],
  };
  @override
  List<Map<String, dynamic>> currentPermissions() =>
      !isUnlocked
          ? []
          : [
            for (final chain in grants.keys)
              for (final name in grants[chain]!) record(chain, name),
          ];
  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest request,
  ) async {
    requireCurrent();
    final stamp = networkRevision;
    grantEntered?.complete();
    await holdGrant?.future;
    requireCurrent();
    if (stamp != networkRevision || cancelled.contains(request.operationId)) {
      throw TbcWireFailure.unauthorized;
    }
    final result = <Map<String, dynamic>>[];
    for (final e in request.permissions.entries) {
      for (final chain in e.value['chains'] as List) {
        grants.putIfAbsent(chain, () => {}).add(e.key);
        result.add(record(chain, e.key));
      }
    }
    return result;
  }

  @override
  Future<List<Object?>> switchChain({
    required String operationId,
    required String chainId,
    required int expectedRevision,
  }) async {
    void current() {
      requireCurrent();
      if (cancelled.contains(operationId) ||
          expectedRevision != networkRevision ||
          !isUnlocked ||
          grants[chainId]?.contains('tbc_accounts') != true ||
          grants[chainId]?.contains('tbc_switchChain') != true) {
        throw TbcWireFailure.unauthorized;
      }
    }

    current();
    if (chainId == chain) return [];
    approvals++;
    switchEntered?.complete();
    await holdSwitch?.future;
    current();
    if (!approve) throw const TbcSigningRejected();
    for (final lane in lanes.values) lane.backend.revokePending(navigation);
    chain = chainId;
    networkRevision++;
    // Both chains intentionally use the same address, so no accountsChanged.
    return [
      {'name': 'chainChanged', 'payload': chainId},
    ];
  }

  @override
  Future<void> beforeDelivery(String method, Object id, String text) async {
    requireCurrent();
    final frame = jsonDecode(text) as Map;
    if (frame['response'].containsKey('result') && method == 'tbc_chainId') {
      expect(frame['response']['result'], chain);
    }
  }

  @override
  Future<void> disconnect(String operationId) async {
    for (final lane in lanes.values) lane.backend.revokePending(navigation);
    grants.clear();
  }

  @override
  Future<void> cancel(String operationId) async => cancelled.add(operationId);
  @override
  void invalidate() {
    active = false;
    for (final lane in lanes.values) lane.backend.revokePending(navigation);
  }
}

final class Delivery implements TbcDocumentDelivery {
  final frames = <Map>[];
  Map<String, Object?>? descriptor;
  @override
  Future<bool> deliver(String text, TbcWebViewNavigation expected) async {
    frames.add(jsonDecode(text));
    return true;
  }

  @override
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  ) async {
    descriptor = value;
    return true;
  }

  @override
  Future<void> close(TbcWebViewNavigation expected) async {}
}

final class Harness {
  final testnet = replay.Harness(library: currentLibrary);
  final mainnet = replay.Harness(
    network: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
    library: currentLibrary,
  );
  late final control = NetworkControl({
    'tbc:testnet': testnet,
    'tbc:mainnet': mainnet,
  });
  final delivery = Delivery();
  late TbcProviderSession session;
  int sequence = 0;
  Completer<void>? policyEntered, holdPolicy;
  TbcWalletConfiguration get config => TbcWalletConfiguration(
    productId: 'partner.network',
    name: 'Partner',
    profile: 'partner',
    network: testnet.network,
  );
  Future<void> start() async {
    await Future.wait([testnet.start(), mainnet.start()]);
    session = await TbcProviderSession.open(
      configuration: config,
      control: control,
      delivery: delivery,
      worker: testnet.worker,
      additionalWorkers: {'tbc:mainnet': mainnet.worker},
      policy: (_) async {
        policyEntered?.complete();
        await holdPolicy?.future;
        return copied(replay.transaction['audit']['material']['policy']);
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
    'channel': 'tws-webview/1',
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
  Map result(Object id) =>
      delivery.frames.lastWhere(
        (f) => f['type'] == 'delivery' && f['response']['id'] == id,
      )['response'];
  List events(Object id) =>
      delivery.frames.lastWhere(
        (f) => f['type'] == 'delivery' && f['response']['id'] == id,
      )['events'];
  Future<void> grant() =>
      request('grant-${++sequence}', 'wallet_requestPermissions', [
        {
          for (final name in [
            'tbc_accounts',
            'tbc_switchChain',
            'tbc_signMessage',
            'tbc_signTransaction',
          ])
            name: {
              'chains': ['tbc:testnet', 'tbc:mainnet'],
            },
        },
      ]);
  Future<void> close() async {
    await session.close();
    await Future.wait([testnet.worker.close(), mainnet.worker.close()]);
  }
}

void main() {
  setUpAll(() {
    replay.loadReplay();
    final build = jsonDecode(
      File(
        Platform.environment['TBC173_BUILD_REPORT'] ??
            '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json',
      ).readAsStringSync(),
    );
    final row = (build['builds'] as List).singleWhere(
      (v) => v['target'] == 'aarch64-apple-darwin',
    );
    currentLibrary = TbcPinnedComputeLibrary(
      path: row['path'],
      sha256: row['sha256'],
    );
  });
  Future<Harness> start() async {
    final h = Harness();
    await h.start();
    addTearDown(h.close);
    return h;
  }

  test(
    'configured discovery, inactive capabilities and grants do not switch or fetch',
    () async {
      final h = await start();
      expect(h.delivery.descriptor!['chains'], ['tbc:mainnet', 'tbc:testnet']);
      await h.request(1, 'tbc_getCapabilities', {'chainId': 'tbc:mainnet'});
      expect(h.result(1)['result']['chainId'], 'tbc:mainnet');
      expect(h.result(1)['result']['methods']['tbc_switchChain'], '1.0');
      expect(
        h.result(1)['result']['methods'].containsKey('tbc_encrypt'),
        false,
      );
      await h.request(2, 'tbc_getCapabilities', {});
      expect(h.result(2)['result']['methods']['tbc_encrypt'], '1.0');
      await h.request(3, 'tbc_getCapabilities', {
        'chainId': 'tbc:mainnet',
        'address': h.control.selectedAccount.address,
      });
      expect(h.result(3)['error']['code'], 4100);
      await h.grant();
      await h.request(4, 'tbc_getCapabilities', {
        'chainId': 'tbc:mainnet',
        'address': h.control.selectedAccount.address,
      });
      expect(h.result(4)['result']['chainId'], 'tbc:mainnet');
      await h.request(5, 'wallet_getPermissions');
      expect((h.result(5)['result'] as List).length, 8);
      expect(h.control.chain, 'tbc:testnet');
      expect(h.control.approvals, 0);
      expect([...h.testnet.paths, ...h.mainnet.paths], isEmpty);
    },
  );
  test(
    'unknown chain and page endpoint override fail before approval',
    () async {
      final h = await start();
      await h.request(1, 'tbc_switchChain', {'chainId': 'tbc:other'});
      expect(h.result(1)['error']['code'], 4901);
      await h.request(2, 'tbc_switchChain', {
        'chainId': 'tbc:mainnet',
        'apiOrigin': 'https://attacker.example',
      });
      expect(h.result(2)['error']['code'], -32602);
      await h.request(3, 'tbc_getCapabilities', {'chainId': 'tbc:other'});
      expect(h.result(3)['error']['code'], 4901);
      await h.request(4, 'tbc_getCapabilities', {'chainId': null});
      expect(h.result(4)['error']['code'], -32602);
      await h.request(5, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
      expect(h.result(5)['error']['code'], 4100);
      expect(h.control.approvals, 0);
      expect(h.testnet.backend.begins + h.mainnet.backend.begins, 0);
    },
  );
  test(
    'same chain no-op and committed switch select the right real worker',
    () async {
      final h = await start();
      await h.grant();
      await h.request(1, 'tbc_switchChain', {'chainId': 'tbc:testnet'});
      expect(h.result(1)['result'], null);
      expect(h.events(1), []);
      expect(h.control.approvals, 0);
      expect(h.control.networkRevision, 0);
      await h.request(2, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
      expect(h.result(2)['result'], null);
      expect(h.events(2), [
        {'name': 'chainChanged', 'payload': 'tbc:mainnet'},
      ]);
      expect(h.session.worker, same(h.mainnet.worker));
      await h.request(3, 'tbc_chainId');
      expect(h.result(3)['result'], 'tbc:mainnet');
      await h.request(4, 'tbc_signMessage', {
        ...copied(replay.message['request']),
        'chainId': 'tbc:mainnet',
      });
      expect(h.result(4).containsKey('error'), false);
      expect(
        h.mainnet.backend.operations.single.scope.account.network,
        TbcNetwork.mainnet,
      );
      expect(h.mainnet.backend.operations.single.signs, 1);
      expect(h.testnet.backend.begins, 0);
      await h.request(5, 'tbc_switchChain', {'chainId': 'tbc:testnet'});
      await h.request(6, 'tbc_signMessage', copied(replay.message['request']));
      expect(h.result(6).containsKey('error'), false);
      expect(h.testnet.backend.operations.single.signs, 1);
      expect([...h.testnet.paths, ...h.mainnet.paths], isEmpty);
      expect(h.control.networkRevision, 2);
      expect(h.control.approvals, 2);
    },
  );
  test('rejected switch preserves current state and emits no events', () async {
    final h = await start();
    await h.grant();
    h.control.approve = false;
    await h.request(1, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
    expect(h.result(1)['error']['code'], 4001);
    expect(h.events(1), []);
    expect(h.control.chain, 'tbc:testnet');
    expect(h.control.networkRevision, 0);
  });
  test(
    'held policy cannot start signing after network round trip with same revisions',
    () async {
      final h = await start();
      await h.grant();
      h.policyEntered = Completer();
      h.holdPolicy = Completer();
      final pending = h.request(
        1,
        'tbc_signTransaction',
        copied(replay.transaction['request']),
      );
      await h.policyEntered!.future;
      await h.request(2, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
      await h.request(3, 'tbc_switchChain', {'chainId': 'tbc:testnet'});
      h.holdPolicy!.complete();
      await pending;
      expect(h.result(1)['error']['code'], 4100);
      expect(h.testnet.backend.begins + h.mainnet.backend.begins, 0);
      expect([...h.testnet.paths, ...h.mainnet.paths], isEmpty);
      await h.request(4, 'tbc_signMessage', copied(replay.message['request']));
      expect(h.result(4).containsKey('error'), false);
    },
  );
  test(
    'switch cancels held permission dialog and disconnect revokes both chains',
    () async {
      final h = await start();
      await h.grant();
      h.control.grantEntered = Completer();
      h.control.holdGrant = Completer();
      final pending = h.request(1, 'wallet_requestPermissions', [
        {
          'tbc_signTypedData': {
            'chains': ['tbc:testnet'],
          },
        },
      ]);
      await h.control.grantEntered!.future;
      await h.request(2, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
      h.control.holdGrant!.complete();
      await pending;
      expect(h.result(1)['error']['code'], 4100);
      expect(
        h.control.grants.values.any((g) => g.contains('tbc_signTypedData')),
        false,
      );
      await h.request(3, 'tbc_disconnect');
      expect(h.result(3)['result'], null);
      expect(h.events(3), [
        {'name': 'permissionsChanged', 'payload': []},
        {'name': 'accountsChanged', 'payload': []},
      ]);
      await h.request(4, 'wallet_getPermissions');
      expect(h.result(4)['result'], []);
      await h.request(5, 'tbc_chainId');
      expect(h.result(5)['result'], 'tbc:mainnet');
    },
  );
  test(
    'network catalog requires exact per-chain worker source identity',
    () async {
      final h = await start();
      Future<void> mismatch(Map<String, TbcSigningWorker> workers) async {
        await expectLater(
          TbcProviderSession.open(
            configuration: h.config,
            control: h.control,
            delivery: Delivery(),
            worker: h.testnet.worker,
            additionalWorkers: workers,
          ),
          throwsStateError,
        );
      }

      await mismatch({});
      await mismatch({'tbc:mainnet': h.testnet.worker});
      final wrong = replay.Harness(
        network: TbcNetworkConfiguration.trustedCustom(
          network: TbcNetwork.mainnet,
          apiOrigin: 'https://wrong.example',
          trustId: 'other-source',
        ),
      );
      await wrong.start();
      addTearDown(wrong.worker.close);
      await mismatch({'tbc:mainnet': wrong.worker});
    },
  );
  test(
    'switch fences late native begin without closing the document',
    () async {
      final h = await start();
      await h.grant();
      h.testnet.backend.beginEntered = Completer();
      h.testnet.backend.holdBegin = Completer();
      final pending = h.request(
        1,
        'tbc_signMessage',
        copied(replay.message['request']),
      );
      await h.testnet.backend.beginEntered!.future;
      await h.request(2, 'tbc_switchChain', {'chainId': 'tbc:mainnet'});
      h.testnet.backend.holdBegin!.complete();
      await pending;
      // Await ordered cleanup of the late native handle, not a timer.
      await h.testnet.worker.close();
      expect(h.result(1)['error']['code'], 4100);
      expect(h.testnet.backend.operations.single.signs, 0);
      expect(h.testnet.backend.operations.single.closes, 1);
      expect(h.control.active, true);
      await h.request(3, 'tbc_signMessage', {
        ...copied(replay.message['request']),
        'chainId': 'tbc:mainnet',
      });
      expect(h.result(3).containsKey('error'), false);
      expect(h.mainnet.backend.operations.single.signs, 1);
    },
  );
  test(
    'cancelling a switch cannot commit after its approval callback',
    () async {
      final h = await start();
      await h.grant();
      h.control.switchEntered = Completer();
      h.control.holdSwitch = Completer();
      final pending = h.request(1, 'tbc_switchChain', {
        'chainId': 'tbc:mainnet',
      });
      await h.control.switchEntered!.future;
      await h.session.accept(
        h.frame('cancel', {'requestId': 1, 'reason': 'REQUEST_ABORTED'}),
        h.source,
      );
      h.control.holdSwitch!.complete();
      await pending;
      expect(h.control.chain, 'tbc:testnet');
      expect(h.control.networkRevision, 0);
      expect(h.control.active, true);
      expect(
        h.delivery.frames.where(
          (f) => f['type'] == 'delivery' && f['response']['id'] == 1,
        ),
        isEmpty,
      );
    },
  );
}
