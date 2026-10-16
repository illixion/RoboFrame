import Foundation
import RAVENet
import RoboFrameKit
import Testing
@testable import KioskCore

@Suite("Kiosk overlay")
struct KioskOverlayTests {
    @Test("Sensors sort by name, swap known words for emoji, and mark unavailable ones")
    func sensors() {
        let lines = KioskOverlay.sensorLines([
            RoboFrameSensorReading(entityId: "sensor.b", state: "45", friendlyName: "Bedroom Humidity", unit: "%"),
            RoboFrameSensorReading(entityId: "sensor.a", state: "21.5", friendlyName: "Attic Temperature", unit: "°C", isUnavailable: true),
            RoboFrameSensorReading(entityId: "sensor.c", state: "", friendlyName: "Cellar", unit: ""),
        ])
        #expect(lines == ["❗ Attic 🌡️: 21.5°C", "Bedroom 💧: 45%", "Cellar: N/A"])
    }

    @Test("Toasts expire after their duration and keep only the newest few")
    func toasts() {
        var toasts = KioskToasts()
        for index in 0..<6 { toasts.add("toast \(index)", now: 100) }
        #expect(toasts.all.map(\.text) == ["toast 2", "toast 3", "toast 4", "toast 5"])
        let early = toasts.expire(now: 100 + KioskToasts.duration - 0.1)
        let due = toasts.expire(now: 100 + KioskToasts.duration)
        #expect(!early && due)
        #expect(toasts.all.isEmpty)
    }

    @Test("The clock is 24-hour with seconds; the date is short")
    func clock() {
        let clock = KioskOverlay.clock(Date(timeIntervalSince1970: 0))
        #expect(clock.time.count == 8 && clock.time.split(separator: ":").count == 3)
        #expect(clock.date.contains(", "))
    }
}

@Suite("Kiosk keys")
@MainActor
struct KioskKeyTests {
    private func session() throws -> KioskSession {
        try KioskSession(config: KioskConfig(webSocketURL: URL(string: "ws://127.0.0.1:9/rpc/ws")!, accessToken: "t", deviceId: "d"),
                         logger: RAVENetSilentLogger())
    }

    @Test("s then a digit picks a tag list, and an out-of-range digit says so")
    func tagList() throws {
        let session = try session()
        #expect(session.handleKey(.character("s")) == "Tag list (0-0)?")
        #expect(session.handleKey(.character("3")) == "Tag list 3 out of range (0-0)")
        // The prompt is consumed either way: a digit after it is the dimmer again.
        #expect(session.handleKey(.character("3")) == "Brightness 30 %")
    }

    @Test("p hides the photo and reports the session hidden; the panel stays on")
    func hide() throws {
        let session = try session()
        #expect(session.handleKey(.character("p")) == "Image hidden")
        #expect(session.isImageHidden && session.isPanelOn && !session.isShowing)
        #expect(session.handleKey(.character("p")) == "Image shown")
        #expect(session.isShowing)
    }

    @Test("Keys confirm themselves with a toast")
    func toast() throws {
        let session = try session()
        session.handleKey(.right)
        session.handleKey(.character("d"))
        #expect(session.toasts.all.map(\.text) == ["Next", "Display Sync ON"])
    }

    @Test("← steps back through what the server sent and holds there; → lets go")
    func previous() throws {
        let session = try session()
        #expect(session.handleKey(.left) == "No earlier image")
        for id in [1, 2, 2, 3] {
            session.handle(.playback(RoboFramePlayback(current: RoboFramePost(id: id, ext: "jpg"))))
        }
        #expect(session.history.map(\.id) == [1, 2, 3])
        #expect(session.handleKey(.left) == "Previous" && session.isHolding)
        #expect(session.handleKey(.left) == "Previous")
        #expect(session.handleKey(.left) == "No earlier image")

        // A frame that arrives during the hold waits for it to end.
        session.handle(.playback(RoboFramePlayback(current: RoboFramePost(id: 4, ext: "jpg"))))
        #expect(session.history.map(\.id) == [1, 2, 3])
        session.endHold(resume: true)
        #expect(!session.isHolding && session.history.map(\.id) == [1, 2, 3, 4])

        session.handleKey(.left)
        session.handleKey(.right)
        #expect(!session.isHolding)
    }
}
