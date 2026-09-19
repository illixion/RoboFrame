/*
 RoboFrame Native Client - Settings Backup Import

 The "pick a settings backup and apply it" flow, ported from Hypnos's
 `SettingsBackupImport.swift`. A confirmation (RoboFrame backups replace
 profiles; Hypnos backups only add to them), a decode that can fail, a
 success acknowledgement, and the 600ms wait before presenting anything on
 top of a just-dismissed picker.

 The wait is not superstition: presenting an alert in the same runloop turn
 that dismisses `fileImporter` drops the alert entirely, and the user is left
 staring at a picker that closed and did nothing.

 Format detection: both RoboFrame's and Hypnos's backups share the same
 version/exportDate/appVersion header, so the payload is sniffed by its
 distinguishing keys (`profiles` vs `savedRemoteConfigs`/`stashServerURL`)
 rather than by trying one schema and falling back — an all-optional schema
 would otherwise "succeed" decoding the wrong format as an empty backup.
 */

import Foundation
import SwiftUI
import UniformTypeIdentifiers

private enum DetectedBackupFormat {
    case roboFrame
    case hypnos
}

@MainActor
@Observable
final class SettingsBackupImporter {

    /// Drives the file picker.
    var isPickingFile = false
    /// Drives the "this changes your settings" confirmation.
    var isConfirming = false
    /// Drives the success acknowledgement. Set alongside a summary message.
    var successMessage: String?
    /// Non-nil drives the failure alert.
    var errorMessage: String?

    /// Human-readable description of what's about to happen, shown in the
    /// confirmation alert once a file has been picked.
    private(set) var pendingDescription: String?

    private var pendingData: Data?
    private var pendingFormat: DetectedBackupFormat?

    func pickFile() {
        isPickingFile = true
    }

    /// Offers data for confirmation. `afterPickerDismissal` delays
    /// presentation so the alert is not swallowed by the closing picker.
    func offer(_ data: Data, afterPickerDismissal: Bool) {
        guard let format = Self.detectFormat(in: data) else {
            fail("This file doesn't look like a RoboFrame or Hypnos settings backup.", afterPickerDismissal: afterPickerDismissal)
            return
        }
        pendingData = data
        pendingFormat = format
        pendingDescription = format == .roboFrame
            ? "This will replace your saved profiles and device settings with the imported backup. This cannot be undone."
            : "This will add any RoboFrame server profiles found in this Hypnos backup alongside your existing profiles. Your current profiles and settings are not changed."
        present(afterPickerDismissal: afterPickerDismissal) { self.isConfirming = true }
    }

    func fail(_ message: String, afterPickerDismissal: Bool) {
        present(afterPickerDismissal: afterPickerDismissal) { self.errorMessage = message }
    }

    func discard() {
        pendingData = nil
        pendingFormat = nil
        pendingDescription = nil
    }

    /// Decodes and applies the pending backup.
    func apply(to store: ProfileStore) {
        guard let data = pendingData, let format = pendingFormat else { return }
        pendingData = nil
        pendingFormat = nil
        pendingDescription = nil
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            switch format {
            case .roboFrame:
                let backup = try decoder.decode(RoboFrameSettingsBackup.self, from: data)
                store.importBackup(backup)
                successMessage = "Settings have been restored from backup."
            case .hypnos:
                let backup = try decoder.decode(HypnosSettingsBackup.self, from: data)
                let count = store.importHypnosBackup(backup)
                successMessage = count == 1
                    ? "Imported 1 profile from the Hypnos backup."
                    : "Imported \(count) profiles from the Hypnos backup."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Picks up the newest JSON sitting in the Documents folder — the path
    /// for a backup pushed onto the device rather than picked from Files.
    func loadNewestFromDocuments() {
        let fileManager = FileManager.default
        guard let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            errorMessage = "Could not locate the Documents folder."
            return
        }
        do {
            let contents = try fileManager.contentsOfDirectory(
                at: documents,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            )
            let newest = contents
                .filter { $0.pathExtension.lowercased() == "json" }
                .max { lhs, rhs in modified(lhs) < modified(rhs) }

            guard let newest else {
                errorMessage = "No JSON files found in the Documents folder. Place a settings backup there and try again."
                return
            }
            let data = try Data(contentsOf: newest)
            offer(data, afterPickerDismissal: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Sniffs the top-level JSON keys rather than attempting a schema decode
    /// first — both backups' fields are all-optional, so a wrong-format
    /// decode would silently "succeed" as an empty backup instead of erroring.
    private static func detectFormat(in data: Data) -> DetectedBackupFormat? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if object["profiles"] != nil { return .roboFrame }
        if object["savedRemoteConfigs"] != nil || object["stashServerURL"] != nil { return .hypnos }
        return nil
    }

    private func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    private func present(afterPickerDismissal: Bool, _ action: @escaping () -> Void) {
        guard afterPickerDismissal else {
            action()
            return
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            action()
        }
    }
}

// MARK: - Presentation

private struct SettingsBackupImportModifier: ViewModifier {
    @Environment(ProfileStore.self) private var store
    let importer: SettingsBackupImporter
    let onImported: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .fileImporter(
                isPresented: Binding(get: { importer.isPickingFile },
                                     set: { importer.isPickingFile = $0 }),
                allowedContentTypes: [.json]
            ) { result in
                switch result {
                case .success(let url):
                    // startAccessing legitimately returns false for URLs that
                    // aren't security-scoped (e.g. files already in our own
                    // container) — read regardless, only balance a successful
                    // start with a stop.
                    let didAccess = url.startAccessingSecurityScopedResource()
                    defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
                    do {
                        importer.offer(try Data(contentsOf: url), afterPickerDismissal: true)
                    } catch {
                        importer.fail(error.localizedDescription, afterPickerDismissal: true)
                    }
                case .failure(let error):
                    importer.fail(error.localizedDescription, afterPickerDismissal: true)
                }
            }
            .alert("Import Settings?", isPresented: Binding(get: { importer.isConfirming },
                                                           set: { importer.isConfirming = $0 })) {
                Button("Import", role: .destructive) {
                    importer.apply(to: store)
                    if importer.successMessage != nil { onImported?() }
                }
                Button("Cancel", role: .cancel) { importer.discard() }
            } message: {
                Text(importer.pendingDescription ?? "")
            }
            .alert("Import Successful", isPresented: Binding(get: { importer.successMessage != nil },
                                                            set: { if !$0 { importer.successMessage = nil } })) {
                Button("OK") {}
            } message: {
                Text(importer.successMessage ?? "")
            }
            .alert("Import Failed", isPresented: Binding(get: { importer.errorMessage != nil },
                                                        set: { if !$0 { importer.errorMessage = nil } })) {
                Button("OK") {}
            } message: {
                Text(importer.errorMessage ?? "")
            }
    }
}

extension View {
    /// Installs the backup-import picker, confirmation and alerts.
    func settingsBackupImport(_ importer: SettingsBackupImporter,
                              onImported: (() -> Void)? = nil) -> some View {
        modifier(SettingsBackupImportModifier(importer: importer, onImported: onImported))
    }
}
