// Holder-only NFT review. Immutable mint identity comes from the existing
// frozen Rust origin codec, including historical v0/v1/v2, not suffix guesses.
// No ancestry scan, key, approval, broadcast or API-provided display label.
import 'package:crypto/crypto.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'reviewed_rows.dart';
import 'reviewed_address.dart';
import 'reviewed_profiles.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;

final _plain = RegExp(r'^76a914([0-9a-f]{40})88ac$');
final _hold = RegExp(
  r'^76a914([0-9a-f]{40})88ac6a0d56302043757272204e486f6c64$',
);

/// One immutable network/source owner, like the existing parent reader. Never
/// share this instance across source switches. Only authenticated mint identity
/// is cached; balances, owners, spent flags and mutable NFT indexes are not.
final class ReviewedNftAssets {
  ReviewedNftAssets({
    required this.read,
    required this.readHistory,
    required this.keyless,
  });
  final ApiRead read;
  final Future<Map<String, dynamic>> Function(String) readHistory;
  final KeylessCall keyless;
  final _identities = <String, Map<String, dynamic>>{};

  Future<Map<String, Map<String, dynamic>>> resolve(
    List<Map<String, dynamic>> selected,
    void Function() requireCurrent,
  ) async {
    final unique = <String, Map<String, dynamic>>{};
    for (final point in selected) {
      final p = copied(point), code = p['scriptPubKey'];
      need(
        code is String &&
            code.length <= 20000 &&
            RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(code),
        'REVIEWED_NFT_CODE',
      );
      hash32(p['txid']);
      need(
        p['vout'] is int && p['vout'] >= 0 && p['vout'] <= 0xfffffffd,
        'REVIEWED_NFT_POINT',
      );
      unique.putIfAbsent(code, () => p);
    }
    need(unique.isNotEmpty && unique.length <= 256, 'REVIEWED_NFT_ASSET_BOUND');
    final result = <String, Map<String, dynamic>>{};
    await Future.wait(
      unique.entries.map((entry) async {
        requireCurrent();
        final cached = _identities[entry.key];
        if (cached != null) {
          result[entry.key] = cached;
          return;
        }
        final scriptHash = hex(sha256.convert(unhex(entry.key)).bytes.reversed);
        final indexed = await read(
          '/api/tbc/nft/utxo/scriptpubkeyhash/$scriptHash',
        );
        requireCurrent();
        final rows = indexed['utxos'];
        need(
          rows is List && rows.length == 1 && rows[0] is Map,
          'REVIEWED_NFT_INDEX',
        );
        final row = copied(rows[0]);
        Object? alias(String a, String b) {
          final x = row[a], y = row[b];
          need(
            x == null || y == null || canonical(x) == canonical(y),
            'REVIEWED_NFT_ALIAS',
          );
          return x ?? y;
        }

        final id = hash32(alias('nft_id', 'nft_contract_id'));
        need(
          row['txid'] == entry.value['txid'] &&
              uintString(alias('index', 'vout')) == '${entry.value['vout']}',
          'REVIEWED_NFT_INDEX_POINT',
        );
        final indexedScript = alias('scriptPubKey', 'script_pubkey');
        need(
          indexedScript == null || indexedScript == entry.key,
          'REVIEWED_NFT_INDEX_SCRIPT',
        );
        final origin = await readHistory(id);
        requireCurrent();
        // readHistory is the shared txid-verified immutable parent reader. The
        // frozen Rust codec independently verifies raw txid, exact Code, bound
        // collection input, regular Hold, Tape and origin topology.
        need(
          origin['txid'] == id && origin['rawTransaction'] is String,
          'REVIEWED_NFT_ORIGIN_ID',
        );
        Map<String, dynamic> hint;
        try {
          hint = keyless('inspectTokenMaterial', {
            'phase': 'identifyNftOrigin',
            'contractId': id,
            'rawTransaction': origin['rawTransaction'],
          });
        } catch (_) {
          throw StateError('REVIEWED_NFT_ORIGIN_FAILED');
        }
        need(
          hint.length == 4 &&
              hint['family'] == 'tbc721' &&
              {'current', 'historical'}.contains(hint['generation']) &&
              hint['verification'] == 'origin-template' &&
              hint['assetIdentityVerified'] == false,
          'REVIEWED_NFT_ORIGIN',
        );
        // Bind the cached parsed view to bytes even for a custom data adapter.
        final parsed = inspectTransaction(origin['rawTransaction'], id),
            outputs = parsed['outputs'] as List,
            inputs = parsed['inputs'] as List;
        need(
          outputs.length >= 3 &&
              inputs.isNotEmpty &&
              outputs[0]['scriptPubKey'] == entry.key,
          'REVIEWED_NFT_ORIGIN_CODE',
        );
        final collection = hash32(inputs[0]['txid']), slot = inputs[0]['vout'];
        need(
          row['collection_id'] == null || row['collection_id'] == collection,
          'REVIEWED_NFT_COLLECTION',
        );
        final value =
            frozen({
                  'contractId': id,
                  'collectionId': collection,
                  'tokenId': '$slot',
                  'generation': hint['generation'],
                  'code': entry.key,
                  'tape': outputs[2]['scriptPubKey'],
                })
                as Map<String, dynamic>;
        requireCurrent();
        if (_identities.length >= 256)
          _identities.remove(_identities.keys.first);
        _identities[entry.key] = value;
        result[entry.key] = value;
      }),
    );
    requireCurrent();
    return Map.unmodifiable(result);
  }
}

