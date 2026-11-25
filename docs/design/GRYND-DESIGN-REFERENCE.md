# GRYND — Design Reference & Redesign Foundation

| | |
|---|---|
| **Status** | Research complete. No UI, CSS, component, gameplay or database change has been made. |
| **Branch** | `solitaire-first` |
| **Date** | 2026-11-17 |
| **Scope** | Design audit, light-mode investigation, visual direction, colour system, component references, installed design skills, redesign roadmap |
| **Out of scope** | Any page redesign, `globals.css` / `light-theme.css` / theme generator / Tailwind config edits, component edits, dependency or version changes, auth/gameplay/DB changes |

This document is the input to a future redesign. It is deliberately opinionated: a redesign that does not
choose a direction will reproduce the current mix of styles. Every claim below is either measured from the
repository or cited to a source inspected during this research.

---

## 0. What GRYND is now

GRYND is a **competitive Solitaire platform** — "the competitive home of Solitaire" — not the old multi-game
casino product that the codebase and some files still imply.

Current product surface (confirmed on the live site and in the repository):

| Area | What exists today |
|---|---|
| Competitive | Ranked Klondike duel (PvP), Elo rating, server-verified results |
| Progression | Trophies, levels, streaks, rank ladder, player titles |
| Solo | Solo Klondike with timer, undo, personal bests |
| Daily | One deterministic daily deal, daily + unlimited puzzles |
| Practice | Unrated games vs. AI at selectable difficulty |
| Learning | GRYND Academy: lessons, courses, video guide, coaching, practice |
| Social | Leaderboards, profiles, statistics, match history, reviews |
| Monetisation | GRYND PRO (three billing intervals, Stripe), cosmetics, rewards |

The **information architecture is already correct** for the new product: `/play`, `/learn`, `/classement`,
`/profil`, `/stats`, `/daily`, `/solitaire`, `/upgrade-pro`, `/settings`. The visual layer is what has not
caught up. This distinction matters for the roadmap: the redesign is mostly a **presentation and system
problem**, not a navigation re-architecture.

### 0.1 Architecture map (relevant parts)

```
src/app/
  layout.tsx            root HTML shell, theme bootstrap, metadata
  globals.css           4,619 lines: utilities, keyframes, legacy casino CSS, game visual tokens
  light-theme.css       generated (1,061 lines) — remaps dark utilities for light mode
  providers.tsx         Clerk + Theme + Language + SWR + Socket providers
  PageClient.jsx        homepage (936 lines)

src/components/
  navigation-bar.jsx    fixed top bar, 7 primary links + account menu + mobile drawer
  SiteChrome.tsx        one pathname gate: site chrome vs. bare portal game surface
  ThemeToggle.tsx       theme switch
  uipro/index.jsx       21 trivial wrapper components (NavShell, HeroShell, CardGrid…) with no styles
  home/                 HeroCard3D, HomeExplainer, SocialProof
  learn/                Academy landing, courses, lessons, video, coaching
  solitaire/            BoardAppearanceDrawer
  solitaire-duel/       board, opponent seats, tutorials, theme picker
  stats/                PerformanceDashboard, StatTile, LineChart, ProAnalyticsLocked

src/context/
  ThemeContext.js       data-theme + .dark class + color-scheme + meta theme-color
  LanguageContext.jsx
```

### 0.2 How the theme works today

1. `ThemeContext.js` writes `data-theme="light|dark"`, toggles the `.dark` class, sets `color-scheme`, and
   updates `<meta name="theme-color">`.
2. A bootstrap script at the top of `<body>` in `layout.tsx` sets the same state before first paint.
3. Dark mode is the authored design: literal utility colours (`bg-[#040d24]`, `text-white`,
   `border-[#00e5ff]/40`) with no `dark:` variants in use.
4. Light mode is **generated** by `scripts/generate-light-theme.mjs`: it scans `src/` for colour utilities,
   maps each near-black ground through a luminance/hue classifier into one of six hue families × three
   elevation roles, and emits `html[data-theme="light"] .<utility>` rules with `!important`.

---

## 1. Current design audit

### 1.1 Measured state

Scanned 827 source files under `src/`:

| Metric | Value | Why it matters |
|---|---:|---|
| Arbitrary hex colour utilities | **3,274 uses** | Colour is authored at call sites, not in a system |
| Distinct hex values | **281** | No single palette can be inferred or enforced |
| `bg-[#…]` utilities | **797** | Every surface is a hard-coded decision |
| `text-white` utilities | **836** | No semantic text hierarchy |
| Neon glow shadow utilities (`shadow-[0_0…rgba(…)`) | **203** | Glow is used as a default, not an accent |
| Generated light rules | **226** | A second, parallel styling system to maintain |
| `!important` declarations in light theme | **290** | Overrides are winning by force, not by design |
| Distinct `rounded-*` utilities | **18** | Including `[2px]`, `[3px]`, `[4px]`, `[6px]` one-offs |
| Shared token block | 1 (`--gr-*`, game surfaces only) | The only authored token set, scoped to boards |

Most colour-dense files (a proxy for design debt):

```
admin/operations     110 arbitrary hex
profil/PageClient     106
learn/LessonPlayer    103
classement/PageClient  92
settings/PageClient    90
navigation-bar         78
welcome/PageClient     74
game-landing           67
```

### 1.2 What already works (keep it)

These are real assets and the redesign should preserve them:

- **A coherent dark identity.** The navy ground + cyan + yellow is recognisable and reads as competitive,
  not generic. The `--gr-*` game token block is well documented, contrast-checked, and tested by
  `tests/game-visual-tokens.test.mjs`. It is the seed of a proper system.
- **Single theme choke point.** `applyTheme()` and the pre-paint bootstrap mean no theme flash. That is
  better than most apps.
- **A11y groundwork.** Skip link, `safe-area` insets, reduced-motion handling, focus-ring tokens in games,
  and an existing axe script (`verify:a11y`).
