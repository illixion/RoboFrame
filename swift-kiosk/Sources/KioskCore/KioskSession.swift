/*
 Kiosk session

 One display, one session (`main`) on a `RoboFrameConnection`, driving the
 shared `RAVESlideshowEngine` in its server-driven mode:

 - Every `playback.current` becomes the engine's authoritative item; the
   upcoming list bounds its prefetch (1 deep: a Pi 3 has 1 GB).
 - The engine's finished transition is the frame on screen, and that is when
   `imageReady` goes out, once per post, with a video's indexed length so
   the server dwells for the whole clip.
 - `displayState` for this deviceId is the panel: off reports the session
   absent and invisible and stops reporting `imageReady` (a hidden session is
   outside the readiness barrier), on reports it back. node-display, running
   alongside, is what actually powers the panel.

 What it never does, per the protocol: run its own dwell timer, advance on a
 wake, or filter posts locally.
 */

import Foundation
import RAVENet
import RAVERoboFrame
import RAVESlideshowCore

@MainActor
public final class KioskSession {
    public static let sessionId = "main"

    public let config: KioskConfig
    public let engine: RAVESlideshowEngine
    public let connection: RoboFrameConnection
    public let provider: KioskMediaProvider

    /// Panel power as the server last reported it.
    public private(set) var isPanelOn = true
    public private(set) var tagLists: [[String]] = []
    public private(set) var currentList = 0
    public private(set) var alert: RoboFrameAlert?
    /// The latest effect video or live scene, for the renderer to play over the slideshow.
    public private(set) var effect: Effect?

    public enum Effect: Equatable, Sendable {
        case video(URL)
        case scene(URL)
    }

    /// The server asked for a reload (`refresh`).
    public var onRefresh: (() -> Void)?
    /// Anything the renderer should redraw for (alert, effect, panel state).
    public var onChange: (() -> Void)?

    private let logger: any RAVENetLogger
    private var handlers: RoboFrameSessionHandlers?
    private var reportedReadyID: Int?
    private var screen: (width: Int, height: Int)

    public init(config: KioskConfig, logger: any RAVENetLogger = RAVENetOSLogger(subsystem: "roboframe.kiosk", category: "session")) throws {
        guard let endpoint = RoboFrameEndpoint(webSocketURL: config.webSocketURL, accessToken: config.accessToken, deviceId: config.deviceId),
              let socketURL = endpoint.webSocketURL else {
            throw KioskConfig.LoadError.badWebSocketURL
        }
        self.config = config
        self.logger = logger
        self.screen = (config.screenWidth, config.screenHeight)
        provider = KioskMediaProvider(endpoint: endpoint, config: config)
        connection = RoboFrameConnection(url: socketURL, logger: logger)
        engine = RAVESlideshowEngine(
            provider: provider,
            displaySettings: RAVESlideshowDisplaySettings(
                delay: TimeInterval(config.intervalMs) / 1_000,
                transitionDuration: config.transitionDuration,
                enableKenBurns: false
            ),
            configuration: RAVESlideshowConfiguration(
                prefetchLimit: 1,
                serverDriven: true,
                automaticAdvancement: false,
                platformCapabilities: .iOSFallback
            )
        )
        engine.onTransition = { [weak self] displayed in
            self?.didDisplay(displayed)
        }
    }

    public func start() {
        engine.start()
        let handlers = connection.attachSession(Self.sessionId)
        handlers.onMessage = { [weak self] message in self?.handle(message) }
        handlers.onConnected = { [weak self] in self?.didConnect() }
        self.handlers = handlers
        reportScene()
    }

    public func stop() {
        connection.detachSession(Self.sessionId)
        connection.disconnect()
        engine.stop()
    }

    /// The real display mode, once the renderer knows it. Re-joins the
    /// channel so the server's prefetch is keyed to the new size.
    public func setScreenSize(width: Int, height: Int) {
        guard width > 0, height > 0, (width, height) != screen else { return }
        screen = (width, height)
        provider.setScreenSize(width: width, height: height)
        if connection.isConnected { sendSlideshowConfig() }
    }

    // MARK: - Local controls (keypad)

