// swift-tools-version: 6.2
import PackageDescription

// RoboFrame's Swift kiosk: the Linux frontend for Pi-class boards, and the
// successor to native-kiosk (Python). The protocol client and the slideshow
// engine are RAVESDK's, shared with Hypnos and NativeClient, so all three
// follow the server the same way. Builds on macOS too, for development,
// where it runs headless: the renderer is SDL2 + OpenGL ES 2 + libmpv, the
// stack the Pi has.
let package = Package(
    name: "RoboFrameKiosk",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../../RAVESDK"),
    ],
    targets: [
        // Config, the session (connection + engine + panel state), the media
        // provider and the overlay text. No windowing, so it tests anywhere.
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

#if os(Linux)
package.targets += [
    .systemLibrary(name: "CSDL2", pkgConfig: "sdl2", providers: [.apt(["libsdl2-dev", "libsdl2-ttf-dev", "libsdl2-image-dev"])]),
    .systemLibrary(name: "CGLES2", pkgConfig: "glesv2", providers: [.apt(["libgles-dev"])]),
    .systemLibrary(name: "CMpv", pkgConfig: "mpv", providers: [.apt(["libmpv-dev"])]),
    // The window, the GL compositor (crossfades, overlay), text and the
    // libmpv player. Linux only.
    .target(name: "KioskRenderer", dependencies: ["KioskCore", "CSDL2", "CGLES2", "CMpv"]),
]
package.targets.first { $0.name == "roboframe-kiosk" }!.dependencies.append("KioskRenderer")
#endif
