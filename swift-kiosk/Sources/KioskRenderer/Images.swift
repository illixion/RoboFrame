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

/// Decoded RGBA pixels, top row first, rows tightly packed.
struct RGBAImage: Sendable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

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

    func texture() -> GLTexture {
        pixels.withUnsafeBytes { GLTexture(width: width, height: height, rgba: $0.baseAddress) }
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
             leading image: RGBAImage? = nil, imageGap: Int = 8) -> RGBAImage? {
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
            var pixels = image.pixels
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
        return RGBAImage(surface: box)
    }

    /// The largest size at which `text` fits in `width` x `height`.
    func fittingSize(_ text: String, width: Int, height: Int) -> Int {
        var low = 8, high = max(8, height), best = 8
        while low <= high {
            let mid = (low + high) / 2
            if self.width(of: text, size: mid) <= width && lineHeight(size: mid) <= height {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

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
