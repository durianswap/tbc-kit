import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';

// Offline replay of signatures already produced on the two P5 devices using a
// public synthetic fixture. This test does not invoke a Vault or produce new
// signatures; real Rust Engine verification still checks returned transactions.
late Map<String, dynamic> fixture;
late ComputeProbe engine;

final class ReplayOperation implements TbcSigningOperation {
  ReplayOperation(this.harness);
  final Harness harness;
  int checks = 0, consents = 0, binds = 0, signs = 0, closes = 0;
  bool nativeCurrent = true, approved = true;
  Future<void> Function()? duringConsent;
  void Function()? duringBind;
  void Function(Map<String, dynamic>)? alterReceipt;
  void Function(Map<String, dynamic>)? alterSignature;
  Map<String, dynamic> get audit => harness.sample['audit'];

  @override
  Future<void> requireCurrent() async {
    checks++;
    need(nativeCurrent, 'TEST_NATIVE_REVOKED');
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async {
    consents++;
    expect(canonical(intent.request), canonical(harness.sample['request']));
    expect(canonical(intent.context), canonical(harness.sample['context']));
    expect(intent.toString(), 'TbcBoundedSigningIntent(redacted)');
    expect(() => intent.request['from'] = 'changed', throwsUnsupportedError);
    await duringConsent?.call();
    harness.now = protocolTime(audit['approval']['approvedAt']);
    return approved;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) async {
    binds++;
    expect(canonical(material.binding), canonical(audit['binding']));
    expect(canonical(material.preview), canonical(audit['preview']));
    expect(canonical(material.plan), canonical(audit['plan']));
    if (audit.containsKey('envelope')) {
      expect(canonical(material.envelope), canonical(audit['envelope']));
    }
    expect(material.toString(), 'TbcSigningMaterial(redacted)');
    expect(
      () => material.binding['payload']['expiresAt'] = 'changed',
      throwsUnsupportedError,
    );
    duringBind?.call();
    final receipt = copied(audit['approval']);
    alterReceipt?.call(receipt);
    return TbcSigningReceipt(receipt);
  }

  @override
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    throw StateError('Single-stage replay must not advance');
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt receipt,
    TbcSigningTask task,
  ) async {
    expect(canonical(receipt.wire), canonical(audit['approval']));
    expect(receipt.toString(), 'TbcSigningReceipt(redacted)');
    expect(task.toString(), 'TbcSigningTask(redacted)');
    if (audit['plan'] != null) {
      expect(
        canonical(task.wire),
        canonical(audit['plan']['payload']['signingTasks'][signs]),
      );
    } else if (audit.containsKey('tasks')) {
      expect(canonical(task.wire), canonical(audit['tasks'][signs]));
    }
    final result = copied(audit['signatures'][signs++]);
    alterSignature?.call(result);
    return TbcTaskSignature(
      taskId: result['taskId'],
      signatureEncoding: result['signatureEncoding'],
      signature: result['signature'],
    );
  }

  @override
  Future<void> close() async {
    closes++;
    nativeCurrent = false;
  }
}

final class Harness {
  Harness(Map value, {this.messageProfile = MessageSigningProfile.standard})
    : sample = copied(value) {
    now = protocolTime(
      sample['audit']['binding']['payload']['expiresAt'],
    ).subtract(const Duration(minutes: 5));
  }
  final Map<String, dynamic> sample;
  final MessageSigningProfile messageProfile;
  late DateTime now;
  bool authorized = true, unlocked = true;
  int materialReads = 0;
  Future<void> Function()? duringPrepare;
  void Function()? duringTiming;
  final timings = <String, List<int>>{};
  late final operation = ReplayOperation(this);
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
    requireAuthorized: (method) {
      need(authorized && method == sample['method'], 'TEST_PERMISSION_REVOKED');
    },
    isUnlocked: () => unlocked,
    clock: () => now,
  );
  late final executor = TbcSigningExecutor(
    messageProfile: messageProfile,
    prepareMaterial: (request, account) async {
      materialReads++;
      await duringPrepare?.call();
      final material = copied(sample['audit']['material']);
      final captured = protocolTime(
        material['snapshot']['payload']['capturedAt'],
      );
      if (captured.isAfter(now)) now = captured;
      return material;
    },
    authority: authority,
    engine: engine,
    signer: operation,
    timing: (stage, us) {
      duringTiming?.call();
      (timings[stage] ??= []).add(us);
    },
  );
  Future<Map<String, dynamic>> execute() =>
      executor.execute(sample['method'], sample['request']);
}

