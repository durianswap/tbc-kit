// Public-terms inspection only. Secret witness bytes stay inside this call;
// frozen Rust independently checks the exact witness in prepare/finalize.
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:pointycastle/digests/ripemd160.dart';
import 'protocol_codec.dart';
import 'htlc_material.dart' show inspectHtlcCode;
import 'reviewed_address.dart';

const _signaturePrefix = '097369676e617475726521';
const _maxPreimage = 65535 - 111;
String _owner(String publicKey) => hex(
  RIPEMD160Digest().process(
    Uint8List.fromList(sha256.convert(unhex(publicKey)).bytes),
  ),
);

/// Preview-only refund projection, shared with associated plan normalization.
/// Claim templates are deliberately not decoded by this refund helper.
int? associatedHtlcRefundLock(String script, Object? template) {
  if (template is! String ||
      template.length != 90 ||
      !template.startsWith(_signaturePrefix) ||
      !template.endsWith('00'))
    return null;
  Map code;
  try {
    code = inspectHtlcCode(script);
  } catch (_) {
    return null;
  }
  need(
    RegExp(r'^[0-9a-f]{90}$').hasMatch(template) &&
        {'02', '03'}.contains(template.substring(22, 24)),
    'REVIEWED_HTLC_WITNESS',
  );
  need(
    _owner(template.substring(22, 88)) == code['senderHash'] &&
        code['lockTime'] >= 1 &&
        code['lockTime'] <= 0x7fffffff,
    'REVIEWED_HTLC_REFUND',
  );
  return code['lockTime'] as int;
}

Map<String, dynamic> inspectAssociatedHtlcWitness({
  required String script,
  required String template,
  required String accountAddress,
  required int sequence,
  required int transactionLockTime,
}) {
  const error = 'REVIEWED_HTLC_WITNESS';
  need(
    sequence >= 0 &&
        sequence <= 0xffffffff &&
        transactionLockTime >= 0 &&
        transactionLockTime <= 0xffffffff &&
        template.length >= 90 &&
        template.length <= (44 + _maxPreimage + 4) * 2 &&
        RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(template) &&
        template.startsWith(_signaturePrefix),
    error,
  );
  Map code;
  try {
    code = inspectHtlcCode(script);
  } catch (_) {
    throw StateError(error);
  }
  need({'02', '03'}.contains(template.substring(22, 24)), error);
  final owner = _owner(template.substring(22, 88));
  need(reviewedAddress(owner) == accountAddress, error);
  final suffix = unhex(template.substring(88));
  if (suffix.length == 1 && suffix[0] == 0) {
    final lock = code['lockTime'] as int;
    need(
      owner == code['senderHash'] &&
          sequence != 0xffffffff &&
          lock >= 1 &&
          lock <= 0x7fffffff &&
          transactionLockTime <= 0x7fffffff &&
          transactionLockTime >= lock &&
          (transactionLockTime < 500000000) == (lock < 500000000),
      error,
    );
    return const {'branch': 'refund', 'preimageVerified': false};
  }
  need(
    suffix.length >= 2 && suffix.last == 0x51 && owner == code['receiverHash'],
    error,
  );
  final push = Uint8List.sublistView(suffix, 0, suffix.length - 1),
      op = push[0];
  Uint8List secret;
  if (push.length == 1 && op == 0)
    secret = Uint8List(0);
  else if (push.length == 1 && (op == 0x4f || (op >= 0x51 && op <= 0x60)))
    secret = Uint8List.fromList([op == 0x4f ? 0x81 : op - 0x50]);
  else {
    int width, length;
    if (op >= 1 && op <= 75) {
      width = 1;
      length = op;
    } else if (op == 76 && push.length >= 2 && push[1] >= 76) {
      width = 2;
      length = push[1];
    } else if (op == 77 && push.length >= 3) {
      width = 3;
      length = push[1] + 256 * push[2];
      need(length >= 256, error);
    } else
      throw StateError(error);
    need(length <= _maxPreimage && push.length == width + length, error);
    secret = Uint8List.sublistView(push, width);
    need(
      !(length == 1 &&
          (secret[0] == 0x81 || (secret[0] >= 1 && secret[0] <= 16))),
      error,
    );
  }
  need(sha256.convert(secret).toString() == code['hashlock'], error);
  return const {'branch': 'claim', 'preimageVerified': true};
}
