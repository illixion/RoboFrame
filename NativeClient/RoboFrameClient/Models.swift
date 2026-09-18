import Foundation

enum ProfileMode: String, Codable, CaseIterable, Identifiable {
    case slideshow
    case webPage

    var id: String { rawValue }
    var label: String { self == .slideshow ? "RoboFrame" : "Website" }
    var systemImage: String { self == .slideshow ? "photo.stack" : "globe" }
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
    var slideshow3DMode: Slideshow3DPreference = .off

    // Display settings mirrored from Hypnos's RemoteViewerConfig, so a
    // profile carries the same knobs the slideshow ornament and Adjustments
    // popover expose there.
    var useAspectRatio: Bool = true
    var enableKenBurns: Bool = true
    var enableDynamicBrightness: Bool = true
    var transparentBackground: Bool = false
    var textSize: Double = 1.0

    /// Per-profile resolution caps. `nil` inherits `AppSettings`'s device-wide
    /// default, matching `RemoteViewerConfig.maxImageResolution2D/3D`.
    var maxImageResolution2D: Int?
    var maxImageResolution3D: Int?

    enum CodingKeys: String, CodingKey {
        case id, savedDate, name, mode, endpoint, deviceId, accessToken, interval, modTags
        case showClock, showSensors, webPageURL, webTransparentBackground, webAutoRefreshInterval, slideshow3DMode
        case useAspectRatio, enableKenBurns, enableDynamicBrightness, transparentBackground, textSize
        case maxImageResolution2D, maxImageResolution3D
    }

    init() {}

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        savedDate = try values.decodeIfPresent(Date.self, forKey: .savedDate) ?? .now
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? "New Display"
        mode = try values.decodeIfPresent(ProfileMode.self, forKey: .mode) ?? .slideshow
        endpoint = try values.decodeIfPresent(String.self, forKey: .endpoint) ?? ""
        deviceId = try values.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        accessToken = try values.decodeIfPresent(String.self, forKey: .accessToken) ?? ""
        interval = try values.decodeIfPresent(Double.self, forKey: .interval) ?? 15
        modTags = try values.decodeIfPresent([String].self, forKey: .modTags) ?? []
        showClock = try values.decodeIfPresent(Bool.self, forKey: .showClock) ?? true
        showSensors = try values.decodeIfPresent(Bool.self, forKey: .showSensors) ?? true
        webPageURL = try values.decodeIfPresent(String.self, forKey: .webPageURL) ?? ""
        webTransparentBackground = try values.decodeIfPresent(Bool.self, forKey: .webTransparentBackground) ?? false
        webAutoRefreshInterval = try values.decodeIfPresent(Double.self, forKey: .webAutoRefreshInterval) ?? 0
        slideshow3DMode = try values.decodeIfPresent(Slideshow3DPreference.self, forKey: .slideshow3DMode) ?? .off
        useAspectRatio = try values.decodeIfPresent(Bool.self, forKey: .useAspectRatio) ?? true
        enableKenBurns = try values.decodeIfPresent(Bool.self, forKey: .enableKenBurns) ?? true
        enableDynamicBrightness = try values.decodeIfPresent(Bool.self, forKey: .enableDynamicBrightness) ?? true
        transparentBackground = try values.decodeIfPresent(Bool.self, forKey: .transparentBackground) ?? false
        textSize = try values.decodeIfPresent(Double.self, forKey: .textSize) ?? 1.0
        maxImageResolution2D = try values.decodeIfPresent(Int.self, forKey: .maxImageResolution2D)
        maxImageResolution3D = try values.decodeIfPresent(Int.self, forKey: .maxImageResolution3D)
    }

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

    func mediaURL(for post: RemotePost, record: Bool = false) -> URL? {
        guard let base = normalizedEndpoint else { return nil }
        var components = URLComponents(url: base.appending(path: "get"), resolvingAgainstBaseURL: false)
        var items = [
            URLQueryItem(name: "id", value: String(post.id)),
            URLQueryItem(name: "record", value: record ? "1" : "0"),
        ]
        if !deviceId.isEmpty { items.append(URLQueryItem(name: "deviceId", value: deviceId)) }
        if !accessToken.isEmpty { items.append(URLQueryItem(name: "token", value: accessToken)) }
        components?.queryItems = items
        return components?.url
    }

    func duplicated(named name: String) -> Self {
        var result = self
        result.id = UUID()
        result.savedDate = .now
        result.name = name
        return result
    }

    /// Mirrors `RemoteViewerConfig.webAutoRefreshOptions` — the slider snap
    /// points for "reload after this long with no interaction".
    static let webAutoRefreshOptions: [Double] = [0, 30, 60, 120, 300, 600, 1800]

    static func webAutoRefreshLabel(_ interval: Double) -> String {
        guard interval > 0 else { return "Off" }
        if interval < 60 { return "\(Int(interval))s" }
        let minutes = Int(interval) / 60
        return "\(minutes) min"
    }

    static let roboFrameRepositoryURL = URL(string: "https://github.com/illixion/RoboFrame")!
}

enum Slideshow3DPreference: String, Codable, CaseIterable, Identifiable {
    case off
    case spatial
    case pseudo3D

    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "2D"
        case .spatial: "Spatial Images"
        case .pseudo3D: "Real-Time 3D Video"
        }
    }

    /// Matches the icon set `RemoteViewerOrnamentView`'s 3D menu uses in
    /// Hypnos so the ornament reads the same at a glance.
    var systemImage: String {
        switch self {
        case .off: "view.3d"
        case .spatial: "spatial.capture.fill"
        case .pseudo3D: "move.3d"
        }
    }
}

struct RemotePost: Identifiable, Equatable, Hashable, Decodable {
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
