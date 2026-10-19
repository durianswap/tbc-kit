// Public synthetic identities; real system SQLite, no network or Vault.
import Foundation
import SQLite3

@main private struct BroadcastStoreCheck {
  @MainActor static var checks=0
  @MainActor static var cases=[String]()
  @MainActor static func yes(_ condition:Bool){precondition(condition,"check \(checks+1)");checks+=1}
  @MainActor static func rejects(_ block:()throws->Void){var failed=false;do{try block()}catch{failed=true};yes(failed)}
  @MainActor static func done(_ name:String){cases.append(name)}
  @MainActor static func main()throws {
    let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
    let sample=(fixture["cases"] as! [[String:Any]]).first{$0["name"] as? String=="batch-accepted-replay"}!
    let source=sample["sourceIdentity"] as! String,rows=sample["records"] as! [[String:Any]]
    func identity(_ r:[String:Any])->NativeBroadcastIdentity{NativeBroadcastIdentity(idempotencyKey:r["idempotencyKey"] as! String,rawHash:r["rawHash"] as! String,txid:r["txid"] as! String,submitContextHash:r["submitContextHash"] as! String,accountScopeHash:r["accountScopeHash"] as! String)}
    let a=identity(rows[0]),b=identity(rows[1]),root=URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
    func id(_ tag:String,_ number:Int)->NativeBroadcastIdentity {
      NativeBroadcastIdentity(idempotencyKey:a.idempotencyKey+"-"+tag,rawHash:String(format:"%064x",number),txid:String(format:"%064x",number+100),submitContextHash:a.submitContextHash,accountScopeHash:a.accountScopeHash)
    }
    func renamed(_ original:NativeBroadcastIdentity,_ tag:String)->NativeBroadcastIdentity {
      NativeBroadcastIdentity(idempotencyKey:original.idempotencyKey+"-"+tag,rawHash:original.rawHash,txid:original.txid,submitContextHash:original.submitContextHash,accountScopeHash:original.accountScopeHash)
    }
    func store(_ profile:String="test",_ account:String?=nil,_ sourceValue:String?=nil)throws->SystemBroadcastStore {
      try SystemBroadcastStore(directory:root,profile:profile,sourceIdentity:sourceValue ?? source,accountScopeHash:account ?? a.accountScopeHash)
    }
    if CommandLine.arguments.count>3 {
      let s=try store("crash")
      if CommandLine.arguments[3]=="seed-crash" {
        _ = try s.begin([a,b]){};_ = try s.admitDispatch([a,b]){}
        FileHandle.standardOutput.write(Data("{\"status\":\"CRASH_SEEDED\"}\n".utf8));_exit(0)
      }
      yes(try s.read(a.idempotencyKey)?.state=="uncertain");yes(try s.read(b.idempotencyKey)?.state=="uncertain")
      yes(try !s.begin([a,b]){}.created)
      rejects{_ = try s.admitDispatch([a,b]){}}
      try s.complete(a,status:"known"){};yes(try s.read(a.idempotencyKey)?.resultStatus=="known")
      yes(try s.read(b.idempotencyKey)?.state=="uncertain");s.close()
      print("{\"status\":\"CRASH_REOPEN_PASS\",\"checks\":\(checks)}");return
    }
    var s=try store()
    let first=try s.begin([a,b]){};yes(first.created && first.records.count==2 && first.records.allSatisfy{$0?.state=="prepared"})
    yes(first.records[0]?.identity==a && first.records[1]?.identity==b);done("frozen-identities-batch-atomic")
    yes(try !s.begin([a,b]){}.created);done("same-request-replay")
    let third=id("partial",3),partial=try s.begin([a,third]){}
    yes(!partial.created && partial.records[0] != nil && partial.records[1]==nil);yes(try s.read(third.idempotencyKey)==nil);done("partial-existing-does-not-insert")
    rejects{_ = try s.begin([renamed(a,"conflict")]){}};done("active-txid-raw-collision")
    let changed=NativeBroadcastIdentity(idempotencyKey:a.idempotencyKey,rawHash:a.rawHash,txid:a.txid,submitContextHash:String(repeating:"f",count:64),accountScopeHash:a.accountScopeHash)
    rejects{_ = try s.begin([changed]){}};done("same-key-different-context")
    var calls=0
    rejects{try s.markUncertain([a,b]){calls+=1;if calls==3{throw BroadcastStoreFailure(code:"TEST_CANCEL")}}}
    yes(try s.read(a.idempotencyKey)?.state=="prepared" && s.read(b.idempotencyKey)?.state=="prepared");done("batch-uncertainty-fence-rollback")
    try s.markUncertain([a,b]){};try s.markUncertain([a,b]){}
    s.close();s=try store();yes(try s.read(a.idempotencyKey)?.state=="uncertain" && s.read(b.idempotencyKey)?.state=="uncertain");done("uncertainty-survives-reopen")
    rejects{try s.abortPrepared([a],code:"CANCELLED"){}};yes(try s.read(a.idempotencyKey)?.state=="uncertain");done("cannot-abort-uncertain-by-assertion")
    try s.complete(a,status:"accepted"){};try s.complete(a,status:"accepted"){}
    rejects{try s.complete(a,status:"rejected"){}};done("result-idempotency-no-contradiction")
    calls=0;rejects{try s.complete(b,status:"known"){calls+=1;if calls==3{throw BroadcastStoreFailure(code:"TEST_CANCEL")}}}
    yes(try s.read(b.idempotencyKey)?.state=="uncertain");done("result-commit-fence-rollback")
    try s.complete(b,status:"known"){};s.close();s=try store()
    yes(try s.read(a.idempotencyKey)?.resultStatus=="accepted" && s.read(b.idempotencyKey)?.resultStatus=="known");done("results-survive-reopen")
    let aborted=id("aborted",4);_ = try s.begin([aborted]){};try s.abortPrepared([aborted],code:"INVALID_INPUT"){};try s.abortPrepared([aborted],code:"INVALID_INPUT"){}
    yes(try s.read(aborted.idempotencyKey)?.state=="not-submitted");rejects{try s.markUncertain([aborted]){}};rejects{try s.complete(aborted,status:"accepted"){}};done("pre-network-abort-terminal-auditable")
    let fresh=renamed(aborted,"fresh");yes(try s.begin([fresh]){}.created);yes(try s.read(aborted.idempotencyKey)?.state=="not-submitted")
    try s.markUncertain([fresh]){};let active=try s.readByTxids([fresh.txid]);yes(active.count==1 && active[0].identity==fresh);done("fresh-approval-identity-release-no-shadow")
    let rollback=id("rollback",5);calls=0
    rejects{_ = try s.begin([rollback]){calls+=1;if calls==3{throw BroadcastStoreFailure(code:"TEST_CANCEL")}}}
    yes(try s.read(rollback.idempotencyKey)==nil);done("begin-fence-rollback")
    let second=try store();rejects{_ = try second.begin([renamed(fresh,"race")]){}};second.close();done("independent-handle-active-collision")
    let otherAccount=try store("test",String(repeating:"2",count:64))
    rejects{_ = try otherAccount.read(a.idempotencyKey)};yes(try otherAccount.readByTxids([a.txid]).isEmpty);otherAccount.close();done("account-isolation")
    let otherSource=try store("test",nil,String(repeating:"3",count:64));yes(try otherSource.read(a.idempotencyKey)==nil);rejects{_ = try otherSource.begin([a]){}};otherSource.close();done("network-source-isolation")
    let otherProfile=try store("other");yes(try otherProfile.begin([a]){}.created);otherProfile.close();done("wallet-profile-isolation")
    rejects{_ = try s.begin([a,a]){}};rejects{_ = try s.begin([]){}};rejects{_ = try s.readByTxids(["bad"])};done("bounded-unique-inputs")
    let secret="PRIVATE_TEST_SECRET_SENTINEL";rejects{try s.abortPrepared([fresh],code:secret){}};done("no-arbitrary-error-persistence")
    let terminal=id("terminal",6);_ = try s.begin([terminal]){};try s.complete(terminal,status:"rejected"){}
    yes(try s.read(terminal.idempotencyKey)?.result?["reason"]=="TBC transaction rejected");done("redacted-rejected-result")
    let cancelledA=id("cancel-a",8),cancelledB=id("cancel-b",9);_ = try s.begin([cancelledA,cancelledB]){}
    let cancelled=try s.admitDispatch([cancelledA,cancelledB]){};var starts=0
    rejects{_ = try s.startAdmission(cancelled,fence:{throw BroadcastStoreFailure(code:"TEST_REVOKED")},start:{starts+=1})}
    yes(starts==0);yes(try s.read(cancelledA.idempotencyKey)?.state=="not-submitted" && s.read(cancelledB.idempotencyKey)?.state=="not-submitted");done("revoked-admission-before-dispatch-aborts-batch")
    rejects{try s.cancelAdmission(cancelled)};rejects{_ = try s.startAdmission(cancelled,fence:{},start:{starts+=1})};yes(starts==0);done("consumed-admission-cannot-start")
    let freshCancel=renamed(cancelledA,"retry");yes(try s.begin([freshCancel]){}.created);done("cancelled-before-dispatch-releases-identity")
    let explicit=id("explicit",10);_ = try s.begin([explicit]){};let explicitTicket=try s.admitDispatch([explicit]){};try s.cancelAdmission(explicitTicket)
    yes(try s.read(explicit.idempotencyKey)?.abortCode=="DISPATCH_CANCELLED");done("native-cancel-unstarted-ticket")
    let thrown=id("throw-after-start",11);_ = try s.begin([thrown]){};let thrownTicket=try s.admitDispatch([thrown]){}
    rejects{_ = try s.startAdmission(thrownTicket,fence:{},start:{starts+=1;throw BroadcastStoreFailure(code:"TEST_TRANSPORT")})}
    yes(try starts==1 && s.read(thrown.idempotencyKey)?.state=="uncertain");rejects{try s.cancelAdmission(thrownTicket)};rejects{_ = try s.admitDispatch([thrown]){}};done("transport-entry-throw-remains-unknown-no-retry")
    let success=id("success-start",12);_ = try s.begin([success]){};let successTicket=try s.admitDispatch([success]){}
    yes(try s.startAdmission(successTicket,fence:{},start:{starts+=1;return "submitted"})=="submitted")
    rejects{_ = try s.startAdmission(successTicket,fence:{},start:{starts+=1})};yes(starts==2);done("native-dispatch-enqueues-once")
    let failAdmit=id("fail-admit",13);_ = try s.begin([failAdmit]){};calls=0
    rejects{_ = try s.admitDispatch([failAdmit]){calls+=1;if calls==3{throw BroadcastStoreFailure(code:"TEST_REVOKED")}}}
    yes(try s.read(failAdmit.idempotencyKey)?.state=="prepared");done("admission-final-fence-rolls-back")
    let foreign=try store("foreign"),foreignId=id("foreign",14);_ = try foreign.begin([foreignId]){};let foreignTicket=try foreign.admitDispatch([foreignId]){}
    rejects{_ = try s.startAdmission(foreignTicket,fence:{},start:{starts+=1})};yes(starts==2);try foreign.cancelAdmission(foreignTicket);foreign.close();done("foreign-ticket-cannot-dispatch")
    let corrupt=id("corrupt",7);_ = try s.begin([corrupt]){};s.close()
    var db:OpaquePointer?;yes(sqlite3_open(root.appendingPathComponent("tbc-kit-broadcast.sqlite").path,&db)==SQLITE_OK)
    let sql="UPDATE broadcast_intents SET identity_digest='corrupt' WHERE key='\(corrupt.idempotencyKey)'"
    yes(sqlite3_exec(db,sql,nil,nil,nil)==SQLITE_OK);sqlite3_close(db)
    s=try store();rejects{_ = try s.read(corrupt.idempotencyKey)};done("corrupt-identity-rejected")
    s.close();rejects{_ = try s.read(a.idempotencyKey)};done("closed-store-fails")
    let data=try Data(contentsOf:root.appendingPathComponent("tbc-kit-broadcast.sqlite"))
    yes(data.range(of:Data(secret.utf8))==nil);done("secret-sentinel-not-on-disk")
    let result:[String:Any]=["status":"PASS","checks":checks,"cases":cases,"identityDigests":[a.digest,b.digest],"networkRequests":0]
    print(String(data:try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!)
  }
}
