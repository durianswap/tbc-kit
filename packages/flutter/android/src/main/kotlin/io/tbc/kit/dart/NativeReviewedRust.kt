package io.tbc.kit.dart

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

private object ReviewedRustAbi {
 init { System.loadLibrary("tbc_compute_native");System.loadLibrary("tbc_dart_reviewed") }
 external fun identity():String
 external fun call(method:ByteArray,input:ByteArray):ByteArray
}

/** Kit-owned adapter; postOwner is the native host executor, never supplied by
 * a page. No keys, network, decoding policy, retry or alternative Rust runtime.
 * Packaging independently verifies linked binaries; identity is a build tag.
 */
internal class NativeReviewedRust(private val postOwner:((()->Unit)->Unit)):NativeReviewedComputer {
 private val owner=Thread.currentThread()
 init { check(ReviewedRustAbi.identity()==ARTIFACT){"NATIVE_COMPUTE_IDENTITY"} }
 override fun call(method:String,input:String,complete:(Result<String>)->Unit){
  check(Thread.currentThread()===owner){"NATIVE_EXECUTOR"}
  fun failure()=Result.failure<String>(NativeCustodyFailure("NATIVE_REVIEWED_COMPUTE_FAILED"))
  if(method !in setOf("prepareReviewedStage","finalizeReviewedStage") || input.length>16*1024*1024){complete(failure());return}
  val bytes=input.toByteArray(Charsets.UTF_8)
  if(bytes.size>16*1024*1024){complete(failure());return}
  try {
   worker.execute{
    val value=try {
     val output=ReviewedRustAbi.call(method.toByteArray(Charsets.UTF_8),bytes)
     check(output.size<=32*1024*1024)
     Result.success(Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output)).toString())
    }catch(_:Exception){failure()}
    postOwner {check(Thread.currentThread()===owner){"NATIVE_EXECUTOR"};complete(value)}
   }
  }catch(_:java.util.concurrent.RejectedExecutionException){complete(failure())}
 }
 companion object {
  const val ARTIFACT="1d5a2a68a60f613376f3b59e7b318a7e6799d3f3e690d73ad902988ab3ab0675"
  private val worker=ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,ArrayBlockingQueue<Runnable>(8),
   {r->Thread(r,"tbc-reviewed-compute").apply{isDaemon=true}},ThreadPoolExecutor.AbortPolicy())
 }
}
