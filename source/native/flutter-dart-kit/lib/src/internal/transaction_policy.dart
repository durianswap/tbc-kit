// Current-TBC20 policy from the frozen Kit/P5 contract profile. This module
// grows by verified family, not by applying FT fees/dust to unrelated assets.
import '../configuration.dart';
import '../host_environment.dart';
import 'protocol_codec.dart';
import 'transaction_profiles.dart' show transactionBundleLimit;

Map<String, dynamic> defaultTransactionPolicy({
  required TbcNetworkConfiguration network,
  required Map<String, dynamic> request,
  required DateTime now,
  Map<String, dynamic>? snapshot,
}) {
  final tokenHtlc =
      [
        'tbc-htlc-lock',
        'tbc-htlc-claim',
        'tbc-htlc-refund',
      ].contains(request['intent']?['type']) &&
      request['intent']['assetStandard'] != null;
  final standard = tokenHtlc ? request['intent']['assetStandard'] : null;
  need(
    !tokenHtlc || ['tbc20-standard', 'tbc20-stablecoin'].contains(standard),
    'HTLC_TOKEN_STANDARD',
  );
  final fungible =
      standard == 'tbc20-standard' ||
      ['tbc20.transfer', 'tbc20.merge'].contains(request['intent']?['type']);
  final nft = request['intent']?['type'] == 'tbc721.transfer';
  final timelock = [
    'tbc-timelock-lock',
    'tbc-timelock-unlock',
  ].contains(request['intent']?['type']);
  final htlc = [
    'tbc-htlc-lock',
    'tbc-htlc-claim',
    'tbc-htlc-refund',
  ].contains(request['intent']?['type']);
  final stablecoin =
      standard == 'tbc20-stablecoin' ||
      [
        'tbc20Stablecoin.transfer',
        'tbc20Stablecoin.merge',
      ].contains(request['intent']?['type']);
  need(request['chainId'] == network.chainId, 'POLICY_NETWORK');
  if (request['intent']?['type'] == 'tbc721.batchTransfer') {
    need(
      snapshot != null &&
          snapshot['snapshotHash'] == hashJson(snapshot['payload']) &&
          snapshot['payload']['chainId'] == network.chainId,
      'POLICY_MATERIAL',
    );
    final items = request['intent']['transfers'] as List;
    final contracts = snapshot!['payload']['contracts'] as List;
    need(
      contracts.length == items.length &&
          contracts.every(
            (c) =>
                c['family'] == 'nft' &&
                ['tbc721', '2.0'].contains(c['protocolVersion']) &&
                items.any((i) => i['contractId'] == c['contractId']),
          ),
      'POLICY_NFT_BATCH',
    );
    final policy = currentNftPolicy(
      network: network,
      request: request,
      now: now,
    );
    policy['payload']['contractPolicies'] = [
      {
        'family': 'nft',
        'allowedVersions': ['tbc721', '2.0'],
      },
    ];
    policy['policyHash'] = hashJson(policy['payload']);
    return policy;
  }
  if ([
    'tbc-lop-create',
    'tbc-lop-cancel',
    'tbc-lop-match',
  ].contains(request['intent']?['type'])) {
    return currentTbc20Policy(network: network, request: request, now: now);
  }
  if ([
    'tbc-amm-create',
    'tbc-amm-add-liquidity',
    'tbc-amm-remove-liquidity',
    'tbc-amm-swap',
    'tbc20-lp-transfer',
    'tbc20-lp-merge',
    'tbc20-lp-lock',
    'tbc20-lp-unlock',
  ].contains(request['intent']?['type'])) {
    return currentAmmPolicy(network: network, request: request, now: now);
  }
  // Creation selects a specific current contract family, not an untrusted
  // label for an existing asset. Historical creation stays unsupported.
  if (request['intent']?['type'] == 'tbc20-standard-create') {
    return currentTbc20Policy(network: network, request: request, now: now);
  }
  if ([
    'tbc721-standard-create-collection',
    'tbc721-standard-mint',
    'tbc721-standard-batch-mint',
  ].contains(request['intent']?['type'])) {
    return currentNftPolicy(network: network, request: request, now: now);
  }
  var currentCoin = false;
  if (fungible || nft || stablecoin) {
    // Select only from the package-owned, hashed material snapshot. A caller's
    // label must never select cheaper/different rules for the same asset.
    need(
      snapshot != null &&
          snapshot['snapshotHash'] == hashJson(snapshot['payload']) &&
          snapshot['payload']['chainId'] == network.chainId,
      'POLICY_MATERIAL',
    );
    final contracts = snapshot!['payload']['contracts'] as List;
    need(
      contracts.length == 1 &&
          contracts.single['family'] ==
              (nft
                  ? 'nft'
                  : stablecoin
                  ? 'stablecoin'
                  : 'ft') &&
          contracts.single['contractId'] == request['intent']['contractId'],
      'POLICY_ASSET',
    );
    final version = contracts.single['protocolVersion'];
    need(
      !tokenHtlc ||
          (version == (standard == 'tbc20-standard' ? 'tbc20' : 'coin') &&
              contracts.single['standardId'] == standard),
      'HTLC_CURRENT_TOKEN_REQUIRED',
    );
    need(
      (nft
              ? ['tbc721', '2.0']
              : stablecoin
              ? ['coin', '4.0']
              : ['tbc20', '4.0'])
          .contains(version),
      'POLICY_ASSET_VERSION',
    );
    currentCoin = version == 'coin';
    if (version == 'tbc721') {
      return currentNftPolicy(network: network, request: request, now: now);
    }
    if (version == 'tbc20') {
      return currentTbc20Policy(network: network, request: request, now: now);
    }
  }
  need(
    timelock ||
        htlc ||
        fungible ||
        nft ||
        stablecoin ||
        [
          'tbc.transfer',
          'tbc.maintenance.merge',
        ].contains(request['intent']?['type']),
    'POLICY_PROFILE_UNSUPPORTED',
  );
  final payload = <String, dynamic>{
    'version': '1.0',
    'policyId': 'tbc-${network.network.name}-kit-r1',
    'revision': '1',
    'chainId': network.chainId,
    'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 5))),
    'sighashType': 65,
    'maxBundleTransactions': 32,
    'minConfirmations': '0',
    'dustThreshold': timelock || htlc ? '42' : '24',
    'feeRateSatPerKb': '80',
    // Coin uses its own frozen policy (dust 24), not the FT dust 42 profile.
    // Holder-only support does not expose a createVersion or admin operation.
    'contractPolicies': <Object>[
      if (currentCoin)
        {
          'family': 'stablecoin',
          'allowedVersions': ['coin'],
        },
    ],
    'amountLimits': [
      {'scope': 'native', 'maximum': '2100000000000000'},
    ],
  };
  return {'payload': payload, 'policyHash': hashJson(payload)};
}

