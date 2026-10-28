import Foundation

@main struct FenceChecks {
    @MainActor static func main() throws {
        var time = 100.0
        let fence = NativeSessionFence(now: { time })
        let scope = NativeSessionFence.Scope(origin: "https://alpha.example", navigationID: "doc-1", accountID: "account-a", chainID: "tbc:testnet")
        var checks = [String](), executions = 0
        func rejects(_ body: () throws -> Void) { do { try body(); fatalError("Expected rejection") } catch is NativeSessionFence.Failure {} catch { fatalError("Wrong failure") } }
        rejects { _ = try fence.capture(timeoutSeconds: 30) }
        try fence.replaceVerifiedScope(scope)
        let first = try fence.capture(timeoutSeconds: 30)
        try fence.startOnce(first) { executions += 1 }
        rejects { try fence.startOnce(first) { executions += 1 } }
        try fence.finish(first)
        rejects { try fence.finish(first) }
        checks.append("once-and-duplicate-delivery")
        let cancelled = try fence.capture(timeoutSeconds: 30)
        fence.cancel(cancelled); rejects { try fence.startOnce(cancelled) { executions += 1 } }
        checks.append("cancel-before-signer")
        let reload = try fence.capture(timeoutSeconds: 30)
        try fence.replaceVerifiedScope(scope)
        rejects { try fence.startOnce(reload) { executions += 1 } }
        checks.append("same-origin-reload")
        for (name, changed) in [
            ("navigation", NativeSessionFence.Scope(origin: "https://beta.example", navigationID: "doc-2", accountID: "account-a", chainID: "tbc:testnet")),
            ("account", NativeSessionFence.Scope(origin: scope.origin, navigationID: "doc-2", accountID: "account-b", chainID: "tbc:testnet")),
            ("network", NativeSessionFence.Scope(origin: scope.origin, navigationID: "doc-2", accountID: "account-b", chainID: "tbc:mainnet"))
        ] {
            let ticket = try fence.capture(timeoutSeconds: 30)
            try fence.replaceVerifiedScope(changed)
            rejects { try fence.startOnce(ticket) { executions += 1 } }
            checks.append(name + "-before-signer")
        }
        let expired = try fence.capture(timeoutSeconds: 1); time += 1
        rejects { try fence.startOnce(expired) { executions += 1 } }
        checks.append("exact-deadline")
        let inFlight = try fence.capture(timeoutSeconds: 30)
        try fence.startOnce(inFlight) { executions += 1 }
        fence.close(); rejects { try fence.finish(inFlight) }
        try fence.replaceVerifiedScope(scope)
        rejects { try fence.startOnce(inFlight) { executions += 1 } }
        checks.append("close-reopen-inflight-no-retry")
        let other = NativeSessionFence(now: { time }); try other.replaceVerifiedScope(scope)
        let owned = try fence.capture(timeoutSeconds: 30)
        rejects { try other.startOnce(owned) { executions += 1 } }
        checks.append("new-vm-owner")
        let a = try fence.capture(timeoutSeconds: 30), b = try fence.capture(timeoutSeconds: 30)
        fence.cancel(a); try fence.startOnce(b) { executions += 1 }; try fence.finish(b)
        checks.append("independent-concurrent-calls")
        let failed = try fence.capture(timeoutSeconds: 30)
        enum NativeFailure: Error { case failed }
        do { try fence.startOnce(failed) { executions += 1; throw NativeFailure.failed } } catch NativeFailure.failed {}
        rejects { try fence.startOnce(failed) { executions += 1 } }
        checks.append("throw-consumes-start")
        let waitingApproval = try fence.capture(timeoutSeconds: 30, authorizationBound: true)
        let independentRead = try fence.capture(timeoutSeconds: 30)
        fence.authorizationChanged()
        rejects { try fence.startOnce(waitingApproval) { executions += 1 } }
        try fence.finish(independentRead)
        checks.append("permission-change-before-signer-read-unaffected")
        let signing = try fence.capture(timeoutSeconds: 30, authorizationBound: true)
        try fence.startOnce(signing) { executions += 1 }
        fence.authorizationChanged()
        do { try fence.finish(signing); fatalError("Expected revoked") }
        catch NativeSessionFence.Failure.revoked {}
        checks.append("permission-change-after-signer-no-delivery")
        fence.authorizationChanged() // A fresh grant must not revive old tickets.
        rejects { try fence.startOnce(waitingApproval) { executions += 1 } }
        rejects { try fence.startOnce(signing) { executions += 1 } }
        let fresh = try fence.capture(timeoutSeconds: 30, authorizationBound: true)
        try fence.startOnce(fresh) { executions += 1 }; try fence.finish(fresh)
        try fence.replaceVerifiedScope(scope)
        do { try fence.check(signing); fatalError("Expected stale scope") }
        catch NativeSessionFence.Failure.stale {} // Never deliver a revocation reply to a replacement document.
        checks.append("new-grant-never-revives-old-ticket")
        rejects { try fence.replaceVerifiedScope(.init(origin: "", navigationID: "new", accountID: "a", chainID: "tbc:testnet")) }
        rejects { try fence.startOnce(owned) { executions += 1 } }
        try fence.replaceVerifiedScope(scope)
        let clockTicket = try fence.capture(timeoutSeconds: 30)
        rejects { _ = try fence.capture(timeoutSeconds: .infinity) }
        rejects { _ = try fence.capture(timeoutSeconds: 0) }
        time = .nan; rejects { try fence.check(clockTicket) }
        checks.append("invalid-clock-and-timeout")
        precondition(executions == 6 && checks.count == 15)
        print("NATIVE_FENCE_PASS swift checks=\(checks.count) executions=\(executions) reads=0 posts=0")
        time = 200
        try fence.replaceVerifiedScope(scope)
        let batch = try fence.capture(timeoutSeconds: 30, authorizationBound: true)
        var tasks = 0
        try fence.startBoundTaskOnce(batch, taskID: "input-0") { tasks += 1 }
        try fence.startBoundTaskOnce(batch, taskID: "input-1") { tasks += 1 }
        rejects { try fence.startBoundTaskOnce(batch, taskID: "input-0") { tasks += 1 } }
        rejects { try fence.startOnce(batch) { tasks += 1 } }
        do { try fence.startBoundTaskOnce(batch, taskID: "failed") { throw NativeFailure.failed } } catch NativeFailure.failed {}
        rejects { try fence.startBoundTaskOnce(batch, taskID: "failed") { tasks += 1 } }
        rejects { try fence.startBoundTaskOnce(batch, taskID: "") { tasks += 1 } }
        fence.authorizationChanged()
        rejects { try fence.startBoundTaskOnce(batch, taskID: "input-2") { tasks += 1 } }
        let expiredBatch = try fence.capture(timeoutSeconds: 1, authorizationBound: true)
        time += 1
        rejects { try fence.startBoundTaskOnce(expiredBatch, taskID: "input-2") { tasks += 1 } }
        let single = try fence.capture(timeoutSeconds: 30)
        try fence.startOnce(single) {}
        rejects { try fence.startBoundTaskOnce(single, taskID: "input-2") { tasks += 1 } }
        let finished = try fence.capture(timeoutSeconds: 30)
        try fence.finish(finished)
        rejects { try fence.startBoundTaskOnce(finished, taskID: "input-2") { tasks += 1 } }
        precondition(tasks == 2)
        print("NATIVE_BOUND_TASKS_PASS swift tasks=2 duplicate-expiry-revoke-failure=blocked")
        let delivery = try fence.captureDelivery(authorizationBound: true)
        let signingExpiry = try fence.capture(timeoutSeconds: 1, authorizationBound: true)
        time += 121
        rejects { try fence.startBoundTaskOnce(signingExpiry, taskID: "late") {} }
        try fence.finishDelivery(delivery)
        rejects { try fence.finishDelivery(delivery) }
        let revokedDelivery = try fence.captureDelivery(authorizationBound: true)
        fence.authorizationChanged()
        rejects { try fence.finishDelivery(revokedDelivery) }
        let navigatedDelivery = try fence.captureDelivery()
        try fence.replaceVerifiedScope(scope)
        rejects { try fence.finishDelivery(navigatedDelivery) }
        let closedDelivery = try fence.captureDelivery()
        fence.close()
        rejects { try fence.finishDelivery(closedDelivery) }
        print("NATIVE_DELIVERY_PASS swift expiry-result-only duplicate-revoke-navigation-close=blocked")
    }
}
