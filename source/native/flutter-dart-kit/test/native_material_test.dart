import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'support/trusted_index_candidate.dart';

void main() {
  final fixture =
      jsonDecode(File('test/fixtures/native-transfers.json').readAsStringSync())
          as Map;
  for (final sample in fixture['cases']) {
    test('frozen Kit native material/policy: ${sample['name']}', () async {
      final paths = <String>[],
          network = TbcNetworkConfiguration.official(
            sample['network'] == 'mainnet'
                ? TbcNetwork.mainnet
                : TbcNetwork.testnet,
          );
      final reader = NativeMaterialReader(
        network: network,
        read: (path) async {
          paths.add(path);
          expect(sample['replies'].containsKey(path), true);
          return copied(sample['replies'][path]);
        },
      );
      Future<Map<String, dynamic>> run() => reader.resolve(
        request: copied(sample['request']),
        account: copied(sample['account']),
        now: DateTime.parse(sample['now']),
        snapshotId: sample['snapshotId'],
        minConfirmations: sample['name'] == 'future-height' ? '1' : '0',
      );
      if (sample['snapshot']['portError'] != null) {
        await expectLater(run(), throwsA(isA<StateError>()));
      } else {
        expect(canonical(await run()), canonical(withoutObservedTip(sample['snapshot'])));
        expect(
          canonical(
            defaultTransactionPolicy(
              network: network,
              request: copied(sample['request']),
              now: DateTime.parse(sample['now']),
            ),
          ),
          canonical(sample['policy']),
        );
      }
      final expected = (sample['trace'] as List).where((p) => sample['name'] == 'future-height' || p != '/api/tbc/nodeinfo');
      expect(paths.length, expected.length);
      expect(paths.toSet(), expected.toSet());
    });
  }
  test('wrong chain rejects before any GET', () async {
    final sample = fixture['cases'][0];
    var reads = 0;
    final reader = NativeMaterialReader(
      network: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
      read: (p) async {
        reads++;
        return {};
      },
    );
    await expectLater(
      reader.resolve(
        request: copied(sample['request']),
        account: copied(sample['account']),
        now: DateTime.now(),
        snapshotId: 'bad-network',
      ),
      throwsStateError,
    );
    expect(reads, 0);
  });
}
