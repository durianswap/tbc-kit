// A single job's authenticated material, ported from frozen rc.16. Immutable
// reads are reused; accepted Engine-validated change funds the next sub-batch.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'nft_mint_job.dart';

final class NftMintJobMaterial {
  NftMintJobMaterial._(
    this.scope,
    this.base,
    this.contract,
    this.ownerScript,
    this.expiresAt,
    this.native,
    this.slots,
    this.parents,
  );
  final NftJobMap scope, base, contract;
  final String ownerScript;
  final DateTime expiresAt;
  final Map<String, NftJobMap> native, parents;
  final Map<int, NftJobMap> slots;
  int _revision = 0;
  static Future<NftMintJobMaterial> prepare({
    required NftJobMap scope,
    required NftJobMap account,
    required Future<NftJobMap> Function(NftJobMap) resolve,
  }) async {
    final n = (scope['items'] as List).length;
    // Resolver read promises live in the same preparation scope. All groups
    // see the same native index, collection index and immutable creation raw.
    final snapshots = await Future.wait([
      for (var i = 0; i < n; i += 100)
        resolve(
          nftMintJobRequest(
            scope,
            i,
            100,
            scope['limits']['maxTotalFee'],
            scope['limits']['expiresAt'],
          ),
        ),
    ]);
    final first = snapshots.first['payload'] as NftJobMap;
    final contract = copied((first['contracts'] as List).single as Map);
    need(
      contract['contractId'] == scope['collectionId'] &&
          contract['family'] == 'collection' &&
          contract['standardId'] == 'tbc721-standard',
      'NFT_JOB_COLLECTION',
    );
    final native = <String, NftJobMap>{},
        parents = <String, NftJobMap>{},
        slots = <int, NftJobMap>{};
    final wanted = (scope['items'] as List).map((i) => i['slot']).toSet();
    var expiry = protocolTime(scope['limits']['expiresAt']);
    final nativeSets = <Set<String>>[];
    for (final snapshot in snapshots) {
      final p = snapshot['payload'] as Map;
      need(
        snapshot['snapshotHash'] == hashJson(p) &&
            canonical(p['account']) == canonical(account) &&
            p['chainId'] == scope['authority']['chainId'],
        'NFT_JOB_MATERIAL_BINDING',
      );
      final c = copied((p['contracts'] as List).single as Map);
      need(
        canonical({...c, 'currentOutpoint': null}) ==
            canonical({...contract, 'currentOutpoint': null}),
        'NFT_JOB_COLLECTION_CONFLICT',
      );
      final e = protocolTime(p['expiresAt']);
      if (e.isBefore(expiry)) expiry = e;
      for (final raw in p['parents'] as List) {
        final v = copied(raw as Map), id = v['txid'] as String;
        need(
          !parents.containsKey(id) ||
              parents[id]!['rawTransaction'] == v['rawTransaction'],
          'NFT_JOB_PARENT_CONFLICT',
        );
        parents[id] = v;
      }
      final nativeSet = <String>{};
      for (final raw in p['utxos'] as List) {
        final u = copied(raw as Map), key = '${u['txid']}:${u['vout']}';
        if (u['classification'] == 'native') {
          need(
            !native.containsKey(key) || canonical(native[key]) == canonical(u),
            'NFT_JOB_NATIVE_CONFLICT',
          );
          native[key] = u;
          nativeSet.add(key);
        } else {
          need(
            u['classification'] == 'collection-slot' &&
                u['txid'] == scope['collectionId'] &&
                wanted.contains(u['vout']),
            'NFT_JOB_UNRELATED_MATERIAL',
          );
          final slot = u['vout'] as int;
          need(
            !slots.containsKey(slot) || canonical(slots[slot]) == canonical(u),
            'NFT_JOB_SLOT_CONFLICT',
          );
          slots[slot] = u;
        }
      }
      nativeSets.add(nativeSet);
    }
    need(
      slots.length == wanted.length &&
          parents.containsKey(scope['collectionId']) &&
          nativeSets.every(
            (s) => s.length == native.length && s.every(native.containsKey),
          ),
      'NFT_JOB_INCOMPLETE_MATERIAL',
    );
    final owner = inspectAccount(
      account,
      expectedChainId: scope['authority']['chainId'],
    );
    return NftMintJobMaterial._(
      scope,
      copied(first),
      contract,
      owner['scriptPubKey']!,
      expiry,
      native,
      slots,
      parents,
    );
  }