void main() {
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/signing/replay.json').readAsStringSync(),
    );
    final library = fixture['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });

  for (final platform in ['android', 'ios']) {
    for (final method in ['tbc_signMessage', 'tbc_signTransaction']) {
      test(
        '$platform recorded $method output/task/fee parity through extracted executor',
        () async {
          final sample =
              (fixture['cases'] as List).singleWhere(
                    (c) => c['name'] == '$platform-$method',
                  )
                  as Map;
          final h = Harness(sample);
          final result = await h.execute();
          expect(canonical(result), canonical(sample['result']));
          expect(h.operation.consents, 1);
          expect(h.operation.binds, 1);
          expect(h.operation.signs, method == 'tbc_signTransaction' ? 2 : 1);
          expect(h.materialReads, method == 'tbc_signTransaction' ? 1 : 0);
          expect(h.operation.closes, 1);
          if (method == 'tbc_signTransaction') {
            for (final phase in [
              'validate:plan',
              'validate:pre-sign',
              'validate:finalized',
            ]) {
              expect(h.timings[phase], hasLength(1));
            }
            expect(result['totalFee'], sample['result']['totalFee']);
          } else {
            expect(h.timings['messageVerify'], hasLength(1));
          }
          await expectLater(h.execute(), throwsA(isA<StateError>()));
          expect(h.operation.closes, 1);
        },
      );
    }
  }

  Harness transaction() => Harness(
    (fixture['cases'] as List).singleWhere(
      (c) => c['name'] == 'android-tbc_signTransaction',
    ),
  );
  Harness message() => Harness(
    (fixture['cases'] as List).singleWhere(
      (c) => c['name'] == 'android-tbc_signMessage',
    ),
  );

  test('optional timing consumer cannot change the signed result', () async {
    final h = transaction();
    h.duringTiming = () => throw StateError('Diagnostic sink unavailable');
    expect(canonical(await h.execute()), canonical(h.sample['result']));
    expect(h.operation.consents, 1);
  });

  test('one consent overlaps the single shared material preparation', () async {
    final h = transaction(),
        preparing = Completer<void>(),
        consent = Completer<void>(),
        release = Completer<void>();
    h.duringPrepare = () {
      preparing.complete();
      return release.future;
    };
    h.operation.duringConsent = () async {
      expect(preparing.isCompleted, true);
      consent.complete();
    };
    final pending = h.execute();
    await consent.future;
    expect(h.materialReads, 1);
    expect(h.operation.binds, 0);
    release.complete();
    await pending;
    expect(
      [
        h.materialReads,
        h.operation.consents,
        h.operation.binds,
        h.operation.signs,
      ],
      [1, 1, 1, 2],
    );
  });

  test(
    'missing grant stops before native consent, material or signing',
    () async {
      final h = transaction()..authorized = false;
      await expectLater(h.execute(), throwsA(isA<StateError>()));
      expect(
        [
          h.materialReads,
          h.operation.consents,
          h.operation.binds,
          h.operation.signs,
          h.operation.closes,
        ],
        [0, 0, 0, 0, 1],
      );
    },
  );

  test(
    'native revocation and consent rejection never reach binding or signing',
    () async {
      for (final revoked in [true, false]) {
        final h = transaction();
        if (revoked) {
          h.operation.nativeCurrent = false;
        } else {
          h.operation.approved = false;
        }
        await expectLater(
          h.execute(),
          throwsA(revoked ? isA<StateError>() : isA<TbcSigningRejected>()),
        );
        expect(
          [h.operation.binds, h.operation.signs, h.operation.closes],
          [0, 0, 1],
        );
      }
    },
  );

  test(
    'grant invalidation during concurrent preparation rejects before binding',
    () async {
      final h = transaction();
      h.operation.duringConsent = () async {
        h.authorized = false;
      };
      await expectLater(h.execute(), throwsA(isA<StateError>()));
      expect(
        [h.operation.binds, h.operation.signs, h.operation.closes],
        [0, 0, 1],
      );
    },
  );

  test('locked account and changed receipt cannot reach a signature', () async {
    for (final locked in [true, false]) {
      final h = transaction();
      if (locked) {
        h.unlocked = false;
      } else {
        h.operation.alterReceipt = (r) {
          r['bindingHash'] = '0' * 64;
        };
      }
      await expectLater(h.execute(), throwsA(isA<StateError>()));
      expect(h.operation.signs, 0);
      expect(h.operation.closes, 1);
    }
  });

  test(
    'expiry after binding and altered signature never return a signed result',
    () async {
      final expired = transaction();
      expired.operation.duringBind = () {
        expired.now = protocolTime(
          expired.sample['audit']['binding']['payload']['expiresAt'],
        );
      };
      await expectLater(expired.execute(), throwsA(isA<StateError>()));
      expect(expired.operation.signs, 0);
      for (final h in [message(), transaction()]) {
        h.operation.alterSignature = (sig) {
          sig['signature'] =
              '00' *
              (sig['signatureEncoding'] == 'compact65-recoverable' ? 65 : 64);
        };
        await expectLater(h.execute(), throwsA(isA<StateError>()));
        expect(h.operation.closes, 1);
      }
    },
  );
}
