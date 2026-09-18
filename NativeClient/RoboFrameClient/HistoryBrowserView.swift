import SwiftUI

struct HistoryBrowserView: View {
    let profile: RoboFrameProfile
    @State private var history: RoboFrameHistory?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let history {
                    List {
                        Section("Recently shown") {
                            ForEach(history.history) { post in HistoryPostRow(post: post, profile: profile) }
                        }
                        ForEach(history.groups) { group in
                            Section(group.deviceId.isEmpty ? "Other requests" : group.deviceId) {
                                ForEach(group.posts) { post in HistoryPostRow(post: post, profile: profile) }
                            }
                        }
                    }
                } else if let error {
                    ContentUnavailableView("History unavailable", systemImage: "clock.badge.exclamationmark", description: Text(error))
                } else {
                    ProgressView("Loading history…")
                }
            }
            .navigationTitle("Viewing History")
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Reload", systemImage: "arrow.clockwise") { load() } } }
            .task { load() }
        }
        .accessibilityIdentifier("roboframe.history.browser")
    }

    private func load() {
        Task {
            do { history = try await RoboFrameAPI().history(profile: profile); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct HistoryPostRow: View {
    let post: RemotePost
    let profile: RoboFrameProfile

    var body: some View {
        HStack {
            AsyncImage(url: profile.mediaURL(for: post, record: false)) { phase in
                phase.image?.resizable().scaledToFill()
            }
            .frame(width: 64, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading) {
                Text("#\(post.id)")
                Text(post.ext.uppercased()).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
