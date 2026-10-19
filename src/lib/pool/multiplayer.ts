import { SyncedState } from "./types";

/** The stroke as the player struck it. Everything after the cue is the server's. */
export interface PoolShotRequest {
  angle: number;
  pull: number;
  spinX?: number;
  spinY?: number;
  cueX?: number;
  cueY?: number;
}

/**
 * Hand one stroke to the server, which replays it and rules on it.
 *
 * Pool settles coins, so the winning seat is decided by this endpoint's own
 * simulation (`src/lib/pool/shoot.ts`), never by the page. The returned state is
 * the authoritative board in the CALLER's view (`myTeam`/`oppTeam` already
 * mirrored), and the page adopts its ruling once its local rollout settles.
 *
 * Never throws: a dropped request only costs the server ruling, and the local
 * animation still finishes.
 */
export async function submitPoolShot(
  matchId: string,
  shotId: string,
  shot: PoolShotRequest,
): Promise<{ ok: boolean; state?: SyncedState; winner?: 1 | 2 | null; payout?: number } | null> {
  try {
    const res = await fetch("/api/pool/submit-shot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, shotId, shot }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) return null;
    return data;
  } catch {
    return null;
  }
}

export const isNewerVersion = (incoming: number, current: number) =>
  incoming > current;

export async function pushPoolState(
  matchId: string,
  state: SyncedState,
  aiMode: boolean,
) {
  if (aiMode) return;
  // Accept all lifecycle states — the API handles version-based dedup.
  // This ensures ROLLING states are persisted so the polling fallback
  // can show ball movement to the opponent in real time.

  fetch("/api/pool/update-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, state }),
  }).catch(() => {});
}
