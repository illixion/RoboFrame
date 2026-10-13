/*
 OpenGL ES 2

 The smallest GL layer the compositor needs, sized to the Pi 3's VideoCore
 IV (GLES 2.0, 2048-pixel textures, no RGB888 texture format, so every
 upload is RGBA). Everything is drawn as one unit quad, placed and textured
 by uniforms; there is no depth buffer and no mipmapping.

 VC4 allocates every texture and framebuffer from the kernel's CMA pool
 (256 MB, shared with X, the compositor and the video decoder, which needs
 megabytes of it contiguous). Allocating a fresh, differently sized texture
 per photo fragments that pool until the decoder can't start, so the big
 surfaces are allocated once at a fixed size and refilled in place.

 All of it runs on the main thread, which owns the GL context.
 */

import CGLES2

enum GLError: Error, CustomStringConvertible {
    case compile(String)
    case link(String)
    case framebuffer(GLenum)

    var description: String {
        switch self {
        case .compile(let log): "shader didn't compile: \(log)"
        case .link(let log): "program didn't link: \(log)"
        case .framebuffer(let status): "framebuffer incomplete (0x\(String(status, radix: 16)))"
        }
    }
}

/// A rectangle in screen pixels, origin top left.
struct PixelRect: Equatable {
    var x: Float
    var y: Float
    var width: Float
    var height: Float
}

final class GLTexture {
    let id: GLuint
    let width: Int
    let height: Int

    /// An RGBA texture, from tightly packed rows (top row first), or empty.
    init(width: Int, height: Int, rgba: UnsafeRawPointer?) {
        var id: GLuint = 0
        glGenTextures(1, &id)
        self.id = id
        self.width = width
        self.height = height
        glBindTexture(GLenum(GL_TEXTURE_2D), id)
        glTexParameteri(GLenum(GL_TEXTURE_2D), GLenum(GL_TEXTURE_MIN_FILTER), GL_LINEAR)
        glTexParameteri(GLenum(GL_TEXTURE_2D), GLenum(GL_TEXTURE_MAG_FILTER), GL_LINEAR)
        glTexParameteri(GLenum(GL_TEXTURE_2D), GLenum(GL_TEXTURE_WRAP_S), GL_CLAMP_TO_EDGE)
        glTexParameteri(GLenum(GL_TEXTURE_2D), GLenum(GL_TEXTURE_WRAP_T), GL_CLAMP_TO_EDGE)
        glPixelStorei(GLenum(GL_UNPACK_ALIGNMENT), 4)
        glTexImage2D(GLenum(GL_TEXTURE_2D), 0, GL_RGBA, GLsizei(width), GLsizei(height), 0,
                     GLenum(GL_RGBA), GLenum(GL_UNSIGNED_BYTE), rgba)
    }

    deinit {
        var id = id
        glDeleteTextures(1, &id)
    }
}

/// A screen-sized texture a photo is copied into. Photos are never larger
/// than the screen (the server sizes them to it), so one slot fits any.
final class GLPhotoSlot {
    let texture: GLTexture
    private(set) var width = 0
    private(set) var height = 0

    init(width: Int, height: Int) {
        texture = GLTexture(width: width, height: height, rgba: nil)
    }

    /// The photo's blurred copy, for the bars beside it (DecodedPhoto).
    private let backdropTexture = GLTexture(width: DecodedPhoto.backdropSize, height: DecodedPhoto.backdropSize, rgba: nil)
    private(set) var backdropSize: (width: Int, height: Int)?
    private(set) var focus = (x: 0.5, y: 0.5)

    func upload(_ photo: DecodedPhoto) {
        upload(photo.image)
        focus = photo.focus
        backdropSize = nil
        if let backdrop = photo.backdrop, backdrop.width <= backdropTexture.width, backdrop.height <= backdropTexture.height {
            glBindTexture(GLenum(GL_TEXTURE_2D), backdropTexture.id)
            backdrop.pixels.withUnsafeBytes {
                glTexSubImage2D(GLenum(GL_TEXTURE_2D), 0, 0, 0, GLsizei(backdrop.width), GLsizei(backdrop.height),
                                GLenum(GL_RGBA), GLenum(GL_UNSIGNED_BYTE), $0.baseAddress)
            }
            backdropSize = (backdrop.width, backdrop.height)
        }
    }

    /// The backdrop texture and the part of it the copy fills, when there is one.
    var backdrop: (texture: GLTexture, region: GLCompositor.Region, width: Int, height: Int)? {
        guard let size = backdropSize else { return nil }
        let w = Float(backdropTexture.width), h = Float(backdropTexture.height)
        return (backdropTexture, GLCompositor.Region(u: 0.5 / w, v: 0.5 / h, width: (Float(size.width) - 1) / w, height: (Float(size.height) - 1) / h),
                size.width, size.height)
    }

