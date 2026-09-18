/*
 RoboFrame Native Client - Web Page Ornament View

 1:1 port of Hypnos's `WebPageOrnamentView`.
 [ Profiles | Back? | Forward? | Reload/Stop | Home | Title/URL | Auto-refresh | Hide ]
 */

import RAVEUI
import SwiftUI

struct WebPageOrnamentView: View {
    @Environment(\.dismiss) private var dismiss
    let model: WebPageModel
    var onHideControls: () -> Void

    var body: some View {
        HStack(spacing: RAVEChromeMetrics.spacing) {
            Button { dismiss() } label: { Image(systemName: "square.grid.2x2").font(.title3) }
                .raveChromeButtonStyle()
                .help("Back to Profiles")

            Divider().frame(height: 24)

            // Hidden rather than disabled: a pinned page usually has no
            // history at all, so permanently greyed-out chevrons are just
            // noise. They appear once there's somewhere to go.
            if model.canGoBack {
                Button { model.goBack() } label: { Image(systemName: "chevron.left").font(.title3) }
                    .raveChromeButtonStyle()
                    .help("Back")
            }
            if model.canGoForward {
                Button { model.goForward() } label: { Image(systemName: "chevron.right").font(.title3) }
                    .raveChromeButtonStyle()
                    .help("Forward")
            }

            Button {
                if model.isLoading { model.stopLoading() } else { model.reload() }
            } label: {
                Image(systemName: model.isLoading ? "xmark" : "arrow.clockwise").font(.title3)
            }
            .raveChromeButtonStyle()
            .help(model.isLoading ? "Stop Loading" : "Reload")

            Button { model.goHome() } label: { Image(systemName: "house").font(.title3) }
                .raveChromeButtonStyle()
                .disabled(model.profile.resolvedWebPageURL == nil)
                .help("Back to the configured page")

            Divider().frame(height: 24)

            pageLabel

            if model.profile.webAutoRefreshInterval > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise.circle")
                    Text(RoboFrameProfile.webAutoRefreshLabel(model.profile.webAutoRefreshInterval))
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .help("Auto-refreshes when idle")
            }

            Divider().frame(height: 24)

            Button { onHideControls() } label: { Image(systemName: "eye.slash").font(.title3) }
                .raveChromeButtonStyle()
                .help("Hide Controls (blocks page interaction)")
                .accessibilityIdentifier("roboframe.web.hide")
        }
        .padding(.horizontal, RAVEChromeMetrics.horizontalPadding)
        .padding(.vertical, RAVEChromeMetrics.verticalPadding)
        .chromeBackground()
    }

    private var pageLabel: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error = model.error {
                Text(error).font(.callout).foregroundStyle(.red).lineLimit(1)
            } else {
                Text(model.title.isEmpty ? model.profile.name : model.title).font(.callout).lineLimit(1)
            }
            Text(displayHost).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: 320, alignment: .leading)
    }

    /// Host of whatever is currently loaded, falling back to the raw string
    /// so a malformed URL still shows something useful.
    private var displayHost: String {
        guard let url = URL(string: model.currentURLText) else { return model.currentURLText }
        return url.host ?? model.currentURLText
    }
}
