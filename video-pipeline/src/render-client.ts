import * as core from '@diffusionstudio/core';
import { RenderPayoffSpec, RenderSpec } from './compose.js';

declare global {
  interface Window {
    __render?: {
      status?: string;
      error?: string;
      elapsedMs?: number;
      bytes?: number;
      done?: boolean;
    };
  }
}

type RenderState = NonNullable<Window['__render']>;

const VIDEO_URL = '/media/gameplay.mp4';

function setStatus(windowState: RenderState | undefined, text: string): void {
  if (!windowState) return;
  windowState.status = text;
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function specCasing(casing: string): 'upper' | 'lower' | undefined {
  if (casing === 'upper') return 'upper';
  if (casing === 'lower') return 'lower';
  return undefined;
}

async function applyCaptionLayer(
  textLayer: core.Layer,
  spec: RenderSpec['headline'] | RenderPayoffSpec,
  delay: number,
  duration: number
): Promise<void> {
  const clip = new core.TextClip({
    text: spec.text,
    color: spec.color as `#${string}`,
    align: 'center',
    baseline: 'middle',
    casing: specCasing(spec.casing),
    font: {
      family: spec.fontFamily,
      size: spec.fontSize,
      weight: spec.fontWeight as core.FontWeight,
    },
    strokes: [{ color: spec.strokeColor as `#${string}`, width: spec.strokeWidth, opacity: spec.strokeOpacity, lineJoin: 'round' }],
    shadows: [
      {
        color: spec.shadowColor as `#${string}`,
        offsetX: spec.shadowOffsetX,
        offsetY: spec.shadowOffsetY,
        blur: spec.shadowBlur,
        opacity: spec.shadowOpacity,
      },
    ],
    maxWidth: '95%',
    delay,
    duration,
  });
  clip.position = { x: spec.x, y: spec.y };
  await textLayer.add(clip);
}

async function main(): Promise<void> {
  const windowState: RenderState = (window.__render = {});

  setStatus(windowState, 'loading spec\u2026');
  const resp = await fetch('/spec.json');
  if (!resp.ok) throw new Error(`spec fetch failed: HTTP ${resp.status}`);
  const spec = (await resp.json()) as RenderSpec;

  setStatus(windowState, 'loading source\u2026');
  const source = await core.Source.from<core.VideoSource>(VIDEO_URL);

  setStatus(windowState, 'building composition\u2026');
  const composition = new core.Composition({
    width: spec.format.width,
    height: spec.format.height,
    background: '#000000',
    licenseKey: undefined,
  });

  const videoLayer = await composition.add(new core.Layer());
  for (const beat of spec.beats) {
    const video = new core.VideoClip(source, {
      position: 'center',
      width: '100%',
      height: '100%',
      anchor: 0.5,
      delay: beat.destStart - beat.srcStart,
      scale: beat.scale,
    });
    video.range = [beat.srcStart, beat.srcEnd];
    await videoLayer.add(video);
  }

const textLayer = await composition.add(new core.Layer());
  await applyCaptionLayer(textLayer, spec.headline, 0, spec.duration);
  if (spec.payoff) {
    await applyCaptionLayer(
      textLayer,
      spec.payoff,
      spec.payoff.destStart,
      spec.payoff.destEnd - spec.payoff.destStart
    );
  }

  setStatus(windowState, `rendering ${spec.duration}s\u2026`);
  const encoder = new core.Encoder(composition);
  encoder.onProgress = (p) => setStatus(windowState, `rendering ${Math.round(p.progress)}%\u2026`);
  const startedAt = performance.now();
  const result = await encoder.render();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (result.type !== 'success' || !result.data) {
    if (result.type === 'error') throw result.error;
    throw new Error(`render finished with type '${result.type}'`);
  }

  setStatus(windowState, `uploading ${(result.data.size / 1048576).toFixed(1)} MB\u2026`);
  const upload = await fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: result.data,
  });
  if (!upload.ok) throw new Error(`upload failed: HTTP ${upload.status}`);

  windowState.elapsedMs = elapsedMs;
  windowState.bytes = result.data.size;
  windowState.done = true;
  setStatus(windowState, `done in ${(elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (!window.__render) window.__render = {};
  window.__render.error = msg;
  window.__render.status = 'ERROR';
  console.error(e);
});