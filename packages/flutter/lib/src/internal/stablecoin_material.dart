// Holder-only read plan matching frozen Kit. The Engine authenticates scripts,
// issuer/owner and signatures; these parsers only select required read material.
import '../configuration.dart';
import '../host_environment.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'utxo_pages.dart';
import 'tbc20_material.dart';

const coinTemplateRevision =
    'c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3';

int coinTapeLockTime(String script) {
  final b = unhex(script);
  need(
    b.length >= 66 &&
        b.length <= 127 &&
        hex(b.sublist(0, 3)) == '006a30' &&
        hex(b.sublist(b.length - 9)) == '544243323054415045' &&
        b[b.length - 15] == 4 &&
        b[b.length - 10] == 9,
    'COIN_LOCK_ENVELOPE',
  );
  var n = 0;
  for (var i = 0; i < 4; i++) n |= b[b.length - 14 + i] << (8 * i);
  return n;
}

final class StablecoinMaterialReader {
  StablecoinMaterialReader({
    required this.network,
    required this.read,
    required this.readHistory,
    this.rememberParent,
    required this.keyless,
  });
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final void Function(Map<String, dynamic>)? rememberParent;
  final KeylessCall keyless;

  List<Map<String, dynamic>> _index(Map data, {required bool token}) {
    final rows = data['utxos'];
    need(rows is List && rows.length <= 10000, 'STABLE_INDEX');
    final seen = <String>{}, result = <Map<String, dynamic>>[];
    for (final row in rows) {
      need(row is Map, 'UTXO_ROW');
      final id = hash32(row['txid']),
          v = BigInt.parse(uintString(row['index']));
      final value = uintString(row[token ? 'tbc_value' : 'value']),
          amount = token ? uintString(row['ft_value']) : null;
      need(
        v <= BigInt.from(0xffffffff) &&
            seen.add('$id:$v') &&
            value != '0' &&
            (!token || amount != '0'),
        'UTXO_INDEX_IDENTITY',
      );
      final height = row['height'];
      need(token || height != null, 'NATIVE_HEIGHT');
      result.add({
        'txid': id,
        'vout': v.toInt(),
        'satoshis': value,
        if (token) 'ftAmount': amount,
        if (height != null)
          'height': height == -1 || height == '-1' ? '0' : uintString(height),
      });
    }
    result.sort(_outpoint);
    return result;
  }

  int _outpoint(Map a, Map b) {
    final c = (a['txid'] as String).compareTo(b['txid']);
    return c != 0 ? c : (a['vout'] as int).compareTo(b['vout']);
  }

  String? _confirmations(Map row, BigInt? tip, [Map? tx]) {
    if (row['height'] == null) return tx?['confirmations'] as String?;
    final h = BigInt.parse(row['height']);
    if (tip == null) return h == BigInt.zero ? '0' : tx?['confirmations'] as String?;
    need(h <= tip, 'FUTURE_UTXO');
    return h == BigInt.zero ? '0' : '${tip - h + BigInt.one}';
  }

