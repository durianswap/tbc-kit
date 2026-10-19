// Mechanical reuse of the frozen P5 document boundary. Not a new DApp protocol.
// Create-only: never overwrite either the source or an existing candidate.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),p5=resolve(base,'../flutter-dart-live-token-exploration');
const sha=b=>createHash('sha256').update(b).digest('hex');
const sealBytes=await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json'));
assert.equal(sha(sealBytes),'db3d2ef6e85ae0c6bd3281d87580d46b2c7c916521686854ed8dc5c0aa0f3b06');
const seal=JSON.parse(sealBytes),files=[];
function replace(text,before,after){assert.equal(text.split(before).length,2,before);return text.replace(before,after);}
async function save(source,destination,adapt){
 const bytes=await readFile(join(p5,source));assert.equal(sha(bytes),seal.sourceHashes[source],source);
 const value=adapt(bytes.toString());await mkdir(dirname(join(base,destination)),{recursive:true});
 await writeFile(join(base,destination),value,{flag:'wx'});
 files.push({source,sourceSha256:sha(bytes),destination,sha256:sha(value)});
}
await save('android/TbcFlutterWebViewHost.kt','platform/android/src/main/kotlin/io/tbc/kit/dart/TbcFlutterWebViewHost.kt',text=>{
 text=replace(text,'package io.tbc.flutter','package io.tbc.kit.dart');
 text=replace(text,'io.tbc.kit/private-webview','io.tbc.kit.dart/private-webview');
 text=replace(text,'private val verifiedNavigation: (String, Map<String,String>) -> Unit = {_,_->},','private val verifiedNavigation: (String, Map<String,String>) -> Unit,');
 text=replace(text,'private val allowDelivery: (String, Map<String,String>, String) -> Boolean = {_,_,_->true},','private val allowDelivery: (String, Map<String,String>, String) -> Boolean,');
 return replace(text,'if (call.method == "deliver" && !allowDelivery(id,expected,value as String))','if (delivery && !allowDelivery(id,expected,value as String))');
});
await save('ios/TbcFlutterWebViewHost.swift','platform/ios/Classes/TbcFlutterWebViewHost.swift',text=>{
 text=replace(text,'io.tbc.kit/private-webview','io.tbc.kit.dart/private-webview');
 text=replace(text,'verifiedNavigation:@escaping (String,[String:String])->Void = {_,_ in},','verifiedNavigation:@escaping (String,[String:String])->Void,');
 text=replace(text,'allowDelivery:@escaping (String,[String:String],String)->Bool = {_,_,_ in true}) throws','allowDelivery:@escaping (String,[String:String],String)->Bool) throws');
 return replace(text,'default:result(FlutterMethodNotImplemented)','default:result(FlutterError(code:"WEBVIEW_UNSUPPORTED_OPERATION",message:nil,details:nil))');
});
for(const name of ['TbcWebViewAttachment','TbcWebViewBoundary'])
 await save(`ios/${name}.swift`,`platform/ios/Classes/${name}.swift`,text=>name==='TbcWebViewBoundary'
  ?text.replaceAll('decisionHandler:@escaping (WKNavigationActionPolicy','decisionHandler:@escaping @MainActor (WKNavigationActionPolicy')
  :text);
await save('lib/webview_platform.dart','lib/src/flutter/webview_platform.dart',text=>{
 text=replace(text,"import 'package:flutter/foundation.dart';\n",'');
 text=replace(text,"import 'boundary_types.dart';","import '../internal/wire_session.dart';");
 text=replace(text,"import 'webview_scope.dart';","import '../webview_scope.dart';");
 text=replace(text,'implements TbcWebViewNativeDelivery, TbcLegacyWebViewNativeDelivery','implements TbcDocumentDelivery');
 text=replace(text,'io.tbc.kit/private-webview','io.tbc.kit.dart/private-webview');
 const start=text.indexOf('  @override\n  String? get legacyPlatform'),end=text.indexOf('\n  static Future<TbcWebViewPlatform>',start);
 assert(start>0&&end>start);text=text.slice(0,start)+text.slice(end);
 const a=text.indexOf('  @override\n  Future<bool> deliverLegacy('),b=text.indexOf('  @override\n  Future<bool> describe(',a);
 assert(a>0&&b>a);text=text.slice(0,a)+text.slice(b);
 assert(text.includes('throw const TbcRuntimeFailure('));return text.replaceAll('throw const TbcRuntimeFailure(','throw StateError(');
});
await writeFile(join(base,'evidence/f1-webview-extraction.json'),JSON.stringify({
 status:'F1_WEBVIEW_BOUNDARY_EXTRACTION_NOT_DEVICE_ACCEPTANCE',files,
 changes:['candidate namespace only','required navigation and native emission callbacks, no permissive defaults',
 'Android also fences Legacy delivery; current native owner rejects unsupported Legacy envelopes',
 'Dart uses the candidate document interface; no Legacy execution adapter enabled'],
 acceptedDeliveryChanged:false,deviceAcceptance:false,
},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({files:files.length,acceptedDeliveryChanged:false,deviceAcceptance:false}));
