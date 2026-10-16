/*
 Kiosk renderer

 A fullscreen SDL2 window with an OpenGL ES 2 context, composited every
 frame from three layers:

 1. The slideshow: what the engine shows (its incoming item during a
    transition, else its current one). Photos are decoded as soon as the
    engine prefetches them, so a transition starts on time, and copied into
    one of two screen-sized textures when it does (the one on screen and
    the one fading in). Videos play through libmpv into one of a few 720p
    targets. Those surfaces are allocated once and reused (GL.swift says
    why). A new frame crossfades over the old for the configured transition
    length, photo or video either side.
    A photo is placed whole or filling the screen (`fit`), zooms slowly
    towards its busiest part over its dwell (Ken Burns, KioskKenBurns), and
    has its blurred copy in the bars beside it. That copy is drawn only in
    the bars, never under the photo, so each layer still paints every pixel
    once and the additive crossfade stays exact.
    The slideshow's brightness setting dims this layer alone.
 2. Effects: a `playVideo` clip or a `playScene` stream over the slideshow,
    or a `showText` alert, which covers everything.
 3. The overlay: clock, date, sensors, toasts (fading in and out), the
    status line (offline, a refused token, an empty query) and the
    settings menu over everything.

 The panel off (displayState) draws black and stops video; the photo hidden
 from the keypad keeps the overlay. Nothing here talks to the server: the
 session does, and this only draws its state.

 The loop runs on the main queue, so it shares the main actor with the
 session: 60 Hz while something moves (a fade, a video), 20 Hz otherwise,
 drawing only when something changed. Swaps wait for vsync.
 */

import CGLES2
import CSDL2
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KioskCore
import RAVENet
import RAVERoboFrame
import RAVESlideshowCore

public enum KioskRendererError: Error, CustomStringConvertible {
    case sdl(String)

    public var description: String {
        switch self {
        case .sdl(let message): message
        }
    }
}

@MainActor
public final class KioskRenderer {
    private enum Content {
        case photo(GLPhotoSlot)
        case video(GLRenderTarget, URL)
    }

    private struct Layer {
        let id: String
        let content: Content
        /// When it started fading in: the Ken Burns zoom's clock.
        let start: TimeInterval
    }

    private enum PlayerOwner: Equatable {
        case none
        case slideshow(String)
        case effect
    }

    private let session: KioskSession
    private let logger: any RAVENetLogger
    private let window: OpaquePointer
    private let glContext: SDL_GLContext
    private let compositor: GLCompositor
    private let text = TextSetter()
    private let player: VideoPlayer?
    private var audioPlayer: VideoPlayer?
    private let maxTextureSize: Int

    public private(set) var width: Int
    public private(set) var height: Int

    // Slideshow
    /// Decoded and waiting for their turn, in RAM rather than GPU memory.
    private var photos: [String: DecodedPhoto] = [:]
    private var photoSlots: [GLPhotoSlot] = []
    private var videoTargets: [GLRenderTarget] = []
    private var videoTargetRetryAt: TimeInterval = 0
    private var decoding: Set<String> = []
    private var unplayable: Set<String> = []
    private var front: Layer?
    private var fade: (layer: Layer, start: TimeInterval)?
    private var pendingVideo: (id: String, url: URL, target: GLRenderTarget)?
    private var owner = PlayerOwner.none

    // Effects
    private var effect: (value: KioskSession.Effect, target: GLRenderTarget, start: TimeInterval?)?
    private var audio: URL?
    private var alert: (value: RoboFrameAlert, background: (Float, Float, Float), text: GLTexture?, image: GLTexture?)?

    // Overlay
    private var clockText = (time: "", date: "")
    private var clockTexture: GLTexture?
    private var dateTexture: GLTexture?
    private var sensorLines: [String] = []
    private var sensorsTexture: GLTexture?
    private var toastTextures: [(id: Int, texture: GLTexture)] = []
    private var statusText: String?
    private var statusTexture: GLTexture?
    private var menuRows: [KioskMenuRow] = []
    private var menuTexture: GLTexture?
    private var overlayLayout: (clock: Bool, seconds: Bool, date: Bool, sensors: Bool)?

    private var dirty = true
    private var timer: DispatchSourceTimer?
    private var fastTicks: Bool?

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var scale: Float { Float(height) / 1080 }

