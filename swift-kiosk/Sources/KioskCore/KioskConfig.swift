/*
 Kiosk configuration

 Read from `roboframe.config.json` (path in ROBOFRAME_CONFIG): the top-level
 `accessToken` and `deviceId`, and the `kiosk` block native-kiosk already
 uses, so one config drives either frontend. Environment variables override
 the file, under native-kiosk's names.

 What the on-screen settings menu changes is saved apart from both, in the
 settings file (`KIOSK_SETTINGS`, or `kiosk.settingsPath`), and wins over
 them: the launcher's config and environment are fixed, and a choice made
 at the frame has to survive a restart. The file holds only the keys the
 menu touched, under the `kiosk` block's names.
 */

import Foundation

public struct KioskConfig: Equatable, Sendable {
    public var webSocketURL: URL
    public var accessToken: String
    public var deviceId: String
    /// Dwell time in milliseconds.
    public var intervalMs: Int
    public var modTags: [String]
    /// Dim every frame (`bright=1` on `/get`).
    public var bright: Bool
    /// Ask for JPEG re-encodes of every source, not just JXL.
    public var lowmem: Bool
    /// Advertise the screen's aspect ratio so the server prefers matching posts.
    public var ratioFilter: Bool
    /// Compose every frame onto a screen-sized canvas server-side. Forces the
    /// ratio filter on, which is what keeps the crop small.
    public var wallpaper: Bool
    /// A video post's transcode (`h264`), or nil for the raw file.
    public var vcodec: String?
    /// Cap on the transcode's height: a Pi 3 decodes 720p30 with headroom
    /// but 1080p only at about realtime.
    public var videoMaxHeight: Int
    /// mpv's `hwdec`: `v4l2m2m-copy` on a Pi under X11, `no` for software.
    public var hwdec: String
    /// The largest `/get` response accepted for a still.
    public var maxMediaBytes: Int
    /// Crossfade length between frames, in seconds.
    public var transitionDuration: TimeInterval
    /// The screen size frames are requested at. The renderer overrides it
    /// with the real display mode when it has one.
    public var screenWidth: Int
    public var screenHeight: Int

    // Look and overlay. Everything below is what the settings menu edits.

    /// A slow zoom towards the photo's busiest part over each dwell, like the web kiosk.
    public var kenBurns: Bool
    public var fit: Fit
    /// Fill the bars beside a letterboxed photo with a blurred copy of it.
    public var blurBackground: Bool
    /// The slideshow's own brightness, 10-100 %; the overlay stays at full.
    public var brightness: Int
    public var showClock: Bool
    public var showSeconds: Bool
    public var showDate: Bool
    public var showSensors: Bool
    /// `bright` follows this clock window as well (the web kiosk's night light).
    public var nightLight: KioskNightLight?
    /// Where the menu's choices are saved; nil keeps them for this run only.
    public var settingsPath: String?

    public enum Fit: String, Sendable, CaseIterable {
        /// The whole photo, centred, bars beside it.
        case contain
        /// The screen filled edge to edge, the photo's overflow cropped.
        case cover
    }

