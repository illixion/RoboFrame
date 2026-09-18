import AVFoundation
import Foundation
import Observation
import RAVESlideshow

@MainActor @Observable
final class SlideshowModel {
    let profile: RoboFrameProfile
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
                mode3D: profile.slideshow3DMode == .spatial ? .spatial3D : .off
            ),
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

    func start() {
        engine.start()
        pool.attach(sessionID: sessionID, profile: profile) { [weak self] message in self?.handle(message) }
    }

    func stop() {
        pool.detach(sessionID: sessionID, profile: profile)
        engine.stop()
        audioPlayer?.pause()
        audioPlayer = nil
    }

    func reportScene(active: Bool) {
        engine.setVisible(active)
        pool.send(sessionID: sessionID, profile: profile, action: "present", payload: ["deviceId": profile.deviceId, "present": active])
        pool.send(sessionID: sessionID, profile: profile, action: "visibility", payload: ["deviceId": profile.deviceId, "visible": active])
    }

    func next() { pool.send(sessionID: sessionID, profile: profile, action: "requestNext") }
    func reshuffle() { pool.send(sessionID: sessionID, profile: profile, action: "reshuffle") }
    func block() {
        guard let current else { return }
        pool.send(sessionID: sessionID, profile: profile, action: "block", payload: ["id": current.id])
    }
    func setTagList(_ index: Int) { pool.send(sessionID: sessionID, profile: profile, action: "setTagList", payload: ["listNumber": index]) }
    func setModTags(_ tags: [String]) { pool.send(sessionID: sessionID, profile: profile, action: "setModTags", payload: ["tags": tags]) }
    func setDisplaySync(_ enabled: Bool) { pool.send(sessionID: sessionID, profile: profile, action: "displaySync", payload: ["enabled": enabled]) }
    func clearError() { error = nil }

    func save() async -> String? {
        guard let current else { return nil }
        do { return try await api.save(postID: current.id, profile: profile) }
        catch { self.error = error.localizedDescription; return nil }
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
            engine.displaySettings.delay = interval
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
