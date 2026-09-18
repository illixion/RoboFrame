/*
 RoboFrame Native Client - Viewer Scene Root

 visionOS-only. Backs the "slideshow-viewer" `WindowGroup(for:
 SlideshowWindowValue.self)` scene added so multiple slideshow/web-page
 windows can be open at once — mirrors Hypnos's `RemoteViewerSceneRoot`,
 which resolves a launched window's profile by id from the shared store
 rather than carrying the profile value itself through the scene. Resolving
 by id (instead of making `RoboFrameProfile` the scene's `Codable` payload)
 means an ornament-driven edit to the profile is picked up live in the open
 window, the same as it is in `ProfileManagerView`'s own `.fullScreenCover`
 path.

 Both launch paths in `ProfileManagerView` (a saved row's Launch button, and
 the bottom draft's `launchDraft()`, which always saves first) guarantee the
 profile already exists in `ProfileStore.profiles` by the time this scene
 opens, so the only "not found" case is the profile being deleted from
 another window afterward.
 */

import RAVEUI
import SwiftUI

struct ViewerSceneRoot: View {
    @Environment(ProfileStore.self) private var store
    let windowValue: SlideshowWindowValue?

    private var profile: RoboFrameProfile? {
        guard let profileID = windowValue?.profileID else { return nil }
        return store.profiles.first { $0.id == profileID }
    }

    var body: some View {
        // Resolved per body evaluation (not cached) so a profile edited or
        // deleted elsewhere is reflected immediately in this window.
        if let windowValue, let profile {
            ViewerDestination(profile: profile, onConfigChanged: store.save)
                #if os(visionOS)
                .manageWindow(ManagedWindows.slideshowViewer(windowValue, profile: profile))
                #endif
        } else {
            ContentUnavailableView(
                "Profile No Longer Exists",
                systemImage: "questionmark.folder",
                description: Text("This profile was deleted. Close this window and launch it again from RoboFrame.")
            )
        }
    }
}
