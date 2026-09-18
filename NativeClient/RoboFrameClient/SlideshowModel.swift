import AVFoundation
import Foundation
import Observation

@MainActor @Observable
final class SlideshowModel {
    let profile: RoboFrameProfile
    let sessionID: String
    private let pool: RemoteSessionPool
    private let api = RoboFrameAPI()

    private(set) var current: RemotePost?
    private(set) var mediaURL: URL?
    private(set) var upcoming: [RemotePost] = []
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
    }

    func start() {
        pool.attach(sessionID: sessionID, profile: profile) { [weak self] message in self?.handle(message) }
    }

    func stop() {
        pool.detach(sessionID: sessionID, profile: profile)
        audioPlayer?.pause()
        audioPlayer = nil
    }

    func reportScene(active: Bool) {
        pool.send(sessionID: sessionID, profile: profile, action: "present", payload: ["deviceId": profile.deviceId, "present": active])
        pool.send(sessionID: sessionID, profile: profile, action: "visibility", payload: ["deviceId": profile.deviceId, "visible": active])
    }

    func markRendered(durationMs: Int? = nil) {
        guard isDisplayOn, let current, reportedReadyID != current.id else { return }
        reportedReadyID = current.id
        var payload: [String: Any] = ["id": current.id]
        if let durationMs, durationMs > 0 { payload["durationMs"] = durationMs }
        pool.send(sessionID: sessionID, profile: profile, action: "imageReady", payload: payload)
        Task { try? await api.addToHistory(postID: current.id, profile: profile) }
    }

    func next() { pool.send(sessionID: sessionID, profile: profile, action: "requestNext") }
    func reshuffle() { pool.send(sessionID: sessionID, profile: profile, action: "reshuffle") }
    func block() { if let current { pool.send(sessionID: sessionID, profile: profile, action: "block", payload: ["id": current.id]) } }
    func setTagList(_ index: Int) { pool.send(sessionID: sessionID, profile: profile, action: "setTagList", payload: ["listNumber": index]) }
    func setModTags(_ tags: [String]) { pool.send(sessionID: sessionID, profile: profile, action: "setModTags", payload: ["tags": tags]) }
    func setDisplaySync(_ enabled: Bool) { pool.send(sessionID: sessionID, profile: profile, action: "displaySync", payload: ["enabled": enabled]) }
    func clearError() { error = nil }

    func save() async -> String? {
        guard let current else { return nil }
        do { return try await api.save(postID: current.id, profile: profile) }
        catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    private func handle(_ message: RemoteMessage) {
        switch message {
        case .playback(let current, let upcoming, let interval, let list, let tags):
            profileInterval = interval
            self.current = current
            self.upcoming = upcoming
            self.currentList = list
            self.modTags = tags
            reportedReadyID = nil
            loadCurrent()
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
        case .refresh: loadCurrent()
        case .searchEmpty(let message), .fatalError(let message): error = message
        default: break
        }
    }

    private(set) var profileInterval: Double = 15
    private(set) var modTags: [String] = []

    private func loadCurrent() {
        guard let current else { mediaURL = nil; return }
        Task {
            do { mediaURL = try await api.mediaURL(for: current, profile: profile) }
            catch { self.error = error.localizedDescription }
        }
    }
}
