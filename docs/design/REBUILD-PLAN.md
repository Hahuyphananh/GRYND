# GRYND UI Rebuild — Locked Decisions and Phase Contract

Status: **Phases 0–6 complete — Phase 7 in progress (theme regenerated; file deletion gated by measurement)**
Date: 2026-11-18
Companion to: [`GRYND-DESIGN-REFERENCE.md`](./GRYND-DESIGN-REFERENCE.md) (the research and audit)

This file is the execution contract. The reference document explains *what is
wrong and why*; this one records *what we agreed to do, in what order, and how a
phase is judged finished*. If the two ever disagree about scope, this file wins.

---

## Decisions log

| ID | Decision | Status |
|----|----------|--------|
| D1 | Home is a ranked-first landing; `/play` is the only six-mode menu | Locked |
| D2 | Build the primitives first, then convert screens one at a time | Locked |
| D3 | Dark and light are one gate per phase — a phase is not done until both pass | Locked |

---

## D1 — Home is a ranked-first landing, `/play` is the menu

**What home keeps.** Hero (`The competitive home of Solitaire`), the ranked
primary CTA, the player's own ranked standing (Elo / trophies / ranked games /
win rate), the recent-matches list, the public Solitaire ladder preview, the
fairness section, social proof, and the ad slot as the last block.

**What home loses.** The six-card "Pick a mode" grid. A visitor who wants the
full menu follows one link to `/play`, which already renders exactly six cards
in the required order and is the surface `tests/play-hub.test.mjs` pins.

**What `/play` keeps.** All six cards, the three groups, the per-mode colour
tag, and the featured Ranked card. No route is added, removed or redirected.

**Why this is Phase 3, not now.** Removing the grid means rewriting ~200 lines
of home markup that will be restyled again by the token migration. That is the
rework D2 exists to prevent. The information architecture is settled here; the
markup change rides on the primitives.

**Acceptance criteria (Phase 3).**

- Home renders no mode grid; it renders at most three inline mode links plus one
  "All six ways to play →" link to `/play`.
- `/play` remains the single six-card menu, unchanged in count and order.
- Home still links `/games/solitaire-duel` and `/classement` (pinned by
  `tests/internal-linking.test.mjs`).
- The ad slot is still the last interactive block (`tests/ad-model.test.mjs`).
- `StreakWidget` still mounts (`tests/streak-milestones.test.mjs`).
- Home still reads `/api/solitaire/solo` and `/api/solitaire/daily` for the
  player's own standing (`tests/solitaire-solo-daily.test.mjs`); the figures
  move to the ranked standing block instead of disappearing with the cards.
- No test file is edited to make any of the above pass.

**Known test surface that reads `src/app/PageClient.jsx`.** Any home change must
keep these green — they are the reason a "delete the grid" edit is not a
five-minute job:

`ad-model`, `ai-search-readiness`, `internal-linking`,
`hilltop-banner`, `moderation-enforcement`, `rewards-quests-ui`, `shared-poll`,
`solitaire-solo-daily`.

**Deliberate follow-on, not part of D1.** Home currently links recent matches to
`/casino/solitaire-duel/<id>`. That is the match route, not the `/casino`
redirect, so no test fails — but the public URL should point at the canonical
path when the match route is next touched. Out of scope here.

---

## D2 — Primitives first, then screens

No page is restyled until the six primitives exist and are visually reviewed in
both themes. The order is fixed:

| # | Primitive | Contract | Replaces |
|---|-----------|----------|----------|
| 1 | `PageHeader` | kicker, title, description, optional actions | the copy-pasted `text-[11px] font-black uppercase tracking-[0.4em]` + `text-4xl font-black leading-[0.95]` block on `/`, `/play`, `/solitaire`, `/stats` |
| 2 | `Surface` | `tone` (page / raised / panel), `padding`, `as` | `bg-[#07101f]/90`, `bg-white/[0.02]`, `bg-white/[0.03]`, `#040d24` one-offs |
| 3 | `Button` | `variant` (primary / secondary / ghost), `size`, `asChild`-free (`href` prop) | `bg-cyan-400 text-[#04121a]`, `bg-emerald-500 text-slate-950`, hand-rolled outlines |
| 4 | `StatTile` | label, value, hint, optional tone | `UserStatsTabs`'s `StatTile`, home tiles, `/stats` tiles |
| 5 | `Tabs` | items, value, onChange, keyboard model | `UserStatsTabs` tab bar, `/classement` tabs, `/stats` ranges |
| 6 | `EmptyState` | title, body, action, tone | the scattered "No matches yet" / dash-only blocks |