    public func requestNext() { connection.sendRequestNext(sessionId: Self.sessionId) }
    public func reshuffle() { connection.sendReshuffle(sessionId: Self.sessionId) }
    public func setTagList(_ index: Int) { connection.sendSetTagList(sessionId: Self.sessionId, listNumber: index) }
    public func setDisplaySync(_ enabled: Bool) { connection.sendDisplaySync(sessionId: Self.sessionId, enabled: enabled) }
    public func blockCurrent() {
        guard let post = engine.current.flatMap({ RoboFramePost(slideshowItem: $0.item) }) else { return }
        connection.sendBlock(postId: post.id)
    }

    // MARK: - Protocol

    private func didConnect() {
        logger.log(.info, "connected")
        sendSlideshowConfig()
        connection.sendGetDisplayState(target: config.deviceId)
    }

    private func sendSlideshowConfig() {
        let ratio = config.ratioFilter && screen.height > 0
            ? (Double(screen.width) / Double(screen.height) * 10_000).rounded() / 10_000
            : nil
        connection.sendSlideshowConfig(sessionId: Self.sessionId, RoboFrameSlideshowConfig(
            deviceId: config.deviceId,
            intervalMs: config.intervalMs,
            modTags: config.modTags,
            ratio: ratio,
            width: screen.width,
            height: screen.height,
            bright: config.bright,
            convert: true,
            lowmem: config.lowmem
        ))
    }

    private func reportScene() {
        connection.reportSceneState(sessionId: Self.sessionId, deviceId: config.deviceId, present: isPanelOn, visible: isPanelOn)
    }

    func handle(_ message: RoboFrameMessage) {
        switch message {
        case .playback(let playback):
            apply(playback)
        case .tagLists(let lists):
            tagLists = lists
        case .currentTagList(let index):
            currentList = index
        case .displayState(let target, let on) where target == config.deviceId:
            setPanel(on: on)
        case .alert(let alert):
            self.alert = alert
            onChange?()
        case .dismissAlert:
            alert = nil
            onChange?()
        case .playVideo(let url):
            effect = .video(url)
            onChange?()
        case .playScene(let scene):
            // The kiosk's player speaks RTSP; WHEP is the web kiosk's.
            guard let rtsp = scene.rtsp else { return }
            effect = .scene(rtsp)
            onChange?()
        case .stopVideo:
            if case .video = effect { effect = nil; onChange?() }
        case .stopScene:
            // A stopScene never tears down a playVideo.
            if case .scene = effect { effect = nil; onChange?() }
        case .refresh:
            logger.log(.info, "refresh requested")
            onRefresh?()
        case .searchEmpty(let query):
            logger.log(.warning, "no posts match the channel's query: \(query)")
        case .halted(let reason):
            logger.log(.error, "connection halted: \(reason)")
        default:
            break
        }
    }

    private func apply(_ playback: RoboFramePlayback) {
        if let interval = playback.interval {
            var settings = engine.displaySettings
            settings.delay = interval
            engine.displaySettings = settings
        }
        if let list = playback.currentList { currentList = list }
        let lookahead = playback.next ?? playback.upcoming.first
        engine.setAuthoritativeNextItemID(lookahead.map { String($0.id) })
        engine.prunePrefetched(keeping: Set(playback.upcoming.map { String($0.id) }))
        engine.setAuthoritativeCurrent(playback.current?.slideshowItem)
        guard let current = playback.current, current.id != reportedReadyID else { return }
        reportedReadyID = nil
        // A post that is already on screen makes no transition, so it would
        // never be confirmed; the server re-announces one when it resumes a
        // channel it parked on this frame.
        if let shown = engine.current, shown.item.id == String(current.id), engine.incoming == nil {
            didDisplay(shown)
        }
    }

    private func setPanel(on: Bool) {
        guard on != isPanelOn else { return }
        logger.log(.info, "panel \(on ? "on" : "off", privacy: .public)")
        isPanelOn = on
        engine.setVisible(on)
        // Back on, the server commits a fresh post (it dark-advanced while the
        // panel was off) and announces it; that frame's transition is the
        // next report. The parked one is never re-confirmed.
        reportScene()
        onChange?()
    }

    private func didDisplay(_ displayed: RAVESlideshowDisplayedMedia) {
        guard isPanelOn, let post = RoboFramePost(slideshowItem: displayed.item), reportedReadyID != post.id else { return }
        reportedReadyID = post.id
        logger.log(.info, "showing post \(post.id) (\(post.ext, privacy: .public))")
        connection.sendImageReady(sessionId: Self.sessionId, postId: post.id, durationMs: post.durationMs)
    }
}
