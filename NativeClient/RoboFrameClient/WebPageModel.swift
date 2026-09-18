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
    private var delegate: Delegate?
    private var refreshTask: Task<Void, Never>?

    init(profile: RoboFrameProfile) { self.profile = profile }

    func start() {
        guard webView == nil, let url = profile.resolvedWebPageURL else { return }
        let delegate = Delegate()
        delegate.didStart = { [weak self] in self?.isLoading = true }
        delegate.didFinish = { [weak self] in self?.isLoading = false; self?.title = self?.webView?.title ?? ""; self?.restartRefresh() }
        delegate.didFail = { [weak self] in self?.isLoading = false; self?.error = $0 }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if profile.webTransparentBackground {
            configuration.userContentController.addUserScript(.init(source: "document.documentElement.style.background='transparent';document.body&&(document.body.style.background='transparent');", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
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
        view.load(URLRequest(url: url))
    }

    func stop() { refreshTask?.cancel(); webView?.stopLoading(); webView = nil; delegate = nil }
    func reload() { webView?.reload(); restartRefresh() }
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

    private final class Delegate: NSObject, WKNavigationDelegate, WKUIDelegate {
        var didStart: (() -> Void)?
        var didFinish: (() -> Void)?
        var didFail: ((String) -> Void)?
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { didStart?() }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { didFinish?() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { didFail?(error.localizedDescription) }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
            return nil
        }
    }
}
