import 'dart:async';
import 'package:crypto/crypto.dart';
import 'configuration.dart';
import 'internal/protocol_codec.dart';
import 'internal/read_api.dart';
import 'internal/transaction_read.dart';
import 'internal/txo_status_batches.dart';

typedef TbcCollectionInspector = FutureOr<Map<String, dynamic>> Function(
  String collectionId, String rawTransaction,
);

/// Current mint-slot observations, not reservations or spending authority.
/// The inspector reuses Kit's keyless `inspectTokenMaterial/inspectCollection`.
/// No key, signing, funding, tip query, polling or automatic retry is required.
final class Tbc721Reader {
  Tbc721Reader({required this.network, required this.inspectCollection,
    Future<Map<String, dynamic>> Function(String)? read,
    TxoStatusTransport? status}) {
    if ((read == null) != (status == null)) {
      throw ArgumentError('Custom read and status must share one source');
    }
    if (read == null) {
      _api = TbcReadApi(network);
      _read = _api!.getPublic;
      _status = _api!.txoStatus;
    } else { _read = read; _status = status!; }
  }
  final TbcNetworkConfiguration network;
  final TbcCollectionInspector inspectCollection;
  TbcReadApi? _api;
  late final Future<Map<String, dynamic>> Function(String) _read;
  late final TxoStatusTransport _status;
  final _layouts = <String, Map<String, dynamic>>{};
  final _loads = <String, Future<Map<String, dynamic>>>{};
  final _observations = <String, Future<Map<String, dynamic>>>{};
  bool _closed = false;
  void _open() { if (_closed) throw StateError('NFT reader closed'); }

  Future<Map<String, dynamic>> _load(String id) {
    _open();
    if (_layouts.containsKey(id)) return Future.value(_layouts[id]);
    return _loads.putIfAbsent(id, () => () async {
      try {
        Map<String, dynamic> reply;
        try { reply = await _read('/api/tbc/txraw/txid/$id'); }
        catch (_) { _open(); throw const _Unavailable(); }
        _open();
        final raw = reply['txraw'];
        need(raw is String && raw.isNotEmpty && raw.length <= 2097152 &&
            lowerHexText(raw), 'COLLECTION_BYTES');
        // Local txid verification remains independent of the API response.
        inspectTransaction(raw as String, id);
        final layout = await inspectCollection(id, raw);
        _open();
        final owner = inspectP2pkhAddress(layout['ownerAddress']);
        need(layout['collectionId'] == id &&
          layout['verification'] == 'collection-template' &&
          layout['generation'] == 'shared' && layout['supply'] is int &&
          layout['supply'] >= 1 && layout['supply'] <= 4095 &&
          layout['slotScript'] == '76a914${owner}88ac$mintSuffix',
          'COLLECTION_LAYOUT');
        final result = frozen({'collection': {'collectionId': id,
          'ownerAddress': layout['ownerAddress'], 'supply': layout['supply']},
          'slotScript': layout['slotScript']}) as Map<String, dynamic>;
        // Store only authenticated immutable layout; never mutable slot status.
        if (_layouts.length >= 128) _layouts.remove(_layouts.keys.first);
        _layouts[id] = result;
        return result;
      } finally { _loads.remove(id); }
    }());
  }

  Future<Map<String, dynamic>> getMintStatus({
    required String collectionId, required String address,
  }) {
    _open(); hash32(collectionId);
    final script = '76a914${inspectP2pkhAddress(address)}88ac$mintSuffix';
    final key = '$collectionId:$address';
    return _observations.putIfAbsent(key, () => () async {
      try { return await _observe(collectionId, address, script); }
      finally { _observations.remove(key); }
    }());
  }

  Future<Map<String, dynamic>> _observe(String id, String address, String script) async {
    final base = {'collectionId': id, 'address': address, 'source': 'trusted-api'};
    final scriptHash = hex(sha256.convert(unhex(script)).bytes.reversed.toList());
    // Drain independent reads before returning, including an offline index.
    Object? loadError;
    final results = await Future.wait<Map<String, dynamic>?>([
      _load(id).then<Map<String, dynamic>?>((v) => v,
        onError: (Object e) { loadError = e; return null; }),
      _read('/api/tbc/utxo/scriptpubkeyhash/$scriptHash')
        .then<Map<String, dynamic>?>((v) => v, onError: (_) => null),
    ], eagerError: false);
    _open();
    Map<String, dynamic> own(Map value) => frozen(value) as Map<String, dynamic>;
    if (loadError != null) {
      if (loadError is! _Unavailable) throw loadError!;
      return own({...base, 'status':'unknown', 'reason':'collection-unavailable', 'availableSlots':[]});
    }
    final layout = results[0]!, collection = layout['collection'] as Map;
    if (collection['ownerAddress'] != address) {
      return own({...base, 'status':'not-owner', 'collection': collection});
    }
    final available = <int>{}, spent = <int>{};
    int slot(Map row) {
      final n = BigInt.parse(uintString(row['index']));
      need(row['txid'] == id && n > BigInt.zero &&
        n <= BigInt.from(collection['supply']) && uintString(row['value']) == '100' &&
        (row['scriptPubKey'] == null || row['scriptPubKey'] == script), 'COLLECTION_SLOT');
      return n.toInt();
    }
    final index = results[1];
    if (index != null) {
      final rows = index['utxos'];
      need(rows is List && rows.length <= 10000, 'COLLECTION_INDEX');
      for (final row in rows as List) {
        need(row is Map, 'COLLECTION_INDEX_ROW');
        if (row['txid'] == id) need(available.add(slot(row)), 'COLLECTION_DUPLICATE');
      }
    }
    final missing = [for (var n = 1; n <= collection['supply']; n++) if (!available.contains(n)) n];
    final reply = missing.isEmpty ? <String, dynamic>{'txos':[]} :
      await readTxoStatusBatches(_status, [for (final n in missing) {'txid':id,'index':n}],
        requireComplete:false, tolerateTransportFailure:true);
    _open();
    for (final row in reply['txos']) {
      final n = slot(row); (row['spent'] == true ? spent : available).add(n);
    }
    final slots = available.toList()..sort();
    final unknown = missing.where((n) => !available.contains(n) && !spent.contains(n)).toList();
    return own({...base, 'collection':collection, 'availableSlots': slots,
      if (unknown.isNotEmpty) ...{'status':'unknown', 'unknownSlots': unknown,
        'reason': reply['statusUnavailable'] == true ? 'status-unavailable':'incomplete-status'}
      else ...{'status':slots.isEmpty ? 'exhausted':'available',
        'availableCount': slots.length, 'spentCount':spent.length},
    });
  }

  void close() { _closed = true; _layouts.clear(); _api?.close(); }
  static const mintSuffix = '6a0d5630204d696e74204e486f6c64';
}
final class _Unavailable implements Exception { const _Unavailable(); }
