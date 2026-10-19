// Local migration gate, not a public package API or a chain acceptance run.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';

Future<void> main() async {
  final prior = Directory('../flutter-dart-live-token-exploration');
  final baseline =
      jsonDecode(
            await File(
              '${prior.path}/evidence/preflight-20261012/baseline.json',
            ).readAsString(),
          )
          as Map;
  final capture =
      jsonDecode(
            await File(
              '${prior.path}/evidence/live-readonly-20261012-a/capture.json',
            ).readAsString(),
          )
          as Map;
  final library = baseline['library'] as Map;
  need(
    sha256.convert(await File(library['path']).readAsBytes()).toString() ==
        library['sha256'],
    'NATIVE_HASH',
  );
  final engine = ComputeProbe(DynamicLibrary.open(library['path']));
  final oldPlan =
      (capture['captures'] as List).firstWhere((r) => r['method'] == 'plan')
          as Map;
  final reads = <String>[];
  Future<Map<String, dynamic>> read(String path) async {
    reads.add(path);
    final response = capture['responses'][path];
    need(response != null, 'EXTRA_GET:$path');
    need(response['status'] == 200, 'FIXTURE_HTTP');
    final data = jsonDecode(response['body']);
    need('${data['code']}' == '200', 'FIXTURE_ENVELOPE');
    return Map<String, dynamic>.from(data['data']);
  }

  final reader = Tbc20MaterialReader(
    network: TbcNetworkConfiguration.trustedCustom(
      network: TbcNetwork.testnet,
      apiOrigin: capture['origin'],
      trustId: 'p5-material-replay',
    ),
    read: read,
    keyless:
        (method, input) => Map<String, dynamic>.from(
          jsonDecode(engine.call('keyless', method, jsonEncode(input))),
        ),
  );
  final request = copied(capture['request']),
      account = copied(capture['account']);
  final old = oldPlan['input']['snapshot'] as Map;
  Future<Map<String, dynamic>> resolve() => reader.resolve(
    request: request,
    account: account,
    now: DateTime.parse(old['payload']['capturedAt']),
    snapshotId: old['payload']['snapshotId'],
  );
  final cold = await resolve(), coldGets = reads.length;
  need(canonical(cold) == canonical(old), 'MATERIAL_CHANGED');
  final warm = await resolve(), warmGets = reads.length - coldGets;
  need(canonical(warm) == canonical(cold), 'CACHE_CHANGED');
  need(coldGets == 7 && warmGets == 3, 'READ_COUNT');
  final input = copied(oldPlan['input'])..['snapshot'] = cold;
  final planned = jsonDecode(engine.call('engine', 'plan', jsonEncode(input)));
  need(
    planned['ok'] == true &&
        canonical(planned['result']) == canonical(oldPlan['result']),
    'PLAN_PARITY',
  );
  final validated = jsonDecode(
    engine.call(
      'engine',
      'validate',
      jsonEncode({
        ...input,
        'phase': 'plan',
        'plan': planned['result']['plan'],
      }),
    ),
  );
  need(
    validated['ok'] == true && validated['result']['valid'] == true,
    'VALIDATION',
  );
  final report = {
    'status': 'F1_EXTRACTED_TBC20_MATERIAL_PARITY_PASS',
    'recordedAt': DateTime.now().toUtc().toIso8601String(),
    'kitVersion': baseline['kit']['identity']['version'],
    'nativeSha256': library['sha256'],
    'snapshotExact': true,
    'planExact': true,
    'necessaryPlanValidation': true,
    'coldGets': coldGets,
    'warmGets': warmGets,
    'fee': planned['result']['plan']['payload']['preview']['totalFee'],
    'signingTasks':
        (planned['result']['plan']['payload']['signingTasks'] as List).length,
    'networkHttp': 0,
    'signatures': 0,
    'broadcasts': 0,
    'proofLimit':
        'Recorded P5 Testnet material replay, not new device or live-chain acceptance of the candidate package.',
  };
  await Directory('evidence').create(recursive: true);
  final output = File('evidence/f1-material-parity.json');
  need(!output.existsSync(), 'EVIDENCE_EXISTS');
  await output.writeAsString(
    '${const JsonEncoder.withIndent('  ').convert(report)}\n',
  );
  stdout.writeln(jsonEncode(report));
}
