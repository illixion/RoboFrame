/*
 RoboFrame Native Client - Pinned Web Page View

 1:1 port of Hypnos's `PinnedWebPageView`: a thin `UIViewRepresentable`
 wrapper around the model-owned `WKWebView`, so the page's scroll position,
 login state, and in-page JS survive the window losing and regaining focus.
 */

import SwiftUI
import WebKit

struct PinnedWebPageView: UIViewRepresentable {
    let model: WebPageModel
    let interactionEnabled: Bool

    func makeUIView(context: Context) -> WKWebView {
        let webView = model.webView ?? WKWebView(frame: .zero)
        model.setInteractionEnabled(interactionEnabled)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        model.setInteractionEnabled(interactionEnabled)
    }
}
