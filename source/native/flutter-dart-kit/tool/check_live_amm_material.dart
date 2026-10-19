// Read-only maintainer diagnosis: public chain inputs, no keys or dispatch.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/read_api.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';

Future<void> main(List<String> args) async {
  final captured = jsonDecode(await File(args[0]).readAsString());
  final plan = copied(captured['plan'] ?? captured);
  final accounts = jsonDecode(await File('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json').readAsString());
  final account = copied(accounts['accounts'][args[1]]);
  final now = DateTime.fromMillisecondsSinceEpoch(DateTime.now().millisecondsSinceEpoch, isUtc: true);
  plan['request']['constraints']['expiresAt'] = now.add(const Duration(minutes: 5)).toIso8601String();
  final network = TbcNetworkConfiguration.trustedCustom(network: TbcNetwork.testnet, apiOrigin: 'https://api.tbcdev.org', trustId: 'final-amm-readonly');
  final api = TbcReadApi(network);
  final file = File('/private/tmp/tbc-trusted-pool2-compute-20261015-b/target/aarch64-apple-darwin/release/libtbc_compute_native.dylib');
  final probe = ComputeProbe(DynamicLibrary.open(file.path));
  final replies = <String, Map<String, dynamic>>{}, result = <String, dynamic>{'signatures':0,'broadcasts':0,'librarySha256':sha256.convert(await file.readAsBytes()).toString()};
  Future<Map<String,dynamic>> read(String path) async { final d = await api.get(path); replies[path] = d; return d; }
  Map<String,dynamic> keyless(String method, Map<String,dynamic> input) => copied(jsonDecode(probe.call('keyless', method, jsonEncode(input))));
  try {
    final token = Tbc20MaterialReader(network: network, read: read, keyless: keyless);
    final snapshot = await AmmBusinessMaterialReader(network: network, read: read, readHistory: token.parent, rememberParent: token.rememberParent,
      funding: NativeMaterialReader(network: network, read: read), keyless: keyless).resolve(request: plan['request'], account: account, now: now, snapshotId: 'readonly-final-amm');
    final input = {'version':'1.0','request':plan['request'],'requestHash':hashJson(plan['request']), 'snapshot':snapshot,
      'policy':defaultTransactionPolicy(network:network,request:plan['request'],now:now,snapshot:snapshot)};
    result['input'] = input;
    result['result'] = jsonDecode(probe.call('engine','plan',jsonEncode(input)));
  } catch(e,s) { result['error'] = '$e'; result['stack'] = '$s'; }
  finally { api.close(); }
  result['replies'] = replies;
  final output = File(args[2]); need(!output.existsSync(), 'EVIDENCE_EXISTS');
  await output.writeAsString(jsonEncode(result));
  print(jsonEncode({'error':result['error'],'result':result['result']?['error'],'ok':result['result']?['ok'],'reads':replies.keys.toList(),'stack':result['stack']}));
}
