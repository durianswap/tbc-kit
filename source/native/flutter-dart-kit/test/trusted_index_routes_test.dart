// Changed read plans against immutable, independently captured signed outputs.
// Enrich old captures with the API's already-supported Code/Tape fields from
// their frozen raw transactions. Never rewrite a frozen oracle or use live keys.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/pool2_material.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'amm_controller_signing_test.dart' show RoleFixtureOperation;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main(){
  final files=['amm-business-signing','lp-signing','lop-signing','htlc-token-signing','htlc-native-signing','nft-mint-signing','creation-signing','unified-pool-signing'];
  final samples=<Map<String,dynamic>>[];
  for(final file in files){
    final data=jsonDecode(File('test/fixtures/$file.json').readAsStringSync());
    for(final s in data['cases']){
      if(s['audit']!=null && s['result']?['transactions']!=null) samples.add({...copied(s),'fixtureFile':file});
    }
  }
  // Current creation uses explicit feePolicy, never obsolete lpPlan requests.
  for(final file in ['high-level173','high-level173-extra']){
    final data=jsonDecode(File('../contract173-upgrade/$file.json').readAsStringSync());
    for(final s in data['cases'])samples.add({...copied(s),'fixtureFile':file});
  }
  late Map library;
  late IndexedFixture indexed;
  setUpAll(() { library=trustedIndexCandidateLibrary(); indexed=IndexedFixture(samples); });
  test('Pool2 omitted unlocked lock time is zero; locked/malformed stays rejected', () {
    expect(pool2LpLockTime({}, locked:false),0);
    expect(pool2LpLockTime({'lock_time':0}, locked:false),0);
    expect(pool2LpLockTime({'lock_time':829000}, locked:true),829000);
    expect(() => pool2LpLockTime({}, locked:true),throwsStateError);
    for(final bad in [null,-1,1.5,'invalid',4294967296]) {
      expect(() => pool2LpLockTime({'lock_time':bad}, locked:false),throwsStateError);
    }
  });
  // Real official-API shape: omitted lock_time must produce identical spend bytes.
  final omitted=copied(samples.firstWhere((s)=>s['name']=='unified-pool2-remove'));
  omitted['name']='unified-pool2-remove-omitted-unlocked-time';
  for(final entry in (omitted['replies'] as Map).entries) {
    if((entry.key as String).contains('/pool/lputxo/')) {
      for(final row in entry.value['utxos']) (row as Map).remove('lock_time');
    }
  }
  samples.add(omitted);
  for(final base in samples){
    test('${base['fixtureFile']} ${base['name']} preserves signed bytes',()async{
      final s=copied(base),replies=copied(s['replies']);
      if(s['signingAccounts']!=null)s['additionalAccounts']=s['signingAccounts'];
      final expires=tbcProtocolTimestamp(DateTime.now().add(const Duration(minutes:2)));
      if(s['request']['constraints']?['expiresAt']!=null)s['request']['constraints']['expiresAt']=expires;
      final reads=<String>[];
      s['replies']=replies;
      indexed.enrich(s);
      // HTLC lock FT record and AMM-create underlying FT are covered above.
      final op=s['signingAccounts']==null?FixtureOperation(s):RoleFixtureOperation(s);
      final poolConsent=RegExp(r'^unified-pool2-(buy|sell|add|remove)$').hasMatch(s['name'])?Completer<void>():null;
      if(poolConsent!=null){
        op.duringConsent=()async{
          try{
            for(var n=0;reads.length<2&&n<300;n++)await Future<void>.delayed(const Duration(milliseconds:1));
            expect(reads,unorderedEquals([
              '/api/tbc/utxo/address/${s['account']['address']}',
              '/api/tbc/pool/poolinfo/poolid/${s['request']['intent']['poolContractId']}',
            ]));
            expect(op.binds,0);expect(op.signs,0);
          }finally{poolConsent.complete();}
        };
      }
      final worker=await TbcSigningWorker.start(
        library:TbcPinnedComputeLibrary(path:library['path'],sha256:library['sha256']),
        network:TbcNetworkConfiguration.official(TbcNetwork.testnet),
        backend:FixtureBackend(op),
        read:(path)async{
          reads.add(path);expect(replies.containsKey(path),true,reason:'unexpected GET $path');if(poolConsent!=null)await poolConsent.future;return copied(replies[path]);
        },
        txoStatus:(_ )async=>copied(s['statusReply'] ?? replies['/api/tbc/txo/status']),
      );
      addTearDown(worker.close);
      Map<String,dynamic>? policy;
      if(s['minConfirmations']!='0'){
        policy=copied(s['audit']['material']['policy']);
        policy['payload']['expiresAt']=expires;policy['policyHash']=hashJson(policy['payload']);
      }
      final result=await worker.execute(
        scope:TbcSigningRequestScope(operationId:'indexed-${s['name']}',method:s['method'],
          account:TbcAccount(network:TbcNetwork.testnet,address:s['account']['address'],publicKey:s['account']['publicKey']),revision:0,
          navigation:TbcWebViewNavigation(webViewInstanceId:'view',sessionId:'session',navigationId:'nav',
            committedUrl:'https://partner.example/dapp',origin:'https://partner.example',createdAt:tbcProtocolTimestamp(DateTime.now()))),
        request:s['request'],policy:policy,requireAuthorized:(){},isUnlocked:()=>true,
      );
      expect(canonical(result['transactions']),canonical(s['result']['transactions']));
      expect(result['totalFee'],s['result']['totalFee']);
      expect(op.consents,1);expect(op.binds,1);
      expect(reads.length,reads.toSet().length);
    });
  }
}
