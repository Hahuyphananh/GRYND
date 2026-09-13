import * as fs from 'node:fs';
import * as path from 'node:path';
import { EditManifest, compileManifest } from './manifest.js';
import { analyzeMp4, assertPlayableMedia, probeMedia, sanityCheckRender } from './analyze.js';
import { buildRenderSpec, deterministicManifest } from './compose.js';
import { RenderResult, RenderRunner } from './render.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const MANIFEST_DIR = path.join(ROOT, 'manifests');

interface Options {
  folder: string;
  manifestOverride: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  let folder = '';
  let manifestOverride: string | null = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { folder: '', manifestOverride: null, help: true };
    if (arg.startsWith('--manifest=')) {
      manifestOverride = arg.slice('--manifest='.length);
      continue;
    }
    if (!folder) folder = arg;
  }
  return { folder, manifestOverride, help: false };
}

function discoverMp4s(folder: string): string[] {
  if (!fs.existsSync(folder)) {
    throw new Error(`input folder not found: ${folder}`);
  }
  return fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((f) => path.join(folder, f))
    .sort();
}

function loadManifests(dir: string): EditManifest[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EditManifest;
      } catch {
        console.log(`[batch] warning: could not parse manifest ${f} — skipped`);
        return null;
      }
    })
    .filter((m): m is EditManifest => m !== null);
}

function resolveSourceForManifest(manifest: EditManifest, folder: string): string {
  if (path.isAbsolute(manifest.source) && fs.existsSync(manifest.source)) {
    return manifest.source;
  }
  const candidate = path.join(folder, path.basename(manifest.source));
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  throw new Error(`manifest source not found: ${manifest.source} (looked in ${folder})`);
}

function pickManifest(
  videoPath: string,
  manifestOverride: string | null,
  available: EditManifest[],
  fallback: EditManifest
): { manifest: EditManifest; used: 'fixture' | 'fallback' } {
  if (manifestOverride) {
    if (!fs.existsSync(manifestOverride)) {
      throw new Error(`--manifest file not found: ${manifestOverride}`);
    }
    return { manifest: JSON.parse(fs.readFileSync(manifestOverride, 'utf8')) as EditManifest, used: 'fixture' };
  }
  const base = path.basename(videoPath);
  for (const manifest of available) {
    if (path.basename(manifest.source) === base) return { manifest, used: 'fixture' };
  }
  return { manifest: fallback, used: 'fallback' };
}

function validateManifest(manifest: EditManifest, duration: number): void {
  const compiled = compileManifest(manifest);
  const beats = [...compiled.beats];
  if (manifest.payoff) {
    beats.push({
      sourceStart: manifest.payoff.sourceStart,
      sourceEnd: manifest.payoff.sourceEnd,
      scale: manifest.payoff.scale,
      importance: 'highlight',
      destStart: 0,
      destDuration: manifest.payoff.sourceEnd - manifest.payoff.sourceStart,
    });
  }
  for (const beat of beats) {
    if (beat.sourceStart < 0 || beat.sourceEnd > duration || beat.sourceEnd <= beat.sourceStart) {
      throw new Error(
        `beat out of source range (source ${beat.sourceStart}-${beat.sourceEnd}s, media ${duration.toFixed(2)}s)`
      );
    }
  }
}

function outputPathFor(videoPath: string, manifest: EditManifest): string {
  const name = manifest.output?.trim() ? manifest.output?.trim() : `${path.basename(videoPath, path.extname(videoPath))}.mp4`;
  return path.join(OUTPUT_DIR, name);
}

interface SummaryRow {
  file: string;
  used: string;
  output: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audio: boolean;
  bytes: number;
  renderSeconds: number;
  sanitized: boolean;
  errors: string[];
}