- **Real product data.** The homepage already fetches real rating, trophies, solo summary, daily summary,
  recent matches and leaderboard rows. The redesign can show truth instead of placeholder stats.
- **A solitaire-first nav** has already been rewritten (Play / Learn / Leaderboard / Rules / PRO / Account).

### 1.3 Weaknesses, prioritised

**P1 — The visual language still reads "casino", not "competitive sport".**
Evidence in the repository, not a matter of taste:

- `globals.css` keeps `.animated-bg` (a 30s animated 4-colour gradient), `.glow-pulse`, `.animate-neonPulse`,
  `.cyberpunk-grid`, `.gradient-hover`, `.shimmer-heading`, `.animated-button`, `.commencer-hover`,
  `.decouvrir-hover`. These are the visual vocabulary of a betting product.
- A global element selector repaints **every** blue button to neon yellow with `!important`:

  ```css
  button[class*="bg-blue-"]:not(:disabled), … {
    background-color: #f5ff3b !important;
    color: #031026 !important;
    box-shadow: 0 0 14px rgba(245, 255, 59, 0.35);
  }
  ```

  This outranks component classes by selector shape, so no page can express its own hierarchy. It is the
  single most damaging rule in the stylesheet.
- 203 glow utilities mean emphasis is ambient. When everything glows, nothing is emphasised.

**P1 — There is no semantic design system.**
281 hexes and 836 `text-white` uses mean a card, a panel and a page do not share a vocabulary. Elevation,
border strength, muted text and accent are re-decided per component. This is why screens feel "assembled"
even when each one is individually decent.

**P2 — Typography is under-specified.**
`Orbitron` is loaded for display use; body text falls back to Tailwind's default sans stack. Orbitron is a
techno/arcade face: used broadly (current display headings, `logo-text`) it actively signals casino/cyber,
which fights the premium-sport direction. There is no documented type scale, no tabular-numeral rule for
ratings/clock/times, and headings range from `text-3xl font-black` to 11px tracked caps without a system.

**P2 — Navigation carries legacy weight.**
`navigation-bar.jsx` has 7 primary links, an account `<details>` menu, a trophy/coin chip, avatar + title +
streak lines, install button, theme toggle, sign-out, and a mobile drawer. Its height changes at three
breakpoints (`h-16` → `sm:h-20` → `md:h-24`), so page offsets change with viewport. The nav is doing the
job of a nav + a HUD + a profile card. Chess.com splits these concerns (top bar vs. persistent left rail).

**P2 — Homepage hierarchy is flat.**
The mode grid gives Ranked, Solo, vs AI, Daily, Daily Puzzle and Unlimited Puzzles equal visual weight.
Ranked — the product's reason to exist — does not read as the primary action. Users must read six cards to
find the one that matters.

**P2 — Product framing leaks legacy multi-game content.**
`classement/PageClient.jsx` still carries a 24-game `RATED_GAMES_FALLBACK` (Chess, Pool, Keno Duel, Neon
Flush…) even though the product is Solitaire-first. The fallback is filtered by availability, but it keeps
dead product concepts in the UI's source of truth and can resurface stale tabs.

**P2 — Theme strategy is a second styling system.**
See §2. The existence of 226 generated override rules with 290 `!important`s is itself the problem: it
means the primary styling layer cannot be themed, only counter-patched.

**P3 — Component duplication instead of primitives.**
`uipro/index.jsx` defines 21 components that render a plain `<div>`/`<a>`/`<button>` and forward
`className`. They add names but no behaviour, no variants, no accessibility, no states. Meanwhile the real
button styles are inline utility strings repeated across pages. A redesign needs ~12 genuine primitives.

**P3 — Detail inconsistency.**
18 radius utilities, one-offs like `rounded-[3px]` and `[6px]`; mixed icon families available (Tabler is
installed, but Lucide is the shadcn default); emoji used as icons (`🔥` in `RecordLine`); cards with
simultaneous border + ring + glow + gradient.

### 1.4 What is genuinely missing for a premium feel

Premium interfaces are not made by adding effects. They are made by **consistent restraint**:

1. One accent used for one meaning (action), not for decoration everywhere.
2. A neutral ramp with enough steps to express page → surface → raised → overlay.
3. A type scale that is actually followed, with tight tracking only at display sizes.
4. Spacing on a single 4/8px rhythm, so unrelated cards line up by accident.
5. Elevation expressed by surface + hairline in light mode, by surface + subtle shadow in dark — not by glow.
6. Motion that confirms an action and lasts 120–240ms, plus one orchestrated page entrance at most.

---

## 2. Light theme audit

### 2.1 What the current light theme actually is

It is **not a light theme**. The generator's palette is:

```js
PAGE  = "#24417f";  // page ground
CARD  = "#31508f";  // raised surface
PANEL = "#1b3266";  // recessed surface
```

The generator's own comment states the rule explicitly: *"light mode moves ONLY the near-black grounds.
Everything else — text, hairlines, shadows, neon accents — is exactly what the dark theme authored, because
the ground it sits on is still dark."*

So light mode is a **saturated mid-blue re-tint of dark mode**: white text, neon cyan and yellow accents,
and near-black shadows, on a navy ground that is merely lighter. Measured:

| Pair | Ratio | Verdict |
|---|---:|---|
| `#FFFFFF` on page `#24417F` | 9.82:1 | Legible, but still white-on-dark |
| `#FFFFFF` on card `#31508F` | 7.85:1 | Legible |
| `#9DD8FF` on card `#31508F` | 5.12:1 | Legible |
| `#00E5FF` on page `#24417F` | 6.39:1 | Legible |

Contrast is not the failure. **Identity is.** The user's instinct is correct: it feels like a filter over
dark mode because that is literally what it is.

### 2.2 Why it cannot be polished into a good light mode

1. **It has no light palette.** There is no near-white ground, no dark ink, no light-mode border ramp. A
   light theme's hierarchy comes from *white surfaces on a tinted page with dark hairlines*. None of that
   exists here.