    /// Opens the window. `windowed` is for desktops and tests; the kiosk runs fullscreen.
    public init(session: KioskSession, windowed: Bool = false,
                logger: any RAVENetLogger = RAVENetOSLogger(subsystem: "roboframe.kiosk", category: "renderer")) throws {
        self.session = session
        self.logger = logger
        SDL_SetHint("SDL_VIDEO_X11_FORCE_EGL", "1")
        SDL_SetHint("SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS", "0")
        guard SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) == 0 else { throw KioskRendererError.sdl("SDL_Init: \(Self.sdlError)") }
        TTF_Init()
        _ = IMG_Init(Int32(IMG_INIT_JPG.rawValue | IMG_INIT_PNG.rawValue))

        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, Int32(SDL_GL_CONTEXT_PROFILE_ES.rawValue))
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2)
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0)
        SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1)
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0)

        var flags = SDL_WINDOW_OPENGL.rawValue | SDL_WINDOW_SHOWN.rawValue
        if !windowed { flags |= SDL_WINDOW_FULLSCREEN_DESKTOP.rawValue | SDL_WINDOW_BORDERLESS.rawValue }
        let centered = Int32(0x2FFF_0000)
        guard let window = SDL_CreateWindow("RoboFrame", centered, centered, Int32(session.config.screenWidth), Int32(session.config.screenHeight), flags) else {
            throw KioskRendererError.sdl("SDL_CreateWindow: \(Self.sdlError)")
        }
        guard let glContext = SDL_GL_CreateContext(window) else {
            SDL_DestroyWindow(window)
            throw KioskRendererError.sdl("SDL_GL_CreateContext: \(Self.sdlError)")
        }
        self.window = window
        self.glContext = glContext
        SDL_GL_MakeCurrent(window, glContext)
        if SDL_GL_SetSwapInterval(1) != 0 { logger.log(.warning, "no vsync: \(Self.sdlError, privacy: .public)") }
        SDL_ShowCursor(0)

        var drawableWidth: Int32 = 0, drawableHeight: Int32 = 0
        SDL_GL_GetDrawableSize(window, &drawableWidth, &drawableHeight)
        width = Int(drawableWidth)
        height = Int(drawableHeight)
        compositor = try GLCompositor()
        maxTextureSize = GLCompositor.maxTextureSize

        let renderer = String(cString: glGetString(GLenum(GL_RENDERER)))
        let version = String(cString: glGetString(GLenum(GL_VERSION)))
        logger.log(.info, "GL \(version, privacy: .public) on \(renderer, privacy: .public), \(width)x\(height), max texture \(maxTextureSize)")
        if !text.hasFont { logger.log(.warning, "no TrueType font found; the overlay is empty") }

        let mpvLog: (String) -> Void = { [logger] line in logger.log(.warning, "\(line)") }
        player = VideoPlayer(hwdec: session.config.hwdec, video: true, log: mpvLog)
        if player == nil { logger.log(.error, "libmpv didn't start; videos are skipped") }
        makePhotoSlots()

        session.onChange = { [weak self] in self?.dirty = true }
    }

    private static var sdlError: String { String(cString: SDL_GetError()) }

    /// Starts drawing. The session should already be started.
    public func run() {
        session.setScreenSize(width: width, height: height)
        schedule(fast: true)
    }

    private func schedule(fast: Bool) {
        guard fast != fastTicks else { return }
        fastTicks = fast
        timer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        let interval: DispatchTimeInterval = fast ? .microseconds(16_666) : .milliseconds(50)
        timer.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.tick() }
        }
        timer.resume()
        self.timer = timer
    }

    // MARK: - Frame

    private func tick() {
        pollInput()
        session.expireToasts()
        handlePlayerEvents()
        syncEffects()
        syncSlideshow()
        syncOverlay()

        var animating = false
        if let fade {
            animating = true
            if now - fade.start >= session.config.transitionDuration { finishFade() }
            dirty = true
        }
        if let player, owner != .none, session.isPanelOn {
            animating = true
            if let target = activeVideoTarget, player.renderIfNeeded(into: target) { dirty = true }
        }
        if let start = effect?.start, now - start < 0.5 { animating = true; dirty = true }
        if session.isShowing, alert == nil, let layer = fade?.layer ?? front, kenBurnsProgress(layer) < 1 {
            animating = true
            dirty = true
        }
        if session.toasts.all.contains(where: { $0.isAnimating(now: now) }) {
            animating = true
            dirty = true
        }

        if dirty {
            dirty = false
            draw()
            SDL_GL_SwapWindow(window)
            player?.reportSwap()
        }
        schedule(fast: animating)
    }

    /// The texture mpv is drawing into, whoever it's playing for.
    private var activeVideoTarget: GLRenderTarget? {
        switch owner {
        case .none: nil
        case .effect: effect?.target
        case .slideshow(let id):
            if pendingVideo?.id == id { pendingVideo?.target }
            else if let layer = [fade?.layer, front].compactMap({ $0 }).first(where: { $0.id == id }), case .video(let target, _) = layer.content { target }
            else { nil }
        }
    }

    private func draw() {
        compositor.begin(width: width, height: height)
        guard session.isPanelOn else { return }
        let screen = PixelRect(x: 0, y: 0, width: Float(width), height: Float(height))

        if let alert {
            compositor.fill(screen, red: alert.background.0, green: alert.background.1, blue: alert.background.2, alpha: 1)
            drawAlertContent(alert.text, alert.image)
            return
        }

        if session.isShowing {
            if let fade {
                let progress = Float(min(1, max(0, (now - fade.start) / max(0.001, session.config.transitionDuration))))
                // Ease in and out, so the fade doesn't start or end on a step.
                let eased = progress * progress * (3 - 2 * progress)
                if let front { drawLayer(front, alpha: 1 - eased) }
                drawLayer(fade.layer, alpha: eased)
            } else if let front {
                drawLayer(front, alpha: 1)
            }
            let brightness = Float(session.config.brightness) / 100
            if brightness < 1 { compositor.fill(screen, red: 0, green: 0, blue: 0, alpha: 1 - brightness) }
        }

        if let effect, let start = effect.start {
            compositor.draw(effect.target.texture, in: screen, alpha: Float(min(1, (now - start) / 0.5)), blend: .over)
        }

        drawOverlay()
    }

    private func drawLayer(_ layer: Layer, alpha: Float) {
        switch layer.content {
        case .photo(let slot):
            let config = session.config
            var rect = KioskKenBurns.placed(width: slot.width, height: slot.height, screenWidth: width, screenHeight: height, fit: config.fit)
            if config.kenBurns { rect = KioskKenBurns.zoomed(rect, focus: slot.focus, progress: kenBurnsProgress(layer)) }
            let photo = PixelRect(x: Float(rect.x), y: Float(rect.y), width: Float(rect.width), height: Float(rect.height))
            if config.blurBackground, let backdrop = slot.backdrop { drawBackdrop(backdrop, around: photo, alpha: alpha) }
            compositor.draw(slot.texture, in: photo, alpha: alpha, blend: .add, region: slot.region)
        case .video(let target, _):
            // mpv letterboxes into the full-screen target itself.
            compositor.draw(target.texture, in: PixelRect(x: 0, y: 0, width: Float(width), height: Float(height)), alpha: alpha, blend: .add)
        }
    }

    /// How far a photo's zoom has got: 0 as it starts fading in, 1 by the
    /// time its dwell (and the fade) is over, then it holds.
    private func kenBurnsProgress(_ layer: Layer) -> Double {
        guard session.config.kenBurns, case .photo = layer.content else { return 1 }
        let span = session.engine.displaySettings.delay + session.config.transitionDuration
        return min(1, max(0, (now - layer.start) / max(1, span)))
    }

    /// The photo's blurred copy, scaled to cover the screen, drawn in the
    /// strips around `photo`: above, below, then either side.
    private func drawBackdrop(_ backdrop: (texture: GLTexture, region: GLCompositor.Region, width: Int, height: Int), around photo: PixelRect, alpha: Float) {
        let cover = KioskKenBurns.placed(width: backdrop.width, height: backdrop.height, screenWidth: width, screenHeight: height, fit: .cover)
        let screenWidth = Float(width), screenHeight = Float(height)
        let top = max(0, min(screenHeight, photo.y)), bottom = max(top, min(screenHeight, photo.y + photo.height))
        let left = max(0, min(screenWidth, photo.x)), right = max(left, min(screenWidth, photo.x + photo.width))
        let strips = [
            PixelRect(x: 0, y: 0, width: screenWidth, height: top),
            PixelRect(x: 0, y: bottom, width: screenWidth, height: screenHeight - bottom),
            PixelRect(x: 0, y: top, width: left, height: bottom - top),
            PixelRect(x: right, y: top, width: screenWidth - right, height: bottom - top),
        ]
        for strip in strips where strip.width >= 1 && strip.height >= 1 {
            // The strip's part of the cover-scaled copy, in texture coordinates.
            let u = (Double(strip.x) - cover.x) / cover.width, v = (Double(strip.y) - cover.y) / cover.height
            let region = GLCompositor.Region(
                u: backdrop.region.u + Float(u) * backdrop.region.width,
                v: backdrop.region.v + Float(v) * backdrop.region.height,
                width: Float(Double(strip.width) / cover.width) * backdrop.region.width,
                height: Float(Double(strip.height) / cover.height) * backdrop.region.height)
            compositor.draw(backdrop.texture, in: strip, alpha: alpha, blend: .add, region: region)
        }
    }

    // MARK: - Slideshow

    private func syncSlideshow() {
        let engine = session.engine
        decodeAhead()

        guard session.isShowing else {
            if front != nil || fade != nil || pendingVideo != nil {
                front = nil
                fade = nil
                pendingVideo = nil
                if case .slideshow = owner { stopPlayer() }
                dirty = true
            }
            return
        }

        guard let target = engine.incoming ?? engine.current else { return }
        let id = target.item.id
        guard id != (fade?.layer.id ?? front?.id), !unplayable.contains(id) else { return }

        switch target.media {
        case .still, .animatedImage:
            guard let image = photos[id] else { return }
            if fade != nil { finishFade() }
            let inUse = [front?.content].compactMap { content -> GLPhotoSlot? in
                if case .photo(let slot) = content { slot } else { nil }
            }
            guard let slot = photoSlots.first(where: { slot in !inUse.contains { $0 === slot } }) else { return }
            slot.upload(image)
            photos[id] = nil
            pendingVideo = nil
            begin(Layer(id: id, content: .photo(slot), start: now))
        case .video(let url, _):
            guard pendingVideo?.id != id, effect == nil, let player else {
                if self.player == nil {
                    // No mpv: nothing will start it, so confirm the frame as it is.
                    unplayable.insert(id)
                    session.videoStarted(id, durationMs: nil)
                }
                return
            }
            guard let target = freeVideoTarget() else { return }
            pendingVideo = (id, url, target)
            owner = .slideshow(id)
            player.load(url, options: VideoPlayer.Options(loop: loops(target: engineItem(id)), audio: false, holdLastFrame: true))
            logger.log(.info, "loading video for post \(id)")
        }
    }

    private func engineItem(_ id: String) -> RAVESlideshowItem? {
        [session.engine.incoming, session.engine.current].compactMap { $0 }.first { $0.item.id == id }?.item
    }

    /// A clip that fits in the dwell loops; a longer one plays once and holds
    /// its last frame until the server moves on (it dwells for the clip's
    /// length), as the other kiosks do: looping it would flash its opening
    /// just before the advance.
    private func loops(target item: RAVESlideshowItem?) -> Bool {
        guard let duration = item?.duration, duration > 0 else { return true }
        return duration <= session.engine.displaySettings.delay
    }

    /// A video target no layer is showing, blacked out. Up to three exist:
    /// the video on screen, one fading in over it, and an effect over both.
    /// Nil while all three are busy, and for a while after one couldn't be
    /// made: retrying every frame would keep pressing on the CMA pool that
    /// just ran out, the condition that wedges the Pi's decoder.
    private func freeVideoTarget() -> GLRenderTarget? {
        var used: [GLRenderTarget] = []
        for layer in [front, fade?.layer].compactMap({ $0 }) {
            if case .video(let target, _) = layer.content { used.append(target) }
        }
        if let pendingVideo { used.append(pendingVideo.target) }
        if let effect { used.append(effect.target) }
        // Videos are capped at 720p, so a target any bigger only costs memory.
        let targetHeight = min(height, 720)
        let targetWidth = Int((Double(width) * Double(targetHeight) / Double(height)).rounded())
        // A free target made for another screen size (one made while the
        // panel was off and X ran at 320x200) is replaced, not reused.
        videoTargets.removeAll { target in
            !used.contains { $0 === target } && (target.texture.width != targetWidth || target.texture.height != targetHeight)
        }
        if let free = videoTargets.first(where: { target in !used.contains { $0 === target } }) {
            free.clear()
            return free
        }
        guard videoTargets.count < 3, now >= videoTargetRetryAt else { return nil }
        do {
            let target = try GLRenderTarget(width: targetWidth, height: targetHeight)
            videoTargets.append(target)
            return target
        } catch {
            logger.log(.error, "video target: \(String(describing: error), privacy: .public)")
            videoTargetRetryAt = now + 5
            return nil
        }
    }

    /// The two photo textures, sized to the screen. Kept when the screen
    /// shrinks (every panel off drops X to 320x200 and back), since a photo
    /// fits a larger slot; reallocating them is the CMA churn GL.swift avoids.
    private func makePhotoSlots() {
        let slotWidth = min(width, maxTextureSize), slotHeight = min(height, maxTextureSize)
        if let slot = photoSlots.first, slot.texture.width >= slotWidth, slot.texture.height >= slotHeight { return }
        photoSlots = (0..<2).map { _ in GLPhotoSlot(width: slotWidth, height: slotHeight) }
    }

    /// Photos are decoded as soon as the engine has their bytes, so a
    /// transition can start the moment it's due.
    private func decodeAhead() {
        let engine = session.engine
        var wanted: [(String, Data)] = []
        var keep: Set<String> = []
        for (item, media) in [engine.current.map { ($0.item, $0.media) }, engine.incoming.map { ($0.item, $0.media) }].compactMap({ $0 })
            + engine.prefetched.map({ ($0.item, $0.media) }) {
            keep.insert(item.id)
            if case .still(let data, _) = media { wanted.append((item.id, data)) }
        }
        let onScreen = Set([front?.id, fade?.layer.id].compactMap { $0 })
        for id in photos.keys where !keep.contains(id) || onScreen.contains(id) { photos[id] = nil }
        unplayable.formIntersection(keep.union(onScreen))

        for (id, data) in wanted where photos[id] == nil && !decoding.contains(id) && !unplayable.contains(id) && !onScreen.contains(id) {
            decoding.insert(id)
            let maxWidth = min(width, maxTextureSize), maxHeight = min(height, maxTextureSize)
            Task.detached(priority: .userInitiated) {
                let image = DecodedPhoto.decode(data, maxWidth: maxWidth, maxHeight: maxHeight)
                await MainActor.run { [weak self] in self?.decoded(id, image, maxWidth: maxWidth, maxHeight: maxHeight) }
            }
        }
    }

    private func decoded(_ id: String, _ image: DecodedPhoto?, maxWidth: Int, maxHeight: Int) {
        decoding.remove(id)
        // Fitted to a screen size that has since changed: decoded again at
        // the new one on the next tick.
        guard maxWidth == min(width, maxTextureSize), maxHeight == min(height, maxTextureSize) else { return }
        guard let image else {
            logger.log(.warning, "couldn't decode post \(id)")
            unplayable.insert(id)
            return
        }
        photos[id] = image
    }

    private func begin(_ layer: Layer) {
        if fade != nil { finishFade() }
        dirty = true
        guard front != nil, session.config.transitionDuration > 0 else {
            replaceFront(with: layer)
            return
        }
        fade = (layer, now)
    }

    private func finishFade() {
        guard let fade else { return }
        self.fade = nil
        replaceFront(with: fade.layer)
    }

    private func replaceFront(with layer: Layer) {
        front = layer
        // A video fading out keeps playing until it's gone; a photo taking
        // over is when its decoder goes.
        if case .photo = layer.content, case .slideshow = owner { stopPlayer() }
    }

    private func stopPlayer() {
        player?.stop()
        owner = .none
    }

    private func handlePlayerEvents() {
        if let player {
            for event in player.events() {
                switch (owner, event) {
                case (.slideshow(let id), .started):
                    guard let pending = pendingVideo, pending.id == id else { break }
                    pendingVideo = nil
                    logger.log(.info, "video for post \(id) playing: \(player.property("video-codec") ?? "?", privacy: .public) \(player.property("width") ?? "?", privacy: .public)x\(player.property("height") ?? "?", privacy: .public), hwdec=\(player.property("hwdec-current") ?? "no", privacy: .public)")
                    begin(Layer(id: id, content: .video(pending.target, pending.url), start: now))
                    let seconds = player.property("duration").flatMap(Double.init).flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
                    session.videoStarted(id, durationMs: seconds.map { Int(($0 * 1_000).rounded()) })
                case (.slideshow(let id), .failed(let reason)):
                    logger.log(.warning, "video for post \(id) failed: \(reason)")
                    if pendingVideo?.id == id { pendingVideo = nil }
                    unplayable.insert(id)
                    owner = .none
                    if session.videoFailed(id) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                            MainActor.assumeIsolated { _ = self?.unplayable.remove(id) }
                        }
                    }
                case (.effect, .started):
                    effect?.start = now
                    dirty = true
                case (.effect, .finished), (.effect, .failed):
                    if case .failed(let reason) = event { logger.log(.warning, "effect failed: \(reason)") }
                    session.effectEnded()
                default:
                    break
                }
            }
        }
        if let audioPlayer {
            for event in audioPlayer.events() where event != .started {
                session.audioEnded()
            }
        }
    }

    // MARK: - Effects

    private func syncEffects() {
        if session.effect != effect?.value {
            if effect != nil {
                effect = nil
                stopPlayer()
                resumeSlideshowVideo()
            }
            if session.effect != nil, player == nil {
                // Nothing can play it; let the session drop it rather than
                // asking again every frame.
                session.effectEnded()
            } else if let value = session.effect, let player, let target = freeVideoTarget() {
                effect = (value, target, nil)
                owner = .effect
                pendingVideo = nil
                switch value {
                case .video(let url):
                    player.load(url, options: VideoPlayer.Options(loop: false, audio: true))
                case .scene(let url):
                    player.load(url, options: VideoPlayer.Options(loop: false, audio: true, lowLatency: true))
                }
            }
            dirty = true
        }

        if session.audio != audio {
            audio = session.audio
            if let url = audio {
                if audioPlayer == nil {
                    audioPlayer = VideoPlayer(hwdec: "no", video: false) { [logger] line in logger.log(.warning, "\(line)") }
                }
                audioPlayer?.load(url, options: VideoPlayer.Options(loop: false, audio: true))
            } else {
                audioPlayer?.stop()
            }
        }

        if session.alert != alert?.value {
            if let value = session.alert { buildAlert(value) } else { alert = nil }
            dirty = true
        }
        // An alert covers the screen, so the video under it waits.
        player?.setPaused(alert != nil || !session.isPanelOn)
    }

    /// After an effect, a video post that was on screen starts again.
    private func resumeSlideshowVideo() {
        guard let player, let layer = fade?.layer ?? front, case .video(_, let url) = layer.content else { return }
        owner = .slideshow(layer.id)
        player.load(url, options: VideoPlayer.Options(loop: loops(target: engineItem(layer.id)), audio: false, holdLastFrame: true))
    }

    private func buildAlert(_ value: RoboFrameAlert) {
        let background = Self.parseHex(value.backgroundHex)
        alert = (value, background, nil, nil)
        layoutAlert(imageHeight: 0)
        guard let imageURL = value.imageURL.flatMap(resolve) else { return }
        let maxWidth = width / 4, maxHeight = height / 2
        let maxBytes = session.config.maxMediaBytes
        Task { [weak self] in
            guard let (data, _) = try? await URLSession.shared.data(from: imageURL), data.count <= maxBytes else { return }
            let image = await Task.detached { RGBAImage.decode(data, maxWidth: maxWidth, maxHeight: maxHeight) }.value
            guard let self, let image, self.alert?.value == value else { return }
            self.alert?.image = image.texture()
            self.layoutAlert(imageHeight: Int(self.alertImageRect(image.width, image.height).height))
            self.dirty = true
        }
    }

    /// The alert's text, as large as fits beside its image.
    private func layoutAlert(imageHeight: Int) {
        guard let value = alert?.value, !value.text.isEmpty else { return }
        let availableHeight = height - 40 - (imageHeight > 0 ? imageHeight + 20 : 0)
        let size = text.fittingSize(value.text, width: width - 40, height: max(8, availableHeight))
        let image = text.box([value.text], size: size, rightAligned: false, padding: (0, 0), background: (0, 0, 0, 0),
                             color: SDL_Color(r: 255, g: 255, b: 255, a: 255))
        alert?.text = image?.texture()
    }

    /// At most a quarter of the width and half the height, like the web kiosk.
    private func alertImageRect(_ imageWidth: Int, _ imageHeight: Int) -> PixelRect {
        let fit = min(1, Float(width / 4) / Float(imageWidth), Float(height / 2) / Float(imageHeight))
        return PixelRect(x: 0, y: 0, width: Float(imageWidth) * fit, height: Float(imageHeight) * fit)
    }

    private func drawAlertContent(_ textTexture: GLTexture?, _ image: GLTexture?) {
        var items: [(GLTexture, PixelRect)] = []
        if let image { items.append((image, alertImageRect(image.width, image.height))) }
        if let textTexture { items.append((textTexture, PixelRect(x: 0, y: 0, width: Float(textTexture.width), height: Float(textTexture.height)))) }
        let gap: Float = 20
        var y = (Float(height) - items.reduce(0) { $0 + $1.1.height } - gap * Float(max(0, items.count - 1))) / 2
        for (texture, size) in items {
            compositor.draw(texture, in: PixelRect(x: (Float(width) - size.width) / 2, y: y, width: size.width, height: size.height), alpha: 1, blend: .over)
            y += size.height + gap
        }
    }

    /// Relative URLs (`/get?id=…`) are the server's own, and need the token.
    private func resolve(_ url: URL) -> URL? {
        if url.scheme == "http" || url.scheme == "https" { return url }
        let endpoint = session.provider.endpoint
        guard let absolute = URL(string: url.relativeString, relativeTo: endpoint.baseURL)?.absoluteURL,
              var components = URLComponents(url: absolute, resolvingAgainstBaseURL: false) else { return nil }
        if ["/get", "/save"].contains(components.path) {
            var items = components.queryItems ?? []
            // A /get alert image is a post: ask for it at the size it's drawn
            // and as JPEG, not the original (a 24 MP decode on a 1 GB Pi).
            if components.path == "/get", !items.contains(where: { ["width", "height"].contains($0.name) }) {
                items += [URLQueryItem(name: "width", value: String(width / 4)), URLQueryItem(name: "height", value: String(height / 2)),
                          URLQueryItem(name: "convert", value: "1")]
            }
            components.queryItems = items + [URLQueryItem(name: "token", value: endpoint.accessToken)]
        }
        return components.url
    }

    static func parseHex(_ hex: String) -> (Float, Float, Float) {
        var digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return (0, 0, 0) }
        return (Float((value >> 16) & 0xFF) / 255, Float((value >> 8) & 0xFF) / 255, Float(value & 0xFF) / 255)
    }

    // MARK: - Overlay

    private func syncOverlay() {
        let fontScale = scale
        let config = session.config
        let radius = Int(10 * fontScale)
        let layout = (clock: config.showClock, seconds: config.showSeconds, date: config.showDate, sensors: config.showSensors)
        if overlayLayout.map({ $0 != layout }) ?? true {
            overlayLayout = layout
            clockText = ("", "")
            sensorLines = []
            dirty = true
        }
        let clock = KioskOverlay.clock(seconds: config.showSeconds)
        if clock != clockText {
            if clock.time != clockText.time {
                clockTexture = config.showClock ? text.box([clock.time], size: Int(48 * fontScale), rightAligned: false, radius: radius)?.texture() : nil
            }
            if clock.date != clockText.date {
                dateTexture = config.showDate ? text.box([clock.date], size: Int(48 * fontScale), rightAligned: false, radius: radius)?.texture() : nil
            }
            clockText = clock
            dirty = true
        }

        let lines = config.showSensors ? KioskOverlay.sensorLines(session.sensors) : []
        if lines != sensorLines {
            sensorLines = lines
            sensorsTexture = lines.isEmpty ? nil : text.box(lines, size: Int(26 * fontScale), rightAligned: true, radius: radius)?.texture()
            dirty = true
        }

        let status = KioskOverlay.status(session)
        if status != statusText {
            statusText = status
            statusTexture = status.flatMap {
                text.box([$0], size: Int(24 * fontScale), rightAligned: false, padding: (16, 10), background: (122, 31, 31, 230),
                         color: SDL_Color(r: 255, g: 255, b: 255, a: 255), radius: radius)?.texture()
            }
            dirty = true
        }

        let rows = session.isMenuOpen ? session.menuRows : []
        if rows != menuRows {
            menuRows = rows
            menuTexture = rows.isEmpty ? nil : text.menu(
                title: "Settings",
                subtitle: "\(session.config.deviceId) · \(width)×\(height)",
                rows: rows,
                footer: "↑↓ or 2 8 move   ←→ or 4 6 change   5 or Enter select   M or 0 close",
                scale: Double(min(fontScale, Float(height) / Float(max(1, menuNaturalHeight(rows: rows))) * 0.94))
            )?.texture()
            dirty = true
        }

        let toasts = session.toasts.all
        if toasts.map(\.id) != toastTextures.map(\.id) {
            toastTextures = toasts.compactMap { toast in
                if let existing = toastTextures.first(where: { $0.id == toast.id }) { return existing }
                let edge = session.thumbnailSize
                let thumbnail = toast.thumbnail.flatMap { RGBAImage.decode($0, maxWidth: edge, maxHeight: edge) }
                guard let image = text.box([toast.text], size: Int(22 * fontScale), rightAligned: false, padding: (Int(14 * fontScale), Int(8 * fontScale)),
                                           background: (40, 40, 42, 235), color: SDL_Color(r: 255, g: 255, b: 255, a: 255),
                                           leading: thumbnail, imageGap: Int(10 * fontScale), radius: Int(8 * fontScale)) else { return nil }
                return (toast.id, image.texture())
            }
            dirty = true
        }
    }

    /// The menu's height at 1080p scale 1, to shrink it on a short screen.
    private func menuNaturalHeight(rows: [KioskMenuRow]) -> Int {
        36 * 2 + 64 + rows.reduce(0) { $0 + 46 + ($1.section != nil ? 44 : 0) } + 56
    }

    private func drawOverlay() {
        let margin = 30 * scale
        if let clockTexture {
            draw(clockTexture, x: margin, y: Float(height) - Float(clockTexture.height) - margin)
        }
        if let dateTexture {
            draw(dateTexture, x: Float(width) - Float(dateTexture.width) - margin, y: Float(height) - Float(dateTexture.height) - margin)
        }
        if let sensorsTexture {
            draw(sensorsTexture, x: Float(width) - Float(sensorsTexture.width) - margin, y: margin)
        }
        if let statusTexture {
            draw(statusTexture, x: margin, y: margin)
        }
        // Toasts stack down from the top right, over the sensors, sliding
        // into place as they fade in.
        var y = 20 * scale
        let toasts = session.toasts.all
        for (id, texture) in toastTextures {
            let look = toasts.first { $0.id == id }?.appearance(now: now) ?? (alpha: 1, drop: 0)
            draw(texture, x: Float(width) - Float(texture.width) - 20 * scale, y: y - Float(look.drop) * 20 * scale, alpha: Float(look.alpha))
            y += (Float(texture.height) + 8 * scale) * Float(min(1, look.alpha * 2))
        }
        if let menuTexture {
            compositor.fill(PixelRect(x: 0, y: 0, width: Float(width), height: Float(height)), red: 0, green: 0, blue: 0, alpha: 0.45)
            draw(menuTexture, x: (Float(width) - Float(menuTexture.width)) / 2, y: (Float(height) - Float(menuTexture.height)) / 2)
        }
    }

    private func draw(_ texture: GLTexture, x: Float, y: Float, alpha: Float = 1) {
        compositor.draw(texture, in: PixelRect(x: x.rounded(), y: y.rounded(), width: Float(texture.width), height: Float(texture.height)), alpha: alpha, blend: .over)
    }

    // MARK: - Input

    private func pollInput() {
        var event = SDL_Event()
        while SDL_PollEvent(&event) != 0 {
            switch event.type {
            case SDL_QUIT.rawValue:
                quit()
            case SDL_KEYDOWN.rawValue:
                // X auto-repeats a held key (the keypad's passthrough keys
                // too): one press is one action, as in native-kiosk. Only the
                // menu's arrows repeat, to scroll.
                if event.key.repeat != 0 {
                    let arrows = [SDLK_UP, SDLK_DOWN, SDLK_LEFT, SDLK_RIGHT].map { Int($0.rawValue) }
                    guard session.isMenuOpen, arrows.contains(Int(event.key.keysym.sym)) else { break }
                }
                handleKey(event.key.keysym)
            case SDL_WINDOWEVENT.rawValue:
                if event.window.event == UInt8(SDL_WINDOWEVENT_SIZE_CHANGED.rawValue) { resized() }
                dirty = true
            default:
                break
            }
        }
    }

    private func handleKey(_ key: SDL_Keysym) {
        let control = Int(key.mod) & Int(KMOD_CTRL.rawValue) != 0
        switch Int(key.sym) {
        case Int(SDLK_ESCAPE.rawValue):
            // Closes the menu; otherwise, like native-kiosk, quits: the
            // launcher's xinit ends with us, and getty starts the session again.
            guard session.isMenuOpen else { quit() }
            session.handleKey(.escape)
        case Int(SDLK_RIGHT.rawValue):
            session.handleKey(.right)
        case Int(SDLK_LEFT.rawValue):
            session.handleKey(.left)
        case Int(SDLK_UP.rawValue):
            session.handleKey(.up)
        case Int(SDLK_DOWN.rawValue):
            session.handleKey(.down)
        case Int(SDLK_RETURN.rawValue), Int(SDLK_KP_ENTER.rawValue):
            session.handleKey(.enter)
        case Int(SDLK_BACKSPACE.rawValue):
            session.handleKey(.backspace)
        case Int(SDLK_KP_0.rawValue):
            session.handleKey(.character("0"))
        case Int(SDLK_KP_1.rawValue)...Int(SDLK_KP_9.rawValue):
            // SDL numbers the keypad 1-9 and then 0, so 0 is its own case.
            session.handleKey(.character(Character(String(Int(key.sym) - Int(SDLK_KP_1.rawValue) + 1))))
        case 32..<127:
            session.handleKey(.character(Character(UnicodeScalar(UInt8(key.sym))), control: control))
        default:
            break
        }
    }

    /// Ends the process now, status 0. exit() would run atexit handlers and
    /// library teardown while mpv's and Mesa's threads are still running; a
    /// crash in there reads as a failure to run-kiosk, which then gives up
    /// on this frontend for native-kiosk.
    private func quit() -> Never {
        player?.stop()
        audioPlayer?.stop()
        fflush(nil)
        _exit(0)
    }

    private func resized() {
        var drawableWidth: Int32 = 0, drawableHeight: Int32 = 0
        SDL_GL_GetDrawableSize(window, &drawableWidth, &drawableHeight)
        guard Int(drawableWidth) != width || Int(drawableHeight) != height, drawableWidth > 0, drawableHeight > 0 else { return }
        width = Int(drawableWidth)
        height = Int(drawableHeight)
        logger.log(.info, "screen is now \(width)x\(height)")
        clockText = ("", "")
        sensorLines = []
        toastTextures = []
        statusText = nil
        menuRows = []
        front = nil
        fade = nil
        photos = [:]
        makePhotoSlots()
        session.setScreenSize(width: width, height: height)
    }
}
