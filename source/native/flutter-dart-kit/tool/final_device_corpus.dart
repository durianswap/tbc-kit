// Maintainer-only corpus refresh. Add current API index evidence from frozen
// bytes; never modify expected transaction/signature results or package files.
import 'dart:convert';
import 'dart:io';
import '../test/support/indexed_fixture.dart';

void main(List<String> args) {
  if(args.length!=2)throw ArgumentError('Output corpus and projected Prepared material paths required');
  Map fixture(String p)=>jsonDecode(File(p).readAsStringSync()) as Map;
  final rows=<Map>[],skipped=<Map>[],preparedMaterials=<Map>[];
  final native=fixture('test/fixtures/native-transfers.json')['cases'] as List;
  rows.add((fixture('test/fixtures/signing/replay.json')['cases'] as List).firstWhere((s)=>s['name']=='android-tbc_signMessage'));
  for(final s in fixture('test/fixtures/native-signing.json')['cases'])rows.add({...s,'replies':native.firstWhere((n)=>n['name']==s['name'])['replies']});
  for(final name in ['fungible-signing','nft-signing','stablecoin-signing','staged-signing','creation-signing','nft-mint-signing','lp-signing','pool2-signing','pool2-maintenance','timelock-signing','htlc-native-signing','htlc-token-signing','lop-signing']){
    final samples=(fixture('test/fixtures/$name.json')['cases'] as List).cast<Map>();
    final indexed=IndexedFixture(samples);
    for(final original in samples){
      final s=jsonDecode(jsonEncode(original)) as Map;
      if(s['minConfirmations']!=null&&s['minConfirmations']!='0'){skipped.add({'name':s['name'],'reason':'Explicit confirmation policy retained in offline suite'});continue;}
      final before=jsonEncode(s['result']);
      if(s['audit']?['material']?['snapshot']?['payload']?['contracts'] is List)indexed.enrich(s);
      if(jsonEncode(s['result'])!=before)throw StateError('ORACLE_CHANGED');
      rows.add(s);
    }
  }
  for(final name in ['high-level173','high-level173-extra']){
    final samples=(fixture('../contract173-upgrade/$name.json')['cases'] as List).cast<Map>();
    final indexed=IndexedFixture(samples);
    for(final s in samples){final before=jsonEncode(s['result']);indexed.enrich(s);if(jsonEncode(s['result'])!=before)throw StateError('ORACLE_CHANGED');rows.add(s);}
  }
  for(final s in fixture('test/fixtures/prepared-signing.json')['cases']){
    final original=rows.where((v)=>v['name']==s['source']['name']).firstOrNull;
    if(s['request']['chainId']=='tbc:testnet'&&original!=null){
      final sources=(fixture('test/fixtures/${s['source']['file']}')['cases'] as List).cast<Map>();
      final source=jsonDecode(jsonEncode(sources.firstWhere((v)=>v['name']==s['source']['name']))) as Map;
      final indexed=IndexedFixture(sources),before=jsonEncode(source['result']);
      switch(s['source']['file']){
        case 'fungible-signing.json':case 'staged-signing.json':case 'stablecoin-signing.json': indexed.projectHolder(source);break;
        case 'pool2-signing.json':indexed.projectPool2(source);break;
        case 'lp-signing.json':indexed.projectLp(source);break;
        case 'htlc-token-signing.json':indexed.projectHolder(source,requireTip:source['request']['intent']['type']!='tbc-htlc-claim');break;
        case 'lop-signing.json':indexed.projectLop(source);break;
      }
      if(jsonEncode(source['result'])!=before)throw StateError('PREPARED_ORACLE_CHANGED');
      preparedMaterials.add({'name':'prepared-${s['name']}','material':source['audit']['material']});
      rows.add({...original,...s,'name':'prepared-${s['name']}'});
    }
  }
  final keep=['name','method','request','result','replies','statusBody','statusReply','coldStatus'];
  final output={'cases':[for(final s in rows){for(final k in keep)if(s.containsKey(k))k:s[k]}],'skipped':skipped};
  File(args[0]).writeAsStringSync(jsonEncode(output));
  File(args[1]).writeAsStringSync(jsonEncode(preparedMaterials));
  print(jsonEncode({'cases':rows.length,'testnetCases':rows.where((s)=>s['request']['chainId']=='tbc:testnet').length,'expectedResultsUnchanged':true,'broadcast':false}));
}
