// Actual wire/session/worker/frozen Rust, with fixture native and network
// adapters. The paired native executable tests attest the real custody owner.
import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_maintenance.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wallet_protocol.dart';
import 'maintenance_worker_test.dart' as merge;
import 'provider_session_test.dart' show Delivery;
import 'support/signing_replay.dart' as replay;

final class Control
    implements
        TbcProviderControl,
        TbcProviderProtocolControl,
        TbcProviderOptionalMethods {
  Control(this.h, this.walletProtocol);
  final merge.Harness h;
  final delivered = <Object, String>{};
  final grants = {'tbc_accounts', 'tbc_sendTransaction'};
  @override
  final TbcNativeWalletProtocol walletProtocol;
  @override
  final optionalMethods = {'tbc_sendTransaction'};
  @override
  TbcNetworkConfiguration get network => h.network;
  @override
  TbcWebViewNavigation get navigation => h.navigation;
  @override
  TbcAccount get selectedAccount => h.account;
  @override
  int revision = 0;
  @override
  bool get isUnlocked => h.unlocked;
  @override
  void requireCurrent() => need(h.live, 'REVOKED');
  @override
  bool permits(String name) => isUnlocked && grants.contains(name);
  @override
  List<Map<String, dynamic>> currentPermissions() => [];
  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest r,
  ) async => throw StateError('Not part of fixture');
  @override
  Future<void> disconnect(String id) async {
    grants.clear();
    revision++;
  }

  @override
  Future<void> cancel(String id) async {}
  @override
  void invalidate() {
    h.live = false;
  }

  @override
  Future<void> beforeDelivery(String method, Object id, String text) async {
    requireCurrent();
    delivered[id] = method;
    final response = jsonDecode(text)['response'] as Map;
    if (response.containsKey('result')) {
      final standard = walletProtocol == TbcNativeWalletProtocol.standard;
      expect(
        method,
        standard ? 'wallet_runMultiRoundMerge' : 'wallet_mergeMaintenance',
      );
      expect(permits('tbc_accounts') && permits('tbc_sendTransaction'), true);
      final result = Map<String, dynamic>.from(response['result']);
      if (standard) {
        expect(result.remove('atomic'), false);
        expect(result.remove('progress'), isNotEmpty);
      }
      expect(result, h.noopResult ?? h.owner?.result);
    }
  }
}

final class Entry {
  Entry(String file, int index, String kind, {this.standard = false})
    : h = merge.Harness(file, index, kind);
  final merge.Harness h;
  final bool standard;
  late final control = Control(
    h,
    standard
        ? TbcNativeWalletProtocol.standard
        : TbcNativeWalletProtocol.legacy,
  );
  final delivery = Delivery();
  late TbcProviderSession session;
  int sequence = 0;
  String frame(String type, [Map extra = const {}]) => canonical({
    'channel': control.walletProtocol.wireChannel,
    'type': type,
    'sessionId': h.navigation.sessionId,
    'navigationId': h.navigation.navigationId,
    'messageId': 'request-${++sequence}',
    ...extra,
  });
  TbcWebViewMessageSource get source => TbcWebViewMessageSource(
    webViewInstanceId: h.navigation.webViewInstanceId,
    sessionId: h.navigation.sessionId,
    navigationId: h.navigation.navigationId,
    origin: h.navigation.origin,
    topOrigin: h.navigation.origin,
    isMainFrame: true,
  );
  Future<void> start({bool enabled = true}) async {
    await h.start(
      profile:
          standard
              ? MessageSigningProfile.standard
              : MessageSigningProfile.legacyBitcoin,
    );
    session = await TbcProviderSession.open(
      configuration: TbcWalletConfiguration(
        productId: 'partner.fixture',
        name: 'Fixture',
        profile: 'fixture',
        network: h.network,
        maintenance:
            enabled
                ? TbcMaintenancePolicy(
                  maxTransactions: 2,
                  maxTotalFee: h.limits['maxTotalFee'],
                  approvalLifetime: const Duration(minutes: 2),
                  maxIndexRefreshes: 0,
                  indexRefreshDelay: Duration.zero,
                )
                : null,
      ),
      control: control,
      delivery: delivery,
      worker: h.worker,
      walletProtocol: control.walletProtocol,
    );
    await session.accept(frame('ready'), source);
  }

  Future<void> request(Object id, String method, Object? input) {
    h.scope = TbcSigningRequestScope(
      operationId: rpcOperationId(h.navigation.sessionId, id),
      method: 'tbc_sendTransaction',
      navigation: h.navigation,
      account: h.account,
      revision: control.revision,
    );
    return session.accept(
      frame('request', {
        'request': {
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          'params': standard ? input : {'legacyJson': jsonEncode(input)},
        },
      }),
      source,
    );
  }

