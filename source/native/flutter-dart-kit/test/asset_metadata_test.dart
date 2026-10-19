// Trusted API metadata plus exact local Code/Tape recognition; no live keys.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/asset_metadata.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_business.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_mapping.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'support/trusted_index_candidate.dart';
Map<String,dynamic> sample(String file,String name)=>copied(
 (jsonDecode(File('test/fixtures/$file.json').readAsStringSync())['cases'] as List).singleWhere((c)=>c['name']==name));
void main(){
 late ComputeProbe engine;
 final network=TbcNetworkConfiguration.official(TbcNetwork.testnet);
 setUpAll(()=>engine=ComputeProbe(DynamicLibrary.open(trustedIndexCandidateLibrary()['path'])));
 Map<String,dynamic> keyless(String method,Map<String,dynamic> input)=>copied(jsonDecode(engine.call('keyless',method,canonical(input))));
 AssetMetadataReader reader(Map replies,List<String> paths,{TbcNetworkConfiguration? source})=>AssetMetadataReader(history:Tbc20MaterialReader(
  network:source??network,keyless:keyless,read:(path)async{paths.add(path);expect(replies.containsKey(path),true,reason:path);return copied(replies[path]);}));
 Map<String,dynamic> ftInfo(String raw,{int decimal=6,String name='Token',String symbol='TBCX'}){
  final out=inspectTransaction(raw)['outputs'],tape=out[1]['scriptPubKey'],bytes=unhex(tape);var amount=BigInt.zero;
  for(var at=3;at<51;at+=8)for(var n=0;n<8;n++)amount+=BigInt.from(bytes[at+n])<<(8*n);
  return {'code_script':out[0]['scriptPubKey'],'tape_script':tape,'amount':'$amount','decimal':decimal,'name':name,'symbol':symbol};
 }
 for(final name in ['create-tbc20-single','create-tbc20-fragmented','create-tbc20-selected']){
  test('$name one indexed read and exact Legacy decimal conversion',()async{
   final s=sample('creation-signing',name),tx=s['result']['transactions'].last,id=tx['txid'],path='/api/tbc/ft/info/contract/$id',paths=<String>[];
   final r=reader({path:ftInfo(tx['rawTransaction'])},paths),values=await Future.wait([r.ft(id),r.ft(id),r.ft(id)]);
   for(final v in values)expect([v.contractId,v.family,v.current,v.decimals,v.name,v.symbol],[id,'tbc20',true,6,'Token','TBCX']);
   final a=s['account'],resolver=LegacyBusinessResolver(account:LegacyMappingAccount(chainId:a['chainId'],address:a['address'],accountId:a['accountId']),
    network:network,metadata:LegacySharedMetadata(r),requireCurrent:(){});
   final request=await resolver.resolve({'flag':'FT_TRANSFER','ft_contract_address':id,'address':a['address'],'ft_amount':'0.01','broadcastEnabled':false});
   expect(request['intent']['amount'],'10000');expect(request['intent']['type'],'tbc20.transfer');expect(paths,[path]);
   await expectLater(r.stablecoin(id),throwsStateError);
  });
 }
 test('historical FT precision without genesis download',()async{
  final s=sample('fungible-signing','historical-transfer'),p=s['audit']['material']['snapshot']['payload'],id=s['request']['intent']['contractId'];
  final raw=(p['parents'] as List).singleWhere((r)=>r['txid']==id)['rawTransaction'],paths=<String>[];
  final r=reader({'/api/tbc/ft/info/contract/$id':ftInfo(raw,name:'Controlled Pool Token',symbol:'CPT')},paths),v=await r.ft(id);
  expect([v.current,v.decimals,v.name,v.symbol],[false,6,'Controlled Pool Token','CPT']);expect(paths.length,1);
 });
 for(final name in ['current-coin-transfer','historical-stablecoin-transfer']){
  test('$name indexed identity without issuance history',()async{
   final s=sample('stablecoin-signing',name),p=s['audit']['material']['snapshot']['payload'],record=p['contracts'][0],id=record['contractId'];
   final old=name.startsWith('historical'),mintId=old?record['creationTxid']:record['currentOutpoint']['txid'];
   final mint=inspectTransaction((p['parents'] as List).singleWhere((r)=>r['txid']==mintId)['rawTransaction']);
   final code=mint['outputs'][3]['scriptPubKey'],tape=mint['outputs'][4]['scriptPubKey'],bytes=unhex(tape);var supply=BigInt.zero;
   for(var at=3;at<51;at+=8)for(var n=0;n<8;n++)supply+=BigInt.from(bytes[at+n])<<(8*n);
   final paths=<String>[],path='/api/tbc/stablecoin/info/stablecoinid/$id';
   final r=reader({path:{'stablecoin_id':id,'code_script':code,'tape_script':tape,'supply':'$supply','decimal':old?6:0,
    'name':old?'Task Six Dollar':'Offline Coin','symbol':old?'TSD':'OFF'}},paths),v=await r.stablecoin(id);
   expect(v.current,!old);expect(v.decimals,old?6:0);await r.stablecoin(id);expect(paths,[path]);await expectLater(r.ft(id),throwsStateError);
  });
 }
 for(final name in ['unified-pool2-sell','unified-amm-public-plain-buy','unified-amm-public-locked-buy']){
  test('$name current state routes and immutable identity caches',()async{
   final s=sample('unified-pool-signing',name),id=s['request']['intent']['poolContractId'],paths=<String>[],replies=s['replies'];
   final infoPath='/api/tbc/pool/poolinfo/poolid/$id',info=replies[infoPath],r=reader(replies,paths),value=await r.poolToken(id);
   expect(value.current,!name.startsWith('unified-pool2'));expect(value.ftContractId,info['ft_contract_id']);
   expect(paths,[infoPath,'/api/tbc/txraw/txid/${info['txid']}']);await r.poolToken(id);expect(paths.length,2);
  });
 }
 test('missing precision, invalid scripts and supply rejected without fallback queries',()async{
  final s=sample('creation-signing','create-tbc20-single'),tx=s['result']['transactions'].last,id=tx['txid'],path='/api/tbc/ft/info/contract/$id';
  for(final failure in ['decimal','range','code','tape','name','supply']){
   final info=ftInfo(tx['rawTransaction']);
   switch(failure){case 'decimal':info.remove('decimal');case 'range':info['decimal']=19;case 'code':info['code_script']='51';
    case 'tape':info['tape_script']='006a';case 'name':info['name']='';case 'supply':info['amount']='0';}
   final paths=<String>[];await expectLater(reader({path:info},paths).ft(id),throwsStateError);expect(paths,[path]);
  }
 });
 test('failed metadata is not cached or automatically retried',()async{
  final s=sample('creation-signing','create-tbc20-single'),tx=s['result']['transactions'].last,id=tx['txid'];var reads=0;
  final r=AssetMetadataReader(history:Tbc20MaterialReader(network:network,keyless:keyless,read:(_)async{reads++;return reads==1?{'code_script':'00'}:ftInfo(tx['rawTransaction']);}));
  await expectLater(r.ft(id),throwsStateError);expect(reads,1);expect((await r.ft(id)).decimals,6);expect(reads,2);
 });
 test('network and API source never share metadata caches',()async{
  final s=sample('creation-signing','create-tbc20-single'),tx=s['result']['transactions'].last,id=tx['txid'],paths=<String>[],replies={'/api/tbc/ft/info/contract/$id':ftInfo(tx['rawTransaction'])};
  final a=reader(replies,paths),b=reader(replies,paths,source:TbcNetworkConfiguration.trustedCustom(network:TbcNetwork.mainnet,apiOrigin:'https://read.example',trustId:'partner'));
  await a.ft(id);await b.ft(id);expect(paths.length,2);expect(a.network.chainId,'tbc:testnet');expect(b.network.chainId,'tbc:mainnet');
 });
}
