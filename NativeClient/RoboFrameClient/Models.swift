import Foundation

enum ProfileMode: String, Codable, CaseIterable, Identifiable {
    case slideshow
    case webPage

    var id: String { rawValue }
    var label: String { self == .slideshow ? "RoboFrame" : "Website" }
}

struct RoboFrameProfile: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var savedDate: Date = .now
    var name: String = "New Display"
    var mode: ProfileMode = .slideshow
    var endpoint: String = ""
    var deviceId: String = ""
    var accessToken: String = ""
    var interval: Double = 15
    var modTags: [String] = []
    var showClock = true
    var showSensors = true
    var webPageURL = ""
    var webTransparentBackground = false
    var webAutoRefreshInterval: Double = 0

    var normalizedEndpoint: URL? {
        let value = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        return URL(string: value.contains("://") ? value : "https://\(value)")
    }

    var webSocketURL: URL? {
        guard var components = URLComponents(url: normalizedEndpoint ?? URL(string: "https://invalid")!, resolvingAgainstBaseURL: false),
              components.host != nil else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/rpc/ws"
        components.path = "/" + components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: accessToken)]
        }
        return components.url
    }

    var resolvedWebPageURL: URL? {
        let value = webPageURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let candidate = value.contains("://") ? value : "https://\(value)"
        guard let url = URL(string: candidate), url.host != nil else { return nil }
        return url
    }

    var launchError: String? {
        switch mode {
        case .slideshow:
            if normalizedEndpoint == nil { return "Enter a RoboFrame server URL." }
            if deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "Enter a stable display ID."
            }
            return nil
        case .webPage: return resolvedWebPageURL == nil ? "Enter a valid website URL." : nil
        }
    }

    func duplicated(named name: String) -> Self {
        var result = self
        result.id = UUID()
        result.savedDate = .now
        result.name = name
        return result
    }
}

struct RemotePost: Identifiable, Equatable, Hashable {
    let id: Int
    let ext: String
    let durationMs: Int?
    var isVideo: Bool { ["mp4", "webm", "mov", "m4v"].contains(ext.lowercased()) }
}

struct SensorReading: Identifiable, Equatable {
    let id: String
    var state: String
    var name: String
    var unit: String
}

struct RemoteAlert: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let colorHex: String
    let imageURL: URL?
}

enum RemoteMessage: Equatable {
    case connected
    case playback(current: RemotePost?, upcoming: [RemotePost], interval: Double, currentList: Int, modTags: [String])
    case tagLists([[String]])
    case sensor(SensorReading)
    case alert(RemoteAlert)
    case dismissAlert
    case playVideo(URL)
    case stopVideo
    case playAudio(URL)
    case stopAudio
    case displayState(target: String, isOn: Bool)
    case refresh
    case searchEmpty(String)
    case fatalError(String)
}

enum RoboFrameAPIError: LocalizedError {
    case invalidEndpoint
    case badResponse

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: "Invalid RoboFrame server URL."
        case .badResponse: "RoboFrame server returned an invalid response."
        }
    }
}
