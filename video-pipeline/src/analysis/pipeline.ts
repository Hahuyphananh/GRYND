import * as fs from 'node:fs';
import * as path from 'node:path';
import { probeMedia, MediaInfo } from '../analyze.js';
import { cleanupFrames, extractFrames } from './sampling.js';
import { runWindowsOcr, WindowsOcrOutput } from './windows-ocr.js';
import { identifyGame } from './identify.js';
import { analyzerFor } from './games/index.js';
import { scoreImportantMoments } from './scoring.js';
import { ANALYSIS_VERSION, GameplayAnalysis, OcrObservation } from './types.js';

export interface AnalyzeOptions {
  fps?: number;
  format?: 'jpg' | 'png';
  locale?: string;
  /** Leave extracted frames on disk after analysis. */
  keepFrames?: boolean;
  /** Where to write the GameplayAnalysis JSON (default: manifests/analysis). */
  analysisDir?: string;
  /** Override the sampled-frame cache root (default: %TEMP%/grynd-analysis-frames). */
  framesDir?: string;
}

export interface AnalyzeResult {
  analysis: GameplayAnalysis;
  jsonPath: string | null;
  ocr: WindowsOcrOutput | null;
  tookMs: number;
}

function slugName(file: string): string {
  return path.basename(file, path.extname(file)).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function analyzeVideo(filePath: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const started = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  const media: MediaInfo = await probeMedia(filePath);

  const fps = opts.fps ?? 2;
  const format = opts.format ?? 'jpg';

  // 1) Sample frames (single-pass, reusable, temp dir by default)
  const sampling = await extractFrames(filePath, {
    fps,
    format,
    duration: media.duration,
    dir: opts.framesDir,
  });

  // 2) Local OCR via Windows OCR (no external engine installed)
  let ocr: WindowsOcrOutput | null = null;
  let observations: OcrObservation[] = [];
  try {
    ocr = await runWindowsOcr(sampling.dir, {
      pattern: `frame-*.${format}`,
      locale: opts.locale ?? 'fr-CA',
    });
    if (ocr.error) {
      warnings.push(`Windows OCR unavailable/failed: ${ocr.error}`);
      ocr = null;
    }
  } catch (e) {
    warnings.push(`Windows OCR invocation failed: ${e instanceof Error ? e.message : String(e)}`);
    ocr = null;
  }

  if (ocr) {
    observations = sampling.samples
      .map((s) => {
        const r = ocr?.results.find((x) => x.image === path.basename(s.file));
        if (r?.error) warnings.push(`OCR frame ${r.image}: ${r.error}`);
        const text = (r?.text ?? '').trim();
        return {
          timestamp: s.time,
          image: path.basename(s.file),
          text,
          lines: r?.lines ?? [],
          confidence: null,
        };
      })
      .filter((o) => o.text.length > 0);
  }

  // 3) Game identification
  const identification = identifyGame({ filename: path.basename(filePath), observations });

  // 4) Game-specific analysis
  const analyzer = analyzerFor(identification.game);
  const events = analyzer.analyze({ observations });

  // 5) Deterministic ranking of important moments
  const importantMoments = scoreImportantMoments(events);

  const wordCount = ocr
    ? ocr.results.reduce((acc, r) => acc + r.lines.reduce((a, l) => a + l.words.length, 0), 0)
    : 0;

  const sampledFrames = sampling.samples.map((s) => s.file);

  const analysis: GameplayAnalysis = {
    schemaVersion: 1,
    source: filePath,
    game: identification.game,
    gameConfidence: identification.confidence,
    duration: media.duration,
    width: media.width,
    height: media.height,
    fps: media.fps,
    sampling: {
      fps,
      frameCount: sampling.samples.length,
      format,
      times: sampling.samples.map((s) => s.time),
      framesDir: sampling.dir,
      reused: sampling.reused,
    },
    ocr: {
      engine: ocr ? ocr.engine : null,
      locale: ocr ? ocr.locale : null,
      wordCount,
    },
    observations,
    events,
    importantMoments,
    suggestedHeadline: null,
    payoff: null,
    sampledFrames,
    analysisVersion: ANALYSIS_VERSION,
    errors,
    warnings,
  };

  // 6) Persist GameplayAnalysis JSON
  const analysisDir = opts.analysisDir ?? path.join(videoPipelineRoot(), 'manifests', 'analysis');
  const jsonPath = path.join(ensureDir(analysisDir), `${slugName(filePath)}-analysis.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2), 'utf8');

  // 7) Clean temporary frames unless asked to keep them
  if (!opts.keepFrames) {
    cleanupFrames(sampling.dir);
  }

  return {
    analysis,
    jsonPath,
    ocr,
    tookMs: Date.now() - started,
  };
}

function videoPipelineRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

export { expectedFrameCount } from './sampling.js';