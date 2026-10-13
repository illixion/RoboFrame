/*
 Kiosk settings

 The settings file the on-screen menu writes (KioskConfig says where it is
 and why it wins over the config file), and the night-light window.

 The file is a flat JSON object under the `kiosk` block's key names, so a
 hand-edited config and a menu-saved setting mean the same thing. Writes go
 to a temporary file renamed over the old one, so a power cut mid-write
 leaves the previous settings rather than half a file.
 */

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

public final class KioskSettingsStore {
    public let path: String?
    private(set) var values: [String: JSONValue]

    public init(path: String?) {
        self.path = path
        values = Self.read(path: path)
    }

    static func read(path: String?) -> [String: JSONValue] {
        guard let path, let data = FileManager.default.contents(atPath: path),
              let values = try? JSONDecoder().decode([String: JSONValue].self, from: data) else { return [:] }
        return values
    }

    /// Saves one setting; false when the file couldn't be written (the
    /// change still applies until the kiosk restarts).
    @discardableResult
    func set(_ key: String, _ value: JSONValue) -> Bool {
        values[key] = value
        return write()
    }

    /// Forgets every saved setting, so the config file applies again.
    @discardableResult
    public func removeAll() -> Bool {
        values = [:]
        guard let path else { return true }
        return (try? FileManager.default.removeItem(atPath: path)) != nil || !FileManager.default.fileExists(atPath: path)
    }

    public var isEmpty: Bool { values.isEmpty }

    private func write() -> Bool {
        guard let path else { return false }
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp")
            try encoder.encode(values).write(to: temporary)
            guard rename(temporary.path, path) == 0 else { return false }
            return true
        } catch {
            return false
        }
    }
}

/// A daily clock window, `22:00` to `07:00`, that may wrap past midnight.
public struct KioskNightLight: Equatable, Sendable {
    /// Minutes after midnight.
    public let start: Int
    public let end: Int

    public init?(start: Int, end: Int) {
        guard (0..<1440).contains(start), (0..<1440).contains(end), start != end else { return nil }
        self.start = start
        self.end = end
    }

    /// `HH:MM` strings; nil when either is missing or malformed, or they match.
    public init?(start: String?, end: String?) {
        guard let start = start.flatMap(Self.minutes), let end = end.flatMap(Self.minutes) else { return nil }
        self.init(start: start, end: end)
    }

    static func minutes(_ text: String) -> Int? {
        let parts = text.trimmingCharacters(in: .whitespaces).split(separator: ":")
        guard parts.count == 2, let hours = Int(parts[0]), let minutes = Int(parts[1]),
              (0..<24).contains(hours), (0..<60).contains(minutes), parts[1].count == 2 else { return nil }
        return hours * 60 + minutes
    }

    public func isActive(atMinute minute: Int) -> Bool {
        start < end ? (start..<end).contains(minute) : minute >= start || minute < end
    }

    public func isActive(at date: Date = Date()) -> Bool {
        isActive(atMinute: Self.localMinute(date))
    }

    static func localMinute(_ date: Date) -> Int {
        var seconds = time_t(date.timeIntervalSince1970)
        var parts = tm()
        localtime_r(&seconds, &parts)
        return Int(parts.tm_hour) * 60 + Int(parts.tm_min)
    }

    public static func format(_ minutes: Int) -> String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    public var startText: String { Self.format(start) }
    public var endText: String { Self.format(end) }
    public var label: String { "\(startText)–\(endText)" }

    /// The menu's choices.
    public static let presets: [KioskNightLight] = [
        (20, 7), (21, 7), (22, 6), (22, 7), (23, 7), (0, 7),
    ].compactMap { KioskNightLight(start: $0.0 * 60, end: $0.1 * 60) }
}