    public init(
        webSocketURL: URL,
        accessToken: String,
        deviceId: String = "screen1",
        intervalMs: Int = 15_000,
        modTags: [String] = [],
        bright: Bool = false,
        lowmem: Bool = true,
        ratioFilter: Bool = true,
        wallpaper: Bool = false,
        vcodec: String? = "h264",
        videoMaxHeight: Int = 720,
        hwdec: String = "no",
        maxMediaBytes: Int = 64 * 1024 * 1024,
        transitionDuration: TimeInterval = 1,
        screenWidth: Int = 1920,
        screenHeight: Int = 1080,
        kenBurns: Bool = true,
        fit: Fit = .contain,
        blurBackground: Bool = true,
        brightness: Int = 100,
        showClock: Bool = true,
        showSeconds: Bool = true,
        showDate: Bool = true,
        showSensors: Bool = true,
        nightLight: KioskNightLight? = nil,
        settingsPath: String? = nil
    ) {
        self.webSocketURL = webSocketURL
        self.accessToken = accessToken
        self.deviceId = deviceId
        self.intervalMs = intervalMs
        self.modTags = modTags
        self.bright = bright
        self.lowmem = lowmem
        self.ratioFilter = ratioFilter || wallpaper
        self.wallpaper = wallpaper
        self.vcodec = vcodec
        self.videoMaxHeight = videoMaxHeight
        self.hwdec = hwdec
        self.maxMediaBytes = maxMediaBytes
        self.transitionDuration = transitionDuration
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.kenBurns = kenBurns
        self.fit = fit
        self.blurBackground = blurBackground
        self.brightness = Self.clampBrightness(brightness)
        self.showClock = showClock
        self.showSeconds = showSeconds
        self.showDate = showDate
        self.showSensors = showSensors
        self.nightLight = nightLight
        self.settingsPath = settingsPath
    }

    static func clampBrightness(_ value: Int) -> Int { min(100, max(10, value)) }

    public enum LoadError: Error, CustomStringConvertible {
        case unreadable(String)
        case missingToken
        case badWebSocketURL

        public var description: String {
            switch self {
            case .unreadable(let detail): "can't read the config file: \(detail)"
            case .missingToken: "an access token is required (top-level accessToken, or ACCESS_TOKEN)"
            case .badWebSocketURL: "the WebSocket URL isn't a ws:// or wss:// URL"
            }
        }
    }

    /// Load from the file at `path` (if any), then apply `environment`.
    public static func load(path: String?, environment: [String: String]) throws -> KioskConfig {
        var root: [String: JSONValue] = [:]
        if let path, FileManager.default.fileExists(atPath: path) {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                root = try JSONDecoder().decode([String: JSONValue].self, from: data)
            } catch {
                throw LoadError.unreadable(String(describing: error))
            }
        }
        let kiosk = root["kiosk"]?.object ?? [:]
        let display = root["display"]?.object ?? [:]
        let settingsPath = environment["KIOSK_SETTINGS"].flatMap { $0.isEmpty ? nil : $0 }
            ?? kiosk["settingsPath"]?.string
            ?? Self.defaultSettingsPath(environment)
        let settings = KioskSettingsStore.read(path: settingsPath)

        func usable(_ value: JSONValue?) -> JSONValue? {
            guard let value, value != .null, value != .string("") else { return nil }
            return value
        }
        /// The menu's saved value, then the environment, then the file.
        func pick(_ env: String, _ values: JSONValue?...) -> JSONValue? {
            if let value = environment[env], !value.isEmpty { return .string(value) }
            return values.lazy.compactMap(usable).first
        }
        func setting(_ key: String, env: String) -> JSONValue? {
            usable(settings[key]) ?? pick(env, kiosk[key])
        }

