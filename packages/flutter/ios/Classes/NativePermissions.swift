import Foundation
import CoreFoundation
import CryptoKit
import SQLite3

struct PermissionFailure:Error { let code:String }
func permissionNeed(_ ok:Bool,_ code:String)throws{if !ok{throw PermissionFailure(code:code)}}
struct PermissionSnapshot {let revision:Int64;let records:[[String:Any]]}
struct PermissionCommitResult {let acknowledgedRevision:Int64;let current:PermissionSnapshot}
// Selected by native wallet registration, never decoded from a page request.
// Keep Standard's existing tables/IDs intact; Legacy has a separate versioned
// namespace even when profile, chain, origin and operation IDs are identical.
enum NativeWalletProtocol:String {
 case standard="tws/1.0",legacy="legacy-window-turing/v1"
 var wireChannel:String{self == .standard ? "tws-webview/1":"legacy-window-turing-shared/1"}
 var scopesTable:String{self == .standard ? "scopes":"legacy_scopes"}
 var commitsTable:String{self == .standard ? "commits":"legacy_commits"}
 var permissionDomain:String{self == .standard ? "TWS/1.0/permission":"legacy-window-turing/v1/permission"}
}
@MainActor protocol NativePermissionBackend:AnyObject {
 var walletProtocol:NativeWalletProtocol{get}
 func loadAll()throws->[String:PermissionSnapshot]
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult
}
// Existing custom Standard backends keep their storage contract. A Legacy
// backend must opt in and isolate both grants and its idempotency ledger.
extension NativePermissionBackend {var walletProtocol:NativeWalletProtocol{.standard}}
// One native transaction owner, not a loop over per-chain commits. Custom
// wallet stores implement this only if they can commit every mutation atomically.
struct NativePermissionMutation {
 let backend:NativePermissionBackend,chainId:String,origin:String,expected:Int64
 let records:[[String:Any]],callId:String,meaning:String
}
@MainActor protocol NativePermissionGroupBackend:NativePermissionBackend {
 func acceptsGroup(_ backends:[NativePermissionBackend])->Bool
 func commitGroup(_ mutations:[NativePermissionMutation],fence:()throws->Void)throws->[String:PermissionCommitResult]
}
public struct NativeAccount:Equatable {
 public let address:String,publicKey:String,chainId:String
 public init(address:String,publicKey:String,chainId:String){self.address=address;self.publicKey=publicKey;self.chainId=chainId}
 public var accountId:String{"\(chainId):\(address)"}
 var identity:[String:Any]{["address":address,"publicKey":publicKey,"chainId":chainId,"accountId":accountId]}
}
@MainActor public protocol NativeAccountSource:AnyObject {
 var current:NativeAccount{get};var revision:Int64{get};var unlocked:Bool{get}
 // Wallet-selected identities, not the whole Vault. Primary first. Change the
 // revision and notify custody whenever selection, key availability or lock changes.
 var signingAccounts:[NativeAccount]{get}
}
public extension NativeAccountSource {var signingAccounts:[NativeAccount]{[current]}}
enum PermissionJSON {
 static func canonical(_ v:Any?)throws->String {
  guard let v,!(v is NSNull)else{return "null"}
  if let s=v as? String{return String(data:try JSONSerialization.data(withJSONObject:s,options:[.fragmentsAllowed,.withoutEscapingSlashes]),encoding:.utf8)!}
  if let n=v as? NSNumber{if CFGetTypeID(n)==CFBooleanGetTypeID(){return n.boolValue ? "true":"false"};let d=n.doubleValue;try permissionNeed(d.isFinite && d.rounded()==d && abs(d)<=9007199254740991,"PERMISSION_NUMBER");return String(n.int64Value)}
  if let a=v as? [Any]{return "["+(try a.map{try canonical($0)}).joined(separator:",")+"]"}
  if let m=v as? [String:Any]{return "{"+(try m.keys.sorted{$0.utf16.lexicographicallyPrecedes($1.utf16)}.map{try canonical($0)+":"+canonical(m[$0])}).joined(separator:",")+"}"}
  throw PermissionFailure(code:"PERMISSION_JSON")
 }
 static func records(_ raw:String)throws->[[String:Any]]{guard let r=try JSONSerialization.jsonObject(with:Data(raw.utf8)) as? [[String:Any]]else{throw PermissionFailure(code:"PERMISSION_CORRUPT")};return r}
 static func id(_ parts:String...)->String{Data(SHA256.hash(data:Data(parts.joined(separator:"\0").utf8))).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
}
// System SQLite only; no bundled database, key material, transaction journal,
// raw transaction, unlock state or signing permit is written here.
@MainActor final class SystemPermissionBackend:NativePermissionGroupBackend {
 private var db:OpaquePointer?;private let profile:String,chain:String,databasePath:String
 let walletProtocol:NativeWalletProtocol
 init(profile:String,chain:String,directory:URL,walletProtocol:NativeWalletProtocol = .standard)throws{
  self.walletProtocol=walletProtocol
  try permissionNeed(!profile.isEmpty && ["tbc:mainnet","tbc:testnet"].contains(chain),"PERMISSION_SCOPE");self.profile=profile;self.chain=chain
  let path=directory
  try FileManager.default.createDirectory(at:path,withIntermediateDirectories:true)
  // Resolve the existing directory first: Foundation resolves an absent file
  // differently from an existing one (notably /private/tmp versus /tmp).
  databasePath=path.standardizedFileURL.resolvingSymlinksInPath().appendingPathComponent("tbc-kit-permissions.sqlite").path
  try permissionNeed(sqlite3_open_v2(databasePath,&db,SQLITE_OPEN_CREATE|SQLITE_OPEN_READWRITE|SQLITE_OPEN_FULLMUTEX,nil)==SQLITE_OK,"PERMISSION_STORE_UNAVAILABLE")
  try execute("PRAGMA journal_mode=DELETE");try execute("PRAGMA synchronous=FULL")
  try execute("CREATE TABLE IF NOT EXISTS \(walletProtocol.scopesTable)(profile TEXT,chain TEXT,origin TEXT,revision INTEGER NOT NULL,records TEXT NOT NULL,PRIMARY KEY(profile,chain,origin))")
  try execute("CREATE TABLE IF NOT EXISTS \(walletProtocol.commitsTable)(profile TEXT,chain TEXT,call_id TEXT,meaning TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(profile,chain,call_id))")
 }
 func close(){if let db{sqlite3_close(db);self.db=nil}}
 private func statement(_ sql:String,_ values:[Any])throws->OpaquePointer{
  var s:OpaquePointer?;try permissionNeed(sqlite3_prepare_v2(db,sql,-1,&s,nil)==SQLITE_OK,"PERMISSION_STORE_UNAVAILABLE")
  guard let s else{throw PermissionFailure(code:"PERMISSION_STORE_UNAVAILABLE")}
  do{for(i,v)in values.enumerated(){let rc:Int32;if let n=v as? Int64{rc=sqlite3_bind_int64(s,Int32(i+1),n)}else if let text=v as? String{rc=text.withCString{sqlite3_bind_text(s,Int32(i+1),$0,-1,unsafeBitCast(-1,to:sqlite3_destructor_type.self))}}else{throw PermissionFailure(code:"PERMISSION_SQL_TYPE")};try permissionNeed(rc==SQLITE_OK,"PERMISSION_STORE_UNAVAILABLE")};return s}
  catch{sqlite3_finalize(s);throw error}
 }
 private func execute(_ sql:String,_ values:[Any]=[])throws{
  let s=try statement(sql,values);defer{sqlite3_finalize(s)}
  var rc=sqlite3_step(s);while rc==SQLITE_ROW{rc=sqlite3_step(s)};try permissionNeed(rc==SQLITE_DONE,"PERMISSION_STORE_UNAVAILABLE")
 }
 private func text(_ s:OpaquePointer,_ col:Int32)throws->String{guard let p=sqlite3_column_text(s,col)else{throw PermissionFailure(code:"PERMISSION_CORRUPT")};return String(cString:p)}
 func loadAll()throws->[String:PermissionSnapshot]{
  var result=[String:PermissionSnapshot]();let s=try statement("SELECT origin,revision,records FROM \(walletProtocol.scopesTable) WHERE profile=? AND chain=?",[profile,chain]);defer{sqlite3_finalize(s)}
  var rc=sqlite3_step(s);while rc==SQLITE_ROW{result[try text(s,0)]=PermissionSnapshot(revision:sqlite3_column_int64(s,1),records:try PermissionJSON.records(text(s,2)));rc=sqlite3_step(s)};try permissionNeed(rc==SQLITE_DONE,"PERMISSION_STORE_UNAVAILABLE");return result
 }
 private func load(_ origin:String,chain:String)throws->PermissionSnapshot{
  let s=try statement("SELECT revision,records FROM \(walletProtocol.scopesTable) WHERE profile=? AND chain=? AND origin=?",[profile,chain,origin]);defer{sqlite3_finalize(s)};let rc=sqlite3_step(s)
  if rc==SQLITE_DONE{return PermissionSnapshot(revision:0,records:[])};try permissionNeed(rc==SQLITE_ROW,"PERMISSION_STORE_UNAVAILABLE");return PermissionSnapshot(revision:sqlite3_column_int64(s,0),records:try PermissionJSON.records(text(s,1)))
 }
 func commit(origin:String,expected:Int64,records:[[String:Any]],callId:String,meaning:String,fence:()throws->Void)throws->PermissionCommitResult{
  try commitGroup([NativePermissionMutation(backend:self,chainId:chain,origin:origin,expected:expected,records:records,callId:callId,meaning:meaning)],fence:fence)[chain]!
 }
 func acceptsGroup(_ backends:[NativePermissionBackend])->Bool{
  guard db != nil,(1...2).contains(backends.count)else{return false}
  let stores=backends.compactMap{$0 as? SystemPermissionBackend}
  return stores.count==backends.count && Set(stores.map{$0.chain}).count==stores.count && stores.allSatisfy{$0.db != nil && $0.databasePath==databasePath && $0.profile==profile && $0.walletProtocol==walletProtocol}
 }
 func commitGroup(_ mutations:[NativePermissionMutation],fence:()throws->Void)throws->[String:PermissionCommitResult]{
  try permissionNeed(acceptsGroup(mutations.map{$0.backend}) && Set(mutations.map{$0.origin}).count==1 && Set(mutations.map{$0.callId}).count==1 && mutations.allSatisfy{($0.backend as? SystemPermissionBackend)?.chain==$0.chainId},"PERMISSION_GROUP_SCOPE")
  try fence();try execute("BEGIN IMMEDIATE");var committed=false
  defer{if !committed{try? execute("ROLLBACK")}}
  try fence()
  var previous=[String:Int64](),current=[String:PermissionSnapshot](),results=[String:PermissionCommitResult]()
  for m in mutations{
   let s=try statement("SELECT meaning,revision FROM \(walletProtocol.commitsTable) WHERE profile=? AND chain=? AND call_id=?",[profile,m.chainId,m.callId]);defer{sqlite3_finalize(s)}
   let rc=sqlite3_step(s);if rc==SQLITE_ROW{try permissionNeed(text(s,0)==m.meaning,"PERMISSION_CONFLICT");previous[m.chainId]=sqlite3_column_int64(s,1)}else{try permissionNeed(rc==SQLITE_DONE,"PERMISSION_STORE_UNAVAILABLE")}
   current[m.chainId]=try load(m.origin,chain:m.chainId)
  }
  try permissionNeed(previous.isEmpty || previous.count==mutations.count,"PERMISSION_GROUP_PARTIAL")
  for m in mutations{
   let before=current[m.chainId]!
   if let prior=previous[m.chainId]{results[m.chainId]=PermissionCommitResult(acknowledgedRevision:prior,current:before);continue}
   try permissionNeed(m.expected>=0 && m.expected<Int64.max && before.revision==m.expected,"PERMISSION_CONFLICT")
   let next=m.expected+1,serialized=try PermissionJSON.canonical(m.records)
   try execute("INSERT OR REPLACE INTO \(walletProtocol.scopesTable) VALUES(?,?,?,?,?)",[profile,m.chainId,m.origin,next,serialized])
   try execute("INSERT INTO \(walletProtocol.commitsTable) VALUES(?,?,?,?,?)",[profile,m.chainId,m.callId,m.meaning,next])
   results[m.chainId]=PermissionCommitResult(acknowledgedRevision:next,current:PermissionSnapshot(revision:next,records:try PermissionJSON.records(serialized)))
  }
  try fence();try execute("COMMIT");committed=true
  return results
 }
}
struct NativeGrantProposal {let origin:String,expected:Int64,accountRevision:Int64,accountId:String,callId:String,capabilities:[String],records:[[String:Any]],meaning:String;let accounts:[NativeAccount],selection:[NativeAccount];var walletProtocol:NativeWalletProtocol = .standard}
// Created only by custody after reserving the operation and verifying scope.
@MainActor final class NativePermissionGrant {
 let permissions:NativePermissions,proposal:NativeGrantProposal
 let check:()throws->Void,detach:()->Void
 init(permissions:NativePermissions,proposal:NativeGrantProposal,check:@escaping()throws->Void,detach:@escaping()->Void){self.permissions=permissions;self.proposal=proposal;self.check=check;self.detach=detach}
}
@MainActor final class NativePermissions {
 private let accounts:NativeAccountSource,backend:NativePermissionBackend,changed:(String?)->Void
 private let chain:String
 let walletProtocol:NativeWalletProtocol
 private var snapshots:[String:PermissionSnapshot],available=true
 private let allowed:Set<String>=["tbc_accounts","tbc_accountMetadata","tbc_switchChain","tbc_signMessage","tbc_signTypedData","tbc_signTransaction","tbc_sendTransaction","tbc_signWorkflow","tbc_crypto"]
 init(accounts:NativeAccountSource,chain:String,backend:NativePermissionBackend,walletProtocol:NativeWalletProtocol = .standard,changed:@escaping(String?)->Void)throws{
  try permissionNeed(["tbc:mainnet","tbc:testnet"].contains(chain),"PERMISSION_CHAIN")
  try permissionNeed(backend.walletProtocol==walletProtocol,"PERMISSION_PROTOCOL")
  self.walletProtocol=walletProtocol;self.accounts=accounts;self.chain=chain;self.backend=backend;self.changed=changed;snapshots=try backend.loadAll()
 }
 private func snapshot(_ origin:String)->PermissionSnapshot{snapshots[origin] ?? PermissionSnapshot(revision:0,records:[])}
 private func caveat(_ p:[String:Any],_ name:String)throws->Any?{guard let cs=p["caveats"] as? [[String:Any]]else{throw PermissionFailure(code:"PERMISSION_CORRUPT")};try permissionNeed((3...4).contains(cs.count) && cs.allSatisfy{Set($0.keys)==["type","value"] && ["restrictChains","restrictAccounts","restrictMethods","expiresAt"].contains($0["type"] as? String ?? "")} && Set(cs.compactMap{$0["type"] as? String}).count==cs.count,"PERMISSION_CORRUPT");let found=cs.filter{$0["type"] as? String==name};try permissionNeed(found.count<=1,"PERMISSION_CORRUPT");return found.first?["value"]}
 func selectedAccounts()throws->[NativeAccount]{
  let selected=accounts.signingAccounts
  try permissionNeed((1...16).contains(selected.count) && selected.first==accounts.current && selected.allSatisfy{$0.chainId==chain} && Set(selected.map{$0.accountId}).count==selected.count && Set(selected.map{String($0.publicKey.dropFirst(2))}).count==selected.count,"NATIVE_ACCOUNT_SELECTION")
  return selected
 }
 func records(_ origin:String,account:NativeAccount?=nil)throws->[[String:Any]]{
  try permissionNeed(available,"PERMISSION_STORE_UNAVAILABLE");try permissionNeed(accounts.current.chainId==chain,"PERMISSION_CHAIN_CHANGED");if !accounts.unlocked{return []}
  let target=account ?? accounts.current
  if account != nil{try permissionNeed(selectedAccounts().contains(target),"NATIVE_ACCOUNT_SELECTION")}
  return try snapshot(origin).records.filter{p in
   try permissionNeed(Set(p.keys)==["id","parentCapability","invoker","date","caveats"],"PERMISSION_CORRUPT")
   guard let method=p["parentCapability"] as? String else{throw PermissionFailure(code:"PERMISSION_CORRUPT")}
   try permissionNeed(p["invoker"] as? String==origin && allowed.contains(method) && caveat(p,"restrictChains") as? [String]==[accounts.current.chainId] && caveat(p,"restrictMethods") as? [String]==[method],"PERMISSION_CORRUPT")
   guard let ids=try caveat(p,"restrictAccounts") as? [String],(1...16).contains(ids.count),Set(ids).count==ids.count,ids.allSatisfy({$0.hasPrefix(chain+":") && $0.count>chain.count+1}) else{throw PermissionFailure(code:"PERMISSION_CORRUPT")}
   if let value=try caveat(p,"expiresAt"){guard let expiry=value as? String else{throw PermissionFailure(code:"PERMISSION_CORRUPT")};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];var date=f.date(from:expiry);if date==nil{f.formatOptions=[.withInternetDateTime];date=f.date(from:expiry)};try permissionNeed(date != nil,"PERMISSION_CORRUPT");if date!<=Date(){return false}}
   return ids.contains(target.accountId)
  }
 }
 func permits(_ origin:String,_ capability:String,account:NativeAccount?=nil)throws->Bool{try records(origin,account:account).contains{$0["parentCapability"] as? String==capability}}
 func require(_ origin:String,_ capability:String,account:NativeAccount?=nil)throws{try permissionNeed(accounts.unlocked,"NATIVE_LOCKED");try permissionNeed(permits(origin,"tbc_accounts",account:account) && permits(origin,capability,account:account),"NATIVE_PERMISSION")}
 func epoch(_ origin:String)->String{"\(accounts.revision):\(snapshot(origin).revision):\(available)"}
 func proposal(origin:String,request:[String:Any],operationId:String)throws->NativeGrantProposal{
  try permissionNeed(available && accounts.unlocked,"NATIVE_LOCKED");try permissionNeed(accounts.current.chainId==chain,"PERMISSION_CHAIN_CHANGED");try permissionNeed(!request.isEmpty && request.keys.allSatisfy{allowed.contains($0)},"UNSUPPORTED_PERMISSION")
  let capabilities=request.keys.sorted()
  for(capability,value)in request{guard let v=value as? [String:Any]else{throw PermissionFailure(code:"INVALID_PARAMS")};let fields:Set<String>=capability=="tbc_accounts" ? ["chains","maxAccounts"]:["chains"];let maximum=v["maxAccounts"] as? NSNumber;let validMaximum=maximum.map{CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.rounded()==$0.doubleValue && (1...16).contains($0.intValue)} ?? false;try permissionNeed(v.keys.allSatisfy{fields.contains($0)} && v["chains"] as? [String]==[chain] && (v["maxAccounts"]==nil || validMaximum),"INVALID_PARAMS")}
  try permissionNeed(capabilities.contains("tbc_accounts") || permits(origin,"tbc_accounts"),"NATIVE_PERMISSION")
  let before=snapshot(origin),account=accounts.current,now=Int64(floor(Date().timeIntervalSince1970*1000))
  let selection=try selectedAccounts(),granted:[NativeAccount]
  if let requested=request["tbc_accounts"] as? [String:Any]{granted=Array(selection.prefix((requested["maxAccounts"] as? NSNumber)?.intValue ?? 1))}
  else{granted=try selection.filter{try permits(origin,"tbc_accounts",account:$0)}}
  try permissionNeed(granted.contains(account),"NATIVE_PERMISSION")
  var all=before.records.filter{!capabilities.contains($0["parentCapability"] as? String ?? "")}
  for(index,name)in capabilities.enumerated(){all.append(["id":PermissionJSON.id(walletProtocol.permissionDomain,operationId,account.chainId,name,String(index)),"parentCapability":name,"invoker":origin,"date":now,"caveats":[["type":"restrictChains","value":[account.chainId]],["type":"restrictAccounts","value":granted.map{$0.accountId}],["type":"restrictMethods","value":[name]]]])}
  all.sort{($0["parentCapability"] as! String)<($1["parentCapability"] as! String)}
  let records=try PermissionJSON.records(PermissionJSON.canonical(all)),meaning=try PermissionJSON.canonical(["origin":origin,"chainId":account.chainId,"expected":before.revision,"records":records])
  return NativeGrantProposal(origin:origin,expected:before.revision,accountRevision:accounts.revision,accountId:account.accountId,callId:operationId,capabilities:capabilities,records:records,meaning:meaning,accounts:granted,selection:selection,walletProtocol:walletProtocol)
 }
 func approve(_ proposal:NativeGrantProposal,fence:()throws->Void)throws->[[String:Any]]{
  func current()throws{try fence();try permissionNeed(proposal.walletProtocol==walletProtocol,"PERMISSION_PROTOCOL");try permissionNeed(available && accounts.unlocked && accounts.revision==proposal.accountRevision && accounts.current.accountId==proposal.accountId && selectedAccounts()==proposal.selection,"NATIVE_REVISION_CHANGED")}
  try current()
  do{let r=try backend.commit(origin:proposal.origin,expected:proposal.expected,records:proposal.records,callId:proposal.callId,meaning:proposal.meaning,fence:current);snapshots[proposal.origin]=r.current;changed(proposal.origin);return try records(proposal.origin).filter{proposal.capabilities.contains($0["parentCapability"] as? String ?? "")}}
  catch{available=false;changed(nil);throw error}
 }
 private func checkProposal(_ p:NativeGrantProposal)throws{
  try permissionNeed(p.walletProtocol==walletProtocol,"PERMISSION_PROTOCOL")
  try permissionNeed(available && accounts.unlocked && accounts.revision==p.accountRevision && accounts.current.accountId==p.accountId && selectedAccounts()==p.selection && snapshot(p.origin).revision==p.expected && p.expected>=0 && p.expected<Int64.max,"NATIVE_REVISION_CHANGED")
 }
 static func groupBackend(_ grants:[NativePermissionGrant])throws->NativePermissionGroupBackend{
  try permissionNeed(grants.count==2 && Set(grants.map{$0.permissions.chain}).count==grants.count && Set(grants.map{$0.permissions.walletProtocol}).count==1,"PERMISSION_GROUP_SCOPE")
  guard let group=grants.first?.permissions.backend as? NativePermissionGroupBackend,group.acceptsGroup(grants.map{$0.permissions.backend})else{throw PermissionFailure(code:"PERMISSION_GROUP_UNAVAILABLE")};return group
 }
 static func approveGroup(_ grants:[NativePermissionGrant],fence:()throws->Void)throws->[[String:Any]]{
  let backend=try groupBackend(grants)
  func current()throws{try fence();for g in grants{try g.check();try g.permissions.checkProposal(g.proposal)}}
  try current()
  let meaning=try PermissionJSON.canonical(["kind":"TWS/permission-group","members":grants.map{["chainId":$0.permissions.chain,"meaning":$0.proposal.meaning]}])
  let mutations=grants.map{g in let p=g.proposal;return NativePermissionMutation(backend:g.permissions.backend,chainId:g.permissions.chain,origin:p.origin,expected:p.expected,records:p.records,callId:p.callId,meaning:meaning)}
  for g in grants{g.detach()}
  do{
   let results=try backend.commitGroup(mutations,fence:current)
   try current()
   try permissionNeed(Set(results.keys)==Set(mutations.map{$0.chainId}),"PERMISSION_GROUP_RESULT")
   for g in grants{let p=g.proposal,r=results[g.permissions.chain]!
    try permissionNeed(r.acknowledgedRevision==p.expected+1 && r.current.revision==p.expected+1 && PermissionJSON.canonical(r.current.records)==PermissionJSON.canonical(p.records),"PERMISSION_GROUP_RESULT")
   }
   // Install every committed cache before any observer can see the new grants.
   for g in grants{g.permissions.snapshots[g.proposal.origin]=results[g.permissions.chain]!.current}
   for g in grants{g.permissions.changed(g.proposal.origin)}
   return try grants.flatMap{g in try g.permissions.records(g.proposal.origin).filter{g.proposal.capabilities.contains($0["parentCapability"] as? String ?? "")}}
  }catch{for g in grants{g.permissions.available=false};for g in grants{g.permissions.changed(nil)};throw error}
 }
 func revoke(_ origin:String,callId:String,fence:()throws->Void)throws{
  changed(origin);let before=snapshot(origin)
  do{let r=try backend.commit(origin:origin,expected:before.revision,records:[],callId:callId,meaning:PermissionJSON.canonical(["origin":origin,"revision":before.revision,"revoke":true]),fence:fence);snapshots[origin]=r.current}
  catch{available=false;changed(nil);throw error}
 }
}
