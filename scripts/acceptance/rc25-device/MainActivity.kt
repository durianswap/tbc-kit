package io.tbc.rc25.acceptance
import android.app.Activity
import android.os.Bundle
import android.webkit.*
import io.tbc.engine.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors

class MainActivity:Activity(){
    private lateinit var web:WebView
    private val engine=TbcEngine("0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    private val keyless=TbcKeylessEngine("0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4")
    private val workers=Executors.newFixedThreadPool(4)
    override fun onCreate(state:Bundle?){super.onCreate(state);web=WebView(this);web.settings.javaScriptEnabled=true;web.settings.allowFileAccess=true
        web.webViewClient=object:WebViewClient(){override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse?{return if(request.url.scheme in listOf("http","https")) WebResourceResponse("text/plain","UTF-8",java.io.ByteArrayInputStream("network forbidden".toByteArray())) else null}}
        web.addJavascriptInterface(this,"TbcProbe");setContentView(web);web.loadUrl("file:///android_asset/index.html")}
    @JavascriptInterface fun postMessage(raw:String){
        val d=JSONObject(raw);val kind=d.getString("kind")
        if(kind=="report" || kind=="progress"){File(filesDir,if(kind=="report")"report.json" else "progress.json").writeText(d.getString("text"));return}
        if(kind!="call")return
        workers.execute {
            val id=d.getString("id");var result:String?=null;var error:String?=null
            try {result=runBlocking {if(d.getString("family")=="engine")engine.callEnvelope(TbcEngineMethod.entries.first{it.wireName==d.getString("method")},d.getString("input")) else keyless.callEnvelope(TbcKeylessOperation.entries.first{it.wireName==d.getString("method")},d.getString("input"))}}
            catch(e:Throwable){error="Native bridge failure: ${e.javaClass.simpleName}: ${e.message}"}
            val args=JSONArray().put(id).put(result?:JSONObject.NULL).put(error?:JSONObject.NULL)
            runOnUiThread {web.evaluateJavascript("globalThis.__nativeComplete(...$args)",null)}
        }
    }
}
