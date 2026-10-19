// Frozen native HTLC material path; Token HTLC joins this router separately.
// Only non-secret selectors enter this reader. No signing, broadcast, native
// fee-index scan on spend or ancestry recursion. Engine is final authority.
import '../configuration.dart';
import '../host_environment.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show ApiRead;
import 'nft_material.dart' show ApiTxoStatus;
import 'transaction_read.dart';

const htlcProfiles = {'tbc-htlc-lock', 'tbc-htlc-claim', 'tbc-htlc-refund'};

// A private read projection only, never the request passed to Engine/custody.
Map<String, dynamic> htlcMaterialRequest(Map request) {
  final result = copied(request);
  (result['intent'] as Map).remove('preimage');
  return result;
}

Map<String, dynamic> inspectHtlcCode(String script) {
  need(
    RegExp(r'^[0-9a-f]{274}$').hasMatch(script) &&
        script.substring(0, 6) == '63a820' &&
        script.substring(70, 78) == '8876a914' &&
        script.substring(118, 122) == '6704' &&
        script.substring(130, 228) ==
            '8152ba816ea0646e040065cd1da263040065cd1da269a1676d7551686700686956ba01247f778104ffffffff9e6976a914' &&
        script.substring(268) == '6888ac',
    'HTLC_TEMPLATE',
  );
  var lock = 0;
  for (var i = 3; i >= 0; i--)
    lock =
        lock * 256 +
        int.parse(script.substring(122 + i * 2, 124 + i * 2), radix: 16);
  return {
    'hashlock': script.substring(6, 70),
    'receiverHash': script.substring(78, 118),
    'senderHash': script.substring(228, 268),
    'lockTime': lock,
  };
}

