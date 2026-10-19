// Enabled only after frozen material/Engine parity. These bounds match the
// material readers, not a blanket increase for all future transaction families.
const transactionTaskLimits = {
  'tbc-lop-create': 128,
  'tbc-lop-cancel': 3,
  'tbc-lop-match': 3,
  'tbc-htlc-lock': 128,
  'tbc-htlc-claim': 128,
  'tbc-htlc-refund': 128,
  'tbc-timelock-lock': 128,
  'tbc-timelock-unlock': 128,
  'amm.swap': 128,
  'amm.addLiquidity': 128,
  'amm.removeLiquidity': 128,
  'amm.mergeToken': 6,
  'tbc20Lp.transfer': 128,
  'tbc20Lp.lock': 128,
  'tbc20Lp.unlock': 128,
  // Current LP permits more inputs; historical limits remain enforced by the
  // same frozen Engine after authenticated template selection.
  'tbc20Lp.merge': 128,
  'tbc20Lp.burn': 6,
  'tbc20.transfer': 32,
  'tbc20.merge': 32,
  'tbc20-standard-create': 128,
  'tbc721-standard-create-collection': 128,
  'tbc721-standard-mint': 128,
  'tbc721-standard-batch-mint': 128,
  'tbc-amm-create': 128,
  'tbc-amm-add-liquidity': 128,
  'tbc-amm-remove-liquidity': 128,
  'tbc-amm-swap': 128,
  'tbc20-lp-transfer': 128,
  'tbc20-lp-merge': 128,
  'tbc20-lp-lock': 128,
  'tbc20-lp-unlock': 128,
  'tbc.pool.swap.exactTbcForToken': 128,
  'tbc.pool.swap.exactTokenForTbc': 128,
  'tbc.pool.liquidity.add': 128,
  'tbc.pool.liquidity.remove': 128,
  'tbc.pool.ft.merge': 6,
  'tbc.pool.ftlp.merge': 6,
  'tbc.pool.ftlp.burn': 6,
  'tbc.transfer': 128,
  'tbc.maintenance.merge': 100,
  'tbc721.transfer': 128,
  'tbc20Stablecoin.transfer': 128,
  'tbc20Stablecoin.merge': 128,
};
const maxTransactionBundleSize = 32;

// Frozen Pool plans may omit aggregate signingTaskCount. Their transaction
// graph still has one validated signing stage per transaction. Do not mistake
// the first-stage task list for the complete batch or invent an exact count.
const poolContinuationProfiles = {
  'tbc-amm-add-liquidity',
  'tbc-amm-remove-liquidity',
  'tbc-amm-swap',
  'amm.addLiquidity',
  'amm.removeLiquidity',
  'amm.swap',
};

// A bounded creation consent includes dependent steps and possible native
// consolidation. An HTLC claim separately requires the exact preimage-disclosure
// warning already shown by native consent. Both cases require their matching
// plan shapes; do not suppress arbitrary Engine warnings.
bool coveredTransactionWarnings(Map request, Map payload) {
  final preview = payload['preview'];
  final warnings = preview is Map ? preview['warnings'] : null;
  if (warnings is! List) return false;
  if (request['intent']?['type'] == 'tbc-htlc-claim') {
    final transactions = payload['transactions'];
    return warnings.length == 1 &&
        warnings.single == 'HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE' &&
        transactions is List &&
        transactions.length == 1 &&
        preview['transactionCount'] == 1;
  }
  if (warnings.isEmpty) return true;
  final transactions = payload['transactions'];
  if (poolContinuationProfiles.contains(request['intent']?['type'])) {
    return warnings.length == 2 &&
        warnings.toSet().containsAll({
          'MULTI_TRANSACTION',
          'MAINTENANCE_TRANSACTION',
        }) &&
        transactions is List &&
        transactions.length >= 2 &&
        transactions.length <= maxTransactionBundleSize &&
        preview['transactionCount'] == transactions.length &&
        transactions.first['id'] == 'native-funding-1' &&
        transactions
            .take(transactions.length - 1)
            .every((t) => t['role'] == 'maintenance') &&
        transactions.last['role'] == 'primary';
  }
  return request['intent']?['type'] == 'tbc20-standard-create' &&
      warnings.length == 2 &&
      warnings.toSet().containsAll({
        'MULTI_TRANSACTION',
        'MAINTENANCE_TRANSACTION',
      }) &&
      transactions is List &&
      transactions.length == 3 &&
      preview['transactionCount'] == 3 &&
      transactions[0]['role'] == 'maintenance' &&
      transactions[1]['role'] == 'prerequisite' &&
      transactions[2]['role'] == 'primary';
}
