// Verification only. P5 private scalars remain in native custody.
import 'dart:typed_data';
import 'package:web3dart/crypto.dart' as ec;
import 'package:pointycastle/api.dart';
import 'package:pointycastle/ecc/api.dart';
import 'package:pointycastle/ecc/curves/secp256k1.dart';
import 'package:pointycastle/signers/ecdsa_signer.dart';
import 'protocol_codec.dart';

void verifyRecoverable(Map task, Map result) {
  need(
    result['taskId'] == task['taskId'] &&
        result['signatureEncoding'] == task['signatureEncoding'],
    'SIGNATURE_TASK_MISMATCH',
  );
  final b = unhex(result['signature']);
  need(b.length == 65 && b[0] >= 31 && b[0] <= 34, 'RECOVERY_HEADER');
  final r = BigInt.parse(hex(b.sublist(1, 33)), radix: 16),
      s = BigInt.parse(hex(b.sublist(33)), radix: 16);
  final order = BigInt.parse(
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    radix: 16,
  );
  need(
    r > BigInt.zero && r < order && s > BigInt.zero && s <= (order >> 1),
    'SIGNATURE_SCALARS',
  );
  // Frozen Noble first tries DER, then falls back to compact on a DER parse
  // error. A leading 0x30 alone is NOT a reason to reject a valid compact sig.
  // Only a structurally valid DER interpretation triggers the extra check.
  final der = _derScalars(b.sublist(1));
  if (der != null) {
    need(
      der.$1 > BigInt.zero &&
          der.$1 < order &&
          der.$2 > BigInt.zero &&
          der.$2 <= (order >> 1),
      'DER_SIGNATURE_SCALARS',
    );
    final curve = ECCurve_secp256k1();
    final verifier = ECDSASigner(null)..init(
      false,
      PublicKeyParameter(
        ECPublicKey(curve.curve.decodePoint(unhex(task['publicKey'])), curve),
      ),
    );
    need(
      verifier.verifySignature(
        unhex(task['digest']),
        ECSignature(der.$1, der.$2),
      ),
      'DER_SIGNATURE_MISMATCH',
    );
  }
  final recovered = ec.ecRecover(
    unhex(task['digest']),
    ec.MsgSignature(r, s, b[0] - 4),
  );
  need(recovered.length <= 64, 'PUBLIC_KEY_LENGTH');
  final padded = Uint8List(64)..setRange(64 - recovered.length, 64, recovered);
  final compressed =
      '${padded[63].isEven ? '02' : '03'}${hex(padded.sublist(0, 32))}';
  need(compressed == task['publicKey'], 'SIGNATURE_KEY_MISMATCH');
}

// Framing only, not a new cryptographic algorithm. With a fixed 64-byte input,
// canonical DER lengths must use the short form. Malformed DER falls back to
// compact exactly as the frozen JS dependency does.
(BigInt, BigInt)? _derScalars(Uint8List b) {
  if (b.length != 64 || b[0] != 0x30 || b[1] != 62) return null;
  var offset = 2;
  BigInt? integer() {
    if (offset + 2 > b.length || b[offset++] != 2) return null;
    final length = b[offset++];
    if (length == 0 || length >= 128 || offset + length > b.length) return null;
    final bytes = b.sublist(offset, offset + length);
    offset += length;
    if (bytes[0] >= 128 ||
        (bytes.length > 1 && bytes[0] == 0 && bytes[1] < 128))
      return null;
    return BigInt.parse(hex(bytes), radix: 16);
  }

  final r = integer();
  if (r == null) return null;
  final s = integer();
  return s != null && offset == 64 ? (r, s) : null;
}
