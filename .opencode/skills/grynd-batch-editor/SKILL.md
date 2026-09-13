---
name: grynd-batch-editor
description: >-
  LOAD THIS SKILL for AUTOMATED, HEADLESS, BATCH short-form video editing of
  GRYND casino gameplay using the diffusion-studio browser pipeline — triggers
  include "batch edit", "automated editing", "batch-render", "render short
  programmatically", "diffusion studio", "scripted edit", "headless render",
  "run the pipeline", batch blackjack/roulette/crash/Plinko edits, TikTok /
  Instagram Reels / YouTube Shorts in bulk, manifest-driven editing, or any
  request touching video-pipeline/ (batch.ts, render.ts, render-server.ts,
  render-client.ts, compose.ts, analyze.ts, manifests/). DO NOT use for manual
  CapCut editing (see grynd-video-editor) or for GRYND app/game-development
  tasks.
---

# GRYND Batch Editor

Automated, headless, manifest-driven short-form editing of GRYND gameplay.
Everything happens in the browser (`@diffusionstudio/core` v4 + Chromium via
Playwright), orchestrated from Node/TypeScript in `video-pipeline/`. No CapCut,
no GUI.

## When to use

- User asks to run/create/batch-render GRYND shorts programmatically.
- User wants a bulk or scripted alternative to the manual CapCut editor
  (`grynd-video-editor`).
- Any work inside `video-pipeline/` or on the batch/manifest/spec/render stack.

For manual/meme-reel CapCut editing and its editing philosophy, load
`grynd-video-editor` instead. This skill covers the code pipeline and its
editorial contract, NOT the CapCut MCP.

## Editing contract (inherited from `grynd-video-editor`)

- ONE persistent headline layer for the whole short; subtitle-style captions are
  forbidden; optional single payoff accent over the payoff beat.
- Event-based, dead-time-free edits: beats cut to gameplay moments, scaled
  punch-ins for emphasis (no keyframes).
- Gameplay audio preserved; no voices. Target ~15–20s per short.

## Pipeline

1. **Manifest** (`src/manifest.ts`): `EditManifest` = schemaVersion, source
   basename, output name, format, `headline`, `beats[]` (sourceStart/sourceEnd,
   scale, importance, label), optional `payoff` (text, window). `compileManifest`
   lays beats sequentially on the timeline starting at 0.
2. **Analyze** (`src/analyze.ts`): ffprobe metadata, deterministic frame
   sampling, `sanityCheckRender` (probe + luma at ~30%/75%, audio present,
   duration match). No gameplay-event inference yet.
3. **Compose** (`src/compose.ts`): manifest → `RenderSpec` with caption visuals
   (headline y=0.12, payoff y=0.3, sizes 74/88, black stroke+shadow) and beat
   RectSpecs.
4. **Render** (`src/render-server.ts` + `render-client.ts` + `render.ts`): a
   local server serves `/client.js`, `/spec.json`, `/media/gameplay.mp4` (Range)
   and receives `POST /upload`. The client builds the Composition and beats
   (`VideoClip`), headline and payoff (`TextClip` with native strokes/shadows),
   calls `encoder.render()` in-memory, uploads the MP4 blob.
5. **Batch** (`src/batch.ts`): discover MP4s → probe → analyze → pick fixture
   manifest by basename (or deterministic fallback) → validate → build spec →
   render via one shared `RenderRunner` (single browser + server, one page per
   job) → sanity check → summary. `npm run batch -- <folder> [--manifest f]`.

## PhotonCore v4.0.3 semantics (verified — do not "fix")

- Clip timeline `start = delay + range[0]`, `end = delay + range[1]`. To play
  source window `[s,e]` at timeline `t`: `delay = t - s` (often negative when
  cutting later source regions) and `range = [s, e]`. Negative delays are
  allowed and cut at 0.
- `trim(a,b)` only sets `delay = a` / `duration = b-a` — timeline trim, NOT
  source selection.
- Encoder callback streaming truncates moov; always `await encoder.render()`
  and upload `result.data` (Blob).
- No license key → explicit watermark ("No Diffusion Studio Core key
  provided. Rendering with watermark.") which visibly darkens the whole frame.
- media metadata print goes to stdout; sanity parser reads stdout+stderr.

## Honesty rules

- NEVER invent gameplay events. Beat timestamps in fixtures must be grounded in
  deterministic signals (scene boundaries, luma/audio activity, known structure)
  and labeled clearly.
- `deterministicManifest` is the no-understanding fallback (opening window,
  mild scales) — never silently passes it off as analysis.
- Report successes and failures in the batch summary honestly.

## Verification before reporting done

- `npx tsc --noEmit` clean, then `npm run batch -- <folder>`.
- ffprobe: duration ≈ manifest total, resolution/fps match, h264 + audio.
- `sanityCheckRender`: non-black luma at probe times, no duration mismatch.
- Spot-check audio follows beat source windows (RMS/volumedetect), text layer
  yields high-YMAX + low saturation in the headline band.
- Reference fixture: `manifests/trusted-16-twice.json` (19.3s, "bro trusted
  16 TWICE" + "BUSTED").

## Constraints

- Everything stays in `video-pipeline/` plus this skill file.
- Do NOT modify the CapCut MCP, `grynd-video-editor`, the manual video-editing
  skill, the GRYND app, root package.json, or opencode.json.