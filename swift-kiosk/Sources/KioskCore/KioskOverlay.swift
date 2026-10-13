/*
 Overlay text

 What the kiosk draws over the slideshow, as plain strings, so every
 renderer shows the same thing and the formatting tests without a screen:
 the clock (bottom left), the date (bottom right), Home Assistant sensors
 (top right) and short toasts confirming a key press (top right, above the
 sensors). Matches native-kiosk and the web kiosk's sensors.js. A status
 line (offline, or a banner the session raised) sits top left.
 */

import Foundation
import RAVERoboFrame
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

public enum KioskOverlay {
    /// Words in a sensor's friendly name drawn as an emoji instead.
    static let sensorEmoji: [(word: String, emoji: String)] = [
        ("Temperature", "🌡️"),
        ("Humidity", "💧"),
        ("Atmospheric pressure", "🌬️"),
    ]

    /// One line per sensor, sorted by name. A sensor that went unavailable
    /// keeps its last value behind a warning mark.
    public static func sensorLines(_ sensors: some Collection<RoboFrameSensorReading>) -> [String] {
        sensors
            .sorted { sortKey($0.friendlyName) < sortKey($1.friendlyName) }
            .map { reading in
                var name = reading.friendlyName
                for (word, emoji) in sensorEmoji { name = name.replacingOccurrences(of: word, with: emoji) }
                let value = reading.state.isEmpty ? "N/A" : reading.state + reading.unit
                return (reading.isUnavailable ? "❗ " : "") + "\(name): \(value)"
            }
    }

    /// Sorting ignores everything outside printable ASCII, so a name that
    /// starts with an emoji sorts by its words.
    private static func sortKey(_ name: String) -> String {
        String(name.unicodeScalars.filter { $0.value >= 32 && $0.value < 127 })
    }

    /// The clock and date lines in local time: `14:05:09` (or `14:05`) and `Mon, Oct 12`.
    public static func clock(_ date: Date = Date(), seconds showSeconds: Bool = true) -> (time: String, date: String) {
        var seconds = time_t(date.timeIntervalSince1970)
        var parts = tm()
        localtime_r(&seconds, &parts)
        return (format(showSeconds ? "%H:%M:%S" : "%H:%M", parts), format("%a, %b %-d", parts))
    }

    /// The top-left status line: a banner wins over being offline.
    @MainActor
    public static func status(_ session: KioskSession) -> String? {
        if let banner = session.banner { return "⚠️ " + banner.text }
        return session.isOffline ? "⚠️ Offline, reconnecting…" : nil
    }

    private static func format(_ pattern: String, _ parts: tm) -> String {
        var parts = parts
        var buffer = [CChar](repeating: 0, count: 64)
        let count = strftime(&buffer, buffer.count, pattern, &parts)
        return String(decoding: buffer.prefix(count).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}

/// Short-lived confirmations, newest last, at most `limit` at a time.
public struct KioskToasts: Sendable {
    public struct Toast: Equatable, Sendable {
        public let id: Int
        public let text: String
        /// A small JPEG shown beside the text (the save confirmation's preview).
        public let thumbnail: Data?
        public let created: TimeInterval
        public let expires: TimeInterval

        /// Fades in and slides down as it arrives, fades out before it goes,
        /// like the web kiosk's toasts: opacity and a 0...1 offset.
        public func appearance(now: TimeInterval) -> (alpha: Double, drop: Double) {
            let arriving = min(1, max(0, (now - created) / KioskToasts.fade))
            let leaving = min(1, max(0, (expires - now) / KioskToasts.fade))
            let easedIn = KioskKenBurns.eased(arriving)
            return (min(easedIn, KioskKenBurns.eased(leaving)), 1 - easedIn)
        }

        public func isAnimating(now: TimeInterval) -> Bool {
            now - created < KioskToasts.fade || expires - now < KioskToasts.fade
        }
    }

    public static let duration: TimeInterval = 3
    public static let fade: TimeInterval = 0.3
    public static let limit = 4

    public private(set) var all: [Toast] = []
    private var nextID = 0

    public init() {}

    public mutating func add(_ text: String, thumbnail: Data? = nil, now: TimeInterval) {
        nextID += 1
        all.append(Toast(id: nextID, text: text, thumbnail: thumbnail, created: now, expires: now + Self.duration))
        if all.count > Self.limit { all.removeFirst(all.count - Self.limit) }
    }

    /// Drops expired toasts; true when the list changed.
    @discardableResult
    public mutating func expire(now: TimeInterval) -> Bool {
        let before = all.count
        all.removeAll { $0.expires <= now }
        return all.count != before
    }
}
