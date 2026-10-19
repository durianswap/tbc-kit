// Historical pair *recognition* still comes from frozen Rust identifyPairs.
// These bounded field readers run only after that exact-template recognition;
// a marker alone is never sufficient to accept an asset or authorize a signer.
import 'protocol_codec.dart';

bool reviewedHistoricalCandidate(String script, BigInt value) =>
    value == BigInt.from(500) &&
    script.length >= 56 &&
    script.endsWith('0532436f6465');

// Apply only after both complete pairs have passed frozen Rust recognition.
// Historical partial-hash identities are not a substitute for this full Code
// equality: only the holder controller is allowed to differ in indexed Code.
String historicalContractCode(String script) {
  need(
    script.length >= 56 &&
        script.endsWith('0532436f6465') &&
        script.substring(script.length - 56, script.length - 54) == '15',
    'REVIEWED_HISTORICAL_CONTROLLER',
  );
  return '${script.substring(0, script.length - 54)}${'0' * 42}${script.substring(script.length - 12)}';
}

Map<String, dynamic> historicalReviewedPair(Map row, Map identity) {
  final protocol = identity['protocol'], version = identity['protocolVersion'];
  final coin = protocol == 'legacy-stablecoin';
  need(
    identity['generation'] == 'historical' &&
        identity['verification'] == 'exact-template' &&
        identity['assetIdentityVerified'] == false &&
        {'legacy-ft', 'legacy-tbc20', 'legacy-stablecoin'}.contains(protocol) &&
        identity['family'] == (coin ? 'tbc20Stablecoin' : 'tbc20') &&
        version is int &&
        version >= 0 &&
        version <= 255 &&
        identity['codeIdentity'] is String &&
        RegExp(r'^(?:[0-9a-f]{2}){33,37}$').hasMatch(identity['codeIdentity']),
    'REVIEWED_HISTORICAL_IDENTITY',
  );
  final code = unhex(row['codeScript']), tape = unhex(row['tapeScript']);
  // The frozen SDK places a direct 21-byte receiver immediately before 2Code.
  final receiver = code.length - 28;
  need(
    receiver >= 0 &&
        code[receiver] == 21 &&
        hex(code.sublist(code.length - 6)) == '0532436f6465',
    'REVIEWED_HISTORICAL_CONTROLLER',
  );
  final balance = identity['balanceRaw'];
  need(
    balance is String &&
        RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(balance) &&
        BigInt.parse(balance) <=
            BigInt.from(6) * ((BigInt.one << 63) - BigInt.one),
    'REVIEWED_TOKEN_BALANCE',
  );
  int? lock;
  if (coin) {
    // Match SDK get_lock_time_from_tape: complete chunks, not suffix guessing
    // (an ordinary FT's four-byte symbol must not be mistaken for a lock).
    need(
      tape.length >= 3 && hex(tape.sublist(0, 3)) == '006a30',
      'REVIEWED_HISTORICAL_COIN_TAPE',
    );
    var offset = 2;
    final chunks = <List<int>>[];
    while (offset < tape.length) {
      final op = tape[offset++];
      var length = op;
      if (op == 76 || op == 77) {
        final bytes = op == 76 ? 1 : 2;
        need(offset + bytes <= tape.length, 'REVIEWED_HISTORICAL_COIN_TAPE');
        length = tape[offset++];
        if (bytes == 2) length |= tape[offset++] << 8;
      } else
        need(op >= 1 && op <= 75, 'REVIEWED_HISTORICAL_COIN_TAPE');
      need(offset + length <= tape.length, 'REVIEWED_HISTORICAL_COIN_TAPE');
      chunks.add(tape.sublist(offset, offset + length));
      offset += length;
    }
    need(
      chunks.length >= 6 &&
          chunks.first.length == 48 &&
          hex(chunks.last) == '4654617065' &&
          chunks[chunks.length - 2].length == 4,
      'REVIEWED_HISTORICAL_COIN_TAPE',
    );
    final bytes = chunks[chunks.length - 2];
    lock = bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
  }
  return frozen({
        'code': {
          'standardId': protocol,
          'generation': 'historical',
          'protocolVersion': version,
          'codeIdentity': identity['codeIdentity'],
          'controller': hex(code.sublist(receiver + 1, receiver + 22)),
          'tapeSize': tape.length,
          'verification': 'exact-template',
          'assetIdentityVerified': false,
        },
        'balanceRaw': balance,
        if (lock != null) 'lockTime': lock,
      })
      as Map<String, dynamic>;
}

/// Holder CLTV predicate only, not tip/maturity or administrator authorization.
void checkHistoricalHolderLock(int lock, Map inputLock) {
  final sequence = inputLock['sequence'], tx = inputLock['transactionLockTime'];
  need(
    sequence is int &&
        sequence >= 0 &&
        sequence < 0xffffffff &&
        tx is int &&
        tx >= 0 &&
        tx <= 0xffffffff &&
        lock <= tx &&
        (lock == 0 || (lock < 500000000) == (tx < 500000000)),
    'REVIEWED_COIN_INPUT_LOCK',
  );
}
