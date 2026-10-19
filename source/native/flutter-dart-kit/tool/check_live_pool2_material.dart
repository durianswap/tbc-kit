// Public-chain read-only diagnosis: no Signer, private key, UI or broadcast.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/read_api.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/unified_pool_material.dart';
Future<void> main(List<String> args)async{
 final plan=copied(jsonDecode(await File(args[0]).readAsString())),platform=args[1];
 final accounts=jsonDecode(await File('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json').readAsString());
 final account=copied(accounts['accounts'][platform]);
 final network=TbcNetworkConfiguration.trustedCustom(network:TbcNetwork.testnet,apiOrigin:'https://api.tbcdev.org',trustId:'pool2-readonly');
 final api=TbcReadApi(network),probe=ComputeProbe(DynamicLibrary.open('/private/tmp/tbc-trusted-pool2-compute-20261015-b/target/aarch64-apple-darwin/release/libtbc_compute_native.dylib'));
 final replies=<String,Map<String,dynamic>>{};
 Future<Map<String,dynamic>> read(String path)async{final d=await api.get(path);replies[path]=d;return d;}
 Map<String,dynamic> keyless(String method,Map<String,dynamic> input){final r=copied(jsonDecode(probe.call('keyless',method,jsonEncode(input))));if(r['ok']==false)stderr.writeln({'method':method,'error':r['error']});return r;}
 final token=Tbc20MaterialReader(network:network,read:read,keyless:keyless),now=DateTime.now().toUtc();
 try{
  final material=await UnifiedPoolMaterialReader(network:network,read:read,readHistory:token.parent,rememberParent:token.rememberParent,keyless:keyless).resolve(request:plan['request'],account:account,now:now,snapshotId:'readonly-pool2');
  final input={'version':'1.0','request':plan['request'],'requestHash':hashJson(plan['request']),'snapshot':material.snapshot,'policy':material.policy(request:plan['request'],network:network)};
  final result=copied(jsonDecode(probe.call('engine','plan',jsonEncode(input))));
  print(jsonEncode({'ok':result['ok'],'error':result['error'],'reads':replies.keys.toList()}));
  if(args.length>2)await File(args[2]).writeAsString(jsonEncode({'input':input,'result':result,'replies':replies}));
 }catch(e,s){stderr.writeln('$e\n$s');rethrow;}finally{api.close();}
}
