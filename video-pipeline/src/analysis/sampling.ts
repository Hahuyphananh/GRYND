import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTool } from '../analyze.js';

export interface FrameSample {
  index: number;
  /** Nominal source time in seconds (frame i of an fps sampler maps to i / fps). */
  time: number;
  file: string;
}

export interface FrameSampling {
  dir: string;
  format: 'jpg' | 'png';
  fps: number;
  samples: FrameSample[];
  expected: number;
  reused: boolean;
}

/** Number of frames the sampler should produce for a clip of `duration` at `fps`. */
export function expectedFrameCount(duration: number, fps: number): number {
  return Math.max(1, Math.floor(duration * fps));
}

function formatExt(format: 'jpg' | 'png'): string {
  return format === 'png' ? 'png' : 'jpg';
}

/**
 * Single-pass frame extraction at a fixed rate (default 2 FPS). Frames are
 * numbered `frame-000000.<ext>` and reuse an already-complete set to avoid
 * re-decoding. Never extracts every frame.
 */
export async function extractFrames(
  videoPath: string,
  opts: { fps?: number; format?: 'jpg' | 'png'; dir?: string; duration: number }
): Promise<FrameSampling> {
  const fps = opts.fps ?? 2;
  const format = opts.format ?? 'jpg';
  const expected = expectedFrameCount(opts.duration, fps);
  const dir = opts.dir ?? defaultFramesDir(videoPath, fps, format);

  if (fs.existsSync(dir)) {
    const existing = listFrameFiles(dir, format);
    // ffmpeg's fps filter output count is stable but can differ by one from
    // the expectation depending on the source PTS grid.
    if (existing.length >= expected - 1) {
      return {
        dir,
        format,
        fps,
        samples: existing.slice(0, expected).map((f, i) => ({ index: i, time: i / fps, file: f })),
        expected,
        reused: true,
      };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^frame-\d+\.(jpg|png)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }

  const args = [
    '-y',
    '-v', 'error',
    '-i', videoPath,
    '-vf', `fps=${fps}`,
    '-frames:v', String(expected),
  ];
  if (format === 'jpg') args.push('-q:v', '2');
  const outPattern = path.join(dir, `frame-%06d.${formatExt(format)}`);
  await runTool('ffmpeg', [...args, outPattern]);

  const samples = listFrameFiles(dir, format).map((f, i) => ({ index: i, time: i / fps, file: f }));
  return { dir, format, fps, samples, expected, reused: false };
}

function listFrameFiles(dir: string, format: 'jpg' | 'png'): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => new RegExp(`^frame-\\d+\\.${formatExt(format)}$`).test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function defaultFramesDir(videoPath: string, fps: number, format: 'jpg' | 'png'): string {
  const base = path.basename(videoPath, path.extname(videoPath));
  return path.join(framesRoot(), `${slug(base)}-${fps}fps-${formatExt(format)}`);
}

export function framesRoot(): string {
  return path.join(process.env.TEMP ?? '.', 'grynd-analysis-frames');
}

export function cleanupFrames(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}