final class HtlcMaterialReader {
  HtlcMaterialReader({
    required this.network,
    required this.read,
    required this.status,
    required this.readHistory,
    required this.funding,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final ApiTxoStatus status;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final NativeMaterialReader funding;

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
    final intent = request['intent'];
    need(
      intent is Map &&
          htlcProfiles.contains(intent['type']) &&
          !intent.containsKey('preimage'),
      'HTLC_READ_PROJECTION',
    );
    need(!intent.containsKey('assetStandard'), 'HTLC_TOKEN_MATERIAL_PENDING');
    final floor = BigInt.parse(uintString(minConfirmations));
    if (intent['type'] == 'tbc-htlc-lock')
      return funding.resolve(
        request: request,
        account: account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
    final claim = intent['type'] == 'tbc-htlc-claim',
        points = request['constraints']?['inputOutpoints'];
    need(
      points is List && points.isNotEmpty && points.length <= 128,
      'HTLC_SELECTION',
    );
    final selected = <String>{}, txos = <Map<String, dynamic>>[];
    for (final p in points) {
      need(
        p is Map &&
            p.length == 2 &&
            p['vout'] is int &&
            p['vout'] >= 0 &&
            p['vout'] <= 0xffffffff,
        'HTLC_SELECTION',
      );
      need(
        selected.add('${hash32(p['txid'])}:${p['vout']}'),
        'HTLC_SELECTION_DUPLICATE',
      );
      txos.add({'txid': p['txid'], 'index': p['vout']});
    }
    final replies = await Future.wait([
      !claim || floor > BigInt.zero ? read('/api/tbc/nodeinfo') : Future<Map<String, dynamic>?>.value(null),
      status(txos),
    ]);
    final node = replies[0], height = node == null ? null : BigInt.parse(uintString(node['blocks']));
    need(height == null || height < BigInt.from(500000000), 'HTLC_TIP_HEIGHT');
    if (node != null) hash32(node['bestblockhash']);
    final mtp =
        node?['mediantime'] == null
            ? null
            : BigInt.parse(uintString(node!['mediantime']));
    final observed = replies[1]!['txos'];
    need(
      observed is List && observed.length == points.length,
      'HTLC_STATUS_COUNT',
    );
    final rows = <Map<String, dynamic>>[], seen = <String>{};
    for (final row in observed) {
      need(row is Map, 'HTLC_STATUS_ROW');
      final id = hash32(row['txid']),
          vout = BigInt.parse(uintString(row['index'])),
          value = BigInt.parse(uintString(row['value']));
      final key = '$id:$vout';
      need(
        vout <= BigInt.from(0xffffffff) &&
            value > BigInt.zero &&
            value <= BigInt.from(9007199254740991) &&
            selected.contains(key) &&
            seen.add(key) &&
            row['spent'] == false,
        'HTLC_STATUS_ROW',
      );
      rows.add({
        'txid': id,
        'vout': vout.toInt(),
        'satoshis': '$value',
        if (row['scriptPubKey'] != null) 'scriptPubKey': row['scriptPubKey'],
        if (row['height'] != null)
          'height':
              row['height'] == -1 || row['height'] == '-1'
                  ? '0'
                  : uintString(row['height']),
      });
    }
    final ids = rows.map((r) => r['txid'] as String).toSet(),
        parents = <String, Map<String, dynamic>>{};
    final refresh =
        rows
            .where((r) => r['height'] == null && floor > BigInt.zero)
            .map((r) => r['txid'])
            .toSet();
    await Future.wait(
      ids.map((id) async {
        Map<String, dynamic> parent;
        if (refresh.contains(id)) {
          final data = await read('/api/tbc/decode/txid/$id');
          need(data['txid'] == id && data['hex'] is String, 'HTLC_DECODE_ID');
          parent = {
            ...inspectTransaction(data['hex'], id),
            if (data['confirmations'] != null)
              'confirmations': uintString(data['confirmations']),
          };
        } else {
          parent = await readHistory(id);
        }
        need(parent['txid'] == id, 'HTLC_PARENT_ID');
        parents[id] = parent;
      }),
    );
    bool? refundDomain;
    final utxos = <Map<String, dynamic>>[];
    for (final row in rows) {
      final parent = parents[row['txid']]!,
          outputs = parent['outputs'],
          vout = row['vout'] as int;
      need(
        outputs is List &&
            vout < outputs.length &&
            outputs[vout]['satoshis'] == row['satoshis'] &&
            (row['scriptPubKey'] == null ||
                row['scriptPubKey'] == outputs[vout]['scriptPubKey']),
        'HTLC_OUTPUT',
      );
      final script = outputs[vout]['scriptPubKey'] as String,
          code = inspectHtlcCode(script),
          lock = code['lockTime'] as int;
      need(
        code[claim ? 'receiverHash' : 'senderHash'] ==
            owner['scriptPubKey']!.substring(6, 46),
        'HTLC_ACCOUNT_ROLE',
      );
      if (!claim) {
        final heightDomain = lock < 500000000;
        need(
          lock > 0 &&
              lock <= 0x7fffffff &&
              (refundDomain == null || refundDomain == heightDomain) &&
              (heightDomain
                  ? height != null && BigInt.from(lock) <= height
                  : mtp != null && BigInt.from(lock) < mtp),
          'HTLC_REFUND_MATURITY',
        );
        refundDomain = heightDomain;
      }
      String? count;
      if (row['height'] != null) {
        final at = BigInt.parse(row['height']);
        need(height == null || at <= height, 'HTLC_STATUS_HEIGHT');
        count = at == BigInt.zero ? '0' : height == null ? null : '${height - at + BigInt.one}';
      } else {
        count = parent['confirmations'] as String?;
      }
      need(
        floor == BigInt.zero ||
            (count != null && BigInt.parse(uintString(count)) >= floor),
        'HTLC_CONFIRMATIONS',
      );
      utxos.add({
        'txid': row['txid'],
        'vout': vout,
        'satoshis': row['satoshis'],
        'scriptPubKey': script,
        'classification': 'htlc',
        if (count != null) 'confirmations': uintString(count),
      });
    }
    utxos.sort((a, b) {
      final n = (a['txid'] as String).compareTo(b['txid']);
      return n != 0 ? n : (a['vout'] as int).compareTo(b['vout']);
    });
    final ordered = ids.toList()..sort();
    final payload = <String, dynamic>{
      'version': '1.0',
      'snapshotId': snapshotId,
      'chainId': network.chainId,
      if (node != null) 'block': {
        'height': '$height',
        'hash': node['bestblockhash'],
        if (mtp != null) 'medianTimePast': '$mtp',
      },
      'capturedAt': tbcProtocolTimestamp(now),
      'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 2))),
      'account': account,
      'utxos': utxos,
      'parents': [
        for (final id in ordered)
          {'txid': id, 'rawTransaction': parents[id]!['rawTransaction']},
      ],
      'contracts': <Object>[],
    };
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
