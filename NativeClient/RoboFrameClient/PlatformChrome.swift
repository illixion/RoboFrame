/*
 RoboFrame Native Client - Platform Chrome

 Cross-platform "floating glass bar" background, matching Hypnos's
 `PlatformShims.glassBackgroundEffect()`: native `.glassBackgroundEffect()` on
 visionOS (an ornament/window material only that platform provides),
 `.glassEffect` on iOS 26+, and a `.ultraThinMaterial` fallback below that.
 */

import SwiftUI

extension View {
    @ViewBuilder
    func chromeBackground(cornerRadius: CGFloat = 20) -> some View {
        #if os(visionOS)
        self.glassBackgroundEffect(in: .rect(cornerRadius: cornerRadius))
        #else
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            self.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        #endif
    }
}

/// How long the ornaments stay visible with no interaction before
/// auto-hiding. Mirrors `AppModel.autoHideDelay` in Hypnos; RoboFrame has no
/// Settings screen for this yet, so it's a fixed constant rather than a
/// per-device preference.
enum ChromeAutoHide {
    static let delay: TimeInterval = 8
}
