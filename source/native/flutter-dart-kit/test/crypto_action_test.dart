import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/crypto_action.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'signing_executor_test.dart' as digestOnly;

// Frozen Core + independent Node/Noble oracle. This replay proves orchestration
// and result boundaries only, NOT live native BIE1 or installed-device custody.
late ComputeProbe engine;
final fixture =
    jsonDecode(File('test/fixtures/crypto-signing.json').readAsStringSync())
        as Map;

class CryptoOperation implements TbcCryptoSigningOperation {
  CryptoOperation(this.h);
  final CryptoHarness h;
  int consents = 0, binds = 0, cryptos = 0, closes = 0;
  bool approved = true, current = true;
  void Function()? onConsent, onBind, onCrypto;
  void Function(Map<String, dynamic>)? changeReceipt, changeResult;
  Map get audit => h.sample['audit'];
  @override
  Future<void> requireCurrent() async => need(current, 'NATIVE_REVOKED');
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async {
    consents++;
    expect(intent.method, h.sample['method']);
    expect(canonical(intent.request), canonical(h.sample['request']));
    expect(canonical(intent.context), canonical(h.sample['context']));
    onConsent?.call();
    return approved;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) async {
    binds++;
    expect(canonical(material.plan), canonical(audit['plan']));
    expect(canonical(material.preview), canonical(audit['preview']));
    expect(canonical(material.binding), canonical(audit['binding']));
    expect(material.envelope, null);
    expect(material.reviewed, null);
    final value = copied(audit['approval']);
    changeReceipt?.call(value);
    onBind?.call();
    return TbcSigningReceipt(value);
  }

  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  ) async {
    await requireCurrent();
    cryptos++;
    expect(canonical(receipt.wire), canonical(audit['approval']));
    expect(canonical(task.wire), canonical(audit['task']));
    expect(task.toString(), 'TbcCryptoTask(redacted)');
    expect(() => task.wire['accountId'] = 'changed', throwsUnsupportedError);
    final value = copied(audit['cryptoResult']);
    changeResult?.call(value);
    onCrypto?.call();
    final result = TbcCryptoResult(value);
    expect(result.toString(), 'TbcCryptoResult(redacted)');
    return result;
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt receipt,
    TbcSigningTask task,
  ) async => throw StateError('BIE1 must not use digest-signing');
  @override
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation next,
  ) async =>
      throw StateError('Standalone BIE1 must not be a transaction workflow');
  @override
  Future<void> close() async {
    closes++;
    current = false;
  }
}

final class CryptoHarness {
  CryptoHarness([int index = 0, this.backend])
    : sample = copied(fixture['cases'][index]) {
    now = protocolTime(sample['now']);
  }
  final Map<String, dynamic> sample;
  late DateTime now;
  bool authorized = true, unlocked = true;
  final CryptoOperation Function(CryptoHarness)? backend;
  late final operation = backend?.call(this) ?? CryptoOperation(this);
  final timings = <String>[];
  late final authority = TbcOperationAuthority(
    context: sample['context'],
    account: TbcAccount(
      network:
          sample['account']['chainId'] == 'tbc:mainnet'
              ? TbcNetwork.mainnet
              : TbcNetwork.testnet,
      address: sample['account']['address'],
      publicKey: sample['account']['publicKey'],
    ),
    requireAuthorized:
        (m) => need(authorized && m == sample['method'], 'PERMISSION_REVOKED'),
    isUnlocked: () => unlocked,
    clock: () => now,
  );
  late final executor = TbcSigningExecutor(
    prepareMaterial:
        (r, a) async => throw StateError('Crypto must not read chain data'),
    authority: authority,
    signer: operation,
    engine: engine,
    timing: (stage, _) => timings.add(stage),
  );
  Future<Map<String, dynamic>> execute() =>
      executor.execute(sample['method'], sample['request']);
}

