import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/read_api.dart';

// Only the socket destination changes. Real Dart HttpClient request ordering,
// headers, body and redirects are exercised; no public endpoint or transaction.
class LocalSocketClient implements HttpClient {
  LocalSocketClient(this.inner,this.port);
  final HttpClient inner;
  final int port;
  @override
  set connectionTimeout(Duration? value)=>inner.connectionTimeout=value;
  @override
  Future<HttpClientRequest> openUrl(String method,Uri uri) {
    expect(uri.origin,'https://api.tbcdev.org');
    return inner.openUrl(method,uri.replace(scheme:'http',host:'127.0.0.1',port:port));
  }
  @override
  void close({bool force=false})=>inner.close(force:force);
  @override
  dynamic noSuchMethod(Invocation invocation)=>super.noSuchMethod(invocation);
}

void main(){
 for(final redirect in [false,true])test('real read-only POST socket; redirect=$redirect',()async{
  final server=await HttpServer.bind(InternetAddress.loopbackIPv4,0);
  final inner=HttpClient(),calls=<String>[];
  final txos=[{'txid':'ab'*32,'index':1}];
  server.listen((request)async{
    calls.add('${request.method} ${request.uri.path}');
    expect(jsonDecode(await utf8.decoder.bind(request).join()),{'txos':txos});
    expect(request.headers.contentType?.mimeType,'application/json');
    if(redirect){request.response.statusCode=307;request.response.headers.set('Location','/forbidden');}
    else{request.response.headers.contentType=ContentType.json;request.response.write(jsonEncode({'code':200,'data':{'results':[]}}));}
    await request.response.close();
  });
  try{
   await HttpOverrides.runZoned(()async{
    final api=TbcReadApi(TbcNetworkConfiguration.official(TbcNetwork.testnet));
    try{
     if(redirect)await expectLater(api.txoStatus(txos),throwsStateError);
     else expect(await api.txoStatus(txos),{'txos':[]});
    }finally{api.close();}
   },createHttpClient:(_)=>LocalSocketClient(inner,server.port));
   expect(calls,['POST /api/tbc/txo/status']);
  }finally{inner.close(force:true);await server.close(force:true);}
 });
}
