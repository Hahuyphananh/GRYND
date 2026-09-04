# GRYND UX Upgrade Plan

## Status

✅ Done — Housekeeping (UX.md moved to `.agents/instructions/UX.md`), P1-1
(Recently played + persisted search/filter), P1-2 (Popular/New badges), P1-4
(balance at laptop widths), P0-1 (global branded toast system — home page +
settings migrated; inline errors intentionally kept).

⬜ Remaining — P0-2, P0-3, P1-3, P2-1, P2-2, P2-3, P3-1, P3-2, P3-3.

---

Sources: `.agents/instructions/UX.md` (the 20 UX laws — this
plan cites them by number) and a review of the live components (nav, casino
lobby, home, settings, creator-mode, legal pages).

Goal: reduce confusion, effort, and errors across the app **while keeping the
current brand** — the neon-casino identity (`#00e5ff` cyan, `#f5ff3b` yellow,
`#040d24`/`#050b1e` navy, glow shadows, `rounded-xl` cards, framer-motion,
Tabler icons) and the existing component system in `src/components/uipro/`.

## Brand guardrails (non-negotiables)

- Palette: keep `#00e5ff` (primary), `#f5ff3b` (accent/CTA), `#ff4fd8`/`#a855f7` (pink/violet),
  `#040d24` family backgrounds. Per-section accents in settings (amber = responsible play,
  emerald = security, fuchsia = wagers) are intentional — keep them.
- Components: build on `uipro` (buttons, modal, toast shell, nav shell). Add missing
  primitives there; never hand-roll per-page duplicates.
- Motion: keep `framer-motion` + the existing `lib/animations` variants, and always honor
  `useReducedMotion`/`withReducedMotion` (already done well everywhere).
- All strings stay in the translation system (`useTranslation`), not hardcoded.
- Accessibility floor already met: focus-visible rings, aria-labels, Escape-to-close,
  reduced motion, semantic HTML. Keep it.

## Already strong (do not churn)

- Casino lobby: search, 4 filters, no-results state, friend-presence, onboarding tour,
  sticky mobile CTA, `data-tour` steps. (Laws 1, 5, 7, 9, 11)
- Settings: per-section save + inline feedback, quick-pick amounts, sensible defaults,
  admin gating. (Laws 13, 14, 19)
- Home: quest/streak/battlepass progress widgets, completion popups, terms modal, live
  stats. (Laws 10, 11, 20)
- Inputs validate early and preserve work on error (MFA strips non-digits, wager
  validation, contact email, loss-limit messages). (Laws 14, 15)
- Creator Mode overlay/result panel and the legal-pages layout are clean.

---

## P0 — Foundations (highest impact, touches every page)

### P0-1. Global branded toast system  *(Law 6 — Doherty Threshold)*
**Gap:** feedback is fragmented: the home page has a local `notification` state +
`UIPro16ToastShell` that never auto-dismisses; settings show inline text next to save
buttons; games show ad-hoc states. Users routinely can't tell if a save/claim/action
registered.
**Change:** add a `ToastProvider` (context) rendering `UIPro16ToastShell`-styled toasts
portaled to `<body>`: dark navy `#040d24/95` card, `#00e5ff` border, icon per type
(success = emerald check, error = red alert, info = cyan), auto-dismiss ~4s, manual
dismiss, `aria-live="polite"`, reduced-motion aware. Mount once in the root layout.
Migrate the home page's local toast + settings' inline success messages (keep inline
*errors* near the field — Law 15 says tell users how to fix it in place).
**Files:** new `src/components/toast/`, edit `src/app/layout.tsx`, home `PageClient`,
settings `PageClient`.
**Effort:** M.

### P0-2. Branded loading states instead of "Loading…" text  *(Law 6)*
**Gap:** settings shows a raw blue screen with `Loading...` text; quests/challenges show
tiny `ui.loading` text.
**Change:** a small branded skeleton (navy card, `#00e5ff/20` shimmer rows, respecting
reduced motion). Replace the raw `bg-[#003366] Loading...` branch and the inline loading
texts.
**Effort:** S–M.

