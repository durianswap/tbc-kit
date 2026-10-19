// Private normalized signing rows. Never expose witnesses in review/UI output.
import 'protocol_codec.dart';

List<Map>? reviewedAssociatedProfiles(Map material, int index, int inputCount) {
  if (material['format'] != 'associated') return null;
  final rows =
      index == 0
          ? material['request']['sourceUtxos']
          : material['request']['inputs'][index - 1];
  need(rows is List && rows.length == inputCount, 'REVIEWED_PROFILE_COUNT');
  return (rows as List).cast<Map>();
}

void requireReviewedProofProfile(Map input, String profile) {
  need(
    input['scriptSigType'] == profile &&
        !const [
          'signingPublicKey',
          'signingRole',
          'unfinishedScriptSig',
          'prePreTxData',
          'contractTx',
          'ftVersion',
        ].any(input.containsKey),
    'REVIEWED_PROOF_PROFILE',
  );
}

/// Only use after authenticating a supported holder Code and its owner. This
/// checks the private witness slot, not arbitrary Script execution. SIGHASH_ALL
/// still binds the exact reviewed inputs/outputs; frozen Rust assembles and
/// verifies the signature. Proof payloads remain private and are not re-fetched.
void requireReviewedHolderTemplate(Map input, String publicKey) {
  need(
    input['scriptSigType'] == 'other' &&
        !const [
          'signingPublicKey',
          'signingRole',
          'ancestorTransactions',
          'prePreTxData',
          'contractTx',
          'ftVersion',
        ].any(input.containsKey),
    'REVIEWED_HOLDER_TEMPLATE_PROFILE',
  );
  final wire = input['unfinishedScriptSig'];
  need(
    wire is String &&
        wire.length <= 2097152 &&
        RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(wire),
    'REVIEWED_HOLDER_TEMPLATE',
  );
  final bytes = unhex(wire as String);
  var offset = 0, slots = 0;
  while (offset < bytes.length) {
    final op = bytes[offset++];
    int length;
    if (op <= 75) {
      length = op;
    } else if (op <= 78) {
      final width = 1 << (op - 76);
      need(offset + width <= bytes.length, 'REVIEWED_HOLDER_TEMPLATE');
      length = 0;
      for (var i = 0; i < width; i++) length |= bytes[offset++] << (8 * i);
    } else {
      continue;
    }
    need(offset + length <= bytes.length, 'REVIEWED_HOLDER_TEMPLATE');
    if (op == 9 &&
        hex(bytes.sublist(offset, offset + length)) == '7369676e6174757265') {
      slots++;
      final next = offset + length;
      need(
        next + 34 <= bytes.length &&
            bytes[next] == 33 &&
            hex(bytes.sublist(next + 1, next + 34)) == publicKey,
        'REVIEWED_HOLDER_TEMPLATE_KEY',
      );
    }
    offset += length;
  }
  need(slots == 1, 'REVIEWED_HOLDER_TEMPLATE_SLOT');
}

void requireReviewedLopProfile(
  Map input,
  Map terms,
  Map account,
  String publicKeyHash,
) {
  need(
    !const [
      'signingPublicKey',
      'signingRole',
      'ancestorTransactions',
      'prePreTxData',
      'contractTx',
      'ftVersion',
    ].any(input.containsKey),
    'REVIEWED_LOP_PROFILE',
  );
  if (input['scriptSigType'] == 'tbc_lop_match') {
    need(
      input['preTx'] is String && input['unfinishedScriptSig'] == null,
      'REVIEWED_LOP_MATCH_PROFILE',
    );
    // Actual match proof is reconstructed by frozen Rust preflight/finalize;
    // no order-owner signature or caller-provided witness is authorized here.
    return;
  }
  need(
    input['scriptSigType'] == 'other' &&
        terms['ownerHash'] == publicKeyHash &&
        input['unfinishedScriptSig'] ==
            '097369676e617475726521${account['publicKey']}52',
    'REVIEWED_LOP_CANCEL_WITNESS',
  );
}
