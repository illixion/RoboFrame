/*
 Settings menu

 What the config file sets, adjustable at the frame: `m` (or Enter, or the
 keypad's C held) opens it. It has to work from the 4x4 keypad, which has
 no arrows but ← and →, so the digits around 5 are a d-pad as well:

   ↑ or 2 / ↓ or 8    move               ← or 4 / → or 6    change the value
   Enter, space or 5  toggle / run       Esc, m, p or 0     close

 A change applies at once and is saved to the settings file (KioskConfig),
 so it survives a restart. The menu closes itself after `timeout` without
 a key, so a frame left with it open goes back to being a frame.
 */

import Foundation

public struct KioskMenuState: Equatable, Sendable {
    public var selection = 0
    var lastInput: TimeInterval
    public static let timeout: TimeInterval = 30
}

/// One line of the menu as the renderer draws it.
public struct KioskMenuRow: Equatable, Sendable {
    /// A heading drawn above this row, when it starts a section.
    public let section: String?
    public let label: String
    public let value: String
    public let isSelected: Bool
}

enum KioskMenuItem: CaseIterable {
    case interval, transition, kenBurns
    case fit, blurBackground, brightness, bright, nightLight
    case clock, seconds, date, sensors
    case tagList, displaySync, reshuffle
    case restart, reset

    var section: String? {
        switch self {
        case .interval: "Slideshow"
        case .fit: "Picture"
        case .clock: "Overlay"
        case .tagList: "Channel"
        case .restart: "Kiosk"
        default: nil
        }
    }

    var label: String {
        switch self {
        case .interval: "Show each photo for"
        case .transition: "Crossfade"
        case .kenBurns: "Ken Burns zoom"
        case .fit: "Fit"
        case .blurBackground: "Beside the photo"
        case .brightness: "Brightness"
        case .bright: "Dimmed variant"
        case .nightLight: "Night light"
        case .clock: "Clock"
        case .seconds: "Seconds"
        case .date: "Date"
        case .sensors: "Sensors"
        case .tagList: "Tag list"
        case .displaySync: "Display sync"
        case .reshuffle: "Reshuffle the order"
        case .restart: "Restart the kiosk"
        case .reset: "Reset settings to the config"
        }
    }

    static let intervals = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600]
    static let transitions: [Double] = [0, 0.5, 1, 1.5, 2, 3]
}

extension KioskSession {
    public var isMenuOpen: Bool { menu != nil }

    public func openMenu() {
        menu = KioskMenuState(lastInput: now)
        onChange?()
    }

    public func closeMenu() {
        guard menu != nil else { return }
        menu = nil
        onChange?()
    }

    public var menuRows: [KioskMenuRow] {
        let selection = menu?.selection ?? -1
        return KioskMenuItem.allCases.enumerated().map { index, item in
            KioskMenuRow(section: item.section, label: item.label, value: value(of: item), isSelected: index == selection)
        }
    }

    /// A key while the menu is open. Returns a toast, if any.
    func menuKey(_ key: KioskKey) -> String? {
        guard var state = menu else { return nil }
        state.lastInput = now
        let items = KioskMenuItem.allCases
        let item = items[state.selection]
        switch key {
        case .up, .character("2", false):
            state.selection = (state.selection + items.count - 1) % items.count
        case .down, .character("8", false):
            state.selection = (state.selection + 1) % items.count
        case .left, .character("4", false):
            menu = state
            return adjust(item, by: -1)
        case .right, .character("6", false):
            menu = state
            return adjust(item, by: 1)
        case .enter, .character(" ", false), .character("5", false):
            menu = state
            return activate(item)
        case .escape, .backspace, .character("m", false), .character("p", false), .character("0", false):
            closeMenu()
            return nil
        default:
            break
        }
        menu = state
        onChange?()
        return nil
    }

    private func activate(_ item: KioskMenuItem) -> String? {
        switch item {
        case .reshuffle:
            endHold(resume: false)
            reshuffle()
            return "Reshuffling"
        case .restart:
            onRefresh?()
            return "Restarting…"
        case .reset:
            guard !settings.isEmpty else { return "Nothing to reset" }
            settings.removeAll()
            onRefresh?()
            return "Settings reset"
        default:
            return adjust(item, by: 1)
        }
    }

