import AVKit
import DebugTrace
import RAVESlideshow
import SwiftUI

struct RoboFrameSlideshowSurface: View {
    let model: SlideshowModel

    var body: some View {
        let mode = model.profile.slideshow3DMode
        RAVESlideshowSurface(engine: model.engine) { context in
            StillSlideshowMedia(
                context: context,
                aiDepth: mode == .aiDepth,
                // The surface fades the outgoing layer with SwiftUI opacity,
                // which an AI 3D mesh doesn't follow; it fades on its own.
                isOutgoing: context.role == .current && model.engine.incoming != nil
            )
        } animated: { context in
            StillSlideshowMedia(context: context)
        } video: { context in
            SlideshowVideoMedia(context: context, pseudo3D: mode.convertsVideo)
        } placeholder: {
            ProgressView("Waiting for RoboFrame…")
                .tint(.white)
                .foregroundStyle(.white)
        }
        #if os(visionOS)
        // Depth for the next picture while this one is on screen, so it
        // arrives with its mesh.
        .task(id: mode == .aiDepth ? model.engine.peekedNext?.item.id : nil) {
            guard mode == .aiDepth, let peek = model.engine.peekedNext,
                  case .still(let data, _) = peek.media,
                  let image = UIImage(data: data)?.cgImage else { return }
            _ = await SlideshowDepthCache.shared.depth(for: peek.item.id, image: image)
        }
        #endif
    }
}

private struct StillSlideshowMedia: View {
    let context: RAVESlideshowRenderContext
    var aiDepth = false
    var isOutgoing = false

    var body: some View {
        switch context.media.media {
        case .still(let data, _):
            if let image = UIImage(data: data) {
                ZStack {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .brightness(context.visualSettings.brightness)
                        .contrast(context.visualSettings.contrast)
                        .saturation(context.visualSettings.saturation)
                        .modifier(SpatialImageTreatment(enabled: context.displaySettings.mode3D == .spatial3D))
                    #if os(visionOS)
                    if aiDepth, let cgImage = image.cgImage {
                        AIDepthStill(
                            itemID: context.media.item.id,
                            image: cgImage,
                            aspectRatio: image.size,
                            visualSettings: context.visualSettings,
                            isOutgoing: isOutgoing,
                            fadeDuration: context.displaySettings.reduceMotion ? 0 : context.displaySettings.transitionDuration * 0.6
                        )
                    }
                    #endif
                }
            } else {
                ContentUnavailableView("Media unavailable", systemImage: "exclamationmark.triangle")
            }
        case .animatedImage(_, let url):
            AsyncImage(url: url) { $0.image?.resizable().scaledToFit() }
        case .video:
            EmptyView()
        }
    }
}

private struct SlideshowVideoMedia: View {
    let context: RAVESlideshowRenderContext
    let pseudo3D: Bool

    var body: some View {
        guard case .video(let url, _) = context.media.media else { return AnyView(EmptyView()) }
        #if os(visionOS)
        if pseudo3D {
            return AnyView(Pseudo3DSlideshowVideo(url: url, visualSettings: context.visualSettings))
        }
        #endif
        return AnyView(FlatSlideshowVideo(url: url))
    }
}

/// A slideshow clip: muted, looping, playing from the moment it appears, as
/// Hypnos's slideshow plays them, with no playback controls. Its player comes
/// from `SlideshowClipPool`, where `loadMedia` already buffered it, so the
/// crossfade fades in a picture rather than an empty layer.
private struct FlatSlideshowVideo: View {
    let url: URL

    var body: some View {
        // Taken while rendering, not in `.task`, so the layer's very first
        // frame already has the prepared player behind it.
        PlayerLayerView(player: SlideshowClipPool.shared.clip(for: url).player)
            // Started as the layer is inserted, so the crossfade fades in a
            // clip that is already moving.
            .onAppear { SlideshowClipPool.shared.clip(for: url).play() }
            .task(id: url) {
                // A clip that never starts says why, instead of sitting on a black tile.
                try? await Task.sleep(for: .seconds(5))
                SlideshowClipPool.shared.clip(for: url).reportIfStalled()
            }
            .onDisappear { SlideshowClipPool.shared.release(url) }
    }
}

