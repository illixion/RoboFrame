/*
 RoboFrame Native Client - Settings Backup

 Codable backup container for the client's own settings (profiles, device-wide
 defaults, mod tag presets) plus a lightweight FileDocument wrapper for
 SwiftUI fileExporter/fileImporter. Mirrors Hypnos's `SettingsBackup` shape —
 same top-level version/exportDate/appVersion header, same all-optional
 fields so an older or newer backup still decodes.
 */

import SwiftUI
import UniformTypeIdentifiers

// MARK: - Backup Data Model

struct RoboFrameSettingsBackup: Codable {
    /// Schema version — increment when fields change semantics or type.
    let version: Int
    let exportDate: Date
    let appVersion: String

    /// The full saved-profile list. Wholesale-replaced on import, matching
    /// Hypnos's `savedRemoteConfigs` restore behavior — a settings restore is
    /// expected to put the device back exactly as the backup describes it.
    var profiles: [RoboFrameProfile]?

    // Device-wide defaults (AppSettings)
    var defaultMaxImageResolution2D: Int?
    var defaultMaxImageResolution3D: Int?
    var globalVisualAdjustments: Data?

    // Mod tag presets (ModTagManager) — device-wide, not per-profile.
    var modTagLists: [[String]]?
    var modTagDefaultIndex: Int?
    var modTagLastActiveIndex: Int?

    static let currentVersion = 1
}

// MARK: - FileDocument Wrapper

struct RoboFrameSettingsBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
