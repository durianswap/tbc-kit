import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';

void main() {
  test(
    'default TBC20 policy matches the sealed accepted policy byte-for-byte',
    () {
      final f = jsonDecode(
        File('test/fixtures/signing/replay.json').readAsStringSync(),
      );
      final c = (f['cases'] as List).firstWhere(
        (c) => c['name'] == 'android-tbc_signTransaction',
      );
      final expected = c['audit']['material']['policy'] as Map;
      final now = DateTime.parse(
        expected['payload']['expiresAt'],
      ).subtract(const Duration(minutes: 5));
      expect(
        canonical(
          currentTbc20Policy(
            network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
            request: copied(c['request']),
            now: now,
          ),
        ),
        canonical(expected),
      );
    },
  );
  test(
    'policy follows the configured chain and rejects another family/network',
    () {
      final n = TbcNetworkConfiguration.official(TbcNetwork.mainnet),
          now = DateTime.utc(2026, 10, 12);
      final p = currentTbc20Policy(
        network: n,
        request: {
          'chainId': n.chainId,
          'intent': {'type': 'tbc20.transfer'},
        },
        now: now,
      );
      expect(p['payload']['policyId'], 'tbc-mainnet-kit-r1');
      expect(p['payload']['chainId'], n.chainId);
      expect(p['payload']['feeRateSatPerKb'], '80');
      expect(p['payload']['dustThreshold'], '42');
      for (final request in [
        {
          'chainId': 'tbc:testnet',
          'intent': {'type': 'tbc20.transfer'},
        },
        {
          'chainId': n.chainId,
          'intent': {'type': 'amm.swap'},
        },
      ]) {
        expect(
          () => currentTbc20Policy(network: n, request: request, now: now),
          throwsStateError,
        );
      }
    },
  );
}
