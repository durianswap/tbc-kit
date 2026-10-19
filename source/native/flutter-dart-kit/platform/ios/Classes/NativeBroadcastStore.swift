// Wallet-private system SQLite. Not a signing store, raw transaction queue,
// background sender or general recovery executor. No page/MethodChannel API.
import Foundation
import SQLite3
import CryptoKit

struct BroadcastStoreFailure:Error { let code:String }
private func broadcastNeed(_ condition:Bool,_ code:String)throws {
  if !condition { throw BroadcastStoreFailure(code:code) }
}
struct NativeBroadcastIdentity:Equatable {
  let idempotencyKey:String,rawHash:String,txid:String,submitContextHash:String,accountScopeHash:String
  var fields:[String] {[idempotencyKey,rawHash,txid,submitContextHash,accountScopeHash]}
  var digest:String {Data(SHA256.hash(data:Data(fields.joined(separator:"\0").utf8))).map{String(format:"%02x",$0)}.joined()}
  func validate(source:String,account:String)throws {
    try broadcastNeed(idempotencyKey.range(of:"^[A-Za-z0-9:._-]{1,256}$",options:.regularExpression) != nil &&
      idempotencyKey.hasPrefix("tbcnet-"+source.prefix(24)+"-") &&
      fields.dropFirst().allSatisfy{$0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil} &&
      accountScopeHash==account,"BROADCAST_IDENTITY")
  }
}
struct NativeBroadcastRecord {
  let identity:NativeBroadcastIdentity,state:String,createdAt:String,resultStatus:String?,abortCode:String?
  // Node-provided error text may reflect raw bytes/preimages. Persist only a
  // status and fixed local code, and reconstruct redacted stable descriptions.
  var result:[String:String]? {
    guard let resultStatus else{return nil}
    var value=["txid":identity.txid,"status":resultStatus]
    if resultStatus=="rejected" {value["reason"]=state=="not-submitted" ? "TBC transaction was not submitted":"TBC transaction rejected"}
    return value
  }
}
struct NativeBroadcastReservation {let created:Bool,records:[NativeBroadcastRecord?]}
// Process-local, one-use native ticket. Never serialize to Dart or a page.
final class NativeBroadcastAdmission {fileprivate init(){}}

