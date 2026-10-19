package io.tbc.dartkitf1

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.system.Os
import io.tbc.kit.dart.*
import org.json.JSONObject
import java.io.File

// Maintainer-only Testnet adapter. Never included in the partner Vault/defaults.
class PrivateTestnetWallet(private val activity:Activity):NativeAccountSource,NativeApprovalPresenter,NativeDigestSigner {
 override val current:NativeAccount
 override var revision=0L
 override var unlocked=false
 private var scalar=ByteArray(0)
 var approvals=0;var signatures=0;var nativeSignUs=0L;var lastApprovedNs=0L;var lastSignedNs=0L
 init {
  check(activity.packageName=="io.tbc.dartkit.contract173")
  val p=JSONObject(activity.assets.open("native-account.json").bufferedReader().use{it.readText()})
  check(p.getString("chainId")=="tbc:testnet")
  current=NativeAccount(p.getString("address"),p.getString("publicKey"),"tbc:testnet")
  System.loadLibrary("tbc_contract173_signer")
 }
 private external fun signPrivateTestnet(digest:ByteArray,encoding:Int,key:ByteArray):ByteArray
 fun unlock(){
  scalar.fill(0);scalar=ByteArray(0);unlocked=false;revision++
  val file=File(activity.filesDir,"testnet-private.json")
  check(file.length() in 1..4096 && Os.stat(file.path).st_mode and 511==384){"TESTNET_PRIVATE_MODE"}
  val bytes=file.readBytes()
  try {
   val p=JSONObject(bytes.toString(Charsets.UTF_8))
   check(p.getString("chainId")==current.chainId && p.getString("address")==current.address && p.getString("publicKey")==current.publicKey){"TESTNET_ACCOUNT_MISMATCH"}
   val hex=p.getString("scalar");check(hex.matches(Regex("^[0-9a-f]{64}$")))
   val key=ByteArray(32){hex.substring(it*2,it*2+2).toInt(16).toByte()}
   check(key.take(31).any{it.toInt()!=0} || (key[31].toInt() and 255)>2){"PUBLIC_FIXTURE_KEY_FORBIDDEN"}
   scalar=key;unlocked=true;revision++
  } finally {bytes.fill(0)}
 }
 override fun present(review:NativeReview,complete:(Boolean)->Unit):()->Unit {
  approvals++;var finished=false
  val permitted=unlocked&&review.chainId==current.chainId&&review.accountAddress==current.address&&review.origin=="http://127.0.0.1:41893"
  fun finish(yes:Boolean){if(finished)return;finished=true;if(yes)lastApprovedNs=System.nanoTime();complete(yes)}
  val dialog=AlertDialog.Builder(activity).setTitle("TESTNET ONLY · "+review.title)
   .setMessage(review.origin+"\n"+review.description)
   .setPositiveButton("Approve"){_,_->finish(permitted)}.setNegativeButton("Reject"){_,_->finish(false)}
   .setOnCancelListener{finish(false)}.create()
  dialog.show()
  // User-authorized isolated Testnet automation, not a partner default.
  Handler(Looper.getMainLooper()).postDelayed({if(!finished&&dialog.isShowing){dialog.dismiss();finish(permitted)}},250)
  return {if(!finished){finished=true;dialog.dismiss()}}
 }
 override fun sign(account:NativeAccount,digest:ByteArray,encoding:String,requireCurrent:()->Unit,complete:(Result<ByteArray>)->Unit){
  complete(runCatching {
   requireCurrent();check(unlocked&&account==current&&scalar.size==32&&digest.size==32&&encoding in setOf("compact64","compact65-recoverable"))
   requireCurrent();val start=System.nanoTime()
   val result=signPrivateTestnet(digest,if(encoding=="compact64")64 else 65,scalar)
   lastSignedNs=System.nanoTime();nativeSignUs+=(lastSignedNs-start)/1000;signatures++;result
  })
 }
 fun stats()=mapOf("approvals" to approvals,"signatures" to signatures,"nativeSignUs" to nativeSignUs,
  "approvalToLastSignatureUs" to if(lastSignedNs>=lastApprovedNs)(lastSignedNs-lastApprovedNs)/1000 else 0,
  "testnetPrivateAdapter" to true)
}
