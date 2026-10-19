// Frozen current-NFT mint read plan. No transaction construction or signing.
// Funding and immutable history are shared with other asset readers.
import 'package:crypto/crypto.dart';
import '../configuration.dart';
import 'native_material.dart';
import 'nft_material.dart' show ApiTxoStatus, tbc721TemplateRevision;
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show ApiRead;

final class CollectionMaterialReader {
  CollectionMaterialReader({
    required this.network,
    required this.read,
    required this.status,
    required this.readHistory,
    this.rememberParent,
    required this.funding,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final ApiTxoStatus status;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final void Function(Map<String, dynamic>)? rememberParent;
  final NativeMaterialReader funding;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    final owner = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(
      intent is Map &&
          [
            'tbc721-standard-mint',
            'tbc721-standard-batch-mint',
          ].contains(intent['type']),
      'COLLECTION_PROFILE',
    );
    final id = hash32(intent['collectionId']),
        floor = BigInt.parse(uintString(minConfirmations));
    final items =
        intent['type'] == 'tbc721-standard-mint' ? [intent] : intent['items'];
    need(
      items is List && items.isNotEmpty && items.length <= 32,
      'COLLECTION_SLOT_BOUND',
    );
    final slots = <int>[];
    for (final item in items) {
      need(
        item is Map &&
            item['slot'] is int &&
            item['slot'] > 0 &&
            item['slot'] <= 0xffffffff,
        'COLLECTION_SLOT',
      );
      slots.add(item['slot']);
    }
    need(slots.toSet().length == slots.length, 'DUPLICATE_COLLECTION_SLOT');
    final script = '${owner['scriptPubKey']}6a0d5630204d696e74204e486f6c64';
    final scriptHash = hex(
      sha256.convert(unhex(script)).bytes.reversed.toList(),
    );
    final native = funding.resolve(
      request: request,
      account: account,
      now: now,
      snapshotId: snapshotId,
      minConfirmations: minConfirmations,
    );
    final indexed = read('/api/tbc/utxo/scriptpubkeyhash/$scriptHash');
    final creation =
        floor == BigInt.zero
            ? readHistory(id)
            : indexed.then((result) {
              final rows = result['utxos'];
              need(rows is List, 'COLLECTION_INDEX_BOUND');
              final selected = rows.where(
                (r) =>
                    r is Map &&
                    r['txid'] == id &&
                    slots.contains(int.tryParse('${r['index'] ?? r['vout']}')),
              );
              return selected.isEmpty ||
                      selected.any((r) => r['height'] == null)
                  ? readConfirmedTransaction(read, id, remember: rememberParent)
                  : readHistory(id);
            });
    for (final future in [native, creation, indexed]) {
      future.ignore();
    }
    final values = await Future.wait([native, creation, indexed]);
    final snapshot = values[0], parent = values[1], rows = values[2]['utxos'];
    final payload = copied(snapshot['payload']),
        outputs = parent['outputs'] as List;
    need(rows is List && rows.length <= 10000, 'COLLECTION_INDEX_BOUND');
    final bySlot = <int, Map>{};
    for (final row in rows) {
      need(row is Map, 'COLLECTION_INDEX_ROW');
      if (row['txid'] != id) continue;
      final index = BigInt.parse(uintString(row['index'] ?? row['vout']));
      need(
        index <= BigInt.from(0xffffffff) && !bySlot.containsKey(index.toInt()),
        'COLLECTION_INDEX_SLOT',
      );
      need(
        row['index'] == null ||
            row['vout'] == null ||
            uintString(row['index']) == uintString(row['vout']),
        'COLLECTION_INDEX_ALIAS',
      );
      bySlot[index.toInt()] = row;
    }
    for (final slot in slots) {
      need(
        slot < outputs.length &&
            outputs[slot]['scriptPubKey'] == script &&
            outputs[slot]['satoshis'] == '100',
        'COLLECTION_SLOT_AUTHORITY',
      );
    }
    final missing = slots.where((s) => !bySlot.containsKey(s)).toList();
    if (missing.isNotEmpty) {
      final reply = await status([
        for (final s in missing) {'txid': id, 'index': s},
      ]);
      final canonicalStatus = reply['txos'] is List;
      final rows = canonicalStatus ? reply['txos'] : reply['results'];
      need(
        rows is List && rows.length == missing.length,
        'COLLECTION_STATUS_BOUND',
      );
      final seen = <int>{};
      for (final row in rows) {
        need(row is Map, 'COLLECTION_STATUS_ROW');
        final slot = BigInt.parse(uintString(row['index']));
        need(
          slot <= BigInt.from(0xffffffff) &&
              missing.contains(slot.toInt()) &&
              seen.add(slot.toInt()),
          'COLLECTION_STATUS_SLOT',
        );
        final observedScript =
            canonicalStatus ? row['scriptPubKey'] : row['scriptpubkey'];
        need(
          row['txid'] == id &&
              uintString(row['value']) == '100' &&
              (canonicalStatus ? row['spent'] : row['status']?['spent']) ==
                  false &&
              (observedScript == null || observedScript == script),
          'COLLECTION_STATUS_AUTHORITY',
        );
        bySlot[slot.toInt()] = row;
      }
    }
    final height = payload['block'] == null ? null : BigInt.parse(payload['block']['height']);
    Future<String>? decodedConfirmation;
    Future<String?> confirmation(Map row) async {
      if (row['height'] == null) {
        if (floor == BigInt.zero) return null;
        // Only explicit nonzero confirmation policy requires an observation.
        decodedConfirmation ??= () async {
          final d =
              parent['confirmations'] != null
                  ? parent
                  : await readConfirmedTransaction(
                    read,
                    id,
                    remember: rememberParent,
                  );
          return uintString(d['confirmations']);
        }();
        return decodedConfirmation!;
      }
      final h =
          row['height'] == -1 || row['height'] == '-1'
              ? BigInt.zero
              : BigInt.parse(uintString(row['height']));
      need(height == null || h <= height, 'FUTURE_COLLECTION');
      return h == BigInt.zero ? '0' : height == null ? null : '${height - h + BigInt.one}';
    }

    final assets = await Future.wait(
      slots.map((slot) async {
        final row = bySlot[slot]!;
        need(uintString(row['value']) == '100', 'COLLECTION_INDEX_AMOUNT');
        final count = await confirmation(row);
        return {
          'txid': id,
          'vout': slot,
          'satoshis': '100',
          'scriptPubKey': script,
          'classification': 'collection-slot',
          'contractId': id,
          if (count != null) 'confirmations': count,
        };
      }),
    );
    final utxos = [...payload['utxos'] as List, ...assets];
    need(
      utxos.length <= 128 &&
          utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
              utxos.length,
      'COLLECTION_INPUT_BOUND',
    );
    payload['utxos'] = utxos;
    payload['parents'] = [
      {'txid': id, 'rawTransaction': parent['rawTransaction']},
    ];
    payload['contracts'] = [
      {
        'contractId': id,
        'family': 'collection',
        'protocolVersion': 'tbc721',
        'standardId': 'tbc721-standard',
        'templateRevision': tbc721TemplateRevision,
        'genesisOutpoint': {'txid': id, 'vout': 0},
        'creationTxid': id,
        'currentOutpoint': {'txid': id, 'vout': slots.first},
      },
    ];
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
