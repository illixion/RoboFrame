/*
 RoboFrame Native Client - Slideshow Ornament View

 1:1 port of Hypnos's `RemoteViewerOrnamentView`.
 [ Profiles | History | Prev | Next | Save | Reshuffle | Tag List | Mod Tags | Sync | 3D | Resolution | Adjustments | Block | Identity ]
 */

import RAVEUI
import SwiftUI

struct SlideshowOrnamentView: View {
    @Environment(\.dismiss) private var dismiss
    let model: SlideshowModel
    @Binding var showHistory: Bool
    @State private var showAdjustments = false
    @State private var showAddPresetPopover = false
    @State private var newPresetText = ""

    var body: some View {
        HStack(spacing: RAVEChromeMetrics.spacing) {
            // Back to the profile list — RoboFrame's equivalent of Hypnos's
            // "Grid" button, which returns to the app's main gallery window.
            Button { dismiss() } label: {
                Image(systemName: "square.grid.2x2").font(.title3)
            }
            .raveChromeButtonStyle()
            .help("Back to Profiles")

            Button {
                withAnimation { showHistory.toggle() }
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.title3)
                    .padding(6)
                    .background(showHistory ? .white.opacity(0.3) : .clear, in: .rect(cornerRadius: 8))
            }
            .raveChromeButtonStyle()
            .help("View History")

            Divider().frame(height: 24)

            Button { model.previous() } label: { Image(systemName: "chevron.left").font(.title3) }
                .raveChromeButtonStyle()
                .help("Previous Image")

            Button { model.next() } label: { Image(systemName: "chevron.right").font(.title3) }
                .raveChromeButtonStyle()
                .help("Next Image")

            Divider().frame(height: 24)

            Button { Task { _ = await model.save() } } label: { Image(systemName: "square.and.arrow.down").font(.title3) }
                .raveChromeButtonStyle()
                .disabled(model.current == nil)
                .help("Save Image")

            Button { model.reshuffle() } label: { Image(systemName: "arrow.trianglehead.2.clockwise.rotate.90").font(.title3) }
                .raveChromeButtonStyle()
                .help("Reshuffle")

            tagListMenu
            modTagMenu

            Button {
                model.setDisplaySync(true)
            } label: {
                Image(systemName: "link.circle").font(.title3)
            }
            .raveChromeButtonStyle()
            .help("Display Sync")

            #if os(visionOS)
            slideshow3DMenu
            #endif

            resolutionMenu
            adjustmentsButton

            Button { model.block() } label: {
                Image(systemName: "hand.raised.fill").font(.title3).foregroundStyle(.red)
            }
            .raveChromeButtonStyle()
            .disabled(model.current == nil)
            .help("Block Post")

            Divider().frame(height: 24)

            identityLabel
        }
        .padding(.horizontal, RAVEChromeMetrics.horizontalPadding)
        .padding(.vertical, RAVEChromeMetrics.verticalPadding)
        .chromeBackground()
    }

    private var identityLabel: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.profile.name).font(.callout).lineLimit(1)
            Text(model.profile.deviceId.isEmpty ? model.profile.endpoint : "device \(model.profile.deviceId)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: 220, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .help("Profile and display id for this viewer")
    }

    private var tagListMenu: some View {
        Menu {
            ForEach(model.tagLists.indices, id: \.self) { index in
                Button {
                    model.setTagList(index)
                } label: {
                    HStack {
                        Text(tagListLabel(index))
                        if model.currentList == index { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "number").font(.title3)
                Text("\(model.currentList + 1)/\(max(model.tagLists.count, 1))").font(.callout).foregroundColor(.secondary)
            }
        }
        .menuStyle(.button)
        .raveChromeButtonStyle()
        .disabled(model.tagLists.count <= 1)
        .help("Tag List")
    }

    private func tagListLabel(_ index: Int) -> String {
        "List \(index + 1): \(model.tagLists[index].first ?? "")"
    }

    private var modTagMenu: some View {
        Menu {
            Button {
                ModTagManager.shared.clearActive()
            } label: {
                HStack { Text("None"); if ModTagManager.shared.activeIndex == nil { Image(systemName: "checkmark") } }
            }
            ForEach(ModTagManager.shared.modTagLists.indices, id: \.self) { index in
                Button {
                    ModTagManager.shared.switchToPreset(index)
                } label: {
                    HStack {
                        Text(modTagLabel(index))
                        if ModTagManager.shared.activeIndex == index { Image(systemName: "checkmark") }
                    }
                }
            }
            Divider()
            Button {
                newPresetText = ""
                showAddPresetPopover = true
            } label: {
                Label("Add Preset…", systemImage: "plus")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tag").font(.title3)
                Text(modTagBadge).font(.callout).foregroundColor(.secondary)
            }
        }
        .menuStyle(.button)
        .raveChromeButtonStyle()
        .help("Mod Tags")
        .popover(isPresented: $showAddPresetPopover) { addPresetPopover }
    }

    private var addPresetPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Mod Tag Preset").font(.headline)
            Text("Space-separated tags. Negate with a leading `-`.").font(.caption).foregroundColor(.secondary)
            TextField("rating:s -blood", text: $newPresetText)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(minWidth: 320)
                .onSubmit { commitNewPreset() }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { showAddPresetPopover = false }
                Button("Add & Apply") { commitNewPreset() }
                    .buttonStyle(.borderedProminent)
                    .disabled(parsedNewPresetTags.isEmpty)
            }
        }
        .padding(20)
    }

    private var parsedNewPresetTags: [String] {
        newPresetText.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
    }

    private func commitNewPreset() {
        let tags = parsedNewPresetTags
        guard !tags.isEmpty else { return }
        var lists = ModTagManager.shared.modTagLists
        lists.append(tags)
        ModTagManager.shared.modTagLists = lists
        ModTagManager.shared.switchToPreset(lists.count - 1)
        newPresetText = ""
        showAddPresetPopover = false
    }

    private func modTagLabel(_ index: Int) -> String {
        "Preset \(index + 1): \(ModTagManager.shared.modTagLists[index].first ?? "")"
    }

    private var modTagBadge: String {
        guard let idx = ModTagManager.shared.activeIndex else { return "—" }
        return "\(idx + 1)/\(ModTagManager.shared.modTagLists.count)"
    }

    private var adjustmentsButton: some View {
        Button {
            showAdjustments.toggle()
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.title3)
                .padding(6)
                .background(
                    (model.adjustments.isModified || AppSettings.shared.globalVisualAdjustments.isModified) ? .white.opacity(0.3) : .clear,
                    in: .rect(cornerRadius: 8)
                )
        }
        .raveChromeButtonStyle()
        .help("Visual Adjustments")
        .popover(isPresented: $showAdjustments) {
            SlideshowAdjustmentsPopover(model: model)
        }
    }

    #if os(visionOS)
    private var slideshow3DMenu: some View {
        Menu {
            ForEach(Slideshow3DPreference.allCases) { mode in
                Button {
                    model.slideshow3DMode = mode
                } label: {
                    HStack { Text(mode.label); if model.slideshow3DMode == mode { Image(systemName: "checkmark") } }
                }
            }
        } label: {
            Image(systemName: model.slideshow3DMode.systemImage)
                .font(.title3)
                .padding(6)
                .background(model.slideshow3DMode != .off ? .white.opacity(0.3) : .clear, in: .rect(cornerRadius: 8))
        }
        .menuStyle(.button)
        .raveChromeButtonStyle()
        .help("Slideshow 3D Mode")
    }
    #endif

    private var resolutionMenu: some View {
        let is3D = model.slideshow3DMode != .off
        let currentValue = is3D ? model.maxImageResolution3D : model.maxImageResolution2D
        let currentLabel = AppSettings.maxImageResolutionOptions.first(where: { $0.value == currentValue })?.label ?? "Off"

        return Menu {
            ForEach(AppSettings.maxImageResolutionOptions, id: \.value) { option in
                Button {
                    if is3D { model.maxImageResolution3D = option.value } else { model.maxImageResolution2D = option.value }
                } label: {
                    HStack { Text(option.label); if option.value == currentValue { Image(systemName: "checkmark") } }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "photo").font(.title3)
                Text(currentLabel).font(.callout).foregroundColor(.secondary)
            }
        }
        .menuStyle(.button)
        .raveChromeButtonStyle()
        .help(is3D ? "Max Image Resolution (3D)" : "Max Image Resolution (2D)")
    }
}
