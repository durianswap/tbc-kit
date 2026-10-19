// Per-run maintenance index/material composition. It selects bounded inputs,
// not transactions: the existing readers, Engine and native signing lifecycle
// remain authoritative. No HTTP stack, signer, durable store or Legacy branch.
import '../configuration.dart';
import 'multi_round_merge.dart';
import 'native_material.dart';
import 'pool2_material.dart';
import 'protocol_codec.dart';
import 'stablecoin_material.dart';
import 'tbc20_material.dart';
import 'transaction_policy.dart';
import 'transaction_read.dart';
import 'unified_pool_material.dart';
import 'utxo_pages.dart';
import 'chain_read_reply.dart';

Map<String, dynamic> _owned(Map v) => frozen(copied(v)) as Map<String, dynamic>;
String _point(Map v) => '${v['txid']}:${v['vout'] ?? v['index']}';

final class MergeMaterialSession {
  MergeMaterialSession({
    required this.history,
    required Map account,
    required Map authority,
    required Map asset,
    required this.requireCurrent,
    required this.clock,
  }) : account = _owned(account),
       authority = _owned(authority),
       asset = _owned(asset) {
    inspectAccount(this.account, expectedChainId: network.chainId);
    need(
      authority['accountId'] == account['accountId'] &&
          authority['chainId'] == network.chainId,
      'MERGE_MATERIAL_ACCOUNT',
    );
    // Reuse the coordinator's public shape checks without making an approval.
    normalizeMultiRoundMergeLimits(this.asset, {
      'targetUtxoCount': 1,
      'maxTransactions': 1,
      'maxTotalFee': '0',
      'expiresAt': _now.add(const Duration(minutes: 1)).toIso8601String(),
    }, clock().millisecondsSinceEpoch);
  }
  final Tbc20MaterialReader history;
  final Map<String, dynamic> account, authority, asset;
  // Must check the same account/session/origin/network and accounts+send grant.
  final Future<void> Function() requireCurrent;
  final DateTime Function() clock;
  // Dart wall clocks may carry microseconds; the shared wire format admits
  // seconds or milliseconds. Normalize our own timestamps, not caller input.
  DateTime get _now => DateTime.fromMillisecondsSinceEpoch(
    clock().millisecondsSinceEpoch,
    isUtc: true,
  );
  TbcNetworkConfiguration get network => history.network;
  final _accepted = <String>{};
  int _epoch = 0;
  bool _reading = false, _closed = false;
  _Round? _round;

  void close() {
    _closed = true;
    _epoch++;
    _round = null;
  }

  // Called only by the native-backed adapter after accepted/known submission,
  // never from a page DTO or a merely constructed transaction.
  void accepted(String txid) {
    need(!_closed, 'MERGE_MATERIAL_CLOSED');
    _accepted.add(hash32(txid));
    _epoch++;
    _round = null;
  }

  Future<void> _current(int epoch) async {
    need(!_closed && epoch == _epoch, 'MERGE_MATERIAL_STALE');
    await requireCurrent();
    need(!_closed && epoch == _epoch, 'MERGE_MATERIAL_STALE');
  }

  // Start only the ordinary reader's required independent tip/funding GETs
  // while bounded consent UI is pending. The same round owns both futures;
  // no new endpoint, retries, detached signing or cross-round mutable cache.
  void prefetch(Map state) {
    final r = _round;
    need(
      r != null &&
          !_closed &&
          r.epoch == _epoch &&
          canonical(state) == canonical(r.state),
      'MERGE_PREFETCH_STATE',
    );
    // Ordinary native/FT/Coin maintenance has no chain-time requirement.
    // Locked LP/Coin inputs request a tip lazily in their material reader.
    if (asset['kind'] != 'tbc') {
      r!.read('/api/tbc/utxo/address/${account['address']}').ignore();
    }
  }

