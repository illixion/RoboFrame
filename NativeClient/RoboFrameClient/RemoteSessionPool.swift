import DebugTrace
import Foundation
import RAVENet
import RoboFrameKit

/// One `RoboFrameConnection` per server URL, shared by every window that
/// points at it; each window is a session on it. The last window to leave
/// closes the connection.
@MainActor
final class RemoteSessionPool {
    static let shared = RemoteSessionPool()
    private var connections: [URL: RoboFrameConnection] = [:]

    /// Attach a session. Nil when the profile has no usable server URL.
    func attach(sessionID: String, profile: RoboFrameProfile) -> (RoboFrameConnection, RoboFrameSessionHandlers)? {
        guard let url = profile.webSocketURL else { return nil }
        let connection = connections[url] ?? {
            let connection = RoboFrameConnection(url: url, logger: RoboFrameNetLogger())
            connections[url] = connection
            return connection
        }()
        return (connection, connection.attachSession(sessionID))
    }

    func detach(sessionID: String, profile: RoboFrameProfile) {
        guard let url = profile.webSocketURL, let connection = connections[url] else { return }
        if connection.detachSession(sessionID) == 0 {
            connection.disconnect()
            connections.removeValue(forKey: url)
        }
    }
}

/// Where the connection's lines go. RAVENet logs its endpoint without the
/// query, so this profile's access token (`?token=`) never reaches a log, and
/// hashes the host in exports; the rest keeps RAVENet's per-value privacy.
private struct RoboFrameNetLogger: RAVENetLogger {
    private static let logger = DebugLogger(subsystem: "com.illixion.roboframe.client", category: "websocket")

    func log(_ level: RAVENetLogLevel, _ message: DebugLogMessage) {
        switch level {
        case .debug: Self.logger.debug(message)
        case .info: Self.logger.info(message)
        case .warning: Self.logger.warning(message)
        case .error: Self.logger.error(message)
        }
    }
}
