/*
 Image decoding and text

 Photos are decoded off the main thread with SDL_image (libjpeg-turbo on
 the Pi) into RGBA rows the compositor uploads as one texture. Text is set
 with SDL_ttf into the same RGBA form: each overlay box (clock, date,
 sensors, a toast, an alert) becomes one small texture, redrawn only when
 its text changes.
 */

import CSDL2
import Foundation
import KioskCore

/// A photo decoded for the slideshow, with what drawing it needs: the
/// tiny, blurred and darkened copy that fills the bars beside it, and the
/// point its Ken Burns zoom heads for.
struct DecodedPhoto: Sendable {
    let image: RGBAImage
    let backdrop: RGBAImage?
    let focus: (x: Double, y: Double)

    /// The backdrop's longest edge. Stretched across the screen with linear
    /// filtering, a blurred copy this small reads as a soft blur.
    static let backdropSize = 40

    static func decode(_ data: Data, maxWidth: Int, maxHeight: Int) -> DecodedPhoto? {
        guard let image = RGBAImage.decode(data, maxWidth: maxWidth, maxHeight: maxHeight) else { return nil }
        let focus = image.pixels.withUnsafeBytes { KioskKenBurns.focus(rgba: $0, width: image.width, height: image.height) }
        return DecodedPhoto(image: image, backdrop: image.backdrop(edge: backdropSize), focus: focus)
    }
}

/// Decoded RGBA pixels, top row first, rows tightly packed.
struct RGBAImage: Sendable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init(width: Int, height: Int, pixels: [UInt8]) {
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    /// Box-sampled down to `edge` on the longest side, blurred twice more
    /// and darkened to 45 %, so the photo in front stays the brightest thing.
    func backdrop(edge: Int) -> RGBAImage? {
        guard width > 0, height > 0 else { return nil }
        let scale = Double(edge) / Double(max(width, height))
        let w = max(1, Int((Double(width) * scale).rounded())), h = max(1, Int((Double(height) * scale).rounded()))
        var small = [Double](repeating: 0, count: w * h * 3)
        pixels.withUnsafeBufferPointer { source in
            for y in 0..<h {
                let y0 = y * height / h, y1 = max(y0 + 1, (y + 1) * height / h)
                for x in 0..<w {
                    let x0 = x * width / w, x1 = max(x0 + 1, (x + 1) * width / w)
                    // Every other source pixel each way is plenty for a blur.
                    var r = 0.0, g = 0.0, b = 0.0, count = 0.0
                    for sy in stride(from: y0, to: y1, by: 2) {
                        for sx in stride(from: x0, to: x1, by: 2) {
                            let offset = (sy * width + sx) * 4
                            r += Double(source[offset]); g += Double(source[offset + 1]); b += Double(source[offset + 2])
                            count += 1
                        }
                    }
                    let index = (y * w + x) * 3
                    small[index] = r / count; small[index + 1] = g / count; small[index + 2] = b / count
                }
            }
        }
        for _ in 0..<2 { small = Self.boxBlur(small, width: w, height: h) }
        var out = [UInt8](repeating: 255, count: w * h * 4)
        for index in 0..<(w * h) {
            for channel in 0..<3 { out[index * 4 + channel] = UInt8(min(255, small[index * 3 + channel] * 0.45)) }
        }
        return RGBAImage(width: w, height: h, pixels: out)
    }

    private static func boxBlur(_ pixels: [Double], width: Int, height: Int) -> [Double] {
        var out = pixels
        for y in 0..<height {
            for x in 0..<width {
                var sum = (0.0, 0.0, 0.0), count = 0.0
                for dy in -1...1 {
                    for dx in -1...1 {
                        let sx = min(width - 1, max(0, x + dx)), sy = min(height - 1, max(0, y + dy))
                        let offset = (sy * width + sx) * 3
                        sum.0 += pixels[offset]; sum.1 += pixels[offset + 1]; sum.2 += pixels[offset + 2]
                        count += 1
                    }
                }
                let offset = (y * width + x) * 3
                out[offset] = sum.0 / count; out[offset + 1] = sum.1 / count; out[offset + 2] = sum.2 / count
            }
        }
        return out
    }

