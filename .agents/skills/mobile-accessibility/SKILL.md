---
name: mobile-accessibility
description: Use when a mobile screen or interaction must work with VoiceOver, TalkBack, large text, reduced motion, high contrast, or a keyboard, or when contrast, labels, focus, or touch targets are in question. Not for backend or data concerns.
---
<!-- type: flexible -->

# Mobile Accessibility

Accessibility requirements for GRYND on iOS and Android. Treat the platform
screen reader as a first-class client: **if VoiceOver or TalkBack cannot complete
the task, the screen is not done.**

Reference: WCAG 2.2 (<https://www.w3.org/TR/WCAG22/>), Apple Accessibility
(<https://developer.apple.com/accessibility/>), Android Accessibility
(<https://developer.android.com/guide/topics/ui/accessibility>).

## Doctrine

- **Contrast is not a preference.** Body text needs 4.5:1; large text (>= 24px, or
  >= 19px bold) needs 3:1; UI component boundaries and focus indicators need 3:1.
  Check the actual colour pair, including text over gradients and over card art.
- **Every target is at least 44x44 CSS px** (WCAG 2.2 AA requires 24x24; 44 is the
  platform baseline and the right target here). Spacing counts: a 24px control
  with 12px of clear space can pass spacing-based exceptions, but do not rely on
  that for primary actions.
- **Nothing may require a drag.** WCAG 2.5.7 requires a single-pointer
  alternative. The solitaire board's click-to-select path is the compliant
  alternative to dragging; never remove it.
- **Focus must be visible and ordered.** A keyboard or switch user must see where
  they are and move in a logical order. Do not suppress outlines.
- **Motion is optional.** Reduce Motion removes non-essential animation without
  removing information.
- **Announce changes, do not narrate gameplay.** A polite live region for status
  ("Opponent joined", "Move rejected") is right. A live region on every card or
  clock tick floods the screen reader and makes the app unusable.

## Process

### 1. Inspect the existing accessibility surface

- `src/app/globals.css` - the `--focus-ring` token and the global
  `prefers-reduced-motion` block. Reuse them; do not invent a parallel ring.
- `src/components/shell/MobileTabBar.tsx` - the established pattern:
  `aria-label` on the nav, `aria-current="page"` on the active tab.
- The component you are changing, plus any dialog, toast, or board it contains.
- Existing tests that pin accessibility attributes (for example the tab bar and
  play-hub tests) so you do not break a contract.

### 2. Structure and semantics

- Use real elements: `button` for actions, `a` for navigation, `nav`/`main`/
  `header` for landmarks. A `div` with `onClick` is invisible to assistive tech
  unless you add `role`, `tabIndex`, and key handling - at which point a `button`
  was simpler.
- One `h1` per screen; headings reflect the visual hierarchy, not the font size.
- Lists of cards, matches, or leaderboard rows are lists.
- Every icon-only control has an `aria-label` that names the action, not the icon
  ("Close", not "X").
- Decorative images use `alt=""`; meaningful images describe the content.
- Do not use `aria-label` to replace visible text that already labels the control
  differently (WCAG 2.5.3 Label in Name).

### 3. Focus and keyboard

- Keep a visible focus indicator on every interactive element. The project's
  `--focus-ring` is the colour; do not remove `:focus-visible` styling.
- Logical tab order follows the visual order. Do not use positive `tabIndex`.
- A dialog traps focus while open, restores focus to the trigger on close, and
  closes on Escape.
- The board must be fully playable by keyboard: selectable cards are reachable,
  selection is announced, and moving to a target is possible. Verify this rather
  than assuming it.
- Do not make the page unzoomable. The viewport in `src/app/layout.tsx` sets
  `viewportFit: "cover"` but no `maximumScale`; keep it that way.

### 4. Screen reader behaviour

- Test VoiceOver (iOS) and TalkBack (Android) by task, not by element count:
  "start a match", "make a move", "read the result", "find my rank".
- Name, role, and state must be sufficient without visual context. For a card:
  rank, suit, and whether it is selected or movable.
- Group related information so the reader does not stop on every decorative span.
- Use `aria-live="polite"` for status changes and `aria-live="assertive"` only
  for errors that block the task. Never announce continuous values (a timer, a
  progress bar updating each frame) on every change.
- Mark busy regions with `aria-busy` while loading so the reader waits instead of
  reading a skeleton.
- Announce the result of a move once, at the end of the interaction - not on
  pointerdown and again on confirmation.

### 5. Contrast, colour, and text

- Never use colour alone to convey state (a red border with no icon or text fails
  for colour-blind users). Pair colour with a label, icon, or pattern.
- Check every state: default, hover, active, focus, disabled, error, and the same
  elements over card art or a gradient background.
- Support text scaling to 200% without clipping or overlap. Use `rem`, avoid fixed
  heights on text containers, and let labels wrap.
- Provide sufficient line height (about 1.4-1.6 for body) and limit line length on
  wide screens.
- Dark and light themes both need independent contrast checks; a token that passes
  in one can fail in the other.

### 6. Motion, timing, and touch

- Honour `prefers-reduced-motion` for every non-essential animation, including
  the global CSS block already in `globals.css`.
- No essential information may flash, blink, or auto-advance. Any timed content
  the user must read needs a way to pause or extend it.
- Provide a way to pause or dismiss transient messages; a toast that vanishes
  before a screen-reader user reaches it is not accessible.
- Do not require precise timing for a non-game action. In gameplay, the timer is
  part of the game and must be announced and adjustable where the rules allow.

### Verify

1. Contrast: measure the real foreground/background pair for every state, in both
   themes. Report the ratios you measured.
2. Screen reader: complete the primary task with VoiceOver on iOS, then TalkBack
   on Android. Note where you got stuck.
3. Keyboard: complete the same task with keyboard only, including the board.
4. Text: 200% zoom and the largest Dynamic Type / font-size setting.
5. Motion: Reduce Motion on, and confirm nothing is lost.
6. Touch: measure the smallest interactive target on the screen.
7. Run `npx tsc --noEmit` and the relevant existing tests.

Only claim a check you actually performed; say "not tested with TalkBack" when
that is the truth.

## Red flags

| Rationalisation | Reality |
|---|---|
| "It has an `aria-label`, so it is accessible." | A label on a non-focusable `div` is still unreachable. Use a real control. |
| "The contrast is close enough at a glance." | Measure the ratio. 4.4:1 for body text is a failure, and gradients change the ratio across the element. |
| "Dragging is the real interaction; keyboard users can use the web app." | The app *is* the web app. WCAG 2.5.7 applies, and the click-to-select path already exists. |
| "I'll announce every move so the player does not miss anything." | That floods the reader. Announce the outcome of the interaction, once. |
| "Reduce Motion only matters for the big animations." | It applies to every non-essential transition, including the card snap and the toast. |
| "The focus ring is ugly, so I removed it." | Removing it strands keyboard users. Restyle it, do not delete it. |
| "24x24 is the WCAG minimum, so 28px is fine." | It passes the letter of the rule and still misses on a phone. Use 44px for actions. |
