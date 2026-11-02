# GLITCH — GRYND's mascot

GLITCH is GRYND's official character. This folder holds the six expressions;
this document covers the artwork **and** how the app is allowed to use it.

Every file is a **WebP with a genuine alpha channel**. There is no white or
coloured backdrop in the shipped files, and no CSS blend mode is used anywhere
(see "Why these files are processed").

## Expressions

| Expression | Use it for | Optimised (2x) | 1x | Master |
| --- | --- | --- | --- | --- |
| `idle` | the default; neutral greeting, waiting, an unexpected/neutral state | `glitch-idle.webp` | `glitch-idle-192.webp` | `assets/mascot-source/masters/glitch-idle.png` |
| `wink` | playful, a nudge, "I know something you don't" | `glitch-wink.webp` | `glitch-wink-192.webp` | `…/glitch-wink.png` |
| `victory` | a win — match result, a first successful match | `glitch-victory.webp` | `glitch-victory-192.webp` | `…/glitch-victory.png` |
| `defeat` | a loss, a setback — sympathetic, never mocking | `glitch-defeat.webp` | `glitch-defeat-192.webp` | `…/glitch-defeat.png` |
| `surprised` | a first-time moment, a question, mild curiosity | `glitch-surprised.webp` | `glitch-surprised-192.webp` | `…/glitch-surprised.png` |
| `focused` | something that matters — a final question, a competitive step | `glitch-focused.webp` | `glitch-focused-192.webp` | `…/glitch-focused.png` |

`idle` is the fallback whenever an expression is missing or unrecognised.

> In use today: onboarding questionnaire q1 (`surprised`) and q5 (`focused`),
> the five `/welcome` steps (`idle`, `wink`, `focused`, `focused`, `victory`),
> the first RPS match (`idle`, then `victory`/`defeat`), every match result
> (`victory`/`defeat`/`idle`), and one games-hub hint per session
> (`idle`/`wink`). The full mapping is in `src/lib/mascot/glitchOnboarding.ts`
> and `src/lib/mascot/glitchMoments.ts`.

## Sizes

| Property | Value |
| --- | --- |
| Canvas | **square**, transparent padding, one shared scale across all six |
| Master | 1024 × 1024 transparent PNG (source archive only, never shipped) |
| Shipped | 384 × 384 (2x) and 192 × 192 (1x) WebP |
| Per 384 file | 16.7 – 27.3 KB |
| Whole set | 12 files, ~172 KB |
| Encoding | WebP `quality 90`, `alphaQuality 100`, `effort 6`, `smartSubsampling` |

`<Glitch>` emits `srcSet="…-192.webp 1x, ….webp 2x"` with `sizes` set to the
rendered CSS size, so a 72–120 px mascot fetches the 192 px file on 1x/2x
displays and the 384 px file only at 3x. Both are served with `loading="lazy"`
and `decoding="async"`; explicit `width`/`height` prevent layout shift.

## Component entry points

| File | What it is |
| --- | --- |
| `src/lib/mascot/glitchAssets.ts` | the **typed allow-list** — six expressions → file + intrinsic size + alt text. There is no `src` prop anywhere, so no caller can point the mascot at an arbitrary image. |
| `src/components/mascot/Glitch.tsx` | the image. Square box, `object-contain`, alpha-following aqua glow (`drop-shadow`, never `box-shadow`), no background, no filter that alters the artwork. |
| `src/components/mascot/GlitchBubble.tsx` | the ivory speech bubble + optional dismiss control (44 × 44 hit area). The text is the `role="status"` live region. |
| `src/components/mascot/GlitchSay.tsx` | image + bubble, either **inline** or in one corner. Presentational only. |
| `src/components/mascot/GlitchProvider.tsx` | the **one** floating layer, mounted once in `src/app/layout.tsx`. Owns cadence, suppression, timers and the portal. |
| `src/lib/mascot/glitchCadence.js` | the pure rules: priorities, cooldowns, session cap, dedupe, suppression. Unit-tested without rendering. |
| `src/lib/mascot/glitchOnboarding.ts` | onboarding step → expression + message key. |
| `src/lib/mascot/glitchMoments.ts` | result / lobby → expression + message key + event id. |

## Provider API

```ts
const { say, hide, isAvailable } = useGlitch();

say({
  expression?,   // one of the six; defaults to "idle"
  message,       // required — a silent floating mascot is noise
  placement?,    // "bottom-left" (default) | "bottom-right" | "top-left"
  priority?,     // 0 ambient · 1 hint (default) · 2 milestone · 3 critical
  eventId?,      // stable id; the same id never appears twice per session
  autoHideMs?,   // number, or null to stay until dismissed
  dismissible?,
  size?,         // "sm" | "md" | "lg" | pixels
}): boolean      // true only if it was actually shown

hide(): void
```

`say()` returns `false` when the rules decline, so a call site can tell "shown"
from "suppressed". Outside the provider `useGlitch()` is inert (`isAvailable:
false`) instead of throwing.

**Inline is not the provider's job.** A page that wants GLITCH next to its own
copy renders `<GlitchSay placement="inline" />` directly — that is page content
and is not rate-limited.

For non-React code there is one browser event, validated before anything renders:

```js
window.dispatchEvent(new CustomEvent("grynd:glitch", {
  detail: { message: "Pick a game.", expression: "idle", priority: 1 },
}));
```

## Cadence

| Rule | Value |
| --- | --- |
| Priority 0 — ambient | off unless `config.allowAmbient` |
| Priority 1 — hint | 5 min cooldown |
| Priority 2 — milestone | 2 min cooldown |
| Priority 3 — critical | bypasses cooldowns and the 90 s floor, **not** the session cap |
| Minimum gap | 90 s between any two floating appearances |
| Session cap | 3 floating appearances |
| Duplicates | an `eventId` never shows twice in a session |
| Overlap | one bubble at a time; a higher priority replaces, anything else is dropped |