  Future<MergeRecord> readState() async {
    need(!_reading && !_closed, 'MERGE_MATERIAL_ACTIVE');
    _reading = true;
    final epoch = ++_epoch;
    _round = null;
    try {
      await _current(epoch);
      final memo = <String, Future<Map<String, dynamic>>>{};
      Future<Map<String, dynamic>> read(String path) {
        final result = memo.putIfAbsent(path, () async {
          await _current(epoch);
          final value = frozen(copyChainReadReply(await history.read(path)))
              as Map<String, dynamic>;
          await _current(epoch);
          return value;
        });
        result.ignore();
        return result.then(copyChainReadReply);
      }

      final kind = asset['kind'],
          owner = inspectAccount(account, expectedChainId: network.chainId);
      String path;
      Map<String, dynamic>? poolIdentity;
      bool current = false;
      if (kind == 'tbc') {
        path = '/api/tbc/utxo/address/${account['address']}';
      } else if (kind == 'ft' || kind == 'stablecoin') {
        final id = asset['contractId'];
        path =
            kind == 'ft'
                ? '/api/tbc/ft/utxo/combinescript/${owner['publicKeyHash']}00/contract/$id'
                : '/api/tbc/stablecoin/utxo/combinescript/${owner['publicKeyHash']}00/stablecoinid/$id';
        // Reuse the same per-round info response during actual preparation.
        read(path).ignore();
        final indexed = await readIndexedFungible(read, history.keyless, id,
            coin: kind == 'stablecoin');
        current = indexed['identity']['generation'] == 'current';
      } else {
        final id = asset['poolContractId'] as String;
        final indexed = await read('/api/tbc/pool/poolinfo/poolid/$id');
        final pool = await history.parent(hash32(indexed['txid']));
        final hint = history.keyless('inspectAmmMaterial', {
          'phase': 'identifyPoolState',
          'pool': {'txid': pool['txid'], 'rawTransaction': pool['rawTransaction']},
        });
        need(hint['family'] == 'amm' && hint['verification'] == 'state-template' &&
            ['current', 'historical'].contains(hint['generation']), 'MERGE_POOL_TEMPLATE');
        current = hint['generation'] == 'current';
        final ftId = hash32(indexed['ft_contract_id']);
        need(
          !(current && kind == 'pool-ft'),
          'POOL_TEMPLATE_OPERATION_UNSUPPORTED',
        );
        Map<String, dynamic> descriptor;
        String poolTxid;
        if (current) {
          final ft = await readIndexedFungible(read, history.keyless, ftId, coin: false);
          descriptor = history.keyless('inspectAmmMaterial', {
            'phase': 'describe',
            'poolContractId': id,
            'indexedPool': {
              'ftCodeScript': ft['indexedFungible']['codeScript'],
              'ftTapeScript': ft['indexedFungible']['tapeScript'],
            },
            'currentPool': {'txid': pool['txid'], 'rawTransaction': pool['rawTransaction']},
            'publicKey': account['publicKey'],
          });
          need(descriptor['poolContractId'] == id, 'MERGE_POOL_DESCRIPTOR');
          path =
              '/api/tbc/pool/lputxo/scriptpubkeyhash/${hash32(descriptor['ownerLpScriptHash'])}';
          poolTxid = pool['txid'];
        } else {
          final info = pool2IndexInfo(indexed);
          final ft = await history.parent(ftId);
          descriptor = history.keyless('preparePoolNft', {
            'phase': 'describe',
            'contractId': id,
            'ownerAddress': account['address'],
            'info': info,
            'poolPreTxraw': pool['rawTransaction'],
            'ftContractTxraw': ft['rawTransaction'],
          });
          need(
            descriptor['stablecoin'] == false &&
                descriptor['ftContractId'] == ftId &&
                descriptor['ownerCombineScript'] ==
                    '${owner['publicKeyHash']}00',
            'MERGE_POOL_DESCRIPTOR',
          );
          poolTxid = info['txid'];
          path =
              kind == 'pool-ft'
                  ? '/api/tbc/ft/utxo/combinescript/${descriptor['poolCombineScript']}/contract/$ftId'
                  : '/api/tbc/pool/lputxo/scriptpubkeyhash/${hash32(descriptor['ftlpScriptHash'])}';
        }
        poolIdentity = {
          'poolContractId': id,
          'ftContractId': ftId,
          'currentPoolTxid': poolTxid,
        };
      }
      final reply = await collectUtxoPages(
        read,
        path,
        maxRows: 10000,
        allowNull: kind == 'ftlp',
      );
      final rawRows = (reply['utxos'] as List).cast<Map>();
      final rows = <Map<String, dynamic>>[];
      for (final row in rawRows) {
        final native = kind == 'tbc', lp = kind == 'ftlp';
        final value = uintString(
          row[native
                  ? 'value'
                  : lp && !current
                  ? 'tbc_balance'
                  : 'tbc_value'] ??
              (lp ? row['value'] : null),
        );
        final amount =
            native
                ? value
                : uintString(
                  row[lp && !current ? 'lp_balance' : 'ft_value'] ??
                      (lp ? row['balance'] : null),
                );
        need(value != '0' && amount != '0', 'MERGE_INDEX_ZERO');
        final normalized = <String, dynamic>{
          'txid': hash32(row['txid']),
          'vout': int.parse(uintString(row['index'] ?? row['vout'])),
          'satoshis': value,
          if (!native)
            (['ft', 'stablecoin'].contains(kind) ? 'ftAmount' : 'assetAmount'):
                amount,
          if (row['height'] != null)
            'height':
                row['height'] == -1 || row['height'] == '-1'
                    ? '0'
                    : uintString(row['height']),
          if (lp && row['lock_time'] != null)
            'lockTime': int.parse(uintString(row['lock_time'])),
        };
        rows.add(normalized);
      }
      await _current(epoch);
      final payload = <String, dynamic>{
        'version': '1.0',
        'authority': authority,
        'asset': asset,
        'observedAt': _now.toIso8601String(),
        'revision': hashJson(rows),
        'utxoCount': rows.length,
        if (poolIdentity != null) 'poolIdentity': poolIdentity,
        'observedTransactionIds':
            _accepted.where((id) => rows.any((r) => r['txid'] == id)).toList(),
      };
      final state = _owned({
        ...payload,
        'stateHash': hashMultiRoundMergeState(payload),
      });
      _round = _Round(
        epoch,
        state,
        rows.map(_owned).toList(),
        rawRows.map(_owned).toList(),
        path,
        read,
      );
      return state;
    } finally {
      _reading = false;
    }
  }

