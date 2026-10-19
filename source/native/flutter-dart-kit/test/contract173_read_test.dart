import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_fee_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/utxo_pages.dart';

void main() {
  Map<String, dynamic> fee(int lp) => {
    'lpFeeRate': lp,
    'taxFeeRate': 0,
    'serviceProviderFeeRate': 0,
    'protocolFeeRate': 0,
    'feeAddress': '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
  };
  Map<String, dynamic> row(int n) => {
    'txid': 'ab' * 32,
    'index': n,
    'value': '100',
  };
  test('explicit rates use 1.7.3 bound, not the superseded 600 bps cap', () {
    for (final value in [0, 600, 601, 9999]) {
      expect(normalizeAmmFeePolicy(fee(value)), fee(value));
    }
    for (final invalid in [
      fee(-1),
      fee(10000),
      {...fee(5000), 'taxFeeRate': 5000},
      {...fee(1), 'lpFeeRate': 1.5},
      {...fee(1), 'feeAddress': 'bad'},
      {...fee(1), 'feeAddress': '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMJ'},
      {...fee(1), 'lpPlan': 6},
      {...fee(1)}..remove('taxFeeRate'),
    ]) {
      expect(() => normalizeAmmFeePolicy(invalid), throwsStateError);
    }
  });
  test(
    'unpaged index costs exactly one read; LP null alone becomes empty',
    () async {
      final paths = <String>[];
      expect(
        await collectUtxoPages(
          (p) async {
            paths.add(p);
            return {
              'utxos': [row(0)],
            };
          },
          '/index',
          maxRows: 2,
        ),
        {
          'utxos': [row(0)],
        },
      );
      expect(paths, ['/index']);
      expect(
        await collectUtxoPages(
          (p) async => {'utxos': null},
          '/index',
          maxRows: 2,
          allowNull: true,
        ),
        {'utxos': []},
      );
      await expectLater(
        collectUtxoPages((p) async => {'utxos': null}, '/index', maxRows: 2),
        throwsStateError,
      );
    },
  );
  test(
    'cursor follows only explicit continuation and deduplicates overlap',
    () async {
      final paths = <String>[];
      final result = await collectUtxoPages(
        (p) async {
          paths.add(p);
          return paths.length == 1
              ? {
                'utxos': [row(0)],
                'next_cursor': 'a+/=',
              }
              : {
                'utxos': [row(0), row(1)],
              };
        },
        '/index',
        maxRows: 2,
      );
      expect(result, {
        'utxos': [row(0), row(1)],
      });
      expect(paths, ['/index', '/index?after=a%2B%2F%3D']);
    },
  );
  test(
    'duplicate/cyclic/oversized/malformed indexes reject without raw reads',
    () async {
      for (final data in [
        {
          'utxos': [row(0), row(0)],
        },
        {
          'utxos': [row(0), row(1), row(2)],
        },
        {
          'utxos': [row(0)],
          'next_cursor': null,
        },
        {
          'utxos': [row(0)],
          'next_cursor': 'x',
        },
        {
          'utxos': [
            {'txid': 'bad', 'index': 0},
          ],
        },
        {
          'utxos': [row(0)],
          'next_cursor': 'x' * 2049,
        },
      ]) {
        var reads = 0;
        await expectLater(
          collectUtxoPages(
            (p) async {
              reads++;
              return data;
            },
            '/index',
            maxRows: 2,
            maxPages: 2,
          ),
          throwsStateError,
        );
        expect(reads, lessThanOrEqualTo(2));
      }
    },
  );
}
