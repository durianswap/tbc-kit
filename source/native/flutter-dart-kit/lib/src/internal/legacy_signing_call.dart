// Trusted Legacy entry preparation only. Execution remains the shared worker,
// with native-owned protocol grants and Bitcoin framing selected at startup.
import 'legacy_business.dart';
import 'legacy_mapping.dart';
import 'protocol_codec.dart';
import 'workflow_request.dart';

final class LegacySigningCall {
  LegacySigningCall._(
    this.method,
    this.params,
    this.account,
    this.standardMethod,
    Set<String> permissions,
    this.usesCrypto,
    this._direct,
  ) : requiredPermissions = Set.unmodifiable(permissions);

  factory LegacySigningCall.capture(
    String method,
    Object? params,
    LegacyMappingAccount account,
  ) {
    if (method == 'sendTransaction') {
      final p = snapshotLegacySendParams(params), route = _businessMethod(p);
      return LegacySigningCall._(
        method,
        p,
        account,
        route,
        {route},
        false,
        null,
      );
    }
    if (method == 'signMessage') {
      final message = frozen(legacyMessage(params));
      return LegacySigningCall._(
        method,
        message,
        account,
        'tbc_signMessage',
        {'tbc_signMessage'},
        false,
        frozen({...account.common, 'message': message}) as Map<String, dynamic>,
      );
    }
    if (method == 'sendBatchRequest') {
      final rows = normalizeLegacyBatch(params),
          permissions = <String>{'tbc_signWorkflow'};
      var crypto = false;
      for (final row in rows) {
        switch (row['method']) {
          case 'sendTransaction':
            need(
              _businessMethod(snapshotLegacySendParams(row['params'])) ==
                  'tbc_signTransaction',
              'LEGACY_BATCH_SIGN_ONLY',
            );
            permissions.add('tbc_signTransaction');
          case 'signMessage':
            legacyMessage(row['params']);
            permissions.add('tbc_signMessage');
          default:
            final mapped = mapLegacyStandalone(
              row['method'],
              row['params'],
              account,
            );
            final isCrypto =
                mapped['method'] == 'tbc_encrypt' ||
                mapped['method'] == 'tbc_decrypt';
            permissions.add(isCrypto ? 'tbc_crypto' : 'tbc_signTransaction');
            crypto |= isCrypto;
        }
      }
      return LegacySigningCall._(
        method,
        rows,
        account,
        'tbc_signWorkflow',
        permissions,
        crypto,
        null,
      );
    }
    final mapped = mapLegacyStandalone(method, params, account),
        route = mapped['method'] as String;
    return LegacySigningCall._(
      method,
      null,
      account,
      route,
      {route},
      route == 'tbc_encrypt' || route == 'tbc_decrypt',
      mapped['params'] as Map<String, dynamic>,
    );
  }

  final String method, standardMethod;
  // Captured finite JSON; page display amounts are never protocol numbers.
  final Object? params;
  final LegacyMappingAccount account;
  final Set<String> requiredPermissions;
  final bool usesCrypto;
  final Map<String, dynamic>? _direct;

  bool get needsMetadata {
    bool needs(Object? input) {
      final p = input is List ? input.single : input;
      return p is Map &&
          const {
            'FT_TRANSFER',
            'STABLECOIN_TRANSFER',
            'POOLNFT_SWAP_TO_TBC',
          }.contains(p['flag']);
    }

    return method == 'sendTransaction'
        ? needs(params)
        : method == 'sendBatchRequest' &&
            (params as List).any(
              (row) =>
                  row['method'] == 'sendTransaction' && needs(row['params']),
            );
  }

  Future<Map<String, dynamic>> prepare(
    LegacyBusinessResolver business,
    void Function() requireCurrent,
  ) async {
    void current() {
      requireCurrent();
      need(
        business.account.chainId == account.chainId &&
            business.account.address == account.address,
        'LEGACY_PREPARATION_ACCOUNT',
      );
    }

    current();
    if (_direct != null) return _direct;
    final request =
        method == 'sendBatchRequest'
            ? await mapLegacyWorkflow(
              params,
              account,
              mapBusiness: business.resolve,
            )
            : await business.resolve(params);
    current();
    if (method == 'sendBatchRequest') {
      final actual = workflowRequiredPermissions(
        request,
        method: standardMethod,
      );
      need(
        actual.length == requiredPermissions.length &&
            actual.containsAll(requiredPermissions),
        'LEGACY_PERMISSION_PROJECTION',
      );
      return request;
    }
    // The frozen Kit's wallet-owned bounded consent cap. Page fields cannot
    // supply this policy, select an endpoint or enlarge signing authority.
    return frozen({
          ...request,
          'constraints': {
            ...?request['constraints'] as Map<String, dynamic>?,
            'maxFee': (params as Map)['flag'] == 'P2PKH' ? '1000' : '10000',
          },
        })
        as Map<String, dynamic>;
  }

  static String _businessMethod(Map p) {
    final flag = p['flag'];
    if (const {
      'FT_MERGE',
      'STABLECOIN_MERGE',
      'POOLNFT_MERGE',
      'FTLP_MERGE',
      'POOLNFT_LP_BURN',
    }.contains(flag)) {
      return 'tbc_sendTransaction';
    }
    if (const {
      'POOLNFT_SWAP_TO_TOKEN',
      'POOLNFT_SWAP_TO_TBC',
      'POOLNFT_LP_INCREASE',
      'POOLNFT_LP_CONSUME',
    }.contains(flag)) {
      need(p['broadcastEnabled'] == false, 'LEGACY_POOL_SIGN_ONLY');
      return 'tbc_signTransaction';
    }
    need(
      const {
        'P2PKH',
        'FT_TRANSFER',
        'STABLECOIN_TRANSFER',
        'NFT_TRANSFER',
      }.contains(flag),
      'LEGACY_UNSUPPORTED_BUSINESS',
    );
    return p['broadcastEnabled'] == false
        ? 'tbc_signTransaction'
        : 'tbc_sendTransaction';
  }
}