2. **It is derived from the dark theme, not authored.** The classifier maps any low-luminance background by
   hue family into 6 family targets × 3 roles. Two semantically different surfaces with similar luminance
   collapse into one colour; a decorative tint is promoted to a "ground". The mapping cannot know intent.
3. **It themes utilities, not semantics.** 226 rules exist only for tokens the regex found in `src/`.
   Colour set in CSS files, inline `style`, canvas, images, runtime cosmetic props (`nameGlow`, equipped
   frames), and third-party widgets is untouched. Theme holes are structural, not bugs.
4. **`!important` ends the cascade.** 290 forced declarations mean component states cannot win. Hover and
   focus variants are re-emitted as separate rules to compensate, which multiplies the surface area for
   conflicts.
5. **Effects were designed for near-black.** Shadows at 45–55% black and cyan glows over a mid-blue ground
   read as haze. The dark theme's depth cues do not translate.
6. **Regeneration is a hidden build step.** A new literal hex gets no light mapping until someone runs
   `npm run theme:light`. Nothing prevents a developer from adding a raw colour that silently breaks in
   light mode.
7. **The ground colour is duplicated three times** — `PAGE` in the generator, `META_COLOR.light` in
   `ThemeContext.js`, and `THEME_LIGHT_GROUND` in `layout.tsx`. They must move together or the mobile
   address bar bands against the page.

### 2.3 Recommendation: author light mode as a first-class theme

Do **not** extend the remap. Replace the strategy in stages:

- **Primitives + semantic tokens.** Components reference `--bg-page`, `--bg-surface`, `--text-primary`,
  `--border-default`, `--accent`, etc. Only the semantic layer is re-pointed per theme.
- **No utility remapping, no `!important`.** The theme is a token redefinition, not a selector war.
- **One source of truth.** Define the palette once (CSS custom properties in `globals.css`, optionally
  generated from a single JSON/TS source), and have `ThemeContext`/`layout.tsx` import the light page colour
  from that same module — no third literal.
- **Light mode gets its own depth language.** Surfaces are white/near-white; separation comes from a
  hairline plus a very soft shadow (`0 1px 2px rgba(16,24,40,.06)`), not from glow.
- **Keep the cyan identity, shift its role.** On white, `#00E5FF` is unusable as text (≈1.6:1). Light mode
  uses a deeper cyan for ink/interaction (`#0E7490`, 5.36:1) and reserves bright cyan for fills/brand marks.
- **Migrate incrementally, page by page, with the generator alive** until parity is reached. Then delete
  `light-theme.css` and `generate-light-theme.mjs` in one deliberate change. Do not delete them first.

A migration is measurable: `grep -c '\[#'` per file should trend to zero; the light stylesheet's rule count
should trend to zero.

---

## 3. Design direction

### 3.1 Positioning

> **GRYND is the competitive home of Solitaire: a serious, calm, premium sport surface where the game and
> your rating are the loudest things on screen.**

Chess.com is the correct structural model — not its branding. What to take: a persistent game-oriented
navigation rail, a dashboard that answers "what should I do next", rating and progress presented as
first-class data, learning integrated as a product pillar, and a profile that reads like an athlete card.
What **not** to take: its density, its ad clutter, its 2005-era table styling, or any colour/logo language.

### 3.2 Five principles

1. **The board is the hero.** Marketing chrome recedes; on gameplay routes, the table and the HUD are the
   only high-contrast objects.
2. **Competitive clarity.** Rating, rank, trophies, streak and time are always in the same place, in tabular
   numerals, with one definition each. No two surfaces may disagree (the app already enforces this for
   trophies — keep that discipline visually).
3. **Earned premium, not casino.** Depth from surface and hairline; accent from action and win states.
   No ambient pulse, no gold gradients on non-reward UI, no animated page backgrounds.
4. **One accent, one job.** Cyan = primary action and "you". Yellow = ranked/your-turn/selection. Magenta =
   opponent. Gold = trophies/rewards only. Green/red = outcome only.
5. **Calm at rest, crisp on action.** Static screens do not move. Interaction feedback is 120–200ms and
   communicates state change.

### 3.3 Anti-patterns to remove (with owners)

| Anti-pattern | Where | Replace with |
|---|---|---|
| Global `!important` button recolour | `globals.css` | Token-driven `Button` variants |
| Animated multi-colour page gradient | `.animated-bg` | Flat page ground + one optional static radial |
| Ambient glow / neon pulse | `.glow-pulse`, `.animate-neonPulse`, 203 glow utilities | Shadow only on elevated surfaces; glow only for live/win |
| Cyber grid overlay | `.cyberpunk-grid` | Removed |
| Shimmering text | `.shimmer-heading`, `.animate-shimmer-elegant` | Static metallic/gold text or plain ink |
| 18 radii | throughout | 4 radii: `sm 6`, `md 10`, `lg 14`, `full` |
| Emoji as icons | `RecordLine` (`🔥`) | Tabler icon + text |
| `<details>` as account menu | `navigation-bar.jsx` | Accessible popover/menu primitive |
| Three nav heights | `h-16 / sm:h-20 / md:h-24` | One height per breakpoint, documented |

### 3.4 Typography

Current: Orbitron (display) + system sans (body). Recommendation:

- **UI text:** one neutral grotesque with good numerals — Inter (already referenced in some static HTML) or
  Geist. Use it for everything except the wordmark and hero display.
- **Display:** a tighter, more editorial grotesque (e.g. Archivo / Instrument Sans / Space Grotesk) **or**
  keep Orbitron **only** for the GRYND wordmark. Orbitron is a brand asset, not a UI typeface: at 32–56px it
  reads arcade; at 14px nav labels it reads toy-like.
- **Numerals:** `font-variant-numeric: tabular-nums` on rating, trophies, clock, timers, leaderboard columns
  and stats. This is non-negotiable for a competitive product.
- **Scale** (rem, desktop → mobile): 56/48 → 40/36 → 32/28 → 24/22 → 20/18 → 16 → 14 → 12. Line-height
  1.05–1.15 display, 1.5 body, 1.35 UI labels.