void main() {
  test('encryption limit uses decoded bytes in every encoding before approval', () async {
    for (final message in [
      {'encoding': 'utf8', 'data': '中' * 21846},
      {'encoding': 'utf8', 'data': '😀' * 16385},
      {'encoding': 'base64', 'data': base64Encode(List.filled(65537, 1))},
    ]) {
      final h = CryptoHarness();
      h.sample['request']['message'] = message;
      await expectLater(h.execute(), throwsStateError);
      expect(h.operation.consents, 0);
      expect(h.operation.cryptos, 0);
    }
    for (final message in [
      {'encoding': 'utf8', 'data': '中' * 21845 + 'a'},
      {'encoding': 'utf8', 'data': '😀' * 16384},
      {'encoding': 'utf8', 'data': 'a' * 65536},
      {'encoding': 'hex', 'data': '01' * 65536},
      {'encoding': 'base64', 'data': base64Encode(List.filled(65536, 1))},
    ]) {
      final request = copied(fixture['cases'][0]['request']);
      request['message'] = message;
      expect(() => checkCryptoRequest('tbc_encrypt', request), returnsNormally);
    }
  });
  test('historical large UTF-8 decrypt result remains a valid protocol result', () {
    final task = {'purpose': 'decrypt', 'algorithm': bie1Algorithm, 'taskId': 'old'};
    expect(() => checkCryptoResult(task, {
      'algorithm': bie1Algorithm, 'taskId': 'old',
      'message': {'encoding': 'utf8', 'data': '中' * 24000},
    }), returnsNormally);
  });
  setUpAll(() {
    expect(
      sha256
          .convert(File('test/fixtures/crypto-signing.json').readAsBytesSync())
          .toString(),
      '9373286892cfd6c82a93d7f5c8637f12015172b261e3463613058cb63a818bc3',
    );
    final library =
        (jsonDecode(
              File('test/fixtures/signing/replay.json').readAsStringSync(),
            )
            as Map)['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
    digestOnly.engine = engine;
  });
  for (var i = 0; i < (fixture['cases'] as List).length; i++) {
    test(
      'frozen ${fixture['cases'][i]['name']} exact plan/binding/task/result',
      () async {
        final h = CryptoHarness(i);
        expect(canonical(await h.execute()), canonical(h.sample['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(h.operation.cryptos, 1);
        expect(h.operation.closes, 1);
        expect(
          h.timings.where((s) => s == 'nativeCryptoRoundTrip'),
          hasLength(1),
        );
        expect(
          h.timings.where(
            (s) =>
                s == 'plan' ||
                s.startsWith('validate:') ||
                s == 'nativeSignerRoundTrip',
          ),
          isEmpty,
        );
        await expectLater(h.execute(), throwsStateError);
        expect(h.operation.cryptos, 1);
      },
    );
  }
  for (final invalid in fixture['invalid']) {
    test('${invalid['name']} fails before approval/crypto', () async {
      final h = CryptoHarness(invalid['method'] == 'tbc_encrypt' ? 0 : 1);
      h.sample['request'] = copied(invalid['request']);
      await expectLater(h.execute(), throwsA(isA<TbcInvalidCryptoRequest>()));
      expect(h.operation.consents, 0);
      expect(h.operation.binds, 0);
      expect(h.operation.cryptos, 0);
      expect(h.operation.closes, 1);
    });
  }
  test('rejection never binds/uses key', () async {
    final h = CryptoHarness()..operation.approved = false;
    await expectLater(h.execute(), throwsA(isA<TbcSigningRejected>()));
    expect(h.operation.binds, 0);
    expect(h.operation.cryptos, 0);
    expect(h.operation.closes, 1);
  });
  test('digest-only Vault cannot substitute signing for BIE1', () async {
    final h = digestOnly.Harness(fixture['cases'][0]);
    await expectLater(h.execute(), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.operation.binds, 0);
    expect(h.operation.signs, 0);
    expect(h.operation.closes, 1);
  });
  for (final boundary in ['grant', 'lock', 'native', 'expiry']) {
    for (final afterCrypto in [false, true]) {
      test(
        '$boundary ${afterCrypto ? 'after crypto suppresses delivery' : 'during consent prevents key use'}',
        () async {
          final h = CryptoHarness();
          void change() {
            switch (boundary) {
              case 'grant':
                h.authorized = false;
              case 'lock':
                h.unlocked = false;
              case 'native':
                h.operation.current = false;
              case 'expiry':
                h.now = h.now.add(const Duration(minutes: 5));
            }
          }

          if (afterCrypto) {
            h.operation.onCrypto = change;
          } else {
            h.operation.onConsent = change;
          }
          await expectLater(h.execute(), throwsStateError);
          expect(h.operation.cryptos, afterCrypto ? 1 : 0);
          expect(h.operation.closes, 1);
        },
      );
    }
  }
  for (final field in ['bindingHash', 'expiresAt']) {
    test('$field receipt mismatch fails before key use', () async {
      final h = CryptoHarness();
      h.operation.changeReceipt =
          (r) =>
              r[field] = field == 'bindingHash' ? '00' * 32 : r['approvedAt'];
      await expectLater(h.execute(), throwsStateError);
      expect(h.operation.cryptos, 0);
    });
  }
  for (final field in ['taskId', 'algorithm', 'ciphertext', 'extra']) {
    test('$field crypto result mismatch suppressed', () async {
      final h = CryptoHarness();
      h.operation.changeResult = (r) => r[field] = 'invalid';
      await expectLater(h.execute(), throwsStateError);
      expect(h.operation.cryptos, 1);
      expect(h.operation.closes, 1);
    });
  }
  test('decrypt output schema checked before release', () async {
    final h = CryptoHarness(1);
    h.operation.changeResult =
        (r) => r['message'] = {'encoding': 'base64', 'data': '!'};
    await expectLater(h.execute(), throwsStateError);
  });
  test('input mutation after consent cannot change task or result', () async {
    final h = CryptoHarness();
    h.operation.onConsent =
        () => h.sample['request']['message']['data'] = 'changed';
    expect(canonical(await h.execute()), canonical(h.sample['result']));
  });
  test('crypto protocol bounds include empty utf8/base64 but not hex', () {
    final r = copied(fixture['cases'][0]['request']);
    r['message'] = {'encoding': 'utf8', 'data': '😀' * 16384};
    checkCryptoRequest('tbc_encrypt', r);
    r['message']['data'] += 'x';
    expect(
      () => checkCryptoRequest('tbc_encrypt', r),
      throwsA(isA<TbcInvalidCryptoRequest>()),
    );
    r['message'] = {'encoding': 'base64', 'data': 'AB=='};
    checkCryptoRequest(
      'tbc_encrypt',
      r,
    ); // Frozen schema permits nonzero padding bits.
  });
}
