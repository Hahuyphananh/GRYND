// src/lib/solitaire-analytics.ts
//
// One taxonomy for the Solitaire-only product, layered on the analytics stack
// that already exists (posthog-js on the client, posthog-node on the server).
// This module does NOT install a second platform: it names the events, refuses
// properties that do not belong in analytics, and enforces the consent gate the
// rest of the app already respects (`getCookieConsent() === "accepted"`).
//
// Two rules matter more than the event list:
//
//   1. AUTHORITY. A client event describes something the PLAYER did (opened a
//      page, clicked a button). A server event describes something the SERVER
//      confirmed (a match settled, a result recorded). `ranked_match_completed`
//      and `onboarding_completed` therefore exist only on the server, where the
//      database write is the proof — the result screen opening is not.
//   2. NO HIDDEN DATA. Properties are allowlisted, not passed through. Card
//      identities, deals, move logs, tokens, emails and full URLs never enter
//      analytics, whatever a caller hands us.

import { getCookieConsent } from "./cookieConsent";

/** The complete Solitaire taxonomy. Names are the contract; do not re-spell. */
export const SOLITAIRE_EVENTS = {
  // Acquisition and onboarding
  landingPageViewed: "landing_page_viewed",
  signupCompleted: "signup_completed",
  onboardingStarted: "onboarding_started",
  onboardingStepCompleted: "onboarding_step_completed",
  onboardingCompleted: "onboarding_completed",
  onboardingSkipped: "onboarding_skipped",
  firstGameStarted: "first_game_started",
  firstGameCompleted: "first_game_completed",
  // Gameplay
  gameStarted: "solitaire_game_started",
  gameCompleted: "solitaire_game_completed",
  gameAbandoned: "solitaire_game_abandoned",
  gameRestarted: "solitaire_game_restarted",
  // Competitive
  rankedQueueStarted: "ranked_queue_started",
  rankedQueueCancelled: "ranked_queue_cancelled",
  rankedMatchFound: "ranked_match_found",
  rankedMatchStarted: "ranked_match_started",
  rankedMatchCompleted: "ranked_match_completed",
  rankedMatchForfeited: "ranked_match_forfeited",
  // Daily
  dailyChallengeStarted: "daily_challenge_started",
  dailyChallengeCompleted: "daily_challenge_completed",
  // Review
  reviewOpened: "solitaire_review_opened",
  reviewCompleted: "solitaire_review_completed",
  reviewPracticeClicked: "review_practice_clicked",
  // Practice drills (Phase 5): a review can deep-link into one, and only these
  // events can say whether the same player actually started/finished it.
  practiceDrillStarted: "practice_drill_started",
  practiceDrillCompleted: "practice_drill_completed",
  // Engagement
  leaderboardViewed: "leaderboard_viewed",
  profileViewed: "profile_viewed",
  academyLessonStarted: "academy_lesson_started",
  academyLessonCompleted: "academy_lesson_completed",
} as const;

export type SolitaireEventName =
  (typeof SOLITAIRE_EVENTS)[keyof typeof SOLITAIRE_EVENTS];

const EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(SOLITAIRE_EVENTS));

/** True for a name this product is allowed to emit. */
export function isSolitaireEvent(value: unknown): value is SolitaireEventName {
  return typeof value === "string" && EVENT_NAMES.has(value);
}

/** How a game was played. */
export const SOLITAIRE_MODES = ["solo", "daily", "ranked", "ai", "puzzle"] as const;
export type SolitaireMode = (typeof SOLITAIRE_MODES)[number];

export const SOLITAIRE_RESULTS = [
  "win",
  "loss",
  "draw",
  "completed",
  "abandoned",
] as const;
export type SolitaireResult = (typeof SOLITAIRE_RESULTS)[number];

export const OPPONENT_TYPES = ["human", "recorded", "ai"] as const;
export type OpponentType = (typeof OPPONENT_TYPES)[number];

export const PLATFORMS = ["web", "ios", "android"] as const;
export type AnalyticsPlatform = (typeof PLATFORMS)[number];

/**
 * The ONLY properties an event may carry. Everything else is dropped, which is
 * what keeps a well-meaning caller from attaching a deal, a hand or an email.
 */
export const ALLOWED_PROPERTY_KEYS = [
  "mode",
  "game_id",
  "is_first_game",
  "is_authenticated",
  "platform",
  "source",
  "duration_seconds",
  "result",
  "opponent_type",
  "step",
  "steps_total",
  "lesson_id",
  "surface",
  // Matchmaking transparency (Phase 3): how long the search took and how far
  // apart the two ratings were. Coarse, numeric, never identifying.
  "queue_duration_ms",
  "rating_diff",
  // Which drill, which skill — never the reviewed deal or its cards.
  "skill_id",
  "exercise_id",
] as const;

export type SolitaireEventProperties = {
  mode?: SolitaireMode;
  game_id?: string;
  is_first_game?: boolean;
  is_authenticated?: boolean;
  platform?: AnalyticsPlatform;
  source?: string;
  duration_seconds?: number;
  result?: SolitaireResult;
  opponent_type?: OpponentType;
  step?: number;
  steps_total?: number;
  lesson_id?: string;
  surface?: string;
  queue_duration_ms?: number;
  rating_diff?: number;
  skill_id?: string;
  exercise_id?: string;
};

const SOURCE_MAX = 64;
const ID_MAX = 96;

const oneOf = <T extends readonly string[]>(
  allowed: T,
  value: unknown,
): T[number] | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;

const boundedString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;

/**
 * Reduce any caller payload to the allowlisted, validated shape.
 *
 * Unknown keys are DROPPED (not forwarded). A numeric field that arrives as a
 * string, a duration that is negative or NaN, or an enum outside its set is
 * omitted rather than guessed at.
 */