/// Players for the clips on screen and the ones `loadMedia` prepared ahead of
/// them, by URL. Bounded: prefetched clips the server dropped from its
/// look-ahead never reach a view, so the oldest ones off screen are evicted.
/// The bound covers the engine's whole look-ahead (`prefetchLimit`, 3) plus
/// the current and incoming clips, so a prepared clip is never evicted before
/// its turn.
@MainActor
final class SlideshowClipPool {
    static let shared = SlideshowClipPool()
    private static let capacity = 8

    private var clips: [URL: SlideshowClipPlayer] = [:]
    private var order: [URL] = []

    /// Load, buffer and preroll the clip, so it starts moving the moment it
    /// appears. Gives up after `timeout`: the view still plays the clip, and
    /// reports it if it never starts.
    func prepare(_ url: URL, timeout: Duration = .seconds(10)) async {
        await clip(for: url).prepare(timeout: timeout)
    }

    /// The clip's player, prepared or fresh. A failed one is replaced: its
    /// encode may not have had a transcode slot when it was prefetched.
    func clip(for url: URL) -> SlideshowClipPlayer {
        order.removeAll { $0 == url }
        order.append(url)
        if let clip = clips[url], !clip.failed { return clip }
        clips[url]?.stop()
        let clip = SlideshowClipPlayer(url: url)
        clips[url] = clip
        evict()
        return clip
    }

    func release(_ url: URL) {
        clips.removeValue(forKey: url)?.stop()
        order.removeAll { $0 == url }
    }

    private func evict() {
        while order.count > Self.capacity, let oldest = order.first(where: { clips[$0]?.isPlaying != true }) {
            release(oldest)
        }
    }
}

@MainActor
final class SlideshowClipPlayer {
    private static let logger = DebugLogger(subsystem: "com.illixion.roboframe.client", category: "video")

    let player = AVPlayer()
    private(set) var isPlaying = false
    private var prerolled = false
    private var prerollAnswered = false
    private var playRequestedAt: ContinuousClock.Instant?
    private var statusObservation: NSKeyValueObservation?
    private var startObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?

    var failed: Bool { player.currentItem?.status == .failed }

    init(url: URL) {
        player.isMuted = true
        player.actionAtItemEnd = .none
        let item = AVPlayerItem(url: url)
        statusObservation = item.observe(\.status) { item, _ in
            guard item.status == .failed else { return }
            let error = item.error as NSError?
            let status = item.errorLog()?.events.last?.errorStatusCode ?? 0
            Task { @MainActor in
                Self.logger.error("clip failed: \(error?.domain ?? "-", privacy: .public) \(error?.code ?? 0, privacy: .public), last HTTP status \(status, privacy: .public)")
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.player.seek(to: .zero)
                self?.player.play()
            }
        }
        player.replaceCurrentItem(with: item)
    }

