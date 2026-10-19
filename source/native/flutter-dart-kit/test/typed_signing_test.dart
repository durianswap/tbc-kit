import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/typed_signing.dart';
import 'signing_executor_test.dart' as replay;

void main() {
  final fixture =
      jsonDecode(File('test/fixtures/typed-signing.json').readAsStringSync())
          as Map;
  final cases = fixture['cases'] as List;
  replay.Harness sample([int index = 0]) => replay.Harness(cases[index]);
  setUpAll(() {
    final source =
        jsonDecode(File('test/fixtures/signing/replay.json').readAsStringSync())
            as Map;
    final library = source['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    replay.engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  for (var i = 0; i < cases.length; i++) {
    test(
      'frozen typed ${cases[i]['name']} exact envelope, binding, task, payload and signature',
      () async {
        final h = sample(i);
        final result = await h.execute();
        expect(canonical(result), canonical(cases[i]['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(h.operation.signs, 1);
        expect(h.operation.closes, 1);
        expect(h.materialReads, 0);
        expect(h.timings['messageVerify'], hasLength(1));
        expect(
          h.timings.keys.any((k) => k.startsWith('validate:') || k == 'plan'),
          false,
        );
      },
    );
  }
  for (final invalid in fixture['invalid'] as List) {
    test(
      'typed ${invalid['name']} rejected before approval/signing/reads',
      () async {
        final h = sample();
        h.sample['request'] = copied(invalid['request']);
        await expectLater(h.execute(), throwsA(isA<StateError>()));
        expect(h.operation.consents, 0);
        expect(h.operation.binds, 0);
        expect(h.operation.signs, 0);
        expect(h.operation.closes, 1);
        expect(h.materialReads, 0);
      },
    );
  }
  test(
    'portable field comparison matches frozen English ASCII-name corpus',
    () {
      final names = (fixture['sort']['input'] as List).cast<String>();
      final sorted = [...names]..sort(typedFieldNameCompare);
      expect(sorted, fixture['sort']['expected']);
    },
  );
  test('typed helper produces detached immutable material', () {
    final request = copied(cases[0]['request']);
    final e = typedDataEnvelope(request, cases[0]['context']['origin']);
    request['data']['message']['amount'] = '999';
    expect(
      e['message']['amount'],
      cases[0]['request']['data']['message']['amount'],
    );
    expect(() => e['domain']['name'] = 'changed', throwsUnsupportedError);
  });
  test(
    'reject consent leaves no signature, material lookup or binding',
    () async {
      final h = sample();
      h.operation.approved = false;
      await expectLater(h.execute(), throwsA(isA<TbcSigningRejected>()));
      expect(h.operation.consents, 1);
      expect(h.operation.binds, 0);
      expect(h.operation.signs, 0);
      expect(h.materialReads, 0);
    },
  );
  test('typed permission revoked during consent cannot use key', () async {
    final h = sample();
    h.operation.duringConsent = () async {
      h.authorized = false;
    };
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.binds, 0);
    expect(h.operation.signs, 0);
  });
  test(
    'native navigation cancellation during consent cannot use key',
    () async {
      final h = sample();
      h.operation.duringConsent = () async {
        h.operation.nativeCurrent = false;
      };
      await expectLater(h.execute(), throwsA(isA<StateError>()));
      expect(h.operation.binds, 0);
      expect(h.operation.signs, 0);
    },
  );
  test('lock after binding cannot use key', () async {
    final h = sample();
    h.operation.duringBind = () {
      h.unlocked = false;
    };
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.binds, 1);
    expect(h.operation.signs, 0);
  });
  test('expired receipt cannot use key', () async {
    final h = sample();
    h.operation.alterReceipt = (r) {
      r['expiresAt'] = r['approvedAt'];
    };
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.signs, 0);
  });
  test('mismatched receipt cannot use key', () async {
    final h = sample();
    h.operation.alterReceipt = (r) {
      r['bindingHash'] = '00' * 32;
    };
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.signs, 0);
  });
  test('changed recoverable signature rejected rather than returned', () async {
    final h = sample();
    h.operation.alterSignature = (s) {
      final signature = s['signature'] as String;
      s['signature'] = '${signature.substring(0, signature.length - 2)}00';
    };
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.signs, 1);
  });
  test(
    'ordinary-message task cannot be substituted into typed signing',
    () async {
      final h = sample();
      h.operation.alterSignature = (s) {
        s['taskId'] = 'sign-message';
      };
      await expectLater(h.execute(), throwsA(isA<StateError>()));
      expect(h.operation.signs, 1);
    },
  );
  test('request mutation during consent cannot alter signed content', () async {
    final h = sample();
    h.operation.duringConsent = () async {
      h.sample['request']['data']['message']['amount'] = '999';
    };
    expect(canonical(await h.execute()), canonical(cases[0]['result']));
  });
  test('result-size limit enforced before consent', () async {
    final h = sample();
    h.sample['request']['data']['message'] = {'large': 'x' * 65536};
    await expectLater(h.execute(), throwsA(isA<StateError>()));
    expect(h.operation.consents, 0);
    expect(h.operation.signs, 0);
  });
}
