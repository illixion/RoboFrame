import AVKit
import SwiftUI
import WebKit

@main
struct RoboFrameApp: App {
    @State private var store = ProfileStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
        }
    }
}

@MainActor @Observable
final class ProfileStore {
    private let key = "RoboFrameClient.profiles"
    var profiles: [RoboFrameProfile] = []
    var selectedID: UUID?

    init() {
        profiles = (try? JSONDecoder().decode([RoboFrameProfile].self, from: UserDefaults.standard.data(forKey: key) ?? Data())) ?? []
        selectedID = profiles.first?.id
    }

    func save(_ profile: RoboFrameProfile) {
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index] = profile }
        else { profiles.append(profile) }
        selectedID = profile.id
        persist()
    }
    func delete(_ profile: RoboFrameProfile) { profiles.removeAll { $0.id == profile.id }; selectedID = profiles.first?.id; persist() }
    private func persist() { UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: key) }
}

struct RootView: View {
    @Environment(ProfileStore.self) private var store
    @State private var editor: RoboFrameProfile?
    @State private var presenting: RoboFrameProfile?

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            List(selection: $store.selectedID) {
                ForEach(store.profiles) { profile in
                    Label(profile.name, systemImage: profile.mode == .slideshow ? "photo.stack" : "globe")
                        .tag(profile.id)
                        .contextMenu {
                            Button("Open") { presenting = profile }
                            Button("Copy") { editor = profile.duplicated(named: "\(profile.name) Copy") }
                            Button("Delete", role: .destructive) { store.delete(profile) }
                        }
                }
            }
            .navigationTitle("RoboFrame")
            .toolbar {
                Button { editor = RoboFrameProfile() } label: { Label("New Display", systemImage: "plus") }
                    .accessibilityIdentifier("roboframe.profile.new")
            }
        } detail: {
            if let profile = store.profiles.first(where: { $0.id == store.selectedID }) {
                ProfileDetail(profile: profile, edit: { editor = profile }, open: { presenting = profile })
            } else {
                ContentUnavailableView("No Displays", systemImage: "rectangle.on.rectangle", description: Text("Create a RoboFrame display profile to begin."))
            }
        }
        .sheet(item: $editor) { ProfileEditor(profile: $0) { store.save($0); editor = nil } }
        .fullScreenCover(item: $presenting) { ProfileDestination(profile: $0) }
    }
}

struct ProfileDetail: View {
    let profile: RoboFrameProfile
    let edit: () -> Void
    let open: () -> Void
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: profile.mode == .slideshow ? "photo.stack.fill" : "globe")
                .font(.system(size: 54)).foregroundStyle(.tint)
            Text(profile.name).font(.title.bold())
            Text(profile.mode.label).foregroundStyle(.secondary)
            if let error = profile.launchError { Text(error).foregroundStyle(.red) }
            Button("Open", action: open).buttonStyle(.borderedProminent).disabled(profile.launchError != nil)
                .accessibilityIdentifier("roboframe.profile.open")
            Button("Edit", action: edit)
        }
        .padding()
    }
}

struct ProfileEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: RoboFrameProfile
    let save: (RoboFrameProfile) -> Void

    init(profile: RoboFrameProfile, save: @escaping (RoboFrameProfile) -> Void) {
        _draft = State(initialValue: profile)
        self.save = save
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    TextField("Name", text: $draft.name).accessibilityIdentifier("roboframe.profile.name")
                    Picker("Mode", selection: $draft.mode) {
                        ForEach(ProfileMode.allCases) { Text($0.label).tag($0) }
                    }
                }
                if draft.mode == .slideshow {
                    Section("RoboFrame Server") {
                        TextField("Server URL", text: $draft.endpoint).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Display ID", text: $draft.deviceId).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Access Token", text: $draft.accessToken)
                        Stepper("Interval: \(Int(draft.interval)) seconds", value: $draft.interval, in: 2...3600)
                        TextField("Modifier tags (space separated)", text: Binding(get: { draft.modTags.joined(separator: " ") }, set: { draft.modTags = $0.split(whereSeparator: \.isWhitespace).map(String.init) }))
                    }
                    Section("Display") {
                        Toggle("Show Clock", isOn: $draft.showClock)
                        Toggle("Show Sensors", isOn: $draft.showSensors)
                    }
                } else {
                    Section("Website") {
                        TextField("Page URL", text: $draft.webPageURL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Toggle("Transparent Background", isOn: $draft.webTransparentBackground)
                        Stepper("Refresh: \(Int(draft.webAutoRefreshInterval)) seconds", value: $draft.webAutoRefreshInterval, in: 0...3600, step: 15)
                    }
                }
                if let error = draft.launchError { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Edit Profile")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save(draft) }.accessibilityIdentifier("roboframe.profile.save") }
            }
        }
    }
}