    /// Until the item can play through its first stretch without waiting and
    /// its decoder is primed (prerolled), it fails, or `timeout` passes.
    func prepare(timeout: Duration) async {
        let deadline = ContinuousClock.now + timeout
        func waiting() -> Bool { ContinuousClock.now < deadline && !Task.isCancelled }
        while waiting(), let item = player.currentItem {
            if item.status == .failed { return }
            if item.status == .readyToPlay, item.isPlaybackLikelyToKeepUp || item.isPlaybackBufferFull { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        // preroll(atRate:) raises unless the item is ready and the player stopped.
        guard !prerolled, !isPlaying, player.currentItem?.status == .readyToPlay, player.rate == 0 else { return }
        prerollAnswered = false
        player.preroll(atRate: 1) { [weak self] finished in
            Task { @MainActor in
                self?.prerolled = finished
                self?.prerollAnswered = true
            }
        }
        while waiting(), !prerollAnswered { try? await Task.sleep(for: .milliseconds(20)) }
    }

    func play() {
        guard !isPlaying else { return }
        isPlaying = true
        playRequestedAt = .now
        let prerolled = prerolled
        startObservation = player.observe(\.timeControlStatus) { [weak self] player, _ in
            guard player.timeControlStatus == .playing else { return }
            Task { @MainActor in
                guard let self, let start = self.playRequestedAt else { return }
                self.playRequestedAt = nil
                self.startObservation = nil
                let ms = Int((ContinuousClock.now - start) / .milliseconds(1))
                Self.logger.info("clip playing \(ms, privacy: .public) ms after play(), prerolled \(prerolled, privacy: .public)")
            }
        }
        // A clip prepare() buffered has nothing to wait for, so it skips
        // AVPlayer's buffering-rate check, which held prerolled HLS clips back
        // for about two seconds, most of the crossfade.
        if let item = player.currentItem, item.status == .readyToPlay,
           item.isPlaybackLikelyToKeepUp || item.isPlaybackBufferFull {
            player.playImmediately(atRate: 1)
        } else {
            player.play()
        }
    }

    func reportIfStalled() {
        guard let item = player.currentItem, player.timeControlStatus != .playing else { return }
        Self.logger.notice("clip not playing after 5 s: item status \(item.status.rawValue, privacy: .public), waiting for \(self.player.reasonForWaitingToPlay?.rawValue ?? "-", privacy: .public)")
    }

    func stop() {
        isPlaying = false
        startObservation = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        statusObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }
}

/// An `AVPlayerLayer` and nothing else: `VideoPlayer` always brings its controls.
private struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

#if os(visionOS)
import RAVEMedia
import RealityKit

/// AI 3D over one slideshow picture: the depth mesh, laid over the flat
/// picture once the depth is ready, and an input layer in front of it so
/// the window's tap still toggles the chrome (the mesh's RealityView would
/// swallow it).
private struct AIDepthStill: View {
    let itemID: String
    let image: CGImage
    let aspectRatio: CGSize
    let visualSettings: RAVESlideshowVisualSettings
    let isOutgoing: Bool
    let fadeDuration: TimeInterval
    @State private var depth: StillDepthMap?

    var body: some View {
        ZStack {
            if let depth {
                RAVEAIDepthPhotoView(
                    image: image,
                    depth: depth,
                    contentID: itemID,
                    adjustments: .init(
                        brightness: visualSettings.brightness,
                        contrast: visualSettings.contrast,
                        saturation: visualSettings.saturation
                    ),
                    opacity: isOutgoing ? 0 : 1,
                    fadeDuration: fadeDuration
                )
                Color.white.opacity(0.001)
                    .offset(z: RAVEAIDepthPhotoView.inputTargetZ)
            }
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .task(id: itemID) {
            depth = await SlideshowDepthCache.shared.depth(for: itemID, image: image)
        }
    }
}

/// Depth maps for the pictures on screen and the next one, by item id. RAM
/// only and small: a slideshow passes through far too much to keep more.
@MainActor
final class SlideshowDepthCache {
    static let shared = SlideshowDepthCache()
    private static let capacity = 6

    private var maps: [String: StillDepthMap] = [:]
    private var order: [String] = []
    private var inFlight: [String: Task<StillDepthMap?, Never>] = [:]

    func depth(for id: String, image: CGImage) async -> StillDepthMap? {
        if let map = maps[id] { return map }
        if let running = inFlight[id] { return await running.value }
        let task = Task { await RAVEStillDepthEstimator.shared.depth(for: image) }
        inFlight[id] = task
        let map = await task.value
        inFlight.removeValue(forKey: id)
        if let map {
            maps[id] = map
            order.removeAll { $0 == id }
            order.append(id)
            while order.count > Self.capacity { maps.removeValue(forKey: order.removeFirst()) }
        }
        return map
    }
}

private struct Pseudo3DSlideshowVideo: View {
    let url: URL
    let visualSettings: RAVESlideshowVisualSettings
    @State private var engine = Pseudo3DStereoEngine()
    @State private var failed = false

    var body: some View {
        Group {
            if failed {
                FlatSlideshowVideo(url: url)
            } else {
                GeometryReader3D { _ in
                    RealityView { content in
                        let entity = engine.makeVideoEntity()
                        content.add(entity)
                        engine.observeVideoSize(content: content)
                    } update: { _ in
                        engine.configure(
                            adjustments: RAVEColorAdjustments(
                                brightness: visualSettings.brightness,
                                contrast: visualSettings.contrast,
                                saturation: visualSettings.saturation
                            ),
                            settings: .default,
                            isFlipped: false
                        )
                    }
                }
                .task {
                    engine.onPlaybackError = { failed = true }
                    engine.loops = true
                    engine.load(url: url, roomActive: true, depthMode: .realtime)
                }
            }
        }
    }
}
#endif

private struct SpatialImageTreatment: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        #if os(visionOS)
        content
            .shadow(color: enabled ? .cyan.opacity(0.38) : .clear, radius: enabled ? 26 : 0, y: enabled ? 10 : 0)
            .rotation3DEffect(.degrees(enabled ? -1.5 : 0), axis: (x: 0, y: 1, z: 0))
        #else
        content
        #endif
    }
}
