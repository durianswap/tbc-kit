// Current and historical holder review over one authenticated status plan.
// Administration, contract-held escrow, LOP and HTLC need their own verified
// material profiles. They must not fall through to this address-holder path.
import 'protocol_codec.dart';
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'reviewed_token.dart';
import 'reviewed_address.dart';
import 'reviewed_rows.dart';
import 'reviewed_historical_token.dart';
import 'reviewed_profiles.dart';
import 'tbc20_material.dart' show ApiRead;
import 'transaction_read.dart';

final _p2pkh = RegExp(r'^76a914([0-9a-f]{40})88ac$');

Future<Map<int, Map<String, dynamic>>> reviewFungibleHolderTransactions({
  required ReviewedRawPlan plan,
  required ReviewedStatusReader status,
  required List<List<Map<String, dynamic>>> verifiedInputs,
  required Map material,
  required Map account,
  required String chainId,
  required List<int> transactionIndexes,
  required ReviewedTokenCodec codec,
  required ApiRead read,
  required void Function() requireCurrent,
}) async {
  account = copied(account);
  final own = inspectAccount(account, expectedChainId: chainId);
  final rows = boundReviewedRows(
    plan: plan,
    status: status,
    verifiedInputs: verifiedInputs,
    transactionIndexes: transactionIndexes,
  );
  final scripts = <String>{};
  for (final row in rows) {
    scripts.addAll(
      (row['inputs'] as List).map((i) => i['scriptPubKey'] as String),
    );
    scripts.addAll(
      (row['transaction']['outputs'] as List).map(
        (i) => i['scriptPubKey'] as String,
      ),
    );
  }
  final flat = scripts.toList(),
      descriptors = codec.codes(flat),
      codes = {for (var i = 0; i < flat.length; i++) flat[i]: descriptors[i]};
  final dependencies = <String, Map<String, dynamic>>{},
      tokens = <List<Map<String, dynamic>>>[];
  final addressCache = <String, String>{
    own['publicKeyHash']!: account['address'],
  };
  String address(String hash) =>
      addressCache.putIfAbsent(hash, () => reviewedAddress(hash));
  List<List<Map<String, dynamic>>> sides(Map row) => [
    [
      for (final u in row['inputs'])
        {'script': u['scriptPubKey'], 'value': BigInt.from(u['satoshis'])},
    ],
    [
      for (final o in row['transaction']['outputs'])
        {'script': o['scriptPubKey'], 'value': BigInt.parse(o['satoshis'])},
    ],
  ];
  final profiles = <int, List?>{};
  void checkInput(Map row, int i, Map? code) {
    final associated = profiles[row['index']],
        script = row['inputs'][i]['scriptPubKey'];
    if (code != null) {
      need(
        (code['controller'] as String).endsWith('00'),
        'REVIEWED_HOLDER_CONTROLLER',
      );
      need(
        address((code['controller'] as String).substring(0, 40)) ==
            account['address'],
        'REVIEWED_HOLDER_OWNER',
      );
      if (associated != null) {
        if (code['generation'] == 'historical') {
          requireReviewedHolderTemplate(associated[i], account['publicKey']);
        } else {
          requireReviewedProofProfile(associated[i], code['standardId']);
        }
      }
    } else {
      need(
        _p2pkh.firstMatch(script)?.group(1) == own['publicKeyHash'],
        'REVIEWED_FEE_OWNER',
      );
      if (associated != null)
        requireReviewedProofProfile(associated[i], 'p2pkh');
    }
  }

  // Known ownership/profile failures retain the existing pre-read rejection.
  for (final row in rows) {
    final index = row['index'] as int;
    final List? profile =
        material['format'] != 'associated'
            ? null
            : index == 0
            ? material['request']['sourceUtxos']
            : material['request']['inputs'][index - 1];
    need(
      profile == null || profile.length == (row['inputs'] as List).length,
      'REVIEWED_HOLDER_PROFILE_COUNT',
    );
    profiles[index] = profile;
    for (var i = 0; i < (row['inputs'] as List).length; i++) {
      final script = row['inputs'][i]['scriptPubKey'] as String,
          code = codes[script];
      if (code != null || _p2pkh.hasMatch(script)) checkInput(row, i, code);
    }
  }
  // One dependency batch for both generations. An apparent historical marker
  // only schedules a read; exact frozen Rust recognition is still mandatory.
  for (final row in rows)
    for (final u in row['inputs'])
      if (codes[u['scriptPubKey']] != null ||
          reviewedHistoricalCandidate(
            u['scriptPubKey'],
            BigInt.from(u['satoshis']),
          )) {
        final vout = u['vout'] as int;
        need(vout < 0xffffffff, 'REVIEWED_TAPE_INDEX');
        dependencies['${u['txid']}:${vout + 1}'] = {
          'txid': u['txid'],
          'vout': vout + 1,
        };
      }
  requireCurrent();
  final replies = await status.readDependencies(dependencies.values.toList());
  requireCurrent();
  final tapes = {for (final p in replies) '${p['txid']}:${p['index']}': p};
  final historicalRequests = <Map<String, dynamic>>[];
  for (final row in rows) {
    final sideRows = sides(row);
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < sideRows[side].length; i++) {
        final o = sideRows[side][i];
        if (codes[o['script']] != null ||
            !reviewedHistoricalCandidate(o['script'], o['value']))
          continue;
        final input = side == 0 ? row['inputs'][i] : null;
        final tape =
            input != null
                ? tapes['${input['txid']}:${input['vout'] + 1}']
                : null;
        final next =
            side == 1 && i + 1 < sideRows[1].length ? sideRows[1][i + 1] : null;
        final script =
            input != null ? (tape?['scriptPubKey']) : (next?['script']);
        need(
          script is String &&
              (input != null
                  ? (tape?['value']) == '0'
                  : (next?['value']) == BigInt.zero),
          'REVIEWED_TOKEN_TAPE',
        );
        historicalRequests.add({
          'codeScript': o['script'],
          'codeSatoshis': 500,
          'tapeScript': script,
          'tapeSatoshis': 0,
        });
      }
  }
  final historicalPairs = <String, Map<String, dynamic>>{};
  if (historicalRequests.isNotEmpty) {
    final inspected = codec.historicalPairs(historicalRequests);
    for (var i = 0; i < historicalRequests.length; i++) {
      final script = historicalRequests[i]['codeScript'] as String,
          code = inspected[i]['code'] as Map<String, dynamic>;
      need(
        codes[script] == null || canonical(codes[script]) == canonical(code),
        'REVIEWED_PAIR_CODE_CHANGED',
      );
      codes[script] = code;
      historicalPairs[canonical(historicalRequests[i])] = inspected[i];
    }
  }
  for (final row in rows) {
    final found = <Map<String, dynamic>>[], outputs = sides(row);
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < outputs[side].length; i++) {
        final o = outputs[side][i],
            code = codes[o['script']],
            plain = _p2pkh.firstMatch(o['script']);
        if (code != null) {
          // This partner excludes administrator overrides; contract controllers
          // cannot be inferred from the primary holder's account or a metadata hint.
          if (side == 0 && code['generation'] == 'historical')
            checkInput(row, i, code);
          if (side == 1)
            need(
              (code['controller'] as String).endsWith('00'),
              'REVIEWED_HOLDER_CONTROLLER',
            );
          found.add({'side': side, 'index': i, 'code': code});
        } else if (plain == null) {
          need(
            side == 1 &&
                i > 0 &&
                codes[outputs[side][i - 1]['script']] != null &&
                o['value'] == BigInt.zero,
            'REVIEWED_HOLDER_UNKNOWN_SCRIPT',
          );
        }
      }
    need(found.any((t) => t['side'] == 0), 'REVIEWED_HOLDER_NO_TOKEN_INPUT');
    tokens.add(found);
  }
  final pairRequests = <Map<String, dynamic>>[];
  final pairs = <Map<String, dynamic>>[], currentPositions = <int>[];
  for (var r = 0; r < rows.length; r++)
    for (final t in tokens[r]) {
      final row = rows[r],
          i = t['index'] as int,
          outputs = row['transaction']['outputs'] as List;
      final input = t['side'] == 0 ? row['inputs'][i] : null;
      final tape =
          input != null ? tapes['${input['txid']}:${input['vout'] + 1}'] : null;
      final next =
          input == null && i + 1 < outputs.length ? outputs[i + 1] : null;
      final script =
          input != null ? (tape?['scriptPubKey']) : (next?['scriptPubKey']);
      need(
        script is String &&
            (input != null ? (tape?['value']) : (next?['satoshis'])) == '0',
        'REVIEWED_TOKEN_TAPE',
      );
      final request = <String, dynamic>{
        'codeScript': input?['scriptPubKey'] ?? outputs[i]['scriptPubKey'],
        'codeSatoshis': input?['satoshis'] ?? int.parse(outputs[i]['satoshis']),
        'tapeScript': script,
        'tapeSatoshis': 0,
        if (input != null && reviewedCoinCode(t['code']))
          'inputLock': {
            'sequence': row['transaction']['inputs'][i]['sequence'],
            'transactionLockTime': row['transaction']['locktime'],
          },
      };
      t['tapeScript'] = script;
      if (t['code']['generation'] == 'historical') {
        final lock = request.remove('inputLock');
        final pair = historicalPairs[canonical(request)];
        need(pair != null, 'REVIEWED_HISTORICAL_PAIR_BINDING');
        if (lock != null) checkHistoricalHolderLock(pair!['lockTime'], lock);
        pairs.add(pair!);
      } else {
        currentPositions.add(pairs.length);
        pairs.add({});
        pairRequests.add(request);
      }
    }
  if (pairRequests.isNotEmpty) {
    final values = codec.pairs(pairRequests);
    for (var i = 0; i < values.length; i++)
      pairs[currentPositions[i]] = values[i];
  }
  var at = 0;
  for (final found in tokens) {
    final sums = <String, List<BigInt>>{};
    for (final t in found) {
      final pair = pairs[at++];
      need(
        canonical(pair['code']) == canonical(t['code']),
        'REVIEWED_PAIR_CODE_CHANGED',
      );
      final amount = BigInt.parse(pair['balanceRaw']);
      t['amount'] = amount;
      if (pair.containsKey('lockTime')) t['lockTime'] = pair['lockTime'];
      final sum = sums.putIfAbsent(
        t['code']['codeIdentity'],
        () => [BigInt.zero, BigInt.zero],
      );
      sum[t['side'] as int] += amount;
    }
    need(sums.values.every((s) => s[0] == s[1]), 'REVIEWED_TOKEN_CONSERVATION');
  }
  final assets = await discoverReviewedTokenAssets(
    codec: codec,
    read: read,
    requireCurrent: requireCurrent,
    inputs: [
      for (var r = 0; r < rows.length; r++)
        for (final t in tokens[r])
          if (t['side'] == 0)
            {
              'code': t['code'],
              'txid': rows[r]['inputs'][t['index']]['txid'],
              'vout': rows[r]['inputs'][t['index']]['vout'],
              if (t['code']['generation'] == 'historical')
                'tapeScript': t['tapeScript'],
              if (t['code']['generation'] == 'historical')
                'codeScript': rows[r]['inputs'][t['index']]['scriptPubKey'],
            },
    ],
  );
  requireCurrent();
  final result = <int, Map<String, dynamic>>{};
  for (var r = 0; r < rows.length; r++) {
    final row = rows[r],
        groups = <String, Map<String, dynamic>>{},
        locks = <Map<String, dynamic>>[];
    void add(String id, Map asset, String owner, int side, BigInt amount) {
      final group = groups.putIfAbsent(
        id,
        () => {'asset': asset, 'endpoints': <String, List<BigInt>>{}},
      );
      final sums = (group['endpoints'] as Map<String, List<BigInt>>)
          .putIfAbsent(owner, () => [BigInt.zero, BigInt.zero]);
      sums[side] += amount;
    }

    for (final t in tokens[r]) {
      final code = t['code'] as Map, asset = assets[code['codeIdentity']];
      need(asset != null, 'REVIEWED_OUTPUT_ASSET');
      final owner = address((code['controller'] as String).substring(0, 40)),
          side = t['side'] as int,
          i = t['index'] as int;
      add(code['codeIdentity'], asset!, owner, side, t['amount']);
      if (t.containsKey('lockTime')) {
        final lock = t['lockTime'] as int;
        locks.add({
          'position': side == 0 ? 'input' : 'output',
          'index': i,
          'owner': owner,
          'contractId': asset['contractId'],
          'amount': '${t['amount']}',
          'lockTime': lock,
          'domain':
              lock == 0
                  ? 'none'
                  : lock < 500000000
                  ? 'height'
                  : 'timestamp',
          'transactionLockTime': row['transaction']['locktime'],
          'scriptLockChecked': side == 0,
          'chainMaturityChecked': false,
          if (side == 0)
            'sequence': row['transaction']['inputs'][i]['sequence'],
        });
      }
    }
    final outputs = sides(row);
    for (var side = 0; side < 2; side++)
      for (final o in outputs[side]) {
        if (o['value'] == BigInt.zero) continue;
        final plain = _p2pkh.firstMatch(o['script']), code = codes[o['script']];
        final hash =
            plain?.group(1) ??
            (code?['controller'] as String?)?.substring(0, 40);
        need(hash != null, 'REVIEWED_COLLATERAL_OWNER');
        add(
          'native',
          {'type': 'tbc', 'symbol': 'TBC'},
          address(hash!),
          side,
          o['value'],
        );
      }
    final fee =
        outputs[0].fold<BigInt>(
          BigInt.zero,
          (s, o) => s + (o['value'] as BigInt),
        ) -
        outputs[1].fold<BigInt>(
          BigInt.zero,
          (s, o) => s + (o['value'] as BigInt),
        );
    need(fee >= BigInt.zero, 'REVIEWED_NATIVE_OVERSPEND');
    result[row['index']] =
        frozen({
              'index': row['index'],
              'txid': row['transaction']['txid'],
              if (material['format'] == 'associated')
                'txidKind': 'unsigned-preview',
              'feeSatoshis': '$fee',
              'classification': {
                'protocol':
                    tokens[r].any((t) => reviewedCoinCode(t['code']))
                        ? 'stablecoin'
                        : 'ft',
                'action': 'transfer-or-merge',
                'conformance': 'standard',
              },
              if (locks.isNotEmpty) 'coinLocks': locks,
              'groups': [
                for (final entry in groups.entries)
                  {
                    'key': entry.key,
                    'asset': entry.value['asset'],
                    'flows': [
                      for (final e
                          in (entry.value['endpoints']
                                  as Map<String, List<BigInt>>)
                              .entries)
                        if (e.value[0] != e.value[1] ||
                            e.value[0] != BigInt.zero)
                          if (e.value[0] == e.value[1])
                            {
                              'purpose': 'self',
                              'direction': 'self',
                              'amount': {'raw': '${e.value[0]}'},
                              'recognized': true,
                              'isSelf': true,
                              'from': {'address': e.key},
                              'to': {'address': e.key},
                            }
                          else
                            {
                              'purpose': 'transfer',
                              'direction':
                                  e.value[1] > e.value[0] ? 'in' : 'out',
                              'amount': {
                                'raw': '${(e.value[1] - e.value[0]).abs()}',
                              },
                              'recognized': true,
                              'isSelf': false,
                              if (e.value[1] > e.value[0])
                                'to': {'address': e.key}
                              else
                                'from': {'address': e.key},
                            },
                    ],
                  },
              ],
            })
            as Map<String, dynamic>;
  }
  return Map.unmodifiable(result);
}
