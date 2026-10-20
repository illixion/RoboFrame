/*
 Kiosk session

 One display, one session (`main`) on a `RoboFrameConnection`, driving the
 shared `RAVESlideshowEngine` in its server-driven mode:

 - Every `playback.current` becomes the engine's authoritative item; the
   upcoming list bounds its prefetch (1 deep: a Pi 3 has 1 GB).
 - The engine's finished transition is the frame on screen, and that is when
   `imageReady` goes out, once per post. A video post goes out once the
   player is actually playing it, not when the engine hands over its URL,
   with its indexed length (or the player's, when the library has none) so
   the server dwells for the whole clip. Every `slideshowConfig` re-arms the
   report: the server answers one by re-announcing the frame on screen and
   waiting for it to be confirmed again.
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
 - What space saves and `b` blocks (`target`) trails an automatic advance by
   `targetGrace`. The keypad sends a key when the button comes back up, and
   saving is a hold, so a press that started on one post often lands just
   after the next one faded in; it still means the post it started on. A
   post reached with `→` or `←` is the target at once: it was asked for.
 - `setBrightness` below `minimumBrightness` for this deviceId hides the
   slideshow like `p` does, as the web kiosk treats it.
 - `bright` is the config's, or on during the night-light window. A change
   re-sends `slideshowConfig` (the server prefetches the variant this
   display asks for) and drops what was prefetched under the old one.

 What it never does, per the protocol: run its own dwell timer, advance on a
 wake, or filter posts locally.
 */

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RAVENet
import RoboFrameKit
import RAVESlideshowCore

@MainActor
public final class KioskSession {
    public static let sessionId = "main"

    public private(set) var config: KioskConfig
    public let settings: KioskSettingsStore
    public let engine: RAVESlideshowEngine
    public let connection: RoboFrameConnection
    public let provider: KioskMediaProvider

    /// Panel power as the server last reported it.
    public private(set) var isPanelOn = true
    /// The photo hidden from the keypad; the overlay stays.
    public private(set) var isImageHidden = false
    /// `setBrightness` turned the slideshow down below `minimumBrightness`.
    public private(set) var isDimmedOut = false
    public static let minimumBrightness = 16
    /// Whether the slideshow is on screen: the panel on and the photo not hidden.
    public var isShowing: Bool { isPanelOn && !isImageHidden && !isDimmedOut }
    /// `bright` as the server should render it: configured, or the night light.
    public private(set) var effectiveBright = false
    /// The socket has been down long enough to say so on screen.
    public private(set) var isOffline = false
    public static let offlineAfter: TimeInterval = 10
    /// Something the person at the frame should know, until it's resolved.
    public private(set) var banner: Banner?
    /// The settings menu, while it's open.
    public internal(set) var menu: KioskMenuState?
    public private(set) var tagLists: [[String]] = []
    public internal(set) var currentList = 0
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
    /// What `b` blocks and space saves: the post on screen, or for
    /// `targetGrace` after an automatic advance, the one before it.
    public private(set) var target: RAVESlideshowDisplayedMedia?
    public var currentPostID: Int? { target.flatMap { RoboFramePost(slideshowItem: $0.item) }?.id }
    public static let targetGrace: TimeInterval = 1.5
    /// How long a `→`/`←` press keeps the next frame's target immediate,
    /// bounding the wait for the server's reply.
    public static let navIntentWindow: TimeInterval = 10
    public var sensors: [RoboFrameSensorReading] { Array(connection.sensors.values) }

    public enum Effect: Equatable, Sendable {
        case video(URL)
        case scene(URL)
    }

    public enum Banner: Equatable, Sendable {
        /// The server refused this kiosk (a bad token): it won't reconnect.
        case halted(String)
        /// The channel's query matches nothing, so nothing will play.
        case searchEmpty