    func upload(_ image: RGBAImage) {
        width = min(image.width, texture.width)
        height = min(image.height, texture.height)
        glBindTexture(GLenum(GL_TEXTURE_2D), texture.id)
        glPixelStorei(GLenum(GL_UNPACK_ALIGNMENT), 4)
        image.pixels.withUnsafeBytes {
            glTexSubImage2D(GLenum(GL_TEXTURE_2D), 0, 0, 0, GLsizei(width), GLsizei(height),
                            GLenum(GL_RGBA), GLenum(GL_UNSIGNED_BYTE), $0.baseAddress)
        }
    }

    /// The part of the texture the photo fills, inset half a texel so
    /// filtering never reaches the previous photo's pixels beyond it.
    var region: GLCompositor.Region {
        let textureWidth = Float(texture.width), textureHeight = Float(texture.height)
        return GLCompositor.Region(u: 0.5 / textureWidth, v: 0.5 / textureHeight,
                                   width: (Float(width) - 1) / textureWidth, height: (Float(height) - 1) / textureHeight)
    }
}

/// A texture to render into: what libmpv draws each video frame onto, so
/// the compositor can fade it like a photo.
final class GLRenderTarget {
    let texture: GLTexture
    let framebuffer: GLuint

    init(width: Int, height: Int) throws {
        texture = GLTexture(width: width, height: height, rgba: nil)
        var framebuffer: GLuint = 0
        glGenFramebuffers(1, &framebuffer)
        self.framebuffer = framebuffer
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), framebuffer)
        glFramebufferTexture2D(GLenum(GL_FRAMEBUFFER), GLenum(GL_COLOR_ATTACHMENT0), GLenum(GL_TEXTURE_2D), texture.id, 0)
        let status = glCheckFramebufferStatus(GLenum(GL_FRAMEBUFFER))
        glClearColor(0, 0, 0, 1)
        glClear(GLbitfield(GL_COLOR_BUFFER_BIT))
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), 0)
        guard status == GLenum(GL_FRAMEBUFFER_COMPLETE) else {
            var framebuffer = framebuffer
            glDeleteFramebuffers(1, &framebuffer)
            throw GLError.framebuffer(status)
        }
    }

    /// Blacks it out, so a reused target never flashes its last video.
    func clear() {
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), framebuffer)
        glClearColor(0, 0, 0, 1)
        glClear(GLbitfield(GL_COLOR_BUFFER_BIT))
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), 0)
    }

    deinit {
        var framebuffer = framebuffer
        glDeleteFramebuffers(1, &framebuffer)
    }
}

/// Draws textured and solid quads onto the default framebuffer.
final class GLCompositor {
    /// A part of a texture, in texture coordinates.
    struct Region {
        var u: Float = 0
        var v: Float = 0
        var width: Float = 1
        var height: Float = 1
    }

    enum Blend {
        /// Ordinary alpha blending, for the overlay.
        case over
        /// Adds the layer's colour times its opacity: two layers at t and
        /// 1 - t sum to an exact crossfade, letterbox bars included.
        case add
    }

    private let textured: GLuint
    private let solid: GLuint
    private let quad: GLuint
    private var width: Float = 1
    private var height: Float = 1

    private let texturedRect: GLint
    private let texturedUV: GLint
    private let texturedAlpha: GLint
    private let texturedSampler: GLint
    private let solidRect: GLint
    private let solidColor: GLint

    private static let vertexShader = """
        attribute vec2 a_pos;
        uniform vec4 u_rect;
        uniform vec4 u_uv;
        varying vec2 v_uv;
        void main() {
            v_uv = u_uv.xy + a_pos * u_uv.zw;
            gl_Position = vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
        }
        """

    private static let texturedShader = """
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_texture;
        uniform float u_alpha;
        void main() {
            vec4 color = texture2D(u_texture, v_uv);
            gl_FragColor = vec4(color.rgb, color.a * u_alpha);
        }
        """

    private static let solidShader = """
        precision mediump float;
        uniform vec4 u_color;
        void main() {
            gl_FragColor = u_color;
        }
        """

    init() throws {
        textured = try Self.program(vertex: Self.vertexShader, fragment: Self.texturedShader)
        solid = try Self.program(vertex: Self.vertexShader, fragment: Self.solidShader)
        texturedRect = glGetUniformLocation(textured, "u_rect")
        texturedUV = glGetUniformLocation(textured, "u_uv")
        texturedAlpha = glGetUniformLocation(textured, "u_alpha")
        texturedSampler = glGetUniformLocation(textured, "u_texture")
        solidRect = glGetUniformLocation(solid, "u_rect")
        solidColor = glGetUniformLocation(solid, "u_color")

        var quad: GLuint = 0
        glGenBuffers(1, &quad)
        self.quad = quad
        let corners: [GLfloat] = [0, 0, 1, 0, 0, 1, 1, 1]
        glBindBuffer(GLenum(GL_ARRAY_BUFFER), quad)
        corners.withUnsafeBytes { bytes in
            glBufferData(GLenum(GL_ARRAY_BUFFER), bytes.count, bytes.baseAddress, GLenum(GL_STATIC_DRAW))
        }
    }

