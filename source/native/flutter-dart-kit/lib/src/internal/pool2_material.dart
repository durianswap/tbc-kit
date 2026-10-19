// Existing Pool2 operations, not historical creation or a Legacy executor.
// Only material selection/normalization is ported; Rust remains authoritative
// for contract interpretation, fee maths, construction and signing checks.
import '../configuration.dart';
import '../host_environment.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;
import 'transaction_read.dart';
import 'utxo_pages.dart';

const pool2Profiles = {
  'tbc.pool.swap.exactTbcForToken': 'swapToToken',
  'tbc.pool.swap.exactTokenForTbc': 'swapToTbc',
  'tbc.pool.liquidity.add': 'increaseLp',
  'tbc.pool.liquidity.remove': 'consumeLp',
  'tbc.pool.ft.merge': 'mergePoolFt',
  'tbc.pool.ftlp.merge': 'mergeFtlp',
  'tbc.pool.ftlp.burn': 'burnFtlp',
};

// Policy is derived from the keyless descriptor in this exact preparation,
// never from a DApp fee override or an unbound previous Pool query.
final class Pool2PreparedMaterial {
  Pool2PreparedMaterial._(
    this._snapshot,
    this._pool,
    this._requestHash,
    this._floor,
  );
  final Map<String, dynamic> _snapshot, _pool;
  final String _requestHash;
  final String _floor;
  Map<String, dynamic> get snapshot => copied(_snapshot);
  Map<String, dynamic> policy({
    required Map<String, dynamic> request,
    required TbcNetworkConfiguration network,
    required DateTime now,
    String minConfirmations = '0',
  }) {
    need(
      hashJson(request) == _requestHash &&
          request['chainId'] == network.chainId &&
          _snapshot['payload']['chainId'] == network.chainId &&
          minConfirmations == _floor,
      'POOL2_POLICY_BINDING',
    );
    final payload = <String, dynamic>{
      'version': '1.0',
      'policyId': 'tbc-${network.network.name}-kit-r1',
      'revision': '1',
      'chainId': network.chainId,
      'feeRateSatPerKb': '80',
      'dustThreshold': '24',
      'minConfirmations': uintString(minConfirmations),
      'maxBundleTransactions': 32,
      'sighashType': 65,
      'contractPolicies': <Object>[],
      'amountLimits': [
        {'scope': 'native', 'maximum': '2100000000000000'},
      ],
      'pool': copied(_pool),
      'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 5))),
    };
    return {'payload': payload, 'policyHash': hashJson(payload)};
  }
}

