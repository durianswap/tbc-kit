// Generic AMM/LP material routing from frozen Kit. Only the private read plan
// is projected: the caller's original request/hash remains the Engine input.
// Script recognition selects a reader, never permission or signing authority.
import '../configuration.dart';
import 'amm_business_material.dart';
import 'lp_material.dart';
import 'native_material.dart';
import 'pool2_material.dart';
import 'protocol_codec.dart';
import 'chain_read_reply.dart';
import 'tbc20_material.dart' show ApiRead, KeylessCall;
import 'transaction_policy.dart';
import 'transaction_read.dart';
import 'transaction_signing_roles.dart';

const unifiedPoolProfiles = {
  'amm.swap',
  'amm.addLiquidity',
  'amm.removeLiquidity',
  'amm.mergeToken',
  'tbc20Lp.transfer',
  'tbc20Lp.lock',
  'tbc20Lp.unlock',
  'tbc20Lp.merge',
  'tbc20Lp.burn',
};

final class UnifiedPoolPreparedMaterial {
  UnifiedPoolPreparedMaterial._(
    this._snapshot,
    this._policy,
    this._requestHash,
    this._chainId,
    this._floor,
  );
  final Map<String, dynamic> _snapshot, _policy;
  final String _requestHash, _chainId, _floor;
  Map<String, dynamic> get snapshot => copied(_snapshot);
  Map<String, dynamic> policy({
    required Map<String, dynamic> request,
    required TbcNetworkConfiguration network,
    String minConfirmations = '0',
  }) {
    need(
      hashJson(request) == _requestHash &&
          request['chainId'] == _chainId &&
          network.chainId == _chainId &&
          minConfirmations == _floor,
      'UNIFIED_POOL_POLICY_BINDING',
    );
    return copied(_policy);
  }
}

