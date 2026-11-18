/*
 RoboFrame Native Client - Slideshow Window View

 1:1 port of Hypnos's `RemoteViewerWindowView`, trimmed to the parts that
 apply outside Hypnos's multi-scene window manager: media surface, clock/
 sensor overlays, toast, alert, history, tap-to-reveal auto-hide chrome.

 visionOS uses the same scene ornament and live HUD host as Convolution.
 iOS keeps its controls inside the single fullscreen viewer.
 */

import Combine
import RAVEMedia
import RAVEUI
import SwiftUI

struct SlideshowWindowView: View {
    @Environment(\.scenePhase) private var scenePhase
    #if os(visionOS)
    @Environment(\.raveViewerHUD) private var viewerHUD
    #endif
    let profile: RoboFrameProfile
    let onConfigChanged: (RoboFrameProfile) -> Void

    @State private var model: SlideshowModel
    @State private var controlsVisible = true
    @State private var showHistory = false
    @State private var autoHideTask: Task<Void, Never>?
    @State private var currentTime = Date()
    @State private var historyStore: RemoteHistoryStore?
    @State private var viewerSize = CGSize(width: 1400, height: 900)
    @State private var controlsBusy = false

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

            RoboFrameSlideshowSurface(model: model, onTap: toggleControls, controlsVisible: controlsVisible)
                .ignoresSafeArea()

            // Everything drawn over the picture sits in front of an AI 3D
            // mesh, which would otherwise cover it (see `liftedOverAIDepth`).
            if model.displayShowClock {
                clockOverlay
                    .liftedOverAIDepth(isAIDepth)
            }

            if model.displayShowSensors, !model.sortedSensors.isEmpty {
                sensorOverlay
                    .liftedOverAIDepth(isAIDepth)
            }

            if let toast = model.toastMessage {
                toastOverlay(toast)
                    .liftedOverAIDepth(isAIDepth)
            }

            if let alert = model.alert {
                AlertOverlayView(alert: alert)
                    .transition(.opacity)
                    .liftedOverAIDepth(isAIDepth)
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
                .liftedOverAIDepth(isAIDepth)
            }

            #if !os(visionOS)
            VStack {
                Spacer()
                if controlsVisible {
                    viewerControls
                        .padding(.bottom, 24)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .liftedOverAIDepth(isAIDepth)
            #endif
        }
        .background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear { viewerSize = geometry.size }
                    .onChange(of: geometry.size) { _, size in viewerSize = size }
            }
        }
        #if os(visionOS)
        .raveViewerControls(visible: controlsVisible) { viewerControls }
        .onChange(of: viewerHUD?.isInHUD) { _, inHUD in
            if inHUD == false { controlsVisible = true; resetAutoHideTimer() }
        }
        #endif
        .contentShape(.rect)
        .onTapGesture(perform: toggleControls)
        #if os(visionOS)
        // The plain, resizable "slideshow-viewer" window: visionOS resets
        // persistentSystemOverlays on every user resize regardless of this
        // condition's value, so a plain conditional modifier only survives
        // until the first resize. See RAVEUI's autoHidingSystemOverlays.
        .autoHidingSystemOverlays(when: !controlsVisible)
        #else
        .persistentSystemOverlays(controlsVisible ? .automatic : .hidden)
        #endif
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
            resetAutoHideTimer()
            guard isOpen, let historyStore else { return }
            Task { await historyStore.refresh() }
        }
        .onReceive(clockTimer) { currentTime = $0 }
        .sheet(isPresented: $model.showDepthModelSetup) {
            RAVEDepthModelSetupView(
                prompt: "3D needs a depth model: it estimates the 3D shape of each picture and video frame. Bigger models look better; smaller ones are quicker and lighter. You only need to do this once."
            ) { variant in
                // The key `CoreMLDepthProvider` reads for the real-time role.
                UserDefaults.standard.set(variant.name, forKey: DepthModelRole.realtime.defaultsKey)
                model.depthModelInstalled()
            }
        }
    }

    private var viewerControls: some View {
        SlideshowOrnamentView(model: model, showHistory: $showHistory,
                             availableWidth: max(320, viewerSize.width - 32)) { busy in
            controlsBusy = busy
            if busy { autoHideTask?.cancel() } else { resetAutoHideTimer() }
        }
        .simultaneousGesture(TapGesture().onEnded { resetAutoHideTimer() })
    }

    private var isAIDepth: Bool { model.slideshow3DMode == .aiDepth }

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
                            Text(sensor.displayName + ":")
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

    private func toggleControls() {
        guard !controlsBusy else { return }
        withAnimation { controlsVisible.toggle() }
        resetAutoHideTimer()
    }

    private func resetAutoHideTimer() {
        autoHideTask?.cancel()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestKeepControls") { return }
        #endif
        guard controlsVisible, !controlsBusy, !showHistory else { return }
        autoHideTask = Task {
            try? await Task.sleep(for: .seconds(ChromeAutoHide.delay))
            guard !Task.isCancelled else { return }
            withAnimation { controlsVisible = false }
        }
    }
}

private extension View {
    /// In front of the stereo picture's input layer. visionOS
    /// only: elsewhere there is no mesh and no depth.
    @ViewBuilder
    func liftedOverAIDepth(_ isAIDepth: Bool) -> some View {
        #if os(visionOS)
        offset(z: isAIDepth ? RAVEStereoPhotoView.inputTargetZ + 4 : 0)
        #else
        self
        #endif
    }
}