    /// Starts a frame on the screen: libmpv leaves its own GL state behind,
    /// so every frame sets everything it relies on.
    func begin(width: Int, height: Int) {
        self.width = Float(width)
        self.height = Float(height)
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), 0)
        glViewport(0, 0, GLsizei(width), GLsizei(height))
        glDisable(GLenum(GL_DEPTH_TEST))
        glDisable(GLenum(GL_SCISSOR_TEST))
        glDisable(GLenum(GL_CULL_FACE))
        glEnable(GLenum(GL_BLEND))
        glClearColor(0, 0, 0, 1)
        glClear(GLbitfield(GL_COLOR_BUFFER_BIT))
        glBindBuffer(GLenum(GL_ARRAY_BUFFER), quad)
        glEnableVertexAttribArray(0)
        glVertexAttribPointer(0, 2, GLenum(GL_FLOAT), GLboolean(GL_FALSE), 0, nil)
        glActiveTexture(GLenum(GL_TEXTURE0))
    }

    func draw(_ texture: GLTexture, in rect: PixelRect, alpha: Float, blend: Blend, region: Region = Region()) {
        guard alpha > 0 else { return }
        glUseProgram(textured)
        setBlend(blend)
        glBindTexture(GLenum(GL_TEXTURE_2D), texture.id)
        glUniform1i(texturedSampler, 0)
        setRect(texturedRect, rect)
        glUniform4f(texturedUV, region.u, region.v, region.width, region.height)
        glUniform1f(texturedAlpha, alpha)
        glDrawArrays(GLenum(GL_TRIANGLE_STRIP), 0, 4)
    }

    func fill(_ rect: PixelRect, red: Float, green: Float, blue: Float, alpha: Float) {
        glUseProgram(solid)
        setBlend(.over)
        setRect(solidRect, rect)
        glUniform4f(solidColor, red, green, blue, alpha)
        glDrawArrays(GLenum(GL_TRIANGLE_STRIP), 0, 4)
    }

    private func setBlend(_ blend: Blend) {
        switch blend {
        case .over: glBlendFunc(GLenum(GL_SRC_ALPHA), GLenum(GL_ONE_MINUS_SRC_ALPHA))
        case .add: glBlendFunc(GLenum(GL_SRC_ALPHA), GLenum(GL_ONE))
        }
    }

    /// Pixel rect (top left origin) to clip space: the quad's (0, 0) corner
    /// is the rect's top left, which is also the texture's first row.
    private func setRect(_ location: GLint, _ rect: PixelRect) {
        glUniform4f(location,
                    rect.x / width * 2 - 1,
                    1 - rect.y / height * 2,
                    rect.width / width * 2,
                    -rect.height / height * 2)
    }

    private static func program(vertex: String, fragment: String) throws -> GLuint {
        let vertexShader = try compile(GLenum(GL_VERTEX_SHADER), vertex)
        let fragmentShader = try compile(GLenum(GL_FRAGMENT_SHADER), fragment)
        let program = glCreateProgram()
        glAttachShader(program, vertexShader)
        glAttachShader(program, fragmentShader)
        glBindAttribLocation(program, 0, "a_pos")
        glLinkProgram(program)
        glDeleteShader(vertexShader)
        glDeleteShader(fragmentShader)
        var linked: GLint = 0
        glGetProgramiv(program, GLenum(GL_LINK_STATUS), &linked)
        guard linked != 0 else {
            throw GLError.link(infoLog { glGetProgramInfoLog(program, $0, nil, $1) })
        }
        return program
    }

    private static func compile(_ kind: GLenum, _ source: String) throws -> GLuint {
        let shader = glCreateShader(kind)
        source.withCString { text in
            var pointer: UnsafePointer<GLchar>? = text
            glShaderSource(shader, 1, &pointer, nil)
        }
        glCompileShader(shader)
        var compiled: GLint = 0
        glGetShaderiv(shader, GLenum(GL_COMPILE_STATUS), &compiled)
        guard compiled != 0 else {
            throw GLError.compile(infoLog { glGetShaderInfoLog(shader, $0, nil, $1) })
        }
        return shader
    }

    private static func infoLog(_ read: (GLsizei, UnsafeMutablePointer<GLchar>) -> Void) -> String {
        var buffer = [GLchar](repeating: 0, count: 1024)
        read(GLsizei(buffer.count), &buffer)
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    static var maxTextureSize: Int {
        var size: GLint = 0
        glGetIntegerv(GLenum(GL_MAX_TEXTURE_SIZE), &size)
        return Int(size)
    }
}
