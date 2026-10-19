// Local identity resolution, never a permission grant or private-key lookup.
// Additional accounts must be supplied by trusted wallet custody, not Chain
// Data, a page request or a DApp-provided public key. Native role custody is a
// separate gate; resolving these identities alone cannot authorize a signature.
import 'protocol_codec.dart';
import 'transaction_read.dart';

const poolRoleProfiles = {
  'tbc-amm-add-liquidity',
  'tbc-amm-remove-liquidity',
  'tbc-amm-swap',
  'amm.addLiquidity',
  'amm.removeLiquidity',
  'amm.swap',
};

final class TransactionSigningAccounts {
  TransactionSigningAccounts._(this.primary, this.additional, this.roles);
  final Map<String, dynamic> primary;
  final List<Map<String, dynamic>> additional, roles;
  Map<String, dynamic>? get controller =>
      roles.isEmpty ? null : roles.single['account'];

  factory TransactionSigningAccounts.resolve({
    required Map request,
    required Map primary,
    List<Map<String, dynamic>> additional = const [],
  }) {
    final owner = copied(primary), chain = request['chainId'];
    inspectAccount(owner, expectedChainId: chain);
    need(request['from'] == owner['address'], 'ROLE_PRIMARY');
    final declared = request['signingRoles'];
    if (declared == null) {
      need(additional.isEmpty, 'ROLE_UNREQUESTED_ACCOUNT');
      return TransactionSigningAccounts._(
        frozen(owner) as Map<String, dynamic>,
        const [],
        const [],
      );
    }
    need(poolRoleProfiles.contains(request['intent']?['type']), 'ROLE_PROFILE');
    need(declared is List && declared.length == 1, 'ROLE_SELECTION');
    final selection = declared.single;
    need(
      selection is Map &&
          selection.length == 2 &&
          selection['role'] == 'pool-controller' &&
          selection['accountId'] is String,
      'ROLE_SELECTION',
    );
    final id = selection['accountId'];
    need(
      id.startsWith('$chain:') && id.length > chain.length + 1,
      'ROLE_CHAIN',
    );
    need(
      additional.length == (id == owner['accountId'] ? 0 : 1),
      'ROLE_ACCOUNT_COUNT',
    );
    final accounts = [owner, ...additional.map(copied)];
    for (final a in accounts) inspectAccount(a, expectedChainId: chain);
    need(
      accounts.map((a) => a['accountId']).toSet().length == accounts.length &&
          accounts
                  .map((a) => (a['publicKey'] as String).substring(2))
                  .toSet()
                  .length ==
              accounts.length,
      'ROLE_AMBIGUOUS_ACCOUNT',
    );
    final matched = accounts.where((a) => a['accountId'] == id).toList();
    need(matched.length == 1, 'ROLE_ACCOUNT_MISSING');
    return TransactionSigningAccounts._(
      frozen(owner) as Map<String, dynamic>,
      List.unmodifiable(
        accounts.skip(1).map((a) => frozen(a) as Map<String, dynamic>),
      ),
      List.unmodifiable([
        frozen({'role': 'pool-controller', 'account': matched.single})
            as Map<String, dynamic>,
      ]),
    );
  }

  void requireSnapshot(Map snapshot) {
    final observed = snapshot['signingAccounts'];
    need(
      canonical(snapshot['account']) == canonical(primary) &&
          (additional.isEmpty
              ? observed == null
              : canonical(observed) == canonical(additional)),
      'ROLE_SNAPSHOT_ACCOUNT',
    );
  }

  void requireTasks(List tasks) {
    final accounts = [primary, ...additional];
    for (final task in tasks) {
      need(
        task is Map &&
            accounts.any(
              (a) =>
                  task['accountId'] == a['accountId'] &&
                  task['publicKey'] == a['publicKey'],
            ),
        'ROLE_TASK_ACCOUNT',
      );
    }
  }
}