**Rules.**

- One accent for the product (ranked). Mode identity becomes a token used for a
  rule, a dot or a small tag — never a page-wide surface.
- Depth is a hairline plus a soft shadow, not a glow.
- No primitive accepts a raw colour. Variants map to semantic tokens only.
- A 6-line local `cx()` helper, not a new `clsx`/`tailwind-merge` dependency.
- Each primitive ships with: dark screenshot, light screenshot, keyboard focus,
  and one real screen using it.

**Definition of done for D2.** All six exist, are used by at least one live
screen, and no new arbitrary hex value has been introduced to adopt them.

---

## D3 — Light mode is a gate, not a phase

Every phase is judged in both themes. A phase that looks correct in dark and
broken in light is **not complete**, regardless of how good the dark version
looks. `UserStatsTabs` is the cautionary example: 26 literal colours, an active
tab of `#f5ff3b` on `#06152c`, gold streak values that are effectively invisible
on white.

**Gate checklist per phase.**

- [ ] `npm run test:tokens` passes (23 assertions).
- [ ] Dark: the touched screens are pixel-stable against the Phase 0 capture.
- [ ] Light: the same screens pass contrast (body ≥ 4.5:1, large text ≥ 3:1,
      focus ring visible on both page and surface).
- [ ] No new `!important`, no element selectors, no `[class*=]` selectors.
- [ ] Focus is visible on every interactive element with the keyboard alone.
- [ ] `prefers-reduced-motion` removes the same motion the design adds.

**Ordering constraint.** `src/app/light-theme.css` is generated (226 rules, 290
`!important`) and stays loaded, untouched, until every migrated screen has
parity. New tokens are layered on top; the generated file is deleted last, never
first. Never edit `light-theme.css` by hand — regenerate it with
`npm run theme:light` if it must change at all.

---

## Phase 0 — Freeze the drift (no visual change)

1. Add a guard that fails on a **new** arbitrary colour in `src/app` and
   `src/components`, with an explicit allow-list for the board's `--sol-*`
   consumers and the three files that legitimately own colour
   (`globals.css`, `light-theme.css`, `solitaire-cosmetics.css`).
2. Capture the current state with the repo's own tooling
   (`qa/design-shots.mjs`, `qa/solitaire-theme-check.mjs`) for the screens in
   Phases 2–5, in both themes.
3. Write `docs/design/TOKENS.md`: every semantic token, its dark and light
   value, and its measured contrast pair.

**Done when:** the guard fails on a deliberately added hex value and passes on
the current tree; `npm run test:tokens` is still 23/23; no source file changed
except the guard and the docs.

**Delivered.** `scripts/check-design-tokens.mjs` + `qa/design-token-baseline.json`
(176 files, 3,433 hex literals at baseline). `npm run design:guard` passes and
its failure path is tested in a sandbox (`tests/design-token-guard.test.mjs`).
`docs/design/TOKENS.md` records every token with its measured contrast pair.
Captures: the repo's screenshot harnesses render lobbies and matches, not
`/settings`, and need a live auth context — deferred to Phase 2's shell work,
where the nav and page ground are captured once for every screen.

---

## Phase 1 — Semantic layer and the six primitives

**Scope.** Extend the existing `--gr-*` block in `src/app/globals.css` with
semantic aliases, define them for both themes, build the six primitives, and
convert exactly one screen end-to-end as the proving ground (`/settings`).

**Token set (names only — values live in `TOKENS.md`).**

```
--bg-page        --bg-surface     --bg-panel
--text-primary   --text-secondary --text-muted
--border-hairline --border-strong
--accent         --accent-fill    --on-accent
--state-win      --state-loss     --state-gold
--focus-ring     --shadow-raise   --radius-surface
```

**Not in Phase 1.** Navigation, home, `/play`, the board, the match page, the
result screen, the profile page, `/classement`. Those are Phases 2–6 and they
wait for the primitives.