    private func adjust(_ item: KioskMenuItem, by step: Int) -> String? {
        switch item {
        case .interval:
            let seconds = Self.stepped(KioskMenuItem.intervals, current: config.intervalMs / 1_000, by: step)
            update("interval", .number(Double(seconds * 1_000))) { $0.intervalMs = seconds * 1_000 }
        case .transition:
            let seconds = Self.stepped(KioskMenuItem.transitions, current: config.transitionDuration, by: step)
            update("transitionMs", .number((seconds * 1_000).rounded())) { $0.transitionDuration = seconds }
        case .kenBurns:
            update("kenBurns", .bool(!config.kenBurns)) { $0.kenBurns.toggle() }
        case .fit:
            let fit: KioskConfig.Fit = config.fit == .contain ? .cover : .contain
            update("fit", .string(fit.rawValue)) { $0.fit = fit }
        case .blurBackground:
            update("blurBackground", .bool(!config.blurBackground)) { $0.blurBackground.toggle() }
        case .brightness:
            let level = KioskConfig.clampBrightness(config.brightness + step * 10)
            setBrightness(level)
        case .bright:
            update("bright", .bool(!config.bright)) { $0.bright.toggle() }
        case .nightLight:
            let choices: [KioskNightLight?] = [nil] + KioskNightLight.presets
                + (config.nightLight.map { KioskNightLight.presets.contains($0) ? [] : [$0] } ?? [])
            let index = choices.firstIndex(of: config.nightLight) ?? 0
            let next = choices[(index + step % choices.count + choices.count) % choices.count]
            update(["nightLightStart": .string(next?.startText ?? "off"), "nightLightEnd": .string(next?.endText ?? "off")]) {
                $0.nightLight = next
            }
        case .clock:
            update("clock", .bool(!config.showClock)) { $0.showClock.toggle() }
        case .seconds:
            update("clockSeconds", .bool(!config.showSeconds)) { $0.showSeconds.toggle() }
        case .date:
            update("date", .bool(!config.showDate)) { $0.showDate.toggle() }
        case .sensors:
            update("sensors", .bool(!config.showSensors)) { $0.showSensors.toggle() }
        case .tagList:
            guard !tagLists.isEmpty else { return "No tag lists from the server" }
            let index = (currentList + step % tagLists.count + tagLists.count) % tagLists.count
            endHold(resume: false)
            setTagList(index)
            // The server confirms with the next playback frame; show the choice now.
            currentList = index
            onChange?()
        case .displaySync:
            isDisplaySyncOn.toggle()
            setDisplaySync(isDisplaySyncOn)
            onChange?()
        case .reshuffle, .restart, .reset:
            onChange?()
        }
        return nil
    }

    /// The slideshow's brightness, from the menu or a digit key.
    func setBrightness(_ percent: Int) {
        let level = KioskConfig.clampBrightness(percent)
        update("brightness", .number(Double(level))) { $0.brightness = level }
    }

    private func value(of item: KioskMenuItem) -> String {
        func onOff(_ on: Bool) -> String { on ? "On" : "Off" }
        switch item {
        case .interval: return Self.duration(config.intervalMs / 1_000)
        case .transition:
            return config.transitionDuration == 0 ? "Cut" : Self.decimal(config.transitionDuration) + " s"
        case .kenBurns: return onOff(config.kenBurns)
        case .fit: return config.fit == .contain ? "Whole photo" : "Fill the screen"
        case .blurBackground: return config.blurBackground ? "Blurred copy" : "Black"
        case .brightness: return "\(config.brightness) %"
        case .bright: return onOff(config.bright)
        case .nightLight: return config.nightLight?.label ?? "Off"
        case .clock: return onOff(config.showClock)
        case .seconds: return onOff(config.showSeconds)
        case .date: return onOff(config.showDate)
        case .sensors: return onOff(config.showSensors)
        case .tagList:
            guard currentList < tagLists.count else { return tagLists.isEmpty ? "—" : "\(currentList)" }
            let tags = tagLists[currentList].joined(separator: " ")
            return "\(currentList): " + (tags.count > 28 ? tags.prefix(27) + "…" : tags)
        case .displaySync: return onOff(isDisplaySyncOn)
        case .reshuffle, .restart: return ""
        case .reset: return settings.isEmpty ? "" : "\(settings.values.count) saved"
        }
    }

    /// The choice `by` steps from `current` (or from where `current` would
    /// sort in), clamped at the ends.
    static func stepped<Value: Comparable>(_ choices: [Value], current: Value, by step: Int) -> Value {
        let index: Int
        if let exact = choices.firstIndex(of: current) {
            index = exact + step
        } else {
            let above = choices.firstIndex { $0 > current } ?? choices.count
            index = step > 0 ? above : above - 1
        }
        return choices[min(choices.count - 1, max(0, index))]
    }

    /// `45 s`, `1 min`, `1 min 30 s`.
    static func duration(_ seconds: Int) -> String {
        guard seconds >= 60 else { return "\(seconds) s" }
        let minutes = seconds / 60, rest = seconds % 60
        return rest == 0 ? "\(minutes) min" : "\(minutes) min \(rest) s"
    }

    static func decimal(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}
