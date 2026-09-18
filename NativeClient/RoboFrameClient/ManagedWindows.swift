/*
 RoboFrame Native Client - Managed Window Descriptors

 Describes each of the app's scenes to RAVEUI's window manager (see
 Hypnos's `ManagedWindows.swift`, which this mirrors): what it is called in
 the window inventory, and how to recreate it. The registry, the summon
 mechanics and the manager UI all live in RAVEUI; this file is only the app's
 half — its labels and its fresh-identity clones.
 */

import Foundation
import RAVEUI

#if os(visionOS)

enum ManagedWindows {
    /// The profile-manager window. Plain `WindowGroup` with no payload, so
    /// there is nothing to clone — recreate simply reopens the same scene id.
    @MainActor
    static func main() -> RAVEManagedWindow {
        .singleton(id: "main", label: RAVEWindowLabel(title: "RoboFrame", systemImage: "list.bullet"))
    }

    /// A slideshow/web-page viewer window, keyed by its own window identity
    /// (see `SlideshowWindowValue`) rather than the profile id, so Summon can
    /// recreate it without waiting for the old scene to disconnect first.
    @MainActor
    static func slideshowViewer(_ value: SlideshowWindowValue, profile: RoboFrameProfile?) -> RAVEManagedWindow {
        .value(
            id: "slideshow-viewer",
            value,
            label: RAVEWindowLabel(
                title: profile?.name ?? "Viewer",
                subtitle: profile.map { $0.mode == .webPage ? $0.webPageURL : $0.endpoint },
                systemImage: profile?.mode == .webPage ? "globe" : "photo.stack"
            ),
            recreate: { $0.recreated() }
        )
    }

    @MainActor
    static func console() -> RAVEManagedWindow {
        .singleton(id: "console", label: RAVEWindowLabel(title: "Console", systemImage: "terminal"))
    }
}

#endif
