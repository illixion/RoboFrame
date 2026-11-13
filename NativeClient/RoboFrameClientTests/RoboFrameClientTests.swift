import XCTest
import RAVESlideshow
@testable import RoboFrameClient
#if os(visionOS)
@testable import RAVEUI
import UIKit
#endif

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
    #if os(visionOS)
    @MainActor
    func testHUDReturnsTheSameLiveViewAndRetainsItsState() {
        let portal = RAVEViewerHUDPortal()
        let home = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let hud = UIView(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
        let liveView = UIView(frame: home.bounds)
        let editor = UITextField()
        editor.text = "Retained viewer state"
        liveView.addSubview(editor)
        home.addSubview(liveView)
        portal.home = home
        portal.source = liveView
        for _ in 0..<3 {
            portal.mount(in: hud)
            XCTAssertTrue(portal.isInHUD)
            XCTAssertTrue(liveView.superview === hud)
            XCTAssertTrue(home.subviews.isEmpty)
            XCTAssertEqual(editor.text, "Retained viewer state")
            portal.restore()
            XCTAssertFalse(portal.isInHUD)
            XCTAssertTrue(liveView.superview === home)
            XCTAssertEqual(liveView.frame, home.bounds)
            XCTAssertTrue(hud.subviews.isEmpty)
            XCTAssertTrue(liveView.subviews.first === editor)
            XCTAssertEqual(editor.text, "Retained viewer state")
        }
    }
    #endif

    @MainActor
    func testClosingOneViewerDoesNotStopAnotherViewersVideo() {
        var profile = RoboFrameProfile()
        profile.endpoint = "https://frame.example"
        let first = SlideshowModel(profile: profile)
        let second = SlideshowModel(profile: profile)
        let url = URL(fileURLWithPath: "/tmp/roboframe-test-clip.mp4")
        let firstClip = first.clipPool.clip(for: url)
        let secondClip = second.clipPool.clip(for: url)
        XCTAssertFalse(firstClip.player === secondClip.player)
        first.stop()
        XCTAssertNil(firstClip.player.currentItem)
        XCTAssertNotNil(secondClip.player.currentItem)
        second.stop()
    }

    func testServerDrivenEngineWaitsForAuthoritativePlayback() async {
        let provider = await MainActor.run { TestProvider() }
        let engine = await MainActor.run {
            RAVESlideshowEngine(provider: provider, configuration: .init(serverDriven: true, automaticAdvancement: false))
        }
        await MainActor.run { engine.start() }
        try? await Task.sleep(for: .milliseconds(30))
        let before = await MainActor.run { engine.current }
        XCTAssertNil(before)

        let item = RAVESlideshowItem(id: "17", fileExtension: "jpg")
        await MainActor.run { engine.setAuthoritativeCurrent(item) }
        await engine.waitUntilIdleForTesting()
        let after = await MainActor.run { engine.current?.item.id }
        XCTAssertEqual(after, "17")
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
