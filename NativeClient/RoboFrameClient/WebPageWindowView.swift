/*
 RoboFrame Native Client - Web Page Window View

 1:1 port of Hypnos's `WebPageWindowView`: pins an arbitrary web page as an
 interactive panel, with page state retained for the model's lifetime,
 and interaction gated on ornament visibility (see the reveal-catcher note
 below — it is the sole way back once controls are hidden).
 */

import SwiftUI

struct WebPageWindowView: View {
    @Environment(\.scenePhase) private var scenePhase
    let profile: RoboFrameProfile

    @State private var model: WebPageModel
    @State private var controlsVisible = true
    @State private var autoHideTask: Task<Void, Never>?

    private let cornerRadius: CGFloat = 24

    init(profile: RoboFrameProfile) {
        self.profile = profile
        _model = State(initialValue: WebPageModel(profile: profile))
    }

    private var isTransparent: Bool { profile.webTransparentBackground }

    var body: some View {
        ZStack {
            if model.webView != nil {
                PinnedWebPageView(model: model, interactionEnabled: controlsVisible)
                    .allowsHitTesting(controlsVisible)
                    .clipShape(.rect(cornerRadius: isTransparent ? 0 : cornerRadius))
            } else {
                unavailableView
            }

            // Reveal target, in FRONT of the page. A gesture on the container
            // *behind* the WebView won't reach gaze targeting on visionOS once
            // the page stops accepting hits, so this needs to be a real
            // (invisible) drawn layer, not `Color.clear`, sitting above it.
            if !controlsVisible {
                Color.white.opacity(0.001)
                    .contentShape(.rect)
                    .onTapGesture { showControls() }
                    .accessibilityIdentifier("roboframe.web.reveal")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            if !isTransparent { Color.black }
        }
        .overlay(alignment: .bottom) {
            if controlsVisible {
                WebPageOrnamentView(model: model, onHideControls: hideControls)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .contentShape(.rect)
        // Backstop for the in-front catcher above (and the reveal path when
        // the page failed to load, so there's no WebView in the way at all).
        .onTapGesture { showControls() }
        .persistentSystemOverlays(controlsVisible ? .automatic : .hidden)
        #if os(iOS)
        .statusBarHidden(!controlsVisible)
        #endif
        .onAppear {
            model.onUserInteraction = { resetAutoHideTimer() }
            model.start()
            controlsVisible = true
            resetAutoHideTimer()
        }
        .onDisappear {
            model.stop()
            autoHideTask?.cancel()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase != .active { model.stopLoading() }
        }
    }

    @ViewBuilder
    private var unavailableView: some View {
        VStack(spacing: 12) {
            Image(systemName: "globe.badge.chevron.backward")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("\"\(profile.name)\" has no valid page URL.")
                .font(.title3)
                .multilineTextAlignment(.center)
            Text("Set a page URL for this profile, then launch it again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(40)
    }

    private func showControls() {
        guard !controlsVisible else { return }
        withAnimation { controlsVisible = true }
        resetAutoHideTimer()
    }

    private func hideControls() {
        autoHideTask?.cancel()
        withAnimation { controlsVisible = false }
    }

    private func resetAutoHideTimer() {
        autoHideTask?.cancel()
        autoHideTask = Task {
            try? await Task.sleep(for: .seconds(ChromeAutoHide.delay))
            guard !Task.isCancelled else { return }
            withAnimation { controlsVisible = false }
        }
    }
}
