# Chess AI — Phase 1 engine spike

**Gate: passed.** This directory is throwaway scaffolding that answers one question:
can the production chess engine run in a plain browser page, from static files,
with no server and no COOP/COEP headers?

It can.

## Run it

```bash
node standalone/chess-ai/spike/run-spike.mjs               # wasm served as application/wasm
node standalone/chess-ai/spike/run-spike.mjs --mime=octet  # prove the non-streaming fallback
# or: npm run spike:chess-ai
```

The runner builds the page with Vite into `dist/chess-ai-spike/`, serves the **built**
output from a local static server, launches headless Chrome, blocks every `https://`
and `wss://` request, and asserts the result. It needs only Chrome (set `CHROME_PATH`
if it is not in a standard location); no Playwright or test framework is involved.

## What was proven

Measured on this machine (Windows, headless Chrome, single-threaded Stockfish 16):

| Check                                 | Result                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Engine boots in a Web Worker          | **170–184 ms** (first engine output line at ~50 ms)                      |
| Worker entry that works               | `new Worker("engine/stockfish-nnue-16-single.js")` — the **bare script** |
| Documented hash form `#<wasm>,worker` | **Times out** (no `uciok` within 8 s) — do not use                       |
| Wasm MIME                             | `application/wasm` **and** `application/octet-stream` both boot          |
| `crossOriginIsolated`                 | **false** — no COOP/COEP, no SharedArrayBuffer                           |
| Search cost, `hard` (500 ms budget)   | 172–369 ms per move                                                      |
| Search cost, `medium` (300 ms budget) | 271–284 ms                                                               |
| Search cost, `easy` (150 ms budget)   | 100–108 ms                                                               |
| Legal moves                           | 7/7 cases validated with `chess.js`                                      |
| Mate in one                           | found (`Ra8#`)                                                           |
| Mated position                        | `bestmove (none)`, handled as "no move"                                  |
| Promotion                             | `e7e8q` → `e8=Q`                                                         |
| Network                               | one origin only (the local static server); 8–9 local requests            |

Positions exercised: start position, an Italian middlegame, a black-to-move opening
(the bot opening as White), mate in one, a checkmated position, and a promotion.

## Decisions this spike fixes for Phase 2

1. **Worker form.** Use the bare worker URL and keep the `.wasm` **next to the JS**
   (the build's default `locateFile` resolves relative to the worker script). The
   package's `#…,worker` hash form is not needed and does not boot.
2. **Host the wasm without relying on its MIME type.** Portal hosts (itch.io,
   CrazyGames) may serve `.wasm` as `application/octet-stream`; the engine falls back
   to an ArrayBuffer compile and still boots. There is no streaming-only requirement.
3. **No special headers.** A single-threaded build is the only viable one on portal
   hosting: no `SharedArrayBuffer`, no `Cross-Origin-Opener-Policy`/`Embedder-Policy`.
4. **Relative paths.** The Vite build uses `base: "./"`; the page resolves the engine
   with `new URL("engine/…", document.baseURI)` so it survives subdirectory hosting.
5. **Search budgets are affordable.** The shipped tier budgets (150/300/500 ms) land
   at 100–370 ms per move in this environment, which is a comfortable "Thinking…"
   pause, not a freeze — provided the engine stays in a Worker (it is).
6. **Licence.** Stockfish is **GPLv3**. The plan is to ship the engine **unmodified**
   (byte-identical to `node_modules/stockfish/src/stockfish-nnue-16-single.{js,wasm}`,
   verified by hash), with the GPLv3 text and a corresponding-source pointer in the
   package. No engine source is modified, so no patch set needs publishing.

## Phase 2 follow-up: real adapter, real game

Phase 2 replaced this page's measurement code with the shipping adapter
(`../src/engine.ts`) behind a small harness, so the same checks now run through the
code the game will use.

| Check                                                  | Result                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests (`npm run test:chess-ai-standalone`)        | **30/30 pass** — match rules, clocks, undo, resign, mate/stalemate/timeout, difficulty table, adapter queue/timeouts/illegal answers, self-play driver |
| Typecheck (`tsc -p standalone/chess-ai/tsconfig.json`) | clean                                                                                                                                                  |     | Full self-play (`npm run check:selfplay:chess-ai`) | **checkmate** in ~60–70 plies, ~10 s (`hard` vs `easy`; latest run 61 plies, 9.4 s), every move re-validated by `chess.js`, 0 illegal |
| Network during the game                                | the local static origin only                                                                                                                           |

## CPU throttling: what it does and does not measure

The runner repeats the search under `Emulation.setCPUThrottlingRate` at 1×/4×/6×.
A movetime-capped search cannot show throttling (it stops at the same wall-clock
budget), and neither can a fixed-depth search that reuses a warm transposition
table — so the benchmark clears the hash and also times a main-thread control
(one representative run; the self-play game is not deterministic and neither are
these timings):

| Signal                                  | 1×     | 4×     | 6×     | Reading                              |
| --------------------------------------- | ------ | ------ | ------ | ------------------------------------ |
| Main-thread control (3M-iteration loop) | 7 ms   | 24 ms  | 39 ms  | throttle **is** applied (5.6× at 6×) |
| Fixed depth, clear hash + `go depth 12` | 326 ms | 337 ms | 342 ms | worker **not** throttled (1.05×)     |
| `hard` median per move (500 ms budget)  | 290 ms | 276 ms | 284 ms | flat — movetime caps wall time       |
| `medium` (300 ms budget)                | 265 ms | 284 ms | 264 ms | same                                 |
| `easy` (150 ms budget)                  | 139 ms | 95 ms  | 99 ms  | same                                 |

What that means:

1. **Think-time is bounded by construction.** `movetime` is a wall-clock cap, so a
   slow phone stops within the same 150/300/500 ms — it simply searches fewer nodes.
   The weak-hardware risk is weaker play, not a longer "Thinking…" stall.
2. **CDP throttling does not reach the engine's dedicated worker** in this headless
   Chrome (main thread 5.6× slower, worker 1.05×). These numbers therefore cannot
   estimate mobile playing strength; that needs a real device. The benchmark is still
   a useful main-thread regression check once the board UI exists.
3. 6 samples per tier. The first attempt without `Clear Hash` produced
   304 → 178 ms — later runs got _faster_ as the table warmed, which is exactly the
   trap this control now removes.

## Contents

| Path                     | Role                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `spike.js` | The measurement page: boots the engine, searches, validates with `chess.js`                                         |
| `../public/engine/`      | Byte-identical copies of the production engine build, shared with the app (the spike sets `publicDir: "../public"`) |
| `vite.config.mts`        | Isolated build, `base: "./"`, output to `dist/chess-ai-spike/`                                                      |
| `run-spike.mjs`          | Build → serve → headless Chrome (CDP) → assert → `report.json`                                                      |

Phase 2 has since replaced the page's measurement code with the real
`../src/engine.ts` adapter and a harness that plays complete games; the engine
assets and every finding above carried over unchanged.
