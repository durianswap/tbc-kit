// Reconstruct API Code/Tape fields omitted by old captures from their frozen
// transaction bytes. Expected transactions and signatures are never changed.
import 'dart:convert';
import 'dart:ffi';
import 'package:crypto/crypto.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'trusted_index_candidate.dart';

final class IndexedFixture {
  IndexedFixture(Iterable<Map> samples) {
    probe = ComputeProbe(
      DynamicLibrary.open(trustedIndexCandidateLibrary()['path']),
    );
    for (final sample in samples) {
      for (final p
          in sample['audit']?['material']?['snapshot']?['payload']?['parents'] ??
              []) {
        raw.putIfAbsent(
          p['txid'],
          () => inspectTransaction(p['rawTransaction'], p['txid']),
        );
      }
    }
  }
  late final ComputeProbe probe;
  final raw = <String, Map<String, dynamic>>{};
  Map<String, dynamic> call(String method, Map<String, dynamic> value) =>
      copied(jsonDecode(probe.call('keyless', method, canonical(value))));
  BigInt amount(String tape) {
    final bytes = unhex(tape);
    var total = BigInt.zero;
    for (var at = 3; at < 51; at += 8) {
      for (var n = 0; n < 8; n++)
        total += BigInt.from(bytes[at + n]) << (8 * n);
    }
    return total;
  }

  Map<String, dynamic> ftInfo(String id) {
    final outputs = raw[id]!['outputs'];
    return {
      'code_script': outputs[0]['scriptPubKey'],
      'tape_script': outputs[1]['scriptPubKey'],
      'amount': '${amount(outputs[1]['scriptPubKey'])}',
    };
  }

  Map<String, dynamic> coinInfo(String id, {String? creationTxid}) {
    final issuer = raw[id]!,
        hash =
            sha256
                .convert(unhex(issuer['outputs'][0]['scriptPubKey']))
                .toString();
    final outputs = (raw[creationTxid] ?? issuer)['outputs'] as List;
    // Legacy StableCoin issuance is the contract transaction itself (3/4).
    if (outputs.length > 4 &&
        outputs[3]['satoshis'] == '500' &&
        outputs[4]['satoshis'] == '0') {
      final tape = outputs[4]['scriptPubKey'] as String;
      return {
        'stablecoin_id': id,
        'utxo': {'txid': id, 'vout': 0},
        'code_script': outputs[3]['scriptPubKey'],
        'tape_script': tape,
        'supply': '${amount(tape)}',
      };
    }
    Map<String, dynamic>? selected;
    var supply = BigInt.zero;
    for (final p in raw.values) {
      final outs = p['outputs'] as List;
      for (var v = 0; v + 1 < outs.length; v++) {
        if (outs[v]['satoshis'] != '500' || outs[v + 1]['satoshis'] != '0')
          continue;
        final code = outs[v]['scriptPubKey'] as String;
        if (!code.contains(hash)) continue;
        final d =
            (call('inspectTokenMaterial', {
                      'phase': 'inspectCodes',
                      'scripts': [code],
                    })['codes']
                    as List)
                .single;
        if (d?['coinNftCodeHash'] != hash) continue;
        final tape = outs[v + 1]['scriptPubKey'] as String,
            observed = amount(tape);
        if (observed <= supply) continue;
        supply = observed;
        selected = {
          'stablecoin_id': id,
          'utxo': {'txid': p['txid'], 'vout': 0},
          'code_script': code,
          'tape_script': tape,
          'supply': '$supply',
        };
      }
    }
    if (selected == null) throw StateError('No frozen Coin issuance for $id');
    return selected;
  }

