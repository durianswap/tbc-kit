import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  final fixture = jsonDecode(
    File('test/fixtures/lop-signing.json').readAsStringSync(),
  );
  final replies = fixture['cases'][6]['replies'] as Map;
  final path =
      replies.keys.firstWhere((p) => p.toString().contains('/decode/'))
          as String;
  final id = path.split('/').last;
  final original = replies[path] as Map;
  test(
    'fresh decode seeds immutable raw across readers, never confirmation state',
    () async {
      final calls = <String>[];
      var confirmation = '12';
      final reader = Tbc20MaterialReader(
        network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
        keyless: (_, __) => throw StateError('no engine needed'),
        read: (p) async {
          calls.add(p);
          expect(
            p,
            path,
            reason: 'verified bytes must not be downloaded again',
          );
          return {
            ...Map<String, dynamic>.from(original),
            'confirmations': confirmation,
          };
        },
      );
      final fresh = await readConfirmedTransaction(
        reader.read,
        id,
        remember: reader.rememberParent,
      );
      expect(fresh['confirmations'], '12');
      expect(reader.hasParent(id), isTrue);
      final cached = await reader.parent(id);
      expect(cached.containsKey('confirmations'), isFalse);
      expect(cached['rawTransaction'], fresh['rawTransaction']);
      expect(() => (cached['outputs'] as List).clear(), throwsUnsupportedError);
      confirmation = '0';
      expect((await reader.confirmedParent(id))['confirmations'], '0');
      expect(calls, [path, path]);
      expect((await reader.parent(id)).containsKey('confirmations'), isFalse);
    },
  );
  for (final corrupt in ['txid', 'hex', 'confirmations']) {
    test('rejected $corrupt does not seed immutable bytes', () async {
      final bad = {
        ...Map<String, dynamic>.from(original),
        'confirmations': '1',
      };
      bad[corrupt] =
          corrupt == 'txid'
              ? 'ff' * 32
              : corrupt == 'hex'
              ? '00'
              : '-1';
      final reader = Tbc20MaterialReader(
        network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
        keyless: (_, __) => {},
        read: (_) async => bad,
      );
      await expectLater(reader.confirmedParent(id), throwsStateError);
      expect(reader.hasParent(id), isFalse);
    });
  }
}
