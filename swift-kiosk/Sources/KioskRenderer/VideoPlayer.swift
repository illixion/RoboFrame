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

 mpv needs LC_NUMERIC=C, set once before the first instance.
 */

import CMpv
import CSDL2
import Foundation
import Glibc

final class VideoPlayer {
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
    }

    private let handle: OpaquePointer
    private var renderContext: OpaquePointer?
    private var loading = false
    private var paused = false
    private let log: (String) -> Void

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

    private func setProperty(_ name: String, _ value: String) {
        mpv_set_property_string(handle, name, value)
    }

    private func command(_ arguments: [String]) {
        var cStrings = arguments.map { strdup($0) }
        defer { cStrings.forEach { free($0) } }
        cStrings.append(nil)
        cStrings.withUnsafeMutableBufferPointer { buffer in
            buffer.baseAddress!.withMemoryRebound(to: UnsafePointer<CChar>?.self, capacity: buffer.count) {
                _ = mpv_command(handle, $0)
            }
        }
    }

    func load(_ url: URL, options: Options) {
        setProperty("loop-file", options.loop ? "inf" : "no")
        setProperty("aid", options.audio ? "auto" : "no")
        setProperty("cache", options.lowLatency ? "no" : "auto")
        setProperty("rtsp-transport", "tcp")
        setProperty("pause", "no")
        paused = false
        loading = true
        command(["loadfile", url.absoluteString, "replace"])
    }

    /// A property as text (`hwdec-current`, `video-codec`), or nil if unset.
    func property(_ name: String) -> String? {
        guard let value = mpv_get_property_string(handle, name) else { return nil }
        defer { mpv_free(value) }
        return String(cString: value)
    }

    func stop() {
        loading = false
        command(["stop"])
    }

    func setPaused(_ paused: Bool) {
        guard paused != self.paused else { return }
        self.paused = paused
        setProperty("pause", paused ? "yes" : "no")
    }

    /// Everything mpv reported since the last call. Never blocks.
    func events() -> [Event] {
        var events: [Event] = []
        while let event = mpv_wait_event(handle, 0), event.pointee.event_id != MPV_EVENT_NONE {
            switch event.pointee.event_id {
            case MPV_EVENT_PLAYBACK_RESTART:
                if loading {
                    loading = false
                    events.append(.started)
                }
            case MPV_EVENT_END_FILE:
                guard let data = event.pointee.data else { break }
                let end = data.assumingMemoryBound(to: mpv_event_end_file.self).pointee
                if end.reason == MPV_END_FILE_REASON_ERROR {
                    loading = false
                    events.append(.failed(String(cString: mpv_error_string(end.error))))
                } else if end.reason == MPV_END_FILE_REASON_EOF {
                    events.append(.finished)
                }
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
