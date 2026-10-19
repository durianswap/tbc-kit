// Frozen height-profile PiggyBank material routing. Unlock reads only selected
// deposits and unique direct parents; no fee index or ancestry walk. This is
// not a script VM: the unchanged Engine authenticates the final bound plan.
import '../configuration.dart';
import '../host_environment.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show ApiRead;
import 'transaction_read.dart';

const timelockProfiles = {'tbc-timelock-lock', 'tbc-timelock-unlock'};

/// Exact public height-lock view shared by material selection and review.
/// It is not a VM or a chain-maturity assertion.
Map<String, dynamic> inspectTimelockCode(String script) {
  need(
    RegExp(r'^[0-9a-f]{106}$').hasMatch(script) &&
        script.startsWith('76a914') &&
        script.substring(46, 84) == '88ad56ba01247f778104ffffffff819e518804' &&
        script.substring(92) == '8152ba81a15187',
    'TIMELOCK_TEMPLATE',
  );
  var lock = 0;
  for (var i = 3; i >= 0; i--)
    lock =
        lock * 256 +
        int.parse(script.substring(84 + i * 2, 86 + i * 2), radix: 16);
  need(lock < 500000000, 'TIMELOCK_OWNER_MATURITY');
  return {'ownerHash': script.substring(6, 46), 'lockHeight': lock};
}

final class TimelockMaterialReader {
  TimelockMaterialReader({
    required this.network,
    required this.read,
    required this.readHistory,
    required this.funding,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final NativeMaterialReader funding;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    // The caller cannot retarget a selection during an asynchronous index read.
    request = copied(request);
    account = copied(account);
    final owner = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    need(
      timelockProfiles.contains(request['intent']?['type']),
      'TIMELOCK_PROFILE',
    );
    final floor = BigInt.parse(uintString(minConfirmations));
    if (request['intent']['type'] == 'tbc-timelock-lock') {
      return funding.resolve(
        request: request,
        account: account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
    }
    final points = request['constraints']?['inputOutpoints'];
    need(
      points is List && points.isNotEmpty && points.length <= 128,
      'TIMELOCK_SELECTION',
    );
    final selected = <String>{};
    for (final p in points) {
      need(
        p is Map &&
            p.length == 2 &&
            p['vout'] is int &&
            p['vout'] >= 0 &&
            p['vout'] <= 0xffffffff,
        'TIMELOCK_SELECTION',
      );
      need(
        selected.add('${hash32(p['txid'])}:${p['vout']}'),
        'TIMELOCK_DUPLICATE_SELECTION',
      );
    }
    final responses = await Future.wait([
      read('/api/tbc/nodeinfo'),
      read('/api/tbc/frozenUtxo/address/${account['address']}/piggyBank'),
    ]);
    final node = responses[0],
        height = BigInt.parse(uintString(node['blocks']));
    need(height < BigInt.from(500000000), 'TIMELOCK_HEIGHT_DOMAIN');
    hash32(node['bestblockhash']);
    final index = responses[1]['utxos'];
    need(index is List && index.length <= 10000, 'TIMELOCK_INDEX_BOUND');
    final rows = <Map<String, dynamic>>[], seen = <String>{};
    for (final row in index) {
      need(row is Map, 'TIMELOCK_INDEX_ROW');
      final id = hash32(row['txid']),
          vout = BigInt.parse(uintString(row['index'])),
          value = BigInt.parse(uintString(row['value']));
      need(
        vout <= BigInt.from(0xffffffff) &&
            value > BigInt.zero &&
            value <= BigInt.from(9007199254740991),
        'TIMELOCK_INDEX_ROW',
      );
      final key = '$id:$vout';
      need(seen.add(key), 'TIMELOCK_INDEX_DUPLICATE');
      if (selected.contains(key))
        rows.add({
          'txid': id,
          'vout': vout.toInt(),
          'satoshis': '$value',
          if (row['height'] != null)
            'height':
                row['height'] == -1 || row['height'] == '-1'
                    ? '0'
                    : uintString(row['height']),
        });
    }
    need(rows.length == selected.length, 'TIMELOCK_UNAVAILABLE');
    final ids = rows.map((r) => r['txid'] as String).toSet(),
        parents = <String, Map<String, dynamic>>{};
    // One fresh decode per parent only if a positive floor needs unknown
    // confirmation data. Immutable raw bytes never attest fresh confirmations.
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
          need(
            data['txid'] == id && data['hex'] is String,
            'TIMELOCK_DECODE_ID',
          );
          parent = {
            ...inspectTransaction(data['hex'], id),
            if (data['confirmations'] != null)
              'confirmations': uintString(data['confirmations']),
          };
        } else {
          parent = await readHistory(id);
        }
        need(parent['txid'] == id, 'TIMELOCK_PARENT_ID');
        parents[id] = parent;
      }),
    );
    final utxos = <Map<String, dynamic>>[];
    for (final row in rows) {
      final parent = parents[row['txid']]!, outputs = parent['outputs'];
      final vout = row['vout'] as int;
      need(
        outputs is List &&
            vout < outputs.length &&
            outputs[vout]['satoshis'] == row['satoshis'],
        'TIMELOCK_OUTPUT',
      );
      final script = outputs[vout]['scriptPubKey'];
      need(script is String, 'TIMELOCK_TEMPLATE');
      final code = inspectTimelockCode(script),
          lock = code['lockHeight'] as int;
      need(
        BigInt.from(lock) <= height &&
            code['ownerHash'] == owner['scriptPubKey']!.substring(6, 46),
        'TIMELOCK_OWNER_MATURITY',
      );
      String? count;
      if (row['height'] != null) {
        final at = BigInt.parse(row['height']);
        need(at <= height, 'TIMELOCK_INDEX_HEIGHT');
        count = at == BigInt.zero ? '0' : '${height - at + BigInt.one}';
      } else {
        count = parent['confirmations'] as String?;
      }
      need(
        floor == BigInt.zero ||
            (count != null && BigInt.parse(uintString(count)) >= floor),
        'TIMELOCK_CONFIRMATIONS',
      );
      utxos.add({
        'txid': row['txid'],
        'vout': vout,
        'satoshis': row['satoshis'],
        'scriptPubKey': script,
        'classification': 'timelock',
        if (count != null) 'confirmations': uintString(count),
      });
    }
    utxos.sort((a, b) {
      final id = (a['txid'] as String).compareTo(b['txid']);
      return id != 0 ? id : (a['vout'] as int).compareTo(b['vout']);
    });
    final ordered = ids.toList()..sort();
    final payload = <String, dynamic>{
      'version': '1.0',
      'snapshotId': snapshotId,
      'chainId': network.chainId,
      'block': {'height': '$height', 'hash': node['bestblockhash']},
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
