// Private Legacy DTO facade. It consumes the shared network metadata adapter;
// it does not fetch, approve, construct, sign, broadcast or retry transactions.
import '../configuration.dart';
import 'legacy_mapping.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'asset_metadata.dart';

final class LegacyFtIdentity {
  const LegacyFtIdentity({
    required this.decimals,
    required this.currentStandard,
  });
  final int decimals;
  final bool currentStandard;
}

/// Wallet-owned, source-bound metadata surface. Implementations must reuse the
/// production material reader's origin cache and request-local reads. The page
/// supplies neither this adapter nor a precision/generation assertion.
abstract interface class LegacyBusinessMetadata {
  TbcNetworkConfiguration get network;
  Future<LegacyFtIdentity> ft(String contractId);
  Future<int> stablecoinDecimals(String contractId);
  Future<int> poolFtDecimals(String poolContractId);
}

/// Thin Legacy projection over the common immutable material metadata reader.
/// No metadata HTTP client or Legacy-specific cache is introduced.
final class LegacySharedMetadata implements LegacyBusinessMetadata {
  LegacySharedMetadata(this.reader);
  final AssetMetadataReader reader;
  @override
  TbcNetworkConfiguration get network => reader.network;
  @override
  Future<LegacyFtIdentity> ft(String id) async {
    final value = await reader.ft(id);
    return LegacyFtIdentity(
      decimals: value.decimals,
      currentStandard: value.current,
    );
  }

  @override
  Future<int> stablecoinDecimals(String id) async =>
      (await reader.stablecoin(id)).decimals;
  @override
  Future<int> poolFtDecimals(String id) async =>
      (await reader.poolFt(id)).decimals;
}

final class LegacyBusinessResolver {
  LegacyBusinessResolver({
    required this.account,
    required TbcNetworkConfiguration network,
    required this.metadata,
    required this.requireCurrent,
    DateTime Function()? now,
  }) : _source = canonical(network.toKitOptions()),
       _now = now ?? DateTime.now {
    need(network.chainId == account.chainId, 'LEGACY_BUSINESS_NETWORK');
    _current();
  }
  final LegacyMappingAccount account;
  final LegacyBusinessMetadata metadata;
  final void Function() requireCurrent;
  final String _source;
  final DateTime Function() _now;

  void _current() {
    requireCurrent();
    need(
      metadata.network.chainId == account.chainId &&
          canonical(metadata.network.toKitOptions()) == _source,
      'LEGACY_METADATA_SOURCE',
    );
  }

  Future<Map<String, dynamic>> resolve(Object? params) async {
    _current();
    // Reuse the existing finite-JSON snapshot, including decimal display input.
    // The normalizer is not used here: standalone maintenance may broadcast in
    // the shared send lifecycle, whereas batch maintenance remains forbidden.
    final p = snapshotLegacySendParams(params);
    final flag = p['flag'];
    Map<String, dynamic> mapped;
    switch (flag) {
      case 'P2PKH':
        mapped = mapLegacyTbcTransfer(p, account);
      case 'FT_TRANSFER':
        final id = hash32((p['ft_contract_address'] as String).toLowerCase());
        final identity = await metadata.ft(id);
        _current();
        mapped = mapLegacyFtTransfer(
          p,
          account,
          decimals: identity.decimals,
          currentStandard: identity.currentStandard,
        );
      case 'STABLECOIN_TRANSFER':
        final id = hash32((p['ft_contract_address'] as String).toLowerCase());
        final decimals = await metadata.stablecoinDecimals(id);
        _current();
        mapped = mapLegacyStablecoinTransfer(p, account, decimals: decimals);
      case 'NFT_TRANSFER':
        mapped = mapLegacyNftTransfer(p, account);
      case 'FT_MERGE':
      case 'STABLECOIN_MERGE':
        mapped = mapLegacyAssetMerge(p, account);
      case 'POOLNFT_SWAP_TO_TOKEN':
      case 'POOLNFT_SWAP_TO_TBC':
      case 'POOLNFT_LP_INCREASE':
      case 'POOLNFT_LP_CONSUME':
      case 'POOLNFT_MERGE':
      case 'FTLP_MERGE':
      case 'POOLNFT_LP_BURN':
        final now = _now();
        int? decimals;
        if (flag == 'POOLNFT_SWAP_TO_TBC') {
          final id = hash32(
            (p['nft_contract_address'] as String).toLowerCase(),
          );
          decimals = await metadata.poolFtDecimals(id);
          _current();
        }
        mapped = mapLegacyPoolTransaction(
          p,
          account,
          ftDecimals: decimals,
          now: now,
        );
      default:
        // No generic flag passthrough: historical creates/admin/BTC/EVM are not
        // accepted, and no unimplemented method is reported as successful.
        throw StateError('LEGACY_UNSUPPORTED_BUSINESS');
    }
    _current();
    return legacySharedBusinessRequest(mapped);
  }
}
