import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

// Source candidate only. Never replace or silently relabel the frozen oracle.
Map<String, dynamic> trustedIndexCandidateLibrary() {
  final file =
      File(
        Platform.environment['TBC_MATERIAL_LIBRARY'] ??
            '../../packages/tbc-engine/rust/target/debug/libtbc_direct_material_probe.dylib',
      ).absolute;
  return {
    'path': file.path,
    'sha256': sha256.convert(file.readAsBytesSync()).toString(),
  };
}

// Expected semantic delta, not a new frozen snapshot: an unqueried chain tip
// and non-observed confirmation counts are absent. All spend bytes stay equal.
Map<String, dynamic> withoutObservedTip(Map snapshot) {
  final result = copied(snapshot), payload = result['payload'];
  payload.remove('block');
  for (final u in payload['utxos']) {
    if (u['confirmations'] != '0') u.remove('confirmations');
  }
  result['snapshotHash'] = hashJson(payload);
  return result;
}

// Update only the evidence commitment of an immutable signing oracle after an
// explicitly specified read-plan change. Signing tasks, transaction templates,
// signatures and expected final bytes are never regenerated from the candidate.
void rebindExpectedSnapshot(Map sample, Map snapshot) {
  final audit = sample['audit'],
      plan = audit['plan'],
      binding = audit['binding'];
  need(plan['planHash'] == hashJson(plan['payload']), 'ORACLE_PLAN_HASH');
  need(
    binding['payload']['operationHash'] == plan['planHash'],
    'ORACLE_BINDING_PLAN',
  );
  audit['material']['snapshot'] = snapshot;
  plan['payload']['snapshotHash'] = snapshot['snapshotHash'];
  plan['planHash'] = hashJson(plan['payload']);
  binding['payload']['operationHash'] = plan['planHash'];
  binding['bindingHash'] = hashJson(binding['payload']);
  audit['approval']['bindingHash'] = binding['bindingHash'];
}
