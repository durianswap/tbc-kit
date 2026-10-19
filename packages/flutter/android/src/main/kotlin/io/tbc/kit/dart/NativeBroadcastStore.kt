package io.tbc.kit.dart

// Wallet-private system SQLite. No signing journal, raw queue, auto sender or
// page/MethodChannel entry point. All operations are serialized per connection.
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder

data class NativeBroadcastIdentity(val idempotencyKey:String,val rawHash:String,val txid:String,
  val submitContextHash:String,val accountScopeHash:String) {
  val fields get()=listOf(idempotencyKey,rawHash,txid,submitContextHash,accountScopeHash)
  val digest get()=MessageDigest.getInstance("SHA-256").digest(fields.joinToString("\u0000").toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it.toInt() and 255)}
  fun validate(source:String,account:String) {
    check(Regex("^[A-Za-z0-9:._-]{1,256}$").matches(idempotencyKey)&&
      idempotencyKey.startsWith("tbcnet-${source.take(24)}-")&&
      fields.drop(1).all{Regex("^[0-9a-f]{64}$").matches(it)}&&accountScopeHash==account){"BROADCAST_IDENTITY"}
  }
}
data class NativeBroadcastRecord(val identity:NativeBroadcastIdentity,val state:String,val createdAt:String,
  val resultStatus:String?,val abortCode:String?) {
  // Never persist arbitrary node errors, which can contain raw tx/preimages.
  val result:Map<String,String>? get()=resultStatus?.let{status->buildMap{
    put("txid",identity.txid);put("status",status)
    if(status=="rejected")put("reason",if(state=="not-submitted")"TBC transaction was not submitted" else "TBC transaction rejected")
  }}
}
data class NativeBroadcastReservation(val created:Boolean,val records:List<NativeBroadcastRecord?>)
// Native-only opaque identity, not a serialized permission. An unregistered
// instance cannot pass the store's identity registry.
class NativeBroadcastAdmission internal constructor()