**Done when:** the checklist in D3 passes for `/settings` in both themes, no
existing screen has changed visually, and `npm run typecheck` is clean.

**Delivered.** 24 role tokens appended to `globals.css` (aliases for grounds and
inks, authored values measured on all six grounds for the rest — no override in
`light-theme.css`, which stays generated and untouched). Six primitives in
`src/components/ui/` plus a 6-line `cx()`: `PageHeader`, `Surface`, `Button`,
`StatTile`, `Tabs`, `EmptyState`. `/settings` converted end-to-end: 0 hex
literals left, ten cards rebuilt on `Surface`, language and loss-limit controls
on `Tabs` (arrow-key navigable), CTAs on `Button`, the signed-out and
unanswered-questionnaire branches on `EmptyState`, current limit on `StatTile`.
`--text-muted` was corrected mid-phase: the first value measured 3.98:1 on the
light raised surface and was replaced with `#b6c9e2` (4.7:1 there). No other
screen was touched.

---

## Phase 2 — delivered

**One finding changed the plan.** `tests/play-hub.test.mjs` pins the navbar's
seven destinations twice — `/\["\/", "\/play", "\/learn", "\/classement", "\/contact", "\/games\/solitaire-duel", "\/upgrade-pro"\]/`
with `assert.equal(arrays.length, 2)`. The proposed trim to four links plus a
Play button would therefore have required editing a product-contract test, which
this programme forbids. All seven destinations were kept; the shell was fixed
around them instead.

- `--nav-height` (4rem), `--tabbar-height` (3.5rem) and `--shell-max` (90rem) in
  the semantic layer. The bar had encoded its height in four places and, from
  `sm` up, the content offset was 64px under a bar rendering 80–96px — pages
  masked the gap with their own `pt-24`. Bar, offset and the streak chip now
  read the same token.
- `navigation-bar.jsx`: 0 hex literals. Glow shadows replaced with the hairline
  + `--shadow-raise` language; active link is an accent underline rather than a
  yellow halo; sign-up is the accent fill with `--on-accent` ink.
- `Footer.tsx` and `SiteChrome.tsx`: 0 hex literals; footer ground was a fifth
  near-black (`#04060b`), now `--bg-page`.
- New `src/components/shell/MobileTabBar.tsx`: four destinations (Play, Ladder,
  Learn, You), 0 hex, `md:hidden`, safe-area padded, rendered by `SiteChrome`
  so the portal surface still has no chrome.
- One page ground: `/`, `/play`, `ModeLobby`, `/solitaire`, `/daily`,
  `/classement`, `/stats`, `/profil`, `/upgrade-pro` and `/settings` now paint
  `--bg-page` instead of `#05070d`/`#04060f`.
- Guard total fell 3,433 → 3,338 (four files now clean). No test was edited.

## Phase 3 — delivered

- **D1 landed.** Home no longer renders the six-card grid: `MODES`, `ModeArt`,
  the four mode photographs and the hover preview state are gone. Ranked keeps
  the hero CTA; three inline ways in (solo, vs AI, daily) plus one
  "All six ways to play →" link to `/play`. The solo and daily figures moved to
  the standing block instead of vanishing with the cards, so home still reads
  `/api/solitaire/solo` and `/api/solitaire/daily`.
- Home rebuilt on the primitives: `StatTile` for the four standing numbers,
  `Surface` for matches, ladder, solo/daily lines and the fairness cards,
  `Button` for every CTA, and the terms dialog on tokens. Home is 0 hex.
- `/play`: heading on `PageHeader`, card chrome on tokens (the six cards, their
  order, ids and hrefs are untouched — `tests/play-hub.test.mjs` passes).
- `/solitaire` and `/daily` frames on `PageHeader`; the daily summary is four
  `StatTile`s; the PRO-locked archive card and CTAs on tokens/`Button`.
- **One test was rewritten, deliberately.** `tests/solitaire-solo-daily.test.mjs`
  asserted the six-card `MODES` grid home used to render and demanded
  `/solitaire` + `/daily` as PRIMARY NAV links, which `tests/play-hub.test.mjs`
  forbids. The D1 decision supersedes that assertion, so the test now pins the
  new contract (three inline links, one `/play` link, no grid) and keeps its
  strength. This is the only test changed by the programme so far.
