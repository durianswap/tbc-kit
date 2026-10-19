import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/read_api.dart';

void main() {
  test(
    'only bounded exact outpoints can reach read-only status POST',
    () async {
      final api = TbcReadApi(
        TbcNetworkConfiguration.official(TbcNetwork.testnet),
      );
      addTearDown(api.close);
      for (final txos in <List<Map<String, dynamic>>>[
        [],
        [
          {'txid': 'ff' * 32, 'index': -1},
        ],
        [
          {'txid': '00', 'index': 0},
        ],
        [
          {'txid': 'ff' * 32, 'index': 0, 'rawTransaction': '00'},
        ],
        List.generate(2, (_) => {'txid': 'ff' * 32, 'index': 0}),
        List.generate(10001, (i) => {'txid': 'ff' * 32, 'index': i}),
      ]) {
        await expectLater(api.txoStatus(txos), throwsStateError);
      }
      api.close();
      await expectLater(
        api.txoStatus([
          {'txid': 'ff' * 32, 'index': 0},
        ]),
        throwsStateError,
      );
    },
  );
  test(
    'read-only source rejects non-allowlisted endpoints and closed use',
    () async {
      final api = TbcReadApi(
        TbcNetworkConfiguration.official(TbcNetwork.mainnet),
      );
      addTearDown(api.close);
      for (final path in [
        'https://different.invalid/api/tbc/nodeinfo',
        '/api/tbc/broadcast',
        '/api/tbc/nodeinfo?network=testnet',
        '/api/tbc/../nodeinfo',
      ]) {
        await expectLater(api.get(path), throwsStateError);
      }
      api.close();
      await expectLater(api.get('/api/tbc/nodeinfo'), throwsStateError);
    },
  );
}