- **Tracking:** `-0.02em` at ≥32px, `0` at body, `+0.06em` only for genuine small-caps labels — and use
  sentence case for labels, not ALL CAPS everywhere.
- **Weights:** 2 (regular, medium) for UI, 3 (+ semibold/bold) for display. Stop using `font-black` as the
  default emphasis.

### 3.5 Spacing, radius, elevation

- **Spacing:** 4px base; allowed steps 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. No `p-[13px]`.
- **Radius:** `--radius-sm 6px` (inputs, chips), `--radius-md 10px` (buttons, small cards),
  `--radius-lg 14px` (cards, dialogs), `--radius-xl 20px` (hero panels), `full` (avatars, pills).
  Board cell radius stays a game token (`--gr-cell-radius`).
- **Elevation:**
  - Dark: `0 1px 0 rgba(255,255,255,.04) inset` + `0 8px 24px rgba(3,8,23,.45)` for raised; panels get a
    hairline border, not a glow.
  - Light: `0 1px 2px rgba(16,24,40,.06)` + `0 8px 24px rgba(16,24,40,.06)`; border `#DDE3EC`.
- **Container:** 1440px max; 12-column grid; 24px gutter desktop, 16px mobile; content max 1200px for
  reading surfaces (learn articles) with 72ch line length.

### 3.6 Information architecture (Chess.com-informed, not copied)

Desktop:

```
┌──────────────────────────────────────────────────────────────┐
│ Top bar: wordmark · search · rating/trophies · theme · avatar│
├────────────┬─────────────────────────────────┬───────────────┤
│ Left rail  │ Main content                     │ Right rail    │
│ Play       │ (dashboard / page)               │ Next action   │
│ Learn      │                                  │ Daily deal    │
│ Compete    │                                  │ Friends/online│
│ Profile    │                                  │               │
│ PRO        │                                  │               │
└────────────┴─────────────────────────────────┴───────────────┘
```

Mobile: top bar + bottom tab bar (Play · Learn · Compete · Profile). The current drawer can remain as the
overflow menu, but the four primary destinations should not require opening a drawer.

This is an IA *proposal*; implementation is Phase 2 in the roadmap and requires its own approval.

---

## 4. Recommended colour system

### 4.1 Token architecture

Three layers, one direction of dependency:

```
primitive (never used in components)
  --cyan-400: #00e5ff;  --navy-950: #030817; …
        ↓
semantic (the only thing components reference)
  --bg-page, --bg-surface, --bg-raised, --bg-sunken
  --text-primary, --text-secondary, --text-tertiary, --text-disabled
  --border-subtle, --border-default, --border-strong
  --accent, --accent-hover, --accent-pressed, --accent-soft, --on-accent
  --signal-success / --warning / --error / --info
  --rank-gold, --opponent, --focus-ring
        ↓
component (optional aliases)
  --button-primary-bg: var(--accent); …
```

Rules:

- `[data-theme="light"]` redefines **semantic tokens only**.
- No `!important`, no element selectors, no `[class*="..."]` selectors.
- Every colour used by a component must resolve to a semantic token; a raw hex in a component is a lint
  error once the system lands.
- Colour tokens that need opacity get an `-rgb` triplet, matching the existing `--gr-*` convention.

### 4.2 Dark theme tokens (preserves current identity)

| Token | Value | Notes |
|---|---|---|
| `--bg-page` | `#030817` | existing page ground |
| `--bg-surface` | `#040D24` | cards |
| `--bg-raised` | `#071733` | hovered/selected cards, popovers |
| `--bg-sunken` | `#001933` | wells, board sockets |
| `--bg-overlay` | `rgba(3,8,23,.72)` | modal scrim |
| `--text-primary` | `#FFFFFF` | 19.98:1 on page |
| `--text-secondary` | `rgba(255,255,255,.72)` | ~9:1 on page |
| `--text-tertiary` | `rgba(255,255,255,.52)` | metadata |
| `--text-disabled` | `rgba(255,255,255,.38)` | |
| `--border-subtle` | `rgba(255,255,255,.08)` | dividers |
| `--border-default` | `rgba(255,255,255,.14)` | card edges |
| `--border-strong` | `rgba(255,255,255,.24)` | inputs, focus affordance |
| `--accent` | `#00E5FF` | 12.99:1 on page |
| `--accent-hover` | `#5CEFFF` | |
| `--accent-pressed` | `#00BCD4` | |
| `--accent-soft` | `rgba(0,229,255,.12)` | selected nav, chips |
| `--on-accent` | `#04121C` | 17.37:1 on yellow, 12.6:1 on cyan |
| `--rank-gold` | `#F5FF3B` | ranked / your turn (17.69:1 on raised) |
| `--rank-gold-ink` | `#A16207` | only on light grounds |
| `--opponent` | `#FF4FD8` | 6.77:1 on raised |
| `--signal-success` | `#34D399` | |
| `--signal-warning` | `#FBBF24` | |
| `--signal-error` | `#F87171` | |
| `--signal-info` | `#7DD3FC` | |
| `--focus-ring` | `#9DD8FF` | 12.59:1 on dark |

### 4.3 Light theme tokens (new, authored)

A neutral, slightly cool page with white surfaces — the opposite strategy from today's navy re-tint.

