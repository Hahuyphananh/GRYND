# Creator Mode — In-Page Recording Engine

This document describes the shared Creator Mode recording engine
(`src/lib/creator-mode/recorder.ts` and friends). It explains how the
recorder captures game viewports **inside the website** without screen
sharing, per-rendering-technology behavior, and the known limitations of
each capture path.

## What is recorded

The recorder captures **only** the dedicated recording viewport — the DOM
container the game page mounts inside `<CreatorModeHost>` (the element
marked `data-creator-recording`). Never:

- the browser tab or window (address bar, bookmarks, browser chrome)
- the OS taskbar / dock / other applications
- other browser tabs or windows
- the page's navigation bar, footer, or modals (they live outside the
  viewport container)

There is no full-desktop recording and no OBS-style external tooling. No
screen-sharing permission prompt is required, because capture never uses
`getDisplayMedia`.

## Why this architecture

The games render with DOM, SVG, canvas (2D and WebGL), and mixes of all
of them (only four files in the app use `<canvas>`; everything else is
DOM/SVG). Browsers expose exactly one native way to rasterize arbitrary
DOM into a canvas — the SVG `<foreignObject>` technique — and one native
way to capture a canvas — `canvas.captureStream()` + `MediaRecorder`.
The engine combines them, and picks a path based on how the container
renders:

### 1. Canvas mode (canvas / WebGL games)

When a single `<canvas>` covers most of the container (threshold
`CANVAS_MODE_AREA_THRESHOLD` in `src/lib/creator-mode/types.ts`), the
recorder draws that canvas into an output canvas each animation frame
and records the output canvas.

- Exact, synchronous, full frame rate (default 30 fps).
- Works for 2D and WebGL canvases (`drawImage` accepts both).

### 2. Composite mode (DOM / SVG / mixed games)

Every frame the recorder:

1. clones the container, strips `<canvas>/<script>/<iframe>` (canvases
   are drawn live, scripts/iframes do nothing in an image),
2. absolutizes relative URLs (`src`, `srcset`, `poster`, CSS `url()`)
   so same-origin assets resolve inside the SVG,
3. serializes the clone to XHTML and embeds it — together with the
   page's stylesheets, collected once and cached — into a
   `data:image/svg+xml` SVG with a `<foreignObject>`,
4. draws that data-URL image into the output canvas (letterboxed to the
   selected output aspect ratio, centered on a black base), then
5. composites any live `<canvas>` elements back on top at their layout
   positions.

Chrome's own SVG rasterizer renders the DOM with the page's real CSS, so
Tailwind classes, inline styles, and SVG elements all appear correctly.
Every raster and CSS `url()` is inlined into the snapshot as a data URL
before drawing, the CSS is compacted (comments/newlines stripped) and
CDATA-wrapped, and the snapshot is served as a **data: URL** — drawing an
SVG image from a `blob:` URL taints the canvas in Chrome (verified
experimentally), while the identical `data:` snapshot stays
**origin-clean**, which `captureStream()` requires. Compaction keeps the
URL under Chrome's ~2 MB `data:`-URL ceiling; if a page is so CSS-heavy
that even the compacted snapshot would exceed it, the recorder reports a
clear size error instead of failing silently.

The output canvas is always sized to the **selected recording
dimensions** (9:16 default, 16:9, 1:1, or custom). The game renders
inside a recording viewport of that logical size which is CSS-scaled to
fit the screen; the capture runs at the full logical resolution, so the
creator never resizes their browser window.

### Feature detection & fallback

- Before composite capture starts, the recorder runs a one-shot probe
  (draw one snapshot, verify the canvas is origin-clean **and** painted).
  If the probe fails (e.g. an old Safari quirk where foreignObject
  renders blank), it falls back to canvas mode when a dominant canvas
  exists, otherwise it reports a clear error instead of silently writing
  a black/broken video.
- MIME type selection walks `vp9 → vp8 → webm → mp4` using
  `MediaRecorder.isTypeSupported`; browsers without `MediaRecorder` or
  `canvas.captureStream` get a clear "unsupported" state.

## Known limitations

Honest list — the recorder degrades or errors rather than pretending:

