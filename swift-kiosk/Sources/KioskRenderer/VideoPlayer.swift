/*
 Video through libmpv

 One mpv instance, drawn through its render API into a GL texture the
 compositor owns, so a video fades in and out like a photo and the overlay
 is drawn over it in the same frame. native-kiosk runs mpv as a separate
 process embedded with --wid instead, which can't fade and needed evdev
 grabs to keep keys away from mpv's window; neither applies here.

 There is exactly one instance on purpose: the Pi 3 has 1 GB and no swap,
 and a second decoder is what used to OOM it. A new file replaces the old
 one; the old one's texture keeps its last frame, which is what fades out.
 An audio-only `playAudio` clip gets its own instance with no video output.

 Events are matched to the file they belong to by mpv's playlist entry id.
 mpv's queue still holds whatever the previous file reported before the
 `loadfile` (a looping clip wrapping around, an end of file), and taken for
 the new file's, a stale restart faded in a black target and a stale end
 skipped a clip that hadn't started.

 Nothing here waits on mpv's core from the caller's thread, the kiosk's
 render loop. Commands and property reads run on a serial queue of their
 own: on the Pi the core thread is also the decoder's, and once the
 firmware's video service stops answering, a V4L2 call there sleeps in the
 kernel for good. A synchronous call from the render loop then froze the
 screen on whatever it last drew, with the panel coming and going around
 it. A command that has been running for `hangLimit` marks the player hung;
 the renderer stops handing it videos, and the Pi's decoder watchdog
 reboots (nothing short of that brings the decoder back).

 A load is also never interrupted while it opens. A `stop` or a new `load`
 that arrives before the current one has shown its first frame or failed
 waits for it (up to `settleLimit`): stopping the V4L2 decoder while it is
 still allocating its buffers is what wedged the firmware, and panel cuts,
 which stop the video and load it again on wake, made that common.

 mpv needs LC_NUMERIC=C, set once before the first instance.
 */

import CMpv
import CSDL2
import Foundation
import Glibc

/// Unchecked: the state under `lock` is what the control queue touches; the
/// rest belongs to the caller's thread.
final class VideoPlayer: @unchecked Sendable {
    enum Event: Equatable {
        /// The first frame of the file is up (or it resumed after a seek).
        case started
        /// It played to the end (only when not looping).
        case finished
        case failed(String)
    }

    struct Options: Equatable {
        var loop = true
        var audio = false
        /// Live streams: no buffering, RTSP over TCP.
        var lowLatency = false
        /// Pause on the last frame at the end instead of finishing: a
        /// slideshow clip stays up until the server moves on. Effects and
        /// audio finish, so the session hears that they ended.
        var holdLastFrame = false
    }

    /// What mpv says about the file that started.
    struct Info {
        var codec: String?
        var width: String?
        var height: String?
        var hwdec: String?
        var duration: Double?
    }

    private enum Request {
        case load(URL, Options)
        case stop
    }

    /// An event of a file, kept until the load it may belong to has its
    /// playlist entry id.
    private enum FileEvent {
        case start(Int64)
        case restart
        case end(Int64, mpv_end_file_reason, Int32)
    }

    /// How long a command may run before the player counts as hung.
    static let hangLimit: TimeInterval = 20
    /// How long a stop or a new load waits for the opening one to settle.
    static let settleLimit: TimeInterval = 20

    private let handle: OpaquePointer
    private var renderContext: OpaquePointer?
    private let control = DispatchQueue(label: "roboframe.kiosk.mpv")
    private let log: (String) -> Void

    // Shared with the control queue, under `lock`.
    private let lock = NSLock()
    /// The playlist entry the last `load` made, once `loadfile` has returned.
    /// Nil while resolved means mpv didn't say: every event is taken as the
    /// current file's, as before ids were matched.
    private var entryID: Int64?
    private var entryResolved = true
    private var commandSince: TimeInterval?

