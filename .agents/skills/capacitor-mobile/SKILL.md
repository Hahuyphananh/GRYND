---
name: capacitor-mobile
description: Use when working on GRYND's iOS or Android shell, native status/navigation bars, safe areas, keyboard behaviour, app lifecycle, resume, haptics, plugins, permissions, or WebView debugging. Not for pure web UI or gameplay rules.
---
<!-- type: flexible -->

# Capacitor Mobile

GRYND's native shell. The app is a Capacitor 8 WebView pointed at the remote web
app (`capacitor.config.ts`), so almost every "native" behaviour is a contract
between the OS, the Capacitor plugin, and a web module in `src/lib/native/`.

Capacitor docs: <https://capacitorjs.com/docs>. Plugin APIs for the installed
packages: `@capacitor/app`, `@capacitor/keyboard`, `@capacitor/status-bar`,
`@capacitor/haptics`, `@capacitor/network`, `@capacitor/splash-screen`,
`@capacitor/core`.

## Doctrine

- **The WebView is the app, and it is not a native view hierarchy.** There is no
  `UINavigationController`, no `UISheetPresentationController`, no Android
  `BottomAppBar`, and no native gesture recognizer. A WKWebView/Android WebView
  renders HTML; anything that looks native is CSS that reproduces it.
- **Capacitor cannot do what the platform does not expose to a WebView.** No
  background execution guarantee, no reliable background timers, no true control
  of the display refresh rate, no native push without an added plugin, no
  arbitrary access to the filesystem or contacts without a plugin and permission.
  Never promise these in copy, comments, or UI.
- **Every native call must be optional.** A browser session, a denied permission,
  an emulator without a vibrator, or a missing plugin must degrade silently. The
  existing `src/lib/native/haptics.ts` is the reference implementation: no
  top-level plugin imports, `isNativePlatform()` before loading, and every entry
  point resolves rather than rejects.
- **Do not add a plugin without a concrete need.** Each plugin adds native code,
  permissions, store-review surface, and a second failure mode. Check first
  whether the behaviour already exists in `src/lib/native/`.
- **iOS and Android differ in ways that matter.** Test both; a fix for one is
  frequently a regression for the other.

## Process

### 1. Inspect the shell before changing it

- `capacitor.config.ts` - `appId`, `appendUserAgent` (the `GRYNDApp/1.0` token the
  server uses to keep AdSense and Stripe checkout out of the native build),
  remote `server.url`, `cleartext: false`, `errorPath`, and the Keyboard
  `resizeOnFullScreen` workaround.
- `src/lib/native/` - `appLifecycle.ts`, `backButton.ts`, `connectivity.ts`,
  `haptics.ts`, `keyboard.ts`, `shell.ts`, `shellServer.ts`, `socketRecovery.ts`.
- `src/components/native/` - `NativeLifecycleBridge`, `NativeBackButton`,
  `NativeSystemBars`, `NativeKeyboard`.
- `src/app/layout.tsx` - `viewportFit: "cover"` and the mounted bridges.
- `android/` and `ios/` for manifest/plist changes and the current app id.

### 2. Status bar, navigation bar, and safe areas

- Android 15+ (targetSdk 35+) draws edge-to-edge by default. The app background
  must extend behind the bars; only content is inset.
- `--safe-top` / `--safe-bottom` are the single source of truth
  (`src/app/globals.css`), and they are non-zero only with `viewport-fit=cover`.
- `.safe-top` moves content down while the element's own background still paints
  behind the status bar. Use it on a `fixed top-0` surface.
- Bottom-fixed controls use `.safe-bottom` (or
  `padding-bottom: max(1rem, env(safe-area-inset-bottom))`). Do not hard-code.
- `NativeSystemBars` sets the real bar appearance. Do not paint a fake status bar
  to work around a colour. If the bar style must change per screen, do it through
  the existing bridge and restore it on unmount.
- The `themeColor` in `layout.tsx` is deliberately not set; do not add one.

### 3. Keyboard

