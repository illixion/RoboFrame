/*
 RoboFrame Native Client - Profile Manager

 1:1 port of Hypnos's `RemoteTabView`: a single scrollable list holding both
 the saved-profile rows and the draft editor for whichever one is loaded.
 Nothing reaches `ProfileStore.profiles` until an explicit Save — the
 "Editing" section always names the profile a Save would overwrite plus
 whether the draft currently differs from it, so "am I about to change a
 saved profile?" is answerable without remembering what was loaded.

 An open viewer window writes its own ornament tweaks straight back into the
 store (`SlideshowModel.onConfigChanged`). A clean draft silently follows
 those; a draft with edits of its own can't, so it's flagged instead of
 letting the next Save quietly revert the window's change.
 */

import SwiftUI

struct ProfileManagerView: View {
    @Environment(ProfileStore.self) private var store

    /// The profile being edited. Only ever persisted through `save()`.
    @State private var editingProfile: RoboFrameProfile

    /// The draft as it looked at load / new / save time. "Has the user
    /// changed anything" is exactly `editingProfile != baseline`.
    @State private var baseline: RoboFrameProfile

    /// A load / new-draft request parked behind the discard confirmation.
    @State private var pendingSwitch: PendingSwitch?

    /// Set when the loaded profile changed in the store while this draft had
    /// unsaved edits — saving would replace whatever changed it.
    @State private var storeChangedUnderDraft = false

    @State private var didSeedDefaults = false
    @State private var newModTagPreset = ""
    #if !os(visionOS)
    // iOS only: a single-window `.fullScreenCover` presentation. visionOS
    // instead opens the "slideshow-viewer" `WindowGroup` (see `launch(_:)`),
    // so multiple viewers can be open at once — there's no analogous benefit
    // to a second scene on iOS's single-window presentation.
    @State private var presenting: RoboFrameProfile?
    #endif
    #if os(visionOS)
    @Environment(\.openWindow) private var openWindow
    #endif

    private enum PendingSwitch: Equatable {
        case load(UUID)
        case newDraft
    }

    init() {
        // Both start as the same value (same `id`), so a freshly opened
        // editor reads as an untouched new draft rather than a modified one.
        let draft = RoboFrameProfile()
        _editingProfile = State(initialValue: draft)
        _baseline = State(initialValue: draft)
    }

    // MARK: - Draft state

    private var storedCopy: RoboFrameProfile? {
        store.profiles.first { $0.id == editingProfile.id }
    }

    private var isNewDraft: Bool { storedCopy == nil }
    private var hasUnsavedChanges: Bool { editingProfile != baseline }
    private var trimmedName: String { editingProfile.name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmedName.isEmpty && (isNewDraft || hasUnsavedChanges) }
    private var needsSaveToLaunch: Bool { isNewDraft || hasUnsavedChanges }

