import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';

const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
void main() {
  test('exact amount conversion matches JS limits and rejects rounding', () {
    for (final decimals in [0, 6, 8, 18]) {
      for (final value in ['0', '1', '900719925474099312345678']) {
        expect(parseTbcDisplayAmount(formatTbcAtomicAmount(value, decimals), decimals), value);
      }
    }
    expect(parseTbcDisplayAmount('1.000001', 6), '1000001');
    for (final value in ['01', '-1', '1e3', '1.', ' 1', '1.0000001']) {
      expect(() => parseTbcDisplayAmount(value, 6), throwsFormatException);
    }
    expect(() => formatTbcAtomicAmount('1', 19), throwsArgumentError);
  });
  test('query facade performs one explicit read and never refreshes or retries', () async {
    final paths = <String>[];
    final api = TbcQueryClient(network: TbcNetworkConfiguration.official(TbcNetwork.testnet), read: (path) async {
      paths.add(path); return {'value': 1.5, 'list': [1]};
    });
    expect(paths, isEmpty);
    final id = 'ab' * 32;
    final calls = [
      () => api.nodeInfo(), () => api.balanceByAddress(address),
      () => api.utxosByAddress(address, limit: 1, after: 'a/b+c', target: '1'),
      () => api.ftInfo(id), () => api.ftTokenListByAddress(address),
      () => api.ftBalanceByAddress(address, id), () => api.stablecoinInfo(id),
      () => api.stablecoinListByAddress(address), () => api.stablecoinBalanceByAddress(address, id),
      () => api.nftInfo(id), () => api.nftCollectionInfo(id), () => api.poolInfo(id),
      () => api.txRaw(id), () => api.decodeTransaction(id),
    ];
    for (final call in calls) {
      final before = paths.length, value = await call();
      expect(paths.length, before + 1); expect(value['value'], 1.5);
      expect(() => value['extra'] = 1, throwsUnsupportedError);
    }
    final q = Uri.parse(paths[2]).queryParameters;
    expect(q, {'limit': '1', 'after': 'a/b+c', 'target': '1'});
    final before = paths.length;
    expect(() => api.ftInfo('../bad'), throwsStateError);
    expect(() => api.utxosByAddress(address, limit: 1001), throwsArgumentError);
    expect(paths.length, before);
    api.close(); await expectLater(api.nodeInfo(), throwsStateError);
  });
  test('decode identity mismatch is rejected with no second raw download', () async {
    var reads = 0;
    final api = TbcQueryClient(network: TbcNetworkConfiguration.official(TbcNetwork.mainnet), read: (_) async { reads++; return {'txid': '00' * 32}; });
    await expectLater(api.inspectTransactionById('ab' * 32), throwsStateError);
    expect(reads, 1); api.close();
  });
}