@MainActor final class SystemBroadcastStore {
  private var db:OpaquePointer?
  private var admissions=[ObjectIdentifier:(NativeBroadcastAdmission,[NativeBroadcastIdentity])] ()
  let profile:String,sourceIdentity:String,accountScopeHash:String
  init(directory:URL,profile:String,sourceIdentity:String,accountScopeHash:String)throws {
    try broadcastNeed(profile.range(of:"^[A-Za-z0-9:._-]{1,128}$",options:.regularExpression) != nil &&
      [sourceIdentity,accountScopeHash].allSatisfy{$0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil},"BROADCAST_STORE_SCOPE")
    self.profile=profile;self.sourceIdentity=sourceIdentity;self.accountScopeHash=accountScopeHash
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    let file=directory.appendingPathComponent("tbc-kit-broadcast.sqlite")
    do {
      try broadcastNeed(sqlite3_open_v2(file.path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_FULLMUTEX,nil)==SQLITE_OK,"BROADCAST_STORE_UNAVAILABLE")
      sqlite3_busy_timeout(db,3000)
      try execute("PRAGMA journal_mode=DELETE");try execute("PRAGMA synchronous=FULL")
      try execute("CREATE TABLE IF NOT EXISTS broadcast_intents(profile TEXT NOT NULL,source TEXT NOT NULL,key TEXT NOT NULL,raw_hash TEXT NOT NULL,txid TEXT NOT NULL,context_hash TEXT NOT NULL,account_scope TEXT NOT NULL,identity_digest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,result_status TEXT,abort_code TEXT,PRIMARY KEY(profile,source,key))")
      try execute("CREATE UNIQUE INDEX IF NOT EXISTS broadcast_active_tx ON broadcast_intents(profile,source,txid) WHERE state!='not-submitted'")
      try execute("CREATE UNIQUE INDEX IF NOT EXISTS broadcast_active_raw ON broadcast_intents(profile,source,raw_hash) WHERE state!='not-submitted'")
      try execute("CREATE TABLE IF NOT EXISTS broadcast_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,profile TEXT NOT NULL,source TEXT NOT NULL,key TEXT NOT NULL,identity_digest TEXT NOT NULL,action TEXT NOT NULL,code TEXT NOT NULL,recorded_at TEXT NOT NULL)")
      try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
    } catch {close();throw error}
  }
  func close(){admissions.removeAll();if let db{sqlite3_close(db);self.db=nil}}
  private func now()->String {let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f.string(from:Date())}
  private func statement(_ sql:String,_ values:[String]=[])throws->OpaquePointer {
    try broadcastNeed(db != nil,"BROADCAST_STORE_CLOSED")
    var stmt:OpaquePointer?
    try broadcastNeed(sqlite3_prepare_v2(db,sql,-1,&stmt,nil)==SQLITE_OK,"BROADCAST_STORE_UNAVAILABLE")
    guard let stmt else {throw BroadcastStoreFailure(code:"BROADCAST_STORE_UNAVAILABLE")}
    do {for(i,v) in values.enumerated(){let code=v.withCString{sqlite3_bind_text(stmt,Int32(i+1),$0,-1,unsafeBitCast(-1,to:sqlite3_destructor_type.self))};try broadcastNeed(code==SQLITE_OK,"BROADCAST_STORE_UNAVAILABLE")};return stmt}
    catch {sqlite3_finalize(stmt);throw error}
  }
  private func execute(_ sql:String,_ values:[String]=[])throws {
    let stmt=try statement(sql,values);defer{sqlite3_finalize(stmt)}
    var code=sqlite3_step(stmt);while code==SQLITE_ROW {code=sqlite3_step(stmt)}
    try broadcastNeed(code==SQLITE_DONE,"BROADCAST_STORE_CONFLICT_OR_UNAVAILABLE")
  }
  private func text(_ stmt:OpaquePointer,_ column:Int32)throws->String {
    guard let value=sqlite3_column_text(stmt,column) else{throw BroadcastStoreFailure(code:"BROADCAST_STORE_CORRUPT")}
    return String(cString:value)
  }
  private func decode(_ stmt:OpaquePointer)throws->NativeBroadcastRecord {
    let id=try NativeBroadcastIdentity(idempotencyKey:text(stmt,0),rawHash:text(stmt,1),txid:text(stmt,2),submitContextHash:text(stmt,3),accountScopeHash:text(stmt,4))
    try id.validate(source:sourceIdentity,account:accountScopeHash)
    let digest=try text(stmt,5),state=try text(stmt,6),created=try text(stmt,7)
    let result=sqlite3_column_type(stmt,8)==SQLITE_NULL ? nil:try text(stmt,8)
    let aborted=sqlite3_column_type(stmt,9)==SQLITE_NULL ? nil:try text(stmt,9)
    try broadcastNeed(digest==id.digest && ["prepared","uncertain","completed","not-submitted"].contains(state),"BROADCAST_STORE_CORRUPT")
    try broadcastNeed((state=="completed" && ["accepted","known","rejected"].contains(result ?? "") && aborted==nil) ||
      (state=="not-submitted" && result=="rejected" && Self.abortCodes.contains(aborted ?? "")) ||
      (["prepared","uncertain"].contains(state) && result==nil && aborted==nil),"BROADCAST_STORE_CORRUPT")
    return NativeBroadcastRecord(identity:id,state:state,createdAt:created,resultStatus:result,abortCode:aborted)
  }
  private let columns="key,raw_hash,txid,context_hash,account_scope,identity_digest,state,created_at,result_status,abort_code"
  func read(_ key:String)throws->NativeBroadcastRecord? {
    let stmt=try statement("SELECT \(columns) FROM broadcast_intents WHERE profile=? AND source=? AND key=?",[profile,sourceIdentity,key]);defer{sqlite3_finalize(stmt)}
    let code=sqlite3_step(stmt);if code==SQLITE_DONE{return nil};try broadcastNeed(code==SQLITE_ROW,"BROADCAST_STORE_UNAVAILABLE");return try decode(stmt)
  }
  func readByTxids(_ ids:[String])throws->[NativeBroadcastRecord] {
    try broadcastNeed(!ids.isEmpty && ids.count<=32 && Set(ids).count==ids.count && ids.allSatisfy{$0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil},"BROADCAST_LOOKUP")
    let placeholders=Array(repeating:"?",count:ids.count).joined(separator:",")
    // Historical not-submitted rows stay auditable but must not shadow a later
    // authorized submission of the same exact transaction in status recovery.
    let stmt=try statement("SELECT \(columns) FROM broadcast_intents WHERE profile=? AND source=? AND account_scope=? AND state!='not-submitted' AND txid IN (\(placeholders)) ORDER BY created_at,key",[profile,sourceIdentity,accountScopeHash]+ids);defer{sqlite3_finalize(stmt)}
    var result=[NativeBroadcastRecord](),code=sqlite3_step(stmt)
    while code==SQLITE_ROW {result.append(try decode(stmt));code=sqlite3_step(stmt)}
    try broadcastNeed(code==SQLITE_DONE,"BROADCAST_STORE_UNAVAILABLE");return result
  }
  private func transaction<T>(_ fence:()throws->Void,_ body:()throws->T)throws->T {
    try fence();try execute("BEGIN IMMEDIATE");var committed=false
    defer{if !committed{try? execute("ROLLBACK")}}
    try fence();let result=try body();try fence();try execute("COMMIT");committed=true;return result
  }
  private func audit(_ id:NativeBroadcastIdentity,_ action:String,_ code:String="")throws {
    try execute("INSERT INTO broadcast_audit(profile,source,key,identity_digest,action,code,recorded_at) VALUES(?,?,?,?,?,?,?)",[profile,sourceIdentity,id.idempotencyKey,id.digest,action,code,now()])
  }
  private func checked(_ id:NativeBroadcastIdentity)throws->NativeBroadcastRecord {
    try id.validate(source:sourceIdentity,account:accountScopeHash)
    guard let row=try read(id.idempotencyKey),row.identity==id else{throw BroadcastStoreFailure(code:"BROADCAST_IDENTITY_CONFLICT")};return row
  }
  func begin(_ ids:[NativeBroadcastIdentity],fence:()throws->Void)throws->NativeBroadcastReservation {
    try broadcastNeed(!ids.isEmpty && ids.count<=32 && Set(ids.map{$0.idempotencyKey}).count==ids.count && Set(ids.map{$0.txid}).count==ids.count && Set(ids.map{$0.rawHash}).count==ids.count,"BROADCAST_BATCH")
    for id in ids{try id.validate(source:sourceIdentity,account:accountScopeHash)}
    return try transaction(fence){
      let existing=try ids.map{try read($0.idempotencyKey)}
      for(i,row)in existing.enumerated(){if let row{try broadcastNeed(row.identity==ids[i],"BROADCAST_IDENTITY_CONFLICT")}}
      if existing.contains(where:{$0 != nil}){return NativeBroadcastReservation(created:false,records:existing)}
      for id in ids{
        try execute("INSERT INTO broadcast_intents VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)",[profile,sourceIdentity]+id.fields+[id.digest,"prepared",now()])
        try audit(id,"prepared")
      }
      return NativeBroadcastReservation(created:true,records:try ids.map{try read($0.idempotencyKey)})
    }
  }
  // Atomic for a whole batch; native dispatcher must invoke this immediately
  // before transport admission. This alone is not permission to send.
  func markUncertain(_ ids:[NativeBroadcastIdentity],fence:()throws->Void)throws {
    try broadcastNeed(!ids.isEmpty && ids.count<=32 && Set(ids.map{$0.idempotencyKey}).count==ids.count,"BROADCAST_BATCH")
    try transaction(fence){for id in ids{
      let row=try checked(id);try broadcastNeed(["prepared","uncertain"].contains(row.state),"BROADCAST_STATE")
      if row.state=="prepared" {try execute("UPDATE broadcast_intents SET state='uncertain' WHERE profile=? AND source=? AND key=?",[profile,sourceIdentity,id.idempotencyKey]);try audit(id,"uncertain")}
    }}
  }
  func complete(_ id:NativeBroadcastIdentity,status:String,fence:()throws->Void)throws {
    try broadcastNeed(["accepted","known","rejected"].contains(status),"BROADCAST_RESULT")
    try transaction(fence){let row=try checked(id)
      if row.state=="completed" {try broadcastNeed(row.resultStatus==status,"BROADCAST_RESULT_CONFLICT");return}
      try broadcastNeed(["prepared","uncertain"].contains(row.state),"BROADCAST_STATE")
      try execute("UPDATE broadcast_intents SET state='completed',result_status=? WHERE profile=? AND source=? AND key=?",[status,profile,sourceIdentity,id.idempotencyKey]);try audit(id,"completed",status)
    }
  }
  private static let abortCodes:Set<String>=["INVALID_INPUT","NODE_RESPONSE_INVALID","CANCELLED","AUTHORITY_CHANGED","EXPIRED","DISPATCH_CANCELLED"]
  func abortPrepared(_ ids:[NativeBroadcastIdentity],code:String,fence:()throws->Void)throws {
    try broadcastNeed(Self.abortCodes.contains(code) && !ids.isEmpty && ids.count<=32 && Set(ids.map{$0.idempotencyKey}).count==ids.count,"BROADCAST_ABORT")
    try transaction(fence){for id in ids{
      let row=try checked(id)
      if row.state=="not-submitted" {try broadcastNeed(row.abortCode==code,"BROADCAST_ABORT_CONFLICT");continue}
      // Do not accept a caller claim of POST=0 after transport admission.
      try broadcastNeed(row.state=="prepared","BROADCAST_ABORT_AFTER_DISPATCH")
      try execute("UPDATE broadcast_intents SET state='not-submitted',result_status='rejected',abort_code=? WHERE profile=? AND source=? AND key=?",[code,profile,sourceIdentity,id.idempotencyKey]);try audit(id,"not-submitted",code)
    }}
  }
  // The native owner retains this ticket between Dart's journal call and the
  // actual native HTTP call. Replay/unknown rows cannot mint another ticket.
  func admitDispatch(_ ids:[NativeBroadcastIdentity],fence:()throws->Void)throws->NativeBroadcastAdmission {
    try broadcastNeed(!ids.isEmpty && ids.count<=32 && Set(ids.map{$0.idempotencyKey}).count==ids.count,"BROADCAST_BATCH")
    try transaction(fence){for id in ids {
      try broadcastNeed(checked(id).state=="prepared","BROADCAST_ALREADY_ADMITTED")
      try execute("UPDATE broadcast_intents SET state='uncertain' WHERE profile=? AND source=? AND key=?",[profile,sourceIdentity,id.idempotencyKey]);try audit(id,"uncertain")
    }}
    let ticket=NativeBroadcastAdmission();admissions[ObjectIdentifier(ticket)]=(ticket,ids);return ticket
  }
  private func take(_ ticket:NativeBroadcastAdmission)throws->[NativeBroadcastIdentity] {
    guard let entry=admissions.removeValue(forKey:ObjectIdentifier(ticket)),entry.0===ticket else{throw BroadcastStoreFailure(code:"BROADCAST_ADMISSION_CONSUMED")};return entry.1
  }
  // No caller-supplied POST counter is accepted. This private transition is
  // reachable only by consuming our still-unstarted in-process native ticket.
  private func abortUnstarted(_ ids:[NativeBroadcastIdentity])throws {
    try transaction({}){for id in ids {
      try broadcastNeed(checked(id).state=="uncertain","BROADCAST_ADMISSION_STATE")
      try execute("UPDATE broadcast_intents SET state='not-submitted',result_status='rejected',abort_code='DISPATCH_CANCELLED' WHERE profile=? AND source=? AND key=?",[profile,sourceIdentity,id.idempotencyKey]);try audit(id,"not-submitted","DISPATCH_CANCELLED")
    }}
  }
  func cancelAdmission(_ ticket:NativeBroadcastAdmission)throws {try abortUnstarted(take(ticket))}
  // Called on the SAME native serial executor as authority changes. There is
  // no await between the fresh fence and start(). start must enqueue exactly
  // one request synchronously. Any throw after entering start is unknown.
  func startAdmission<T>(_ ticket:NativeBroadcastAdmission,fence:()throws->Void,start:()throws->T)throws->T {
    let ids=try take(ticket)
    do {try fence();for id in ids{try broadcastNeed(checked(id).state=="uncertain","BROADCAST_ADMISSION_STATE")}}
    catch {try? abortUnstarted(ids);throw error}
    return try start()
  }
}
