import Foundation
import RAVESlideshow

struct RoboFrameHistory: Decodable, Equatable {
    struct Group: Decodable, Identifiable, Equatable {
        let deviceId: String
        let posts: [RemotePost]
        var id: String { deviceId }
    }

    let history: [RemotePost]
    let groups: [Group]
}

actor RoboFrameAPI {
    private let session: URLSession = .shared

    func mediaURL(for post: RemotePost, profile: RoboFrameProfile, record: Bool = false) throws -> URL {
        guard let base = profile.normalizedEndpoint else { throw RoboFrameAPIError.invalidEndpoint }
        var components = URLComponents(url: base.appending(path: "get"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "id", value: String(post.id))]
        items.append(URLQueryItem(name: "record", value: record ? "1" : "0"))
        if !profile.deviceId.isEmpty { items.append(URLQueryItem(name: "deviceId", value: profile.deviceId)) }
        if !profile.accessToken.isEmpty { items.append(URLQueryItem(name: "token", value: profile.accessToken)) }
        components.queryItems = items
        guard let url = components.url else { throw RoboFrameAPIError.invalidEndpoint }
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
        guard let base = profile.normalizedEndpoint else { throw RoboFrameAPIError.invalidEndpoint }
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
        var items: [URLQueryItem] = []
        if let postID { items.append(URLQueryItem(name: "id", value: String(postID))) }
        if !profile.deviceId.isEmpty { items.append(URLQueryItem(name: "deviceId", value: profile.deviceId)) }
        if !profile.accessToken.isEmpty { items.append(URLQueryItem(name: "token", value: profile.accessToken)) }
        components.queryItems = items
        guard let url = components.url else { throw RoboFrameAPIError.invalidEndpoint }
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

extension RemotePost {
    var slideshowItem: RAVESlideshowItem {
        RAVESlideshowItem(
            id: String(id),
            mediaKind: isVideo ? .video : .image,
            fileExtension: ext,
            duration: durationMs.map { Double($0) / 1_000 },
            metadata: ["postID": String(id)]
        )
    }

    init?(slideshowItem: RAVESlideshowItem) {
        guard let id = Int(slideshowItem.metadata["postID"] ?? slideshowItem.id) else { return nil }
        self.init(id: id, ext: slideshowItem.fileExtension, durationMs: slideshowItem.duration.map { Int($0 * 1_000) })
    }
}
