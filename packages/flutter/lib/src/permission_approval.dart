import 'dart:convert';
import 'formal_approval.dart';
import 'host_environment.dart';

/// Issues non-signing consent receipts for Kit permission and chain-switch
/// operations. This is not a signer, grant store or unlock mechanism. Core/Host
/// still commits grants or the session mutation through authoritative CAS.
///
/// [readRevision] is a local, monotonic wallet lifecycle revision, incremented
/// on account/network changes, lock, navigation, revocation and disposal. The
/// authority callback must include the native document/session fence. Neither
/// callback may fetch chain data. Native/external stores need their own atomic
/// commit fence; these Dart checks do not provide cross-executor atomicity.
final class TbcPermissionApprovalIssuer {
  const TbcPermissionApprovalIssuer({
    required this.environment,
    required this.readRevision,
    required this.isAuthorityCurrent,
  });

  final TbcHostEnvironment environment;
  final int Function() readRevision;
  final bool Function(TbcApprovalScope) isAuthorityCurrent;

  Future<TbcIssuedApproval> issue(
    TbcApprovalAuthorization authorization,
  ) => _issue(authorization, 'permission');

  Future<TbcIssuedApproval> issueSwitch(
    TbcApprovalAuthorization authorization,
  ) => _issue(authorization, 'switchChain');

  Future<TbcIssuedApproval> _issue(
    TbcApprovalAuthorization authorization,
    String expectedKind,
  ) async {
    authorization.requireActive();
    final review = authorization.review;
    if (review.operationKind != expectedKind ||
        (expectedKind == 'switchChain' &&
            (review.method != 'tbc_switchChain' ||
                review.scope.chainIds.length != 1 ||
                review.scope.accountId != null)) ||
        review.scope.chainIds.isEmpty ||
        !review.scope.chainIds.every(environment.supportsChainId)) {
      throw StateError('Not a non-signing approval for a configured wallet network');
    }
    final revision = readRevision();
    void active() {
      authorization.requireActive();
      if (readRevision() != revision || !isAuthorityCurrent(review.scope)) {
        throw StateError('Non-signing approval authority changed');
      }
    }

    active();
    final started = DateTime.parse(await environment.now());
    active();
    if (!started.isBefore(review.expiresAt)) {
      throw StateError('Non-signing approval expired');
    }
    final entropy = await environment.randomBytes(32);
    active();
    final approvedAt = await environment.now();
    active();
    final approved = DateTime.parse(approvedAt);
    if (approved.isBefore(started) || !approved.isBefore(review.expiresAt)) {
      throw StateError('Non-signing approval clock or expiry changed');
    }
    final payload =
        ((authorization.custodyEnvelope['params'] as Map)['binding']
                as Map)['payload']
            as Map;
    // Preserve the exact bound expiry. Never normalize already-bound data.
    final expiresAt = payload['expiresAt'] as String;
    final token = base64UrlEncode(entropy).replaceAll('=', '');
    return TbcIssuedApproval(
      approvalId: '${expectedKind == 'permission' ? 'permission' : 'switch'}-$token',
      approvalToken: token,
      bindingHash: review.bindingHash,
      approvedAt: approvedAt,
      expiresAt: expiresAt,
      // No permit, key access or grant is installed by this issuer. There is
      // nothing to revoke here; committed grant revocation belongs to Host.
      revoke: () {},
    );
  }
}
