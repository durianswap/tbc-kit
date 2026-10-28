// Bounded unified FT holder transfer/merge read adapter. No signing, broadcast,
// private key, UI, or contract arithmetic. Rust is the final material validator.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import '../configuration.dart';
import 'utxo_pages.dart';
import 'chain_read_reply.dart';

typedef ApiRead = Future<Map<String, dynamic>> Function(String path);
typedef KeylessCall =
    Map<String, dynamic> Function(String operation, Map<String, dynamic> input);
const tbc20TemplateRevision =
    '0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84';

/// Identity supplied by the configured trusted API, checked locally against
/// exact Code/Tape templates. This is not an issuance-history proof. Callers
/// still supply the current inputs and direct ancestors required for unlocking.
Future<Map<String, dynamic>> readIndexedFungible(
  ApiRead read, KeylessCall keyless, String id, {required bool coin}
) async {
  hash32(id);
  final info = await read(coin
      ? '/api/tbc/stablecoin/info/stablecoinid/$id'
      : '/api/tbc/ft/info/contract/$id');
  if (coin) need(info['stablecoin_id'] == id, 'INDEX_COIN_ID');
  for (final field in ['code_script', 'tape_script']) {
    final value = info[field];
    need(value is String && value.isNotEmpty && value.length <= 131072 &&
        value.length.isEven && RegExp(r'^[0-9a-f]+$').hasMatch(value), 'INDEX_SCRIPT');
  }
  final identities = keyless('inspectTokenMaterial', {
    'phase': 'identifyPairs',
    'pairs': [{ 'codeScript': info['code_script'], 'tapeScript': info['tape_script'],
      'codeSatoshis': 500, 'tapeSatoshis': 0 }],
  })['identities'];
  need(identities is List && identities.length == 1 && identities[0] is Map &&
      identities[0]['family'] == (coin ? 'tbc20Stablecoin' : 'tbc20') &&
      ['current', 'historical'].contains(identities[0]['generation']), 'INDEX_TEMPLATE');
  final supply = uintString(info[coin ? 'supply' : 'amount']);
  need(supply != '0', 'INDEX_SUPPLY');
  return {'info': copyChainReadReply(info), 'identity': copied(identities[0]), 'indexedFungible': {
    'codeScript': info['code_script'], 'tapeScript': info['tape_script'], 'totalSupply': supply,
  }};
}

class Tbc20MaterialReader {
  Tbc20MaterialReader({
    required this.network,
    required this.read,
    required this.keyless,
    this.maxInputs = 128,
  }) {
    need(maxInputs >= 1 && maxInputs <= 256, 'INPUT_LIMIT');
  }
  final TbcNetworkConfiguration network;
  String get endpoint => network.apiOrigin;
  final ApiRead read;
  final KeylessCall keyless;
  final int maxInputs;
  // One reader belongs to one immutable network/source context. Fresh indices
  // and confirmations never enter this cache. Failed entries cannot poison it.
  final Map<String, Map<String, dynamic>> _immutable = {};
  int _retained = 0;
  final Map<String, Future<Map<String, dynamic>>> _pending = {};
  // Origin template hints only; Engine still authenticates full asset lineage.
  final Map<String, Map<String, dynamic>> _identified = {};
  bool hasParent(String id) => _immutable.containsKey(id);

  /// Only parsed, txid-verified bytes enter the cross-operation cache. Status
  /// such as confirmations is deliberately excluded and must be read afresh.
  void rememberParent(Map<String, dynamic> parent) {
    final id = hash32(parent['txid']), raw = parent['rawTransaction'] as String;
    final previous = _immutable[id];
    if (previous != null) {
      need(previous['rawTransaction'] == raw, 'IMMUTABLE_PARENT_CONFLICT');
      return;
    }
    while (_immutable.isNotEmpty &&
        (_immutable.length >= 256 ||
            _retained + raw.length > 16 * 1024 * 1024)) {
      final first = _immutable.keys.first;
      _retained -=
          (_immutable.remove(first)!['rawTransaction'] as String).length;
      _identified.remove(first);
    }
    _immutable[id] =
        frozen({
              'txid': id,
              'rawTransaction': raw,
              'inputs': parent['inputs'],
              'outputs': parent['outputs'],
              'locktime': parent['locktime'],
            })
            as Map<String, dynamic>;
    _retained += raw.length;
  }

