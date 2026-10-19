// Read-only, reproducible adaptation of the sealed P5 native permission owner.
// Emits candidate file bodies/provenance; apply through the normal patch tool.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const base=resolve(import.meta.dirname,'..'),p5=resolve(base,'../flutter-dart-live-token-exploration');
const seal=JSON.parse(await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json')));
const sha=b=>createHash('sha256').update(b).digest('hex');
const files={},provenance=[];
for(const [language,path] of [['kotlin','android/NativePermissions.kt'],['swift','ios/NativePermissions.swift']]){
 const original=await readFile(join(p5,path));assert.equal(sha(original),seal.sourceHashes[path]);
 let s=original.toString();
 function replace(from,to){assert.equal(s.split(from).length,2,from);s=s.replace(from,to);}
 if(language==='kotlin'){
  replace('package io.tbc.dartwebview','package io.tbc.kit.dart');
  replace(',val fixtureIndex:Int','');
  replace(' fun metrics():Map<String,Int>\n','');
  replace(' private var reads=0;private var writes=0\n var failNextCommitForTest=false\n','');
  replace('check(profile.isNotEmpty()&&chain=="tbc:testnet")','check(profile.isNotEmpty()&&chain in setOf("tbc:mainnet","tbc:testnet"))');
  replace('"p4-permissions.sqlite"','"tbc-kit-permissions.sqlite"');
  replace(' override fun metrics()=mapOf("reads" to reads,"writes" to writes)\n','');
  s=s.replaceAll('reads++;','').replaceAll(';writes++','');
  s=s.replaceAll('arrayOf(profile,chain,origin,next,PermissionJson.canonical(records))','arrayOf<Any>(profile,chain,origin,next,PermissionJson.canonical(records))')
   .replaceAll('arrayOf(profile,chain,callId,meaning,next)','arrayOf<Any>(profile,chain,callId,meaning,next)');
  replace('fence();if(failNextCommitForTest){failNextCommitForTest=false;error("PERMISSION_STORE_UNAVAILABLE")}','fence()');
  replace('class NativePermissions(val accounts:NativeAccountSource,private val backend:NativePermissionBackend,private val changed:(String?)->Unit) {',
   'class NativePermissions(val accounts:NativeAccountSource,private val chain:String,private val backend:NativePermissionBackend,private val changed:(String?)->Unit) {\n init { check(chain in setOf("tbc:mainnet","tbc:testnet")) }');
  replace(' fun metrics()=backend.metrics()\n','');
  replace('check(available){"PERMISSION_STORE_UNAVAILABLE"}\n  if(!accounts.unlocked)',
   'check(available){"PERMISSION_STORE_UNAVAILABLE"}\n  check(accounts.current.chainId==chain){"PERMISSION_CHAIN_CHANGED"}\n  if(!accounts.unlocked)');
  replace('check(available&&accounts.unlocked){"NATIVE_LOCKED"};check(request.isNotEmpty()',
   'check(available&&accounts.unlocked){"NATIVE_LOCKED"};check(accounts.current.chainId==chain){"PERMISSION_CHAIN_CHANGED"};check(request.isNotEmpty()');
  replace('for((_,value)in request){val v=value as? Map<*,*>?:error("INVALID_PARAMS");check(v.keys.all{it=="chains"||it=="maxAccounts"}&&v["chains"]==listOf(accounts.current.chainId)&&(!v.containsKey("maxAccounts")||v["maxAccounts"]==1)){"INVALID_PARAMS"}}',
   'for((capability,value)in request){val v=value as? Map<*,*>?:error("INVALID_PARAMS");val allowedFields=if(capability=="tbc_accounts")setOf("chains","maxAccounts")else setOf("chains");val maximum=v["maxAccounts"];check(v.keys.all{it in allowedFields}&&v["chains"]==listOf(chain)&&(!v.containsKey("maxAccounts")||((maximum is Int||maximum is Long)&&(maximum as Number).toLong() in 1L..16L))){"INVALID_PARAMS"}}');
  replace('val cs=p["caveats"] as? List<*>?:error("PERMISSION_CORRUPT")\n  val found=',
   'val cs=p["caveats"] as? List<*>?:error("PERMISSION_CORRUPT")\n  check(cs.size in 3..4 && cs.all{it is Map<*,*> && it.keys==setOf("type","value") && it["type"] in setOf("restrictChains","restrictAccounts","restrictMethods","expiresAt")}){"PERMISSION_CORRUPT"}\n  check(cs.map{(it as Map<*,*>)["type"]}.toSet().size==cs.size){"PERMISSION_CORRUPT"}\n  val found=');
  replace('val method=p["parentCapability"] as? String?:error("PERMISSION_CORRUPT")',
   'check(p.keys==setOf("id","parentCapability","invoker","date","caveats")){"PERMISSION_CORRUPT"}\n   val method=p["parentCapability"] as? String?:error("PERMISSION_CORRUPT")');
  replace('check(ids.isNotEmpty())','check(ids.isNotEmpty()&&ids.all{it is String}){"PERMISSION_CORRUPT"}');
  replace('val expiry=caveat(p,"expiresAt") as? String',
   'val expiryValue=caveat(p,"expiresAt");val hasExpiry=(p["caveats"] as List<*>).any{(it as Map<*,*>)["type"]=="expiresAt"}\n   check(!hasExpiry||expiryValue is String){"PERMISSION_CORRUPT"};val expiry=expiryValue as? String');
  replace('// System SQLite, private fixture database, FULL synchronous durability. No',
   '// Wallet-private system SQLite, FULL synchronous durability. No');
  files['platform/android/src/main/kotlin/io/tbc/kit/dart/NativePermissions.kt']=s;
 }else{
  replace(' var metrics:[String:Int]{get}\n','');
  replace(';let fixtureIndex:UInt8','');
  replace(' private var reads=0,writes=0;var failNextCommitForTest=false\n var metrics:[String:Int]{["reads":reads,"writes":writes]}\n','');
  replace('init(profile:String,chain:String)throws{','init(profile:String,chain:String,directory:URL)throws{');
  replace('!profile.isEmpty && chain=="tbc:testnet"','!profile.isEmpty && ["tbc:mainnet","tbc:testnet"].contains(chain)');
  replace('let path=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]','let path=directory');
  replace('"p4-permissions.sqlite"','"tbc-kit-permissions.sqlite"');
  s=s.replaceAll('reads+=1;','').replaceAll(';writes+=1','');
  replace('try fence();if failNextCommitForTest{failNextCommitForTest=false;throw PermissionFailure(code:"PERMISSION_STORE_UNAVAILABLE")}','try fence()');
  replace('private let accounts:NativeAccountSource,backend:NativePermissionBackend,changed:(String?)->Void',
   'private let accounts:NativeAccountSource,backend:NativePermissionBackend,changed:(String?)->Void\n private let chain:String');
  replace(' var metrics:[String:Int]{backend.metrics}\n','');
  replace('init(accounts:NativeAccountSource,backend:NativePermissionBackend,changed:@escaping(String?)->Void)throws{self.accounts=accounts;self.backend=backend;self.changed=changed;snapshots=try backend.loadAll()}',
   'init(accounts:NativeAccountSource,chain:String,backend:NativePermissionBackend,changed:@escaping(String?)->Void)throws{try permissionNeed(["tbc:mainnet","tbc:testnet"].contains(chain),"PERMISSION_CHAIN");self.accounts=accounts;self.chain=chain;self.backend=backend;self.changed=changed;snapshots=try backend.loadAll()}');
  replace('try permissionNeed(available,"PERMISSION_STORE_UNAVAILABLE");if !accounts.unlocked{return []}',
   'try permissionNeed(available,"PERMISSION_STORE_UNAVAILABLE");try permissionNeed(accounts.current.chainId==chain,"PERMISSION_CHAIN_CHANGED");if !accounts.unlocked{return []}');
  replace('try permissionNeed(available && accounts.unlocked,"NATIVE_LOCKED");try permissionNeed(!request.isEmpty',
   'try permissionNeed(available && accounts.unlocked,"NATIVE_LOCKED");try permissionNeed(accounts.current.chainId==chain,"PERMISSION_CHAIN_CHANGED");try permissionNeed(!request.isEmpty');
  replace('for value in request.values{guard let v=value as? [String:Any]else{throw PermissionFailure(code:"INVALID_PARAMS")};try permissionNeed(v.keys.allSatisfy{$0=="chains" || $0=="maxAccounts"} && v["chains"] as? [String]==[accounts.current.chainId] && (v["maxAccounts"]==nil || v["maxAccounts"] as? Int==1),"INVALID_PARAMS")}',
   'for(capability,value)in request{guard let v=value as? [String:Any]else{throw PermissionFailure(code:"INVALID_PARAMS")};let fields:Set<String>=capability=="tbc_accounts" ? ["chains","maxAccounts"]:["chains"];let maximum=v["maxAccounts"] as? NSNumber;let validMaximum=maximum.map{CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.rounded()==$0.doubleValue && (1...16).contains($0.intValue)} ?? false;try permissionNeed(v.keys.allSatisfy{fields.contains($0)} && v["chains"] as? [String]==[chain] && (v["maxAccounts"]==nil || validMaximum),"INVALID_PARAMS")}');
  replace('let found=cs.filter{$0["type"] as? String==name};',
   'try permissionNeed((3...4).contains(cs.count) && cs.allSatisfy{Set($0.keys)==["type","value"] && ["restrictChains","restrictAccounts","restrictMethods","expiresAt"].contains($0["type"] as? String ?? "")} && Set(cs.compactMap{$0["type"] as? String}).count==cs.count,"PERMISSION_CORRUPT");let found=cs.filter{$0["type"] as? String==name};');
  replace('guard let method=p["parentCapability"] as? String else',
   'try permissionNeed(Set(p.keys)==["id","parentCapability","invoker","date","caveats"],"PERMISSION_CORRUPT")\n   guard let method=p["parentCapability"] as? String else');
  replace('if let expiry=try caveat(p,"expiresAt") as? String{',
   'if let value=try caveat(p,"expiresAt"){guard let expiry=value as? String else{throw PermissionFailure(code:"PERMISSION_CORRUPT")};');
  files['platform/ios/Classes/NativePermissions.swift']=s;
 }
 provenance.push({source:path,sourceSha256:sha(original),candidateSha256:sha(s),language});
}
for(const [path,s]of Object.entries(files)){
 assert(!/fixtureIndex|failNextCommitForTest|p4-permissions|fun metrics|var metrics/.test(s),path);
}
console.log(JSON.stringify({files,provenance}));