    var body: some View {
        NavigationStack {
            List {
                savedProfilesSection
                editingSection

                Section {
                    Picker("Mode", selection: $editingProfile.mode) {
                        ForEach(ProfileMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Mode")
                } footer: {
                    Text(editingProfile.mode == .webPage
                         ? "Pins a website in your space. The page keeps its state and window size; it only accepts input while the ornaments are visible."
                         : "Slideshow driven by a RoboFrame server.")
                }

                if editingProfile.mode == .webPage {
                    webPageSection
                } else {
                    slideshowSections
                }

                Section {
                    Button {
                        launchDraft()
                    } label: {
                        Text(launchButtonTitle)
                            .foregroundStyle(.blue)
                    }
                    .disabled(trimmedName.isEmpty || editingProfile.launchError != nil)
                    .accessibilityIdentifier("roboframe.profile.launchDraft")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let reason = editingProfile.launchError {
                            Text(reason).foregroundStyle(.red)
                        }
                        if needsSaveToLaunch {
                            Text(isNewDraft
                                 ? "Saves the draft as a new profile first — launching always opens a saved profile."
                                 : "Saves your changes to \u{201c}\(storedCopy?.name ?? trimmedName)\u{201d} first — launching always opens a saved profile.")
                        }
                    }
                }
            }
            .navigationTitle("RoboFrame")
            .onAppear(perform: seedDefaultsIfUntouched)
            .onChange(of: store.profiles) { _, _ in adoptStoreChange() }
            .confirmationDialog(
                pendingSwitchTitle,
                isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } }),
                titleVisibility: .visible
            ) {
                Button(isNewDraft ? "Save as New Profile and Continue" : "Save Changes and Continue") {
                    resolvePendingSwitch(saveFirst: true)
                }
                Button("Discard Changes", role: .destructive) {
                    resolvePendingSwitch(saveFirst: false)
                }
                Button("Cancel", role: .cancel) { pendingSwitch = nil }
            }
            #if !os(visionOS)
            .fullScreenCover(item: $presenting) { ViewerDestination(profile: $0, onConfigChanged: persistViewerConfigChange) }
            #endif
        }
    }

    /// Opens a launched profile's viewer. visionOS opens a genuine window
    /// (`ViewerSceneRoot` resolves the profile live by id, so this window's
    /// ornament edits and any change from another window both stay in sync);
    /// iOS presents the existing single-window `.fullScreenCover`.
    private func launch(_ profile: RoboFrameProfile) {
        #if os(visionOS)
        openWindow(id: "slideshow-viewer", value: profile.id)
        #else
        presenting = profile
        #endif
    }

    /// Writes an ornament/adjustments-driven config edit back to whichever
    /// store owns the profile — the saved list if it's already there,
    /// otherwise the still-open draft — mirroring Hypnos's
    /// `persistRemoteViewerConfig` routing so a live viewer's changes are
    /// never silently dropped.
    private func persistViewerConfigChange(_ updated: RoboFrameProfile) {
        if store.profiles.contains(where: { $0.id == updated.id }) {
            store.save(updated)
        }
        if editingProfile.id == updated.id {
            editingProfile = updated
        }
    }

    // MARK: - Saved profiles

    @ViewBuilder
    private var savedProfilesSection: some View {
        Section {
            if store.profiles.isEmpty {
                Text("No saved profiles").foregroundColor(.secondary)
            } else {
                ForEach(store.profiles) { profile in
                    savedProfileRow(profile)
                }
                .onDelete { indexSet in
                    for index in indexSet { store.delete(store.profiles[index]) }
                }
            }
        } header: {
            HStack {
                Text("Saved Profiles")
                Spacer()
                Button { requestNewDraft() } label: { Label("New", systemImage: "plus") }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("roboframe.profile.new")
            }
            .textCase(nil)
        } footer: {
            Text("Launch opens the saved version of a profile; unsaved edits stay in the editor below.")
        }
    }

    @ViewBuilder
    private func savedProfileRow(_ profile: RoboFrameProfile) -> some View {
        let isEditing = profile.id == editingProfile.id

        HStack {
            Image(systemName: profile.mode.systemImage)
                .foregroundStyle(.secondary)
                .help(profile.mode.label)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(profile.name)
                    if isEditing {
                        Text(hasUnsavedChanges ? "Editing · unsaved" : "Editing")
                            .font(.caption2)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(
                                hasUnsavedChanges ? Color.orange.opacity(0.3) : Color.secondary.opacity(0.2),
                                in: .capsule
                            )
                    }
                }
                if let reason = profile.launchError {
                    Text(reason).font(.caption).foregroundStyle(.red)
                } else {
                    Text(profile.savedDate, style: .date).font(.caption).foregroundColor(.secondary)
                }
            }
            Spacer()
            Button(isEditing ? "Reload" : "Load") { requestLoad(profile) }
                .buttonStyle(.borderless)
                .disabled(isEditing && !hasUnsavedChanges)
            Button("Copy") {
                store.save(profile.duplicated(named: uniqueName(from: profile.name + " (Copy)")))
            }
            .buttonStyle(.borderless)
            Button("Launch") { launch(profile) }
                .buttonStyle(.borderedProminent)
                .disabled(profile.launchError != nil)
                .accessibilityIdentifier("roboframe.profile.open")
        }
    }

    // MARK: - Editing status

    @ViewBuilder
    private var editingSection: some View {
        Section {
            TextField("Name", text: $editingProfile.name)
                .accessibilityIdentifier("roboframe.profile.name")

            HStack(spacing: 8) {
                Image(systemName: statusSymbol).foregroundStyle(statusTint)
                Text(statusText).font(.callout)
                Spacer()
            }

            if storeChangedUnderDraft {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("This profile changed in an open viewer window.")
                        Text("Saving replaces that change with your edits.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("Reload") { revertToStored() }.buttonStyle(.bordered)
                }
            }

            HStack {
                Button(isNewDraft ? "Save as New Profile" : "Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                    .accessibilityIdentifier("roboframe.profile.save")
                Button("Revert") { revertToStored() }
                    .buttonStyle(.bordered)
                    .disabled(isNewDraft || !hasUnsavedChanges)
                Spacer()
                if !isNewDraft {
                    Button("Save as Copy") { saveAsNew() }
                        .buttonStyle(.bordered)
                        .disabled(trimmedName.isEmpty)
                }
            }
        } header: {
            Text("Editing")
        } footer: {
            Text(isNewDraft
                 ? "Nothing is written until you save. Launching saves first."
                 : "\u{201c}Save as Copy\u{201d} branches these settings into a new profile instead of overwriting \u{201c}\(storedCopy?.name ?? trimmedName)\u{201d}.")
        }
    }

    private var statusSymbol: String {
        if isNewDraft { return "doc.badge.plus" }
        return hasUnsavedChanges ? "pencil.circle.fill" : "checkmark.circle.fill"
    }
    private var statusTint: Color {
        if isNewDraft { return .secondary }
        return hasUnsavedChanges ? .orange : .green
    }
    private var statusText: String {
        guard let stored = storedCopy else { return "New profile — not saved yet" }
        return hasUnsavedChanges ? "Unsaved changes to \u{201c}\(stored.name)\u{201d}" : "Matches the saved profile \u{201c}\(stored.name)\u{201d}"
    }
    private var launchButtonTitle: String {
        let verb = editingProfile.mode == .webPage ? "Open Website" : "Launch Viewer"
        return needsSaveToLaunch ? "Save & \(verb)" : verb
    }
    private var pendingSwitchTitle: String {
        guard let stored = storedCopy else { return "\u{201c}\(trimmedName)\u{201d} hasn't been saved yet" }
        return "\u{201c}\(stored.name)\u{201d} has unsaved changes"
    }

    // MARK: - Draft actions

    private func save() {
        var profile = editingProfile
        profile.name = trimmedName.isEmpty ? "Untitled" : trimmedName
        editingProfile = profile
        store.save(profile)
        baseline = profile
        storeChangedUnderDraft = false
    }

    private func saveAsNew() {
        let copy = editingProfile.duplicated(named: uniqueName(from: trimmedName))
        store.save(copy)
        editingProfile = copy
        baseline = copy
        storeChangedUnderDraft = false
    }

    private func revertToStored() {
        guard let stored = storedCopy else { return }
        editingProfile = stored
        baseline = stored
        storeChangedUnderDraft = false
    }

    private func requestLoad(_ profile: RoboFrameProfile) {
        guard hasUnsavedChanges else { load(profile); return }
        pendingSwitch = .load(profile.id)
    }

    private func requestNewDraft() {
        guard hasUnsavedChanges else { newDraft(); return }
        pendingSwitch = .newDraft
    }

    private func load(_ profile: RoboFrameProfile) {
        editingProfile = profile
        baseline = profile
        storeChangedUnderDraft = false
        didSeedDefaults = true
    }

    private func newDraft() {
        var draft = RoboFrameProfile()
        draft.name = uniqueName(from: "New Profile")
        store.applyDefaults(to: &draft)
        editingProfile = draft
        baseline = draft
        storeChangedUnderDraft = false
        didSeedDefaults = true
    }

    private func resolvePendingSwitch(saveFirst: Bool) {
        let pending = pendingSwitch
        pendingSwitch = nil
        if saveFirst { save() }
        switch pending {
        case .load(let id):
            if let profile = store.profiles.first(where: { $0.id == id }) { load(profile) }
        case .newDraft: newDraft()
        case nil: break
        }
    }

    private func launchDraft() {
        if needsSaveToLaunch { save() }
        launch(editingProfile)
    }

    private func seedDefaultsIfUntouched() {
        guard !didSeedDefaults, isNewDraft, !hasUnsavedChanges else { return }
        var seeded = editingProfile
        store.applyDefaults(to: &seeded)
        editingProfile = seeded
        baseline = seeded
        didSeedDefaults = true
    }

    private func adoptStoreChange() {
        guard let stored = storedCopy, stored != baseline else { return }
        if hasUnsavedChanges {
            storeChangedUnderDraft = true
        } else {
            editingProfile = stored
            baseline = stored
        }
    }

    private func uniqueName(from base: String) -> String {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.isEmpty ? "New Profile" : trimmed
        let taken = Set(store.profiles.map(\.name))
        guard taken.contains(candidate) else { return candidate }
        var index = 2
        while taken.contains("\(candidate) \(index)") { index += 1 }
        return "\(candidate) \(index)"
    }

    // MARK: - Website mode

    @ViewBuilder
    private var webPageSection: some View {
        Section {
            TextField("Page URL", text: $editingProfile.webPageURL)
                .textContentType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)

            if !editingProfile.webPageURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               editingProfile.resolvedWebPageURL == nil {
                Text("Not a usable URL.").font(.caption).foregroundStyle(.red)
            } else if let resolved = editingProfile.resolvedWebPageURL,
                      resolved.absoluteString != editingProfile.webPageURL.trimmingCharacters(in: .whitespacesAndNewlines) {
                Text("Opens \(resolved.absoluteString)").font(.caption).foregroundColor(.secondary)
            }

            Toggle("Transparent Background", isOn: $editingProfile.webTransparentBackground)
            Text("Injects CSS so the page's own background paints through to your space. Pages that set a background on an inner element still paint it.")
                .font(.caption)
                .foregroundColor(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Auto-Refresh")
                    Spacer()
                    Text(RoboFrameProfile.webAutoRefreshLabel(editingProfile.webAutoRefreshInterval)).foregroundColor(.secondary)
                }
                Slider(value: autoRefreshIndex, in: 0...Double(RoboFrameProfile.webAutoRefreshOptions.count - 1), step: 1)
                Text("Reloads the page after this long with no interaction. Off by default.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        } header: {
            Text("Website")
        } footer: {
            Text("Tap the window to reveal the controls and unlock the page; hide them again (eye button, or let them auto-hide) to block input and stop visionOS from highlighting links as you look around.")
        }
    }

    private var autoRefreshIndex: Binding<Double> {
        Binding(
            get: {
                let options = RoboFrameProfile.webAutoRefreshOptions
                let current = editingProfile.webAutoRefreshInterval
                let nearest = options.enumerated().min { lhs, rhs in abs(lhs.element - current) < abs(rhs.element - current) }
                return Double(nearest?.offset ?? 0)
            },
            set: { newValue in
                let options = RoboFrameProfile.webAutoRefreshOptions
                let index = min(max(Int(newValue.rounded()), 0), options.count - 1)
                editingProfile.webAutoRefreshInterval = options[index]
            }
        )
    }

    // MARK: - RoboFrame mode

    @ViewBuilder
    private var slideshowSections: some View {
        Section {
            TextField("RoboFrame Server URL", text: $editingProfile.endpoint)
                .textContentType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("roboframe.profile.endpoint")

            TextField("Display ID", text: $editingProfile.deviceId)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("roboframe.profile.deviceId")

            Text("Home Assistant uses this stable ID. The server keeps each window's slideshow session independent.")
                .font(.caption)
                .foregroundColor(.secondary)

            SecureField("Access Token", text: $editingProfile.accessToken)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            Link("RoboFrame on GitHub", destination: RoboFrameProfile.roboFrameRepositoryURL)
                .font(.caption)
        } header: {
            Text("RoboFrame Server")
        }

        Section("Display") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Image Interval")
                    Spacer()
                    Text(formatDelay(editingProfile.interval)).foregroundColor(.secondary)
                }
                Slider(value: $editingProfile.interval, in: 3...120, step: 1)
            }

            #if os(visionOS)
            Picker("3D Mode", selection: $editingProfile.slideshow3DMode) {
                ForEach(Slideshow3DPreference.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            #endif

            Toggle("Show Clock", isOn: $editingProfile.showClock)
            Toggle("Show Sensors", isOn: $editingProfile.showSensors)
            Toggle("Fit to Window Aspect Ratio", isOn: $editingProfile.useAspectRatio)
            Toggle("Ken Burns Effect", isOn: $editingProfile.enableKenBurns)
            Toggle("Dynamic Brightness", isOn: $editingProfile.enableDynamicBrightness)
            Toggle("Transparent Background", isOn: $editingProfile.transparentBackground)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Text Size")
                    Spacer()
                    Text(String(format: "%.0f%%", editingProfile.textSize * 100)).foregroundColor(.secondary)
                }
                Slider(value: $editingProfile.textSize, in: 0.5...3.0, step: 0.1)
            }
        }

        modTagPresetsSection
    }

    // MARK: - Mod tag presets (device-wide)

    /// Mod tags don't persist on the server — they modify the active query
    /// for whichever channel this device is on. The catalog of presets lives
    /// entirely on this device; switching presets pushes the active set to
    /// the server. Deliberately outside the draft/Save flow: these are
    /// device-wide, not per-profile, so edits apply the moment they're made.
    @ViewBuilder
    private var modTagPresetsSection: some View {
        let mtm = ModTagManager.shared
        let bindable = Binding(get: { mtm.modTagLists }, set: { mtm.modTagLists = $0 })

        Section {
            ForEach(mtm.modTagLists.indices, id: \.self) { index in
                HStack {
                    Text("Preset \(index + 1)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .frame(width: 70, alignment: .leading)
                    TextField(
                        "Tags (space-separated)",
                        text: Binding(
                            get: { index < mtm.modTagLists.count ? mtm.modTagLists[index].joined(separator: " ") : "" },
                            set: { newValue in
                                guard index < bindable.wrappedValue.count else { return }
                                bindable.wrappedValue[index] = newValue.components(separatedBy: " ").filter { !$0.isEmpty }
                            }
                        )
                    )
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                }
            }
            .onDelete { indexSet in bindable.wrappedValue.remove(atOffsets: indexSet) }

            HStack {
                TextField("Tags (space-separated)", text: $newModTagPreset)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("Add Preset") {
                    let tags = newModTagPreset.trimmingCharacters(in: .whitespaces)
                        .components(separatedBy: " ")
                        .filter { !$0.isEmpty }
                    if !tags.isEmpty {
                        var lists = mtm.modTagLists
                        lists.append(tags)
                        mtm.modTagLists = lists
                        newModTagPreset = ""
                    }
                }
                .disabled(newModTagPreset.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            Picker("Default Preset", selection: Binding(
                get: { mtm.defaultIndex ?? -1 },
                set: { mtm.defaultIndex = $0 == -1 ? nil : $0 }
            )) {
                Text("None").tag(-1)
                ForEach(mtm.modTagLists.indices, id: \.self) { index in
                    Text("Preset \(index + 1): \(index < mtm.modTagLists.count ? (mtm.modTagLists[index].first ?? "") : "")").tag(index)
                }
            }
            .pickerStyle(.menu)
        } header: {
            Text("Mod Tag Presets")
        } footer: {
            Text("Shared by every RoboFrame window on this device — saved as you type, not part of the profile above.")
        }
    }

    private func formatDelay(_ seconds: TimeInterval) -> String {
        let intSeconds = Int(seconds)
        if intSeconds >= 60 {
            let minutes = intSeconds / 60
            let remainingSeconds = intSeconds % 60
            if remainingSeconds == 0 { return "\(minutes) min" }
            return "\(minutes) min \(remainingSeconds) sec"
        }
        return "\(intSeconds) seconds"
    }
}

/// Which viewer a launched profile presents. Kept separate from
/// `ProfileManagerView` so it can be reused by any future launch surface
/// (e.g. a Shortcuts/deep-link entry point).
struct ViewerDestination: View {
    let profile: RoboFrameProfile
    var onConfigChanged: (RoboFrameProfile) -> Void = { _ in }
    var body: some View {
        switch profile.mode {
        case .slideshow: SlideshowWindowView(profile: profile, onConfigChanged: onConfigChanged)
        case .webPage: WebPageWindowView(profile: profile)
        }
    }
}
