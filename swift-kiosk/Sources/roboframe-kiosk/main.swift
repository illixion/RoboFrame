/*
 roboframe-kiosk

 Runs one display's session: joins its channel, follows playback, reports
 each frame, and draws it fullscreen (KioskRenderer, on Linux). HEADLESS=1,
 or a build without the renderer (macOS), runs the same session without a
 window; WINDOWED=1 opens a window instead of taking the screen.

 Config: ROBOFRAME_CONFIG (roboframe.config.json) plus native-kiosk's
 environment overrides. SCREEN_SIZE=1920x1080 sets the frame size when
 there's no window to measure.
 */

import Foundation
import KioskCore
#if canImport(Glibc)
import Glibc
#endif
#if canImport(KioskRenderer)
import KioskRenderer
#endif

/// `refresh` reloads the kiosk: the process replaces itself, as the Python
/// kiosk re-execs and the web kiosk reloads its page.
func reexec() -> Never {
    #if os(Linux)
    let executable = "/proc/self/exe"
    #else
    let executable = CommandLine.arguments[0]
    #endif
    execv(executable, CommandLine.unsafeArgv)
    FileHandle.standardError.write(Data("roboframe-kiosk: re-exec failed (errno \(errno)), exiting\n".utf8))
    exit(1)
}

#if canImport(Glibc)
// Decoded photos are 8 MB buffers, freed every few seconds. glibc raises its
// mmap threshold after big frees and then serves them from heap arenas it
// never hands back, so the kiosk's RSS creeps up all day. A fixed 1 MB
// threshold keeps each photo an mmap of its own, returned on free.
// (malloc.h isn't in Swift's Glibc module; the parameter numbers are glibc's.)
@_silgen_name("mallopt") func mallopt(_ parameter: Int32, _ value: Int32) -> Int32
let M_MMAP_THRESHOLD: Int32 = -3, M_ARENA_MAX: Int32 = -8
_ = mallopt(M_MMAP_THRESHOLD, 1 << 20)
_ = mallopt(M_ARENA_MAX, 2)
#endif

let environment = ProcessInfo.processInfo.environment
let config: KioskConfig
do {
    config = try KioskConfig.load(path: environment["ROBOFRAME_CONFIG"], environment: environment)
} catch {
    FileHandle.standardError.write(Data("roboframe-kiosk: \(error)\n".utf8))
    exit(1)
}

func flag(_ name: String) -> Bool { ["1", "true", "yes"].contains(environment[name]?.lowercased() ?? "") }

/// What has to stay alive while the main queue runs.
nonisolated(unsafe) var running: [AnyObject] = []

MainActor.assumeIsolated {
    let session: KioskSession
    do {
        session = try KioskSession(config: config)
    } catch {
        FileHandle.standardError.write(Data("roboframe-kiosk: \(error)\n".utf8))
        exit(1)
    }
    session.onRefresh = { reexec() }
    #if canImport(KioskRenderer)
    if !flag("HEADLESS") {
        do {
            let renderer = try KioskRenderer(session: session, windowed: flag("WINDOWED"))
            session.start()
            renderer.run()
            running = [session, renderer]
            return
        } catch {
            FileHandle.standardError.write(Data("roboframe-kiosk: no display (\(error)); set HEADLESS=1 to run without one\n".utf8))
            exit(1)
        }
    }
    #endif
    session.start()
    running = [session]
}

// Not dispatchMain(): on Linux it exits the main thread and hands the main
// queue to a worker, and the GL context and X connection belong to the
// thread that made them. The run loop drains the main queue right here.
withExtendedLifetime(running) {
    RunLoop.main.run()
}
