/*
 RoboFrame Native Client - Visual Adjustments

 Port of Hypnos's `VisualAdjustments`, trimmed to the fields the slideshow
 ornament's Adjustments popover actually drives (brightness/contrast/
 saturation/opacity) — auto-enhance, sharpen, and the RealityKit "Distance"
 sliders are photo-viewer-specific and don't apply to a generic slideshow
 surface fed from `RAVESlideshowVisualSettings`.
 */

import Foundation
import RAVESlideshow

struct VisualAdjustments: Codable, Equatable {
    var brightness: Double = 0.0
    var contrast: Double = 1.0
    var saturation: Double = 1.0
    var opacity: Double = 1.0

    init() {}

    init(brightness: Double = 0.0, contrast: Double = 1.0, saturation: Double = 1.0, opacity: Double = 1.0) {
        self.brightness = brightness
        self.contrast = contrast
        self.saturation = saturation
        self.opacity = opacity
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        brightness = try container.decodeIfPresent(Double.self, forKey: .brightness) ?? 0.0
        contrast = try container.decodeIfPresent(Double.self, forKey: .contrast) ?? 1.0
        saturation = try container.decodeIfPresent(Double.self, forKey: .saturation) ?? 1.0
        opacity = try container.decodeIfPresent(Double.self, forKey: .opacity) ?? 1.0
    }

    private enum CodingKeys: String, CodingKey {
        case brightness, contrast, saturation, opacity
    }

    var isModified: Bool {
        brightness != 0.0 || contrast != 1.0 || saturation != 1.0 || opacity != 1.0
    }

    mutating func reset() {
        brightness = 0.0
        contrast = 1.0
        saturation = 1.0
        opacity = 1.0
    }

    var slideshowVisualSettings: RAVESlideshowVisualSettings {
        RAVESlideshowVisualSettings(brightness: brightness, contrast: contrast, saturation: saturation, opacity: opacity)
    }
}
