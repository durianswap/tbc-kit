import Foundation
import UIKit
import WebKit

/// Locates an app-owned WebView without private flutter_inappwebview APIs or a
/// "first WebView" guess. Install markerSource using initialUserScripts before
/// loading a DApp. The inert marker is read from native WKUserScript configuration,
/// never from DOM, evaluated JS, a page message, URL, or a page-provided view ID.
/// This establishes view identity ONLY, not origin, document or signing authority.
@MainActor final class TbcWebViewAttachment {
    enum Failure: Error { case closed, alreadyAttached, missing, ambiguous, budget }
    let instanceId = UUID().uuidString
    var markerSource: String { "/* tbc-native-view:\(instanceId) */" }
    private weak var webView: WKWebView?
    private weak var rootView: UIView?
    private var attached = false
    private var closed = false

    private func matches(_ view: WKWebView) -> Bool {
        let markers = view.configuration.userContentController.userScripts.filter {
            $0.source.hasPrefix("/* tbc-native-view:")
        }
        return markers.count == 1 && markers[0].source == markerSource &&
            markers[0].injectionTime == .atDocumentStart && markers[0].isForMainFrameOnly
    }

    /// A missing view may be retried after Flutter mounts it. Ambiguity/overflow
    /// permanently closes this owner; callers must not silently pick one view.
    func attach(in root: UIView) throws -> WKWebView {
        guard !closed else { throw Failure.closed }
        guard !attached else { throw Failure.alreadyAttached }
        var pending = [root], visited = 0, found: WKWebView?
        while let node = pending.popLast() {
            visited += 1
            guard visited <= 4096 else { close(); throw Failure.budget }
            if let candidate = node as? WKWebView, matches(candidate) {
                guard found == nil else { close(); throw Failure.ambiguous }
                found = candidate
            }
            guard pending.count + node.subviews.count <= 4096 else {
                close(); throw Failure.budget
            }
            pending.append(contentsOf: node.subviews)
        }
        guard let found else { throw Failure.missing }
        attached = true; webView = found; rootView = root
        return found
    }

    /// No tree scan on the message hot path. Navigation/securityOrigin checks
    /// remain the native message adapter's responsibility on the same UI actor.
    func owns(_ candidate: WKWebView) -> Bool {
        guard !closed, attached, let webView, let rootView,
              candidate === webView, candidate.isDescendant(of: rootView) else { return false }
        return true
    }

    func close() {
        closed = true; webView = nil; rootView = nil
    }
}
