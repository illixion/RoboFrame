import XCTest
import RAVESlideshow
@testable import RoboFrameClient

final class RoboFrameClientTests: XCTestCase {
    func testSlideshowURLPreservesDeploymentSubpathAndToken() {
        var profile = RoboFrameProfile()
        profile.endpoint = "https://frame.example/display"
        profile.accessToken = "test token"
        let url = try? XCTUnwrap(profile.webSocketURL)
        XCTAssertEqual(url?.scheme, "wss")
        XCTAssertEqual(url?.path, "/display/rpc/ws")
        XCTAssertEqual(URLComponents(url: url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "test token")
    }

    func testWebsiteProfileRequiresUsableURL() {
        var profile = RoboFrameProfile()
        profile.mode = .webPage
        XCTAssertNotNil(profile.launchError)
        profile.webPageURL = "example.com/dashboard"
        XCTAssertEqual(profile.resolvedWebPageURL?.scheme, "https")
        XCTAssertNil(profile.launchError)
    }

    func testCopyGetsNewIdentityButRetainsSettings() {
        var profile = RoboFrameProfile()
        profile.endpoint = "https://frame.example"
        profile.deviceId = "kitchen"
        let copy = profile.duplicated(named: "Kitchen")
        XCTAssertNotEqual(profile.id, copy.id)
        XCTAssertEqual(copy.endpoint, profile.endpoint)
        XCTAssertEqual(copy.name, "Kitchen")
    }

    func testSlideshowSessionDefaultsToTheStableProfileIdentity() async {
        var profile = RoboFrameProfile()
        profile.endpoint = "https://frame.example"
        profile.deviceId = "kitchen"

        let sessionID = await MainActor.run { SlideshowModel(profile: profile).sessionID }
        XCTAssertEqual(sessionID, profile.id.uuidString)
    }
    func testServerDrivenEngineWaitsForAuthoritativePlayback() async {
        let provider = await MainActor.run { TestProvider() }
        let engine = await MainActor.run {
            RAVESlideshowEngine(provider: provider, configuration: .init(serverDriven: true, automaticAdvancement: false))
        }
        await MainActor.run { engine.start() }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertNil(await MainActor.run { engine.current })

        let item = RAVESlideshowItem(id: "17", fileExtension: "jpg")
        await MainActor.run { engine.setAuthoritativeCurrent(item) }
        await engine.waitUntilIdleForTesting()
        XCTAssertEqual(await MainActor.run { engine.current?.item.id }, "17")
        await MainActor.run { engine.stop() }
    }
}

@MainActor
private final class TestProvider: RAVESlideshowContentProvider {
    func fetchMoreContent(_ request: RAVESlideshowFetchRequest) async throws -> [RAVESlideshowItem] { [] }
    func loadMedia(for item: RAVESlideshowItem, maxResolution: Int) async throws -> RAVESlideshowLoadedMedia {
        .still(data: Data([0xFF]), displayURL: nil)
    }
}
