/*
 RoboFrame Native Client - Slideshow Model

 Per-window model driving one slideshow viewer, backed by the shared
 `RAVESlideshowEngine` and this app's WebSocket session pool. Exposes the same
 display-setting/adjustment surface Hypnos's `RemoteViewerModel` does, so
 `SlideshowOrnamentView` can be a close port of `RemoteViewerOrnamentView`.
 */

import AVFoundation
import Foundation
import Observation
import RAVESlideshow

@MainActor @Observable
final class SlideshowModel {
    var profile: RoboFrameProfile
    let sessionID: String
    let engine: RAVESlideshowEngine
    private let pool: RemoteSessionPool
    private let api = RoboFrameAPI()

    private(set) var tagLists: [[String]] = []
    private(set) var currentList = 0
    private(set) var sensors: [String: SensorReading] = [:]
    private(set) var alert: RemoteAlert?
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
                enableKenBurns: profile.enableKenBurns,
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

    var sortedSensors: [SensorReading] { sensors.values.sorted { $0.name < $1.name } }

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
        get { engine.displaySettings.enableKenBurns }
        set { updateDisplaySettings { $0.enableKenBurns = newValue }; profile.enableKenBurns = newValue; persistConfig() }
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
            profile.slideshow3DMode = newValue
            updateDisplaySettings { $0.mode3D = newValue == .spatial ? .spatial3D : .off }
            persistConfig()
        }
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
        pool.attach(sessionID: sessionID, profile: profile) { [weak self] message in self?.handle(message) }
        ModTagManager.shared.addSendHandler(id: sessionID) { [weak self] tags in self?.setModTags(tags) }
        let initialTags = profile.modTags.isEmpty ? ModTagManager.shared.activeTags : profile.modTags
        if !initialTags.isEmpty { setModTags(initialTags) }
    }

    func stop() {
        ModTagManager.shared.removeSendHandler(id: sessionID)
        pool.detach(sessionID: sessionID, profile: profile)
        engine.stop()
        audioPlayer?.pause()
        audioPlayer = nil
        toastTask?.cancel()
    }

    func reportScene(active: Bool) {
        engine.setVisible(active)
        pool.send(sessionID: sessionID, profile: profile, action: "present", payload: ["deviceId": profile.deviceId, "present": active])
        pool.send(sessionID: sessionID, profile: profile, action: "visibility", payload: ["deviceId": profile.deviceId, "visible": active])
    }

    func next() { pool.send(sessionID: sessionID, profile: profile, action: "requestNext") }
    func previous() { engine.previous() }
    func reshuffle() {
        pool.send(sessionID: sessionID, profile: profile, action: "reshuffle")
        showToast("Reshuffled", isError: false)
    }
    func block() {
        guard let current else { return }
        pool.send(sessionID: sessionID, profile: profile, action: "block", payload: ["id": current.id])
        showToast("Blocked", isError: false)
    }
    func setTagList(_ index: Int) { pool.send(sessionID: sessionID, profile: profile, action: "setTagList", payload: ["listNumber": index]) }
    func setModTags(_ tags: [String]) { pool.send(sessionID: sessionID, profile: profile, action: "setModTags", payload: ["tags": tags]) }
    func setDisplaySync(_ enabled: Bool) { pool.send(sessionID: sessionID, profile: profile, action: "displaySync", payload: ["enabled": enabled]) }
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
        var payload: [String: Any] = ["id": postID]
        if let durationMs, durationMs > 0 { payload["durationMs"] = durationMs }
        pool.send(sessionID: sessionID, profile: profile, action: "imageReady", payload: payload)
    }

    private func handle(_ message: RemoteMessage) {
        switch message {
        case .playback(let current, let upcoming, let interval, let list, let tags):
            updateDisplaySettings { $0.delay = interval }
            engine.setAuthoritativeNextItemID(upcoming.first.map { String($0.id) })
            engine.prunePrefetched(keeping: Set(upcoming.map { String($0.id) }))
            engine.setAuthoritativeCurrent(current?.slideshowItem)
            currentList = list
            modTags = tags
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
        case .searchEmpty(let message), .fatalError(let message): error = message
        default: break
        }
    }
}
