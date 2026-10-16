// swift-tools-version: 6.2
import PackageDescription

// RoboFrame's WebSocket protocol client for the Swift clients in this repo:
// NativeClient (visionOS, iOS) and swift-kiosk (Linux, the Pi). Typed frames,
// session multiplexing and the post-reconnect replay, present/visibility
// edges and the server's URLs. The wire contract is docs/protocol.md; change
// them together. The transport is RAVESDK's RAVENet, and posts convert to
// RAVESlideshowCore's items; both build on Linux, so this does too.
let package = Package(
    name: "RoboFrameKit",
    platforms: [.visionOS(.v26), .macOS(.v14), .iOS(.v26), .tvOS(.v26)],
    products: [
        .library(name: "RoboFrameKit", targets: ["RoboFrameKit"]),
    ],
    dependencies: [
        .package(path: "../../RAVESDK"),
    ],
    targets: [
        .target(name: "RoboFrameKit", dependencies: [
            .product(name: "RAVENet", package: "RAVESDK"),
            .product(name: "RAVESlideshowCore", package: "RAVESDK"),
        ]),
        .testTarget(name: "RoboFrameKitTests", dependencies: [
            "RoboFrameKit",
            .product(name: "RAVENet", package: "RAVESDK"),
        ]),
    ]
)
