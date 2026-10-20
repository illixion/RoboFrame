/*
 RoboFrame Native Client - Slideshow Model

 Per-window model driving one slideshow viewer, backed by the shared
 `RAVESlideshowEngine` and a session on the shared `RoboFrameConnection`. Exposes the same
 display-setting/adjustment surface Hypnos's `RemoteViewerModel` does, so
 `SlideshowOrnamentView` can be a close port of `RemoteViewerOrnamentView`.
 */

import AVFoundation
import Foundation
import Observation
import RAVEMedia
import RoboFrameKit
import RAVESlideshow

@MainActor @Observable
final class SlideshowModel {
    var profile: RoboFrameProfile
    let sessionID: String
    let engine: RAVESlideshowEngine
    private let pool: RemoteSessionPool
    private var connection: RoboFrameConnection?
    private let api = RoboFrameAPI()

    private(set) var tagLists: [[String]] = []
    private(set) var currentList = 0
    private(set) var sensors: [String: RoboFrameSensorReading] = [:]
    private(set) var alert: RoboFrameAlert?
    private(set) var effectVideoURL: URL?
    private(set) var audioPlayer: AVPlayer?
    private(set) var error: String?
    private(set) var isDisplayOn = true
    private var reportedReadyID: Int?

    /// Fires whenever an ornament/adjustments edit changes a persisted field
    /// on `profile`, so the window view can write it back into `ProfileStore`.
    var onConfigChanged: ((RoboFrameProfile) -> Void)?

    /// Non-blocking status text shown at the bottom of the viewer (save
    /// confirmation, block confirmation, errors) — matches
    /// `RemoteViewerModel.toastMessage`/`toastIsError`.
    var toastMessage: String?
    var toastIsError = false
    private var toastTask: Task<Void, Never>?

    init(profile: RoboFrameProfile, sessionID: String? = nil, pool: RemoteSessionPool = .shared) {
        self.profile = profile
        self.sessionID = sessionID ?? profile.id.uuidString
        self.pool = pool
        engine = RAVESlideshowEngine(
            provider: RoboFrameSlideshowProvider(profile: profile),
            displaySettings: .init(
                delay: profile.interval,
                showClock: profile.showClock,
                showSensors: profile.showSensors,
                useAspectRatio: profile.useAspectRatio,
                // Ken Burns doesn't move an AI 3D picture's mesh.
                enableKenBurns: profile.enableKenBurns && profile.slideshow3DMode != .aiDepth,
                enableDynamicBrightness: profile.enableDynamicBrightness,
                transparentBackground: profile.transparentBackground,
                textScale: profile.textSize,
                mode3D: profile.slideshow3DMode == .spatial ? .spatial3D : .off,
                maxImageResolution2D: profile.maxImageResolution2D ?? AppSettings.shared.defaultMaxImageResolution2D,
                maxImageResolution3D: profile.maxImageResolution3D ?? AppSettings.shared.defaultMaxImageResolution3D
            ),
            visualSettings: AppSettings.shared.globalVisualAdjustments.slideshowVisualSettings,
            configuration: .init(serverDriven: true, automaticAdvancement: false)
        )
        engine.onTransition = { [weak self] displayed in
            self?.markRendered(postID: Int(displayed.item.id), durationMs: displayed.item.duration.map { Int($0 * 1_000) })
        }
    }

    var current: RemotePost? { engine.current.flatMap { RemotePost(slideshowItem: $0.item) } }
    var currentMedia: RAVESlideshowDisplayedMedia? { engine.current }
    var incomingMedia: RAVESlideshowDisplayedMedia? { engine.incoming }
    var profileInterval: Double { engine.displaySettings.delay }
    var modTags: [String] = []

    /// Adjustments currently applied to this window, mirrored into the
    /// engine's `visualSettings` on every change.
    var adjustments: VisualAdjustments {
        get {
            let v = engine.visualSettings
            return VisualAdjustments(brightness: v.brightness, contrast: v.contrast, saturation: v.saturation, opacity: v.opacity)
        }
        set { engine.visualSettings = newValue.slideshowVisualSettings }
    }

    var sortedSensors: [RoboFrameSensorReading] { sensors.values.sorted { $0.sortKey < $1.sortKey } }

    // MARK: - Display setting proxies (Adjustments popover "Viewer" tab + ornament)