Inline messages are never rate-limited and never recorded, so a re-rendered
tutorial step still shows its own line.

## Suppression

A floating request is refused (and spends nothing) when:

| Signal | Selector / route |
| --- | --- |
| Active match | any `/casino/*` board route (`history` excepted) |
| Blocking overlay | `[aria-modal="true"]` — result screens, the post-match ad, sheets, dialogs |
| Ad in the corner | `[data-ad-placement]`, `ins.adsbygoogle` in the lower viewport |
| Loading | `[aria-busy="true"]` |
| Error / retry | `[role="alert"]` |
| Creator mode | `[data-creator-layout]` |

The floating layer is `z-[80]`: above the navbar (40), below the result screen
(95), toasts (100) and the post-match ad (100). Its wrapper is
`pointer-events-none`; only the dismiss button is interactive.

## Translations

All mascot copy lives in `src/lib/appTextTranslations.js` as a **nested** tree —
`t()` resolves dotted paths. Supported locales: **en, fr, es**.

```js
en: {
  glitch: {
    result: { victory: "That one's yours.", … },
    lobby:  { pickGame: "Pick a game. I'll be watching.", … },
  },
  onboarding: { glitch: { welcome: { step0: "Hey. I'm GLITCH. …" } } },
}
```

To add a string: add the same key under **all three** locales, then call
`t("glitch.your.key")`. Never hard-code a sentence in a component — the test
suites assert that none of the mascot's lines appear as literals in the pages.

## Adding a mascot event safely

1. Add the copy to `en` / `fr` / `es` under the right namespace.
2. Map the moment in `glitchOnboarding.ts` / `glitchMoments.ts`: expression,
   message key, and a **stable `eventId`**.
3. Call `say()` from a component that is **not a game board**, once per mount,
   behind a ref guard — and only remember the hint when `say()` returned `true`.
4. Pick the lowest priority that fits (1 unless it is a milestone or
   tutorial-critical), and use inline placement when the message belongs to the
   page rather than the corner.
5. Add the key to the relevant test's list so a missing locale fails the build
   instead of silently falling back to English.

## Regenerating the assets

`sharp` is already a dependency, so there is nothing to install.

```bash
node scripts/prepare-mascot-assets.mjs
```

The script reads the six originals from `assets/mascot-source/` (falling back
to the repository root on a fresh checkout), writes the WebP files here, and
rewrites the PNG masters. Output is deterministic — re-running produces
byte-for-byte identical files.

It also writes verification sheets next to the sources, because background
removal has to be inspected, not assumed:

| Artifact | What it proves |
| --- | --- |
| `assets/mascot-source/contact-sheet.png` | all six on GRYND's `#030817` at native 192 / 96 / 48 px |
| `assets/mascot-source/edge-check.png` | 4× zoom on the silhouette — halos, missing pixels, broken detail |
| `assets/mascot-source/halo-check.png` | the same six on magenta, where any leftover fringe is unmistakable |
| `assets/mascot-source/asset-report.json` | per-file dimensions, byte sizes and alpha flags |

## Source artwork (preserved, never edited)

| Expression | Original file | Note |
| --- | --- | --- |
| `idle` | `assets/mascot-source/glitch.png` | |
| `wink` | `assets/mascot-source/glitch wink.png` | |
| `victory` | `assets/mascot-source/glitch victory.png` | lavender backdrop, not white |
| `defeat` | `assets/mascot-source/glitch defeat.png` | |
| `surprised` | `assets/mascot-source/glitch suprised.png` | source name is misspelled — kept verbatim; the shipped asset is `glitch-surprised.webp` |
| `focused` | `assets/mascot-source/glitch focused.png` | |

All six originals are 1024 × 1024, 8-bit, **PNG colour type 2 (RGB — no alpha
channel)**. They were moved, not deleted; none were edited.

## Why these files are processed

The originals have **no alpha channel**, so their background is real opaque
paint: near-white for five expressions, a light periwinkle gradient for
`victory`. Deleting "light pixels" is not an option — it also deletes the ivory
eyes and mouth. The pipeline instead:

1. flood-fills from the border with a **neutral-and-light** predicate, so the
   fill cannot reach the enclosed face and cannot touch the saturated cyan and
   coral confetti;
2. keeps a deliberately conservative fill for `victory`, whose backdrop is a
   lavender gradient and whose body carries its own lavender shading (a looser
   predicate walked past the silhouette and left body pixels half-transparent);
3. reconstructs coverage only in a 3 px edge band, using `|C−B| / |F−B|` with
   the nearest opaque artwork colour `F`;
4. re-colours that band with `F` instead of the blend — this removes
   white/lavender fringing rather than merely fading it;
5. drops the detached floor-shadow ellipse by component statistics on the
   **opaque core** colour, which is what stops it being confused with confetti.

Verified after processing: every output has an alpha channel, no expression is
cropped at the canvas border, no floor shadow survives, and no backdrop-coloured
fringe remains on the magenta sheet.

## Visual rules

- Do **not** put GLITCH inside an opaque card or panel, and never add a
  background colour, border or rounded rectangle behind it.
- Separate it from GRYND's near-black page with an **alpha-following glow**:
  `filter: drop-shadow(...)` on the `<img>`. A `box-shadow` follows the element
  box, not the artwork, and produces a visible rectangle.
- Never stretch it: render with explicit `width`/`height` and `object-contain`.
- Never use a CSS blend mode to fake transparency. The mascot's own indigo is
  only a few luminance steps from `#030817`, so any blend that erases a light
  backdrop also erases the character.