        public var text: String {
            switch self {
            case .halted: "The server refused this frame's access token. Check accessToken in the config."
            case .searchEmpty: "No posts match this frame's tags. Pick another tag list in the menu."
            }
        }
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
    /// The renderer's latest screen size, applied once the panel has been on
    /// for `screenSettle`.
    private var reportedScreen: (width: Int, height: Int)?
    /// When the panel last came on; the distant past until it first goes off.
    private var panelOnSince: TimeInterval = -.infinity
    var screenSettle: TimeInterval = 2
    /// Smaller than any panel this kiosk drives; see `setScreenSize`.
    static let minimumScreen = (width: 640, height: 360)
    private var lastPlayback: RoboFramePlayback?
    private var backSteps = 0
    private var holdTask: Task<Void, Never>?
    private var historySeeded = false
    private var targetTask: Task<Void, Never>?
    private var navIntentUntil: TimeInterval = 0
    private var ticker: Task<Void, Never>?
    private var lastConnected: TimeInterval
    private var failedVideos: [Int: Int] = [:]
    /// A video post on screen whose player hasn't started yet.
    private var awaitingVideo: RAVESlideshowDisplayedMedia?
    /// The video the player last started, and its length in ms when known.
    private var startedVideo: (id: String, durationMs: Int?)?
    var awaitingTagList = false
    public internal(set) var isDisplaySyncOn = false
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    public init(config: KioskConfig, logger: any RAVENetLogger = RAVENetOSLogger(subsystem: "roboframe.kiosk", category: "session")) throws {
        guard let endpoint = RoboFrameEndpoint(webSocketURL: config.webSocketURL, accessToken: config.accessToken, deviceId: config.deviceId),
              let socketURL = endpoint.webSocketURL else {
            throw KioskConfig.LoadError.badWebSocketURL
        }
        self.config = config
        self.logger = logger
        self.screen = (config.screenWidth, config.screenHeight)
        settings = KioskSettingsStore(path: config.settingsPath)
        lastConnected = ProcessInfo.processInfo.systemUptime
        effectiveBright = config.bright || (config.nightLight?.isActive() ?? false)
        var media = config
        media.bright = effectiveBright
        provider = KioskMediaProvider(endpoint: endpoint, config: media)
        connection = RoboFrameConnection(url: socketURL, logger: logger)
        engine = RAVESlideshowEngine(
            provider: provider,
            displaySettings: RAVESlideshowDisplaySettings(
                delay: TimeInterval(config.intervalMs) / 1_000,
                transitionDuration: config.transitionDuration,
                // The renderer draws its own Ken Burns; the engine only times frames.
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
            self?.transitioned(to: displayed)
        }
    }

    public func start() {
        engine.start()
        let handlers = connection.attachSession(Self.sessionId)
        handlers.onMessage = { [weak self] message in self?.handle(message) }
        handlers.onConnected = { [weak self] in self?.didConnect() }
        self.handlers = handlers
        reportScene()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.tick()
            }
        }
    }

    public func stop() {
        ticker?.cancel()
        connection.detachSession(Self.sessionId)
        connection.disconnect()
        engine.stop()
    }

    /// The real display mode, once the renderer knows it. Re-joins the
    /// channel so the server's prefetch is keyed to the new size.
    ///
    /// Not while the panel is off, nor in the moment after it comes on:
    /// node-display turns the panel off by disabling X's output, which drops
    /// the screen to 320x200 until it's back. That isn't a size to fetch
    /// posts at, and each re-join makes the server restart the channel (it
    /// re-commits the frame, and with nobody present runs its dwell blind).
    /// The size the renderer last reported is applied once the panel has
    /// been on for `screenSettle`, from `tick`.
    ///
    /// Never one below `minimumScreen`, whatever the panel state: that is X
    /// with no output enabled (320x200 on VC4), which a panel cut without a
    /// `displayState` would otherwise pass off as the real mode.
    public func setScreenSize(width: Int, height: Int) {
        guard width >= Self.minimumScreen.width, height >= Self.minimumScreen.height else { return }
        reportedScreen = (width, height)
        applyScreenSize()
    }

    private func applyScreenSize() {
        guard let reported = reportedScreen, isPanelOn, now - panelOnSince >= screenSettle else { return }
        reportedScreen = nil
        guard reported != screen else { return }
        screen = reported
        provider.setScreenSize(width: reported.width, height: reported.height)
        if connection.isConnected { sendSlideshowConfig() }
    }

    /// Once a second: the offline badge, the night light, the menu's timeout.
    func tick() {
        let now = self.now
        if connection.isConnected { lastConnected = now }
        let offline = banner == nil && now - lastConnected >= Self.offlineAfter
        if offline != isOffline {
            isOffline = offline
            logger.log(offline ? .warning : .info, offline ? "offline" : "back online")
            onChange?()
        }
        updateBright()
        applyScreenSize()
        if let menu, now - menu.lastInput >= KioskMenuState.timeout {
            self.menu = nil
            onChange?()
        }
    }

    /// Applies a changed setting: saved, then acted on.
    func update(_ key: String, _ value: JSONValue, _ change: (inout KioskConfig) -> Void) {
        update([key: value], change)
    }

    func update(_ values: [String: JSONValue], _ change: (inout KioskConfig) -> Void) {
        let before = config
        change(&config)
        guard config != before else { return }
        for (key, value) in values.sorted(by: { $0.key < $1.key }) where !settings.set(key, value) {
            logger.log(.warning, "couldn't save the setting \(key, privacy: .public)")
        }
        if config.intervalMs != before.intervalMs {
            var display = engine.displaySettings
            display.delay = TimeInterval(config.intervalMs) / 1_000
            engine.displaySettings = display
            if connection.isConnected { sendSlideshowConfig() }
        }
        if config.transitionDuration != before.transitionDuration {
            var display = engine.displaySettings
            display.transitionDuration = config.transitionDuration
            engine.displaySettings = display
        }
        if config.bright != before.bright || config.nightLight != before.nightLight { updateBright() }
        onChange?()
    }

    private func updateBright() {
        let bright = config.bright || (config.nightLight?.isActive() ?? false)
        guard bright != effectiveBright else { return }
        effectiveBright = bright
        logger.log(.info, "bright \(bright ? "on" : "off", privacy: .public)")
        provider.setBright(bright)
        // What was prefetched is the other variant; the next playback
        // frame fetches the upcoming post again.
        engine.prunePrefetched(keeping: [])
        if connection.isConnected { sendSlideshowConfig() }
    }

