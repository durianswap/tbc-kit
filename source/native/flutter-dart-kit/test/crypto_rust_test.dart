// Host-only public scalar1/2 fixture. No wallet keys, network or broadcast.
// Do not copy this fixture adapter into a wallet: production keys stay native.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:ffi/ffi.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'crypto_action_test.dart' as replay;

typedef _CryptNative =
    Int32 Function(
      Pointer<Uint8>,
      UintPtr,
      Pointer<Uint8>,
      UintPtr,
      Uint32,
      Pointer<Uint8>,
      UintPtr,
    );
typedef _CryptDart =
    int Function(
      Pointer<Uint8>,
      int,
      Pointer<Uint8>,
      int,
      int,
      Pointer<Uint8>,
      int,
    );
late _CryptDart crypt;

Uint8List input(Map task) {
  if (task['purpose'] == 'decrypt') return base64Decode(task['ciphertext']);
  final m = task['message'];
  return switch (m['encoding']) {
    'utf8' => Uint8List.fromList(utf8.encode(m['data'])),
    'hex' => unhex(m['data']),
    'base64' => base64Decode(m['data']),
    _ => throw StateError('Invalid fixture'),
  };
}

Uint8List execute(
  Uint8List bytes,
  bool decrypt, {
  int publicScalar = 1,
  bool reject = false,
}) {
  final capacity = decrypt ? bytes.length : 69 + (bytes.length ~/ 16 + 1) * 16;
  final data = calloc<Uint8>(bytes.isEmpty ? 1 : bytes.length);
  final scalar = calloc<Uint8>(32), output = calloc<Uint8>(capacity);
  try {
    data.asTypedList(bytes.length).setAll(0, bytes);
    scalar[31] = publicScalar;
    output.asTypedList(capacity).fillRange(0, capacity, 0xa5);
    final length = crypt(
      data,
      bytes.length,
      scalar,
      32,
      decrypt ? 1 : 0,
      output,
      capacity,
    );
    if (reject) {
      expect(length, lessThan(0));
      expect(
        output.asTypedList(capacity).every((v) => v == 0),
        isTrue,
        reason: 'No unauthenticated plaintext may be copied out',
      );
      return Uint8List(0);
    }
    expect(length, inInclusiveRange(0, capacity));
    return Uint8List.fromList(output.asTypedList(length));
  } finally {
    data
        .asTypedList(bytes.isEmpty ? 1 : bytes.length)
        .fillRange(0, bytes.isEmpty ? 1 : bytes.length, 0);
    scalar.asTypedList(32).fillRange(0, 32, 0);
    output.asTypedList(capacity).fillRange(0, capacity, 0);
    calloc.free(data);
    calloc.free(scalar);
    calloc.free(output);
  }
}

final class RustFixtureOperation extends replay.CryptoOperation {
  RustFixtureOperation(super.h);
  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  ) async {
    final expected = await super.executeCrypto(receipt, task);
    final bytes = input(task.wire);
    Uint8List? output;
    try {
      output = execute(bytes, task.purpose == 'decrypt');
      final value = {
        'taskId': task.taskId,
        'algorithm': task.algorithm,
        if (task.purpose == 'encrypt') 'ciphertext': base64Encode(output),
        if (task.purpose == 'decrypt')
          'message': {'encoding': 'base64', 'data': base64Encode(output)},
      };
      expect(canonical(value), canonical(expected.wire));
      return TbcCryptoResult(value);
    } finally {
      bytes.fillRange(0, bytes.length, 0);
      output?.fillRange(0, output.length, 0);
    }
  }
}

void main() {
  setUpAll(() {
    const root =
        '../flutter-compat/crypto-custody-source-evidence-2026-10-07-a/native-signer';
    const path = '$root/target/release/libtbc_signer_kernel.dylib';
    const pin =
        '9b6bddd40a80d25dd5a2bb9888eaa99a148141274acd36856ac149f4e7e9af0f';
    expect(sha256.convert(File(path).readAsBytesSync()).toString(), pin);
    final evidence = jsonDecode(File('$root/evidence.json').readAsStringSync());
    expect(evidence['librarySha256'], pin);
    for (final file in [
      'src/crypto.rs',
      'src/lib.rs',
      'include/tbc_signer_kernel.h',
    ]) {
      expect(
        sha256
            .convert(File('../signer/kernel/$file').readAsBytesSync())
            .toString(),
        evidence['sourceHashes'][file],
      );
    }
    final library = DynamicLibrary.open(path);
    expect(
      library.lookupFunction<Uint32 Function(), int Function()>(
        'tbc_signer_kernel_version',
      )(),
      1,
    );
    crypt = library.lookupFunction<_CryptNative, _CryptDart>('tbc_signer_bie1');
    final e =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(e['path']).readAsBytesSync()).toString(),
      e['sha256'],
    );
    replay.engine = ComputeProbe(DynamicLibrary.open(e['path']));
  });
  for (var i = 0; i < (replay.fixture['cases'] as List).length; i++) {
    test(
      'actual frozen Rust ${replay.fixture['cases'][i]['name']} through shared executor',
      () async {
        final h = replay.CryptoHarness(i, RustFixtureOperation.new);
        expect(canonical(await h.execute()), canonical(h.sample['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.cryptos, 1);
        expect(h.operation.closes, 1);
      },
    );
  }
  for (final bad in replay.fixture['nativeReject']) {
    test('actual Rust rejects ${bad['name']} tamper without plaintext', () {
      execute(base64Decode(bad['ciphertext']), true, reject: true);
    });
  }
  test(
    'actual Rust rejects different public fixture account without plaintext',
    () {
      execute(
        base64Decode(replay.fixture['cases'][0]['result']['ciphertext']),
        true,
        publicScalar: 2,
        reject: true,
      );
    },
  );
}
