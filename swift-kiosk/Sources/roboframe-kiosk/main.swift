/*
 roboframe-kiosk

 Runs one display's session: joins its channel, follows playback, reports
 each frame. This build has no renderer yet (frames are loaded and reported,
 not drawn), which is enough to prove the protocol path on a real server
 alongside the Python kiosk; an SDL window comes next.

 Config: ROBOFRAME_CONFIG (roboframe.config.json) plus native-kiosk's
 environment overrides. SCREEN_SIZE=1920x1080 sets the requested frame size.
 */

import Foundation
import KioskCore
#if canImport(Glibc)
import Glibc
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

let environment = ProcessInfo.processInfo.environment
let config: KioskConfig
do {
    config = try KioskConfig.load(path: environment["ROBOFRAME_CONFIG"], environment: environment)
} catch {
    FileHandle.standardError.write(Data("roboframe-kiosk: \(error)\n".utf8))
    exit(1)
}

let session = try MainActor.assumeIsolated {
    let session = try KioskSession(config: config)
    session.onRefresh = { reexec() }
    session.start()
    return session
}

withExtendedLifetime(session) {
    dispatchMain()
}
