import Foundation
import RoboFrameKit
import RAVESlideshow

actor RoboFrameAPI {
    private let session: URLSession = .shared

    func mediaURL(for post: RemotePost, profile: RoboFrameProfile, record: Bool = false) throws -> URL {
        var options = RoboFrameMediaOptions(record: record)
        // AVPlayer can't open these containers, and won't play an unbounded
        // chunked mp4 either, so it gets the server's source-resolution HLS
        // encode, which starts playing on its first segment.
        if post.isVideo && !post.isISOMedia {
            options.vcodec = "hls"
            options.videoMaxHeight = 0
            options.videoMaxFPS = 0
        }
        guard let url = profile.roboFrameEndpoint?.mediaURL(postID: post.id, options: options) else {
            throw RoboFrameAPIError.invalidEndpoint
        }
        return url
    }

    func save(postID: Int, profile: RoboFrameProfile) async throws -> String {
        let (data, response) = try await session.data(from: try endpoint("save", postID: postID, profile: profile))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw RoboFrameAPIError.badResponse }
        return String(decoding: data, as: UTF8.self)
    }

    func addToHistory(postID: Int, profile: RoboFrameProfile) async throws {
        _ = try await session.data(from: try endpoint("addtohistory", postID: postID, profile: profile))
    }

    func history(profile: RoboFrameProfile) async throws -> RoboFrameHistory {
        let (data, response) = try await session.data(from: try endpoint("history.json", profile: profile))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw RoboFrameAPIError.badResponse }
        return try JSONDecoder().decode(RoboFrameHistory.self, from: data)
    }

    private func endpoint(_ path: String, postID: Int, profile: RoboFrameProfile) throws -> URL {
        try endpoint(path, profile: profile, postID: postID)
    }

    private func endpoint(_ path: String, profile: RoboFrameProfile, postID: Int? = nil) throws -> URL {
        guard let url = profile.roboFrameEndpoint?.url(path: path, postID: postID) else {
            throw RoboFrameAPIError.invalidEndpoint
        }
        return url
    }
}

@MainActor
final class RoboFrameSlideshowProvider: RAVESlideshowContentProvider {
    private let profile: RoboFrameProfile
    private let api: RoboFrameAPI

    init(profile: RoboFrameProfile, api: RoboFrameAPI = RoboFrameAPI()) {
        self.profile = profile
        self.api = api
    }

    func fetchMoreContent(_ request: RAVESlideshowFetchRequest) async throws -> [RAVESlideshowItem] {
        // RoboFrame's channel is server-authoritative: playback frames select
        // items, so the generic engine must never perform a client-side search.
        []
    }

    func loadMedia(for item: RAVESlideshowItem, maxResolution: Int) async throws -> RAVESlideshowLoadedMedia {
        guard let post = RemotePost(slideshowItem: item) else { throw RoboFrameAPIError.badResponse }
        let url = try await api.mediaURL(for: post, profile: profile, record: false)
        if post.isVideo { return .video(url: url, hlsURL: nil) }
        return .still(data: try await URLSession.shared.data(from: url).0, displayURL: url)
    }

    func displayURL(for item: RAVESlideshowItem) -> URL? {
        nil
    }

    func didDisplay(_ item: RAVESlideshowItem) async {
        guard let post = RemotePost(slideshowItem: item) else { return }
        try? await api.addToHistory(postID: post.id, profile: profile)
    }
}
