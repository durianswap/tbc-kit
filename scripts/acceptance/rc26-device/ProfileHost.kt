package io.tbc.kitloop

import android.app.Activity
import android.os.*
import android.widget.TextView
import com.facebook.soloader.nativeloader.NativeLoader
import com.facebook.soloader.nativeloader.SystemDelegate
import io.tbc.engine.*
import io.tbc.kit.host.NativeSessionFence
import kotlinx.coroutines.runBlocking
import org.json.*
import java.util.concurrent.Executors

class ProfileActivity: Activity() {
    lateinit var label: TextView
    lateinit var host: NativeHost
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        label=TextView(this); label.text="Isolated NFT local profile — no network"; setContentView(label)
        host=NativeHost(this); host.start()
    }
}

// Reuses the exact thread-confined Hermes JNI library from rc.25. No Vault,
// HTTP, SQLite or production wallet; synthetic signer is labelled in report.
class NativeHost(private val app: ProfileActivity) {
    companion object { init {
        NativeLoader.initIfUninitialized(SystemDelegate())
        Class.forName("com.facebook.jni.ThreadScopeSupport")
        System.loadLibrary("tbc_kit_loop")
    } }
    private external fun create(): Long
    private external fun evaluate(handle: Long, code: ByteArray)
    private val main=Handler(Looper.getMainLooper())
    private val worker=Executors.newFixedThreadPool(2)
    private val engine=TbcEngine("0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    private val keyless=TbcKeylessEngine("0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    private var handle=0L
    fun start() {
        handle=create()
        evaluate(handle,app.assets.open("hermes-bootstrap.js").readBytes())
        evaluate(handle,"globalThis.fetch=function(){throw Error('Network forbidden');};".toByteArray())
        evaluate(handle,app.assets.open("suite.js").readBytes())
    }
    fun dispatch(op:String, bytes:ByteArray):ByteArray {
        val input=JSONTokener(String(bytes,Charsets.UTF_8)).nextValue()
        val result:Any?=when(op) {
            "now" -> SystemClock.elapsedRealtimeNanos()/1e6
            "encode" -> (input as String).toByteArray(Charsets.UTF_8).map { it.toInt() and 255 }.let { JSONArray(it) }
            "decode" -> (input as JSONArray).let { a -> String(ByteArray(a.length()){a.getInt(it).toByte()},Charsets.UTF_8) }
            "schedule" -> { val a=input as JSONArray; main.postDelayed({evaluate(handle,"__fireTimer(${a.getInt(0)})".toByteArray())},a.getLong(1)); null }
            "url" -> { val u=java.net.URI(input as String);JSONObject().put("origin","${u.scheme}://${u.authority}").put("href",u.toString())
                .put("protocol","${u.scheme}:").put("hostname",u.host).put("host",u.authority).put("port",if(u.port<0)"" else u.port.toString())
                .put("pathname",u.path.ifEmpty{"/"}).put("search",u.query?.let{"?$it"}?:"").put("hash",u.fragment?.let{"#$it"}?:"")
                .put("username",u.userInfo?:"").put("password","") }
            "message" -> {
                val m=input as JSONObject
                if(m.getString("kind") in listOf("report","progress")) {
                    val kind=m.getString("kind");app.filesDir.resolve("$kind.json").writeText(m.getString("text"))
                    main.post { app.label.text=m.getString("text").take(1200) }
                } else if(m.getString("kind")=="call") {
                    worker.execute {
                        val r=runCatching { runBlocking {
                            if(m.getString("family")=="fence") {
                                var tick=0.0
                                val fence=NativeSessionFence { tick }
                                fence.replaceVerifiedScope(NativeSessionFence.Scope("https://controlled.example","document","fixture-account","tbc:testnet"))
                                val ticket=fence.capture(120.0,authorizationBound=true)
                                tick=JSONObject(m.getString("input")).getDouble("elapsed")/1000.0
                                fence.check(ticket)
                                error("Expected expired fence")
                            }
                            else if(m.getString("family")=="engine")engine.callEnvelope(TbcEngineMethod.entries.first{it.wireName==m.getString("method")},m.getString("input"))
                            else keyless.callEnvelope(TbcKeylessOperation.entries.first{it.wireName==m.getString("method")},m.getString("input"))
                        } }
                        val failure=r.exceptionOrNull()?.let { "${it.javaClass.simpleName}: ${it.message}" }
                        val args=JSONArray().put(m.getString("id")).put(r.getOrNull()?:JSONObject.NULL).put(failure?:JSONObject.NULL)
                        main.post {evaluate(handle,"__nativeComplete.apply(null,$args)".toByteArray())}
                    }
                } else error("Unsupported probe message")
                null
            }
            else -> error("Unsupported probe operation")
        }
        return (result?.toString()?:"null").let { if(result is String)JSONObject.quote(result) else it }.toByteArray()
    }
}
