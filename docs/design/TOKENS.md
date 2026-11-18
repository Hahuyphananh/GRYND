# GRYND semantic tokens

Status: **Phase 1 — implemented in `src/app/globals.css`**
Date: 2026-11-18

This is the reference for the role names product chrome uses. It is deliberately
short: 24 names, one owner, measured contrast for every pair that carries text.

Two layers, one palette:

```
src/app/globals.css
  ├─ GRYND GAME VISUAL TOKENS   --gr-*   the colours (brand, seats, states)
  └─ GRYND SEMANTIC UI LAYER    --bg-*, --text-*, --accent …   the roles
```

A role is either a **alias** of a game token or a **newly authored value that
clears its contrast requirement on both themes**. That is the whole trick: aliases
inherit light mode for free, and the few authored values are chosen so light mode
needs no override at all.

## Grounds

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg-page` | `#030817` | `#24417f` | the page itself |
| `--bg-surface` | `#040d24` | `#31508f` | cards, panels, HUD |
| `--bg-panel` | `#001933` | `#1b3266` | recessed well inside a card |

All three are `var(--gr-surface-*)` aliases. `light-theme.css` re-points those
three tokens on `html[data-theme="light"]` (specificity 0,1,1 beats `:root`'s
0,1,0), so the aliases follow without a single duplicated value.

## Text — measured on all six grounds

Order: dark page / surface / panel · light page / surface / panel.
Requirement: AA body text 4.5:1.

| Token | Value | Dark | Light | Use |
|---|---|---|---|---|
| `--text-primary` | `#ffffff` | 20.0 / 19.3 / 17.7 | 9.8 / 7.9 / 12.4 | headings, values, body |
| `--text-secondary` | `#cddcef` | 14.4 / 13.9 / 12.7 | 7.1 / 5.6 / 8.9 | descriptions, hints |
| `--text-muted` | `#b6c9e2` | 11.8 / 11.4 / 10.5 | 5.8 / 4.7 / 7.3 | 11px uppercase labels, meta |

`--text-primary` aliases `--gr-ink`. The other two are authored: the old
`--gr-ink-subtle` (white at 45%) measured 3.35:1 on the light page, which is why
muted text needed a real value rather than an alpha.

## Accent

One accent for the product: ranked.

| Token | Value | Dark | Light | Notes |
|---|---|---|---|---|
| `--accent` | `#10b981` | 7.9 / 7.6 / 7.0 | 3.9 / **3.1** / 4.9 | fill + border only (3:1 non-text) |
| `--accent-strong` | `#34d399` | 10.4 / 10.0 / 9.2 | 5.1 / 4.1 / 6.5 | accent-coloured **text** on light |
| `--accent-fill` | `rgba(16,185,129,0.12)` | — | — | soft tint for tags and rows |
| `--on-accent` | `#04121c` | — | — | ink on an accent fill, **7.47:1** |

**Rule:** `--accent` is a fill and a border. Small text on a light surface must use
`--accent-strong` (5.1:1 on the light page) or `--text-primary`. Using `--accent`
for 12px text on light is a 3.9:1 failure and the reason this rule is written down.

## States

| Token | Value | Dark | Light |
|---|---|---|---|
| `--state-win` | `#34d399` | 10.4 / 10.0 / 9.2 | 5.1 / 4.1 / 6.5 |
| `--state-loss` | `#fca5a5` | 10.5 / 10.2 / 9.3 | 5.2 / 4.1 / 6.5 |
| `--state-gold` | `#ffd700` | 14.3 / 13.8 / 12.6 | 7.0 / 5.6 / 8.8 |

`#f87171` (the obvious "loss red") was rejected: 3.55:1 on the light page. The
paler `#fca5a5` is the value that still reads as red and passes AA on both.

Gold replaces the old "streak gold on white is invisible" problem: 7.0:1 on the
light page.

## Borders and depth

| Token | Value | Notes |
|---|---|---|
| `--border-hairline` | `var(--gr-hairline)` (white 10%) | decorative; no contrast assertion |
| `--border-strong` | `var(--gr-border-strong)` (white 30%) | control outlines |
| `--border-warning` | `rgba(255,215,0,0.35)` | responsible-play card |
| `--border-success` | `rgba(52,211,153,0.35)` | security card |
| `--shadow-raise` | `0 8px 24px rgba(3,8,23,.45), inset 0 1px 0 rgba(255,255,255,.06)` | hairline + soft shadow, **no glow** |
| `--radius-surface` | `12px` | cards; the board keeps its own `6px` |

`--focus-ring` aliases `--gr-focus-ring` (`#9dd8ff`, 12.6:1 dark / 5.1:1 light),
which is already checked in both themes by `tests/game-visual-tokens.test.mjs`.

## What is *not* a token

- **Mode colours.** Ranked / solo / AI / daily / puzzle / unlimited are no longer
  page surfaces. A mode may use one rule, dot or tag; the accent is ranked's.
- **Board geometry.** `--gr-cell-radius` and the board's own `--sol-*` stay
  frozen; no shared cell size exists on purpose.
- **Glow.** The 203 glow utilities are not carried over. If one survives as a
  deliberate brand moment, it becomes a token with a name, in Phase 7.

## Adding a token

1. If an existing `--gr-*` already means it, add an alias. Do not copy the value.
2. If it is new, measure it on all six grounds and write the numbers in the block's
   comment, next to the value.
3. Run `npm run test:tokens`, `npm run test:design-guard` and
   `npm run test:ui-primitives`.
4. Never add a hex to a component to adopt the layer — that is what the guard and
   `tests/ui-primitives.test.mjs` exist to stop.
