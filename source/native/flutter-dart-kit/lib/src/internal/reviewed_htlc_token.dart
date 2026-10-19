// Exact unsigned HTLC Token impact. The shared status and identity helpers own
// all reads. Associated witnesses stay private; only public lock/role terms
// leave this module. It has no signer, broadcast or persistence.
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:pointycastle/digests/ripemd160.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'reviewed_address.dart';
import 'reviewed_material.dart';
import 'reviewed_rows.dart';
import 'reviewed_status.dart';
import 'reviewed_token.dart';
import 'reviewed_htlc_terms.dart';
import 'reviewed_profiles.dart';
import 'htlc_material.dart' show inspectHtlcCode;
import 'tbc20_material.dart' show ApiRead;

final _p2pkh = RegExp(r'^76a914([0-9a-f]{40})88ac$');

Future<Map<int, Map<String, dynamic>>> reviewHtlcTokenTransactions({
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
        {'script': u['scriptPubKey'], 'amount': BigInt.from(u['satoshis'])},
    ],
    [
      for (final o in row['transaction']['outputs'])
        {'script': o['scriptPubKey'], 'amount': BigInt.parse(o['satoshis'])},
    ],
  ];
  final flat =
          <String>{
            for (final row in rows)
              for (final side in sides(row))
                for (final o in side) o['script'],
          }.toList(),
      decoded = codec.codes(flat),
      codes = {for (var i = 0; i < flat.length; i++) flat[i]: decoded[i]},
      locksByScript = <String, Map<String, dynamic>>{},
      controllers = <String, String>{};
  for (final script in flat)
    if (script.length == 274) {
      locksByScript[script] = inspectHtlcCode(script);
      controllers[script] =
          '${hex(RIPEMD160Digest().process(Uint8List.fromList(sha256.convert(sha256.convert(unhex(script)).bytes).bytes)))}01';
    }
  final addressCache = <String, String>{
    own['publicKeyHash']!: account['address'],
  };
  String address(String hash) =>
      addressCache.putIfAbsent(hash, () => reviewedAddress(hash));
  final tokens = <List<Map<String, dynamic>>>[],
      terms = <List<Map<String, dynamic>>>[],
      dependencies = <String, Map<String, dynamic>>{};
  for (final row in rows) {
    final both = sides(row),
        found = <Map<String, dynamic>>[],
        locks = <Map<String, dynamic>>[],
        tx = row['transaction'];
    final profiles = reviewedAssociatedProfiles(
      material,
      row['index'],
      (row['inputs'] as List).length,
    );
    need(
      (tx['inputs'] as List).every((i) => i['scriptSig'] == ''),
      'REVIEWED_LOCK_UNSIGNED_REQUIRED',
    );
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < both[side].length; i++) {
        final o = both[side][i],
            code = codes[o['script']],
            htlc = locksByScript[o['script']],
            plain = _p2pkh.firstMatch(o['script']);
        final profile = side == 0 && profiles != null ? profiles[i] : null;
        if (code != null) {
          found.add({'side': side, 'index': i, 'code': code});
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
        } else if (htlc != null) {
          need(o['amount'] > BigInt.zero, 'REVIEWED_EMPTY_LOCK');
          locks.add({
            'position': side == 0 ? 'input' : 'output',
            'index': i,
            'amount': '${o['amount']}',
            'transactionLockTime': tx['locktime'],
            if (side == 0) 'sequence': tx['inputs'][i]['sequence'],
            'verification': 'exact-template',
            'chainMaturityChecked': false,
            'scriptExecutionVerified': false,
            ...reviewedHtlcPublicTerms(
              code: htlc,
              script: o['script'],
              accountAddress: account['address'],
              addressFromHash: address,
              transactionLockTime: tx['locktime'],
              sequence: side == 0 ? tx['inputs'][i]['sequence'] : null,
              associatedInput: profile,
            ),
          });
        } else if (plain != null) {
          if (side == 0) {
            need(plain.group(1) == own['publicKeyHash'], 'REVIEWED_FEE_OWNER');
            if (profile != null) requireReviewedProofProfile(profile, 'p2pkh');
          }
        } else
          need(
            side == 1 &&
                i > 0 &&
                codes[both[side][i - 1]['script']] != null &&
                o['amount'] == BigInt.zero,
            'REVIEWED_TOKEN_HTLC_UNKNOWN_SCRIPT',
          );
      }
    need(locks.isNotEmpty && locks.length <= 256, 'REVIEWED_TOKEN_HTLC_LOCKS');
    need(found.any((t) => t['side'] == 0), 'REVIEWED_TOKEN_HTLC_INPUT');
    tokens.add(found);
    terms.add(locks);
  }
  requireCurrent();
  final values = await status.readDependencies(dependencies.values.toList());
  requireCurrent();
  final tapes = {for (final v in values) '${v['txid']}:${v['index']}': v},
      requests = <Map<String, dynamic>>[];
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
                ? (next?['amount']) == BigInt.zero
                : (tape?['value']) == '0'),
        'REVIEWED_TOKEN_TAPE',
      );
      requests.add({
        'codeScript': o['script'],
        'codeSatoshis': (o['amount'] as BigInt).toInt(),
        'tapeScript': script,
        'tapeSatoshis': 0,
        if (side == 0 && reviewedCoinCode(t['code']))
          'inputLock': {
            'sequence': row['transaction']['inputs'][i]['sequence'],
            'transactionLockTime': row['transaction']['locktime'],
          },
      });
    }
  final pairs = codec.pairs(requests);
  var position = 0;
  for (final found in tokens)
    for (final t in found) {
      final pair = pairs[position++];
      need(
        canonical(pair['code']) == canonical(t['code']),
        'REVIEWED_PAIR_CODE_CHANGED',
      );
      t['amount'] = BigInt.parse(pair['balanceRaw']);
      if (pair.containsKey('lockTime')) t['lockTime'] = pair['lockTime'];
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
            },
    ],
  );
  requireCurrent();
  final result = <int, Map<String, dynamic>>{};
  for (var r = 0; r < rows.length; r++) {
    final row = rows[r],
        both = sides(row),
        found = tokens[r],
        linked = <String>{},
        locks = <Map<String, dynamic>>[];
    for (final lock in terms[r]) {
      final side = lock['position'] == 'input' ? 0 : 1,
          i = lock['index'] as int,
          o = both[side][i],
          candidates =
              found
                  .where(
                    (t) =>
                        t['side'] == side &&
                        (side == 1
                            ? t['index'] == i + 1
                            : row['inputs'][t['index']]['txid'] ==
                                    row['inputs'][i]['txid'] &&
                                row['inputs'][t['index']]['vout'] ==
                                    row['inputs'][i]['vout'] + 1),
                  )
                  .toList();
      need(
        o['amount'] == BigInt.from(100) &&
            (side == 1 ? i == 0 : row['inputs'][i]['vout'] == 0) &&
            candidates.length == 1,
        'REVIEWED_TOKEN_HTLC_ADJACENCY',
      );
      final token = candidates.single,
          amount = token['amount'] as BigInt,
          asset = assets[token['code']['codeIdentity']];
      need(
        token['code']['controller'] == controllers[o['script']] &&
            amount > BigInt.zero &&
            amount <= (BigInt.one << 63) - BigInt.one,
        'REVIEWED_TOKEN_HTLC_CONTROLLER',
      );
      final coinLock = token['lockTime'] as int?;
      need(
        coinLock == null ||
            coinLock == 0 ||
            (coinLock < 500000000) == (lock['lockTime'] < 500000000),
        'REVIEWED_TOKEN_HTLC_LOCK_DOMAIN',
      );
      need(asset != null, 'REVIEWED_OUTPUT_ASSET');
      linked.add('$side:${token['index']}');
      locks.add({
        ...lock,
        'escrowToken': {
          'index': token['index'],
          'standardId': token['code']['standardId'],
          'contractId': asset!['contractId'],
          'amount': '$amount',
          if (coinLock != null) ...{
            'coinLockTime': coinLock,
            'coinInputLockChecked': side == 0,
          },
        },
      });
    }
    final groups = <String, Map<String, dynamic>>{},
        coinLocks = <Map<String, dynamic>>[];
    void add(
      String id,
      Map asset,
      int side,
      BigInt amount,
      bool locked,
      String? owner,
    ) {
      final g = groups.putIfAbsent(
        id,
        () => {
          'asset': asset,
          'totals': [BigInt.zero, BigInt.zero],
          'flows': <Map<String, dynamic>>[],
          'endpoints': <String, Map<String, dynamic>>{},
        },
      );
      g['totals'][side] += amount;
      if (owner != null) {
        final e = (g['endpoints'] as Map<String, Map<String, dynamic>>)
            .putIfAbsent(
              '${locked ? 'lock' : 'address'}:$owner',
              () => {
                'owner': owner,
                'locked': locked,
                'totals': [BigInt.zero, BigInt.zero],
              },
            );
        e['totals'][side] += amount;
      } else if (amount > BigInt.zero)
        (g['flows'] as List).add({
          'purpose': side == 0 ? 'release' : 'lock',
          'direction': side == 0 ? 'out' : 'in',
          'amount': {'raw': '$amount'},
          'recognized': true,
        });
    }

    for (final t in found) {
      final code = t['code'],
          asset = assets[code['codeIdentity']],
          side = t['side'] as int,
          i = t['index'] as int,
          plain = (code['controller'] as String).endsWith('00'),
          conditional = linked.contains('$side:$i');
      need(
        asset != null && (plain || conditional),
        'REVIEWED_TOKEN_HTLC_ORPHAN',
      );
      final owner =
              plain
                  ? address((code['controller'] as String).substring(0, 40))
                  : null,
          lock = t['lockTime'] as int?;
      add(
        code['codeIdentity'],
        asset!,
        side,
        t['amount'],
        conditional || lock != null && lock > 0,
        owner,
      );
      if (lock != null && owner != null)
        coinLocks.add({
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
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < both[side].length; i++) {
        final o = both[side][i];
        if (o['amount'] == BigInt.zero) continue;
        final plain = _p2pkh.firstMatch(o['script']),
            code = codes[o['script']],
            conditional =
                locksByScript.containsKey(o['script']) ||
                linked.contains('$side:$i'),
            hash =
                plain?.group(1) ??
                (code != null && (code['controller'] as String).endsWith('00')
                    ? (code['controller'] as String).substring(0, 40)
                    : null);
        need(conditional || hash != null, 'REVIEWED_COLLATERAL_OWNER');
        add(
          'native',
          {'type': 'tbc', 'symbol': 'TBC'},
          side,
          o['amount'],
          conditional,
          hash == null ? null : address(hash),
        );
      }
    for (final e in groups.entries) {
      final g = e.value;
      need(
        e.key == 'native' || g['totals'][0] == g['totals'][1],
        'REVIEWED_TOKEN_CONSERVATION',
      );
      for (final ep
          in (g['endpoints'] as Map<String, Map<String, dynamic>>).values) {
        final a = ep['totals'][0] as BigInt,
            b = ep['totals'][1] as BigInt,
            d = b - a,
            owner = ep['owner'];
        if (a == BigInt.zero && b == BigInt.zero) continue;
        (g['flows'] as List).add(
          d == BigInt.zero
              ? {
                'purpose': 'self',
                'direction': 'self',
                'amount': {'raw': '$a'},
                'recognized': true,
                'from': {'address': owner},
                'to': {'address': owner},
              }
              : {
                'purpose':
                    ep['locked'] == true
                        ? (d > BigInt.zero ? 'lock' : 'release')
                        : 'transfer',
                'direction': d > BigInt.zero ? 'in' : 'out',
                'amount': {'raw': '${d.abs()}'},
                'recognized': true,
                d > BigInt.zero ? 'to' : 'from': {'address': owner},
              },
        );
      }
    }
    final fee =
        both[0].fold<BigInt>(
          BigInt.zero,
          (s, o) => s + (o['amount'] as BigInt),
        ) -
        both[1].fold<BigInt>(
          BigInt.zero,
          (s, o) => s + (o['amount'] as BigInt),
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
                'protocol': 'tbc-htlc',
                'action':
                    locks.any((l) => l['position'] == 'input')
                        ? 'spend-or-transition'
                        : 'lock',
                'conformance': 'standard',
              },
              'htlcLocks': locks,
              if (coinLocks.isNotEmpty) 'coinLocks': coinLocks,
              'groups': [
                for (final e in groups.entries)
                  {
                    'key': e.key,
                    'asset': e.value['asset'],
                    'flows': e.value['flows'],
                  },
              ],
            })
            as Map<String, dynamic>;
  }
  return Map.unmodifiable(result);
}
