import Foundation
import RoboFrameKit
import Testing
@testable import KioskCore

@Suite("Kiosk config")
struct KioskConfigTests {

    private func write(_ json: String) throws -> String {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("kiosk-\(UUID().uuidString).json").path
        try Data(json.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    @Test("native-kiosk's config file reads the same, loose types included")
    func file() throws {
        let path = try write("""
        {"accessToken":"t0k","deviceId":"slideshow_display",
         "display":{"wsUrl":"ws://display.local:3123/rpc/ws"},
         "kiosk":{"wsUrl":"ws://100.103.115.47:3123/rpc/ws","interval":"20000","bright":"1",
                  "lowmem":0,"modTags":["rating:s"],"vcodec":"h264","hwdec":"v4l2m2m-copy","wallpaper":true}}
        """)
        defer { try? FileManager.default.removeItem(atPath: path) }
        let config = try KioskConfig.load(path: path, environment: [:])
        #expect(config.webSocketURL.absoluteString == "ws://100.103.115.47:3123/rpc/ws")
        #expect(config.accessToken == "t0k")
        #expect(config.deviceId == "slideshow_display")
        #expect(config.intervalMs == 20_000)
        #expect(config.bright)
        #expect(!config.lowmem)
        #expect(config.modTags == ["rating:s"])
        #expect(config.vcodec == "h264")
        #expect(config.wallpaper && config.ratioFilter)
    }

    @Test("The environment overrides the file")
    func environment() throws {
        let path = try write(#"{"accessToken":"file","kiosk":{"interval":15000,"vcodec":"h264"}}"#)
        defer { try? FileManager.default.removeItem(atPath: path) }
        let config = try KioskConfig.load(path: path, environment: [
            "ACCESS_TOKEN": "env", "INTERVAL": "9000", "VCODEC": "off",
            "MOD_TAGS": "a, b,,c", "SCREEN_SIZE": "1280x720",
        ])
        #expect(config.accessToken == "env")
        #expect(config.intervalMs == 9_000)
        #expect(config.vcodec == nil)
        #expect(config.modTags == ["a", "b", "c"])
        #expect(config.screenWidth == 1280 && config.screenHeight == 720)
        #expect(config.webSocketURL.absoluteString == "ws://localhost:3123/rpc/ws")
    }

    @Test("A number past Int's range is ignored, not a crash on start")
    func hugeNumber() throws {
        let path = try write(#"{"accessToken":1e19,"kiosk":{"interval":1e19,"maxMediaBytes":-1e300}}"#)
        defer { try? FileManager.default.removeItem(atPath: path) }
        let config = try KioskConfig.load(path: path, environment: [:])
        #expect(config.intervalMs == 15_000)
        #expect(config.accessToken == "1e+19")
    }

    @Test("No token is an error, not an unauthenticated kiosk")
    func missingToken() {
        #expect(throws: KioskConfig.LoadError.self) {
            try KioskConfig.load(path: nil, environment: [:])
        }
    }
}

@Suite("Kiosk media URLs")
@MainActor
struct KioskMediaURLTests {

    private func provider(_ config: KioskConfig) throws -> KioskMediaProvider {
        let endpoint = try #require(RoboFrameEndpoint(webSocketURL: config.webSocketURL, accessToken: config.accessToken, deviceId: config.deviceId))
        return KioskMediaProvider(endpoint: endpoint, config: config)
    }

    @Test("Stills are screen-sized JPEGs; the variant matches what slideshowConfig advertises")
    func still() throws {
        let config = KioskConfig(webSocketURL: URL(string: "ws://s:3123/rpc/ws")!, accessToken: "t", deviceId: "d", bright: true)
        let url = try provider(config).stillURL(for: RoboFramePost(id: 5, ext: "jxl"))
        #expect(url?.absoluteString == "http://s:3123/get?id=5&record=1&width=1920&height=1080&convert=1&lowmem=1&bright=1&deviceId=d&token=t")
    }

    @Test("Videos ask for the capped H.264 transcode and nothing else")
    func video() throws {
        let config = KioskConfig(webSocketURL: URL(string: "ws://s:3123/rpc/ws")!, accessToken: "t", deviceId: "d")
        let url = try provider(config).videoURL(for: RoboFramePost(id: 6, ext: "webm"))
        #expect(url?.absoluteString == "http://s:3123/get?id=6&record=1&vcodec=h264&vmaxh=720&deviceId=d&token=t")
    }
}
