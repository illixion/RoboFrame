/*
 RoboFrame Native Client - App Settings

 Device-wide defaults every profile falls back to when it doesn't override a
 setting itself: the global visual-adjustments baseline (Adjustments
 popover's "Global" tab) and the default slideshow resolution caps
 (`RoboFrameProfile.maxImageResolution2D/3D == nil`). Mirrors the handful of
 device-wide fields Hypnos keeps on `AppModel` rather than per-profile.
 */

import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    static let shared = AppSettings()

    var globalVisualAdjustments: VisualAdjustments {
        didSet { saveAdjustments() }
    }

    /// 0 = no cap (native resolution).
    var defaultMaxImageResolution2D: Int {
        didSet { UserDefaults.standard.set(defaultMaxImageResolution2D, forKey: Self.res2DKey) }
    }
    var defaultMaxImageResolution3D: Int {
        didSet { UserDefaults.standard.set(defaultMaxImageResolution3D, forKey: Self.res3DKey) }
    }

    /// Mirrors `AppModel.maxImageResolutionOptions` (value 0 = Off / no limit).
    static let maxImageResolutionOptions: [(label: String, value: Int)] = [
        ("480px", 480),
        ("640px", 640),
        ("960px", 960),
        ("1280px", 1280),
        ("1600px", 1600),
        ("2048px", 2048),
        ("2560px", 2560),
        ("3200px", 3200),
        ("4096px", 4096),
        ("Off", 0),
    ]

    private static let adjustmentsKey = "AppSettings.globalVisualAdjustments"
    private static let res2DKey = "AppSettings.defaultMaxImageResolution2D"
    private static let res3DKey = "AppSettings.defaultMaxImageResolution3D"

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.adjustmentsKey),
           let decoded = try? JSONDecoder().decode(VisualAdjustments.self, from: data) {
            globalVisualAdjustments = decoded
        } else {
            globalVisualAdjustments = VisualAdjustments()
        }
        let defaults = UserDefaults.standard
        defaultMaxImageResolution2D = defaults.object(forKey: Self.res2DKey) != nil ? defaults.integer(forKey: Self.res2DKey) : 4096
        defaultMaxImageResolution3D = defaults.object(forKey: Self.res3DKey) != nil ? defaults.integer(forKey: Self.res3DKey) : 2048
    }

    private func saveAdjustments() {
        if let data = try? JSONEncoder().encode(globalVisualAdjustments) {
            UserDefaults.standard.set(data, forKey: Self.adjustmentsKey)
        }
    }
}
