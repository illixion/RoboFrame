/*
 RoboFrame Native Client - Slideshow Window View

 1:1 port of Hypnos's `RemoteViewerWindowView`, trimmed to the parts that
 apply outside Hypnos's multi-scene window manager: media surface, clock/
 sensor overlays, toast, alert, history, tap-to-reveal auto-hide chrome.

 Ornament note: Hypnos attaches its ornament via SwiftUI's `.ornament()`
 modifier onto a `WindowGroup` scene. RoboFrame's viewer is presented with
 `.fullScreenCover`, and `.ornament()`'s "float outside the window bounds"
 behavior is defined in terms of the presenting scene rather than modal
 content, so its behavior there is unverified. Rather than gamble that on an
 unattended pass, the chrome here is a plain bottom-anchored bar using the
 same `chromeBackground()` glass look — same buttons, same layout, just
 anchored inside the window instead of floating past its edge. Revisit with
 `.ornament()` once this can be verified on-device.
 */

import Combine
import SwiftUI

struct SlideshowWindowView: View {
    @Environment(\.scenePhase) private var scenePhase
    let profile: RoboFrameProfile
    let onConfigChanged: (RoboFrameProfile) -> Void

    @State private var model: SlideshowModel
    @State private var controlsVisible = true
    @State private var showHistory = false
    @State private var autoHideTask: Task<Void, Never>?
    @State private var currentTime = Date()
    @State private var historyStore: RemoteHistoryStore?

    private let clockTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(profile: RoboFrameProfile, onConfigChanged: @escaping (RoboFrameProfile) -> Void) {
        self.profile = profile
        self.onConfigChanged = onConfigChanged
        _model = State(initialValue: SlideshowModel(profile: profile))
    }

    var body: some View {
        ZStack {
            if !model.displayTransparentBackground {
                Color.black.ignoresSafeArea()
            }

            RoboFrameSlideshowSurface(model: model)
                .brightness(model.adjustments.brightness)
                .contrast(model.adjustments.contrast)
                .saturation(model.adjustments.saturation)
                .opacity(model.adjustments.opacity)
                .ignoresSafeArea()

            if model.displayShowClock {
                clockOverlay
            }

            if model.displayShowSensors, !model.sortedSensors.isEmpty {
                sensorOverlay
            }

            if let toast = model.toastMessage {
                toastOverlay(toast)
            }

            if let alert = model.alert {
                AlertOverlayView(alert: alert)
                    .transition(.opacity)
            }

            if showHistory, let store = historyStore {
                HistoryOverlayView(store: store) { post in
                    // History entries are already-seen posts; jumping to one
                    // is a manual override to the otherwise server-driven
                    // playback, matching Hypnos's `jumpToHistoryEntry`.
                    model.engine.setAuthoritativeCurrent(post.slideshowItem)
                    showHistory = false
                }
                .transition(.opacity)
            }

            VStack {
                Spacer()
                if controlsVisible {
                    SlideshowOrnamentView(model: model, showHistory: $showHistory)
                        .padding(.bottom, 24)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .contentShape(.rect)
        .onTapGesture {
            withAnimation { controlsVisible.toggle() }
            resetAutoHideTimer()
        }
        .persistentSystemOverlays(controlsVisible ? .automatic : .hidden)
        #if os(iOS)
        .statusBarHidden(!controlsVisible)
        #endif
        .onAppear {
            model.onConfigChanged = onConfigChanged
            model.start()
            historyStore = RemoteHistoryStore(profile: profile)
            resetAutoHideTimer()
        }
        .onDisappear {
            model.stop()
            autoHideTask?.cancel()
        }
        .onChange(of: scenePhase) { _, newPhase in
            model.reportScene(active: newPhase == .active)
        }
        .onChange(of: showHistory) { _, isOpen in
            guard isOpen, let historyStore else { return }
            Task { await historyStore.refresh() }
        }
        .onReceive(clockTimer) { currentTime = $0 }
    }

    private var clockOverlay: some View {
        let scale = model.profile.textSize
        return VStack {
            Spacer()
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(currentTime, format: .dateTime.hour().minute())
                        .font(.system(size: 48 * scale, weight: .light, design: .monospaced))
                    Text(currentTime, format: .dateTime.weekday(.wide).month(.wide).day())
                        .font(.system(size: 20 * scale, weight: .regular))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.7)))
                .padding(16)
                Spacer()
            }
        }
    }

    private var sensorOverlay: some View {
        let scale = model.profile.textSize
        return VStack {
            HStack {
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    ForEach(model.sortedSensors) { sensor in
                        HStack(spacing: 4) {
                            Text(sensor.name + ":")
                            Text(sensor.state)
                            if !sensor.unit.isEmpty { Text(sensor.unit) }
                        }
                        .font(.system(size: 16 * scale))
                    }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.7)))
                .padding(16)
            }
            Spacer()
        }
    }

    private func toastOverlay(_ text: String) -> some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                Text(text)
                    .font(.system(size: 16))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(model.toastIsError ? Color.red.opacity(0.85) : Color.black.opacity(0.7)))
                Spacer()
            }
            .padding(.bottom, 80)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .animation(.easeInOut, value: model.toastMessage)
    }

    private func resetAutoHideTimer() {
        autoHideTask?.cancel()
        guard controlsVisible else { return }
        autoHideTask = Task {
            try? await Task.sleep(for: .seconds(ChromeAutoHide.delay))
            guard !Task.isCancelled else { return }
            withAnimation { controlsVisible = false }
        }
    }
}
