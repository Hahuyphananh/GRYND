// src/lib/academyVideoProgress.ts
//
// LOCAL video progress for GRYND Academy. The rendered parts are static files,
// so the only thing worth remembering is how far this browser got in each one:
//
//   * the last position in seconds per part (for resume),
//   * which parts have been watched to the end,
//   * the last part opened (so the section can point at it).
//
// Like lesson progress it is device-local for guests AND signed-in players, is
// namespaced per account, and never touches the server.

import { ACADEMY_VIDEOS, type AcademyVideo } from "./academyVideos";

export type AcademyVideoProgressState = {
  readonly positionByVideo: Readonly<Record<string, number>>;
  readonly watchedVideoIds: readonly string[];
  readonly lastVideoId: string | null;
  readonly updatedAt: number;
};

export type AcademyVideoStatus = "not-started" | "in-progress" | "watched";

export type VideoProgressStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const ACADEMY_VIDEO_PROGRESS_STORAGE_PREFIX = "grynd:academy:videos:v1";
export const ACADEMY_VIDEO_PROGRESS_EVENT = "grynd:academy-video-progress";

/** Below this many seconds, "resume" is not worth a prompt. */
const RESUME_MIN_SECONDS = 5;
/** Within this many seconds of the end, the part counts as watched. */
const WATCHED_TAIL_SECONDS = 4;

const VIDEO_BY_ID = new Map(ACADEMY_VIDEOS.map((video) => [video.id, video]));

export function emptyAcademyVideoProgress(): AcademyVideoProgressState {
  return { positionByVideo: {}, watchedVideoIds: [], lastVideoId: null, updatedAt: 0 };
}

export function academyVideoProgressStorageKey(userId?: string | null): string {
  return `${ACADEMY_VIDEO_PROGRESS_STORAGE_PREFIX}:${userId ? encodeURIComponent(userId) : "guest"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampPosition(position: number, video: AcademyVideo): number {
  if (!Number.isFinite(position)) return 0;
  return Math.min(Math.max(0, position), video.lengthSeconds);
}

/** Accept only parts that still exist and positions inside their runtime. */
export function normalizeAcademyVideoProgress(
  value: unknown,
): AcademyVideoProgressState {
  if (!isRecord(value)) return emptyAcademyVideoProgress();

  const positions: Record<string, number> = {};
  if (isRecord(value.positionByVideo)) {
    for (const [id, raw] of Object.entries(value.positionByVideo)) {
      const video = VIDEO_BY_ID.get(id);
      if (!video || typeof raw !== "number") continue;
      positions[id] = clampPosition(raw, video);
    }
  }

  const watchedVideoIds = Array.isArray(value.watchedVideoIds)
    ? [...new Set(
        value.watchedVideoIds.filter(
          (id): id is string => typeof id === "string" && VIDEO_BY_ID.has(id),
        ),
      )]
    : [];

  const lastVideoId =
    typeof value.lastVideoId === "string" && VIDEO_BY_ID.has(value.lastVideoId)
      ? value.lastVideoId
      : null;

  return {
    positionByVideo: positions,
    watchedVideoIds,
    lastVideoId,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0,
  };
}

export function parseAcademyVideoProgress(
  raw: string | null,
): AcademyVideoProgressState {
  if (!raw) return emptyAcademyVideoProgress();
  try {
    return normalizeAcademyVideoProgress(JSON.parse(raw));
  } catch {
    return emptyAcademyVideoProgress();
  }
}

export function serializeAcademyVideoProgress(
  progress: AcademyVideoProgressState,
): string {
  return JSON.stringify(progress);
}

export function readAcademyVideoProgress(
  storage: VideoProgressStorage | null | undefined,
  userId?: string | null,
): AcademyVideoProgressState {
  if (!storage) return emptyAcademyVideoProgress();
  try {
    return parseAcademyVideoProgress(
      storage.getItem(academyVideoProgressStorageKey(userId)),
    );
  } catch {
    return emptyAcademyVideoProgress();
  }
}

export function writeAcademyVideoProgress(
  storage: VideoProgressStorage | null | undefined,
  userId: string | null | undefined,
  progress: AcademyVideoProgressState,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      academyVideoProgressStorageKey(userId),
      serializeAcademyVideoProgress(progress),
    );
  } catch {
    // Private mode / blocked storage: the player still works in memory.
  }
}

export function isAcademyVideoWatched(
  progress: AcademyVideoProgressState,
  videoId: string,
): boolean {
  return progress.watchedVideoIds.includes(videoId);
}

/** Last known position, clamped to the part's runtime. */
export function academyVideoPosition(
  progress: AcademyVideoProgressState,
  video: AcademyVideo,
): number {
  if (isAcademyVideoWatched(progress, video.id)) return video.lengthSeconds;
  return clampPosition(progress.positionByVideo[video.id] ?? 0, video);
}

export function academyVideoStatus(
  progress: AcademyVideoProgressState,
  video: AcademyVideo,
): AcademyVideoStatus {
  if (isAcademyVideoWatched(progress, video.id)) return "watched";
  return (progress.positionByVideo[video.id] ?? 0) > 0 ? "in-progress" : "not-started";
}

export function academyVideoPercent(
  progress: AcademyVideoProgressState,
  video: AcademyVideo,
): number {
  if (video.lengthSeconds <= 0) return 0;
  return Math.min(
    100,
    Math.round((academyVideoPosition(progress, video) / video.lengthSeconds) * 100),
  );
}

/**
 * Where playback should start when the page opens, or null when the part should
 * start at 0 (barely begun, already watched, or effectively finished).
 */
export function academyVideoResumeAt(
  progress: AcademyVideoProgressState,
  video: AcademyVideo,
): number | null {
  if (isAcademyVideoWatched(progress, video.id)) return null;
  const position = progress.positionByVideo[video.id] ?? 0;
  if (!Number.isFinite(position) || position < RESUME_MIN_SECONDS) return null;
  if (position >= video.lengthSeconds - WATCHED_TAIL_SECONDS) return null;
  return Math.floor(position);
}

export function recordAcademyVideoProgress(
  progress: AcademyVideoProgressState,
  update: { videoId: string; position?: number; watched?: boolean },
  now = Date.now(),
): AcademyVideoProgressState {
  const video = VIDEO_BY_ID.get(update.videoId);
  if (!video) return progress;

  const previous = progress.positionByVideo[video.id] ?? 0;
  const requested =
    typeof update.position === "number" && Number.isFinite(update.position)
      ? update.position
      : previous;
  const position = clampPosition(requested, video);
  const watched =
    progress.watchedVideoIds.includes(video.id) ||
    update.watched === true ||
    position >= video.lengthSeconds - WATCHED_TAIL_SECONDS;

  return {
    positionByVideo: {
      ...progress.positionByVideo,
      [video.id]: watched ? video.lengthSeconds : Math.floor(position),
    },
    watchedVideoIds: watched
      ? [...new Set([...progress.watchedVideoIds, video.id])]
      : progress.watchedVideoIds,
    lastVideoId: video.id,
    updatedAt: now,
  };
}

export function watchedVideoCount(progress: AcademyVideoProgressState): number {
  return progress.watchedVideoIds.length;
}

export function notifyAcademyVideoProgressChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ACADEMY_VIDEO_PROGRESS_EVENT));
}
