// Shared public terms for native and Token HTLC, over an exact decoded Code.
// Optional associated witness remains private; only its checked branch escapes.
import 'protocol_codec.dart';
import 'reviewed_htlc_witness.dart';

Map<String, dynamic> reviewedHtlcPublicTerms({
  required Map code,
  required String script,
  required String accountAddress,
  required String Function(String) addressFromHash,
  required int transactionLockTime,
  int? sequence,
  Map? associatedInput,
}) {
  final lock = code['lockTime'] as int,
      sender = addressFromHash(code['senderHash']),
      receiver = addressFromHash(code['receiverHash']);
  need(lock >= 1 && lock <= 0x7fffffff, 'REVIEWED_HTLC_LOCK_RANGE');
  if (sequence != null)
    need(
      accountAddress == sender || accountAddress == receiver,
      'REVIEWED_HTLC_ROLE',
    );
  Map<String, dynamic> branch = const {
    'branch': 'unresolved',
    'preimageVerified': false,
  };
  if (associatedInput != null) {
    need(
      sequence != null &&
          associatedInput['scriptSigType'] == 'other' &&
          associatedInput['unfinishedScriptSig'] is String &&
          associatedInput['signingPublicKey'] == null,
      'REVIEWED_HTLC_WITNESS',
    );
    branch = inspectAssociatedHtlcWitness(
      script: script,
      template: associatedInput['unfinishedScriptSig'],
      accountAddress: accountAddress,
      sequence: sequence!,
      transactionLockTime: transactionLockTime,
    );
  }
  return {
    'hashlock': code['hashlock'],
    'sender': sender,
    'receiver': receiver,
    'lockTime': lock,
    'domain': lock < 500000000 ? 'height' : 'timestamp',
    ...branch,
  };
}
