// Frozen LOP read orchestration. Rust owns script recognition and construction;
// this adapter supplies fresh exact availability and bounded immutable ancestry.
import '../configuration.dart';
import '../host_environment.dart';
import 'nft_material.dart' show ApiTxoStatus;
import 'protocol_codec.dart';
import 'stablecoin_material.dart' show coinTemplateRevision;
import 'tbc20_material.dart';
import 'transaction_read.dart';
import 'utxo_pages.dart';

const lopProfiles = ['tbc-lop-create', 'tbc-lop-cancel', 'tbc-lop-match'];

final class LopMaterialReader {
  LopMaterialReader({
    required this.network,
    required this.read,
    required this.status,
    required this.history,
    required this.keyless,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final ApiTxoStatus status;
  final Tbc20MaterialReader history;
  final KeylessCall keyless;

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
      'LOP_ACCOUNT',
    );
    final i = request['intent'];
    need(i is Map && lopProfiles.contains(i['type']), 'LOP_PROFILE');
    final create = i['type'] == 'tbc-lop-create',
        cancel = i['type'] == 'tbc-lop-cancel';
    final floor = BigInt.parse(uintString(minConfirmations));
    Map<String, dynamic> point(dynamic p) {
      need(
        p is Map &&
            p.length == 2 &&
            p['vout'] is int &&
            p['vout'] >= 0 &&
            p['vout'] <= 0xffffffff,
        'LOP_POINT',
      );
      return {'txid': hash32(p['txid']), 'vout': p['vout']};
    }

    String pointKey(Map p) => '${p['txid']}:${p['vout']}';
    final requestedRaw = request['constraints']?['inputOutpoints'];
    final Set<String>? selected;
    if (requestedRaw == null) {
      selected = null;
    } else {
      need(
        requestedRaw is List &&
            requestedRaw.isNotEmpty &&
            requestedRaw.length <= 128,
        'LOP_INPUTS',
      );
      selected = {for (final p in requestedRaw) pointKey(point(p))};
      need(selected.length == requestedRaw.length, 'LOP_INPUTS');
    }
    bool allowed(Map p) => selected == null || selected.contains(pointKey(p));
    final hints = <Map<String, dynamic>>[], targets = <Map<String, dynamic>>[];
    BigInt? wanted;
    if (create) {
      final order = i['order'];
      need(
        order is Map &&
            ['buy', 'sell'].contains(order['side']) &&
            ['native-token', 'token-token'].contains(order['market']) &&
            (order['market'] == 'token-token') == (order['assetB'] != null),
        'LOP_ORDER',
      );
      final assets = [
        order['assetA'],
        if (order['assetB'] != null) order['assetB'],
      ];
      final ids = <String>{};
      for (final a in assets) {
        need(
          a is Map &&
              ['tbc20-standard', 'tbc20-stablecoin'].contains(a['standard']),
          'LOP_ASSET',
        );
        need(ids.add(hash32(a['contractId'])), 'LOP_ASSET');
      }
      final volume = BigInt.parse(uintString(order['saleVolume'])),
          price = BigInt.parse(uintString(order['unitPrice']));
      need(
        volume > BigInt.zero &&
            price > BigInt.zero &&
            volume <= BigInt.parse('9223372036854775807') &&
            price <= BigInt.parse('9223372036854775807'),
        'LOP_AMOUNT',
      );
      final nativeSell =
          order['side'] == 'sell' && order['market'] == 'native-token';
      final escrow =
          nativeSell
              ? null
              : order['side'] == 'buy'
              ? order['assetB'] ?? order['assetA']
              : order['assetA'];
      wanted =
          order['side'] == 'sell'
              ? volume
              : volume * price ~/ BigInt.from(1000000);
      need(
        wanted > BigInt.zero &&
            (nativeSell || wanted <= BigInt.parse('9223372036854775807')),
        'LOP_AMOUNT',
      );
      for (final a in assets)
        hints.add({
          ...copied(a),
          'escrow': a['contractId'] == escrow?['contractId'],
        });
    } else {
      final raw = i['targetOutpoints'];
      need(raw is List && raw.length == (cancel ? 1 : 2), 'LOP_TARGETS');
      for (final p in raw) targets.add(point(p));
      need(
        targets.map(pointKey).toSet().length == targets.length,
        'LOP_TARGETS',
      );
    }
    final parents = <String, Map<String, dynamic>>{},
        contracts = <String, Map<String, dynamic>>{};
    final utxos = <Map<String, dynamic>>[],
        fresh = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> parent(String id) async {
      if (parents.containsKey(id)) return parents[id]!;
      final p = await (fresh[id] ?? history.parent(hash32(id)));
      parents[id] = p;
      return p;
    }

    Map<String, dynamic> raw(Map p) => {
      'txid': p['txid'],
      'rawTransaction': p['rawTransaction'],
    };
    Map<String, dynamic> inspect(Map<String, dynamic> input) {
      final r = keyless('inspectLopMaterial', input);
      need(r['error'] == null, 'LOP_INSPECTION');
      return r;
    }

    Map<String, dynamic> asset(Map p, int vout) {
      final a = inspect({
        'phase': 'inspectAsset',
        'parent': raw(p),
        'vout': vout,
      });
      need(
        a['txid'] == p['txid'] &&
            a['vout'] == vout &&
            ['tbc20-standard', 'tbc20-stablecoin'].contains(a['standardId']),
        'LOP_ASSET',
      );
      uintString(a['balance']);
      final deps = a['dependencies'];
      need(deps is List && deps.length <= 6, 'LOP_DEPENDENCIES');
      for (final d in deps) point(d);
      return a;
    }

    Future<void> anchor(String id, String standard, [Map? current]) async {
      final indexed = await readIndexedFungible(read, keyless, id,
          coin: standard == 'tbc20-stablecoin');
      need(indexed['identity']['generation'] == 'current', 'LOP_CURRENT_TOKEN');
      // Identity-only market metadata is not a spend or an unspentness claim.
      // Current spending rows still carry their real selected outpoints.
      current ??= {'txid': id, 'vout': 0};
      final previous = contracts[id];
      need(
        previous == null || previous['standardId'] == standard,
        'LOP_STANDARD_CONFLICT',
      );
      if (previous != null) {
        final p = previous['currentOutpoint'];
        final c = (p['txid'] as String).compareTo(current['txid']);
        if (c < 0 || c == 0 && p['vout'] <= current['vout']) return;
      }
      contracts[id] = {
        'contractId': id,
        'indexedFungible': indexed['indexedFungible'],
        'family': standard == 'tbc20-standard' ? 'ft' : 'stablecoin',
        'protocolVersion': standard == 'tbc20-standard' ? 'tbc20' : 'coin',
        'standardId': standard,
        'templateRevision':
            standard == 'tbc20-standard'
                ? tbc20TemplateRevision
                : coinTemplateRevision,
        'creationTxid': id,
        'genesisOutpoint': {'txid': id, 'vout': 0},
        'currentOutpoint': {'txid': current['txid'], 'vout': current['vout']},
      };
    }

    String? normalizedHeight(dynamic value) =>
        value == null
            ? null
            : (value == -1 || value == '-1' ? '0' : uintString(value));
    Map<String, dynamic>? observedTip;
    Future<Map<String, dynamic>>? pendingTip;
    Future<Map<String, dynamic>> observeTip() => pendingTip ??= read('/api/tbc/nodeinfo').then((tip) {
      uintString(tip['blocks']); hash32(tip['bestblockhash']);
      if(tip['mediantime'] != null) uintString(tip['mediantime']);
      return observedTip = tip;
    });
    final tipRead = floor > BigInt.zero ? observeTip() : Future<Map<String, dynamic>?>.value(null),
        nativeRead = collectUtxoPages(
          read,
          '/api/tbc/utxo/address/${account['address']}',
          maxRows: 128,
        );
    final pending = <Future<dynamic>>[tipRead, nativeRead];
    for (final f in pending) f.ignore();
    Future<String?> confirmation(String id, dynamic h, Map? tip) async {
      final height = normalizedHeight(h),
          observed = tip == null ? null : BigInt.parse(uintString(tip['blocks']));
      if (height != null) {
        need(observed == null || BigInt.parse(height) <= observed, 'LOP_HEIGHT');
        return height == '0'
            ? '0'
            : observed == null ? null : '${observed - BigInt.parse(height) + BigInt.one}';
      }
      if (floor == BigInt.zero) return null;
      final decoded = await fresh.putIfAbsent(id, () async {
        final p = await history.confirmedParent(id), old = parents[id];
        need(
          old == null || old['rawTransaction'] == p['rawTransaction'],
          'LOP_FRESH_PARENT',
        );
        parents[id] = p;
        return p;
      });
      need(decoded['confirmations'] != null, 'LOP_CONFIRMATIONS_UNKNOWN');
      return decoded['confirmations'];
    }

    Future<void> assetsWork() async {
      if (create) {
        await Future.wait(
          hints.map((hint) async {
            final id = hint['contractId'] as String,
                standard = hint['standard'] as String;
            if (hint['escrow'] != true) {
              await anchor(id, standard);
              return;
            }
            final path =
                standard == 'tbc20-standard'
                    ? '/api/tbc/ft/utxo/combinescript/${owner['publicKeyHash']}00/contract/$id'
                    : '/api/tbc/stablecoin/utxo/combinescript/${owner['publicKeyHash']}00/stablecoinid/$id';
            final values = await Future.wait([
              standard == 'tbc20-standard'
                  ? collectUtxoPages(read, path, maxRows: 128)
                  : read(path),
              tipRead,
              nativeRead,
            ]);
            final rows = values[0]!['utxos'], tip = values[1];
            need(rows is List && rows.length <= 128, 'LOP_INDEX_BOUND');
            final candidates = <Map<String, dynamic>>[], seen = <String>{};
            for (final row in rows) {
              final p = point({
                'txid': row['txid'],
                'vout': int.parse(uintString(row['index'])),
              });
              need(seen.add(pointKey(p)), 'LOP_DUPLICATE');
              final amount = uintString(row['ft_value']),
                  value = uintString(row['tbc_value']);
              need(amount != '0' && value != '0', 'LOP_INDEX');
              candidates.add({
                ...p,
                'balance': amount,
                'satoshis': value,
                if (row['height'] != null) 'height': row['height'],
              });
            }
            candidates.sort(_outpoint);
            var total = BigInt.zero;
            final chosen = <Map<String, dynamic>>[];
            for (final row in candidates) {
              if (!allowed(row) || selected == null && total >= wanted!)
                continue;
              final c = await confirmation(row['txid'], row['height'], tip);
              if (c != null && BigInt.parse(c) < floor) {
                need(selected == null, 'LOP_SELECTED_CONFIRMATIONS');
                continue;
              }
              final p = await parent(row['txid']), a = asset(p, row['vout']);
              need(
                a['standardId'] == standard &&
                    a['balance'] == row['balance'] &&
                    row['satoshis'] == '500' &&
                    a['controller'] == '${owner['publicKeyHash']}00',
                'LOP_HOLDER',
              );
              final lock = BigInt.parse(uintString(a['lockTime']));
              final time = lock == BigInt.zero ? null : await observeTip();
              final height = time == null ? null : BigInt.parse(uintString(time['blocks']));
              if (lock != BigInt.zero &&
                  (lock < BigInt.from(500000000)
                      ? lock > height!
                      : time!['mediantime'] == null ||
                          lock >=
                              BigInt.parse(uintString(time['mediantime'])))) {
                need(selected == null, 'LOP_IMMATURE_SELECTED');
                continue;
              }
              need(chosen.length < 5, 'LOP_ASSET_INPUT_BOUND');
              chosen.add(a);
              total += BigInt.parse(a['balance']);
              utxos.add({
                'txid': a['txid'],
                'vout': a['vout'],
                'satoshis': '500',
                'scriptPubKey': a['scriptPubKey'],
                'classification':
                    standard == 'tbc20-standard' ? 'ft' : 'stablecoin',
                'contractId': id,
                if (c != null) 'confirmations': c,
              });
            }
            need(chosen.isNotEmpty && total >= wanted!, 'LOP_INSUFFICIENT');
            await Future.wait([
              anchor(id, standard, chosen.first),
              for (final id in {
                for (final a in chosen)
                  for (final p in a['dependencies']) hash32(p['txid']),
              })
                parent(id),
            ]);
          }),
        );
      } else {
        final orders = await Future.wait(
          targets.asMap().entries.map((entry) async {
            final target = entry.value;
            final id = target['txid'] as String;
            // Cold targets need bytes regardless. Decode supplies both bytes
            // and fresh confirmations in one request. Warm targets defer fresh
            // status until we know whether the TXO index already has height.
            if (floor > BigInt.zero && !history.hasParent(id)) {
              fresh.putIfAbsent(id, () => history.confirmedParent(id));
            }
            final p = await parent(id);
            final order = inspect({
              'phase': 'inspectOrder',
              'parent': raw(p),
              'vout': target['vout'],
            });
            need(
              order['standardId'] == 'tbc-lop' &&
                  order['txid'] == target['txid'] &&
                  order['vout'] == target['vout'] &&
                  (cancel
                      ? order['ownerHash'] == owner['publicKeyHash']
                      : order['side'] == (entry.key == 0 ? 'buy' : 'sell')),
              'LOP_ORDER_ROLE',
            );
            return {'parent': p, 'order': order, 'target': target};
          }),
        );
        List<Map<String, dynamic>> orderPoints(Map order) => [
          copied(order['target']),
          if (order['order']['escrow'] != null)
            {
              'txid': order['target']['txid'],
              'vout': order['target']['vout'] + 1,
            },
        ];
        final points = orders.expand(orderPoints).toList();
        for (final p in points) point(p);
        need(
          points.every(allowed) &&
              points.map(pointKey).toSet().length == points.length,
          'LOP_PAIRED_INPUTS',
        );
        final values = await Future.wait([
          status([
            for (final p in points) {'txid': p['txid'], 'index': p['vout']},
          ]),
          tipRead,
          nativeRead,
        ]);
        final rows = values[0]!['txos'],
            tip = values[1],
            lookup = <String, Map>{},
            heights = <String, String>{};
        need(rows is List && rows.length == points.length, 'LOP_STATUS_COUNT');
        for (final row in rows) {
          final key = '${hash32(row['txid'])}:${uintString(row['index'])}';
          need(
            points.any((p) => pointKey(p) == key) &&
                !lookup.containsKey(key) &&
                row['spent'] == false,
            'LOP_STATUS',
          );
          lookup[key] = row;
          final h = normalizedHeight(row['height']);
          if (h != null) {
            need(
              heights[row['txid']] == null || heights[row['txid']] == h,
              'LOP_SIBLING_HEIGHT',
            );
            heights[row['txid']] = h;
          }
        }
        await Future.wait(
          orders.map((order) async {
            final a = (order['order'] as Map)['escrow'];
            for (final p in orderPoints(order)) {
              final row = lookup[pointKey(p)]!,
                  outputs = (order['parent'] as Map)['outputs'] as List;
              need(p['vout'] < outputs.length, 'LOP_OUTPUT');
              final output = outputs[p['vout']];
              need(
                uintString(row['value']) == output['satoshis'] &&
                    (row['scriptPubKey'] == null ||
                        row['scriptPubKey'] == output['scriptPubKey']),
                'LOP_OUTPUT',
              );
              final c = await confirmation(p['txid'], row['height'], tip);
              need(c == null || BigInt.parse(c) >= floor, 'LOP_CONFIRMATIONS');
              final escrow = p['vout'] != (order['target'] as Map)['vout'];
              utxos.add({
                ...p,
                'satoshis': output['satoshis'],
                'scriptPubKey': output['scriptPubKey'],
                'classification':
                    !escrow
                        ? 'lop'
                        : a['standardId'] == 'tbc20-standard'
                        ? 'ft'
                        : 'stablecoin',
                if (escrow) 'contractId': hash32(a['contractId']),
                if (c != null) 'confirmations': c,
              });
            }
            if (a != null) {
              if (uintString(a['lockTime']) != '0') await observeTip();
              final deps = a['dependencies'];
              need(deps is List && deps.length <= 6, 'LOP_DEPENDENCIES');
              for (final p in deps) point(p);
              await Future.wait([
                anchor(hash32(a['contractId']), a['standardId'], a),
                for (final id in {for (final p in deps) hash32(p['txid'])})
                  parent(id),
              ]);
            }
          }),
        );
      }
    }

    final work = assetsWork();
    pending.add(work);
    work.ignore();
    try {
      final values = await Future.wait<dynamic>([tipRead, nativeRead, work]);
      final tip = observedTip, rows = values[1]['utxos'];
      need(rows is List && rows.length <= 128, 'LOP_NATIVE_BOUND');
      final funding = <Map<String, dynamic>>[], seen = <String>{};
      for (final row in rows) {
        final p = point({
          'txid': row['txid'],
          'vout': int.parse(uintString(row['index'])),
        });
        need(seen.add(pointKey(p)), 'LOP_NATIVE_DUPLICATE');
        final value = uintString(row['value']);
        need(value != '0', 'LOP_NATIVE_VALUE');
        if (!allowed(p)) continue;
        final c = await confirmation(p['txid'], row['height'], tip);
        if (c != null && BigInt.parse(c) < floor) continue;
        funding.add({
          ...p,
          'satoshis': value,
          'scriptPubKey': owner['scriptPubKey'],
          'classification': 'native',
          if (c != null) 'confirmations': c,
        });
      }
      need(funding.isNotEmpty, 'LOP_NATIVE_MISSING');
      final all = [...funding, ...utxos]..sort(_outpoint);
      need(
        all.length <= 128 && all.map(pointKey).toSet().length == all.length,
        'LOP_INPUT_BOUND',
      );
      final parentRows =
          parents.values.toList()
            ..sort((a, b) => (a['txid'] as String).compareTo(b['txid']));
      final contractRows =
          contracts.values.toList()..sort(
            (a, b) => (a['contractId'] as String).compareTo(b['contractId']),
          );
      final payload = {
        'version': '1.0',
        'snapshotId': snapshotId,
        'chainId': network.chainId,
        if (tip != null) 'block': {
          'height': uintString(tip['blocks']),
          'hash': hash32(tip['bestblockhash']),
          if (tip['mediantime'] != null)
            'medianTimePast': uintString(tip['mediantime']),
        },
        'capturedAt': tbcProtocolTimestamp(now),
        'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 2))),
        'account': {
          'chainId': account['chainId'],
          'accountId': account['accountId'],
          'address': account['address'],
          'publicKey': account['publicKey'],
        },
        'utxos': all,
        'parents': parentRows.map(raw).toList(),
        'contracts': contractRows,
      };
      return {'payload': payload, 'snapshotHash': hashJson(payload)};
    } finally {
      await Future.wait(
        pending.map(
          (f) => f.then<void>((_) {}, onError: (Object _, StackTrace __) {}),
        ),
      );
    }
  }
}

int _outpoint(Map a, Map b) {
  final c = (a['txid'] as String).compareTo(b['txid']);
  return c == 0 ? (a['vout'] as int).compareTo(b['vout']) : c;
}
