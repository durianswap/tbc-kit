import 'configuration.dart';
import 'internal/read_api.dart';
import 'internal/transaction_read.dart';
import 'internal/protocol_codec.dart';

typedef TbcQueryRead = Future<Map<String, dynamic>> Function(String path);

/// Explicitly network-bound. Each method issues exactly one query. API data is
/// trusted-source information, not independent consensus or an arrival proof.
/// Never cache mutable balances, confirmations or UTXO state as spend authority.
final class TbcQueryClient {
  TbcQueryClient({required this.network, TbcQueryRead? read}) {
    if (read == null) {
      _api = TbcReadApi(network);
      _read = _api!.getPublic;
    } else {
      _read = read;
    }
  }
  final TbcNetworkConfiguration network;
  TbcReadApi? _api;
  late final TbcQueryRead _read;
  bool _closed = false;
  Future<Map<String, dynamic>> _get(String path) async {
    if (_closed) throw StateError('Query client closed');
    final result = await _read(path);
    if (_closed) throw StateError('Query client closed');
    return frozen(result) as Map<String, dynamic>;
  }

  String _address(String address) {
    inspectP2pkhAddress(address);
    return address;
  }

  Future<Map<String, dynamic>> nodeInfo() => _get('/api/tbc/nodeinfo');
  Future<Map<String, dynamic>> balanceByAddress(String address) =>
      _get('/api/tbc/balance/address/${_address(address)}');
  Future<Map<String, dynamic>> utxosByAddress(
    String address, {
    int? limit,
    String? after,
    String? target,
  }) {
    final query = <String, String>{};
    if (limit != null) {
      if (limit < 1 || limit > 1000) throw ArgumentError.value(limit, 'limit');
      query['limit'] = '$limit';
    }
    if (after != null) {
      if (after.isEmpty || after.length > 2048)
        throw ArgumentError('Invalid cursor');
      query['after'] = after;
    }
    if (target != null) {
      if (uintString(target) == '0' || target.length > 39)
        throw ArgumentError('Invalid target');
      query['target'] = target;
    }
    final path = '/api/tbc/utxo/address/${_address(address)}';
    return _get(
      query.isEmpty ? path : '$path?${Uri(queryParameters: query).query}',
    );
  }

  Future<Map<String, dynamic>> ftInfo(String contractId) =>
      _get('/api/tbc/ft/info/contract/${hash32(contractId)}');
  Future<Map<String, dynamic>> ftTokenListByAddress(String address) =>
      _get('/api/tbc/ft/tokenlist/address/${_address(address)}');
  Future<Map<String, dynamic>> ftBalanceByAddress(
    String address,
    String contractId,
  ) => _get(
    '/api/tbc/ft/tokenbalance/address/${_address(address)}/contract/${hash32(contractId)}',
  );
  Future<Map<String, dynamic>> stablecoinInfo(String contractId) =>
      _get('/api/tbc/stablecoin/info/stablecoinid/${hash32(contractId)}');
  Future<Map<String, dynamic>> stablecoinListByAddress(String address) =>
      _get('/api/tbc/stablecoin/stablecoinlist/address/${_address(address)}');
  Future<Map<String, dynamic>> stablecoinBalanceByAddress(
    String address,
    String contractId,
  ) => _get(
    '/api/tbc/stablecoin/tokenbalance/address/${_address(address)}/stablecoinid/${hash32(contractId)}',
  );
  Future<Map<String, dynamic>> nftInfo(String nftId) =>
      _get('/api/tbc/nft/nftinfo/nftid/${hash32(nftId)}');
  Future<Map<String, dynamic>> nftCollectionInfo(String collectionId) =>
      _get('/api/tbc/nft/collectioninfo/collectionid/${hash32(collectionId)}');
  Future<Map<String, dynamic>> poolInfo(String poolId) =>
      _get('/api/tbc/pool/poolinfo/poolid/${hash32(poolId)}');
  Future<Map<String, dynamic>> txRaw(String txid) =>
      _get('/api/tbc/txraw/txid/${hash32(txid)}');
  Future<Map<String, dynamic>> decodeTransaction(String txid) =>
      _get('/api/tbc/decode/txid/${hash32(txid)}');

  /// One decode query plus the existing local parser/txid check. Missing
  /// confirmations remain unknown (null), never silently become confirmed.
  Future<Map<String, dynamic>> inspectTransactionById(String txid) async {
    final value = await decodeTransaction(txid);
    need(value['txid'] == txid, 'DECODE_IDENTITY');
    final raw = value['hex'] ?? value['rawTransaction'];
    need(raw is String, 'TX_BYTES');
    return frozen({
          ...inspectTransaction(raw as String, txid),
          'chainId': network.chainId,
          'confirmations':
              value['confirmations'] == null
                  ? null
                  : uintString(value['confirmations']),
        })
        as Map<String, dynamic>;
  }

  void close() {
    _closed = true;
    _api?.close();
  }
}

const tbcAtomicDecimals = 6;
void _decimals(int decimals) {
  if (decimals < 0 || decimals > 18)
    throw ArgumentError.value(decimals, 'decimals');
}

/// Exact decimal conversion. Excess precision is rejected, never rounded.
String parseTbcDisplayAmount(String display, int decimals) {
  _decimals(decimals);
  if (display.length > 1024 ||
      !RegExp(r'^(0|[1-9][0-9]*)(\.[0-9]+)?$').hasMatch(display))
    throw const FormatException('Invalid display amount');
  final parts = display.split('.'),
      fraction = parts.length == 2 ? parts[1] : '';
  if (fraction.length > decimals)
    throw const FormatException('Amount exceeds asset precision');
  return BigInt.parse(
    '${parts.first}${fraction.padRight(decimals, '0')}',
  ).toString();
}

String formatTbcAtomicAmount(String atomic, int decimals) {
  _decimals(decimals);
  if (atomic.length > 1024) throw const FormatException('Amount too large');
  uintString(atomic);
  if (decimals == 0) return atomic;
  final padded = atomic.padLeft(decimals + 1, '0'),
      split = padded.length - decimals;
  final fraction = padded.substring(split).replaceFirst(RegExp(r'0+$'), '');
  return '${padded.substring(0, split)}${fraction.isEmpty ? '' : '.$fraction'}';
}

/// Existing local parser; no HTTP, no consensus/asset receipt claim.
Map<String, dynamic> inspectTbcTransaction(
  String rawTransaction, {
  String? expectedTxid,
}) =>
    frozen(inspectTransaction(rawTransaction, expectedTxid))
        as Map<String, dynamic>;