    // The caller's thread only.
    /// A load was sent and hasn't shown a frame or failed.
    private var loading = false
    private var loadSentAt: TimeInterval = 0
    private var entryStarted = false
    private var backlog: [FileEvent] = []
    private var deferred: Request?
    private var paused = false

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// `video: false` makes an audio-only player with no render context.
    init?(hwdec: String, video: Bool, log: @escaping (String) -> Void) {
        setlocale(LC_NUMERIC, "C")
        guard let handle = mpv_create() else { return nil }
        self.handle = handle
        self.log = log
        set("vo", video ? "libmpv" : "null")
        if !video { set("vid", "no") }
        set("hwdec", hwdec)
        // The Pi's V4L2 decoder takes its buffers from the same CMA pool as
        // every GL surface, and its defaults (20 decoded frames queued, 16
        // bitstream buffers: about 40 MB at 720p) are more than is left
        // beside X and the compositor. H.264 needs a handful of reference
        // frames; eight decoded and four input buffers keep it streaming.
        if hwdec.contains("v4l2m2m") {
            set("vd-lavc-o", "num_capture_buffers=8,num_output_buffers=4")
        }
        set("keep-open", "yes")
        set("idle", "yes")
        set("input-default-bindings", "no")
        set("osc", "no")
        set("terminal", "no")
        set("demuxer-max-bytes", "32MiB")
        set("demuxer-max-back-bytes", "16MiB")
        guard mpv_initialize(handle) >= 0 else {
            mpv_terminate_destroy(handle)
            return nil
        }
        mpv_request_log_messages(handle, "warn")
        guard video else { return }

        // libmpv resolves GL functions through SDL, from the context current on this thread.
        let getProcAddress: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> UnsafeMutableRawPointer? = { _, name in
            name.flatMap { SDL_GL_GetProcAddress($0) }
        }
        var initParams = mpv_opengl_init_params(get_proc_address: getProcAddress, get_proc_address_ctx: nil)
        var context: OpaquePointer?
        let created = MPV_RENDER_API_TYPE_OPENGL.withCString { apiType in
            withUnsafeMutablePointer(to: &initParams) { initPointer in
                var params = [
                    mpv_render_param(type: MPV_RENDER_PARAM_API_TYPE, data: UnsafeMutableRawPointer(mutating: apiType)),
                    mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, data: UnsafeMutableRawPointer(initPointer)),
                    mpv_render_param(type: MPV_RENDER_PARAM_INVALID, data: nil),
                ]
                return mpv_render_context_create(&context, handle, &params)
            }
        }
        guard created >= 0, let context else {
            log("mpv render context failed: \(String(cString: mpv_error_string(created)))")
            mpv_terminate_destroy(handle)
            return nil
        }
        renderContext = context
    }

    deinit {
        if let renderContext { mpv_render_context_free(renderContext) }
        mpv_terminate_destroy(handle)
    }

    private func set(_ name: String, _ value: String) {
        mpv_set_option_string(handle, name, value)
    }

    /// Runs `work` on the control queue, timing it for `isHung`.
    private func perform(_ work: @escaping @Sendable (OpaquePointer) -> Void) {
        control.async { [self] in
            lock.withLock { commandSince = Self.now }
            work(handle)
            lock.withLock { commandSince = nil }
        }
    }

    /// A command to mpv has been running for `hangLimit`: its core is stuck
    /// (on the Pi, in the decoder driver) and nothing sent to it will run.
    var isHung: Bool {
        lock.withLock { commandSince.map { Self.now - $0 >= Self.hangLimit } ?? false }
    }

    func load(_ url: URL, options: Options) {
        request(.load(url, options))
    }

    func stop() {
        request(.stop)
    }

    private func request(_ request: Request) {
        if loading, Self.now - loadSentAt < Self.settleLimit {
            deferred = request
            return
        }
        deferred = nil
        send(request)
    }

    private func send(_ request: Request) {
        backlog = []
        switch request {
        case .stop:
            loading = false
            entryStarted = false
            lock.withLock { entryID = nil; entryResolved = true }
            perform { handle in Self.command(handle, ["stop"]) }
        case .load(let url, let options):
            paused = false
            loading = true
            loadSentAt = Self.now
            entryStarted = false
            lock.withLock { entryID = nil; entryResolved = false }
            perform { [self] handle in
                mpv_set_property_string(handle, "loop-file", options.loop ? "inf" : "no")
                mpv_set_property_string(handle, "aid", options.audio ? "auto" : "no")
                mpv_set_property_string(handle, "cache", options.lowLatency ? "no" : "auto")
                mpv_set_property_string(handle, "rtsp-transport", "tcp")
                mpv_set_property_string(handle, "keep-open", options.holdLastFrame ? "yes" : "no")
                mpv_set_property_string(handle, "pause", "no")
                Self.command(handle, ["loadfile", url.absoluteString, "replace"])
                // `replace` leaves the new file as the playlist's only entry,
                // and the command has run by the time mpv_command returns.
                var id: Int64 = 0
                let known = mpv_get_property(handle, "playlist/0/id", MPV_FORMAT_INT64, &id) >= 0
                lock.withLock {
                    entryID = known ? id : nil
                    entryResolved = true
                }
            }
        }
    }

    private static func command(_ handle: OpaquePointer, _ arguments: [String]) {
        var cStrings = arguments.map { strdup($0) }
        defer { cStrings.forEach { free($0) } }
        cStrings.append(nil)
        cStrings.withUnsafeMutableBufferPointer { buffer in
            buffer.baseAddress!.withMemoryRebound(to: UnsafePointer<CChar>?.self, capacity: buffer.count) {
                _ = mpv_command(handle, $0)
            }
        }
    }

    func setPaused(_ paused: Bool) {
        guard paused != self.paused else { return }
        self.paused = paused
        perform { handle in mpv_set_property_string(handle, "pause", paused ? "yes" : "no") }
    }

    /// The started file's codec, size, decoder and length, read off the
    /// render loop and handed to `completion` on the main queue.
    func info(_ completion: @escaping @MainActor @Sendable (Info) -> Void) {
        perform { handle in
            func string(_ name: String) -> String? {
                guard let value = mpv_get_property_string(handle, name) else { return nil }
                defer { mpv_free(value) }
                return String(cString: value)
            }
            let info = Info(
                codec: string("video-codec"), width: string("width"), height: string("height"),
                hwdec: string("hwdec-current"),
                duration: string("duration").flatMap(Double.init).flatMap { $0.isFinite && $0 > 0 ? $0 : nil })
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(info) } }
        }
    }

    /// Everything mpv reported since the last call. Never blocks.
    func events() -> [Event] {
        while let event = mpv_wait_event(handle, 0), event.pointee.event_id != MPV_EVENT_NONE {
            switch event.pointee.event_id {
            case MPV_EVENT_START_FILE:
                guard let data = event.pointee.data else { break }
                backlog.append(.start(data.assumingMemoryBound(to: mpv_event_start_file.self).pointee.playlist_entry_id))
            case MPV_EVENT_PLAYBACK_RESTART:
                backlog.append(.restart)
            case MPV_EVENT_END_FILE:
                guard let data = event.pointee.data else { break }
                let end = data.assumingMemoryBound(to: mpv_event_end_file.self).pointee
                backlog.append(.end(end.playlist_entry_id, end.reason, end.error))
            case MPV_EVENT_LOG_MESSAGE:
                guard let data = event.pointee.data else { break }
                let message = data.assumingMemoryBound(to: mpv_event_log_message.self).pointee
                let prefix = message.prefix.map { String(cString: $0) } ?? "mpv"
                let text = message.text.map { String(cString: $0) } ?? ""
                log("mpv[\(prefix)] \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
            default:
                break
            }
        }

        var events: [Event] = []
        let (resolved, current) = lock.withLock { (entryResolved, entryID) }
        // Until `loadfile` has returned, nothing can be told apart from the
        // previous file's events; they wait.
        if resolved {
            let isCurrent: (Int64) -> Bool = { id in current == nil || id == current }
            for event in backlog {
                switch event {
                case .start(let id):
                    if isCurrent(id) { entryStarted = true }
                case .restart:
                    // Only once this load's file has started: anything
                    // before that is the previous file's.
                    if loading, entryStarted {
                        loading = false
                        events.append(.started)
                    }
                case .end(let id, let reason, let error):
                    guard isCurrent(id) else { break }
                    if reason == MPV_END_FILE_REASON_ERROR {
                        loading = false
                        events.append(.failed(String(cString: mpv_error_string(error))))
                    } else if reason == MPV_END_FILE_REASON_EOF {
                        events.append(.finished)
                    }
                }
            }
            backlog = []
        }

        // A stop or load held while the last load opened goes now. Whatever
        // that load did is no longer what the caller is waiting for.
        if let held = deferred, !loading || Self.now - loadSentAt >= Self.settleLimit {
            deferred = nil
            send(held)
            return []
        }
        return events
    }

    /// Draws the current video frame into `target` if mpv has a new one.
    /// Leaves mpv's GL state behind; the compositor resets its own.
    @discardableResult
    func renderIfNeeded(into target: GLRenderTarget) -> Bool {
        guard let renderContext else { return false }
        let flags = mpv_render_context_update(renderContext)
        guard flags & UInt64(MPV_RENDER_UPDATE_FRAME.rawValue) != 0 else { return false }
        var fbo = mpv_opengl_fbo(fbo: Int32(target.framebuffer), w: Int32(target.texture.width), h: Int32(target.texture.height), internal_format: 0)
        // Not flipped: the target's first row is the image's top, like an uploaded photo.
        var flip: Int32 = 0
        withUnsafeMutablePointer(to: &fbo) { fboPointer in
            withUnsafeMutablePointer(to: &flip) { flipPointer in
                var params = [
                    mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_FBO, data: UnsafeMutableRawPointer(fboPointer)),
                    mpv_render_param(type: MPV_RENDER_PARAM_FLIP_Y, data: UnsafeMutableRawPointer(flipPointer)),
                    mpv_render_param(type: MPV_RENDER_PARAM_INVALID, data: nil),
                ]
                _ = mpv_render_context_render(renderContext, &params)
            }
        }
        return true
    }

    /// Tells mpv a frame went to the screen, for its frame timing.
    func reportSwap() {
        if let renderContext { mpv_render_context_report_swap(renderContext) }
    }
}