    /// The same image with its corners cut round, antialiased, for the
    /// overlay's boxes (the web kiosk's border-radius).
    func roundingCorners(_ radius: Int) -> RGBAImage {
        let radius = min(radius, width / 2, height / 2)
        guard radius > 1 else { return self }
        var pixels = pixels
        let r = Double(radius)
        for y in 0..<radius {
            for x in 0..<radius {
                // Distance from the corner circle's centre, sampled at the pixel's centre.
                let dx = r - (Double(x) + 0.5), dy = r - (Double(y) + 0.5)
                let coverage = min(1, max(0, r - (dx * dx + dy * dy).squareRoot() + 0.5))
                guard coverage < 1 else { continue }
                for (cx, cy) in [(x, y), (width - 1 - x, y), (x, height - 1 - y), (width - 1 - x, height - 1 - y)] {
                    let offset = (cy * width + cx) * 4 + 3
                    pixels[offset] = UInt8(Double(pixels[offset]) * coverage)
                }
            }
        }
        return RGBAImage(width: width, height: height, pixels: pixels)
    }

    /// Decodes a JPEG/PNG, scaling it down to fit `maxWidth` x `maxHeight`
    /// if it's larger (the server sends screen-sized frames, so that's rare).
    static func decode(_ data: Data, maxWidth: Int, maxHeight: Int) -> RGBAImage? {
        data.withUnsafeBytes { bytes -> RGBAImage? in
            guard let base = bytes.baseAddress,
                  let stream = SDL_RWFromConstMem(base, Int32(bytes.count)),
                  let decoded = IMG_Load_RW(stream, 1) else { return nil }
            defer { SDL_FreeSurface(decoded) }
            guard let rgba = SDL_ConvertSurfaceFormat(decoded, SDL_PIXELFORMAT_RGBA32.rawValue, 0) else { return nil }
            defer { SDL_FreeSurface(rgba) }
            let width = Int(rgba.pointee.w), height = Int(rgba.pointee.h)
            let scale = min(1, Double(maxWidth) / Double(width), Double(maxHeight) / Double(height))
            guard scale < 1 else { return RGBAImage(surface: rgba) }
            let fitted = SDL_CreateRGBSurfaceWithFormat(0, Int32(Double(width) * scale), Int32(Double(height) * scale), 32, SDL_PIXELFORMAT_RGBA32.rawValue)
            guard let fitted else { return nil }
            defer { SDL_FreeSurface(fitted) }
            SDL_SoftStretchLinear(rgba, nil, fitted, nil)
            return RGBAImage(surface: fitted)
        }
    }

    /// Copies an RGBA32 surface out, dropping its row padding.
    init(surface: UnsafeMutablePointer<SDL_Surface>) {
        let width = Int(surface.pointee.w), height = Int(surface.pointee.h)
        self.width = width
        self.height = height
        let pitch = Int(surface.pointee.pitch)
        let rowBytes = width * 4
        let source = surface.pointee.pixels.assumingMemoryBound(to: UInt8.self)
        var pixels = [UInt8](repeating: 0, count: rowBytes * height)
        pixels.withUnsafeMutableBufferPointer { out in
            for row in 0..<height {
                (out.baseAddress! + row * rowBytes).update(from: source + row * pitch, count: rowBytes)
            }
        }
        self.pixels = pixels
    }

    /// Cropped to the GPU's texture limit (2048 on the Pi), which only an
    /// overlay line far wider than the screen reaches: an oversized upload
    /// fails and samples as a black bar instead.
    func texture() -> GLTexture {
        let limit = GLCompositor.maxTextureSize
        guard limit > 0, width > limit || height > limit else {
            return pixels.withUnsafeBytes { GLTexture(width: width, height: height, rgba: $0.baseAddress) }
        }
        let croppedWidth = min(width, limit), croppedHeight = min(height, limit)
        var cropped = [UInt8](repeating: 0, count: croppedWidth * croppedHeight * 4)
        for row in 0..<croppedHeight {
            let source = row * width * 4
            cropped.replaceSubrange(row * croppedWidth * 4 ..< (row + 1) * croppedWidth * 4, with: pixels[source ..< source + croppedWidth * 4])
        }
        return cropped.withUnsafeBytes { GLTexture(width: croppedWidth, height: croppedHeight, rgba: $0.baseAddress) }
    }
}

