/*
 RoboFrame Native Client - Slideshow Viewer Window Value

 The "slideshow-viewer" `WindowGroup` scene's payload. Carries its own `id`
 separate from `profileID` so a summoned window can be recreated under a
 fresh identity (mirrors Hypnos's `RemoteViewerWindowValue`) — without a
 separable identity, RAVEUI's window manager can't issue the dismiss and the
 reopen together, and Summon has to wait out the old scene's teardown instead
 (still correct, just slower and momentarily blank).
 */

import Foundation
import RAVEUI

struct SlideshowWindowValue: Identifiable, Codable, Hashable {
    let id: UUID
    let profileID: UUID

    init(profileID: UUID) {
        self.id = UUID()
        self.profileID = profileID
    }
}

#if os(visionOS)
extension SlideshowWindowValue {
    /// Same profile under a fresh window identity.
    func recreated() -> SlideshowWindowValue {
        SlideshowWindowValue(profileID: profileID)
    }
}
#endif
