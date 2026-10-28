import Foundation

/// Native-only lifetime fencing, NOT transaction validation or a DApp API.
/// Keep this object on the same serial executor as navigation/account events
/// and the immediate start of the Vault operation. Never put it in a JS bridge.
@MainActor public final class NativeSessionFence {
    public enum Failure: Error { case closed, stale, revoked, expired, invalid, alreadyStarted }
    public struct Scope: Equatable {
        public let origin: String
        public let navigationID: String
        public let accountID: String
        public let chainID: String
        // Values must come from the trusted native navigation/account owner,
        // not URL/name/origin fields supplied by the page or its JS messages.
        public init(origin: String, navigationID: String, accountID: String, chainID: String) {
            self.origin = origin; self.navigationID = navigationID
            self.accountID = accountID; self.chainID = chainID
        }
    }
    public final class Ticket {
        fileprivate let owner: UUID
        fileprivate let generation: UUID
        fileprivate let authorizationGeneration: UUID?
        public let scope: Scope
        fileprivate let deadline: Double
        fileprivate var active = true
        fileprivate var started = false
        fileprivate var startedTasks = Set<String>()
        fileprivate init(owner: UUID, generation: UUID, authorizationGeneration: UUID?, scope: Scope, deadline: Double) {
            self.owner = owner; self.generation = generation; self.scope = scope; self.deadline = deadline
            self.authorizationGeneration = authorizationGeneration
        }
    }
    /// Result routing only, never usable as a signing credential.
    public final class DeliveryTicket {
        fileprivate let context: Ticket
        fileprivate init(_ context: Ticket) { self.context = context }
    }
    private let owner = UUID()
    private var generation = UUID()
    private var authorizationGeneration = UUID()
    private var scope: Scope?
    private var invalidationObservers: [UUID: (Ticket, () -> Void)] = [:]
    private let now: () -> Double
    public init(now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) { self.now = now }

    /// Call for EVERY top-frame document change, even reload of the same URL,
    /// account/network change, lock and VM recreation. Old tickets never revive.
    public func replaceVerifiedScope(_ next: Scope) throws {
        close() // A failed navigation/account replacement must not revive the old scope.
        guard !next.origin.isEmpty, !next.navigationID.isEmpty,
              !next.accountID.isEmpty, !next.chainID.isEmpty else { throw Failure.invalid }
        scope = next
    }
    public func close() {
        generation = UUID(); scope = nil
        notifyInvalidation { _ in true }
    }
    /// Call only after a committed permission change, on the Vault's executor.
    /// Revocation and a later grant cannot revive a sensitive ticket. Unbound
    /// transport callbacks remain live so the permission commit can be acknowledged.
    public func authorizationChanged() {
        authorizationGeneration = UUID()
        notifyInvalidation { $0.authorizationGeneration != nil }
    }
    public func capture(timeoutSeconds: Double, authorizationBound: Bool = false) throws -> Ticket {
        guard let scope else { throw Failure.closed }
        let time = now(), deadline = time + timeoutSeconds
        guard time.isFinite, timeoutSeconds.isFinite, timeoutSeconds > 0,
              deadline.isFinite, deadline > time else { throw Failure.invalid }
        return Ticket(owner: owner, generation: generation,
                      authorizationGeneration: authorizationBound ? authorizationGeneration : nil,
                      scope: scope, deadline: deadline)
    }
    public func cancel(_ ticket: Ticket) {
        if ticket.owner == owner {
            ticket.active = false
            notifyInvalidation { $0 === ticket }
        }
    }
    public func captureDelivery(authorizationBound: Bool = false) throws -> DeliveryTicket {
        DeliveryTicket(try capture(timeoutSeconds: 1, authorizationBound: authorizationBound))
    }
    public func finishDelivery(_ delivery: DeliveryTicket) throws {
        try checkContext(delivery.context)
        cancel(delivery.context)
    }
    /// Optional native resource cleanup, only for approval-bound tasks. No page
    /// callbacks, persistence, or work on the ordinary signing hot path.
    public func checkAuthorization(_ ticket: Ticket) throws {
        try check(ticket)
        guard ticket.authorizationGeneration != nil else { throw Failure.invalid }
    }
    public func onAuthorizationInvalidation(_ ticket: Ticket, _ cancel: @escaping () -> Void) throws -> UUID {
        try checkAuthorization(ticket)
        let id = UUID(); invalidationObservers[id] = (ticket, cancel); return id
    }
    public func removeInvalidationObserver(_ id: UUID) { invalidationObservers.removeValue(forKey: id) }
    private func notifyInvalidation(_ matches: (Ticket) -> Bool) {
        let selected = invalidationObservers.filter { matches($0.value.0) }
        // Remove first: cancellation is allowed to reenter resource cleanup.
        for id in selected.keys { invalidationObservers.removeValue(forKey: id) }
        for value in selected.values { value.1() }
    }
    public func check(_ ticket: Ticket) throws {
        try checkContext(ticket)
        let time = now()
        guard time.isFinite, time < ticket.deadline else { throw Failure.expired }
    }
    private func checkContext(_ ticket: Ticket) throws {
        guard scope != nil else { throw Failure.closed }
        guard ticket.owner == owner, ticket.generation == generation,
              ticket.scope == scope, ticket.active else { throw Failure.stale }
        if let captured = ticket.authorizationGeneration, captured != authorizationGeneration { throw Failure.revoked }
    }
    /// The trusted caller must already have verified Kit approval/binding/task
    /// and obtained the native user decision. This only fences that decision's
    /// lifetime. Run the immediate Vault start synchronously here, not after an
    /// unguarded queue hop. Do not hold this boundary while waiting for UI.
    public func startOnce<T>(_ ticket: Ticket, _ start: () throws -> T) throws -> T {
        try check(ticket)
        guard !ticket.started, ticket.startedTasks.isEmpty else { throw Failure.alreadyStarted }
        ticket.started = true // Consumed even if start throws; no implicit retry.
        return try start()
    }
    /// Exact task membership in Kit-bound approval must already be verified.
    /// Multiple approved inputs share a lifetime but not a one-shot task token.
    public func startBoundTaskOnce<T>(_ ticket: Ticket, taskID: String, _ start: () throws -> T) throws -> T {
        try check(ticket)
        guard !taskID.isEmpty else { throw Failure.invalid }
        guard !ticket.started, ticket.startedTasks.insert(taskID).inserted else { throw Failure.alreadyStarted }
        return try start() // Consumed on failure, too. No hidden retry.
    }
    /// Check after async completion before delivering to Kit/the page. Failure
    /// means delivery is stale; it does not mean the Vault/POST never executed.
    public func finish(_ ticket: Ticket) throws {
        try check(ticket); cancel(ticket)
    }
}
