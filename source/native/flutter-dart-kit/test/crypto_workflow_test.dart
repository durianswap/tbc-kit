// Shared executor + actual frozen Rust plan/validation, public replay custody.
// Native custody, mobile and real-key computation are separate evidence.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'workflow_execution_test.dart' as w;

void main() {
  setUpAll(() {
    final bytes = File('test/fixtures/crypto-workflow.json').readAsBytesSync();
    expect(
      sha256.convert(bytes).toString(),
      'be69533af3b37464b048a9d811998f2d961869427d39e004db8216ddb8b1bc1e',
    );
    w.planning = w.signing = jsonDecode(utf8.decode(bytes));
    final lib = w.read('signing/replay')['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    w.native = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  for (final name in [
    'crypto-pair',
    'mixed-crypto',
    'prepared-crypto',
    'crypto-independent-failure',
  ]) {
    test('frozen workflow crypto $name uses one receipt', () async {
      final h = w.Harness(name);
      if (h.source['failAt'] != null)
        h.operation.unavailableAt = h.source['failAt'];
      final result = await h.run();
      expect(canonical(result), canonical(h.expected['result']));
      expect(h.operation.consents, 1);
      expect(h.operation.binds, 1);
      expect(h.operation.cryptos, 2);
      expect(h.reads, 0);
      expect(
        h.preparations,
        name.contains('mixed') || name.contains('prepared') ? 1 : 0,
      );
      expect(h.operation.closes, 1);
    });
  }
  test('task mismatch blocks completion and next step', () async {
    final h = w.Harness('crypto-pair')..operation.tamperCrypto = true;
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.cryptos, 1);
    expect(h.operation.finishes, 0);
  });
  test('opaque failure cannot continue independent steps', () async {
    final h = w.Harness('crypto-independent-failure');
    h.operation.unavailableAt = 'fails';
    h.operation.opaqueCryptoFailure = true;
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.cryptos, 1);
    expect(h.operation.finishes, 0);
  });
  for (final state in ['grant', 'locked', 'expiry']) {
    test('crypto result withheld after $state changes', () async {
      final h = w.Harness('crypto-pair');
      h.operation.duringCrypto = () {
        if (state == 'grant') h.revokedGrant = 'tbc_crypto';
        if (state == 'locked') h.unlocked = false;
        if (state == 'expiry')
          h.time = protocolTime(h.source['request']['expiresAt']);
      };
      await expectLater(h.run(), throwsStateError);
      expect(h.operation.cryptos, 1);
      expect(h.operation.finishes, 0);
    });
  }
  test('crypto grant required before approval', () async {
    final h = w.Harness('crypto-pair')..revokedGrant = 'tbc_crypto';
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.operation.cryptos, 0);
  });
}
