// Public synthetic transactions; no funded address, HTTP or broadcast.
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';
import 'package:tbc_kit_flutter_dart/src/internal/collection_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/htlc_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';

void main() {
  final f = copied(jsonDecode(File('test/fixtures/rc16-material.json').readAsStringSync()));
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  final now = protocolTime(f['now']), account = copied(f['account']);
  for (final count in [25,26,100,128]) {
    for (final claim in [true,false]) {
      test('HTLC ${claim ? 'claim':'refund'} $count batches only requested outputs', () async {
        final gets=<String>[], posts=<List<Map<String,dynamic>>>[], history=<String>[];
        Future<Map<String,dynamic>> read(String path) async {
          gets.add(path); expect(path,'/api/tbc/nodeinfo');
          return {'blocks':830000,'bestblockhash':'bb'*32};
        }
        final r=HtlcMaterialReader(network:network,read:read,
          funding:NativeMaterialReader(network:network,read:read),
          status:(points) async { posts.add(points); return {'txos':[for(final p in points)
            {...p,'value':'10000','spent':false,'height':829999,'scriptPubKey':f['htlcScript']}]}; },
          readHistory:(id) async {history.add(id);return inspectTransaction(f['htlc']['raw'],id);});
        final request={'version':'1.0','chainId':network.chainId,'from':account['address'],
          'intent':{'version':'1.0','type':claim ? 'tbc-htlc-claim':'tbc-htlc-refund','to':account['address']},
          'constraints':{'inputOutpoints':[for(var i=0;i<count;i++) {'txid':f['htlc']['txid'],'vout':i}]}};
        final result=await r.resolve(request:request,account:account,now:now,snapshotId:'htlc-$count');
        expect(result['payload']['utxos'],hasLength(count));
        expect(gets,claim ? isEmpty:['/api/tbc/nodeinfo']);
        expect(history,[f['htlc']['txid']]);
        expect(posts.length,(count+24)~/25);
        expect(posts.every((p)=>p.length<=25),true);
        expect(posts.expand((p)=>p).map((p)=>p['index']).toSet(),hasLength(count));
      });
    }
  }
  for (final count in [26,100]) {
    for (final indexedCount in [0,count]) {
      test('collection $count slots with $indexedCount indexed reuses original reads', () async {
        final gets=<String>[],posts=<int>[],history=<String>[];
        Future<Map<String,dynamic>> read(String p) async {
          gets.add(p);
          if(p.contains('/utxo/address/')) return {'utxos':[{'txid':f['funding']['txid'],'index':'0','value':'9000000','height':829999}]};
          expect(p,startsWith('/api/tbc/utxo/scriptpubkeyhash/'));
          return {'utxos':[for(var i=1;i<=indexedCount;i++) {'txid':f['collection']['txid'],'index':'$i','value':'100','height':829999}]};
        }
        final reader=CollectionMaterialReader(network:network,read:read,
          funding:NativeMaterialReader(network:network,read:read),
          readHistory:(id) async {history.add(id);return inspectTransaction(f['collection']['raw'],id);},
          status:(p) async {posts.add(p.length);return {'txos':[for(final point in p)
            {...point,'value':'100','spent':false,'height':829999,'scriptPubKey':f['collection']['layout']['slotScript']}]};});
        final request={'version':'1.0','chainId':network.chainId,'from':account['address'],
          'intent':{'version':'1.0','type':'tbc721-standard-batch-mint','collectionId':f['collection']['txid'],
            'items':[for(var i=1;i<=count;i++) {'slot':i,'to':account['address'],'name':'public $i','description':'fixture','media':{'kind':'uri','uri':'ipfs://public'}}]},
          'constraints':{'maxFee':'10000'}};
        final snapshot=await reader.resolve(request:request,account:account,now:now,snapshotId:'collection-$count');
        expect(snapshot['payload']['utxos'],hasLength(count+1));
        expect(posts,indexedCount==count ? isEmpty:List.generate((count+24)~/25,(i)=>(count-i*25).clamp(0,25)));
        expect(gets,hasLength(2));expect(gets.toSet(),hasLength(2));
        expect(history,[f['collection']['txid']]);
      });
    }
  }
  test('raw review 26 outputs and repeated dependency consume use two requests total', () async {
    final raw=f['rawSpend']['raw'];
    final plan=ReviewedRawPlan.fromMaterial(normalizeReviewedMaterial({
      'payload':{'format':'raw','transactions':[{'rawTransaction':raw,
        'inputs':[for(var i=0;i<26;i++) {'satoshis':'1000','scriptPubKey':f['script']}]}]}}));
    final calls=<int>[];
    final r=ReviewedStatusReader(plan:plan,requireCurrent:(){},status:(points) async {
      calls.add(points.length);return {'txos':[for(final p in points)
        {...p,'value':'1000','spent':false,'scriptPubKey':f['script']}]};});
    await r.readInputs();
    await r.readDependencies([for(var i=0;i<26;i++) {'txid':f['rawParent']['txid'],'vout':i}]);
    expect(calls,[25,1]);
    expect(r.policyMaterial()['resolvedOutputs'],hasLength(26));
  });

  for(final indexed in [0,75,101]) {
    test('getMintStatus index=$indexed: single-flight, immutable reuse, fresh mutable status',() async {
      final gets=<String>[],posts=<int>[];var inspections=0;
      final reader=Tbc721Reader(network:network,
        inspectCollection:(id,raw){inspections++;return copied(f['collection']['layout']);},
        read:(p) async {gets.add(p);return p.contains('/txraw/') ? {'txraw':f['collection']['raw']}:
          {'utxos':[for(var i=1;i<=indexed;i++) {'txid':f['collection']['txid'],'index':'$i','value':'100'}]};},
        status:(points) async {posts.add(points.length);return {'txos':[for(final p in points) {...p,'value':'100','spent':false}]};});
      Future<Map> query()=>reader.getMintStatus(collectionId:f['collection']['txid'],address:account['address']);
      final a=query(),b=query();expect(identical(a,b),true);
      final result=await a;await b;
      expect(result['status'],'available');expect(result['availableCount'],101);
      expect(gets,hasLength(2));expect(inspections,1);
      expect(posts.length,(101-indexed+24)~/25);
      await query();expect(inspections,1);expect(gets,hasLength(3));
      expect(posts.length,2*((101-indexed+24)~/25));
      reader.close();expect(query,throwsStateError);
    });
  }
  for(final mode in ['incomplete','offline','spent','foreign','duplicate','wrong-value']) {
    test('getMintStatus $mode never invents availability',() async {
      final r=Tbc721Reader(network:network,
        inspectCollection:(id,raw)=>copied(f['collection']['layout']),
        read:(p) async =>p.contains('/txraw/') ? {'txraw':f['collection']['raw']}:{'utxos':[]},
        status:(points) async {
          if(mode=='offline') throw const SocketException('offline');
          final rows=[for(final p in points) {...p,'value':mode=='wrong-value'?'101':'100','spent':mode=='spent'}];
          if(mode=='incomplete') rows.removeLast();
          if(mode=='foreign') rows.first['txid']='ff'*32;
          if(mode=='duplicate') rows.add({...rows.first});
          return {'txos':rows};
        });
      final work=r.getMintStatus(collectionId:f['collection']['txid'],address:account['address']);
      if(['foreign','duplicate','wrong-value'].contains(mode)) { await expectLater(work,throwsStateError); }
      else { final value=await work;expect(value['status'],mode=='spent'?'exhausted':'unknown'); }
      r.close();
    });
  }
}