    var displayShowClock: Bool {
        get { engine.displaySettings.showClock }
        set { updateDisplaySettings { $0.showClock = newValue }; profile.showClock = newValue; persistConfig() }
    }
    var displayShowSensors: Bool {
        get { engine.displaySettings.showSensors }
        set { updateDisplaySettings { $0.showSensors = newValue }; profile.showSensors = newValue; persistConfig() }
    }
    var displayUseAspectRatio: Bool {
        get { engine.displaySettings.useAspectRatio }
        set { updateDisplaySettings { $0.useAspectRatio = newValue }; profile.useAspectRatio = newValue; persistConfig() }
    }
    var displayEnableKenBurns: Bool {
        get { profile.enableKenBurns }
        set {
            updateDisplaySettings { $0.enableKenBurns = newValue && profile.slideshow3DMode != .aiDepth }
            profile.enableKenBurns = newValue
            persistConfig()
        }
    }
    var displayEnableDynamicBrightness: Bool {
        get { engine.displaySettings.enableDynamicBrightness }
        set { updateDisplaySettings { $0.enableDynamicBrightness = newValue }; profile.enableDynamicBrightness = newValue; persistConfig() }
    }
    var displayTransparentBackground: Bool {
        get { engine.displaySettings.transparentBackground }
        set { updateDisplaySettings { $0.transparentBackground = newValue }; profile.transparentBackground = newValue; persistConfig() }
    }
    var displayDelay: Double {
        get { engine.displaySettings.delay }
        set { updateDisplaySettings { $0.delay = newValue }; profile.interval = newValue; persistConfig() }
    }

    /// The slideshow 3D mode as the ornament's menu understands it. Bridges
    /// `Slideshow3DPreference` (which also carries the RoboFrame-specific
    /// real-time-video option) onto the engine's `RAVESlideshow3DMode`.
    var slideshow3DMode: Slideshow3DPreference {
        get { profile.slideshow3DMode }
        set {
            // No depth model yet: offer one, and switch once it's installed.
            if newValue.needsDepthModel, !RAVEStillDepthEstimator.shared.isModelAvailable {
                pendingDepthModelMode = newValue
                showDepthModelSetup = true
                return
            }
            apply3DMode(newValue)
        }
    }

    private func apply3DMode(_ mode: Slideshow3DPreference) {
        profile.slideshow3DMode = mode
        updateDisplaySettings {
            $0.mode3D = mode == .spatial ? .spatial3D : .off
            $0.enableKenBurns = profile.enableKenBurns && mode != .aiDepth
        }
        persistConfig()
    }

    /// Drives the depth-model setup sheet, shown when a 3D mode that runs
    /// the depth model is chosen with none installed.
    var showDepthModelSetup = false
    private var pendingDepthModelMode: Slideshow3DPreference?

    /// The setup sheet installed a model: apply the mode that asked for it.
    /// Directly, not through the setter: the estimator caches "no model" for
    /// a few seconds and would offer the sheet again.
    func depthModelInstalled() {
        guard let mode = pendingDepthModelMode else { return }
        pendingDepthModelMode = nil
        apply3DMode(mode)
    }

    var maxImageResolution2D: Int {
        get { profile.maxImageResolution2D ?? AppSettings.shared.defaultMaxImageResolution2D }
        set {
            profile.maxImageResolution2D = newValue
            updateDisplaySettings { $0.maxImageResolution2D = newValue }
            persistConfig()
        }
    }
    var maxImageResolution3D: Int {
        get { profile.maxImageResolution3D ?? AppSettings.shared.defaultMaxImageResolution3D }
        set {
            profile.maxImageResolution3D = newValue
            updateDisplaySettings { $0.maxImageResolution3D = newValue }
            persistConfig()
        }
    }

    private func updateDisplaySettings(_ mutate: (inout RAVESlideshowDisplaySettings) -> Void) {
        var settings = engine.displaySettings
        mutate(&settings)
        engine.displaySettings = settings
    }

    private func persistConfig() {
        onConfigChanged?(profile)
    }

    func start() {
        engine.start()
        guard let (connection, handlers) = pool.attach(sessionID: sessionID, profile: profile) else {
            error = "Invalid RoboFrame WebSocket URL."
            return
        }
        self.connection = connection
        handlers.onMessage = { [weak self] message in self?.handle(message) }
        handlers.onConnected = { [weak self] in self?.sendSlideshowConfig() }
        reportScene(active: true)
        ModTagManager.shared.addSendHandler(id: sessionID) { [weak self] tags in self?.setModTags(tags) }
        let initialTags = profile.modTags.isEmpty ? ModTagManager.shared.activeTags : profile.modTags
        if !initialTags.isEmpty { setModTags(initialTags) }
    }