final class Pool2MaterialReader {
  Pool2MaterialReader({
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

  Future<Pool2PreparedMaterial> resolve({
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
      intent is Map && pool2Profiles.containsKey(intent['type']),
      'POOL2_PROFILE',
    );
    final operation = pool2Profiles[intent['type']]!,
        id = hash32(intent['poolContractId']),
        floor = BigInt.parse(uintString(minConfirmations));
    final buy = operation == 'swapToToken',
        sell = operation == 'swapToTbc',
        add = operation == 'increaseLp',
        remove = operation == 'consumeLp',
        mergeFt = operation == 'mergePoolFt',
        mergeLp = operation == 'mergeFtlp',
        burnLp = operation == 'burnFtlp';
    final maintenance = mergeFt || mergeLp || burnLp;
    final amount =
        maintenance
            ? '0'
            : uintString(
              intent[sell
                  ? 'ftAmount'
                  : remove
                  ? 'lpAmount'
                  : 'tbcAmount'],
            );
    need(maintenance || BigInt.parse(amount) > BigInt.zero, 'POOL2_AMOUNT');
    // Frozen Engine rejects explicit Pool2 inputs. Preserve that contract;
    // never silently replace a caller-selected coin with automatic funding.
    need(
      request['constraints']?['inputOutpoints'] == null,
      'HISTORICAL_POOL_EXPLICIT_INPUTS',
    );
    final native = funding.resolve(
      request: request,
      account: account,
      now: now,
      snapshotId: snapshotId,
      minConfirmations: minConfirmations,
    );
    native.ignore();
    final nodes = <String, Future<Map<String, dynamic>>>{},
        heights = <String, String>{};
    Future<Map<String, dynamic>> parent(String txid) =>
        nodes.putIfAbsent(txid, () async {
          // Freeze this request's observation when the read starts; loading an
          // index later must not retroactively alter already-bound descriptors.
          final height = heights[txid];
          String? confirmations;
          if (floor == BigInt.zero) {
            // No confirmation claim is needed at a zero floor. Do not fetch a
            // tip or delay exact transaction-byte verification for metadata.
            return readHistory(txid);
          }
          if (height != null) {
            final tip = BigInt.parse(
              (await native)['payload']['block']['height'],
            );
            final h = BigInt.parse(height);
            need(h <= tip, 'POOL2_INDEX_HEIGHT');
            confirmations = h == BigInt.zero ? '0' : '${tip - h + BigInt.one}';
          }
          if (maintenance && confirmations == null) {
            final freshFunding = (await native)['payload']['utxos'] as List;
            confirmations =
                freshFunding
                    .where((u) => u['txid'] == txid)
                    .firstOrNull?['confirmations'];
          }
          if (floor > BigInt.zero && confirmations == null) {
            final d = await read('/api/tbc/decode/txid/$txid');
            need(
              d['txid'] == txid && d['confirmations'] != null,
              'POOL2_CONFIRMATIONS',
            );
            final parent = inspectTransaction(d['hex'], txid);
            rememberParent?.call(parent);
            return {...parent, 'confirmations': uintString(d['confirmations'])};
          }
          return {
            ...await readHistory(txid),
            if (confirmations != null) 'confirmations': confirmations,
          };
        });
    Future<List<Map<String, dynamic>>> index(
      String path, {
      bool lp = false,
      bool locked = false,
    }) async {
      final response = await collectUtxoPages(
        read,
        path,
        maxRows: 256,
        allowNull: lp,
      );
      final rows =
          lp && response['utxos'] == null && response.containsKey('utxos')
              ? <Object>[]
              : response['utxos'];
      need(rows is List && rows.length <= 256, 'POOL2_INDEX_BOUND');
      final result = <Map<String, dynamic>>[], seen = <String>{};
      for (final row in rows) {
        need(row is Map, 'POOL2_INDEX_ROW');
        final txid = hash32(row['txid']), vout = _integer(row['index']);
        need(
          vout <= 0xffffffff && seen.add('$txid:$vout'),
          'POOL2_INDEX_OUTPOINT',
        );
        if (row['height'] != null) {
          final h =
              row['height'] == -1 || row['height'] == '-1'
                  ? '0'
                  : uintString(row['height']);
          need(
            heights[txid] == null || heights[txid] == h,
            'POOL2_INDEX_HEIGHT_CONFLICT',
          );
          heights[txid] = h;
        }
        result.add({
          'txid': txid,
          'outputIndex': vout,
          'satoshis': _integer(row[lp ? 'tbc_balance' : 'tbc_value']),
          'balance': uintString(row[lp ? 'lp_balance' : 'ft_value']),
          if (lp) 'lockTime': pool2LpLockTime(row, locked: locked),
        });
      }
      return result;
    }

    final infoRead = read('/api/tbc/pool/poolinfo/poolid/$id');
    infoRead.ignore();
    final feeRead = native.then((snapshot) async {
      final u = snapshot['payload']['utxos'][0],
          tx = await readHistory(u['txid']);
      final outputs = tx['outputs'] as List, vout = u['vout'] as int;
      need(
        vout < outputs.length &&
            outputs[vout]['satoshis'] == u['satoshis'] &&
            outputs[vout]['scriptPubKey'] == owner['scriptPubKey'],
        'POOL2_FUNDING_PARENT',
      );
      return tx;
    });
    feeRead.ignore();
    final info = pool2IndexInfo(await infoRead),
        ftId = info['ftContractId'] as String;
    final ownerCombine =
        '${(owner['scriptPubKey'] as String).substring(6, 46)}00';
    Future<List<Map<String, dynamic>>>? ownerIndex;
    if (add) {
      ownerIndex = index(
        '/api/tbc/ft/utxo/combinescript/$ownerCombine/contract/$ftId',
      );
      ownerIndex.ignore();
    }
    final currentRead = parent(info['txid']);
    currentRead.ignore();
    final previousRead = currentRead.then((tx) {
      need(
        (tx['inputs'] as List).isNotEmpty && tx['inputs'][0]['vout'] == 0,
        'POOL2_STATE_ANCESTRY',
      );
      final priorId = hash32(tx['inputs'][0]['txid']);
      // Maintenance can later select an output of the preceding state. Keep
      // its first-read metadata consistent with the frozen material source.
      return maintenance && floor == BigInt.zero
          ? nodes.putIfAbsent(priorId, () => readHistory(priorId))
          : readHistory(priorId);
    });
    previousRead.ignore();
    final anchors = await Future.wait([currentRead, read('/api/tbc/ft/info/contract/$ftId')]),
        current = anchors[0],
        ft = anchors[1];
    final indexedFt = {'codeScript': _hex(ft['code_script']), 'tapeScript': _hex(ft['tape_script'])};
    final descriptor = keyless('preparePoolNft', {
      'phase': 'describe',
      'contractId': id,
      'ownerAddress': account['address'],
      'info': info,
      'poolPreTxraw': current['rawTransaction'],
      'indexedFt': indexedFt,
    });
    need(
      descriptor['stablecoin'] == false &&
          descriptor['ftContractId'] == ftId &&
          descriptor['pool'] is Map,
      'POOL2_DESCRIPTOR',
    );
    final pool = copied(descriptor['pool']),
        decimals = _integer(descriptor['ftDecimal']);
    // Only time-locked LP operations require chain height. Ordinary swaps and
    // unlocked LP operations consume the same current/direct proof bytes.
    if (pool['ftlpLockTimeEnabled'] == true && (add || remove || mergeLp || burnLp)) {
      final snapshot = await native;
      if (snapshot['payload']['block'] == null) {
        final tip = await read('/api/tbc/nodeinfo');
        snapshot['payload']['block'] = {'height': uintString(tip['blocks']), 'hash': hash32(tip['bestblockhash'])};
      }
    }
    need(
      decimals <= 18 && descriptor['ownerCombineScript'] == ownerCombine,
      'POOL2_OWNER',
    );
    final poolScript = _hex(descriptor['poolFtScript']),
        ownerScript = _hex(descriptor['ownerFtScript']),
        lpScript = _hex(descriptor['ftlpScript']);
    final poolConfig = {
      'lpPlan': _integer(pool['lpPlan']),
      'serviceFeeRate': _integer(pool['serviceFeeRate']),
      'serviceProviderTag': info['serviceProvider'],
    };
    need(
      poolConfig['lpPlan'] >= 1 &&
          poolConfig['lpPlan'] <= 6 &&
          RegExp(
            r'^[\x20-\x7e]{1,64}$',
          ).hasMatch(poolConfig['serviceProviderTag']),
      'POOL2_POLICY',
    );
    final poolArgs = <String, dynamic>{
      for (final k in ['ftLpRaw', 'ftARaw', 'tbcSat', 'poolValueSat'])
        k: uintString(pool[k]),
      'serviceFeeRate': poolConfig['serviceFeeRate'],
      'lpPlan': poolConfig['lpPlan'],
      'ftlpLockTimeEnabled': pool['ftlpLockTimeEnabled'] == true,
      'publicKeyLocked': pool['publicKeyLocked'] == true,
      if (add && pool['publicKeyLocked'] == true)
        'lockedLpCostSatoshis': _integer(pool['lockedLpCostSatoshis']),
    };
    List<Map<String, dynamic>> owned = [], held = [], lp = [];
    var lockHeight = 0;
    if (maintenance) {
      final rows = await index(
        mergeFt
            ? '/api/tbc/ft/utxo/combinescript/${descriptor['poolCombineScript']}/contract/$ftId'
            : '/api/tbc/pool/lputxo/scriptpubkeyhash/${hash32(descriptor['ftlpScriptHash'])}',
        lp: !mergeFt,
        locked: pool['ftlpLockTimeEnabled'] == true,
      );
      rows.sort(_ascendingAsset);
      final bounded = rows.take(mergeFt ? 4 : 5).toList();
      if (mergeFt) {
        held = bounded;
      } else {
        lp = bounded.map((r) => {...r, 'script': lpScript}).toList();
      }
      if (mergeLp && pool['ftlpLockTimeEnabled'] == true) {
        lockHeight = _integer((await native)['payload']['block']['height']);
      }
    } else if (add) {
      final preview = keyless('legacyPoolPreview', {
        'operation': 'increaseLp',
        'ftContractId': ftId,
        'ftDecimal': decimals,
        'amount': _display(amount, 6),
        'lockTime': 0,
        'pool': {
          for (final k in [
            'ftLpRaw',
            'ftARaw',
            'tbcSat',
            'poolValueSat',
            'publicKeyLocked',
            'lockedLpCostSatoshis',
          ])
            if (poolArgs.containsKey(k)) k: poolArgs[k],
        },
      });
      owned = _sufficient(
        await ownerIndex!,
        uintString(preview['ftRequiredRaw']),
      );
    } else if (remove) {
      final rows = await Future.wait([
        index(
          '/api/tbc/ft/utxo/combinescript/${descriptor['poolCombineScript']}/contract/$ftId',
        ),
        index(
          '/api/tbc/pool/lputxo/scriptpubkeyhash/${hash32(descriptor['ftlpScriptHash'])}',
          lp: true,
          locked: pool['ftlpLockTimeEnabled'] == true,
        ),
      ]);
      held = rows[0];
      lp = rows[1].map((r) => {...r, 'script': lpScript}).toList();
      if (pool['ftlpLockTimeEnabled'] == true) {
        final tip = _integer((await native)['payload']['block']['height']);
        need(tip >= 2, 'POOL2_LOCK_HEIGHT');
        lockHeight = tip - 2;
      } else {
        lp = _sufficient(lp, amount);
      }
    } else {
      final rows = await index(
        '/api/tbc/ft/utxo/combinescript/${descriptor[buy ? 'poolCombineScript' : 'ownerCombineScript']}/contract/$ftId',
      );
      if (buy) {
        held = rows;
      } else {
        owned = rows;
      }
    }
    final selected = keyless('preparePoolNft', {
      'phase': 'select',
      'operation': operation,
      'ftContractId': ftId,
      'ftDecimal': decimals,
      'pool': poolArgs,
      'amount': _display(amount, sell ? decimals : 6),
      if ((remove || mergeLp) && pool['ftlpLockTimeEnabled'] == true)
        'currentBlockHeight': lockHeight,
      'ownerFtCandidates': owned,
      'poolFtCandidates': held,
      'ftlpCandidates': lp,
    });
    final selectedOwned = selected['ownerFtCandidates'],
        selectedHeld = selected['poolFtCandidates'],
        selectedLp = selected['ftlpCandidates'];
    need(
      selectedOwned is List &&
          selectedHeld is List &&
          selectedLp is List &&
          (maintenance
              ? selectedOwned.isEmpty &&
                  (mergeFt
                      ? selectedLp.isEmpty && selectedHeld.isNotEmpty
                      : selectedHeld.isEmpty && selectedLp.isNotEmpty)
              : buy
              ? selectedHeld.isNotEmpty &&
                  selectedOwned.isEmpty &&
                  selectedLp.isEmpty
              : sell || add
              ? selectedOwned.isNotEmpty &&
                  selectedHeld.isEmpty &&
                  selectedLp.isEmpty
              : selectedOwned.isEmpty &&
                  selectedHeld.isNotEmpty &&
                  selectedLp.isNotEmpty),
      'POOL2_SELECTION',
    );
    need(!add || selectedOwned.length == 1, 'POOL2_ADD_FRAGMENTED');
    if (maintenance) {
      final count = mergeFt ? selectedHeld.length : selectedLp.length;
      need(
        count >= (burnLp ? 1 : 2) && count <= (mergeFt ? 4 : 5),
        'POOL2_MAINTENANCE_INPUTS',
      );
    }
    final inputs = <Map<String, dynamic>>[
      for (final (items, source, classification, script) in [
        (selectedOwned, owned, 'ft', ownerScript),
        (selectedHeld, held, 'pool-ft', poolScript),
        (selectedLp, lp, 'ftlp', lpScript),
      ])
        for (final item in items)
          () {
            need(
              source.any((s) => canonical(s) == canonical(item)),
              'POOL2_SELECTION_MEMBERSHIP',
            );
            return {
              ...copied(item),
              'classification': classification,
              'script': script,
            };
          }(),
    ];
    need(inputs.isNotEmpty && inputs.length <= 126, 'POOL2_SELECTED_BOUND');
    final selectedParents = await Future.wait(
      inputs.map((i) => parent(i['txid'])),
    );
    final ancestry = keyless('prepareAssetAncestry', {
      'phase': 'inspect',
      'items': [
        for (var i = 0; i < inputs.length; i++)
          {
            'parentTxid': inputs[i]['txid'],
            'outputIndex': inputs[i]['outputIndex'],
            'parentTxraw': selectedParents[i]['rawTransaction'],
          },
      ],
    });
    need(
      ancestry['items'] is List && ancestry['items'].length == inputs.length,
      'POOL2_ANCESTRY',
    );
    final grandparents = await Future.wait(
      (ancestry['items'] as List).map((item) async {
        final refs = item['references'];
        need(
          refs is List && refs.isNotEmpty && refs.length <= 6,
          'POOL2_ANCESTRY_BOUND',
        );
        return await Future.wait(
          (refs as List).map(
            (r) async => {
              'txid': hash32(r['txid']),
              'outputIndex': _integer(r['outputIndex']),
              'parent': await readHistory(hash32(r['txid'])),
            },
          ),
        );
      }),
    );
    if (buy || sell) {
      final proof = keyless('prepareAssetAncestry', {
        'phase': 'prove',
        'items': [
          for (var i = 0; i < inputs.length; i++)
            {
              'parentTxid': inputs[i]['txid'],
              'outputIndex': inputs[i]['outputIndex'],
              'parentTxraw': selectedParents[i]['rawTransaction'],
              'grandparents': [
                for (final g in grandparents[i])
                  {
                    'txid': g['txid'],
                    'outputIndex': g['outputIndex'],
                    'txraw': (g['parent'] as Map)['rawTransaction'],
                  },
              ],
            },
        ],
      });
      need(
        proof['items'] is List && proof['items'].length == inputs.length,
        'POOL2_PROOF',
      );
      for (final item in proof['items']) {
        _hex(item['prePreTxData']);
      }
    }
    final joined = await Future.wait([
      native,
      feeRead,
      previousRead,
    ]);
    final payload = copied(joined[0]['payload']),
        feeParent = joined[1],
        previous = joined[2];
    final utxos = payload['utxos'] as List;
    final tip = payload['block'] == null ? null : BigInt.parse(payload['block']['height']);
    if (tip != null) {
      for (final h in heights.values) need(BigInt.parse(h) <= tip, 'POOL2_INDEX_HEIGHT');
    }
    final orderedParents = <String, Map<String, dynamic>>{};
    void keep(Map<String, dynamic> p) => orderedParents.putIfAbsent(
      p['txid'],
      () => {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
    );
    for (final p in [feeParent, previous, current]) {
      keep(p);
    }
    Map<String, dynamic> output(
      Map<String, dynamic> tx,
      int vout,
      String classification, {
      String? contractId,
      String? script,
      String? value,
    }) {
      need(
        vout >= 0 && vout < (tx['outputs'] as List).length,
        'POOL2_PARENT_OUTPUT',
      );
      final o = tx['outputs'][vout];
      final fundingObservation =
          maintenance
              ? utxos
                  .where(
                    (u) =>
                        u['classification'] == 'native' &&
                        u['txid'] == tx['txid'],
                  )
                  .firstOrNull
              : null;
      final confirmations =
          tx['confirmations'] ?? fundingObservation?['confirmations'];
      need(
        (script == null || o['scriptPubKey'] == script) &&
            (value == null || o['satoshis'] == value),
        'POOL2_PARENT_BINDING',
      );
      return {
        'txid': tx['txid'],
        'vout': vout,
        'satoshis': o['satoshis'],
        'scriptPubKey': o['scriptPubKey'],
        if (confirmations != null) 'confirmations': confirmations,
        'classification': classification,
        if (contractId != null) 'contractId': contractId,
      };
    }

    utxos.add(
      output(
        current,
        0,
        'pool',
        contractId: id,
        script: info['poolCodeScript'],
        value: info['value'],
      ),
    );
    if (!remove && !maintenance) {
      for (var i = 0; i < (current['outputs'] as List).length; i++) {
        final s = current['outputs'][i]['scriptPubKey'];
        if (s == poolScript || (add && s == lpScript)) {
          utxos.add(
            output(
              current,
              i,
              s == poolScript ? 'pool-ft' : 'ftlp',
              contractId: id,
            ),
          );
        }
      }
    }
    var selectedBalance = BigInt.zero;
    for (var i = 0; i < inputs.length; i++) {
      final input = inputs[i],
          p = selectedParents[i],
          vout = input['outputIndex'] as int;
      final u = output(
        p,
        vout,
        input['classification'],
        script: input['script'],
        value: '${input['satoshis']}',
        contractId: input['classification'] == 'ft' ? ftId : id,
      );
      if (!utxos.any(
        (existing) =>
            existing['txid'] == u['txid'] && existing['vout'] == u['vout'],
      )) {
        utxos.add(u);
      }
      if (!remove || input['classification'] == 'ftlp') {
        selectedBalance += BigInt.parse(input['balance']);
      }
      keep(p);
      for (final g in grandparents[i]) {
        keep(g['parent'] as Map<String, dynamic>);
      }
    }
    need(
      (!sell && !remove) || selectedBalance >= BigInt.parse(amount),
      'POOL2_SELECTED_BALANCE',
    );
    need(
      !maintenance || selectedBalance > BigInt.zero,
      'POOL2_SELECTED_BALANCE',
    );
    need(
      (maintenance && !mergeFt) ||
          utxos.any((u) => u['classification'] == 'pool-ft'),
      'POOL2_HELD_FT_MISSING',
    );
    need(
      utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
          utxos.length,
      'POOL2_DUPLICATE_MATERIAL',
    );
    need(
      1 + utxos.where((u) => u['classification'] != 'native').length <= 128,
      'POOL2_INPUT_BUDGET',
    );
    payload['parents'] = orderedParents.values.toList();
    payload['contracts'] = [
      {
        'contractId': ftId,
        'family': 'ft',
        'protocolVersion': '4.0',
        'creationTxid': ftId,
        'indexedFungible': {...indexedFt, 'totalSupply': uintString(ft['amount'])},
        'currentOutpoint': {
          'txid': inputs.first['txid'],
          'vout': inputs.first['outputIndex'],
        },
      },
      {
        'contractId': id,
        'family': 'pool',
        'protocolVersion': '2.0',
        'creationTxid': id,
        'indexedPool': {'ftCodeScript': indexedFt['codeScript'], 'ftTapeScript': indexedFt['tapeScript']},
        'currentOutpoint': {'txid': current['txid'], 'vout': 0},
      },
    ];
    return Pool2PreparedMaterial._(
      {'payload': payload, 'snapshotHash': hashJson(payload)},
      copied(poolConfig),
      hashJson(request),
      minConfirmations,
    );
  }
}

int _integer(Object? v) {
  final n = BigInt.parse(uintString(v));
  need(n <= BigInt.from(9007199254740991), 'POOL2_SAFE_INTEGER');
  return n.toInt();
}

String _hex(Object? v) {
  need(
    v is String &&
        v.isNotEmpty &&
        v.length <= 2 * 1024 * 1024 &&
        RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(v),
    'POOL2_HEX',
  );
  return v as String;
}

String _display(String raw, int decimals) {
  if (decimals == 0) return raw;
  final p = raw.padLeft(decimals + 1, '0'),
      split = p.length - decimals,
      fraction = p.substring(split).replaceFirst(RegExp(r'0+$'), '');
  return fraction.isEmpty
      ? p.substring(0, split)
      : '${p.substring(0, split)}.$fraction';
}

List<Map<String, dynamic>> _sufficient(
  List<Map<String, dynamic>> rows,
  String amount,
) {
  final enough =
      rows
          .where((r) => BigInt.parse(r['balance']) >= BigInt.parse(amount))
          .toList()
        ..sort((a, b) {
          final amount = BigInt.parse(
            a['balance'],
          ).compareTo(BigInt.parse(b['balance']));
          if (amount != 0) return amount;
          final tx = (a['txid'] as String).compareTo(b['txid']);
          return tx != 0
              ? tx
              : (a['outputIndex'] as int).compareTo(b['outputIndex']);
        });
  return enough.isEmpty ? rows : [enough.first];
}

int _ascendingAsset(Map<String, dynamic> a, Map<String, dynamic> b) {
  final balance = BigInt.parse(
    a['balance'],
  ).compareTo(BigInt.parse(b['balance']));
  if (balance != 0) return balance;
  final txid = (a['txid'] as String).compareTo(b['txid']);
  return txid != 0
      ? txid
      : (a['outputIndex'] as int).compareTo(b['outputIndex']);
}

// The official index omits lock_time for ordinary, unlocked Pool2 LPs.
// Missing is not interchangeable with malformed or locked-LP lock metadata.
int pool2LpLockTime(Map row, {required bool locked}) {
  if (!row.containsKey('lock_time')) {
    need(!locked, 'POOL2_LOCK_TIME_MISSING');
    return 0;
  }
  final value = _integer(row['lock_time']);
  need(value <= 0xffffffff, 'POOL2_LOCK_TIME_BOUND');
  return value;
}

// Shared by the ordinary material reader and maintenance index preparation.
// Index shape validation is not authorization or proof of unspentness.
Map<String, dynamic> pool2IndexInfo(Map data) {
  final result = <String, dynamic>{
    'ftAPartialHash': hash32(data['ft_a_partial_hash']),
    'ftLpPartialHash': hash32(data['ft_lp_partial_hash']),
    'ftContractId': hash32(data['ft_contract_id']),
    'lpBalance': uintString(data['lp_balance']),
    'tbcBalance': uintString(data['tbc_balance']),
    'tokenBalance': uintString(data['token_balance']),
    'value': uintString(data['value']),
    'poolCodeScript': _hex(data['pool_code_script']),
    'txid': hash32(data['txid']),
    'serviceFeeRate': _integer(data['service_fee_rate']),
    'serviceProvider': data['service_provider'],
    'version': _integer(data['version']),
    'vout': _integer(data['vout']),
  };
  need(
    result['version'] == 2 &&
        result['vout'] == 0 &&
        result['serviceProvider'] is String &&
        (result['serviceProvider'] as String).isNotEmpty &&
        result['serviceProvider'].length <= 256,
    'POOL2_INFO',
  );
  return result;
}
