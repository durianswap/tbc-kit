// Pure review of authenticated native inputs/outputs. Uses the same parsed
// plan and status binding as Token/NFT review, never a second reader or signer.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'reviewed_address.dart';
import 'reviewed_material.dart';
import 'reviewed_rows.dart';
import 'reviewed_status.dart';
import 'reviewed_htlc_terms.dart';
import 'timelock_material.dart' show inspectTimelockCode;
import 'htlc_material.dart' show inspectHtlcCode;

final _p2pkh = RegExp(r'^76a914([0-9a-f]{40})88ac$');

Map<int, Map<String, dynamic>> reviewNativeTransactions({
  required ReviewedRawPlan plan,
  required ReviewedStatusReader status,
  required List<List<Map<String, dynamic>>> verifiedInputs,
  required Map material,
  required Map account,
  required String chainId,
  required List<int> transactionIndexes,
}) {
  final own = inspectAccount(account, expectedChainId: chainId),
      rows = boundReviewedRows(
        plan: plan,
        status: status,
        verifiedInputs: verifiedInputs,
        transactionIndexes: transactionIndexes,
      ),
      result = <int, Map<String, dynamic>>{};
  final addressCache = <String, String>{
    own['publicKeyHash']!: account['address'],
  };
  String address(String hash) =>
      addressCache.putIfAbsent(hash, () => reviewedAddress(hash));
  for (final row in rows) {
    final tx = row['transaction'] as Map, index = row['index'] as int;
    final sides = <List<Map<String, dynamic>>>[
      [
        for (final u in row['inputs'])
          {'script': u['scriptPubKey'], 'amount': BigInt.from(u['satoshis'])},
      ],
      [
        for (final o in tx['outputs'])
          {'script': o['scriptPubKey'], 'amount': BigInt.parse(o['satoshis'])},
      ],
    ];
    final codes = <List<Map<String, dynamic>?>>[];
    final kinds = <String>{};
    for (final side in sides) {
      final parsed = <Map<String, dynamic>?>[];
      for (final o in side) {
        final script = o['script'] as String;
        Map<String, dynamic>? code;
        if (script.length == 106) {
          code = {'kind': 'time', ...inspectTimelockCode(script)};
        } else if (script.length == 274) {
          code = {'kind': 'htlc', ...inspectHtlcCode(script)};
        } else
          need(_p2pkh.hasMatch(script), 'REVIEWED_NATIVE_UNKNOWN_SCRIPT');
        if (code != null) kinds.add(code['kind']);
        parsed.add(code);
      }
      codes.add(parsed);
    }
    need(kinds.length <= 1, 'REVIEWED_MIXED_LOCK_PROFILE');
    final kind = kinds.isEmpty ? null : kinds.single;
    if (kind != null)
      need(
        (tx['inputs'] as List).every((i) => i['scriptSig'] == ''),
        'REVIEWED_LOCK_UNSIGNED_REQUIRED',
      );
    final List? profiles =
        material['format'] != 'associated'
            ? null
            : index == 0
            ? material['request']['sourceUtxos']
            : material['request']['inputs'][index - 1];
    need(
      profiles == null || profiles.length == sides[0].length,
      'REVIEWED_NATIVE_PROFILE_COUNT',
    );
    final locks = <Map<String, dynamic>>[],
        flows = <Map<String, dynamic>>[],
        balances = <String, BigInt>{};
    for (var side = 0; side < 2; side++)
      for (var i = 0; i < sides[side].length; i++) {
        final o = sides[side][i],
            amount = o['amount'] as BigInt,
            code = codes[side][i];
        final input = side == 0,
            sequence = input ? tx['inputs'][i]['sequence'] : null;
        final Map? profile = input && profiles != null ? profiles[i] : null;
        if (code == null) {
          final hash = _p2pkh.firstMatch(o['script'])!.group(1)!,
              owner = address(hash);
          if (input) {
            need(hash == own['publicKeyHash'], 'REVIEWED_FEE_OWNER');
            if (profile != null)
              need(
                profile['scriptSigType'] == 'p2pkh' &&
                    profile['signingPublicKey'] == null &&
                    profile['unfinishedScriptSig'] == null,
                'REVIEWED_FEE_PROFILE',
              );
          }
          balances[owner] =
              (balances[owner] ?? BigInt.zero) + (input ? -amount : amount);
          continue;
        }
        need(amount > BigInt.zero, 'REVIEWED_EMPTY_LOCK');
        final term = <String, dynamic>{
          'position': input ? 'input' : 'output',
          'index': i,
          'amount': '$amount',
          'transactionLockTime': tx['locktime'],
          if (input) 'sequence': sequence,
          'verification': 'exact-template',
          'chainMaturityChecked': false,
          'scriptExecutionVerified': false,
        };
        final flow = <String, dynamic>{
          'purpose': input ? 'release' : 'lock',
          'direction': input ? 'out' : 'in',
          'recognized': true,
          'amount': {'raw': '$amount'},
        };
        if (kind == 'time') {
          final owner = address(code['ownerHash']),
              lock = code['lockHeight'] as int;
          if (input) {
            need(
              owner == account['address'] &&
                  sequence != 0xffffffff &&
                  tx['locktime'] < 500000000 &&
                  tx['locktime'] >= lock,
              'REVIEWED_TIMELOCK_CONDITION',
            );
            if (profile != null) {
              // A TimeLock consumes the ordinary sig/pubkey witness. No arbitrary
              // extra template bytes may be hidden behind a valid public preview.
              final type = profile['scriptSigType'];
              need(
                profile['signingPublicKey'] == null &&
                    ((type == 'p2pkh' &&
                            profile['unfinishedScriptSig'] == null) ||
                        (type == 'other' &&
                            profile['unfinishedScriptSig'] ==
                                '097369676e617475726521${account['publicKey']}')),
                'REVIEWED_TIMELOCK_WITNESS',
              );
            }
          }
          term.addAll({
            'owner': owner,
            'lockHeight': lock,
            'domain': 'height',
            'scriptLockChecked': input,
          });
          flow[input ? 'from' : 'to'] = {'address': owner};
        } else {
          term.addAll(
            reviewedHtlcPublicTerms(
              code: code,
              script: o['script'],
              accountAddress: account['address'],
              addressFromHash: address,
              sequence: sequence,
              transactionLockTime: tx['locktime'],
              associatedInput: profile,
            ),
          );
        }
        locks.add(term);
        flows.add(flow);
      }
    need(locks.length <= 256, 'REVIEWED_LOCK_TERM_BOUND');
    final fee =
        sides[0].fold<BigInt>(
          BigInt.zero,
          (sum, o) => sum + (o['amount'] as BigInt),
        ) -
        sides[1].fold<BigInt>(
          BigInt.zero,
          (sum, o) => sum + (o['amount'] as BigInt),
        );
    need(fee >= BigInt.zero, 'REVIEWED_NATIVE_OVERSPEND');
    if (kind == null) {
      // With all inputs owned, output recipients are exact; self/change is not
      // presented as another outgoing transfer or charged again as an asset fee.
      final outputs = <String, BigInt>{};
      for (final o in sides[1]) {
        final owner = address(_p2pkh.firstMatch(o['script'])!.group(1)!);
        outputs[owner] =
            (outputs[owner] ?? BigInt.zero) + (o['amount'] as BigInt);
      }
      for (final e in outputs.entries)
        if (e.key != account['address'])
          flows.add({
            'purpose': 'transfer',
            'direction': 'out',
            'recognized': true,
            'amount': {'raw': '${e.value}'},
            'from': {'address': account['address']},
            'to': {'address': e.key},
            'isSelf': false,
          });
      final change = outputs[account['address']];
      if (change != null)
        flows.add({
          'purpose': 'self',
          'direction': 'self',
          'recognized': true,
          'amount': {'raw': '$change'},
          'from': {'address': account['address']},
          'to': {'address': account['address']},
          'isSelf': true,
        });
    } else {
      for (final e in balances.entries)
        if (e.value != BigInt.zero)
          flows.add({
            'purpose': 'transfer',
            'direction': e.value > BigInt.zero ? 'in' : 'out',
            'recognized': true,
            'amount': {'raw': '${e.value.abs()}'},
            if (e.value > BigInt.zero)
              'to': {'address': e.key}
            else
              'from': {'address': e.key},
          });
    }
    result[index] =
        frozen({
              'index': index,
              'txid': tx['txid'],
              'feeSatoshis': '$fee',
              if (material['format'] == 'associated')
                'txidKind': 'unsigned-preview',
              'classification': {
                'protocol':
                    kind == null
                        ? 'tbc'
                        : kind == 'time'
                        ? 'tbc-timelock'
                        : 'tbc-htlc',
                'action':
                    kind == null
                        ? 'transfer'
                        : codes[0].any((c) => c != null)
                        ? 'spend-or-transition'
                        : 'lock',
                'conformance': 'standard',
              },
              if (kind == 'time') 'timeLocks': locks,
              if (kind == 'htlc') 'htlcLocks': locks,
              'groups': [
                {
                  'key': 'native',
                  'asset': {'type': 'tbc', 'symbol': 'TBC'},
                  'flows': flows,
                },
              ],
            })
            as Map<String, dynamic>;
  }
  return Map.unmodifiable(result);
}
