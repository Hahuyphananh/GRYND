---
name: mobile-ui-design
description: Use when designing or building a mobile-first screen, layout, or component and its structure, typography, spacing, density, or state coverage is still undecided. Not for auditing an existing interface, choosing a brand identity, or picking a specific platform's controls.
---
<!-- type: flexible -->

# Mobile UI Design

Mobile-first UI design for the GRYND web app and its Capacitor WebView. This
skill governs *structure and system*: how a screen is composed, how it scales
from a 320px phone to a desktop, and how it behaves in every non-happy state.

For a platform's specific navigation and controls, use `ios-human-interface` or
`material-design-3`. For card and board interactions, use `mobile-game-ux`.

## Doctrine

- **The phone is the product.** GRYND ships as an iOS and Android app whose UI is
  a WebView at `https://www.grynd.dedyn.io/` (`capacitor.config.ts`). Design the
  narrow layout first and let larger screens earn their extra room. A desktop
  layout squeezed down is not a mobile layout.
- **One primary action per screen.** Every screen answers one question and offers
  one obvious next step. Competing calls to action are a design bug.
- **Use the design system that exists.** GRYND's tokens live in
  `src/app/globals.css` (`--bg-surface`, `--border-hairline`, `--text-primary`,
  `--text-muted`, `--accent-strong`, `--focus-ring`, `--nav-height`,
  `--tabbar-height`, `--safe-top`, `--safe-bottom`). Do not invent hex values,
  spacing scales, or parallel component styles. If a token is missing, propose
  adding it once rather than hard-coding a value at the call site.
- **States are part of the component, not a follow-up.** Loading, empty, error,
  success, disabled, and offline are designed before the happy path is called
  done.
- **Touch, not hover.** Hover is an enhancement for pointer devices. Nothing
  essential may depend on it, and every interactive element needs a visible
  pressed state.
- **Prefer CSS and the existing stack.** Tailwind CSS 4 and Framer Motion 12 are
  already installed. Adding a UI kit, icon set, or animation library for one
  screen is not justified.

## Process

### 1. Inspect before designing

Read, at minimum:

- `src/app/globals.css` - tokens, safe-area utilities (`.safe-top`, `.safe-bottom`),
  existing responsive blocks.
- `src/components/shell/MobileTabBar.tsx` - the established mobile navigation
  pattern (`md:hidden`, `--tabbar-height`, per-tab `aria-current`).
- `src/app/layout.tsx` - `viewport` and `viewportFit: "cover"`, which is what
  makes `env(safe-area-inset-*)` non-zero.
- The closest existing screen or component to the one you are building.

List what you found and reuse it. If you cannot name the tokens and components
you are reusing, you have not finished inspecting.

### 2. Set the layout contract

Decide and write down:

- **Breakpoints.** Mobile is the unprefixed default. Add `sm:`, `md:`, `lg:`
  only where the layout genuinely changes. Do not add a breakpoint per component.
- **Viewport height.** Use `dvh`, not `vh`, for full-height surfaces; mobile
  browser chrome and the native keyboard change `vh` behaviour. Prefer
  `min-h-dvh` to `h-screen`.
- **Scroll ownership.** Exactly one vertical scroller per screen. If a region
  scrolls internally, set `overscroll-behavior: contain` so the page behind it
  does not move.
- **Navigation clearance.** Content that sits under the fixed top bar or
  `MobileTabBar` must clear `--nav-height` / `--tabbar-height` plus the relevant
  safe-area inset. Never hard-code a pixel guess.
- **Width.** Constrain readable content (roughly 60-75 characters) on wide
  screens; let boards, tables, and media use the available width.

### 3. Build the type and spacing ramp

- Body text at 16px or larger. Below 16px is hard to read on a phone, and iOS
  zooms focused inputs below 16px, which breaks the layout.
- Use a small, fixed ramp (for example 12 / 14 / 16 / 20 / 24 / 32). Express
  display sizes with `clamp()` so they scale without a breakpoint.
- Use a consistent spacing step (4px or 8px). Group related elements with
  proximity rather than borders; separate unrelated groups with more space.
- Prefer fluid width over fixed width, and `min-w-0` / `truncate` on flex
  children that can overflow. Test with a 30-character username and a long game
  title.

### 4. Design the states

For every screen or data-bound component, define all of:

| State | Requirement |
|---|---|
| Loading | A skeleton or spinner sized to the final content; never a layout jump |
| Empty | Says what would be here, why it is empty, and the one action that fixes it |
| Error | Plain language, what happened, and a retry that preserves the user's work |
| Success | Confirms the outcome and what happens next |
| Disabled | Visibly distinct and explained; disabled is not an error message |
| Offline | Honest about what still works; a queued action says it is queued |

### 5. Make it touch-friendly

- Minimum 44x44 CSS px for any target (Apple) and 48x48 where practical
  (Material). Icon-only buttons get padding to reach the target, not a larger
  glyph.
- Space adjacent destructive and constructive actions apart; never place them
  within a thumb-width of each other.
- Put primary actions in the lower half of the screen for one-handed use, except
  where the platform convention says otherwise (a top-right Done, a back arrow).
- Provide `:active` / `[data-pressed]` feedback within one frame. See
  `mobile-game-ux` for latency budgets.

### 6. Adapt upward, not downward

- Wide screens may add a second column, a persistent sidebar, or a data table -
  only when it improves the task.
- Do not stretch a phone layout across 1440px without a max-width.
- Keep the information hierarchy identical across sizes; change arrangement, not
  meaning.

### Verify

1. Check narrow and wide: 320, 360, 390, 430, 768, 1024, and 1440 CSS px.
2. Check text resize to 200% and the longest realistic strings in each slot.
3. Check with the keyboard open (native app) and with the on-screen browser
   chrome collapsed.
4. Check every state in the table above, not just the success path.
5. Run the project's checks: `npx tsc --noEmit`, and the relevant existing test
   file. Do not modify or delete a test to make a layout pass.
6. In the native app, confirm the top and bottom chrome are not overlapped:
   `npx cap sync` then run on a notched device or emulator.

Report what you verified and what you could not (for example: "not viewed on a
physical device").

## Red flags

| Rationalisation | Reality |
|---|---|
| "It looks fine in DevTools at 390px, so mobile is done." | DevTools has no notch, no keyboard, no native chrome, and no touch. The WebView is the target, not the emulator. |
| "I'll add the loading and error states later." | They are the states users hit on a bad connection, which is the normal condition on a phone. Designing them later means redesigning the screen. |
| "Hover reveals the action, so it is discoverable." | Touch has no hover. Anything revealed only on hover is unreachable for most of the audience. |
| "A new component is faster than reading the existing one." | It creates a second visual language and a second thing to maintain. Read `globals.css` and the nearest screen first. |
| "The tap target is small but the icon is clear." | A clear icon on a 20px target is still a miss. Pad the target to 44px. |
| "`h-screen` is fine, it is the same as `dvh`." | It is not, once browser chrome or the native keyboard appears. Use `dvh`. |
| "I'll hard-code this spacing value, it is only one place." | One hard-coded value becomes the reference for the next ten. Use the token or add it deliberately. |
