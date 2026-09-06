// src/lib/creator-mode/types.ts
//
// Shared types for the Creator Mode foundation. These are the single
// vocabulary used by the permission layer, the client transport, the
// recorder, and the React components so every game integrates against
// one stable shape instead of ad-hoc per-game implementations.

/** Who the current user is in the creator program. */
export type CreatorRole = "admin" | "approved-creator" | "none";

/** Lifecycle of a single viewport capture. */
export type RecordingState =
  | "idle" // not recording, nothing captured
  | "requesting" // getDisplayMedia prompt is open / permission pending
  | "recording" // MediaRecorder is capturing the viewport
  | "stopped" // capture finished, a downloadable blob exists
  | "error"; // capture failed (permission denied, unsupported, etc.)

/** Resolution of the captured viewport (from the video track). */
export type CaptureDimensions = {
  width: number;
  height: number;
};

/**
 * Snapshot of a finished recording, ready to be downloaded.
 * The Blob is kept so future work (upload, creator-program storage)
 * can consume it directly without re-encoding.
 */
export type RecordingResult = {
  blob: Blob;
  url: string;
  mimeType: string;
  dimensions: CaptureDimensions | null;
  durationMs: number;
};

/**
 * The full creator-mode configuration/state contract exposed to a game
 * page. `enabled` is the mode flag passed from the lobby; the rest is
 * recorder state so UIs can render one consistent control.
 */
export type CreatorModeConfig = {
  enabled: boolean;
  state: RecordingState;
  dimensions: CaptureDimensions | null;
  error: string | null;
};

/**
 * How long recording keeps running after the game reaches its normal
 * completed/result state, so the result/winner animation is captured
 * before the recording stops. Games can override via
 * <CreatorModeHost autoStopDelayMs={...} />.
 *
 * 2400ms covers the shared PvpResultScreen entrance (spring panel +
 * icon pop, ~0.8s) plus its confetti bursts (fired at 0 / 350 / 650ms)
 * with margin, so a creator clip ends after the WIN/LOSS popup is
 * clearly on screen — never before it shows.
 */
export const DEFAULT_AUTO_STOP_DELAY_MS = 2400;

/**
 * The shared Creator Mode lifecycle API. Every game integrates against
 * this single contract (via <CreatorModeHost /> props or the
 * useCreatorModeLifecycle hook) instead of touching the recorder
 * directly:
 *
 *   • creatorModeEnabled / recordingDimensions — the mode flag and
 *     selected output size passed from the lobby
 *   • gameStarted()  — call when the REAL game starts (never page load)
 *   • gameFinished() — call when the game reaches its normal completed
 *     state; recording keeps running briefly (autoStopDelayMs) to
 *     capture the result/winner animation, then stops
 *   • gameQuit()     — call when the user quits; recording stops NOW
 *   • startCreatorRecording() / stopCreatorRecording() — explicit
 *     manual control (start still runs the 3→2→1 countdown first)
 */
export type CreatorModeLifecycle = {
  creatorModeEnabled: boolean;
  recordingDimensions: CreatorModeDimensions;
  gameStarted: () => void;
  gameFinished: (delayMs?: number) => void;
  gameQuit: () => void;
  startCreatorRecording: () => void;
  stopCreatorRecording: () => void;
  /** Recorder state for UI ("idle" | "recording" | "stopped" | ...). */
  state: RecordingState;
  /** Finished recording blob — set once recording has stopped. */
  lastResult: RecordingResult | null;
  error: string | null;
  /** Trigger a download of the last recording. Returns the filename. */
  download: (filenameBase?: string) => string | null;
};

/** URL query parameter the lobby appends to game links. */
export const CREATOR_MODE_PARAM = "creator";
export const CREATOR_MODE_PARAM_ON = "1";

/** Storage key prefix (sessionStorage) used to persist the flag between
 *  lobby → game → match-page navigations. Keyed per user. */
export const CREATOR_MODE_STORAGE_PREFIX = "grynd:creatorMode:";

// ── Recording output dimensions ──────────────────────────────────────
//
// The selected dimensions define the output recording canvas (and the
// dedicated recording viewport the game is rendered in). The user never
// resizes their browser window — the frame is scaled to fit on screen
// while the capture always runs at the selected logical size.

export type DimensionPresetKey = "9:16" | "16:9" | "1:1" | "custom";

export type CreatorModeDimensions = {
  /** Which preset produced these dimensions ("custom" = manual input). */
  preset: DimensionPresetKey;
  width: number;
  height: number;
};

/** Hard bounds for custom dimensions — unreasonable values are clamped. */
export const MIN_CAPTURE_DIMENSION = 320;
export const MAX_CAPTURE_DIMENSION = 3840;

export const DIMENSION_PRESETS: Record<
  Exclude<DimensionPresetKey, "custom">,
  { label: string; width: number; height: number }
> = {
  "9:16": { label: "9:16", width: 1080, height: 1920 },
  "16:9": { label: "16:9", width: 1920, height: 1080 },
  "1:1": { label: "1:1", width: 1080, height: 1080 },
};

/** Default output when Creator Mode is enabled (9:16 per spec). */
export const DEFAULT_CREATOR_DIMENSIONS: CreatorModeDimensions = {
  preset: "9:16",
  width: DIMENSION_PRESETS["9:16"].width,
  height: DIMENSION_PRESETS["9:16"].height,
};

/** Clamp + validate custom dimensions. Returns the sanitised values. */
export function sanitizeDimensions(width: number, height: number) {
  const w = Math.round(
    Math.min(MAX_CAPTURE_DIMENSION, Math.max(MIN_CAPTURE_DIMENSION, Number(width) || 0)),
  );
  const h = Math.round(
    Math.min(MAX_CAPTURE_DIMENSION, Math.max(MIN_CAPTURE_DIMENSION, Number(height) || 0)),
  );
  return { width: w, height: h };
}

/** Storage key prefix for the persisted dimension selection (sessionStorage). */
export const CREATOR_DIMENSIONS_STORAGE_PREFIX = "grynd:creatorModeDims:";

// ── Capture source mode ──────────────────────────────────────────────
// The recorder picks a browser-native capture path based on how the game
// container renders (see docs/CREATOR_MODE_RECORDING.md).

export type CaptureSourceMode = "canvas" | "composite" | "none";

/** How much of the container a canvas must cover to use canvas mode. */
export const CANVAS_MODE_AREA_THRESHOLD = 0.6;
