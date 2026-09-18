/*
 RoboFrame Native Client - History Overlay

 1:1 port of Hypnos's `RemoteHistoryView`: an in-window grid overlay (not a
 sheet) showing the RoboFrame server's rolling viewing history, sectioned per
 display the same way the server's own /history page is, since the same post
 can legitimately appear under more than one display's section.
 */

import SwiftUI

struct HistoryOverlayView: View {
    let store: RemoteHistoryStore
    var onEntrySelected: ((RemotePost) -> Void)?

    /// The server's sentinel bucket for requests with no deviceId.
    private static let othersDeviceId = "others"

    var body: some View {
        ScrollView {
            if store.groups.isEmpty {
                emptyState
            } else {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(store.groups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(label(for: group.deviceId))
                                .font(.headline)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                                ForEach(group.posts) { post in
                                    thumbnail(for: post)
                                }
                            }
                        }
                    }
                }
                .padding()
            }
        }
        .background(.ultraThinMaterial)
        .cornerRadius(16)
        .padding(32)
        .overlay(alignment: .topTrailing) {
            if store.isLoading {
                ProgressView().padding(16)
            }
        }
    }

    private func label(for deviceId: String) -> String {
        deviceId == Self.othersDeviceId ? "Other" : deviceId
    }

    private func thumbnail(for post: RemotePost) -> some View {
        Group {
            if let url = store.imageURL(for: post) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill).frame(height: 120).clipped().cornerRadius(8)
                    case .failure:
                        placeholder
                    case .empty:
                        placeholder.overlay(ProgressView().scaleEffect(0.6))
                    @unknown default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .onTapGesture { onEntrySelected?(post) }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            if store.isLoading {
                ProgressView()
            } else if let error = store.lastError {
                Text("History unavailable").font(.headline)
                Text(error).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("No history yet").font(.headline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .padding()
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.3)).frame(height: 120)
    }
}
