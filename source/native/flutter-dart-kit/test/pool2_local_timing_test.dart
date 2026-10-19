// Opt-in local CPU isolation: frozen public fixtures, no HTTP or private keys.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/unified_pool_material.dart';
import 'native_signing_test.dart' show FixtureOperation;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  test('Pool2 matched offline Engine timing', () async {
    final samples=(jsonDecode(File('test/fixtures/unified-pool-signing.json').readAsStringSync())['cases'] as List).map((s)=>copied(s)).toList();
    final indexed=IndexedFixture(samples), network=TbcNetworkConfiguration.official(TbcNetwork.testnet);
    final libraries={
      'baseline':Platform.environment['TBC_BASELINE_LIBRARY']!,
      'candidate':trustedIndexCandidateLibrary()['path'] as String,
    };
    final probes={for(final e in libraries.entries)e.key:ComputeProbe(DynamicLibrary.open(e.value))};
    final rows=<Map<String,dynamic>>[];
    for(final operation in ['buy','sell','add','remove']) {
      final s=copied(samples.firstWhere((s)=>s['name']=='unified-pool2-$operation'));
      indexed.enrich(s);
      Future<Map<String,dynamic>> read(String p)async {expect(s['replies'].containsKey(p),true);return copied(s['replies'][p]);}
      final token=Tbc20MaterialReader(network:network,read:read,keyless:indexed.call);
      final prepared=await UnifiedPoolMaterialReader(network:network,read:read,readHistory:token.parent,rememberParent:token.rememberParent,keyless:indexed.call).resolve(
        request:s['request'],account:s['account'],now:protocolTime(s['now']),snapshotId:s['snapshotId']);
      final material={
        'baseline':copied(s['audit']['material']),
        'candidate':{'snapshot':prepared.snapshot,'policy':prepared.policy(request:s['request'],network:network)},
      };
      // One warmup per library, followed by ten interleaved measured executions.
      for(var iteration=0;iteration<=10;iteration++) {
        for(final mode in iteration.isEven?['baseline','candidate']:['candidate','baseline']) {
          final stages=<String,int>{},op=FixtureOperation(s),timer=Stopwatch()..start();
          final result=await TbcSigningExecutor(
            engine:probes[mode]!,signer:op,
            authority:TbcOperationAuthority(context:s['context'],account:TbcAccount(network:TbcNetwork.testnet,address:s['account']['address'],publicKey:s['account']['publicKey']),requireAuthorized:(_){},isUnlocked:()=>true,clock:()=>protocolTime(s['now'])),
            prepareMaterial:(_,__)async=>copied(material[mode]!),
            timing:(stage,us)=>stages.update(stage,(value)=>value+us,ifAbsent:()=>us),
          ).execute(s['method'],s['request']);
          final elapsed=timer.elapsedMicroseconds;
          expect(canonical(result['transactions']),canonical(s['result']['transactions']));
          expect(op.consents,1);expect(op.binds,1);
          if(iteration>0)rows.add({'operation':operation,'mode':mode,'iteration':iteration,'elapsedUs':elapsed,'stagesUs':stages});
        }
      }
    }
    final output=File(Platform.environment['TBC_POOL2_TIMING_OUTPUT']!);
    if(output.existsSync())throw StateError('Immutable timing output exists');
    await output.writeAsString(jsonEncode({'scope':'Offline same executor; fixed public signatures; isolates Engine and local checks, not device speed','libraries':libraries,'rows':rows}));
  },skip:Platform.environment['TBC_POOL2_TIMING_OUTPUT']==null);
}
