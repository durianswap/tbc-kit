package io.tbc.kit.host

import java.util.UUID

/** Native-only lifetime fence. Never expose it or its tickets to page JavaScript.
 * All entry points, scope changes and immediate Vault starts use the creating
 * thread. Async workers return to that executor before result delivery. */
class NativeSessionFence(private val now: () -> Double = { System.nanoTime() / 1_000_000_000.0 }) {
    enum class Reason { CLOSED, STALE, REVOKED, EXPIRED, INVALID, ALREADY_STARTED, WRONG_THREAD }
    class Failure(val reason: Reason) : IllegalStateException(reason.name)
    data class Scope(val origin: String, val navigationID: String, val accountID: String, val chainID: String)
    class Ticket internal constructor(
        internal val owner: UUID, internal val generation: UUID,
        internal val authorizationGeneration: UUID?,
        val scope: Scope, internal val deadline: Double,
    ) {
        internal var active = true
        internal var started = false
        internal val startedTasks = mutableSetOf<String>()
    }
    /** Result routing is not permission to start work. A long operation may
     * report its terminal/partial outcome to the same still-authorized page,
     * even after its signing deadline. This type cannot be passed to Vault. */
    class DeliveryTicket internal constructor(internal val context: Ticket)
    private val thread = Thread.currentThread()
    private val owner = UUID.randomUUID()
    private var generation = UUID.randomUUID()
    private var authorizationGeneration = UUID.randomUUID()
    private var scope: Scope? = null
    private val invalidationObservers = mutableMapOf<UUID, Pair<Ticket, () -> Unit>>()
    private fun confined() { if (Thread.currentThread() !== thread) throw Failure(Reason.WRONG_THREAD) }
    /** Only trusted platform navigation/account events may call this. Every
     * document reload, account/network change and VM recreation invalidates all
     * old tickets, even when the new values equal the old ones. */
    fun replaceVerifiedScope(next: Scope) {
        close() // Failed replacement invalidates the previous scope too.
        if (listOf(next.origin, next.navigationID, next.accountID, next.chainID).any { it.isEmpty() }) throw Failure(Reason.INVALID)
        scope = next
    }
    fun close() { confined(); generation = UUID.randomUUID(); scope = null; notifyInvalidation { true } }
    /** After committed permission changes only. Keep transport acknowledgements
     * alive; sensitive tickets never revive after a later grant. */
    fun authorizationChanged() {
        confined(); authorizationGeneration = UUID.randomUUID()
        notifyInvalidation { it.authorizationGeneration != null }
    }
    fun capture(timeoutSeconds: Double, authorizationBound: Boolean = false): Ticket {
        confined()
        val current = scope ?: throw Failure(Reason.CLOSED)
        val time = now(); val deadline = time + timeoutSeconds
        if (!time.isFinite() || !timeoutSeconds.isFinite() || timeoutSeconds <= 0 || !deadline.isFinite() || deadline <= time) throw Failure(Reason.INVALID)
        return Ticket(owner, generation, if (authorizationBound) authorizationGeneration else null, current, deadline)
    }
    fun cancel(ticket: Ticket) {
        confined()
        if (ticket.owner == owner) { ticket.active = false; notifyInvalidation { it === ticket } }
    }
    fun captureDelivery(authorizationBound: Boolean = false): DeliveryTicket =
        DeliveryTicket(capture(1.0, authorizationBound))
    fun finishDelivery(delivery: DeliveryTicket) {
        checkContext(delivery.context)
        cancel(delivery.context)
    }
    /** Optional native cleanup for approval-bound resources, never a page callback. */
    fun checkAuthorization(ticket: Ticket) {
        check(ticket)
        if (ticket.authorizationGeneration == null) throw Failure(Reason.INVALID)
    }
    fun onAuthorizationInvalidation(ticket: Ticket, cancel: () -> Unit): UUID {
        checkAuthorization(ticket)
        val id = UUID.randomUUID(); invalidationObservers[id] = ticket to cancel; return id
    }
    fun removeInvalidationObserver(id: UUID) { confined(); invalidationObservers.remove(id) }
    private fun notifyInvalidation(matches: (Ticket) -> Boolean) {
        val selected = invalidationObservers.filterValues { matches(it.first) }
        selected.keys.forEach { invalidationObservers.remove(it) }
        // A faulty cleanup must not prevent other private sessions being erased.
        selected.values.forEach { runCatching { it.second() } }
    }
    fun check(ticket: Ticket) {
        checkContext(ticket)
        val time = now()
        if (!time.isFinite() || time >= ticket.deadline) throw Failure(Reason.EXPIRED)
    }
    private fun checkContext(ticket: Ticket) {
        confined()
        if (scope == null) throw Failure(Reason.CLOSED)
        if (ticket.owner != owner || ticket.generation != generation || ticket.scope != scope || !ticket.active) throw Failure(Reason.STALE)
        if (ticket.authorizationGeneration != null && ticket.authorizationGeneration != authorizationGeneration) throw Failure(Reason.REVOKED)
    }
    /** Kit binding/task validation and native consent must precede this call.
     * Start the Vault operation immediately on this executor. A worker which
     * queues actual key use elsewhere needs its own equivalent atomic fence.
     * This is not a replacement for approval, and is not held across UI waits. */
    fun <T> startOnce(ticket: Ticket, start: () -> T): T {
        check(ticket)
        if (ticket.started || ticket.startedTasks.isNotEmpty()) throw Failure(Reason.ALREADY_STARTED)
        ticket.started = true
        return start()
    }
    /** Caller must verify this exact task against the Kit-bound approval first.
     * One approval can cover many inputs; each task still starts only once.
     * No new lifetime, authority epoch or unguarded executor hop is introduced. */
    fun <T> startBoundTaskOnce(ticket: Ticket, taskId: String, start: () -> T): T {
        check(ticket)
        if (taskId.isEmpty()) throw Failure(Reason.INVALID)
        if (ticket.started || !ticket.startedTasks.add(taskId)) throw Failure(Reason.ALREADY_STARTED)
        return start() // Task remains consumed even if custody throws.
    }
    /** Stale delivery does not prove signing/submission never happened. */
    fun finish(ticket: Ticket) { check(ticket); cancel(ticket) }
}
