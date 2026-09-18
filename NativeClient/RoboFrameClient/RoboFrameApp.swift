/*
 RoboFrame Native Client - App Entry Point

 Slimmed to the app shell + persisted profile store; the profile-manager and
 viewer UI live in `ProfileManagerView.swift` and the `*WindowView.swift`
 files (1:1 ports of Hypnos's Remote tab / Remote Viewer).
 */

import SwiftUI

@main
struct RoboFrameApp: App {
    @State private var store = ProfileStore()

    var body: some Scene {
        WindowGroup(id: "main") {
            ProfileManagerView()
                .environment(store)
        }

        #if os(visionOS)
        // Genuine independent windows so multiple slideshows/web pages can
        // run at once — visionOS only. iOS keeps the single-window
        // `.fullScreenCover` presentation in `ProfileManagerView`, since a
        // second `WindowGroup` scene has no multi-window benefit there and
        // would just add an extra way to navigate. Keyed by `SlideshowWindowValue`
        // (its own window identity plus the profile id `ViewerSceneRoot`
        // resolves live from the store) rather than by the profile id alone,
        // so Summon can recreate a fresh window instead of waiting for the
        // old scene to disconnect — see that struct's header for why.
        WindowGroup(id: "slideshow-viewer", for: SlideshowWindowValue.self) { $value in
            ViewerSceneRoot(windowValue: value)
                .environment(store)
        }
        .windowStyle(.plain)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1400, height: 900)
        .defaultLaunchBehavior(.suppressed)

        // Pop-out console, ported from Hypnos's Console window/tab.
        Window("Console", id: "console") {
            ConsoleWindowView()
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(.suppressed)
        #endif
    }
}

@MainActor @Observable
final class ProfileStore {
    private let key = "RoboFrameClient.profiles"
    var profiles: [RoboFrameProfile] = []
    var selectedID: UUID?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        if let fixture = arguments.first(where: { $0.hasPrefix("-UITestProfile=") })?.split(separator: "=", maxSplits: 1).last {
            // Fixture launches never read the real persisted store, so a UI
            // test's result can't depend on whatever earlier runs left behind
            // in the simulator's UserDefaults. "empty" starts with a clean
            // slate for tests (like creating a new profile) that don't need
            // a preset one — without it, a saved-profiles list that keeps
            // growing across repeated local test runs eventually pushes a
            // freshly created row below the fold, and the accessibility
            // query for it flakes because `List` doesn't materialize
            // off-screen rows.
            switch fixture {
            case "web":
                var profile = RoboFrameProfile()
                profile.name = "Pinned Test Page"
                profile.mode = .webPage
                profile.webPageURL = "https://example.com"
                profiles = [profile]
            case "empty":
                profiles = []
            default:
                var profile = RoboFrameProfile()
                profile.name = "Test Display"
                profile.endpoint = "https://frame.example"
                profile.deviceId = "ui-test"
                profiles = [profile]
            }
        } else {
            profiles = (try? JSONDecoder().decode([RoboFrameProfile].self, from: UserDefaults.standard.data(forKey: key) ?? Data())) ?? []
        }
        selectedID = profiles.first?.id
    }

    func save(_ profile: RoboFrameProfile) {
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index] = profile }
        else { profiles.append(profile) }
        selectedID = profile.id
        persist()
    }
    func delete(_ profile: RoboFrameProfile) { profiles.removeAll { $0.id == profile.id }; selectedID = profiles.first?.id; persist() }
    private func persist() { UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: key) }

    /// Seeds a fresh draft with device-wide defaults. `RoboFrameProfile()`
    /// already carries sensible baked-in defaults, so today this is a no-op
    /// hook — kept as the seam Hypnos's `applySlideshowDefaults` occupies, in
    /// case a device-wide "new profile" preset is added later.
    func applyDefaults(to profile: inout RoboFrameProfile) {}
}