// AMM dust/slot semantics are not the FT or NFT profile. This is the accepted
// frozen policy, not a contract upgrade or a new fee computation algorithm.
Map<String, dynamic> currentAmmPolicy({
  required TbcNetworkConfiguration network,
  required Map<String, dynamic> request,
  required DateTime now,
}) {
  need(
    request['chainId'] == network.chainId &&
        [
          'tbc-amm-create',
          'tbc-amm-add-liquidity',
          'tbc-amm-remove-liquidity',
          'tbc-amm-swap',
          'tbc20-lp-transfer',
          'tbc20-lp-merge',
          'tbc20-lp-lock',
          'tbc20-lp-unlock',
        ].contains(request['intent']?['type']),
    'POLICY_PROFILE_UNSUPPORTED',
  );
  final payload = <String, dynamic>{
    'version': '1.0',
    'policyId': 'tbc-${network.network.name}-kit-r1',
    'revision': '1',
    'chainId': network.chainId,
    'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 5))),
    'sighashType': 65,
    'maxBundleTransactions': 32,
    'minConfirmations': '0',
    'dustThreshold': '10',
    'feeRateSatPerKb': '80',
    'contractPolicies': [
      {
        'family': 'pool',
        'allowedVersions': ['pool3'],
        'createVersion': 'pool3',
      },
    ],
    'amountLimits': [
      {'scope': 'native', 'maximum': '2100000000000000'},
      for (final (kind, version) in [('ft', 'tbc20'), ('lp', 'pool3')]) ...[
        {
          'scope': '$kind-total',
          'protocolVersion': version,
          'maximum': '55340232221128654842',
        },
        {
          'scope': '$kind-slot',
          'protocolVersion': version,
          'maximum': '9223372036854775807',
        },
      ],
    ],
  };
  return {'payload': payload, 'policyHash': hashJson(payload)};
}

