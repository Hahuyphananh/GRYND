import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MediaInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioPresent: boolean;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  container: string;
  sizeBytes: number;
}

/**
 * Gameplay analysis holder. The typed, gameplay-aware shape lives in
 * src/analysis/types.ts and is re-exported here for pipeline compatibility.
 */
import { ANALYSIS_VERSION } from './analysis/types.js';
import type {
  GameId,
  GameplayAnalysis,
  GameplayEvent,
  Importance,
  ImportantMoment,
  OcrObservation,
} from './analysis/types.js';

export { ANALYSIS_VERSION };

export type {
  GameId,
  GameplayAnalysis,
  GameplayEvent,
  ImportantMoment,
  OcrObservation,
  Importance,
} from './analysis/types.js';

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    sample_rate?: string;
    channels?: number;
    avg_frame_rate?: string;
  }>;
  format?: {
    duration?: string;
    format_name?: string;
    size?: string;
  };
}

export async function runTool(tool: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(tool, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`${tool} failed: ${e.message}\n${e.stderr ?? ''}`);
  }
}

function parseFps(value: string | undefined): number {
  if (!value || value === '0/0') return 0;
  const [n, d] = value.split('/');
  const numerator = parseFloat(n);
  const denominator = parseFloat(d);
  if (!d || denominator === 0) return numerator;
  return numerator / denominator;
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const { stdout } = await runTool('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ]);
  const json: FfprobeJson = JSON.parse(stdout);
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const audio = json.streams?.find((s) => s.codec_type === 'audio');
  return {
    path: filePath,
    duration: parseFloat(json.format?.duration ?? '0'),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseFps(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? 'unknown',
    audioPresent: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? parseInt(audio.sample_rate, 10) : null,
    channels: audio?.channels ?? null,
    container: json.format?.format_name ?? 'unknown',
    sizeBytes: json.format?.size ? parseInt(json.format.size, 10) : 0,
  };
}

/**
 * Extract a deterministic set of frames used by the analysis layer. This is
 * sampling infrastructure only — it never classifies the content.
 */
export async function sampleFrames(
  inputPath: string,
  times: number[],
  outDir: string
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const outputs: string[] = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(outDir, `frame-${String(i).padStart(3, '0')}-${t.toFixed(2)}s.png`);
    if (!fs.existsSync(out)) {
      await runTool('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', t.toFixed(3),
        '-i', inputPath,
        '-frames:v', '1',
        out,
      ]);
    }
    outputs.push(out);
  }
  return outputs;
}

/**
 * Structural, deterministic analysis. It collects media metadata plus a
 * frame-sample gallery. It does NOT infer blackjack/roulette/crash/Plinko
 * gameplay events — that awareness arrives in a later step.
 */
export async function analyzeMp4(
  filePath: string,
  opts: { sampleTimes?: number[] } = {}
): Promise<{ media: MediaInfo; analysis: GameplayAnalysis }> {
  const media = await probeMedia(filePath);
  const times = opts.sampleTimes ?? evenlySpacedTimes(media.duration, Math.min(6, Math.max(1, Math.floor(media.duration / 8))));
  const framesDir = path.join(path.dirname(filePath), '..', '.analysis-frames');
  const sampledFrames = await sampleFrames(filePath, times, framesDir);
  return {
    media,
    analysis: {
      schemaVersion: 1,
      source: filePath,
      game: 'unknown',
      gameConfidence: 0,
      duration: media.duration,
      width: media.width,
      height: media.height,
      fps: media.fps,
      sampling: {
        fps: 0,
        frameCount: sampledFrames.length,
        format: 'png',
        times,
        framesDir,
        reused: true,
      },
      ocr: { engine: null, locale: null, wordCount: 0 },
      observations: [],
      events: [],
      importantMoments: [],
      suggestedHeadline: null,
      payoff: null,
      sampledFrames,
      analysisVersion: ANALYSIS_VERSION,
      errors: [],
      warnings: [],
    },
  };
}

export function evenlySpacedTimes(duration: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [Math.min(1, Math.max(0, duration / 2))];
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => Number((step * (i + 0.5)).toFixed(3)));
}

export interface AverageY {
  time: number;
  avgY: number;
}

/** Average luma (0 = black, 235 = white) of a single frame. */
async function frameLuma(inputPath: string, time: number): Promise<AverageY> {
  const { stdout, stderr } = await runTool('ffmpeg', [
    '-hide_banner',
    '-ss', time.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ]);
  const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stdout + stderr);
  const avgY = match ? parseFloat(match[1]) : 0;
  return { time, avgY };
}

export interface RenderSanity {
  ok: boolean;
  media: MediaInfo;
  expectedDuration: number;
  durationDelta: number;
  lumaFrames: AverageY[];
  minLuma: number;
  problems: string[];
}

/**
 * Automated post-render sanity check: verifies the output is a real, playable
 * file of roughly the expected duration and that sampled frames are not black.
 */
export async function sanityCheckRender(
  outputPath: string,
  expectedDuration: number
): Promise<RenderSanity> {
  const problems: string[] = [];
  const media = await probeMedia(outputPath);
  const durationDelta = media.duration - expectedDuration;

  if (!media.videoCodec || media.width === 0 || media.height === 0) {
    problems.push('output has no readable video stream');
  }
  if (Math.abs(durationDelta) > 2) {
    problems.push(`duration mismatch: expected ~${expectedDuration.toFixed(1)}s, got ${media.duration.toFixed(1)}s`);
  }
  if (!media.audioPresent) {
    problems.push('output has no audio stream');
  }

  const probeTimes = [
    Math.min(media.duration * 0.3, Math.max(0.4, expectedDuration * 0.3)),
    Math.min(media.duration * 0.75, Math.max(1.2, expectedDuration * 0.75)),
  ];
  const lumaFrames: AverageY[] = [];
  for (const t of probeTimes) {
    if (t < media.duration) {
      lumaFrames.push(await frameLuma(outputPath, t));
    }
  }
  const minLuma = Math.min(...lumaFrames.map((f) => f.avgY));
  if (lumaFrames.length > 0 && minLuma < 4) {
    problems.push(`sampled frames appear black (min luma ${minLuma.toFixed(2)})`);
  }

  return {
    ok: problems.length === 0,
    media,
    expectedDuration,
    durationDelta,
    lumaFrames,
    minLuma,
    problems,
  };
}

export function assertPlayableMedia(media: MediaInfo, filePath: string): void {
  if (media.duration <= 0) throw new Error(`media has no duration: ${filePath}`);
  if (media.width === 0 || media.height === 0) throw new Error(`media has no resolution: ${filePath}`);
}