export function sanitizeSolitaireProperties(
  input: Record<string, unknown> | undefined | null,
): SolitaireEventProperties {
  const out: SolitaireEventProperties = {};
  if (!input || typeof input !== "object") return out;

  const mode = oneOf(SOLITAIRE_MODES, input.mode);
  if (mode) out.mode = mode;

  const gameId = boundedString(input.game_id, ID_MAX);
  if (gameId) out.game_id = gameId;

  if (typeof input.is_first_game === "boolean") out.is_first_game = input.is_first_game;
  if (typeof input.is_authenticated === "boolean") {
    out.is_authenticated = input.is_authenticated;
  }

  const platform = oneOf(PLATFORMS, input.platform);
  if (platform) out.platform = platform;

  const source = boundedString(input.source, SOURCE_MAX);
  if (source) out.source = source;

  const duration = nonNegativeInt(input.duration_seconds);
  if (duration !== undefined) out.duration_seconds = duration;

  const result = oneOf(SOLITAIRE_RESULTS, input.result);
  if (result) out.result = result;

  const opponentType = oneOf(OPPONENT_TYPES, input.opponent_type);
  if (opponentType) out.opponent_type = opponentType;

  const step = nonNegativeInt(input.step);
  if (step !== undefined) out.step = step;

  const stepsTotal = nonNegativeInt(input.steps_total);
  if (stepsTotal !== undefined) out.steps_total = stepsTotal;

  const lessonId = boundedString(input.lesson_id, ID_MAX);
  if (lessonId) out.lesson_id = lessonId;

  const surface = boundedString(input.surface, SOURCE_MAX);
  if (surface) out.surface = surface;

  const queueDuration = nonNegativeInt(input.queue_duration_ms);
  if (queueDuration !== undefined) out.queue_duration_ms = queueDuration;

  const ratingDiff = nonNegativeInt(input.rating_diff);
  if (ratingDiff !== undefined) out.rating_diff = ratingDiff;

  const skillId = boundedString(input.skill_id, ID_MAX);
  if (skillId) out.skill_id = skillId;

  const exerciseId = boundedString(input.exercise_id, ID_MAX);
  if (exerciseId) out.exercise_id = exerciseId;

  return out;
}

/** Where this session runs, from the UA the native shell already appends. */
export function detectPlatform(): AnalyticsPlatform {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent || "";
  if (!/GRYNDApp\//.test(ua)) return "web";
  return /iPhone|iPad|iPod/i.test(ua) ? "ios" : "android";
}

/** Analytics may only run after the visitor accepted the cookie banner. */
export function hasAnalyticsConsent(): boolean {
  return getCookieConsent() === "accepted";
}

// Session-scoped dedupe: a remount, a refresh or a double render must not
// double-count a page view. Authoritative results never rely on this — the
// server checks the database instead.
const emittedOnce = new Set<string>();

/** Test seam: clear the session dedupe set. */
export function __resetSolitaireAnalytics(): void {
  emittedOnce.clear();
}

type CaptureFn = (event: string, properties: Record<string, unknown>) => void;
let captureOverride: CaptureFn | null = null;

/** Test seam: observe (or stub) the client capture without a running PostHog. */
export function __setSolitaireCaptureForTests(fn: CaptureFn | null): void {
  captureOverride = fn;
}

/**
 * Emit a client event. Returns true only when something was actually sent, so
 * callers/tests can distinguish "gated off" from "captured". Never throws.
 */
export function trackSolitaireEvent(
  event: SolitaireEventName,
  properties?: SolitaireEventProperties | Record<string, unknown>,
): boolean {
  if (!isSolitaireEvent(event)) return false;
  if (typeof window === "undefined") return false;
  if (!hasAnalyticsConsent()) return false;

  const clean: Record<string, unknown> = {
    ...sanitizeSolitaireProperties(properties as Record<string, unknown> | undefined),
  };
  // A caller-provided valid platform wins; otherwise report where we run.
  if (!clean.platform) clean.platform = detectPlatform();

  try {
    if (captureOverride) {
      captureOverride(event, clean);
      return true;
    }
    // Loaded lazily so importing this module from tests or the server never
    // pulls the browser SDK (or initialises it).
    void import("posthog-js")
      .then((mod) => {
        const posthog = mod.default as unknown as {
          capture: (name: string, props: Record<string, unknown>) => void;
        };
        posthog.capture(event, clean);
      })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire a client event at most once per browser session under `key`.
 * Used for page-view events, whose lifecycle is a mount, not an action.
 */
export function trackSolitaireEventOnce(
  key: string,
  event: SolitaireEventName,
  properties?: SolitaireEventProperties | Record<string, unknown>,
): boolean {
  if (!isSolitaireEvent(event)) return false;
  if (typeof window === "undefined") return false;
  if (!hasAnalyticsConsent()) return false;
  if (emittedOnce.has(key)) return false;
  emittedOnce.add(key);
  return trackSolitaireEvent(event, properties);
}

/**
 * Best-effort per-process dedupe for server events that could otherwise be
 * emitted by a retried request. The authoritative guard stays the database
 * (settlement and onboarding writes are idempotent); this only removes the
 * duplicate capture within one instance.
 */
const serverSeen = new Set<string>();

export function onceOnServer(key: string): boolean {
  if (serverSeen.has(key)) return false;
  serverSeen.add(key);
  if (serverSeen.size > 5000) {
    // Bound memory on a long-lived instance; oldest first.
    const first = serverSeen.values().next().value;
    if (first) serverSeen.delete(first);
  }
  return true;
}

export function __resetServerDedupe(): void {
  serverSeen.clear();
}
