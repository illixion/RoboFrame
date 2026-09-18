import AVKit
import RAVESlideshow
import SwiftUI

struct RoboFrameSlideshowSurface: View {
    let model: SlideshowModel

    var body: some View {
        RAVESlideshowSurface(engine: model.engine) { context in
            StillSlideshowMedia(context: context)
        } animated: { context in
            StillSlideshowMedia(context: context)
        } video: { context in
            SlideshowVideoMedia(context: context, pseudo3D: model.profile.slideshow3DMode == .pseudo3D)
        } placeholder: {
            ProgressView("Waiting for RoboFrame…")
                .tint(.white)
                .foregroundStyle(.white)
        }
    }
}

private struct StillSlideshowMedia: View {
    let context: RAVESlideshowRenderContext

    var body: some View {
        switch context.media.media {
        case .still(let data, _):
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .brightness(context.visualSettings.brightness)
                    .contrast(context.visualSettings.contrast)
                    .saturation(context.visualSettings.saturation)
                    .modifier(SpatialImageTreatment(enabled: context.displaySettings.mode3D == .spatial3D))
            } else {
                ContentUnavailableView("Media unavailable", systemImage: "exclamationmark.triangle")
            }
        case .animatedImage(_, let url):
            AsyncImage(url: url) { $0.image?.resizable().scaledToFit() }
        case .video:
            EmptyView()
        }
    }
}

private struct SlideshowVideoMedia: View {
    let context: RAVESlideshowRenderContext
    let pseudo3D: Bool

    var body: some View {
        guard case .video(let url, _) = context.media.media else { return AnyView(EmptyView()) }
        #if os(visionOS)
        if pseudo3D {
            return AnyView(Pseudo3DSlideshowVideo(url: url, visualSettings: context.visualSettings))
        }
        #endif
        return AnyView(VideoPlayer(player: AVPlayer(url: url)))
    }
}

#if os(visionOS)
import RAVEMedia
import RealityKit

private struct Pseudo3DSlideshowVideo: View {
    let url: URL
    let visualSettings: RAVESlideshowVisualSettings
    @State private var engine = Pseudo3DStereoEngine()
    @State private var failed = false

    var body: some View {
        Group {
            if failed {
                VideoPlayer(player: AVPlayer(url: url))
            } else {
                GeometryReader3D { _ in
                    RealityView { content in
                        let entity = engine.makeVideoEntity()
                        content.add(entity)
                        engine.observeVideoSize(content: content)
                    } update: { _ in
                        engine.configure(
                            adjustments: RAVEColorAdjustments(
                                brightness: visualSettings.brightness,
                                contrast: visualSettings.contrast,
                                saturation: visualSettings.saturation
                            ),
                            settings: .default,
                            isFlipped: false
                        )
                    }
                }
                .task {
                    engine.onPlaybackError = { failed = true }
                    engine.loops = true
                    engine.load(url: url, roomActive: true, depthMode: .realtime)
                }
            }
        }
    }
}
#endif

private struct SpatialImageTreatment: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        #if os(visionOS)
        content
            .shadow(color: enabled ? .cyan.opacity(0.38) : .clear, radius: enabled ? 26 : 0, y: enabled ? 10 : 0)
            .rotation3DEffect(.degrees(enabled ? -1.5 : 0), axis: (x: 0, y: 1, z: 0))
        #else
        content
        #endif
    }
}
