import Foundation
import Observation
import WebKit

@MainActor @Observable
final class WebPageModel {
    let profile: RoboFrameProfile
    @ObservationIgnored private(set) var webView: WKWebView?
    var title = ""
    var isLoading = false
    var error: String?
    var interactionEnabled = true
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var currentURLText = ""

    /// Fires on every user tap/scroll reported by the page, so the owning
    /// window can restart its ornament auto-hide timer — the page can't
    /// reveal the ornaments itself once they're gone. Mirrors
    /// `WebPageWindowModel.onUserInteraction` in Hypnos.
    var onUserInteraction: (() -> Void)?

    private var delegate: Delegate?
    private var refreshTask: Task<Void, Never>?

    init(profile: RoboFrameProfile) { self.profile = profile }

    func start() {
        guard webView == nil, let url = profile.resolvedWebPageURL else { return }
        let delegate = Delegate()
        delegate.didStart = { [weak self] in self?.isLoading = true }
        delegate.didFinish = { [weak self] in
            guard let self else { return }
            self.isLoading = false
            self.title = self.webView?.title ?? ""
            self.canGoBack = self.webView?.canGoBack ?? false
            self.canGoForward = self.webView?.canGoForward ?? false
            self.currentURLText = self.webView?.url?.absoluteString ?? self.profile.webPageURL
            self.restartRefresh()
        }
        delegate.didFail = { [weak self] in self?.isLoading = false; self?.error = $0 }
        delegate.didInteract = { [weak self] in self?.onUserInteraction?() }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if profile.webTransparentBackground {
            configuration.userContentController.addUserScript(.init(source: "document.documentElement.style.background='transparent';document.body&&(document.body.style.background='transparent');", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Reports taps/scrolls so the owning window can restart its
        // auto-hide timer while the page is actively being used — a reload
        // mid-interaction (below) already restarts it, but that alone would
        // hide the ornaments under the user while they're still reading.
        configuration.userContentController.add(delegate, name: "pageInteraction")
        configuration.userContentController.addUserScript(.init(
            source: """
            (function () {
                let last = 0;
                function report() {
                    const now = Date.now();
                    if (now - last < 1000) { return; }
                    last = now;
                    window.webkit.messageHandlers.pageInteraction.postMessage("tick");
                }
                document.addEventListener("click", report, true);
                document.addEventListener("scroll", report, true);
                document.addEventListener("touchstart", report, true);
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = delegate
        view.uiDelegate = delegate
        if profile.webTransparentBackground {
            view.isOpaque = false
            view.backgroundColor = .clear
            view.underPageBackgroundColor = .clear
        }
        self.delegate = delegate
        webView = view
        currentURLText = url.absoluteString
        view.load(URLRequest(url: url))
    }

    func stop() { refreshTask?.cancel(); webView?.configuration.userContentController.removeScriptMessageHandler(forName: "pageInteraction"); webView?.stopLoading(); webView = nil; delegate = nil }
    func reload() { webView?.reload(); restartRefresh() }
    func stopLoading() { webView?.stopLoading(); isLoading = false }
    func goBack() { webView?.goBack(); restartRefresh() }
    func goForward() { webView?.goForward(); restartRefresh() }
    func goHome() { if let url = profile.resolvedWebPageURL { webView?.load(URLRequest(url: url)) }; restartRefresh() }
    func setInteractionEnabled(_ enabled: Bool) { interactionEnabled = enabled; webView?.isUserInteractionEnabled = enabled }

    private func restartRefresh() {
        refreshTask?.cancel()
        guard profile.webAutoRefreshInterval > 0 else { return }
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.profile.webAutoRefreshInterval))
            guard !Task.isCancelled else { return }
            self.webView?.reload()
        }
    }

    private final class Delegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var didStart: (() -> Void)?
        var didFinish: (() -> Void)?
        var didFail: ((String) -> Void)?
        var didInteract: (() -> Void)?
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { didStart?() }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { didFinish?() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { didFail?(error.localizedDescription) }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
            return nil
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "pageInteraction" else { return }
            didInteract?()
        }
    }
}