  MergeRecord prepareStep(MergeRecord input) {
    final r = _round,
        scope = input['scope'] as Map,
        approval = input['approval'] as Map;
    need(
      r != null &&
          !r.claimed &&
          !_closed &&
          r.epoch == _epoch &&
          canonical(input['state']) == canonical(r.state) &&
          canonical(scope['authority']) == canonical(authority) &&
          canonical(scope['asset']) == canonical(asset) &&
          input['scopeHash'] == hashJson(scope) &&
          approval['scopeHash'] == input['scopeHash'] &&
          approval['status'] == 'approved' &&
          approval['approvalId'] is String,
      'MERGE_MATERIAL_BINDING',
    );
    final selected = [...r!.rows]..sort((a, b) {
      final key =
          asset['kind'] == 'tbc'
              ? 'satoshis'
              : ['ft', 'stablecoin'].contains(asset['kind'])
              ? 'ftAmount'
              : 'assetAmount';
      final value = BigInt.parse(a[key]).compareTo(BigInt.parse(b[key]));
      final id = (a['txid'] as String).compareTo(b['txid']);
      return value != 0
          ? value
          : id != 0
          ? id
          : (a['vout'] as int).compareTo(b['vout']);
    });
    final max =
        asset['kind'] == 'tbc'
            ? 100
            : asset['kind'] == 'pool-ft'
            ? 4
            : 5;
    final bounded = selected.take(max).toList(growable: false);
    need(bounded.length >= 2, 'MERGE_REQUIRES_TWO_INPUTS');
    final index = input['stepIndex'];
    need(index is int && index >= 1 && index <= 64, 'MERGE_STEP_INDEX');
    final end = protocolTime(scope['limits']['expiresAt']),
        approvedEnd = protocolTime(approval['expiresAt']);
    final expiry =
        (end.isBefore(approvedEnd) ? end : approvedEnd)
            .toUtc()
            .toIso8601String();
    final identity = hashJson({
      'domain': 'tbc-kit/multi-round-step/1',
      'scopeHash': input['scopeHash'],
      'approvalId': approval['approvalId'],
      'stepIndex': index,
    });
    final request = _owned({
      'version': '1.0',
      'chainId': network.chainId,
      'from': account['address'],
      'clientRequestId': 'kit-multi-round-$identity',
      'intent': {
        'version': '1.0',
        'type': switch (asset['kind']) {
          'tbc' => 'tbc.maintenance.merge',
          'ft' => 'tbc20.merge',
          'stablecoin' => 'tbc20Stablecoin.merge',
          'pool-ft' => 'amm.mergeToken',
          _ => 'tbc20Lp.merge',
        },
        if (asset['contractId'] != null) 'contractId': asset['contractId'],
        if (asset['poolContractId'] != null)
          'poolContractId': asset['poolContractId'],
      },
      'constraints': {
        'expiresAt': expiry,
        'maxFee': uintString(input['remainingFee']),
        'feePreference': 'standard',
      },
    });
    final step = MergeMaterialStep._(this, r, request, bounded);
    r.claimed = true;
    return Map<String, dynamic>.unmodifiable({
      'version': '1.0',
      'stepId': 'merge-$index',
      'stepIndex': index,
      'authority': authority,
      'asset': asset,
      'stateHash': r.state['stateHash'],
      'materialHash': hashJson(request),
      'inputCount': bounded.length,
      'outputCount': 1,
      'feeKind': 'maximum',
      'fee': input['remainingFee'],
      'expiresAt': expiry,
      'dependsOn': List<String>.unmodifiable(
        (input['acceptedTxids'] as List).cast<String>().where(
          (id) => bounded.any((r) => r['txid'] == id),
        ),
      ),
      'prepared': step,
    });
  }
}

