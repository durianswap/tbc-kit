// Token HTLC is one bound operation, not an independent token transfer.
// Only non-secret selectors enter this material router. The frozen Engine
// authenticates Code/Tape identity, the claim proof and every signed output.
import '../configuration.dart';
import 'htlc_material.dart';
import 'native_material.dart';
import 'nft_material.dart' show ApiTxoStatus;
import 'protocol_codec.dart';
import 'stablecoin_material.dart';
import 'tbc20_material.dart';
import 'transaction_read.dart';

final class HtlcTokenMaterialReader {
  HtlcTokenMaterialReader({
    required this.network,
    required this.read,
    required this.status,
    required this.funding,
    required this.tokens,
    required this.stablecoins,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final ApiTxoStatus status;
  final NativeMaterialReader funding;
  final Tbc20MaterialReader tokens;
  final StablecoinMaterialReader stablecoins;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    request = copied(request);
    account = copied(account);
    final owner = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final i = request['intent'];
    need(
      i is Map &&
          htlcProfiles.contains(i['type']) &&
          !i.containsKey('preimage') &&
          ['tbc20-standard', 'tbc20-stablecoin'].contains(i['assetStandard']),
      'HTLC_TOKEN_READ_PROJECTION',
    );
    final coin = i['assetStandard'] == 'tbc20-stablecoin',
        id = hash32(i['contractId']);
    if (i['type'] == 'tbc-htlc-lock')
      return (coin ? stablecoins.resolve : tokens.resolve)(
        request: request,
        account: account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
    final targets = i['targetOutpoints'];
    need(
      targets is List &&
          targets.length == 1 &&
          targets.single is Map &&
          targets.single.length == 2 &&
          targets.single['vout'] == 1,
      'HTLC_TOKEN_TARGET',
    );
    final target = hash32(targets.single['txid']),
        claim = i['type'] == 'tbc-htlc-claim';
    final floor = BigInt.parse(uintString(minConfirmations));
    // Five independent reads start together; funding owns the only tip/index
    // pair. Dynamic status never enters the shared immutable parent cache.
    final observedStatus = status([
      for (final index in [0, 1]) {'txid': target, 'index': index},
    ]);
    observedStatus.ignore();
    final targetParent =
        floor == BigInt.zero
            ? tokens.parent(target)
            : observedStatus.then((s) {
              final rows = s['txos'];
              need(rows is List && rows.length == 2, 'HTLC_TOKEN_STATUS');
              return rows.any((r) => r['height'] == null)
                  ? tokens.confirmedParent(target)
                  : tokens.parent(target);
            });
    final values = await Future.wait<dynamic>([
      funding.resolve(
        request: request,
        account: account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      ),
      observedStatus,
      readIndexedFungible(read, tokens.keyless, id, coin: coin),
      targetParent,
    ]);
    final payload = copied(values[0]['payload']),
        indexed = values[2] as Map,
        parent = values[3] as Map;
    Map? block = payload['block'];
    // Ordinary claims have no deadline; a Coin escrow may separately be locked.
    if (block == null && coin) {
      final asset = tokens.keyless('inspectLopMaterial', {
        'phase': 'inspectAsset',
        'parent': {'txid': target, 'rawTransaction': parent['rawTransaction']}, 'vout': 1,
      });
      if (uintString(asset['lockTime']) != '0') {
        final tip = await read('/api/tbc/nodeinfo');
        block = {'height': uintString(tip['blocks']), 'hash': hash32(tip['bestblockhash']),
          if(tip['mediantime'] != null) 'medianTimePast': uintString(tip['mediantime'])};
        payload['block'] = block;
      }
    }
    final height = block == null ? null : BigInt.parse(uintString(block['height']));
    need(
      (height == null || height < BigInt.from(500000000)) &&
          indexed['identity']['generation'] == 'current' &&
          parent['txid'] == target,
      'HTLC_TOKEN_PARENT',
    );
    final mtp =
        block?['medianTimePast'] == null
            ? null
            : BigInt.parse(uintString(block!['medianTimePast']));
    final rawRows = values[1]['txos'];
    need(rawRows is List && rawRows.length == 2, 'HTLC_TOKEN_STATUS');
    final rows = <Map<String, dynamic>>[], heights = <String>{};
    for (final r in rawRows) {
      need(
        r is Map && r['txid'] == target && r['spent'] == false,
        'HTLC_TOKEN_STATUS',
      );
      final index = uintString(r['index']), amount = uintString(r['value']);
      need(index == '0' || index == '1', 'HTLC_TOKEN_STATUS');
      final h =
          r['height'] == null
              ? null
              : (r['height'] == -1 || r['height'] == '-1'
                  ? '0'
                  : uintString(r['height']));
      if (h != null) {
        need(height == null || BigInt.parse(h) <= height, 'HTLC_TOKEN_HEIGHT');
        heights.add(h);
      }
      rows.add({
        'index': int.parse(index),
        'value': amount,
        if (h != null) 'height': h,
        if (r['scriptPubKey'] != null) 'scriptPubKey': r['scriptPubKey'],
      });
    }
    rows.sort((a, b) => (a['index'] as int).compareTo(b['index']));
    need(
      rows[0]['index'] == 0 && rows[1]['index'] == 1 && heights.length <= 1,
      'HTLC_TOKEN_SIBLINGS',
    );
    final outputs = parent['outputs'] as List;
    need(
      outputs.length >= 3 && outputs[2]['satoshis'] == '0',
      'HTLC_TOKEN_TAPE',
    );
    for (var n = 0; n < 2; n++) {
      final expected = n == 0 ? '100' : '500', r = rows[n], output = outputs[n];
      need(
        r['value'] == expected &&
            output['satoshis'] == expected &&
            (r['scriptPubKey'] == null ||
                r['scriptPubKey'] == output['scriptPubKey']),
        'HTLC_TOKEN_OUTPUT',
      );
    }
    final code = inspectHtlcCode(outputs[0]['scriptPubKey']),
        lock = code['lockTime'] as int;
    need(
      code[claim ? 'receiverHash' : 'senderHash'] ==
          owner['scriptPubKey']!.substring(6, 46),
      'HTLC_TOKEN_ROLE',
    );
    if (!claim)
      need(
        lock > 0 &&
            lock <= 0x7fffffff &&
            (lock < 500000000
                ? height != null && BigInt.from(lock) <= height
                : mtp != null && BigInt.from(lock) < mtp),
        'HTLC_TOKEN_MATURITY',
      );
    Map<String, dynamic>? fresh;
    if (floor > BigInt.zero && rows.any((r) => r['height'] == null)) {
      fresh = Map<String, dynamic>.from(parent);
      need(fresh['confirmations'] != null, 'HTLC_TOKEN_FRESH_PARENT');
    }
    final asset = <Map<String, dynamic>>[];
    for (var n = 0; n < 2; n++) {
      final row = rows[n], h = row['height'] as String?;
      final count =
          h == null
              ? (fresh?['confirmations'] as String?)
              : h == '0'
              ? '0'
              : height == null ? null : '${height - BigInt.parse(h) + BigInt.one}';
      need(
        floor == BigInt.zero || (count != null && BigInt.parse(count) >= floor),
        'HTLC_TOKEN_CONFIRMATIONS',
      );
      asset.add({
        'txid': target,
        'vout': n,
        'satoshis': row['value'],
        'scriptPubKey': outputs[n]['scriptPubKey'],
        'classification':
            n == 0
                ? 'htlc'
                : coin
                ? 'stablecoin'
                : 'ft',
        if (n == 1) 'contractId': id,
        if (count != null) 'confirmations': count,
      });
    }
    final parents = <String, Map>{target: parent},
        refs = <String>{...tbc20References(parent, 1)};
    refs.removeWhere(parents.containsKey);
    for (final p in await Future.wait(refs.map(tokens.parent)))
      parents[p['txid']] = p;
    final utxos = [...payload['utxos'] as List, ...asset];
    need(
      utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
          utxos.length,
      'HTLC_TOKEN_DUPLICATE',
    );
    payload['utxos'] = utxos;
    payload['parents'] = [
      for (final p in parents.values)
        {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
    ];
    payload['contracts'] = [
      {
        'contractId': id,
        'indexedFungible': indexed['indexedFungible'],
        'family': coin ? 'stablecoin' : 'ft',
        'protocolVersion': coin ? 'coin' : 'tbc20',
        'standardId': i['assetStandard'],
        'templateRevision': coin ? coinTemplateRevision : tbc20TemplateRevision,
        'creationTxid': id,
        'genesisOutpoint': {'txid': id, 'vout': 0},
        'currentOutpoint': {'txid': target, 'vout': 1},
      },
    ];
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
