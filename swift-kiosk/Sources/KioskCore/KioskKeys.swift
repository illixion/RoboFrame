/*
 Keyboard and keypad shortcuts

 The same keys as the web kiosk (public/modules/ui.js) and native-kiosk.
 gpio-agent's 4x4 keypad types them through uinput, so they arrive as
 ordinary key presses:

   →        next post            t     reshuffle
   ←        previous post
   b        block the current    d     toggle display sync
   s 0-9    switch tag list      p     hide/show the photo (clock stays)
   space    save the current     ctrl+r reload the kiosk
 */

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RAVERoboFrame

public enum KioskKey: Equatable, Sendable {
    case character(Character, control: Bool = false)
    case right
    case left
}

extension KioskSession {
    /// Acts on a key press and returns what to confirm on screen, if anything.
    @discardableResult
    public func handleKey(_ key: KioskKey) -> String? {
        let toast = respond(to: key)
        if let toast { self.toast(toast) }
        return toast
    }

    private func respond(to key: KioskKey) -> String? {
        let lastList = max(0, tagLists.count - 1)
        if awaitingTagList {
            awaitingTagList = false
            guard case .character(let character, false) = key, let index = character.wholeNumberValue else {
                return "Press 0-\(lastList) for tag list"
            }
            guard index < tagLists.count else { return "Tag list \(index) out of range (0-\(lastList))" }
            endHold(resume: false)
            setTagList(index)
            return "Tag list \(index)"
        }
        switch key {
        case .right:
            endHold(resume: false)
            requestNext()
            return "Next"
        case .left:
            return showPrevious()
        case .character("r", true):
            onRefresh?()
            return "Refreshing…"
        case .character(let character, false):
            switch character {
            case "b":
                guard let id = currentPostID else { return nil }
                blockCurrent()
                return "Blocked \(id)"
            case "s":
                awaitingTagList = true
                return "Tag list (0-\(lastList))?"
            case "d":
                isDisplaySyncOn.toggle()
                setDisplaySync(isDisplaySyncOn)
                return "Display Sync \(isDisplaySyncOn ? "ON" : "OFF")"
            case "p":
                setImageHidden(!isImageHidden)
                return "Image \(isImageHidden ? "hidden" : "shown")"
            case "t":
                endHold(resume: false)
                reshuffle()
                return "Reshuffling"
            case " ":
                guard let id = currentPostID else { return nil }
                let thumbnail = thumbnailURL()
                Task { await save(postID: id, thumbnail: thumbnail) }
                return "Saving \(id)"
            default:
                return nil
            }
        default:
            return nil
        }
    }

    /// `/save` for a post; the server's answer is the confirmation, with a
    /// preview of what was saved once the save itself has gone through.
    func save(postID: Int, thumbnail: URL?) async {
        guard let url = provider.endpoint.url(path: "save", postID: postID) else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(decoding: data.prefix(120), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard status == 200 else {
                toast("Save failed: \(text.isEmpty ? "HTTP \(status)" : text)")
                return
            }
            toast(text.isEmpty ? "Saved \(postID)" : text, thumbnail: await fetchThumbnail(thumbnail))
        } catch {
            toast("Save failed")
        }
    }

    /// Edge of the save preview, in pixels: 72 at 1080p.
    public var thumbnailSize: Int { max(24, Int((72 * Double(screenHeight) / 1080).rounded())) }

    /// The preview of the post on screen: a video's poster frame, a photo
    /// resized server-side, and none for an animated post, whose `/get`
    /// variant is the whole clip as an mp4 rather than a still.
    func thumbnailURL() -> URL? {
        guard let shown = engine.current, let post = RoboFramePost(slideshowItem: shown.item) else { return nil }
        var options = RoboFrameMediaOptions(width: thumbnailSize, height: thumbnailSize)
        if post.isVideo {
            options.poster = true
        } else if case .video = shown.media {
            return nil
        } else {
            options.convert = true
        }
        return provider.endpoint.mediaURL(postID: post.id, options: options)
    }

    /// Best effort: a failed preview just leaves the toast as text.
    private func fetchThumbnail(_ url: URL?) async -> Data? {
        guard let url else { return nil }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1 << 20 else { return nil }
        return data
    }
}
