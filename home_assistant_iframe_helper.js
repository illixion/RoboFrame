// This script helps manage visibility state for Home Assistant iframes

// Save this in your homeassistant/www folder as home_assistant_iframe_helper.js
// and enable in user settings under Settings -> Dashboard -> Resources
// example value: /local/home_assistant_iframe_helper.js?v=2

(function() {
    console.log("Injected Home Assistant visibility script");

    let overrideHidden = null; // Null means "use default behavior"

    // Store original properties
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    const nativeVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");

    Object.defineProperty(document, "hidden", {
        get: () => overrideHidden !== null ? overrideHidden : nativeHidden.get.call(document),
        configurable: true
    });

    Object.defineProperty(document, "visibilityState", {
        get: () => overrideHidden !== null ? (overrideHidden ? "hidden" : "visible") : nativeVisibilityState.get.call(document),
        configurable: true
    });

    window.addEventListener("message", (event) => {
        if (event.data && event.data.type === "visibility") {
            console.log("Visibility message received:", event.data);

            overrideHidden = event.data.hidden; // Set our custom override

            // Trigger visibilitychange event
            document.dispatchEvent(new Event("visibilitychange"));
        }
    });

    // Also listen for actual visibility changes
    document.addEventListener("visibilitychange", () => {
        if (overrideHidden === null) {
            console.log("Browser visibility change detected:", document.visibilityState);
        }
    });

    // Listen for 'h' key press and notify parent
    document.addEventListener("keydown", (event) => {
        if (event.key === "h" && !event.repeat) {
            window.parent.postMessage({ type: "notification", message: "toggle" }, "*");
        }
    });
})();
