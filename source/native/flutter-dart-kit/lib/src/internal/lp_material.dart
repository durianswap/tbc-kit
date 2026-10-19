// LP holder read plan from the frozen Kit. No current reserve query, native
// fee-parent read, recursive ancestry, signature or mutable-state caching.
import '../configuration.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;
import 'transaction_read.dart';
import 'utxo_pages.dart';

const lpProfiles = {
  'tbc20-lp-transfer',
  'tbc20-lp-merge',
  'tbc20-lp-lock',
  'tbc20-lp-unlock',
};

// Same canonical aliases as Kit's official LP REST codec. Values are integers
// in atomic units; conflicting aliases fail rather than choosing one silently.
String lpIndexAmount(Map row, {bool native = false}) {
  final names =
      native
          ? ['tbc_value', 'value', 'tbc_balance']
          : ['ft_value', 'balance', 'lp_balance'];
  final values = [
    for (final name in names)
      if (row[name] != null) uintString(row[name]),
  ];
  need(
    values.isNotEmpty && values.every((v) => v == values.first),
    'LP_INDEX_AMOUNT',
  );
  return values.first;
}

final class LpMaterialReader {
  LpMaterialReader({
    required this.network,
    required this.read,
    required this.readHistory,
    this.rememberParent,
    required this.funding,
    required this.keyless,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final void Function(Map<String, dynamic>)? rememberParent;
  final NativeMaterialReader funding;
  final KeylessCall keyless;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(intent is Map && lpProfiles.contains(intent['type']), 'LP_PROFILE');
    final id = hash32(intent['poolContractId']),
        floor = BigInt.parse(uintString(minConfirmations));
    final all = ['tbc20-lp-merge', 'tbc20-lp-unlock'].contains(intent['type']);
    final wanted = BigInt.parse(uintString(intent['amount'] ?? '0'));
    need(all || wanted > BigInt.zero, 'LP_AMOUNT');
    final points = request['constraints']?['inputOutpoints'] as List?;
    final parents = <String, Map<String, dynamic>>{},
        decoded = <String, Future<Map<String, dynamic>>>{};
    Map<String, dynamic> keep(Map<String, dynamic> tx) {
      parents[tx['txid']] = tx;
      return tx;
    }

    Map<String, dynamic> raw(Map tx) => {
      'txid': tx['txid'],
      'rawTransaction': tx['rawTransaction'],
    };
    Map<String, dynamic> inspect(Map<String, dynamic> value) =>
        keyless('inspectAmmMaterial', value);
    Future<Map<String, dynamic>> parent(String txid) async =>
        decoded.containsKey(txid)
            ? await decoded[txid]!
            : await readHistory(txid);
    Future<Map<String, dynamic>> fresh(String txid) =>
        decoded.putIfAbsent(txid, () async {
          final data = await read('/api/tbc/decode/txid/$txid');
          need(data['txid'] == txid && data['hex'] is String, 'LP_DECODE_ID');
          final parent = inspectTransaction(data['hex'], txid);
          rememberParent?.call(parent);
          return {
            ...parent,
            if (data['confirmations'] != null)
              'confirmations': uintString(data['confirmations']),
          };
        });
    final native = funding.resolve(
      request: request,
      account: account,
      now: now,
      snapshotId: snapshotId,
      minConfirmations: minConfirmations,
    );
    native.ignore();
    final info=await read('/api/tbc/pool/poolinfo/poolid/$id');
    need(uintString(info['vout'])=='0','LP_POOL_ID');
    final poolTxid=hash32(info['txid']);
    final anchors = await Future.wait([
      readHistory(poolTxid).then(keep),
      read('/api/tbc/ft/info/contract/${hash32(info['ft_contract_id'])}'),
    ]);
    final pool=anchors[0],ft=anchors[1];
    need(pool['outputs'][0]['scriptPubKey']==info['pool_code_script'] &&
        pool['outputs'][0]['satoshis']==uintString(info['value']), 'LP_POOL_INDEX');
    final indexedPool={'ftCodeScript':ft['code_script'],'ftTapeScript':ft['tape_script']};
    final descriptor = inspect({
      'phase': 'describe',
      'poolContractId': id,
      'indexedPool': indexedPool,
      'currentPool': raw(pool),
      'publicKey': account['publicKey'],
    });
    need(
      descriptor['poolContractId'] == id &&
          descriptor['ownerLpScript'] is String,
      'LP_DESCRIPTOR',
    );
    final scriptHash = hash32(descriptor['ownerLpScriptHash']);
    hash32(descriptor['templateRevision']);
    need(
      !['tbc20-lp-lock', 'tbc20-lp-unlock'].contains(intent['type']) ||
          descriptor['lpTimelock'] == true,
      'LP_TIMELOCK_PROFILE',
    );
    final rows =
        (await collectUtxoPages(
          read,
          '/api/tbc/pool/lputxo/scriptpubkeyhash/$scriptHash',
          maxRows: 128,
          allowNull: true,
        ))['utxos'];
    need(rows is List && rows.length <= 128, 'LP_INDEX_BOUND');
    final candidates = <Map<String, dynamic>>[], seen = <String>{};
    for (final row in rows) {
      need(row is Map, 'LP_INDEX_ROW');
      final txid = hash32(row['txid']),
          vout = BigInt.parse(uintString(row['index'])),
          balance = lpIndexAmount(row);
      need(
        vout <= BigInt.from(0xffffffff) &&
            balance != '0' &&
            lpIndexAmount(row, native: true) == '500' &&
            seen.add('$txid:$vout'),
        'LP_INDEX_ROW',
      );
      candidates.add({
        'txid': txid,
        'vout': vout.toInt(),
        'balance': balance,
        if (row['height'] != null)
          'height':
              row['height'] == -1 || row['height'] == '-1'
                  ? '0'
                  : uintString(row['height']),
      });
    }
    candidates.sort((a, b) {
      final order = (a['txid'] as String).compareTo(b['txid']);
      return order != 0 ? order : (a['vout'] as int).compareTo(b['vout']);
    });
    final payload = copied((await native)['payload']);
    Map? block=payload['block'];
    BigInt? height=block==null?null:BigInt.parse(block['height']);
    Future<void> observeTip()async{
      if(block!=null)return;
      final tip=await read('/api/tbc/nodeinfo');
      block={'height':uintString(tip['blocks']),'hash':hash32(tip['bestblockhash']),
        if(tip['mediantime']!=null)'medianTimePast':uintString(tip['mediantime'])};
      payload['block']=block;height=BigInt.parse(block!['height']);
    }
    final selected = <Map<String, dynamic>>[],
        dependencies = <String>{};
    var total = BigInt.zero;
    for (final candidate in candidates) {
      if (points != null &&
          !points.any(
            (p) =>
                p['txid'] == candidate['txid'] &&
                p['vout'] == candidate['vout'],
          ))
        continue;
      if (!all && total >= wanted && points == null) break;
      String? count;
      if (candidate['height'] != null) {
        final at = BigInt.parse(candidate['height']);
        need(height==null||at <= height!, 'LP_INDEX_HEIGHT');
        count = at == BigInt.zero ? '0' : height==null?null:'${height! - at + BigInt.one}';
      } else if (floor > BigInt.zero) {
        count = (await fresh(candidate['txid']))['confirmations'];
      }
      if (floor > BigInt.zero &&
          (count == null || BigInt.parse(count) < floor)) {
        need(points == null, 'LP_SELECTED_CONFIRMATIONS');
        continue;
      }
      final tx = await parent(candidate['txid']),
          outputs = tx['outputs'] as List,
          index = candidate['vout'] as int;
      need(
        index < outputs.length &&
            outputs[index]['satoshis'] == '500' &&
            outputs[index]['scriptPubKey'] == descriptor['ownerLpScript'],
        'LP_RAW_IDENTITY',
      );
      final parsed = inspect({
        'phase': 'inspectAssets',
        'parents': [raw(tx)],
        'outputs': [
          {'txid': candidate['txid'], 'vout': index, 'kind': 'lp'},
        ],
      });
      final items = parsed['items'];
      need(items is List && items.length == 1, 'LP_ASSET_PARSE');
      final item = items.single;
      need(
        item is Map &&
            item['txid'] == candidate['txid'] &&
            item['vout'] == index &&
            item['kind'] == 'lp' &&
            item['balance'] == candidate['balance'] &&
            item['scriptPubKey'] == descriptor['ownerLpScript'] &&
            item['dependencies'] is List,
        'LP_ASSET_IDENTITY',
      );
      final lock = item['lockTime'];
      need(lock is int && lock >= 0 && lock <= 0xffffffff, 'LP_LOCK');
      if(lock!=0)await observeTip();
      if (lock >= 500000000) need(block!['medianTimePast'] != null, 'LP_MTP');
      final mature =
          lock == 0 ||
          (lock < 500000000
              ? BigInt.from(lock) <= height!
              : BigInt.from(lock) <
                  BigInt.parse(uintString(block!['medianTimePast'])));
      if (!mature) {
        need(points == null, 'LP_SELECTED_IMMATURE');
        continue;
      }
      need(selected.length < 128, 'LP_ASSET_BOUND');
      keep(tx);
      total += BigInt.parse(item['balance']);
      selected.add({
        'txid': candidate['txid'],
        'vout': index,
        'satoshis': '500',
        'scriptPubKey': descriptor['ownerLpScript'],
        'classification': 'ftlp',
        'contractId': id,
        if (count != null) 'confirmations': count,
      });
      for (final point in item['dependencies']) {
        need(
          point is Map &&
              (tx['inputs'] as List).any(
                (p) => p['txid'] == point['txid'] && p['vout'] == point['vout'],
              ),
          'LP_DIRECT_PROOF',
        );
        dependencies.add(hash32(point['txid']));
      }
    }
    need(
      selected.isNotEmpty &&
          (all || total >= wanted) &&
          (intent['type'] != 'tbc20-lp-merge' || selected.length >= 2),
      'LP_INSUFFICIENT',
    );
    await Future.wait(
      dependencies
          .where((id) => !parents.containsKey(id))
          .map((id) => parent(id).then(keep)),
    );
    final natives = payload['utxos'] as List,
        combined = [...natives, ...selected];
    need(
      (natives.isEmpty ? 0 : 1) + selected.length <= 128 &&
          combined.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
              combined.length,
      'LP_INPUT_BUDGET',
    );
    payload['utxos'] = combined;
    payload['parents'] = [for (final tx in parents.values) raw(tx)];
    payload['contracts'] = [
      {
        'contractId': id,
        'indexedPool': indexedPool,
        'family': 'pool',
        'protocolVersion': 'pool3',
        'standardId': 'tbc-amm',
        'templateRevision': descriptor['templateRevision'],
        'creationTxid': id,
        'genesisOutpoint': {'txid': id, 'vout': 0},
        'currentOutpoint': {'txid': poolTxid, 'vout': 0},
      },
    ];
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
