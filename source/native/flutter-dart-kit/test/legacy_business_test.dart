import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_mapping.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_business.dart';

final class Metadata implements LegacyBusinessMetadata {
  @override
  TbcNetworkConfiguration network = TbcNetworkConfiguration.official(
    TbcNetwork.testnet,
  );
  final calls = <String>[];
  final gate = Completer<void>();
  bool wait = false;
  int decimals = 6;
  @override
  Future<LegacyFtIdentity> ft(String id) async {
    calls.add('ft:$id');
    if (wait) await gate.future;
    return const LegacyFtIdentity(decimals: 6, currentStandard: true);
  }

  @override
  Future<int> stablecoinDecimals(String id) async {
    calls.add('coin:$id');
    if (wait) await gate.future;
    return decimals;
  }

  @override
  Future<int> poolFtDecimals(String id) async {
    calls.add('pool:$id');
    if (wait) await gate.future;
    return decimals;
  }
}

void main() {
  final data = jsonDecode(
    File('test/fixtures/legacy-pool-mapping.json').readAsStringSync(),
  );
  final a = data['account'];
  final account = LegacyMappingAccount(
    chainId: a['chainId'],
    address: a['address'],
    accountId: a['accountId'],
  );
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  final ft = {
    'flag': 'FT_TRANSFER',
    'ft_contract_address': 'ab' * 32,
    'address': a['address'],
    'ft_amount': 1.25,
    'broadcastEnabled': false,
  };
  for (final c in (data['cases'] as List).where(
    (c) => c['error'] != true && c['chainId'] == 'tbc:testnet',
  )) {
    test('facade ${c['name']} uses only required shared metadata', () async {
      final metadata = Metadata()..decimals = c['decimals'];
      final resolver = LegacyBusinessResolver(
        account: account,
        network: network,
        metadata: metadata,
        requireCurrent: () {},
        now: () => DateTime.parse(data['now']),
      );
      final result = await resolver.resolve([c['input']]);
      expect(result, legacySharedBusinessRequest(c['expected']));
      expect(
        metadata.calls.length,
        c['input']['flag'] == 'POOLNFT_SWAP_TO_TBC' ? 1 : 0,
      );
    });
  }
  test(
    'metadata read cannot change captured params or execute after revocation',
    () async {
      final metadata = Metadata()..wait = true;
      bool current = true;
      final resolver = LegacyBusinessResolver(
        account: account,
        network: network,
        metadata: metadata,
        requireCurrent: () {
          if (!current) throw StateError('revoked');
        },
      );
      final params = {...ft}, pending = resolver.resolve(params);
      params['ft_amount'] = '999';
      current = false;
      metadata.gate.complete();
      await expectLater(pending, throwsStateError);
    },
  );
  test(
    'snapshot survives page mutation while precision is being loaded',
    () async {
      final metadata = Metadata()..wait = true;
      final resolver = LegacyBusinessResolver(
        account: account,
        network: network,
        metadata: metadata,
        requireCurrent: () {},
      );
      final params = {...ft}, pending = resolver.resolve(params);
      params['ft_amount'] = '999';
      metadata.gate.complete();
      expect((await pending)['intent']['amount'], '1250000');
    },
  );
  test(
    'different source or chain is rejected, including during asynchronous resolution',
    () async {
      final metadata = Metadata();
      final other = TbcNetworkConfiguration.trustedCustom(
        network: TbcNetwork.testnet,
        apiOrigin: 'https://other.example',
        trustId: 'other',
      );
      expect(
        () => LegacyBusinessResolver(
          account: account,
          network: other,
          metadata: metadata,
          requireCurrent: () {},
        ),
        throwsStateError,
      );
      final resolver = LegacyBusinessResolver(
        account: account,
        network: network,
        metadata: metadata,
        requireCurrent: () {},
      );
      metadata.wait = true;
      final pending = resolver.resolve(ft);
      metadata.network = other;
      metadata.gate.complete();
      await expectLater(pending, throwsStateError);
    },
  );
  test(
    'mixed batch metadata overlaps and maintains ordered shared intents',
    () async {
      final metadata = Metadata()..wait = true;
      final resolver = LegacyBusinessResolver(
        account: account,
        network: network,
        metadata: metadata,
        requireCurrent: () {},
      );
      final sell =
          (data['cases'] as List).firstWhere(
            (c) => c['name'] == 'POOLNFT_SWAP_TO_TBC',
          )['input'];
      final rows =
          [
            ft,
            sell,
            {...ft, 'flag': 'STABLECOIN_TRANSFER'},
          ].map((p) => {'method': 'sendTransaction', 'params': p}).toList();
      final pending = mapLegacyWorkflow(
        rows,
        account,
        mapBusiness: resolver.resolve,
      );
      await Future<void>.delayed(Duration.zero);
      expect(metadata.calls.map((s) => s.split(':').first), [
        'ft',
        'pool',
        'coin',
      ]);
      metadata.gate.complete();
      final result = await pending;
      expect((result['steps'] as List).map((s) => s['intent']['type']), [
        'tbc20.transfer',
        'amm.swap',
        'tbc20Stablecoin.transfer',
      ]);
    },
  );
  test('excluded flags never query metadata', () async {
    final metadata = Metadata();
    final resolver = LegacyBusinessResolver(
      account: account,
      network: network,
      metadata: metadata,
      requireCurrent: () {},
    );
    for (final flag in [
      'FT_MINT',
      'COLLECTION_CREATE',
      'NFT_CREATE',
      'POOLNFT_MINT',
      'POOLNFT_INIT',
      'STABLECOIN_MINT',
      'BTC',
      'EVM',
    ]) {
      await expectLater(resolver.resolve({'flag': flag}), throwsStateError);
    }
    expect(metadata.calls, isEmpty);
  });
}