Map<String, dynamic> currentNftPolicy({
  required TbcNetworkConfiguration network,
  required Map<String, dynamic> request,
  required DateTime now,
}) {
  need(
    request['chainId'] == network.chainId &&
        [
          'tbc721.transfer',
          'tbc721.batchTransfer',
          'tbc721-standard-create-collection',
          'tbc721-standard-mint',
          'tbc721-standard-batch-mint',
        ].contains(request['intent']?['type']),
    'POLICY_PROFILE_UNSUPPORTED',
  );
  final payload = <String, dynamic>{
    'version': '1.0',
    'policyId': 'tbc-${network.network.name}-kit-r1',
    'revision': '1',
    'chainId': network.chainId,
    'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 5))),
    'sighashType': 65,
    'maxBundleTransactions': transactionBundleLimit(request),
    'minConfirmations': '0',
    'dustThreshold': '42',
    'feeRateSatPerKb': '80',
    'contractPolicies': [
      for (final family in ['collection', 'nft'])
        {
          'createVersion': 'tbc721',
          'family': family,
          'allowedVersions': ['tbc721'],
        },
    ],
    'amountLimits': [
      {'scope': 'native', 'maximum': '2100000000000000'},
    ],
  };
  return {'payload': payload, 'policyHash': hashJson(payload)};
}

Map<String, dynamic> currentTbc20Policy({
  required TbcNetworkConfiguration network,
  required Map<String, dynamic> request,
  required DateTime now,
}) {
  need(
    request['chainId'] == network.chainId &&
        request['intent'] is Map &&
        ([
              'tbc20.transfer',
              'tbc20.merge',
              'tbc20-standard-create',
              'tbc-lop-create',
              'tbc-lop-cancel',
              'tbc-lop-match',
            ].contains(request['intent']['type']) ||
            ([
                  'tbc-htlc-lock',
                  'tbc-htlc-claim',
                  'tbc-htlc-refund',
                ].contains(request['intent']['type']) &&
                request['intent']['assetStandard'] == 'tbc20-standard')),
    'POLICY_PROFILE_UNSUPPORTED',
  );
  final payload = <String, dynamic>{
    'version': '1.0',
    'policyId': 'tbc-${network.network.name}-kit-r1',
    'revision': '1',
    'chainId': network.chainId,
    'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 5))),
    'sighashType': 65,
    'maxBundleTransactions': 32,
    'minConfirmations': '0',
    'dustThreshold': '42',
    'feeRateSatPerKb': '80',
    'contractPolicies': [
      {
        'createVersion': 'tbc20',
        'family': 'ft',
        'allowedVersions': ['tbc20'],
      },
      if ([
        'tbc-lop-create',
        'tbc-lop-cancel',
        'tbc-lop-match',
      ].contains(request['intent']['type']))
        {
          'family': 'stablecoin',
          'allowedVersions': ['coin'],
        },
    ],
    'amountLimits': [
      {'scope': 'native', 'maximum': '2100000000000000'},
      {
        'scope': 'ft-total',
        'maximum': '332041393326771929052',
        'protocolVersion': 'tbc20',
      },
      {
        'scope': 'ft-slot',
        'maximum': '9223372036854775807',
        'protocolVersion': 'tbc20',
      },
    ],
  };
  return {'payload': payload, 'policyHash': hashJson(payload)};
}
