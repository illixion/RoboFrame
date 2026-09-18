import XCTest

@MainActor
final class RoboFrameClientUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCreatesWebsiteProfile() throws {
        app.launchArguments = ["-UITestProfile=empty"]
        app.launch()
        app.buttons["roboframe.profile.new"].tap()
        let name = app.textFields["roboframe.profile.name"]
        name.tap()
        // The draft starts with a non-empty placeholder name ("New Profile",
        // deduplicated) — mirrors Hypnos's `RemoteTabView.newDraft()`, which
        // seeds "New Configuration" rather than leaving the field blank.
        // Select-all before typing so the replacement is exact regardless of
        // where the tap happened to land the caret.
        name.typeKey("a", modifierFlags: .command)
        name.typeText("Kitchen Panel")
        app.buttons["roboframe.profile.save"].tap()
        XCTAssertTrue(app.staticTexts["Kitchen Panel"].waitForExistence(timeout: 2))
    }

    func testLaunchesConfiguredSlideshow() throws {
        app.launchArguments = ["-UITestProfile=slideshow"]
        app.launch()
        app.buttons["roboframe.profile.open"].tap()
        XCTAssertTrue(app.staticTexts["Waiting for RoboFrame…"].waitForExistence(timeout: 3))
    }

    func testPinnedPageCanRevealControlsAfterHiding() throws {
        app.launchArguments = ["-UITestProfile=web"]
        app.launch()
        app.buttons["roboframe.profile.open"].tap()
        let hide = app.buttons["roboframe.web.hide"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        hide.tap()
        let reveal = app.otherElements["roboframe.web.reveal"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 2))
        reveal.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 2))
    }
}