  List<NftJobMap> _select(List<int> requested) {
    need(
      DateTime.now().isBefore(expiresAt) &&
          requested.isNotEmpty &&
          requested.length <= 100 &&
          requested.toSet().length == requested.length &&
          requested.every(slots.containsKey),
      'NFT_JOB_SLOT_UNAVAILABLE',
    );
    return requested.map((s) => slots[s]!).toList();
  }

  NftJobMap snapshot(List<int> requested) {
    final selected = _select(requested), id = scope['collectionId'];
    final requiredParents = {
      id,
      ...native.values.map((u) => u['txid']).where(parents.containsKey),
    };
    final p = {
      ...base,
      'snapshotId':
          'nft-job-${hashJson({'scope': hashJson(scope), 'revision': _revision, 'slots': requested}).substring(0, 32)}',
      'expiresAt': expiresAt.toUtc().toIso8601String(),
      'utxos': [...native.values, ...selected],
      'parents': [for (final id in requiredParents) parents[id]],
      'contracts': [
        {
          ...contract,
          'currentOutpoint': {'txid': id, 'vout': requested.first},
        },
      ],
    };
    return copied({'payload': p, 'snapshotHash': hashJson(p)});
  }

  void acceptValidatedBatch(List<int> requested, List<NftJobMap> transactions) {
    _select(requested);
    need(transactions.length == requested.length, 'NFT_JOB_SIGNED_COUNT');
    final nextNative = {...native},
        nextParents = {...parents},
        spent = <String>{},
        ids = <String>{};
    for (var i = 0; i < transactions.length; i++) {
      final value = transactions[i], id = value['txid'] as String;
      final tx = inspectTransaction(value['rawTransaction'], id),
          inputs = tx['inputs'] as List;
      need(
        ids.add(id) &&
            !nextParents.containsKey(id) &&
            inputs.first['txid'] == scope['collectionId'] &&
            inputs.first['vout'] == requested[i],
        'NFT_JOB_SIGNED_SLOT',
      );
      for (var vin = 0; vin < inputs.length; vin++) {
        final input = inputs[vin], key = '${input['txid']}:${input['vout']}';
        need(
          spent.add(key) && (vin == 0 || nextNative.containsKey(key)),
          'NFT_JOB_SPENT_INPUT',
        );
        nextNative.remove(key);
      }
      final outputs = tx['outputs'] as List;
      for (var vout = 3; vout < outputs.length; vout++) {
        final output = outputs[vout];
        need(
          output['scriptPubKey'] == ownerScript && output['satoshis'] != '0',
          'NFT_JOB_CHANGE',
        );
        nextNative['$id:$vout'] = {
          'txid': id,
          'vout': vout,
          'satoshis': output['satoshis'],
          'scriptPubKey': ownerScript,
          'classification': 'native',
          'confirmations': '0',
        };
      }
      nextParents[id] = {'txid': id, 'rawTransaction': value['rawTransaction']};
    }
    native
      ..clear()
      ..addAll(nextNative);
    for (final slot in requested) slots.remove(slot);
    parents
      ..clear()
      ..[scope['collectionId']] = nextParents[scope['collectionId']]!;
    for (final value in native.values) {
      final p = nextParents[value['txid']];
      if (p != null) parents[p['txid']] = p;
    }
    _revision++;
  }
}
