// Frozen Kit NFT holder read plan, not a builder or an authorization source.
// Shares the wallet/network immutable parent cache with other asset families.
import 'package:crypto/crypto.dart';
import '../configuration.dart';
import '../host_environment.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'utxo_pages.dart';
import 'tbc20_material.dart';

typedef ApiTxoStatus =
    Future<Map<String, dynamic>> Function(List<Map<String, dynamic>> txos);
const tbc721TemplateRevision =
    'a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104';
const _holdSuffix = '6a0d56302043757272204e486f6c64';

final class NftMaterialReader {
  NftMaterialReader({
    required this.network,
    required this.read,
    required this.status,
    required this.readHistory,
    this.rememberParent,
    required this.keyless,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final ApiTxoStatus status;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final void Function(Map<String, dynamic>)? rememberParent;
  final KeylessCall keyless;
  final Map<String, bool> _origins = {};

  // Same rc.16 composition as the JS material router: reuse authenticated
  // single-NFT readers, with one operation-owned read scope. The Engine owns
  // dependent funding/change and every transaction; this is not a new builder.
  Future<Map<String, dynamic>> _batch({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    required String minConfirmations,
  }) async {
    request = copied(request);
    account = copied(account);
    final items = request['intent']['transfers'];
    need(
      items is List && items.isNotEmpty && items.length <= 100,
      'NFT_BATCH_BOUND',
    );
    final ids = <String>{};
    for (final item in items) {
      need(
        item is Map && ids.add(hash32(item['contractId'])),
        'NFT_BATCH_IDENTITY',
      );
      need(
        item.keys.every({'contractId', 'to', 'payment'}.contains),
        'NFT_BATCH_FIELDS',
      );
      inspectP2pkhAddress(item['to']);
    }
    final reads = <String, Future<Map<String, dynamic>>>{};
    final histories = <String, Future<Map<String, dynamic>>>{};
    final scoped = NftMaterialReader(
      network: network,
      read: (p) => reads.putIfAbsent(p, () => read(p)),
      status: status,
      readHistory: (id) => histories.putIfAbsent(id, () => readHistory(id)),
      rememberParent: rememberParent,
      keyless: keyless,
    );
    final results = await Future.wait<Map<String, dynamic>>([
      for (final item in items)
        scoped.resolve(
          request: {
            ...request,
            'intent': {
              'version': request['intent']['version'],
              'type': 'tbc721.transfer',
              'contractId': item['contractId'],
              'to': item['to'],
              if (item['payment'] != null) 'payment': copied(item['payment']),
            },
          },
          account: account,
          now: now,
          snapshotId: snapshotId,
          minConfirmations: minConfirmations,
        ),
    ], eagerError: false);
    final utxos = <String, Map>{},
        parents = <String, Map>{},
        contracts = <String, Map>{};
    void merge(Map<String, Map> into, String key, Map item) {
      need(
        !into.containsKey(key) || canonical(into[key]) == canonical(item),
        'NFT_BATCH_CONFLICT',
      );
      into[key] = item;
    }

    final first = results.first['payload'] as Map;
    for (var n = 0; n < results.length; n++) {
      final p = results[n]['payload'] as Map;
      need(
        canonical(p['account']) == canonical(first['account']) &&
            canonical(p['block']) == canonical(first['block']) &&
            p['capturedAt'] == first['capturedAt'] &&
            p['expiresAt'] == first['expiresAt'],
        'NFT_BATCH_CONTEXT',
      );
      for (final u in p['utxos']) merge(utxos, '${u['txid']}:${u['vout']}', u);
      for (final r in p['parents']) merge(parents, r['txid'], r);
      for (final c in p['contracts']) {
        need(c['contractId'] == items[n]['contractId'], 'NFT_BATCH_CONTRACT');
        merge(contracts, c['contractId'], c);
      }
    }
    need(
      contracts.length == items.length &&
          utxos.length <= 128 + 2 * items.length &&
          parents.length <= 10000,
      'NFT_BATCH_MATERIAL_BOUND',
    );
    final payload = <String, dynamic>{
      ...first,
      'utxos': utxos.values.toList(),
      'parents': parents.values.toList(),
      'contracts': contracts.values.toList(),
    };
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    if (request['intent']?['type'] == 'tbc721.batchTransfer') {
      return _batch(
        request: request,
        account: account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
    }
    final owner = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(intent is Map && intent['type'] == 'tbc721.transfer', 'NFT_PROFILE');
    final id = hash32(intent['contractId']),
        floor = BigInt.parse(uintString(minConfirmations));
    final requested =
        (request['constraints'] as Map?)?['inputOutpoints'] as List?;
    if (requested != null) {
      need(requested.isNotEmpty && requested.length <= 128, 'REQUESTED_INPUTS');
      final seen = <String>{};
      for (final p in requested) {
        need(
          p is Map &&
              p.length == 2 &&
              p['vout'] is int &&
              p['vout'] >= 0 &&
              p['vout'] <= 0xffffffff,
          'REQUESTED_INPUTS',
        );
        need(seen.add('${hash32(p['txid'])}:${p['vout']}'), 'REQUESTED_INPUTS');
      }
    }
    final tipRead =
            floor > BigInt.zero
                ? read('/api/tbc/nodeinfo')
                : Future<Map<String, dynamic>?>.value(null),
        nativeRead = collectUtxoPages(
          read,
          '/api/tbc/utxo/address/${account['address']}',
          maxRows: 256,
        ),
        originRead = readHistory(id);
    for (final f in [tipRead, nativeRead, originRead]) {
      f.ignore();
    }
    try {
      final mint = await originRead;
      if (!_origins.containsKey(id)) {
        final hint = keyless('inspectTokenMaterial', {
          'phase': 'identifyNftOrigin',
          'contractId': id,
          'rawTransaction': mint['rawTransaction'],
        });
        need(
          hint.length == 4 &&
              hint['family'] == 'tbc721' &&
              ['current', 'historical'].contains(hint['generation']) &&
              hint['verification'] == 'origin-template' &&
              hint['assetIdentityVerified'] == false,
          'NFT_ORIGIN',
        );
        if (_origins.length >= 256) _origins.remove(_origins.keys.first);
        _origins[id] = hint['generation'] == 'current';
      }
      final current = _origins[id]!;
      need(
        current || (intent['payment'] == null && requested == null),
        'HISTORICAL_NFT_PARAMETERS',
      );
      final parents = <String, Map>{id: mint};
      Future<Map<String, dynamic>> keep(String id) async {
        final p = await readHistory(id);
        parents[id] = p;
        return p;
      }

      final inputs = mint['inputs'] as List, outputs = mint['outputs'] as List;
      need(
        inputs.isNotEmpty &&
            inputs[0]['vout'] != 0 &&
            outputs.length >= 3 &&
            outputs[0]['satoshis'] == '200',
        'NFT_MINT_TOPOLOGY',
      );
      final origin = hash32(inputs[0]['txid']),
          code = outputs[0]['scriptPubKey'] as String;
      final scriptHash = hex(
        sha256.convert(unhex(code)).bytes.reversed.toList(),
      );
      final listFuture = read('/api/tbc/nft/utxo/scriptpubkeyhash/$scriptHash');
      final rows = (await listFuture)['utxos'];
      need(rows is List && rows.length == 1 && rows[0] is Map, 'NFT_INDEX');
      final row = rows[0] as Map;
      Object? alias(String a, String b) {
        final x = row[a], y = row[b];
        need(
          x == null || y == null || canonical(x) == canonical(y),
          'NFT_INDEX_ALIAS',
        );
        return x ?? y;
      }

      final at = hash32(row['txid']),
          index = uintString(alias('index', 'vout')),
          nftId = alias('nft_id', 'nft_contract_id');
      alias('scriptPubKey', 'script_pubkey');
      need(
        index == '0' &&
            (nftId == null || nftId == id) &&
            (row['collection_id'] == null || row['collection_id'] == origin),
        'NFT_INDEX_IDENTITY',
      );
      // A zero floor keeps unknown distinct from zero and never queries decode.
      Future<Map<String, dynamic>>? freshParent;
      final confirmation = () async {
        final height = row['height'];
        if (height == null) {
          if (floor == BigInt.zero) return null;
          freshParent = readConfirmedTransaction(
            read,
            at,
            remember: rememberParent,
          );
          return (await freshParent!)['confirmations'] as String;
        }
        final observedTip = await tipRead;
        final h =
            height == '-1' || height == -1
                ? BigInt.zero
                : BigInt.parse(uintString(height));
        if (observedTip == null) return h == BigInt.zero ? '0' : null;
        final tip = BigInt.parse(uintString(observedTip['blocks']));
        need(h <= tip, 'FUTURE_NFT');
        return h == BigInt.zero ? '0' : '${tip - h + BigInt.one}';
      }();
      final values = await Future.wait<dynamic>([
        freshParent == null
            ? keep(at)
            : freshParent!.then((p) {
              parents[at] = p;
              return p;
            }),
        Future<void>.value(),
        confirmation,
        tipRead,
        nativeRead,
      ]);
      final tx = values[0] as Map,
          count = values[2] as String?,
          tip = values[3] as Map?;
      final height =
          tip == null ? null : BigInt.parse(uintString(tip['blocks']));
      if (tip != null) hash32(tip['bestblockhash']);
      final txOutputs = tx['outputs'] as List;
      need(txOutputs.length >= 3, 'NFT_OUTPUTS');
      final hold = txOutputs[1] as Map;
      // Match SDK construction: the configured NFT index supplies currentness.
      // Still validate paired Hold ownership/value from the verified raw bytes.
      need(
        hold['satoshis'] == '100' &&
            hold['scriptPubKey'] == '${owner['scriptPubKey']}$_holdSuffix',
        'NFT_HOLD_AUTHORITY',
      );
      void identity(Map t) {
        final out = t['outputs'] as List;
        need(
          out.length >= 3 &&
              out[0]['scriptPubKey'] == code &&
              out[2]['scriptPubKey'] == outputs[2]['scriptPubKey'],
          'NFT_IMMUTABLE_IDENTITY',
        );
      }

      String ancestor(Map t) {
        final ins = t['inputs'] as List;
        need(
          ins.length >= 2 &&
              ins[0]['txid'] == ins[1]['txid'] &&
              ins[0]['vout'] == 0 &&
              ins[1]['vout'] == 1,
          'NFT_DESCENDANT_PAIR',
        );
        return hash32(ins[0]['txid']);
      }

      identity(tx);
      if (current) {
        final ins = tx['inputs'] as List;
        need(ins.isNotEmpty, 'NFT_PARENT');
        await keep(at == id ? hash32(ins[0]['txid']) : ancestor(tx));
      } else {
        identity(mint);
        if (at != id)
          identity(await keep(ancestor(tx)));
        else
          await keep(
            origin,
          ); // Mint's direct unlocking predecessor, not a history audit.
      }
      final raw = values[4]['utxos'];
      need(
        raw is List && raw.isNotEmpty && raw.length <= 256,
        'NATIVE_CANDIDATE_BOUND',
      );
      final seen = <String>{}, native = <Map<String, dynamic>>[];
      for (final n in raw) {
        need(n is Map, 'UTXO_ROW');
        final txid = hash32(n['txid']),
            v = BigInt.parse(uintString(n['index'])),
            value = uintString(n['value']);
        final h =
            n['height'] == -1 || n['height'] == '-1'
                ? BigInt.zero
                : BigInt.parse(uintString(n['height']));
        need(
          v <= BigInt.from(0xffffffff) &&
              value != '0' &&
              (height == null || h <= height) &&
              seen.add('$txid:$v'),
          'NATIVE_DESCRIPTOR',
        );
        if (requested != null &&
            !requested.any((p) => p['txid'] == txid && p['vout'] == v.toInt()))
          continue;
        native.add({
          'txid': txid,
          'vout': v.toInt(),
          'satoshis': value,
          'scriptPubKey': owner['scriptPubKey'],
          if (height != null || h == BigInt.zero)
            'confirmations':
                h == BigInt.zero ? '0' : '${height! - h + BigInt.one}',
          'classification': 'native',
        });
      }
      need(native.isNotEmpty, 'NATIVE_FUNDING');
      native.sort((a, b) {
        final c = (a['txid'] as String).compareTo(b['txid']);
        return c != 0 ? c : (a['vout'] as int).compareTo(b['vout']);
      });
      final utxos = [
        ...native,
        for (var i = 0; i < 2; i++)
          {
            'txid': at,
            'vout': i,
            'satoshis': txOutputs[i]['satoshis'],
            'scriptPubKey': txOutputs[i]['scriptPubKey'],
            'classification': 'nft',
            'contractId': id,
            if (count != null) 'confirmations': count,
          },
      ];
      need(utxos.length <= 128, 'SNAPSHOT_INPUT_BOUND');
      need(
        utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
            utxos.length,
        'SNAPSHOT_DUPLICATE_INPUT',
      );
      final payload = <String, dynamic>{
        'version': '1.0',
        'snapshotId': snapshotId,
        'chainId': network.chainId,
        if (tip != null)
          'block': {'height': '$height', 'hash': tip['bestblockhash']},
        'capturedAt': tbcProtocolTimestamp(now),
        'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 2))),
        'account': account,
        'utxos': utxos,
        'parents': [
          for (final p in parents.values)
            {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
        ],
        'contracts': [
          {
            'contractId': id,
            'family': 'nft',
            'protocolVersion': current ? 'tbc721' : '2.0',
            if (current) 'standardId': 'tbc721-standard',
            if (current) 'templateRevision': tbc721TemplateRevision,
            if (current) 'genesisOutpoint': {'txid': id, 'vout': 0},
            'creationTxid': id,
            'currentOutpoint': {'txid': at, 'vout': 0},
          },
        ],
      };
      return {'payload': payload, 'snapshotHash': hashJson(payload)};
    } finally {
      await Future.wait(
        [tipRead, nativeRead, originRead].map((f) async {
          try {
            await f;
          } catch (_) {}
        }),
      );
    }
  }
}
