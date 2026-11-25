---
name: ios-human-interface
description: Use when a screen will run on iPhone or iPad and its navigation pattern, safe-area behaviour, sheets, gestures, Dynamic Type, or platform-specific feel is in question. Not for Android conventions, generic layout, or backend concerns.
---
<!-- type: flexible -->

# iOS Human Interface Guidelines

Applying Apple's Human Interface Guidelines to GRYND's WKWebView UI. The app is
a Capacitor wrapper around a remote web app (`capacitor.config.ts`), so the
deliverable is a web screen that *feels* native on iOS, not UIKit code.

Read the current guidelines rather than trusting memory:
<https://developer.apple.com/design/human-interface-guidelines/>

## Doctrine

- **Respect the system.** The status bar, home indicator, and system gestures
  belong to iOS. Never draw over them, never imitate them, and never trap a
  gesture the system owns.
- **Be honest about the platform boundary.** A WKWebView cannot present a native
  `UISheetPresentationController`, cannot register a `UIScreenEdgePanGestureRecognizer`,
  and cannot use `UINavigationController`. You can reproduce the *behaviour* in
  CSS and JavaScript; you cannot claim the native control. If a native control is
  genuinely required, that is a Capacitor plugin decision, not a styling one.
- **Navigation must be predictable.** iOS users expect a tab bar for top-level
  destinations and a back affordance for drilling in. GRYND already has
  `src/components/shell/MobileTabBar.tsx` for the former - use it rather than
  inventing a second tab pattern.
- **Text must scale.** Dynamic Type is an accessibility contract. Do not block
  zoom, do not fix text in pixels that cannot grow, and do not clip at large
  sizes.
- **Motion confirms, it does not decorate.** Short, interruptible, and disabled
  under Reduce Motion.
- **Do not add dependencies.** There is no iOS UI kit in this project and none is
  needed. Tailwind 4, CSS, and Framer Motion 12 are already available.

## Process

### 1. Inspect the current iOS surface

- `capacitor.config.ts` - remote `server.url`, `appendUserAgent`, `errorPath`,
  and the Keyboard plugin workaround.
- `src/app/layout.tsx` - `viewport` with `viewportFit: "cover"` and no
  `maximumScale`, which must stay that way.
- `src/app/globals.css` - `--safe-top`, `--safe-bottom`, `.safe-top`,
  `.safe-bottom`.
- `src/lib/native/*` - lifecycle, back button, keyboard, connectivity, haptics.
- The screen you are touching, plus `MobileTabBar` for navigation consistency.

### 2. Safe areas and the home indicator

- Every full-bleed surface must inset its **content**, not shrink its background:
  use `.safe-top` or `padding-top: var(--safe-top)` on a `fixed top-0` element so
  the background still paints behind the status bar.
- Bottom-fixed controls clear the home indicator with
  `padding-bottom: max(1rem, env(safe-area-inset-bottom))` (the `.safe-bottom`
  utility).
- Never place a tappable control within the home-indicator swipe region. That
  gesture belongs to the system.
- Landscape on a notched phone has left/right insets too. If the screen supports
  landscape, use `env(safe-area-inset-left/right)`.

### 3. Navigation

- **Top level:** the existing bottom tab bar, hidden at `md` and above.
- **Drill-down:** a visible back control in the top bar that mirrors the system
  chevron position (leading edge) and label ("Back", not "Return"). Do not rely
  on the edge-swipe alone: the WebView cannot register it natively, and a
  horizontal card drag would conflict with it anyway.
- **Modals and sheets:** iOS presents these over the content with a dimmed
  backdrop and a grabber. Reproduce the presentation in CSS:
  - Enter from the bottom, 250-350ms, ease-out; exit faster (200ms).
  - A drag-to-dismiss handle, a visible close affordance, and backdrop tap to
    dismiss - but never dismiss a sheet with unsaved input without confirming.
  - Full-screen sheets need their own safe-area insets and a scroll container
    that does not move the page behind them.
  - Do not describe this in code as a "native sheet"; it is a web sheet styled to
    match the platform.
- **Alerts:** use the existing dialog pattern if one exists. If none exists, a
  centred card with a title, one sentence of body, and at most two actions
  (cancel first on the left, destructive in red). Do not stack three actions.

### 4. Controls and touch

- 44x44pt minimum target. A 44pt target may contain a smaller glyph.
- Use familiar affordances: switches for instant settings, segmented controls for
  two or three views, a checkmark for a completed selection.
- Destructive actions are red and require confirmation only when the result is
  irreversible. Do not confirm everything.
- Do not use long-press for a primary action; it is undiscoverable and conflicts
  with text selection.

### 5. Dynamic Type and accessibility

- Size text in `rem`, not fixed `px`, so the user's text-size setting scales it.
- Keep `user-scalable` enabled; the current viewport does not set `maximumScale`
  and must not start doing so.
- Test at the largest accessibility sizes: labels wrap, containers grow, nothing
  is clipped, and no control becomes unreachable.
- Support Reduce Motion via `@media (prefers-reduced-motion: reduce)`.
- Label icon-only controls with `aria-label`; VoiceOver reads `aria-label`,
  `role`, and state - not visual context.
- Use `aria-live="polite"` for asynchronous status, never for rapid game events
  (see `mobile-accessibility`).

### 6. Motion that matches the platform

- Standard transitions 250-350ms; direct manipulation (a dragged card) must
  track the finger with no easing until release.
- Use spring-like easing on release, but cap overshoot so the element cannot
  cover a control.
- Respect Reduce Motion by substituting a cross-fade or instant change.
- Never animate a layout property (`width`, `height`, `top`, `left`) on a large
  surface; animate `transform` and `opacity`.

### Verify

1. Run on an iPhone simulator or device via `npx cap sync ios` and Xcode. A
   desktop browser with a device profile does not reproduce safe areas or the
   home indicator.
2. Check portrait and landscape, with the status bar in light and dark content.
3. Check the largest Dynamic Type setting and 200% browser zoom.
4. Check VoiceOver reading order on the screen and on any sheet.
5. Check Reduce Motion on.
6. Run `npx tsc --noEmit` and the relevant existing tests. Do not weaken a test
   to accommodate a visual change.

State clearly which checks were done on a real iOS runtime and which were only
reasoned about.

## Red flags

| Rationalisation | Reality |
|---|---|
| "I'll call it a native sheet." | It is a web sheet styled like one. A WKWebView cannot present `UISheetPresentationController` without a plugin. |
| "The edge-swipe back gesture works in Safari, so it works in the app." | Capacitor's WKWebView has no native edge-swipe unless code adds it, and it would fight the solitaire drag. Provide a visible back control. |
| "Safe areas are fine, I used `100vh`." | `vh` ignores the notch and the home indicator. Use safe-area padding, and `dvh` for height. |
| "Users can zoom if the text is too small." | Blocking zoom is an accessibility failure, and relying on zoom is not Dynamic Type support. |
| "Haptics on every card move will feel premium." | `src/lib/native/haptics.ts` deliberately forbids haptics from gameplay: it can leak timing in a competitive match and turns feedback into noise. |
| "44pt is only a guideline." | It is the platform's baseline for a reliable tap, and it is smaller than Material's 48dp. Do not go under it. |
| "A confirmation dialog makes the delete safer." | Confirming every action trains users to dismiss dialogs. Confirm only irreversible ones. |
