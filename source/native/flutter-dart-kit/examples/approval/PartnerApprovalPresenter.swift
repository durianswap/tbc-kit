import Foundation
#if canImport(tbc_kit_flutter_dart)
import tbc_kit_flutter_dart
#endif

/// Wire show/refresh to trusted, scrollable wallet UI. Never a WebView prompt.
/// Retain the details view after consent; finish() releases it on completion.
@MainActor final class PartnerApprovalPresenter: NativeApprovalPresenter {
    typealias Show = @MainActor (NativeReview, @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void
    private final class Entry {
        let initial: NativeReview
        var decided = false, approved = false, closed = false
        var close: (@MainActor () -> Void)?
        init(_ review: NativeReview) { initial = review }
    }
    private var entries: [String: Entry] = [:]
    private let show: Show
    private let refresh: @MainActor (NativeReview) -> Void
    init(show: @escaping Show, refresh: @escaping @MainActor (NativeReview) -> Void) {
        self.show = show; self.refresh = refresh
    }
    func present(_ review: NativeReview, complete: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void {
        guard entries[review.operationId] == nil else { complete(false); return {} }
        let entry = Entry(review)
        entries[review.operationId] = entry
        entry.close = show(review) { [weak self, weak entry] approved in
            guard let self, let entry, self.entries[review.operationId] === entry,
                  !entry.decided, !entry.closed else { return }
            entry.decided = true; entry.approved = approved
            complete(approved) // exactly once, only on an explicit UI decision
        }
        if entry.closed { entry.close?(); entry.close = nil }
        return { [weak self, weak entry] in
            guard let self, let entry, !entry.closed else { return }
            entry.closed = true; entry.close?(); entry.close = nil
            if !entry.approved { self.entries.removeValue(forKey: review.operationId) }
        }
    }
    func update(_ review: NativeReview) {
        guard let entry = entries[review.operationId], entry.approved,
              review.phase == "binding-verified",
              review.origin == entry.initial.origin,
              review.chainId == entry.initial.chainId,
              review.accountAddress == entry.initial.accountAddress else { return }
        refresh(review) // existing progress/details only; no decision callback
    }
    func finish(operationId: String) {
        guard let entry = entries.removeValue(forKey: operationId) else { return }
        if !entry.closed { entry.closed = true; entry.close?(); entry.close = nil }
    }
}
