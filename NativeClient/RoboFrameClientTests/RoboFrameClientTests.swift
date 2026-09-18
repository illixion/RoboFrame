import XCTest
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
}
