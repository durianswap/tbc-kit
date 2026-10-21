package example.tbc

import io.tbc.kit.dart.NativeApprovalPresenter
import io.tbc.kit.dart.NativeReview

/** All callbacks run on the custody owner thread; wire to trusted wallet UI. */
class PartnerApprovalPresenter(
    private val show: (NativeReview, (Boolean) -> Unit) -> (() -> Unit),
    private val refresh: (NativeReview) -> Unit
) : NativeApprovalPresenter {
    private class Entry(val initial: NativeReview) {
        var decided = false
        var approved = false
        var closed = false
        var close: (() -> Unit)? = null
    }
    private val entries = mutableMapOf<String, Entry>()
    override fun present(review: NativeReview, complete: (Boolean) -> Unit): () -> Unit {
        if (entries.containsKey(review.operationId)) { complete(false); return {} }
        val entry = Entry(review)
        entries[review.operationId] = entry
        entry.close = show(review) { approved ->
            if (entries[review.operationId] === entry && !entry.decided && !entry.closed) {
                entry.decided = true; entry.approved = approved
                complete(approved) // exactly once, only on an explicit UI decision
            }
        }
        if (entry.closed) { entry.close?.invoke(); entry.close = null }
        return {
            if (!entry.closed) {
                entry.closed = true; entry.close?.invoke(); entry.close = null
                if (!entry.approved) entries.remove(review.operationId)
            }
        }
    }
    override fun update(review: NativeReview) {
        val entry = entries[review.operationId] ?: return
        if (entry.approved && review.phase == "binding-verified" &&
            review.origin == entry.initial.origin && review.chainId == entry.initial.chainId &&
            review.accountAddress == entry.initial.accountAddress) {
            refresh(review) // existing progress/details only; no second decision
        }
    }
    fun finish(operationId: String) {
        val entry = entries.remove(operationId) ?: return
        if (!entry.closed) { entry.closed = true; entry.close?.invoke(); entry.close = null }
    }
}
