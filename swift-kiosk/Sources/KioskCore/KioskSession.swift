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
   alongside, is what actually powers the panel. Hiding the photo from the
   keypad (`p`) reports the same way, but leaves the clock on screen.
 - `←` steps back through the posts this display was sent, seeded from the
   server's `/history.json`, and holds the earlier post for one interval.
   The server is never told: sessions sharing this channel share one queue,
   so going back is this display's alone. Playback frames that arrive during
   the hold wait for it to end, then the latest one applies.

 What it never does, per the protocol: run its own dwell timer, advance on a
 wake, or filter posts locally.
 */

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
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
    /// The photo hidden from the keypad; the overlay stays.
    public private(set) var isImageHidden = false
    /// Whether the slideshow is on screen: the panel on and the photo not hidden.
    public var isShowing: Bool { isPanelOn && !isImageHidden }
    public private(set) var tagLists: [[String]] = []
    public private(set) var currentList = 0
    public private(set) var alert: RoboFrameAlert?
    /// The latest effect video or live scene, for the renderer to play over the slideshow.
    public private(set) var effect: Effect?
    /// A `playAudio` clip, played alongside whatever is on screen.
    public private(set) var audio: URL?
    public private(set) var toasts = KioskToasts()
    /// Posts the server put on screen, oldest first, for `←`.
    public private(set) var history: [RoboFramePost] = []
    public static let historyLimit = 100
    /// `←` is holding an earlier post on screen.
    public var isHolding: Bool { holdTask != nil }
    /// The post on screen, which is what `b` blocks and space saves (during
    /// a `←` hold, the earlier post).
    public var currentPostID: Int? { engine.current.flatMap { RoboFramePost(slideshowItem: $0.item) }?.id }
    public var sensors: [RoboFrameSensorReading] { Array(connection.sensors.values) }

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
    var screenHeight: Int { screen.height }
    private var lastPlayback: RoboFramePlayback?
    private var backSteps = 0
    private var holdTask: Task<Void, Never>?
    private var historySeeded = false
    var awaitingTagList = false
    var isDisplaySyncOn = false

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

    public func setImageHidden(_ hidden: Bool) {
        guard hidden != isImageHidden else { return }
        isImageHidden = hidden
        showingChanged()
    }

    public func toast(_ text: String, thumbnail: Data? = nil) {
        logger.log(.info, "toast: \(text)")
        toasts.add(text, thumbnail: thumbnail, now: ProcessInfo.processInfo.systemUptime)
        onChange?()
    }

    // MARK: - Previous (←)

    /// Shows the post before the one on screen (or before the one `←` is
    /// already holding) for one interval. Returns the toast.
    func showPrevious() -> String {
        let index = history.count - 2 - backSteps
        guard index >= 0 else {
            seedHistory()
            return "No earlier image"
        }
        backSteps += 1
        let seconds = max(2, engine.displaySettings.delay)
        holdTask?.cancel()
        holdTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.endHold(resume: true)
        }
        engine.setAuthoritativeCurrent(history[index].slideshowItem)
        return "Previous"
    }

    /// Back to live playback: the latest frame when the hold runs out, or
    /// nothing yet when a key just asked the server for a new one.
    func endHold(resume: Bool) {
        guard let holdTask else { return }
        holdTask.cancel()
        self.holdTask = nil
        backSteps = 0
        if resume, let lastPlayback { apply(lastPlayback) }
    }

    private func record(_ post: RoboFramePost?) {
        guard let post, history.last?.id != post.id else { return }
        history.append(post)
        if history.count > Self.historyLimit { history.removeFirst(history.count - Self.historyLimit) }
    }

    /// Fills the history from the server's request log once, so `←` works
    /// straight after a start. What this display recorded itself stays newest.
    private func seedHistory() {
        guard !historySeeded, let url = provider.endpoint.url(path: "history.json") else { return }
        historySeeded = true
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw KioskMediaError.status((response as? HTTPURLResponse)?.statusCode ?? 0) }
                let served = try JSONDecoder().decode(RoboFrameHistory.self, from: data).history
                let local = Set(history.map(\.id))
                history = Array((served.reversed().filter { !local.contains($0.id) } + history).suffix(Self.historyLimit))
            } catch {
                historySeeded = false
                logger.log(.warning, "history seed failed: \(error.localizedDescription)")
            }
        }
    }

    public func expireToasts() {
        if toasts.expire(now: ProcessInfo.processInfo.systemUptime) { onChange?() }
    }

    /// The renderer finished (or couldn't play) the effect.
    public func effectEnded() {
        guard effect != nil else { return }
        effect = nil
        onChange?()
    }

    public func audioEnded() {
        audio = nil
    }

    // MARK: - Protocol

    private func didConnect() {
        logger.log(.info, "connected")
        sendSlideshowConfig()
        connection.sendGetDisplayState(target: config.deviceId)
        seedHistory()
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
        connection.reportSceneState(sessionId: Self.sessionId, deviceId: config.deviceId, present: isShowing, visible: isShowing)
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
        case .playAudio(let url):
            audio = url
            onChange?()
        case .stopAudio:
            audio = nil
            onChange?()
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
        lastPlayback = playback
        guard !isHolding else { return }
        record(playback.current)
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
        showingChanged()
    }

    private func showingChanged() {
        engine.setVisible(isShowing)
        // Back on, the server commits a fresh post (it dark-advanced while the
        // panel was off) and announces it; that frame's transition is the
        // next report. The parked one is never re-confirmed.
        reportScene()
        onChange?()
    }

    private func didDisplay(_ displayed: RAVESlideshowDisplayedMedia) {
        // A post `←` brought back isn't the channel's, so it isn't reported.
        guard isShowing, !isHolding, let post = RoboFramePost(slideshowItem: displayed.item), reportedReadyID != post.id else { return }
        reportedReadyID = post.id
        logger.log(.info, "showing post \(post.id) (\(post.ext, privacy: .public))")
        connection.sendImageReady(sessionId: Self.sessionId, postId: post.id, durationMs: post.durationMs)
    }
}