| Token | Value | Contrast |
|---|---|---|
| `--bg-page` | `#F6F7F9` | page ground |
| `--bg-surface` | `#FFFFFF` | cards |
| `--bg-raised` | `#FFFFFF` | + hairline + shadow |
| `--bg-sunken` | `#EDF0F5` | wells, table header |
| `--bg-overlay` | `rgba(11,18,32,.40)` | modal scrim |
| `--text-primary` | `#0B1220` | 17.47:1 on page · 18.72:1 on white |
| `--text-secondary` | `#475569` | 7.58:1 on white |
| `--text-tertiary` | `#64748B` | 4.76:1 on white · **4.44:1 on page → on the page ground use secondary, or a darker step** |
| `--text-disabled` | `#94A3B8` | non-text use only |
| `--border-subtle` | `#E8ECF2` | dividers |
| `--border-default` | `#DDE3EC` | card edges |
| `--border-strong` | `#C7D0DD` | inputs |
| `--accent` | `#0E7490` | 5.36:1 on white — text/interactive cyan |
| `--accent-fill` | `#0891B2` | 3.68:1 — fills, icons ≥24px, focus ring |
| `--accent-soft` | `#E6F6F9` | chips, selected nav |
| `--on-accent` | `#04222B` | 5.46:1 on `#00A3B8` |
| `--brand-cyan` | `#00A3B8` | 3.03:1 — large marks only, never body text |
| `--rank-gold` | `#A16207` | 4.92:1 on white (text) |
| `--rank-gold-fill` | `#FDE68A` | with `#78350F` ink |
| `--opponent` | `#BE185D` | text-safe magenta |
| `--signal-success` | `#15803D` | 5.02:1 |
| `--signal-warning` | `#B45309` | 5.02:1 |
| `--signal-error` | `#B91C1C` | 6.47:1 |
| `--signal-info` | `#0369A1` | |
| `--focus-ring` | `#0891B2` | 3.43:1 on page (non-text 3:1 requirement) |

Why these values:

- `#0E7490` keeps GRYND's cyan hue (~189°) but at a lightness that clears AA on white. The bright brand
  cyan is retained for the logo, large numbers and fills, so the identity survives without failing contrast.
- The page is `#F6F7F9`, not pure white, so white cards have somewhere to sit. This is what makes light mode
  read as designed rather than "dark mode with white cards".
- Gold is split into a **text** value and a **fill** value. This is the mistake the dark palette avoids and
  light palettes usually make: one gold cannot serve both roles on white.
- Borders are deliberately low-contrast (1.23–1.48:1). That is correct for decoration; interactive control
  boundaries must use `--border-strong` or a shadow so they remain perceivable.

### 4.4 Interactive states (both themes)

| State | Dark | Light |
|---|---|---|
| Hover (surface) | `--bg-raised` | `#F8FAFC` |
| Hover (accent) | `--accent-hover` | `#0B6478` |
| Active/pressed | `--accent-pressed`, `scale(.99)` | `#095365` |
| Selected | `--accent-soft` + 1px `--accent` | `--accent-soft` + 1px `--accent` |
| Focus-visible | 2px `--focus-ring`, 2px offset | 2px `--focus-ring`, 2px offset |
| Disabled | 38% ink, `rgba(255,255,255,.06)` fill | 38% ink, `#F1F5F9` fill |
| Destructive | `--signal-error` text on `rgba(248,113,113,.12)` | `#DC2626` on `#FEF2F2` |

### 4.5 Rules of use

1. Never use `--accent` for decoration. If it is not clickable, current, or "you", it is not cyan.
2. Yellow/gold is **ranked, selection, or reward**. Never a general CTA.
3. Green/red only for outcome and validation, never for identity.
4. Maximum two accent families visible in one viewport.
5. A card is `--bg-surface` + `--border-default` + one shadow. Not a border **and** a ring **and** a glow.
6. Text on an accent fill always uses `--on-accent`; never `text-white` by habit.

---

## 5. Component recommendations

These are **references**, not installed dependencies. Nothing here has been added to `package.json`.
Adopt one primitive at a time, starting with `Button`, `Card`, `Badge`, `Tabs`, `Input`, `Dialog`, `Table`.

### 5.1 Library assessment

| Library | Licence | React/Next | Tailwind v4 | Light + dark | Verdict for GRYND |
|---|---|---|---|---|---|
| **shadcn/ui** | MIT | Yes (React 19 / Next 16 OK) | Yes (CSS vars; also Base UI / React Aria / Radix variants) | Yes, token-driven | **Primary reference + selective adoption.** Best fit for Card, Dialog, Tabs, Table, Tooltip, Empty, Field, Sidebar |
| **Origin UI** (now **coss.com/ui**) | MIT | Yes | Yes | Yes | **Reference for forms/settings/onboarding.** Repo was acquired; legacy Origin components remain in `apps/origin`, active work is Base UI. Do not treat old snippets as current API |
| **Magic UI** | MIT | Yes | Yes | Mostly theme-aware | **Limited.** Good for 4–5 marketing moments (NumberTicker, BorderBeam, Marquee). Not for dashboards or gameplay |
| **React Bits** | MIT **+ Commons Clause** | Yes | Yes | Partial; many effects are dark/decorative | **Very limited.** Free to use in a product; may not resell/redistribute the components. Avoid shader backgrounds (bundle + mobile cost) |
| **Shadcn Dashboard** (towerneon) | MIT | React 19 + Vite; separate Next version | Yes | Yes (`ThemeProvider`) | **Reference only** for dashboard shell, stat cards, data tables |
| **Shadcn UI Blocks** (shadcnblockscom) | No root LICENSE found | n/a | n/a | n/a | **Not a component package** — the README is a curated directory. Reject as dependency; use as discovery index |
| **Awesome Shadcn UI** (bytefer) | MIT | n/a | n/a | n/a | **Reference list only** |
| **Shadboard** | MIT | Next 15 / React 19 | Yes | Yes (theme customizer) | **Reference** for settings, profile, pricing/billing layouts |
| **Design Resources for Developers** | MIT | n/a | n/a | n/a | **Reference list only** (fonts, colour tools, icons) |
| **@shadcn/lint** | (see repo) | Framework-agnostic | **Yes (works without shadcn)** | n/a | **Highest-value future adoption.** Agent-first linter that can ban arbitrary values and enforce token/component contracts. Not installed now (would add a dependency) |

### 5.2 Dependency / compatibility notes

- The project has **no `components.json`, no `src/components/ui/`, and no `cn()` helper**, so shadcn is not
  drop-in. Setup is a deliberate phase, not a copy-paste.
