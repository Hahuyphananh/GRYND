# GRYND video pipeline

Headless short-form video editing for GRYND gameplay, running entirely inside the
browser via `@diffusionstudio/core` v4 (composition → encode), driven from
Node/TypeScript. No CapCut, no GUI needed.

## Layout

- `nat` patterns live in `src/`:
  - `manifest.ts` — typed edit manifests (`EditManifest`, `Beat`, `PayoffBeat`,
    `compileManifest`, `defaultImportanceScale`).
  - `analyze.ts` — ffprobe metadata, deterministic frame sampling, post-render
    sanity check (duration match, non-black luma frames, audio present).
  - `compose.ts` — turns a manifest into a browser-safe `RenderSpec` (caption
    styling constants, beat layout, payload accent).
  - `render-server.ts` — local HTTP server: serves `/client.js`, `/spec.json`,
    `/media/gameplay.mp4` (Range requests) and accepts `POST /upload`.
  - `render-client.ts` — browser bundle: builds the Composition, add beats as
    `VideoClip`s, one headline `TextClip`, optional payoff `TextClip`, renders
    in-memory and uploads the MP4.
  - `render.ts` — esbuild client build + `RenderRunner` (one Chromium + one
    server reused across a batch).
  - `batch.ts` — CLI entry point.
- `src/analysis/` — gameplay-understanding layer:
  - `types.ts` — shared model: `GameId`, `Importance` (normal/important/
    highlight/major), `OcrObservation`, `GameplayEvent`, `ImportantMoment`,
    `GameplayAnalysis` (the unified analysis holder).
  - `sampling.ts` — single-pass 2 FPS frame sampling (jpg/png) into a temp dir,
    cached/frame-reused, cleaned up after the run.
  - `windows-ocr.ts` + `scripts/ocr-win.ps1` — the locally installed Windows
    OCR engine (`Windows.Media.Ocr`, fr-CA) driven from Node via a WinRT
    PowerShell bridge; JSON handoff via a temp UTF-8 file.
  - `identify.ts` — deterministic game identification
    (blackjack/roulette/crash/plinko/unknown) from filename + OCR vocabulary.
  - `games/` — per-game analyzers; `blackjack.ts` is a temporal state machine
    (rounds, player/dealer hands, score transitions, 21, busts, round results).
  - `scoring.ts` — deterministic important-moment ranking.
  - `pipeline.ts` + `analyze-cli.ts` — orchestration + CLI.
- `manifests/` — fixture manifests (matched by source basename).
- `manifests/analysis/` — per-video `GameplayAnalysis` JSON.
- `dist/render-client.js` — built browser bundle.
- `output/` — rendered shorts.
- `input-samples/` — test inputs (gitignored).

## Usage

```bash
npm run batch -- <input-folder> [--manifest <file.json>]
```

The batch discovers MP4s, probes/analyzes each, picks a fixture manifest by
basename (or a deterministic fallback), validates beat ranges against the media,
builds the render spec, renders headlessly, and sanity-checks the output.

## Gameplay analysis

```bash
npm run analyze -- <video.mp4>                      # defaults (2fps, jpg, fr-CA)
npx tsx src/analyze-cli.ts <video.mp4> [flags]      # flags must go via npx:
  --fps 2          --format jpg|png    --locale fr-CA
  --keep-frames    --out <dir>         # default out: manifests/analysis/
```

- Extracts a single-pass 2 FPS frame grid (temp dir, reused across runs when an
  intact grid already exists, removed afterwards unless `--keep-frames`).
- OCRs every sampled frame with the **locally installed** Windows OCR engine
  (`Windows.Media.Ocr`, zero install; a report item for this step was verifying
  no large external OCR engine is pulled in).
- Identifies the game (filename + OCR vocabulary), runs the matching analyzer
  (blackjack is a temporal state machine), ranks important moments, and writes
  `manifests/analysis/<slug>-analysis.json`.
- OCR carries no per-word confidence, so `observation.confidence` is `null`;
  event confidence is derived only from evidence, never invented.

Note: npm 11 swallows `--flags` passed to `npm run`, so options are used via
`npx tsx src/analyze-cli.ts`. The plain `npm run analyze -- <video>` path works
for defaults.

`batch.ts` still uses the deterministic fixture manifest (analysis → manifest is
a later step); legacy `analyzeMp4` in `analyze.ts` remains backward-compatible.

## Current state

- **POC** (`src/poc.ts` + `src/server.ts` + `src/client/render.ts`): minimal
  single-clip render, verified MP4 (h264/AAC).
- **Batch fixture** (`manifests/trusted-16-twice.json`): the blackjack test
  rendered to a 19.3s vertical short, headline `bro trusted 16 TWICE`, payoff
  `BUSTED`, gameplay audio preserved across beats.
- **Analysis layer** (`src/analysis/`): real gameplay understanding on the
  source footage — 2 FPS sampling + local Windows OCR + game identification +
  blackjack event inference, writing `manifests/analysis/*.json`. Verified
  against the real blackjack recording (see report). It does NOT generate edit
  manifests yet.
- **Honesty constraint:** the batch still uses deterministic fixture manifests
  for beat timestamps; the analysis layer only *discovers* what happened and
  never guesses. Event confidence is evidence-based; OCR confidence is `null`
  because the Windows OCR engine does not expose it.

## Rendering notes

- `licenseKey: undefined` runs in watermark mode (the core overlays a translucent
  watermark over the whole frame; observable as a ~13-luma darkening). Verified
  behavior of `@diffusionstudio/core@4.0.3`; licensing comes later.
- The PhotonCore semantics quirks verified against this exact version:
  - clip `start = delay + range[0]`, `end = delay + range[1]` — to play source
    window `[s, e]` at timeline `t`, set `delay = t - s` and `range = [s, e]`.
  - `trim(a, b)` just sets `delay = a`, `duration = b - a` (timeline, not source).
  - Encoder streaming callbacks are unreliable for this pipeline; use the
    in-memory `await encoder.render()` and upload `result.data`.
- Sanity luma parsing reads `metadata=print:file=-` output (stdout + stderr).

## Verification

```bash
npx tsc --noEmit
npm run batch -- input-samples
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 output/...
```

The fixture run: 19.31s, 1080x1920@30fps, h264 + AAC 48kHz/2ch, sane luma at
probe times, audio energy follows the beat/source windows.