package io.tbc.kit.dart

import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import androidx.webkit.*
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** One engine's private channel. Construct on the UI thread and retain until
 * engine disposal. The resolver must use that engine's public platform view
 * lookup, never a page value or a global 'first WebView'. invalidateCustody must
 * synchronously fence native key work; the Dart event alone is not a Vault fence.
 */
class TbcFlutterWebViewHost(
    messenger: BinaryMessenger,
    private val resolvePlatformView: (Int) -> View?,
    pageBytes: ByteArray,
    expectedPageSHA256: String,
    private val allowInsecureLoopback: Boolean = false,
    private val invalidateCustody: (String, Map<String, String>?) -> Unit,
    private val resolveLegacyClient: ((WebView) -> WebViewClient?)? = null,
    private val verifiedNavigation: (String, Map<String,String>) -> Unit,
    private val allowDelivery: (String, Map<String,String>, String) -> Boolean,
    private val allowLegacyDelivery: (String, Map<String,String>, String) -> Boolean = {_,_,_->false},
) {
    private class MissingWebViewFeature(val feature: String) : RuntimeException()
    private val channel = MethodChannel(messenger, "io.tbc.kit.dart/private-webview")
    private val owners = mutableMapOf<String, Boundary>()
    private var closed = false
    private val pageSource: String
    private val supportsLegacyPage: Boolean
    private val uiHandler = Handler(Looper.getMainLooper())
    private fun modernBridgeAvailable() = listOf(WebViewFeature.GET_WEB_VIEW_CLIENT,
        WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
        .all { WebViewFeature.isFeatureSupported(it) }
    private fun legacyPageSyntaxAvailable(web: WebView): Boolean {
        // The page artifact targets Safari 13.1 syntax, including optional
        // chaining. V8 did not ship that syntax until Chromium 80. This is a
        // parse floor, not proof that every DApp works on that WebView.
        val version = WebViewCompat.getCurrentWebViewPackage(web.context)?.versionName ?: return false
        return (version.substringBefore('.').toIntOrNull() ?: return false) >= 80
    }
    init {
        ui()
        require(pageBytes.isNotEmpty() && pageBytes.size <= 2 * 1024 * 1024)
        val hash = MessageDigest.getInstance("SHA-256").digest(pageBytes).joinToString("") { "%02x".format(it) }
        require(hash == expectedPageSHA256)
        pageSource = pageBytes.toString(Charsets.UTF_8)
        require(pageSource.toByteArray(Charsets.UTF_8).contentEquals(pageBytes))
        supportsLegacyPage = Regex("""/\* tbc-dart-legacy-page:[0-9a-f]{64} \*/""").containsMatchIn(pageSource)
        channel.setMethodCallHandler(::handle)
    }
    private fun ui() = check(Looper.myLooper() === Looper.getMainLooper())
    fun isCurrent(owner: String, expected: Map<String,String>): Boolean {
        ui(); return !closed && owners[owner]?.isCurrent(expected) == true
    }
    fun invalidateAll() { ui(); owners.values.toList().forEach { it.revoke() } }
    fun dispose() {
        ui(); if (closed) return
        closed = true
        owners.values.toList().forEach { it.dispose() }
        owners.clear(); channel.setMethodCallHandler(null)
    }
    private fun event(id: String, type: String, body: Map<String, Any?>) {
        if (!closed && owners.containsKey(id)) channel.invokeMethod("event", mapOf("ownerId" to id, "type" to type, "body" to body))
    }
    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        ui()
        try {
            check(!closed)
            val args = call.arguments as? Map<*, *> ?: error("input")
            if (call.method == "create") {
                check(args.isEmpty() && owners.size < 8)
                val id = UUID.randomUUID().toString()
                val owner = Boundary(id); owners[id] = owner
                val reply = mutableMapOf<String, Any>("ownerId" to id, "webViewInstanceId" to owner.instanceId,
                    "markerSource" to "/* tbc-native-view:${owner.instanceId} */", "legacyPageSupported" to supportsLegacyPage)
                if (!modernBridgeAvailable() && resolveLegacyClient != null) reply["legacyBootstrapSource"] = pageSource
                result.success(reply); return
            }
            val id = args["ownerId"] as? String ?: error("owner")
            val owner = owners[id] ?: error("owner")
            when (call.method) {
                "attach" -> {
                    check(args.keys == setOf("ownerId", "platformViewId"))
                    val viewId = args["platformViewId"] as? Int ?: error("view")
                    check(viewId >= 0); result.success(owner.attach(viewId))
                }
                "dispose" -> {
                    check(args.keys == setOf("ownerId")); owner.dispose(); owners.remove(id); result.success(null)
                }
                "close", "deliver", "deliverLegacy", "describe" -> {
                    val delivery = call.method == "deliver" || call.method == "deliverLegacy"
                    val extra = if (delivery) "serialized" else "descriptor"
                    check(args.keys == if (call.method == "close") setOf("ownerId", "expected") else setOf("ownerId", "expected", extra))
                    val raw = args["expected"] as? Map<*, *> ?: error("scope")
                    check(raw.keys == scopeKeys && raw.values.all { it is String } && raw["webViewInstanceId"] == owner.instanceId)
                    val expected = raw.entries.associate { (k, v) -> (k as String) to (v as String) }
                    if (call.method == "close") { result.success(owner.close(expected)); return }
                    val value = args[extra] ?: error("value")
                    if (delivery) check(value is String && value.toByteArray().size <= maxMessage)
                    else check(value is Map<*, *> && value.keys.all { it is String })
                    if (delivery && !(if(call.method=="deliverLegacy")allowLegacyDelivery(id,expected,value as String)else allowDelivery(id,expected,value as String))) { result.success(false); return }
                    owner.evaluate(when (call.method) {
                        "deliver" -> "receive"
                        "deliverLegacy" -> "receiveLegacy"
                        else -> "describe"
                    }, value, expected) { result.success(it) }
                }
                else -> result.notImplemented()
            }
        } catch (error: MissingWebViewFeature) {
            result.error("WEBVIEW_REQUIRED_FEATURE_UNAVAILABLE", error.feature, null)
        } catch (_: Exception) { result.error("WEBVIEW_OPERATION_FAILED", null, null) }
    }

    private fun origin(text: String?): String? { return try {
        val url = java.net.URI(text ?: "")
        val scheme = url.scheme?.lowercase(Locale.ROOT)
        val host = url.host?.lowercase(Locale.ROOT) ?: return null
        if (url.rawUserInfo != null || host.any { it.code > 127 } ||
            (scheme != "https" && !(scheme == "http" && allowInsecureLoopback && host in setOf("localhost", "127.0.0.1", "::1", "[::1]")))) null
        else {
            val port = if (url.port == -1) { if (scheme == "https") 443 else 80 } else url.port
            if (port !in 1..65535) null
            else "$scheme://$host" + if (port == if (scheme == "https") 443 else 80) "" else ":$port"
        }
    } catch (_: Exception) { null } }
    private fun quote(value: Any): String = when (value) {
        is String -> JSONObject.quote(value)
        is Map<*, *> -> JSONObject(value).toString()
        else -> error("json")
    }
    private fun findUniqueWebView(root: View): WebView {
        var visited = 0
        val matches = mutableListOf<WebView>()
        fun walk(view: View, depth: Int) {
            check(++visited <= 512 && depth <= 32)
            if (view is WebView) matches.add(view)
            else if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i), depth + 1)
        }
        walk(root, 0); check(matches.size == 1); return matches.single()
    }
    private inner class Boundary(val id: String) {
        val instanceId = UUID.randomUUID().toString()
        private var webRef = WeakReference<WebView>(null)
        private var rootRef = WeakReference<View>(null)
        private var viewId: Int? = null
        private var previous: WebViewClient? = null
        private var client: Client? = null
        private var script: ScriptHandler? = null
        private var legacyPortMode = false
        private var legacyStartedRevision: String? = null
        private var legacyOfferedRevision: String? = null
        private var legacyPort: WebMessagePort? = null
        private var legacyToken: String? = null
        private var legacyAcked = false
        private var scope: Map<String, String>? = null
        private var revision = UUID.randomUUID().toString()
        private var finishing: String? = null
        private var blockedDocument = false
        private var disposed = false
        private val detach = object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {}
            override fun onViewDetachedFromWindow(v: View) { blockedDocument = true; invalidate() }
        }
        fun owns(web: WebView): Boolean {
            if (disposed || webRef.get() !== web || !web.isAttachedToWindow) return false
            val root = rootRef.get() ?: return false
            if (resolvePlatformView(viewId ?: return false) !== root) return false
            var ancestor: View? = web
            repeat(33) {
                if (ancestor === root) return true
                ancestor = ancestor?.parent as? View
            }
            return false
        }
        private fun installed(web: WebView) = owns(web) && client != null &&
            if (legacyPortMode) resolveLegacyClient?.invoke(web) === previous
            else WebViewCompat.getWebViewClient(web) === client
        private fun current(web: WebView, expected: Map<String, String>) =
            installed(web) && !blockedDocument && scope == expected && origin(web.url) == expected["origin"]
        fun isCurrent(expected: Map<String,String>): Boolean {
            val web=webRef.get() ?: return false; return current(web,expected)
        }
        fun attach(platformId: Int): Boolean {
            check(!disposed && viewId == null)
            val root = resolvePlatformView(platformId) ?: return false
            val web = findUniqueWebView(root)
            if (!web.isAttachedToWindow) return false
            check(web.url.isNullOrEmpty() || web.url == "about:blank")
            check(owners.values.none { it !== this && it.webRef.get() === web })
            val modern = modernBridgeAvailable()
            if (!modern && resolveLegacyClient == null) {
                val missing = listOf(WebViewFeature.GET_WEB_VIEW_CLIENT, WebViewFeature.WEB_MESSAGE_LISTENER,
                    WebViewFeature.DOCUMENT_START_SCRIPT).first { !WebViewFeature.isFeatureSupported(it) }
                throw MissingWebViewFeature(missing)
            }
            if (!modern && !legacyPageSyntaxAvailable(web))
                throw MissingWebViewFeature("WEBVIEW_JAVASCRIPT_RUNTIME")
            previous = if (modern) WebViewCompat.getWebViewClient(web) else resolveLegacyClient?.invoke(web)
            // The pinned plugin selects this public AndroidX client on supported
            // modern WebViews. Never silently drop its compat error/safety hooks.
            if (modern) check(previous is WebViewClientCompat)
            val wrapper = Client(previous ?: error("client"))
            legacyPortMode = !modern
            viewId = platformId; rootRef = WeakReference(root); webRef = WeakReference(web); client = wrapper
            try {
                if (legacyPortMode) {
                    web.webViewClient = wrapper; web.addOnAttachStateChangeListener(detach)
                    return true
                }
                WebViewCompat.addWebMessageListener(web, "tbcKitNative", setOf("*")) { view, message, source, main, _ ->
                    ui()
                    val active = scope ?: return@addWebMessageListener
                    if (view !== web || !main || !current(web, active) || origin(source.toString()) != active["origin"] || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
                    val text = message.data ?: return@addWebMessageListener
                    acceptMessage(web, text, active)
                }
                script = WebViewCompat.addDocumentStartJavaScript(web, pageSource, setOf("*"))
                web.webViewClient = wrapper; web.addOnAttachStateChangeListener(detach)
                return true
            } catch (error: Exception) { dispose(); throw error }
        }
        private fun acceptMessage(web: WebView, text: String, active: Map<String, String>) {
            if (!current(web, active) || text.toByteArray().size > 8 * 1024 * 1024) return
            try {
                val body = JSONObject(text)
                if (body.length() != 2 || body.opt("epoch") != active["navigationId"]) return
                val serialized = body.opt("serialized") as? String ?: return
                if (serialized.toByteArray().size > maxMessage) return
                event(id, "message", mapOf("serialized" to serialized, "source" to mapOf(
                    "webViewInstanceId" to instanceId, "sessionId" to active["sessionId"], "navigationId" to active["navigationId"],
                    "origin" to active["origin"], "topOrigin" to active["origin"], "isMainFrame" to true)))
            } catch (_: Exception) { /* Malformed untrusted page data has no authority. */ }
        }
        private fun offerLegacyPort(web: WebView, url: String) {
            if (!legacyPortMode || !installed(web) || blockedDocument || scope != null ||
                legacyStartedRevision != revision || legacyOfferedRevision == revision || web.url != url) return
            val exactOrigin = origin(url) ?: return
            val captured = revision
            web.evaluateJavascript("typeof window.__tbcFlutterPage==='object'") { present ->
                if (!installed(web) || blockedDocument || revision != captured || web.url != url) return@evaluateJavascript
                if (present != "true") {
                    // Pinned flutter_inappwebview can defer initialUserScripts on WebView 44.
                    // This is a late, bounded fallback, never a grant or origin claim.
                    web.evaluateJavascript(pageSource) {
                        if (installed(web) && !blockedDocument && revision == captured && web.url == url)
                            sendLegacyPort(web, url, exactOrigin, captured)
                    }
                } else sendLegacyPort(web, url, exactOrigin, captured)
            }
        }
        private fun sendLegacyPort(web: WebView, url: String, exactOrigin: String, captured: String) {
            if (!installed(web) || blockedDocument || revision != captured || web.url != url ||
                legacyOfferedRevision == captured) return
            val ports = web.createWebMessageChannel()
            val retained = ports[0]
            val token = UUID.randomUUID().toString()
            legacyPort = retained; legacyToken = token; legacyAcked = false
            retained.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(port: WebMessagePort, message: WebMessage) {
                    ui()
                    if (port !== legacyPort || revision != captured || !installed(web) ||
                        blockedDocument || web.url != url || origin(web.url) != exactOrigin) return
                    val value = message.data ?: return
                    if (!legacyAcked) {
                        if (value != "tbc-native-port-ack:$token") return
                        legacyAcked = true
                        finished(web, url)
                    } else scope?.let { acceptMessage(web, value, it) }
                }
            }, uiHandler)
            try {
                web.postWebMessage(WebMessage("tbc-native-port:$token", arrayOf(ports[1])), Uri.parse(exactOrigin))
                legacyOfferedRevision = captured
            } catch (_: Exception) {
                retained.close(); legacyPort = null; legacyToken = null
                blockedDocument = true; invalidate()
            }
        }
        fun invalidate() {
            val old = scope; scope = null; revision = UUID.randomUUID().toString(); finishing = null
            legacyStartedRevision = null; legacyOfferedRevision = null; legacyToken = null; legacyAcked = false
            legacyPort?.close(); legacyPort = null
            invalidateCustody(id, old)
            event(id, "invalidated", mapOf("navigation" to old))
            if (old != null) webRef.get()?.evaluateJavascript("window.__tbcFlutterPage && window.__tbcFlutterPage.close(${quote(old.getValue("navigationId"))})", null)
        }
        fun close(expected: Map<String, String>): Boolean {
            if (disposed || scope != expected) return false
            blockedDocument = true; invalidate(); return true
        }
        fun revoke() { blockedDocument = true; invalidate() }
        fun dispose() {
            if (disposed) return
            disposed = true; invalidate()
            webRef.get()?.let { web ->
                web.removeOnAttachStateChangeListener(detach)
                if (!legacyPortMode) {
                    script?.remove(); WebViewCompat.removeWebMessageListener(web, "tbcKitNative")
                    if (WebViewCompat.getWebViewClient(web) === client) web.webViewClient = previous ?: WebViewClient()
                } else if (resolveLegacyClient?.invoke(web) === previous && web.isAttachedToWindow) {
                    // The pinned plugin's public delegate field becomes null on disposal.
                    // Restore only while that exact owner still retains its delegate.
                    web.webViewClient = previous ?: WebViewClient()
                }
            }
            script = null; webRef.clear(); rootRef.clear(); previous = null; client = null
        }
        fun evaluate(method: String, value: Any, expected: Map<String, String>, done: (Boolean) -> Unit) {
            val web = webRef.get()
            if (web == null || !current(web, expected)) { done(false); return }
            val captured = revision
            web.evaluateJavascript("window.__tbcFlutterPage && window.__tbcFlutterPage.$method(${quote(expected.getValue("navigationId"))},${quote(value)})") { result ->
                done(captured == revision && current(web, expected) && result == "true")
            }
        }
        private fun finished(web: WebView, url: String) {
            if (!installed(web) || blockedDocument || scope != null || finishing == revision || web.url != url ||
                (legacyPortMode && !legacyAcked)) return
            val canonical = origin(url) ?: return
            val captured = revision; finishing = captured
            val token = UUID.randomUUID().toString()
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).also { it.timeZone = TimeZone.getTimeZone("UTC") }
            val next = mapOf("webViewInstanceId" to instanceId, "sessionId" to UUID.randomUUID().toString(), "navigationId" to token,
                "committedUrl" to url, "origin" to canonical, "topOrigin" to canonical, "frame" to "top", "createdAt" to format.format(Date()))
            web.evaluateJavascript("window.__tbcFlutterPage && window.__tbcFlutterPage.arm(${quote(token)})") { answer ->
                if (captured == revision && installed(web) && !blockedDocument && web.url == url && answer == "true") {
                    scope = next; verifiedNavigation(id,next); event(id, "navigation", next)
                }
            }
        }
        private fun willNavigate(web: WebView, url: String) {
            if (web.url != url && web.url?.substringBefore('#') == url.substringBefore('#')) return
            blockedDocument = true; invalidate()
        }
        private inner class Client(private val delegate: WebViewClient) : WebViewClientCompat() {
            override fun onPageStarted(v: WebView, url: String, icon: Bitmap?) {
                if (v === webRef.get()) {
                    invalidate(); blockedDocument = false
                    if (legacyPortMode) legacyStartedRevision = revision
                }
                delegate.onPageStarted(v, url, icon)
            }
            override fun onPageFinished(v: WebView, url: String) {
                if (legacyPortMode) uiHandler.postDelayed({ offerLegacyPort(v, url) }, 200)
                else finished(v, url)
                delegate.onPageFinished(v, url)
            }
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.isForMainFrame) willNavigate(v, r.url.toString())
                return delegate.shouldOverrideUrlLoading(v, r)
            }
            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(v: WebView, url: String): Boolean { willNavigate(v, url); return delegate.shouldOverrideUrlLoading(v, url) }
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceErrorCompat) {
                if (r.isForMainFrame) { blockedDocument = true; invalidate() }
                if (delegate is WebViewClientCompat) delegate.onReceivedError(v, r, e)
                else delegate.onReceivedError(v, e.errorCode, e.description.toString(), r.url.toString())
            }
            @Suppress("DEPRECATION")
            override fun onReceivedError(v: WebView, code: Int, description: String, url: String) {
                blockedDocument = true; invalidate(); delegate.onReceivedError(v, code, description, url)
            }
            override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, response: WebResourceResponse) {
                if (r.isForMainFrame) { blockedDocument = true; invalidate() }; delegate.onReceivedHttpError(v, r, response)
            }
            override fun onReceivedSslError(v: WebView, handler: SslErrorHandler, error: SslError) {
                // Even if the host's browser UI proceeds, this document gets no wallet session.
                blockedDocument = true; invalidate(); delegate.onReceivedSslError(v, handler, error)
            }
            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                blockedDocument = true; invalidate(); return delegate.onRenderProcessGone(v, detail)
            }
            override fun onSafeBrowsingHit(v: WebView, r: WebResourceRequest, threat: Int, response: SafeBrowsingResponseCompat) {
                blockedDocument = true; invalidate()
                if (delegate is WebViewClientCompat) delegate.onSafeBrowsingHit(v, r, threat, response)
            }
            override fun onPageCommitVisible(v: WebView, url: String) = delegate.onPageCommitVisible(v, url)
            override fun doUpdateVisitedHistory(v: WebView, url: String, reload: Boolean) = delegate.doUpdateVisitedHistory(v, url, reload)
            override fun onLoadResource(v: WebView, url: String) = delegate.onLoadResource(v, url)
            override fun onFormResubmission(v: WebView, dont: Message, resend: Message) = delegate.onFormResubmission(v, dont, resend)
            override fun onReceivedClientCertRequest(v: WebView, r: ClientCertRequest) = delegate.onReceivedClientCertRequest(v, r)
            override fun onReceivedHttpAuthRequest(v: WebView, h: HttpAuthHandler, host: String, realm: String) = delegate.onReceivedHttpAuthRequest(v, h, host, realm)
            override fun onReceivedLoginRequest(v: WebView, realm: String, account: String?, args: String) = delegate.onReceivedLoginRequest(v, realm, account, args)
            override fun onScaleChanged(v: WebView, old: Float, new: Float) = delegate.onScaleChanged(v, old, new)
            override fun onUnhandledKeyEvent(v: WebView, e: KeyEvent) = delegate.onUnhandledKeyEvent(v, e)
            override fun shouldOverrideKeyEvent(v: WebView, e: KeyEvent) = delegate.shouldOverrideKeyEvent(v, e)
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = delegate.shouldInterceptRequest(v, r)
            @Suppress("DEPRECATION")
            override fun shouldInterceptRequest(v: WebView, url: String): WebResourceResponse? = delegate.shouldInterceptRequest(v, url)
            @Suppress("DEPRECATION")
            override fun onTooManyRedirects(v: WebView, cancel: Message, proceed: Message) = delegate.onTooManyRedirects(v, cancel, proceed)
        }
    }
    private companion object {
        const val maxMessage = 4 * 1024 * 1024
        val scopeKeys = setOf("webViewInstanceId", "sessionId", "navigationId", "committedUrl", "origin", "topOrigin", "frame", "createdAt")
    }
}
