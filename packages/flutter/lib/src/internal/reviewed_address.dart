// Public P2PKH display address only. Both configured TBC networks use version
// zero; network/session authority is checked separately, never inferred here.
import 'package:crypto/crypto.dart';
import 'protocol_codec.dart';

String reviewedAddress(String publicKeyHash) {
  need(
    RegExp(r'^[0-9a-f]{40}$').hasMatch(publicKeyHash),
    'REVIEWED_ADDRESS_HASH',
  );
  final payload = [0, ...unhex(publicKeyHash)];
  final check = sha256.convert(sha256.convert(payload).bytes).bytes;
  final bytes = [...payload, ...check.take(4)];
  var number = BigInt.zero;
  for (final byte in bytes) number = (number << 8) | BigInt.from(byte);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var result = '';
  while (number > BigInt.zero) {
    result = alphabet[(number % BigInt.from(58)).toInt()] + result;
    number ~/= BigInt.from(58);
  }
  for (final byte in bytes) {
    if (byte != 0) break;
    result = '1$result';
  }
  return result;
}
