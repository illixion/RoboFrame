/*
 RoboFrame Native Client - Mod Tag Manager

 Port of Hypnos's `ModTagManager`. Local catalog of "mod tag" presets — extra
 tag clauses appended to the RoboFrame orchestrator's query for the active
 channel. There is no server-side mod-tag catalog; the server only learns the
 active mod tags via `slideshowConfig` (on connect) or `setModTags` (on
 switch). All viewer windows share one instance so a switch is synchronized
 across every window connected to the same RoboFrame instance.
 */

import Foundation
import Observation
import os

@MainActor
@Observable
final class ModTagManager {
    static let shared = ModTagManager()

    /// User-curated catalog of mod-tag presets. Each entry is an array of tag
    /// strings appended to the active channel's query.
    var modTagLists: [[String]] = [] {
        didSet { save() }
    }

    /// The currently active preset index, or nil for "no mod tags".
    private(set) var activeIndex: Int?

    /// User preference for which preset to apply on launch. nil = pick up
    /// from `lastActiveIndex`, or no mod tags if there's nothing recorded.
    var defaultIndex: Int? {
        didSet { save() }
    }

    /// Recovery hint across launches.
    private(set) var lastActiveIndex: Int?

    /// Network senders — one per active slideshow session. Called with the
    /// new active tags after a switch so each connected window can push
    /// `setModTags` to its WebSocket.
    private var sendHandlers: [String: ([String]) -> Void] = [:]

    var activeTags: [String] {
        guard let idx = activeIndex, idx >= 0, idx < modTagLists.count else { return [] }
        return modTagLists[idx]
    }

    var isActive: Bool { activeIndex != nil }

    private static let modTagListsKey = "ModTagManager.modTagLists"
    private static let defaultIndexKey = "ModTagManager.defaultIndex"
    private static let lastActiveIndexKey = "ModTagManager.lastActiveIndex"
    private static let logger = Logger(subsystem: "com.illixion.roboframe.client", category: "ModTagManager")

    private init() {
        load()
    }

    func addSendHandler(id: String, _ handler: @escaping ([String]) -> Void) {
        sendHandlers[id] = handler
    }

    func removeSendHandler(id: String) {
        sendHandlers[id] = nil
    }

    func switchToPreset(_ index: Int?) {
        let target: Int? = (index != nil && index! >= 0 && index! < modTagLists.count) ? index : nil
        guard target != activeIndex else { return }
        activeIndex = target
        if let idx = target { lastActiveIndex = idx }
        save()
        notifySendHandlers()
    }

    func clearActive() { switchToPreset(nil) }

    private func initialize() {
        let preferred = defaultIndex ?? lastActiveIndex
        if let idx = preferred, idx >= 0, idx < modTagLists.count {
            activeIndex = idx
        } else {
            activeIndex = nil
        }
    }

    private func save() {
        let defaults = UserDefaults.standard
        if let data = try? JSONEncoder().encode(modTagLists) {
            defaults.set(data, forKey: Self.modTagListsKey)
        }
        if let idx = defaultIndex {
            defaults.set(idx, forKey: Self.defaultIndexKey)
        } else {
            defaults.removeObject(forKey: Self.defaultIndexKey)
        }
        if let idx = lastActiveIndex {
            defaults.set(idx, forKey: Self.lastActiveIndexKey)
        } else {
            defaults.removeObject(forKey: Self.lastActiveIndexKey)
        }
    }

    private func load() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: Self.modTagListsKey),
           let lists = try? JSONDecoder().decode([[String]].self, from: data) {
            modTagLists = lists
        }
        defaultIndex = defaults.object(forKey: Self.defaultIndexKey) != nil ? defaults.integer(forKey: Self.defaultIndexKey) : nil
        lastActiveIndex = defaults.object(forKey: Self.lastActiveIndexKey) != nil ? defaults.integer(forKey: Self.lastActiveIndexKey) : nil
        initialize()
        Self.logger.info("ModTagManager loaded: \(self.modTagLists.count, privacy: .public) presets")
    }

    private func notifySendHandlers() {
        let tags = activeTags
        for handler in sendHandlers.values { handler(tags) }
    }
}