  Future<Map<String, dynamic>> _decoded(String id) async {
    final d = await read('/api/tbc/decode/txid/${hash32(id)}'),
        p = inspectTransaction(d['hex'], id);
    need(
      d['txid'] == id &&
          d['vout'] is List &&
          (d['vout'] as List).length == (p['outputs'] as List).length,
      'DECODE_IDENTITY',
    );
    final outputs = p['outputs'] as List;
    for (var i = 0; i < outputs.length; i++) {
      final row = d['vout'][i],
          script = row['scriptPubKey'],
          addresses = script['addresses'] ?? [];
      need(
        uintString(row['n']) == '$i' &&
            script['hex'] == outputs[i]['scriptPubKey'] &&
            (row['valueSat'] == null ||
                uintString(row['valueSat']) == outputs[i]['satoshis']) &&
            addresses is List &&
            addresses.every((a) => a is String),
        'DECODE_OUTPUT',
      );
    }
    final confirmations = uintString(d['confirmations']);
    rememberParent?.call(p);
    return {...p, 'confirmations': confirmations};
  }

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
    final htlc =
        intent is Map &&
        intent['type'] == 'tbc-htlc-lock' &&
        intent['assetStandard'] == 'tbc20-stablecoin' &&
        !intent.containsKey('preimage');
    need(
      intent is Map &&
          (htlc ||
              [
                'tbc20Stablecoin.transfer',
                'tbc20Stablecoin.merge',
              ].contains(intent['type'])),
      'STABLE_HOLDER_ONLY',
    );
    final id = hash32(intent['contractId']),
        merge = intent['type'] == 'tbc20Stablecoin.merge',
        floor = BigInt.parse(uintString(minConfirmations));
    final receivers = intent['receivers'] as List?;
    final amount =
        merge
            ? BigInt.zero
            : receivers == null
            ? BigInt.parse(uintString(intent['amount']))
            : receivers.fold<BigInt>(
              BigInt.zero,
              (a, r) => a + BigInt.parse(uintString(r['amount'])),
            );
    need(merge || amount > BigInt.zero, 'STABLE_AMOUNT');
    final requested = request['constraints']?['inputOutpoints'] as List?;
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
    bool wanted(Map r) =>
        requested == null ||
        requested.any((p) => p['txid'] == r['txid'] && p['vout'] == r['vout']);
    Future<Map<String, dynamic>>? tipRead;
    Future<Map<String, dynamic>> readTip() => tipRead ??= read('/api/tbc/nodeinfo');
    if (floor > BigInt.zero || htlc) readTip().ignore();
    final nativeRead = collectUtxoPages(
          read,
          '/api/tbc/utxo/address/${account['address']}',
          maxRows: 256,
        ),
        tokenRead = read(
          '/api/tbc/stablecoin/utxo/combinescript/${owner['publicKeyHash']}00/stablecoinid/$id',
        ),
        infoFuture = read('/api/tbc/stablecoin/info/stablecoinid/$id');
    for (final f in [nativeRead, tokenRead, infoFuture]) {
      f.ignore();
    }
    final decoded = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> decode(String at) =>
        decoded.putIfAbsent(at, () => _decoded(at));
    try {
      final info = await infoFuture;
      need(info['stablecoin_id'] == id && info['utxo'] is Map &&
          uintString(info['utxo']['vout']) == '0', 'STABLE_STATE_IDENTITY');
      hash32(info['utxo']['txid']);
      for (final field in ['code_script', 'tape_script']) {
        final value = info[field];
        need(value is String && value.isNotEmpty && value.length <= 131072 &&
            value.length.isEven && RegExp(r'^[0-9a-f]+$').hasMatch(value), 'STABLE_INDEX_SCRIPT');
      }
      final identities = keyless('inspectTokenMaterial', {'phase': 'identifyPairs', 'pairs': [{
        'codeScript': info['code_script'], 'tapeScript': info['tape_script'],
        'codeSatoshis': 500, 'tapeSatoshis': 0,
      }]})['identities'];
      need(identities is List && identities.length == 1 && identities[0] is Map &&
          identities[0]['family'] == 'tbc20Stablecoin' &&
          ['current', 'historical'].contains(identities[0]['generation']), 'STABLE_INDEX_TEMPLATE');
      final current = identities[0]['generation'] == 'current';
      final indexedFungible = {
        'codeScript': info['code_script'], 'tapeScript': info['tape_script'],
        'totalSupply': uintString(info['supply']),
      };
      need(!htlc || current, 'HTLC_CURRENT_TOKEN_REQUIRED');
      need(current || requested == null, 'HISTORICAL_EXPLICIT_INPUTS');
      final candidates = _index(await tokenRead, token: true),
          selected = <Map<String, dynamic>>[],
          loaded = <String, Map<String, dynamic>>{};
      Future<Map<String, dynamic>> load(String at) =>
          floor == BigInt.zero ||
                  candidates
                      .where((r) => r['txid'] == at)
                      .every((r) => r['height'] != null)
              ? readHistory(at)
              : decode(at);
      var total = BigInt.zero;
      if (current) {
        final remaining = candidates.where(wanted).toList();
        var inspected = 0;
        while (remaining.isNotEmpty &&
            (merge || requested != null || total < amount)) {
          final batch = <Map<String, dynamic>>[];
          var provisional = total;
          final capacity = 5 - selected.length;
          while (remaining.isNotEmpty &&
              batch.length < (capacity < 1 ? 1 : capacity) &&
              (merge || requested != null || provisional < amount)) {
            final c = remaining.removeAt(0);
            need(++inspected <= 128, 'COIN_DISCOVERY_BOUND');
            if (floor > BigInt.zero && c['height'] != null) {
              final count =
                  _confirmations(
                    c,
                    BigInt.parse(uintString((await readTip())['blocks'])),
                  )!;
              if (BigInt.parse(count) < floor) continue;
            }
            provisional += BigInt.parse(c['ftAmount']);
            batch.add(c);
          }
          await Future.wait(
            batch
                .map((c) => c['txid'] as String)
                .toSet()
                .where((at) => !loaded.containsKey(at))
                .map((at) async {
                  loaded[at] = await load(at);
                }),
          );
          for (final c in batch) {
            final p = loaded[c['txid']]!;
            if (floor > BigInt.zero && c['height'] == null) {
              need(p['confirmations'] != null, 'CONFIRMATIONS_UNKNOWN');
              if (BigInt.parse(p['confirmations']) < floor) continue;
            }
            final out = p['outputs'] as List, index = c['vout'] as int;
            need(
              index + 1 < out.length &&
                  out[index]['satoshis'] == '500' &&
                  out[index + 1]['satoshis'] == '0',
              'COIN_PAIR',
            );
            final lock = coinTapeLockTime(out[index + 1]['scriptPubKey']);
            if (lock != 0) {
              final code = keyless('inspectTokenMaterial', {'phase': 'inspectCodes', 'scripts': [out[index]['scriptPubKey']]})['codes'][0];
              need(code is Map && code['standardId'] == 'tbc20-stablecoin', 'COIN_TEMPLATE');
              final adminHint = code['adminPubkeyHash'] == owner['publicKeyHash'];
              if (!adminHint) {
                final tip = await readTip();
                need(
                  lock < 500000000 || tip['mediantime'] != null,
                  'COIN_MEDIAN_TIME',
                );
                final mature =
                    lock < 500000000
                        ? BigInt.from(lock) <=
                            BigInt.parse(uintString(tip['blocks']))
                        : BigInt.from(lock) <
                            BigInt.parse(uintString(tip['mediantime']));
                if (!mature) {
                  need(requested == null, 'EXPLICIT_COIN_LOCKED');
                  continue;
                }
              }
            }
            need(selected.length < 5, 'COIN_ASSET_BOUND');
            selected.add(c);
            total += BigInt.parse(c['ftAmount']);
          }
        }
      } else {
        int ascending(Map a, Map b) {
          final c = BigInt.parse(
            a['ftAmount'],
          ).compareTo(BigInt.parse(b['ftAmount']));
          return c != 0 ? c : _outpoint(a, b);
        }

        candidates.sort(ascending);
        if (merge) {
          selected.addAll(candidates.take(5));
        } else {
          final enough = candidates.where(
            (c) => BigInt.parse(c['ftAmount']) >= amount,
          );
          if (enough.isNotEmpty)
            selected.add(enough.first);
          else {
            candidates.sort((a, b) {
              final c = BigInt.parse(
                b['ftAmount'],
              ).compareTo(BigInt.parse(a['ftAmount']));
              return c != 0 ? c : _outpoint(a, b);
            });
            for (final c in candidates) {
              if (selected.length >= 127 || total >= amount) break;
              selected.add(c);
              total += BigInt.parse(c['ftAmount']);
            }
          }
        }
        total = selected.fold(
          BigInt.zero,
          (sum, c) => sum + BigInt.parse(c['ftAmount']),
        );
        await Future.wait(
          selected.map((c) => c['txid'] as String).toSet().map((at) async {
            loaded[at] = await load(at);
          }),
        );
      }
      need(
        selected.length >= (merge ? 2 : 1) && total >= amount,
        'STABLE_INSUFFICIENT',
      );
      // The selected parents already identify the exact unlock dependencies.
      // Read them while independent funding/issuance work is still pending;
      // consumption and every validation remain below in deterministic order.
      final directReads = <String, Future<Map<String, dynamic>>>{};
      for (final c in selected) {
        final refs = (current ? tbc20References : legacyFtReferences)(
          loaded[c['txid']]!,
          c['vout'],
        );
        for (final at in refs) {
          if (at == '0' * 64 || at == id || loaded.containsKey(at)) continue;
          final pending = directReads.putIfAbsent(at, () => readHistory(at));
          pending.ignore();
        }
      }
      final values = await Future.wait<dynamic>([
            tipRead ?? Future<Map<String, dynamic>?>.value(null),
            nativeRead,
            infoFuture,
          ]),
          tip = values[0] as Map?,
          height = tip == null ? null : BigInt.parse(uintString(tip['blocks']));
      if (tip != null) hash32(tip['bestblockhash']);
      final allNative = _index(values[1], token: false);
      need(allNative.length <= 256, 'NATIVE_CANDIDATE_BOUND');
      for (final n in allNative) {
        _confirmations(n, height);
      }
      final native = [
        for (final n in allNative.where(wanted))
          {
            'txid': n['txid'],
            'vout': n['vout'],
            'satoshis': n['satoshis'],
            'scriptPubKey': owner['scriptPubKey'],
            if (_confirmations(n, height) != null) 'confirmations': _confirmations(n, height),
            'classification': 'native',
          },
      ];
      need(
        native.isNotEmpty && selected.length + 1 <= 128,
        'STABLE_NATIVE_FUNDING',
      );
      final asset = <Map<String, dynamic>>[],
          parents = <String, Map<String, dynamic>>{};
      for (final c in selected) {
        final p = loaded[c['txid']]!,
            out = p['outputs'] as List,
            index = c['vout'] as int,
            count = _confirmations(c, height, p);
        need(
          index < out.length &&
              out[index]['satoshis'] == c['satoshis'] &&
              (floor == BigInt.zero || count != null),
          'STABLE_PARENT',
        );
        asset.add({
          'txid': c['txid'],
          'vout': index,
          'satoshis': c['satoshis'],
          'scriptPubKey': out[index]['scriptPubKey'],
          if (count != null) 'confirmations': count,
          'classification': 'stablecoin',
          'contractId': id,
        });
        parents[p['txid']] = p;
      }
      Future<Map<String, dynamic>> include(
        String at, {
        Future<Map<String, dynamic>>? prefetched,
      }) async {
        hash32(at);
        final known = parents[at];
        if (known != null) return known;
        need(parents.length < 1024, 'STABLE_ANCESTRY_BOUND');
        final p = await (prefetched ?? directReads[at] ?? readHistory(at));
        parents[at] = p;
        return p;
      }

      if (current) {
        final refs = <String>{};
        for (final c in selected) {
          final p = loaded[c['txid']]!;
          coinTapeLockTime(p['outputs'][c['vout'] + 1]['scriptPubKey']);
          refs.addAll(tbc20References(p, c['vout']));
        }
        refs.removeWhere((at) => at == '0' * 64 || parents.containsKey(at));
        // Future.wait preserves reference order, independent of completion order.
        for (final p in await Future.wait(
          refs.map((at) => directReads[at] ?? readHistory(at)),
        )) {
          parents[p['txid']] = p;
        }
      } else {
        // Bind trusted API identity/supply; no historical issuance or funding
        // audit. Direct SDK unlock proofs and current spend validation remain.
        final references = <String>{};
        for (final c in selected) {
          references.addAll(legacyFtReferences(loaded[c['txid']]!, c['vout']));
        }
        for (final p in await Future.wait(references.map(include))) {
          parents[p['txid']] = p;
        }
      }
      final utxos = [...native, ...asset];
      need(
        utxos.map((u) => '${u['txid']}:${u['vout']}').toSet().length ==
            utxos.length,
        'SNAPSHOT_DUPLICATE_INPUT',
      );
      final last = asset.last,
          payload = <String, dynamic>{
            'version': '1.0',
            'snapshotId': snapshotId,
            'chainId': network.chainId,
            if (tip != null) 'block': {
              'height': '$height',
              'hash': tip['bestblockhash'],
              if (current && tip['mediantime'] != null)
                'medianTimePast': uintString(tip['mediantime']),
            },
            'capturedAt': tbcProtocolTimestamp(now),
            'expiresAt': tbcProtocolTimestamp(
              now.add(const Duration(minutes: 2)),
            ),
            'account': account,
            'utxos': utxos,
            'parents': [
              for (final p in parents.values)
                {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
            ],
            'contracts': [
              {
                'contractId': id,
                'family': 'stablecoin',
                'protocolVersion': current ? 'coin' : '4.0',
                if (current) 'standardId': 'tbc20-stablecoin',
                if (current) 'templateRevision': coinTemplateRevision,
                if (current) 'genesisOutpoint': {'txid': id, 'vout': 0},
                'creationTxid': id,
                'indexedFungible': indexedFungible,
                'currentOutpoint': {'txid': last['txid'], 'vout': last['vout']},
              },
            ],
          };
      return {'payload': payload, 'snapshotHash': hashJson(payload)};
    } finally {
      await Future.wait(
        [if (tipRead != null) tipRead!, nativeRead, tokenRead, infoFuture].map((f) async {
          try {
            await f;
          } catch (_) {}
        }),
      );
    }
  }
}