        let socket = pick("WS_URL", kiosk["wsUrl"], display["wsUrl"])?.string ?? "ws://localhost:3123/rpc/ws"
        guard let webSocketURL = URL(string: socket), ["ws", "wss"].contains(webSocketURL.scheme) else {
            throw LoadError.badWebSocketURL
        }
        guard let token = pick("ACCESS_TOKEN", root["accessToken"])?.string, !token.isEmpty else {
            throw LoadError.missingToken
        }
        var modTags = kiosk["modTags"]?.array?.compactMap(\.string) ?? []
        if let tags = environment["MOD_TAGS"], !tags.isEmpty {
            modTags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        var vcodec = pick("VCODEC", kiosk["vcodec"])?.string ?? "h264"
        if ["", "0", "no", "none", "off"].contains(vcodec.lowercased()) { vcodec = "" }
        let size = environment["SCREEN_SIZE"].flatMap(Self.parseSize)

        return KioskConfig(
            webSocketURL: webSocketURL,
            accessToken: token,
            deviceId: pick("DEVICE_ID", root["deviceId"])?.string ?? "screen1",
            intervalMs: max(2_000, setting("interval", env: "INTERVAL")?.int ?? 15_000),
            modTags: modTags,
            bright: setting("bright", env: "BRIGHT")?.bool ?? false,
            lowmem: pick("LOWMEM", kiosk["lowmem"])?.bool ?? true,
            ratioFilter: pick("RATIO_FILTER", kiosk["ratioFilter"])?.bool ?? true,
            wallpaper: pick("WALLPAPER", kiosk["wallpaper"])?.bool ?? false,
            vcodec: vcodec.isEmpty ? nil : vcodec,
            videoMaxHeight: pick("VIDEO_MAX_HEIGHT", kiosk["videoMaxHeight"])?.int ?? 720,
            hwdec: pick("HWDEC", kiosk["hwdec"])?.string ?? "no",
            maxMediaBytes: pick("MAX_MEDIA_BYTES", kiosk["maxMediaBytes"])?.int ?? 64 * 1024 * 1024,
            transitionDuration: Double(max(0, setting("transitionMs", env: "TRANSITION_MS")?.int ?? 1_000)) / 1_000,
            screenWidth: size?.width ?? 1920,
            screenHeight: size?.height ?? 1080,
            kenBurns: setting("kenBurns", env: "KEN_BURNS")?.bool ?? true,
            fit: setting("fit", env: "FIT")?.string.flatMap { Fit(rawValue: $0.lowercased()) } ?? .contain,
            blurBackground: setting("blurBackground", env: "BLUR_BACKGROUND")?.bool ?? true,
            brightness: setting("brightness", env: "BRIGHTNESS")?.int ?? 100,
            showClock: setting("clock", env: "CLOCK")?.bool ?? true,
            showSeconds: setting("clockSeconds", env: "CLOCK_SECONDS")?.bool ?? true,
            showDate: setting("date", env: "DATE")?.bool ?? true,
            showSensors: setting("sensors", env: "SENSORS")?.bool ?? true,
            nightLight: KioskNightLight(
                start: setting("nightLightStart", env: "NIGHT_LIGHT_START")?.string,
                end: setting("nightLightEnd", env: "NIGHT_LIGHT_END")?.string
            ),
            settingsPath: settingsPath
        )
    }

    /// `$XDG_CONFIG_HOME/roboframe-kiosk/settings.json`, else under `~/.config`.
    static func defaultSettingsPath(_ environment: [String: String]) -> String? {
        if let config = environment["XDG_CONFIG_HOME"], !config.isEmpty { return config + "/roboframe-kiosk/settings.json" }
        guard let home = environment["HOME"], !home.isEmpty else { return nil }
        return home + "/.config/roboframe-kiosk/settings.json"
    }

    /// `1920x1080`.
    static func parseSize(_ text: String) -> (width: Int, height: Int)? {
        let parts = text.lowercased().split(separator: "x").compactMap { Int($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return nil }
        return (parts[0], parts[1])
    }
}

/// Just enough JSON to read a hand-edited config: values come back as
/// whatever type the reader asks for, the way native-kiosk's Python reads them
/// (`"1"`, `1` and `true` are all true).
enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let bool = try? value.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? value.decode(Double.self) {
            self = .number(number)
        } else if let string = try? value.decode(String.self) {
            self = .string(string)
        } else if let array = try? value.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try value.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var string: String? {
        switch self {
        case .string(let value): value
        case .number(let value): value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): String(value)
        default: nil
        }
    }

    var int: Int? {
        switch self {
        case .number(let value): value.isFinite ? Int(value) : nil
        case .string(let value): Int(value.trimmingCharacters(in: .whitespaces))
        default: nil
        }
    }

    var bool: Bool? {
        switch self {
        case .bool(let value): value
        case .number(let value): value != 0
        case .string(let value): ["1", "true", "yes", "on"].contains(value.lowercased())
        default: nil
        }
    }

    var array: [JSONValue]? {
        if case .array(let value) = self { value } else { nil }
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { value } else { nil }
    }
}