async function main(): Promise<void> {
  const { folder, manifestOverride, help } = parseArgs(process.argv.slice(2));
  if (help || !folder) {
    console.log('usage: npm run batch -- <input-folder> [--manifest <file.json>]');
    process.exit(help ? 0 : 1);
  }

  const files = discoverMp4s(folder);
  if (files.length === 0) {
    console.log(`[batch] no MP4 files found in ${folder}`);
    return;
  }
  const available = loadManifests(MANIFEST_DIR);
  console.log(`[batch] processing ${files.length} file(s) from ${folder}`);
  console.log(`[batch] manifests available: ${available.length}`);

  const runner = await RenderRunner.start();
  const batchStart = performance.now();
  const summary: SummaryRow[] = [];

  try {
    for (const file of files) {
      console.log(`\n=== [batch] ${path.basename(file)} ===`);
      try {
        const media = await probeMedia(file);
        assertPlayableMedia(media, file);

        const { analysis } = await analyzeMp4(file, {
          sampleTimes: evenlySpaced(media.duration, 4),
        });
        console.log(
          `[batch] analysis: ${media.duration.toFixed(2)}s ${media.width}x${media.height} @${media.fps.toFixed(0)}fps ` +
            `video=${media.videoCodec} audio=${media.audioPresent ? media.audioCodec : 'none'} ` +
            `(frames sampled: ${analysis.sampledFrames.length})`
        );

        const fallback = deterministicManifest({ duration: media.duration, source: path.basename(file) });
        const { manifest, used } = pickManifest(file, manifestOverride, available, fallback);
        validateManifest(manifest, media.duration);
        const effectiveSource = resolveSourceForManifest(manifest, folder);

        const spec = buildRenderSpec(manifest);
        const outputPath = outputPathFor(file, manifest);
        console.log(`[batch] manifest: ${used} — ${spec.beats.length} beat(s), ${spec.duration.toFixed(2)}s total`);

        const renderStart = performance.now();
        const result: RenderResult = await runner.render({
          mediaPath: effectiveSource,
          outputPath,
          specJson: JSON.stringify(spec),
        });
        const renderSeconds = (performance.now() - renderStart) / 1000;

        if (result.browserError) {
          const message = `render failed: ${result.browserError}`;
          console.log(`[batch] ${message}`);
          summary.push({ file: path.basename(file), used, output: outputPath, duration: 0, width: 0, height: 0, fps: 0, videoCodec: '', audio: false, bytes: 0, renderSeconds, sanitized: false, errors: [message] });
          continue;
        }

        const sanity = await sanityCheckRender(outputPath, spec.duration + 0.02);
        console.log(
          `[batch] rendered ${(spec.duration * spec.format.fps).toFixed(0)} frames in ${renderSeconds.toFixed(1)}s -> ${outputPath} (${result.bytes} bytes)`
        );
        console.log(
          `[batch] ffprobe: ${sanity.media.duration.toFixed(2)}s, ${sanity.media.width}x${sanity.media.height} ` +
            `@${sanity.media.fps.toFixed(0)}fps, codec=${sanity.media.videoCodec}, ` +
            `audio=${sanity.media.audioPresent ? `${sanity.media.audioCodec} ${sanity.media.sampleRate}Hz/${sanity.media.channels}ch` : 'none'}`
        );
        console.log(
          `[batch] sanity: ${sanity.ok ? 'OK' : 'FAILED'} — luma=${sanity.lumaFrames.map((f) => `${f.avgY.toFixed(1)}@${f.time.toFixed(1)}s`).join(', ') || 'n/a'}` +
            (sanity.problems.length ? ` problems=${sanity.problems.join(' | ')}` : '')
        );

        summary.push({
          file: path.basename(file),
          used,
          output: outputPath,
          duration: sanity.media.duration,
          width: sanity.media.width,
          height: sanity.media.height,
          fps: sanity.media.fps,
          videoCodec: sanity.media.videoCodec,
          audio: sanity.media.audioPresent,
          bytes: result.bytes,
          renderSeconds,
          sanitized: sanity.ok && result.browserError === null,
          errors: sanity.problems,
        });
      } catch (err) {
        const message = `processing error: ${(err as Error).message}`;
        console.log(`[batch] ${message}`);
        summary.push({ file: path.basename(file), used: 'error', output: '', duration: 0, width: 0, height: 0, fps: 0, videoCodec: '', audio: false, bytes: 0, renderSeconds: 0, sanitized: false, errors: [message] });
      }
    }
  } finally {
    await runner.close();
  }

  const totalSeconds = ((performance.now() - batchStart) / 1000).toFixed(1);
  console.log(`\n[batch] batch complete in ${totalSeconds}s`);
  console.log('[batch] summary:');
  for (const row of summary) {
    const outcome = row.errors.length ? 'ERR' : row.sanitized ? 'OK' : 'SANITY-FAIL';
    console.log(
      `  ${outcome.padEnd(12)} ${row.file.padEnd(42)} used=${row.used.padEnd(7)} ` +
        `dur=${row.duration.toFixed(1)}s res=${row.width}x${row.height} fps=${row.fps.toFixed(0)} ` +
        `codec=${row.videoCodec} audio=${row.audio} bytes=${row.bytes} render=${row.renderSeconds.toFixed(1)}s`
    );
    for (const e of row.errors) console.log(`       ${e}`);
  }
}

function evenlySpaced(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 0) return [];
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => Number((step * (i + 0.5)).toFixed(3)));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});