- **Pre-existing reds, unchanged and out of scope:** `hilltop-banner`,
  `rewards-quests-ui` and `shared-poll` were already failing
  on the untouched tree; they concern the casino hub, the four-page banner set,
  the quest widget on the hub, and a `useSharedPoll` call home no longer makes.
  They belong to Phases 6–7 and were not edited.

## Phase 4 — delivered

- **The result screen speaks once.** `PvpResultScreen` no longer opens with a
gradient banner, a glow and a stacked score comparison. The outcome is a chip;
the hero is one line (`You beat @name` / `Defeated by @name`); the number is
`result-primary-number` (Overall Elo, else the first `progress.to`); the one
filled primary action comes first. The score line, progression bars, opponent
strip, summary rows and the analysis link moved into a collapsed **Match
Details** disclosure — nothing was deleted, it is one tap away.
- `OUTCOME_STYLES` reduced to token classes only (`bar`, `chip`, `accentText`):
no `gradient`, no `glow`, no `borderTop`. The panel ground, chips and hairlines
are `--bg-surface`, `--bg-panel` and `--border-hairline`; one literal remains in
the file and it is not chrome.
- **The review surface is on the same language.**
`/solitaire/review/[kind]/[gameId]` painted its own `#05070d` page, `#070b12`
board card and `#f5ff3b` PRO allowance card; it now reads `--bg-page`,
`--bg-surface`, `--radius-surface`, `--shadow-raise`, `--border-warning` and
`--state-gold`. Layout, keyboard model and every `data-testid` are untouched:
32/32 in `tests/solitaire-review-ui.test.mjs`, and `review-entrypoints`,
`duel-ui-contract`, `share-win`, `overall-elo`, `vast-post-match` and
`solitaire-bot-result` stay green.
- Guard total fell 3,338 → 3,278 (six files now clean). No test was edited.
- **Three suites fail on `ENOENT`, not on this work:** `game-result-reveal-delay`,
`guest-post-match-cta` and `post-match-timeline` read casino files this
Solitaire-first branch no longer ships (`barrier-blitz/[matchId]`,
`tic-tac-toe/[matchId]`, `api/sudoku-duel/match/[matchId]/timeline`). They fail
the same way on the untouched tree and belong to the Phase 7 cleanup.

## Phase 5 — started

- **`UserStatsTabs` is on the token layer.** The five tabs keep their labels and
  `role="tablist"` semantics (the panel below swaps, so a segmented control
  would be the wrong primitive), and gain arrow / Home / End keyboard
  navigation with a roving `tabIndex`. Tiles are the shared `StatTile` with
  semantic tones (`win` / `loss` / `gold` / `accent`) instead of eight literal
  colours — the streak-gold that was invisible in light mode now reads
  `--state-gold` (7.0:1 on the light page). Rating rows and the Overall Elo
  card are `Surface` panels; the file is at **0 hex**.
- **`SolitaireModesPanel` is translated and tokenised.** It was the last block
  on an otherwise-translated profile still written in English for every player.
  Its 23 strings now live under `solitaireModes.*` in EN, FR and ES (69 values,
  each verified to resolve, with `{`/`}` interpolation untouched), and its four
  white-alpha cards became `Surface tone="panel"`. The two fetches, the dash
  for “not recorded” and the guest hint are unchanged. **0 hex.**
- **First extraction out of the page:** the four cosmetics pickers became
  `src/components/profil/ProfilePickerModals.jsx`. It is pure wiring — state,
  ownership and the equip handlers stay in the page, so the component cannot
  grant or bill anything. Page 2,790 → 2,773 lines.
- **The split is unblocked.** `tests/helpers/profile-source.mjs` exports
  `readProfileSource()` — the page plus every module extracted from it — and the
  suites that read the profile as text now use it: `profil-page-i18n`,
  `profile-load-fanout`, `leaderboard-rating`, `overall-elo`, `pro-stats`,
  `pro-benefits`, `friends-search`, `friend-challenge`, `private-rooms`,
  `shared-poll` and `guest-claim`. No assertion was weakened or deleted: the
  same regexes must still match, they simply no longer care which file holds the
  code. The reader discovers new modules automatically, so the next extraction
  needs no test edit at all.
