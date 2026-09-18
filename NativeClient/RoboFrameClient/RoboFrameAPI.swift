import Foundation

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

    private func endpoint(_ path: String, postID: Int, profile: RoboFrameProfile) throws -> URL {
        guard let base = profile.normalizedEndpoint else { throw RoboFrameAPIError.invalidEndpoint }
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "id", value: String(postID))]
        if !profile.deviceId.isEmpty { items.append(URLQueryItem(name: "deviceId", value: profile.deviceId)) }
        if !profile.accessToken.isEmpty { items.append(URLQueryItem(name: "token", value: profile.accessToken)) }
        components.queryItems = items
        guard let url = components.url else { throw RoboFrameAPIError.invalidEndpoint }
        return url
    }
}
