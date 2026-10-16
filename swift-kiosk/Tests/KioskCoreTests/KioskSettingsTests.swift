import Foundation
import RAVENet
import RoboFrameKit
import Testing
@testable import KioskCore

private func temporaryPath(_ name: String) -> String {
    FileManager.default.temporaryDirectory.appendingPathComponent("kiosk-\(name)-\(UUID().uuidString).json").path
}

@Suite("Kiosk settings")
struct KioskSettingsTests {

    @Test("What the menu saved wins over the environment and the config file")
    func precedence() throws {
        let configPath = temporaryPath("config"), settingsPath = temporaryPath("settings")
        defer { [configPath, settingsPath].forEach { try? FileManager.default.removeItem(atPath: $0) } }
        try Data(#"{"accessToken":"t","kiosk":{"interval":20000,"kenBurns":false,"fit":"cover","clock":false}}"#.utf8)
            .write(to: URL(fileURLWithPath: configPath))
        try Data(#"{"interval":45000,"kenBurns":true,"nightLightStart":"off","nightLightEnd":"off"}"#.utf8)
            .write(to: URL(fileURLWithPath: settingsPath))
        let config = try KioskConfig.load(path: configPath, environment: [
            "KIOSK_SETTINGS": settingsPath, "INTERVAL": "9000", "NIGHT_LIGHT_START": "22:00", "NIGHT_LIGHT_END": "07:00",
        ])
        #expect(config.intervalMs == 45_000)
        #expect(config.kenBurns)
        // Untouched by the menu: the file's values stand.
        #expect(config.fit == .cover && !config.showClock)
        // "off" is a choice, not a missing value that falls through to the environment.
        #expect(config.nightLight == nil)
        #expect(config.settingsPath == settingsPath)
    }

    @Test("Defaults: Ken Burns, a whole photo on its blurred copy, every overlay on")
    func defaults() throws {
        let config = try KioskConfig.load(path: nil, environment: ["ACCESS_TOKEN": "t", "HOME": "/home/kiosk"])
        #expect(config.kenBurns && config.fit == .contain && config.blurBackground)
        #expect(config.showClock && config.showSeconds && config.showDate && config.showSensors)
        #expect(config.brightness == 100 && config.nightLight == nil)
        #expect(config.settingsPath == "/home/kiosk/.config/roboframe-kiosk/settings.json")
    }

    @Test("The store writes only what it was given and forgets it on reset")
    func store() throws {
        let path = temporaryPath("store")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let store = KioskSettingsStore(path: path)
        #expect(store.set("brightness", .number(60)))
        #expect(KioskSettingsStore.read(path: path) == ["brightness": .number(60)])
        #expect(store.removeAll() && !FileManager.default.fileExists(atPath: path))
    }

    @Test("The night light wraps past midnight and needs two different times")
    func nightLight() throws {
        let overnight = try #require(KioskNightLight(start: "22:00", end: "07:00"))
        #expect(overnight.isActive(atMinute: 23 * 60) && overnight.isActive(atMinute: 6 * 60 + 59))
        #expect(!overnight.isActive(atMinute: 7 * 60) && !overnight.isActive(atMinute: 12 * 60))
        let afternoon = try #require(KioskNightLight(start: "13:00", end: "17:30"))
        #expect(afternoon.isActive(atMinute: 17 * 60 + 29) && !afternoon.isActive(atMinute: 17 * 60 + 30))
        #expect(KioskNightLight(start: "22:00", end: "22:00") == nil)
        #expect(KioskNightLight(start: "25:00", end: "07:00") == nil)
        #expect(KioskNightLight(start: "7:5", end: "08:00") == nil)
        #expect(overnight.label == "22:00–07:00")
    }
}

@Suite("Kiosk menu")
@MainActor
struct KioskMenuTests {

    private func session(settingsPath: String? = nil) throws -> KioskSession {
        try KioskSession(config: KioskConfig(webSocketURL: URL(string: "ws://127.0.0.1:9/rpc/ws")!, accessToken: "t", deviceId: "d",
                                             settingsPath: settingsPath),
                         logger: RAVENetSilentLogger())
    }

    @Test("m opens the menu; keys move, change and close it, and the keypad's digits work as a d-pad")
    func navigation() throws {
        let session = try session()
        #expect(session.handleKey(.character("m")) == nil && session.isMenuOpen)
        #expect(session.menuRows.first?.isSelected == true)
        #expect(session.menuRows.first?.value == "15 s")
        session.handleKey(.right)
        #expect(session.config.intervalMs == 20_000)
        session.handleKey(.character("4"))
        session.handleKey(.character("4"))
        #expect(session.config.intervalMs == 10_000)
        session.handleKey(.character("8"))
        session.handleKey(.down)
        #expect(session.menu?.selection == 2)
        session.handleKey(.character("5"))
        #expect(!session.config.kenBurns)
        session.handleKey(.up)
        #expect(session.menu?.selection == 1)
        // Up from the top wraps to the bottom.
        session.handleKey(.up)
        session.handleKey(.up)
        #expect(session.menuRows.last?.isSelected == true)
        session.handleKey(.character("0"))
        #expect(!session.isMenuOpen)
        // Closed again, keys are the slideshow's.
        #expect(session.handleKey(.character("p")) == "Image hidden")
    }

    @Test("A change in the menu is saved to the settings file")
    func saves() throws {
        let path = temporaryPath("menu")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let session = try session(settingsPath: path)
        session.openMenu()
        session.handleKey(.right)
        session.handleKey(.down)
        session.handleKey(.left)
        #expect(KioskSettingsStore.read(path: path) == ["interval": .number(20_000), "transitionMs": .number(500)])
    }

    @Test("Digits dim the slideshow, 0 is full brightness")
    func dimmer() throws {
        let session = try session()
        #expect(session.handleKey(.character("3")) == "Brightness 30 %")
        #expect(session.config.brightness == 30)
        #expect(session.handleKey(.character("0")) == "Brightness 100 %")
    }

    @Test("setBrightness below the floor hides the slideshow for this deviceId only")
    func setBrightness() throws {
        let session = try session()
        session.handle(.brightness(target: "other", value: 0))
        #expect(session.isShowing)
        session.handle(.brightness(target: "d", value: 8))
        #expect(!session.isShowing && session.isPanelOn)
        session.handle(.brightness(target: "d", value: 200))
        #expect(session.isShowing)
    }

    @Test("The 320x200 screen X falls back to while the panel is off never reaches the server")
    func screenSizeWhilePanelOff() throws {
        let session = try session()
        let post = RoboFramePost(id: 5, ext: "jpg")
        func requestedSize() -> String? {
            let items = URLComponents(url: session.provider.stillURL(for: post)!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            return items.first { $0.name == "width" }?.value
        }
        session.setScreenSize(width: 1920, height: 1080)
        #expect(requestedSize() == "1920")

        session.handle(.displayState(target: "d", on: false))
        session.setScreenSize(width: 320, height: 200)
        #expect(requestedSize() == "1920")

        // Just back on, X hasn't restored its mode yet: still settling.
        session.handle(.displayState(target: "d", on: true))
        session.setScreenSize(width: 320, height: 200)
        session.tick()
        #expect(requestedSize() == "1920")

        // A real change, once settled, applies.
        session.screenSettle = 0
        session.setScreenSize(width: 1280, height: 720)
        #expect(requestedSize() == "1280")
    }

    @Test("A refused token and an empty query say so on screen until resolved")
    func banners() throws {
        let session = try session()
        session.handle(.searchEmpty(query: "nothing"))
        #expect(KioskOverlay.status(session)?.contains("No posts match") == true)
        session.handle(.playback(RoboFramePlayback(current: RoboFramePost(id: 1, ext: "jpg"))))
        #expect(KioskOverlay.status(session) == nil)
        session.handle(.halted(reason: "invalid token"))
        #expect(KioskOverlay.status(session)?.contains("access token") == true)
    }

    @Test("Stepping picks the neighbouring choice, from between choices too, and stops at the ends")
    func stepping() {
        #expect(KioskSession.stepped([5, 10, 15, 20], current: 15, by: 1) == 20)
        #expect(KioskSession.stepped([5, 10, 15, 20], current: 12, by: 1) == 15)
        #expect(KioskSession.stepped([5, 10, 15, 20], current: 12, by: -1) == 10)
        #expect(KioskSession.stepped([5, 10, 15, 20], current: 20, by: 1) == 20)
        #expect(KioskSession.duration(90) == "1 min 30 s" && KioskSession.duration(300) == "5 min")
    }
}

@Suite("Ken Burns")
struct KioskKenBurnsTests {

    @Test("The zoom grows 1x to 1.3x about the focus, which stays put on screen")
    func zoom() {
        let rect = KioskKenBurns.Rect(x: 0, y: 0, width: 1000, height: 500)
        #expect(KioskKenBurns.zoomed(rect, focus: (0.5, 0.5), progress: 0) == rect)
        let end = KioskKenBurns.zoomed(rect, focus: (1.0 / 6, 0.5), progress: 1)
        #expect(abs(end.width - 1300) < 1e-9 && abs(end.height - 650) < 1e-9)
        // The focus point maps to the same screen point before and after.
        #expect(abs((end.x + end.width / 6) - 1000.0 / 6) < 1e-9)
        #expect(KioskKenBurns.eased(0.5) == 0.5 && KioskKenBurns.eased(-1) == 0 && KioskKenBurns.eased(2) == 1)
    }

    @Test("Contain fits the whole photo; cover fills the screen")
    func placing() {
        let contain = KioskKenBurns.placed(width: 1000, height: 1000, screenWidth: 1920, screenHeight: 1080, fit: .contain)
        #expect(contain == KioskKenBurns.Rect(x: 420, y: 0, width: 1080, height: 1080))
        let cover = KioskKenBurns.placed(width: 1000, height: 1000, screenWidth: 1920, screenHeight: 1080, fit: .cover)
        #expect(cover == KioskKenBurns.Rect(x: 0, y: -420, width: 1920, height: 1920))
    }

    @Test("The focus is the centre of the ninth with the most edges")
    func focus() {
        // Flat grey, with a checkerboard in the bottom-right ninth.
        let width = 90, height = 60
        var rgba = [UInt8](repeating: 128, count: width * height * 4)
        for y in 40..<60 {
            for x in 60..<90 where (x / 2 + y / 2) % 2 == 0 {
                for channel in 0..<3 { rgba[(y * width + x) * 4 + channel] = 255 }
            }
        }
        let focus = rgba.withUnsafeBytes { KioskKenBurns.focus(rgba: $0, width: width, height: height) }
        #expect(abs(focus.x - 5.0 / 6) < 1e-9 && abs(focus.y - 5.0 / 6) < 1e-9)
        let flat = [UInt8](repeating: 9, count: width * height * 4)
        #expect(flat.withUnsafeBytes { KioskKenBurns.focus(rgba: $0, width: width, height: height) } == (0.5, 0.5))
    }
}