/// SDL_ttf fonts plus a colour-emoji font for sensor icons, so mixed lines
/// ("🌡️ Living room: 21.5°C") draw each run in the font that has it.
final class TextSetter {
    private let path: String?
    private let emojiPath: String?
    private var fonts: [Int: OpaquePointer] = [:]
    private var emoji: OpaquePointer?
    private var triedEmoji = false

    static let fontCandidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    static let emojiCandidates = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"]

    init() {
        path = Self.fontCandidates.first { FileManager.default.fileExists(atPath: $0) }
        emojiPath = Self.emojiCandidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    var hasFont: Bool { path != nil }

    deinit {
        fonts.values.forEach { TTF_CloseFont($0) }
        if let emoji { TTF_CloseFont(emoji) }
    }

    /// NotoColorEmoji is a bitmap font with a single 109 px strike. Opened on
    /// first use: SDL_ttf isn't initialised yet when the renderer builds this.
    private func emojiFont() -> OpaquePointer? {
        if !triedEmoji {
            triedEmoji = true
            if let emojiPath {
                emoji = TTF_OpenFont(emojiPath, 109)
                if emoji == nil { FileHandle.standardError.write(Data("emoji font \(emojiPath) failed: \(String(cString: SDL_GetError()))\n".utf8)) }
            }
        }
        return emoji
    }

    private func font(size: Int) -> OpaquePointer? {
        if let font = fonts[size] { return font }
        guard let path, let font = TTF_OpenFont(path, Int32(size)) else { return nil }
        fonts[size] = font
        return font
    }

    func lineHeight(size: Int) -> Int {
        font(size: size).map { Int(TTF_FontLineSkip($0)) } ?? size
    }

    /// The width `line` will have: emoji runs are measured in the emoji font
    /// and scaled to the text's line height, as `line` draws them.
    func width(of text: String, size: Int) -> Int {
        guard let font = font(size: size) else { return 0 }
        let height = Int(TTF_FontHeight(font))
        var total = 0
        for (run, isEmoji) in Self.runs(text) {
            var width: Int32 = 0, runHeight: Int32 = 0
            if isEmoji, let emoji = emojiFont() {
                TTF_SizeUTF8(emoji, run, &width, &runHeight)
                total += runHeight > 0 ? max(1, Int(width) * height / Int(runHeight)) : 0
            } else {
                TTF_SizeUTF8(font, run, &width, &runHeight)
                total += Int(width)
            }
        }
        return total
    }

    /// One line as an RGBA32 surface (caller frees it).
    func line(_ text: String, size: Int, color: SDL_Color) -> UnsafeMutablePointer<SDL_Surface>? {
        guard let font = font(size: size) else { return nil }
        let height = Int(TTF_FontHeight(font))
        var runs: [UnsafeMutablePointer<SDL_Surface>] = []
        defer { runs.forEach { SDL_FreeSurface($0) } }
        for (run, isEmoji) in Self.runs(text) {
            let emoji = isEmoji ? emojiFont() : nil
            let useEmoji = emoji != nil
            guard let rendered = TTF_RenderUTF8_Blended(emoji ?? font, run, color),
                  let rgba = SDL_ConvertSurfaceFormat(rendered, SDL_PIXELFORMAT_RGBA32.rawValue, 0) else { continue }
            SDL_FreeSurface(rendered)
            if useEmoji, rgba.pointee.h > 0 {
                // Scale the 109 px strike down to the text's line height.
                let scaledWidth = max(1, Int(rgba.pointee.w) * height / Int(rgba.pointee.h))
                if let scaled = SDL_CreateRGBSurfaceWithFormat(0, Int32(scaledWidth), Int32(height), 32, SDL_PIXELFORMAT_RGBA32.rawValue) {
                    SDL_SoftStretchLinear(rgba, nil, scaled, nil)
                    SDL_FreeSurface(rgba)
                    runs.append(scaled)
                    continue
                }
            }
            runs.append(rgba)
        }
        let width = runs.reduce(0) { $0 + Int($1.pointee.w) }
        let lineHeight = runs.reduce(height) { max($0, Int($1.pointee.h)) }
        guard let line = SDL_CreateRGBSurfaceWithFormat(0, Int32(max(1, width)), Int32(lineHeight), 32, SDL_PIXELFORMAT_RGBA32.rawValue) else { return nil }
        var x: Int32 = 0
        for run in runs {
            SDL_SetSurfaceBlendMode(run, SDL_BLENDMODE_NONE)
            var target = SDL_Rect(x: x, y: (Int32(lineHeight) - run.pointee.h) / 2, w: run.pointee.w, h: run.pointee.h)
            SDL_UpperBlit(run, nil, line, &target)
            x += run.pointee.w
        }
        return line
    }

    /// Lines in a translucent black box, like the web kiosk's overlay boxes,
    /// with an optional image to their left (a toast's preview).
    func box(_ lines: [String], size: Int, rightAligned: Bool, padding: (x: Int, y: Int) = (14, 10),
             background: (UInt8, UInt8, UInt8, UInt8) = (0, 0, 0, 178),
             color: SDL_Color = SDL_Color(r: 222, g: 222, b: 222, a: 255),
             leading image: RGBAImage? = nil, imageGap: Int = 8, radius: Int = 0) -> RGBAImage? {
        let surfaces = lines.compactMap { line($0, size: size, color: color) }
        defer { surfaces.forEach { SDL_FreeSurface($0) } }
        guard !surfaces.isEmpty else { return nil }
        let gap = 4
        let imageWidth = image.map { $0.width + imageGap } ?? 0
        let textHeight = surfaces.reduce(0) { $0 + Int($1.pointee.h) } + gap * (surfaces.count - 1)
        let width = surfaces.map { Int($0.pointee.w) }.max()! + imageWidth + padding.x * 2
        let height = max(textHeight, image?.height ?? 0) + padding.y * 2
        guard let box = SDL_CreateRGBSurfaceWithFormat(0, Int32(width), Int32(height), 32, SDL_PIXELFORMAT_RGBA32.rawValue) else { return nil }
        defer { SDL_FreeSurface(box) }
        SDL_FillRect(box, nil, SDL_MapRGBA(box.pointee.format, background.0, background.1, background.2, background.3))
        if let image {
            var pixels = image.roundingCorners(max(0, radius / 2)).pixels
            pixels.withUnsafeMutableBytes { bytes in
                guard let surface = SDL_CreateRGBSurfaceWithFormatFrom(bytes.baseAddress, Int32(image.width), Int32(image.height), 32,
                                                                        Int32(image.width * 4), SDL_PIXELFORMAT_RGBA32.rawValue) else { return }
                defer { SDL_FreeSurface(surface) }
                SDL_SetSurfaceBlendMode(surface, SDL_BLENDMODE_NONE)
                var target = SDL_Rect(x: Int32(padding.x), y: Int32((height - image.height) / 2), w: Int32(image.width), h: Int32(image.height))
                SDL_UpperBlit(surface, nil, box, &target)
            }
        }
        var y = padding.y + (height - padding.y * 2 - textHeight) / 2
        for surface in surfaces {
            let x = rightAligned ? width - padding.x - Int(surface.pointee.w) : padding.x + imageWidth
            SDL_SetSurfaceBlendMode(surface, SDL_BLENDMODE_BLEND)
            var target = SDL_Rect(x: Int32(x), y: Int32(y), w: surface.pointee.w, h: surface.pointee.h)
            SDL_UpperBlit(surface, nil, box, &target)
            y += Int(surface.pointee.h) + gap
        }
        return RGBAImage(surface: box).roundingCorners(radius)
    }

    /// The settings menu as one panel: a title, then each row's label on the
    /// left and value on the right under its section's heading, the selected
    /// row highlighted, and the keys to use along the bottom.
    func menu(title: String, subtitle: String, rows: [KioskMenuRow], footer: String, scale: Double) -> RGBAImage? {
        func px(_ value: Double) -> Int { max(1, Int((value * scale).rounded())) }
        let textSize = px(30), headingSize = px(20), titleSize = px(40)
        let white = SDL_Color(r: 240, g: 240, b: 240, a: 255)
        let dim = SDL_Color(r: 160, g: 160, b: 160, a: 255)
        let accent = SDL_Color(r: 138, g: 180, b: 248, a: 255)
        let width = px(980), padding = px(36), rowHeight = px(46), headingHeight = px(44)
        let height = padding * 2 + px(64) + rows.reduce(0) { $0 + rowHeight + ($1.section != nil ? headingHeight : 0) } + px(56)
        guard let panel = SDL_CreateRGBSurfaceWithFormat(0, Int32(width), Int32(height), 32, SDL_PIXELFORMAT_RGBA32.rawValue) else { return nil }
        defer { SDL_FreeSurface(panel) }
        SDL_FillRect(panel, nil, SDL_MapRGBA(panel.pointee.format, 18, 18, 20, 238))

        func blit(_ text: String, size: Int, color: SDL_Color, x: Int, y: Int, rightAligned: Bool = false, height: Int? = nil) {
            guard !text.isEmpty, let surface = line(text, size: size, color: color) else { return }
            defer { SDL_FreeSurface(surface) }
            SDL_SetSurfaceBlendMode(surface, SDL_BLENDMODE_BLEND)
            let w = Int(surface.pointee.w), h = Int(surface.pointee.h)
            var target = SDL_Rect(x: Int32(rightAligned ? x - w : x), y: Int32(y + ((height ?? h) - h) / 2), w: Int32(w), h: Int32(h))
            SDL_UpperBlit(surface, nil, panel, &target)
        }
        func fill(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ r: UInt8, _ g: UInt8, _ b: UInt8, _ a: UInt8) {
            var rect = SDL_Rect(x: Int32(x), y: Int32(y), w: Int32(w), h: Int32(h))
            SDL_FillRect(panel, &rect, SDL_MapRGBA(panel.pointee.format, r, g, b, a))
        }

        var y = padding
        blit(title, size: titleSize, color: white, x: padding, y: y)
        blit(subtitle, size: headingSize, color: dim, x: width - padding, y: y + px(12), rightAligned: true)
        y += px(64)
        for row in rows {
            if let section = row.section {
                blit(section.uppercased(), size: headingSize, color: accent, x: padding, y: y + px(14))
                y += headingHeight
            }
            if row.isSelected {
                fill(padding - px(14), y, width - 2 * padding + px(28), rowHeight, 70, 90, 130, 255)
                fill(padding - px(14), y, px(5), rowHeight, 138, 180, 248, 255)
            }
            blit(row.label, size: textSize, color: row.isSelected ? white : SDL_Color(r: 210, g: 210, b: 210, a: 255), x: padding + px(6), y: y, height: rowHeight)
            let value = row.isSelected && !row.value.isEmpty ? "‹  \(row.value)  ›" : row.value
            blit(value, size: textSize, color: row.isSelected ? white : accent, x: width - padding - px(6), y: y, rightAligned: true, height: rowHeight)
            y += rowHeight
        }
        blit(footer, size: headingSize, color: dim, x: padding, y: y + px(20))
        return RGBAImage(surface: panel).roundingCorners(px(18))
    }

    /// The largest size at which `text` fits in `width` x `height`, from a
    /// fixed ladder of sizes about 10 % apart. Every size measured is an open
    /// font kept in `fonts`, so searching every integer would leave a new
    /// handful behind for each alert text, for as long as the kiosk runs.
    func fittingSize(_ text: String, width: Int, height: Int) -> Int {
        let ladder = Self.fittingSizes
        var low = 0, high = ladder.count - 1, best = ladder[0]
        while low <= high {
            let mid = (low + high) / 2
            let size = ladder[mid]
            if size <= max(8, height), self.width(of: text, size: size) <= width && lineHeight(size: size) <= height {
                best = size
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

    /// 8 px up to 1080p's full height.
    static let fittingSizes: [Int] = {
        var sizes = [8]
        while sizes.last! < 1080 { sizes.append(max(sizes.last! + 1, Int((Double(sizes.last!) * 1.1).rounded()))) }
        return sizes
    }()

    /// Splits text into runs of emoji and non-emoji characters. Coarse, but
    /// it covers the sensor symbols: Misc Symbols and Dingbats, the SMP emoji
    /// blocks, and VS-16 / ZWJ kept with their emoji.
    static func runs(_ text: String) -> [(String, Bool)] {
        var runs: [(String, Bool)] = []
        for scalar in text.unicodeScalars {
            let value = scalar.value
            let isEmoji = (0x2600...0x27BF).contains(value) || (0x1F000...0x1FAFF).contains(value) || value == 0xFE0F || value == 0x200D
            if let last = runs.last, last.1 == isEmoji {
                runs[runs.count - 1].0.unicodeScalars.append(scalar)
            } else {
                runs.append((String(scalar), isEmoji))
            }
        }
        return runs
    }
}
