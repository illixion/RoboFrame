/*
 RoboFrame Native Client - Alert Overlay

 1:1 port of Hypnos's `RemoteAlertWindowView`: a full-bleed color card for
 WebSocket `showText` alerts.
 */

import SwiftUI

struct AlertOverlayView: View {
    let alert: RemoteAlert

    var body: some View {
        ZStack {
            backgroundColor.ignoresSafeArea()
            VStack(spacing: 24) {
                if let url = alert.imageURL {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fit).frame(maxHeight: 300)
                    } placeholder: {
                        ProgressView()
                    }
                }
                Text(alert.text)
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }
        }
        .accessibilityIdentifier("roboframe.remote.alert")
    }

    private var backgroundColor: Color {
        Color(hex: alert.colorHex) ?? .black
    }
}

private extension Color {
    init?(hex: String) {
        var hexString = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if hexString.hasPrefix("#") { hexString.removeFirst() }
        guard hexString.count == 6, let value = UInt64(hexString, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
