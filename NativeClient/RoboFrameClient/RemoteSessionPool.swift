import Foundation
import Observation
import RAVENet

@MainActor @Observable
final class RemoteSessionPool {
    static let shared = RemoteSessionPool()
    private var connections: [URL: PooledConnection] = [:]

    func attach(sessionID: String, profile: RoboFrameProfile, handler: @escaping (RemoteMessage) -> Void) {
        guard let url = profile.webSocketURL else {
            handler(.fatalError("Invalid RoboFrame WebSocket URL."))
            return
        }
        let connection = connections[url] ?? {
            let connection = PooledConnection(url: url)
            connections[url] = connection
            return connection
        }()
        connection.attach(sessionID: sessionID, profile: profile, handler: handler)
    }

    func detach(sessionID: String, profile: RoboFrameProfile) {
        guard let url = profile.webSocketURL, let connection = connections[url] else { return }
        connection.detach(sessionID: sessionID)
        if connection.isEmpty {
            connection.stop()
            connections.removeValue(forKey: url)
        }
    }

    func send(sessionID: String, profile: RoboFrameProfile, action: String, payload: [String: Any] = [:]) {
        guard let connection = profile.webSocketURL.flatMap({ connections[$0] }) else { return }
        connection.send(sessionID: sessionID, action: action, payload: payload)
    }
}

@MainActor
private final class PooledConnection {
    private struct Entry {
        var profile: RoboFrameProfile
        var handler: (RemoteMessage) -> Void
    }
    private let transport: RAVEWebSocketTransport
    private var entries: [String: Entry] = [:]
    private var events: Task<Void, Never>?
    private var ready = false

    init(url: URL) {
        transport = RAVEWebSocketTransport(
            configuration: .init(url: url),
            pingFrameProvider: { #"{"action":"ping"}"# },
            failurePolicy: { failure in
                failure.closeCode == .policyViolation
                    ? .halt(failure.closeReason ?? "Server rejected the access token.")
                    : .reconnect
            }
        )
        events = Task { [weak self, transport] in
            for await event in transport.events {
                await MainActor.run { self?.receive(event) }
            }
        }
        Task { await transport.start() }
    }

    var isEmpty: Bool { entries.isEmpty }

    func attach(sessionID: String, profile: RoboFrameProfile, handler: @escaping (RemoteMessage) -> Void) {
        entries[sessionID] = Entry(profile: profile, handler: handler)
        if ready { configure(sessionID: sessionID, profile: profile) }
    }

    func detach(sessionID: String) {
        if ready { send(sessionID: sessionID, action: "present", payload: ["deviceId": entries[sessionID]?.profile.deviceId ?? "", "present": false]) }
        send(sessionID: sessionID, action: "sessionEnd")
        entries.removeValue(forKey: sessionID)
    }

    func stop() {
        events?.cancel()
        Task { await transport.stop() }
    }

    func send(sessionID: String, action: String, payload: [String: Any] = [:]) {
        var frame: [String: Any] = ["action": action]
        if ["slideshowConfig", "imageReady", "present", "requestNext", "reshuffle", "setModTags", "setTagList", "displaySync", "sessionEnd"].contains(action) {
            frame["sessionId"] = sessionID
        }
        if !payload.isEmpty { frame["payload"] = payload }
        guard JSONSerialization.isValidJSONObject(frame),
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        Task { await transport.send(text) }
    }

    private func receive(_ event: RAVENetEvent) {
        switch event {
        case .frame(let frame):
            if !ready {
                ready = true
                Task { await transport.markReady() }
                entries.forEach { configure(sessionID: $0.key, profile: $0.value.profile) }
                broadcast(.connected)
            }
            parse(frame)
        case .stateChanged(.failed(let reason)):
            broadcast(.fatalError(reason))
        default: break
        }
    }

    private func configure(sessionID: String, profile: RoboFrameProfile) {
        let payload: [String: Any] = [
            "deviceId": profile.deviceId,
            "interval": Int(max(2, profile.interval) * 1_000),
            "modTags": profile.modTags,
        ]
        send(sessionID: sessionID, action: "slideshowConfig", payload: payload)
        send(sessionID: sessionID, action: "present", payload: ["deviceId": profile.deviceId, "present": true])
        send(sessionID: sessionID, action: "visibility", payload: ["deviceId": profile.deviceId, "visible": true])
    }

    private func broadcast(_ message: RemoteMessage) { entries.values.forEach { $0.handler(message) } }
    private func route(_ message: RemoteMessage, ids: [String]?) {
        guard let ids, !ids.isEmpty else { return broadcast(message) }
        ids.forEach { entries[$0]?.handler(message) }
    }

    private func parse(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = object["action"] as? String else { return }
        let payload = object["payload"] as? [String: Any] ?? [:]
        let ids = object["sessionIds"] as? [String]
        switch action {
        case "tagLists":
            if let lists = object["payload"] as? [[String]] { broadcast(.tagLists(lists)) }
        case "playback":
            let current = post(payload["current"])
            let upcoming = (payload["upcoming"] as? [[String: Any]] ?? []).compactMap(post)
            route(.playback(current: current, upcoming: upcoming, interval: Double(payload["interval"] as? Int ?? 15_000) / 1_000, currentList: payload["currentList"] as? Int ?? 0, modTags: payload["modTags"] as? [String] ?? []), ids: ids)
        case "update":
            guard let entity = payload["entity"] as? String, let state = payload["state"] as? String else { return }
            let attributes = payload["attributes"] as? [String: Any]
            broadcast(.sensor(.init(id: entity, state: state, name: attributes?["friendly_name"] as? String ?? entity, unit: attributes?["unit_of_measurement"] as? String ?? "")))
        case "showText":
            guard let text = payload["text"] as? String else { return }
            broadcast(.alert(.init(text: text, colorHex: payload["bgColorHex"] as? String ?? "#000000", imageURL: (payload["imageUrl"] as? String).flatMap(URL.init(string:)))))
        case "dismissText": broadcast(.dismissAlert)
        case "playVideo": if let value = payload["url"] as? String, let url = URL(string: value) { broadcast(.playVideo(url)) }
        case "stopVideo": broadcast(.stopVideo)
        case "playAudio": if let value = payload["url"] as? String, let url = URL(string: value) { broadcast(.playAudio(url)) }
        case "stopAudio": broadcast(.stopAudio)
        case "refresh": broadcast(.refresh)
        case "searchEmpty": broadcast(.searchEmpty(payload["query"] as? String ?? "No matching posts."))
        case "displayState":
            if let target = payload["target"] as? String, let state = payload["state"] as? String { broadcast(.displayState(target: target, isOn: state != "off")) }
        default: break
        }
    }

    private func post(_ object: Any?) -> RemotePost? {
        guard let item = object as? [String: Any], let id = item["id"] as? Int, let ext = item["ext"] as? String else { return nil }
        return .init(id: id, ext: ext, durationMs: item["durationMs"] as? Int)
    }
}
