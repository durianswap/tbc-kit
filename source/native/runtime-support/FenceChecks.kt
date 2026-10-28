package io.tbc.kit.host

fun main() {
    var time = 100.0
    val fence = NativeSessionFence { time }
    val scope = NativeSessionFence.Scope("https://alpha.example", "doc-1", "account-a", "tbc:testnet")
    val checks = mutableListOf<String>(); var executions = 0
    fun rejects(body: () -> Unit) { try { body(); error("Expected rejection") } catch (_: NativeSessionFence.Failure) {} }
    rejects { fence.capture(30.0) }
    fence.replaceVerifiedScope(scope)
    val first = fence.capture(30.0)
    fence.startOnce(first) { executions++ }
    rejects { fence.startOnce(first) { executions++ } }
    fence.finish(first); rejects { fence.finish(first) }
    checks.add("once-and-duplicate-delivery")
    val cancelled = fence.capture(30.0)
    fence.cancel(cancelled); rejects { fence.startOnce(cancelled) { executions++ } }
    checks.add("cancel-before-signer")
    val reload = fence.capture(30.0); fence.replaceVerifiedScope(scope)
    rejects { fence.startOnce(reload) { executions++ } }
    checks.add("same-origin-reload")
    for ((name, changed) in listOf(
        "navigation" to NativeSessionFence.Scope("https://beta.example", "doc-2", "account-a", "tbc:testnet"),
        "account" to NativeSessionFence.Scope(scope.origin, "doc-2", "account-b", "tbc:testnet"),
        "network" to NativeSessionFence.Scope(scope.origin, "doc-2", "account-b", "tbc:mainnet"),
    )) {
        val ticket = fence.capture(30.0); fence.replaceVerifiedScope(changed)
        rejects { fence.startOnce(ticket) { executions++ } }; checks.add("$name-before-signer")
    }
    val expired = fence.capture(1.0); time += 1
    rejects { fence.startOnce(expired) { executions++ } }; checks.add("exact-deadline")
    val inFlight = fence.capture(30.0); fence.startOnce(inFlight) { executions++ }
    fence.close(); rejects { fence.finish(inFlight) }; fence.replaceVerifiedScope(scope)
    rejects { fence.startOnce(inFlight) { executions++ } }; checks.add("close-reopen-inflight-no-retry")
    val other = NativeSessionFence { time }; other.replaceVerifiedScope(scope)
    val owned = fence.capture(30.0)
    rejects { other.startOnce(owned) { executions++ } }; checks.add("new-vm-owner")
    val a = fence.capture(30.0); val b = fence.capture(30.0)
    fence.cancel(a); fence.startOnce(b) { executions++ }; fence.finish(b)
    checks.add("independent-concurrent-calls")
    val failed = fence.capture(30.0)
    try { fence.startOnce(failed) { executions++; throw UnsupportedOperationException() } } catch (_: UnsupportedOperationException) {}
    rejects { fence.startOnce(failed) { executions++ } }; checks.add("throw-consumes-start")
    val waitingApproval = fence.capture(30.0, authorizationBound = true)
    val independentRead = fence.capture(30.0)
    fence.authorizationChanged()
    rejects { fence.startOnce(waitingApproval) { executions++ } }
    fence.finish(independentRead)
    checks.add("permission-change-before-signer-read-unaffected")
    val signing = fence.capture(30.0, authorizationBound = true)
    fence.startOnce(signing) { executions++ }
    fence.authorizationChanged()
    try { fence.finish(signing); error("Expected revoked") }
    catch (e: NativeSessionFence.Failure) { check(e.reason == NativeSessionFence.Reason.REVOKED) }
    checks.add("permission-change-after-signer-no-delivery")
    fence.authorizationChanged()
    rejects { fence.startOnce(waitingApproval) { executions++ } }
    rejects { fence.startOnce(signing) { executions++ } }
    val fresh = fence.capture(30.0, authorizationBound = true)
    fence.startOnce(fresh) { executions++ }; fence.finish(fresh)
    fence.replaceVerifiedScope(scope)
    try { fence.check(signing); error("Expected stale scope") }
    catch (e: NativeSessionFence.Failure) { check(e.reason == NativeSessionFence.Reason.STALE) }
    checks.add("new-grant-never-revives-old-ticket")
    rejects { fence.replaceVerifiedScope(NativeSessionFence.Scope("", "new", "a", "tbc:testnet")) }
    rejects { fence.startOnce(owned) { executions++ } }
    fence.replaceVerifiedScope(scope)
    val clockTicket = fence.capture(30.0)
    rejects { fence.capture(Double.POSITIVE_INFINITY) }; rejects { fence.capture(0.0) }
    time = Double.NaN; rejects { fence.check(clockTicket) }; checks.add("invalid-clock-and-timeout")
    var crossThread = false
    Thread { try { fence.close() } catch (e: NativeSessionFence.Failure) { crossThread = e.reason == NativeSessionFence.Reason.WRONG_THREAD } }.apply { start(); join() }
    check(crossThread && executions == 6 && checks.size == 15)
    println("NATIVE_FENCE_PASS kotlin checks=${checks.size} executions=$executions reads=0 posts=0 thread-check=pass")
    time = 200.0
    fence.replaceVerifiedScope(scope)
    val batch = fence.capture(30.0, authorizationBound = true)
    var tasks = 0
    fence.startBoundTaskOnce(batch, "input-0") { tasks++ }
    fence.startBoundTaskOnce(batch, "input-1") { tasks++ }
    rejects { fence.startBoundTaskOnce(batch, "input-0") { tasks++ } }
    rejects { fence.startOnce(batch) { tasks++ } }
    try { fence.startBoundTaskOnce(batch, "failed") { throw UnsupportedOperationException() } } catch (_: UnsupportedOperationException) {}
    rejects { fence.startBoundTaskOnce(batch, "failed") { tasks++ } }
    rejects { fence.startBoundTaskOnce(batch, "") { tasks++ } }
    fence.authorizationChanged()
    rejects { fence.startBoundTaskOnce(batch, "input-2") { tasks++ } }
    val expiredBatch = fence.capture(1.0, authorizationBound = true); time += 1
    rejects { fence.startBoundTaskOnce(expiredBatch, "input-2") { tasks++ } }
    val single = fence.capture(30.0); fence.startOnce(single) {}
    rejects { fence.startBoundTaskOnce(single, "input-2") { tasks++ } }
    val finished = fence.capture(30.0); fence.finish(finished)
    rejects { fence.startBoundTaskOnce(finished, "input-2") { tasks++ } }
    check(tasks == 2)
    println("NATIVE_BOUND_TASKS_PASS kotlin tasks=2 duplicate-expiry-revoke-failure=blocked")
    val delivery = fence.captureDelivery(authorizationBound = true)
    val signingExpiry = fence.capture(1.0, authorizationBound = true)
    time += 121
    rejects { fence.startBoundTaskOnce(signingExpiry, "late") {} }
    fence.finishDelivery(delivery)
    rejects { fence.finishDelivery(delivery) }
    val revokedDelivery = fence.captureDelivery(authorizationBound = true)
    fence.authorizationChanged()
    rejects { fence.finishDelivery(revokedDelivery) }
    val navigatedDelivery = fence.captureDelivery()
    fence.replaceVerifiedScope(scope)
    rejects { fence.finishDelivery(navigatedDelivery) }
    val closedDelivery = fence.captureDelivery()
    fence.close()
    rejects { fence.finishDelivery(closedDelivery) }
    println("NATIVE_DELIVERY_PASS kotlin expiry-result-only duplicate-revoke-navigation-close=blocked")
}
