import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import '../lib/src/internal/legacy_mapping.dart';
import '../lib/src/internal/protocol_codec.dart';

void main() {
  final fixture = jsonDecode(
    File('test/fixtures/legacy-mapping.json').readAsStringSync(),
  );
  final a = fixture['account'];
  final account = LegacyMappingAccount(
    chainId: a['chainId'],
    address: a['address'],
    accountId: a['accountId'],
  );
  final business = jsonDecode(
    File('test/fixtures/legacy-business-mapping.json').readAsStringSync(),
  );
  for (final c in business['cases']) {
    test('frozen business: ${c['name']}', () {
      Object? run() {
        switch (c['kind']) {
          case 'tbc':
            return mapLegacyTbcTransfer(c['input'], account);
          case 'nft':
            return mapLegacyNftTransfer(c['input'], account);
          case 'amount':
            return legacyAtomicAmount(
              legacyDisplayAmount(c['input'], allowZero: true),
              c['decimals'],
            );
          case 'ft':
            return mapLegacyFtTransfer(
              c['input'],
              account,
              decimals: c['decimals'],
              currentStandard: c['currentStandard'],
            );
          case 'stable':
            return mapLegacyStablecoinTransfer(
              c['input'],
              account,
              decimals: c['decimals'],
            );
          case 'normalize':
            return normalizeLegacyBatch(c['input']);
          default:
            throw StateError('Unknown business case');
        }
      }

      if (c['error'] == true) {
        expect(run, throwsA(anything));
      } else {
        expect(run(), c['expected']);
      }
    });
  }
  for (final c in fixture['cases']) {
    test('frozen Kit: ${c['name']}', () async {
      Future<Object?> run() async {
        switch (c['kind']) {
          case 'raw':
            return legacyRawToReviewed(c['input']);
          case 'associated':
            return legacyAssociatedToReviewed(c['input']);
          case 'normalize':
            return normalizeLegacyBatch(c['input']);
          case 'digest':
            return legacyBitcoinDigest(c['input']);
          case 'workflow':
            return mapLegacyWorkflow(
              c['input'],
              account,
              mapBusiness:
                  (_) => Map<String, dynamic>.from(fixture['transaction']),
            );
          case 'standalone':
            final r = c['input'];
            expect(
              mapLegacySecureResult(r['method'], r['params'], c['result']),
              c['expectedResult'],
            );
            return mapLegacyStandalone(r['method'], r['params'], account);
          case 'results':
            return mapLegacyWorkflowResult(c['input'], c['standardResult']);
          default:
            throw StateError('Unknown oracle case');
        }
      }

      if (c['error'] == true) {
        await expectLater(run(), throwsA(anything));
      } else {
        expect(await run(), c['expected']);
      }
    });
  }
  test('business mapping overlaps without changing ordered results', () async {
    final rows = [
      for (var i = 0; i < 3; i++)
        {
          'method': 'sendTransaction',
          'params': {'broadcastEnabled': false, 'flag': 'P2PKH', 'order': i},
        },
    ];
    final waits = List.generate(3, (_) => Completer<void>()), started = <int>[];
    final pending = mapLegacyWorkflow(
      rows,
      account,
      mapBusiness: (p) async {
        final i = (p as Map)['order'] as int;
        started.add(i);
        await waits[i].future;
        final tx = copied(fixture['transaction']);
        tx['intent']['amount'] = '${i + 1}';
        return tx;
      },
    );
    await Future<void>.delayed(Duration.zero);
    expect(started, [0, 1, 2]);
    for (final c in waits.reversed) {
      c.complete();
    }
    final mapped = await pending;
    expect((mapped['steps'] as List).map((s) => s['intent']['amount']), [
      '1',
      '2',
      '3',
    ]);
  });
  test(
    'mapped transaction cannot change native-captured chain or account',
    () async {
      final rows = [
        {
          'method': 'sendTransaction',
          'params': {'broadcastEnabled': false, 'flag': 'P2PKH'},
        },
      ];
      for (final field in ['chainId', 'from']) {
        await expectLater(
          mapLegacyWorkflow(
            rows,
            account,
            mapBusiness:
                (_) => {
                  ...Map<String, dynamic>.from(fixture['transaction']),
                  field: 'changed',
                },
          ),
          throwsStateError,
        );
      }
    },
  );
  test('mapped request cannot be mutated by the original page object', () {
    final row = fixture['cases'].firstWhere((c) => c['name'] == 'raw')['input'];
    final input = copied(row), mapped = legacyRawToReviewed(input);
    input['utxos_satoshis'][0][0] = 9999;
    expect(
      mapped['payload']['transactions'][0]['inputs'][0]['satoshis'],
      '1000',
    );
    expect(
      () => mapped['payload']['format'] = 'changed',
      throwsUnsupportedError,
    );
  });
  test('result signature matrix mismatch rejected', () {
    final row = fixture['cases'].firstWhere((c) => c['name'] == 'raw')['input'];
    expect(
      () => mapLegacySecureResult('signTransaction', row, {
        'detachedSignatures': [],
      }),
      throwsStateError,
    );
  });
  test(
    'standalone route does not accept arbitrary method or synthetic workflow',
    () {
      expect(
        () => mapLegacyStandalone('sendBatchRequest', [], account),
        throwsUnsupportedError,
      );
      expect(
        () => mapLegacyStandalone('signMessage', {}, account),
        throwsUnsupportedError,
      );
    },
  );
}
