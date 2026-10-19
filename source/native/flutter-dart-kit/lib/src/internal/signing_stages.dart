// Shared post-approval stage machinery. Single requests and workflow steps use
// the same Engine finalization/continuation and Reviewed Rust verification.
// No approval, network, key lookup, persistence or retry is owned here.
import 'dart:convert';
import 'protocol_codec.dart';
import 'reviewed_signing.dart';
import 'transaction_profiles.dart';
import 'typed_signing.dart';

typedef StageEngine =
    Map<String, dynamic> Function(String, Map<String, dynamic>);
typedef StageSign = Future<List<Map<String, dynamic>>> Function(List);
typedef StageAdvance = Future<void> Function(Map<String, dynamic>);

final class SigningStageLimits {
  SigningStageLimits.transaction(Map request, Map plan) {
    taskLimit = transactionTaskLimits[request['intent']['type']]!;
    final preview = plan['payload']['preview'],
        tasks = plan['payload']['signingTasks'];
    stagedWithoutCount =
        poolContinuationProfiles.contains(request['intent']['type']) &&
        preview['transactionCount'] > 1 &&
        preview['signingTaskCount'] == null;
    totalTasks =
        stagedWithoutCount
            ? (taskLimit * (preview['transactionCount'] as int)).clamp(1, 1024)
            : preview['signingTaskCount'] ?? tasks.length;
    need(totalTasks >= tasks.length && totalTasks <= 1024, 'TOTAL_TASK_COUNT');
  }
  late final int taskLimit, totalTasks;
  late final bool stagedWithoutCount;
}

Future<Map<String, dynamic>> signTransactionStages({
  required Map<String, dynamic> material,
  required Map<String, dynamic> plan,
  required Map binding,
  required Map receipt,
  required Map account,
  required StageEngine engine,
  required StageSign sign,
  required StageAdvance advance,
  required void Function() receiptCheck,
  bool forBroadcast = false,
}) async {
  final limits = SigningStageLimits.transaction(material['request'], plan);
  final preview = plan['payload']['preview'];
  Map<String, dynamic>? continuation;
  var stage = 0, count = 0;
  List tasks = plan['payload']['signingTasks'];
  while (true) {
    receiptCheck();
    need(
      tasks.isNotEmpty &&
          tasks.length <= limits.taskLimit &&
          count + tasks.length <= limits.totalTasks,
      'TASK_COUNT',
    );
    final signatures = await sign(tasks);
    count += signatures.length;
    receiptCheck();
    final args = <String, dynamic>{
      ...material,
      'plan': plan,
      'binding': binding,
      'approval': receipt,
      'signatures': signatures,
      if (continuation != null) 'continuation': continuation,
    };
    final finalized = engine('finalize', args);
    if (finalized['status'] == 'pending') {
      need(
        engine('validate', {
              ...args,
              'phase': 'finalized',
              'pending': finalized,
            })['valid'] ==
            true,
        'PENDING_INVALID',
      );
      final next = copied(finalized['continuation']);
      need(
        next['version'] == '1.0' &&
            next['method'] == 'finalize' &&
            next['requestHash'] == material['requestHash'] &&
            next['planHash'] == plan['planHash'] &&
            next['bindingHash'] == binding['bindingHash'] &&
            next['approvalId'] == receipt['approvalId'] &&
            next['stage'] is int &&
            next['stage'] == stage + 1 &&
            next['stage'] < preview['transactionCount'] &&
            (continuation == null ||
                next['sessionId'] == continuation['sessionId']),
        'CONTINUATION_BINDING',
      );
      receiptCheck();
      await advance(finalized);
      receiptCheck();
      stage = next['stage'];
      continuation = next;
      tasks = finalized['signingRequests'];
      continue;
    }
    need(
      finalized['validation']?['valid'] == true && finalized['bundle'] is Map,
      'FINALIZE_INVALID',
    );
    final result = copied(finalized['bundle']);
    need(
      result['chainId'] == account['chainId'] &&
          result['from'] == account['address'] &&
          result['requestHash'] == material['requestHash'] &&
          result['approvalId'] == receipt['approvalId'],
      'RESULT_BINDING',
    );
    need(
      engine('validate', {
            ...args,
            'phase': 'finalized',
            'bundle': result,
          })['valid'] ==
          true,
      'FINALIZED_INVALID',
    );
    need(
      limits.stagedWithoutCount
          ? stage == preview['transactionCount'] - 1 &&
              count <= limits.totalTasks
          : count == limits.totalTasks,
      'INCOMPLETE_TASKS',
    );
    // Use the terminal stage's exact material/signatures/continuation while
    // already available. No refetch, second plan or retained signing journal.
    // Sign-only calls neither perform this extra phase nor allocate a copy.
    if (forBroadcast) {
      receiptCheck();
      need(
        engine('validate', {
              ...args,
              'phase': 'pre-broadcast',
              'bundle': result,
            })['valid'] ==
            true,
        'PRE_BROADCAST_INVALID',
      );
    }
    return result;
  }
}

Future<Map<String, dynamic>> signReviewedStages({
  required ReviewedSigningProgram program,
  required String approvalId,
  required StageSign sign,
  required StageAdvance advance,
  required void Function() receiptCheck,
}) async {
  var count = 0;
  while (true) {
    receiptCheck();
    final tasks = program.tasks;
    need(
      tasks.length <= 1000 && count + tasks.length <= program.totalTasks,
      'TASK_COUNT',
    );
    final signatures = await sign(tasks);
    count += signatures.length;
    receiptCheck();
    program.finalize(signatures);
    if (program.complete) break;
    await advance(program.continuation);
    receiptCheck();
  }
  need(count == program.totalTasks, 'INCOMPLETE_TASKS');
  return copied(program.bundle(approvalId));
}

// Signature verification is performed by the shared task consumer before this
// public projection; this formatter alone is never signing authority.
Map<String, dynamic> signedEnvelopeResult({
  required Map envelope,
  required Map task,
  required Map signature,
  required Map account,
  MessageSigningProfile messageProfile = MessageSigningProfile.standard,
}) {
  final typed = task['purpose'] == 'typedData';
  final legacy =
      !typed && messageProfile == MessageSigningProfile.legacyBitcoin;
  need(typed || task['purpose'] == 'message', 'MESSAGE_PURPOSE');
  return {
    'version': '1.0',
    'scheme':
        typed
            ? 'tbc-typed-data'
            : legacy
            ? 'legacy-bitcoin-message'
            : 'tbc-message',
    'algorithm': task['algorithm'],
    'address': account['address'],
    'accountId': account['accountId'],
    'publicKey': account['publicKey'],
    'envelope': envelope,
    'canonical': canonical(envelope),
    if (!legacy)
      'signingPayload': base64Encode(
        typed ? typedDataPayload(envelope) : messagePayload(envelope),
      ),
    'digest': task['digest'],
    'signature': base64Encode(unhex(signature['signature'])),
  };
}