    func stop() {
        ModTagManager.shared.removeSendHandler(id: sessionID)
        pool.detach(sessionID: sessionID, profile: profile)
        connection = nil
        engine.stop()
        audioPlayer?.pause()
        audioPlayer = nil
        toastTask?.cancel()
    }

    /// Joins this window's channel. The connection calls it after every
    /// (re)connect, ahead of replaying the scene state.
    private func sendSlideshowConfig() {
        connection?.sendSlideshowConfig(sessionId: sessionID, RoboFrameSlideshowConfig(
            deviceId: profile.deviceId,
            intervalMs: Int(max(2, profile.interval) * 1_000),
            modTags: profile.modTags
        ))
    }

    /// A shown window is present (it drives its channel) and visible (HA's
    /// motion telemetry, OR-ed across windows sharing the deviceId).
    func reportScene(active: Bool) {
        engine.setVisible(active)
        connection?.reportSceneState(sessionId: sessionID, deviceId: profile.deviceId, present: active, visible: active)
    }

    func next() { connection?.sendRequestNext(sessionId: sessionID) }
    func previous() { engine.previous() }
    func reshuffle() {
        connection?.sendReshuffle(sessionId: sessionID)
        showToast("Reshuffled", isError: false)
    }
    func block() {
        guard let current else { return }
        connection?.sendBlock(postId: current.id)
        showToast("Blocked", isError: false)
    }
    func setTagList(_ index: Int) { connection?.sendSetTagList(sessionId: sessionID, listNumber: index) }
    func setModTags(_ tags: [String]) { connection?.sendSetModTags(sessionId: sessionID, tags: tags) }
    func setDisplaySync(_ enabled: Bool) { connection?.sendDisplaySync(sessionId: sessionID, enabled: enabled) }
    func clearError() { error = nil }

    func save() async -> String? {
        guard let current else { return nil }
        do {
            let result = try await api.save(postID: current.id, profile: profile)
            showToast(result.isEmpty ? "Saved" : result, isError: false)
            return result
        } catch {
            self.error = error.localizedDescription
            showToast(error.localizedDescription, isError: true)
            return nil
        }
    }

    private func showToast(_ text: String, isError: Bool) {
        toastTask?.cancel()
        toastMessage = text
        toastIsError = isError
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.toastMessage = nil
        }
    }

    private func markRendered(postID: Int?, durationMs: Int?) {
        guard isDisplayOn, let postID, reportedReadyID != postID else { return }
        reportedReadyID = postID
        connection?.sendImageReady(sessionId: sessionID, postId: postID, durationMs: durationMs)
    }

    private func handle(_ message: RoboFrameMessage) {
        switch message {
        case .playback(let playback):
            if let interval = playback.interval { updateDisplaySettings { $0.delay = interval } }
            engine.setAuthoritativeNextItemID(playback.upcoming.first.map { String($0.id) })
            engine.prunePrefetched(keeping: Set(playback.upcoming.map { String($0.id) }))
            engine.setAuthoritativeCurrent(playback.current?.slideshowItem)
            if let list = playback.currentList { currentList = list }
            if let tags = playback.modTags { modTags = tags }
            reportedReadyID = nil
        case .tagLists(let lists): tagLists = lists
        case .sensor(let reading): sensors[reading.id] = reading
        case .alert(let alert): self.alert = alert
        case .dismissAlert: alert = nil
        case .playVideo(let url): effectVideoURL = url
        case .stopVideo: effectVideoURL = nil
        case .playAudio(let url):
            let player = AVPlayer(url: url)
            audioPlayer = player
            player.play()
        case .stopAudio: audioPlayer?.pause(); audioPlayer = nil
        case .displayState(let target, let on) where target == profile.deviceId:
            isDisplayOn = on
            reportScene(active: on)
        case .refresh:
            // A refresh is a server request to reconcile its current frame, not
            // a client-side advance. The authoritative playback frame follows.
            engine.resetSource()
        case .searchEmpty(let query): error = query.isEmpty ? "No matching posts." : "No posts match \(query)."
        case .halted(let reason): error = reason
        default: break
        }
    }
}
