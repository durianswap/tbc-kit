// Frozen AMM index/proof schedule. Rust parses contracts/quotes; Engine later
// authenticates spending and bounds. No wallet UI, signing or broadcast here.
import '../configuration.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;
import 'transaction_read.dart';
import 'transaction_signing_roles.dart';
import 'amm_fee_policy.dart';
import 'utxo_pages.dart';

const ammBusinessProfiles = {
  'tbc-amm-add-liquidity',
  'tbc-amm-remove-liquidity',
  'tbc-amm-swap',
};

final class AmmBusinessMaterialReader {
  AmmBusinessMaterialReader({
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
    List<Map<String, dynamic>> signingAccounts = const [],
  }) async {
    request = copied(request);
    account = copied(account);
    inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(
      intent is Map && ammBusinessProfiles.contains(intent['type']),
      'AMM_PROFILE',
    );
    // Identity only; custody must independently authorize these wallet-owned
    // accounts. The public worker still rejects roles until that gate exists.
    final roles = TransactionSigningAccounts.resolve(
      request: request,
      primary: account,
      additional: signingAccounts,
    );
    final id = hash32(intent['poolContractId']),
        floor = BigInt.parse(uintString(minConfirmations));
    final remove = intent['type'] == 'tbc-amm-remove-liquidity',
        swap = intent['type'] == 'tbc-amm-swap';
    final buy = swap && intent['direction'] == 'tbc-to-ft';
    final kind =
        remove
            ? 'remove'
            : swap
            ? (buy ? 'buy' : 'sell')
            : intent['budgetAsset'] == 'tbc'
            ? 'addTbc'
            : 'addFt';
    final action = <String, dynamic>{
      'kind': kind,
      'amount': uintString(remove ? intent['lpAmount'] : intent['amount']),
      if (intent['initialFtAmount'] != null)
        'initialFtAmount': uintString(intent['initialFtAmount']),
    };
    final points = request['constraints']?['inputOutpoints'] as List?;
    bool permitted(Map p) =>
        points == null ||
        points.any((q) => q['txid'] == p['txid'] && q['vout'] == p['vout']);
    final parents = <String, Map<String, dynamic>>{},
        proofs = <String, Future<void>>{};
    final freshParents = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> confirmedParent(String id) =>
        freshParents.putIfAbsent(
          id,
          () => readConfirmedTransaction(read, id, remember: rememberParent),
        );
    Map<String, dynamic> keep(Map<String, dynamic> tx) {
      parents[tx['txid']] = tx;
      return tx;
    }

    Map<String, dynamic> raw(Map tx) => {
      'txid': tx['txid'],
      'rawTransaction': tx['rawTransaction'],
    };
    Map<String, dynamic> inspect(Map<String, dynamic> input) =>
        keyless('inspectAmmMaterial', input);
    void proof(String txid) {
      hash32(txid);
      if (parents.containsKey(txid) || proofs.containsKey(txid)) return;
      final f = readHistory(txid).then<void>((v) {
        keep(v);
      });
      f.ignore();
      proofs[txid] = f;
    }

    final native = funding.resolve(
      request: request,
      account: account,
      now: now,
      snapshotId: snapshotId,
      minConfirmations: minConfirmations,
    );
    native.ignore();
    // Frozen Kit authenticates the first funding alternative and places that
    // parent before the sorted AMM proof set. Share the same immutable reader;
    // a funding output in the current Pool transaction needs no second GET.
    final fundingParent = native.then((snapshot) async {
      final u = (snapshot['payload']['utxos'] as List).first as Map;
      final tx = await readHistory(u['txid']);
      final outputs = tx['outputs'] as List, index = u['vout'] as int;
      need(
        index < outputs.length &&
            outputs[index]['satoshis'] == u['satoshis'] &&
            outputs[index]['scriptPubKey'] == u['scriptPubKey'],
        'AMM_FUNDING_PARENT',
      );
      return tx;
    });
    fundingParent.ignore();
    final current = () async {
      final info = await read('/api/tbc/pool/poolinfo/poolid/$id');
      final txid = hash32(info['txid']);
      need(
        uintString(info['vout']) == '0' && permitted({'txid': txid, 'vout': 0}),
        'AMM_CURRENT_POINT',
      );
      final ftRead=read('/api/tbc/ft/info/contract/${hash32(info['ft_contract_id'])}');
      ftRead.ignore();
      final tx = keep(
            await (floor == BigInt.zero
                ? readHistory(txid)
                : confirmedParent(txid)),
          ),
          outputs = tx['outputs'] as List;
      need(
        outputs.isNotEmpty &&
            outputs[0]['satoshis'] == uintString(info['value']) &&
            outputs[0]['scriptPubKey'] == info['pool_code_script'] &&
            (tx['inputs'] as List).isNotEmpty,
        'AMM_CURRENT_RAW',
      );
      proof(tx['inputs'][0]['txid']);
      return (info, tx, await ftRead);
    }();
    current.ignore();
    final (info, tx,ft) = await current;
    final indexedPool={'ftCodeScript':ft['code_script'],'ftTapeScript':ft['tape_script']};
    final descriptor = inspect({
      'phase': 'describe',
      if (roles.controller != null)
        'controllerPublicKey': roles.controller!['publicKey'],
      'poolContractId': id,
      'indexedPool': indexedPool,
      'currentPool': raw(tx),
      'publicKey': account['publicKey'],
      'action': action,
    });
    need(
      descriptor['poolContractId'] == id &&
          descriptor['ftContractId'] == info['ft_contract_id'] &&
          descriptor['currentOutpoint']?['txid'] == tx['txid'] &&
          descriptor['currentOutpoint']?['vout'] == 0 &&
          descriptor['poolCodeScript'] == info['pool_code_script'] &&
          descriptor['state']?['ftAmount'] ==
              uintString(info['token_balance']) &&
          descriptor['state']?['lpAmount'] == uintString(info['lp_balance']) &&
          descriptor['state']?['tbcAmount'] == uintString(info['tbc_balance']),
      'AMM_INDEX_BINDING',
    );
    if (descriptor.containsKey('feePolicy')) {
      // The common index can carry stale legacy summaries. Rates/address are
      // bound by the full Code/Tape/genesis inspection above, with no new GET.
      normalizeAmmFeePolicy(descriptor['feePolicy']);
    } else {
      need(
        uintString(descriptor['serviceFeeRate']) ==
            uintString(info['service_fee_rate']),
        'AMM_PRESET_FEE_BINDING',
      );
    }
    hash32(descriptor['templateRevision']);
    for (final name in ['ownerCombineScript', 'poolCombineScript']) {
      need(
        descriptor[name] is String &&
            RegExp(r'^[0-9a-f]{42}$').hasMatch(descriptor[name]),
        'AMM_COMBINE_SCRIPT',
      );
    }
    final authorization = descriptor['authorization'];
    need(authorization is Map, 'AMM_AUTHORIZATION');
    if (authorization['kind'] == 'controller') {
      final hashes = authorization['controllerHashes'];
      need(
        hashes is List &&
            hashes.isNotEmpty &&
            hashes.length <= 5 &&
            hashes.toSet().length == hashes.length &&
            hashes.every(
              (v) => v is String && RegExp(r'^[0-9a-f]{40}$').hasMatch(v),
            ) &&
            authorization['accountMatches'] == true,
        'AMM_CONTROLLER',
      );
    } else {
      need(
        authorization['kind'] == 'public' && roles.controller == null,
        'AMM_AUTHORIZATION',
      );
    }
    final holderKind =
            buy
                ? null
                : remove
                ? 'lp'
                : 'ft',
        needs = descriptor['requirements'];
    need(needs is Map && needs['holderKind'] == holderKind, 'AMM_REQUIREMENTS');
    final wanted = BigInt.parse(uintString(needs['holderAmount']));
    uintString(needs['nativeAmount']);
    final poolRows = collectUtxoPages(
      read,
      '/api/tbc/ft/utxo/combinescript/${descriptor['poolCombineScript']}/contract/${descriptor['ftContractId']}',
      maxRows: 128,
    );
    final holderRows =
        holderKind == null
            ? Future.value(<String, dynamic>{'utxos': <Object>[]})
            : collectUtxoPages(
              read,
              holderKind == 'lp'
                  ? '/api/tbc/pool/lputxo/scriptpubkeyhash/${hash32(descriptor['ownerLpScriptHash'])}'
                  : '/api/tbc/ft/utxo/combinescript/${descriptor['ownerCombineScript']}/contract/${descriptor['ftContractId']}',
              maxRows: 128,
              allowNull: holderKind == 'lp',
            );
    poolRows.ignore();
    holderRows.ignore();
    final joined = await Future.wait([native, poolRows, holderRows]);
    final payload = copied(joined[0]['payload']);
    Map? block = payload['block'];
    BigInt? height = block == null ? null : BigInt.parse(uintString(block['height']));
    Future<void> observeTip() async {
      if (block != null) return;
      final tip = await read('/api/tbc/nodeinfo');
      block = {'height': uintString(tip['blocks']), 'hash': hash32(tip['bestblockhash']),
        if (tip['mediantime'] != null) 'medianTimePast': uintString(tip['mediantime'])};
      payload['block'] = block;
      height = BigInt.parse(block!['height']);
    }
    final decoded = <String, Future<String>>{};
    Future<String?> confirmations(String txid, Object? indexed) async {
      if (indexed == null) {
        if (floor == BigInt.zero) return null;
        return decoded.putIfAbsent(txid, () async {
          final value = await confirmedParent(txid);
          return uintString(value['confirmations']);
        });
      }
      final at =
          indexed == -1 || indexed == '-1'
              ? BigInt.zero
              : BigInt.parse(uintString(indexed));
      need(height == null || at <= height!, 'AMM_INDEX_HEIGHT');
      return at == BigInt.zero ? '0' : height == null ? null : '${height! - at + BigInt.one}';
    }

    final poolConfirmations = await confirmations(tx['txid'], null);
    need(
      floor == BigInt.zero || BigInt.parse(poolConfirmations!) >= floor,
      'AMM_POOL_CONFIRMATIONS',
    );
    final assets = <Map<String, dynamic>>[
      {
        'txid': tx['txid'],
        'vout': 0,
        'satoshis': uintString(info['value']),
        'scriptPubKey': info['pool_code_script'],
        'classification': 'pool',
        'contractId': id,
        if (poolConfirmations != null) 'confirmations': poolConfirmations,
      },
    ];
    final dependencies = <String>{};
    Future<List<Map<String, dynamic>>> select(
      Object? rows,
      bool poolOwned,
    ) async {
      need(rows is List && rows.length <= 128, 'AMM_INDEX_BOUND');
      final kind = poolOwned ? 'ft' : holderKind!,
          expected =
              descriptor[poolOwned
                  ? 'poolFtScript'
                  : kind == 'lp'
                  ? 'ownerLpScript'
                  : 'ownerFtScript'];
      final seen = <String>{}, candidates = <Map<String, dynamic>>[];
      for (final row in rows as List) {
        need(row is Map, 'AMM_INDEX_ROW');
        final txid = hash32(row['txid']);
        final index = BigInt.parse(uintString(row['index'])),
            balance = uintString(
              row['ft_value'] ?? row['balance'] ?? row['lp_balance'],
            );
        need(
          index <= BigInt.from(0xffffffff) &&
              uintString(
                    row['tbc_value'] ?? row['value'] ?? row['tbc_balance'],
                  ) ==
                  '500' &&
              (poolOwned || balance != '0') &&
              seen.add('$txid:$index'),
          'AMM_ASSET_INDEX',
        );
        candidates.add({
          'txid': txid,
          'vout': index.toInt(),
          'balance': balance,
          'height': row['height'],
        });
      }
      candidates.sort((a, b) {
        final c = (a['txid'] as String).compareTo(b['txid']);
        return c != 0 ? c : (a['vout'] as int).compareTo(b['vout']);
      });
      need(!poolOwned || candidates.length == 1, 'AMM_RESERVE_INPUT');
      final ordered =
          poolOwned || points != null
              ? candidates
              : [
                ...candidates.where(
                  (c) => BigInt.parse(c['balance']) >= wanted,
                ),
                ...candidates.where((c) => BigInt.parse(c['balance']) < wanted),
              ];
      final selected = <Map<String, dynamic>>[];
      var total = BigInt.zero;
      for (final c in ordered) {
        if (!permitted(c)) continue;
        final count = await confirmations(c['txid'], c['height']);
        if (floor > BigInt.zero && BigInt.parse(count!) < floor) continue;
        final parent =
                await (freshParents[c['txid']] ?? readHistory(c['txid'])),
            outs = parent['outputs'] as List,
            index = c['vout'] as int;
        need(
          index < outs.length &&
              outs[index]['satoshis'] == '500' &&
              outs[index]['scriptPubKey'] == expected,
          'AMM_ASSET_RAW',
        );
        final parsed = inspect({
          'phase': 'inspectAssets',
          'parents': [raw(parent)],
          'outputs': [
            {'txid': c['txid'], 'vout': index, 'kind': kind},
          ],
        });
        final items = parsed['items'];
        need(items is List && items.length == 1, 'AMM_ASSET_PARSE');
        final item = items.single;
        need(
          item is Map &&
              item['txid'] == c['txid'] &&
              item['vout'] == index &&
              item['kind'] == kind &&
              item['balance'] == c['balance'] &&
              item['scriptPubKey'] == expected &&
              item['dependencies'] is List,
          'AMM_ASSET_IDENTITY',
        );
        if (kind == 'lp') {
          final lock = item['lockTime'];
          need(lock is int && lock >= 0 && lock <= 0xffffffff, 'AMM_LP_LOCK');
          if (lock != 0) {
            await observeTip();
            if (lock >= 500000000)
              need(block!['medianTimePast'] != null, 'AMM_MTP');
            if (lock < 500000000
                ? BigInt.from(lock) > height!
                : BigInt.from(lock) >= BigInt.parse(uintString(block!['medianTimePast'])))
              continue;
          }
        }
        keep(parent);
        for (final p in item['dependencies']) {
          need(
            p is Map &&
                (parent['inputs'] as List).any(
                  (v) => v['txid'] == p['txid'] && v['vout'] == p['vout'],
                ),
            'AMM_DIRECT_PROOF',
          );
          dependencies.add(hash32(p['txid']));
        }
        selected.add({
          'txid': c['txid'],
          'vout': index,
          'satoshis': '500',
          'scriptPubKey': expected,
          'classification':
              poolOwned
                  ? 'pool-ft'
                  : kind == 'lp'
                  ? 'ftlp'
                  : 'ft',
          'contractId':
              poolOwned || kind == 'lp' ? id : descriptor['ftContractId'],
          if (count != null) 'confirmations': count,
        });
        total += BigInt.parse(item['balance']);
        if (poolOwned || (points == null && total >= wanted)) return selected;
      }
      need(selected.isNotEmpty && total >= wanted, 'AMM_HOLDER_INSUFFICIENT');
      return selected;
    }

    final groups = await Future.wait([
      select(joined[1]['utxos'], true),
      holderKind == null
          ? Future.value(<Map<String, dynamic>>[])
          : select(joined[2]['utxos'], false),
    ]);
    for (final group in groups) {
      assets.addAll(group);
    }
    for (final dep in dependencies) {
      proof(dep);
    }
    await Future.wait(proofs.values);
    final nativeUtxos = payload['utxos'] as List,
        all = [...nativeUtxos, ...assets];
    need(
      (nativeUtxos.isEmpty ? 0 : 1) + assets.length <= 128 &&
          all.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
              all.length,
      'AMM_INPUT_BUDGET',
    );
    payload['utxos'] = all;
    final first = await fundingParent;
    final ids =
        parents.keys.where((id) => id != first['txid']).toList()..sort();
    payload['parents'] = [raw(first), for (final id in ids) raw(parents[id]!)];
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
        'currentOutpoint': {'txid': tx['txid'], 'vout': 0},
      },
    ];
    if (roles.additional.isNotEmpty)
      payload['signingAccounts'] = roles.additional;
    roles.requireSnapshot(payload);
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