Future<Map<int, Map<String, dynamic>>> reviewNftHolderTransactions({
  required ReviewedRawPlan plan,
  required ReviewedStatusReader status,
  required List<List<Map<String, dynamic>>> verifiedInputs,
  required Map material,
  required Map account,
  required String chainId,
  required List<int> transactionIndexes,
  required ReviewedNftAssets assets,
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
  final groups = <int, List<Map<String, dynamic>>>{};
  final selected = <Map<String, dynamic>>[], missing = <Map<String, dynamic>>[];
  for (final row in rows) {
    final inputs = row['inputs'] as List;
    final profiles = reviewedAssociatedProfiles(
      material,
      row['index'],
      inputs.length,
    );
    final used = <int>{}, nfts = <Map<String, dynamic>>[];
    for (var i = 0; i < inputs.length; i++) {
      if (used.contains(i)) continue;
      final u = inputs[i], plain = _plain.firstMatch(u['scriptPubKey']);
      if (plain != null) {
        need(plain.group(1) == own['publicKeyHash'], 'REVIEWED_NFT_FEE_OWNER');
        if (profiles != null) requireReviewedProofProfile(profiles[i], 'p2pkh');
        continue;
      }
      if (_hold.firstMatch(u['scriptPubKey']) != null) {
        need(
          inputs.any(
            (v) => v['txid'] == u['txid'] && v['vout'] + 1 == u['vout'],
          ),
          'REVIEWED_NFT_ORPHAN_HOLD',
        );
        continue;
      }
      // Candidate grouping only. The origin codec later authenticates the
      // complete Code; a random covenant followed by Hold never becomes NFT.
      need(
        _hold.firstMatch(u['scriptPubKey']) == null &&
            u['satoshis'] == 200 &&
            u['vout'] <= 0xfffffffd,
        'REVIEWED_NFT_INPUT_CODE',
      );
      final at = inputs.indexWhere(
        (v) => v['txid'] == u['txid'] && v['vout'] == u['vout'] + 1,
      );
      need(at >= 0 && !used.contains(at), 'REVIEWED_NFT_PAIRED_HOLD');
      final hold = inputs[at], owner = _hold.firstMatch(hold['scriptPubKey']);
      need(
        hold['satoshis'] == 100 && owner?.group(1) == own['publicKeyHash'],
        'REVIEWED_NFT_OWNER',
      );
      if (profiles != null) {
        requireReviewedHolderTemplate(profiles[i], account['publicKey']);
        requireReviewedProofProfile(profiles[at], 'p2pkh');
      }
      used.add(at);
      nfts.add({'input': u, 'holdInput': hold, 'index': i, 'holdIndex': at});
      selected.add(copied(u));
      missing.add({'txid': u['txid'], 'vout': u['vout'] + 2});
    }
    need(nfts.isNotEmpty, 'REVIEWED_NFT_NO_INPUT');
    groups[row['index']] = nfts;
  }
  requireCurrent();
  final tapeRead = status.readDependencies(missing),
      identityRead = assets.resolve(selected, requireCurrent);
  // Drain both concurrent read branches on failure; no late unhandled error or
  // additional retry. Only immutable validated origins may survive the request.
  final values = await Future.wait<dynamic>([tapeRead, identityRead]);
  requireCurrent();
  final tapes = {for (final t in values[0]) '${t['txid']}:${t['index']}': t},
      identities = values[1] as Map<String, Map<String, dynamic>>,
      result = <int, Map<String, dynamic>>{};
  for (final row in rows) {
    final outputs = row['transaction']['outputs'] as List,
        nfts = groups[row['index']]!,
        consumed = <String>{},
        outputNfts = <Map<String, dynamic>>[],
        nativeOut = <String, BigInt>{};
    for (final nft in nfts) {
      final u = nft['input'],
          identity = identities[u['scriptPubKey']]!,
          tape = tapes['${u['txid']}:${u['vout'] + 2}'];
      need(
        tape != null &&
            tape['value'] == '0' &&
            tape['scriptPubKey'] == identity['tape'] &&
            consumed.add(identity['contractId']),
        'REVIEWED_NFT_INPUT_IDENTITY',
      );
    }
    final issued = <String>{};
    for (var i = 0; i < outputs.length; i++) {
      final o = outputs[i], plain = _plain.firstMatch(o['scriptPubKey']);
      if (plain != null) {
        final a = reviewedAddress(plain.group(1)!);
        nativeOut[a] =
            (nativeOut[a] ?? BigInt.zero) + BigInt.parse(o['satoshis']);
        continue;
      }
      final identity = identities[o['scriptPubKey']];
      need(
        identity != null && i + 2 < outputs.length,
        'REVIEWED_NFT_OUTPUT_CODE',
      );
      final hold = outputs[i + 1],
          tape = outputs[i + 2],
          owner = _hold.firstMatch(hold['scriptPubKey']);
      need(
        o['satoshis'] == '200' &&
            hold['satoshis'] == '100' &&
            tape['satoshis'] == '0' &&
            owner != null &&
            tape['scriptPubKey'] == identity!['tape'] &&
            consumed.contains(identity['contractId']) &&
            issued.add(identity['contractId']),
        'REVIEWED_NFT_OUTPUT_IDENTITY',
      );
      outputNfts.add({
        'identity': identity,
        'to': reviewedAddress(owner!.group(1)!),
      });
      i += 2;
    }
    need(issued.length == consumed.length, 'REVIEWED_NFT_CONSERVATION');
    final incoming = (row['inputs'] as List).fold<BigInt>(
          BigInt.zero,
          (s, u) => s + BigInt.from(u['satoshis']),
        ),
        outgoing = outputs.fold<BigInt>(
          BigInt.zero,
          (s, o) => s + BigInt.parse(o['satoshis']),
        );
    need(incoming >= outgoing, 'REVIEWED_NATIVE_OVERSPEND');
    result[row['index']] =
        frozen({
              'index': row['index'],
              'txid': row['transaction']['txid'],
              if (material['format'] == 'associated')
                'txidKind': 'unsigned-preview',
              'feeSatoshis': '${incoming - outgoing}',
              'classification': {
                'protocol': 'nft',
                'action': 'transfer',
                'conformance': 'standard',
              },
              'groups': [
                for (final n in outputNfts)
                  {
                    'key': 'nft:${n['identity']['contractId']}',
                    'asset': {
                      'type': 'nft',
                      'contractId': n['identity']['contractId'],
                      'collectionId': n['identity']['collectionId'],
                      'tokenId': n['identity']['tokenId'],
                    },
                    'flows': [
                      {
                        'purpose':
                            n['to'] == account['address'] ? 'self' : 'transfer',
                        'direction':
                            n['to'] == account['address'] ? 'self' : 'out',
                        'recognized': true,
                        'isSelf': n['to'] == account['address'],
                        'from': {'address': account['address']},
                        'to': {'address': n['to']},
                      },
                    ],
                  },
                {
                  'key': 'tbc:TBC',
                  'asset': {'type': 'tbc', 'symbol': 'TBC'},
                  'flows': [
                    for (final n in nativeOut.entries)
                      {
                        'purpose':
                            n.key == account['address'] ? 'self' : 'transfer',
                        'direction':
                            n.key == account['address'] ? 'self' : 'out',
                        'amount': {'raw': '${n.value}'},
                        'recognized': true,
                        'isSelf': n.key == account['address'],
                        'from': {'address': account['address']},
                        'to': {'address': n.key},
                      },
                  ],
                },
              ],
            })
            as Map<String, dynamic>;
  }
  return Map.unmodifiable(result);
}