- shadcn's default icon set is **Lucide**; GRYND uses **`@tabler/icons-react`**. Keep Tabler. Do not add a
  second icon family — it is one of the fastest ways to make a redesign look assembled.
- Tailwind v4 here is configured through `@config "../../tailwind.config.js"` plus `@custom-variant dark`.
  shadcn v4 examples assume CSS-first `@theme inline` and a `.dark` class. GRYND themes on
  `[data-theme]`, so any adopted component must resolve tokens from GRYND's semantic vars, not shadcn's
  default `--background`/`--foreground` pair.
- `framer-motion@12` is already installed, so Magic UI-style motion does not add a dependency — but check
  whether a component imports the newer `motion` package before copying it.
- No `next-themes`; GRYND's theme system is custom. Do not introduce a second theme provider.
- `recharts` is **not** installed. shadcn Chart depends on it; the existing `LineChart.tsx` is custom.
  Adding recharts is a dependency decision, not a styling one.

### 5.3 Per-surface recommendations

**Homepage**
- Structure: one primary Ranked CTA + "your next action" + a compact leaderboard preview + a daily-deal card.
  Secondary modes become a compact row, not six equal cards.
- Components: shadcn `Card`, `Button`, `Badge`, `Tabs`/`SegmentedControl` (Origin/coss) for mode switching.
- Motion: one entrance sequence; no per-card hover lift on all six cards.
- Do not use Magic UI backgrounds here.

**Navigation**
- Desktop: persistent left rail (Play / Learn / Compete / Profile / PRO) + slim top bar (wordmark, rating,
  trophies, theme, avatar). Mobile: bottom tab bar + overflow sheet.
- Components: shadcn `Sidebar`, `NavigationMenu`, `DropdownMenu`, `Sheet`, `Avatar`, `Tooltip`.
- One nav height per breakpoint. Move streak/title cosmetics out of the nav into the profile chip.

**Ranked dashboard (/play, /stats)**
- Structure: identity row (rating, rank, W/L, streak) → rating trend → next match CTA → recent form.
- Components: `Card`, `Tabs`, `Progress`, `Table`, `Chart`; Origin `Meter` for progress, `SegmentedControl`
  for time ranges.
- Tabular numerals everywhere; no glow on charts.

**Leaderboards (/classement)**
- Sticky header, rank medallion (1–3 only), own row highlighted, pagination, filter as segmented control.
- Components: `Table`, `Pagination`, `Avatar`, `Badge`, `Tabs`.
- Fix the 24-game fallback: one Solitaire board + the daily/streak boards actually offered.

**Player profiles (/profil/[clerkId])**
- Athlete-card header: avatar + frame, name + title, level, rank, join date; then rating cards, recent form,
  match history, achievements.
- Components: `Card`, `Tabs`, `Table`, `Tooltip`, `Avatar`, `Badge`.
- Cosmetics (frames, glows) must be constrained to the avatar/name area so they cannot break hierarchy.

**Statistics (/stats)**
- KPI row → trend chart → breakdown table → PRO-locked analytics. Make the locked state informative, not a
  blurred tease.
- Components: `Card`, `Tabs`, `ToggleGroup`, `Table`, `Progress`.

**Learning (/learn, /learn/courses, /learn/[lessonId])**
- Academy landing: continue-learning card, course grid, level filter. Lesson player: step rail, board,
  instruction panel, hint/retry controls.
- Components: `Card`, `Progress`, `Accordion`, `Tabs`, `Kbd` (keyboard hints), `Empty`.
- Keep the lesson board geometry and interaction unchanged.

**Tutorials**
- Checklist + numbered steps (only where content really is a sequence), persistent progress, "why this
  move" callouts. Avoid decorative numbered markers on non-sequential content.

**Subscription (/upgrade-pro)**
- One plan, three intervals as a segmented control, a benefit table, a single primary CTA, trust cues
  (secure checkout, cancel anytime), current-plan state for members.
- Components: `Card`, `RadioGroup`/`SegmentedControl`, `Badge`, `Table`; Shadboard pricing page as a layout
  reference.

**Settings (/settings)**
- Grouped sections (Account, Appearance, Notifications, Privacy, Billing), each with a short description and
  a save model that is obvious (auto-save vs. explicit).
- Components: Origin/coss `Field`, `Fieldset`, `Switch`, `Select`, `Input`, `Separator`.
- Theme choice should show a real preview swatch of both themes, not a sun/moon icon only.

**Daily Challenges (/daily)**
- Calendar strip, countdown to next deal, streak, one clear "play today's deal" action, result state with
  time and rank.
- Components: `Card`, `Badge`, `Progress`, `Tooltip`.

**Solitaire gameplay surroundings (board excluded)**
- Player seats, clocks, move counter, undo/hint, post-match summary, review entry.
- Use the existing `--gr-*` tokens; the board itself must **not** be restyled without a separate gameplay
  usability review (cell size, tap targets, readability at 320–390px, colour-blind seat cues). The current
  board tokens are tested; treat them as frozen until that review happens.

---

## 6. Skill inventory

All skills were installed with the Agent Skills CLI into the repository-standard directory
`.agents/skills/<name>/SKILL.md`. Freebuff discovers this directory (verified with `skills list`); the same
path is shared by Codex, Cursor, GitHub Copilot and OpenCode, so VS Code agent workflows see them too.

### 6.1 Installed

