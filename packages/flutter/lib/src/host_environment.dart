import 'dart:async';
import 'dart:math';
import 'configuration.dart';

typedef TbcReadAccounts =
    FutureOr<List<TbcAccount>> Function(TbcNetwork network);
typedef TbcReadClock = FutureOr<DateTime> Function();
typedef TbcReadEntropy = FutureOr<List<int>> Function(int length);

/// Non-signing callbacks for the private trusted Kit VM. This object does not
/// grant permissions, approve requests, unlock accounts or provide custody.
/// Other Host Ports must be wired explicitly, never given permissive defaults.
final class TbcHostEnvironment {
  TbcHostEnvironment({
    required this.network,
    required this.readAccounts,
    List<TbcNetworkConfiguration> additionalNetworks = const [],
    TbcReadClock? clock,
    TbcReadEntropy? entropy,
  }) : _clock = clock ?? DateTime.now,
       _entropy = entropy ?? _secureBytes {
    final configured = <TbcNetwork, TbcNetworkConfiguration>{
      network.network: network,
    };
    for (final candidate in additionalNetworks) {
      if (configured.containsKey(candidate.network)) {
        throw ArgumentError('Duplicate wallet network configuration');
      }
      configured[candidate.network] = candidate;
    }
    _networks = Map.unmodifiable(configured);
  }

  final TbcNetworkConfiguration network;
  final TbcReadAccounts readAccounts;
  final TbcReadClock _clock;
  final TbcReadEntropy _entropy;
  late final Map<TbcNetwork, TbcNetworkConfiguration> _networks;

  List<TbcNetworkConfiguration> get additionalNetworks => List.unmodifiable(
    _networks.values.where(
      (configured) => configured.network != network.network,
    ),
  );

  bool supportsChainId(String chainId) =>
      _networks.values.any((configured) => configured.chainId == chainId);

  TbcNetworkConfiguration configurationFor(String chainId) {
    for (final configured in _networks.values) {
      if (configured.chainId == chainId) return configured;
    }
    throw StateError('Wallet network is not configured');
  }

  Future<List<Map<String, Object>>> currentAccounts() =>
      accountsForChain(network.chainId);

  /// Wallet-owned target-chain inventory for permission resolution only.
  /// It never changes the active Provider chain or selects a signing account.
  Future<List<Map<String, Object>>> accountsForChain(String chainId) async {
    final configured = configurationFor(chainId);
    final source = await readAccounts(configured.network);
    final seen = <String>{};
    return List.unmodifiable(
      source.map((account) {
        if (account.network != configured.network ||
            !seen.add(account.accountId)) {
          throw StateError('Invalid account snapshot');
        }
        return Map<String, Object>.unmodifiable(account.toKitAccount());
      }),
    );
  }

  /// New protocol timestamps use millisecond UTC. Quantize the clock once at
  /// creation; never rewrite a timestamp already included in a binding.
  Future<String> now() async {
    return tbcProtocolTimestamp(await _clock());
  }

  Future<List<int>> randomBytes(int length) async {
    if (length < 1 || length > 4096) {
      throw const FormatException('Invalid entropy length');
    }
    final bytes = await _entropy(length);
    if (bytes.length != length || bytes.any((n) => n < 0 || n > 255)) {
      throw StateError('Invalid entropy result');
    }
    return List<int>.unmodifiable(bytes);
  }

  /// Private native-host adapter only; never register this as a DApp handler.
  /// No global serialization, preloading, hidden cache or extra account fetch.
  Future<Object> dispatch(String method, Map<String, Object?>? input) async {
    switch (method) {
      case 'accounts.current':
        return currentAccounts();
      case 'clock.now':
        return now();
      case 'entropy.bytes':
        final length = input?['length'];
        if (length is! int) {
          throw const FormatException('Invalid entropy length');
        }
        return randomBytes(length);
      default:
        throw UnsupportedError('Host callback not provided');
    }
  }
}

/// Format newly created timestamps before Kit binding, never rewrite bound data.
String tbcProtocolTimestamp(DateTime instant) {
  final value = DateTime.fromMillisecondsSinceEpoch(
    instant.millisecondsSinceEpoch,
    isUtc: true,
  );
  if (value.year < 0 || value.year > 9999) {
    throw StateError('Clock outside Kit timestamp range');
  }
  return value.toIso8601String();
}

/// Validate without changing the original protocol text or extending expiry.
DateTime parseTbcProtocolTimestamp(String value) {
  if (!RegExp(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$',
  ).hasMatch(value)) {
    throw const FormatException('Invalid protocol timestamp');
  }
  final canonical =
      value.length == 20
          ? '${value.substring(0, 19)}.000Z'
          : '${value.substring(0, 20)}${value.substring(20, value.length - 1).padRight(3, '0')}Z';
  final date = DateTime.parse(value);
  if (date.toIso8601String() != canonical) {
    throw const FormatException('Invalid calendar timestamp');
  }
  return date;
}

List<int> _secureBytes(int length) {
  final random = Random.secure();
  return List<int>.generate(
    length,
    (_) => random.nextInt(256),
    growable: false,
  );
}