final class _Round {
  _Round(this.epoch, this.state, this.rows, this.raw, this.path, this.read);
  final int epoch;
  final MergeRecord state;
  final List<MergeRecord> rows, raw;
  final String path;
  final ApiRead read;
  bool claimed = false;
}

// Owns one exact round selection. Not serializable to a page and not an
// approval token. Every call must still enter the native single-op lifecycle.
final class MergeMaterialStep {
  MergeMaterialStep._(this._session, this._round, this.request, this._selected);
  final MergeMaterialSession _session;
  final _Round _round;
  final MergeRecord request;
  final List<MergeRecord> _selected;
  // Read-only private native binding evidence; not an input override exposed
  // to the page. Ordinary material + Engine still authenticate each outpoint.
  List<String> get selectedInputs =>
      List<String>.unmodifiable(_selected.map(_point));
  bool _used = false;
  MergeRecord? _snapshot;

  Future<MergeRecord> resolve({
    required Map request,
    required Map account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    need(
      !_used &&
          canonical(request) == canonical(this.request) &&
          canonical(account) == canonical(_session.account),
      'MERGE_STEP_BINDING',
    );
    _used = true;
    await _session._current(_round.epoch);
    final points = _selected.map(_point).toSet();
    Future<MergeRecord> read(String path) async {
      await _session._current(_round.epoch);
      // A wallet-owned selection, not a new API truth claim. The normal raw
      // material/Engine checks below still verify every selected asset.
      return path == _round.path
          ? {
            'utxos':
                _round.raw
                    .where((r) => points.contains(_point(r)))
                    .map(copied)
                    .toList(),
          }
          : _round.read(path);
    }

    final network = _session.network, history = _session.history;
    final funding = NativeMaterialReader(network: network, read: read);
    late MergeRecord snapshot, policy;
    final kind = _session.asset['kind'];
    if (kind == 'pool-ft' || kind == 'ftlp') {
      final p = await UnifiedPoolMaterialReader(
        network: network,
        read: read,
        readHistory: history.parent,
        rememberParent: history.rememberParent,
        keyless: history.keyless,
      ).resolve(
        request: this.request,
        account: _session.account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
      snapshot = p.snapshot;
      policy = p.policy(
        request: this.request,
        network: network,
        minConfirmations: minConfirmations,
      );
    } else {
      final resolve =
          kind == 'tbc'
              ? funding.resolve
              : kind == 'ft'
              ? _RoundFtReader(history, read).resolve
              : StablecoinMaterialReader(
                network: network,
                read: read,
                readHistory: history.parent,
                rememberParent: history.rememberParent,
                keyless: history.keyless,
              ).resolve;
      snapshot = await resolve(
        request: this.request,
        account: _session.account,
        now: now,
        snapshotId: snapshotId,
        minConfirmations: minConfirmations,
      );
      policy = defaultTransactionPolicy(
        network: network,
        request: this.request,
        now: now,
        snapshot: snapshot,
      );
      policy['payload']['minConfirmations'] = uintString(minConfirmations);
      policy['policyHash'] = hashJson(policy['payload']);
    }
    await _session._current(_round.epoch);
    final classification = switch (kind) {
      'tbc' => 'native',
      'ft' => 'ft',
      'stablecoin' => 'stablecoin',
      'pool-ft' => 'pool-ft',
      _ => 'ftlp',
    };
    final actual =
        (snapshot['payload']['utxos'] as List)
            .where((r) => r['classification'] == classification)
            .map((r) => _point(r as Map))
            .toSet();
    need(
      actual.length == points.length && actual.containsAll(points),
      'MERGE_MATERIAL_SELECTION',
    );
    _snapshot = _owned(snapshot);
    return {'snapshot': snapshot, 'policy': policy};
  }

  // Invoked only after the shared Engine plan validation and before native
  // binding/signing. Checks actual template inputs, not just index counts.
  void validatePlan(Map material, Map plan) {
    need(
      _snapshot != null &&
          _round.epoch == _session._epoch &&
          !_session._closed &&
          material['snapshot']['snapshotHash'] == _snapshot!['snapshotHash'] &&
          material['requestHash'] == hashJson(request),
      'MERGE_PLAN_BINDING',
    );
    final p = plan['payload'] as Map, txs = p['transactions'] as List;
    need(
      txs.length == 1 &&
          p['preview']['transactionCount'] == 1 &&
          BigInt.parse(uintString(p['preview']['totalFee'])) <=
              BigInt.parse(request['constraints']['maxFee']),
      'MERGE_PLAN_SCOPE',
    );
    final spent =
        plannedInputOutpoints(txs.single['unsignedTransaction']).toSet();
    need(spent.containsAll(_selected.map(_point)), 'MERGE_PLAN_INPUTS');
  }
}

// Reuse the worker's bounded immutable-parent cache without sharing mutable
// index/funding data between rounds. No change to normal FT selection policy.
final class _RoundFtReader extends Tbc20MaterialReader {
  _RoundFtReader(this.shared, ApiRead read)
    : super(network: shared.network, read: read, keyless: shared.keyless);
  final Tbc20MaterialReader shared;
  @override
  Future<MergeRecord> parent(String id) => shared.parent(id);
}
