// swift-tools-version: 6.2
import PackageDescription

// RoboFrame's Swift kiosk: the Linux frontend for Pi-class boards, and the
// successor to native-kiosk (Python). The protocol client and the slideshow
// engine are RAVESDK's, shared with Hypnos and NativeClient, so all three
// follow the server the same way. Builds on macOS too, for development.
let package = Package(
    name: "RoboFrameKiosk",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../../RAVESDK"),
    ],
    targets: [
        // Config, the session (connection + engine + panel state) and the
        // media provider. No windowing, so it tests anywhere.
        .target(
            name: "KioskCore",
            dependencies: [
                .product(name: "RAVERoboFrame", package: "RAVESDK"),
                .product(name: "RAVESlideshowCore", package: "RAVESDK"),
                .product(name: "RAVENet", package: "RAVESDK"),
            ]
        ),
        .executableTarget(name: "roboframe-kiosk", dependencies: ["KioskCore"]),
        .testTarget(name: "KioskCoreTests", dependencies: ["KioskCore"]),
    ]
)
