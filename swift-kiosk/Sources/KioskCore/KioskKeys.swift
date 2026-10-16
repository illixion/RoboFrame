/*
 Keyboard and keypad shortcuts

 The same keys as the web kiosk (public/modules/ui.js) and native-kiosk.
 gpio-agent's 4x4 keypad types them through uinput, so they arrive as
 ordinary key presses:

   →        next post            t     reshuffle
   ←        previous post        1-9 0 brightness 10-90 %, 0 full
   b        block the current    d     toggle display sync
   s 0-9    switch tag list      p     hide/show the photo (clock stays)
   space    save the current     ctrl+r reload the kiosk
   m, Enter the settings menu (KioskMenu has its keys)

 Save and block confirm with a preview of the post they acted on. They act
 on `target`, which trails an automatic advance (KioskSession says why).
 */

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RoboFrameKit

public enum KioskKey: Equatable, Sendable {
    case character(Character, control: Bool = false)
    case right
    case left
    case up
    case down
    case enter
    case escape
    case backspace
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
        if isMenuOpen { return menuKey(key) }
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
        case .enter:
            openMenu()
            return nil
        case .character(let character, false):
            switch character {
            case "b":
                guard let id = currentPostID else { return nil }
                let thumbnail = thumbnailURL()
                blockCurrent()
                // The preview is fetched by id, so the server advancing past
                // the post in the meantime doesn't matter.
                Task { toast("Blocked \(id)", thumbnail: await fetchThumbnail(thumbnail)) }
                return nil
            case "m":
                openMenu()
                return nil
            case "0"..."9":
                let level = character == "0" ? 100 : (character.wholeNumberValue ?? 10) * 10
                setBrightness(level)
                return "Brightness \(config.brightness) %"
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
        guard let shown = target, let post = RoboFramePost(slideshowItem: shown.item) else { return nil }
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
    func fetchThumbnail(_ url: URL?) async -> Data? {
        guard let url else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1 << 20 else { return nil }
        return data
    }
}
