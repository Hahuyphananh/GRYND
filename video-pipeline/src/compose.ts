import { Beat, CompiledManifest, EditManifest, Importance, PayoffBeat, compileManifest, defaultImportanceScale } from './manifest.js';

/**
 * Caption visuals are defined HERE, in one place, and shipped to the browser as
 * part of the RenderSpec. The headline is ONE persistent editorial meme line,
 * never subtitles, never duplicated layers. A single TextClip with native
 * stroke + shadow provides the outline/readability treatment.
 */

export const CAPTION_BASE = {
  color: '#FFFFFF',
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontWeight: '900',
  strokeColor: '#000000',
  strokeWidth: 10,
  strokeOpacity: 0.9,
  shadowColor: '#000000',
  shadowOffsetX: 0,
  shadowOffsetY: 6,
  shadowBlur: 12,
  shadowOpacity: 0.85,
} as const;

/** Horizontal center of the 9:16 frame. */
export const HEADLINE_X = 0.5;

/** Top safe-area vertical position, as a fraction of the frame height. */
export const HEADLINE_Y = 0.12;

/** Upper-mid position for the single payoff accent, clear of gameplay UI. */
export const PAYOFF_Y = 0.3;

export const HEADLINE_FONT_SIZE = 74;
export const PAYOFF_FONT_SIZE = 88;

export interface CaptionVisualSpec {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontFamily: string;
  fontWeight: string;
  strokeColor: string;
  strokeWidth: number;
  strokeOpacity: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  shadowOpacity: number;
  casing: 'upper' | 'lower' | 'none';
}

export interface RenderBeatSpec {
  srcStart: number;
  srcEnd: number;
  destStart: number;
  scale: number;
}

export interface RenderPayoffSpec extends CaptionVisualSpec {
  destStart: number;
  destEnd: number;
}

export interface RenderSpec {
  format: { width: number; height: number; fps: number };
  headline: CaptionVisualSpec;
  beats: RenderBeatSpec[];
  payoff?: RenderPayoffSpec;
  /** Total timeline duration, seconds. */
  duration: number;
}

function captionVisual(
  text: string,
  fontSize: number,
  y: number,
  casing: CaptionVisualSpec['casing']
): CaptionVisualSpec {
  return {
    text,
    x: HEADLINE_X,
    y,
    fontSize,
    ...CAPTION_BASE,
    casing,
  };
}

/**
 * Convert an edit manifest into a browser-safe render spec. Timeline layout:
 * beats play sequentially starting at 0; the headline spans the entire video;
 * an optional payoff accent appears exactly over the payoff beat.
 */
export function buildRenderSpec(manifest: EditManifest): RenderSpec {
  const compiled: CompiledManifest = compileManifest(manifest);
  if (compiled.duration <= 0) {
    throw new Error('manifest produces an empty timeline');
  }

  const beats: RenderBeatSpec[] = compiled.beats.map((beat) => ({
    srcStart: beat.sourceStart,
    srcEnd: beat.sourceEnd,
    destStart: beat.destStart,
    scale: beat.scale,
  }));

  const spec: RenderSpec = {
    format: {
      width: manifest.format.width,
      height: manifest.format.height,
      fps: manifest.format.fps,
    },
    beats,
    headline: captionVisual(manifest.headline, HEADLINE_FONT_SIZE, HEADLINE_Y, 'upper'),
    duration: compiled.duration,
  };

  const payoff = manifest.payoff;
  const payoffText = payoff?.text;
  if (payoff && payoffText) {
    const destDuration = payoff.sourceEnd - payoff.sourceStart;
    const destStart = compiled.beats[compiled.beats.length - 1]?.destStart ?? 0;
    spec.payoff = {
      ...captionVisual(payoffText, PAYOFF_FONT_SIZE, PAYOFF_Y, 'upper'),
      destStart,
      destEnd: destStart + destDuration,
    };
  }

  return spec;
}

/**
 * Deterministic fallback manifest: no gameplay events are inferred. It simply
 * renders the opening window of the footage as a short with mild editorial
 * scales. Replaced later by a real AI gameplay-analysis stage.
 */
export function deterministicManifest(story: { duration: number; source: string }): EditManifest {
  const target = Math.min(18, Math.max(6, story.duration - 1));
  const slice = target / 3;
  const beats: Beat[] = [
    { sourceStart: 0, sourceEnd: slice, scale: 1.0, importance: 'normal', label: 'fallback-open' },
    { sourceStart: slice, sourceEnd: slice * 2, scale: 1.08, importance: 'normal', label: 'fallback-mid' },
    { sourceStart: slice * 2, sourceEnd: Math.min(slice * 3, story.duration), scale: 1.12, importance: 'important', label: 'fallback-close' },
  ];
  return {
    schemaVersion: 1,
    source: story.source,
    format: { width: 1080, height: 1920, fps: 30 },
    headline: 'GRIND SESSION',
    beats,
  };
}

export function scaledBeat(importance: Importance, scale?: number): number {
  return scale ?? defaultImportanceScale(importance);
}