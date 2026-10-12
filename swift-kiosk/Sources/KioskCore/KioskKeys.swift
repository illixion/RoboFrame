/*
 Keyboard and keypad shortcuts

 The same keys as the web kiosk (public/modules/ui.js) and native-kiosk.
 gpio-agent's 4x4 keypad types them through uinput, so they arrive as
 ordinary key presses:

   →        next post            t     reshuffle
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
            setTagList(index)
            return "Tag list \(index)"
        }
        switch key {
        case .right:
            requestNext()
            return "Next"
        case .left:
            return "Previous isn't supported yet"
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
                reshuffle()
                return "Reshuffling"
            case " ":
                guard let id = currentPostID else { return nil }
                Task { await save(postID: id) }
                return "Saving \(id)"
            default:
                return nil
            }
        default:
            return nil
        }
    }

    /// `/save` for a post; the server's answer is the confirmation.
    func save(postID: Int) async {
        guard let url = provider.endpoint.url(path: "save", postID: postID) else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(decoding: data.prefix(120), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            toast(status == 200 ? (text.isEmpty ? "Saved \(postID)" : text) : "Save failed: \(text.isEmpty ? "HTTP \(status)" : text)")
        } catch {
            toast("Save failed")
        }
    }
}
