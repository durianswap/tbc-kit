import 'package:test/test.dart';
import 'dart:convert';
import 'dart:io';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/balance_read.dart';

const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
void main() {
  test(
    'actual frozen Kit oracle matches accepts, rejects and displayed values',
    () async {
      final oracle = jsonDecode(
        File('test/fixtures/balance-frozen-kit.json').readAsStringSync(),
      );
      for (final row in oracle['cases']) {
        final calls = <String>[];
        final future = readTbcBalance(
          network: TbcNetworkConfiguration.official(
            TbcNetwork.values.byName(row['network']),
          ),
          address: row['address'],
          read: (path) async {
            calls.add(path);
            return Map<String, dynamic>.from(row['response']);
          },
        );
        if (row['rejected'] == true) {
          await expectLater(future, throwsStateError);
        } else {
          final result = await future;
          final padded = (result['balanceAtomic'] as String).padLeft(7, '0');
          expect(
            double.parse(
              '${padded.substring(0, padded.length - 6)}.${padded.substring(padded.length - 6)}',
            ),
            row['result']['tbc'],
          );
        }
        expect(calls, ['/api/tbc/balance/address/${row['address']}']);
      }
    },
  );
  test(
    'both networks use one exact balance GET and retain integer wire amounts',
    () async {
      for (final network in TbcNetwork.values) {
        for (final amount in [0, 1, 1.0, 1000001, '9007199254740991']) {
          final paths = <String>[];
          final result = await readTbcBalance(
            network: TbcNetworkConfiguration.official(network),
            address: address,
            read: (path) async {
              paths.add(path);
              return {'address': address, 'balance': amount};
            },
          );
          expect(paths, ['/api/tbc/balance/address/$address']);
          expect(result, {
            'chainId': network.chainId,
            'address': address,
            'decimals': 6,
            'balanceAtomic': amount is double ? '${amount.toInt()}' : '$amount',
          });
        }
      }
    },
  );
  test(
    'API errors, mismatched owner and unsafe amounts reject without fallback',
    () async {
      final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
      for (final response in [
        {'balance': -1},
        {'balance': 1.5},
        {'balance': double.infinity},
        {'balance': '01'},
        {'balance': '1e6'},
        {'balance': '-0'},
        {'balance': ''},
        {'balance': '9007199254740992'},
        {'balance': 9007199254740992},
        {'balance': true},
        <String, dynamic>{},
        {'balance': 0, 'address': null},
        {'balance': 0, 'address': 'wrong'},
      ]) {
        var count = 0;
        await expectLater(
          readTbcBalance(
            network: network,
            address: address,
            read: (p) async {
              count++;
              return response;
            },
          ),
          throwsStateError,
        );
        expect(count, 1);
      }
      var count = 0;
      await expectLater(
        readTbcBalance(
          network: network,
          address: 'bad',
          read: (p) async {
            count++;
            return {'balance': 0};
          },
        ),
        throwsStateError,
      );
      expect(count, 0);
    },
  );
}
