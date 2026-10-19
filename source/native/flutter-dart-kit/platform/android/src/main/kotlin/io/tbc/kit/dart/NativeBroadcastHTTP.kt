package io.tbc.kit.dart

// Wallet-private bounded wire transport. No node codec, authority, retry,
// signer, journal or Flutter/page route. Start inside the native one-use store
// admission on the same serial executor as custody authority changes.
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class NativeBroadcastHTTPFailure(val code:String):Exception(code)
class NativeBroadcastHTTPResponse(val status:Int,body:ByteArray){
 private val bytes=body.copyOf()
 val body get()=bytes.copyOf()
}
class NativeBroadcastHTTPRequest internal constructor(val sourceIdentity:String,val method:String,val url:URL,
 body:ByteArray?,val deadline:Instant,val maximumResponseBytes:Int=4*1024*1024){
 private val bytes=body?.copyOf()
 val body get()=bytes?.copyOf()
 companion object {
  fun validated(sourceIdentity:String,apiOrigin:String,method:String,path:String,body:String?,deadline:Instant):NativeBroadcastHTTPRequest{
   fun requireWire(ok:Boolean){if(!ok)throw NativeBroadcastHTTPFailure("BROADCAST_WIRE_REQUEST")}
   val origin=try{URI(apiOrigin)}catch(_:Exception){throw NativeBroadcastHTTPFailure("BROADCAST_WIRE_REQUEST")}
   requireWire(Regex("^[0-9a-f]{64}$").matches(sourceIdentity)&&origin.scheme=="https"&&!origin.host.isNullOrEmpty()&&origin.userInfo==null&&origin.query==null&&origin.fragment==null&&origin.path.isEmpty()&&origin.toASCIIString()==apiOrigin)
   val post=method=="POST"&&path in setOf("/api/tbc/broadcasttx","/api/tbc/broadcasttxs")
   val read=method=="GET"&&Regex("^/api/tbc/decode/txid/[0-9a-f]{64}$").matches(path)
   val bytes=body?.toByteArray(Charsets.UTF_8)
   requireWire((post&&bytes!=null&&bytes.isNotEmpty()&&bytes.size<=128*1024*1024)||(read&&bytes==null))
   return NativeBroadcastHTTPRequest(sourceIdentity,method,URL(apiOrigin+path),bytes,deadline)
  }
 }
}

class NativeBroadcastHTTP(val sourceIdentity:String,private val dispatchOwner:(()->Unit)->Unit){
 private val ownerThread=Thread.currentThread()
 init {if(!Regex("^[0-9a-f]{64}$").matches(sourceIdentity))throw NativeBroadcastHTTPFailure("BROADCAST_WIRE_SOURCE")}
 // One process-wide I/O pool and timer; no new runtime/dependency per operation.
 // Existing platform ownership decides the reply executor, never the page.
 companion object {
  private val io=Executors.newCachedThreadPool{r->Thread(r,"tbc-broadcast-http").apply{isDaemon=true}}
  private val deadlines=Executors.newSingleThreadScheduledExecutor{r->Thread(r,"tbc-broadcast-deadline").apply{isDaemon=true}}
 }
 fun start(request:NativeBroadcastHTTPRequest,fence:()->Unit,
  complete:(Result<NativeBroadcastHTTPResponse>)->Unit):()->Unit{
  if(Thread.currentThread()!==ownerThread||request.sourceIdentity!=sourceIdentity||!request.deadline.isAfter(Instant.now())||request.maximumResponseBytes !in 1..4*1024*1024)throw NativeBroadcastHTTPFailure("BROADCAST_WIRE_REQUEST")
  fence()
  val work=WireTask(request,complete)
  // No await between fence and this one enqueue. Revocation after enqueue is
  // conservatively unknown even if cancellation happened before bytes left.
  work.start()
  return {work.finish(Result.failure(NativeBroadcastHTTPFailure("NODE_REQUEST_FAILED")))}
 }
 private inner class WireTask(val request:NativeBroadcastHTTPRequest,val complete:(Result<NativeBroadcastHTTPResponse>)->Unit){
  private val done=AtomicBoolean(false)
  @Volatile private var connection:HttpURLConnection?=null
  @Volatile private var timer:ScheduledFuture<*>?=null
  fun finish(result:Result<NativeBroadcastHTTPResponse>){
   if(!done.compareAndSet(false,true))return
   timer?.cancel(false)
   // disconnect may block on Android's streaming lock. Never call it on the
   // authority/UI executor; the result can be delivered before teardown ends.
   io.execute{try{connection?.disconnect()}catch(_:Exception){}}
   dispatchOwner{complete(result)}
  }
  fun start(){
   val timeout=java.time.Duration.between(Instant.now(),request.deadline).toMillis().coerceIn(1,15000)
   timer=deadlines.schedule({finish(Result.failure(NativeBroadcastHTTPFailure("NODE_REQUEST_FAILED")))},timeout,TimeUnit.MILLISECONDS)
   io.execute{
    try{
     if(done.get())return@execute
     val c=request.url.openConnection() as HttpURLConnection;connection=c
     if(done.get()){c.disconnect();return@execute}
     c.instanceFollowRedirects=false;c.useCaches=false;c.connectTimeout=timeout.toInt();c.readTimeout=timeout.toInt()
     c.requestMethod=request.method;c.setRequestProperty("Accept","application/json")
     // This dedicated native client sends no WebView cookies/credentials.
     c.setRequestProperty("Cookie","");c.setRequestProperty("Authorization","")
     val body=request.body
     if(body!=null){
      c.doOutput=true;c.setRequestProperty("Content-Type","application/json")
      // Fixed streaming disables transparent HTTP auth/redirect replay and
      // avoids retaining another whole buffered POST in HttpURLConnection.
      c.setFixedLengthStreamingMode(body.size)
      c.outputStream.use{it.write(body)}
     }
     if(done.get())return@execute
     val status=c.responseCode
     if(c.contentLengthLong>request.maximumResponseBytes)throw NativeBroadcastHTTPFailure("NODE_RESPONSE_INVALID")
     val output=ByteArrayOutputStream()
     val input=if(status>=400)c.errorStream else c.inputStream
     input?.use{stream->val buffer=ByteArray(16384);while(!done.get()){
      val n=stream.read(buffer);if(n<0)break
      if(n>request.maximumResponseBytes-output.size())throw NativeBroadcastHTTPFailure("NODE_RESPONSE_INVALID")
      output.write(buffer,0,n)
     }}
     if(!done.get())finish(Result.success(NativeBroadcastHTTPResponse(status,output.toByteArray())))
    }catch(e:Exception){finish(Result.failure(if(e is NativeBroadcastHTTPFailure)e else NativeBroadcastHTTPFailure("NODE_REQUEST_FAILED")))}
    finally{try{connection?.disconnect()}catch(_:Exception){}}
   }
  }
 }
}
