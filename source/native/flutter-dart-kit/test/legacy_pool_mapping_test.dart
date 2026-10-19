import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_mapping.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

void main() {
  final f = jsonDecode(
    File('test/fixtures/legacy-pool-mapping.json').readAsStringSync(),
  );
  LegacyMappingAccount account(String chain) => LegacyMappingAccount(
    chainId: chain,
    address: f['account']['address'],
    accountId: '$chain:${f['account']['address']}',
  );
  for (final c in f['cases']) {
    test('frozen Pool DTO ${c['name']}', () {
      Map run() => mapLegacyPoolTransaction(
        c['input'],
        account(c['chainId']),
        ftDecimals: c['noMetadata'] == true ? null : c['decimals'],
        now: DateTime.parse(f['now']),
      );
      if (c['error'] == true) {
        expect(run, throwsStateError);
      } else {
        expect(run(), c['expected']);
        final shared = legacySharedBusinessRequest(run());
        expect(shared['chainId'], c['chainId']);
        expect(shared['from'], f['account']['address']);
        expect(shared['clientRequestId'], c['expected']['clientRequestId']);
        expect(shared['constraints'], c['expected']['constraints']);
        expect(shared['intent'].containsKey('lpPlan'), false);
        expect(shared['intent'].containsKey('serviceFeeRate'), false);
      }
    });
  }
  test('LP6 is a page hint only; same mapped request as omitted LP plan', () {
    final c = (f['cases'] as List).firstWhere(
      (c) => c['name'] == 'POOLNFT_SWAP_TO_TOKEN',
    );
    Map run(Map p) => mapLegacyPoolTransaction(
      p,
      account(c['chainId']),
      now: DateTime.parse(f['now']),
    );
    final original = copied(c['input']);
    expect(run({...original, 'lpPlan': 6}), run(original));
    expect(() => run({...original, 'serviceFeeRate': 130}), throwsStateError);
  });
  test(
    'old pool create/init stay excluded, including superficially valid IDs',
    () {
      for (final flag in ['POOLNFT_MINT', 'POOLNFT_INIT']) {
        expect(
          () => mapLegacyPoolTransaction({
            'flag': flag,
            'nft_contract_address': 'ab' * 32,
          }, account('tbc:testnet')),
          throwsStateError,
        );
      }
    },
  );
  test(
    'FT/Coin maintenance maps to one shared transaction, not a merge-all loop',
    () {
      for (final stable in [false, true]) {
        final input = {
          'flag': stable ? 'STABLECOIN_MERGE' : 'FT_MERGE',
          'ft_contract_address': 'AB' * 32,
        };
        final mapped = mapLegacyAssetMerge([input], account('tbc:testnet'));
        expect(mapped['intent'], {
          'version': '1.0',
          'type': stable ? 'tbc.stablecoin.merge' : 'tbc.ft.merge',
          'contractId': 'ab' * 32,
        });
        final shared = legacySharedBusinessRequest(mapped);
        expect(
          shared['intent']['type'],
          stable ? 'tbc20Stablecoin.merge' : 'tbc20.merge',
        );
        expect(shared['intent']['contractId'], 'ab' * 32);
        expect(
          () => mapLegacyAssetMerge({
            ...input,
            'broadcastEnabled': true,
          }, account('tbc:testnet')),
          throwsStateError,
        );
        expect(
          () => mapLegacyAssetMerge({
            ...input,
            'domain': 42,
          }, account('tbc:testnet')),
          throwsStateError,
        );
      }
    },
  );
}
