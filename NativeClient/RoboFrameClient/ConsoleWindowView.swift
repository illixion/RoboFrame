/*
 RoboFrame Native Client - Console Window

 Pop-out console window (visionOS only). The console itself — OSLogStore
 polling, level/category/search filtering, clipboard export — is RAVEConsole,
 shared with Hypnos and the other RAVE apps; this file only hosts it as its
 own scene and registers it with the window manager. Mirrors Hypnos's
 `ConsoleWindowView`, minus the "back to the gallery" ornament: RoboFrame has
 no other window worth summoning from here, so the window's own system chrome
 (title bar close button) is the whole way back.
 */

import RAVEConsole
import RAVEUI
import SwiftUI

#if os(visionOS)
struct ConsoleWindowView: View {
    var body: some View {
        RAVEConsoleScreen()
            .manageWindow(ManagedWindows.console())
    }
}
#endif
