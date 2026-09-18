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
        // A plain tap can land the caret mid-string, and backspace only
        // deletes what's *before* the caret, so first tap the field's right
        // edge to put the caret after the last character, then backspace the
        // whole thing away before typing the replacement. (Not
        // `typeKey("a", modifierFlags: .command)` for select-all — that
        // overload of `typeKey` doesn't exist for the visionOS Simulator
        // XCUITest SDK, only the `XCUIKeyboardKey` one, so it fails to build
        // for that destination.)
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        if let existing = name.value as? String, !existing.isEmpty {
            name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
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
