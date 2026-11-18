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
        let homeController = UIViewController()
        let hudController = UIViewController()
        homeController.view.addSubview(home)
        hudController.view.addSubview(hud)
        let appearance = HUDAppearanceProbe()
        let contentController = RAVEViewerHUDContainerController(host: appearance)
        homeController.addChild(contentController)
        let liveView = contentController.view!
        liveView.frame = home.bounds
        portal.controller = contentController
        let editor = UITextField()
        editor.text = "Retained viewer state"
        appearance.view.addSubview(editor)
        home.addSubview(liveView)
        contentController.didMove(toParent: homeController)
        contentController.start()
        portal.home = home
        portal.source = liveView
        for _ in 0..<3 {
            contentController.beginAppearanceTransition(false, animated: false)
            contentController.endAppearanceTransition()
            portal.mount(in: hud)
            contentController.beginAppearanceTransition(true, animated: false)
            contentController.endAppearanceTransition()
            XCTAssertTrue(portal.isInHUD)
            XCTAssertTrue(liveView.superview === hud)
            XCTAssertTrue(contentController.parent === hudController)
            XCTAssertTrue(home.subviews.isEmpty)
            XCTAssertEqual(editor.text, "Retained viewer state")
            portal.restore()
            XCTAssertFalse(portal.isInHUD)
            XCTAssertTrue(liveView.superview === home)
            XCTAssertTrue(contentController.parent === homeController)
            XCTAssertEqual(liveView.frame, home.bounds)
            XCTAssertTrue(hud.subviews.isEmpty)
            XCTAssertTrue(editor.superview === appearance.view)
            XCTAssertEqual(editor.text, "Retained viewer state")
            XCTAssertEqual(appearance.appearances, 1)
            XCTAssertEqual(appearance.disappearances, 0)
        }
        contentController.finish()
        XCTAssertEqual(appearance.disappearances, 1)
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

    func testRawSplatModesMapOntoTheEngineAndKeepTheirPlaceInTheMenus() {
        XCTAssertEqual(Slideshow3DPreference.rawSplat.engineMode, .spatial3D)
        XCTAssertEqual(Slideshow3DPreference.rawSplatImmersive.engineMode, .immersive3D)
        XCTAssertEqual(Slideshow3DPreference.spatial.engineMode, .spatial3D)
        XCTAssertEqual(Slideshow3DPreference.aiDepth.engineMode, .off)
        XCTAssertTrue(Slideshow3DPreference.rawSplatImmersive.isImmersive)
        XCTAssertFalse(Slideshow3DPreference.rawSplat.isImmersive)
        // Ken Burns moves neither an AI 3D mesh nor a splat.
        XCTAssertFalse(Slideshow3DPreference.rawSplat.allowsKenBurns)
        XCTAssertFalse(Slideshow3DPreference.aiDepth.allowsKenBurns)
        XCTAssertTrue(Slideshow3DPreference.spatial.allowsKenBurns)
    }

    @MainActor
    func testRawSplatIsOfferedOnlyWhereTheBuildCanShowIt() {
        let offered = Slideshow3DPreference.selectable.contains(.rawSplat)
        XCTAssertEqual(offered, RawSplatSupport.isAvailable)
        if !RawSplatSupport.isAvailable {
            XCTAssertEqual(Slideshow3DPreference.rawSplat.resolvedForBuild, .spatial)
            XCTAssertEqual(Slideshow3DPreference.rawSplatImmersive.resolvedForBuild, .spatial)
        }
        XCTAssertEqual(Slideshow3DPreference.aiDepth.resolvedForBuild, .aiDepth)
    }

    func testSavedRawSplatModeSurvivesProfileCoding() throws {
        var profile = RoboFrameProfile()
        profile.slideshow3DMode = .rawSplatImmersive
        let decoded = try JSONDecoder().decode(RoboFrameProfile.self, from: JSONEncoder().encode(profile))
        XCTAssertEqual(decoded.slideshow3DMode, .rawSplatImmersive)
    }
}

@MainActor
private final class TestProvider: RAVESlideshowContentProvider {
    func fetchMoreContent(_ request: RAVESlideshowFetchRequest) async throws -> [RAVESlideshowItem] { [] }
    func loadMedia(for item: RAVESlideshowItem, maxResolution: Int) async throws -> RAVESlideshowLoadedMedia {
        .still(data: Data([0xFF]), displayURL: nil)
    }
}

#if os(visionOS)
@MainActor
private final class HUDAppearanceProbe: UIViewController {
    var appearances = 0
    var disappearances = 0
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appearances += 1
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        disappearances += 1
    }
}
#endif
