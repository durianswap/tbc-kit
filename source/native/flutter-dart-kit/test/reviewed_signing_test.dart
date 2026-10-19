import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';

late ComputeProbe engine;
late List<Map> samples;
final sources = <String, List>{};
Map<String, dynamic> keyless(String method, Map<String, dynamic> args) =>
    copied(jsonDecode(engine.call('keyless', method, canonical(args))));

final class Harness {
  Harness(Map value) : sample = copied(value) {
    now = protocolTime(sample['now']);
    source = sources[sample['source']['file']]!.singleWhere(
      (s) => s['name'] == sample['source']['name'],
    );
  }
  final Map<String, dynamic> sample;
  late final Map source;
  late DateTime now;
  bool authorized = true, unlocked = true, prepared = false;
  int preparations = 0, reads = 0;
  Future<void> Function()? duringPrepare;
  late final operation = ReplayOperation(this);
  late final authority = TbcOperationAuthority(
    context: sample['context'],
    account: TbcAccount(
      network: TbcNetwork.testnet,
      address: sample['account']['address'],
      publicKey: sample['account']['publicKey'],
    ),
    requireAuthorized:
        (m) => need(authorized && m == sample['method'], 'REVOKED'),
    isUnlocked: () => unlocked,
    clock: () => now,
  );
  late final executor = TbcSigningExecutor(
    prepareMaterial: (_, __) async => throw StateError('No builder fallback'),
    prepareReviewed: (request, account, current) async {
      preparations++;
      await duringPrepare?.call();
      current();
      final result = await ReviewedTransactionReviewer(
        chainId: 'tbc:testnet',
        keyless: keyless,
        now: () => now,
        read: (p) async {
          reads++;
          expect(source['replies'].containsKey(p), true);
          return copied(source['replies'][p]);
        },
        readHistory: (_) async => throw StateError('No hidden history read'),
        status: (points) async {
          reads++;
          return {
            'txos': [
              for (final p in points)
                copied(
                  (source['statuses'] as List).singleWhere(
                    (u) =>
                        u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                  ),
                ),
            ],
          };
        },
      ).review(request: request, account: account, requireCurrent: current);
      prepared = true;
      return result;
    },
    authority: authority,
    engine: engine,
    signer: operation,
  );
  Future<Map<String, dynamic>> execute([Map? request]) =>
      executor.execute(sample['method'], request ?? sample['request']);
}

// Independent source parity, not native-custody evidence. The native route
// remains disabled. Replay only known public signatures after exact tasks.
final class ReplayOperation implements TbcSigningOperation {
  ReplayOperation(this.h);
  final Harness h;
  int consents = 0,
      binds = 0,
      signs = 0,
      advances = 0,
      closes = 0,
      stage = 0,
      row = 0;
  bool approve = true, current = true;
  void Function()? duringConsent, duringAdvance, duringSign;
  void Function(Map)? alterReceipt, alterSignature;
  int? readsAtConsent;
  Map get audit => h.sample['audit'];
  Map get expectedStage => h.source['stages'][stage];
  @override
  Future<void> requireCurrent() async => need(current, 'NATIVE_REVOKED');
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) async {
    consents++;
    readsAtConsent = h.reads;
    expect(
      h.prepared,
      true,
    ); // No blind raw-byte approval before effects are authenticated.
    expect(canonical(i.request), canonical(h.sample['request']));
    expect(canonical(i.context), canonical(h.sample['context']));
    expect(canonical(i.review), canonical(h.source['review']));
    expect(i.toString(), isNot(contains('sourceTransaction')));
    duringConsent?.call();
    return approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    binds++;
    expect(canonical(m.binding), canonical(audit['binding']));
    expect(canonical(m.plan), canonical(audit['plan']));
    expect(canonical(m.preview), canonical(audit['preview']));
    expect(m.envelope, isNull);
    expect(canonical(m.reviewed?['material']), canonical(h.source['material']));
    expect(canonical(m.reviewed?['stage']), canonical(expectedStage['stage']));
    expect(
      () => m.reviewed!['material']['request'] = {},
      throwsUnsupportedError,
    );
    final result = copied(audit['approval']);
    alterReceipt?.call(result);
    return TbcSigningReceipt(result);
  }

  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) async {
    advances++;
    expect(canonical(r.wire), canonical(audit['approval']));
    expect(row, (expectedStage['signatures'] as List).length);
    stage++;
    row = 0;
    expect(c.wire['kind'], 'reviewed');
    expect(c.wire['stageIndex'], stage);
    expect(c.wire['planHash'], audit['plan']['planHash']);
    expect(canonical(c.wire['stage']), canonical(expectedStage['stage']));
    expect(c.wire['previousTransactions'], [
      for (var i = 0; i < stage; i++)
        h.source['stages'][i]['finalized']['txraw'],
    ]);
    expect(h.reads, readsAtConsent);
    duringAdvance?.call();
  }

  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) async {
    signs++;
    expect(canonical(r.wire), canonical(audit['approval']));
    final index = expectedStage['stage']['signingInputIndexes'][row];
    expect(t.taskId, 'review-single-tx-$stage-input-$index');
    expect(t.digest, expectedStage['stage']['digests'][row]);
    expect(t.wire['sighashType'], 65);
    expect(t.accountId, h.sample['account']['accountId']);
    expect(t.publicKey, h.sample['account']['publicKey']);
    expect(h.reads, readsAtConsent);
    final result = {
      'taskId': t.taskId,
      'signatureEncoding': 'compact64',
      'signature': expectedStage['signatures'][row++],
    };
    alterSignature?.call(result);
    duringSign?.call();
    return TbcTaskSignature(
      taskId: result['taskId'],
      signatureEncoding: result['signatureEncoding'],
      signature: result['signature'],
    );
  }

  @override
  Future<void> close() async {
    closes++;
    current = false;
  }
}

