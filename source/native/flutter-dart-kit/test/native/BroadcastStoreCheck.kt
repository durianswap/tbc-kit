package io.tbc.kit.dart
// Runs with Android's real SQLite through a TEST-only app_process harness.
// Public identities only; no network, wallet App, signing or approval.
import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.json.JSONObject

private var checks=0
private val cases=mutableListOf<String>()
private fun yes(value:Boolean){check(value){"check ${checks+1}"};checks++}
private fun rejects(block:()->Unit){var failed=false;try{block()}catch(e:Exception){failed=true};yes(failed)}
private fun done(name:String){cases.add(name)}
fun main(args:Array<String>) {
  val fixture=JSONObject(File(args[0]).readText());val samples=fixture.getJSONArray("cases")
  val sample=(0 until samples.length()).map{samples.getJSONObject(it)}.first{it.getString("name")=="batch-accepted-replay"}
  val source=sample.getString("sourceIdentity");val rows=sample.getJSONArray("records")
  fun identity(r:JSONObject)=NativeBroadcastIdentity(r.getString("idempotencyKey"),r.getString("rawHash"),r.getString("txid"),r.getString("submitContextHash"),r.getString("accountScopeHash"))
  val a=identity(rows.getJSONObject(0));val b=identity(rows.getJSONObject(1));val root=File(args[1])
  fun id(tag:String,number:Int)=NativeBroadcastIdentity(a.idempotencyKey+"-"+tag,"%064x".format(number),"%064x".format(number+100),a.submitContextHash,a.accountScopeHash)
  fun renamed(original:NativeBroadcastIdentity,tag:String)=original.copy(idempotencyKey=original.idempotencyKey+"-"+tag)
  fun store(profile:String="test",account:String=a.accountScopeHash,sourceValue:String=source)=SystemBroadcastStore(root,profile,sourceValue,account)
  if(args.size>2) {
    val s=store("crash")
    if(args[2]=="seed-crash") {
      s.begin(listOf(a,b)){};s.admitDispatch(listOf(a,b)){}
      println("{\"status\":\"CRASH_SEEDED\"}");System.out.flush();Runtime.getRuntime().halt(0)
    }
    yes(s.read(a.idempotencyKey)?.state=="uncertain");yes(s.read(b.idempotencyKey)?.state=="uncertain")
    yes(!s.begin(listOf(a,b)){}.created)
    rejects{s.admitDispatch(listOf(a,b)) {}}
    s.complete(a,"known"){};yes(s.read(a.idempotencyKey)?.resultStatus=="known")
    yes(s.read(b.idempotencyKey)?.state=="uncertain");s.close()
    println(JSONObject(mapOf("status" to "CRASH_REOPEN_PASS","checks" to checks)));return
  }
  var s=store()
  val first=s.begin(listOf(a,b)){};yes(first.created&&first.records.size==2&&first.records.all{it?.state=="prepared"})
  yes(first.records[0]?.identity==a&&first.records[1]?.identity==b);done("frozen-identities-batch-atomic")
  yes(!s.begin(listOf(a,b)){}.created);done("same-request-replay")
  val third=id("partial",3);val partial=s.begin(listOf(a,third)){}
  yes(!partial.created&&partial.records[0]!=null&&partial.records[1]==null);yes(s.read(third.idempotencyKey)==null);done("partial-existing-does-not-insert")
  rejects{s.begin(listOf(renamed(a,"conflict"))) {}};done("active-txid-raw-collision")
  val changed=a.copy(submitContextHash="f".repeat(64))
  rejects{s.begin(listOf(changed)) {}};done("same-key-different-context")
  var calls=0
  rejects{s.markUncertain(listOf(a,b)){calls++;check(calls!=3){"TEST_CANCEL"}}}
  yes(s.read(a.idempotencyKey)?.state=="prepared"&&s.read(b.idempotencyKey)?.state=="prepared");done("batch-uncertainty-fence-rollback")
  s.markUncertain(listOf(a,b)){};s.markUncertain(listOf(a,b)){}
  s.close();s=store();yes(s.read(a.idempotencyKey)?.state=="uncertain"&&s.read(b.idempotencyKey)?.state=="uncertain");done("uncertainty-survives-reopen")
  rejects{s.abortPrepared(listOf(a),"CANCELLED") {}};yes(s.read(a.idempotencyKey)?.state=="uncertain");done("cannot-abort-uncertain-by-assertion")
  s.complete(a,"accepted"){};s.complete(a,"accepted"){}
  rejects{s.complete(a,"rejected") {}};done("result-idempotency-no-contradiction")
  calls=0;rejects{s.complete(b,"known"){calls++;check(calls!=3){"TEST_CANCEL"}}}
  yes(s.read(b.idempotencyKey)?.state=="uncertain");done("result-commit-fence-rollback")
  s.complete(b,"known"){};s.close();s=store()
  yes(s.read(a.idempotencyKey)?.resultStatus=="accepted"&&s.read(b.idempotencyKey)?.resultStatus=="known");done("results-survive-reopen")
  val aborted=id("aborted",4);s.begin(listOf(aborted)){};s.abortPrepared(listOf(aborted),"INVALID_INPUT"){};s.abortPrepared(listOf(aborted),"INVALID_INPUT"){}
  yes(s.read(aborted.idempotencyKey)?.state=="not-submitted");rejects{s.markUncertain(listOf(aborted)) {}};rejects{s.complete(aborted,"accepted") {}};done("pre-network-abort-terminal-auditable")
  val fresh=renamed(aborted,"fresh");yes(s.begin(listOf(fresh)){}.created);yes(s.read(aborted.idempotencyKey)?.state=="not-submitted")
  s.markUncertain(listOf(fresh)){};val active=s.readByTxids(listOf(fresh.txid));yes(active.size==1&&active[0].identity==fresh);done("fresh-approval-identity-release-no-shadow")
  val rollback=id("rollback",5);calls=0
  rejects{s.begin(listOf(rollback)){calls++;check(calls!=3){"TEST_CANCEL"}}}
  yes(s.read(rollback.idempotencyKey)==null);done("begin-fence-rollback")
  val second=store();rejects{second.begin(listOf(renamed(fresh,"race"))) {}};second.close();done("independent-handle-active-collision")
  val otherAccount=store(account="2".repeat(64))
  rejects{otherAccount.read(a.idempotencyKey)};yes(otherAccount.readByTxids(listOf(a.txid)).isEmpty());otherAccount.close();done("account-isolation")
  val otherSource=store(sourceValue="3".repeat(64));yes(otherSource.read(a.idempotencyKey)==null);rejects{otherSource.begin(listOf(a)) {}};otherSource.close();done("network-source-isolation")
  val otherProfile=store("other");yes(otherProfile.begin(listOf(a)){}.created);otherProfile.close();done("wallet-profile-isolation")
  rejects{s.begin(listOf(a,a)) {}};rejects{s.begin(emptyList()) {}};rejects{s.readByTxids(listOf("bad"))};done("bounded-unique-inputs")
  val secret="PRIVATE_TEST_SECRET_SENTINEL";rejects{s.abortPrepared(listOf(fresh),secret) {}};done("no-arbitrary-error-persistence")
  val terminal=id("terminal",6);s.begin(listOf(terminal)){};s.complete(terminal,"rejected"){}
  yes(s.read(terminal.idempotencyKey)?.result?.get("reason")=="TBC transaction rejected");done("redacted-rejected-result")
  val cancelledA=id("cancel-a",8);val cancelledB=id("cancel-b",9);s.begin(listOf(cancelledA,cancelledB)){}
  val cancelled=s.admitDispatch(listOf(cancelledA,cancelledB)){};var starts=0
  rejects{s.startAdmission(cancelled,{error("TEST_REVOKED")},{starts++})}
  yes(starts==0);yes(s.read(cancelledA.idempotencyKey)?.state=="not-submitted"&&s.read(cancelledB.idempotencyKey)?.state=="not-submitted");done("revoked-admission-before-dispatch-aborts-batch")
  rejects{s.cancelAdmission(cancelled)};rejects{s.startAdmission(cancelled,{},{starts++})};yes(starts==0);done("consumed-admission-cannot-start")
  val freshCancel=renamed(cancelledA,"retry");yes(s.begin(listOf(freshCancel)){}.created);done("cancelled-before-dispatch-releases-identity")
  val explicit=id("explicit",10);s.begin(listOf(explicit)){};val explicitTicket=s.admitDispatch(listOf(explicit)){};s.cancelAdmission(explicitTicket)
  yes(s.read(explicit.idempotencyKey)?.abortCode=="DISPATCH_CANCELLED");done("native-cancel-unstarted-ticket")
  val thrown=id("throw-after-start",11);s.begin(listOf(thrown)){};val thrownTicket=s.admitDispatch(listOf(thrown)){}
  rejects{s.startAdmission(thrownTicket,{},{starts++;error("TEST_TRANSPORT")})}
  yes(starts==1&&s.read(thrown.idempotencyKey)?.state=="uncertain");rejects{s.cancelAdmission(thrownTicket)};rejects{s.admitDispatch(listOf(thrown)) {}};done("transport-entry-throw-remains-unknown-no-retry")
  val success=id("success-start",12);s.begin(listOf(success)){};val successTicket=s.admitDispatch(listOf(success)){}
  yes(s.startAdmission(successTicket,{},{starts++;"submitted"})=="submitted")
  rejects{s.startAdmission(successTicket,{},{starts++})};yes(starts==2);done("native-dispatch-enqueues-once")
  val failAdmit=id("fail-admit",13);s.begin(listOf(failAdmit)){};calls=0
  rejects{s.admitDispatch(listOf(failAdmit)){calls++;check(calls!=3){"TEST_REVOKED"}}}
  yes(s.read(failAdmit.idempotencyKey)?.state=="prepared");done("admission-final-fence-rolls-back")
  val foreign=store("foreign");val foreignId=id("foreign",14);foreign.begin(listOf(foreignId)){};val foreignTicket=foreign.admitDispatch(listOf(foreignId)){}
  rejects{s.startAdmission(foreignTicket,{},{starts++})};yes(starts==2);foreign.cancelAdmission(foreignTicket);foreign.close();done("foreign-ticket-cannot-dispatch")
  val corrupt=id("corrupt",7);s.begin(listOf(corrupt)){};s.close()
  SQLiteDatabase.openDatabase(File(root,"tbc-kit-broadcast.sqlite").path,null,SQLiteDatabase.OPEN_READWRITE).use{db->
    yes(db.isOpen);db.execSQL("UPDATE broadcast_intents SET identity_digest='corrupt' WHERE key=?",arrayOf(corrupt.idempotencyKey));yes(true)
  }
  s=store();rejects{s.read(corrupt.idempotencyKey)};done("corrupt-identity-rejected")
  s.close();rejects{s.read(a.idempotencyKey)};done("closed-store-fails")
  yes(!File(root,"tbc-kit-broadcast.sqlite").readText(Charsets.ISO_8859_1).contains(secret));done("secret-sentinel-not-on-disk")
  println(JSONObject(mapOf("status" to "PASS","checks" to checks,"cases" to cases,"identityDigests" to listOf(a.digest,b.digest),"networkRequests" to 0)))
}
