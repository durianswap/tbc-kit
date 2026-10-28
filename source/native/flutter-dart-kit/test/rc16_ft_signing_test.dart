import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'native_signing_test.dart' show FixtureOperation;

void main() {
  final fixture=copied(jsonDecode(File('test/fixtures/rc16-ft-signing.json').readAsStringSync()));
  late ComputeProbe engine;
  setUpAll(() {
    final path=Platform.environment['TBC_RC16_LIBRARY'];
    final expected=Platform.environment['TBC_RC16_LIBRARY_SHA256'];
    expect(path,isNotNull);expect(expected,matches(RegExp(r'^[a-f0-9]{64}$')));
    expect(sha256.convert(File(path!).readAsBytesSync()).toString(),expected);
    engine=ComputeProbe(DynamicLibrary.open(path));
  });
  final network=TbcNetworkConfiguration.official(TbcNetwork.testnet);
  for (final raw in fixture['cases']) {
    final s=copied(raw);
    test('${s['name']}: exact frozen reads/plan/signatures and one approval',() async {
      final paths=<String>[];
      final reader=Tbc20MaterialReader(network:network,read:(p) async {
        paths.add(p);expect(s['replies'].containsKey(p),true,reason:'Unexpected extra request');return copied(s['replies'][p]);
      },keyless:(m,p)=>copied(jsonDecode(engine.call('keyless',m,canonical(p)))));
      final prepared=Completer<void>();
      final op=FixtureOperation(s)..duringConsent=() async {
        // Preparation starts before the one approval. Do not turn into serial
        // read-after-approval simply to make the fixture easier to pass.
        await prepared.future;
      };
      final executor=TbcSigningExecutor(engine:engine,signer:op,
        authority:TbcOperationAuthority(context:s['context'],
          account:TbcAccount(network:TbcNetwork.testnet,address:s['account']['address'],publicKey:s['account']['publicKey']),
          requireAuthorized:(_){},isUnlocked:()=>true,clock:()=>protocolTime(s['now'])),
        prepareMaterial:(request,account) async {
          try {
            final snapshot=await reader.resolve(request:request,account:account,now:protocolTime(s['now']),snapshotId:s['snapshotId']);
            expect(canonical(snapshot),canonical(s['audit']['material']['snapshot']));
            final policy=defaultTransactionPolicy(network:network,request:request,snapshot:snapshot,now:protocolTime(s['now']));
            expect(canonical(policy),canonical(s['audit']['material']['policy']));
            return {'snapshot':snapshot,'policy':policy};
          } finally {prepared.complete();}
        });
      final result=await executor.execute('tbc_signTransaction',s['request']);
      expect(canonical(result),canonical(s['result']));
      expect(paths,unorderedEquals(s['trace']));expect(paths.toSet().length,paths.length);
      expect(op.consents,1);expect(op.binds,1);expect(op.advances,s['audit']['stages'].length-1);
      expect(op.signs,s['audit']['signatures'].length);expect(op.closes,1);
    });
  }
}