void main() {
  setUpAll(() {
    samples =
        (jsonDecode(
                  File(
                    'test/fixtures/reviewed-signing.json',
                  ).readAsStringSync(),
                )['cases']
                as List)
            .cast<Map>();
    for (final s in samples)
      sources.putIfAbsent(
        s['source']['file'],
        () =>
            jsonDecode(
              File('test/fixtures/${s['source']['file']}').readAsStringSync(),
            )['cases'],
      );
    final lib =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  for (var index = 0; index < 7; index++) {
    test(
      'Reviewed shared executor $index exact frozen Core binding/result, one approval and no stage reads',
      () async {
        final h = Harness(samples[index]), result = await h.execute();
        expect(canonical(result), canonical(h.sample['result']));
        expect(h.preparations, 1);
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(
          h.operation.signs,
          (h.source['stages'] as List).fold<int>(
            0,
            (sum, s) => sum + (s['signatures'] as List).length,
          ),
        );
        expect(h.operation.advances, (h.source['stages'] as List).length - 1);
        expect(h.operation.closes, 1);
        await expectLater(h.execute(), throwsStateError);
        expect(h.operation.closes, 1);
      },
    );
  }
  test(
    'Reviewed rejection closes operation without binding or signature',
    () async {
      final h = Harness(samples.first);
      h.operation.approve = false;
      await expectLater(h.execute(), throwsA(isA<TbcSigningRejected>()));
      expect(h.operation.consents, 1);
      expect(h.operation.binds, 0);
      expect(h.operation.signs, 0);
      expect(h.operation.closes, 1);
    },
  );
  test('Revocation during reads never offers an approval', () async {
    final h = Harness(samples.first);
    h.duringPrepare = () async {
      h.authorized = false;
    };
    await expectLater(h.execute(), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.operation.signs, 0);
  });
  test(
    'Reviewed rejects unbounded delay and revocation after consent',
    () async {
      for (final expiry in [true, false]) {
        final h = Harness(samples.first);
        h.operation.duringConsent = () {
          if (expiry) {
            h.now = h.now.add(const Duration(minutes: 3));
          } else {
            h.authorized = false;
          }
        };
        await expectLater(h.execute(), throwsStateError);
        expect(h.operation.binds, 0);
        expect(h.operation.signs, 0);
      }
    },
  );
  test('Wrong receipt cannot authorize any digest', () async {
    final h = Harness(samples.first);
    h.operation.alterReceipt = (r) => r['bindingHash'] = '00' * 32;
    await expectLater(h.execute(), throwsStateError);
    expect(h.operation.signs, 0);
  });
  test(
    'Bad signature fails frozen Rust finalization before any child',
    () async {
      final h = Harness(samples[2]);
      h.operation.alterSignature = (r) => r['signature'] = '01' * 64;
      await expectLater(h.execute(), throwsStateError);
      expect(h.operation.advances, 0);
    },
  );
  test('Account lock between reviewed stages stops child signing', () async {
    final h = Harness(samples[2]);
    h.operation.duringAdvance = () => h.unlocked = false;
    await expectLater(h.execute(), throwsStateError);
    expect(
      h.operation.signs,
      (h.source['stages'][0]['signatures'] as List).length,
    );
  });
  test('Revocation after actual sign suppresses the result', () async {
    final h = Harness(samples.first);
    h.operation.duringSign = () => h.operation.current = false;
    await expectLater(h.execute(), throwsStateError);
    expect(h.operation.closes, 1);
  });
  test('Reviewed max fee is enforced before offering consent', () async {
    final h = Harness(samples.first), request = copied(h.sample['request']);
    request['maxFee'] = '0';
    await expectLater(h.execute(request), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.operation.signs, 0);
  });
  test(
    'Reviewed extra fields and excluded signing roles fail before reads',
    () async {
      for (final field in ['signingRoles', 'preview', 'endpoint']) {
        final h = Harness(samples.first), request = copied(h.sample['request']);
        request[field] = {};
        await expectLater(h.execute(request), throwsStateError);
        expect(h.preparations, 0);
        expect(h.operation.signs, 0);
      }
    },
  );
}
