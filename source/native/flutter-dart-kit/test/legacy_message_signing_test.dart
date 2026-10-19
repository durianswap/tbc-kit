// Shared production executor, not a Legacy execution implementation. Replays
// the current frozen Core's public fixture signatures with local verification.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'signing_executor_test.dart' as single;
import 'workflow_execution_test.dart' as batch;

void main() {
  final data = jsonDecode(
    File('test/fixtures/legacy-message-signing.json').readAsStringSync(),
  );
  setUpAll(() {
    final build = jsonDecode(
      File(
        '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json',
      ).readAsStringSync(),
    );
    final lib = (build['builds'] as List).singleWhere(
      (v) => v['target'] == 'aarch64-apple-darwin',
    );
    expect(
      lib['sha256'],
      '413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db',
    );
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    single.engine = ComputeProbe(DynamicLibrary.open(lib['path']));
    batch.native = single.engine;
    batch.planning = {'cases': data['workflows']};
    batch.signing = {
      'cases': [for (final s in data['workflows']) s['expected']],
    };
  });
  for (final s in data['singles']) {
    test(
      'Legacy ${s['name']} uses shared consent, binding, task verification and exact result',
      () async {
        final h = single.Harness(
          s,
          messageProfile: MessageSigningProfile.legacyBitcoin,
        );
        expect(canonical(await h.execute()), canonical(s['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.signs, 1);
        expect(h.materialReads, 0);
        expect(h.operation.closes, 1);
      },
    );
  }
  for (final s in data['workflows']) {
    test(
      'Legacy ${s['name']} preserves one batch consent and deferred dependency binding',
      () async {
        final h = batch.Harness(
          s['name'],
          messageProfile: MessageSigningProfile.legacyBitcoin,
        );
        expect(canonical(await h.run()), canonical(s['expected']['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(h.operation.closes, 1);
        expect(h.operation.signs, s['expected']['signed'].length);
        expect(h.preparations, s['materials'].length);
        expect(h.reads, 0);
      },
    );
  }
  test(
    'page marker cannot select Bitcoin framing through Standard execution',
    () async {
      final s = copied(data['singles'][0]);
      s['request'] = s['referenceRequest'];
      final h = single.Harness(s);
      await expectLater(h.execute(), throwsA(anything));
      expect(h.operation.signs, 0);
      expect(h.operation.binds, 0);
    },
  );
  test(
    'Legacy framing does not bypass reserved Sign-In context validation',
    () async {
      final s = copied(data['singles'][0]);
      s['request']['message'] = {
        'encoding': 'utf8',
        'data': 'evil.example wants you to sign in',
      };
      final h = single.Harness(
        s,
        messageProfile: MessageSigningProfile.legacyBitcoin,
      );
      await expectLater(
        h.execute(),
        throwsA(
          predicate(
            (e) => e.toString().contains('SIGN_IN_PROFILE_NOT_INSTALLED'),
          ),
        ),
      );
      expect(h.operation.signs, 0);
    },
  );
}