| Skill | Source | Licence | Purpose | Installed at |
|---|---|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 (`LICENSE.txt` copied) | Distinctive visual direction, typography, anti-template critique | `.agents/skills/frontend-design/` |
| `brief-to-interface` | [thanhaq/interface-compass-skills](https://github.com/thanhaq/interface-compass-skills) | MIT | Turn a brief into screen strategy + acceptance checks | `.agents/skills/brief-to-interface/` |
| `design-system-starter` | same | MIT | Tokens, component contracts, migration steps | `.agents/skills/design-system-starter/` |
| `interface-quality-audit` | same | MIT | Evidence-led UI audit with P1–P3 severities | `.agents/skills/interface-quality-audit/` |
| `motion-and-interaction` | same | MIT | Purposeful motion, states, reduced motion | `.agents/skills/motion-and-interaction/` |
| `product-surface-copy` | same | MIT | Labels, empty/error/success copy | `.agents/skills/product-surface-copy/` |
| `reference-to-implementation` | same | MIT | Translate screenshots/references into code without copying assets | `.agents/skills/reference-to-implementation/` |
| `shipshape-frontend` | same | MIT | Responsive/a11y/state release pass | `.agents/skills/shipshape-frontend/` |
| `ux-ui-skills` | [taylorwinfield/ux-ui-skills](https://github.com/taylorwinfield/ux-ui-skills) | MIT | Anti-slop + anti-fiction guardrails; 10 sub-skills and templates inside the folder | `.agents/skills/ux-ui-skills/` |

Notes:

- `ux-ui-skills` was installed as one self-contained library (its root `SKILL.md` indexes the ten
  sub-skills at `ux-ui-skills/skills/<name>/SKILL.md`). Its dev-only `bin/` and `tests/` were removed after
  install so the repository does not carry a whole cloned project. `skills list` reports it as
  "modified (differs from the lock)" for that reason; the skill content itself is unmodified.
- `frontend-design` is the only Anthropic skill installed. The other 19 in that repo (docx/pdf/pptx/xlsx,
  canvas-design, brand-guidelines, algorithmic-art, mcp-builder, etc.) are out of scope.
- Interface Compass's `interface-quality-audit` references
  `skills/interface-quality-audit/scripts/static-ui-audit.mjs`. Inside the installed folder the path is
  `.agents/skills/interface-quality-audit/scripts/…`; adjust the path when invoking it.

### 6.2 Inspected and deliberately not installed

| Resource | Why not installed |
|---|---|
| [aladicf/better-web-ui](https://github.com/aladicf/better-web-ui) | **Licence.** Not MIT: a source-available licence requiring that any distributed/forked version be published under the same licence and kept free (conditions 2–4). Copying its 33 skills into a repository that may be public would impose that licence on the distributed copy. Also heavy overlap with Interface Compass. Can still be read as inspiration, but not vendored |
| [JetBrains/skills](https://github.com/JetBrains/skills) | It is a **mirror/catalogue** of 129 skills from 15 upstream repos (including `frontend-design`, which we installed from the original). Installing from it would duplicate `frontend-design` and mix authorship. No root `LICENSE` file was found. Use it as a discovery index, not an install source |
| Anthropic `canvas-design`, `brand-guidelines`, `algorithmic-art` | Not relevant to a product UI system; `brand-guidelines` is Anthropic's brand |
| Interface Compass subset | The seven skills are one workflow; installing a subset would break the hand-offs (brief → system → implementation → audit → release) |

### 6.3 Overlap and conflict resolution

- All three packs share the same thesis (avoid generic AI-default UI and ground work in the real system).
  They do not contradict each other. Their roles are separated:
  - `frontend-design` = **aesthetic direction** and self-critique.
  - Interface Compass = **process** (brief, tokens, reference translation, audit, release).
  - `ux-ui-skills` = **guardrails** (never invent tokens/classes; design states, not screens).
- **Do not run `ux-ui-skills`' `bootstrapping-design-context` yet.** It scaffolds six context documents from
  its templates. That is a gated action for the redesign phase, not this research task. The templates and
  the skill remain available.
- **Do not run `/setup` from better-web-ui** — it is not installed, and it writes `.better-web-ui.md`.
- No existing skill was overwritten. `git status` shows only the nine new directories plus
  `skills-lock.json`; no tracked skill file changed, and `.claude/skills/` was not touched.
- `skills-lock.json` went from 19 to 28 entries. The nine new entries are additive. **The CLI also
  recomputed the `computedHash` of the 19 pre-existing entries** — their `source`, `sourceType` and
  `skillPath` are unchanged, and no skill file changed, but the hash values were rewritten by the newer
  CLI. This is lockfile metadata only; it does not alter any installed skill. Review this hunk before
  committing if you want the lockfile diff to stay purely additive.
- `skills-lock.json` now tracks every installed skill with source + hash, so future `skills update` /
  `experimental_install` can restore exactly this set.

### 6.4 How to invoke them

```
Use frontend-design to critique the /profil layout against the premium-competitive direction.
Use interface-quality-audit to review the homepage at 390px and 1440px and return P1/P2 findings only.
Use design-system-starter to plan the token migration from raw hex utilities.
Use ux-ui-skills → designing-states-not-screens for the daily puzzle empty/loading/error states.
Use reference-to-implementation to translate the Chess.com dashboard structure into GRYND components.
Use shipshape-frontend before shipping the redesigned nav.
```

---

## 7. Implementation roadmap

Each phase is independently shippable and independently reviewable. **No phase may start without approval**,
and no phase may mix a redesign with gameplay or data changes.

### Phase 0 — Foundation (no visual redesign yet)

1. Add the semantic token layer beside the existing `--gr-*` block (dark defaults + authored light values
   from §4). Do not delete the generator.
2. Add `Button`, `Card`, `Badge`, `Input`, `Tabs`, `Dialog`, `Table` primitives in `src/components/ui/`,
   built on tokens, with the states in §4.4.
3. Replace the global `!important` blue→yellow button rule with explicit `Button` variants.
4. Add a CI guard: no new `bg-[#…]`/`text-[#…]` in `src/` outside the token file (start as a warning count,
   then fail).
5. Add tabular numerals to rating/clock/leaderboard columns.

**Acceptance:** tokens documented in one place; primitives render in both themes with no `!important`;
`npm run test:tokens` still passes; no page redesigned.

### Phase 1 — Light mode identity

1. Author `[data-theme="light"]` semantic values (§4.3). No utility remapping.
2. Migrate surfaces and text on 3 representative screens (home, leaderboard, profile) to semantic tokens.
3. Delete the three duplicated light hexes; import one constant in `ThemeContext` and `layout.tsx`.
4. Keep the generated sheet in place until the migrated screens no longer depend on it, then remove it in a
   single dedicated change with a visual regression pass.

**Acceptance:** light mode has white surfaces, dark ink, light borders; no `!important` introduced; both
themes pass the existing axe scan and the palette tests.

### Phase 2 — Navigation and shell

1. Desktop left rail + slim top bar; mobile bottom tabs + overflow sheet.
2. One nav height per breakpoint; move streak/title cosmetics into the profile chip.
3. Accessible account menu (replace `<details>`), visible focus, Escape to close.
4. Keep `SiteChrome`'s portal-surface gate and safe-area behaviour intact.

**Acceptance:** every route reachable in ≤2 taps on mobile; keyboard-only traversal; no layout shift when
the trophy value changes width.

### Phase 3 — Homepage

1. Ranked as the single primary action; "continue where you left off" when data exists.
2. Compact secondary-mode row; daily-deal card; leaderboard preview.
3. Real data only — no fabricated zeros for guests (the current code already models this; keep it).
4. One entrance sequence; remove decorative glow/gradient from marketing sections.

**Acceptance:** primary action visible without scrolling at 390×844 and 1440×900; signed-out and signed-in
states both tested.

### Phase 4 — Competitive surfaces

1. Ranked dashboard, leaderboards, profile, statistics migrated to primitives.
2. Fix the leaderboard fallback to Solitaire-only boards.
3. Own-row highlight, rank medallions, pagination, empty/error states.
4. Charts: one line style, no glow, tabular axes.

**Acceptance:** a new player and a top-10 player both render sensibly; tables overflow correctly at 320px.

### Phase 5 — Learning, PRO, settings, daily

1. Academy landing + course pages + lesson chrome on primitives.
2. PRO page: three intervals, benefit table, single CTA, current-plan state.
3. Settings: grouped fields, real theme preview.
4. Daily: calendar strip, countdown, result state.

**Acceptance:** keyboard-completable lesson; PRO checkout state never flashes the wrong plan; settings
save model is unambiguous.

### Phase 6 — Motion, polish, accessibility

1. Motion budget: 120ms feedback, 200ms transitions, 320ms max for overlays; one page entrance.
2. Remove ambient animations; enforce `prefers-reduced-motion` at the token level.
3. Full axe pass at 320/390/768/1280/1440; contrast verification for every semantic pair.
4. Clean up `globals.css`: delete dead casino classes and the duplicate `space-bg`/`pulseGlow` definitions.

**Acceptance:** Lighthouse a11y ≥ 95 on redesigned routes; no animation runs at rest; `verify:a11y` passes.

### Sequencing note

Phases 0–1 are the leverage. Doing Phase 3 before Phase 0 will produce one more page with its own colours.
The current codebase already demonstrates that outcome 3,274 times.

---

## Appendix A — Sources inspected

Skills (README + actual `SKILL.md` read):

- https://github.com/anthropics/skills — `skills/frontend-design/SKILL.md`, `LICENSE.txt`
- https://github.com/thanhaq/interface-compass-skills — README, `LICENSE`, `design-system-starter`, `interface-quality-audit`
- https://github.com/taylorwinfield/ux-ui-skills — README, root `SKILL.md`, `LICENSE`, sub-skill tree
- https://github.com/aladicf/better-web-ui — README, `LICENSE` (read, rejected)
- https://github.com/JetBrains/skills — README catalogue (read, rejected as install source)
- Licences verified per repo: Apache-2.0 (Anthropic), MIT (Interface Compass, ux-ui-skills)

UI libraries (README/docs/component inventory):

- https://github.com/shadcn-ui/ui + https://ui.shadcn.com/docs/components/card
- https://github.com/origin-space/originui (now coss.com/ui) + https://originui.com → https://coss.com/ui
- https://github.com/magicuidesign/magicui + https://magicui.design
- https://github.com/DavidHDev/react-bits + https://reactbits.dev + `LICENSE.md`
- https://github.com/towerneon/shadcndashboard-ui + `LICENSE`
- https://github.com/shadcnblockscom/shadcn-ui-blocks (directory, no root licence found)
- https://github.com/bytefer/awesome-shadcn-ui + `LICENSE`
- https://github.com/Qualiora/shadboard + `LICENSE`
- https://github.com/bradtraversy/design-resources-for-developers + `LICENSE`
- https://github.com/shadcn-ui/lint

Design references:

- https://www.grynd.dedyn.io/ (live product, Solitaire-first)
- https://www.chess.com/ (navigation, dashboard, learning, progression structure)
- https://ui.shadcn.com/ , https://originui.com/ , https://magicui.design/ , https://reactbits.dev/

## Appendix B — Verification performed

| Check | Result |
|---|---|
| `skills list` shows all 9 new skills under `.agents/skills/` | Pass |
| Existing 19 skill folders present; no tracked skill file modified | Pass |
| `.claude/skills/` untouched | Pass |
| `skills-lock.json`: 9 new entries (19 → 28) | Pass (note: CLI also recomputed hashes of the existing 19; sources/paths unchanged, no skill files changed) |
| Licence file present for `frontend-design` | Pass (`LICENSE.txt`) |
| Dev-only files pruned from `ux-ui-skills` | Pass (`bin/`, `tests/`, `.gitignore` removed) |
| No changes under `src/`, `scripts/`, `tailwind.config.js`, `package.json` | Pass (see final report / `git status`) |
| Contrast values in §2 and §4 | Computed with WCAG 2.x relative-luminance math |

## Appendix C — Explicit non-goals of this document

- It does not choose a final typeface licence or add fonts.
- It does not add a component library, `components.json`, `cn()` helper or any dependency.
- It does not modify the Solitaire board, its tokens, geometry or interactions.
- It does not change gameplay, authentication, payments or the database.
- It does not commit or push anything.
