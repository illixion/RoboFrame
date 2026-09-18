/*
 RoboFrame Native Client - Slideshow Adjustments Popover

 Trimmed port of Hypnos's `VisualAdjustmentsPopover`: brightness/contrast/
 saturation/opacity sliders (the fields `VisualAdjustments` carries — no
 sharpen/auto-enhance/3D-distance, which are photo-viewer-specific) across
 the same Current/Global/Viewer three-tab layout, including the identical
 non-linear slider curve so precision near the default value matches.
 */

import SwiftUI

struct SlideshowAdjustmentsPopover: View {
    enum Tab: String, CaseIterable {
        case current = "Current"
        case global = "Global"
        case viewer = "Viewer"
    }

    @State private var selectedTab: Tab = .current
    let model: SlideshowModel

    var body: some View {
        VStack(spacing: 16) {
            Picker("", selection: $selectedTab) {
                ForEach(Tab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)

            switch selectedTab {
            case .current: currentTabContent
            case .global: globalTabContent
            case .viewer: viewerTabContent
            }
        }
        .padding(20)
        .frame(width: 340)
    }

    // MARK: - Current tab

    @ViewBuilder
    private var currentTabContent: some View {
        @Bindable var model = model
        VStack(spacing: 14) {
            adjustmentSlider(label: "Brightness", value: $model.adjustments.brightness, range: -0.5...0.5, defaultValue: 0.0)
            adjustmentSlider(label: "Contrast", value: $model.adjustments.contrast, range: 0.2...5.0, defaultValue: 1.0)
            adjustmentSlider(label: "Saturation", value: $model.adjustments.saturation, range: 0.0...5.0, defaultValue: 1.0)
            adjustmentSlider(label: "Opacity", value: $model.adjustments.opacity, range: 0.01...1.0, defaultValue: 1.0, linear: true)

            Button("Reset") { model.adjustments.reset() }
                .buttonStyle(.bordered)
                .disabled(!model.adjustments.isModified)
        }
    }

    // MARK: - Global tab

    @ViewBuilder
    private var globalTabContent: some View {
        @Bindable var settings = AppSettings.shared
        VStack(spacing: 14) {
            Text("Default adjustments applied to viewers with no per-window overrides.")
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            adjustmentSlider(label: "Brightness", value: $settings.globalVisualAdjustments.brightness, range: -0.5...0.5, defaultValue: 0.0)
            adjustmentSlider(label: "Contrast", value: $settings.globalVisualAdjustments.contrast, range: 0.3...3.0, defaultValue: 1.0)
            adjustmentSlider(label: "Saturation", value: $settings.globalVisualAdjustments.saturation, range: 0.0...3.0, defaultValue: 1.0)
            adjustmentSlider(label: "Opacity", value: $settings.globalVisualAdjustments.opacity, range: 0.01...1.0, defaultValue: 1.0, linear: true)

            Button("Reset") { settings.globalVisualAdjustments.reset() }
                .buttonStyle(.bordered)
                .disabled(!settings.globalVisualAdjustments.isModified)
        }
    }

    // MARK: - Viewer tab

    @ViewBuilder
    private var viewerTabContent: some View {
        @Bindable var model = model
        VStack(spacing: 14) {
            Text("Display toggles for this viewer session.")
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Toggle("Show Clock", isOn: $model.displayShowClock)
            Toggle("Show Sensors", isOn: $model.displayShowSensors)
            Toggle("Ken Burns Effect", isOn: $model.displayEnableKenBurns)
            Toggle("Dynamic Brightness", isOn: $model.displayEnableDynamicBrightness)
            Toggle("Transparent Background", isOn: $model.displayTransparentBackground)
            Toggle("Fit to Aspect Ratio", isOn: $model.displayUseAspectRatio)

            Divider()

            VStack(spacing: 4) {
                HStack {
                    Text("Slideshow Interval").font(.subheadline)
                    Spacer()
                    Text(formatDelay(model.displayDelay)).font(.caption).monospacedDigit().foregroundColor(.secondary)
                }
                Slider(value: $model.displayDelay, in: 3...120, step: 1)
            }
        }
    }

    private func formatDelay(_ seconds: TimeInterval) -> String {
        if seconds >= 60 {
            let mins = Int(seconds) / 60
            let secs = Int(seconds) % 60
            return secs > 0 ? "\(mins)m \(secs)s" : "\(mins)m"
        }
        return "\(Int(seconds))s"
    }

    // MARK: - Slider component (identical non-linear curve to Hypnos)

    private static let curveExponent: Double = 2.0

    @ViewBuilder
    private func adjustmentSlider(
        label: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        defaultValue: Double,
        linear: Bool = false
    ) -> some View {
        VStack(spacing: 4) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text(formatValue(value.wrappedValue, defaultValue: defaultValue))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundColor(value.wrappedValue != defaultValue ? .accentColor : .secondary)
            }
            if linear {
                Slider(value: value, in: range)
            } else {
                Slider(value: nonLinearBinding(value: value, range: range, defaultValue: defaultValue), in: 0...1)
            }
        }
    }

    private func nonLinearBinding(value: Binding<Double>, range: ClosedRange<Double>, defaultValue: Double) -> Binding<Double> {
        let exponent = Self.curveExponent
        let lower = range.lowerBound
        let upper = range.upperBound
        return Binding<Double>(
            get: {
                let v = value.wrappedValue
                if v <= defaultValue {
                    let fraction = defaultValue > lower ? (defaultValue - v) / (defaultValue - lower) : 0
                    return 0.5 - pow(fraction, 1.0 / exponent) * 0.5
                } else {
                    let fraction = upper > defaultValue ? (v - defaultValue) / (upper - defaultValue) : 0
                    return 0.5 + pow(fraction, 1.0 / exponent) * 0.5
                }
            },
            set: { t in
                if t <= 0.5 {
                    let halfT = (0.5 - t) / 0.5
                    value.wrappedValue = defaultValue - pow(halfT, exponent) * (defaultValue - lower)
                } else {
                    let halfT = (t - 0.5) / 0.5
                    value.wrappedValue = defaultValue + pow(halfT, exponent) * (upper - defaultValue)
                }
            }
        )
    }

    private func formatValue(_ value: Double, defaultValue: Double) -> String {
        if defaultValue == 0.0 {
            return value >= 0 ? String(format: "+%.3f", value) : String(format: "%.3f", value)
        }
        return String(format: "%.3f", value)
    }
}
