package io.tbc.kitloop

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.soloader.nativeloader.NativeLoader
import com.facebook.soloader.nativeloader.SystemDelegate
import io.tbc.engine.TbcEngine
import io.tbc.engine.TbcEngineMethod
import io.tbc.engine.TbcKeylessEngine
import io.tbc.engine.TbcKeylessOperation
import io.tbc.kit.host.NativeSessionFence
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import java.util.concurrent.Executors

// Private VM and fence live on main Looper. Engine work returns through a ticket
// before delivery. Immediate Vault key use is synchronous on that same owner.
class NativeHost(private val activity: LoopActivity) {
    companion object { init {
        // Standalone Hermes has no React Native Application/SoLoader bootstrap.
        // fbjni can attach a GC/runtime worker long after the first JS call.
        NativeLoader.initIfUninitialized(SystemDelegate())
        Class.forName("com.facebook.jni.ThreadScopeSupport")
        System.loadLibrary("tbc_kit_loop")
    } }
    private external fun create(): Long
    private external fun evaluate(handle: Long, code: ByteArray)
    private external fun destroy(handle: Long)
    private val main = Handler(Looper.getMainLooper())
    private val workers = Executors.newFixedThreadPool(2)
    private val engine = TbcEngine()
    private val keylessEngine = TbcKeylessEngine()
    private val fence = NativeSessionFence()
    private val random = SecureRandom()
    private var handle = 0L
    private var vmGeneration = UUID.randomUUID().toString()
    private var ready = false
    private var document = UUID.randomUUID().toString()
    private var authority = JSONObject()
    private val config = JSONObject(activity.assets.open("fixture.json").bufferedReader().use { it.readText() })
    private val realTestnet get() = config.optBoolean("realTestnet")
    private val selfTransferAtomic get() = config.optString("selfTransferAtomic","1000")
    private val vault = DemoVault(activity,realTestnet)
    private val controlledCoinAdmin get() = config.optBoolean("controlledCoinAdmin")
    private val controlledCoinMuSig get() = config.optBoolean("controlledCoinMuSig")
    private val realCoinAdmin get() = config.optBoolean("realCoinAdmin")
    private val hasCoinAdmin get() = controlledCoinAdmin || realCoinAdmin
    private val controlledPoolController get() = config.optBoolean("controlledPoolController")
    private val realPoolController get() = config.optBoolean("realPoolController")
    private val hasPoolController get() = controlledPoolController || realPoolController
    private val realSecondarySigner get() = realCoinAdmin || realPoolController
    private val controlledSecondarySigner get() = controlledCoinAdmin || controlledPoolController
    private val hasSecondarySigner get() = hasCoinAdmin || hasPoolController
    private val secondarySigningRole get() = if(hasPoolController) "pool-controller" else "coin-admin"
    private val secondaryRoleLabel get() = if(hasPoolController) "Pool controller" else "Coin administrator"
    private var adminVault: DemoVault? = null
    private val signingAccounts: List<JSONObject> get() = if(hasSecondarySigner) {
        val values=config.getJSONArray("accounts");(0 until values.length()).map { values.getJSONObject(it) }
    } else listOf(config.getJSONObject("account"))
    private val apiOrigin get() = config.optString("apiOrigin", "https://api.tbcdev.org")
    private val http = TestnetHTTP(apiOrigin)
    private val broadcastDatabase = if(realTestnet) NativeSqliteStore(activity.filesDir.resolve("testnet-broadcast.sqlite")) else null
    private var identityReady = !realTestnet
    private val preferences = activity.getSharedPreferences("native-testnet-permissions",0)
    private val counts = mutableMapOf<String, Int>()
    private val results = JSONArray()
    private val metrics = JSONArray()
    private var jobConsent: JSONObject? = null
    private fun measure(phase:String,fields:JSONObject=JSONObject()) { fields.put("phase",phase).put("monoMs",SystemClock.elapsedRealtimeNanos()/1e6);metrics.put(fields) }
    private val requestMethods = mutableMapOf<String,String>()
    private val seen = mutableSetOf<String>()
    private val deliveries = mutableMapOf<String, NativeSessionFence.DeliveryTicket>()
    private val timers = mutableMapOf<Int, Runnable>()
    private val permits = mutableMapOf<String, Permit>()
    private var pendingApproval: (() -> Unit)? = null
    // Native session-memory store, survives VM recreation but not App restart.
    private val permissionRows = mutableMapOf<String, JSONObject>()
    private val permissionCommits = mutableMapOf<String, Pair<String, String>>()
    private val onboarding get() = config.optBoolean("onboarding", false)
    private data class Permit(val ticket: NativeSessionFence.Ticket, val receipt: JSONObject, val tasks: JSONArray, val messageDigest: String?, val bindingPayload: JSONObject, var stage: Int = 0, val used: MutableSet<String> = mutableSetOf(), var workflowPlan: JSONObject? = null, val workflowTasks: JSONArray = JSONArray(), val workflowStages: MutableMap<String,Int> = mutableMapOf(),var actionTaskCommitment:String?=null,val reviewedTaskCommitments:MutableSet<String> = mutableSetOf(),val reviewedMaterialCommitments:MutableMap<String,String> = mutableMapOf(),val reviewedParents:MutableMap<String,JSONArray> = mutableMapOf(),val reviewedCallIDs:MutableMap<String,String> = mutableMapOf())
    init {
        check(!controlledCoinMuSig || (ControlledMuSig.enabled && controlledCoinAdmin && !realTestnet && !controlledPoolController))
        check(!realCoinAdmin || (realTestnet && !controlledCoinAdmin))
        check(!realPoolController || (realTestnet && !hasCoinAdmin && !controlledPoolController && !controlledCoinMuSig))
        check(!controlledPoolController || (!realTestnet && !hasCoinAdmin))
        if(controlledSecondarySigner) {
            check(!realTestnet)
            val accounts=signingAccounts;check(accounts.size==2)
            check(canonical(accounts[0])==canonical(config.getJSONObject("account")))
            check(accounts[0].getString("accountId")=="tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")
            check(accounts[0].getString("publicKey")=="0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
            val adminAddress=if(controlledCoinMuSig) "1CwpmPr76joFAXxut3k1kgkqdJL9DeJ2VR" else "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP"
            val adminKey=if(controlledCoinMuSig) "023b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec" else "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
            check(accounts[1].getString("chainId")=="tbc:testnet"&&accounts[1].getString("address")==adminAddress)
            check(accounts[1].getString("accountId")=="tbc:testnet:$adminAddress")
            check(accounts[1].getString("publicKey")==adminKey)
            adminVault=DemoVault(activity,false,2)
        }
        if(realTestnet) {
            val digest = "cdb9c215b38872dbec267a145d070233fcfef08c9f29a9a5b30589b93bd64bdf"
            val proof = JSONObject().put("digest",digest).put("signature",vault.sign(digest,"compact65-recoverable"))
            activity.filesDir.resolve("testnet-identity-proof.json").writeText(proof.toString())
            val secondaryProofFile=if(realPoolController) "testnet-controller-identity-proof.json" else "testnet-admin-identity-proof.json"
            val secondaryMetadataFile=if(realPoolController) "real-controller-account.json" else "real-admin-account.json"
            val adminProof = if(realSecondarySigner) {
                val admin=DemoVault(activity,true,slot=if(realPoolController) DemoVault.Slot.POOL_CONTROLLER else DemoVault.Slot.COIN_ADMIN);adminVault=admin
                JSONObject().put("digest",digest).put("signature",admin.sign(digest,"compact65-recoverable")).also {
                    activity.filesDir.resolve(secondaryProofFile).writeText(it.toString())
                }
            } else null
            val selected=activity.filesDir.resolve("transaction-profile.json")
            if(selected.exists())config.put("transactionProfile",JSONObject(selected.readText()))
            val file = activity.filesDir.resolve("real-account.json")
            if(file.exists()) {
                val metadata = JSONObject(file.readText()); check(canonical(metadata.getJSONObject("proof")) == canonical(proof))
                val account = metadata.getJSONObject("account")
                check(account.getString("chainId") == "tbc:testnet" && account.getString("accountId") == "tbc:testnet:"+account.getString("address"))
                config.put("account",account)
                val adminFile=activity.filesDir.resolve(secondaryMetadataFile)
                if(realSecondarySigner && adminFile.exists()) {
                    val adminMetadata=JSONObject(adminFile.readText())
                    check(canonical(adminMetadata.getJSONObject("proof"))==canonical(checkNotNull(adminProof)))
                    val admin=adminMetadata.getJSONObject("account")
                    check(admin.getString("chainId")=="tbc:testnet" && admin.getString("accountId")=="tbc:testnet:"+admin.getString("address"))
                    check(admin.getString("address")!=account.getString("address") && admin.getString("publicKey")!=account.getString("publicKey"))
                    config.put("accounts",JSONArray().put(account).put(admin));identityReady=true
                } else identityReady = !realSecondarySigner
            }
        }
        permissionRows["tbc:testnet"] = JSONObject().put("revision", "0").put("permissions", config.getJSONArray("permissions"))
        if(realTestnet && identityReady) preferences.getString(config.getJSONObject("account").getString("accountId"),null)?.let { saved ->
            check(saved.length <= 1024*1024); val stored = JSONObject(saved)
            val rows = stored.getJSONObject("rows"); rows.keys().forEach { key -> permissionRows[key] = rows.getJSONObject(key) }
            val commits = stored.getJSONObject("commits"); commits.keys().forEach { key -> val pair = commits.getJSONArray(key); permissionCommits[key] = pair.getString(0) to pair.getString(1) }
        }
        // Synthetic fixture only: renew before opening a session, never mutate
        // material or extend an approval in flight. Not a production data API.
        val snapshot = config.getJSONObject("snapshot").getJSONObject("payload")
        val policy = config.getJSONObject("policy").getJSONObject("payload")
        val now = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        snapshot.put("capturedAt", now.toString()).put("expiresAt", now.plusSeconds(240).toString())
        policy.put("expiresAt", now.plusSeconds(240).toString())
        config.getJSONObject("snapshot").put("snapshotHash", hash(snapshot))
        config.getJSONObject("policy").put("policyHash", hash(policy))
        buildVM()
    }
    private fun json(value: Any?): String = when(value) { null -> "null"; is String -> JSONObject.quote(value); else -> value.toString() }
    private fun canonical(value: Any?): String = when(value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        else -> json(value)
    }
    private fun hash(value: JSONObject) = MessageDigest.getInstance("SHA-256").digest(canonical(value).toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    // Keep the trusted wall-clock sample and approval receipts at millisecond
    // precision. Truncating the initial sample can put a later receipt ahead
    // of Kit's monotonic projection even when both use the same device clock.
    private fun instant() = Instant.ofEpochMilli(System.currentTimeMillis()).toString()
    private fun inc(name: String) { counts[name] = (counts[name] ?: 0) + 1 }
    private fun eval(code: String) { check(handle != 0L); evaluate(handle, code.toByteArray(Charsets.UTF_8)) }
    private fun buildVM() {
        vmGeneration = UUID.randomUUID().toString()
        handle = create()
        for (file in (if(realTestnet) listOf("host-bootstrap.js", "bootstrap.js", "network-bootstrap.js", "wallet.js") else listOf("host-bootstrap.js", "bootstrap.js", "wallet.js"))) eval(activity.assets.open(file).bufferedReader().use { it.readText() })
    }
    fun invalidate() {
        ready = false; fence.close(); permits.clear(); seen.clear(); document = UUID.randomUUID().toString()
        http.invalidate(); broadcastDatabase?.invalidate()
        val cancel = pendingApproval; pendingApproval = null; cancel?.invoke()
        activity.dismissApproval()
        if (handle != 0L) eval("__closeWallet()")
        timers.values.forEach { main.removeCallbacks(it) }; timers.clear()
    }
    fun recreate() { invalidate(); destroy(handle); handle = 0; buildVM(); inc("vmRecreated"); save() }
    fun close() { invalidate(); if (handle != 0L) destroy(handle); handle = 0; workers.shutdown(); broadcastDatabase?.close() }
    fun open() {
        if(!identityReady) { inc("awaitingPublicIdentity"); save(); return }
        val account = config.getJSONObject("account"); val session = UUID.randomUUID().toString()
        authority = JSONObject().put("currentContext", JSONObject().put("sessionId", session).put("transport", "webview")
            .put("origin", LoopActivity.ORIGIN).put("topOrigin", LoopActivity.ORIGIN).put("frame", "top").put("navigationId", document).put("createdAt", instant()))
            .put("currentSession", JSONObject().put("version", "1.0").put("scope", JSONObject().put("walletProfile", "native-wallet-integration").put("sessionId", session))
                .put("state", JSONObject().put("version", "1.0").put("sessionId", session).put("revision", "0").put("connected", true).put("activeChainId", "tbc:testnet")
                    .put("activeAccountIds", JSONArray(signingAccounts.map { it.getString("accountId") }.sorted()))))
        fence.replaceVerifiedScope(NativeSessionFence.Scope(LoopActivity.ORIGIN, document, account.getString("accountId"), "tbc:testnet"))
        eval("__openWallet(${json(UUID.randomUUID().toString())},$realTestnet,${json(apiOrigin)}).then(()=>__opened(${json(document)})).catch(()=>__openFailed())")
    }
    fun transportRejected() { inc("transportRejected"); save() }
    private fun rejectLiveRequest(id: String, code: Int) {
        inc("transportRejected")
        results.put(JSONObject().put("outcome","transport-rejected").put("code",code.toString()).put("time",instant()).put("counts",JSONObject(counts.toMap())))
        activity.deliver("$document:$id",JSONObject().put("ok",false).put("code",code))
        save()
    }
    // BEGIN ACCEPTANCE_PROFILE_MATCH
    private fun matchesAcceptanceProfile(entry: JSONObject, intent: JSONObject, constraints: JSONObject, signingRoles: Any? = null): Boolean {
        if(canonical(entry.opt("signingRoles")) != canonical(signingRoles)) return false
        val expected=entry.getJSONObject("intent")
        if(constraints.opt("maxFee") != entry.opt("maxFee") ||
            constraints.keys().asSequence().any { it !in setOf("maxFee","expiresAt","inputOutpoints") }) return false
        val comparable=JSONObject(intent.toString())
        if(entry.optBoolean("runtimePreimage",false)) {
            val value=comparable.opt("preimage") as? String ?: return false
            if(expected.optString("type")!="tbc-htlc-claim" || expected.has("preimage") ||
                value.length>130848 || value.length%2!=0 || value.any { it !in '0'..'9' && it !in 'a'..'f' }) return false
            comparable.remove("preimage")
        }
        if(canonical(comparable)!=canonical(expected)) return false
        return canonical(constraints.opt("inputOutpoints"))==canonical(entry.optJSONObject("constraints")?.opt("inputOutpoints"))
    }
    // END ACCEPTANCE_PROFILE_MATCH
    fun request(raw: String) {
        var liveID: String? = null
        try {
            check(ready && raw.toByteArray(Charsets.UTF_8).size <= 4*1024*1024)
            val body = JSONObject(raw); val id = body.getString("id"); val request = body.getJSONObject("request")
            check(id.length in 1..79 && !seen.contains(id)); seen.add(id); liveID=id
            val enabled=config.getJSONArray("pageMethods")
            if((0 until enabled.length()).none { enabled.getString(it)==request.getString("method") }) {rejectLiveRequest(id,4200);return}
            if(request.getString("method") in setOf("tbc_sendTransaction", "tbc_sendPreparedTransaction")) {
                val p = request.getJSONObject("params"); val intent = p.getJSONObject("intent"); val address = config.getJSONObject("account").getString("address")
                check(p.getString("chainId") == "tbc:testnet" && p.getString("from") == address)
                val ft = config.optJSONObject("transactionProfile") ?: config.optJSONObject("ftTransfer")
                if(ft != null) {
                    val suite=ft.optJSONArray("cases") ?: JSONArray().put(ft)
                    check((0 until suite.length()).any { i ->
                        val entry=suite.getJSONObject(i)
                        matchesAcceptanceProfile(entry,intent,p.getJSONObject("constraints"),p.opt("signingRoles"))
                    })
                } else {
                    check(intent.getString("to") == address && intent.getString("type") == "tbc.transfer" && intent.getString("amount") == selfTransferAtomic && p.getJSONObject("constraints").getString("maxFee") == "200")
                }
            }
            val delivery = "$document:$id"; val protectedMethods=config.getJSONArray("authorizationBoundMethods")
            if(request.getString("method") in setOf("tbc_sendWorkflow","tbc_sendPreparedWorkflow")) {
                val p=request.getJSONObject("params");val address=config.getJSONObject("account").getString("address")
                check(realTestnet&&p.getString("chainId")=="tbc:testnet"&&p.getString("from")==address&&p.getString("maxTotalFee")=="400")
                val steps=p.getJSONArray("steps");check(steps.length() in 1..4)
                for(i in 0 until steps.length()) {
                    val step=steps.getJSONObject(i);val kind=step.getString("kind")
                    check(kind in setOf("transaction","preparedTransaction","message","typedData"))
                    if(kind in setOf("transaction","preparedTransaction")) {
                        val intent=step.getJSONObject("intent")
                        check(intent.getString("type")=="tbc.transfer"&&intent.getString("to")==address&&intent.getString("amount")=="1000"&&step.getJSONObject("constraints").getString("maxFee")=="200")
                    }
                }
            }
            requestMethods[delivery]=request.getString("method")
            deliveries[delivery] = fence.captureDelivery(authorizationBound = (0 until protectedMethods.length()).any { protectedMethods.getString(it)==request.getString("method") }); inc("request")
            eval("__requestWallet(${json(request.toString())}).then(r=>__completed(${json(delivery)},'signed',JSON.stringify(r))).catch(e=>__completed(${json(delivery)},'rejected',String(e.code??'native')))")
        } catch (_: Exception) { liveID?.let { rejectLiveRequest(it,-32602) } ?: transportRejected() }
    }
    // Fixed primitives only; invoked solely from private Hermes, never a page.
    fun dispatch(op: String, bytes: ByteArray): ByteArray {
        check(Looper.myLooper() == Looper.getMainLooper())
        val value = JSONTokener(bytes.toString(Charsets.UTF_8)).nextValue()
        val result: Any? = when(op) {
            "diagnostic" -> { measure("codec-benchmark", value as JSONObject); save(); null }
            "encode" -> JSONArray((value as String).toByteArray(Charsets.UTF_8).map { it.toInt() and 255 })
            "decode" -> { val a = value as JSONArray; Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(ByteArray(a.length()) { a.getInt(it).toByte() })).toString() }
            "url" -> {
                val uri = URI(value as String); check(uri.scheme == "https" && uri.host == "native-kit.test" && uri.rawUserInfo == null && uri.port == -1)
                JSONObject().put("href", value).put("origin", LoopActivity.ORIGIN).put("protocol", "https:").put("host", uri.host).put("hostname", uri.host)
                    .put("port", "").put("username", "").put("password", "").put("pathname", uri.path.ifEmpty { "/" }).put("search", "").put("hash", "")
            }
            "now" -> SystemClock.elapsedRealtimeNanos() / 1_000_000.0
            "networkURL" -> { check(realTestnet); val a = value as JSONArray; TestnetHTTP.url(a.getString(0),a.getString(1),JSONObject(a.getString(2))) }
            "schedule" -> {
                val a = value as JSONArray; val id = a.getInt(0); val old = vmGeneration
                val work = Runnable { if (old == vmGeneration && handle != 0L) { timers.remove(id); eval("__fireTimer($id)") } }
                timers[id] = work; main.postDelayed(work, a.getDouble(1).coerceAtLeast(0.0).toLong()); null
            }
            "cancel" -> { timers.remove((value as Number).toInt())?.let { main.removeCallbacks(it) }; null }
            "opened" -> { if (value == document) { ready = true; activity.web.evaluateJavascript("ready()", null) }; null }
            "openFailed" -> { inc("openFailed"); save(); null }
            "completed" -> { val a = value as JSONArray; complete(a.getString(0), a.getString(1), a.getString(2)); null }
            "call" -> {
                val a = value as JSONArray; val id = a.getString(0); val method = a.getString(1); val input = a.getString(2)
                val target = handle; val generation = vmGeneration; val ticket = runCatching { fence.capture(120.0) }.getOrNull()
                // Defer to avoid JSI reentry; capture lifetime before queueing.
                main.post {
                    if (generation == vmGeneration && target == handle && target != 0L) {
                        if (ticket == null) settle(target, id, "", "closed")
                        else try { fence.check(ticket); inc(method); dispatchCall(method, input) { output, error ->
                            if (generation == vmGeneration && target == handle && target != 0L) {
                                val valid = runCatching { fence.finish(ticket) }.isSuccess
                                settle(target, id, if (valid) output else "", if (valid) error else "stale")
                            }
                        } } catch (_: Exception) { settle(target, id, "", "rejected") }
                    }
                }; null
            }
            else -> error("Unknown private host operation")
        }
        return json(result).toByteArray(Charsets.UTF_8)
    }
    private fun settle(target: Long, id: String, output: String, error: String) {
        if (target == handle && handle != 0L) eval("__settle(${json(id)},${json(output)},${json(error)})")
    }
    private fun dispatchCall(method: String, input: String, done: (String, String) -> Unit) {
        if (method.startsWith("keyless.")) {
            val operation = TbcKeylessOperation.entries.single { it.wireName == method.removePrefix("keyless.") }
            workers.execute {
                val output = runCatching { runBlocking { keylessEngine.callEnvelope(operation, input) } }
                main.post { done(output.getOrDefault(""), if (output.isSuccess) "" else "keyless-failure") }
            }; return
        }
        if (method.startsWith("engine.")) {
            val operation = TbcEngineMethod.entries.single { it.wireName == method.removePrefix("engine.") }
            val computeStart = SystemClock.elapsedRealtimeNanos()
            workers.execute {
                val output = runCatching { runBlocking { engine.callEnvelope(operation, input) } }
                main.post {
                    val checked = runCatching { val raw=output.getOrThrow(); if(method=="engine.validate") acceptValidatedContinuation(JSONObject(input),JSONObject(raw)); raw }
                    measure("engine",JSONObject().put("method",method).put("elapsedMs",(SystemClock.elapsedRealtimeNanos()-computeStart)/1e6).put("inputChars",input.length).put("outputChars",output.getOrDefault("").length))
                    done(checked.getOrDefault(""), if(checked.isSuccess) "" else "engine-failure")
                }
            }; return
        }
        val data = JSONTokener(input).nextValue()
        if(method.startsWith("sqlite.")) { check(realTestnet); done(json(broadcastDatabase!!.call(method,data as? JSONObject ?: JSONObject())),""); return }
        if(method == "http.cancel") { check(realTestnet); http.cancel((data as JSONObject).getString("id")); done("null",""); return }
        if(method == "http.request") {
            check(realTestnet); val request = data as JSONObject
            inc("http."+request.getString("method"))
            if(request.getString("method")=="POST")inc(if(request.getString("url").contains("/txo/status")) "readonly.POST" else "broadcast.POST")
            save()
            val httpStart=SystemClock.elapsedRealtimeNanos()
            measure("http-start",JSONObject().put("url",request.getString("url")).put("method",request.getString("method")))
            workers.execute { val response = runCatching { http.request(request) }; main.post { measure("http-end",JSONObject().put("url",request.getString("url")).put("method",request.getString("method")).put("elapsedMs",(SystemClock.elapsedRealtimeNanos()-httpStart)/1e6)); done(response.getOrDefault(""),if(response.isSuccess) "" else "network-failure") } }; return
        }
        if(method=="job.approve") {approveJob(data as JSONObject,done);return}
        if(method=="job.authorize") {done(authorizeJob(data as JSONObject).toString(),"");return}
        if (method == "approval.request") { approve(data as JSONObject, done); return }
        if (method == "reviewed.execute") { reviewed(data as JSONObject, done); return }
        if (method == "reviewed.signStage") { reviewed(data as JSONObject, done, true); return }
        val result: Any = when(method) {
            "accounts.current" -> JSONArray(signingAccounts)
            "accounts.forChain" -> {check((data as JSONObject).getString("chainId")=="tbc:testnet");JSONArray(signingAccounts)}
            "wallet.signingRoles" -> JSONArray(((if(hasSecondarySigner)listOf(secondarySigningRole) else emptyList())+(if(realTestnet)listOf("coin-admin") else emptyList())).distinct().sorted())
            "authority.read" -> authority
            "clock.now" -> instant().also { measure("clock-read",JSONObject().put("iso",it)) }
            "permissions.load" -> permissionRows[permissionChain((data as JSONObject).getJSONObject("params").getJSONObject("scope"))]
                ?: JSONObject().put("revision", "0").put("permissions", JSONArray())
            "permissions.commit" -> commitPermissions(data as JSONObject)
            "authority.commit" -> {
                val input = data as JSONObject; val payload = input.getJSONObject("mutation").getJSONObject("payload")
                val current = authority.getJSONObject("currentSession"); val target = payload.getJSONObject("target")
                check(canonical(input.getJSONObject("expected")) == canonical(authority))
                check(canonical(payload.getJSONObject("scope")) == canonical(current.getJSONObject("scope")))
                check(payload.getString("expectedRevision") == current.getJSONObject("state").getString("revision"))
                authority.put("currentSession", JSONObject().put("version", "1.0").put("scope", payload.getJSONObject("scope")).put("state", target))
                JSONObject().put("acknowledgment", JSONObject().put("version", "1.0").put("commitId", input.getString("commitId"))
                    .put("status", "committed").put("revision", target.getString("revision"))).put("authority", authority)
            }
            "chain.read" -> {
                check(!realTestnet)
                val query=data as JSONObject;val snapshot=config.getJSONObject("snapshot")
                if(query.has("workflowSteps")) {
                    // Isolated fixture only. Real Testnet uses Kit's shared loader.
                    val steps=query.getJSONArray("workflowSteps");check(controlledSecondarySigner && steps.length()==1)
                    val step=steps.getJSONObject(0)
                    check(step.getJSONObject("requirement").getString("intentType")==if(controlledPoolController) "tbc-amm-swap" else "tbc20-stablecoin-create")
                    check(canonical(step.getJSONArray("signingAccounts"))==canonical(snapshot.getJSONObject("payload").getJSONArray("signingAccounts")))
                    check(canonical(step.getJSONArray("signingRoles"))==canonical(JSONArray().put(JSONObject().put("role",secondarySigningRole).put("accountId",signingAccounts[1].getString("accountId")))))
                    JSONObject().put("version","1.0").put("steps",JSONArray().put(JSONObject().put("stepId",step.getString("stepId")).put("snapshot",snapshot)))
                } else snapshot
            }
            "policy.read" -> { check(!realTestnet); config.getJSONObject("policy") }
            "entropy.bytes" -> { val size = (data as JSONObject).getInt("length"); check(size in 1..1024); val bytes = ByteArray(size); random.nextBytes(bytes); JSONArray(bytes.map { it.toInt() and 255 }) }
            "signer.sign" -> sign(data as JSONObject)
            "crypto.execute" -> crypt(data as JSONObject)
            else -> error("No such host adapter")
        }
        done(json(result), "")
    }
    private fun permissionChain(scope: JSONObject): String {
        check(scope.getString("origin") == LoopActivity.ORIGIN)
        return scope.getString("chainId").also { check(it in listOf("tbc:mainnet", "tbc:testnet")) }
    }
    private fun commitPermissions(input: JSONObject): JSONObject {
        val params = input.getJSONObject("params"); val id = input.getJSONObject("port").getString("callId")
        val encoded = canonical(params)
        permissionCommits[id]?.let { check(it.first == encoded); return JSONObject(it.second) }
        val changes = params.getJSONArray("changes"); check(changes.length() > 0)
        val next = permissionRows.toMutableMap(); val revisions = JSONArray(); val chains = mutableSetOf<String>()
        for (i in 0 until changes.length()) {
            val change = changes.getJSONObject(i); val scope = change.getJSONObject("scope"); val chain = permissionChain(scope)
            val expected = change.getString("expectedRevision"); check(chains.add(chain))
            check(expected == (next[chain]?.getString("revision") ?: "0"))
            val permissions = change.getJSONArray("permissions")
            for (p in 0 until permissions.length()) check(permissions.getJSONObject(p).getString("invoker") == LoopActivity.ORIGIN)
            val number = expected.toLong(); check(number in 0 until Long.MAX_VALUE); val revision = (number + 1).toString()
            next[chain] = JSONObject().put("revision", revision).put("permissions", permissions)
            revisions.put(JSONObject().put("scope", scope).put("revision", revision))
        }
        val result = JSONObject().put("revisions", revisions)
        if(realTestnet) {
            val commits = JSONObject(); permissionCommits.forEach { (key,pair) -> commits.put(key,JSONArray().put(pair.first).put(pair.second)) }
            commits.put(id,JSONArray().put(encoded).put(result.toString()))
            val saved = JSONObject().put("rows",JSONObject(next.toMap())).put("commits",commits).toString()
            check(saved.length <= 1024*1024)
            check(preferences.edit().putString(config.getJSONObject("account").getString("accountId"),saved).commit())
        }
        permissionRows.clear(); permissionRows.putAll(next); permissionCommits[id] = encoded to result.toString()
        inc("permissionWrites"); save()
        // Commit first; failed CAS and idempotent replay do not change fencing.
        fence.authorizationChanged(); permits.clear()
        val cancel = pendingApproval; pendingApproval = null; cancel?.invoke()
        if (cancel != null) activity.dismissApproval()
        return result
    }
    val revocationAcceptance: Boolean get() = config.optBoolean("revocation")
    fun revokeForAcceptance() {
        check(revocationAcceptance)
        val change = JSONObject().put("scope", JSONObject().put("origin", LoopActivity.ORIGIN).put("chainId", "tbc:testnet"))
            .put("expectedRevision", permissionRows["tbc:testnet"]?.getString("revision") ?: "0").put("permissions", JSONArray())
        commitPermissions(JSONObject().put("port", JSONObject().put("callId", UUID.randomUUID().toString()))
            .put("params", JSONObject().put("changes", JSONArray().put(change))))
        inc("nativeRevocations"); save()
    }
    private fun approveJob(input:JSONObject,done:(String,String)->Unit) {
        val scope=input.getJSONObject("scope");val auth=scope.getJSONObject("authority");val limits=scope.getJSONObject("limits");val expiry=Instant.parse(limits.getString("expiresAt"));val items=scope.getJSONArray("items")
        check(jobConsent==null && auth.getString("chainId")=="tbc:testnet" && auth.getString("accountId")==signingAccounts[0].getString("accountId") && auth.getString("origin")==LoopActivity.ORIGIN)
        check(input.getString("scopeHash").length==64 && limits.getString("maxTotalFee").toLong() in 0..200000 && items.length() in 1..250 && expiry.isAfter(Instant.now()))
        val ticket=fence.capture(minOf(120.0,(expiry.toEpochMilli()-System.currentTimeMillis())/1000.0),authorizationBound=true)
        inc("approvalUI");save()
        activity.showApproval("TESTNET NFT MINT JOB — all items and recipients\n"+scope.toString(),false) {choice->
            try {
                fence.check(ticket)
                if(choice!="approve"){done(JSONObject().put("status","rejected").put("scopeHash",input.getString("scopeHash")).toString(),"")}
                else {
                    val receipt=JSONObject().put("status","approved").put("scopeHash",input.getString("scopeHash")).put("approvalId",UUID.randomUUID().toString()).put("approvedAt",instant()).put("expiresAt",limits.getString("expiresAt"))
                    jobConsent=JSONObject().put("scope",scope).put("scopeHash",input.getString("scopeHash")).put("receipt",receipt).put("document",document)
                    measure("approved",JSONObject().put("kind","nft-job").put("items",items.length()).put("approvedAt",receipt.getString("approvedAt")).put("expiresAt",receipt.getString("expiresAt")));inc("approved");save();done(receipt.toString(),"")
                }
            }catch(_:Exception){done("","job-approval-denied")}
        }
    }
    private fun authorizeJob(input:JSONObject):JSONObject {
        val consent=checkNotNull(jobConsent);check(consent.getString("document")==document && canonical(input.get("scope"))==canonical(consent.get("scope")) && input.getString("scopeHash")==consent.getString("scopeHash") && canonical(input.get("approval"))==canonical(consent.get("receipt")))
        val params=input.getJSONObject("params");val binding=params.getJSONObject("binding");val payload=binding.getJSONObject("payload");val plan=input.getJSONObject("plan");val pp=plan.getJSONObject("payload");val auth=consent.getJSONObject("scope").getJSONObject("authority");val expiry=Instant.parse(payload.getString("expiresAt"));val tasks=pp.getJSONArray("signingTasks")
        check(payload.getString("operationKind")=="transaction" && payload.getString("operationHash")==plan.getString("planHash") && canonical(params.get("preview"))==canonical(pp.get("preview")))
        check(payload.getString("accountId")==auth.getString("accountId") && payload.getString("chainId")=="tbc:testnet" && payload.getString("origin")==LoopActivity.ORIGIN && expiry.isAfter(Instant.now()) && !expiry.isAfter(Instant.parse(consent.getJSONObject("receipt").getString("expiresAt"))))
        check(tasks.length()>0 && (0 until tasks.length()).all{signingTaskMatchesAccount(tasks.getJSONObject(it))})
        val ticket=fence.capture(minOf(120.0,(expiry.toEpochMilli()-System.currentTimeMillis())/1000.0),authorizationBound=true);val id=UUID.randomUUID().toString()
        val receipt=JSONObject().put("status","approved").put("approvalId",id).put("approvalToken",UUID.randomUUID().toString()).put("bindingHash",binding.getString("bindingHash")).put("approvedAt",instant()).put("expiresAt",payload.getString("expiresAt"))
        permits[id]=Permit(ticket,receipt,tasks,null,payload);measure("batch-credential",JSONObject().put("tasks",tasks.length()));save();return receipt
    }
    private fun approve(input: JSONObject, done: (String, String) -> Unit) {
        check(pendingApproval == null)
        val params = input.getJSONObject("params"); val binding = params.getJSONObject("binding"); val payload = binding.getJSONObject("payload")
        val expiry = Instant.parse(payload.getString("expiresAt"))
        check(input.getJSONObject("presentation").getString("trust") == "binding-verified" && payload.getString("origin") == LoopActivity.ORIGIN && expiry.isAfter(Instant.now()))
        val ticket = fence.capture(minOf(120.0, (expiry.toEpochMilli() - System.currentTimeMillis()) / 1000.0), authorizationBound = true)
        val permission = payload.getString("operationKind") == "permission"
        val label = if(config.optJSONObject("ftTransfer") != null) "REAL TESTNET · 1 raw C192 FT · max fee 1000\n" else "REAL TESTNET · self-send $selfTransferAtomic atomic · max fee 200\n"
        val profile=config.optJSONObject("transactionProfile")
        val heading=profile?.let { "REAL TESTNET · ${it.optString("title","Test asset suite")}\n" } ?: "REAL TESTNET · ${payload.optString("method")}\n"
        val terms=input.getJSONObject("presentation").getJSONObject("businessTerms")
        val identity=if(terms.getString("status")=="known") "\nBound terms: ${terms.get("value")}" else ""
        val roleDisclosure=input.getJSONObject("presentation").optJSONObject("signingRoles")?.let { roles ->
            check(roles.getString("status")=="known")
            val rows=roles.getJSONArray("value");check(rows.length()>0)
            "\nFee account: ${signingAccounts[0].getString("address")}" + (0 until rows.length()).joinToString("") { index ->
                val row=rows.getJSONObject(index)
                val primary=row.getString("accountId")==signingAccounts[0].getString("accountId");val isAdmin=row.getString("role")=="coin-admin"
                check((isAdmin&&primary&&realTestnet)||(hasSecondarySigner&&row.getString("role")==secondarySigningRole&&row.getString("accountId")==signingAccounts[1].getString("accountId")))
                val selected=signingAccounts[if(primary)0 else 1];val label=if(isAdmin)"Coin administrator" else "Pool controller"
                val step=if(row.has("stepId")) " (step ${row.getString("stepId")})" else ""
                "\n$label$step: ${selected.getString("address")}"
            }
        } ?: ""
        val warningRows=input.getJSONObject("presentation").optJSONArray("warnings") ?: JSONArray()
        val warnings=(0 until warningRows.length()).map { index ->
            val code=warningRows.getString(index)
            if(code=="HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE")
                "Signing an HTLC claim reveals the preimage in the signed transaction, even before broadcast. Share signed bytes only when ready to disclose it."
            else code
        }
        val disclosures=if(warnings.isEmpty()) "" else "\nWarnings:\n"+warnings.joinToString("\n")
        pendingApproval = { done("", "stale") }; inc("approvalUI"); save()
        val cooperativeDisclosure=if(controlledCoinMuSig) "\nPUBLIC FIXTURE ONLY: 2-of-2 MuSig administrator. Two PUBLIC keys in this App's isolated Keystore; this approval authorizes both. No independent remote participant or broadcast." else ""
        activity.showApproval((if(realTestnet) heading else "TEST ONLY · no broadcast\n")+"${LoopActivity.ORIGIN}"+roleDisclosure+cooperativeDisclosure+"\n\n${params.getJSONObject("preview")}"+identity+disclosures, permission) { decision ->
            measure("approval-choice",JSONObject().put("choice",decision).put("pending",pendingApproval!=null));save()
            if (pendingApproval != null) {
                pendingApproval = null
                try {
                    fence.check(ticket)
                    if (decision == "reject") {
                        fence.cancel(ticket); inc("rejected")
                        done(JSONObject().put("status", "rejected").put("bindingHash", binding.getString("bindingHash")).put("rejectedAt", instant()).toString(), "")
                    } else {
                        val id = UUID.randomUUID().toString()
                        val receipt = JSONObject().put("status", "approved").put("approvalId", id).put("approvalToken", UUID.randomUUID().toString())
                            .put("bindingHash", binding.getString("bindingHash")).put("approvedAt", instant()).put("expiresAt", payload.getString("expiresAt"))
                        if (!permission) {
                            val permit=Permit(ticket, receipt, input.getJSONArray("signingTasks"), params.getJSONObject("preview").optString("digest").takeIf { it.isNotEmpty() }, payload)
                            val materials=input.optJSONArray("reviewedMaterials") ?: JSONArray()
                            for(i in 0 until materials.length()) {
                                val material=materials.getJSONObject(i);val taskID=material.getString("taskId")
                                check(!permit.reviewedMaterialCommitments.containsKey(taskID))
                                permit.reviewedMaterialCommitments[taskID]=hash(material)
                            }
                            input.optJSONObject("walletActionPlan")?.let { plan ->
                                check(plan.getString("planHash")==payload.getString("operationHash"))
                                permit.actionTaskCommitment=hash(plan.getJSONObject("payload").getJSONObject("task"))
                            }
                            if(payload.optString("operationKind")=="workflow") {
                                val plan=input.getJSONObject("workflowPlan")
                                check(plan.getString("workflowPlanHash")==payload.getString("operationHash"))
                                // Private continuation projection; never treat this as a replacement signed plan.
                                val projection=JSONObject(plan.toString());val projectedPayload=projection.getJSONObject("payload")
                                val reviewedTasks=projectedPayload.getJSONArray("reviewedTransactionTasks")
                                for(i in 0 until reviewedTasks.length())permit.reviewedTaskCommitments.add(hash(reviewedTasks.getJSONObject(i)))
                                projectedPayload.remove("reviewedTransactionTasks")
                                permit.workflowPlan=projection
                                val tasks=plan.getJSONObject("payload").getJSONArray("immediateSigningTasks")
                                for(i in 0 until tasks.length())permit.workflowTasks.put(tasks.getJSONObject(i))
                            }
                            permits[id]=permit
                        }
                        measure("approved"); inc("approved"); done(receipt.toString(), "")
                    }
                } catch (failure: Exception) {
                    measure("approval-adapter-rejected",JSONObject().put("class",failure.javaClass.simpleName).put("reason",if(failure is NativeSessionFence.Failure) failure.reason.name else "adapter-check"));save()
                    done("", "rejected")
                }
            }
        }
    }
    private fun reviewed(input:JSONObject,done:(String,String)->Unit,stageOnly:Boolean=false) {
        val params=input.getJSONObject("params");val task=params.getJSONObject("task");val receipt=params.getJSONObject("approval");val material=input.getJSONObject("material")
        val id=receipt.getString("approvalId");val permit=permits[id] ?: error("Missing approval");val taskID=task.getString("taskId");val account=config.getJSONObject("account")
        check(realTestnet&&canonical(receipt)==canonical(permit.receipt)&&task.getString("purpose")=="reviewedTransaction")
        check(task.getString("publicKey")==account.getString("publicKey")&&task.getString("accountId")==account.getString("accountId"))
        check(permit.bindingPayload.getString("origin")==LoopActivity.ORIGIN&&task.getString("contextHash")==permit.bindingPayload.getString("contextHash")&&task.getString("chainId")==account.getString("chainId"))
        var onceID=taskID
        if(permit.workflowPlan!=null) {
            val plan=permit.workflowPlan!!;val evidence=input.getJSONObject(if(stageOnly) "evidence" else "workflowTask")
            check(evidence.getString("workflowPlanHash")==plan.getString("workflowPlanHash")&&evidence.getString("bindingHash")==receipt.getString("bindingHash")&&canonical(evidence.getJSONObject("task"))==canonical(task))
            check(permit.reviewedTaskCommitments.contains(hash(task)))
            onceID=evidence.getString("stepId")+":"+taskID
        } else check(permit.actionTaskCommitment!=null&&permit.actionTaskCommitment==hash(task))
        val format=material.getString("format");val request=material.getJSONObject("request")
        val policyMaterial=material.getJSONObject("policyMaterial");val resolvedOutputs=policyMaterial.getJSONArray("resolvedOutputs")
        check(canonical(task.getJSONObject("policyMaterial"))==canonical(policyMaterial))
        check(format in listOf("raw","associated")&&permit.reviewedMaterialCommitments[taskID]==hash(JSONObject().put("taskId",taskID).put("format",format).put("request",request).put("policyMaterial",policyMaterial)))
        val count=if(format=="raw")request.getJSONArray("txraws").length() else 1+request.getJSONArray("inputs").length();check(count in 1..32)
        if(stageOnly) {
            val port=input.getJSONObject("port");val evidence=input.getJSONObject("evidence");val index=input.getInt("transactionIndex")
            check(input.getDouble("transactionIndex")==index.toDouble())
            val callID=port.getString("callId");val roles=task.getJSONArray("signingRoles")
            check(index in 0 until count&&evidence.getString("callId")==callID&&port.getString("operation")=="reviewedTransaction.execute")
            check(evidence.getString("bindingHash")==receipt.getString("bindingHash")&&canonical(evidence.getJSONObject("task"))==canonical(task)&&canonical(port.getJSONObject("params"))==canonical(params))
            check(Instant.parse(receipt.getString("expiresAt")).isAfter(Instant.now())&&roles.length()==1&&roles.getJSONObject(0).getString("role")=="coin-admin")
            val administrator=roles.getJSONObject(0).getJSONObject("account")
            check(signingAccounts.singleOrNull {it.optString("accountId")==administrator.getString("accountId")}?.let {canonical(it)==canonical(administrator)}==true)
            if(index==0) {
                check(onceID !in permit.used);fence.startBoundTaskOnce(permit.ticket,onceID) {}
                permit.used.add(onceID);permit.reviewedParents[onceID]=JSONArray();permit.reviewedCallIDs[onceID]=callID
            }
            val parents=checkNotNull(permit.reviewedParents[onceID]);check(parents.length()==index&&permit.reviewedCallIDs[onceID]==callID)
            // Consume on the Vault executor before suspension. Failure and
            // concurrent duplicates never authorize a retry of this stage.
            fence.startBoundTaskOnce(permit.ticket,"reviewed-stage:$onceID:$index") {}
            fun stageFailure(code:String) {permit.reviewedParents.remove(onceID);permit.reviewedCallIDs.remove(onceID);done("",code)}
            val requestStage=JSONObject().put("format",format).put("request",request).put("publicKey",account.getString("publicKey")).put("transactionIndex",index).put("previousTransactions",if(format=="associated")parents else JSONArray()).put("resolvedOutputs",resolvedOutputs)
            workers.execute {
                val prepared=runCatching {JSONObject(runBlocking {keylessEngine.callEnvelope(TbcKeylessOperation.PREPARE_REVIEWED_STAGE,requestStage.toString())})}
                main.post {
                    try {
                        fence.check(permit.ticket);val stage=prepared.getOrThrow();check(canonical(stage)==canonical(input.getJSONObject("stage")))
                        val digests=stage.getJSONArray("digests");val indexes=stage.getJSONArray("signingInputIndexes");val inputs=stage.getJSONArray("inputs")
                        check(digests.length() in 1..1000&&indexes.length()==digests.length());val expectedTasks=JSONArray()
                        for(slot in 0 until digests.length()) {
                            val n=indexes.getInt(slot);check(n in 0 until inputs.length());val item=inputs.getJSONObject(n)
                            val marked=if(item.has("signingPublicKey"))item.getString("signingPublicKey") else null
                            val selectedAccount=if(marked==null)account else administrator;val key=selectedAccount.getString("publicKey");val selected=marked?:key
                            check(selected==key||selected==key.substring(2));check(marked==null||item.getString("scriptSigType")=="tbc20-stablecoin")
                            val expected=JSONObject().put("inputIndex",n).put("digest",digests.getString(slot)).put("publicKey",selected).put("algorithm",if(selected.length==64)"secp256k1-schnorr" else "secp256k1-ecdsa")
                            val engineTasks=stage.optJSONArray("signingTasks")
                            if(engineTasks!=null)check(engineTasks.length()==digests.length()&&canonical(engineTasks.getJSONObject(slot))==canonical(expected)) else check(marked==null)
                            expectedTasks.put(expected.put("accountId",selectedAccount.getString("accountId")))
                        }
                        check(canonical(expectedTasks)==canonical(input.getJSONArray("tasks")));val signatures=JSONArray()
                        for(slot in 0 until expectedTasks.length()) {
                            val item=expectedTasks.getJSONObject(slot);val primary=item.getString("accountId")==account.getString("accountId")
                            check(primary||realCoinAdmin);val selected=if(primary)vault else checkNotNull(adminVault)
                            val encoding=if(item.getString("algorithm")=="secp256k1-schnorr")"schnorr64" else "compact64"
                            signatures.put(fence.startBoundTaskOnce(permit.ticket,"reviewed:$onceID:$index:$slot"){selected.sign(item.getString("digest"),encoding)})
                            inc("vaultSigns");inc(if(primary)"feeVaultSigns" else "adminVaultSigns")
                        }
                        val finish=JSONObject().put("stage",stage).put("signatures",signatures).put("signatureEncoding","compact64")
                        workers.execute {
                            val finalized=runCatching {JSONObject(runBlocking {keylessEngine.callEnvelope(TbcKeylessOperation.FINALIZE_REVIEWED_STAGE,finish.toString())})}
                            main.post {
                                try {
                                    fence.check(permit.ticket);val result=finalized.getOrThrow();check(permits[id]===permit)
                                    if(format=="raw") {
                                        check(result.getString("txraw")==request.getJSONArray("txraws").getString(index))
                                        val detached=result.getJSONArray("sigs");check(detached.length()==inputs.length())
                                        check((0 until detached.length()).all {detached.getString(it).matches(Regex("^(?:[0-9a-f]{2}){1,512}$"))})
                                    }
                                    if(index+1==count){permit.reviewedParents.remove(onceID);permit.reviewedCallIDs.remove(onceID)}else parents.put(result.getString("txraw"))
                                    done(signatures.toString(),"")
                                }catch(_:Exception){stageFailure("reviewed-stage-finalize-failure")}
                            }
                        }
                    }catch(_:Exception){stageFailure("reviewed-stage-sign-failure")}
                }
            }
            return
        }
        check(onceID !in permit.used);fence.startBoundTaskOnce(permit.ticket,onceID) {};permit.used.add(onceID)
        val raws=JSONArray();val matrix=JSONArray()
        fun stage(index:Int) {
            try {fence.check(permit.ticket)}catch(_:Exception){done("","stale");return}
            if(index==count){done((if(format=="raw")JSONObject().put("sigs",matrix) else JSONObject().put("txraws",raws)).toString(),"");return}
            val requestStage=JSONObject().put("format",format).put("request",request).put("publicKey",account.getString("publicKey")).put("transactionIndex",index).put("previousTransactions",if(format=="associated")raws else JSONArray()).put("resolvedOutputs",resolvedOutputs)
            workers.execute {
                val prepared=runCatching {JSONObject(runBlocking {keylessEngine.callEnvelope(TbcKeylessOperation.PREPARE_REVIEWED_STAGE,requestStage.toString())})}
                main.post {
                    try {
                        fence.check(permit.ticket);val current=prepared.getOrThrow();val digests=current.getJSONArray("digests");check(digests.length() in 1..1000);val signatures=JSONArray()
                        for(slot in 0 until digests.length()){
                            signatures.put(fence.startBoundTaskOnce(permit.ticket,"reviewed:$onceID:$index:$slot"){vault.sign(digests.getString(slot),"compact64")});inc("vaultSigns")
                        }
                        val finish=JSONObject().put("stage",current).put("signatures",signatures).put("signatureEncoding","compact64")
                        workers.execute {
                            val finalized=runCatching {JSONObject(runBlocking {keylessEngine.callEnvelope(TbcKeylessOperation.FINALIZE_REVIEWED_STAGE,finish.toString())})}
                            main.post {
                                try {fence.check(permit.ticket);val result=finalized.getOrThrow();raws.put(result.getString("txraw"));matrix.put(result.getJSONArray("sigs"));stage(index+1)}catch(_:Exception){done("","reviewed-finalize-failure")}
                            }
                        }
                    }catch(_:Exception){done("","reviewed-sign-failure")}
                }
            }
        }
        stage(0)
    }
    private fun signingTaskMatchesAccount(task: JSONObject): Boolean {
        fun lowerHex(value: String, size: Int) = value.length == size && value.all { it in '0'..'9' || it in 'a'..'f' }
        val account = signingAccounts.singleOrNull { it.optString("accountId")==task.optString("accountId") } ?: return false
        val id = account.optString("accountId"); val key = account.optString("publicKey")
        if (id.isEmpty() || task.optString("accountId") != id || !lowerHex(key, 66) || !(key.startsWith("02") || key.startsWith("03")) || !lowerHex(task.optString("digest"), 64)) return false
        val encoding = task.optString("signatureEncoding"); val algorithm = task.optString("algorithm")
        if (task.optString("purpose") == "transaction") {
            if (task.opt("sighashType") !is Number || task.getDouble("sighashType") != 65.0) return false
            if (algorithm == "secp256k1-schnorr-bip340") return encoding == "schnorr64" && task.optString("publicKey") == key.substring(2)
            return algorithm == "secp256k1-ecdsa-sha256d" && encoding == "compact64" && task.optString("publicKey") == key
        }
        return task.optString("purpose") in listOf("message", "typedData") && algorithm == "secp256k1-recoverable-ecdsa-sha256d" && encoding == "compact65-recoverable" && task.optString("publicKey") == key
    }
    private fun acceptValidatedContinuation(p: JSONObject, output: JSONObject) {
        val pending=p.optJSONObject("pending") ?: return
        if(p.optString("phase")!="finalized" || !output.optBoolean("ok") || output.optJSONObject("result")?.optBoolean("valid")!=true) return
        val approval=p.getJSONObject("approval"); val id=approval.getString("approvalId"); val permit=permits[id] ?: error("Missing native approval")
        val continuation=pending.getJSONObject("continuation")
        permit.workflowPlan?.let { workflow ->
            val entries=workflow.getJSONObject("payload").getJSONArray("transactionPlans")
            val child=p.getJSONObject("plan")
            val entry=(0 until entries.length()).map { entries.getJSONObject(it) }.single { canonical(it.getJSONObject("plan"))==canonical(child) }
            val step=entry.getString("stepId")
            check(canonical(approval)==canonical(permit.receipt))
            check(continuation.getString("approvalId")==id&&continuation.getString("bindingHash")==permit.receipt.getString("bindingHash"))
            check(p.getString("requestHash")==child.getJSONObject("payload").getString("requestHash"))
            check(continuation.getString("requestHash")==p.getString("requestHash")&&continuation.getString("planHash")==child.getString("planHash"))
            check(continuation.getInt("stage")==permit.workflowStages.getOrDefault(step,0)+1)
            fence.check(permit.ticket)
            val previous=(0 until permit.workflowTasks.length()).map {permit.workflowTasks.getJSONObject(it)}.filter {it.getString("stepId")==step}
            check(previous.all { "$step:${it.getJSONObject("task").getString("taskId")}" in permit.used })
            val ids=previous.map {it.getJSONObject("task").getString("taskId")}.toMutableSet()
            val tasks=pending.getJSONArray("signingRequests");check(tasks.length()>0)
            for(i in 0 until tasks.length()) {
                val task=tasks.getJSONObject(i)
                check(ids.add(task.getString("taskId"))&&signingTaskMatchesAccount(task))
            }
            // Validate the entire continuation before changing the permit.
            for(i in 0 until tasks.length())permit.workflowTasks.put(JSONObject().put("stepId",step).put("task",tasks.getJSONObject(i)))
            permit.workflowStages[step]=continuation.getInt("stage");inc("validatedWorkflowContinuation");return
        }
        check(canonical(approval)==canonical(permit.receipt))
        check(p.getString("requestHash")==permit.bindingPayload.getString("requestHash") && p.getJSONObject("plan").getString("planHash")==permit.bindingPayload.getString("operationHash"))
        check(continuation.getString("approvalId")==id && continuation.getString("bindingHash")==permit.receipt.getString("bindingHash"))
        check(continuation.getString("requestHash")==permit.bindingPayload.getString("requestHash") && continuation.getString("planHash")==permit.bindingPayload.getString("operationHash"))
        check(continuation.getInt("stage")==permit.stage+1)
        check((0 until permit.tasks.length()).all { permit.tasks.getJSONObject(it).getString("taskId") in permit.used })
        fence.check(permit.ticket)
        val tasks=pending.getJSONArray("signingRequests");check(tasks.length()>0)
        val ids=(0 until permit.tasks.length()).map { permit.tasks.getJSONObject(it).getString("taskId") }.toMutableSet()
        for(i in 0 until tasks.length()){val t=tasks.getJSONObject(i);check(ids.add(t.getString("taskId")) && signingTaskMatchesAccount(t))}
        for(i in 0 until tasks.length())permit.tasks.put(tasks.getJSONObject(i))
        permit.stage++;inc("validatedContinuation")
    }
    private fun crypt(input:JSONObject):JSONObject {
        check(realTestnet)
        val params=input.getJSONObject("params");val task=params.getJSONObject("task");val receipt=params.getJSONObject("approval")
        val id=receipt.getString("approvalId");val permit=permits[id]?:error("No permit")
        check(canonical(receipt)==canonical(permit.receipt))
        val taskID=task.getString("taskId");val purpose=task.getString("purpose")
        check(purpose in listOf("encrypt","decrypt")&&task.getString("algorithm")=="tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1")
        val account=config.getJSONObject("account")
        check(task.getString("publicKey")==account.getString("publicKey")&&task.getString("accountId")==account.getString("accountId")&&task.getString("origin")==LoopActivity.ORIGIN)
        var onceID=taskID
        val plan=permit.workflowPlan
        if(plan!=null) {
            val evidence=input.getJSONObject("workflowTask")
            check(evidence.getString("workflowPlanHash")==plan.getString("workflowPlanHash")&&evidence.getString("bindingHash")==receipt.getString("bindingHash")&&canonical(evidence.getJSONObject("task"))==canonical(task))
            val allowed=plan.getJSONObject("payload").getJSONArray("cryptoTasks")
            check((0 until allowed.length()).any {canonical(allowed.getJSONObject(it))==canonical(task)})
            onceID=evidence.getString("stepId")+":"+taskID
        } else check(permit.actionTaskCommitment!=null&&permit.actionTaskCommitment==hash(task))
        check(!permit.used.contains(onceID))
        val decrypt=purpose=="decrypt"
        val bytes=if(decrypt)android.util.Base64.decode(task.getString("ciphertext"),android.util.Base64.NO_WRAP) else {
            val message=task.getJSONObject("message");val data=message.getString("data")
            when(message.getString("encoding")){
                "utf8"->data.toByteArray(Charsets.UTF_8)
                "base64"->android.util.Base64.decode(data,android.util.Base64.NO_WRAP)
                "hex"->{check(data.matches(Regex("(?:[0-9a-fA-F]{2})*")));data.chunked(2).map{it.toInt(16).toByte()}.toByteArray()}
                else->error("Invalid crypto encoding")
            }
        }
        try {
            val output=fence.startBoundTaskOnce(permit.ticket,onceID){vault.crypt(bytes,decrypt)}
            try {
                permit.used.add(onceID);inc("vaultCrypto")
                val result=JSONObject().put("taskId",taskID).put("algorithm",task.getString("algorithm"))
                val encoded=android.util.Base64.encodeToString(output,android.util.Base64.NO_WRAP)
                return if(decrypt)result.put("message",JSONObject().put("encoding","base64").put("data",encoded)) else result.put("ciphertext",encoded)
            } finally {output.fill(0)}
        } finally {bytes.fill(0)}
    }
    private fun sign(input: JSONObject): JSONObject {
        val totalStart = SystemClock.elapsedRealtimeNanos()
        val params = input.getJSONObject("params"); val approval = params.getJSONObject("approval"); val task = params.getJSONObject("task")
        val permit = permits[approval.getString("approvalId")] ?: error("Missing native approval")
        val account = config.getJSONObject("account"); val encoding = task.getString("signatureEncoding"); val digest = task.getString("digest")
        check(approval.getString("approvalToken") == permit.receipt.getString("approvalToken") && approval.getString("bindingHash") == permit.receipt.getString("bindingHash"))
        check(signingTaskMatchesAccount(task) && Instant.parse(permit.receipt.getString("expiresAt")).isAfter(Instant.now()))
        var onceID=task.getString("taskId")
        if(permit.workflowPlan!=null) {
            val evidence=input.getJSONObject("workflowTask")
            check(evidence.getString("workflowPlanHash")==permit.workflowPlan!!.getString("workflowPlanHash")&&evidence.getString("bindingHash")==permit.receipt.getString("bindingHash"))
            val step=evidence.getString("stepId");check(canonical(evidence.getJSONObject("task"))==canonical(task))
            onceID="$step:$onceID"
            val exact=(0 until permit.workflowTasks.length()).any {val entry=permit.workflowTasks.getJSONObject(it);entry.getString("stepId")==step&&canonical(entry.getJSONObject("task"))==canonical(task)}
            if(!exact) {
                // Core resolves deferred dependencies; the private Host reader
                // checks the live call. Page messages cannot call this bridge.
                val deferred=permit.workflowPlan!!.getJSONObject("payload").getJSONArray("deferredSigningTasks")
                check((0 until deferred.length()).any {val d=deferred.getJSONObject(it);d.getString("targetStepId")==step&&d.getString("taskId")==task.getString("taskId")&&d.getString("purpose")==task.getString("purpose")&&d.getString("publicKey")==task.getString("publicKey")})
                check(task.getString("origin")==LoopActivity.ORIGIN&&task.getString("accountId")==account.getString("accountId")&&encoding=="compact65-recoverable")
            }
        } else if (permit.tasks.length() == 0) {
            val method = permit.bindingPayload.optString("method")
            check(method in setOf("tbc_signMessage", "tbc_signTypedData"))
            check(task.getString("purpose") == (if (method == "tbc_signTypedData") "typedData" else "message") && task.getString("origin") == LoopActivity.ORIGIN && task.getString("accountId") == account.getString("accountId") && digest == permit.messageDigest && encoding == "compact65-recoverable")
        }
        else check((0 until permit.tasks.length()).any { canonical(permit.tasks.get(it)) == canonical(task) })
        val signStart=SystemClock.elapsedRealtimeNanos()
        val signature = if(controlledCoinMuSig && task.getString("accountId")==signingAccounts[1].getString("accountId")) {
            signControlledMuSig(task,permit,approval.getString("approvalId"),onceID)
        } else fence.startBoundTaskOnce(permit.ticket, onceID) {
            if(hasSecondarySigner && task.getString("accountId")==signingAccounts[1].getString("accountId")) {
                check(task.getString("purpose")=="transaction");checkNotNull(adminVault).sign(digest,encoding)
            } else {
                check(task.getString("accountId")==config.getJSONObject("account").getString("accountId"))
                vault.sign(digest,encoding)
            }
        }; measure("signature",JSONObject().put("taskId",task.getString("taskId")).put("nativeMs",(SystemClock.elapsedRealtimeNanos()-signStart)/1e6)); permit.used.add(onceID); inc("vaultSigns")
        if(hasSecondarySigner) inc(if(task.getString("accountId")==signingAccounts[1].getString("accountId")) (if(hasPoolController) "controllerVaultSigns" else "adminVaultSigns") else "feeVaultSigns")
        measure("signer-port",JSONObject().put("elapsedMs",(SystemClock.elapsedRealtimeNanos()-totalStart)/1e6))
        return JSONObject().put("taskId", task.getString("taskId")).put("signatureEncoding", encoding).put("signature", signature)
    }
    private fun signControlledMuSig(task: JSONObject, permit: Permit, approvalID: String, onceID: String): String {
        check(controlledCoinMuSig && controlledCoinAdmin && !realTestnet && !controlledPoolController)
        check(task.getString("purpose")=="transaction" && task.getString("algorithm")=="secp256k1-schnorr-bip340")
        check(task.getString("signatureEncoding")=="schnorr64" && task.getString("publicKey")=="3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec")
        val expiry=Instant.parse(permit.receipt.getString("expiresAt"))
        val ttl=java.time.Duration.between(Instant.now(),expiry).toMillis().coerceAtMost(120000)
        check(ttl>0)
        val taskText=canonical(task); val receiptText=canonical(permit.receipt)
        val binding=hash(JSONObject().put("approvalId",approvalID).put("receipt",permit.receipt)
            .put("task",task).put("onceID",onceID).put("aggregateKey",task.getString("publicKey")))
        val verify = {
            val current=permits[approvalID]
            current != null && current.ticket === permit.ticket && onceID !in current.used && expiry.isAfter(Instant.now()) &&
                signingTaskMatchesAccount(task) && canonical(current.receipt)==receiptText &&
                (if(current.workflowPlan!=null) (0 until current.workflowTasks.length()).any {
                    val entry=current.workflowTasks.getJSONObject(it)
                    entry.getString("stepId")+":"+task.getString("taskId")==onceID && canonical(entry.getJSONObject("task"))==taskText
                } else (0 until current.tasks.length()).any { canonical(current.tasks.getJSONObject(it))==taskText })
        }
        return ControlledMuSig.sign(fence,permit.ticket,onceID,binding,task.getString("digest"),ttl,verify,vault,checkNotNull(adminVault)) {
            name, amount -> repeat(amount) { inc(name) }
        }
    }
    private fun complete(id: String, status: String, code: String) {
        val ticket = deliveries.remove(id) ?: return
        var outcome = status; var resultCode = if (status == "signed") "" else code
        try {
            fence.finishDelivery(ticket)
            activity.deliver(id, if (status == "signed") JSONObject().put("ok", true).put("result", JSONTokener(code).nextValue()) else JSONObject().put("ok", false).put("code", code))
        } catch (failure: NativeSessionFence.Failure) {
            if (failure.reason == NativeSessionFence.Reason.REVOKED) {
                // Same live scope only: terminate the request without leaking
                // its old result. Navigation/account replacement stays silent.
                outcome = "revoked-cancelled"; resultCode = "4100"
                activity.deliver(id, JSONObject().put("ok", false).put("code", "4100"))
            } else outcome = "stale-suppressed"
        } catch (_: Exception) { outcome = "stale-suppressed" }
        val items = if (status == "signed") (JSONTokener(code).nextValue() as? JSONArray)?.length() ?: -1 else -1
        val entry=JSONObject().put("outcome", outcome).put("code", resultCode).put("counts", JSONObject(counts.toMap())).put("items", items).put("time", instant())
        requestMethods.remove(id)?.let { method ->
            entry.put("method",method)
            if(status=="signed"&&method in listOf("tbc_chainId","tbc_accounts","tbc_requestAccounts","tbc_getAccount","tbc_getCapabilities","wallet_getPermissions","tbc_switchChain","tbc_disconnect"))entry.put("publicResult",JSONTokener(code).nextValue())
        }
        if(status=="signed")entry.put("publicResult",JSONTokener(code).nextValue())
        measure("wallet-return",JSONObject().put("status",outcome));results.put(entry); save()
    }
    private fun save() {
        activity.filesDir.resolve("report.json").writeText(JSONObject().put("marker", "ANDROID_NATIVE_KIT_CLOSED_LOOP")
            .put("counts", JSONObject(counts.toMap())).put("results", results).put("metrics",metrics).put("candidate","0.1.0-rc.25").put("nativeEngine", true).put("nativeRustSigner", true)
            .put("keyStorage", if(realTestnet) "isolated-AndroidKeyStore-AES-GCM-random-testnet-key" else "isolated-AndroidKeyStore-AES-GCM-public-test-key").put("syntheticChain", !realTestnet).put("externalPosts",counts["http.POST"] ?: 0)
            .put("realTestnet",realTestnet).put("account",config.getJSONObject("account"))
            .put("productionCustody", false).put("reactNative", false).put("onboarding", onboarding)
            .put("permissionRows", JSONObject(permissionRows.toMap())).put("permissionStorage", if(realTestnet) "native-preferences-grants-only" else "native-session-memory").toString(2))
    }
}
