export const MATCH_LIFECYCLE_STATUSES = [
  "queued",
  "forming",
  "ready",
  "started",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;

export type MatchLifecycleStatus = (typeof MATCH_LIFECYCLE_STATUSES)[number];

export const MATCH_CANCEL_REASONS = [
  "user_cancelled",
  "timeout",
  "insufficient_players",
  "player_disconnected",
  "match_rejected",
  "game_unavailable",
  "server_shutdown",
  "launch_failed",
  "admin_cancelled",
  "duplicate_request",
  "unknown",
] as const;

export type MatchCancelReason = (typeof MATCH_CANCEL_REASONS)[number];

export interface MatchLifecycle {
  status: MatchLifecycleStatus;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: MatchCancelReason | null;
  player_count: number;
  mode: string;
  queue_wait_ms: number | null;
}

export interface MatchLifecycleEvent extends MatchLifecycle {
  event_id: string;
  event_type: `match.${MatchLifecycleStatus}`;
  occurred_at: string;
  match_id: string;
  schema_version: 1;
  metadata?: Record<string, unknown>;
}

const TRANSITIONS: Record<MatchLifecycleStatus, readonly MatchLifecycleStatus[]> = {
  queued: ["forming", "cancelled", "expired", "failed"],
  forming: ["ready", "cancelled", "expired", "failed"],
  ready: ["started", "cancelled", "expired", "failed"],
  started: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export function isMatchLifecycleStatus(value: unknown): value is MatchLifecycleStatus {
  return typeof value === "string" && (MATCH_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

export function isMatchCancelReason(value: unknown): value is MatchCancelReason {
  return typeof value === "string" && (MATCH_CANCEL_REASONS as readonly string[]).includes(value);
}

export function canTransitionMatchLifecycle(
  from: MatchLifecycleStatus,
  to: MatchLifecycleStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function calculateQueueWaitMs(queuedAt: Date | string, endAt: Date | string): number {
  const queuedTime = new Date(queuedAt).getTime();
  const endTime = new Date(endAt).getTime();

  if (!Number.isFinite(queuedTime) || !Number.isFinite(endTime)) {
    throw new Error("Invalid queue lifecycle timestamp");
  }

  const waitMs = endTime - queuedTime;
  if (waitMs < 0) throw new Error("Queue lifecycle timestamps are out of order");
  return waitMs;
}

export function createMatchLifecycleEvent(
  lifecycle: MatchLifecycle,
  matchId: string,
  eventId: string,
  occurredAt = new Date().toISOString(),
  metadata?: Record<string, unknown>,
): MatchLifecycleEvent {
  if (!matchId) throw new Error("matchId is required");
  if (!eventId) throw new Error("eventId is required");
  if (!Number.isInteger(lifecycle.player_count) || lifecycle.player_count < 0) {
    throw new Error("player_count must be a non-negative integer");
  }
  if (!lifecycle.mode) throw new Error("mode is required");

  return {
    ...lifecycle,
    event_id: eventId,
    event_type: `match.${lifecycle.status}`,
    occurred_at: occurredAt,
    match_id: matchId,
    schema_version: 1,
    ...(metadata ? { metadata } : {}),
  };
}
