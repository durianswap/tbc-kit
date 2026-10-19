// One status/material lifecycle for exact current LOP order and Token flows.
// This previews impact; it is not a script VM or authority to sign every input.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'reviewed_address.dart';
import 'reviewed_material.dart';
import 'reviewed_rows.dart';
import 'reviewed_status.dart';
import 'reviewed_token.dart';
import 'reviewed_lop_terms.dart';
import 'reviewed_profiles.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;

final _p2pkh = RegExp(r'^76a914([0-9a-f]{40})88ac$');

Future<Map<int, Map<String, dynamic>>> reviewLopTransactions({
  required ReviewedRawPlan plan,
  required ReviewedStatusReader status,
  required List<List<Map<String, dynamic>>> verifiedInputs,
  required Map material,
  required Map account,
  required String chainId,
  required List<int> transactionIndexes,
  required ReviewedTokenCodec codec,
  required KeylessCall keyless,
  required ApiRead read,
  required void Function() requireCurrent,
}) async {
  account = copied(account);
  final own = inspectAccount(account, expectedChainId: chainId),
      rows = boundReviewedRows(
        plan: plan,
        status: status,
        verifiedInputs: verifiedInputs,
        transactionIndexes: transactionIndexes,
      );
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
  final flat =
          <String>{
            for (final row in rows)
              for (final side in sides(row))
                for (final o in side) o['script'],
          }.toList(),
      orders = inspectReviewedLopCodes(keyless, flat),
      descriptors = codec.codes(flat),
      codes = {for (var i = 0; i < flat.length; i++) flat[i]: descriptors[i]},
      tokens = <List<Map<String, dynamic>>>[],
      dependencies = <String, Map<String, dynamic>>{};
  final addressCache = <String, String>{
    own['publicKeyHash']!: account['address'],
  };
  String address(String hash) =>
      addressCache.putIfAbsent(hash, () => reviewedAddress(hash));
  for (final row in rows) {
    final found = <Map<String, dynamic>>[], both = sides(row);
    final profiles = reviewedAssociatedProfiles(
      material,
      row['index'],
      (row['inputs'] as List).length,
    );
    need(
      both.any((side) => side.any((o) => orders[o['script']] != null)),
      'REVIEWED_LOP_NO_ORDER',
    );
    need(
      (row['transaction']['inputs'] as List).every((i) => i['scriptSig'] == ''),
      'REVIEWED_LOP_UNSIGNED',
    );
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < both[side].length; i++) {
        final o = both[side][i],
            code = codes[o['script']],
            plain = _p2pkh.firstMatch(o['script']);
        final profile = side == 0 && profiles != null ? profiles[i] : null;
        if (code != null) {
          if (side == 0) {
            if (profile != null)
              requireReviewedProofProfile(profile, code['standardId']);
            final input = row['inputs'][i], vout = input['vout'] as int;
            need(vout < 0xffffffff, 'REVIEWED_TAPE_INDEX');
            dependencies['${input['txid']}:${vout + 1}'] = {
              'txid': input['txid'],
              'vout': vout + 1,
            };
            if ((code['controller'] as String).endsWith('00'))
              need(
                (code['controller'] as String).substring(0, 40) ==
                    own['publicKeyHash'],
                'REVIEWED_HOLDER_OWNER',
              );
          }
          found.add({'side': side, 'index': i, 'code': code});
        } else if (plain != null) {
          if (side == 0) {
            need(plain.group(1) == own['publicKeyHash'], 'REVIEWED_FEE_OWNER');
            if (profile != null) requireReviewedProofProfile(profile, 'p2pkh');
          }
        } else if (orders[o['script']] != null) {
          if (profile != null)
            requireReviewedLopProfile(
              profile,
              orders[o['script']]!['terms'],
              account,
              own['publicKeyHash']!,
            );
        } else if (orders[o['script']] == null) {
          need(
            side == 1 &&
                i > 0 &&
                codes[both[side][i - 1]['script']] != null &&
                o['value'] == BigInt.zero,
            'REVIEWED_LOP_UNKNOWN_SCRIPT',
          );
        }
      }
    tokens.add(found);
  }
  requireCurrent();
  final values = await status.readDependencies(dependencies.values.toList());
  requireCurrent();
  final tapes = {for (final v in values) '${v['txid']}:${v['index']}': v},
      pairs = <Map<String, dynamic>>[];
  for (var r = 0; r < rows.length; r++)
    for (final t in tokens[r]) {
      final row = rows[r],
          side = t['side'] as int,
          i = t['index'] as int,
          both = sides(row),
          o = both[side][i],
          input = side == 0 ? row['inputs'][i] : null,
          tape =
              input == null
                  ? null
                  : tapes['${input['txid']}:${input['vout'] + 1}'],
          next = side == 1 && i + 1 < both[1].length ? both[1][i + 1] : null,
          script = input == null ? (next?['script']) : (tape?['scriptPubKey']);
      need(
        script is String &&
            (input == null
                ? (next?['value']) == BigInt.zero
                : (tape?['value']) == '0'),
        'REVIEWED_TOKEN_TAPE',
      );
      pairs.add({
        'codeScript': o['script'],
        'codeSatoshis': (o['value'] as BigInt).toInt(),
        'tapeScript': script,
        'tapeSatoshis': 0,
        if (side == 0 && reviewedCoinCode(t['code']))
          'inputLock': {
            'sequence': row['transaction']['inputs'][i]['sequence'],
            'transactionLockTime': row['transaction']['locktime'],
          },
      });
    }
  final inspected =
      pairs.isEmpty ? <Map<String, dynamic>>[] : codec.pairs(pairs);
  var pos = 0;
  for (final row in tokens)
    for (final t in row) {
      final pair = inspected[pos++];
      need(
        canonical(pair['code']) == canonical(t['code']),
        'REVIEWED_PAIR_CODE_CHANGED',
      );
      t['amount'] = BigInt.parse(pair['balanceRaw']);
      if (pair.containsKey('lockTime')) t['lockTime'] = pair['lockTime'];
    }
  final commitments = <String, String>{};
  for (final order in orders.values)
    if (order != null) {
      final terms = order['terms'];
      for (final a in [terms['baseAsset'], terms['quoteAsset']])
        if (a['kind'] == 'token') {
          final hash = a['partialHash'] as String,
              id = a['contractId'] as String;
          need(
            !commitments.containsKey(hash) || commitments[hash] == id,
            'REVIEWED_LOP_AMBIGUOUS_COMMITMENT',
          );
          commitments[hash] = id;
        }
    }
  final identities = <String, Map<String, dynamic>>{};
  for (final row in tokens)
    for (final t in row) identities[t['code']['codeIdentity']] = t['code'];
  final assets =
      identities.isEmpty
          ? <String, Map<String, dynamic>>{}
          : await authenticateReviewedTokenAssets(
            codec: codec,
            read: read,
            requireCurrent: requireCurrent,
            requests: [
              for (final code in identities.values)
                {
                  'code': code,
                  'contractId':
                      commitments[(code['codeIdentity'] as String).substring(
                        0,
                        64,
                      )],
                },
            ],
          );
  requireCurrent();
  final result = <int, Map<String, dynamic>>{};
  for (var r = 0; r < rows.length; r++) {
    final row = rows[r],
        both = sides(row),
        found = tokens[r],
        owners = <String, String>{},
        linked = <String>{},
        orderTerms = <String, dynamic>{
          'verification': 'exact-template',
          'assetIdentityVerified': false,
          'inputs': <Map>[],
          'outputs': <Map>[],
        };
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < both[side].length; i++) {
        final o = both[side][i], order = orders[o['script']];
        if (order == null) continue;
        final t = order['terms'],
            controller = '${order['controller']}01',
            owner = address(t['ownerHash']);
        (orderTerms[side == 0 ? 'inputs' : 'outputs'] as List).add({
          'index': i,
          'terms': t,
        });
        owners[controller] = owner;
        final nativeSell = t['market'] == 'native-token' && t['side'] == 'sell';
        need(
          o['value'] ==
              (nativeSell ? BigInt.parse(t['saleVolume']) : BigInt.from(300)),
          'REVIEWED_LOP_VALUE',
        );
        if (!nativeSell) {
          final candidates =
                  found
                      .where(
                        (token) =>
                            token['side'] == side &&
                            (side == 1
                                ? token['index'] == i + 1
                                : row['inputs'][token['index']]['txid'] ==
                                        row['inputs'][i]['txid'] &&
                                    row['inputs'][token['index']]['vout'] ==
                                        row['inputs'][i]['vout'] + 1),
                      )
                      .toList(),
              a =
                  t['market'] == 'token-token' && t['side'] == 'buy'
                      ? t['quoteAsset']
                      : t['market'] == 'native-token'
                      ? t['quoteAsset']
                      : t['baseAsset'];
          need(candidates.length == 1, 'REVIEWED_LOP_ADJACENT_ESCROW');
          final token = candidates.single;
          need(
            token['code']['controller'] == controller &&
                (token['code']['codeIdentity'] as String).substring(0, 64) ==
                    a['partialHash'],
            'REVIEWED_LOP_ESCROW_BINDING',
          );
          linked.add('$side:${token['index']}');
        }
      }
    final groups = <String, Map<String, dynamic>>{},
        locks = <Map<String, dynamic>>[];
    void add(
      String id,
      Map asset,
      String owner,
      BigInt amount,
      int side,
      bool locked,
    ) {
      final g = groups.putIfAbsent(
        id,
        () => {
          'asset': asset,
          'totals': [BigInt.zero, BigInt.zero],
          'endpoints': <String, Map<String, dynamic>>{},
        },
      );
      g['totals'][side] += amount;
      final key = '${locked ? 'lock' : 'address'}:$owner',
          endpoint = (g['endpoints'] as Map<String, Map<String, dynamic>>)
              .putIfAbsent(
                key,
                () => {
                  'owner': owner,
                  'locked': locked,
                  'totals': [BigInt.zero, BigInt.zero],
                },
              );
      endpoint['totals'][side] += amount;
    }

    for (final t in found) {
      final code = t['code'],
          plain = (code['controller'] as String).endsWith('00'),
          side = t['side'] as int,
          i = t['index'] as int;
      need(plain || linked.contains('$side:$i'), 'REVIEWED_LOP_ORPHAN_ESCROW');
      final owner =
              plain
                  ? address((code['controller'] as String).substring(0, 40))
                  : owners[code['controller']],
          asset = assets[code['codeIdentity']];
      need(owner != null && asset != null, 'REVIEWED_LOP_ASSET_OWNER');
      add(code['codeIdentity'], asset!, owner!, t['amount'], side, !plain);
      if (t.containsKey('lockTime')) {
        final lock = t['lockTime'] as int;
        locks.add({
          'position': side == 0 ? 'input' : 'output',
          'index': i,
          'contractId': asset['contractId'],
          'amount': '${t['amount']}',
          'owner': owner,
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
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < both[side].length; i++) {
        final o = both[side][i];
        if (o['value'] == BigInt.zero) continue;
        final plain = _p2pkh.firstMatch(o['script']),
            order = orders[o['script']],
            code = codes[o['script']],
            hash =
                plain?.group(1) ??
                (order != null
                    ? order['terms']['ownerHash']
                    : code != null &&
                        (code['controller'] as String).endsWith('00')
                    ? (code['controller'] as String).substring(0, 40)
                    : null),
            owner =
                hash != null
                    ? address(hash)
                    : code != null
                    ? owners[code['controller']]
                    : null;
        need(owner != null, 'REVIEWED_COLLATERAL_OWNER');
        add(
          'native',
          {'type': 'tbc', 'symbol': 'TBC'},
          owner!,
          o['value'],
          side,
          plain == null &&
              (order != null ||
                  code != null &&
                      !(code['controller'] as String).endsWith('00')),
        );
      }
    final fee =
        both[0].fold<BigInt>(
          BigInt.zero,
          (s, o) => s + (o['value'] as BigInt),
        ) -
        both[1].fold<BigInt>(BigInt.zero, (s, o) => s + (o['value'] as BigInt));
    need(fee >= BigInt.zero, 'REVIEWED_NATIVE_OVERSPEND');
    final projected = <Map<String, dynamic>>[];
    if (found.isEmpty) {
      // Frozen native-only order preview: show locked/released principal; the
      // network fee is already explicit, change is not a second transfer.
      for (final side in ['inputs', 'outputs'])
        for (final order in orderTerms[side]) {
          final t = order['terms'];
          need(
            t['market'] == 'native-token' && t['side'] == 'sell',
            'REVIEWED_LOP_TOKEN_REQUIRED',
          );
          projected.add({
            'purpose': side == 'inputs' ? 'release' : 'lock',
            'direction': side == 'inputs' ? 'in' : 'out',
            'amount': {'raw': t['saleVolume']},
            'recognized': true,
            side == 'inputs' ? 'to' : 'from': {
              'address': address(t['ownerHash']),
            },
          });
        }
      // Native-only order endpoints must be selected-owned; foreign payouts
      // cannot be hidden behind a principal-only preview.
      for (final side in both)
        for (final o in side) {
          final plain = _p2pkh.firstMatch(o['script']),
              order = orders[o['script']];
          need(
            (plain?.group(1) ?? order?['terms']['ownerHash']) ==
                own['publicKeyHash'],
            'REVIEWED_LOP_NATIVE_OWNER',
          );
        }
    }
    final groupRows = <Map<String, dynamic>>[];
    for (final e in groups.entries) {
      final g = e.value;
      need(
        e.key == 'native' || g['totals'][0] == g['totals'][1],
        'REVIEWED_TOKEN_CONSERVATION',
      );
      final flows = <Map<String, dynamic>>[];
      for (final ep
          in (g['endpoints'] as Map<String, Map<String, dynamic>>).values) {
        final a = ep['totals'][0] as BigInt,
            b = ep['totals'][1] as BigInt,
            delta = b - a,
            owner = ep['owner'];
        if (a == BigInt.zero && b == BigInt.zero) continue;
        flows.add(
          delta == BigInt.zero
              ? {
                'purpose': 'self',
                'direction': 'self',
                'amount': {'raw': '$a'},
                'recognized': true,
                'isSelf': true,
                'from': {'address': owner},
                'to': {'address': owner},
              }
              : {
                'purpose':
                    ep['locked'] == true
                        ? (delta > BigInt.zero ? 'lock' : 'release')
                        : 'transfer',
                'direction': delta > BigInt.zero ? 'in' : 'out',
                'amount': {'raw': '${delta.abs()}'},
                'recognized': true,
                'isSelf': false,
                delta > BigInt.zero ? 'to' : 'from': {'address': owner},
              },
        );
      }
      groupRows.add({
        'key': e.key,
        'asset': g['asset'],
        'flows': found.isEmpty ? projected : flows,
      });
    }
    result[row['index']] =
        frozen({
              'index': row['index'],
              'txid': row['transaction']['txid'],
              if (material['format'] == 'associated')
                'txidKind': 'unsigned-preview',
              'feeSatoshis': '$fee',
              'classification': {
                'protocol': 'orderBook',
                'action':
                    (orderTerms['inputs'] as List).isEmpty
                        ? 'create'
                        : (orderTerms['outputs'] as List).isEmpty
                        ? 'settle-or-cancel'
                        : 'continuation',
                'conformance': 'standard',
              },
              'orderTerms': orderTerms,
              if (locks.isNotEmpty) 'coinLocks': locks,
              'groups': groupRows,
            })
            as Map<String, dynamic>;
  }
  return Map.unmodifiable(result);
}