| Area | Behavior |
| --- | --- |
| CSS keyframe animations | SVG images never run CSS animations, so class-driven keyframes appear static in the recording. Movement driven by React/inline style updates IS captured every frame. |
| Canvases inside DOM | A `<canvas>` serialized into the SVG renders blank, so live canvases are composited on top afterwards. Positioning math uses layout space and is robust to the viewport's CSS transform. |
| External rasters | Any http(s) image referenced by an SVG-in-img loads without CORS and would taint the canvas (`captureStream` then throws). The recorder therefore INLINES every raster as a data URL before drawing (once per capture, cached): same-origin and CORS-enabled images (avatars, emotes, card art) are fetched in and appear normally; images the browser refuses to read (no CORS) become a transparent pixel so the recording still works — the canvas can never taint. |
| External resources | `@import` rules and external fonts do not load inside an SVG image; text falls back to system fonts. `url()`s in the snapshot's CSS are inlined the same way (unreadable ones become transparent). |
| `vw`/`vh` units | Resolve against the SVG viewport (the container) rather than the browser window — visually equivalent for content laid out to the container. |
| `position: fixed` overlays | Resolve relative to the foreignObject (≈ the container) — full-screen modals inside the container record centered in the frame. |
| Complexity | Composite mode is heavier than canvas mode (serialization + decode per frame). Default 15 fps; frames are skipped when a decode is still in flight (adaptive, never queues). |

## Non-interference guarantees

The recorder is strictly read-only:

- No input listeners are attached anywhere; clicks, pointer events, and
  keyboard input pass straight through the viewport container.
- Nothing is paused, and no timers, animation timing, multiplayer sync,
  or game state is modified.
- The 3 → 2 → 1 countdown is pure overlay UI (portaled to `<body>` with
  `pointer-events: none`) and never touches game logic.

## Game lifecycle wiring

Creator Mode is connected to each game's **real** lifecycle, never to
page load. Games integrate through `<CreatorModeHost />` props or the
`useCreatorModeLifecycle()` hook (canonical API in
`src/lib/creator-mode/types.ts`):

| Signal | When to send it | What happens |
| --- | --- | --- |
| `autoStart` / `gameStarted()` | The actual game starts (e.g. a PvP match leaves the waiting room — `MATCH_STATUS.READY` / `BALL_*` in plinko) | 3 → 2 → 1 countdown, then in-page capture begins |
| `autoStop` / `gameFinished()` | The game reaches its normal completed/result state | Recording keeps running for `autoStopDelayMs` (default 1600 ms) so the result/winner animation is captured, then stops and auto-downloads the finished clip |
| unmount / `gameQuit()` | The user quits / navigates away (Return to lobby, Play Again, in-app back) | Recording stops immediately (no grace period) and the finished clip is AUTO-DOWNLOADED — nothing keeps recording and nothing is silently discarded |
| Tab hidden / page leaving | Tab switched away, browser back out of the app, refresh, tab close, external link | Recording stops and the finished clip is auto-downloaded: graceful stop when the page stays alive (finalize builds the full clip), synchronous save from the frames already captured when the page is actually being torn down |

Recording only ever starts from a genuine game-start signal derived from
the game's own state machine (plinko's reference wiring uses
`isReady || isLaunchable` from `MATCH_STATUS`). A finished result screen
rendered inside the recording viewport is captured during the stop
grace period; the overlay then shows the download UI. Nothing about
game results, scoring, wagers, balances, matchmaking, timers, or
multiplayer state is touched.

## Shared visual layout

Creator Mode does NOT shrink the desktop game into a tiny rectangle — it
provides a dedicated, responsive game-presentation shell optimized for the
selected recording aspect ratio (`src/components/creator-mode/`
`CreatorModeLayout.jsx`):

- `<CreatorModeShell>` fills the recording frame exactly and adapts its
  stacking direction to the selected ratio — portrait 9:16 becomes a
  vertical column (header → game area → pinned aside), landscape 16:9 and
  square 1:1 become a horizontal row. It exposes
  `data-creator-layout={portrait|landscape|square}`.
- A layout context (`useCreatorModeLayout`) gives every game the frame
  orientation/geometry so each game arranges **its own** content — the
  shell does not force one identical layout on every game.
- Reusable primitives: `<ShellHeader>` (branding/status), `<ShellMain>`
  (growing gameplay area), `<ShellAside>` (info/controls).
- Portrait prioritizes actual gameplay: board fills most of the height,
  important info stays visible in the header, controls pinned below;
  nav/footer/unrelated casino UI are already outside the frame.

Games that use the generic `<CreatorResponsiveLayout>` wrapper (blackjack,
chess-ai, uno, odds, …) instead of a bespoke arrangement fill the frame via
two mechanisms, depending on orientation:

- **Portrait (9:16) is the PHONE frame.** The game is laid out at a real
  phone width (390px — `PHONE_LAYOUT_WIDTH`) and `zoom`ed up to fill the
  whole output frame edge-to-edge (`data-creator-phone`). Because the game
  sees a 390px-wide layout, its own mobile-first responsive styles take
  over — wrapping, stacked panels, touch-sized controls — so the recorded
  video looks like a real phone screen at 1080×1920, never a shrunken
  desktop page in the middle of the frame. `zoom` (not `transform: scale`)
  re-lays-out the subtree at the scaled size, so text stays crisp in both
  the live frame and the composite-mode recording. The shared
  `[data-creator-fill]` CSS still makes the game page root take the full
  phone-viewport width and height (overriding desktop `max-w-*` caps and
  `mx-auto` centering) and scrolls internally when the content is taller.
