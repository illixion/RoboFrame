/*
 Kiosk media provider

 Feeds the shared slideshow engine. RoboFrame's channel is server-
 authoritative, so the engine never searches: `playback` frames choose the
 items, and this only loads them.

 Stills come from `/get` already sized to the screen and re-encoded to JPEG
 (`convert`, `lowmem`), which the Pi decodes in hardware. Video posts aren't
 fetched at all: the player streams them from the URL, as the H.264 transcode
 VideoCore can decode. An animated post comes back from the stills path as an
 mp4 (the response's Content-Type is the only signal), so it is handed to the
 player the same way, from its still URL; the server keeps that variant
 cached, so the second fetch is a cache hit.
 */

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RAVERoboFrame
import RAVESlideshowCore

public enum KioskMediaError: Error, CustomStringConvertible {
    case badPost
    case badURL
    case status(Int)
    case tooLarge(Int)

    public var description: String {
        switch self {
        case .badPost: "not a RoboFrame post"
        case .badURL: "couldn't build the media URL"
        case .status(let code): "server answered \(code)"
        case .tooLarge(let bytes): "response too large (\(bytes) bytes)"
        }
    }
}

@MainActor
public final class KioskMediaProvider: RAVESlideshowContentProvider {
    public private(set) var endpoint: RoboFrameEndpoint
    private let config: KioskConfig
    private let session: URLSession
    private var screen: (width: Int, height: Int)

    public init(endpoint: RoboFrameEndpoint, config: KioskConfig, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.config = config
        self.session = session
        self.screen = (config.screenWidth, config.screenHeight)
    }

    /// The size stills are requested at. Must match what `slideshowConfig` advertised.
    public func setScreenSize(width: Int, height: Int) {
        screen = (width, height)
    }

    public func fetchMoreContent(_ request: RAVESlideshowFetchRequest) async throws -> [RAVESlideshowItem] {
        []
    }

    public func loadMedia(for item: RAVESlideshowItem, maxResolution: Int) async throws -> RAVESlideshowLoadedMedia {
        guard let post = RoboFramePost(slideshowItem: item) else { throw KioskMediaError.badPost }
        if post.isVideo {
            guard let url = videoURL(for: post) else { throw KioskMediaError.badURL }
            return .video(url: url, hlsURL: nil)
        }
        guard let url = stillURL(for: post) else { throw KioskMediaError.badURL }
        let (data, response) = try await session.data(from: url)
        let http = response as? HTTPURLResponse
        if let status = http?.statusCode, status != 200 { throw KioskMediaError.status(status) }
        if http?.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("video/") == true {
            return .video(url: url, hlsURL: nil)
        }
        guard data.count <= config.maxMediaBytes else { throw KioskMediaError.tooLarge(data.count) }
        return .still(data: data, displayURL: url)
    }

    public func displayURL(for item: RAVESlideshowItem) -> URL? {
        nil
    }

    /// `/get` for a still, sized to the screen. Recorded as a view.
    public func stillURL(for post: RoboFramePost) -> URL? {
        endpoint.mediaURL(postID: post.id, options: RoboFrameMediaOptions(
            record: true,
            width: screen.width,
            height: screen.height,
            convert: true,
            lowmem: config.lowmem,
            bright: config.bright,
            wallpaper: config.wallpaper
        ))
    }

    /// `/get` for a video post: the hardware-decodable transcode, capped in
    /// height. Resizing flags are ignored server-side for video, so none are sent.
    public func videoURL(for post: RoboFramePost) -> URL? {
        var options = RoboFrameMediaOptions(record: true)
        if let vcodec = config.vcodec {
            options.vcodec = vcodec
            options.videoMaxHeight = config.videoMaxHeight
        }
        return endpoint.mediaURL(postID: post.id, options: options)
    }
}
