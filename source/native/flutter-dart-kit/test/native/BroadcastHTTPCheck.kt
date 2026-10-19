package io.tbc.kit.dart

// Test-only Android loopback HTTP plus real system SQLite under app_process.
import java.io.File
import java.net.URL
import java.time.Instant
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject

fun main(args:Array<String>){
 var checks=0;val cases=mutableListOf<String>();val responses=mutableListOf<Map<String,Any>>()
 fun yes(b:Boolean){check(b){"check ${checks+1}"};checks++}
 fun rejects(f:()->Unit){var failed=false;try{f()}catch(_:Exception){failed=true};yes(failed)}
 val origin=args[0];val source="a".repeat(64);val account="b".repeat(64)
 val replies=LinkedBlockingQueue<()->Unit>()
 val http=NativeBroadcastHTTP(source){replies.add(it)}
 val store=SystemBroadcastStore(File(args[1]),"wire",source,account)
 val expiry=Instant.now().plusSeconds(15)
 val valid=NativeBroadcastHTTPRequest.validated(source,"https://api.tbcdev.org","POST","/api/tbc/broadcasttx","{}",expiry)
 yes(valid.url.toString()=="https://api.tbcdev.org/api/tbc/broadcasttx")
 for(base in listOf(origin,"https://user:password@api.tbcdev.org","https://api.tbcdev.org/","https://api.tbcdev.org?bad","https://api.tbcdev.org#bad")){
  rejects{NativeBroadcastHTTPRequest.validated(source,base,"POST","/api/tbc/broadcasttx","{}",expiry)}
 }
 for((method,path,body)in listOf(Triple("POST","/other","{}"),Triple("GET","/api/tbc/broadcasttx",null),Triple("GET","/api/tbc/decode/txid/"+"1".repeat(64),"{}"))){
  rejects{NativeBroadcastHTTPRequest.validated(source,"https://api.tbcdev.org",method,path,body,expiry)}
 }
 cases.add("native-request-fixed-https-source-and-path")
 var count=0
 fun request(path:String,method:String="POST",millis:Long=5000)=NativeBroadcastHTTPRequest(source,method,URL(origin+path),if(method=="POST")"{\"publicFixture\":true}".toByteArray() else null,Instant.now().plusMillis(millis),4096)
 fun identity(n:Int)=NativeBroadcastIdentity("tbcnet-${source.take(24)}-wire-$n","%064x".format(n),"%064x".format(n+100),source,account)
 fun run(name:String,path:String,method:String="POST",timeout:Long=5000,cancel:Boolean=false,failFence:Boolean=false):Result<NativeBroadcastHTTPResponse>{
  val id=identity(++count);val wire=request(path,method,timeout)
  val ticket=if(method=="POST"){store.begin(listOf(id)){};store.admitDispatch(listOf(id)){}}else null
  var result:Result<NativeBroadcastHTTPResponse>?=null;var completions=0
  try{
   val start={http.start(wire,{if(failFence)throw NativeBroadcastHTTPFailure("TEST_REVOKED")}){r->completions++;yes(completions==1);result=r}}
   val handle=if(ticket!=null)store.startAdmission(ticket,{if(failFence)throw NativeBroadcastHTTPFailure("TEST_REVOKED")},start)else start()
   if(cancel)Thread{Thread.sleep(30);handle()}.apply{isDaemon=true}.start()
   val stop=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
   while(result==null&&System.nanoTime()<stop)replies.poll(100,TimeUnit.MILLISECONDS)?.invoke()
   check(result!=null){"Test response deadline"}
  }catch(e:Exception){result=Result.failure(e)}
  val state=store.read(id.idempotencyKey)?.state
  if(method=="POST")yes(state==if(failFence)"not-submitted" else "uncertain")
  if(ticket!=null)rejects{store.startAdmission(ticket,{},{error("must not retry")})}
  val r=result!!
  responses.add(if(r.isSuccess){val v=r.getOrThrow();mapOf("name" to name,"status" to v.status,"bytes" to v.body.size,"state" to (state?:"none"))}
   else mapOf("name" to name,"error" to ((r.exceptionOrNull() as? NativeBroadcastHTTPFailure)?.code?:"TEST_START_FAILED"),"state" to (state?:"none")))
  cases.add(name);return r
 }
 yes(run("post-ok","/ok").getOrThrow().status==200)
 yes(run("post-redirect-no-follow","/redirect").getOrThrow().status==307)
 yes(run("status-not-found","/not-found",method="GET").getOrThrow().status==404)
 val auth=run("auth-no-replay","/auth")
 // Android fixed-length streaming rejects a challenge rather than retrying it.
 yes(auth.getOrNull()?.status==401||(auth.exceptionOrNull() as? NativeBroadcastHTTPFailure)?.code=="NODE_REQUEST_FAILED")
 for((name,path,code)in listOf(Triple("oversize-declared","/large-header","NODE_RESPONSE_INVALID"),Triple("oversize-streamed","/large-stream","NODE_RESPONSE_INVALID"),Triple("deadline","/slow","NODE_REQUEST_FAILED"),Triple("cancel-after-start","/slow-cancel","NODE_REQUEST_FAILED"),Triple("drop-after-post","/drop","NODE_REQUEST_FAILED"))){
  val r=run(name,path,timeout=if(name=="deadline")200 else 5000,cancel=name=="cancel-after-start")
  yes((r.exceptionOrNull() as? NativeBroadcastHTTPFailure)?.code==code)
 }
 yes((run("revoke-before-start","/forbidden",failFence=true).exceptionOrNull() as? NativeBroadcastHTTPFailure)?.code=="TEST_REVOKED")
 rejects{http.start(request("/expired",millis=-1),{}){error("expired dispatched")}};cases.add("expired-before-start")
 val foreign=NativeBroadcastHTTPRequest(account,"POST",URL(origin+"/foreign"),"{}".toByteArray(),expiry)
 rejects{http.start(foreign,{}){error("foreign dispatched")}};cases.add("foreign-source-before-start")
 val wait=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(700)
 while(System.nanoTime()<wait)replies.poll(50,TimeUnit.MILLISECONDS)?.invoke()
 store.close()
 println(JSONObject(mapOf("status" to "PASS","checks" to checks,"cases" to cases,"responses" to responses)))
}
