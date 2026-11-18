/*
 RoboFrame Native Client - Raw Splat 3D slideshow still

 A slideshow picture as RealityKit's `ImagePresentationComponent` with
 two-pass rendering off (Hypnos's Raw Splat 3D, `PrivateSpatial3DTuning`).
 Sideload builds only: `RawSplatSupport.isAvailable` gates every use.

 The slideshow behaviour follows Hypnos's:
 - the next picture's scene is generated while the current one is on screen
   (`RawSplatSceneCache`, fed from the engine's peeked next item), so it
   arrives finished instead of restarting the conversion animation;
 - a mode change rebuilds the component (a stock component can't become a
   raw one) and every later picture is built the same way, so the slideshow
   keeps converting;
 - Distance scales the picture and a raw splat's depth, the same for every
   picture, and the window-size calibration nudge is never used: it exists
   for two-pass's blur and glitches a splat.
 RealityKit ignores SwiftUI opacity, so the crossfade is an
 `OpacityComponent` on every entity under the picture.
 */

#if os(visionOS)

import CoreImage
import DebugTrace
import ImageIO
import RAVESlideshow
import RealityKit
import SwiftUI

/// `Spatial3DImage` isn't `Sendable`; every use here is on the main actor, so
/// a task may hand it back.
struct SplatScene: @unchecked Sendable {
    let image: ImagePresentationComponent.Spatial3DImage
}

/// Generated `Spatial3DImage`s by picture and adjustments, built ahead of
/// the picture's turn. Small: a slideshow passes through far too much to
/// keep more.
@MainActor
final class RawSplatSceneCache {
    static let shared = RawSplatSceneCache()
    private static let capacity = 4

    private var scenes: [String: Task<SplatScene?, Never>] = [:]
    private var order: [String] = []
    private static let logger = DebugLogger(subsystem: "com.illixion.roboframe.client", category: "raw-splat")

    static func key(itemID: String, settings: RAVESlideshowVisualSettings) -> String {
        String(format: "%@:%.3f:%.3f:%.3f", itemID, settings.brightness, settings.contrast, settings.saturation)
    }

    /// The finished scene for a picture, generating it if no one has started.
    /// The cache holds the task, so the `Spatial3DImage` stays alive until
    /// `generate()`'s progress callbacks have landed even if the view that
    /// asked has gone (RealityKit crashes if they land on freed memory).
    func scene(for key: String, data: Data, settings: RAVESlideshowVisualSettings) async -> SplatScene? {
        if let running = scenes[key] { return await running.value }
        let task = Task { @MainActor () -> SplatScene? in
            let bytes = await Self.adjusted(data, settings: settings)
            do {
                let spatial = try await Self.makeSpatial3DImage(from: bytes)
                try await spatial.generate()
                return SplatScene(image: spatial)
            } catch {
                Self.logger.warning("Raw Splat scene failed: \(error.localizedDescription)")
                return nil
            }
        }
        scenes[key] = task
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.capacity { scenes.removeValue(forKey: order.removeFirst()) }
        let scene = await task.value
        if scene == nil { scenes.removeValue(forKey: key) }
        return scene
    }

    /// Start building a scene no one is waiting for yet.
    func prefetch(key: String, data: Data, settings: RAVESlideshowVisualSettings) {
        guard scenes[key] == nil else { return }
        Task { _ = await scene(for: key, data: data, settings: settings) }
    }

    /// Built off the main actor: the `CGImageSource` never crosses an actor
    /// boundary, which Swift 6's data-race check would reject.
    private nonisolated static func makeSpatial3DImage(from data: Data) async throws -> ImagePresentationComponent.Spatial3DImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return try await ImagePresentationComponent.Spatial3DImage(imageSource: source)
    }

    /// RealityKit doesn't honour SwiftUI's `.brightness`/`.contrast`/
    /// `.saturation` on scene content, so the adjustments are baked into the
    /// source bytes. Identity adjustments skip the CoreImage pass.
    private static func adjusted(_ data: Data, settings: RAVESlideshowVisualSettings) async -> Data {
        guard settings.brightness != 0 || settings.contrast != 1 || settings.saturation != 1 else { return data }
        let (b, c, s) = (settings.brightness, settings.contrast, settings.saturation)
        return await Task.detached(priority: .userInitiated) { bake(data, brightness: b, contrast: c, saturation: s) }.value ?? data
    }

    /// CIColorControls' contrast scale is about 8x more aggressive than
    /// SwiftUI's `.contrast()` for the same deviation from 1, so the deviation
    /// is scaled by 0.12 to match (as Hypnos's 3D adjustment bake does).
    private nonisolated static func bake(_ data: Data, brightness: Double, contrast: Double, saturation: Double) -> Data? {
        guard let input = CIImage(data: data),
              let filter = CIFilter(name: "CIColorControls") else { return nil }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(brightness, forKey: kCIInputBrightnessKey)
        filter.setValue(1.0 + (contrast - 1.0) * 0.12, forKey: kCIInputContrastKey)
        filter.setValue(saturation, forKey: kCIInputSaturationKey)
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.95)
    }
}

struct RawSplatStill: View {
    let itemID: String
    let data: Data
    let immersive: Bool
    /// The Distance setting.
    let distance: Double
    let visualSettings: RAVESlideshowVisualSettings
    let isOutgoing: Bool
    let fadeDuration: TimeInterval
    /// A tap on the picture: visionOS hit-tests RealityKit entities ahead of
    /// SwiftUI's z-order, so the window's own tap gesture never sees it.
    let onTap: () -> Void

