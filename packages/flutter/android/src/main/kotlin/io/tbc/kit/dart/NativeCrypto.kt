package io.tbc.kit.dart

import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

enum class NativeCryptoPurpose { ENCRYPT, DECRYPT }
// Explicit no-output availability failure, not a MAC error, lock or retry.
class NativeCryptoUnavailable:Exception()
interface NativeBie1Executor {
 // Native Vault only, not digest signing. Recheck at key use after any unlock.
 // Callback once on the custody executor. Input is borrowed until callback;
 // erase owned key/plaintext scratch on success/failure/cancellation. No logs,
 // retry, page registration or private-key-returning callback.
 fun execute(account:NativeAccount,purpose:NativeCryptoPurpose,input:ByteArray,
  requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit)
}

object NativeCrypto {
 val methods=setOf("tbc_encrypt","tbc_decrypt")
 const val algorithm="tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1"
 private fun need(ok:Boolean){if(!ok)throw NativeCustodyFailure("NATIVE_CRYPTO_BINDING")}
 @Suppress("UNCHECKED_CAST") private fun map(v:Any?):Map<String,Any?>{need(v is Map<*,*>);return v as Map<String,Any?>}
 private fun text(v:Any?):String{need(v is String);return v as String}
 private fun shape(r:Map<String,Any?>,required:Set<String>,optional:Set<String> = emptySet()){need(r.keys.containsAll(required)&&(required+optional).containsAll(r.keys))}
 private fun hash(v:Any?)=MessageDigest.getInstance("SHA-256").digest(PermissionJson.canonical(v).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it.toInt()and 255)}
 private fun equal(a:Any?,b:Any?)=PermissionJson.canonical(a)==PermissionJson.canonical(b)
 fun time(v:Any?):Instant{val s=text(v);need(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$").matches(s));return Instant.parse(s)}
 private fun b64(v:Any?,min:Int,max:Int):ByteArray{
  val s=text(v);need(s.length in min..max&&Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$").matches(s));return Base64.getDecoder().decode(s)
 }
 private fun message(v:Any?):ByteArray{
  val m=map(v);shape(m,setOf("encoding","data"));val s=text(m["data"])
  return when(m["encoding"]){
   "utf8"->{need(s.codePointCount(0,s.length)<=65536);var i=0;while(i<s.length){val c=s[i++];if(Character.isHighSurrogate(c)){need(i<s.length&&Character.isLowSurrogate(s[i++]));}else need(!Character.isLowSurrogate(c))};s.toByteArray(Charsets.UTF_8).also{if(it.size>65536){it.fill(0);need(false)}}}
   "hex"->{need(s.isNotEmpty()&&s.length<=131072&&Regex("^(?:[0-9a-f]{2})+$").matches(s));ByteArray(s.length/2){s.substring(it*2,it*2+2).toInt(16).toByte()}}
   "base64"->b64(s,0,87384).also{if(it.size>65536){it.fill(0);need(false)}}
   else->throw NativeCustodyFailure("NATIVE_CRYPTO_BINDING")
  }
 }
 fun check(r:Map<String,Any?>,method:String,account:NativeAccount){
  need(method in methods);val encrypt=method=="tbc_encrypt"
  shape(r,setOf("version","chainId","from","algorithm",if(encrypt)"message" else "ciphertext"),setOf("clientRequestId","expiresAt"))
  need(r["version"]=="1.0"&&r["algorithm"]==algorithm&&r["chainId"]==account.chainId&&r["from"]==account.address)
  if(r.containsKey("clientRequestId")){val client=text(r["clientRequestId"]);need(client.codePointCount(0,client.length) in 1..128)}
  if(r.containsKey("expiresAt"))time(r["expiresAt"])
  val bytes=if(encrypt)message(r["message"])else b64(r["ciphertext"],116,174848);bytes.fill(0)
 }
 fun description(r:Map<String,Any?>,method:String,account:NativeAccount):String{
  check(r,method,account);if(r.containsKey("expiresAt"))need(time(r["expiresAt"]).isAfter(Instant.now()))
  return if(method=="tbc_encrypt")"Encrypt with this account using existing BIE1. Return ciphertext to the requesting origin.\nMessage:\n"+PermissionJson.canonical(r["message"])
   else "Decrypt BIE1 with this account. Return plaintext to the requesting origin.\nCiphertext commitment: "+hash(r["ciphertext"])
 }
 fun task(r:Map<String,Any?>,method:String,context:Map<String,Any?>,account:NativeAccount,id:String):Map<String,Any?>{
  check(r,method,account);val encrypt=method=="tbc_encrypt";val field=if(encrypt)"message" else "ciphertext"
  return mapOf("taskId" to id,"purpose" to if(encrypt)"encrypt" else "decrypt","algorithm" to algorithm,"origin" to context["origin"],"accountId" to account.accountId,"publicKey" to account.publicKey,field to r[field])
 }
 fun plan(r:Map<String,Any?>,method:String,context:Map<String,Any?>,account:NativeAccount,expiresAt:String):Map<String,Any?>{
  check(r,method,account);time(expiresAt);if(r.containsKey("expiresAt"))need(!time(expiresAt).isAfter(time(r["expiresAt"])))
  val encrypt=method=="tbc_encrypt";val purpose=if(encrypt)"encrypt" else "decrypt";val field=if(encrypt)"message" else "ciphertext"
  val task=task(r,method,context,account,"crypto-single")
  val preview=mapOf("operationKind" to "crypto","purpose" to purpose,"algorithm" to algorithm,field to r[field],"warnings" to emptyList<String>())
  val p=mapOf("requestHash" to hash(r),"contextHash" to hash(context),"chainId" to account.chainId,"accountId" to account.accountId,"expiresAt" to expiresAt,"task" to task,"preview" to preview)
  return mapOf("payload" to p,"planHash" to hash(p))
 }
 fun bound(request:Map<String,Any?>,method:String,context:Map<String,Any?>,account:NativeAccount,binding:Map<String,Any?>,supplied:Map<String,Any?>,preview:Map<String,Any?>):Map<String,Any?>{
  val p=map(binding["payload"]);val plan=plan(request,method,context,account,text(p["expiresAt"]));val body=map(plan["payload"])
  val expected=mapOf("version" to "1.0","method" to method,"operationKind" to "crypto","contextHash" to hash(context),"origin" to context["origin"],"sessionId" to context["sessionId"],"chainId" to account.chainId,"accountId" to account.accountId,"requestHash" to hash(request),"operationHash" to plan["planHash"],"expiresAt" to p["expiresAt"])
  need(equal(supplied,plan)&&equal(preview,body["preview"])&&equal(binding,mapOf("payload" to expected,"bindingHash" to hash(expected))))
  return map(body["task"])
 }
 fun input(task:Map<String,Any?>):ByteArray{
  need(task["algorithm"]==algorithm);if(task["purpose"]=="encrypt")return message(task["message"])
  need(task["purpose"]=="decrypt");return b64(task["ciphertext"],116,174848)
 }
 fun result(task:Map<String,Any?>,output:ByteArray):Map<String,Any?>{
  val encrypt=task["purpose"]=="encrypt";val encoded=Base64.getEncoder().encodeToString(output)
  if(!encrypt&&encoded.length>87384){
   // Historical UTF-8 ciphertext remains readable in the existing result union.
   // Reject malformed bytes instead of replacing them with a different message.
   need(output.size<=131136)
   val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output)).toString()
   need(text.codePointCount(0,text.length)<=65536)
   return mapOf("taskId" to task["taskId"],"algorithm" to algorithm,"message" to mapOf("encoding" to "utf8","data" to text))
  }
  // Validate encoded size without leaving an unnecessary decoded plaintext copy.
  need(encoded.length in (if(encrypt)116..174848 else 0..87384))
  return mapOf("taskId" to task["taskId"],"algorithm" to algorithm)+(if(encrypt)mapOf("ciphertext" to encoded)else mapOf("message" to mapOf("encoding" to "base64","data" to encoded)))
 }
 fun publicResult(value:Map<String,Any?>,account:NativeAccount):Map<String,Any?> = mapOf("version" to "1.0","chainId" to account.chainId,"from" to account.address,"algorithm" to algorithm)+
  (if(value.containsKey("ciphertext"))mapOf("ciphertext" to value["ciphertext"])else mapOf("message" to value["message"]))
}