  void enrich(Map sample) {
    final replies = sample['replies'] as Map;
    for (final record
        in sample['audit']['material']['snapshot']['payload']['contracts']) {
      final id = record['contractId'] as String;
      if (record['family'] == 'ft')
        replies['/api/tbc/ft/info/contract/$id'] = ftInfo(id);
      if (record['family'] == 'stablecoin') {
        final path = '/api/tbc/stablecoin/info/stablecoinid/$id';
        final indexed = coinInfo(id, creationTxid: record['creationTxid']);
        replies[path] = {
          ...indexed,
          ...?replies[path],
          for (final e in indexed.entries)
            if (e.key != 'utxo') e.key: e.value,
        };
      }
      if (record['standardId'] == 'tbc-amm') {
        final p = raw[record['currentOutpoint']['txid']] ?? raw[id]!;
        final meta = call('inspectAmmMaterial', {
          'phase': 'inspectPool',
          'pool': {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
        });
        final ftid = meta['ftContractId'];
        replies['/api/tbc/ft/info/contract/$ftid'] = ftInfo(ftid);
        replies.putIfAbsent(
          '/api/tbc/pool/poolinfo/poolid/$id',
          () => {
            'txid': p['txid'],
            'vout': 0,
            'value': meta['state']['poolValue'],
            'pool_code_script': p['outputs'][0]['scriptPubKey'],
            'ft_contract_id': ftid,
            'token_balance': meta['state']['ftAmount'],
            'lp_balance': meta['state']['lpAmount'],
            'tbc_balance': meta['state']['tbcAmount'],
            'service_fee_rate': meta['serviceFeeRate'],
          },
        );
      }
    }
  }

  // Rebase only the read evidence of holder-transfer/merge oracles. Asset
  // selection, transaction templates and recorded signatures remain frozen.
  void projectHolder(Map sample, {bool requireTip = false}) {
    enrich(sample);
    final old = sample['audit']['material']['snapshot'];
    var snapshot = copied(old);
    final p = snapshot['payload'], keep = <String>{}, extra = <String>{};
    for (final record in p['contracts']) {
      final family = record['family'];
      need(family == 'ft' || family == 'stablecoin', 'HOLDER_ORACLE_FAMILY');
      final coin = family == 'stablecoin', id = record['contractId'];
      final path =
          coin
              ? '/api/tbc/stablecoin/info/stablecoinid/$id'
              : '/api/tbc/ft/info/contract/$id';
      final info = sample['replies'][path];
      extra.add(path);
      record['indexedFungible'] = {
        'codeScript': info['code_script'],
        'tapeScript': info['tape_script'],
        'totalSupply': info[coin ? 'supply' : 'amount'],
      };
      if (coin) record['creationTxid'] = id;
      final current = ['tbc20', 'coin'].contains(record['protocolVersion']);
      for (final u in p['utxos']) {
        if (u['classification'] != family) continue;
        final parent = raw[u['txid']]!;
        keep.add(u['txid']);
        keep.addAll(
          (current ? tbc20References : legacyFtReferences)(parent, u['vout']),
        );
      }
    }
    (p['parents'] as List).removeWhere((r) => !keep.contains(r['txid']));
    final zero =
        (sample['minConfirmations'] ??
            sample['audit']['material']['policy']['payload']['minConfirmations']) ==
        '0';
    if (zero && !requireTip) snapshot = withoutObservedTip(snapshot);
    snapshot['snapshotHash'] = hashJson(snapshot['payload']);
    rebindExpectedSnapshot(sample, snapshot);
    for (final trace in ['coldTrace', 'warmTrace']) {
      final paths = sample[trace] as List?;
      if (paths == null) continue;
      paths.removeWhere(
        (path) =>
            (zero && !requireTip && path == '/api/tbc/nodeinfo') ||
            (path as String).contains('/txraw/') &&
                !keep.contains(path.split('/').last),
      );
      for (final path in extra) if (!paths.contains(path)) paths.add(path);
    }
  }

  // The new AMM consumes API Code/Tape plus direct unlocking parents, not a
  // replay of the entire issuance chain. Derive the expected remaining proof
  // set from frozen transaction bytes; never copy the reader's actual output.
  void projectAmm(Map sample) {
    enrich(sample);
    var snapshot = copied(sample['audit']['material']['snapshot']);
    final p = snapshot['payload'], intent = sample['request']['intent'];
    final create = intent['type'] == 'tbc-amm-create';
    final zero =
        (sample['minConfirmations'] ??
            sample['audit']['material']['policy']['payload']['minConfirmations']) ==
        '0';
    final keep = <String>{};
    String? first;
    bool lock = false;
    String ftid;
    if (create) {
      ftid = intent['ftContractId'];
      final info = sample['replies']['/api/tbc/ft/info/contract/$ftid'];
      p['contracts'][0]['indexedFungible'] = {
        'codeScript': info['code_script'],
        'tapeScript': info['tape_script'],
        'totalSupply': info['amount'],
      };
    } else {
      final record = (p['contracts'] as List).single;
      final info =
          sample['replies']['/api/tbc/pool/poolinfo/poolid/${record['contractId']}'];
      ftid = info['ft_contract_id'];
      final ft = sample['replies']['/api/tbc/ft/info/contract/$ftid'];
      record['indexedPool'] = {
        'ftCodeScript': ft['code_script'],
        'ftTapeScript': ft['tape_script'],
      };
      first =
          (p['utxos'] as List).firstWhere(
            (u) => u['classification'] == 'native',
          )['txid'];
      keep.add(first!);
      final pool = raw[record['currentOutpoint']['txid']]!;
      keep.add(pool['txid']);
      keep.add(pool['inputs'][0]['txid']);
      for (final u in p['utxos']) {
        final type = u['classification'];
        if (!['pool-ft', 'ft', 'ftlp'].contains(type)) continue;
        final parent = raw[u['txid']]!;
        keep.add(u['txid']);
        final item =
            (call('inspectAmmMaterial', {
                      'phase': 'inspectAssets',
                      'parents': [
                        {
                          'txid': parent['txid'],
                          'rawTransaction': parent['rawTransaction'],
                        },
                      ],
                      'outputs': [
                        {
                          'txid': u['txid'],
                          'vout': u['vout'],
                          'kind': type == 'ftlp' ? 'lp' : 'ft',
                        },
                      ],
                    })['items']
                    as List)
                .single;
        for (final dep in item['dependencies']) keep.add(dep['txid']);
        if (type == 'ftlp' && item['lockTime'] != 0) lock = true;
      }
    }
    final oldParents = {for (final r in p['parents']) r['txid']: r};
    need(keep.every(oldParents.containsKey), 'ORACLE_PARENT_MISSING');
    final rest = keep.where((id) => id != first).toList()..sort();
    p['parents'] = [
      if (first != null) oldParents[first],
      for (final id in rest) oldParents[id],
    ];
    if (zero) {
      final block = p['block'];
      snapshot = withoutObservedTip(snapshot);
      if (lock) {
        snapshot['payload']['block'] = block;
        // A locked LP causes the one tip query only when encountered. Later
        // LP rows can use that observation, but earlier/native rows cannot.
        var observed = false;
        for (var i = 0; i < (p['utxos'] as List).length; i++) {
          final u = p['utxos'][i];
          if (u['classification'] != 'ftlp') continue;
          if (observed && u['confirmations'] != null)
            snapshot['payload']['utxos'][i]['confirmations'] =
                u['confirmations'];
          final item =
              (call('inspectAmmMaterial', {
                        'phase': 'inspectAssets',
                        'parents': [
                          {
                            'txid': u['txid'],
                            'rawTransaction': raw[u['txid']]!['rawTransaction'],
                          },
                        ],
                        'outputs': [
                          {'txid': u['txid'], 'vout': u['vout'], 'kind': 'lp'},
                        ],
                      })['items']
                      as List)
                  .single;
          observed = observed || item['lockTime'] != 0;
        }
      }
    }
    snapshot['snapshotHash'] = hashJson(snapshot['payload']);
    rebindExpectedSnapshot(sample, snapshot);
    final infoPath = '/api/tbc/ft/info/contract/$ftid';
    for (final trace in ['coldTrace', 'warmTrace']) {
      final paths = sample[trace] as List;
      paths.removeWhere(
        (path) =>
            (zero && !lock && path == '/api/tbc/nodeinfo') ||
            (path as String).contains('/txraw/') &&
                !keep.contains(path.split('/').last),
      );
      if (!paths.contains(infoPath)) paths.add(infoPath);
    }
  }

  void projectPool2(Map sample) {
    enrich(sample);
    var snapshot = copied(sample['audit']['material']['snapshot']);
    final p = snapshot['payload'], records = p['contracts'] as List;
    final ft = records.singleWhere((r) => r['family'] == 'ft');
    final pool = records.singleWhere((r) => r['family'] == 'pool');
    final ftid = ft['contractId'], infoPath = '/api/tbc/ft/info/contract/$ftid';
    final info = sample['replies'][infoPath];
    ft['indexedFungible'] = {
      'codeScript': info['code_script'],
      'tapeScript': info['tape_script'],
      'totalSupply': info['amount'],
    };
    pool['indexedPool'] = {
      'ftCodeScript': info['code_script'],
      'ftTapeScript': info['tape_script'],
    };
    final fee =
        (p['utxos'] as List).firstWhere(
          (u) => u['classification'] == 'native',
        )['txid'];
    final current = raw[pool['currentOutpoint']['txid']]!;
    final keep = <String>{fee, current['inputs'][0]['txid'], current['txid']};
    final selection =
        (sample['nativeCalls'] as List).singleWhere(
          (c) =>
              c['method'] == 'preparePoolNft' &&
              c['input']['phase'] == 'select',
        )['result'];
    final assets = [
      for (final key in [
        'ownerFtCandidates',
        'poolFtCandidates',
        'ftlpCandidates',
      ])
        for (final u in selection[key])
          {'txid': u['txid'], 'vout': u['outputIndex']},
    ];
    final statusParents = <String>{
      current['txid'],
      for (final u in assets) u['txid'],
    };
    for (final u in assets) {
      keep.add(u['txid']);
      final refs =
          (call('prepareAssetAncestry', {
                    'phase': 'inspect',
                    'items': [
                      {
                        'parentTxid': u['txid'],
                        'outputIndex': u['vout'],
                        'parentTxraw': raw[u['txid']]!['rawTransaction'],
                      },
                    ],
                  })['items']
                  as List)
              .single['references'];
      for (final ref in refs) keep.add(ref['txid']);
    }
    final previous = {for (final r in p['parents']) r['txid']: r};
    need(keep.every(previous.containsKey), 'POOL2_ORACLE_PARENT_MISSING');
    p['parents'] = [for (final id in keep) previous[id]];
    // Issuance source was historical identity evidence, never a spend input.
    // Indexed Code/Tape replaces that unused descriptor, not its spend checks.
    (p['utxos'] as List).removeWhere(
      (u) => u['classification'] == 'pool-source',
    );
    final zero =
        (sample['minConfirmations'] ??
            sample['audit']['material']['policy']['payload']['minConfirmations']) ==
        '0';
    final type = sample['request']['intent']['type'] as String;
    final locked =
        sample['audit']['material']['policy']['payload']['pool']?['ftlpLockTimeEnabled'] ==
            true &&
        ![
          'tbc.pool.swapToToken',
          'tbc.pool.swapToTbc',
          'amm.swap',
        ].contains(type);
    if (zero) {
      final block = p['block'];
      snapshot = withoutObservedTip(snapshot);
      if (locked) snapshot['payload']['block'] = block;
    }
    snapshot['snapshotHash'] = hashJson(snapshot['payload']);
    rebindExpectedSnapshot(sample, snapshot);
    for (final trace in ['coldTrace', 'warmTrace']) {
      final paths = sample[trace] as List?;
      if (paths == null) continue;
      paths.removeWhere(
        (path) =>
            (zero && !locked && path == '/api/tbc/nodeinfo') ||
            (path as String).contains('/txraw/') &&
                !keep.contains(path.split('/').last) ||
            path.contains('/decode/') &&
                !statusParents.contains(path.split('/').last),
      );
      if (!paths.contains(infoPath)) paths.add(infoPath);
      sample[trace] = paths.toSet().toList();
    }
  }

  void projectLp(Map sample) {
    enrich(sample);
    var snapshot = copied(sample['audit']['material']['snapshot']);
    final p = snapshot['payload'], record = (p['contracts'] as List).single;
    final id = record['contractId'], path = '/api/tbc/pool/poolinfo/poolid/$id';
    final pool = sample['replies'][path], ftid = pool['ft_contract_id'];
    final ftpath = '/api/tbc/ft/info/contract/$ftid',
        ft = sample['replies'][ftpath];
    record['indexedPool'] = {
      'ftCodeScript': ft['code_script'],
      'ftTapeScript': ft['tape_script'],
    };
    record['currentOutpoint'] = {'txid': pool['txid'], 'vout': 0};
    final keep = <String>{pool['txid']}, deps = <String>{};
    bool locked = false;
    for (final u in p['utxos']) {
      if (u['classification'] != 'ftlp') continue;
      keep.add(u['txid']);
      final item =
          (call('inspectAmmMaterial', {
                    'phase': 'inspectAssets',
                    'parents': [
                      {
                        'txid': u['txid'],
                        'rawTransaction': raw[u['txid']]!['rawTransaction'],
                      },
                    ],
                    'outputs': [
                      {'txid': u['txid'], 'vout': u['vout'], 'kind': 'lp'},
                    ],
                  })['items']
                  as List)
              .single;
      for (final d in item['dependencies']) deps.add(d['txid']);
      if (item['lockTime'] != 0) locked = true;
    }
    keep.addAll(deps);
    final previous = {
      for (final parent in p['parents']) parent['txid']: parent,
    };
    need(keep.every(previous.containsKey), 'LP_ORACLE_PARENT_MISSING');
    p['parents'] = [for (final id in keep) previous[id]];
    final zero =
        (sample['minConfirmations'] ??
            sample['audit']['material']['policy']['payload']['minConfirmations']) ==
        '0';
    if (zero) {
      final block = p['block'];
      snapshot = withoutObservedTip(snapshot);
      if (locked) {
        snapshot['payload']['block'] = block;
        var observed = false;
        for (var i = 0; i < (p['utxos'] as List).length; i++) {
          final u = p['utxos'][i];
          if (u['classification'] != 'ftlp') continue;
          if (observed && u['confirmations'] != null)
            snapshot['payload']['utxos'][i]['confirmations'] =
                u['confirmations'];
          final item =
              (call('inspectAmmMaterial', {
                        'phase': 'inspectAssets',
                        'parents': [
                          {
                            'txid': u['txid'],
                            'rawTransaction': raw[u['txid']]!['rawTransaction'],
                          },
                        ],
                        'outputs': [
                          {'txid': u['txid'], 'vout': u['vout'], 'kind': 'lp'},
                        ],
                      })['items']
                      as List)
                  .single;
          observed = observed || item['lockTime'] != 0;
        }
      }
    }
    snapshot['snapshotHash'] = hashJson(snapshot['payload']);
    rebindExpectedSnapshot(sample, snapshot);
    for (final key in ['coldTrace', 'warmTrace']) {
      final paths = sample[key] as List;
      paths.removeWhere(
        (path) =>
            (zero && !locked && path == '/api/tbc/nodeinfo') ||
            (path as String).contains('/txraw/') &&
                !keep.contains(path.split('/').last),
      );
      for (final route in [path, ftpath])
        if (!paths.contains(route)) paths.add(route);
    }
  }

  void projectLop(Map sample) {
    final original = copied(sample['audit']['material']['snapshot']);
    projectHolder(sample);
    final snapshot = sample['audit']['material']['snapshot'],
        p = snapshot['payload'];
    final keep = <String>{};
    bool locked = false;
    // Market-only asset identities are not spendable outpoints. Selected
    // escrow inputs still retain their exact frozen outpoints and scripts.
    for (final record in p['contracts']) {
      final id = record['contractId'];
      final selected = (p['utxos'] as List).where(
        (u) =>
            u['contractId'] == id &&
            ['ft', 'stablecoin'].contains(u['classification']),
      );
      if (selected.isEmpty) record['currentOutpoint'] = {'txid': id, 'vout': 0};
    }
    for (final u in p['utxos']) {
      if (u['classification'] == 'native') continue;
      keep.add(u['txid']);
      if (!['ft', 'stablecoin'].contains(u['classification'])) continue;
      final item = call('inspectLopMaterial', {
        'phase': 'inspectAsset',
        'parent': {
          'txid': u['txid'],
          'rawTransaction': raw[u['txid']]!['rawTransaction'],
        },
        'vout': u['vout'],
      });
      for (final dep in item['dependencies']) keep.add(dep['txid']);
      locked = locked || uintString(item['lockTime']) != '0';
    }
    p['parents'] = [
      for (final parent in original['payload']['parents'])
        if (keep.contains(parent['txid'])) parent,
    ];
    if (locked && sample['minConfirmations'] == '0') {
      p['block'] = original['payload']['block'];
      for (var i = 0; i < (p['utxos'] as List).length; i++) {
        if (p['utxos'][i]['classification'] == 'native' &&
            original['payload']['utxos'][i]['confirmations'] != null)
          p['utxos'][i]['confirmations'] =
              original['payload']['utxos'][i]['confirmations'];
      }
    }
    snapshot['snapshotHash'] = hashJson(p);
    rebindExpectedSnapshot(sample, snapshot);
    for (final key in ['coldTrace', 'warmTrace']) {
      final originalPaths = List<String>.from(sample[key]);
      // Restore order-only parents that a fungible-only projection omits.
      if (key == 'coldTrace')
        for (final id in keep) {
          final rawPath = '/api/tbc/txraw/txid/$id';
          if (sample['replies'].containsKey(rawPath) &&
              !originalPaths.contains(rawPath) &&
              !originalPaths.contains('/api/tbc/decode/txid/$id'))
            originalPaths.add(rawPath);
        }
      if (locked && !originalPaths.contains('/api/tbc/nodeinfo'))
        originalPaths.add('/api/tbc/nodeinfo');
      sample[key] = originalPaths;
    }
  }
}