    @State private var entity = Entity()
    @State private var loadedKey: String?
    /// Entity-level opacity, stepped over the fade. Zero until the scene is
    /// in, so a picture never shows half built.
    @State private var shown: Float = 0
    @State private var fadeTask: Task<Void, Never>?

    private static let logger = DebugLogger(subsystem: "com.illixion.roboframe.client", category: "raw-splat")

    var body: some View {
        // Read here so a change of either re-runs `update`.
        let opacity = shown
        GeometryReader3D { geometry in
            RealityView { content in
                Self.installTapTarget(on: entity)
                content.add(entity)
                scaleEntityToFit(content: content, geometry: geometry)
                Self.applyOpacity(opacity, to: entity)
            } update: { content in
                scaleEntityToFit(content: content, geometry: geometry)
                Self.applyOpacity(opacity, to: entity)
            }
            .gesture(TapGesture().targetedToAnyEntity().onEnded { _ in onTap() })
        }
        .task(id: sceneKey) { await load() }
        .onChange(of: isOutgoing) { _, _ in fade(to: targetOpacity) }
        .onChange(of: visualSettings.opacity) { _, _ in fade(to: targetOpacity, duration: 0) }
        .onChange(of: immersive) { _, newValue in
            // Mode flip without regenerating: the finished scene stays valid.
            guard var ipc = entity.components[ImagePresentationComponent.self] else { return }
            ipc.desiredViewingMode = newValue ? .spatial3DImmersive : .spatial3D
            ipc.applyPrivateSpatial3DTuningIfAvailable(rawSplat: true)
            entity.components.set(ipc)
        }
        .onDisappear {
            fadeTask?.cancel()
            #if ROBOFRAME_PRIVATE_API
            PrivateSpatial3DTuningStore.shared.setRawSplat(false, owner: entity)
            #endif
        }
    }

    private var sceneKey: String { RawSplatSceneCache.key(itemID: itemID, settings: visualSettings) }
    private var targetOpacity: Float { isOutgoing || loadedKey == nil ? 0 : Float(visualSettings.opacity) }

    @MainActor
    private func load() async {
        let key = sceneKey
        if loadedKey == key { return }
        // The renderer's edge settings must be in place before the component
        // is built (`PrivateSpatial3DTuningStore.rawSplatEdgeDefaults`).
        #if ROBOFRAME_PRIVATE_API
        PrivateSpatial3DTuningStore.shared.setRawSplat(true, owner: entity)
        #endif
        guard let spatial = await RawSplatSceneCache.shared.scene(for: key, data: data, settings: visualSettings),
              !Task.isCancelled else { return }
        var ipc = ImagePresentationComponent(spatial3DImage: spatial.image)
        ipc.desiredViewingMode = immersive ? .spatial3DImmersive : .spatial3D
        ipc.applyPrivateSpatial3DTuningIfAvailable(rawSplat: true)
        entity.components.set(ipc)
        loadedKey = key
        fade(to: targetOpacity)
    }

    /// Steps `shown` toward `target` over the fade, since RealityKit won't
    /// animate it.
    @MainActor
    private func fade(to target: Float, duration: TimeInterval? = nil) {
        fadeTask?.cancel()
        let seconds = duration ?? fadeDuration
        let start = shown
        guard seconds > 0, start != target else { shown = target; return }
        fadeTask = Task { @MainActor in
            let steps = max(1, Int(seconds * 30))
            for step in 1...steps {
                try? await Task.sleep(for: .seconds(seconds / Double(steps)))
                guard !Task.isCancelled else { return }
                shown = start + (target - start) * Float(step) / Float(steps)
            }
            shown = target
        }
    }

    private func scaleEntityToFit(content: RealityViewContent, geometry: GeometryProxy3D) {
        let user = Float(distance)
        guard !immersive else {
            entity.scale = SIMD3<Float>(user, user, user)
            return
        }
        guard let ipc = entity.components[ImagePresentationComponent.self] else { return }
        let size = ipc.presentationScreenSize
        guard size.x > 0, size.y > 0 else { return }
        let bounds = content.convert(geometry.frame(in: .local), from: .local, to: .scene)
        let fit = min(bounds.extents.x / size.x, bounds.extents.y / size.y)
        // A raw splat is a volume: its depth follows Distance too.
        entity.scale = SIMD3<Float>(fit * user, fit * user, user)
    }

    /// `InputTargetComponent` + `CollisionComponent` make the picture
    /// tappable through a targeted-entity gesture. The 1x1x0.01 m box scales
    /// with the entity, so the hit region follows the visible picture.
    private static func installTapTarget(on entity: Entity) {
        guard entity.components[InputTargetComponent.self] == nil else { return }
        entity.components.set(InputTargetComponent())
        entity.components.set(CollisionComponent(shapes: [.generateBox(size: SIMD3<Float>(1, 1, 0.01))]))
    }

    /// On every entity under the picture: the renderer builds its mesh below
    /// the picture's entity, and the entity's own component doesn't dim it.
    /// Removed again at full opacity.
    static func applyOpacity(_ opacity: Float, to entity: Entity) {
        if opacity >= 0.999 {
            if entity.components[OpacityComponent.self] != nil { entity.components.remove(OpacityComponent.self) }
        } else if entity.components[OpacityComponent.self]?.opacity != opacity {
            entity.components.set(OpacityComponent(opacity: opacity))
        }
        for child in entity.children { applyOpacity(opacity, to: child) }
    }
}

#endif