    // MARK: - Local controls (keypad)

    public func requestNext() {
        markNavIntent()
        connection.sendRequestNext(sessionId: Self.sessionId)
    }

    /// The next frame was asked for (it replaces a post the person moved
    /// past, blocked or reshuffled away), so it is the target at once.
    private func markNavIntent() { navIntentUntil = now + Self.navIntentWindow }
    public func reshuffle() {
        markNavIntent()
        connection.sendReshuffle(sessionId: Self.sessionId)
    }
    public func setTagList(_ index: Int) {
        markNavIntent()
        connection.sendSetTagList(sessionId: Self.sessionId, listNumber: index)
    }
    public func setDisplaySync(_ enabled: Bool) { connection.sendDisplaySync(sessionId: Self.sessionId, enabled: enabled) }
    public func blockCurrent() {
        guard let id = currentPostID else { return }
        markNavIntent()
        connection.sendBlock(postId: id)
    }

    public func setImageHidden(_ hidden: Bool) {
        guard hidden != isImageHidden else { return }
        isImageHidden = hidden
        showingChanged()
    }

    public func toast(_ text: String, thumbnail: Data? = nil) {
        logger.log(.info, "toast: \(text)")
        toasts.add(text, thumbnail: thumbnail, now: now)
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
        markNavIntent()
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
        if toasts.expire(now: now) { onChange?() }
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

    /// The renderer's player started the video post `id` (or found it can't
    /// play video at all: `durationMs` nil and no player). That is when it is
    /// on screen, so its `imageReady` goes out now if it was waiting.
    public func videoStarted(_ id: String, durationMs: Int?) {
        startedVideo = (id, durationMs)
        guard let waiting = awaitingVideo, waiting.item.id == id else { return }
        awaitingVideo = nil
        didDisplay(waiting)
    }

    /// The renderer couldn't play a video post. One more try, as a network
    /// blip deserves; a second failure skips it, since the server would
    /// otherwise hold the channel on it until its readiness timeout.
    /// Returns whether to retry.
    public func videoFailed(_ id: String) -> Bool {
        guard let postID = Int(id) else { return false }
        let failures = failedVideos[postID, default: 0] + 1
        failedVideos = failedVideos.filter { $0.key == postID }
        failedVideos[postID] = failures
        guard failures >= 2 else { return true }
        if !isHolding, engine.current?.item.id == id || engine.incoming?.item.id == id { requestNext() }
        return false
    }

    private func didConnect() {
        logger.log(.info, "connected")
        lastConnected = now
        if case .halted = banner { banner = nil }
        sendSlideshowConfig()
        connection.sendGetDisplayState(target: config.deviceId)
        seedHistory()
    }

    private func sendSlideshowConfig() {
        // The server re-announces the frame on screen when a lone session
        // re-joins, and waits for it to be confirmed again.
        reportedReadyID = nil
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
            bright: effectiveBright,
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
        case .brightness(let target, let value) where target == config.deviceId:
            let dimmedOut = value < Self.minimumBrightness
            if dimmedOut != isDimmedOut {
                isDimmedOut = dimmedOut
                showingChanged()
            }
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
            if banner == nil { banner = .searchEmpty; onChange?() }
        case .halted(let reason):
            logger.log(.error, "connection halted: \(reason)")
            banner = .halted(reason)
            isOffline = false
            onChange?()
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
        if playback.current != nil, banner == .searchEmpty { banner = nil; onChange?() }
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
        if on { panelOnSince = now }
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

    private func transitioned(to displayed: RAVESlideshowDisplayedMedia) {
        retarget(displayed)
        didDisplay(displayed)
    }

    private func retarget(_ displayed: RAVESlideshowDisplayedMedia) {
        targetTask?.cancel()
        targetTask = nil
        let asked = now < navIntentUntil
        if asked { navIntentUntil = 0 }
        guard target != nil, !asked else {
            target = displayed
            return
        }
        targetTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.targetGrace))
            guard !Task.isCancelled, let self else { return }
            self.target = self.engine.current ?? displayed
            self.targetTask = nil
        }
    }

    private func didDisplay(_ displayed: RAVESlideshowDisplayedMedia) {
        // A post `←` brought back isn't the channel's, so it isn't reported.
        guard isShowing, !isHolding, let post = RoboFramePost(slideshowItem: displayed.item), reportedReadyID != post.id else { return }
        var durationMs = post.durationMs
        if case .video = displayed.media {
            guard let started = startedVideo, started.id == displayed.item.id else {
                awaitingVideo = displayed
                return
            }
            durationMs = durationMs ?? started.durationMs
        }
        awaitingVideo = nil
        reportedReadyID = post.id
        logger.log(.info, "showing post \(post.id) (\(post.ext, privacy: .public))")
        connection.sendImageReady(sessionId: Self.sessionId, postId: post.id, durationMs: durationMs)
    }
}