- **Landscape (16:9) / square (1:1)** keep the direct full-frame fill: the
  game page root fills the frame edge-to-edge via `[data-creator-fill]`.

Games opting into the phone-style portrait column keep it via
`[data-creator-stack]` (which also collapses grid-based desktop layouts,
like chess's board + sidebar grid, to a single column), and `position:
fixed` overlays (turn chips, result modals) are exempt from the fill so
they keep their compact sizing.

Normal (non-Creator-Mode) rendering is byte-for-byte unchanged — the shell
only mounts when Creator Mode is on. Plinko is the reference wiring: it
renders the same gameplay components in both cases but re-arranges them
for the frame (portrait: board-first stack; landscape/square: the standard
3-column grid). No game rules, controls, wagers, or logic are touched.

## Recording UX

Creator Mode configuration (output dimensions, enable/disable) lives in
the **lobby** — it is never in the way during a game. The 🎥 **Creator
Mode ON/OFF control** is available on every game lobby: the shared PvP
lobby chrome (used by the 1v1 duel games), the individual game lobbies
(Chess, Odds, Blackjack, Dice Flush, Hex Duel, Poker, Uno/Neon Flush,
Crash Arena), and the central `/casino` grid. Enabling it persists the
flag for the session (sessionStorage, per user), so entering a match
from any lobby starts recording automatically when the game starts; a
lobby opened with `?creator=1` in its URL keeps the mode on.

| Phase | UI |
| --- | --- |
| Before recording | The **Creator controls** — status ("Creator Mode armed"), **Stop & Save**, and **Download** — are portaled to the bottom of the VIEWPORT (fixed, above the game's own UI). They are always visible and always clickable on every device: they can't fall below the fold of a page layout or be covered by page chrome / fixed bottom bars, and they never appear in the recording (the recorder only reads the frame container). The frame is scaled to leave the bottom strip free so the controls never cover the game. Buttons stay visible but dimmed until they apply. |
| Countdown | 3 → 2 → 1 ring, pure overlay UI (`pointer-events: none`), the game stays fully playable. |
| During recording | The controls switch to REC + the selected dimensions and enable **Stop & Save**. No panels, no input capture — gameplay input is never intercepted, and the controls are never captured in the recording. |
| After recording stops | The finished clip auto-downloads when the game ended normally, the user pressed "Stop & Save", OR the user left the game/page — so a recording is never lost to navigation. **Download** stays enabled (re-download any time), and a clean result panel (modal) appears: "Recording completed", selected dimensions, duration, format, an in-page video preview with play/pause, and Download / Discard / Record-another-game actions. The panel renders above the game's own end-of-match overlay so the Download action is always reachable. |

Downloads use the generated local blob with a meaningful filename:
`grynd-{game}-{date}-{time}.mp4`/`.webm` (e.g. `grynd-plinko-duel-2026-08-30-14-32-05.mp4`).
The download triggers itself when the match ends (auto-stop), when the
creator presses the red "Stop & save" button, or when the user leaves
mid-recording (navigating away, going back, hiding the tab, closing the
page) — the game's result overlay no longer hides the finished clip, a
recording never keeps running unattended, and navigating away can't
discard it. Each finished clip is downloaded at most once (identity
guard), so the leave-save never duplicates the auto-download. The format
is labelled in the result panel. Recordings are never uploaded to the
Grynd server, never stored in the database, and never sent to any
external service — they exist only as a local blob (backed by an object
URL) until the user downloads them or discards them.

## Resource lifecycle

`start()` → countdown (in the provider) → in-page capture. `stop()`
flushes the `MediaRecorder`, builds the final `Blob`, stops the stream
tracks, cancels the animation loop, and revokes the previous download
URL. `stopAndSave()` stops and auto-downloads the finished file from the
recorder's own finalize handler (leave/quit path); `stopAndSaveSync()`
builds the file synchronously from the frames already captured for
pagehide/beforeunload, where the page may die before the async finalize
runs. `dispose()` defers full teardown until a queued finalize has run
so a leave-save clip is never destroyed first, then releases the
recorder, stream, snapshot image, chunks, and object URLs so nothing
leaks between recordings. `cancel()`/`discard()` (result panel Discard /
Record another game) revoke the finished recording's object URL and
return the recorder to idle; starting a new capture also revokes the
previous result's URL, so media resources never accumulate.
