import '../configuration.dart';
import 'protocol_codec.dart';

/// One captured trusted document/account operation, not a page-supplied claim.
/// Every live fence is required. There are deliberately no granted/unlocked or
/// active defaults. The shared permission evaluator supplies [requireAuthorized]
/// after checking the committed grant; the native Vault repeats at execution.
final class TbcOperationAuthority {
  TbcOperationAuthority({
    required Map context,
    required TbcAccount account,
    required this.requireAuthorized,
    required this.isUnlocked,
    required this.clock,
  }) : context = frozen(copied(context)) as Map<String, dynamic>,
       account = frozen(account.toKitAccount()) as Map<String, dynamic>,
       chainId = account.network.chainId;
  final Map<String, dynamic> context, account;
  final String chainId;
  final void Function(String method) requireAuthorized;
  final bool Function() isUnlocked;
  final DateTime Function() clock;

  DateTime get now => DateTime.fromMillisecondsSinceEpoch(
    clock().millisecondsSinceEpoch,
    isUtc: true,
  );
  void check(String method) => requireAuthorized(method);
  // Immutable local identity; liveness/grants/revisions are enforced separately.
  late final String identity = hashJson({
    'context': context,
    'account': account,
  });
}