### P0-3. Replace native `confirm()` with a branded confirm modal  *(Laws 15, 16)*
**Gap:** native browser dialogs (`window.confirm` for MFA disable, the "new version
available — refresh?" ETag nag in the nav) break the brand and can't be styled.
**Change:** extend `uipro` with `UIPro19ConfirmModal` (backdrop + panel already exist as
UIPro17/18). Use it for MFA disable and the app-update notice (also make the update
notice dismissible/non-blocking instead of `confirm`).
**Effort:** S–M.

## P1 — Casino lobby & navigation (decision load + reachability)

### P1-1. "Recently played" row + persisted search/filter  *(Laws 1, 9, 11)*
**Gap:** the lobby shows all 22 games equally; returning players re-scan every time.
**Change:** persist `activeFilter` + `search` in `sessionStorage`; show a "Recently
played" section (last ~4 game keys from `sessionStorage`, serial-position first) before
the full grid.
**Effort:** S–M.

### P1-2. Popular/New badges on game cards  *(Law 7 — Von Restorff)*
**Gap:** every card looks identical; the "popular" filter exists but nothing highlights
the recommended games.
**Change:** small `#00e5ff` "Popular" / `#f5ff3b` "New" pill badges on the card image
corner using existing `popular`/`newestOrder` metadata. One accent per card, never both.
**Effort:** S.

### P1-3. Enlarge small tap targets  *(Law 2 — Fitts's Law)*
**Gap:** "View leaderboard" on game cards is a 12px text link; close/dismiss icon
buttons (16px icons) in the prestige notice; nav level/title text is 10px.
**Change:** bump hit areas to ≥40px (`p-2`/`min-h-[40px]` wrappers), keep visuals
identical. Check the nav avatar/title cluster on `lg–xl`.
**Effort:** S.

### P1-4. Balance visible at laptop widths  *(Laws 3, 8 — Jakob/Fitts)*
**Gap:** the tokens chip renders only at `2xl`; the hamburger only below `md`. At
`md–xl` a signed-in player sees **no balance** (the comments in the nav admit the
chip was hidden to stop clipping).
**Change:** render a compact balance chip from `lg` (short format, e.g. `12.5k`), keep
the full chip at `2xl`, and add `aria-expanded` to the hamburger.
**Effort:** S.

## P2 — Settings & forms (consistency + progressive disclosure)

### P2-1. Section index for the settings hub  *(Laws 1, 19 — Hick/Tesler)*
**Gap:** 10 color-coded sections in one long 2-col grid; no way to jump.
**Change:** a sticky left rail (desktop) / horizontal chip row (mobile) of section
anchors; keep all sections on one page (no tabs — avoids hiding settings, Law 19
favors reveal-over-hide). Keyboard focus moves on anchor click.
**Effort:** M.

### P2-2. Standardize buttons on the uipro primitives  *(Law 16 — Similarity)*
**Gap:** four button treatments coexist: `border-b-4` 3D (settings), plain rounded
(nav), pills (filters/loss-limit), gradient (home). Filters/pills can stay as
segmented controls, but primary actions should be one component with
primary/secondary/danger variants.
**Change:** add `UIPro08Button` variants to `uipro`; migrate settings save buttons and
home CTAs to it (same visuals, shared focus/disabled/hover logic).
**Effort:** M.

### P2-3. Autosave or explicit "saved" confirmation for prefs  *(Law 6, 10)*
**Gap:** notification prefs require a manual Save even though they toggle instantly —
inconsistent with the language picker which applies immediately.
**Change:** make the preference toggles autosave (debounced, optimistic, with the P0-1
toast on failure + revert), keeping the Save button only where a full review matters
(wagers/loss limit).
**Effort:** M.

## P3 — Game flows (error prevention + completion)

### P3-1. Leave-match guard for live PvP games  *(Law 14 — Postel)*
**Gap:** navigating away/back during a live PvP match silently abandons it (the FAQ
documents forfeit rules — the UX doesn't warn).
**Change:** when a match is active (`MATCH_STATUS` beyond waiting), intercept
route-change/`beforeunload` with the P0-3 confirm modal ("Leave match? You'll forfeit").
Implement in the shared `CreatorModeHost`-adjacent lifecycle or a small
`useLeaveMatchGuard` hook, wire into one reference game first (plinko), then the rest.
**Effort:** M–L (per-game wiring).

### P3-2. In-game quick-wager chips  *(Laws 8, 13 — Fitts/Hick)*
**Gap:** per-game wager inputs exist; players type amounts each time (defaults exist
via `useDefaultWager`).
**Change:** where wager inputs render, add 3 quick chips (e.g. 1× / 2× / 5× the
default) as in settings' loss-limit quick amounts. Keep typed input for precision.
**Effort:** S–M per game (start with one).

### P3-3. End-of-session clarity after quitting a game  *(Law 10 — Peak-End)*
**Gap:** leaving a finished game drops the player back with no summary.
**Change:** a lightweight "session summary" panel (result, net tokens, Play again)
reusing the Creator Mode result-panel styling, for the games that already compute
results. Optional; lowest priority.

---

## Suggested order & verification

1. **P0-1 + P0-2** (feedback everywhere) → 2. **P1-2 + P1-3 + P1-4** (quick lobby wins)
   → 3. **P1-1, P2-1** → 4. **P0-3 + P2-2** (consistency) → 5. **P3** (game flows).

Verify each batch:
- `npm run verify:legal-pages` + `qa/smoke-test.mjs` still green (no page regressions).
- `npm run verify:a11y` (`scripts/axe-scan.mjs`) for the touched pages.
- Manual pass in the browser for the lobby, settings, and one game.
- Reduced-motion (`prefers-reduced-motion`) + keyboard-only pass for new toasts/modals.

## Housekeeping

- `UX.md` currently lives inside `.agents/skills/stripe-best-practices/` — that's the
  Stripe-skill folder, so the laws only apply when that skill loads. Recommend moving
  the file to a location that applies globally (e.g. `.agents/instructions/UX.md` or
  `docs/`) so every UI change picks it up. (Not doing this without your go-ahead.)