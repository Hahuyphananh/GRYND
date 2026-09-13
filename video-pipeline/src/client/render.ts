import * as core from '@diffusionstudio/core';

declare global {
  interface Window {
    __pocStatus?: string;
    __pocError?: string;
    __pocElapsedMs?: number;
    __pocBytes?: number;
  }
}

const VIDEO_URL = '/media/gameplay.mp4';
const START = 2;
const END = 6;

function setStatus(text: string): void {
  window.__pocStatus = text;
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

async function main(): Promise<void> {
  setStatus('loading source…');
  const source = await core.Source.from<core.VideoSource>(VIDEO_URL);

  setStatus('building composition…');
  const composition = new core.Composition({
    width: 1080,
    height: 1920,
    background: '#000000',
    licenseKey: undefined,
  });
  const layer = await composition.add(new core.Layer());

  const video = new core.VideoClip(source, { position: 'center', width: '100%', height: '100%' });
  video.trim(START, END);
  await layer.add(video);

  setStatus(`rendering ${composition.duration}s…`);
  const encoder = new core.Encoder(composition);
  encoder.onProgress = (p) => setStatus(`rendering ${Math.round(p.progress)}%…`);
  const startedAt = performance.now();
  const result = await encoder.render();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (result.type !== 'success' || !result.data) {
    if (result.type === 'error') throw result.error;
    throw new Error(`render finished with type '${result.type}'`);
  }

  setStatus(`uploading ${(result.data.size / 1048576).toFixed(1)} MB…`);
  const resp = await fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: result.data,
  });
  if (!resp.ok) throw new Error(`upload failed: HTTP ${resp.status}`);

  window.__pocElapsedMs = elapsedMs;
  window.__pocBytes = result.data.size;
  setStatus(`done in ${(elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  window.__pocError = msg;
  setStatus('ERROR');
  console.error(e);
});