class SystemBroadcastStore(directory:File,val profile:String,val sourceIdentity:String,val accountScopeHash:String) {
  private val db:SQLiteDatabase
  private val ownerThread=Thread.currentThread()
  private val admissions=java.util.IdentityHashMap<NativeBroadcastAdmission,List<NativeBroadcastIdentity>>()
  private val abortCodes=setOf("INVALID_INPUT","NODE_RESPONSE_INVALID","CANCELLED","AUTHORITY_CHANGED","EXPIRED","DISPATCH_CANCELLED")
  init {
    check(Regex("^[A-Za-z0-9:._-]{1,128}$").matches(profile)&&listOf(sourceIdentity,accountScopeHash).all{Regex("^[0-9a-f]{64}$").matches(it)}){"BROADCAST_STORE_SCOPE"}
    check(directory.isDirectory||directory.mkdirs()){"BROADCAST_STORE_UNAVAILABLE"}
    val file=File(directory,"tbc-kit-broadcast.sqlite")
    db=SQLiteDatabase.openDatabase(file.path,null,SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY)
    try {
      db.rawQuery("PRAGMA journal_mode=DELETE",null).use{check(it.moveToFirst()&&it.getString(0).lowercase()=="delete"){"BROADCAST_STORE_UNAVAILABLE"}}
      db.execSQL("PRAGMA synchronous=FULL")
      db.execSQL("CREATE TABLE IF NOT EXISTS broadcast_intents(profile TEXT NOT NULL,source TEXT NOT NULL,key TEXT NOT NULL,raw_hash TEXT NOT NULL,txid TEXT NOT NULL,context_hash TEXT NOT NULL,account_scope TEXT NOT NULL,identity_digest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,result_status TEXT,abort_code TEXT,PRIMARY KEY(profile,source,key))")
      db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS broadcast_active_tx ON broadcast_intents(profile,source,txid) WHERE state!='not-submitted'")
      db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS broadcast_active_raw ON broadcast_intents(profile,source,raw_hash) WHERE state!='not-submitted'")
      db.execSQL("CREATE TABLE IF NOT EXISTS broadcast_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,profile TEXT NOT NULL,source TEXT NOT NULL,key TEXT NOT NULL,identity_digest TEXT NOT NULL,action TEXT NOT NULL,code TEXT NOT NULL,recorded_at TEXT NOT NULL)")
      check(file.setReadable(false,false)&&file.setWritable(false,false)&&file.setReadable(true,true)&&file.setWritable(true,true)){"BROADCAST_STORE_UNAVAILABLE"}
    } catch(e:Exception){db.close();throw e}
  }
  @Synchronized fun close(){admissions.clear();db.close()}
  private fun now()=DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now())
  private fun execute(sql:String,values:List<String> = emptyList()) {
    check(db.isOpen){"BROADCAST_STORE_CLOSED"};db.execSQL(sql,values.toTypedArray())
  }
  private val columns="key,raw_hash,txid,context_hash,account_scope,identity_digest,state,created_at,result_status,abort_code"
  private fun decode(c:Cursor):NativeBroadcastRecord {
    check((0..7).none{c.isNull(it)}){"BROADCAST_STORE_CORRUPT"}
    val id=NativeBroadcastIdentity(c.getString(0),c.getString(1),c.getString(2),c.getString(3),c.getString(4))
    id.validate(sourceIdentity,accountScopeHash)
    val state=c.getString(6);val result=if(c.isNull(8))null else c.getString(8);val aborted=if(c.isNull(9))null else c.getString(9)
    check(c.getString(5)==id.digest&&state in setOf("prepared","uncertain","completed","not-submitted")){"BROADCAST_STORE_CORRUPT"}
    check((state=="completed"&&result in setOf("accepted","known","rejected")&&aborted==null)||
      (state=="not-submitted"&&result=="rejected"&&aborted in abortCodes)||
      (state in setOf("prepared","uncertain")&&result==null&&aborted==null)){"BROADCAST_STORE_CORRUPT"}
    return NativeBroadcastRecord(id,state,c.getString(7),result,aborted)
  }
  @Synchronized fun read(key:String):NativeBroadcastRecord? {
    check(db.isOpen){"BROADCAST_STORE_CLOSED"}
    db.rawQuery("SELECT $columns FROM broadcast_intents WHERE profile=? AND source=? AND key=?",arrayOf(profile,sourceIdentity,key)).use{c->return if(c.moveToFirst())decode(c)else null}
  }
  @Synchronized fun readByTxids(ids:List<String>):List<NativeBroadcastRecord> {
    check(ids.size in 1..32&&ids.toSet().size==ids.size&&ids.all{Regex("^[0-9a-f]{64}$").matches(it)}){"BROADCAST_LOOKUP"}
    check(db.isOpen){"BROADCAST_STORE_CLOSED"}
    val placeholders=ids.joinToString(","){"?"};val result=mutableListOf<NativeBroadcastRecord>()
    // Keep aborted history but never shadow the later active attempt of a txid.
    db.rawQuery("SELECT $columns FROM broadcast_intents WHERE profile=? AND source=? AND account_scope=? AND state!='not-submitted' AND txid IN ($placeholders) ORDER BY created_at,key",(listOf(profile,sourceIdentity,accountScopeHash)+ids).toTypedArray()).use{c->while(c.moveToNext())result.add(decode(c))}
    return result.toList()
  }
  private fun <T> transaction(fence:()->Unit,body:()->T):T {
    check(db.isOpen){"BROADCAST_STORE_CLOSED"};fence();db.beginTransaction()
    try {fence();val result=body();fence();db.setTransactionSuccessful();return result}
    finally {db.endTransaction()}
  }
  private fun audit(id:NativeBroadcastIdentity,action:String,code:String="") {
    execute("INSERT INTO broadcast_audit(profile,source,key,identity_digest,action,code,recorded_at) VALUES(?,?,?,?,?,?,?)",listOf(profile,sourceIdentity,id.idempotencyKey,id.digest,action,code,now()))
  }
  private fun checked(id:NativeBroadcastIdentity):NativeBroadcastRecord {
    id.validate(sourceIdentity,accountScopeHash)
    return read(id.idempotencyKey)?.also{check(it.identity==id){"BROADCAST_IDENTITY_CONFLICT"}}?:error("BROADCAST_IDENTITY_CONFLICT")
  }
  @Synchronized fun begin(identities:List<NativeBroadcastIdentity>,fence:()->Unit):NativeBroadcastReservation {
    val ids=identities.toList()
    check(ids.size in 1..32&&ids.map{it.idempotencyKey}.toSet().size==ids.size&&ids.map{it.txid}.toSet().size==ids.size&&ids.map{it.rawHash}.toSet().size==ids.size){"BROADCAST_BATCH"}
    ids.forEach{it.validate(sourceIdentity,accountScopeHash)}
    return transaction(fence){
      val old=ids.map{read(it.idempotencyKey)}
      old.forEachIndexed{i,row->if(row!=null)check(row.identity==ids[i]){"BROADCAST_IDENTITY_CONFLICT"}}
      if(old.any{it!=null})NativeBroadcastReservation(false,old)
      else {
        ids.forEach{id->
          execute("INSERT INTO broadcast_intents VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)",listOf(profile,sourceIdentity)+id.fields+listOf(id.digest,"prepared",now()))
          audit(id,"prepared")
        }
        NativeBroadcastReservation(true,ids.map{read(it.idempotencyKey)})
      }
    }
  }
  // Atomic across the whole batch; this state transition is not authorization.
  @Synchronized fun markUncertain(identities:List<NativeBroadcastIdentity>,fence:()->Unit) {
    val ids=identities.toList();check(ids.size in 1..32&&ids.map{it.idempotencyKey}.toSet().size==ids.size){"BROADCAST_BATCH"}
    transaction(fence){ids.forEach{id->val row=checked(id);check(row.state in setOf("prepared","uncertain")){"BROADCAST_STATE"}
      if(row.state=="prepared"){execute("UPDATE broadcast_intents SET state='uncertain' WHERE profile=? AND source=? AND key=?",listOf(profile,sourceIdentity,id.idempotencyKey));audit(id,"uncertain")}
    }}
  }
  @Synchronized fun complete(id:NativeBroadcastIdentity,status:String,fence:()->Unit) {
    check(status in setOf("accepted","known","rejected")){"BROADCAST_RESULT"}
    transaction(fence){val row=checked(id)
      if(row.state=="completed")check(row.resultStatus==status){"BROADCAST_RESULT_CONFLICT"}
      else {
        check(row.state in setOf("prepared","uncertain")){"BROADCAST_STATE"}
        execute("UPDATE broadcast_intents SET state='completed',result_status=? WHERE profile=? AND source=? AND key=?",listOf(status,profile,sourceIdentity,id.idempotencyKey));audit(id,"completed",status)
      }
    }
  }
  @Synchronized fun abortPrepared(identities:List<NativeBroadcastIdentity>,code:String,fence:()->Unit) {
    val ids=identities.toList();check(code in abortCodes&&ids.size in 1..32&&ids.map{it.idempotencyKey}.toSet().size==ids.size){"BROADCAST_ABORT"}
    transaction(fence){ids.forEach{id->val row=checked(id)
      if(row.state=="not-submitted")check(row.abortCode==code){"BROADCAST_ABORT_CONFLICT"}
      else {
        // A caller-supplied POST=0 assertion cannot abort transport uncertainty.
        check(row.state=="prepared"){"BROADCAST_ABORT_AFTER_DISPATCH"}
        execute("UPDATE broadcast_intents SET state='not-submitted',result_status='rejected',abort_code=? WHERE profile=? AND source=? AND key=?",listOf(code,profile,sourceIdentity,id.idempotencyKey));audit(id,"not-submitted",code)
      }
    }}
  }
  // Native owner holds the ticket between the journal and actual HTTP call.
  // The whole batch is admitted atomically; replay cannot mint another ticket.
  @Synchronized fun admitDispatch(identities:List<NativeBroadcastIdentity>,fence:()->Unit):NativeBroadcastAdmission {
    check(Thread.currentThread()===ownerThread){"BROADCAST_EXECUTOR"}
    val ids=identities.toList();check(ids.size in 1..32&&ids.map{it.idempotencyKey}.toSet().size==ids.size){"BROADCAST_BATCH"}
    transaction(fence){ids.forEach{id->check(checked(id).state=="prepared"){"BROADCAST_ALREADY_ADMITTED"}
      execute("UPDATE broadcast_intents SET state='uncertain' WHERE profile=? AND source=? AND key=?",listOf(profile,sourceIdentity,id.idempotencyKey));audit(id,"uncertain")
    }}
    return NativeBroadcastAdmission().also{admissions[it]=ids}
  }
  private fun take(ticket:NativeBroadcastAdmission):List<NativeBroadcastIdentity> {
    check(Thread.currentThread()===ownerThread){"BROADCAST_EXECUTOR"}
    return admissions.remove(ticket)?:error("BROADCAST_ADMISSION_CONSUMED")
  }
  // Only our still-unstarted in-memory admission can prove no transport entry.
  // No Dart/page-supplied POST counter or generic uncertain abort is accepted.
  private fun abortUnstarted(ids:List<NativeBroadcastIdentity>) {
    transaction({}){ids.forEach{id->check(checked(id).state=="uncertain"){"BROADCAST_ADMISSION_STATE"}
      execute("UPDATE broadcast_intents SET state='not-submitted',result_status='rejected',abort_code='DISPATCH_CANCELLED' WHERE profile=? AND source=? AND key=?",listOf(profile,sourceIdentity,id.idempotencyKey));audit(id,"not-submitted","DISPATCH_CANCELLED")
    }}
  }
  @Synchronized fun cancelAdmission(ticket:NativeBroadcastAdmission){abortUnstarted(take(ticket))}
  // Must run on the same serial native executor as authority changes. No
  // suspension between fence and synchronously enqueueing the one request.
  // A throw AFTER entering start is uncertain, never proof of no submission.
  @Synchronized fun <T> startAdmission(ticket:NativeBroadcastAdmission,fence:()->Unit,start:()->T):T {
    val ids=take(ticket)
    try {fence();ids.forEach{check(checked(it).state=="uncertain"){"BROADCAST_ADMISSION_STATE"}}}
    catch(e:Exception){try{abortUnstarted(ids)}catch(_:Exception){};throw e}
    return start()
  }
}