struct ProfileDestination: View {
    let profile: RoboFrameProfile
    var body: some View {
        switch profile.mode {
        case .slideshow: SlideshowView(profile: profile)
        case .webPage: WebPageView(profile: profile)
        }
    }
}

struct SlideshowView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model: SlideshowModel
    @State private var saveResult: String?

    init(profile: RoboFrameProfile) { _model = State(initialValue: SlideshowModel(profile: profile)) }
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let effect = model.effectVideoURL {
                VideoPlayer(player: AVPlayer(url: effect)).ignoresSafeArea()
            } else if let url = model.mediaURL, let post = model.current {
                MediaContent(url: url, post: post) { duration in model.markRendered(durationMs: duration) }
                    .id(post.id)
            } else {
                ProgressView("Waiting for RoboFrame…").tint(.white).foregroundStyle(.white)
            }
            VStack {
                HStack {
                    if model.profile.showClock { Text(Date.now, format: .dateTime.hour().minute()).font(.title2.monospacedDigit()) }
                    Spacer()
                    ForEach(model.sensors.values.sorted(by: { $0.name < $1.name })) { Text("\($0.name): \($0.state)\($0.unit)") }
                }.foregroundStyle(.white).padding()
                Spacer()
                HStack {
                    Button("Close") { dismiss() }
                    Button("Next", action: model.next)
                    Button("Shuffle", action: model.reshuffle)
                    Button("Block", role: .destructive, action: model.block)
                    Button("Save") { Task { saveResult = await model.save() } }
                    Menu("Tags") { ForEach(Array(model.tagLists.enumerated()), id: \.offset) { index, tags in Button(tags.joined(separator: " ")) { model.setTagList(index) } } }
                }.buttonStyle(.bordered).padding()
            }
            if let alert = model.alert { AlertOverlay(alert: alert) }
        }
        .alert("RoboFrame", isPresented: Binding(get: { model.error != nil || saveResult != nil }, set: { if !$0 { model.clearError(); saveResult = nil } })) {
            Button("OK", role: .cancel) { model.clearError(); saveResult = nil }
        } message: { Text(model.error ?? saveResult ?? "") }
        .task { model.start(); model.reportScene(active: true) }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in model.reportScene(active: phase == .active) }
    }
}

struct MediaContent: View {
    let url: URL
    let post: RemotePost
    let rendered: (Int?) -> Void
    var body: some View {
        if post.isVideo {
            VideoPlayer(player: AVPlayer(url: url))
                .onAppear { rendered(post.durationMs) }
        } else {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFit().onAppear { rendered(nil) }
                case .failure: ContentUnavailableView("Media unavailable", systemImage: "exclamationmark.triangle")
                default: ProgressView()
                }
            }
        }
    }
}

struct AlertOverlay: View {
    let alert: RemoteAlert
    var body: some View {
        ZStack {
            Color(hex: alert.colorHex).opacity(0.94).ignoresSafeArea()
            VStack(spacing: 20) {
                if let url = alert.imageURL { AsyncImage(url: url) { $0.image?.resizable().scaledToFit() }.frame(maxHeight: 300) }
                Text(alert.text).font(.largeTitle.bold()).multilineTextAlignment(.center).foregroundStyle(.white)
            }.padding(40)
        }.accessibilityIdentifier("roboframe.remote.alert")
    }
}

struct WebPageView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: WebPageModel
    @State private var controlsVisible = true
    init(profile: RoboFrameProfile) { _model = State(initialValue: WebPageModel(profile: profile)) }
    var body: some View {
        ZStack(alignment: .top) {
            if let webView = model.webView { WebView(webView: webView).allowsHitTesting(controlsVisible) }
            else { ProgressView() }
            if controlsVisible {
                HStack {
                    Button("Close") { dismiss() }
                    Button("Home", action: model.goHome)
                    Button("Reload", action: model.reload)
                    Spacer()
                    Text(model.title).lineLimit(1)
                    Button("Hide") { controlsVisible = false; model.setInteractionEnabled(false) }
                }.buttonStyle(.bordered).padding()
            } else {
                Color.white.opacity(0.001).contentShape(Rectangle()).onTapGesture { controlsVisible = true; model.setInteractionEnabled(true) }
            }
        }
        .task { model.start() }.onDisappear { model.stop() }
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

extension Color {
    init(hex: String) {
        let value = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).trimmingCharacters(in: .whitespacesAndNewlines), radix: 16) ?? 0
        self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}
