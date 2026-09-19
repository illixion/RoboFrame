/*
 RoboFrame Native Client - Hypnos Settings Backup Migration

 Hypnos and this client share a lineage: RoboFrame's native app is a 1:1 port
 of Hypnos's Remote tab / Remote Viewer UI, and `RoboFrameProfile` is a direct
 descendant of Hypnos's `RemoteViewerConfig`. A user moving from Hypnos to
 RoboFrame (or just running both) shouldn't have to retype every server URL,
 device ID and token by hand.

 This is a decode-only mirror of the slideshow-relevant subset of Hypnos's
 `SettingsBackup`/`RemoteViewerConfig` JSON shape (see
 Hypnos/Hypnos/Model/SettingsBackup.swift and RemoteViewerConfig.swift). It has
 no dependency on Hypnos's source — every field is optional so it tolerates
 schema drift on either side — and it only carries what has a RoboFrame
 equivalent. Hypnos-only concerns (AR/passthrough, stereo rendering, depth
 models, gallery windows, image-enhancement trackers) have no counterpart here
 and are intentionally not modeled.
 */

import Foundation

struct HypnosSettingsBackup: Decodable {
    var stashServerURL: String?
    var stashAPIKey: String?
    var slideshowDelay: Double?
    var slideshowShowClock: Bool?
    var slideshowShowSensors: Bool?
    var slideshowUseAspectRatio: Bool?
    var slideshowEnableKenBurns: Bool?
    var slideshowEnableDynamicBrightness: Bool?
    var slideshowTransparentBackground: Bool?
    var slideshowTextSize: Double?
    var slideshowMaxImageResolution2D: Int?
    var slideshowMaxImageResolution3D: Int?
    /// Device-wide 2D/3D resolution defaults — map onto `AppSettings`.
    var maxImageResolution: Int?
    var spatial3DMaxResolution: Int?
    var savedRemoteConfigs: [HypnosRemoteViewerConfig]?
}

struct HypnosRemoteViewerConfig: Decodable {
    var id: UUID?
    var name: String?
    var savedDate: Date?
    /// "slideshow" / "webPage" / "appGallery" — `.appGallery` has no
    /// RoboFrame counterpart (it plays whatever Hypnos's main window was
    /// showing) and is skipped at conversion time.
    var mode: String?
    var apiEndpoint: String?
    var wsDeviceId: String?
    var accessToken: String?
    var delay: Double?
    var showClock: Bool?
    var showSensors: Bool?
    var useAspectRatio: Bool?
    var enableKenBurns: Bool?
    var enableDynamicBrightness: Bool?
    var transparentBackground: Bool?
    var textSize: Double?
    /// "off" / "spatial3D" / "immersive3D"
    var slideshow3DMode: String?
    var maxImageResolution2D: Int?
    var maxImageResolution3D: Int?
    var webPageURL: String?
    var webTransparentBackground: Bool?
    var webAutoRefreshInterval: Double?
}

extension HypnosRemoteViewerConfig {
    /// Converts one Hypnos profile into a RoboFrame one, or nil for a mode
    /// RoboFrame has no equivalent for (`appGallery`).
    func asRoboFrameProfile() -> RoboFrameProfile? {
        var profile = RoboFrameProfile()
        switch mode {
        case "webPage": profile.mode = .webPage
        case "appGallery": return nil
        default: profile.mode = .slideshow
        }
        if let name { profile.name = name }
        if let apiEndpoint { profile.endpoint = apiEndpoint }
        if let wsDeviceId { profile.deviceId = wsDeviceId }
        if let accessToken { profile.accessToken = accessToken }
        if let delay { profile.interval = delay }
        if let showClock { profile.showClock = showClock }
        if let showSensors { profile.showSensors = showSensors }
        if let useAspectRatio { profile.useAspectRatio = useAspectRatio }
        if let enableKenBurns { profile.enableKenBurns = enableKenBurns }
        if let enableDynamicBrightness { profile.enableDynamicBrightness = enableDynamicBrightness }
        if let transparentBackground { profile.transparentBackground = transparentBackground }
        if let textSize { profile.textSize = textSize }
        switch slideshow3DMode {
        case "spatial3D": profile.slideshow3DMode = .spatial
        case "immersive3D": profile.slideshow3DMode = .pseudo3D
        default: profile.slideshow3DMode = .off
        }
        profile.maxImageResolution2D = maxImageResolution2D
        profile.maxImageResolution3D = maxImageResolution3D
        if let webPageURL { profile.webPageURL = webPageURL }
        if let webTransparentBackground { profile.webTransparentBackground = webTransparentBackground }
        if let webAutoRefreshInterval { profile.webAutoRefreshInterval = webAutoRefreshInterval }
        return profile
    }
}

extension HypnosSettingsBackup {
    /// Every convertible saved profile, as new RoboFrame profiles (fresh IDs —
    /// these are additions alongside whatever RoboFrame already has, not a
    /// replacement).
    var convertedProfiles: [RoboFrameProfile] {
        savedRemoteConfigs?.compactMap { $0.asRoboFrameProfile() } ?? []
    }
}
