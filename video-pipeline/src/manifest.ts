export type Importance = 'normal' | 'important' | 'highlight' | 'major';

/** One event trace used to audit a generated edit plan. */
export interface StoryEventRef {
  type: string;
  timestamp: number;
  importance: Importance;
  metadata?: Record<string, unknown>;
}

export interface Beat {
  /** In-point inside the source video, seconds */
  sourceStart: number;
  /** Out-point inside the source video, seconds. Must be > sourceStart. */
  sourceEnd: number;
  /** Frames shown at 100% must read 1.0; punch-ins are > 1.0 (e.g. 1.15). */
  scale: number;
  importance: Importance;
  /** Optional editorial label (never shown on screen). */
  label?: string;
  /** Audit link to the analysis event that motivated this cut. */
  eventReference?: string;
  /** Timeline placement, seconds. Filled in by the generator for audit. */
  destStart?: number;
  destEnd?: number;
}

export interface PayoffBeat {
  sourceStart: number;
  sourceEnd: number;
  scale: number;
  /** Optional single accent phrase (one line) flashed at the payoff. */
  text?: string;
}

export interface EditManifest {
  schemaVersion: 1;
  /** Absolute path or basename reference to the GRYND gameplay recording. */
  source: string;
  /** Output filename (written under video-pipeline/output/). Optional. */
  output?: string;
  format: {
    width: 1080;
    height: 1920;
    fps: 30;
  };
  /** ONE persistent editorial meme headline (not subtitles). */
  headline: string;
  /** Sequential gameplay beats, trimmed from `source` in playback order. */
  beats: Beat[];
  payoff?: PayoffBeat;
  /** Gameplay analysis audit trail (filled when the manifest was generated). */
  game?: string;
  story?: {
    type: string;
    reason: string;
    events: StoryEventRef[];
  };
  analysisRef?: string;
  generatedBy?: string;
}

export interface CompiledBeat extends Beat {
  /** Timeline (destination) start, seconds. */
  destStart: number;
  /** Timeline duration, seconds (= sourceEnd - sourceStart). */
  destDuration: number;
}

export interface CompiledManifest {
  manifest: EditManifest;
  beats: CompiledBeat[];
  /** Total timeline duration, seconds. */
  duration: number;
}

/**
 * Sum of the beat durations. Beats appear on the timeline in the order they
 * are declared, each starting where the previous beat ended.
 */
export function compileManifest(manifest: EditManifest): CompiledManifest {
  let cursor = 0;
  const beats: CompiledBeat[] = manifest.beats.map((beat) => {
    const destDuration = beat.sourceEnd - beat.sourceStart;
    if (destDuration <= 0) {
      throw new Error(
        `invalid beat "${beat.label ?? ''}": sourceEnd (${beat.sourceEnd}) must be > sourceStart (${beat.sourceStart})`
      );
    }
    const compiled: CompiledBeat = { ...beat, destStart: cursor, destDuration };
    cursor += destDuration;
    return compiled;
  });
  return { manifest, beats, duration: cursor };
}

export function defaultImportanceScale(importance: Importance): number {
  switch (importance) {
    case 'major':
    case 'highlight':
      return 1.18;
    case 'important':
      return 1.1;
    default:
      return 1.0;
  }
}