- **Five sections are out of the page.** `src/components/profil/` now holds
  `ProfilePickerModals` (61 lines), `BetHistoryPanel` (111),
  `ProfileEmotesPanel` (40), `ProfileAccentPanel` (91) and
  `ProfileChatColorPanel` (115). Every one receives props from the page, which
  keeps the state, the fetches and the save handlers — so no module can grant,
  bill or equip anything on its own. Page **2,790 → 2,491 lines**.
- **Token migration on the page is done.** All 114 chrome literals — the seven
  repeated `#07101f/90` cards, the nine `#050b16` inputs, 24 ring offsets, 19
  focus rings, the `#FFD700` / `#f5ff3b` gold chrome, the four glow shadows and
  the `#0e7490 → #1e293b` button gradient — now read `--bg-surface`,
  `--bg-panel`, `--bg-page`, `--focus-ring`, `--state-gold`, `--on-accent`,
  `--border-hairline` and `--shadow-raise`. **7 literals remain**, all data or
  copy rather than chrome: the `#00e5ff` selection default, two “valid hex
  colour like #00e5ff” examples, and the `#f5c542` cosmetic-badge fallback. The
  ten-value chat palette moved to `src/lib/profileCosmetics.ts` beside
  `ACCENT_COLORS` — it is a player choice, not a role, and the guard scans only
  `src/app` and `src/components`.
- **Pre-existing reds observed while checking this phase, none of them ours:**
  `pro-benefits` (`ENOENT src/app/api/dice-flush/state/route.js`),
  `friends-search` (expects a purchase-history panel the token-currency removal
  already deleted), `leaderboard-rating` (`RATED_GAMES` is now under 10 after
  the casino cleanup, so its “≥10” and mirror-tab assertions fail),
  `guest-claim` (`mock.module` does not exist in this Node runtime), plus the
  three known ones (`hilltop-banner`, `shared-poll`, `rewards-quests-ui`).

## Phase 6 — delivered

- **Five surfaces, one language.** `/classement` (91 replacements), `/stats`,
  `/upgrade-pro`, `/learn` and `/settings` now paint `--bg-page` /
  `--bg-surface` / `--bg-panel`, read `--text-primary` / `--text-secondary` /
  `--text-muted`, `--accent` / `--accent-strong` / `--accent-fill` /
  `--on-accent`, `--state-gold` / `--state-win`, `--border-hairline`,
  `--focus-ring` and `--shadow-raise`. **All five are at 0 hex literals.**
- **The ladder's six glow halos are gone.** Podium, rank card, board, empty state
  and CTA used `rgba()` glows (cyan and gold); they now use `--shadow-raise`,
  the same hairline-plus-soft-shadow depth as the rest of the product.
- **No ranking behaviour changed.** `TABS` is still exactly
  `["trophies", "all-time", "daily-deal", "daily-current", "daily-best"]`,
  `RATED_GAMES_FALLBACK` still mirrors the rated registry, one ladder is still
  painted per view from the cache-first `useApiResource` read (the
  single-ladder first paint), and every tab still reads its own endpoint.
  `coin-leaderboards`, `internal-linking`, `ad-model`, `upgrade-pro-contract`,
  `learn-ui`, `learn-coaching`, `seo-metadata`, `pro-stats`, `overall-elo`,
  `play-hub` and `moderation-enforcement` stay green.
- **`/upgrade-pro` keeps its price-in-the-first-HTML contract.** Only class
  strings changed: the headline lost its `drop-shadow` glow, the three cards
  moved to hairline + surface, the trust box to `--bg-panel`.
- Guard total fell 3,271 → 2,981 (12 files now clean). `test:tokens` 23/23,
  `typecheck` clean. No test was edited in this phase.
- **Observed reds, unchanged and outside this phase:** `leaderboard-rating`
  (`RATED_GAMES` under 10 since the casino cleanup), `prod-perf-optimizations`
  (public lobby listings — a casino surface), `hilltop-banner`,
  `pro-benefits` (`ENOENT dice-flush/state`), `shared-poll`
  (`ENOENT casino/PageClient`), `guest-claim` (`mock.module`) and
  `friends-search` (purchase-history assertion for a panel that no longer
  exists).

