# The blank page after creating a game

**Symptom.** You create a game, the new page is blank, and refreshing shows the
page you expected. It hits Pool Masters, Precision and one Chess branch.

**Cause.** The shared route wrapper (`src/components/RouteTransition.jsx`) was
left with its enter animation never applied, so the page was complete in the DOM
and permanently invisible. Reported as: sometimes after creating a game the page
is blank, and a refresh shows the page you expected.

## What was measured

Production build, no signed-in session, each journey reproduced the way the app
performs it (`router.push` from the game's own hub, i.e. a client-side
navigation — not a hard load), then the page was judged by pixels painted and by
DOM visibility:

| Game | Page reached after Create | Blank |
| --- | --- | --- |
| Pool Masters | `/casino/pool-masters/game/<id>` | 7 / 8 attempts |
| Precision | `/casino/precision/game/<id>` | 8 / 8 attempts |
| Chess | `/casino/chess/<stake>?gameId=…` | 7 / 9 attempts |

Every other create target was clean (4–5 attempts each), including
`/casino/chess-game/<id>` — which is why Chess looked intermittent: it only
routes to the waiting room when nothing was matched
(`src/app/casino/chess/PageClient.jsx`, the `data.ready || status === "in_progress"`
branch), and instantly-matched games land on a route that was never affected.

The same URL loaded directly always painted, which is exactly the player's
workaround: refreshing fixes it. It never healed on its own (+5 s and +10 s
holds, Chess checked to 5 s).

## The mechanism

The invisible element was the wrapper rendered by `RouteTransition`, mounted
around every route in `src/app/providers.tsx`, carrying an inline `opacity: 0`:

```
div[class="relative min-h-screen bg-[#030817]"]   opacity=1
  └ div[class="min-h-screen"]                     inline="opacity: 0;"   ← stuck
```

That value is the `initial` keyframe of the `fadeIn` variant. The component was
`<AnimatePresence mode="wait"><motion.div key={pathname} initial={{opacity:0}}
animate={{opacity:1}} exit={{opacity:0}}>…`. With `mode="wait"` the incoming
page only mounts once the outgoing one has finished exiting, and two things
interleave with that hand-off: Next streams the route (a `loading.tsx` fallback
first — observable as `Loading page…` inside the wrapper), and `/casino/*` 308s
to its canonical `/games/*` route. An instrumented trace of a single navigation
shows both ways the hand-off loses:

```
Pool Masters, new content mounted, then faded out and never restored:
  +202ms  op=1        text="WAITING FOR AN OPPONENT Pool"
  +244ms  op=0.719    ← fading out, not in
  +459ms  op=0   inline="opacity: 0;"   ← stuck for good

Precision, outgoing page faded out and the incoming one never mounted:
  +130ms  op=0.777    text="Home Games Leaderboard Rewar"
  +345ms  op=0   inline="opacity: 0;"   text still the OLD page
```

Either way the wrapper rests at `opacity: 0` and the page is unreadable. It is a
race, which is why the same route passes sometimes and fails other times, and
why only the slowest-rendering routes lose it.

## Why the existing audits missed it

`qa/games-blank-audit.mjs` already hunted this exact class — its header names "a
motion component whose `animate` never runs" — and it already had the detection
(`opacityHiddenTextNodes`) that flags this page. But every route it audited was
reached with `page.goto`, i.e. a hard load, and a hard load mounts the wrapper
fresh and animates it once. The gap was never the probe; it was the navigation.

## The fix

`RouteTransition` no longer drives page visibility from JavaScript. It applies
two CSS keyframes (defined in `src/app/globals.css`) and re-keys on the
pathname:

- `.route-fade-in` — the same 0.25 s fade-in, with **no opacity-0 resting
  state**, so a skipped, cancelled or interrupted animation falls back to the
  element's natural opacity of 1. This is what makes the failure mode
  impossible rather than unlikely.
- `.route-wipe` — the same 0.34 → 0 darkening flash, whose resting state is
  opacity 0, so it cannot cover the page if it never runs.

Reduced-motion is handled by the existing global `prefers-reduced-motion` block,
which collapses both to their end state (the same way `.animate-state-in`
behaves).

The wipe veil sits **inside** the keyed wrapper. Two siblings cannot share one
`key`, and a veil React reuses instead of remounting never replays its one-shot
animation — measured as a veil that stayed at its transparent resting opacity
while the page around it faded in.

## How to verify

```bash
npm run build && npm run start          # CLERK_SECRET_KEY="" to run signed out
npm run verify:games-blank-create       # the regression check
node --import tsx --test tests/route-transition-visibility.test.mjs
```

`verify:games-blank-create` drives each game's create journey as a client-side
navigation, three attempts each, and exits non-zero when any journey leaves a
page invisible, blank or throwing. On the pre-fix build it exits 1 and names
Pool Masters, Precision and Chess; after the fix all 21 journeys pass. The unit
test is the static half: it fails if page visibility is again tied to a
JavaScript `initial` opacity, if the fade class gains an opacity-0 resting
state, or if the veil stops resting transparent.
