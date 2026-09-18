/*
 RoboFrame Native Client - History Store

 Fetches and holds the RoboFrame server's rolling viewing history
 (`/history.json`), shared by every viewer window pointed at the same
 endpoint. Mirrors Hypnos's `RemoteHistoryStore`.
 */

import Foundation
import Observation

@MainActor @Observable
final class RemoteHistoryStore {
    private(set) var groups: [RoboFrameHistory.Group] = []
    private(set) var isLoading = false
    private(set) var lastError: String?
    private let profile: RoboFrameProfile
    private let api = RoboFrameAPI()

    init(profile: RoboFrameProfile) { self.profile = profile }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let history = try await api.history(profile: profile)
            groups = history.groups
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// `RoboFrameProfile.mediaURL` is pure URL-building (no network), so it
    /// can be called synchronously from an `AsyncImage` binding point.
    func imageURL(for post: RemotePost) -> URL? {
        profile.mediaURL(for: post, record: false)
    }
}
