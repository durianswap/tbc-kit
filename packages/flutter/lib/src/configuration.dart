/// Existing wallet-compatible path; not a new HD account discovery policy.
const tbcDefaultDerivationPath = "m/44'/236'/0'/1/0";

/// Wallet-owned discovery identity. This is display metadata, not authority.
final class TbcWalletConfiguration {
  TbcWalletConfiguration({
    required String productId,
    required String name,
    required String profile,
    String walletVersion = '0.0.0',
    required this.network,
    String? icon,
    this.legacy = true,
    this.maintenance,
    List<TbcWalletCapabilityScope> capabilityScopes = const [],
  }) : productId = _productId(productId),
       name = _identifier(name, 'name'),
       profile = _identifier(profile, 'profile'),
       walletVersion = _identifier(walletVersion, 'walletVersion'),
       icon = icon == null ? null : _icon(icon),
       capabilityScopes = List.unmodifiable(capabilityScopes);

  final String productId;
  final String name;
  final String profile;

  /// Display-only wallet build version for Legacy getInfo; not protocol authority.
  final String walletVersion;
  final String? icon;
  final TbcNetworkConfiguration network;
  final bool legacy;

  /// Explicit wallet-owned bounds for shared multi-round maintenance. Omit to
  /// disable it. This is a spending ceiling, never a grant or autoapproval.
  final TbcMaintenancePolicy? maintenance;

  /// Wallet-owned advertised support; omit to keep Kit's transfer-only default.
  /// This is never derived from a DApp request.
  final List<TbcWalletCapabilityScope> capabilityScopes;

  /// Private runtime startup input, never populated by page JavaScript.
  Map<String, Object> toRuntimeConfiguration({
    List<TbcNetworkConfiguration> additionalNetworks = const [],
  }) {
    final seen = <TbcNetwork>{network.network};
    for (final candidate in additionalNetworks) {
      if (!seen.add(candidate.network)) {
        throw ArgumentError('Duplicate wallet network configuration');
      }
    }
    return {
      'wallet': {
        'productId': productId,
        'name': name,
        'profile': profile,
        if (icon != null) 'icon': icon!,
        'legacy': legacy,
        if (capabilityScopes.isNotEmpty)
          'capabilities': {
            'version': '1.0',
            'scopes': [
              for (final scope in capabilityScopes) scope.toKitScope(),
            ],
          },
      },
      'network': network.toKitOptions(),
      if (additionalNetworks.isNotEmpty)
        'networkCatalog': [
          for (final configured in additionalNetworks)
            configured.toKitOptions(),
        ],
    };
  }
}

/// Wallet-owned limits for the shared maintenance coordinator. Legacy aliases
/// use these defaults; the Standard helper may narrow, never widen, the bounds.
final class TbcMaintenancePolicy {
  TbcMaintenancePolicy({
    required this.maxTransactions,
    required this.maxTotalFee,
    required this.approvalLifetime,
    this.maxIndexRefreshes = 6,
    this.indexRefreshDelay = const Duration(seconds: 1),
  }) {
    if (maxTransactions < 1 ||
        maxTransactions > 64 ||
        !RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(maxTotalFee) ||
        maxTotalFee.length > 16 ||
        BigInt.parse(maxTotalFee) > BigInt.parse('2100000000000000') ||
        approvalLifetime <= Duration.zero ||
        approvalLifetime > const Duration(hours: 1) ||
        maxIndexRefreshes < 0 ||
        maxIndexRefreshes > 32 ||
        indexRefreshDelay.isNegative ||
        indexRefreshDelay > const Duration(seconds: 60)) {
      throw const FormatException('Invalid maintenance bounds');
    }
  }

  final int maxTransactions, maxIndexRefreshes;

  /// Atomic native units for the whole run, not per child transaction.
  final String maxTotalFee;
  final Duration approvalLifetime, indexRefreshDelay;

  Map<String, dynamic> limits(DateTime now) => Map.unmodifiable({
    'targetUtxoCount': 1,
    'maxTransactions': maxTransactions,
    'maxTotalFee': maxTotalFee,
    'expiresAt':
        DateTime.fromMillisecondsSinceEpoch(
          now.add(approvalLifetime).millisecondsSinceEpoch,
          isUtc: true,
        ).toIso8601String(),
    'maxIndexRefreshes': maxIndexRefreshes,
    'indexRefreshDelayMs': indexRefreshDelay.inMilliseconds,
  });
}

