/*
 Ken Burns

 The web kiosk's slow zoom (public/modules/slideshow.js and sobel-focus.js):
 each photo grows from 1x to `zoom` over its dwell, eased in and out, about
 the centre of its busiest ninth. The busiest ninth is the cell of a 3x3
 grid with the most Sobel edge energy, measured on a small greyscale copy,
 so the zoom heads for the subject rather than the sky. Here it is plain
 maths over rectangles; the renderer only moves the photo's quad.
 */

import Foundation

public enum KioskKenBurns {
    public static let zoom = 1.3
    /// The edge of the greyscale copy the focus is found on: the web kiosk
    /// measured that 200 px gives the same cell as full size.
    public static let analysisSize = 160

    /// A rectangle in screen pixels, origin top left.
    public struct Rect: Equatable, Sendable {
        public var x, y, width, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x; self.y = y; self.width = width; self.height = height
        }
    }

    /// `ease-in-out`: slow at both ends, so the zoom never starts or stops on a step.
    public static func eased(_ progress: Double) -> Double {
        let t = min(1, max(0, progress))
        return t * t * (3 - 2 * t)
    }

    /// `rect` grown by the zoom at `progress` (0...1) about the point
    /// `focus` (fractions of the rect), which stays where it is on screen.
    public static func zoomed(_ rect: Rect, focus: (x: Double, y: Double), progress: Double) -> Rect {
        let scale = 1 + (zoom - 1) * eased(progress)
        let originX = rect.x + focus.x * rect.width, originY = rect.y + focus.y * rect.height
        return Rect(x: originX + (rect.x - originX) * scale, y: originY + (rect.y - originY) * scale,
                    width: rect.width * scale, height: rect.height * scale)
    }

    /// The photo placed on a `screenWidth` x `screenHeight` screen: whole
    /// and centred (`contain`), or filling it with the overflow cropped.
    public static func placed(width: Int, height: Int, screenWidth: Int, screenHeight: Int, fit: KioskConfig.Fit) -> Rect {
        guard width > 0, height > 0 else { return Rect(x: 0, y: 0, width: Double(screenWidth), height: Double(screenHeight)) }
        let scaleX = Double(screenWidth) / Double(width), scaleY = Double(screenHeight) / Double(height)
        let scale = fit == .contain ? min(scaleX, scaleY) : max(scaleX, scaleY)
        let w = Double(width) * scale, h = Double(height) * scale
        return Rect(x: (Double(screenWidth) - w) / 2, y: (Double(screenHeight) - h) / 2, width: w, height: h)
    }

    /// The centre of the busiest cell of a `grid` x `grid` split of an RGBA
    /// image, as fractions of its size. Samples it down to `analysisSize`
    /// first, so it costs the same for any photo.
    public static func focus(rgba: UnsafeRawBufferPointer, width: Int, height: Int, grid: Int = 3) -> (x: Double, y: Double) {
        let center = (x: 0.5, y: 0.5)
        guard width >= grid, height >= grid, rgba.count >= width * height * 4 else { return center }
        let scale = min(1, Double(analysisSize) / Double(max(width, height)))
        let w = max(grid, Int(Double(width) * scale)), h = max(grid, Int(Double(height) * scale))
        // Greyscale by sampling the source at each small pixel's centre.
        var luma = [Int32](repeating: 0, count: w * h)
        for y in 0..<h {
            let sourceRow = min(height - 1, Int((Double(y) + 0.5) * Double(height) / Double(h))) * width
            for x in 0..<w {
                let offset = (sourceRow + min(width - 1, Int((Double(x) + 0.5) * Double(width) / Double(w)))) * 4
                luma[y * w + x] = (Int32(rgba[offset]) * 77 + Int32(rgba[offset + 1]) * 150 + Int32(rgba[offset + 2]) * 29) >> 8
            }
        }
        return focus(luma: luma, width: w, height: h, grid: grid)
    }

    /// The same, from a greyscale image (row-major).
    public static func focus(luma: [Int32], width w: Int, height h: Int, grid: Int = 3) -> (x: Double, y: Double) {
        guard w >= 3, h >= 3, luma.count >= w * h else { return (0.5, 0.5) }
        var cells = [Int64](repeating: 0, count: grid * grid)
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) {
                func p(_ dx: Int, _ dy: Int) -> Int32 { luma[(y + dy) * w + x + dx] }
                let gx = (p(1, -1) + 2 * p(1, 0) + p(1, 1)) - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1))
                let gy = (p(-1, 1) + 2 * p(0, 1) + p(1, 1)) - (p(-1, -1) + 2 * p(0, -1) + p(1, -1))
                let cell = min(grid - 1, y * grid / h) * grid + min(grid - 1, x * grid / w)
                cells[cell] += Int64(abs(gx) + abs(gy))
            }
        }
        // Ties keep the earliest cell; an image with no edges zooms on its centre.
        guard let best = cells.indices.max(by: { cells[$0] < cells[$1] || (cells[$0] == cells[$1] && $0 > $1) }),
              cells[best] > 0 else { return (0.5, 0.5) }
        return ((Double(best % grid) + 0.5) / Double(grid), (Double(best / grid) + 0.5) / Double(grid))
    }
}