  Map response(Object id) =>
      delivery.frames
              .where(
                (f) => f['type'] == 'delivery' && f['response']['id'] == id,
              )
              .last['response']
          as Map;
  Future<void> close() async {
    await session.close();
    await h.worker.close();
  }

  Map<String, dynamic> standardRequest() => {
    'version': '1.0',
    'chainId': h.network.chainId,
    'from': h.account.address,
    'clientRequestId': 'merge-fixture',
    'asset': h.asset,
    'limits': copied(session.configuration.maintenance!.limits(DateTime.now())),
  };
}

void main() {
  setUpAll(replay.loadReplay);
  for (final kind in ['tbc', 'ft', 'stablecoin', 'pool-ft', 'ftlp']) {
    test(
      'Standard maintenance $kind reuses canonical worker and frozen progress shape',
      () async {
        final (file, index) = switch (kind) {
          'tbc' => ('native-signing', 3),
          'ft' => ('fungible-signing', 2),
          'stablecoin' => ('stablecoin-signing', 3),
          'pool-ft' => ('unified-pool-signing', 4),
          _ => ('unified-pool-signing', 16),
        };
        final e = Entry(file, index, kind, standard: true);
        await e.start();
        addTearDown(e.close);
        expect(
          e.session.availableMethods,
          isNot(contains('tbc_runMultiRoundMerge')),
        );
        await e.request(1, 'tbc_runMultiRoundMerge', e.standardRequest());
        expect(
          e.response(1).containsKey('error'),
          false,
          reason: '${e.response(1)}',
        );
        final result = e.response(1)['result'] as Map;
        expect(result['atomic'], false);
        expect(result['status'], 'complete');
        expect(result['progress'].first['phase'], 'approval');
        expect(result['progress'].last['phase'], 'complete');
        expect(e.h.approvals, 1);
        expect(e.h.operations.single.submits, 1);
        await e.request(2, 'tbc_runMultiRoundMerge', e.standardRequest());
        expect(e.response(2)['result']['reason'], 'already-below-target');
        expect(e.response(2)['result']['progress'].length, 1);
        expect(e.h.approvals, 1);
      },
    );
  }
  for (final failure in [
    'version',
    'chainId',
    'from',
    'clientRequestId',
    'extra',
    'asset',
    'fee',
    'transactions',
    'deadline',
    'refreshes',
    'delay',
    'accounts',
    'send',
    'disabled',
    'rejected',
    'unknown',
  ]) {
    test(
      'Standard maintenance $failure preserves authority and wallet bounds',
      () async {
        final e = Entry('native-signing', 3, 'tbc', standard: true);
        await e.start(enabled: failure != 'disabled');
        addTearDown(e.close);
        final request =
            failure == 'disabled' ? <String, dynamic>{} : e.standardRequest();
        if (['version', 'chainId', 'from', 'clientRequestId'].contains(failure))
          request[failure] = 'wrong/field';
        if (failure == 'extra') request['origin'] = 'https://other.example';
        if (failure == 'asset') request['asset'] = {'kind': 'bad'};
        if (failure == 'fee')
          request['limits']['maxTotalFee'] = '2100000000000001';
        if (failure == 'transactions') request['limits']['maxTransactions'] = 3;
        if (failure == 'deadline')
          request['limits']['expiresAt'] =
              DateTime.now()
                  .add(const Duration(hours: 2))
                  .toUtc()
                  .toIso8601String();
        if (failure == 'refreshes') request['limits']['maxIndexRefreshes'] = 1;
        if (failure == 'delay') request['limits']['indexRefreshDelayMs'] = 1;
        if (failure == 'accounts') e.control.grants.remove('tbc_accounts');
        if (failure == 'send') e.control.grants.remove('tbc_sendTransaction');
        e.h.reject = failure == 'rejected';
        e.h.unknown = failure == 'unknown';
        await e.request(1, 'tbc_runMultiRoundMerge', request);
        final r = e.response(1);
        if (failure == 'unknown') {
          expect(r['result']['status'], 'uncertain');
          // The ordinary send port already reconciles once before throwing
          // unknown; the coordinator must not invent a second recovery loop.
          expect(r['result']['progress'].last['phase'], 'executing');
          expect(e.h.operations.single.submits, 1);
        } else {
          expect(
            r['error']['code'],
            failure == 'disabled'
                ? 4200
                : ['accounts', 'send'].contains(failure)
                ? 4100
                : failure == 'rejected'
                ? 4001
                : -32602,
          );
          expect(e.h.operations, isEmpty);
          if (failure != 'rejected') {
            expect(e.h.paths, isEmpty);
            expect(e.h.approvals, 0);
          }
        }
      },
    );
  }
  test(
    'wallet bounds use canonical millisecond deadlines, not Dart microseconds',
    () {
      final policy = TbcMaintenancePolicy(
        maxTransactions: 2,
        maxTotalFee: '1000',
        approvalLifetime: const Duration(minutes: 2),
      );
      expect(
        policy.limits(
          DateTime.parse('2026-10-14T01:00:00.123456Z'),
        )['expiresAt'],
        '2026-10-14T01:02:00.123Z',
      );
      expect(
        () => TbcMaintenancePolicy(
          maxTransactions: 65,
          maxTotalFee: '1000',
          approvalLifetime: const Duration(minutes: 2),
        ),
        throwsFormatException,
      );
      expect(
        () => TbcMaintenancePolicy(
          maxTransactions: 2,
          maxTotalFee: '2100000000000001',
          approvalLifetime: const Duration(minutes: 2),
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'three aliases are exact DTO mappings, no input limits or authority',
    () {
      expect(legacyMergeAsset('mergeUtxos', null), {'kind': 'tbc'});
      expect(legacyMergeAsset('mergeUtxos', {}), {'kind': 'tbc'});
      for (final method in ['mergeFtUtxos', 'mergeStableCoinUtxos']) {
        for (final input in [
          'A' * 64,
          {'contract_id': 'A' * 64},
          {'ft_contract_address': 'A' * 64},
        ]) {
          expect(legacyMergeAsset(method, input), {
            'kind': method == 'mergeFtUtxos' ? 'ft' : 'stablecoin',
            'contractId': 'a' * 64,
          });
        }
        for (final bad in [
          null,
          [],
          {},
          'bad',
          {'contract_id': 'a' * 64, 'from': 'other'},
          {'contract_id': 'a' * 64, 'ft_contract_address': 'a' * 64},
        ]) {
          expect(() => legacyMergeAsset(method, bad), throwsFormatException);
        }
      }
      for (final bad in [
        [],
        {'limits': {}},
        '',
      ]) {
        expect(
          () => legacyMergeAsset('mergeUtxos', bad),
          throwsFormatException,
        );
      }
    },
  );
  final cases = [
    ('native-signing', 3, 'tbc', 'mergeUtxos'),
    ('fungible-signing', 2, 'ft', 'mergeFtUtxos'),
    ('stablecoin-signing', 3, 'stablecoin', 'mergeStableCoinUtxos'),
  ];
  for (final c in cases) {
    test(
      '${c.$4} uses shared worker, one consent, native result before projection',
      () async {
        final e = Entry(c.$1, c.$2, c.$3);
        await e.start();
        addTearDown(e.close);
        final input =
            c.$3 == 'tbc' ? null : {'contract_id': e.h.asset['contractId']};
        await e.request(1, c.$4, input);
        final r = e.response(1);
        expect(
          r.containsKey('error'),
          false,
          reason:
              '$r paths=${e.h.paths.length} approvals=${e.h.approvals} children=${e.h.operations.length}',
        );
        expect(r['result']['status'], 'complete');
        expect(r['result']['steps'].length, 1);
        expect(e.control.delivered[1], 'wallet_mergeMaintenance');
        expect(e.h.approvals, 1);
        expect(e.h.operations.single.submits, 1);
        expect(e.h.ordinaryBegins, 0);
        final paths = e.h.paths.length;
        await e.request(1, c.$4, input);
        expect(e.h.paths.length, paths);
        expect(e.h.approvals, 1);
        // The same current index now has one output; a new call needs no consent.
        await e.request(2, c.$4, input);
        expect(e.response(2)['result']['reason'], 'already-below-target');
        expect(e.h.approvals, 1);
        expect(e.h.operations.length, 1);
      },
    );
  }
  for (final failure in [
    'disabled',
    'accounts',
    'send',
    'params',
    'rejected',
    'unknown',
  ]) {
    test(
      'maintenance entry $failure does not acquire unintended authority',
      () async {
        final e = Entry('native-signing', 3, 'tbc');
        await e.start(enabled: failure != 'disabled');
        addTearDown(e.close);
        if (failure == 'accounts') e.control.grants.remove('tbc_accounts');
        if (failure == 'send') e.control.grants.remove('tbc_sendTransaction');
        e.h.reject = failure == 'rejected';
        e.h.unknown = failure == 'unknown';
        await e.request(
          1,
          'mergeUtxos',
          failure == 'params' ? {'maxTotalFee': '0'} : null,
        );
        final r = e.response(1);
        if (failure == 'unknown') {
          expect(r['result']['status'], 'uncertain');
          expect(e.h.operations.single.submits, 1);
          expect(e.h.operations.single.reconciles, 1);
          expect(e.h.owner!.result, r['result']);
        } else {
          expect(
            r['error']['code'],
            failure == 'disabled'
                ? 4200
                : failure == 'params'
                ? -32602
                : failure == 'rejected'
                ? 4001
                : 4100,
          );
          expect(e.h.operations, isEmpty);
          if (failure != 'rejected') {
            expect(e.h.paths, isEmpty);
            expect(e.h.approvals, 0);
          }
        }
      },
    );
  }
}
