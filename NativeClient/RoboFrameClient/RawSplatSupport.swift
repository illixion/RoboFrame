/*
 RoboFrame Native Client - Raw Splat 3D support

 Raw Splat 3D is Hypnos's sideload-only RealityKit mode: the picture's 3D
 scene drawn as its raw gaussian splats (two-pass rendering off), sharp when
 seen from the side. It reaches RealityKit through private symbols, so it is
 compiled in only when the build defines `ROBOFRAME_PRIVATE_API`
 (`PRIVATE_API_CONDITION=ROBOFRAME_PRIVATE_API`, set through
 `EXTRA_BUILD_SETTINGS` in the gitignored `scripts/build-signing.conf`). Every
 other build hides the modes and reads a saved one as `.spatial`.
 */

import Foundation
#if os(visionOS)
import RealityKit
#endif

enum RawSplatSupport {
    /// Whether this build and OS can show Raw Splat 3D.
    @MainActor static var isAvailable: Bool {
        #if ROBOFRAME_PRIVATE_API && os(visionOS)
        PrivateSpatial3DTuningStore.shared.isRawSplatAvailable
        #else
        false
        #endif
    }
}

#if os(visionOS)
extension ImagePresentationComponent {
    /// Apply the sideload-only private settings if this build has them. No-op
    /// otherwise. Call right before `components.set(_:)`.
    @MainActor
    mutating func applyPrivateSpatial3DTuningIfAvailable(rawSplat: Bool) {
        #if ROBOFRAME_PRIVATE_API
        PrivateSpatial3DTuningStore.shared.apply(to: &self, rawSplat: rawSplat)
        #endif
    }
}
#endif