/// Explicit per-network/account intent advertisement. The Kit validates the
/// final descriptor; Flutter only keeps this wallet-owned input immutable.
final class TbcWalletCapabilityScope {
  TbcWalletCapabilityScope({
    required this.network,
    required List<String> intents,
    List<String> profiles = const ['core'],
    this.accountId,
  }) : intents = List.unmodifiable(intents),
       profiles = List.unmodifiable(profiles) {
    if (intents.isEmpty ||
        intents.toSet().length != intents.length ||
        profiles.isEmpty ||
        profiles.toSet().length != profiles.length ||
        (accountId != null && !accountId!.startsWith('${network.chainId}:'))) {
      throw const FormatException('Invalid wallet capability scope');
    }
  }

  final TbcNetwork network;
  final String? accountId;
  final List<String> intents;
  final List<String> profiles;

  Map<String, Object> toKitScope() => {
    'chainId': network.chainId,
    if (accountId != null) 'accountId': accountId!,
    'intents': intents,
    'profiles': profiles,
  };
}

String _productId(String value) {
  if (!RegExp(r'^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$').hasMatch(value)) {
    throw const FormatException('Invalid wallet productId');
  }
  return value;
}

String _icon(String value) {
  if (!RegExp(
    r'^data:image/(?:gif|png|svg\+xml|webp);base64,',
  ).hasMatch(value)) {
    throw const FormatException('Expected wallet data image');
  }
  return value;
}

enum TbcNetwork {
  mainnet('tbc:mainnet', 'https://api.turingbitchain.io'),
  testnet('tbc:testnet', 'https://api.tbcdev.org');

  const TbcNetwork(this.chainId, this.officialApiOrigin);
  final String chainId;
  final String officialApiOrigin;
}

/// Wallet-owned source selection, converted to existing Kit network options.
/// Kit remains responsible for the network profile and sourceIdentity hash.
final class TbcNetworkConfiguration {
  TbcNetworkConfiguration.official(this.network)
    : apiOrigin = network.officialApiOrigin,
      rpcOrigin = null,
      trustId = null;

  TbcNetworkConfiguration.trustedCustom({
    required this.network,
    required String apiOrigin,
    required String trustId,
    String? rpcOrigin,
  }) : apiOrigin = _exactHttpsOrigin(apiOrigin),
       rpcOrigin = rpcOrigin == null ? null : _exactHttpsOrigin(rpcOrigin),
       trustId = _trustId(trustId);

  final TbcNetwork network;
  final String apiOrigin;
  final String? rpcOrigin;
  final String? trustId;
  String get chainId => network.chainId;

  Map<String, Object> toKitOptions() => {
    'network': network.name,
    'endpoint':
        trustId == null
            ? {'kind': 'official'}
            : {
              'kind': 'trusted-custom',
              'apiOrigin': apiOrigin,
              'trustId': trustId!,
              if (rpcOrigin != null) 'rpcOrigin': rpcOrigin!,
            },
  };
}

/// Public account only. Address/script/public-key consistency is still checked
/// by Kit/Engine; syntactic validation here is not cryptographic verification.
final class TbcAccount {
  TbcAccount({
    required this.network,
    required String address,
    required String publicKey,
  }) : address = _identifier(address, 'address'),
       publicKey = _publicKey(publicKey);
  final TbcNetwork network;
  final String address;
  final String publicKey;
  String get accountId => '${network.chainId}:$address';
  Map<String, Object> toKitAccount() => {
    'accountId': accountId,
    'chainId': network.chainId,
    'address': address,
    'publicKey': publicKey,
  };
}

String _identifier(String value, String field) {
  if (value.isEmpty ||
      value.length > 256 ||
      value.trim() != value ||
      value.codeUnits.any((c) => c < 0x20 || c == 0x7f)) {
    throw FormatException('Invalid $field');
  }
  return value;
}

String _publicKey(String value) {
  if (!RegExp(r'^(02|03)[0-9a-f]{64}$').hasMatch(value)) {
    throw const FormatException('Expected compressed secp256k1 public key');
  }
  return value;
}

String _trustId(String value) {
  if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').hasMatch(value)) {
    throw const FormatException('Invalid trustId');
  }
  return value;
}

String _exactHttpsOrigin(String value) {
  final uri = Uri.tryParse(value);
  // Match Kit exact-origin policy: no path, credentials, query, fragment,
  // uppercase normalization or redundant default port silently accepted.
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.path.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.origin != value) {
    throw const FormatException('Expected canonical HTTPS origin');
  }
  return value;
}