- Android resizes the WebView (`windowSoftInputMode="adjustResize"` plus
  `resizeOnFullScreen`). `src/lib/native/keyboard.ts` **observes** the keyboard;
  it does not lift, scroll, or focus anything. Do not translate a fixed element
  by `--keyboard-height` on a resized surface - it would move twice.
- iOS does not resize the same way; a focused input must be scrolled into view.
- Close the keyboard on Back before navigating away.
- Test every input, including those inside sheets and the chat composer.

### 4. Lifecycle, resume, and connectivity

- `appLifecycle.ts` reports foreground/background transitions. On resume, do not
  assume a socket survived: `socketRecovery.ts` and `connectivity.ts` exist for
  this. Re-fetch authoritative state instead of trusting a stale board.
- WebView timers are throttled or suspended in the background. Derive elapsed
  time from timestamps, never from `setInterval` ticks.
- A network change must not silently drop a pending action: show an honest
  offline state and retry through the existing path.
- Cold start with no network lands on `server.errorPath` (`error.html`), a local
  asset with one "Try again". It has no plugin access; do not put session or match
  logic in it.

### 5. Haptics

- Use `triggerHaptic("selection" | "success" | "warning")` from
  `src/lib/native/haptics.ts`.
- Never fire haptics from gameplay (moves, timers, sockets, matchmaking). The
  module forbids it because vibration can leak timing in a competitive match.
- Never await a haptic in a user-facing handler; the fire-and-forget form exists
  for that reason.

### 6. Permissions and plugins

- Before adding a plugin: confirm no existing module covers the need, check that
  it supports the installed Capacitor 8, and check what it adds to
  `AndroidManifest.xml` and `Info.plist`.
- Request a permission only at the moment it is needed, explain why first, and
  handle denial as a normal state - the feature must remain usable or clearly
  unavailable, never crash.
- iOS requires a usage-description string for every protected resource; a missing
  one is an App Store rejection.
- After any native dependency or config change, run `npx cap sync` for both
  platforms. A config change that is not synced is not applied.

### 7. WebView performance and debugging

- Debug Android with `chrome://inspect` on a USB-connected device and iOS with
  Safari's Web Inspector on the simulator/device (enable it in Safari settings).
- The remote `server.url` means there is no local dev server in the app; use the
  browser for UI iteration and the device for native behaviour.
- Measure on a mid-range Android device: DOM size, long tasks, and frame timing.
- Avoid loading a plugin on the web path; lazy-load after
  `Capacitor.isNativePlatform()` as `haptics.ts` does.

### Verify

1. `npx cap sync` after every native/config change, then build and run on both
   platforms.
2. Cold start online, cold start offline (expect `error.html`), and resume from
   background after several minutes.
3. Status bar and navigation bar in light and dark content, portrait and
   landscape, gesture and three-button navigation.
4. Keyboard open on every input; focused field visible on both platforms.
5. Haptics on a physical device, and silence on a device without a vibrator.
6. Rotation mid-interaction and mid-drag.
7. Run `npx tsc --noEmit` and the existing tests. Do not loosen a test for a
   native change.

State which checks ran on a physical device and which ran only in a simulator.

## Red flags

| Rationalisation | Reality |
|---|---|
| "Capacitor gives us native navigation." | It gives a WebView. Navigation is web routing; the back button is bridged, not native. |
| "I'll load `@capacitor/haptics` at module top level." | It breaks SSR and downloads plugin code into the browser. Lazy-load after `isNativePlatform()`. |
| "The keyboard overlays the input, so I'll translate the page." | The OS already resized the view on Android; translating moves it twice. Observe, do not lift. |
| "Edge-to-edge is Android 15's problem, not ours." | It is ours: targetSdk 35 forces it, and our content sits under the bars without the insets. |
| "I'll add a plugin for background timers." | Background execution is not guaranteed to a WebView and the plugin cannot change that. Derive from timestamps. |
| "It works in the browser, so the app is fine." | The browser has no notch, no IME resize, no system bars, and no WebView throttling. Test the app. |
| "A permission denial should block the screen." | Denial is a normal outcome. Degrade the feature honestly; never crash or loop the prompt. |
