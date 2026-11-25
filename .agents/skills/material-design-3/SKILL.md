---
name: material-design-3
description: Use when a screen will run on Android and its navigation pattern, controls, touch targets, system bars, edge-to-edge layout, or Material 3 visual language is in question. Not for iOS conventions, generic layout, or backend concerns.
---
<!-- type: flexible -->

# Material Design 3

Applying Material Design 3 (M3) to GRYND's Android WebView. The app is a
Capacitor wrapper around a remote web app, and Android 15+ draws it edge-to-edge
under the system bars whether it asks to or not.

Read the current spec rather than trusting memory: <https://m3.material.io/>

## Doctrine

- **Android is not a resized iPhone.** Navigation, elevation, motion, and even the
  meaning of a bottom bar differ. Do not port iOS patterns and call them Material.
- **Edge-to-edge is mandatory, not optional.** Android 15+ (targetSdk 35+) draws
  every app under the status and navigation bars. Content must inset itself;
  backgrounds must extend behind the bars.
- **The system owns Back.** Android's back gesture and button must always work.
  GRYND handles this in `src/lib/native/backButton.ts` and
  `src/components/native/NativeBackButton.tsx` - never register a competing
  handler or swallow Back to keep a modal open.
- **M3 is a system, not a skin.** Colour roles, type roles, shape, and elevation
  are tokens. Do not approximate them with arbitrary values, and do not add
  `@material/web` or MDC: the project already has Tailwind 4 and its own tokens,
  and a second component library would fight the existing one.
- **Honesty about the WebView.** A WebView has no native Material components, no
  ripple on arbitrary elements, and no `BottomAppBar` widget. Ripple and state
  layers are CSS. Dynamic colour from the wallpaper is not available to the web
  layer unless a plugin exposes it.

## Process

### 1. Inspect the current Android surface

- `capacitor.config.ts` - `appendUserAgent`, the Keyboard
  `resizeOnFullScreen` workaround, and `server.errorPath`.
- `src/app/layout.tsx` - `viewportFit: "cover"`; this is required for
  `env(safe-area-inset-*)` to be non-zero in the WebView.
- `src/app/globals.css` - `--safe-top`, `--safe-bottom`, `.safe-top`,
  `.safe-bottom`, and the tab-bar height contract.
- `src/components/shell/MobileTabBar.tsx` - the existing top-level navigation.
- `src/lib/native/backButton.ts`, `keyboard.ts`, `connectivity.ts`,
  `appLifecycle.ts` - the behaviours Android depends on.
- `src/components/native/NativeSystemBars.tsx` - how bar appearance is set.

### 2. Navigation

- **Top-level destinations:** M3 uses a navigation bar (bottom) for three to five
  destinations. GRYND's `MobileTabBar` already fills this role: four tabs, labels
  under icons, active state, `aria-current="page"`. Reuse and extend it; do not
  add a second bottom bar.
- **Drill-down:** a top app bar with a leading back arrow that calls the same
  history action as the system Back. The two must not disagree.
- **Tabs:** use them for sibling views of the same object, not for navigation
  between unrelated destinations.
- **FAB:** M3's floating action button is for the single most important action on
  a screen. GRYND's screens are mostly board- and list-driven; a FAB that covers
  a card column is worse than a normal button. Use one only when it does not
  overlap gameplay or the tab bar.

### 3. Controls, shape, and state layers

- 48x48dp minimum touch target; 8dp grid for spacing.
- M3 shapes: small (8dp), medium (12dp), large (16dp), full (pill). Pick per
  component role and keep it consistent across the app.
- **Ripple / state layer:** implement as a pseudo-element overlay on press at
  roughly 10-12% of the content colour, fading out over 150-200ms. It must not
  intercept pointer events and must not fire on scroll.
- **Elevation:** M3 expresses elevation with tonal surface colour plus a soft
  shadow, not a hard drop shadow. In this app, prefer the existing
  `--bg-surface` and border tokens over inventing a shadow scale.
- Disabled controls keep their shape and label, with reduced contrast - never
  disappear.
- Use a switch for an immediate binary setting, a checkbox for a multi-select,
  and a segmented button for two to five mutually exclusive views.

### 4. System bars and edge-to-edge

- Extend the app background behind the status and navigation bars; inset only the
  content. `.safe-top` exists for exactly this on a `fixed top-0` element.
- Bottom-fixed surfaces clear the gesture bar with
  `calc(<size> + env(safe-area-inset-bottom))` or `.safe-bottom`. A 10px padding
  with no inset will sit under the gesture bar on Android 15.
- Do not paint a fake status bar. `NativeSystemBars` controls the real one.
- Test with three-button navigation as well as gesture navigation; the inset
  differs.

### 5. Keyboard and focus

- The WebView is resized by the OS (`windowSoftInputMode="adjustResize"` plus the
  plugin's `resizeOnFullScreen`). Therefore do not also translate a fixed element
  by `--keyboard-height`: it would move twice. `src/lib/native/keyboard.ts`
  observes; it does not lift. A surface may consume `--keyboard-height` only if
  it has proved it is not resized.
- The focused input must stay visible above the IME. Scroll it into view after
  the resize settles, not before.
- Keep the Android Back button closing the keyboard first, then the screen - that
  is the platform expectation.

### 6. Motion and accessibility

- Standard durations 200-300ms with emphasized easing for large surfaces.
- Respect Remove Animations: check both `prefers-reduced-motion` and the system
  animator-scale behaviour; never make an animation the only signal.
- TalkBack reads `aria-label`, `role`, and state. Icon-only controls need labels.
- Support 200% text scaling: no fixed-height containers around text, no clipping.
- Announce asynchronous results with `aria-live="polite"`, not gameplay events.

### Verify

1. Run on an Android emulator or device via `npx cap sync android`. Test API 35+
   to see the forced edge-to-edge behaviour.
2. Test gesture navigation and three-button navigation.
3. Test the IME open on every screen with an input, including inside a sheet.
4. Test the hardware/gesture Back on every screen and with a sheet open.
5. Test 200% font size and TalkBack reading order.
6. Run `npx tsc --noEmit` and the relevant existing tests. Never loosen a test to
   make a visual change pass.

Say which checks ran on a real Android runtime and which were only reasoned
about.

## Red flags

| Rationalisation | Reality |
|---|---|
| "Android 15 edge-to-edge only affects native apps." | It affects this WebView. Content under the status bar is clipped unless you inset it. |
| "I added a second bottom bar for this section." | Two bottom bars is never Material. Extend `MobileTabBar` or use in-page tabs. |
| "The ripple is decorative, I'll skip it." | The state layer is the press feedback. Without it, taps feel unregistered. |
| "I'll add `@material/web` for correct components." | It introduces a second design system and bundle weight. The project's tokens and Tailwind are the system. |
| "I took over the Back button so the sheet stays open." | Android users expect Back to dismiss. Handle Back inside the sheet, then let it propagate. |
| "I lifted the composer by `--keyboard-height`." | The OS already resized the view. It moves twice and overshoots. |
| "48dp is the same as 44px, close enough." | It is 48 CSS px versus 44. Using 44 is under target on Android. |