final class UnifiedPoolMaterialReader {
  UnifiedPoolMaterialReader({
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
  // Immutable origin hints only, bounded and tied to this network/read source.
  final Map<String, bool> _origins = {};

  Future<UnifiedPoolPreparedMaterial> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
    List<Map<String, dynamic>> signingAccounts = const [],
  }) async {
    final owned = copied(request), owner = copied(account);
    inspectAccount(owner, expectedChainId: network.chainId);
    need(
      owned['chainId'] == network.chainId && owned['from'] == owner['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = owned['intent'];
    need(
      intent is Map && unifiedPoolProfiles.contains(intent['type']),
      'UNIFIED_POOL_PROFILE',
    );
    final role =
        owned['signingRoles'] == null
            ? null
            : TransactionSigningAccounts.resolve(
              request: owned,
              primary: owner,
              additional: signingAccounts,
            );
    need(role != null || signingAccounts.isEmpty, 'ROLE_UNREQUESTED_ACCOUNT');
    final id = hash32(intent['poolContractId']),
        floor = uintString(minConfirmations);
    final kind = intent['type'] as String;
    final maintenance = kind.startsWith('tbc20Lp.') || kind == 'amm.mergeToken';
    final reads = <String, Future<Map<String, dynamic>>>{};
    Future<Map<String, dynamic>> scopedRead(String path) {
      final pending = reads.putIfAbsent(
        path,
        () async => copyChainReadReply(await read(path)),
      );
      pending.ignore();
      return pending.then(copyChainReadReply);
    }

    // Start mandatory independent reads together, not after origin parsing.
    // A request-local memo prevents the concrete reader from repeating them.
    if(floor!='0')scopedRead('/api/tbc/nodeinfo').ignore();
    scopedRead('/api/tbc/utxo/address/${owner['address']}').ignore();
    final infoRead=scopedRead('/api/tbc/pool/poolinfo/poolid/$id');
    final originRead = infoRead.then((info)=>readHistory(hash32(info['txid'])));
    originRead.ignore();
    try {
      final origin = await originRead;
      if (!_origins.containsKey(id)) {
        final hint = keyless('inspectAmmMaterial', {
          'phase': 'identifyPoolState',
          'pool': {'txid': origin['txid'], 'rawTransaction': origin['rawTransaction']},
        });
        need(
          hint.length == 4 &&
              hint['family'] == 'amm' &&
              ['current', 'historical'].contains(hint['generation']) &&
              hint['verification'] == 'state-template' &&
              hint['assetIdentityVerified'] == false,
          'POOL_ORIGIN',
        );
        if (_origins.length >= 256) _origins.remove(_origins.keys.first);
        _origins[id] = hint['generation'] == 'current';
      }
      final current = _origins[id]!;
      final projected = copied(owned), fields = projected['intent'] as Map;
      final currentTypes = {
        'amm.swap': 'tbc-amm-swap',
        'amm.addLiquidity': 'tbc-amm-add-liquidity',
        'amm.removeLiquidity': 'tbc-amm-remove-liquidity',
        'tbc20Lp.transfer': 'tbc20-lp-transfer',
        'tbc20Lp.lock': 'tbc20-lp-lock',
        'tbc20Lp.unlock': 'tbc20-lp-unlock',
        'tbc20Lp.merge': 'tbc20-lp-merge',
      };
      final historicalTypes = {
        'amm.swap':
            intent['direction'] == 'tbc-to-ft'
                ? 'tbc.pool.swap.exactTbcForToken'
                : 'tbc.pool.swap.exactTokenForTbc',
        'amm.addLiquidity': 'tbc.pool.liquidity.add',
        'amm.removeLiquidity': 'tbc.pool.liquidity.remove',
        'amm.mergeToken': 'tbc.pool.ft.merge',
        'tbc20Lp.merge': 'tbc.pool.ftlp.merge',
        'tbc20Lp.burn': 'tbc.pool.ftlp.burn',
      };
      final concrete = (current ? currentTypes : historicalTypes)[kind];
      need(concrete != null, 'POOL_TEMPLATE_OPERATION_UNSUPPORTED');
      fields['type'] = concrete;
      if (!current) {
        need(role == null, 'HISTORICAL_POOL_ROLE_UNSUPPORTED');
        // Frozen Engine rejects these for historical Pool2, including valid
        // explicit funding coins. This is not an unfinished selection mode.
        need(
          owned['constraints']?['inputOutpoints'] == null,
          'HISTORICAL_POOL_EXPLICIT_INPUTS',
        );
        need(
          fields['poolStateHash'] == null,
          'HISTORICAL_POOL_STATE_COMMITMENT',
        );
        if (!maintenance) fields['receiver'] ??= owned['from'];
        if (kind == 'amm.swap') {
          final buy = fields.remove('direction') == 'tbc-to-ft';
          fields[buy ? 'tbcAmount' : 'ftAmount'] = fields.remove('amount');
          fields[buy ? 'minimumFtAmount' : 'minimumTbcAmount'] = fields.remove(
            'minimumOutput',
          );
        } else if (kind == 'amm.addLiquidity') {
          need(
            fields['budgetAsset'] == 'tbc' &&
                fields['initialFtAmount'] == null &&
                fields['maximumTbcAmount'] == null &&
                fields['maximumFtAmount'] == null,
            'HISTORICAL_POOL_ADD_BUDGET',
          );
          fields.remove('budgetAsset');
          fields['tbcAmount'] = fields.remove('amount');
          if (fields.containsKey('lockTime'))
            fields['lockUntilHeight'] = fields.remove('lockTime');
        }
      }
      final funding = NativeMaterialReader(network: network, read: scopedRead);
      late Map<String, dynamic> snapshot, policy;
      if (!current) {
        final prepared = await Pool2MaterialReader(
          network: network,
          read: scopedRead,
          readHistory: readHistory,
          rememberParent: rememberParent,
          funding: funding,
          keyless: keyless,
        ).resolve(
          request: projected,
          account: owner,
          now: now,
          snapshotId: snapshotId,
          minConfirmations: floor,
        );
        snapshot = prepared.snapshot;
        policy = prepared.policy(
          request: projected,
          network: network,
          now: now,
          minConfirmations: floor,
        );
      } else {
        if (maintenance) {
          snapshot = await LpMaterialReader(
            network: network,
            read: scopedRead,
            readHistory: readHistory,
            rememberParent: rememberParent,
            funding: funding,
            keyless: keyless,
          ).resolve(
            request: projected,
            account: owner,
            now: now,
            snapshotId: snapshotId,
            minConfirmations: floor,
          );
        } else {
          snapshot = await AmmBusinessMaterialReader(
            network: network,
            read: scopedRead,
            readHistory: readHistory,
            rememberParent: rememberParent,
            funding: funding,
            keyless: keyless,
          ).resolve(
            request: projected,
            account: owner,
            signingAccounts: role?.additional ?? const [],
            now: now,
            snapshotId: snapshotId,
            minConfirmations: floor,
          );
        }
        policy = currentAmmPolicy(
          network: network,
          request: projected,
          now: now,
        );
        policy['payload']['minConfirmations'] = floor;
        policy['policyHash'] = hashJson(policy['payload']);
      }
      return UnifiedPoolPreparedMaterial._(
        snapshot,
        policy,
        hashJson(owned),
        network.chainId,
        floor,
      );
    } finally {
      // No orphan eager read survives a failed template or material selection.
      await Future.wait(
        reads.values.map((f) => f.then<void>((_) {}, onError: (Object _) {})),
      );
    }
  }
}