## Phase 7 — in progress

- **The generated light theme was regenerated from the current tree.**
  `npm run theme:light` rebuilt `src/app/light-theme.css`: **1,061 → 657 lines**,
  35,845 → 21,602 bytes, **233 → 139** remap rules. 94 rules mapped utilities
  that no longer exist anywhere in `src/` — the decay of Phases 2–6 — and are
  gone. `test:tokens` 23/23 and `game-visual-tokens`, `light-theme-palette`,
  `ui-primitives` stay green, so generator and file are still in sync.
- **Deleting it is still gated — by measurement, not opinion.** 73 distinct
  utilities the file remaps are still present in `src/` (legacy game and casino
  screens using literals such as `bg-[#040d24]` and `bg-[#08142f]/90`). Removing
  the file today would drop the light-mode mapping for those utilities on the
  screens that still use them. Retirement order holds: migrate those literals
  first, regenerate, then delete the `@import` and the file.
- **Casino-era references are not dead.** `/casino` and `/casino/solitaire-duel`
  still exist as routes, and all 14 `/casino` references in `src/` point at live
  paths; `typecheck` is clean, so nothing imports a deleted module. No removal
  was warranted in this pass.
- **Bundle, measured:** `npm run build:solitaire-standalone` → 309.92 kB JS
  (95.95 kB gzip), 253.02 kB CSS (31.47 kB gzip), 54 modules, 2.88 s. That build
  does not include the app's `globals.css` / `light-theme.css`, so the
  regeneration shows **no** delta there — no bundle claim is made.
- **a11y was not executed.** `npm run verify:a11y` drives puppeteer-core against
  a running server (`http://localhost:3000`); no server was started in this pass,
  so the axe scan is an open item, not a pass.
- **Still red, unchanged:** `leaderboard-rating` (`RATED_GAMES` under 10 after the
  casino cleanup), `prod-perf-optimizations` (public lobby listings),
  `hilltop-banner`, `pro-benefits` (`ENOENT dice-flush/state`), `shared-poll`
  (`ENOENT casino/PageClient`), `guest-claim` (`mock.module`) and
  `friends-search` (purchase-history assertion for a removed panel).

## Phase map (unchanged except D1)

| Phase | Scope |
|-------|-------|
| 2 | Shell: slimmer top bar, mobile bottom tabs, footer, one page ground — **done** |
| 3 | Solitaire funnel: home (per D1), `/play`, `/play/ranked` shell, `/solitaire` + `/daily` frame — **done** |
| 4 | Match end and review: result screen reduced to one number, one line, one action — **done** |
| 5 | Profile: split the 2,790-line page, translate `SolitaireModesPanel`, rebuild `UserStatsTabs` on tokens — **done: page 2,491 lines, five modules extracted** |
| 6 | `/classement` single-ladder first paint, `/stats`, `/learn`, `/upgrade-pro`, `/settings` — **done: all five at 0 hex** |
| 7 | Casino-era cleanup, generated light-theme retirement, a11y and bundle pass — **in progress: theme regenerated; deletion gated** |

---

## Protected — never touched by this programme

Authentication, matchmaking, Elo and trophy maths, game rules, the database and
its migrations, ad gating, payment flows, and every server route's contract. The
board component is frozen: it already reads its own `--sol-*` tokens and is the
best-engineered UI in the repo. It gets wired to the new tokens, never redrawn.

## Open items deferred to the phase that owns them

- Does `/play` keep six equal-weight cards, or promote Ranked to a full-width
  hero card and demote the rest to a 2×2? (Phase 3.)- ~~Is the desktop navigation a rail or a slimmer top bar?~~ **Decided (Phase 2):
  slimmer top bar, not a rail.** The bar is mounted per page (the lobby renders
  it) and orbited by fixed widgets, so a rail would have to re-tune every
  fixed-position element and still mount per page. The measured problem was
  density (seven links + six controls ≈1390px), not orientation; `--nav-height`
  plus a 64px bar solved the height drift the audit found.
- How many of the 203 glow utilities survive as deliberate brand moments?
  (Phase 7, with a count, not an opinion.)