  Future<Map<String, dynamic>> confirmedParent(String id) =>
      readConfirmedTransaction(read, id, remember: rememberParent);

  Future<Map<String, dynamic>> parent(String id) async {
    hash32(id);
    final cached = _immutable[id];
    if (cached != null) return cached;
    return _pending.putIfAbsent(id, () async {
      try {
        final value = await read('/api/tbc/txraw/txid/$id'),
            raw = value['txraw'];
        need(raw is String, 'RAW_TYPE');
        final parsed = inspectTransaction(raw, id);
        rememberParent(parsed);
        return _immutable[id]!;
      } finally {
        _pending.remove(id);
      }
    });
  }

  /// Shared immutable origin classification for metadata and holder preparation.
  /// This is a routing hint, never proof of unspentness or signing authority.
  Future<Map<String, dynamic>> fungibleOrigin(String id) async =>
      _fungibleOrigin(id, await parent(id));

  Map<String, dynamic> _fungibleOrigin(String id, Map<String, dynamic> origin) {
    final cached = _identified[id];
    if (cached != null) return cached;
    final hint = keyless('inspectTokenMaterial', {
      'phase': 'identifyOrigin',
      'contractId': id,
      'rawTransaction': origin['rawTransaction'],
    });
    need(
      hint.length == 4 &&
          ['tbc20', 'tbc20Stablecoin'].contains(hint['family']) &&
          ['current', 'historical'].contains(hint['generation']) &&
          hint['verification'] == 'origin-template' &&
          hint['assetIdentityVerified'] == false,
      'FUNGIBLE_ORIGIN',
    );
    if (_identified.length >= 256) _identified.remove(_identified.keys.first);
    return _identified[id] = frozen(hint) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> _decoded(String id) async {
    final data = await read('/api/tbc/decode/txid/${hash32(id)}');
    need(data['hex'] is String, 'DECODE_RAW');
    final parsed = inspectTransaction(data['hex'], id);
    need(data['txid'] == id, 'DECODE_IDENTITY');
    rememberParent(parsed);
    return {
      ...parsed,
      if (data['confirmations'] != null)
        'confirmations': uintString(data['confirmations']),
    };
  }

  List<Map<String, dynamic>> _index(Map data, {required bool token}) {
    final list = data['utxos'];
    need(list is List && list.length <= 10000, 'UTXO_INDEX');
    final seen = <String>{};
    final result = <Map<String, dynamic>>[];
    for (final row in list) {
      need(row is Map, 'UTXO_ROW');
      final id = hash32(row['txid']), v = uintString(row['index']);
      final index = BigInt.parse(v);
      need(index <= BigInt.from(0xffffffff), 'VOUT_RANGE');
      need(seen.add('$id:$v'), 'DUPLICATE_UTXO');
      final value = uintString(row[token ? 'tbc_value' : 'value']);
      need(value != '0', 'UTXO_ZERO');
      final height = row['height'];
      final amount = token ? uintString(row['ft_value']) : null;
      need(!token || amount != '0', 'TOKEN_ZERO');
      need(token || height != null, 'NATIVE_HEIGHT_UNKNOWN');
      result.add({
        'txid': id,
        'vout': index.toInt(),
        'satoshis': value,
        if (token) 'ftAmount': amount,
        if (height != null)
          'height': height == -1 || height == '-1' ? '0' : uintString(height),
      });
    }
    result.sort((a, b) {
      final c = (a['txid'] as String).compareTo(b['txid']);
      return c != 0 ? c : (a['vout'] as int).compareTo(b['vout'] as int);
    });
    return result;
  }

  String? _confirmations(Map row, BigInt? tip, [Map? decoded]) {
    final h = row['height'];
    if (h == null) return decoded?['confirmations'] as String?;
    final height = BigInt.parse(h);
    if (tip == null) return height == BigInt.zero ? '0' : decoded?['confirmations'] as String?;
    need(height <= tip, 'FUTURE_UTXO');
    return height == BigInt.zero ? '0' : '${tip - height + BigInt.one}';
  }

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    final addr = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['from'] == account['address'] &&
          request['chainId'] == account['chainId'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    final htlc =
        intent is Map &&
        intent['type'] == 'tbc-htlc-lock' &&
        intent['assetStandard'] == 'tbc20-standard' &&
        !intent.containsKey('preimage');
    need(
      intent is Map &&
          (htlc || ['tbc20.transfer', 'tbc20.merge'].contains(intent['type'])),
      'FUNGIBLE_PROFILE',
    );
    final contract = hash32(intent['contractId']);
    final merge = intent['type'] == 'tbc20.merge';
    final receivers = intent['receivers'] as List?;
    final amount =
        merge
            ? BigInt.zero
            : receivers == null
            ? BigInt.parse(uintString(intent['amount']))
            : receivers.fold<BigInt>(
              BigInt.zero,
              (total, row) => total + BigInt.parse(uintString(row['amount'])),
            );
    need(merge || amount > BigInt.zero, 'TOKEN_AMOUNT');
    final floor = BigInt.parse(uintString(minConfirmations));
    final constraints = (request['constraints'] ?? {}) as Map,
        requested = constraints['inputOutpoints'] as List?;
    bool selected(Map row) =>
        requested == null ||
        requested.any(
          (p) =>
              p is Map && p['txid'] == row['txid'] && p['vout'] == row['vout'],
        );
    if (requested != null) {
      need(
        requested.isNotEmpty && requested.length <= maxInputs,
        'REQUESTED_INPUTS',
      );
      final seen = <String>{};
      for (final p in requested) {
        hash32(p['txid']);
        need(
          p['vout'] is int &&
              p['vout'] >= 0 &&
              p['vout'] <= 0xffffffff &&
              seen.add('${p['txid']}:${p['vout']}'),
          'REQUESTED_INPUTS',
        );
      }
    }
    // Launch independent reads before origin parsing; collect all failures.
    final tipRead = floor > BigInt.zero || htlc ? read('/api/tbc/nodeinfo') : Future<Map<String, dynamic>?>.value(null),
        nativeRead = collectUtxoPages(
          read,
          '/api/tbc/utxo/address/${account['address']}',
          maxRows: 10000,
        ),
        tokenRead = collectUtxoPages(
          read,
          '/api/tbc/ft/utxo/combinescript/${addr['publicKeyHash']}00/contract/$contract',
          maxRows: 10000,
        ),
        infoRead = read('/api/tbc/ft/info/contract/$contract');
    for (final f in [tipRead, nativeRead, tokenRead, infoRead]) {
      f.ignore();
    }
    final freshDecoded = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> decoded(String id) =>
        freshDecoded.putIfAbsent(id, () => _decoded(id));
    try {
      final info = await infoRead;
      for (final field in ['code_script', 'tape_script']) {
        final value = info[field];
        need(value is String && value.isNotEmpty && value.length <= 131072 && value.length.isEven &&
            RegExp(r'^[0-9a-f]+$').hasMatch(value), 'FT_INDEX_SCRIPT');
      }
      final identities = keyless('inspectTokenMaterial', {'phase': 'identifyPairs', 'pairs': [{
        'codeScript': info['code_script'], 'tapeScript': info['tape_script'], 'codeSatoshis': 500, 'tapeSatoshis': 0,
      }]})['identities'];
      need(identities is List && identities.length == 1 && identities[0] is Map && identities[0]['family'] == 'tbc20', 'FUNGIBLE_INDEX');
      final hint = identities[0];
      final current = hint['generation'] == 'current';
      need(!htlc || current, 'HTLC_CURRENT_TOKEN_REQUIRED');
      need(current || requested == null, 'HISTORICAL_EXPLICIT_INPUTS');
      final selectedFuture = () async {
        var candidates = _index(await tokenRead, token: true);
        if (current && floor > BigInt.zero) {
          final tip = BigInt.parse(uintString((await tipRead)!['blocks'])),
              eligible = <Map<String, dynamic>>[];
          var accumulated = BigInt.zero, count = 0;
          for (final row in candidates) {
            if (!selected(row)) continue;
            Map? d;
            if (row['height'] == null) {
              need(++count <= maxInputs, 'CONFIRMATION_READ_BOUND');
              d = await decoded(row['txid']);
            }
            final n = _confirmations(row, tip, d);
            need(n != null, 'CONFIRMATIONS_UNKNOWN');
            if (BigInt.parse(n!) < floor) continue;
            eligible.add(row);
            accumulated += BigInt.parse(row['ftAmount']);
            if (!merge && requested == null && accumulated >= amount) break;
            if (htlc
                ? eligible.length >= (maxInputs < 5 ? maxInputs : 5)
                : eligible.length > maxInputs)
              break;
          }
          candidates = eligible;
        }
        final chosen = <Map<String, dynamic>>[];
        var total = BigInt.zero;
        if (!current) {
          int order(Map a, Map b) {
            final c = BigInt.parse(
              a['ftAmount'],
            ).compareTo(BigInt.parse(b['ftAmount']));
            if (c != 0) return c;
            final id = (a['txid'] as String).compareTo(b['txid']);
            return id != 0 ? id : (a['vout'] as int).compareTo(b['vout']);
          }

          candidates.sort(order);
          if (merge) {
            chosen.addAll(candidates.take(5));
          } else {
            final enough = candidates.where(
              (r) => BigInt.parse(r['ftAmount']) >= amount,
            );
            if (enough.isNotEmpty) {
              chosen.add(enough.first);
            } else {
              candidates.sort((a, b) {
                final c = BigInt.parse(
                  b['ftAmount'],
                ).compareTo(BigInt.parse(a['ftAmount']));
                return c != 0 ? c : order(a, b);
              });
              // Five bounds one on-chain FT transaction, not the Engine plan.
              // Read only enough selected inputs; Engine owns any dependent
              // consolidation. Reserve one input for native fee funding.
              var selectedAmount = BigInt.zero;
              for (final row in candidates) {
                if (chosen.length >= maxInputs - 1 || selectedAmount >= amount) break;
                if (BigInt.parse(row['ftAmount']) <= BigInt.zero) continue;
                chosen.add(row);
                selectedAmount += BigInt.parse(row['ftAmount']);
              }
            }
          }
          total = chosen.fold(
            BigInt.zero,
            (sum, r) => sum + BigInt.parse(r['ftAmount']),
          );
        }
        if (current) {
          for (final row in candidates) {
            if (!selected(row) ||
                (!merge && requested == null && total >= amount))
              continue;
            need(
              chosen.length <
                  (maxInputs < (htlc ? 5 : 128) ? maxInputs : (htlc ? 5 : 128)),
              'TOKEN_MATERIAL_BOUND',
            );
            chosen.add(row);
            total += BigInt.parse(row['ftAmount']);
          }
        }
        need(
          chosen.length >= (merge ? 2 : 1) && total >= amount,
          'TOKEN_INSUFFICIENT',
        );
        final parents = await Future.wait(
          chosen
              .map((r) => r['txid'] as String)
              .toSet()
              .map(
                (id) =>
                    floor == BigInt.zero ||
                            chosen
                                .where((r) => r['txid'] == id)
                                .every((r) => r['height'] != null)
                        ? parent(id)
                        : decoded(id),
              ),
        );
        return {'selected': chosen, 'parents': parents};
      }();
      selectedFuture.ignore();
      final values = await Future.wait<dynamic>([
        tipRead,
        nativeRead,
        selectedFuture,
      ]);
      final tip = values[0] as Map?,
          height = tip == null ? null : BigInt.parse(uintString(tip['blocks']));
      if (tip != null) hash32(tip['bestblockhash']);
      final allNative = _index(values[1] as Map, token: false);
      need(allNative.length <= 256, 'NATIVE_CANDIDATE_BOUND');
      for (final n in allNative) {
        _confirmations(n, height);
      }
      final native =
          allNative
              .where(selected)
              .map(
                (n) => {
                  'txid': n['txid'],
                  'vout': n['vout'],
                  'satoshis': n['satoshis'],
                  'scriptPubKey': addr['scriptPubKey'],
                  if (_confirmations(n, height) != null) 'confirmations': _confirmations(n, height),
                  'classification': 'native',
                },
              )
              .toList();
      need(current || native.isNotEmpty, 'HISTORICAL_NATIVE_FUNDING');
      final selection = values[2] as Map,
          chosen = selection['selected'] as List,
          parentMap = <String, Map>{
            for (final p in selection['parents']) p['txid'] as String: p as Map,
          };
      final token = <Map<String, dynamic>>[];
      for (final c in chosen) {
        final p = parentMap[c['txid']]!,
            outputs = p['outputs'] as List,
            index = c['vout'] as int;
        need(
          index < outputs.length && outputs[index]['satoshis'] == c['satoshis'],
          'TOKEN_PARENT_VALUE',
        );
        final conf = _confirmations(c, height, p);
        need(
          floor == BigInt.zero || conf != null,
          'TOKEN_CONFIRMATIONS_UNKNOWN',
        );
        token.add({
          'txid': c['txid'],
          'vout': index,
          'satoshis': c['satoshis'],
          'scriptPubKey': outputs[index]['scriptPubKey'],
          if (conf != null) 'confirmations': conf,
          'classification': 'ft',
          'contractId': contract,
        });
      }
      final direct = <String, Map>{
        ...parentMap,
      };
      final refs = <String>{
        for (final c in chosen)
          ...(current ? tbc20References : legacyFtReferences)(
            parentMap[c['txid']]!,
            c['vout'],
          ),
      };
      refs.removeWhere(
        (id) => id == List.filled(64, '0').join() || direct.containsKey(id),
      );
      for (final p in await Future.wait(refs.map(parent))) {
        direct[p['txid']] = p;
      }
      final capacity =
              htlc || !current || token.length > 6 ? 1 : 6 - token.length,
          used =
              (native.length < capacity ? native.length : capacity) +
              token.length;
      need(used <= maxInputs, 'INPUT_BUDGET');
      final utxos = [...native, ...token];
      need(
        utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
            utxos.length,
        'SNAPSHOT_DUPLICATE_INPUT',
      );
      final last = token.last,
          payload = <String, dynamic>{
            'version': '1.0',
            'snapshotId': snapshotId,
            'chainId': account['chainId'],
            if (tip != null) 'block': {
              'height': '$height',
              'hash': tip['bestblockhash'],
              if (htlc && tip['mediantime'] != null)
                'medianTimePast': uintString(tip['mediantime']),
            },
            'capturedAt': now.toUtc().toIso8601String(),
            'expiresAt':
                now.toUtc().add(const Duration(minutes: 2)).toIso8601String(),
            'account': account,
            'utxos': utxos,
            'parents': [
              for (final p in direct.values)
                {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
            ],
            'contracts': [
              {
                'contractId': contract,
                'family': 'ft',
                'protocolVersion': current ? 'tbc20' : '4.0',
                if (current) 'standardId': 'tbc20-standard',
                if (current) 'templateRevision': tbc20TemplateRevision,
                if (current) 'genesisOutpoint': {'txid': contract, 'vout': 0},
                'creationTxid': contract,
                'indexedFungible': {'codeScript': info['code_script'], 'tapeScript': info['tape_script'], 'totalSupply': uintString(info['amount'])},
                'currentOutpoint': {'txid': last['txid'], 'vout': last['vout']},
              },
            ],
          };
      return {'payload': payload, 'snapshotHash': hashJson(payload)};
    } finally {
      // Reads carry no side effects. Drain index errors on cancellation/failure;
      // invalidation of authority is enforced again before any plan/sign action.
      await Future.wait(
        [tipRead, nativeRead, tokenRead, infoRead].map((f) async {
          try {
            await f;
          } catch (_) {}
        }),
      );
    }
  }
}
