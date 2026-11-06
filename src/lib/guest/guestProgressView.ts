// src/lib/guest/guestProgressView.ts
//
// The guest progression VIEW MODEL (Phase 2F).
//
// Everything here is pure: it turns the payload of GET /api/guest/progress into
// the rows the interface renders, and it is the only place that decides what an
// HTTP status means. Two rules drive it:
//
//  1. A missing or expired guest cookie is NOT an error. The route answers 401
//     (no cookie / forged / expired) or 403 (a signed-in caller), and both mean
//     "there is no guest record to show" — the screen offers to start one.
//     Only a real failure (5xx, a malformed payload, a network throw) is an
//     error, and it must never be disguised as "you have played nothing".
//  2. Nothing is invented. Totals, per-game records and history come from the
//     server's counts; a malformed payload is rejected rather than patched into
//     plausible-looking numbers, and no rating/trophy field exists anywhere in
//     this shape because a guest practice record never carries one.

/** Canonical practice keys the guest writer accepts (src/lib/guest/practiceProgress.ts). */
export const GUEST_GAME_LABELS: Record<string, string> = {
  "tic-tac-toe": "Tic-Tac-Toe",
  dominoes: "Dominoes",
  battleship: "Battleship",
  odds: "Odds",
};

export type GuestPracticeOutcome = "win" | "loss" | "draw";

export type GuestProgressTotals = {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
};

export type GuestProgressGame = GuestProgressTotals & { gameKey: string };

export type GuestProgressHistoryEntry = {
  gameKey: string;
  result: GuestPracticeOutcome;
  aiDifficulty: string | null;
  playedAt: string;
};

export type GuestProgressData = {
  profile: { createdAt: string | null; lastSeenAt: string | null };
  totals: GuestProgressTotals;
  games: GuestProgressGame[];
  history: GuestProgressHistoryEntry[];
};

export type GuestProgressView =
  | { status: "loading" }
  | { status: "no_guest" }
  | { status: "ready"; data: GuestProgressData }
  | { status: "error" };

export type GuestGameRow = {
  gameKey: string;
  label: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
};

export type GuestHistoryRow = {
  key: string;
  gameKey: string;
  label: string;
  result: GuestPracticeOutcome;
  aiDifficulty: string | null;
  playedAt: string;
};

/** The display name of a supported practice game; never a raw key. */
export function guestGameLabel(gameKey: unknown): string {
  const key = typeof gameKey === "string" ? gameKey : "";
  return GUEST_GAME_LABELS[key] ?? key;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTotals(value: unknown): value is GuestProgressTotals {
  if (!value || typeof value !== "object") return false;
  const totals = value as Record<string, unknown>;
  return (
    isCount(totals.matches) &&
    isCount(totals.wins) &&
    isCount(totals.losses) &&
    isCount(totals.draws)
  );
}

export function isGuestPracticeOutcome(value: unknown): value is GuestPracticeOutcome {
  return value === "win" || value === "loss" || value === "draw";
}

/**
 * Structural check of the server payload. A response we cannot read exactly is
 * an error, so the screen can retry instead of rendering zeroes that look like
 * "you have never played".
 */
export function isGuestProgressData(value: unknown): value is GuestProgressData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;

  const profile = data.profile;
  if (!profile || typeof profile !== "object") return false;

  if (!isTotals(data.totals)) return false;
  if (!Array.isArray(data.games) || !Array.isArray(data.history)) return false;

  const gamesOk = data.games.every(
    (row) =>
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).gameKey === "string" &&
      isTotals(row),
  );
  if (!gamesOk) return false;

  return data.history.every(
    (row) =>
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).gameKey === "string" &&
      typeof (row as Record<string, unknown>).result === "string" &&
      typeof (row as Record<string, unknown>).playedAt === "string",
  );
}

/**
 * HTTP status + body → what the screen should render.
 *
 * 401/403 are the "no guest session" state, not failures: a visitor who has
 * never played (or whose 30-day cookie expired) should be invited to start,
 * not shown an error. Everything else that is not a readable success payload
 * is an error.
 */
export function normalizeGuestProgressResponse(
  httpStatus: number,
  payload: unknown,
): GuestProgressView {
  if (httpStatus === 401 || httpStatus === 403) return { status: "no_guest" };
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    return { status: "error" };
  }
  if (!payload || typeof payload !== "object") return { status: "error" };

  const body = payload as { success?: unknown; data?: unknown };
  if (body.success !== true) return { status: "error" };
  if (!isGuestProgressData(body.data)) return { status: "error" };

  return { status: "ready", data: body.data };
}

/**
 * Win rate over DECIDED matches only (a draw is neither a win nor a loss), or
 * null when nothing has been decided. The server's own totals are the input —
 * the percentage is formatting, not a second statistic.
 */
export function guestWinRate(totals: GuestProgressTotals | null | undefined): number | null {
  if (!isTotals(totals)) return null;
  const decided = totals.wins + totals.losses;
  if (decided <= 0) return null;
  return Math.round((totals.wins / decided) * 1000) / 10;
}

/** Per-game rows, in the server's published order (keyed alphabetically). */
export function buildGuestGameRows(data: GuestProgressData | null | undefined): GuestGameRow[] {
  if (!data) return [];
  return data.games
    .filter((row) => row && typeof row.gameKey === "string" && isTotals(row))
    .map((row) => ({
      gameKey: row.gameKey,
      label: guestGameLabel(row.gameKey),
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      winRate: guestWinRate(row),
    }));
}

/**
 * Recent history, newest first as the server sends it. An unrecognised result
 * label is rendered from the server's own normalisation (the read model maps a
 * stray value to `draw`), never presented as a win.
 */
export function buildGuestHistoryRows(
  data: GuestProgressData | null | undefined,
): GuestHistoryRow[] {
  if (!data) return [];
  return data.history
    .filter((row) => row && typeof row.gameKey === "string")
    .map((row, index) => ({
      key: `${row.gameKey}-${row.playedAt}-${index}`,
      gameKey: row.gameKey,
      label: guestGameLabel(row.gameKey),
      result: isGuestPracticeOutcome(row.result) ? row.result : "draw",
      aiDifficulty: row.aiDifficulty ? String(row.aiDifficulty) : null,
      playedAt: row.playedAt,
    }));
}
